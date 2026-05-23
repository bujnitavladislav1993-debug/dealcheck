export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── IP Rate Limiting (Upstash Redis) ────────────────────────────────────────
  // Two-step flow: extraction call (max_tokens ≤ 500) + full analysis call.
  // We only count the FULL analysis call so the limit of 1 means exactly 1 free analysis.
  // Extraction calls are never counted — blocking them mid-flow would break the UX.
  // If Upstash env vars are absent the check is skipped (fail-open / backwards compat).
  const RATE_LIMIT    = 1;           // 1 free full analysis per IP
  const WINDOW_SECS   = 72 * 3600;   // 72-hour window
  const isFullAnalysis = (req.body?.max_tokens || 0) > 500;

  const ip = (
    req.headers['x-forwarded-for'] ||
    req.socket?.remoteAddress ||
    'unknown'
  ).split(',')[0].trim();

  if (isFullAnalysis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
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
