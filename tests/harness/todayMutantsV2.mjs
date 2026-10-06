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
//   oneKiller (optional) why ONE family is all that can see this mutant, for good — the runner prints it instead of
//             "under-guarded by schedule", which would promise a second family that no slice is going to arm.
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
  // Re-scheduled S3+S4 → S5+S6 (orchestrator, 2026-09-29): plan §9.1(l) capped the page at 4 fingerprints, but the
  // glance card and the row card are one material, so the merged page carries 3 and one extra card was still a LEGAL
  // page (the mutant SURVIVED the S3 + S4 matrix, twice). Armed at integration 2 against the two families that can
  // see a card treatment: visual-census, now an IDENTITY check (every fingerprint is one of the pinned design
  // surfaces), and card-nesting (plan-v2 "card-in-card → none") — the r12 group card holds the spot row cards.
  // region-headcount, its old second killer, counts elements and cannot see a style.
  extraCardFingerprint: { armedAt: ["S5", "S6"], kind: 'chrome', file: "src/components/today/v2/NeedsCare.jsx", find: "<div key={gk} data-testid=\"care-group\" data-group={gk} style={{ display: 'flex', flexDirection: 'column', gap: T.space.xs }}>", replace: "<div key={gk} data-testid=\"care-group\" data-group={gk} style={{ display: 'flex', flexDirection: 'column', gap: T.space.xs, border: '1px solid #d4c9be', borderRadius: 12, background: '#ffffff' }}>", killers: ["visual-census", "card-nesting"], defect: "an extra (r12) card treatment around each Needs care group: a fingerprint that is none of the design surfaces, and a card holding cards" },

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

  // ── S6: harvest, put-up, resting, household, sow link (patterns filled by S6, 2026-09-29; exact source text — the
  // plugin throws on a miss). dropRegionInOwner ×10: a region the redesign MOVED into an owner (§9.1 REGIONS) deleted
  // inside that owner. Killers: region-headcount (the owner opened, the region counted) and owner-floors (S6's
  // family: the owner opened is shorter than its recorded floor). S0 predicted first-screen, which cannot see them —
  // every one of these owners is closed on the first screen, and the glance's regions sit behind its tap (D1).
  // Four of the ten live in S3's / S4's files (GlanceCard.jsx; NeedsCare.jsx, S4g's this wave): a line they rewrite
  // re-points its pattern here.
  dropRegionInOwner_watchBand: { armedAt: 'S6', kind: 'chrome', file: 'src/pages/TodayV2.jsx', find: '<HarvestWatchBand data={bands.watch} bare />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'watchBand' (today-watch-band) is deleted inside Harvest" },
  dropRegionInOwner_compose: { armedAt: 'S6', kind: 'chrome', file: 'src/pages/TodayV2.jsx', find: '<ComposeHarvestBand data={bands.compose} bare />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'compose' (compose-harvest-band) is deleted inside Harvest" },
  dropRegionInOwner_putUp: { armedAt: 'S6', kind: 'chrome', file: 'src/pages/TodayV2.jsx', find: '<PutUpUseSoonBand data={bands.soon} bare />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'putUp' (putup-use-soon) is deleted inside From your Put-Up" },
  dropRegionInOwner_dormant: { armedAt: 'S6', kind: 'chrome', file: 'src/pages/TodayV2.jsx', find: '<DormantList plan={plan} bare resumed={resumedSet} onResumed={markResumed} />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'dormant' (care-dormant) is deleted inside Resting" },
  dropRegionInOwner_dryList: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/GlanceCard.jsx', find: '<DroughtList plan={plan} />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'dryList' (care-drought-list) is deleted inside the glance details" },
  dropRegionInOwner_feedSuppressed: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/NeedsCare.jsx', find: '<FeedSuppressedList plan={care.plan} />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'feedSuppressed' (care-feed-suppressed) is deleted at the foot of Needs care" },
  dropRegionInOwner_rainNote: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/GlanceCard.jsx', find: '<RainNote plan={plan} />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'rainNote' (care-rain-note) is deleted inside the glance details" },
  dropRegionInOwner_basisStamp: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/GlanceCard.jsx', find: '{basis && <p data-testid="today-basis-stamp"', replace: '{false && basis && <p data-testid="today-basis-stamp"', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'basisStamp' (today-basis-stamp) is deleted inside the glance details" },
  dropRegionInOwner_droughtLine: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/GlanceCard.jsx', find: '<DroughtLine plan={plan} />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'droughtLine' (drought-line) is deleted inside the glance details" },
  dropRegionInOwner_leafLine: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/GlanceCard.jsx', find: '<LeafWetnessLine plan={plan} />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'leafLine' (leaf-wetness-line) is deleted inside the glance details" },
  // The freeze switched off at its one consumer: the page asks for sow lines and the Sow link row prints the engine's
  // "Sow X by …" lines above its door. Killers: header-text (the row's exact words, v2-busy / v2-frost, whose 09-24
  // engine run has two such lines) and floors (the row is the page's last block, so the lines push the last ink and
  // the document past their 2% ceilings). S0 predicted region-headcount, which counts presence and cannot see ADDED lines.
  sowLinesDuringFreeze: { armedAt: 'S6', kind: 'chrome', file: 'src/pages/TodayV2.jsx', find: 'sowLines: !SOW_DATED_LINES_FROZEN', replace: 'sowLines: true', killers: ['header-text', 'floors'], defect: 'dated sow lines render during the 2027 freeze' },

  // ── §13 Simplify 3: trigger-predicate mutants → cells of the triggers.js unit table (S5 writes the test)
  ignoreRemembered: U('S5', 'Layer 1 dropped — a same-day ack no longer holds'),
  rememberedBeatsUrgent: U('S5', 'a remembered close beats a new, higher trigger'),
  staleAutoOpens: U('S5', 'a stale plan triggers auto-open'),
  // ── OPS-TODAYV2GATECOVERAGE-001: what only the trusted-taps flows drive (review-dbl-recut-gatefix-delta-20261006
  // IMPORTANT-1) — a run that ends with its body gone, a one-row tap, two runs at once, Feed all's result, Cover all's
  // line. Exact source text. Each is killed by ONE flow's family and says so (`oneKiller`): no other check in either
  // gate drives these paths, so a second family would be the same observation filed twice, not an independent one.
  tapsParkedRunNotTaken: { armedAt: 'S4', kind: 'chrome', file: 'src/components/today/v2/NeedsCare.jsx', find: '      const r = runTake(bid)\n', replace: '      const r = (runTake(bid), null)\n', killers: ['trusted-taps'], oneKiller: 'only away-back and close-reopen end a run with its body gone', defect: 'the body on screen drops a parked run instead of landing it — a Water all left mid-run (Back) or closed mid-run (reopened) has no done line and no Undo' },
  tapsRunNotParked: { armedAt: 'S4', kind: 'chrome', file: 'src/components/today/v2/NeedsCare.jsx', find: '      runEnd(bid, { res, what, said, by: claim })\n', replace: '      runEnd(bid)\n', killers: ['trusted-taps'], oneKiller: 'only away-back and close-reopen end a run with its body gone', defect: 'a run that ends with its body gone parks no result for the body then on screen' },
  tapsRowDoneNotRecorded: { armedAt: 'S4', kind: 'chrome', file: 'src/components/today/v2/NeedsCare.jsx', find: '        return { ...cc, failed: f, rowsDone: { ...(cc.rowsDone || {}), [row.key]: { kind, created: res.created[0], spot: row.spotKey } } }\n', replace: '        return { ...cc, failed: f }\n', killers: ['trusted-taps'], oneKiller: 'only row-tap taps a single row', defect: 'D11: a one-row Water posts but leaves no "<plant> · watered" line and no Undo' },
  tapsSecondRunReplacesFirst: { armedAt: 'S4', kind: 'chrome', file: 'src/components/today/v2/NeedsCare.jsx', find: '    return { ...cc, batches: { ...(cc.batches || {}), [bid]: b }, failed: f }\n', replace: '    return { ...cc, batches: { [bid]: b }, failed: f }\n', killers: ['trusted-taps'], oneKiller: 'only two-spots has two runs on the record at once', defect: 'a run that lands replaces the visit\'s batches instead of joining them — with two runs at once the first to land loses its line and its Undo' },
  tapsBulkResultUnsaid: { armedAt: 'S4', kind: 'chrome', file: 'src/components/today/v2/NeedsCare.jsx', find: '    announce(said)\n    if (!alive.current) {\n', replace: '    if (!alive.current) {\n', killers: ['trusted-taps', 'announce'], defect: 'a bulk run never says its result — Feed all (which draws no line) ends in silence; the status region still reads "Logging N in …"' },
  tapsPostsTwice: { armedAt: 'S4', kind: 'chrome', file: 'src/components/today/useCareActions.js', find: "          const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify(body), keepalive: true })\n", replace: "          await fetch('/api/events', { method: 'POST', body: JSON.stringify(body), keepalive: true })\n          const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify(body), keepalive: true })\n", killers: ['post-once'], oneKiller: 'only the trusted-taps flows count the writes at the wire', defect: 'a bulk run posts every planting twice — the page reads the same; the log holds each event double, one of them out of every Undo\'s reach' },
  tapsCoverNoDoneLine: { armedAt: 'S5', kind: 'chrome', file: 'src/components/today/v2/ProtectTonight.jsx', find: '    if (!remaining.length && last) {\n', replace: '    if (false) {\n', killers: ['trusted-taps'], oneKiller: 'only cover-all runs a Cover all', defect: 'a spot wholly covered by Cover all draws no "<Spot> · covered N" line and no Undo' },

  chillOpensEveryNight: U('S5', 'chill ignores first-seen and opens every night'),
  headsupAlwaysOpen: U('S5', 'Heads-up opens on every day of the window'),
  householdAlwaysOpen: U('S6', 'a household section auto-opens'),
  glanceOpenByDefault: U('S3', 'the glance card opens by default'),
}

// Retired, with the reason, so the catalogue never loses a name silently.
export const RETIRED_V2 = {
  highlightStuck: '§13 Simplify 5 cut the in-view scroll-spy (no lit chip state), so there is no highlight to stick',
}
