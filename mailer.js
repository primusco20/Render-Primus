/**
 * mailer.js — transactional email via Resend's HTTP API.
 *
 * No SDK, no queue, no separate service — just fetch() calls from the
 * existing Express server, so this adds zero new infrastructure to
 * maintain. Node 20 (see render.yaml) has global fetch built in.
 *
 * Required env vars (set in the Render dashboard — never commit real
 * values into this file or render.yaml):
 *   RESEND_API_KEY   from resend.com/api-keys
 *   FROM_EMAIL       a verified sender on a domain you've added to Resend,
 *                    e.g. "Primus Barbershop <membership@primusbarbershop.com>"
 *                    — the domain must have SPF + DKIM verified in Resend,
 *                    see docs/EMAIL_SETUP.md for the exact DNS records.
 *
 * If either var is missing, every function here logs a warning and returns
 * { ok: false } instead of throwing — a missing/misconfigured mailer should
 * never break a payment or membership flow.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || '';

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function sendResendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !FROM_EMAIL) {
    console.warn('[mailer] RESEND_API_KEY or FROM_EMAIL not configured — skipping email to', to);
    return { ok: false, error: 'not_configured' };
  }
  if (!to) {
    console.warn('[mailer] no recipient address — skipping send:', subject);
    return { ok: false, error: 'no_recipient' };
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[mailer] Resend rejected email to', to, '—', resp.status, json);
      return { ok: false, error: json?.message || `resend_${resp.status}` };
    }
    return { ok: true, id: json.id };
  } catch (err) {
    console.error('[mailer] network error sending to', to, ':', err.message);
    return { ok: false, error: 'network_error' };
  }
}

// Shared visual wrapper so every email reads as "from the shop" rather than
// a bare block of text. Kept intentionally simple — no external images/CSS
// frameworks, so it renders consistently across mail clients.
function wrapEmail(businessName, bodyHtml) {
  return `<!doctype html>
<html>
  <body style="margin:0; padding:0; background:#0d0d0d; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" style="background:#0d0d0d; padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="480" style="max-width:92%; background:#171717; border-radius:14px; overflow:hidden;">
          <tr><td style="background:#c9a227; padding:20px 28px;">
            <div style="color:#0d0d0d; font-weight:800; font-size:18px; letter-spacing:0.3px;">${escapeHtml(businessName)}</div>
          </td></tr>
          <tr><td style="padding:28px; color:#e8e8e8; font-size:14px; line-height:1.6;">
            ${bodyHtml}
          </td></tr>
          <tr><td style="padding:16px 28px; background:#111; color:#777; font-size:11px;">
            This is an automated message — please don't reply directly to this email.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

// Email type 1: purchase / membership receipt.
async function sendPurchaseReceiptEmail({ businessName, name, email, membershipNumber, amount, currency, method, paidDate }) {
  const amountStr = amount != null ? `${currency || '₱'}${Number(amount).toLocaleString()}` : null;
  const html = wrapEmail(businessName, `
    <h2 style="margin:0 0 12px; color:#fff; font-size:20px;">Payment received</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <p>Thanks for your membership payment. Here's your receipt for your records:</p>
    <table role="presentation" style="width:100%; margin:16px 0; font-size:13px;">
      <tr><td style="color:#999; padding:4px 0;">Membership #</td><td style="text-align:right; font-weight:700; color:#fff;">${escapeHtml(membershipNumber)}</td></tr>
      ${amountStr ? `<tr><td style="color:#999; padding:4px 0;">Amount</td><td style="text-align:right;">${escapeHtml(amountStr)}</td></tr>` : ''}
      <tr><td style="color:#999; padding:4px 0;">Method</td><td style="text-align:right;">${escapeHtml(method || 'n/a')}</td></tr>
      <tr><td style="color:#999; padding:4px 0;">Date</td><td style="text-align:right;">${escapeHtml(paidDate)}</td></tr>
    </table>
    <p style="color:#aaa;">Your digital membership card is in a separate email — keep it handy for your member discount in-store.</p>
  `);
  return sendResendEmail({ to: email, subject: `Your ${businessName} membership receipt`, html });
}

// Email type 2: membership ID badge / card.
async function sendMembershipCardEmail({ businessName, name, email, membershipNumber, discountRate }) {
  const html = wrapEmail(businessName, `
    <h2 style="margin:0 0 12px; color:#fff; font-size:20px;">Your membership card</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <p>Show this at the counter for your member discount:</p>
    <table role="presentation" width="100%" style="margin:20px 0; border:2px solid #c9a227; border-radius:12px;">
      <tr><td style="padding:20px; text-align:center;">
        <div style="color:#c9a227; font-size:11px; letter-spacing:2px; text-transform:uppercase;">${escapeHtml(businessName)} Member</div>
        <div style="color:#fff; font-size:26px; font-weight:800; letter-spacing:1px; margin:10px 0;">${escapeHtml(membershipNumber)}</div>
        <div style="color:#ccc; font-size:13px;">${escapeHtml(name)}</div>
        ${discountRate ? `<div style="color:#999; font-size:12px; margin-top:8px;">${escapeHtml(discountRate)}% off every visit</div>` : ''}
      </td></tr>
    </table>
    <p style="color:#999; font-size:12px;">Lost this email? Use "Resend my card" on our booking page and we'll send it again.</p>
  `);
  return sendResendEmail({ to: email, subject: `Your ${businessName} membership card — ${membershipNumber}`, html });
}

// Fires both emails for a newly-paid/approved membership. Uses
// allSettled so one failing never suppresses the other, and never throws —
// callers fire this in the background and log failures on their own.
async function sendMembershipWelcomeEmails(businessName, record) {
  return Promise.allSettled([
    sendPurchaseReceiptEmail({ businessName, ...record }),
    sendMembershipCardEmail({ businessName, ...record }),
  ]);
}

module.exports = {
  sendResendEmail,
  sendPurchaseReceiptEmail,
  sendMembershipCardEmail,
  sendMembershipWelcomeEmails,
};
