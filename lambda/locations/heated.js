// V5-LOCHEATEDUI-001 — locations.heated on the write path.
//
// `heated` (migrations/v5-locheated-001) is boolean NOT NULL DEFAULT false and has exactly one reader:
// lambda/daily-plan reads `l.heated is true as heated_resolved`, and engine.coldFor then drops the cold
// card for every planting in that location. A heated location is also covered, so frostClass's
// isCoveredDefault already excludes those plantings from the frost alert — nothing else speaks for
// them. THE DANGEROUS ERROR IS A FALSE TRUE, and both rules below exist to make one hard to write.
//
// 1. TYPE. Only a real boolean is a value. null/absent means "not sent", which is the house COALESCE
//    grammar: unchanged on PUT, and the column default (false) on POST — never a NULL, which the column
//    refuses anyway. A string "true" is refused rather than cast: covered's arm lets Postgres cast
//    whatever arrives, and a truthy string silently becoming TRUE is exactly the false TRUE above.
//
// 2. HEATED IMPLIES COVERED. The standing gate v5-locheated-001 :: post_heated_location_is_covered
//    asserts no live location is heated while `covered IS NOT TRUE`. Judged on the row AS IT WILL BE
//    WRITTEN, so a PUT that only sets covered=false on a location that is already heated is refused
//    too. `covered` can never be cleared back to NULL through the PUT (it is not on CLEARABLE_FIELDS),
//    so false is the only way that half can be broken from here.
//
// Zero imports, like ref.js, so the rule is tested behaviourally rather than as source text.

export const HEATED_TYPE_ERROR = 'heated must be true or false';
export const HEATED_NEEDS_COVER_ERROR =
  'A heated location must also be under cover. Set Rain shelter to Under cover, or untick Heated.';

export function validateHeatedType(body) {
  const v = body?.heated;
  if (v == null) return null;
  return typeof v === 'boolean' ? null : HEATED_TYPE_ERROR;
}

// `next` is { heated, covered } as the row will read after the write. Strict `=== true` on covered, so
// NULL ("not stated") fails exactly as false does — the gate's `IS NOT TRUE`, not `= false`.
export function heatedCoverError(next) {
  return next?.heated === true && next?.covered !== true ? HEATED_NEEDS_COVER_ERROR : null;
}

// PUT: the body over the current row with COALESCE semantics — null/absent leaves a column as it is.
export function nextFlagsForPut(body, current) {
  return {
    heated: body?.heated ?? current?.heated ?? false,
    covered: body?.covered ?? current?.covered ?? null,
  };
}

// POST: a new row has only the body. covered's own default is NULL ("not stated"), heated's is false.
export function nextFlagsForPost(body) {
  return {
    heated: body?.heated ?? false,
    covered: body?.covered ?? null,
  };
}
