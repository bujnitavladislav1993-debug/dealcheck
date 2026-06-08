import { put } from '@vercel/blob';

// Vercel default body limit is 4.5 MB. A typical compressed JPEG (≤1800px @ 0.85)
// is ~250–500 KB; three pages stays well under. PDFs are not compressed by the
// frontend, so we still cap each item server-side just in case.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB per image hard cap.

// Upload a single base64 payload to Vercel Blob and return its public URL.
// Returns null on any failure so a Blob outage never blocks the lead from being saved.
async function uploadOne(base64, mime, leadEmail) {
  if (!base64 || !process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const buf = Buffer.from(base64, 'base64');
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      console.warn('[collect-email] image rejected: too large', buf.byteLength);
      return null;
    }
    const ext = mime === 'application/pdf' ? 'pdf'
              : mime === 'image/png'        ? 'png'
              : 'jpg';
    // pathname: leads/{date}/{email}-{random}.{ext} — makes future cleanup easy.
    const day = new Date().toISOString().slice(0, 10);
    const safe = (leadEmail || 'anon').toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 40);
    const rand = Math.random().toString(36).slice(2, 10);
    const pathname = `leads/${day}/${safe}-${rand}.${ext}`;
    const result = await put(pathname, buf, {
      access: 'public',
      contentType: mime || 'application/octet-stream',
    });
    return result.url;
  } catch (e) {
    console.error('[collect-email] blob upload failed:', e.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Dev/testing bypass — skip Redis lead storage so Vlad's test runs don't
  // pollute the real leads database. Frontend sends x-dev-key when ?dev=KEY
  // has been enrolled in the browser.
  if (process.env.DEV_KEY && req.headers['x-dev-key'] === process.env.DEV_KEY) {
    return res.status(200).json({ ok: true, dev: true });
  }

  const {
    firstName, lastName, email, phone, ref,
    dealText, dealType, hasAttachment, lang,
    image,   // { data: base64, mime: 'image/jpeg' | 'application/pdf' } — primary upload
    extras,  // [{ data, mime }, ...] — additional pages (multi-page deals)
  } = req.body || {};

  if (!email || !email.includes('@') || email.length > 200) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'First and last name required' });
  }
  if (!phone || String(phone).replace(/\D/g, '').length < 7) {
    return res.status(400).json({ error: 'Valid phone required' });
  }
  // Sanitize names (preserve unicode letters for Cyrillic, strip control chars / scripts)
  const cleanName = (s) => s ? String(s).replace(/[<>{}\\\/\[\]"`]/g, '').trim().slice(0, 60) : null;
  const safeFirst = cleanName(firstName);
  const safeLast  = cleanName(lastName);
  const safePhone = String(phone).replace(/[^0-9+\-() ]/g, '').slice(0, 20);
  // Deal text: cap at 4 KB to avoid runaway storage; strip control chars
  const safeDealText = dealText
    ? String(dealText).replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 4000)
    : null;
  const safeDealType = dealType && ['lease','finance','cash','contract'].includes(dealType)
    ? dealType : null;
  const safeLang = lang && ['ru','en'].includes(lang) ? lang : null;
  const safeEmail = email.toLowerCase().trim().replace(/[^a-z0-9@._+-]/g, '');

  // ── Upload images to Vercel Blob (if configured) ───────────────────────────
  // We do this BEFORE the Redis write so the lead record contains the URLs.
  // Each upload fails open: a Blob outage doesn't prevent the lead from being saved.
  const imageUrls = [];
  if (image && image.data) {
    const url = await uploadOne(image.data, image.mime, safeEmail);
    if (url) imageUrls.push(url);
  }
  if (Array.isArray(extras)) {
    for (const x of extras.slice(0, 4)) { // hard cap: 1 primary + 4 extras = 5 max
      if (x && x.data) {
        const url = await uploadOne(x.data, x.mime, safeEmail);
        if (url) imageUrls.push(url);
      }
    }
  }

  // ── Save to Redis ──────────────────────────────────────────────────────────
  const base  = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (base && token) {
    try {
      const key   = `lead:${Date.now()}:${safeEmail}`;
      const value = JSON.stringify({
        firstName:     safeFirst,
        lastName:      safeLast,
        email:         safeEmail,
        phone:         safePhone,
        ref:           ref || null,
        dealText:      safeDealText,
        dealType:      safeDealType,
        hasAttachment: !!hasAttachment,
        imageUrls,                       // NEW: Blob URLs in page order (1 primary + up to 4 extras)
        lang:          safeLang,
        ts:            Date.now()
      });
      const auth = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
      await fetch(`${base}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, auth);
    } catch (e) {
      console.error('[collect-email] Redis error:', e.message);
    }
  }

  // ── Admin notification email (Vlad's inbox the moment a lead lands) ───────
  // Requires RESEND_API_KEY + RESEND_FROM + RESEND_ADMIN. Fire-and-forget so it
  // never delays the user response.
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM && process.env.RESEND_ADMIN) {
    const dealLine = safeDealText
      ? safeDealText.slice(0, 600) + (safeDealText.length > 600 ? '…' : '')
      : '(no typed deal text — see attachment)';
    const imageList = imageUrls.length
      ? imageUrls.map((u, i) => `<li><a href="${u}">Page ${i + 1}</a></li>`).join('')
      : '<li style="color:#888">(none)</li>';
    const adminHtml = `
<div style="font-family:-apple-system,Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#f0f0f0;padding:24px;border-radius:10px">
  <div style="font-size:13px;color:#c9a84c;margin-bottom:4px">🔥 New DealCheck lead</div>
  <div style="font-size:20px;font-weight:700;margin-bottom:14px">${safeFirst} ${safeLast}</div>
  <table style="width:100%;font-size:14px;color:#ddd;border-collapse:collapse">
    <tr><td style="padding:4px 0;color:#888;width:90px">Email</td><td><a href="mailto:${safeEmail}" style="color:#c9a84c">${safeEmail}</a></td></tr>
    <tr><td style="padding:4px 0;color:#888">Phone</td><td><a href="tel:${safePhone}" style="color:#c9a84c">${safePhone}</a></td></tr>
    <tr><td style="padding:4px 0;color:#888">Deal type</td><td>${safeDealType || '—'}</td></tr>
    <tr><td style="padding:4px 0;color:#888">Lang</td><td>${safeLang || '—'}</td></tr>
  </table>
  <div style="margin-top:16px;padding:12px;background:#1a1a1a;border-left:3px solid #c9a84c;border-radius:4px;font-size:13px;line-height:1.5;color:#ddd;white-space:pre-wrap">${dealLine.replace(/</g, '&lt;')}</div>
  <div style="margin-top:16px;font-size:13px">
    <div style="color:#888;margin-bottom:6px">Uploaded pages:</div>
    <ul style="margin:0;padding-left:18px;color:#c9a84c">${imageList}</ul>
  </div>
  <div style="margin-top:18px;font-size:12px;color:#666">
    Sent from DealCheck · <a href="https://aidealcheck.com/leads.html" style="color:#666">view all leads</a>
  </div>
</div>`;
    // Resend attachments take base64 content directly. We attach the originals
    // (not the Blob copies) so they arrive even if Blob is down.
    const attachments = [];
    if (image && image.data) {
      attachments.push({
        filename: `deal.${image.mime === 'application/pdf' ? 'pdf' : 'jpg'}`,
        content: image.data,
      });
    }
    if (Array.isArray(extras)) {
      extras.slice(0, 4).forEach((x, i) => {
        if (x && x.data) attachments.push({
          filename: `page-${i + 2}.${x.mime === 'application/pdf' ? 'pdf' : 'jpg'}`,
          content: x.data,
        });
      });
    }

    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM,
        to: process.env.RESEND_ADMIN,
        subject: `🔥 New lead: ${safeFirst} ${safeLast}${safeDealType ? ' · ' + safeDealType : ''}`,
        html: adminHtml,
        attachments: attachments.length ? attachments : undefined,
        reply_to: safeEmail,
      })
    }).catch(e => console.error('[resend admin]', e.message)); // fire-and-forget
  }

  // ── Welcome email to the lead (unchanged) ──────────────────────────────────
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM) {
    const isRu = safeLang === 'ru';
    const subject = isRu
      ? 'Ваш анализ сделки готов — AI DealCheck'
      : 'Your deal analysis is ready — AI DealCheck';
    const html = isRu ? `
<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#0a0a0a;color:#f0f0f0;padding:32px;border-radius:12px">
  <div style="font-size:22px;font-weight:700;color:#c9a84c;margin-bottom:8px">AI DealCheck</div>
  <div style="font-size:16px;font-weight:600;margin-bottom:16px">Привет, ${safeFirst}!</div>
  <p style="color:#aaa;line-height:1.7;margin-bottom:20px">
    Ваш бесплатный анализ готов на сайте. Вернитесь на <a href="https://aidealcheck.com" style="color:#c9a84c">aidealcheck.com</a>, чтобы посмотреть результаты.
  </p>
  <p style="color:#aaa;line-height:1.7;margin-bottom:24px">
    Если сделка оказалась сложной — <strong style="color:#f0f0f0">напишите мне напрямую</strong>. 10+ лет в автобизнесе США, помогу выторговать лучшие условия.
  </p>
  <a href="https://www.instagram.com/pereprodavec_vlad/" style="display:inline-block;padding:12px 24px;background:#c9a84c;color:#000;font-weight:700;border-radius:8px;text-decoration:none;margin-right:8px">📱 Instagram</a>
  <a href="https://t.me/pereprodavec_usa" style="display:inline-block;padding:12px 24px;background:#229ED9;color:#fff;font-weight:700;border-radius:8px;text-decoration:none">✈️ Telegram</a>
  <p style="color:#555;font-size:12px;margin-top:32px">Влад · IG @pereprodavec_vlad · TG @pereprodavec_usa</p>
</div>` : `
<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#0a0a0a;color:#f0f0f0;padding:32px;border-radius:12px">
  <div style="font-size:22px;font-weight:700;color:#c9a84c;margin-bottom:8px">AI DealCheck</div>
  <div style="font-size:16px;font-weight:600;margin-bottom:16px">Hey ${safeFirst},</div>
  <p style="color:#aaa;line-height:1.7;margin-bottom:20px">
    Your free deal analysis is waiting at <a href="https://aidealcheck.com" style="color:#c9a84c">aidealcheck.com</a>. Head back to see your results.
  </p>
  <p style="color:#aaa;line-height:1.7;margin-bottom:24px">
    If the deal looked complicated or you found red flags — <strong style="color:#f0f0f0">reach out directly</strong>. I have 10+ years inside US dealerships and can negotiate on your behalf.
  </p>
  <a href="https://www.instagram.com/pereprodavec_vlad/" style="display:inline-block;padding:12px 24px;background:#c9a84c;color:#000;font-weight:700;border-radius:8px;text-decoration:none;margin-right:8px">📱 Instagram</a>
  <a href="https://t.me/pereprodavec_usa" style="display:inline-block;padding:12px 24px;background:#229ED9;color:#fff;font-weight:700;border-radius:8px;text-decoration:none">✈️ Telegram</a>
  <p style="color:#555;font-size:12px;margin-top:32px">Vlad · IG @pereprodavec_vlad · TG @pereprodavec_usa</p>
</div>`;

    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM,
        to: safeEmail,
        subject,
        html
      })
    }).catch(e => console.error('[resend]', e.message)); // fire-and-forget
  }

  return res.status(200).json({ ok: true, imageUrls });
}
