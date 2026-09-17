/**
 * ADVANCED AI CHAT — server-side example
 * =======================================
 * This is NOT a standalone file to run. It's a snippet to merge into your
 * existing server.js, in the same style as your PayMongo integration
 * (secret keys live here, on the server, never in index.html).
 *
 * WHY THIS HAS TO LIVE ON THE SERVER
 * -----------------------------------
 * OpenAI (GPT), Anthropic (Claude), and Google (Gemini) API keys are secret,
 * billable credentials. If they were pasted into index.html, anyone who
 * right-clicks "View Page Source" (or opens DevTools -> Network tab) could
 * copy them and run up charges on your account. Keeping them as server
 * environment variables — the same pattern your PayMongo key already uses —
 * means they're never sent to the browser at all.
 *
 * WHAT TO DO
 * ----------
 * 1. Add these lines wherever server.js reads its other secrets/env vars:
 *
 *      const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || '';
 *      const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
 *      const GEMINI_API_KEY    = process.env.GEMINI_API_KEY    || '';
 *
 *    Then set the ones you want to use as real environment variables (or in
 *    your .env file, however server.js already loads PAYMONGO_SECRET_KEY).
 *    You don't need all three — one is enough to turn the feature on.
 *
 * 2. Find the GET /api/state route (the one that already adds
 *    `paymongoAvailable` to its response) and add one more field next to it:
 *
 *      paymongoAvailable: !!PAYMONGO_SECRET_KEY,
 *      aiChatAvailable: !!(OPENAI_API_KEY || ANTHROPIC_API_KEY || GEMINI_API_KEY),
 *
 *    index.html already reads this flag to enable/disable the "Use Advanced
 *    AI" toggle in the admin panel's Chat Widget tab.
 *
 * 3. Add the POST /api/ai-chat route below to server.js (adjust the
 *    `app.post(...)` wrapper to match your existing Express setup).
 *
 * 4. Restart server.js. Turn the toggle on in the admin panel. Done —
 *    the chat widget already calls this endpoint and falls back to its
 *    built-in assistant automatically if this route errors or isn't there.
 */

// ---- 3. The actual endpoint ------------------------------------------------

app.post('/api/ai-chat', async (req, res) => {
  try {
    const { message, history, knowledgeBase } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    // Ground every provider in the SAME live business data the built-in
    // assistant uses (services, prices, hours, barbers, membership terms,
    // contact info) — this is what "answer from the site's real data"
    // means in practice: a compact, trustworthy summary, not the raw HTML
    // file (which would be slower, costlier per call, and leak far more
    // than a customer-support bot needs).
    const systemPrompt = buildSystemPrompt(knowledgeBase);

    // "Combine GPT, Claude, and Gemini as source" = a fallback chain: try
    // each configured provider in order and use the first one that answers
    // successfully. This keeps cost/latency the same as calling just one
    // provider, while giving you redundancy if any single provider is down,
    // slow, or its key gets rate-limited. (If you'd rather ask all three and
    // merge/vote on the answers instead, that's a bigger change — happy to
    // build that version if you want true multi-source blending instead of
    // failover; just say so.)
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
        // fall through to the next provider in the chain
      }
    }

    // Every configured provider failed (or none are configured) — tell the
    // front-end so it can fall back to the built-in assistant. This is a
    // normal, expected response shape, not a crash.
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

// ---- Provider calls ---------------------------------------------------
// Each one takes the same (systemPrompt, message, history) shape and
// returns a plain string reply, so the fallback loop above can treat all
// three interchangeably.

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

// ---- History format helpers --------------------------------------------
// The chat widget sends history as [{role:'user'|'assistant', content}], a
// rolling window of the last few visible messages. Each provider wants it
// shaped slightly differently.

function toAnthropicHistory(history) {
  return (history || []).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content }));
}
function toOpenAIHistory(history) {
  return (history || []).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content }));
}
function toGeminiHistory(history) {
  return (history || []).map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] }));
}
