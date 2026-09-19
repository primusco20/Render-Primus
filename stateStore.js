/**
 * stateStore.js — durable storage for what used to live in data/state.json.
 * ====================================================================
 * Render's free plan gives a service no persistent disk, so the filesystem is
 * recreated on every deploy, restart and idle spin-down. That silently erased
 * members, bookings, staff profiles and every admin setting — and left
 * orphaned Supabase logins behind, since Supabase Auth survived while the
 * matching state.json profile did not.
 *
 * This moves the whole state blob into a single Postgres row in the Supabase
 * project the app already uses. One-time SQL to create it:
 *
 *   create table if not exists app_state (
 *     id          text primary key,
 *     data        jsonb not null default '{}'::jsonb,
 *     updated_at  timestamptz not null default now()
 *   );
 *   alter table app_state enable row level security;
 *
 * Leave RLS on and add NO policies. The server talks to this table with the
 * service_role/secret key, which bypasses RLS; with no policies, the
 * publishable/anon key the browser holds can neither read nor write it.
 *
 * ---------------------------------------------------------------------------
 * Why this keeps a synchronous read()/write() API
 * ---------------------------------------------------------------------------
 * server.js calls readState() 20 times and writeState() 13 times, all
 * synchronously, from inside request handlers. Making those async would mean
 * touching every one of those call sites and every function that contains
 * them — a large change with a lot of room for a missed `await` that silently
 * returns a Promise where a state object is expected.
 *
 * Instead the row is loaded into memory once at boot (see init(), which is
 * awaited before the server starts listening), reads are served from that
 * copy, and writes update it immediately and then persist in the background,
 * debounced so a burst of saves becomes one round trip. Call sites are
 * unchanged.
 *
 * The trade-off is that a crash in the ~400ms between a write and its flush
 * loses that write. flushNow() is therefore wired to SIGTERM/SIGINT, which is
 * what Render sends on a deploy, so an orderly restart always drains first.
 *
 * This assumes ONE server instance, which is what the free plan runs. If the
 * service is ever scaled to multiple instances, each would hold its own copy
 * and last-flush-wins would lose edits — at that point reads need to go
 * straight to Postgres rather than to this cache.
 *
 * If Supabase isn't configured, or the initial load fails, everything falls
 * back to the original local file. The site keeps working; it just isn't
 * durable, exactly as before.
 */

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json');

// Lets one Supabase project back more than one deployment (staging/production)
// without them fighting over the same row.
const ROW_ID = process.env.STATE_ROW_ID || 'primus';
const TABLE = 'app_state';
const FLUSH_DEBOUNCE_MS = 400;

let cache = null;          // the authoritative in-memory copy
let remote = false;        // true once Supabase is confirmed reachable
let flushTimer = null;
let flushing = null;       // in-flight flush, so shutdown can await it
let dirty = false;
let lastFlushError = null;

function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_SECRET_KEY);
}

function isRemote() {
  return remote;
}

function status() {
  return { remote, configured: isConfigured(), lastFlushError, dirty };
}

// Each read hands back an independent object, matching the old behaviour of
// re-parsing the file every time. Handlers mutate what they get back and only
// the ones that call write() persist anything; sharing the cached object
// directly would make every stray mutation take effect.
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function restHeaders(extra) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

async function loadRemote() {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(ROW_ID)}&select=data`;
  const resp = await fetch(url, { headers: restHeaders() });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`load ${resp.status} ${body.slice(0, 300)}`);
  }
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length ? rows[0].data : null;
}

async function saveRemote(state) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: restHeaders({
      // Upsert: insert the row, or overwrite it if this id already exists.
      Prefer: 'resolution=merge-duplicates,return=minimal',
    }),
    body: JSON.stringify([{ id: ROW_ID, data: state, updated_at: new Date().toISOString() }]),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`save ${resp.status} ${body.slice(0, 300)}`);
  }
}

function readLocalFile() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

// The local file is kept as a mirror even when Supabase is the source of
// truth. It costs nothing, and it means a Supabase outage at boot still finds
// the most recent state this instance saw rather than an empty seed.
function writeLocalFile(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    if (!remote) console.error('[state] could not write local state file:', e.message);
  }
}

/**
 * Loads the state into memory. Must be awaited before the server starts
 * handling requests, since read() is synchronous afterwards.
 *
 * On a first run against an empty table, an existing local state.json is
 * uploaded as the starting row — so an already-running deployment carries its
 * current data over instead of resetting.
 */
async function init(seedState) {
  if (!isConfigured()) {
    console.warn('[state] SUPABASE_URL / SUPABASE_SECRET_KEY not set — using the local file only.');
    console.warn('[state] On Render\'s free plan that disk is wiped on every deploy and restart.');
    cache = readLocalFile() || clone(seedState);
    writeLocalFile(cache);
    return status();
  }

  try {
    const stored = await loadRemote();
    if (stored && typeof stored === 'object') {
      cache = stored;
      remote = true;
      console.log('[state] loaded from Supabase.');
    } else {
      // No row yet — seed it, preferring whatever this instance already has
      // on disk so an existing deployment migrates rather than resets.
      const local = readLocalFile();
      cache = local || clone(seedState);
      await saveRemote(cache);
      remote = true;
      console.log(local
        ? '[state] no row in Supabase yet — migrated the existing state.json into it.'
        : '[state] no row in Supabase yet — created an empty one.');
    }
  } catch (err) {
    // Reachability problems must not take the site down: fall back to the
    // old behaviour and keep retrying on each write.
    remote = false;
    lastFlushError = err.message;
    console.error('[state] Supabase unavailable at boot, falling back to the local file:', err.message);
    cache = readLocalFile() || clone(seedState);
  }

  writeLocalFile(cache);
  return status();
}

function read() {
  // init() should have run, but never hand back null if something calls in
  // early — an empty object behaves like the old missing-file path.
  if (!cache) cache = {};
  return clone(cache);
}

function write(state) {
  cache = clone(state);
  dirty = true;
  writeLocalFile(cache);
  if (!isConfigured()) return;

  // Debounced: an admin save that touches several fields, or a burst of
  // call-console heartbeats, becomes one upsert rather than a dozen.
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushNow().catch(() => {}); }, FLUSH_DEBOUNCE_MS);
}

async function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!isConfigured() || !dirty || !cache) return status();
  if (flushing) return flushing;

  const snapshot = cache;
  flushing = (async () => {
    try {
      await saveRemote(snapshot);
      // Only clear the flag if nothing new arrived while this was in flight.
      if (cache === snapshot) dirty = false;
      remote = true;
      lastFlushError = null;
    } catch (err) {
      lastFlushError = err.message;
      console.error('[state] could not persist to Supabase (will retry on next write):', err.message);
    } finally {
      flushing = null;
    }
    return status();
  })();
  return flushing;
}

// Render sends SIGTERM before replacing an instance. Draining here is what
// makes a deploy safe rather than a ~400ms window where the last write is
// lost.
function installShutdownHandlers() {
  let closing = false;
  const drain = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[state] ${signal} received — flushing state before exit.`);
    try { await flushNow(); } catch (e) { /* already logged */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => drain('SIGTERM'));
  process.on('SIGINT', () => drain('SIGINT'));
}

module.exports = {
  init,
  read,
  write,
  flushNow,
  isRemote,
  isConfigured,
  status,
  installShutdownHandlers,
  TABLE,
  ROW_ID,
};
