// ============================================================================
//  /api/analyze
//  Thin proxy to Anthropic's Messages API + IP rate limiting.
//
//  Three-tier access model (see TIER_INSTRUCTIONS below):
//    - free  : red-flag diagnosis only (driven by <DIAGNOSIS_JSON>)
//    - lead  : diagnosis + <BREAKDOWN> deep per-fee analysis
//    - full  : diagnosis + breakdown + <EXECUTION> dealer message + script
//
//  The frontend builds the full prompt and posts it here. We append a tier-
//  specific instruction to the system prompt so Claude only generates what
//  the caller is allowed to see, AND we strip the disallowed <BREAKDOWN> /
//  <EXECUTION> blocks from the response as a belt-and-suspenders defense in
//  case the model over-produces.
// ============================================================================

// Output tiers: the dealer-message / negotiation-script EXECUTION block was
// removed entirely (Vlad's call — the tool focuses on diagnosis + red flags
// only; the brokerage CTA on the page sells him personally taking the deal).
// Both LEAD and FULL tiers now emit identical content; the distinction is
// purely about which CTA renders below it on the client.
const TIER_INSTRUCTIONS = {
  free:
    'ACCESS TIER: FREE. Output ONLY the <DIAGNOSIS_JSON>{...}</DIAGNOSIS_JSON> ' +
    'block — no markdown analysis, no <BREAKDOWN>. Save tokens. The user will ' +
    'see red flags + total overcharge headline only; the app shows a "register ' +
    'free to unlock full breakdown" call-to-action below it.',
  lead:
    'ACCESS TIER: LEAD. Output <DIAGNOSIS_JSON>{...}</DIAGNOSIS_JSON> followed ' +
    'by a <BREAKDOWN>…</BREAKDOWN> block containing the full markdown analysis: ' +
    'NUMBERS / location / red flags / per-fee deep analysis / total cost reality ' +
    'check / score. Do NOT write a ready-to-send dealer message, negotiation ' +
    'scripts, or word-for-word phrases for the buyer to send to the dealer. The ' +
    'tool analyzes the deal only; the buyer hires Vlad to actually negotiate.',
  full:
    'ACCESS TIER: FULL. Same content as LEAD — <DIAGNOSIS_JSON> followed by ' +
    '<BREAKDOWN> with the full markdown analysis. Do NOT write any dealer ' +
    'messages, negotiation scripts, or word-for-word phrases for the buyer.',
};

// Strip a section by tag name from a markdown string.
function stripSection(text, tag) {
  const re = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'gi');
  return text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting removed for free testing (was: 1 full analysis per IP / 72h via
  // Upstash Redis). Restore from git history (commit 2264ba4) when the product is
  // stable. The dev-key / devcheck logic below is unrelated and stays in place.

  const sentDevKey = (req.headers['x-dev-key'] || '').trim();
  const envDevKey  = (process.env.DEV_KEY || '').trim();
  const isDevRequest = envDevKey.length > 0 && sentDevKey === envDevKey;

  if (req.body?.devcheck) {
    return res.status(200).json({
      dev:      !!isDevRequest,
      envSet:   envDevKey.length > 0,
      envLen:   envDevKey.length,
      sentLen:  sentDevKey.length,
      sentEdge: sentDevKey ? sentDevKey[0] + '…' + sentDevKey[sentDevKey.length - 1] : ''
    });
  }


  // Build the request that goes to Anthropic. We strip accessTier from the body
  // (it's our control field, not Anthropic's), and append the tier instruction
  // to whatever the frontend set as the `system` prompt.
  const incoming = req.body || {};
  const tier = (incoming.accessTier || 'free').toLowerCase();
  const tierInstruction = TIER_INSTRUCTIONS[tier] || TIER_INSTRUCTIONS.free;

  const body = { ...incoming };
  delete body.accessTier;

  if (typeof body.system === 'string') {
    body.system = body.system + '\n\n' + tierInstruction;
  } else if (Array.isArray(body.system)) {
    // System is a cached-blocks array; append a fresh (uncached) block with the
    // tier instruction so cache reuse still works for the bulk of the prompt.
    body.system = [...body.system, { type: 'text', text: tierInstruction }];
  } else {
    // No system prompt provided — set it to just the tier instruction.
    body.system = tierInstruction;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify(body),
    });

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return res.status(response.status || 502).json({
        error: { message: (raw || 'Upstream returned a non-JSON response').slice(0, 300) }
      });
    }

    // ── Response post-processing ─────────────────────────────────────────
    // Two passes per text block:
    //   1. Strip any <thinking>…</thinking> chain-of-thought the model emitted.
    //      Some Claude responses leak the model's internal narration in English
    //      even when the user's chosen language is Russian — the user should
    //      never see it regardless of tier.
    //   2. Tier-gate: even if Claude over-produces, strip disallowed sections
    //      from each text block before returning. A free-tier user gets
    //      nothing past the diagnosis; a lead-tier user gets the breakdown
    //      but no execution package.
    if (response.ok && data?.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block?.type !== 'text' || typeof block.text !== 'string') continue;
        // 1. Always strip <thinking> blocks — they're never user-facing.
        block.text = stripSection(block.text, 'thinking');
        // 2. Tier gating.
        if (tier === 'free') {
          // Keep ONLY the DIAGNOSIS_JSON block — discard everything else
          // regardless of whether the model wrapped it in tags or not.
          const diagMatch = block.text.match(/<DIAGNOSIS_JSON>[\s\S]*?<\/DIAGNOSIS_JSON>/i);
          block.text = diagMatch ? diagMatch[0] : '';
        } else if (tier === 'lead') {
          block.text = stripSection(block.text, 'EXECUTION');
        }
      }
    }

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: { message: error.message } });
  }
}
