// household.js — Household Mode scope helper (V2 multi-user bridge).
// HOUSEHOLD-MODE: remove at V3-ROLES (DB-layer RLS via current_user_role() replaces this).
// Returns the set of owner Clerk IDs whose rows a request may see/modify.
// Fail-closed: empty/unset/whitespace env -> just the requesting user (single-user behavior).
export function householdScope(userId) {
  const raw = (process.env.GARDEN_HOUSEHOLD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return raw.length ? raw : [userId];
}
export function householdActive() {
  const raw = (process.env.GARDEN_HOUSEHOLD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return raw.length > 1;
}
