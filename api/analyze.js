export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── IP Rate Limiting (Upstash Redis) ────────────────────────────────────────
  // Each full analysis = 2 API calls (extraction + full analysis).
  // Free limit: 1 analysis (2 calls) per IP per 72 hours.
  // Paid users bypass this on the client side via sessionStorage; the cap is
  // intentionally tight to stop browser/device hopping on free tier.
  // If Upstash env vars are absent the check is skipped (fail-open / backwards compat).
  const RATE_LIMIT    = 2;           // max API calls per window (= 1 full analysis)
  const WINDOW_SECS   = 72 * 3600;   // 72 hours

  const ip = (
    req.headers['x-forwarded-for'] ||
    req.socket?.remoteAddress ||
    'unknown'
  ).split(',')[0].trim();

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const base  = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      const key   = `rl:${ip}`;
      const auth  = { headers: { Authorization: `Bearer ${token}` } };

      // INCR atomically; on first call also set the expiry
      const incrRes  = await fetch(`${base}/incr/${key}`, auth);
      const { result: count } = await incrRes.json();

      if (count === 1) {
        // Fire-and-forget — a missed expire just means the key lives until next
        // INCR resets it; worst case: one window of free abuse, acceptable.
        fetch(`${base}/expire/${key}/${WINDOW_SECS}`, auth).catch(() => {});
      }

      if (count > RATE_LIMIT) {
        return res.status(429).json({
          error: {
            message:
              'Вы превысили лимит бесплатных проверок на этот час. ' +
              'Попробуйте снова через час или напишите @pereprodavec_usa в Instagram для персональной консультации. ' +
              '(Rate limit: too many requests from your IP — try again in an hour.)'
          }
        });
      }
    } catch (rlErr) {
      // Redis unavailable → let the request through rather than break the product
      console.error('[rate-limit] Redis error, failing open:', rlErr.message);
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
