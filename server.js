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
 *   POST /api/payments/manual             submit a manual-transfer membership
 *   GET  /api/payments/paymongo/status    poll a checkout session's status
 *   POST /api/ai-chat                     advanced AI chat (optional)
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
 *   PAYMONGO_SECRET_KEY    optional — enables live card/GCash/Maya checkout
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

const app = express();
app.set('trust proxy', true); // Render sits behind a proxy; needed for correct req.protocol
app.use(express.json({ limit: '15mb' })); // generous limit: settings blob can include base64 images

const PORT = process.env.PORT || 3000;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json');
const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const DEFAULT_ADMIN_PASSWORD = 'primusadmin2026'; // matches index.html's client-side default

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    // First run, or file missing/corrupt — start from a minimal seed.
    // Everything else (services, hours, gallery, etc.) is filled in by
    // index.html's own client-side defaults via Object.assign, the first
    // time nothing comes back from the server for those fields.
    return {
      adminPassword: DEFAULT_ADMIN_PASSWORD,
      members: {},
      bookings: [],
      merchant: { paymongoEnabled: false },
      _payments: {}, // internal: paymongo ref -> { status, membershipNumber, checkoutSessionId, name, email, phone }
    };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function requireAdmin(req, res, state) {
  const provided = req.get('x-admin-password') || '';
  const actual = state.adminPassword || DEFAULT_ADMIN_PASSWORD;
  if (provided !== actual) {
    res.status(401).json({ error: 'Incorrect admin password.' });
    return false;
  }
  return true;
}

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

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

// ---------------------------------------------------------------------------
// State routes
// ---------------------------------------------------------------------------

app.get('/api/state', (req, res) => {
  const state = readState();
  const publicState = { ...state };
  delete publicState.adminPassword;
  delete publicState._payments;
  publicState.paymongoAvailable = !!PAYMONGO_SECRET_KEY;
  publicState.aiChatAvailable = !!(ANTHROPIC_API_KEY || OPENAI_API_KEY || GEMINI_API_KEY);
  res.json(publicState);
});

app.post('/api/state', (req, res) => {
  const state = readState();
  if (!requireAdmin(req, res, state)) return;
  const incoming = req.body || {};
  // Preserve internal bookkeeping that the client doesn't know about.
  const merged = { ...state, ...incoming, _payments: state._payments || {} };
  writeState(merged);
  res.json({ ok: true });
});

app.get('/api/admin/state', (req, res) => {
  const state = readState();
  if (!requireAdmin(req, res, state)) return;
  const out = { ...state };
  delete out._payments;
  res.json(out);
});

// ---------------------------------------------------------------------------
// Payments — manual (bank/GCash transfer verified by staff later)
// ---------------------------------------------------------------------------

app.post('/api/payments/manual', (req, res) => {
  const { method, name, email, phone, referenceNumber } = req.body || {};
  if (!name || !email || !phone || !referenceNumber) {
    return res.status(400).json({ error: 'name, email, phone, and referenceNumber are required.' });
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
  };
  writeState(state);
  res.json({ membershipNumber: memNum });
});

// ---------------------------------------------------------------------------
// Payments — live PayMongo checkout (card / gcash / maya)
// ---------------------------------------------------------------------------

const PAYMONGO_METHOD_MAP = { card: 'card', gcash: 'gcash', maya: 'paymaya' };

app.post('/api/payments/paymongo/checkout', async (req, res) => {
  if (!PAYMONGO_SECRET_KEY) {
    return res.status(503).json({ error: 'Live payments are not configured on this server yet.' });
  }
  const { method, name, email, phone } = req.body || {};
  const pmMethod = PAYMONGO_METHOD_MAP[method];
  if (!pmMethod) {
    return res.status(400).json({ error: 'Unsupported payment method for live checkout.' });
  }
  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'name, email, and phone are required.' });
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
      if (!state.members) state.members = {};
      const existing = findMemberByContact(state.members, record.email, record.phone);
      const memNum = existing || generateMembershipNumber(state.members);
      state.members[memNum] = {
        name: record.name, email: record.email, phone: record.phone,
        method: 'paymongo',
        paidDate: new Date().toISOString().slice(0, 10),
        active: true,
        pendingVerification: false,
      };
      record.status = 'paid';
      record.membershipNumber = memNum;
      writeState(state);
      return res.json({ status: 'paid', membershipNumber: memNum });
    }

    res.json({ status: 'pending' });
  } catch (err) {
    console.error('[paymongo/status] error:', err);
    res.json({ status: record.status || 'pending' });
  }
});

// ---------------------------------------------------------------------------
// AI chat (optional — falls back client-side if this errors or is unconfigured)
// ---------------------------------------------------------------------------

app.post('/api/ai-chat', async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Primus Barbershop server listening on port ${PORT}`);
  console.log(`  PayMongo:  ${PAYMONGO_SECRET_KEY ? 'configured' : 'not configured'}`);
  console.log(`  AI chat:   ${(ANTHROPIC_API_KEY || OPENAI_API_KEY || GEMINI_API_KEY) ? 'configured' : 'not configured'}`);
});
