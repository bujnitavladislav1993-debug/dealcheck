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

const TIER_INSTRUCTIONS = {
  free:
    'ACCESS TIER: FREE. Output ONLY the <DIAGNOSIS_JSON>{...}</DIAGNOSIS_JSON> ' +
    'block — no markdown analysis, no <BREAKDOWN>, no <EXECUTION>. Save tokens. ' +
    'The user will see red flags + total overcharge headline only; the app shows ' +
    'a "register free to unlock full breakdown" call-to-action below it.',
  lead:
    'ACCESS TIER: LEAD (registered via Stan Store). Output <DIAGNOSIS_JSON>{...}' +
    '</DIAGNOSIS_JSON> followed by a <BREAKDOWN>…</BREAKDOWN> block containing ' +
    'the full markdown analysis EXCEPT the "Negotiation Scripts" and "ready-to-send ' +
    'dealer message" sections. End the breakdown with a paragraph that says, in the ' +
    'response language: "Это сложно сделать самому — дилеры делают это каждый день. ' +
    'Если хочешь, чтобы я вёл эту сделку лично, напиши мне." / "Doing this alone is ' +
    'hard — dealers do it daily. If you want me to handle this deal personally, DM me." ' +
    'DO NOT output <EXECUTION>. The execution package is the paid tier only.',
  full:
    'ACCESS TIER: FULL (paid). Output all three sections: <DIAGNOSIS_JSON>{...}' +
    '</DIAGNOSIS_JSON>, then <BREAKDOWN>…full markdown analysis…</BREAKDOWN>, then ' +
    '<EXECUTION>…ready-to-send dealer message + step-by-step negotiation script…</EXECUTION>.',
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

  // ── IP Rate Limiting (Upstash Redis) ────────────────────────────────────────
  const RATE_LIMIT     = 1;
  const WINDOW_SECS    = 72 * 3600;
  const isFullAnalysis = (req.body?.max_tokens || 0) > 500;

  const ip = (
    req.headers['x-forwarded-for'] ||
    req.socket?.remoteAddress ||
    'unknown'
  ).split(',')[0].trim();

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

  if (!isDevRequest && isFullAnalysis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const base  = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      const key   = `rl:${ip}`;
      const auth  = { headers: { Authorization: `Bearer ${token}` } };

      const incrRes = await fetch(`${base}/incr/${key}`, auth);
      const { result: count } = await incrRes.json();

      if (count === 1) {
        fetch(`${base}/expire/${key}/${WINDOW_SECS}`, auth).catch(() => {});
      }

      if (count > RATE_LIMIT) {
        return res.status(429).json({
          error: {
            message:
              'Вы уже использовали бесплатный анализ. ' +
              'Попробуйте снова через 72 часа или напишите @pereprodavec_vlad в Instagram для персональной консультации. ' +
              '(Rate limit: 1 free analysis per IP per 72 hours.)'
          }
        });
      }
    } catch (rlErr) {
      console.error('[rate-limit] Redis error, failing open:', rlErr.message);
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

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
          block.text = stripSection(block.text, 'BREAKDOWN');
          block.text = stripSection(block.text, 'EXECUTION');
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
