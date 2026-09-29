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

  // ── S4: needs care (patterns filled by S4, 2026-09-29; exact source text — the plugin throws on a miss)
  clipSpotPanel: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotRow.jsx", find: "{open && <div id={panelId}>{children}</div>}", replace: "{open && <div id={panelId} style={{ height: 0, overflow: 'hidden' }}>{children}</div>}", killers: ["interaction", "visibility"], defect: "the Bag Area panel clipped (height 0, overflow hidden) \u2014 mounted, counted, unseen" },
  hideInsteadOfUnmount: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotRow.jsx", find: "{open && <div id={panelId}>{children}</div>}", replace: "<div id={panelId} hidden={!open}>{children}</div>", killers: ["collapsed-mounted", "visibility"], defect: "closed spot bodies mounted `hidden` instead of unmounted" },
  wrongHeaderCount: { armedAt: "S4", kind: 'chrome', file: "src/pages/TodayV2.jsx", find: "      count: care.length || null,\n", replace: "      count: Math.min(care.length, 20) || null,\n", killers: ["header-text", "count-invariant"], defect: "the Needs care header counts capped rows (20), not all rows" },
  reorderSections: { armedAt: ["S4", "S5"], kind: 'chrome', file: "src/pages/TodayV2.jsx", find: "style={key === 'care' ? careGap : undefined}", replace: "style={key === 'care' ? { ...careGap, order: 9 } : undefined}", killers: ["section-open-set", "first-screen"], defect: "a CSS order: puts Needs care after Resting. S4 re-scheduled it to S4+S5: at S4 the page holds two sections and one instrument for their order (section-open-set orderOf, which reds); the first-screen killer needs Protect (S5) above Needs care" },
  spotReorderOnLog: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/NeedsCare.jsx", find: "  const heldOrder = c?.order\n", replace: "  const heldOrder = null\n", killers: ["spot-order", "group-water-all"], defect: "spots re-rank from the live rows after a log mid-visit (the held order dropped) \u2014 a done spot loses its slot" },
  dropHeaderSummary: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/TodaySection.jsx", find: "        summary={summary}\n", replace: "        summary={null}\n", killers: ["header-text", "floors"], defect: "the one-line section summary is removed" },
  exceptionsCapped: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotBody.jsx", find: "{exRows.map((r) => place(r, 'care-exceptions-row', exceptionReason(r)))}", replace: "{exRows.slice(0, 5).map((r) => place(r, 'care-exceptions-row', exceptionReason(r)))}", killers: ["interaction", "count-invariant"], defect: "the exceptions list is capped (5 of 8 shown under \"\u00b7 8\")" },
  uncapCohort: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotBody.jsx", find: "  const shown = cohortAll ? cohort.length : Math.min(COHORT_CAP, cohort.length)\n", replace: "  const shown = cohort.length\n", killers: ["interaction", "region-headcount"], defect: "the disclosed cohort renders uncapped (89 rows, no Show more / cap note)" },
  dropExceptions: { armedAt: "S4", kind: 'chrome', file: "src/lib/todayV2/spots.js", find: "  if (rows.length <= SMALL_SPOT_MAX) return null\n", replace: "  if (rows.length) return null\n", killers: ["interaction", "region-headcount"], defect: "the exceptions / cohort split is gone \u2014 every spot lists every row" },
  bulkIgnoresBedWait: { armedAt: "S4", kind: 'chrome', file: "src/lib/todayV2/spots.js", find: "  const wait = !!bedWait && (group == null || group === OUTSIDE)\n", replace: "  const wait = false\n", killers: ["header-text", "group-water-all"], defect: "a spot Water all (and so its group) includes beds on bed-wait" },
  groupBulkIgnoresBedWait: { armedAt: "S4", kind: 'chrome', file: "src/lib/todayV2/spots.js", find: "for (const s of list) { if (s.candidates.size) spotsWithWater++; for (const k of s.candidates) keysAll.add(k) }", replace: "for (const s of list) { if (s.candidates.size) spotsWithWater++; for (const r of s.rows) if (r.eventType === 'watering') keysAll.add(r.key) }", killers: ["header-text", "group-water-all"], defect: "MF3: the group Water all includes beds on bed-wait (the spots' own buttons still hold them back)" },
  groupUndoPartial: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/NeedsCare.jsx", find: "      const { undone, failed: stuck } = await actions.undoMany(b.created, { concurrency: 4 })\n", replace: "      const { undone, failed: stuck } = await actions.undoMany(b.created.slice(1), { concurrency: 4 })\n", killers: ["group-water-all", "header-text"], defect: "MF3: the group Undo does not delete exactly the created ids (one is left logged)" },
  dropNotToday: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotRow.jsx", find: "          <button type=\"button\" onClick={disabled || busy ? undefined : onNotToday} aria-disabled={disabled || busy ? 'true' : undefined} aria-label={'Not today: ' + spot.name} style={outlineBtn}>Not today</button>\n", replace: "", killers: ["header-text", "floors"], defect: "the spot Not today control is missing" },
  doneLineVanishes: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotRow.jsx", find: "export function SpotDoneLine({ spotKey, name, text, onUndo, undoBusy, undoLabel, note }) {\n  return (", replace: "export function SpotDoneLine({ spotKey, name, text, onUndo, undoBusy, undoLabel, note }) {\n  return null && (", killers: ["group-water-all", "back-restore"], defect: "the done line is not held for the visit (a logged spot vanishes). The second killer is the shell gate's back-restore, which this matrix does not run" },
  extraCardFingerprint: { armedAt: ["S3", "S4"], kind: 'chrome', file: "src/components/today/v2/NeedsCare.jsx", find: "<div key={gk} data-testid=\"care-group\" data-group={gk} style={{ display: 'flex', flexDirection: 'column', gap: T.space.xs }}>", replace: "<div key={gk} data-testid=\"care-group\" data-group={gk} style={{ display: 'flex', flexDirection: 'column', gap: T.space.xs, border: '1px solid #d4c9be', borderRadius: 12, background: '#ffffff' }}>", killers: ["visual-census", "region-headcount"], defect: "a fifth (r12) card treatment is added. Re-scheduled to S3+S4: visual-census is armed only with S3" },

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
