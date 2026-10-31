// Harness household default (SEC-13a). Every HTTP handler 403s a caller who is not listed in
// GARDEN_HOUSEHOLD_IDS, so a test that never names a household would be refused at the gate. When on,
// each stubbed verifyToken makes its subject a household member: of the test's own list if it is listed
// there, otherwise of a household of one ([sub]). A household of one scopes exactly as an unset list
// did before the gate (householdScope -> [sub], householdActive -> false), so ownership arms keep
// testing the row predicates, now as a member of one household against another household's rows.
// The gate's own refusals are tested with this OFF: lambda/household-isolation.test.js,
// lambda/household.test.js, lambda/shared-state/membership-gate.test.js and the integration cases that
// call setHouseholdDefault(false).
// On only under vitest: operator scripts that import these stubs (scripts/seed-recipes.mjs,
// scripts/putup-postdeploy-refile.mjs) keep the real fail-closed gate.
const KEY = 'GARDEN_HOUSEHOLD_IDS';
let enabled = Boolean(process.env.VITEST);
let explicit; // the last value a test set itself
let written; // the last value this helper wrote, so a test's own value can be told from it

function restoreExplicit() {
  if (written !== undefined && process.env[KEY] === written) {
    if (explicit === undefined) delete process.env[KEY];
    else process.env[KEY] = explicit;
  }
  written = undefined;
}

export function applyHouseholdDefault(sub) {
  if (!enabled || typeof sub !== 'string' || sub === '') return;
  const cur = process.env[KEY];
  if (written === undefined || cur !== written) explicit = cur;
  const listed = (explicit ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(sub);
  const value = listed ? explicit : sub;
  process.env[KEY] = value;
  written = value;
}

export function setHouseholdDefault(on) {
  if (!on) restoreExplicit();
  enabled = Boolean(on);
}

export function resetHouseholdDefault() {
  restoreExplicit();
  enabled = Boolean(process.env.VITEST);
}
