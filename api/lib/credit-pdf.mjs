// Fills the real dealer Credit Application AcroForm from a /apply submission and
// stamps the applicant's electronic signature onto the signature line.
//
// The template is a 2-page AcroForm with 196 named fields. Field names and the
// year/month ("HOW LONG?") column assignments below were read off the template's
// widget geometry, not guessed -- e.g. the employer row's duration is
// hl_year6/hl_month6, while hl_year3/hl_month3 is the separate
// "LIVED IN THE COMMUNITY?" column on the previous-address row.
//
// The form is deliberately NOT flattened: Vlad still needs to type SELLER /
// STOCK NO / VIN / amount requested before sending it to a lender. The
// signature is drawn as page content (not a form field), so it cannot be
// edited away by filling the remaining fields.

import fs from 'fs';
import { PDFDocument, StandardFonts, rgb, PDFName, PDFBool } from 'pdf-lib';

// Resolved relative to this module so it works both locally and inside the
// Vercel function bundle. vercel.json's `includeFiles` keeps the template in
// the bundle -- without it the file is traced away and this read throws.
const TEMPLATE_PATH = new URL('../assets/credit-app-template.pdf', import.meta.url);

// ── helpers ─────────────────────────────────────────────────────────────────

const s = v => (v === undefined || v === null ? '' : String(v).trim());

// ── Cyrillic -> Latin ───────────────────────────────────────────────────────
// Two reasons this is not optional:
//  1. The PDF's standard fonts are WinAnsi-encoded. Writing Cyrillic through
//     them throws on encode, and a viewer that re-renders the field shows
//     boxes or nothing at all.
//  2. A US lender cannot process a credit application in Cyrillic anyway.
// The original text (whatever the applicant typed) is preserved verbatim in
// the notification e-mail body, so nothing is lost.
const CYR = {
  а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'e', ж:'zh', з:'z', и:'i',
  й:'y', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t',
  у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh', щ:'shch', ъ:'', ы:'y',
  ь:'', э:'e', ю:'yu', я:'ya',
  // Ukrainian / other Cyrillic letters that turn up in names
  і:'i', ї:'yi', є:'ye', ґ:'g', ў:'u',
};

/** Transliterate Cyrillic and drop anything the base fonts can't encode. */
function latin(str) {
  let out = '';
  for (const ch of s(str)) {
    const lower = ch.toLowerCase();
    if (CYR[lower] !== undefined) {
      const t = CYR[lower];
      out += ch === lower ? t : t.charAt(0).toUpperCase() + t.slice(1);
    } else if (ch.charCodeAt(0) < 256) {
      out += ch;                       // Latin-1 range: safe for WinAnsi
    } else if ('—–‒'.includes(ch)) {
      out += '-';
    } else if ('“”„'.includes(ch)) {
      out += '"';
    } else if ('‘’'.includes(ch)) {
      out += "'";
    } else if (ch === '…') {
      out += '...';
    }
    // anything else (emoji, CJK, ...) is dropped rather than risking a throw
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** "1234.5" | "$1,234" -> 1234.5 ; anything unparseable -> 0 */
const num = v => {
  const n = parseFloat(s(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const money = v => (num(v) ? '$' + num(v).toLocaleString('en-US') : '');

/** Join non-empty parts with a separator, collapsing whitespace. */
const join = (parts, sep = ', ') =>
  parts.map(s).filter(Boolean).join(sep).replace(/\s+/g, ' ').trim();

/** "Smith" + "Jr." -> "Smith Jr." */
const lastWithSuffix = (last, suffix) => join([last, suffix], ' ');

/** Full street address line: "123 Main St, Irvine, CA 92618" */
const addrLine = (street, city, state, zip) =>
  join([street, city, join([state, zip], ' ')]);

// ── field map ───────────────────────────────────────────────────────────────
// webKey -> pdfFieldName, for plain text fields.

function textMap(d) {
  const totalIncome = num(d['monthly-income']) + num(d['other-income']);
  const coTotal = num(d['co-monthly-income']);

  const map = {
    // Header (seller side). Vlad fills stock/VIN/amount per deal.
    seller: 'DealCheck LLC',
    date: d._date,

    // ── Section A: applicant ──
    L_NAME: lastWithSuffix(d['last-name'], d['suffix']),
    f_NAME: d['first-name'],
    initial: d['middle-initial'],
    b_day: d['dob'],
    dl_number: join([d['dl-number'], d['dl-state']], ' / '),
    'ss-fed': d['ssn'],

    // Residence. phone1 is the address-row phone: prefer home, fall back to cell.
    add1: d['address'],
    city1: d['city'],
    state1: d['state'],
    zip1: d['zip'],
    phone1: s(d['home-phone']) || s(d['cell-phone']),
    hl_year: d['address-years'],
    hl_month: d['address-months'],

    // Previous residence (hl_*2 = how long there; hl_*3 = lived in community)
    previous_address: addrLine(d['prev-address'], d['prev-city'], d['prev-state'], d['prev-zip']),
    hl_year2: d['prev-address-years'],
    hl_month2: d['prev-address-months'],

    // Employment (hl_*6 = how long at present employer)
    occ_title: d['occupation'],
    present_employer: d['employer'],
    phone2: d['work-phone'],
    hl_year6: d['employer-years'],
    hl_month6: d['employer-months'],
    emp_address: d['employer-address'],

    // Previous employment (hl_*7 = how long there)
    prev_emp: join([d['prev-employer'], d['prev-occupation']], ' — '),
    emp_phone1: d['prev-work-phone'],
    hl_year7: d['prev-employer-years'],
    hl_month7: d['prev-employer-months'],
    prev_emp2: d['prev-employer-address'],

    // Income: inc1 = gross monthly from employment, inc3 = other monthly,
    // inc4 = total monthly. inc2 is the alimony/support line (not collected).
    primary_inc1: money(d['monthly-income']),
    primary_inc3: money(d['other-income']),
    primary_inc4: totalIncome ? money(totalIncome) : '',

    // Rent / mortgage payment (page 2, applicant row)
    payment1: money(d['rent-amount']),

    // ── Section B: co-applicant ──
    L_NAME2: d['co-last-name'],
    f_NAME2: d['co-first-name'],
    initial2: d['co-middle-initial'],
    b_day2: d['co-dob'],
    dl_number2: join([d['co-dl-number'], d['co-dl-state']], ' / '),
    'ss-fed2': d['co-ssn'],
    co_phone1: d['co-cell-phone'],
    co_occ_title: d['co-occupation'],
    co_present_employer: d['co-employer'],
    co_phone2: d['co-work-phone'],
    co_primary_inc1: money(d['co-monthly-income']),
    co_primary_inc4: coTotal ? money(coTotal) : '',
  };

  // A co-applicant living at the same address: mirror it so the lender sees it.
  if (s(d['co-first-name']) && s(d['co-last-name'])) {
    map.co_add1 = d['address'];
    map.co_city1 = d['city'];
    map.co_state1 = d['state'];
    map.co_zip1 = d['zip'];
  }

  return map;
}

// ── main ────────────────────────────────────────────────────────────────────

/**
 * Fill the template and stamp the signature.
 *
 * @param {object} data   Flat form submission (web field names).
 * @param {object} opts
 * @param {string} [opts.signaturePng]  data: URL of the drawn signature.
 * @param {string} [opts.signedName]    Typed legal name (fallback + certificate).
 * @param {string} [opts.ip]            Submitter IP, for the audit trail.
 * @param {string} [opts.userAgent]
 * @param {string} [opts.consentText]   The exact consent the applicant accepted.
 * @param {Date}   [opts.signedAt]
 * @returns {Promise<{bytes: Uint8Array, filled: string[], missing: string[]}>}
 */
export async function fillCreditApp(data, opts = {}) {
  const signedAt = opts.signedAt || new Date();
  const d = Object.assign({}, data, {
    _date: signedAt.toLocaleDateString('en-US'),
  });

  const pdf = await PDFDocument.load(fs.readFileSync(TEMPLATE_PATH));
  const form = pdf.getForm();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const timesItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);

  const filled = [];
  const missing = [];

  // Text fields
  const map = textMap(d);
  for (const [name, raw] of Object.entries(map)) {
    const val = latin(raw);
    if (!val) continue;
    let f;
    try {
      f = form.getTextField(name);
    } catch (e) {
      missing.push(name);          // field genuinely absent from the template
      continue;
    }
    f.setText(val);
    // The template's fields carry no /DA entry, so setFontSize() would throw
    // ("No /DA (default appearance) entry found"). Install one first, sized to
    // the value so long strings still fit the narrow boxes.
    const size = val.length > 46 ? 6 : val.length > 28 ? 7 : 8;
    try {
      f.acroField.setDefaultAppearance(`/Helv ${size} Tf 0 g`);
    } catch (e) { /* appearance falls back to the viewer default */ }
    filled.push(name);
  }

  // Own / rent radio (page 2, applicant row)
  const ownRent = s(d['rent-own']).toLowerCase();
  if (ownRent) {
    const choice = /own|mortgage|свой|собств/.test(ownRent) ? 'own'
                 : /rent|аренд|сним/.test(ownRent) ? 'rent'
                 : null;
    if (choice) {
      try { form.getRadioGroup('own_rent1').select(choice); filled.push('own_rent1'); }
      catch (e) { missing.push('own_rent1'); }
    }
  }

  // "Amount of other monthly income and source(s)" -- the source goes on the
  // dotted leader line, which has no form field of its own.
  const src = latin(d['other-income-source']);
  if (src) {
    const p0 = pdf.getPages()[0];
    p0.drawRectangle({ x: 168, y: 400, width: 300, height: 11, color: rgb(1, 1, 1) });
    p0.drawText(src.slice(0, 70), { x: 170, y: 403, size: 7, font: helv, color: rgb(0, 0, 0) });
  }

  // ── Signature ─────────────────────────────────────────────────────────────
  // sig rect on page 2: x=28 y=129 w=258 h~17. Draw above the printed "x ____".
  const page2 = pdf.getPages()[1];
  const SIG = { x: 30, y: 118, w: 254, h: 30 };
  let signatureKind = 'none';

  if (opts.signaturePng && /^data:image\/png;base64,/.test(opts.signaturePng)) {
    const b64 = opts.signaturePng.replace(/^data:image\/png;base64,/, '');
    const png = await pdf.embedPng(Buffer.from(b64, 'base64'));
    // Fit inside the box, preserving aspect ratio.
    const scale = Math.min(SIG.w / png.width, SIG.h / png.height);
    const w = png.width * scale;
    const h = png.height * scale;
    page2.drawImage(png, { x: SIG.x, y: SIG.y, width: w, height: h });
    signatureKind = 'drawn';
  } else if (latin(opts.signedName)) {
    page2.drawText(latin(opts.signedName), {
      x: SIG.x + 2, y: SIG.y + 4, size: 14, font: timesItalic, color: rgb(0, 0, 0.6),
    });
    signatureKind = 'typed';
  }

  if (signatureKind !== 'none') {
    page2.drawText(`Electronically signed ${signedAt.toLocaleString('en-US')}`, {
      x: SIG.x, y: SIG.y - 9, size: 5.5, font: helv, color: rgb(0.35, 0.35, 0.35),
    });
  }

  // ── Electronic signature certificate (appended page) ──────────────────────
  const cert = pdf.addPage([612, 792]);
  let y = 740;
  const line = (text, { size = 9, font = helv, gap = 14, color = rgb(0.1, 0.1, 0.1) } = {}) => {
    cert.drawText(text, { x: 54, y, size, font, color });
    y -= gap;
  };

  line('ELECTRONIC SIGNATURE CERTIFICATE', { size: 13, font: helvBold, gap: 10 });
  line('DealCheck LLC — Credit Application', { size: 9, color: rgb(0.4, 0.4, 0.4), gap: 24 });

  const rows = [
    ['Applicant', join([d['first-name'], d['middle-initial'], lastWithSuffix(d['last-name'], d['suffix'])], ' ')],
    ['Typed legal name', s(opts.signedName)],
    ['Signature method', signatureKind === 'drawn' ? 'Drawn on touchscreen / mouse' : signatureKind === 'typed' ? 'Typed legal name' : 'Not captured'],
    ['Signed at (UTC)', signedAt.toISOString()],
    ['Signed at (local)', signedAt.toLocaleString('en-US')],
    ['Submitted from', s(opts.ip) || 'unavailable'],
    ['Browser', s(opts.userAgent).slice(0, 78) || 'unavailable'],
    ['Source', 'https://aidealcheck.com/apply'],
    ['E-mail on file', s(d['email'])],
    ['Cell phone on file', s(d['cell-phone'])],
  ];
  for (const [k, raw] of rows) {
    const v = latin(raw);
    if (!v) continue;
    cert.drawText(k, { x: 54, y, size: 8, font: helvBold, color: rgb(0.3, 0.3, 0.3) });
    cert.drawText(v, { x: 170, y, size: 8, font: helv, color: rgb(0, 0, 0) });
    y -= 13;
  }

  y -= 12;
  line('CONSENT ACCEPTED BY APPLICANT', { size: 9, font: helvBold, gap: 14 });

  const consent = latin(opts.consentText) || '(consent text not recorded)';
  for (const chunk of wrap(consent, 108)) {
    cert.drawText(chunk, { x: 54, y, size: 7.5, font: helv, color: rgb(0.15, 0.15, 0.15) });
    y -= 10;
    if (y < 70) break;
  }

  // Appearances: without this some viewers (notably Preview.app) show blanks.
  try { form.updateFieldAppearances(helv); } catch (e) { /* non-fatal */ }
  pdf.catalog.getOrCreateAcroForm().dict.set(PDFName.of('NeedAppearances'), PDFBool.True);

  return { bytes: await pdf.save(), filled, missing, signatureKind };
}

/** Greedy word wrap to `width` characters. */
function wrap(text, width) {
  const words = s(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { if (cur) lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}
