// V4-RANKCLEAR-001 — the client-side preference keys that must NOT survive a sign-out.
//
// WHY THIS EXISTS. These keys are per-DEVICE, not per-IDENTITY: nothing in their names or values is
// scoped to a user. On a shared device (this app has exactly two users) the second person to sign in
// inherits the first person's crop-chip ordering and harvest-unit prefills. Presentation only — no
// PII, no data access, nothing server-authoritative — but it is wrong, and "wrong but harmless"
// silently accumulates: `croprank.v1` (V4-CROPLISTORDER-001) is the third key to land in this shape,
// which is what turned a pre-existing convention into a thing worth fixing once, centrally.
//
// EXPLICIT ENUMERATION, NEVER localStorage.clear(). A blanket clear would take drafts, mode, lens
// state, dismissal memory and anything a future slice parks in localStorage — a much larger and
// entirely undiscussed blast radius, and the kind of change that only shows up as a user-visible
// regression weeks later. Every key removed here is listed here. Adding one is a deliberate edit,
// and clientPrefs.test.js pins the list so a silent widening fails the suite.
//
// The PREFIX entry is not scope creep. EventNew reads `lastHarvestUnit:<crop_type_slug>` FIRST and
// falls back to the bare `lastHarvestUnit` only when the per-crop key is missing (see EventNew.jsx
// readLastHarvestUnit) — clearing only the global key would leave the value that is actually read,
// producing a fix that looks done and is not. The two are one preference under two spellings, so
// they are cleared together.
export const CLIENT_PREF_KEYS = [
  'croprank.v1',        // cropLogLedger.js — crop-chip band ordering
  'logone.lastPlant',   // EventNew.jsx — last single-log planting
  'lastHarvestUnit',    // EventNew.jsx — legacy global harvest-unit memory
  // V4-USERPREFS-001 — these three are now CACHES of per-user server state
  // (user_notification_prefs), not the source of truth. They are still per-DEVICE on disk, and
  // they are read SYNCHRONOUSLY to seed first render before the prefs GET lands — which is
  // precisely the window in which the second person to sign in would see the first person's
  // answer. Scrubbing them at sign-out closes that window. Note the failure they cause is not
  // merely cosmetic: quicklog.defaultAllSelected inverts Jen's Log-Many selection (her stated
  // preference is the opposite of Dave's), so a stale cache pre-selects every planting for her.
  'quicklog.defaultAllSelected',  // ScopeChecklist.jsx — Log-Many default selection
  'garden.releasesSeenVersion',   // whatsNew.js — last-seen release version
]

export const CLIENT_PREF_KEY_PREFIXES = [
  'lastHarvestUnit:',   // EventNew.jsx — per-crop harvest-unit memory, one key per crop_type_slug
  // V4-TODAYLOC-002 — CareNeeded suppress-for-today, one key per date ('today-skipped:YYYY-MM-DD').
  // A prefix rather than an exact key because the date is in the name and old days accumulate.
  // Carrying one person's skips into the other's session would HIDE care rows from them, which is
  // the most consequential of the three — a plant goes unwatered and nothing on screen says why.
  'today-skipped:',
]

// try/catch per the house convention (cropLogLedger.readStore, EventNew.readLastHarvestUnit): an
// unavailable or throwing localStorage degrades to "prefs not cleared", never to an error on the
// sign-out path. Losing the sign-out over a storage quirk would be strictly worse than the leak.
export function clearClientPrefs() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return
    for (const key of CLIENT_PREF_KEYS) localStorage.removeItem(key)
    // Snapshot the key list BEFORE removing: Storage.key(i) re-indexes on every removal, so
    // deleting while walking forward skips entries.
    const matched = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && CLIENT_PREF_KEY_PREFIXES.some(p => key.startsWith(p))) matched.push(key)
    }
    for (const key of matched) localStorage.removeItem(key)
  } catch { /* unavailable/denied — ranking and unit prefills simply persist */ }
}
