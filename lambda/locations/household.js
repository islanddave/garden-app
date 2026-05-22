// household.js — Household Mode scope helper (V2 multi-user bridge).
// HOUSEHOLD-MODE: remove at V3-ROLES (DB-layer RLS via current_user_role() replaces this).
// Returns the set of owner Clerk IDs whose rows a request may see/modify.
//
// MEMBERSHIP-GATED: widen to the configured household ONLY when the requester is a member
// of it; otherwise return just their own id. A non-member who authenticates must NEVER see
// the household's data. Fail-closed: empty/unset/whitespace env -> [userId] (single-user).
//
// DEPLOY NOTE: each Lambda is zipped from its OWN directory (deploy-lambda.yml / deploy-staging.yml:
// `cd lambda/<fn> && zip -r ../<fn>.zip .`), so a `../household.js` import is NOT packaged and the
// handler 502s at module load. Therefore an IDENTICAL copy of this file lives in each in-scope
// Lambda dir and is imported as `./household.js`. This file (lambda/household.js) is the canonical
// source + unit-test target; copies are kept byte-identical by lambda/household-copies-sync.test.js.
export function householdScope(userId) {
  const raw = (process.env.GARDEN_HOUSEHOLD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return raw.includes(userId) ? raw : [userId];
}
export function householdActive() {
  const raw = (process.env.GARDEN_HOUSEHOLD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return raw.length > 1;
}
