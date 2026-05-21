// household.js — Household Mode scope helper (V2 multi-user bridge).
// HOUSEHOLD-MODE: remove at V3-ROLES (DB-layer RLS via current_user_role() replaces this).
// Returns the set of owner Clerk IDs whose rows a request may see/modify.
// Fail-closed: empty/unset/whitespace env -> just the requesting user (single-user behavior).
//
// DEPLOY NOTE: each Lambda is zipped from its OWN directory (deploy-lambda.yml / deploy-staging.yml:
// `cd lambda/<fn> && zip -r ../<fn>.zip .`), so a `../household.js` import is NOT packaged and the
// handler 502s at module load. Therefore an IDENTICAL copy of this file lives in each in-scope
// Lambda dir and is imported as `./household.js`. This file (lambda/household.js) is the canonical
// source + unit-test target; copies are kept byte-identical by lambda/household-copies-sync.test.js.
export function householdScope(userId) {
  const raw = (process.env.GARDEN_HOUSEHOLD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return raw.length ? raw : [userId];
}
export function householdActive() {
  const raw = (process.env.GARDEN_HOUSEHOLD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return raw.length > 1;
}
