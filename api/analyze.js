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

  // Dev/testing bypass — when DEV_KEY env var is set and the request header matches,
  // skip rate limiting entirely. Used by the developer browser via ?dev=KEY.
  // Trim both sides — a trailing space/newline pasted into the Vercel env value
  // (or the URL) is the most common reason a correct-looking key fails to match.
  const sentDevKey = (req.headers['x-dev-key'] || '').trim();
  const envDevKey  = (process.env.DEV_KEY || '').trim();
  const isDevRequest = envDevKey.length > 0 && sentDevKey === envDevKey;

  // Lightweight dev-key check — lets the client confirm the bypass actually works
  // server-side (DEV_KEY set AND matching) without spending an Anthropic call.
  if (req.body?.devcheck) {
    // Diagnostic-only: lengths (not values) + first/last char of the SENT key so
    // a mismatch can be pinpointed without leaking the secret. Safe to expose.
    return res.status(200).json({
      dev: !!isDevRequest,
      envSet: envDevKey.length > 0,
      envLen: envDevKey.length,
      sentLen: sentDevKey.length,
      sentEdge: sentDevKey ? sentDevKey[0] + '…' + sentDevKey[sentDevKey.length - 1] : ''
    });
  }

  if (!isDevRequest && isFullAnalysis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
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
              'Вы уже использовали бесплатный анализ. ' +
              'Попробуйте снова через 72 часа или напишите @pereprodavec_usa в Instagram для персональной консультации. ' +
              '(Rate limit: 1 free analysis per IP per 72 hours.)'
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

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      // Anthropic (or an upstream proxy) returned non-JSON — usually an HTML/text
      // error page on 5xx. Wrap it so the client always gets a usable error.message.
      return res.status(response.status || 502).json({
        error: { message: (raw || 'Upstream returned a non-JSON response').slice(0, 300) }
      });
    }
    return res.status(response.status).json(data);
  } catch (error) {
    // fetch itself failed (network, timeout abort, etc.)
    return res.status(500).json({ error: { message: error.message } });
  }
}
