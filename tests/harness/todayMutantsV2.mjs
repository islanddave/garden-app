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
  // At S2 there was no trigger predicate, so the canary forced the visit's effective-open. S5 re-pointed it, as S2
  // asked, at the predicate itself: the one evaluation at the ready point (triggers.js openAtStart) opens every
  // section on the page — a trigger for everything, so what Dave last left closed, and what nothing urgent holds, opens.
  openAll: {
    armedAt: ['S2', 'S5'], kind: 'chrome',
    file: 'src/lib/todayV2/triggers.js',
    find: '  const overlay = {}, fired = {}\n  for (const key of TRIGGER_SECTIONS) {',
    replace: "  const overlay = Object.fromEntries((present || []).map((k) => [k, 'open'])), fired = {}\n  for (const key of TRIGGER_SECTIONS) {",
    killers: ['section-open-set', 'floors'],
    defect: 'real-Chrome canary (Simplify 3): the trigger predicate forced open for every section on the page — the busy-seen / closed-today / conflict / routine / stale / past closes open, the ceilings trip',
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
  // S3 build (2026-09-29): every pattern filled from the S3 source. The four page mutants are scored at S3. The six
  // PLATFORM mutants edit S3 source but are scored with S4 (armedAt S3 + S4), the slice their killers arm with: a bar
  // can only pin, and a jump can only land under it, on a page taller than one screen, and at S3 alone no v2 state
  // is (the contract's SHELL note; S3 build report). `killers` records the families each actually reached in the S3
  // proof runs where that differs from the S0 prediction (chipRowNoScroll: no-hscroll, not first-screen, whose
  // chip-less first screen a sideways strip cannot move).
  unstickBar: {
    armedAt: ['S3', 'S4'], kind: 'chrome',
    file: 'src/components/today/v2/JumpBar.jsx',
    find: "position: keyboardUp ? 'static' : 'sticky'",
    replace: "position: keyboardUp ? 'static' : 'relative'",
    killers: ['sticky', 'jump-landing'],
    defect: 'the jump bar loses position:sticky',
  },
  stickyAtZero: {
    armedAt: ['S3', 'S4'], kind: 'chrome',
    file: 'src/components/today/v2/JumpBar.jsx',
    find: "top: `calc(${TOP_CHROME_HEIGHT_PX}px + env(safe-area-inset-top))`, zIndex: 70,",
    replace: 'top: 0, zIndex: 70,',
    killers: ['sticky', 'jump-landing'],
    defect: 'the bar sticks at top:0, under TopChrome',
  },
  ancestorOverflow: {
    armedAt: ['S3', 'S4'], kind: 'chrome',
    file: 'src/pages/TodayV2.jsx',
    find: "const frameStyle = { maxWidth: 720, margin: '0 auto', padding: '12px 16px 90px', display: 'flex', flexDirection: 'column', gap: T.space.sm }",
    replace: "const frameStyle = { maxWidth: 720, margin: '0 auto', padding: '12px 16px 90px', display: 'flex', flexDirection: 'column', gap: T.space.sm, overflow: 'hidden' }",
    killers: ['sticky', 'jump-landing'],
    defect: 'an ancestor gains overflow:hidden and silently disables sticky',
  },
  chipRowNoScroll: {
    armedAt: 'S3', kind: 'chrome',
    file: 'src/components/today/v2/JumpBar.jsx',
    find: "overflowX: 'auto', minHeight: JUMP_BAR_HEIGHT_PX,",
    replace: "overflowX: 'visible', minHeight: JUMP_BAR_HEIGHT_PX,",
    killers: ['chip-census', 'no-hscroll'],
    defect: 'the chip strip overflow:visible — chips past the edge are unreachable',
  },
  truncateVerdict: {
    armedAt: 'S3', kind: 'chrome',
    file: 'src/components/today/v2/GlanceCard.jsx',
    find: "minHeight: '2.7em', overflowWrap: 'anywhere',",
    replace: "minHeight: '2.7em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',",
    killers: ['verdict-truncation', 'first-screen'],
    defect: 'the verdict ellipsis is restored',
  },
  jumpNoOffset: {
    armedAt: ['S3', 'S4'], kind: 'chrome',
    file: 'src/pages/TodayV2.jsx',
    find: "if (typeof sec.scrollIntoView === 'function') sec.scrollIntoView({ block: 'start', behavior: reducedRef.current ? 'instant' : 'smooth' })",
    replace: "window.scrollTo({ top: sec.getBoundingClientRect().top + window.scrollY, behavior: 'instant' })",
    // Integration S3 × S4: S0 predicted the sticky hit test; a mis-landed jump leaves the bar as it was, so the
    // second killer is jump-focus (2.4.11 — the focused header wholly hidden under TopChrome and the bar).
    killers: ['jump-landing', 'jump-focus'],
    defect: 'a jump lands the header under the bar',
  },
  noScrollPadding: {
    armedAt: ['S3', 'S4'], kind: 'chrome',
    file: 'src/pages/TodayV2.jsx',
    find: '    s.scrollPaddingTop = `calc(',
    replace: '    void `calc(',
    killers: ['jump-landing', 'sticky'],
    defect: 'html scroll-padding-top not set while V2 is mounted',
  },
  noFocusAfterJump: {
    armedAt: ['S3', 'S4'], kind: 'chrome',
    file: 'src/pages/TodayV2.jsx',
    find: "if (header && typeof header.focus === 'function') header.focus({ preventScroll: true })",
    replace: 'void header',
    // Integration S3 × S4: S0 predicted first-screen, which an unmoved focus cannot change; the second killer is
    // jump-focus (2.4.3 — one real Tab after the jump does not continue inside the section).
    killers: ['jump-landing', 'jump-focus'],
    defect: 'focus does not move to the section header after a jump',
  },
  dropCueInCard: {
    armedAt: 'S3', kind: 'chrome',
    file: 'src/components/today/v2/GlanceCard.jsx',
    find: '<WeatherCueLine callout={cueCallout} generatedAt={generatedAt} planDate={planDate} />',
    replace: '{open && <WeatherCueLine callout={cueCallout} generatedAt={generatedAt} planDate={planDate} />}',
    killers: ['region-headcount', 'first-screen'],
    defect: 'the weather cue line leaves the closed glance card (shown only once it is opened)',
  },
  dropFrostInCard: {
    armedAt: 'S3', kind: 'chrome',
    file: 'src/components/today/v2/GlanceCard.jsx',
    find: '<FrostAlertLine alertsSent={plan.alerts_sent} lowShown={agreed?.lowF} planLow={weather.tonightLow} current={current} />',
    replace: '{open && <FrostAlertLine alertsSent={plan.alerts_sent} lowShown={agreed?.lowF} planLow={weather.tonightLow} current={current} />}',
    killers: ['region-headcount', 'first-screen'],
    defect: 'the frost line leaves the closed glance card (shown only once it is opened)',
  },

  // ── S4: needs care (patterns filled by S4, 2026-09-29; exact source text — the plugin throws on a miss)
  clipSpotPanel: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotRow.jsx", find: "{open && <div id={panelId}>{children}</div>}", replace: "{open && <div id={panelId} style={{ height: 0, overflow: 'hidden' }}>{children}</div>}", killers: ["interaction", "visibility"], defect: "the Bag Area panel clipped (height 0, overflow hidden) \u2014 mounted, counted, unseen" },
  hideInsteadOfUnmount: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotRow.jsx", find: "{open && <div id={panelId}>{children}</div>}", replace: "<div id={panelId} hidden={!open}>{children}</div>", killers: ["collapsed-mounted", "visibility"], defect: "closed spot bodies mounted `hidden` instead of unmounted" },
  wrongHeaderCount: { armedAt: "S4", kind: 'chrome', file: "src/pages/TodayV2.jsx", find: "      count: care.length || null,\n", replace: "      count: Math.min(care.length, 20) || null,\n", killers: ["header-text", "count-invariant"], defect: "the Needs care header counts capped rows (20), not all rows" },
  reorderSections: { armedAt: ["S4", "S5"], kind: 'chrome', file: "src/pages/TodayV2.jsx", find: "style={key === 'care' ? careGap : undefined}", replace: "style={key === 'care' ? { ...careGap, order: 9 } : undefined}", killers: ["section-open-set", "first-screen"], defect: "a CSS order: puts Needs care after Resting. S4 re-scheduled it to S4+S5: at S4 the page holds two sections and one instrument for their order (section-open-set orderOf, which reds); the first-screen killer needs Protect (S5) above Needs care" },
  spotReorderOnLog: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/NeedsCare.jsx", find: "  const heldOrder = c?.order\n", replace: "  const heldOrder = null\n", killers: ["spot-order", "group-water-all"], defect: "spots re-rank from the live rows after a log mid-visit (the held order dropped) \u2014 a done spot loses its slot" },
  dropHeaderSummary: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/TodaySection.jsx", find: "        summary={summary == null ? summary : <span data-testid=\"section-summary\">{summary}</span>}\n", replace: "        summary={null}\n", killers: ["header-text", "region-headcount"], defect: "the one-line section summary is removed" },
  exceptionsCapped: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotBody.jsx", find: "{exRows.map((r) => place(r, 'care-exceptions-row', exceptionReason(r)))}", replace: "{exRows.slice(0, 5).map((r) => place(r, 'care-exceptions-row', exceptionReason(r)))}", killers: ["interaction", "count-invariant"], defect: "the exceptions list is capped (5 of 8 shown under \"\u00b7 8\")" },
  uncapCohort: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotBody.jsx", find: "  const shown = cohortAll ? cohort.length : Math.min(COHORT_CAP, cohort.length)\n", replace: "  const shown = cohort.length\n", killers: ["interaction", "region-headcount"], defect: "the disclosed cohort renders uncapped (89 rows, no Show more / cap note)" },
  dropExceptions: { armedAt: "S4", kind: 'chrome', file: "src/lib/todayV2/spots.js", find: "  if (rows.length <= SMALL_SPOT_MAX) return null\n", replace: "  if (rows.length) return null\n", killers: ["interaction", "region-headcount"], defect: "the exceptions / cohort split is gone \u2014 every spot lists every row" },
  bulkIgnoresBedWait: { armedAt: "S4", kind: 'chrome', file: "src/lib/todayV2/spots.js", find: "  const wait = !!bedWait && (group == null || group === OUTSIDE)\n", replace: "  const wait = false\n", killers: ["header-text", "group-water-all"], defect: "a spot Water all (and so its group) includes beds on bed-wait" },
  groupBulkIgnoresBedWait: { armedAt: "S4", kind: 'chrome', file: "src/lib/todayV2/spots.js", find: "for (const s of list) { if (s.candidates.size) spotsWithWater++; for (const k of s.candidates) keysAll.add(k) }", replace: "for (const s of list) { if (s.candidates.size) spotsWithWater++; for (const r of s.rows) if (r.eventType === 'watering') keysAll.add(r.key) }", killers: ["header-text", "group-water-all"], defect: "MF3: the group Water all includes beds on bed-wait (the spots' own buttons still hold them back)" },
  groupUndoPartial: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/NeedsCare.jsx", find: "      const { undone, failed: stuck } = await actions.undoMany(b.created, { concurrency: 4 })\n", replace: "      const { undone, failed: stuck } = await actions.undoMany(b.created.slice(1), { concurrency: 4 })\n", killers: ["group-water-all", "header-text"], defect: "MF3: the group Undo does not delete exactly the created ids (one is left logged)" },
  dropNotToday: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotRow.jsx", find: "          <button type=\"button\" onClick={disabled || busy ? undefined : onNotToday} aria-disabled={disabled || busy ? 'true' : undefined} aria-label={'Not today: ' + spot.name} style={outlineBtn}>Not today</button>\n", replace: "", killers: ["header-text", "floors"], defect: "the spot Not today control is missing" },
  doneLineVanishes: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotRow.jsx", find: "export function SpotDoneLine({ spotKey, name, text, onUndo, undoBusy, undoLabel, note }) {\n  return (", replace: "export function SpotDoneLine({ spotKey, name, text, onUndo, undoBusy, undoLabel, note }) {\n  return null && (", killers: ["group-water-all", "back-restore"], defect: "the done line is not held for the visit (a logged spot vanishes). The second killer is the shell gate's back-restore, which this matrix does not run" },
  // Re-scheduled S3+S4 → S5+S6 (orchestrator, 2026-09-29): plan §9.1(l) caps the page at 4 design surfaces (glance
  // card, bar, band, row card) and the merged S3 + S4 page carries 3, so one extra card is still a LEGAL page there
  // and neither killer can fire (the mutant SURVIVED the S3 + S4 matrix, twice). maxFingerprints stays 4 on purpose:
  // lowering it to the measured 3 would be a frozen count S5/S6 must bump.
  extraCardFingerprint: { armedAt: ["S5", "S6"], kind: 'chrome', file: "src/components/today/v2/NeedsCare.jsx", find: "<div key={gk} data-testid=\"care-group\" data-group={gk} style={{ display: 'flex', flexDirection: 'column', gap: T.space.xs }}>", replace: "<div key={gk} data-testid=\"care-group\" data-group={gk} style={{ display: 'flex', flexDirection: 'column', gap: T.space.xs, border: '1px solid #d4c9be', borderRadius: 12, background: '#ffffff' }}>", killers: ["visual-census", "region-headcount"], defect: "a fifth (r12) card treatment is added. Re-scheduled to S5+S6: baseline 3 of 4 design surfaces at S3+S4 (measured on v2-frost, 2026-09-29); re-arm when the page carries all 4, and if it never does, replace the count with an identity check against the 4 design fingerprints" },

  // ── S4g: Needs care follow-ups (wave 4). Exact source text; each killed by v2-busy's spot-retry run (MF3).
  dropSpotRetry: { armedAt: 'S4g', kind: 'chrome', file: 'src/components/today/v2/SpotRow.jsx', find: '      {failing && (\n', replace: '      {false && (\n', killers: ['header-text', 'spot-retry', 'retry-focus'], defect: 'MF3: a spot holding failed writes shows no "N not logged" line and no Retry — the failure is visible only inside the opened spot' },
  retryNewBatch: { armedAt: 'S4g', kind: 'chrome', file: 'src/components/today/v2/NeedsCare.jsx', find: "      settle(bid, { scope: 'spot', target: spot.key, name: spot.name, kind, at: Date.now() }, res, { etype: g.etype, body: g.body || null })\n", replace: "      settle(newId(), { scope: 'spot', target: spot.key, name: spot.name, kind, at: Date.now() }, res, { etype: g.etype, body: g.body || null })\n", killers: ['spot-retry', 'header-text'], defect: 'MF3: a Retry lands in a batch of its own instead of completing the run it failed in — the run\'s one Undo leaves the retried writes logged' },
  spotShareIsGroupTotal: { armedAt: 'S4g', kind: 'chrome', file: 'src/components/today/v2/NeedsCare.jsx', find: "const n = b.kind === 'not-today' ? 0 : (spotKey && b.scope === 'group' ?", replace: "const n = b.kind === 'not-today' ? 0 : (false && b.scope === 'group' ?", killers: ['group-water-all', 'header-text'], defect: 'MF3: after a group Water all every touched spot reads the GROUP\'s total ("Trough · watered 152") instead of its own share' },
  noFilterAnnouncement: { armedAt: ['S3', 'S4g'], kind: 'chrome', file: 'src/components/today/v2/NeedsCare.jsx', find: '    announce(filterAnnouncement(filterResult(care.rows, next)))\n', replace: '', killers: ['announce', 'announce-once'], defect: '§2.6: a filter change says nothing through the status region (S4\'s state)' },
  emptiedTitleStays: { armedAt: 'S4g', kind: 'chrome', file: 'src/pages/TodayV2.jsx', find: "      title: care.length ? 'Needs care' : needs.caughtUp.title,\n", replace: "      title: 'Needs care',\n", killers: ['header-text', 'empty-focus'], defect: '§2.5: an emptied Needs care keeps the title "Needs care" (S4\'s state) — the header the emptying action focuses does not say it is caught up' },
  dropCaughtUpSummary: { armedAt: 'S4g', kind: 'chrome', file: 'src/pages/TodayV2.jsx', find: '        : needs.caughtUp.summary,\n', replace: '        : null,\n', killers: ['caught-up', 'empty-focus'], defect: '§2.5: the emptied header loses its "N logged today, M covered by rain" line' },
  announceEveryRender: { armedAt: ['S3', 'S4g'], kind: 'chrome', file: 'src/components/today/v2/NeedsCare.jsx', find: "  const feedOnly = tasks.length === 1 && tasks[0] === 'feed'\n", replace: "  const feedOnly = tasks.length === 1 && tasks[0] === 'feed'\n  useEffect(() => { announce(filterAnnouncement(filterResult(care.rows, filters))) })\n", killers: ['announce-once', 'announce'], defect: '§2.6: the filter result is said from a render effect — every render repeats it and talks over the run results (a bulk\'s "Watered N…")' },

  // ── S5: protect tonight + heads-up (patterns filled by S5, 2026-09-29; exact source text — the plugin throws on a
  // miss). The trigger-predicate mutants are cells of the triggers.js unit table (below, §13 Simplify 3); these three
  // and openAll (S2 block, re-pointed) are the real-Chrome half. reorderSections (S4 block) arms with S5 too.
  openNone: {
    armedAt: 'S5', kind: 'chrome',
    file: 'src/lib/todayV2/triggers.js',
    find: '    if (!reopens(t, resolve ? resolve(key) : null, planDate)) continue\n',
    replace: '    continue\n',
    killers: ['section-open-set', 'first-screen'],
    defect: 'real-Chrome canary (Simplify 3): the trigger predicate forced false — nothing auto-opens (frost, chill first seen, the storage window, small pots)',
  },
  coldRowsInNeedsCare: {
    armedAt: 'S5', kind: 'chrome',
    file: 'src/components/today/v2/useNeedsCare.js',
    find: "const CARE_NEEDS = new Set(['water_due', 'no_history', 'fertilize', 'pest', 'overwintering'])",
    replace: "const CARE_NEEDS = new Set(['water_due', 'no_history', 'fertilize', 'pest', 'overwintering', 'cold'])",
    // S5: the rows a second home adds carry no task, so no spot renders them — they show as a header count that no
    // longer matches its spots (S0 predicted region-headcount; the count families are the ones that can see it).
    killers: ['header-text', 'count-invariant'],
    defect: 'cold rows join Needs care as well as Protect (two homes): its header counts 238 over spots that sum to 233',
  },
  pickLinkMissing: {
    armedAt: 'S5', kind: 'chrome',
    file: 'src/components/today/v2/ProtectTonight.jsx',
    find: '      {protect.pick && (\n',
    replace: '      {false && protect.pick && (\n',
    killers: ['region-headcount', 'first-screen'],
    defect: 'the "Pick what\'s ripe first" link is gone from a frost / freeze night',
  },

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
