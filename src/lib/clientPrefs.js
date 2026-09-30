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
import { SHOW_OTHERS_KEY } from './householdView.js'

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
  // V4-HANDEDNESSCONTROLS-001 (BD-054) — handedness.js. The strongest case in this list for being
  // here: every other key leaks a PRESENTATION choice, this one leaks which side of a two-control
  // row the DESTRUCTIVE control sits on. Left behind, the second person to sign in on a shared
  // phone inherits the other's hand, and "Not yet" — a 10-20 day snooze — lands under their thumb
  // while the harmless control sits out of reach. That is the exact harm the setting exists to
  // remove, delivered to the wrong person.
  //
  // ⚠️ INTERIM COST, ACCEPTED KNOWINGLY: user_notification_prefs.handedness is authored and NOT yet
  // applied (migrations/v4-handednesscontrols-001), so until it lands there is no server copy to
  // re-adopt and a sign-out really does lose the choice. Re-picking it is one tap; inheriting the
  // wrong hand silently is not recoverable by the person it happens to, because nothing on screen
  // says the layout was decided by someone else.
  'ui.handedness',
  // V5-NAVCUSTOM-001 — NavPrefsContext's launch caches of the per-person tab bar and More pins
  // (user_notification_prefs.bar_layout / more_pins). Read SYNCHRONOUSLY for the first paint, so
  // left behind they would draw the previous person's bar and pins for the next one — and, since
  // D4 made the bar personal, that is exactly the shift Jen was promised she would never see.
  // Literal strings rather than an import: NavPrefsContext imports AuthContext, which imports this
  // file, so importing the constants here would close a cycle. clientPrefs.test.jsx pins that
  // NavPrefsContext's exported key names are all listed here.
  'nav.barLayout.v1',
  'nav.morePins.v1',
  'nav.morePins.pending.v1',
  // V5-TODAYREDESIGN-001 S2 — the Debug & smoke "New Today (preview) on this phone" switch (todayV2Flag.js).
  // A device choice, but a PERSON's choice on a shared phone: left behind, the next person to sign in
  // lands on the previous person's preview page. Plan-v2 §6.10.
  'garden.todayV2',
  // V5-TODAYREDESIGN-001 (integration 2, 2026-09-29; the orchestrator's call on S6's decision 2) — the household view
  // switch, SHOW_OTHERS_KEY (lib/householdView.js): per-DEVICE and never scrubbed before, so on a shared
  // phone the next person to sign in inherited the last person's choice and could be shown the other's care — V1's
  // pill sets it and the redesigned Today reads the same switch (SF6). Cleared like garden.todayV2, consistent with
  // SF11: after a sign-out the household view starts OFF, on V1 and V2 alike. By import, not a literal:
  // householdView.js is the one file that spells the key (householdView.test.js pins that) and imports nothing,
  // so there is no cycle.
  SHOW_OTHERS_KEY,
]

export const CLIENT_PREF_KEY_PREFIXES = [
  'lastHarvestUnit:',   // EventNew.jsx — per-crop harvest-unit memory, one key per crop_type_slug
  // V4-TODAYLOC-002 — CareNeeded suppress-for-today, one key per date ('today-skipped:YYYY-MM-DD').
  // A prefix rather than an exact key because the date is in the name and old days accumulate.
  // Carrying one person's skips into the other's session would HIDE care rows from them, which is
  // the most consequential of the three — a plant goes unwatered and nothing on screen says why.
  'today-skipped:',
  // BUG-TODAYSKIPNOUNDO-001 — the skip set's companion: keys this device UN-skipped today
  // ('today-unskipped:YYYY-MM-DD'), which CareNeeded's mount merge refuses to re-add from the server.
  // Left behind, the next person to sign in has THEIR own server skips of those rows ignored, so the
  // rows show for them. It can only un-hide a row, never hide one — but it is one person's decision
  // applied to the other, which is the whole class this file exists to close. Same prefix shape, same
  // dated accumulation.
  'today-unskipped:',
  // V5-TODAYREDESIGN-001 (plan-v2 §2.1, §3) — the redesigned Today's localStorage families, all keyed by
  // user already, cleared anyway because sign-out ends one person's use of the device:
  //   'today-sections:<user>' — the remembered open/closed mirror (useTodaySections.js, S2);
  //   'today-seen:<user>'     — the chill first-seen memory (S5). Listed at S2 so the parallel slices that
  //                             write the V2 families never contend over this list; the census in
  //                             clientPrefs.test.jsx reds a V2 family written but not listed.
  'today-sections:',
  'today-seen:',
]

// sessionStorage families, walked separately (the list above is localStorage's).
// BUG-TODAYBACKRESORT-001 — the Today care list's visit layout ('today-visit:<user>:<plan_date>:<list>',
// components/today/visitLayout.js): the section order and open sections a list held, for Back. Keyed by
// user already, so another person never READS it; cleared anyway, because sign-out ends the visit and a
// tab outlives a sign-out. A literal, like the rest of this file; clientPrefsSession.test.jsx pins it
// against visitLayout's own prefix.
export const CLIENT_SESSION_KEY_PREFIXES = [
  'today-visit:',
  // V5-TODAYREDESIGN-001 (plan-v2 §2.1 Layer 2, "this tab session") — the redesigned Today's day-scoped
  // tab families: 'today-filters:<user>' (the task / spot chip selection, S4) and
  // 'today-logged:<user>:<plan_date>' (rows logged today, the double-log guard under a seeded remount, S4).
  // Listed at S2 for the same reason as the localStorage pair above; the slice that writes one in
  // localStorage instead moves its entry across in the same commit.
  'today-filters:',
  'today-logged:',
]

function removePrefixed(storage, prefixes) {
  // Snapshot the key list BEFORE removing: Storage.key(i) re-indexes on every removal, so
  // deleting while walking forward skips entries.
  const matched = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key && prefixes.some(p => key.startsWith(p))) matched.push(key)
  }
  for (const key of matched) storage.removeItem(key)
}

// try/catch per the house convention (cropLogLedger.readStore, EventNew.readLastHarvestUnit): an
// unavailable or throwing localStorage degrades to "prefs not cleared", never to an error on the
// sign-out path. Losing the sign-out over a storage quirk would be strictly worse than the leak.
// Each store in its own try: a throwing one must not keep the other from being cleared.
export function clearClientPrefs() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      for (const key of CLIENT_PREF_KEYS) localStorage.removeItem(key)
      removePrefixed(localStorage, CLIENT_PREF_KEY_PREFIXES)
    }
  } catch { /* unavailable/denied — ranking and unit prefills simply persist */ }
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage) removePrefixed(sessionStorage, CLIENT_SESSION_KEY_PREFIXES)
  } catch { /* unavailable/denied — the visit layout simply persists until the tab closes */ }
}
