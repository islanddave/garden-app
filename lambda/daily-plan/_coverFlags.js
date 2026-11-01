// TEST-ONLY helper; no Lambda source requires it. The deployed handler resolves these two flags in SQL
// (the `cov` lateral in handler.js) and hands the engine the resolved values.
//
// The flags are DELIBERATELY NOT COMPLEMENTS of one three-state coverage value:
//     rain_exposed_resolved  = (state IS FALSE)   -- unknown => false => never rain-credited
//     frost_covered_resolved = (state IS TRUE)    -- unknown => false => still frost-alerted
// Rain credit and frost alerting fail safe in opposite directions, so no single boolean serves both.
//
// Fixtures express coverage as `covered: true|false` (the known case); this maps it onto both flags
// so existing cases keep working, and a case may still set the resolved flags directly for "unknown".
//
// It lives in the test tree, not engine.js, on purpose: a production fallback like
// `p.rain_exposed_resolved ?? !p.covered` would silently re-admit the old semantics for any caller that
// forgot the field. The engine reads ONLY the resolved flags, so a missing one fails visibly in a test.
//
// Apply AFTER any per-case spread so an explicit `covered` on one case still propagates:
//     const p = withCoverFlags({ ...defaults, ...ov });

const UNKNOWN_COVER = Object.freeze({ rain_exposed_resolved: false, frost_covered_resolved: false });

function withCoverFlags(p) {
  const covered = p && p.covered;
  return {
    ...p,
    rain_exposed_resolved:
      p && p.rain_exposed_resolved !== undefined ? p.rain_exposed_resolved : covered === false,
    frost_covered_resolved:
      p && p.frost_covered_resolved !== undefined ? p.frost_covered_resolved : covered === true,
  };
}

module.exports = { withCoverFlags, UNKNOWN_COVER };
