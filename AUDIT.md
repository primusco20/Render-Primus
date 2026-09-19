# Primus Barbershop — security & correctness audit

Scope: `server.js` (1,156 lines) and `index.html` (13,511 lines) as uploaded
19 Sep 2026, plus `supabaseAdmin.js`, `mailer.js`, `render.yaml`,
`package.json`, `create-owner.js`.

**Not reviewed:** `owner.html` (not provided). Several findings below touch
it, and the admin-panel migration can't be planned without it.

Severity is about *this* deployment — a public repo, a live Render URL, real
customer payments and real biometric data.

---

## CRITICAL

### C1 — Default admin password is published in a public repo

`server.js:127`

```js
const DEFAULT_ADMIN_PASSWORD = 'primusadmin2026'; // matches index.html's client-side default
```

Also at `index.html:5275`. `readState()` seeds `adminPassword` with this
value on first run, and `requireAdmin()` falls back to it whenever
`state.adminPassword` is unset.

The GitHub repo is **public**. Anyone who reads it can send
`x-admin-password: primusadmin2026` and get full admin: rewrite prices,
read `/api/admin/state`, delete staff, alter memberships.

This is also not hypothetical for you specifically — see F1, because the
state file resets, which restores the default password every time.

**Fix**
- Remove the constant. Read `process.env.ADMIN_PASSWORD` and refuse to start
  if it isn't set.
- Change the current password immediately, regardless.
- Consider the repo's history compromised: rotate anything that was ever
  committed to it.

---

### C2 — Stored XSS on the customer homepage, reachable by anyone

`index.html:8452`

```js
? `<img src="${b.photo}" alt="${escapeAttr(b.name)}">`
```

`b.name` and `b.bio` are escaped. `b.photo` is not.

The full chain is open to an anonymous attacker:

1. `POST /api/staff/signup` is public. A **Barber** signup is auto-approved
   (`server.js:527` — `const approved = pos !== 'Support'`), so it lands
   `approved: true, active: true` with no human in the loop.
2. Sign in via Supabase, get an access token.
3. `PATCH /api/staff/me` accepts `photo` (`STAFF_SELF_EDITABLE_FIELDS`,
   `server.js:561`) and writes it with no validation:
   `acct[key] = req.body[key]`.
4. Set `photo` to `x" onerror="/* anything */`.
5. `renderTeamSection()` renders it into "Meet the Team" for **every
   customer** who loads the homepage.

From there: read the admin password out of `localStorage`
(`primus_admin_settings`), keylog the membership payment form, redirect
checkout. It runs on the same origin as the payment flow.

**Fix**
- Escape it: `src="${escapeAttr(b.photo)}"`.
- Validate server-side in `/api/staff/me`: accept only `https:` URLs or
  `data:image/(png|jpe?g|webp);base64,` payloads, with a length cap.
- Same unescaped pattern exists at `index.html` lines 6562, 7109, 7118,
  7673, 7792, 7842, 7908, 7946, 8090, 10040. Those are admin-controlled
  rather than public, so lower severity — fix them in the same pass.

---

### C3 — `GET /api/state` publishes everything, including biometrics

`server.js:390–399` strips only `adminPassword` and `_payments`. Everything
else in `state.json` goes to anyone who requests the URL, unauthenticated.

Currently exposed:

| Field | Why it matters |
|---|---|
| `ownerFaceDescriptor` | 128-float biometric template for the owner |
| `barberAccounts[].faceDescriptor` | Same, per staff member |
| `barberAccounts[].email` / `.phone` | Staff PII |
| `members` | Customer name, email, phone, membership number, payment method |
| `barberAccounts[].supportPeerId` | Live PeerJS call ID — callable directly |

Under the Philippine Data Privacy Act, the face descriptors and member
records are personal (and in the biometric case, sensitive) information
being disclosed without any access control.

**Fix** — split the endpoint. Public `/api/state` should return only what
the customer page renders: business info, services, hours, gallery,
reviews, and a **projection** of barbers (`name`, `position`, `photo`,
`status`, `bio`). Everything else moves behind `requireAdmin` or the
staff-session check. This is also the prerequisite for making `index.html`
customer-only.

---

### C4 — Face ID is not a second factor

`index.html:5650` and `9384`:

```js
const distance = faceapi.euclideanDistance(descriptor, appSettings.ownerFaceDescriptor);
if (distance <= FACE_MATCH_THRESHOLD) { /* pass */ }
```

The comparison runs in the visitor's own browser, against a template that
C3 hands out publicly. An attacker doesn't need to defeat it — they can
call the success branch from the devtools console, or edit
`FACE_MATCH_THRESHOLD`.

`STAFF_ACCOUNTS.md` describes it as "the mandatory second factor". It is a
UI affordance, not a security control, and shouldn't be relied on while the
admin password is the only real gate.

**Fix** — either treat it as UX only and document it as such, or move
matching server-side (descriptor never leaves the server, comparison
happens in `requireAdmin`). Don't leave it described as a factor it isn't.

---

## HIGH

### H1 — Admin password can be brute-forced

`POST /api/state`, `/api/admin/state`, `/api/staff/reset-password` and
`DELETE /api/staff/:id` have **no rate limiter** — `paymentLimiter` is
applied only to payment and signup routes. Unlimited guesses at
`x-admin-password`, no lockout, no logging.

Comparison is also non-constant-time (`server.js:180`). Minor next to the
missing limiter, but use `crypto.timingSafeEqual` when you fix it.

### H2 — `/api/ai-chat` is unauthenticated, unthrottled, unbounded

`server.js:997` — no `checkOrigin`, no limiter. Anyone can POST in a loop
and bill your Anthropic/OpenAI/Gemini account. `history` and
`knowledgeBase` are caller-supplied and go straight into the prompt, so it
also works as a free general-purpose LLM proxy and as a prompt-injection
surface.

**Fix** — add `checkOrigin` and a limiter; cap `history` length; build the
knowledge base from server-side state instead of trusting the request body.

### H3 — `trust proxy: true` makes the rate limiter bypassable

`server.js:93`. With this set, `req.ip` is taken from the client-supplied
`X-Forwarded-For` header. An attacker rotates the header and every request
looks like a new IP, so `paymentLimiter` never fires.

**Fix** — `app.set('trust proxy', 1)` on Render (one proxy hop).

### H4 — Self-editable `active` flag

`STAFF_SELF_EDITABLE_FIELDS` includes `active`. A staff member an admin has
deactivated can `PATCH /api/staff/me {"active": true}` and put themselves
back on the public team page. `approved` is correctly excluded — `active`
should be too.

### H5 — Turnstile is inert on the staff signup form

`index.html:3866` still carries the placeholder `YOUR_TURNSTILE_SITE_KEY`,
and the only widget on the page sits in the payment section. The staff
signup at `index.html:8978` sends the shared `turnstileToken` variable,
which is `''` unless the visitor happened through the payment flow first.

So today: `TURNSTILE_SECRET_KEY` unset → `verifyTurnstile` returns `true`
and signup is unprotected. The moment you set it → every staff signup fails
with "Verification failed."

**Fix** — real sitekey, and render a widget inside the signup pane.

---

## FUNCTIONAL

### F1 — `state.json` is on ephemeral storage and is being wiped

`server.js:104` writes to `<app>/data/state.json`. `render.yaml` declares
`plan: free` with **no `disk:` block**, so there is no persistent volume.
Render's filesystem resets on every deploy, restart, and free-tier
spin-down after idle.

Consequences you are probably already seeing:

- Members, bookings, staff profiles and approvals vanish without warning.
  This is very likely why `barberAccounts` was `[]` earlier.
- `adminPassword` reverts to the C1 default on every reset.
- Supabase Auth users **do** persist while their `state.json` profile does
  not. You accumulate orphaned logins that authenticate successfully and
  then fail with "Account not found" at `/api/staff/me`.

**Fix** — this needs a real datastore. You already run Supabase; moving
`state.json` into a Postgres table there is the smallest change that makes
the data durable. A Render paid disk also works. Nothing else in this
document matters much until data stops disappearing.

### F2 — Changing position to Support silently revokes approval

`index.html:8661`. Covered in chat — approve *after* the position change,
and set both Role (`staff`) and Position (`Support`), since
`getLiveSupportAgents()` requires both.

### F3 — `create-owner.js` cannot run as committed

`require('../supabaseAdmin')` resolves outside the project when the file
sits at the repo root. Either move it to `scripts/` (as the docs assume) or
change the path to `./supabaseAdmin`.

### F4 — AI voice has no provider

`aiChatAvailable: false` — no AI key set on Render, so `/api/ai-chat`
returns `502` and there is no reply to speak.

Secondary, once a key is set: on iOS Safari `speechSynthesis.speak()` is
blocked unless it originates in a user gesture. Replies arrive after a
`fetch`, so the first utterance of a session may be dropped. Prime the
queue with a silent utterance inside the send-button handler.

### F5 — Documentation contradicts the code

`STAFF_ACCOUNTS.md` states that `GET /api/state` exposing staff data is no
longer true ("Neither is true anymore"). Password hashes are indeed gone,
but the endpoint still publishes emails, phones, face descriptors and
member records — see C3. Anyone relying on that document will
mis-assess the risk.

---

## MEDIUM / LOW

- **15 MB JSON body limit** on every route (`server.js:99`) with no
  authentication on `/api/ai-chat` — cheap memory-pressure vector on a
  free-tier instance.
- **`POST /api/state` is a whole-blob overwrite.** Two admins in two tabs:
  last writer wins, silently. The `VOLATILE_STAFF_FIELDS` guard patches
  this for five call-state fields only.
- **No `Content-Security-Policy`, `X-Frame-Options`, or
  `X-Content-Type-Options`.** A CSP would have blunted C2.
- **Chat history restored via `innerHTML`** from `localStorage`
  (`index.html:6468`). Self-XSS only, but it re-executes whatever C2 wrote.
- **Membership numbers are `MEM-` + 5 random digits** — 90,000 values,
  enumerable, and `/api/members/resend-card` will mail a card to the
  address on file for a guessed number.
- **No structured logging on privileged actions.** After an incident there
  is no way to tell what was changed or by whom.

---

## Suggested order

Each step leaves the site working.

1. **F1** — durable storage. Everything else is written on sand until this
   is done.
2. **C1** — rotate the admin password, remove the hardcoded default.
3. **C2 + H4** — escape `b.photo`, validate it server-side, drop `active`
   from the self-editable list. One small commit.
4. **C3** — split `/api/state` into public and privileged payloads. This is
   the real prerequisite for making `index.html` customer-only.
5. **H1, H2, H3** — limiter on admin routes, guards on `/api/ai-chat`,
   `trust proxy: 1`.
6. **F4** — add an AI key, verify voice on desktop first.
7. **F2** — re-approve the Support agent, verify the call end-to-end.
8. Only then: build out `barber.html` / `admin.html` / `support.html`,
   migrate the admin panel into `owner.html`, and strip admin out of
   `index.html`.

Step 8 is the largest single piece of work here and depends on C3 being
done first — otherwise the "customer-only" page still serves staff and
member data to anyone who opens `/api/state`.
