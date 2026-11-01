'use strict';
// Whose plantings a Space's nightly plan and rain logger may take (BUG-AUTHZLAMBDA-001). The CJS
// mirror of householdScope() in lambda/household.js: that file is ESM and its per-Lambda copies are held
// byte-identical by household-copies-sync.test.js, so this CJS Lambda restates the rule instead;
// householdScope-parity.test.js feeds both the same env and owner matrix so they cannot drift.
//
// household(Space) = the GARDEN_HOUSEHOLD_IDS list when the Space's owner (spaces.created_by) is in it,
// else just the owner. FAIL CLOSED: an unset env narrows to the owner alone, never widens.
//
// ONE DELIBERATE DIFFERENCE: a null, empty or whitespace owner gets the EMPTY set, not [owner].
// householdScope('') returns [''] and `'' = any(array[''])` is true in Postgres, so an unowned Space
// would otherwise own every row whose created_by is blank.
//
// The plantings SELECT in handler.js computes the same thing in SQL (the `hh` lateral); this module is
// what the JS side of the run reads (assignee check, unassigned owner, rain logger).

// Read exactly as lambda/household.js reads it.
function householdIds() {
  return (process.env.GARDEN_HOUSEHOLD_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const blank = (v) => v == null || String(v).trim() === '';

// householdScope(owner), with the empty set for a blank owner.
function householdOf(owner) {
  if (blank(owner)) return [];
  const raw = householdIds();
  return raw.includes(owner) ? raw : [owner];
}

// One Space's scope: its owner (null when blank), its members, and why it is degraded when it resolved
// to the owner alone. `degraded` is null for a full household and for an unowned Space (that one is
// reported as space-owner-missing instead).
function spaceScope(owner) {
  if (blank(owner)) return { owner: null, members: [], degraded: null };
  const raw = householdIds();
  const members = raw.includes(owner) ? raw : [owner];
  let degraded = null;
  if (members.length < 2) {
    degraded = raw.length === 0 ? 'env-missing' : raw.includes(owner) ? 'env-single-entry' : 'owner-not-in-household';
  }
  return { owner, members, degraded };
}

module.exports = { householdIds, householdOf, spaceScope };
