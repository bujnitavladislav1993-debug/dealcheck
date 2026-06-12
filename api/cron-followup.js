// Cron-triggered follow-up engine. Runs on a schedule (see vercel.json crons),
// scans Redis for every lead, and sends the +24h or +72h follow-up email to any
// lead that crossed the threshold and hasn't received that step yet.
//
// Idempotency: each lead record gets a touchedStep1 / touchedStep2 timestamp
// after a successful send, so re-runs of the cron never double-send.
//
// Personalization: emails reference the lead's firstName and dealText. Language
// is chosen from lead.lang ('ru' default, 'en' for English leads).

import { sendBrevoEmail } from './lib/brevo.js';

const STEP1_HOURS = 24;
const STEP2_HOURS = 72;

export default async function handler(req, res) {
  // Optional auth — Vercel auto-sends Authorization: Bearer <CRON_SECRET> when
  // that env var exists. If it's not set we accept all calls (the endpoint is
  // idempotent so the worst a leaker can do is trigger sends we'd have made anyway).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const sent = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (sent !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }

  const base  = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return res.status(500).json({ error: 'Redis not configured' });

  const auth  = { headers: { Authorization: `Bearer ${token}` } };
  const wAuth = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  const now   = Date.now();

  try {
    // 1) Pull every lead key.
    const keysRes = await fetch(`${base}/keys/lead:*`, auth);
    const { result: keys = [] } = await keysRes.json();
    if (keys.length === 0) return res.status(200).json({ ok: true, processed: 0 });

    // 2) Bulk-fetch values.
    const mgetPath = keys.map((k) => encodeURIComponent(k)).join('/');
    const valuesRes = await fetch(`${base}/mget/${mgetPath}`, auth);
    const { result: values } = await valuesRes.json();
    const safeValues = Array.isArray(values) ? values : [];

    let step1Sent = 0, step2Sent = 0, skipped = 0, errors = 0;

    for (let i = 0; i < keys.length; i++) {
      const raw = safeValues[i];
      if (!raw) { skipped++; continue; }
      let lead;
      try { lead = JSON.parse(raw); } catch { skipped++; continue; }
      if (!lead.email || !lead.ts) { skipped++; continue; }

      const ageH = (now - lead.ts) / 3_600_000;

      // STEP 1 — first follow-up, +24 hours after signup.
      if (ageH >= STEP1_HOURS && !lead.touchedStep1) {
        const ok = await sendFollowup(1, lead);
        if (ok) {
          lead.touchedStep1 = now;
          await fetch(`${base}/set/${encodeURIComponent(keys[i])}/${encodeURIComponent(JSON.stringify(lead))}`, wAuth);
          step1Sent++;
        } else {
          errors++;
        }
        continue; // never send both steps in the same run
      }

      // STEP 2 — final nudge, +72 hours after signup.
      if (ageH >= STEP2_HOURS && !lead.touchedStep2) {
        const ok = await sendFollowup(2, lead);
        if (ok) {
          lead.touchedStep2 = now;
          await fetch(`${base}/set/${encodeURIComponent(keys[i])}/${encodeURIComponent(JSON.stringify(lead))}`, wAuth);
          step2Sent++;
        } else {
          errors++;
        }
      }
    }

    return res.status(200).json({
      ok: true,
      totalLeads: keys.length,
      step1Sent,
      step2Sent,
      skipped,
      errors,
    });
  } catch (e) {
    console.error('[cron-followup]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── Email composition ──────────────────────────────────────────────────────────

async function sendFollowup(step, lead) {
  const isRu      = lead.lang === 'ru' || !lead.lang;       // default to Russian
  const firstName = lead.firstName || (isRu ? 'друг' : 'there');

  // If the lead typed actual deal text, reference it (truncated). Otherwise use
  // a generic opener so the email still feels personal.
  const dealSnippet = lead.dealText ? lead.dealText.slice(0, 140).trim() : '';
  const dealLine = dealSnippet
    ? (isRu
        ? `Видел твою сделку: «${dealSnippet}${lead.dealText.length > 140 ? '…' : ''}». `
        : `I saw your deal: "${dealSnippet}${lead.dealText.length > 140 ? '…' : ''}". `)
    : (isRu
        ? 'Раз ты прогонял сделку через AI DealCheck — '
        : "Since you ran a deal through AI DealCheck — ");

  const subject = step === 1
    ? (isRu
        ? `${firstName}, твоя сделка — пара мыслей`
        : `${firstName}, a couple thoughts on your deal`)
    : (isRu
        ? `${firstName}, последнее сообщение от меня`
        : `${firstName}, last note from me`);

  const html = step === 1
    ? step1Html(isRu, firstName, dealLine)
    : step2Html(isRu, firstName);

  return await sendBrevoEmail({
    to:      lead.email,
    toName:  firstName,
    subject,
    html,
    tags:    [`followup-step${step}`, isRu ? 'ru' : 'en'],
  });
}

function step1Html(isRu, firstName, dealLine) {
  if (isRu) return `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;font-size:16px;padding:8px">
<p>Привет, ${escapeHtml(firstName)}!</p>
<p>Это Влад из AI DealCheck. ${escapeHtml(dealLine)}хотел уточнить — ты уже подписал контракт с дилером или ещё думаешь?</p>
<p>За 10+ лет в Mercedes я видел сотни сделок, и почти на каждой можно сбить $50-200 в месяц — если знать, на что давить. Если хочешь, гляну твою сделку лично (не только AI).</p>
<p><strong>Два варианта:</strong></p>
<p style="text-align:center;margin:28px 0">
<a href="https://stan.store/vladbujnita/p/------7f9vxlbh" style="background:#c9a84c;color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">👉 Гид по лизингу — $9</a>
</p>
<p>Или напиши/позвони напрямую — отвечу лично:</p>
<p style="text-align:center;margin:20px 0">
<a href="https://www.instagram.com/pereprodavec_vlad/" style="background:#E1306C;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin:4px">📱 @pereprodavec_vlad</a>
<a href="tel:+19498707365" style="background:#25D366;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin:4px">📞 (949) 870-7365</a>
</p>
<p>Удачи с машиной 🚗</p>
<p><strong>Влад</strong><br>AI DealCheck<br><span style="color:#666;font-size:14px">10+ лет в автобизнесе США</span></p>
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="color:#888;font-size:13px">Это автоматическое продолжение от AI DealCheck. Если не хочешь больше получать письма — просто ответь STOP, и я тебя удалю.</p>
</div>`;
  // EN
  return `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;font-size:16px;padding:8px">
<p>Hey ${escapeHtml(firstName)},</p>
<p>It's Vlad from AI DealCheck. ${escapeHtml(dealLine)}wanted to check — have you signed the dealer contract yet, or still thinking it over?</p>
<p>10+ years inside Mercedes taught me that almost every deal has $50-200/mo of room to negotiate, IF you know what to push. Happy to look at your deal personally — not just the AI.</p>
<p><strong>Two ways to continue:</strong></p>
<p style="text-align:center;margin:28px 0">
<a href="https://stan.store/vladbujnita/p/------7f9vxlbh" style="background:#c9a84c;color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">👉 Lease Guide — $9</a>
</p>
<p>Or text/call me directly — I respond personally:</p>
<p style="text-align:center;margin:20px 0">
<a href="https://www.instagram.com/pereprodavec_vlad/" style="background:#E1306C;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin:4px">📱 @pereprodavec_vlad</a>
<a href="tel:+19498707365" style="background:#25D366;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin:4px">📞 (949) 870-7365</a>
</p>
<p>Good luck with the car 🚗</p>
<p><strong>Vlad</strong><br>AI DealCheck<br><span style="color:#666;font-size:14px">10+ years in US auto</span></p>
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="color:#888;font-size:13px">Automated follow-up from AI DealCheck. Reply STOP to unsubscribe.</p>
</div>`;
}

function step2Html(isRu, firstName) {
  if (isRu) return `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;font-size:16px;padding:8px">
<p>Привет, ${escapeHtml(firstName)}!</p>
<p>Это последнее письмо от меня — обещаю.</p>
<p>Если твоя сделка уже закрыта — поздравляю 🎉 Надеюсь, AI DealCheck помог поймать что-то полезное.</p>
<p>Если ещё на этапе выбора — у меня есть пара мест в этом месяце, чтобы взять сделку лично: позвоню дилеру вместо тебя, выбью money factor, разберу каждую цифру в контракте.</p>
<p><strong>Fee: $299 или 20% от того, что я тебе сэкономлю — что меньше.</strong></p>
<p style="text-align:center;margin:28px 0">
<a href="tel:+19498707365" style="background:#25D366;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">📞 (949) 870-7365 — позвони мне</a>
</p>
<p>Или Instagram: <a href="https://www.instagram.com/pereprodavec_vlad/" style="color:#E1306C">@pereprodavec_vlad</a></p>
<p>Спама больше не будет — это правда последнее письмо.</p>
<p><strong>Влад</strong><br>AI DealCheck</p>
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="color:#888;font-size:13px">Это последнее автоматическое письмо от AI DealCheck. Больше ничего слать не буду.</p>
</div>`;
  // EN
  return `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;font-size:16px;padding:8px">
<p>Hey ${escapeHtml(firstName)},</p>
<p>Last message from me — promise.</p>
<p>If your deal is already done, congrats 🎉 Hopefully AI DealCheck helped catch something useful.</p>
<p>If you're still in the middle of it, I have a few slots this month to take your deal personally: I call the dealer for you, negotiate the money factor, comb every line of the contract.</p>
<p><strong>Fee: $299 OR 20% of what I save you — whichever is less.</strong></p>
<p style="text-align:center;margin:28px 0">
<a href="tel:+19498707365" style="background:#25D366;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">📞 (949) 870-7365 — call me</a>
</p>
<p>Or DM on Instagram: <a href="https://www.instagram.com/pereprodavec_vlad/" style="color:#E1306C">@pereprodavec_vlad</a></p>
<p>No more emails after this. Promise.</p>
<p><strong>Vlad</strong><br>AI DealCheck</p>
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="color:#888;font-size:13px">Final automated note from AI DealCheck. No further messages.</p>
</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}
