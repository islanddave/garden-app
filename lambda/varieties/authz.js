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

// BUG-VARIETYEDITHOUSEHOLDMIRROR-001 — Postgres `text LIKE pattern`, default escape, in JS.
//
// WHY A REAL LIKE AND NOT startsWith. Today's four patterns are plain text plus at most one trailing
// `%`, for which prefix/equality is exact. But canEditVariety below answers for whatever
// managedPrincipalPatterns returns, and a pattern the next lane adds may not keep that shape: `_` is
// a one-character wildcard, `%` may sit mid-pattern, and `\` escapes the character after it. A
// prefix check reads `data\_fix-%` as the literal text `data\_fix-`, so it would answer TRUE for a
// value Postgres refuses — the one direction can_edit must never be wrong in.
//
// Semantics, from the manual (9.7.1) and src/backend/utils/adt/like_match.c:
//   · the pattern covers the WHOLE string;  `%` = zero or more characters, line breaks included;
//   · `_` = exactly one character (a code point — hence Array.from and the `u` flag, so an astral
//     character is one, as it is in a UTF-8 database);
//   · `\x` = the literal character x, for any x (`\%`, `\_`, `\\`, and equally `\a`);
//   · case-sensitive, and nothing else is special.
// A pattern ENDING in a lone `\` makes Postgres raise ("LIKE pattern must not end with escape
// character") once the match reaches it, and answer false when it does not. Either way the
// statement admits no row, so this returns false.
//
// NOT MODELED: collation. This is code-point equality, which is what LIKE and `=` are on a text
// column under a deterministic collation. Under a case-insensitive one Postgres could match where
// this does not — the safe direction (a read-only form over a row the PUT would take).
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

// BUG-VARIETYEDITHOUSEHOLDMIRROR-001 — would PUT/DELETE /api/varieties/:id take this row?
//
// THE PROBLEM. VarietyEditor grayed the form out unless created_by was the caller's own id (or a
// managed principal), because GARDEN_HOUSEHOLD_IDS is Lambda-side config the client cannot see. The
// PUT accepts the whole household, so the second member saw 472 of 497 live cultivars read-only
// (2026-09-23) that the server would have saved. GET /api/varieties/:id now carries this answer as
// `can_edit`, and the form trusts it over its own guess.
//
// THE CONTRACT. This is the row predicate both writes carry, arm for arm:
//     created_by = ANY(${household})                   ->  household.includes(createdBy)
//     OR created_by LIKE ANY(${managedPatterns}::text[])  ->  managedPrincipalPatterns(household).some(sqlLike)
// `household` must be the handler's own householdScope(userId) — the value the SQL binds — and the
// patterns come from the same helper index.js derives `managedPatterns` from, so there is one
// membership rule, not two. The writes' other two terms (`id = …`, `deleted_at IS NULL`) are the
// by-id read's own WHERE, so a row that reached this function already satisfies them.
// It must NEVER answer true where the PUT would refuse: that is a form that opens, takes the
// typing, and loses it. Change a write predicate and this changes with it, in the same commit;
// authz-household.test.js pins the two together and can-edit-route.test.js runs them side by side.
//
// What it does not speak for: validation, the rate limit, the breeding pairing rule — refusals about
// the BODY, which the form reports in its error banner. This is only "is the row yours to edit".
//
// Refusals above the two arms:
//   · a missing/non-string created_by — SQL NULL makes both arms NULL, and NULL admits no row;
//   · an EMPTY created_by — the one place this is stricter than the SQL text ('' = ANY(ARRAY[''])
//     is TRUE). The handler 401s an empty subject before householdScope runs, so [''] is never
//     bound; same fail-closed stance as canEditSource's `userId !== ''`.
export function canEditVariety(household, createdBy) {
  if (!Array.isArray(household)) return false;
  if (typeof createdBy !== 'string' || createdBy === '') return false;
  return household.includes(createdBy)
    || managedPrincipalPatterns(household).some((p) => sqlLike(createdBy, p));
}

// V5-SOURCECONTACT-001 — who may PATCH /api/varieties/sources/:id.
//
// public.source is a SHARED catalogue (globally readable, RLS off, no ownership trigger — see
// v5-sourceentity-001's header): created_by records who first typed the row, not who owns the place.
// So a proven household member may edit ANY live source, including the ones intake/backfill
// principals created ('system' and friends), which no human could otherwise correct. Everyone else
// may edit only rows they created themselves — the pre-household owner-only behaviour, and the only
// thing a stranger holding a valid Clerk token can reach.
//
// Same membership test as managedPrincipalPatterns (household.length > 1), for the same reason:
// derived from householdScope's return value, fail-closed for a single-id household.
export function canEditSource(household, userId, createdBy) {
  if (Array.isArray(household) && household.length > 1 && household.includes(userId)) return true;
  return typeof userId === 'string' && userId !== '' && createdBy === userId;
}
