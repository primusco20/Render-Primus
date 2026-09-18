#!/usr/bin/env node
/**
 * scripts/create-owner.js — one-time setup for the shop owner's Supabase
 * login. There's no public sign-up for this (unlike staff barber/admin/
 * support accounts) — letting anyone self-declare as "owner" would defeat
 * the whole point, so this is a CLI script run by whoever manages the
 * server, using the same SUPABASE_SECRET_KEY the server itself uses.
 *
 * Usage (from the project root, with env vars available — e.g. via
 * `render shell` on the deployed service, or a local .env for testing):
 *
 *   node scripts/create-owner.js owner@yourshop.com "a strong password"
 *
 * After it succeeds:
 *   1. Add that email to the OWNER_EMAILS env var on Render (comma-separate
 *      if there's more than one owner/partner who should have full access).
 *   2. Sign in at /owner.html with that email + password — Face ID still
 *      runs as the second factor, exactly as before.
 *
 * The legacy shared Admin Password keeps working the whole time — this is
 * additive, not a cutover. See docs/STAFF_ACCOUNTS.md.
 */

const supabaseAdmin = require('../supabaseAdmin');

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node scripts/create-owner.js <email> <password>');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('Password must be at least 6 characters.');
    process.exit(1);
  }
  if (!supabaseAdmin.isConfigured()) {
    console.error('SUPABASE_URL / SUPABASE_SECRET_KEY / SUPABASE_PUBLISHABLE_KEY are not all set in this environment.');
    process.exit(1);
  }

  try {
    const user = await supabaseAdmin.createStaffAuthUser({ email, password });
    console.log(`Created Supabase login for ${user.email} (id: ${user.id}).`);
    console.log(`Now add this to OWNER_EMAILS on Render:  ${user.email}`);
  } catch (err) {
    console.error('Could not create the account:', err.message);
    process.exit(1);
  }
}

main();
