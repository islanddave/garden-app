// todayMutantsV2.mjs — the defect catalogue for gate:today-shape:v2's mutation proof (V5-TODAYREDESIGN-001).
//
// A DATA FILE, read by tests/harness/vite.harness.v2mutant.mjs (applies one mutant, in memory) and
// scripts/mutate-today-shape-v2.mjs (enumerates, runs the gate per mutant, counts killer families). A NEW file:
// tests/harness/todayMutants.mjs (v1) belongs to MAIN's lane-warmed and is not touched; the two retire together
// at S8c.
//
// SHAPE: name → { armedAt, file, find, replace, defect, killers, kind }
//   armedAt   the slice that writes the source this mutant edits. Until it lands, `file`/`find` are null and the
//             mutant is PENDING: listed and counted by the runner, never scored. The slice that lands fills in
//             the exact source text in the same commit (patterns are EXACT source text; the plugin THROWS on a
//             miss — a mutant that silently fails to apply would score SURVIVED, the one result that lies).
//   killers   the §9.1 families expected to kill it (≥ 2 independent ones once all are armed).
//   kind      'chrome' (served mutated, the gate must red) or 'unit-table' (§13 Simplify 3: trigger-predicate
//             mutants became cells of the triggers.js unit table, today-v2-contract.mjs TRIGGER_CELLS).
//
// ARMED AT S0: one canary on the seam S0 itself built. Everything that edits V2 source waits for that source.
const P = (armedAt, killers, defect) => ({ armedAt, file: null, find: null, replace: null, killers, defect, kind: 'chrome' })
const U = (armedAt, defect) => ({ armedAt, file: null, find: null, replace: null, killers: ['unit-table'], defect, kind: 'unit-table' })

export const MUTANTS_V2 = {
  // ── S0: the prefs seam, dark at the client — no reader (PrefsProvider or V1's own) can issue the GET.
  prefsClientDark: {
    armedAt: 'S0', kind: 'chrome',
    file: 'src/lib/notificationPrefsClient.js',
    find: 'export async function fetchNotificationPrefs({ getToken } = {}) {\n  if (!CRITTER_BASE) return null',
    replace: 'export async function fetchNotificationPrefs({ getToken } = {}) {\n  if (CRITTER_BASE || !CRITTER_BASE) return null',
    killers: ['prefs-instrument', 'section-open-set'],
    defect: 'the prefs read never leaves the client, so every remembered open/closed and every date-scoped ack is silently ignored. At S0 only prefs-instrument is armed; section-open-set joins at S2 (the remembered states).',
  },

  // ── S2: section component, visit layer, route toggle. The panel is FacetGroupHeader's native-mode panel (the
  // section body); at S2 its only armed killer is `floors` (the open Resting body in v2-remembered carries the
  // last ink above the Sow row), so these two are UNDER-GUARDED BY SCHEDULE until visibility / region-headcount
  // arm with S3–S6.
  hideSectionBody: {
    armedAt: 'S2', kind: 'chrome',
    file: 'src/components/forms/FacetGroupHeader.jsx',
    find: '{hasPanel && <div id={panelId} style={panelStyle}>{children}</div>}',
    replace: "{hasPanel && <div id={panelId} style={{ ...panelStyle, display: 'none' }}>{children}</div>}",
    killers: ['visibility', 'region-headcount', 'floors'],
    defect: 'POSITIVE CONTROL: an open section body display:none',
  },
  clipSectionBody: {
    armedAt: 'S2', kind: 'chrome',
    file: 'src/components/forms/FacetGroupHeader.jsx',
    find: '{hasPanel && <div id={panelId} style={panelStyle}>{children}</div>}',
    replace: "{hasPanel && <div id={panelId} style={{ ...panelStyle, height: 0, overflow: 'hidden' }}>{children}</div>}",
    killers: ['visibility', 'region-headcount', 'floors'],
    defect: 'an open body height:0; overflow:hidden (ancestor clip)',
  },
  // At S2 there is no trigger predicate yet (S5), so the canary forces the one place every open state resolves:
  // the visit's effective-open. S5 re-points it at triggers.js when the predicate exists.
  openAll: {
    armedAt: 'S2', kind: 'chrome',
    file: 'src/hooks/useTodayVisit.js',
    find: "  if (!record) return false\n  const o = record.overlay?.[key]",
    replace: "  if (!record || record) return true\n  const o = record.overlay?.[key]",
    killers: ['section-open-set', 'first-screen', 'floors'],
    defect: 'real-Chrome canary (Simplify 3): every section forced open — v2-remembered-conflict\'s closed care opens, the scroll ceiling trips',
  },
  // "Never reads": the provider's boot read never settles, so data-prefs-loaded stays false (it never lies at
  // S2 — nothing else sets it), the GET is never observed, and the server's remembered open never applies.
  skipPrefsFetch: {
    armedAt: 'S2', kind: 'chrome',
    file: 'src/context/PrefsContext.jsx',
    find: '    fetchNotificationPrefs({ getToken: tokenRef.current })\n      .then(p => { if (on) { setPrefs(p); setPrefsLoaded(true) } })',
    replace: '    new Promise(() => {})\n      .then(p => { if (on) { setPrefs(p); setPrefsLoaded(true) } })',
    killers: ['prefs-instrument', 'prefs-loaded-attr', 'section-open-set'],
    defect: 'PrefsProvider never reads — no GET, data-prefs-loaded false, Layer 1\'s server half dropped',
  },

  // ── S3: glance card + jump bar (the in-view scroll-spy is cut, §13 Simplify 5, so highlightStuck is retired)
  unstickBar: P('S3', ['sticky', 'jump-landing'], 'the jump bar loses position:sticky'),
  stickyAtZero: P('S3', ['sticky', 'jump-landing'], 'the bar sticks at top:0, under TopChrome'),
  ancestorOverflow: P('S3', ['sticky', 'visibility'], 'an ancestor gains overflow:hidden and silently disables sticky'),
  chipRowNoScroll: P('S3', ['chip-census', 'first-screen'], 'the chip strip overflow:visible — chips past the edge are unreachable'),
  truncateVerdict: P('S3', ['verdict-truncation', 'first-screen'], 'the verdict ellipsis is restored'),
  jumpNoOffset: P('S3', ['jump-landing', 'sticky'], 'a jump lands the header under the bar'),
  noScrollPadding: P('S3', ['jump-landing', 'sticky'], 'html scroll-padding-top not set while V2 is mounted'),
  noFocusAfterJump: P('S3', ['jump-landing', 'first-screen'], 'focus does not move to the section header after a jump'),
  dropCueInCard: P('S3', ['region-headcount', 'first-screen'], 'the weather cue line leaves the closed glance card'),
  dropFrostInCard: P('S3', ['region-headcount', 'first-screen'], 'the frost line leaves the closed glance card'),

  // ── S4: needs care
  clipSpotPanel: P('S4', ['visibility', 'region-headcount'], 'the Bag Area panel clipped'),
  hideInsteadOfUnmount: P('S4', ['collapsed-mounted', 'visibility'], 'closed bodies mounted `hidden` instead of unmounted'),
  wrongHeaderCount: P('S4', ['header-text', 'chip-census'], 'the header counts capped rows, not all rows'),
  reorderSections: P('S4', ['section-open-set', 'first-screen'], 'a CSS order: puts sections out of the fixed order'),
  spotReorderOnLog: P('S4', ['section-open-set', 'region-headcount'], 'spots re-rank after a log mid-visit'),
  dropHeaderSummary: P('S4', ['header-text', 'region-headcount'], 'the one-line section summary is removed'),
  exceptionsCapped: P('S4', ['region-headcount', 'header-text'], 'the exceptions list is capped'),
  uncapCohort: P('S4', ['region-headcount', 'first-screen'], 'the cohort renders uncapped'),
  dropExceptions: P('S4', ['region-headcount', 'header-text'], 'the exceptions are gone'),
  bulkIgnoresBedWait: P('S4', ['header-text', 'region-headcount'], 'a spot Water all includes beds on bed-wait'),
  groupBulkIgnoresBedWait: P('S4', ['header-text', 'region-headcount'], 'MF3: the group Water all includes beds on bed-wait'),
  groupUndoPartial: P('S4', ['header-text', 'region-headcount'], 'MF3: the group Undo does not delete exactly the created ids'),
  dropNotToday: P('S4', ['header-text', 'region-headcount'], 'the spot Not today control is missing'),
  doneLineVanishes: P('S4', ['back-restore', 'region-headcount'], 'the done line is not held for the visit'),
  extraCardFingerprint: P('S4', ['visual-census', 'region-headcount'], 'a fifth (r12) card treatment is added'),

  // ── S5: protect tonight + heads-up
  openNone: P('S5', ['section-open-set', 'first-screen'], 'real-Chrome canary (Simplify 3): the trigger predicate forced false — nothing auto-opens'),
  coldRowsInNeedsCare: P('S5', ['region-headcount', 'header-text'], 'cold rows render in two homes'),
  pickLinkMissing: P('S5', ['region-headcount', 'first-screen'], 'the "Pick what\'s ripe first" link is gone'),

  // ── S6: harvest, put-up, resting, household, sow link; a moved region deleted inside its owner, ×10
  ...Object.fromEntries(['watchBand', 'compose', 'putUp', 'dormant', 'dryList', 'feedSuppressed', 'rainNote', 'basisStamp', 'droughtLine', 'leafLine']
    .map((r) => [`dropRegionInOwner_${r}`, P('S6', ['region-headcount', 'first-screen'], `the moved region '${r}' is deleted inside its V2 owner`)])),
  sowLinesDuringFreeze: P('S6', ['header-text', 'region-headcount'], 'dated sow lines render during the 2027 freeze'),

  // ── §13 Simplify 3: trigger-predicate mutants → cells of the triggers.js unit table (S5 writes the test)
  ignoreRemembered: U('S5', 'Layer 1 dropped — a same-day ack no longer holds'),
  rememberedBeatsUrgent: U('S5', 'a remembered close beats a new, higher trigger'),
  staleAutoOpens: U('S5', 'a stale plan triggers auto-open'),
  chillOpensEveryNight: U('S5', 'chill ignores first-seen and opens every night'),
  headsupAlwaysOpen: U('S5', 'Heads-up opens on every day of the window'),
  householdAlwaysOpen: U('S6', 'a household section auto-opens'),
  glanceOpenByDefault: U('S3', 'the glance card opens by default'),
}

// Retired, with the reason, so the catalogue never loses a name silently.
export const RETIRED_V2 = {
  highlightStuck: '§13 Simplify 5 cut the in-view scroll-spy (no lit chip state), so there is no highlight to stick',
}
