/**
 * supabaseAdmin.js — Supabase Auth (GoTrue) for STAFF accounts only.
 * ====================================================================
 * This is Option 2 from the project notes: Supabase now holds staff
 * (barber / admin / support) *login credentials* — nothing else. Members,
 * bookings, and merchant settings all stay exactly where they were, in
 * state.json. See docs/STAFF_ACCOUNTS.md for the full picture, including
 * the bug this replaces (every staff sign-up used to depend on knowing the
 * site's single shared Admin Password, and that password — plus every
 * staff member's password hash — was readable by anyone who fetched
 * GET /api/state).
 *
 * Talks to Supabase's Auth REST API directly with fetch() — no
 * @supabase/supabase-js dependency, same "no SDK" approach as mailer.js.
 * This also sidesteps a known supabase-js admin-client bug with the new
 * secret-key format (github.com/supabase/supabase-js/issues/1568) since we
 * control every header ourselves.
 *
 * Required env vars (set in the Render dashboard — see render.yaml):
 *   SUPABASE_URL              e.g. https://xxxxxxxx.supabase.co
 *   SUPABASE_SECRET_KEY       Project Settings > API Keys > Secret keys
 *                             (sb_secret_...). Older project: use the
 *                             "service_role" key from the Legacy API Keys
 *                             tab instead — same env var name. NEVER expose
 *                             this one to the browser.
 *   SUPABASE_PUBLISHABLE_KEY  Project Settings > API Keys > Publishable key
 *                             (sb_publishable_...). Older project: use the
 *                             "anon" key from Legacy API Keys instead — same
 *                             env var name. Safe to expose to the browser —
 *                             publicConfig() below is what does that.
 *
 * If SUPABASE_URL/SUPABASE_SECRET_KEY/SUPABASE_PUBLISHABLE_KEY aren't all
 * set yet, isConfigured() returns false and every staff route responds with
 * a clear "not set up yet" error instead of crashing — the rest of the site
 * (bookings, payments, members) keeps working while you finish Supabase setup.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';

function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_SECRET_KEY && SUPABASE_PUBLISHABLE_KEY);
}

// Sent to the browser as part of the public GET /api/state payload, so
// index.html/owner.html can talk to Supabase Auth directly for staff
// sign-up/login. The publishable key is meant to be public — same as the
// old "anon key" — it does nothing without a matching user email+password.
function publicConfig() {
  return {
    supabaseUrl: SUPABASE_URL,
    supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY,
    supabaseAvailable: isConfigured(),
  };
}

async function adminFetch(path, options = {}) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SECRET_KEY,
      'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
      ...(options.headers || {}),
    },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(json?.msg || json?.message || json?.error_description || `Supabase admin API ${resp.status}`);
    err.status = resp.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Creates the Supabase Auth user behind a new staff sign-up.
// email_confirm:true skips Supabase's own confirmation email — the sign-up
// form is already guarded by Turnstile + a rate limiter (see server.js),
// and the account still goes through the existing approved/active workflow
// in state.json exactly as before.
async function createStaffAuthUser({ email, password }) {
  return adminFetch('/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  }); // -> { id, email, ... }
}

async function updateStaffPassword(userId, newPassword) {
  return adminFetch(`/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: JSON.stringify({ password: newPassword }),
  });
}

async function deleteStaffAuthUser(userId) {
  return adminFetch(`/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

// Verifies a staff member's own access token — the one their browser got
// back from signing in — and returns who they are. Uses the *publishable*
// key (not the secret key): this is the same "who is this token for" call
// the browser SDK itself makes, just run here so the server can trust the
// result before touching state.json.
async function verifyStaffToken(accessToken) {
  if (!isConfigured() || !accessToken) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    return user && user.id ? { id: user.id, email: user.email } : null;
  } catch (err) {
    console.error('[supabaseAdmin] token verification failed:', err.message);
    return null;
  }
}

// Exchanges an email + password for a Supabase session, server-side.
//
// The browser used to do this itself via signInWithPassword(), which meant it
// first had to know the staff member's email address — and the only way it
// had to turn a typed username into one was to search the publicly-served
// barberAccounts list. Running the exchange here is what allows that list to
// stop carrying emails, phones and face descriptors altogether.
//
// Uses the publishable key, exactly as the browser SDK would; a password
// grant never involves the secret key. Returns null on any failure so the
// caller can answer with one generic message rather than distinguishing
// "no such user" from "wrong password".
async function signInStaff(email, password) {
  if (!isConfigured() || !email || !password) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json || !json.access_token) return null;
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_in: json.expires_in,
      token_type: json.token_type || 'bearer',
    };
  } catch (err) {
    console.error('[supabaseAdmin] staff sign-in failed:', err.message);
    return null;
  }
}

module.exports = {
  isConfigured,
  publicConfig,
  createStaffAuthUser,
  updateStaffPassword,
  deleteStaffAuthUser,
  verifyStaffToken,
  signInStaff,
};
