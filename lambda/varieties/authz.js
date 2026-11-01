// Write scope for PUT/DELETE /api/varieties/:id (V4-VARIETYHOUSEHOLD-001).
//
// THE PROBLEM. Both writes were scoped `created_by = ${userId}`, but some live cultivars were created by
// NON-HUMAN principals (offline intake/repair scripts that stamped their own run id into created_by).
// No human owns those rows, so no human could edit them through the API, and they are the rows carrying
// the bad data.
//
// WHY NOT REASSIGN created_by. A one-off UPDATE would unstick today's rows and leave the NEXT intake
// batch stuck. created_by is also the audit anchor; rewriting it destroys the record of which run
// produced the row. So the predicate widens and the data stays honest.
//
// WHY householdScope ALONE IS NOT ENOUGH. householdScope(userId) returns the ids in GARDEN_HOUSEHOLD_IDS
// when the caller is one of them, else [userId]. Those are Clerk subs (`user_*`); the non-human
// principals are not household members, so swapping `= ${userId}` for `= ANY(householdScope(userId))`
// still refuses them. A SECOND, ADDITIVE arm is required for the managed principals.
//
// WHY THAT ARM MUST BE GATED. An ungated `OR created_by LIKE ANY(patterns)` arm would let ANY
// authenticated Clerk user edit those rows, because householdScope hands a stranger [their-own-id] and
// the arm would not care. So the patterns are handed to the SQL only when the caller is a proven
// household member, and as an EMPTY array otherwise.
//
// THE MEMBERSHIP TEST. `household.length > 1` is exactly "GARDEN_HOUSEHOLD_IDS lists more than one id AND
// the caller is one of them": householdScope returns the multi-id array only on a member match, and the
// 1-element [userId] for a non-member, an unset env and an empty env alike. It is derived from the
// helper's return value so there is no second copy of the membership rule to drift. Its one imprecision
// is fail-CLOSED: a single-id household cannot be told from a stranger, so it gets no managed arm.
//
// SCOPE. This governs the varieties write path only. It does not widen householdScope, which is shared
// byte-identically by other Lambdas.
export const MANAGED_PRINCIPAL_PATTERNS = [
  'system',
  'rescue-intake-%',
  'data-audit-%',
  'data-correction-%',
];

// Prefixes, not literal ids, so the next intake batch (`rescue-intake-<site>-<date>`) is editable on
// arrival. Safe against matching a human: a Clerk sub is `user_<base58>` and can never take one of these
// prefixes, and created_by on the POST path is always the JWT sub, so no request can steer a row into the
// managed set.
//
// Returns the patterns to hand the SQL `LIKE ANY(...)` arm: the real list for a household member, an
// EMPTY list for everyone else. `x LIKE ANY(ARRAY[]::text[])` is FALSE (not NULL) in Postgres, so the
// empty case collapses the arm rather than opening it.
export function managedPrincipalPatterns(household) {
  return Array.isArray(household) && household.length > 1 ? MANAGED_PRINCIPAL_PATTERNS : [];
}

// Postgres `text LIKE pattern` (default escape) in JS (BUG-VARIETYEDITHOUSEHOLDMIRROR-001).
//
// WHY A REAL LIKE AND NOT startsWith. Today's patterns are plain text plus at most one trailing `%`, for
// which prefix/equality is exact. But canEditVariety answers for whatever managedPrincipalPatterns
// returns, and a pattern added later may use `_` (one-character wildcard), a mid-pattern `%`, or `\`
// (escapes the next character). A prefix check would answer TRUE for a value Postgres refuses, the one
// direction can_edit must never be wrong in.
//
// Semantics (Postgres manual 9.7.1, like_match.c):
//   * the pattern covers the WHOLE string; `%` = zero or more characters, line breaks included;
//   * `_` = exactly one character (a code point, hence Array.from and the `u` flag);
//   * `\x` = the literal character x, for any x;
//   * case-sensitive, and nothing else is special.
// A pattern ENDING in a lone `\` makes Postgres raise or answer false; either way no row is admitted, so
// this returns false.
//
// NOT MODELED: collation. This is code-point equality. Under a case-insensitive collation Postgres could
// match where this does not, which is the safe direction.
export function sqlLike(text, pattern) {
  if (typeof text !== 'string' || typeof pattern !== 'string') return false;
  const chars = Array.from(pattern);
  let source = '';
  for (let i = 0; i < chars.length; i += 1) {
    let c = chars[i];
    if (c === '%') { source += '[\\s\\S]*'; continue; }
    if (c === '_') { source += '[\\s\\S]'; continue; }
    if (c === '\\') {
      i += 1;
      if (i >= chars.length) return false;
      c = chars[i];
    }
    source += c.replace(/[\\^$.*+?()[\]{}|/]/, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u').test(text);
}

// Would PUT/DELETE /api/varieties/:id take this row? (BUG-VARIETYEDITHOUSEHOLDMIRROR-001)
//
// VarietyEditor cannot see GARDEN_HOUSEHOLD_IDS (Lambda-side config), so it used to gray out rows the
// server would have saved. GET /api/varieties/:id now carries this answer as `can_edit` and the form
// trusts it over its own guess.
//
// THE CONTRACT. This is the row predicate both writes carry, arm for arm:
//     created_by = ANY(${household})                      ->  household.includes(createdBy)
//     OR created_by LIKE ANY(${managedPatterns}::text[])  ->  managedPrincipalPatterns(household).some(sqlLike)
// `household` must be the handler's own householdScope(userId), the value the SQL binds, and the patterns
// come from the same helper index.js derives `managedPatterns` from, so there is one membership rule.
// The writes' other terms (`id = ...`, `deleted_at IS NULL`) are the by-id read's own WHERE.
// It must NEVER answer true where the PUT would refuse: that is a form that opens, takes the typing, and
// loses it. Change a write predicate and this changes with it, in the same commit; authz-household.test.js
// pins the two together and can-edit-route.test.js runs them side by side.
//
// It does not speak for validation, the rate limit or the breeding pairing rule (refusals about the
// BODY). This is only "is the row yours to edit".
//
// Refusals above the two arms:
//   * a missing/non-string created_by: SQL NULL makes both arms NULL, and NULL admits no row;
//   * an EMPTY created_by, the one place this is stricter than the SQL ('' = ANY(ARRAY['']) is TRUE). The
//     handler 401s an empty subject before householdScope runs, so [''] is never bound; same
//     fail-closed stance as canEditSource's `userId !== ''`.
export function canEditVariety(household, createdBy) {
  if (!Array.isArray(household)) return false;
  if (typeof createdBy !== 'string' || createdBy === '') return false;
  return household.includes(createdBy)
    || managedPrincipalPatterns(household).some((p) => sqlLike(createdBy, p));
}

// Who may PATCH /api/varieties/sources/:id (V5-SOURCECONTACT-001).
//
// public.source is a SHARED catalogue (globally readable, RLS off, no ownership trigger): created_by
// records who first typed the row, not who owns the place. So a proven household member may edit ANY
// live source, including ones intake/backfill principals created, which no human could otherwise
// correct. Everyone else may edit only rows they created themselves, the only thing a stranger holding a
// valid Clerk token can reach.
//
// Same membership test as managedPrincipalPatterns (household.length > 1), fail-closed for a single-id
// household.
export function canEditSource(household, userId, createdBy) {
  if (Array.isArray(household) && household.length > 1 && household.includes(userId)) return true;
  return typeof userId === 'string' && userId !== '' && createdBy === userId;
}
