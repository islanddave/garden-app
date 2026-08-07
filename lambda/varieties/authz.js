// V4-VARIETYHOUSEHOLD-001 — write scope for PUT/DELETE /api/varieties/:id.
//
// THE PROBLEM. Both writes were scoped `created_by = ${userId}`. 25 of the 408 live cultivars were
// created by NON-HUMAN principals — offline intake/repair scripts that stamped their own run id into
// created_by (measured on live prod 2026-08-07):
//     rescue-intake-longriver-20260712  15   ·   data-audit-20260706          5
//     system                             4   ·   data-correction-2026-07-07   1
// No human owns those rows, so NO human could edit them through the API — and they are precisely the
// rows carrying the bad data (a cultivar literally named "… [orphan]", another with species NULL and
// DTM 365/365, and the whole data-audit batch with no DTM at all). 24 of the 25 are attached to live
// plantings, so they render in the app while being permanently uneditable from it.
//
// WHY NOT REASSIGN created_by INSTEAD. A one-off UPDATE would unstick today's 25 rows and leave the
// NEXT intake batch equally stuck. created_by is also the audit anchor — rewriting it destroys the
// record of which run produced the row. So the predicate widens; the data stays honest.
//
// WHY householdScope ALONE IS NOT ENOUGH — the load-bearing subtlety. householdScope(userId) returns
// the ids listed in GARDEN_HOUSEHOLD_IDS when the caller is one of them, else [userId]. Those ids are
// Clerk subs (`user_*`). The non-human principals are NOT household members and never will be, so a
// naive swap of `= ${userId}` for `= ANY(householdScope(userId))` still refuses all 25 rows — it
// fixes nothing. A SECOND, ADDITIVE arm is required for the managed principals.
//
// WHY THAT ARM MUST BE GATED. An ungated `OR created_by LIKE ANY(patterns)` arm would let ANY
// authenticated Clerk user on the internet edit those 25 rows, because householdScope hands a
// stranger [their-own-id] and the arm would not care. So the arm is handed to the SQL only when the
// caller is a proven household member, and handed as an EMPTY array otherwise.
//
// THE MEMBERSHIP TEST. `household.length > 1` is exactly "GARDEN_HOUSEHOLD_IDS lists more than one id
// AND the caller is one of them" — householdScope only ever returns the multi-id array on a member
// match, and returns the 1-element [userId] for a non-member, an unset env, and an empty env alike.
// It is derived from the existing helper's return value rather than re-parsing the env, so there is
// no second copy of the membership rule to drift. Its one imprecision is fail-CLOSED: a
// single-id household cannot be told apart from a stranger, so it gets no managed arm. Prod lists
// two ids, so this is not a live limitation.
//
// SCOPE. This governs the varieties write path only. It does not widen householdScope, which is
// shared byte-identically by 16 other Lambdas.
export const MANAGED_PRINCIPAL_PATTERNS = [
  'system',
  'rescue-intake-%',
  'data-audit-%',
  'data-correction-%',
];

// Prefixes, not the 4 literal ids, so the next intake batch (`rescue-intake-<site>-<date>`) is
// editable on arrival instead of re-filing this same bug. Safe against matching a human: a Clerk sub
// is `user_<base58>` and can never take one of these prefixes, and created_by on the POST path is
// always the JWT sub — no request can steer a row into the managed set. Verified on live prod: 0 of
// the `user_%` created_by values match these patterns, and a member's editable set is exactly the
// 408 live cultivars (383 household + 25 managed) while a non-member's is 0.
//
// Returns the patterns to hand the SQL `LIKE ANY(...)` arm: the real list for a household member,
// an EMPTY list for everyone else. Postgres evaluates `x LIKE ANY(ARRAY[]::text[])` to FALSE (not
// NULL — confirmed against live prod), so the empty case collapses the arm rather than opening it.
export function managedPrincipalPatterns(household) {
  return Array.isArray(household) && household.length > 1 ? MANAGED_PRINCIPAL_PATTERNS : [];
}
