// Brevo transactional email helper.
// Sends one email via Brevo's REST API. Fails open (returns false) so calling code
// can fire-and-forget without try/catch around it.
//
// Requires env vars:
//   BREVO_API_KEY   — from Brevo → Settings → SMTP & API → API keys
//   BREVO_FROM_EMAIL — sender address on an authenticated domain (e.g. vlad@aidealcheck.com)
//   BREVO_FROM_NAME  — display name (defaults to "AI DealCheck" if not set)
//
// Replies route to carswithvlad1@gmail.com so Vlad reads everything from his Gmail.

export async function sendBrevoEmail({ to, toName, subject, html, tags }) {
  const apiKey    = process.env.BREVO_API_KEY;
  const fromEmail = process.env.BREVO_FROM_EMAIL;
  const fromName  = process.env.BREVO_FROM_NAME || 'AI DealCheck';
  if (!apiKey || !fromEmail || !to) return false;

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept':       'application/json',
        'api-key':      apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender:  { name: fromName, email: fromEmail },
        to:      [{ email: to, name: toName || to.split('@')[0] }],
        replyTo: { email: 'carswithvlad1@gmail.com', name: 'Vlad' },
        subject,
        htmlContent: html,
        tags: Array.isArray(tags) && tags.length ? tags : undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[brevo] send failed', res.status, body.slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[brevo] send error', e.message);
    return false;
  }
}
