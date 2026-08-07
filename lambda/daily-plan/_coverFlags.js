// TEST-ONLY helper. Not required by any Lambda source file — the deployed handler computes these
// two flags in SQL (handler.js, the `cov` lateral) and hands them to the engine already resolved.
//
// BUG-NOLOCOUTDOOR-001 replaced the single `covered` boolean with a three-state resolved in SQL and
// split into two booleans that are DELIBERATELY NOT COMPLEMENTS:
//
//     rain_exposed_resolved  = (state IS FALSE)   -- unknown => false => never rain-credited
//     frost_covered_resolved = (state IS TRUE)    -- unknown => false => still frost-alerted
//
// Both are false for an unknown location, and that is the whole point: rain credit and frost
// alerting have OPPOSITE fail-safe directions, so no single boolean can be safe for both.
//
// Existing fixtures across nine files express coverage as `covered: true|false`, which is the
// KNOWN case and maps cleanly onto both flags. This helper does that mapping inside each fixture
// factory so ~48 individual cases keep working unchanged, while still letting any single case opt
// into the unknown state by setting the resolved flags directly.
//
// WHY THIS LIVES IN THE TEST TREE AND NOT IN engine.js: a production fallback of the shape
// `p.rain_exposed_resolved ?? !p.covered` would silently re-admit the old semantics for any caller
// that forgot the new field — which is precisely how an un-located planting became "outdoor" in the
// first place. The engine must read ONLY the resolved flags, so that a missing flag fails visibly
// in a test rather than invisibly in the garden. Compatibility belongs where the compatibility
// problem is: the fixtures.
//
// Apply AFTER any per-case spread so an explicit `covered: true` on a single case still propagates:
//     const p = { ...defaults, ...ov };  ->  const p = withCoverFlags({ ...defaults, ...ov });

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
