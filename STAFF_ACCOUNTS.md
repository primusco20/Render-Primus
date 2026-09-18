# Staff & owner accounts (Option 2, extended)

This started as Option 2 from the project notes: **Supabase holds login
credentials — for staff (barber/admin/support) accounts, and now the owner
too.** Members, bookings, merchant settings, and everything else about a
staff member (name, bio, photo, status, approval, position, face
descriptor) still live in `state.json`, exactly as before.

## The problem this fixes

Before this change, every staff sign-up/login lived entirely in the browser:
passwords were SHA-256'd client-side and stored in `state.json`'s
`barberAccounts` array, and **every** save to the server — including an
anonymous visitor's self-service sign-up — was authorized with the site's
single shared Admin Password (sent as `x-admin-password`, cached in
`appSettings.adminPassword`, with a hardcoded default baked into
`index.html`'s JS). Two concrete problems fell out of that:

1. **`GET /api/state` is public and unauthenticated**, and it returned the
   full `barberAccounts` array — including every staff member's username and
   password hash — to anyone who asked.
2. **Self-service sign-up depended on the client already knowing the site's
   admin password.** That worked only by accident, via a hardcoded default
   matching the server's default. The moment the owner actually changed the
   Admin Settings password (as they're supposed to), new staff sign-ups
   would silently stop reaching the server — the UI would say "success" but
   nothing would actually save.

Neither is true anymore. Staff credentials now live in Supabase Auth, which
the sign-up/login endpoints below never need the Admin Password to reach.

## What moved, what didn't

| Lives in Supabase Auth | Still lives in state.json |
|---|---|
| Email + password (hashed by Supabase) | name, username, phone, email (a copy, for display/lookup) |
| — | position, role, status, approved, active |
| — | bio, photo, faceDescriptor |
| — | supportPeerId, isLive, liveHeartbeat, liveSince |

The site owner's single Admin Password can now be paired with a real
Supabase login too — see "Owner login" below. Either credential still works
on its own.

## New server routes (see `server.js` / `supabaseAdmin.js`)

- `POST /api/staff/signup` — public (Turnstile + rate-limited, same as the
  payment forms). Creates the Supabase user *and* the `state.json` profile
  record in one request. No admin password involved.
- `PATCH /api/staff/me` — a logged-in staff member updating their own
  profile (bio/photo/status/live-call fields). Authorized by their own
  Supabase session token, not the admin password. Can only ever touch their
  own record.
- `POST /api/staff/reset-password` / `DELETE /api/staff/:id` — admin-only
  (same `x-admin-password` check as every other privileged route today).

## Env vars to set (Render dashboard)

```
SUPABASE_URL              https://YOUR-PROJECT.supabase.co
SUPABASE_SECRET_KEY       Settings > API Keys > Secret keys (sb_secret_...)
                          — older project: use the "service_role" key from
                          the Legacy API Keys tab instead, same var name.
SUPABASE_PUBLISHABLE_KEY  Settings > API Keys > Publishable key
                          (sb_publishable_...) — older project: use "anon"
                          key instead, same var name. Safe to expose; the
                          server hands it to the browser via /api/state.
```

Until all three are set, `supabaseAdmin.isConfigured()` is `false` and every
staff route responds with a clear "not set up yet" error — bookings,
payments, and members keep working normally in the meantime.

## Live-status fields can't be clobbered by a stale admin save

`isLive`, `liveHeartbeat`, `liveSince`, `ringHeartbeat`, and `lastDeclineAt`
on a `barberAccounts` entry change many times a minute while someone's on
the call console. The general `/api/state` save (used for every other admin
edit — gallery, business settings, etc.) always sends the *whole* state
blob, including whatever that browser tab's in-memory copy of
`barberAccounts` happens to be. `server.js` now always keeps the server's
own current values for those five fields on every `/api/state` save,
regardless of what the incoming save says — so an admin editing settings in
one tab can never accidentally stomp a support agent's live call state from
another tab or device.



## Owner login

The Owner Console (`owner.html`) and the main site's Admin Settings panel
now *also* accept a Supabase login, using the exact same plumbing as staff
accounts above (`supabaseAdmin.js`, `requireAdmin()` in `server.js`). There's
no self-service sign-up for this — letting anyone declare themselves owner
would defeat the point — so it's set up once via a CLI script instead:

```
node scripts/create-owner.js owner@yourshop.com "a strong password"
```

Then add that email to the `OWNER_EMAILS` env var (comma-separated if more
than one person should have full access). Signing in at `/owner.html` with
that email + password works exactly like the password did before — Face ID
still runs as the mandatory second factor, unchanged.

**The legacy shared Admin Password keeps working the whole time.** This is
additive, not a cutover: `requireAdmin()` accepts either credential, so
there's no risk of getting locked out while Supabase is being set up, and no
need to migrate on a deadline. The password is now framed in the Owner
Console's Security page as a fallback rather than the primary login, but
nothing about it actually changed — same field, same reset flow.

The main site's embedded Admin Settings panel (inside `index.html`) is
unchanged on the client side — it still only has a password field. Since
`requireAdmin()` now accepts a Supabase-authenticated owner too, extending
that panel's login UI to match is a small follow-up, not something that
needed touching here.

## Migration note

The three demo/test accounts that used to be seeded in `index.html`
(`defaultAppSettings.barberAccounts`) have been removed — they all shared
one email address (`dirksantiago@primus.com`), which Supabase won't allow
for three separate logins anyway, and they were explicitly QA stubs, not
real data. Once the env vars above are set, create real accounts through the
site's own "Barber Login" sign-up form — one email per person.

If you ever have *real* pre-migration staff accounts to carry over, they
won't have a matching Supabase user (no email required for the old
password-hash scheme) — the pragmatic path is to have each of them run the
real sign-up flow again with a proper email address, rather than a scripted
migration.

## What was deliberately left alone (for a future pass, not this one)

- `admin.html`, `barber.html`, `member.html`, and `support.html` are still
  blank scaffold pages — this change didn't build those out. It only fixed
  where staff and owner auth lives, using the existing sign-up/login UI
  already inside `index.html` / `owner.html`.
- The main site's embedded Admin Settings panel doesn't have an email field
  yet (see "Owner login" above) — it still only takes the legacy password,
  which still works fine.
