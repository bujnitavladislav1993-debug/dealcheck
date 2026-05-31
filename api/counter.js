const SEED = 847; // display offset — real Redis count starts at 0, displayed as 847+

export default async function handler(req, res) {
  const base  = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!base || !token) {
    return res.status(200).json({ count: null });
  }

  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const KEY  = 'dealcheck:global_count';

  try {
    if (req.method === 'POST') {
      const r = await fetch(`${base}/incr/${KEY}`, auth);
      const { result } = await r.json();
      return res.status(200).json({ count: (parseInt(result) || 1) + SEED - 1 });
    } else {
      const r = await fetch(`${base}/get/${KEY}`, auth);
      const { result } = await r.json();
      return res.status(200).json({ count: (parseInt(result) || 0) + SEED });
    }
  } catch (e) {
    console.error('[counter]', e.message);
    return res.status(200).json({ count: null });
  }
}
