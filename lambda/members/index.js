// /api/members: PLANT-ASSIGN-001 household roster read. GET-only, Clerk-authed. Lists the CALLER'S
// HOUSEHOLD's users so the caretaker AssigneePicker can offer Dave/Jen. Clerk is the identity source of
// truth (there is no DB roster table; profiles holds only some users), so there is NO Neon read. Mirrors the
// lambda/findings auth/secrets seam. A normal Fn-URL lambda (deploy-lambda.yml gives it a Function URL + CORS).
// Roster = Clerk list ∩ householdScope(caller) (0A.6: it once returned EVERY Clerk user, email included, to
// ANY authenticated caller). Email is dropped from the response; displayName() still uses it server-side as
// a label fallback. householdScope is fail-closed: GARDEN_HOUSEHOLD_IDS unset -> [caller]. Both deploy
// workflows read-merge that env onto garden-members so the deployed roster does not collapse to the caller.
import { createClerkClient } from '@clerk/backend';
import { householdScope } from './household.js';
import { requestContext } from './request-context.js';

const SCHEMA_VERSION = 1;

// Service/bot accounts, excluded from the caretaker roster so they can't be re-picked via the UI. Identify by
// STABLE markers (system email + optional env sub list), NOT a hardcoded sub literal: the old literal was
// actually a real caretaker (Jen) in the LIVE Clerk instance and wrongly hid her (DRG-ASSIGN-FIX).
const SYSTEM_EMAILS = new Set(
  (process.env.SYSTEM_CLERK_EMAILS || 'islanddave+clerk+system@gmail.com')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const SYSTEM_SUBS = new Set(
  (process.env.SYSTEM_CLERK_SUB || 'user_3D7uvqWjyxdq3jgVwTZs0mKT7Xd')
    .split(',').map((s) => s.trim()).filter(Boolean));
function isSystemUser(u) {
  if (SYSTEM_SUBS.has(u.id)) return true;
  const email = (u.emailAddresses?.[0]?.emailAddress || '').toLowerCase();
  return SYSTEM_EMAILS.has(email);
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate.
function resp(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) };
}

// Best-effort human label from a Clerk user. Falls back through full name -> username -> email localpart -> id.
function displayName(u) {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (u.username) return u.username;
  const email = u.emailAddresses?.[0]?.emailAddress;
  if (email) return email.split('@')[0];
  return u.id;
}

export const handler = async (event) => {
  // The kit answers OPTIONS and every sign-in refusal (401, the household gate's 403) before any Clerk call. It gets
  // no neon: this Lambda has no Neon dependency (index.test.js forbids the import).
  const ctx = await requestContext(event, { resp });
  if (ctx.response) return ctx.response;
  const { secrets, userId } = ctx;

  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/members';
  if (method !== 'GET' || rawPath !== '/api/members') {
    return resp(405, { error: 'Method not allowed' });
  }

  try {
    const clerk = createClerkClient({ secretKey: secrets.CLERK_SECRET_KEY });
    const ids = householdScope(userId);
    // R1-11: ask Clerk for exactly the household's ids. A page of all users (it was the first 50) drops a
    // member who sorts past it. Guard: index.test.js "R1-11", tests/integration/members-authz.int.test.js.
    const list = await clerk.users.getUserList({ userId: ids, limit: ids.length });
    // v1 returns { data, totalCount }; tolerate an array too.
    const users = Array.isArray(list) ? list : (list?.data ?? []);
    const hh = new Set(ids); // 0A.6: roster scoped to the caller household (kept: defence in depth)
    const members = users
      .filter((u) => !isSystemUser(u))  // exclude service/bot accounts from caretaker roster (DRG-ASSIGN-FIX)
      .filter((u) => hh.has(u.id))      // 0A.6: strangers see only themselves; household sees household
      .map((u) => ({
        id: u.id,
        display_name: displayName(u),   // 0A.6: email dropped — no consumer renders it
      }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
    return resp(200, { schema_version: SCHEMA_VERSION, members });
  } catch (err) {
    console.error('members lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
