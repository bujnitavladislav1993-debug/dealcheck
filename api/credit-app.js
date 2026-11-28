import { fillCreditApp } from './lib/credit-pdf.mjs';
import { sendBrevoEmail } from './lib/brevo.js';

// Receives a /apply submission, fills the real dealer Credit Application PDF,
// stamps the applicant's electronic signature, and e-mails the finished PDF to
// Vlad with the raw submission in the body.
//
// Deliberately NOT stored in Vercel Blob. Blob URLs are public (unguessable,
// but public), and this payload carries SSN + driver's licence numbers. The
// only copy leaves over Brevo straight to the inbox.
//
// Nothing here logs field values -- only field *names* and counts -- so an SSN
// never lands in Vercel's function logs.

const MAX_BODY_FIELDS = 120;
const MAX_VALUE_LEN   = 400;
const MAX_SIG_BYTES   = 400 * 1024;      // a 600x160 PNG signature is ~10-40 KB

const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Mask all but the last 4 so the e-mail body doesn't carry a bare SSN twice. */
const maskId = v => {
  const digits = String(v || '').replace(/\D/g, '');
  if (digits.length < 4) return String(v || '');
  return '•••-••-' + digits.slice(-4);
};

const SENSITIVE = new Set(['ssn', 'co-ssn']);

// Human labels for the e-mail body, in form order.
const LABELS = {
  'first-name': 'First name', 'middle-initial': 'MI', 'last-name': 'Last name',
  suffix: 'Suffix', ssn: 'SSN', dob: 'Date of birth',
  'dl-number': "Driver's licence #", 'dl-state': 'DL state',
  address: 'Address', city: 'City', state: 'State', zip: 'ZIP',
  'home-phone': 'Home phone', 'cell-phone': 'Cell phone', email: 'E-mail',
  'rent-own': 'Own / rent', 'rent-amount': 'Rent or mortgage',
  'address-years': 'Years at address', 'address-months': 'Months at address',
  'prev-address': 'Previous address', 'prev-city': 'Previous city',
  'prev-state': 'Previous state', 'prev-zip': 'Previous ZIP',
  'prev-address-years': 'Years at previous address',
  'prev-address-months': 'Months at previous address',
  employer: 'Employer', occupation: 'Occupation',
  'employer-address': 'Employer address',
  'employer-years': 'Years at employer', 'employer-months': 'Months at employer',
  'work-phone': 'Work phone', 'monthly-income': 'Gross monthly income',
  'other-income': 'Other monthly income', 'other-income-source': 'Other income source',
  'prev-employer': 'Previous employer', 'prev-occupation': 'Previous occupation',
  'prev-employer-address': 'Previous employer address',
  'prev-employer-years': 'Years at previous employer',
  'prev-employer-months': 'Months at previous employer',
  'prev-work-phone': 'Previous work phone',
  'co-first-name': 'Co-applicant first name', 'co-middle-initial': 'Co-applicant MI',
  'co-last-name': 'Co-applicant last name', 'co-ssn': 'Co-applicant SSN',
  'co-dob': 'Co-applicant date of birth',
  'co-dl-number': "Co-applicant driver's licence #", 'co-dl-state': 'Co-applicant DL state',
  'co-cell-phone': 'Co-applicant cell', 'co-email': 'Co-applicant e-mail',
  'co-employer': 'Co-applicant employer', 'co-occupation': 'Co-applicant occupation',
  'co-monthly-income': 'Co-applicant monthly income',
  'co-work-phone': 'Co-applicant work phone',
};

/** Light per-IP throttle: 6 submissions per hour. Fails open. */
async function rateLimited(ip) {
  const base  = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token || !ip) return false;
  try {
    const key  = `creditapp:rl:${ip}`;
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const r = await fetch(`${base}/incr/${encodeURIComponent(key)}`, auth);
    const n = (await r.json()).result;
    if (n === 1) await fetch(`${base}/expire/${encodeURIComponent(key)}/3600`, auth);
    return n > 6;
  } catch (e) {
    return false;                         // never block a real applicant on Redis
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const body = req.body || {};
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
  const { signaturePng, signedName, consentText } = body;

  // ── Validate ──────────────────────────────────────────────────────────────
  const keys = Object.keys(fields);
  if (!keys.length || keys.length > MAX_BODY_FIELDS) {
    return res.status(400).json({ ok: false, error: 'bad_payload' });
  }

  const clean = {};
  for (const k of keys) {
    const v = fields[k];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    clean[k] = String(v).slice(0, MAX_VALUE_LEN);
  }

  const first = (clean['first-name'] || '').trim();
  const last  = (clean['last-name']  || '').trim();
  if (!first || !last) {
    return res.status(400).json({ ok: false, error: 'name_required' });
  }
  if (!String(signedName || '').trim()) {
    return res.status(400).json({ ok: false, error: 'signature_name_required' });
  }

  let sigPng = typeof signaturePng === 'string' ? signaturePng : '';
  if (sigPng) {
    if (!/^data:image\/png;base64,/.test(sigPng)) sigPng = '';
    else if (Buffer.byteLength(sigPng, 'utf8') > MAX_SIG_BYTES) sigPng = '';
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket?.remoteAddress || '';

  if (await rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'too_many' });
  }

  // ── Fill the PDF ──────────────────────────────────────────────────────────
  let pdf;
  try {
    pdf = await fillCreditApp(clean, {
      signaturePng: sigPng,
      signedName:   String(signedName).slice(0, 120),
      consentText:  String(consentText || '').slice(0, 2000),
      ip,
      userAgent:    String(req.headers['user-agent'] || '').slice(0, 200),
      signedAt:     new Date(),
    });
    console.log('[credit-app] filled', pdf.filled.length, 'fields; signature:', pdf.signatureKind,
                pdf.missing.length ? `; unmapped: ${pdf.missing.join(',')}` : '');
  } catch (e) {
    console.error('[credit-app] pdf fill failed:', e.message);
    return res.status(500).json({ ok: false, error: 'pdf_failed' });
  }

  // ── E-mail it ─────────────────────────────────────────────────────────────
  const rows = Object.keys(LABELS)
    .filter(k => (clean[k] || '').trim())
    .map(k => {
      const shown = SENSITIVE.has(k) ? maskId(clean[k]) : clean[k];
      return `<tr>
        <td style="padding:4px 10px 4px 0;color:#888;font-size:12px;white-space:nowrap">${esc(LABELS[k])}</td>
        <td style="padding:4px 0;font-size:13px;color:#111"><strong>${esc(shown)}</strong></td>
      </tr>`;
    }).join('');

  const name = `${first} ${last}`;
  const fileSafe = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'applicant';
  const stamp = new Date().toISOString().slice(0, 10);

  const html = `
<div style="font-family:-apple-system,Inter,Segoe UI,sans-serif;max-width:620px;margin:0 auto">
  <div style="background:#0C447C;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.75">Signed credit application</div>
    <div style="font-size:21px;font-weight:700;margin-top:3px">${esc(name)}</div>
  </div>
  <div style="border:1px solid #e5e3dd;border-top:none;padding:20px 22px;border-radius:0 0 10px 10px;background:#fff">
    <p style="margin:0 0 14px;font-size:13px;color:#333">
      The completed, signed PDF is attached — ready to send to a lender.
      Fill in <strong>SELLER / STOCK NO / VIN / AMOUNT REQUESTED</strong> at the top before you submit it.
    </p>
    <div style="background:#f6f5f2;border-radius:8px;padding:12px 14px;margin-bottom:16px;font-size:12px;color:#444">
      Signed by <strong>${esc(signedName)}</strong> — ${esc(pdf.signatureKind === 'drawn' ? 'drawn signature' : 'typed name')},
      ${esc(new Date().toLocaleString('en-US'))}${ip ? ` — IP ${esc(ip)}` : ''}.
      Full audit trail is on the last page of the PDF.
    </div>
    <table style="border-collapse:collapse;width:100%">${rows}</table>
    <p style="margin:18px 0 0;font-size:11px;color:#999">
      SSN is masked here on purpose — the full number is in the attached PDF.
    </p>
  </div>
</div>`;

  const sent = await sendBrevoEmail({
    to:      process.env.ADMIN_NOTIFY_EMAIL || 'carswithvlad1@gmail.com',
    toName:  'Vlad',
    subject: `📝 Signed credit app: ${name}`,
    html,
    tags:    ['credit-app'],
    attachments: [{
      name:    `credit-app-${fileSafe}-${stamp}.pdf`,
      content: Buffer.from(pdf.bytes).toString('base64'),
    }],
  });

  if (!sent) {
    // The applicant must not be told "fine" if nothing reached Vlad — the
    // frontend falls back to its EmailJS path on a non-2xx.
    console.error('[credit-app] brevo send failed for', fileSafe);
    return res.status(502).json({ ok: false, error: 'email_failed' });
  }

  return res.status(200).json({ ok: true, signature: pdf.signatureKind });
}
