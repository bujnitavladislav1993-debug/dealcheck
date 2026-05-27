export default async function handler(req, res) {
  const adminKey = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const base  = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) {
    return res.status(500).json({ error: 'Redis not configured' });
  }

  const auth = { headers: { Authorization: `Bearer ${token}` } };

  try {
    // 1. Get all lead keys
    const keysRes = await fetch(`${base}/keys/lead:*`, auth);
    const { result: keys } = await keysRes.json();
    if (!keys || keys.length === 0) {
      return res.status(200).json({ count: 0, leads: [] });
    }

    // 2. Bulk-fetch their values via MGET
    const mgetPath  = keys.map((k) => encodeURIComponent(k)).join('/');
    const valuesRes = await fetch(`${base}/mget/${mgetPath}`, auth);
    const { result: values } = await valuesRes.json();

    // 3. Parse & merge
    const leads = values.map((v, i) => {
      try {
        return { key: keys[i], ...(JSON.parse(v)) };
      } catch {
        return { key: keys[i], raw: v, parseError: true };
      }
    });

    // 4. Sort newest first
    leads.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    // 5. CSV export branch
    if (req.query.format === 'csv') {
      const header = ['Date', 'First Name', 'Last Name', 'Email', 'Phone', 'Deal Type', 'Attachment', 'Lang', 'Deal Text', 'Ref'];
      const esc    = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows   = leads.map((l) => [
        l.ts ? new Date(l.ts).toISOString() : '',
        l.firstName     || '',
        l.lastName      || '',
        l.email         || '',
        l.phone         || '',
        l.dealType      || '',
        l.hasAttachment ? 'yes' : '',
        l.lang          || '',
        l.dealText      || '',
        l.ref           || ''
      ].map(esc).join(','));
      const csv = [header.join(','), ...rows].join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="leads-${Date.now()}.csv"`);
      return res.status(200).send(csv);
    }

    return res.status(200).json({ count: leads.length, leads });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
