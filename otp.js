/**
 * otp.js — one-time codes for logins and sensitive lookups.
 * ===========================================================================
 * Replaces the browser-side Face ID check as the actual second factor. That
 * check compared a descriptor in the visitor's own JavaScript, so anyone could
 * call the success path from devtools; this one requires possession of an
 * inbox the server sends to, which the browser cannot fake.
 *
 * Design notes, in the order they matter:
 *
 *  1. CODES ARE HASHED AT REST. The pending-code table lives in the same state
 *     blob as everything else. Storing plaintext codes there would mean a
 *     future read-leak of that blob hands over live second factors. Each code
 *     gets its own random salt, so two identical codes hash differently and
 *     the table can't be attacked with one precomputed set.
 *
 *  2. VERIFICATION IS CONSTANT-TIME. A plain === on a 6-digit code leaks how
 *     many leading digits matched through response timing.
 *
 *  3. FAILED ATTEMPTS BURN THE CODE. Six digits is a million combinations, but
 *     an unbounded retry loop reduces that to minutes of scripted guessing.
 *     Five wrong tries invalidates it and a new one must be requested.
 *
 *  4. REQUESTS ARE THROTTLED PER IDENTIFIER, not just per IP — an attacker
 *     rotating IPs could otherwise flood a real person's inbox, and a mailbox
 *     full of codes is how people get trained to ignore them.
 *
 *  5. ENUMERATION IS NOT POSSIBLE THROUGH THIS. The request endpoint answers
 *     identically whether or not the address exists, so it can't be used to
 *     discover who has an account.
 *
 * Codes are delivered by email through the existing Resend mailer. There is no
 * SMS path: adding one needs a provider account (in PH, Semaphore or Twilio),
 * and email is what this deployment can already send today.
 */

const crypto = require('crypto');
const mailer = require('./mailer');

const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;      // 10 minutes
const MAX_ATTEMPTS = 5;                   // wrong guesses before the code dies
const MAX_REQUESTS_PER_WINDOW = 3;        // per identifier
const REQUEST_WINDOW_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;     // no "resend" spam

// Where pending codes live inside the state blob. Underscore-prefixed to match
// _payments, and explicitly stripped from the public payload in server.js.
const STORE_KEY = '_otp';

function store(state) {
  if (!state[STORE_KEY]) state[STORE_KEY] = {};
  return state[STORE_KEY];
}

// purpose keeps codes from being reused across flows: a code mailed for a
// membership lookup must not unlock an owner login.
function slot(purpose, identifier) {
  return `${purpose}:${String(identifier || '').trim().toLowerCase()}`;
}

function generateCode() {
  // randomInt is drawn from the CSPRNG; Math.random() is predictable enough
  // that a determined attacker can narrow the space.
  const max = 10 ** CODE_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(CODE_LENGTH, '0');
}

function hashCode(code, salt) {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function codesMatch(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Drops expired entries so the table can't grow without bound.
function prune(state, now = Date.now()) {
  const table = store(state);
  let removed = 0;
  for (const [key, rec] of Object.entries(table)) {
    const staleWindow = (rec.windowStart || 0) + REQUEST_WINDOW_MS;
    if (rec.expiresAt < now && staleWindow < now) { delete table[key]; removed++; }
  }
  return removed;
}

function emailHtml(businessName, code, purposeLabel) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0d0d0d;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" style="background:#0d0d0d;padding:32px 0;"><tr><td align="center">
    <table role="presentation" width="480" style="max-width:92%;background:#171717;border-radius:14px;overflow:hidden;">
      <tr><td style="background:#c9a227;padding:20px 28px;">
        <div style="color:#0d0d0d;font-weight:800;font-size:18px;">${escapeHtml(businessName)}</div>
      </td></tr>
      <tr><td style="padding:28px;color:#e8e8e8;font-size:14px;line-height:1.6;">
        <h2 style="margin:0 0 12px;color:#fff;font-size:20px;">Your verification code</h2>
        <p style="color:#bbb;">Use this code to ${escapeHtml(purposeLabel)}. It expires in 10 minutes.</p>
        <div style="margin:22px 0;text-align:center;">
          <span style="display:inline-block;background:#0d0d0d;border:2px solid #c9a227;border-radius:12px;
                       padding:16px 26px;color:#fff;font-size:30px;font-weight:800;letter-spacing:10px;">${escapeHtml(code)}</span>
        </div>
        <p style="color:#999;font-size:12px;">If you didn't request this, you can ignore this email — nothing has changed on your account. Never share this code with anyone, including staff.</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Issues a code and emails it.
 *
 * Returns { ok, reason?, retryAfterMs? }. `ok:false` here means throttled or
 * undeliverable — the CALLER decides what to tell the user, and for login
 * flows it should report success either way so the endpoint can't be used to
 * discover which addresses are real.
 */
async function requestCode({ state, purpose, identifier, email, businessName, purposeLabel }) {
  const now = Date.now();
  prune(state, now);
  const table = store(state);
  const key = slot(purpose, identifier);
  const existing = table[key];

  // Throttle: per-identifier window, plus a cooldown between sends.
  if (existing) {
    const windowStart = existing.windowStart || 0;
    const inWindow = now - windowStart < REQUEST_WINDOW_MS;
    if (inWindow && (existing.requestCount || 0) >= MAX_REQUESTS_PER_WINDOW) {
      return { ok: false, reason: 'throttled', retryAfterMs: windowStart + REQUEST_WINDOW_MS - now };
    }
    if (existing.lastSentAt && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown', retryAfterMs: existing.lastSentAt + RESEND_COOLDOWN_MS - now };
    }
  }

  const code = generateCode();
  const salt = crypto.randomBytes(16).toString('hex');
  const windowStart = (existing && now - (existing.windowStart || 0) < REQUEST_WINDOW_MS)
    ? existing.windowStart : now;

  table[key] = {
    salt,
    hash: hashCode(code, salt),
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    windowStart,
    requestCount: (existing && windowStart === existing.windowStart ? (existing.requestCount || 0) : 0) + 1,
    lastSentAt: now,
    email,
  };

  const sent = await mailer.sendResendEmail({
    to: email,
    subject: `${code} is your ${businessName || 'verification'} code`,
    html: emailHtml(businessName || 'Verification', code, purposeLabel || 'sign in'),
  });

  if (!sent || sent.ok === false) {
    // Don't leave a live code behind that the person can never receive.
    delete table[key];
    return { ok: false, reason: 'send_failed' };
  }
  return { ok: true };
}

/**
 * Checks a code. Returns { ok, reason? } where reason is one of:
 * no_code | expired | too_many_attempts | mismatch.
 *
 * A successful verification consumes the code — it cannot be replayed.
 */
function verifyCode({ state, purpose, identifier, code }) {
  const now = Date.now();
  const table = store(state);
  const key = slot(purpose, identifier);
  const rec = table[key];

  if (!rec || !rec.hash) return { ok: false, reason: 'no_code' };
  if (rec.expiresAt < now) { delete table[key]; return { ok: false, reason: 'expired' }; }
  if ((rec.attempts || 0) >= MAX_ATTEMPTS) { delete table[key]; return { ok: false, reason: 'too_many_attempts' }; }

  const supplied = String(code || '').trim();
  const match = codesMatch(rec.hash, hashCode(supplied, rec.salt));

  if (!match) {
    rec.attempts = (rec.attempts || 0) + 1;
    // Burn it on the last allowed attempt rather than leaving a spent code.
    if (rec.attempts >= MAX_ATTEMPTS) delete table[key];
    return { ok: false, reason: 'mismatch', attemptsLeft: Math.max(0, MAX_ATTEMPTS - rec.attempts) };
  }

  delete table[key]; // single use
  return { ok: true };
}

module.exports = {
  requestCode,
  verifyCode,
  prune,
  STORE_KEY,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_REQUESTS_PER_WINDOW,
  RESEND_COOLDOWN_MS,
};
