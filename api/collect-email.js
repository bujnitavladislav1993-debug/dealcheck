export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { firstName, lastName, email, phone, ref } = req.body || {};
  if (!email || !email.includes('@') || email.length > 200) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  // Sanitize names (preserve unicode letters for Cyrillic, strip control chars / scripts)
  const cleanName = (s) => s ? String(s).replace(/[<>{}\\\/\[\]"`]/g, '').trim().slice(0, 60) : null;
  const safeFirst = cleanName(firstName);
  const safeLast  = cleanName(lastName);
  const safePhone = phone ? String(phone).replace(/[^0-9+\-() ]/g, '').slice(0, 20) : null;

  const base  = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (base && token) {
    try {
      const safeEmail = email.toLowerCase().trim().replace(/[^a-z0-9@._+-]/g, '');
      const key       = `lead:${Date.now()}:${safeEmail}`;
      const value     = JSON.stringify({
        firstName: safeFirst,
        lastName:  safeLast,
        email:     safeEmail,
        phone:     safePhone,
        ref:       ref || null,
        ts:        Date.now()
      });
      const auth      = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };

      await fetch(`${base}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, auth);
    } catch (e) {
      console.error('[collect-email] Redis error:', e.message);
    }
  }

  return res.status(200).json({ ok: true });
}
