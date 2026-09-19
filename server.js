/**
 * Primus Barbershop — backend for Render
 * ========================================
 * A plain Express web service (Render runs this as a "Web Service", not a
 * serverless function like Netlify). It serves index.html / owner.html and
 * implements every /api/* route those pages call:
 *
 *   GET  /api/state                       public state (no admin password)
 *   POST /api/state                       admin-only: save full state
 *   GET  /api/admin/state                 admin-only: full state (incl. password)
 *   POST /api/payments/paymongo/checkout  start a live PayMongo checkout
 *   POST /api/payments/xendit/checkout    start a live Xendit checkout (PayMongo alternative)
 *   POST /api/payments/manual             submit a manual-transfer membership
 *   GET  /api/payments/paymongo/status    poll a PayMongo checkout session's status
 *   GET  /api/payments/xendit/status      poll a Xendit invoice's status
 *   POST /api/payments/paymongo/webhook   PayMongo calls this on payment (reliable confirmation)
 *   POST /api/payments/xendit/webhook     Xendit calls this on payment (reliable confirmation)
 *   POST /api/ai-chat                     advanced AI chat (optional)
 *   POST /api/staff/signup                 public: create a barber/admin/support account (Supabase-backed)
 *   PATCH /api/staff/me                    staff-only (own Supabase session): update own profile fields
 *   POST /api/staff/reset-password         admin-only: reset a staff member's password
 *   DELETE /api/staff/:id                  admin-only: remove a staff member's Supabase login
 *
 * STAFF ACCOUNTS (barber / admin / support)
 * ------------------------------------------
 * Login credentials for these live in Supabase Auth, not state.json — see
 * supabaseAdmin.js and docs/STAFF_ACCOUNTS.md. Everything else about a staff
 * member (name, bio, photo, status, approval, position) still lives in
 * state.json's `barberAccounts` array exactly as before.
 *
 * OWNER LOGIN
 * -----------
 * The Owner Console (owner.html) and the main site's Admin Settings panel
 * now ALSO accept a Supabase login — anyone signed in whose email is in the
 * OWNER_EMAILS env var gets full admin/owner privilege, same as knowing the
 * legacy Admin Password does. Both credentials work side by side (see
 * requireAdmin() below); the legacy password is kept as a fallback so
 * nobody gets locked out. Create an owner's Supabase login with
 * `node scripts/create-owner.js <email> <password>` — see
 * docs/STAFF_ACCOUNTS.md for the full setup.
 *
 * Only one live gateway (PayMongo or Xendit) is ever active for customers at
 * a time — see merchant.paymongoEnabled / merchant.xenditEnabled in state and
 * the "Payment Mode" switch in Admin > Payment Merchant (index.html). Both
 * can be configured on the server at once; whichever one is switched on in
 * Admin decides which one customers actually see.
 *
 * STORAGE
 * -------
 * State is kept in a JSON file (./data/state.json) on disk. This is fine to
 * get you running, but Render's free/starter web services have an EPHEMERAL
 * filesystem — it resets on every deploy/restart. For real persistence,
 * either:
 *   1. Add a Render persistent Disk to this service and point STATE_FILE at
 *      a path on that disk (e.g. /var/data/state.json), or
 *   2. Swap this file-store for Render Key Value / Render Postgres.
 * The code below only touches readState()/writeState(), so swapping the
 * storage backend later is a small, isolated change.
 *
 * ENVIRONMENT VARIABLES (set these in the Render dashboard, not in code)
 * ------------------------------------------------------------------
 *   PORT                  set automatically by Render
 *   STATE_FILE             optional, defaults to ./data/state.json
 *   PAYMONGO_SECRET_KEY    optional — enables live card/GCash/Maya checkout via PayMongo
 *   PAYMONGO_WEBHOOK_SECRET optional — verifies PayMongo webhook calls; get
 *                          this from the Dashboard when you add the webhook
 *                          endpoint (Developers > Webhooks). Without it, the
 *                          app still works via /status polling alone — this
 *                          just makes payment confirmation more reliable.
 *   XENDIT_SECRET_KEY      optional — enables live card/GCash/Maya checkout via
 *                          Xendit (xendit.co), a PayMongo alternative. Get it
 *                          from Xendit Dashboard > Settings > API Keys.
 *   XENDIT_WEBHOOK_TOKEN   optional — verifies Xendit webhook ("callback")
 *                          calls; this is the plain "Verification Token"
 *                          shown in Xendit Dashboard > Settings > Webhooks —
 *                          not a secret you generate yourself. Without it,
 *                          the app still works via /status polling alone.
 *   ANTHROPIC_API_KEY      optional — enables Claude for the AI chat widget
 *   OPENAI_API_KEY         optional — enables GPT for the AI chat widget
 *   GEMINI_API_KEY         optional — enables Gemini for the AI chat widget
 *   PUBLIC_BASE_URL        optional — e.g. https://yourapp.onrender.com
 *                          (auto-detected from the request if not set)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mailer = require('./mailer'); // Resend-backed transactional email (see mailer.js)
const supabaseAdmin = require('./supabaseAdmin'); // Supabase Auth for staff accounts (see supabaseAdmin.js)
const stateStore = require('./stateStore');       // durable state storage (see stateStore.js)

const app = express();
// Render sits behind exactly one proxy. `true` would trust the whole
// X-Forwarded-For chain, which lets a caller forge req.ip and slip past the
// rate limiter below by sending a fresh fake IP on every request. The hop
// count is the correct setting: req.protocol still resolves properly.
app.set('trust proxy', 1);
// The `verify` callback stashes the raw request body on req.rawBody as it's
// parsed, without changing anything else about normal JSON parsing. This is
// needed for the PayMongo webhook route, which must HMAC-sign the *raw*
// bytes PayMongo sent, not a re-serialized version of the parsed JSON.
app.use(express.json({
  limit: '15mb', // generous limit: settings blob can include base64 images
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

const PORT = process.env.PORT || 3000;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json');
const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY || '';
// Set after creating the webhook in the PayMongo Dashboard (Developers >
// Webhooks). This is a *different* secret from PAYMONGO_SECRET_KEY — it's
// only used to verify that incoming webhook POSTs genuinely came from
// PayMongo, never sent to PayMongo's API.
const PAYMONGO_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET || '';
// Xendit (xendit.co) — the alternative live gateway to PayMongo. Same idea:
// a secret key to create/check checkouts, and a separate webhook token to
// verify that incoming "callback" POSTs genuinely came from Xendit.
const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY || '';
const XENDIT_WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Cloudflare Turnstile secret key (see docs/EMAIL_SETUP.md) — verifies that
// signup/payment submissions come from a real browser, not a script.
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
// Exact origin this site is served from, e.g. https://primusbarbershop.onrender.com
// or your custom domain. Used to reject cross-site POSTs to the payment
// endpoints. Leave unset during local development.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

// The admin password now comes from the environment only. It used to be a
// literal in this file that index.html carried a matching copy of — which
// meant anyone reading the (public) repo could authenticate as admin against
// the live site. There is deliberately no fallback value: if this is unset,
// password auth is disabled entirely rather than silently reverting to a
// known default. Set ADMIN_PASSWORD in the Render dashboard.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.warn('[auth] ADMIN_PASSWORD is not set — password-based admin login is DISABLED.');
  console.warn('[auth] Set it in the Render dashboard, or sign in as an owner via Supabase (OWNER_EMAILS).');
}

// Owner accounts on Supabase (see supabaseAdmin.js / scripts/create-owner.js).
// Comma-separated, case-insensitive. Anyone signed in through Supabase whose
// email is in this list gets full admin/owner privilege — same privilege
// the legacy Admin Password already grants, just tied to a real identity.
const OWNER_EMAILS = (process.env.OWNER_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// Used only when there's nothing stored yet. Everything else (services,
// hours, gallery, etc.) is filled in by index.html's own client-side defaults
// via Object.assign, the first time nothing comes back from the server.
function seedState() {
  return {
    // No adminPassword seeded here on purpose — auth reads ADMIN_PASSWORD
    // from the environment. A seeded default would silently reappear every
    // time storage is recreated.
    members: {},
    bookings: [],
    merchant: { paymongoEnabled: false, xenditEnabled: false },
    _payments: {}, // internal: paymongo ref -> { status, membershipNumber, checkoutSessionId, name, email, phone }
  };
}

// Both of these stay synchronous on purpose — they're called from inside 30+
// request handlers. stateStore keeps the state in memory (loaded from
// Supabase before the server starts listening) and persists writes in the
// background, so the call sites below are unchanged while the data itself
// now survives a redeploy. See stateStore.js for the full reasoning.
function readState() {
  return stateStore.read();
}

function writeState(state) {
  stateStore.write(state);
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

// Checks either credential for full admin/owner privilege: the legacy
// shared Admin Password (unchanged, sent as x-admin-password — kept as a
// break-glass fallback so nobody gets locked out while Supabase is being
// set up), or a Supabase session belonging to one of OWNER_EMAILS (sent as
// `Authorization: Bearer <token>` — see docs/STAFF_ACCOUNTS.md). Async
// because the Supabase check is a network call; every call site below
// already awaits it.
// Length-independent comparison. `===` on secrets leaks how many leading
// characters matched via response timing; timingSafeEqual needs equal-length
// buffers, so both sides are hashed to a fixed 32 bytes first.
function secretsMatch(a, b) {
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function requireAdmin(req, res, state) {
  // Both are accepted, rather than one shadowing the other. ADMIN_PASSWORD is
  // the break-glass credential and must always work — it's the only one that
  // survives the state file being recreated. state.adminPassword is whatever
  // the owner set in the console's Security page, and keeps working too.
  const provided = req.get('x-admin-password') || '';
  if (provided && (secretsMatch(provided, ADMIN_PASSWORD) || secretsMatch(provided, state.adminPassword))) {
    return true;
  }

  if (OWNER_EMAILS.length && supabaseAdmin.isConfigured()) {
    const authHeader = req.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token) {
      const owner = await supabaseAdmin.verifyStaffToken(token);
      if (owner && owner.email && OWNER_EMAILS.includes(owner.email.toLowerCase())) {
        return true;
      }
    }
  }

  res.status(401).json({ error: 'Not authorized.' });
  return false;
}

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// ---------------------------------------------------------------------------
// Bot / abuse defenses — Cloudflare Turnstile + a lightweight rate limiter.
// No new services: Turnstile is a single server-side verify call, and the
// rate limiter is in-memory (fine for Render's free single-instance plan).
// ---------------------------------------------------------------------------

// Verifies a Turnstile token with Cloudflare. Returns true if TURNSTILE_SECRET_KEY
// isn't set yet, so the site keeps working while you're setting things up —
// once you set the env var, unverified/missing tokens start failing closed.
async function verifyTurnstile(token, remoteip) {
  if (!TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token, remoteip: remoteip || '' }),
    });
    const json = await resp.json();
    return !!json.success;
  } catch (err) {
    console.error('[turnstile] verification request failed:', err.message);
    return false; // fail closed on network errors
  }
}

// Rejects state-mutating requests whose Origin/Referer doesn't match this
// site, once ALLOWED_ORIGIN is set. Browsers always send Origin on
// cross-site POSTs, so this blocks a script on another domain from calling
// these routes directly. It does nothing against curl/Postman — that's what
// Turnstile + rate limiting are for.
function checkOrigin(req, res, next) {
  if (!ALLOWED_ORIGIN) return next();
  const origin = req.get('origin') || req.get('referer') || '';
  if (origin.startsWith(ALLOWED_ORIGIN)) return next();
  console.warn('[origin-check] blocked request from origin:', origin || '(none)');
  return res.status(403).json({ error: 'Request origin not allowed.' });
}

// Minimal fixed-window in-memory rate limiter — zero dependencies. If you
// ever move this service to multiple Render instances, swap the Map for a
// shared store (e.g. Upstash Redis) since each instance would otherwise
// count separately.
function rateLimit({ windowMs, max }) {
  const hits = new Map(); // ip -> array of request timestamps
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, arr] of hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length) hits.set(ip, kept); else hits.delete(ip);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      return res.status(429).json({ error: 'Too many requests — please wait a moment and try again.' });
    }
    arr.push(now);
    hits.set(ip, arr);
    next();
  };
}

// 8 attempts per 15 minutes per IP — generous for a real customer retrying a
// typo, tight enough to blunt a scripted flood of fake submissions.
const paymentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8 });

// Every privileged route re-checks the admin password on each request, so
// without this an attacker can simply guess in a loop — there is no session
// and no lockout anywhere else. 20 per 5 minutes is far more than a real
// owner mistyping a password needs.
const adminLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20 });

// /api/ai-chat spends real money per call on a third-party API. It was
// previously open to anyone, unthrottled — a free LLM proxy billed to this
// account.
const aiLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 30 });

function generateMembershipNumber(members) {
  let memNum;
  do {
    memNum = 'MEM-' + Math.floor(10000 + Math.random() * 90000);
  } while (members[memNum]);
  return memNum;
}

function findMemberByContact(members, email, phone) {
  const normPhone = (phone || '').replace(/\D/g, '').slice(-10);
  for (const [memNum, data] of Object.entries(members)) {
    if (data.email && email && data.email.toLowerCase() === email.toLowerCase()) return memNum;
    if (data.phone && normPhone && data.phone.replace(/\D/g, '').slice(-10) === normPhone) return memNum;
  }
  return null;
}

// Shared by both the /status polling endpoint and the PayMongo webhook so a
// payment only ever gets marked paid and turned into a membership in one
// place. Safe to call more than once for the same ref (e.g. the customer's
// browser polls /status right as the webhook also arrives) — if it's
// already paid, this is a no-op and just returns the existing membership.
// Mutates `state` in place; caller is responsible for writeState(state).
function markPaymentPaid(state, ref) {
  const record = state._payments && state._payments[ref];
  if (!record) return null;
  if (record.status === 'paid') return record;

  if (!state.members) state.members = {};
  const existing = findMemberByContact(state.members, record.email, record.phone);
  const memNum = existing || generateMembershipNumber(state.members);
  const paidDate = new Date().toISOString().slice(0, 10);
  state.members[memNum] = {
    name: record.name, email: record.email, phone: record.phone,
    // record.gateway is set when the checkout is created (see the
    // paymongo/checkout and xendit/checkout routes below). Old payment
    // records from before this field existed default to 'paymongo'.
    method: record.gateway || 'paymongo',
    paidDate,
    active: true,
    pendingVerification: false,
    // Marked true right away since the welcome emails are fired below —
    // this stops the /api/state handler from re-sending them later if an
    // admin edit round-trips this same member through the dashboard.
    emailSent: true,
  };
  record.status = 'paid';
  record.membershipNumber = memNum;

  // Fire the receipt + membership card emails in the background. Never
  // block payment confirmation on email delivery, and a failed send never
  // affects the membership itself — mailer.js logs failures on its own.
  mailer.sendMembershipWelcomeEmails(state.businessName || 'Your Barbershop', {
    name: record.name,
    email: record.email,
    membershipNumber: memNum,
    amount: state.subscriptionAmount,
    currency: 'PHP',
    method: record.gateway,
    paidDate,
    discountRate: state.discountRate,
  }).catch((err) => console.error('[mailer] welcome emails failed for', memNum, err));

  return record;
}

function findRefByCheckoutSessionId(state, checkoutSessionId) {
  if (!state._payments) return null;
  for (const [ref, record] of Object.entries(state._payments)) {
    if (record.checkoutSessionId === checkoutSessionId) return ref;
  }
  return null;
}

function findRefByXenditInvoiceId(state, invoiceId) {
  if (!state._payments) return null;
  for (const [ref, record] of Object.entries(state._payments)) {
    if (record.xenditInvoiceId === invoiceId) return ref;
  }
  return null;
}

// Verifies a PayMongo webhook request per their documented scheme:
// https://developers.paymongo.com/docs/securing-webhook
//   Paymongo-Signature: t=<timestamp>,te=<test-mode-sig>,li=<live-mode-sig>
//   signature = HMAC_SHA256(webhookSecret, `${timestamp}.${rawBody}`)
// Compare against li if the event is live, te if it's a test event.
function verifyPaymongoWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader || !rawBody) return false;
  const parts = {};
  for (const kv of signatureHeader.split(',')) {
    const [k, v] = kv.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const { t: timestamp, te: testSig, li: liveSig } = parts;
  if (!timestamp || (!testSig && !liveSig)) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  // Try live signature first (if present), then test — whichever this
  // event actually carries. timingSafeEqual needs equal-length buffers, so
  // guard the length check before comparing.
  for (const candidate of [liveSig, testSig]) {
    if (!candidate) continue;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(candidate, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// State routes
// ---------------------------------------------------------------------------

// The public payload deliberately carries NO customer personal data. It used
// to ship the whole `members` object — name, email, phone, payment method and
// reference number for every paying customer — plus every booking record, to
// anyone who opened this URL unauthenticated. Two projections replace them:
//
//   memberStatuses  { "MEM-12345": { active: true } }
//   bookings        [ { date, time, barber } ]
//
// which is precisely what the customer page needs (validating a membership
// number at checkout, and greying out slots that are already taken) and
// nothing more. Anything that genuinely needs a person's details now goes
// through the lookup routes below, which return only the one matching record.
// Admins still get the unprojected state from GET /api/admin/state.
function buildPublicState(state) {
  const publicState = { ...state };
  delete publicState.adminPassword;
  delete publicState._payments;

  publicState.memberStatuses = Object.fromEntries(
    Object.entries(state.members || {}).map(([num, m]) => [num, { active: m.active !== false }])
  );
  delete publicState.members;

  publicState.bookings = (state.bookings || []).map(b => ({
    date: b.date, time: b.time, barber: b.barber,
  }));

  return publicState;
}

app.get('/api/state', (req, res) => {
  const state = readState();
  const publicState = buildPublicState(state);
  publicState.paymongoAvailable = !!PAYMONGO_SECRET_KEY;
  publicState.xenditAvailable = !!XENDIT_SECRET_KEY;
  publicState.aiChatAvailable = !!(ANTHROPIC_API_KEY || OPENAI_API_KEY || GEMINI_API_KEY);
  Object.assign(publicState, supabaseAdmin.publicConfig()); // supabaseUrl / supabasePublishableKey / supabaseAvailable — all safe to expose
  res.json(publicState);
});

// ---------------------------------------------------------------------------
// Customer lookup routes
//
// These exist so the browser never needs a copy of everyone's records to
// answer a question about one person. Each takes a contact detail the real
// customer would know, matches it server-side, and returns only their own
// row. Rate-limited, because a lookup endpoint that accepts an email is an
// enumeration tool if you let it run unbounded.
// ---------------------------------------------------------------------------

const lookupLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15 });

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

// Membership number -> is it usable, and what name is on it. The name is
// returned only on a positive match (it pre-fills the review form); an
// unknown number gets no data at all.
app.post('/api/members/verify', lookupLimiter, (req, res) => {
  const num = String(req.body?.membershipNumber || '').trim();
  if (!num) return res.status(400).json({ error: 'Membership number required.' });
  const state = readState();
  const entry = Object.entries(state.members || {})
    .find(([memNum]) => memNum.toLowerCase() === num.toLowerCase());
  if (!entry || entry[1].active === false) return res.json({ valid: false });
  return res.json({ valid: true, membershipNumber: entry[0], name: entry[1].name || '' });
});

// Phone or email -> that person's membership number. Used by the chat
// assistant, which previously scanned a client-side copy of every member.
app.post('/api/members/lookup', lookupLimiter, (req, res) => {
  const contact = String(req.body?.contact || '').trim().toLowerCase();
  if (!contact) return res.status(400).json({ error: 'Contact required.' });
  const digits = normalizeDigits(contact);
  const state = readState();
  for (const [memNum, data] of Object.entries(state.members || {})) {
    const emailMatch = data.email && data.email.toLowerCase() === contact;
    const phoneMatch = data.phone && digits.length >= 7 && normalizeDigits(data.phone) === digits;
    if ((emailMatch || phoneMatch) && data.active !== false) {
      return res.json({ found: true, membershipNumber: memNum });
    }
  }
  return res.json({ found: false });
});

// Membership number or email -> that person's upcoming bookings only.
app.post('/api/bookings/lookup', lookupLimiter, (req, res) => {
  const ref = String(req.body?.reference || '').trim().toLowerCase();
  if (!ref) return res.status(400).json({ error: 'Reference required.' });
  const state = readState();
  const today = new Date().toISOString().slice(0, 10);
  const matches = (state.bookings || []).filter(b => {
    const byMembership = b.membership && String(b.membership).toLowerCase() === ref;
    // Booking records store the customer address as custEmail; `email` is
    // accepted too so this keeps working if that ever gets normalised.
    const byEmail = (b.custEmail && String(b.custEmail).toLowerCase() === ref)
      || (b.email && String(b.email).toLowerCase() === ref);
    return (byMembership || byEmail) && (!b.date || b.date >= today);
  }).map(b => ({
    date: b.date, time: b.time, barber: b.barber,
    service: b.service, appointmentNumber: b.appointmentNumber,
  }));
  matches.sort((a, b) => String(a.date + a.time).localeCompare(String(b.date + b.time)));
  res.json({ bookings: matches });
});

app.post('/api/state', adminLimiter, async (req, res) => {
  const state = readState();
  if (!(await requireAdmin(req, res, state))) return;
  const incoming = req.body || {};

  // A page that loaded from the PUBLIC /api/state holds projections, not the
  // real records: memberStatuses instead of members, and bookings stripped
  // down to { date, time, barber }. If such a page ever POSTs its whole
  // settings blob back, those projections would overwrite the genuine data
  // and silently destroy every customer's contact details and booking
  // history. Only a client that fetched GET /api/admin/state has the real
  // thing, and it says so with this header; everyone else's copy of these
  // two keys is discarded in favour of what the server already holds.
  const hasFullState = req.get('x-full-state') === '1';
  if (!hasFullState) {
    delete incoming.members;
    delete incoming.bookings;
  }
  delete incoming.memberStatuses; // never persisted — derived on read

  // Preserve internal bookkeeping that the client doesn't know about.
  const merged = { ...state, ...incoming, _payments: state._payments || {} };

  // /api/staff/me (and the customer call-routing heartbeat) are the only
  // things that should ever move these fields — they change many times a
  // minute while someone's Live on the call console. A full-state save from
  // an admin's tab holding an older in-memory copy of barberAccounts (e.g.
  // a settings edit made a while after that tab's last page load) must
  // never clobber them back to a stale value, so this always keeps
  // whatever the server currently has for these, regardless of what this
  // particular save's copy of barberAccounts says.
  const VOLATILE_STAFF_FIELDS = ['isLive', 'liveHeartbeat', 'liveSince', 'ringHeartbeat', 'lastDeclineAt'];
  if (Array.isArray(merged.barberAccounts) && Array.isArray(state.barberAccounts)) {
    const currentById = new Map(state.barberAccounts.map(a => [a.id, a]));
    merged.barberAccounts = merged.barberAccounts.map(a => {
      const current = currentById.get(a.id);
      if (!current) return a;
      const kept = { ...a };
      for (const key of VOLATILE_STAFF_FIELDS) kept[key] = current[key];
      return kept;
    });
  }

  // A manual-transfer membership starts as { active:false, pendingVerification:true }
  // (see /api/payments/manual below) and staff approves it from the Admin
  // dashboard's members list, which round-trips the whole state through
  // this route. Catch that transition here and send the same receipt +
  // card emails a live-checkout payment gets — guarded by emailSent so
  // re-saving the dashboard (which POSTs full state on every edit) never
  // re-sends them.
  if (merged.members) {
    for (const [memNum, member] of Object.entries(merged.members)) {
      const before = state.members && state.members[memNum];
      const justApproved = member.active && !member.emailSent && (!before || !before.active);
      if (justApproved && member.email) {
        member.emailSent = true;
        mailer.sendMembershipWelcomeEmails(merged.businessName || 'Your Barbershop', {
          name: member.name,
          email: member.email,
          membershipNumber: memNum,
          amount: merged.subscriptionAmount,
          currency: 'PHP',
          method: member.method,
          paidDate: member.paidDate,
          discountRate: merged.discountRate,
        }).catch((err) => console.error('[mailer] welcome emails failed for', memNum, err));
      }
    }
  }

  writeState(merged);
  res.json({ ok: true });
});

app.get('/api/admin/state', adminLimiter, async (req, res) => {
  const state = readState();
  if (!(await requireAdmin(req, res, state))) return;
  const out = { ...state };
  delete out._payments;
  res.json(out);
});

// ---------------------------------------------------------------------------
// Staff accounts (barber / admin / support) — Supabase-backed
// ---------------------------------------------------------------------------
// This is the fix for "the shared admin password problem" described in the
// project notes: self-service sign-up used to require the client to know
// (or embed a default copy of) the SAME single password that gates the
// entire site's state, and every staff member's password hash was readable
// by anyone who hit GET /api/state. Neither is true anymore — sign-up and
// login below only ever talk to Supabase Auth, and never touch or need the
// site's Admin Password. Reset/delete stay admin-only (requireAdmin) since
// those are the same privileged actions the Owner Console already gates.

// Verifies the bearer token a staff member's own browser holds after
// signing in with Supabase, and attaches who they are to req.staff. This
// only ever proves "who is making this request" — it does NOT grant any
// elevated privilege, so /api/staff/me below can only ever touch that one
// person's own record.
async function requireStaffSelf(req, res, next) {
  const authHeader = req.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const staff = token ? await supabaseAdmin.verifyStaffToken(token) : null;
  if (!staff) return res.status(401).json({ error: 'Your session has expired — please log in again.' });
  req.staff = staff;
  next();
}

app.post('/api/staff/signup', checkOrigin, paymentLimiter, async (req, res) => {
  if (!supabaseAdmin.isConfigured()) {
    return res.status(503).json({ error: 'Staff accounts are not set up on this server yet — ask the shop owner to finish the Supabase setup.' });
  }
  const { name, username, email, phone, password, position, bio, photo, faceDescriptor, turnstileToken } = req.body || {};
  const cleanName = (name || '').trim();
  const cleanUsername = (username || '').trim().toLowerCase();
  const cleanEmail = (email || '').trim();
  if (!cleanName || !cleanUsername || !cleanEmail || !password) {
    return res.status(400).json({ error: 'name, username, email, and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  // Signup accepts bio/photo/faceDescriptor directly, so it needs the same
  // checks the self-edit route applies — otherwise that validation is
  // bypassed by simply setting the payload at registration instead.
  const fieldProblem = validateStaffSelfEdit({
    ...(bio !== undefined ? { bio } : {}),
    ...(photo !== undefined ? { photo } : {}),
    ...(faceDescriptor ? { faceDescriptor } : {}),
  });
  if (fieldProblem) return res.status(400).json({ error: fieldProblem });

  const human = await verifyTurnstile(turnstileToken, req.ip);
  if (!human) {
    return res.status(403).json({ error: 'Verification failed. Please refresh the page and try again.' });
  }

  const state = readState();
  if (!state.barberAccounts) state.barberAccounts = [];
  if (state.barberAccounts.some(a => (a.username || '').toLowerCase() === cleanUsername)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  let authUser;
  try {
    authUser = await supabaseAdmin.createStaffAuthUser({ email: cleanEmail, password });
  } catch (err) {
    const taken = err.status === 422 || /already.*(registered|exists)/i.test(err.message || '');
    return res.status(400).json({ error: taken ? 'That email is already registered.' : 'Could not create the account — please try again.' });
  }

  const pos = position === 'Admin' || position === 'Support' ? position : 'Barber';
  const role = pos === 'Barber' ? 'barber' : 'staff';
  const approved = pos !== 'Support'; // matches the existing workflow: only Support needs admin approval

  const record = {
    id: authUser.id, name: cleanName, username: cleanUsername, phone: phone || '', email: cleanEmail,
    role, position: pos, status: 'Active', supportPeerId: '',
    bio: bio || '', photo: photo || '', faceDescriptor: faceDescriptor || null,
    active: approved, approved,
  };
  state.barberAccounts.push(record);
  if (role === 'barber') {
    state.barbers = state.barbers || [];
    if (!state.barbers.includes(cleanName)) state.barbers.push(cleanName);
  }

  try {
    writeState(state);
  } catch (err) {
    // Filesystem hiccup — undo the Supabase user so there's no orphaned
    // login with no matching profile in state.json.
    supabaseAdmin.deleteStaffAuthUser(authUser.id).catch(() => {});
    console.error('[staff-signup] writeState failed:', err);
    return res.status(500).json({ error: 'Could not save your account — please try again.' });
  }

  res.json({ account: record });
});

// A logged-in staff member updating their OWN profile — bio/photo/status/
// live-call fields. Deliberately a short whitelist: name, username, phone,
// email, position, and approval stay admin-only (via the existing /api/state
// route + Owner Console / Admin Settings, both still gated by the Admin
// Password), exactly matching today's "can't touch your own name/email" rule.
// `active` used to be in this list, which let a staff member an admin had
// just deactivated flip themselves back on and reappear on the public team
// page. Activation is an admin decision; it lives with `approved` now.
const STAFF_SELF_EDITABLE_FIELDS = ['status', 'bio', 'photo', 'supportPeerId', 'isLive', 'liveHeartbeat', 'liveSince', 'lastDeclineAt', 'faceDescriptor'];

const ALLOWED_STAFF_STATUSES = ['Active', 'Break', 'Lunch', 'Inactive'];

// `photo` is rendered into an <img src> on the public homepage. Anyone can
// self-register as a barber (barber signups are auto-approved), so without
// this an attacker could store `x" onerror="...` here and run script in every
// customer's browser. Only two shapes are ever legitimate: an https URL, or
// an inline base64 image. Quotes and angle brackets can't occur in either.
function isSafePhoto(value) {
  if (typeof value !== 'string') return false;
  if (value === '') return true; // clearing the photo is fine
  if (value.length > 4 * 1024 * 1024) return false;
  if (/["'<>\\\s]/.test(value)) return false;
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)) return true;
  return /^https:\/\/[^"'<>\\]+$/.test(value);
}

// Rejects the whole request rather than silently dropping a bad field, so a
// caller sending garbage finds out instead of believing it saved.
function validateStaffSelfEdit(body) {
  if (Object.prototype.hasOwnProperty.call(body, 'photo') && !isSafePhoto(body.photo)) {
    return 'photo must be an https URL or an inline base64 image.';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'bio')) {
    if (typeof body.bio !== 'string' || body.bio.length > 2000) return 'bio must be text under 2000 characters.';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'status') && !ALLOWED_STAFF_STATUSES.includes(body.status)) {
    return `status must be one of: ${ALLOWED_STAFF_STATUSES.join(', ')}.`;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'supportPeerId')) {
    if (typeof body.supportPeerId !== 'string' || !/^[A-Za-z0-9_-]{0,64}$/.test(body.supportPeerId)) {
      return 'supportPeerId is not a valid peer id.';
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'faceDescriptor') && body.faceDescriptor !== null) {
    const d = body.faceDescriptor;
    if (!Array.isArray(d) || d.length !== 128 || !d.every(n => typeof n === 'number' && Number.isFinite(n))) {
      return 'faceDescriptor must be 128 finite numbers.';
    }
  }
  for (const key of ['isLive']) {
    if (Object.prototype.hasOwnProperty.call(body, key) && typeof body[key] !== 'boolean') {
      return `${key} must be true or false.`;
    }
  }
  for (const key of ['liveHeartbeat', 'liveSince', 'lastDeclineAt']) {
    const v = body[key];
    if (Object.prototype.hasOwnProperty.call(body, key) && v !== null && !Number.isFinite(v)) {
      return `${key} must be a timestamp or null.`;
    }
  }
  return null;
}

app.patch('/api/staff/me', requireStaffSelf, (req, res) => {
  const body = req.body || {};
  const problem = validateStaffSelfEdit(body);
  if (problem) return res.status(400).json({ error: problem });

  const state = readState();
  const acct = (state.barberAccounts || []).find(a => a.id === req.staff.id);
  if (!acct) return res.status(404).json({ error: 'Account not found.' });
  for (const key of STAFF_SELF_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) acct[key] = body[key];
  }
  writeState(state);
  res.json({ account: acct });
});

app.post('/api/staff/reset-password', adminLimiter, async (req, res) => {
  const state = readState();
  if (!(await requireAdmin(req, res, state))) return;
  if (!supabaseAdmin.isConfigured()) {
    return res.status(503).json({ error: 'Staff accounts are not set up on this server yet.' });
  }
  const { id, newPassword } = req.body || {};
  if (!id || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'id and a newPassword of at least 6 characters are required.' });
  }
  supabaseAdmin.updateStaffPassword(id, newPassword)
    .then(() => res.json({ ok: true }))
    .catch(() => res.status(400).json({ error: 'Could not reset that password — this account may not have a Supabase login yet (created before Supabase was set up?).' }));
});

app.delete('/api/staff/:id', adminLimiter, async (req, res) => {
  const state = readState();
  if (!(await requireAdmin(req, res, state))) return;
  if (!supabaseAdmin.isConfigured()) return res.json({ ok: true }); // nothing to clean up
  supabaseAdmin.deleteStaffAuthUser(req.params.id)
    .catch((err) => console.warn('[staff-delete] could not delete Supabase user', req.params.id, err.message))
    .finally(() => res.json({ ok: true }));
});

// ---------------------------------------------------------------------------
// Payments — manual (bank/GCash transfer verified by staff later)
// ---------------------------------------------------------------------------

app.post('/api/payments/manual', checkOrigin, paymentLimiter, async (req, res) => {
  const { method, name, email, phone, referenceNumber, turnstileToken } = req.body || {};
  if (!name || !email || !phone || !referenceNumber) {
    return res.status(400).json({ error: 'name, email, phone, and referenceNumber are required.' });
  }
  const human = await verifyTurnstile(turnstileToken, req.ip);
  if (!human) {
    return res.status(403).json({ error: 'Verification failed. Please refresh the page and try again.' });
  }

  const state = readState();
  if (!state.members) state.members = {};

  const existing = findMemberByContact(state.members, email, phone);
  const memNum = existing || generateMembershipNumber(state.members);

  state.members[memNum] = {
    name, email, phone, method,
    referenceNumber,
    paidDate: new Date().toISOString().slice(0, 10),
    active: false,
    pendingVerification: true,
    emailSent: false, // set true by /api/state once staff approves this membership
  };
  writeState(state);
  res.json({ membershipNumber: memNum });
});

// ---------------------------------------------------------------------------
// Membership — resend the digital card email (customer lost the original)
// ---------------------------------------------------------------------------

app.post('/api/members/resend-card', checkOrigin, paymentLimiter, async (req, res) => {
  const { email, phone, turnstileToken } = req.body || {};
  if (!email && !phone) {
    return res.status(400).json({ error: 'email or phone is required.' });
  }
  const human = await verifyTurnstile(turnstileToken, req.ip);
  if (!human) {
    return res.status(403).json({ error: 'Verification failed. Please refresh the page and try again.' });
  }

  const state = readState();
  const memNum = findMemberByContact(state.members || {}, email, phone);

  // Respond identically whether or not a match was found, so this endpoint
  // can't be used to check which emails/phones belong to real members.
  if (memNum && state.members[memNum].active) {
    const member = state.members[memNum];
    mailer.sendMembershipCardEmail({
      businessName: state.businessName || 'Your Barbershop',
      name: member.name,
      email: member.email,
      membershipNumber: memNum,
      discountRate: state.discountRate,
    }).catch((err) => console.error('[mailer] resend-card failed for', memNum, err));
  }
  res.json({ ok: true, message: 'If that matches an active membership on file, the card has been resent.' });
});

// ---------------------------------------------------------------------------
// Payments — live PayMongo checkout (card / gcash / maya)
// ---------------------------------------------------------------------------

const PAYMONGO_METHOD_MAP = { card: 'card', gcash: 'gcash', maya: 'paymaya' };

app.post('/api/payments/paymongo/checkout', checkOrigin, paymentLimiter, async (req, res) => {
  if (!PAYMONGO_SECRET_KEY) {
    return res.status(503).json({ error: 'Live payments are not configured on this server yet.' });
  }
  const { method, name, email, phone, turnstileToken } = req.body || {};
  const pmMethod = PAYMONGO_METHOD_MAP[method];
  if (!pmMethod) {
    return res.status(400).json({ error: 'Unsupported payment method for live checkout.' });
  }
  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'name, email, and phone are required.' });
  }
  const human = await verifyTurnstile(turnstileToken, req.ip);
  if (!human) {
    return res.status(403).json({ error: 'Verification failed. Please refresh the page and try again.' });
  }

  const state = readState();
  const amount = Math.round((state.subscriptionAmount || 500) * 100); // PayMongo wants centavos
  const ref = crypto.randomUUID();

  try {
    const resp = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString('base64'),
      },
      body: JSON.stringify({
        data: {
          attributes: {
            billing: { name, email, phone },
            send_email_receipt: false,
            show_description: true,
            show_line_items: true,
            description: `${state.businessName || 'Barbershop'} Membership`,
            line_items: [{
              currency: 'PHP',
              amount,
              name: 'Membership',
              quantity: 1,
            }],
            payment_method_types: [pmMethod],
            success_url: `${baseUrl(req)}/?paymongo=success&ref=${ref}`,
            cancel_url: `${baseUrl(req)}/?paymongo=cancelled`,
          },
        },
      }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      const msg = json?.errors?.[0]?.detail || 'PayMongo rejected the checkout request.';
      return res.status(502).json({ error: msg });
    }

    if (!state._payments) state._payments = {};
    state._payments[ref] = {
      status: 'pending',
      gateway: 'paymongo',
      checkoutSessionId: json.data.id,
      name, email, phone,
    };
    writeState(state);

    res.json({ checkoutUrl: json.data.attributes.checkout_url });
  } catch (err) {
    console.error('[paymongo/checkout] error:', err);
    res.status(502).json({ error: 'Could not reach PayMongo. Please try again.' });
  }
});

app.get('/api/payments/paymongo/status', async (req, res) => {
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ error: 'ref is required.' });

  const state = readState();
  const record = state._payments && state._payments[ref];
  if (!record) return res.status(404).json({ error: 'Unknown reference.' });

  if (record.status === 'paid') {
    return res.json({ status: 'paid', membershipNumber: record.membershipNumber });
  }
  if (!PAYMONGO_SECRET_KEY) {
    return res.json({ status: record.status });
  }

  try {
    const resp = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${record.checkoutSessionId}`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString('base64') },
    });
    const json = await resp.json();
    const paymentIntent = json?.data?.attributes?.payment_intent;
    const paid = paymentIntent?.attributes?.status === 'succeeded' ||
      (json?.data?.attributes?.payments || []).some(p => p.attributes?.status === 'paid');

    if (paid) {
      const updated = markPaymentPaid(state, ref);
      writeState(state);
      return res.json({ status: 'paid', membershipNumber: updated.membershipNumber });
    }

    res.json({ status: 'pending' });
  } catch (err) {
    console.error('[paymongo/status] error:', err);
    res.json({ status: record.status || 'pending' });
  }
});

// ---------------------------------------------------------------------------
// Payments — PayMongo webhook (reliable confirmation even if the customer
// closes the tab before being redirected back to success_url)
// ---------------------------------------------------------------------------
//
// Set this up once in the PayMongo Dashboard: Developers > Webhooks > Add
// Endpoint, URL = https://<your-render-url>/api/payments/paymongo/webhook,
// event = checkout_session.payment.paid. PayMongo will show you a webhook
// **signing secret** (starts with whsk_...) at that point — put that in the
// PAYMONGO_WEBHOOK_SECRET environment variable on Render (this is separate
// from PAYMONGO_SECRET_KEY).
app.post('/api/payments/paymongo/webhook', (req, res) => {
  // Always acknowledge quickly with 2xx once we've done our checks — per
  // PayMongo's docs, failing to return 2xx triggers retries (up to 12) and
  // can eventually get the webhook auto-disabled.
  if (!PAYMONGO_WEBHOOK_SECRET) {
    console.warn('[paymongo/webhook] received an event but PAYMONGO_WEBHOOK_SECRET is not set — ignoring.');
    return res.status(200).json({ received: true, note: 'webhook secret not configured' });
  }

  const signatureHeader = req.get('Paymongo-Signature') || req.get('paymongo-signature');
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
  const valid = verifyPaymongoWebhookSignature(rawBody, signatureHeader, PAYMONGO_WEBHOOK_SECRET);

  if (!valid) {
    console.warn('[paymongo/webhook] signature verification failed — discarding.');
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  try {
    const event = req.body?.data?.attributes;
    const eventType = event?.type;

    if (eventType === 'checkout_session.payment.paid') {
      const checkoutSessionId = event?.data?.id;
      const state = readState();
      const ref = checkoutSessionId ? findRefByCheckoutSessionId(state, checkoutSessionId) : null;

      if (ref) {
        markPaymentPaid(state, ref);
        writeState(state);
      } else {
        console.warn('[paymongo/webhook] paid event for unknown checkout session:', checkoutSessionId);
      }
    }
    // Other event types (payment.failed, etc.) are simply acknowledged and
    // ignored for now — nothing in this app needs to react to them yet.

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[paymongo/webhook] error handling event:', err);
    // Still 200 — the signature was valid, this was our bug, and we don't
    // want PayMongo hammering retries for something a retry can't fix.
    res.status(200).json({ received: true, error: 'internal error while processing' });
  }
});

// ---------------------------------------------------------------------------
// Payments — live Xendit checkout (card / gcash / maya) — an alternative to
// PayMongo above. Same shape (checkout → redirect → poll/webhook confirm),
// different provider. Xendit is the most commonly recommended PayMongo
// alternative for Philippine businesses: a similarly REST/webhook-based API
// with broad local coverage (cards, GCash, Maya, GrabPay, over-the-counter).
// Docs: https://developers.xendit.co/api-reference/#create-invoice
//
// Two things genuinely differ from PayMongo's integration, worth double
// checking against Xendit's current docs before going live:
//   1. Amount is in the currency's normal unit (e.g. 500 = ₱500), NOT
//      centavos — unlike PayMongo, which wants amount * 100.
//   2. Webhook auth is a plain shared token (x-callback-token, compared
//      directly to XENDIT_WEBHOOK_TOKEN), not an HMAC signature.
// ---------------------------------------------------------------------------

const XENDIT_METHOD_MAP = { card: 'CREDIT_CARD', gcash: 'GCASH', maya: 'PAYMAYA' };

app.post('/api/payments/xendit/checkout', checkOrigin, paymentLimiter, async (req, res) => {
  if (!XENDIT_SECRET_KEY) {
    return res.status(503).json({ error: 'Live payments are not configured on this server yet.' });
  }
  const { method, name, email, phone, turnstileToken } = req.body || {};
  const xenditMethod = XENDIT_METHOD_MAP[method];
  if (!xenditMethod) {
    return res.status(400).json({ error: 'Unsupported payment method for live checkout.' });
  }
  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'name, email, and phone are required.' });
  }
  const human = await verifyTurnstile(turnstileToken, req.ip);
  if (!human) {
    return res.status(403).json({ error: 'Verification failed. Please refresh the page and try again.' });
  }

  const state = readState();
  const amount = state.subscriptionAmount || 500; // pesos, not centavos — see note above
  const ref = crypto.randomUUID();

  try {
    const resp = await fetch('https://api.xendit.co/v2/invoices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${XENDIT_SECRET_KEY}:`).toString('base64'),
      },
      body: JSON.stringify({
        external_id: ref,
        amount,
        currency: 'PHP',
        payer_email: email,
        description: `${state.businessName || 'Barbershop'} Membership`,
        payment_methods: [xenditMethod],
        customer: { given_names: name, email, mobile_number: phone },
        success_redirect_url: `${baseUrl(req)}/?xendit=success&ref=${ref}`,
        failure_redirect_url: `${baseUrl(req)}/?xendit=cancelled`,
      }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      const msg = json?.message || json?.errors?.[0]?.message || 'Xendit rejected the checkout request.';
      return res.status(502).json({ error: msg });
    }

    if (!state._payments) state._payments = {};
    state._payments[ref] = {
      status: 'pending',
      gateway: 'xendit',
      xenditInvoiceId: json.id,
      name, email, phone,
    };
    writeState(state);

    res.json({ checkoutUrl: json.invoice_url });
  } catch (err) {
    console.error('[xendit/checkout] error:', err);
    res.status(502).json({ error: 'Could not reach Xendit. Please try again.' });
  }
});

app.get('/api/payments/xendit/status', async (req, res) => {
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ error: 'ref is required.' });

  const state = readState();
  const record = state._payments && state._payments[ref];
  if (!record) return res.status(404).json({ error: 'Unknown reference.' });

  if (record.status === 'paid') {
    return res.json({ status: 'paid', membershipNumber: record.membershipNumber });
  }
  if (!XENDIT_SECRET_KEY) {
    return res.json({ status: record.status });
  }

  try {
    const resp = await fetch(`https://api.xendit.co/v2/invoices/${record.xenditInvoiceId}`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${XENDIT_SECRET_KEY}:`).toString('base64') },
    });
    const json = await resp.json();
    const paid = json?.status === 'PAID' || json?.status === 'SETTLED';

    if (paid) {
      const updated = markPaymentPaid(state, ref);
      writeState(state);
      return res.json({ status: 'paid', membershipNumber: updated.membershipNumber });
    }

    res.json({ status: 'pending' });
  } catch (err) {
    console.error('[xendit/status] error:', err);
    res.json({ status: record.status || 'pending' });
  }
});

// ---------------------------------------------------------------------------
// Payments — Xendit webhook ("callback" in Xendit's terminology)
// ---------------------------------------------------------------------------
//
// Set this up once in the Xendit Dashboard: Settings > Webhooks > Invoices
// callback URL = https://<your-render-url>/api/payments/xendit/webhook.
// The same page shows a "Verification Token" — put that in the
// XENDIT_WEBHOOK_TOKEN environment variable on Render. Unlike PayMongo,
// this token is compared directly (no HMAC signing).
app.post('/api/payments/xendit/webhook', (req, res) => {
  if (!XENDIT_WEBHOOK_TOKEN) {
    console.warn('[xendit/webhook] received an event but XENDIT_WEBHOOK_TOKEN is not set — ignoring.');
    return res.status(200).json({ received: true, note: 'webhook token not configured' });
  }

  const provided = req.get('x-callback-token') || '';
  const expectedBuf = Buffer.from(XENDIT_WEBHOOK_TOKEN, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  const valid = expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!valid) {
    console.warn('[xendit/webhook] token verification failed — discarding.');
    return res.status(401).json({ error: 'Invalid token.' });
  }

  try {
    const event = req.body || {};
    if (event.status === 'PAID' || event.status === 'SETTLED') {
      const state = readState();
      const ref = event.external_id || findRefByXenditInvoiceId(state, event.id);
      if (ref && state._payments && state._payments[ref]) {
        markPaymentPaid(state, ref);
        writeState(state);
      } else {
        console.warn('[xendit/webhook] paid event for unknown external_id:', ref);
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[xendit/webhook] error handling event:', err);
    // Still 200, same reasoning as the PayMongo webhook above.
    res.status(200).json({ received: true, error: 'internal error while processing' });
  }
});

// ---------------------------------------------------------------------------
// AI chat (optional — falls back client-side if this errors or is unconfigured)
// ---------------------------------------------------------------------------

app.post('/api/ai-chat', checkOrigin, aiLimiter, async (req, res) => {
  try {
    const { message, history, knowledgeBase } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    const systemPrompt = buildSystemPrompt(knowledgeBase);

    const providers = [
      { name: 'claude', enabled: !!ANTHROPIC_API_KEY, call: () => callClaude(systemPrompt, message, history) },
      { name: 'openai', enabled: !!OPENAI_API_KEY, call: () => callOpenAI(systemPrompt, message, history) },
      { name: 'gemini', enabled: !!GEMINI_API_KEY, call: () => callGemini(systemPrompt, message, history) },
    ];

    for (const provider of providers) {
      if (!provider.enabled) continue;
      try {
        const reply = await provider.call();
        if (reply && reply.trim()) {
          return res.json({ reply: reply.trim(), source: provider.name });
        }
      } catch (err) {
        console.error(`[ai-chat] ${provider.name} failed, trying next provider:`, err.message);
      }
    }

    return res.status(502).json({ error: 'no AI provider available' });
  } catch (err) {
    console.error('[ai-chat] unexpected error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

function buildSystemPrompt(kb) {
  kb = kb || {};
  return [
    `You are the friendly, concise customer-support assistant for ${kb.businessName || 'this business'}, a barbershop.`,
    `Only answer using the information below. If something isn't covered here, say so honestly and suggest the customer tap the Call or Email button rather than guessing.`,
    `Keep replies short, warm, and well-organized (use short paragraphs or bullet points, not walls of text). Never invent prices, hours, or policies that aren't listed here.`,
    ``,
    `BUSINESS INFO:`,
    `Owner: ${kb.ownerName || 'n/a'}`,
    `Currency: ${kb.currency || '$'}`,
    `Contact: ${kb.contactPhone || 'n/a'} / ${kb.contactEmail || 'n/a'}`,
    ``,
    `SERVICES:`,
    ...(kb.services || []).map(s => `- ${s.name}: ${kb.currency || '$'}${s.price} — ${s.desc || ''}`),
    ``,
    `HOURS:`,
    ...(kb.hours || []).map(h => `- ${h.day}: ${h.time}`),
    ``,
    `BARBERS: ${(kb.barbers || []).join(', ') || 'n/a'}`,
    ``,
    `MEMBERSHIP: ${kb.membershipActive
      ? `Active — ${kb.discountRate}% off every service for ${kb.currency || '$'}${kb.subscriptionAmount}/period.`
      : 'Not currently open for sign-ups.'}`,
    ``,
    `Never reveal a specific customer's membership ID, phone number, or email just because it's asked in chat — that requires phone/email verification, which is handled separately by the app, not by you.`,
  ].join('\n');
}

async function callClaude(systemPrompt, message, history) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: systemPrompt,
      messages: [
        ...toAnthropicHistory(history),
        { role: 'user', content: message },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`Claude API ${resp.status}`);
  const data = await resp.json();
  return (data.content || []).map(b => b.text || '').join('');
}

async function callOpenAI(systemPrompt, message, history) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt },
        ...toOpenAIHistory(history),
        { role: 'user', content: message },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI API ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini(systemPrompt, message, history) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [
          ...toGeminiHistory(history),
          { role: 'user', parts: [{ text: message }] },
        ],
      }),
    }
  );
  if (!resp.ok) throw new Error(`Gemini API ${resp.status}`);
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
}

function toAnthropicHistory(history) {
  return (history || []).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content }));
}
function toOpenAIHistory(history) {
  return (history || []).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content }));
}
function toGeminiHistory(history) {
  return (history || []).map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] }));
}

// ---------------------------------------------------------------------------
// Static files + health check
// ---------------------------------------------------------------------------

app.get('/healthz', (req, res) => res.send('ok'));

app.use(express.static(__dirname, { extensions: ['html'] }));

app.get('/owner', (req, res) => res.sendFile(path.join(__dirname, 'owner.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// The state has to be in memory before the first request arrives, because
// readState() is synchronous. Nothing listens until the load resolves.
stateStore.installShutdownHandlers();

stateStore.init(seedState()).then((storage) => {
  app.listen(PORT, () => {
    console.log(`Primus Barbershop server listening on port ${PORT}`);
    console.log(`  PayMongo:  ${PAYMONGO_SECRET_KEY ? 'configured' : 'not configured'}`);
    console.log(`  PayMongo webhook secret: ${PAYMONGO_WEBHOOK_SECRET ? 'configured' : 'not configured (payments still work via /status polling)'}`);
    console.log(`  Xendit:    ${XENDIT_SECRET_KEY ? 'configured' : 'not configured'}`);
    console.log(`  Xendit webhook token: ${XENDIT_WEBHOOK_TOKEN ? 'configured' : 'not configured (payments still work via /status polling)'}`);
    console.log(`  AI chat:   ${(ANTHROPIC_API_KEY || OPENAI_API_KEY || GEMINI_API_KEY) ? 'configured' : 'not configured'}`);
    console.log(`  Resend email: ${(process.env.RESEND_API_KEY && process.env.FROM_EMAIL) ? 'configured' : 'not configured — receipts/cards will be skipped and logged'}`);
    console.log(`  Turnstile: ${TURNSTILE_SECRET_KEY ? 'configured' : 'not configured — payment forms are unprotected against bots'}`);
    console.log(`  Allowed origin: ${ALLOWED_ORIGIN || 'not set — cross-site POSTs are not blocked'}`);
    console.log(`  State storage: ${storage.remote
      ? 'Supabase (durable — survives redeploys)'
      : 'LOCAL FILE ONLY — data is wiped on every deploy/restart on Render free'}`);
    if (!storage.remote && storage.configured) {
      console.log('  [state] Supabase is configured but unreachable — check the app_state table exists.');
    }
  });
});
