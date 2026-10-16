// todayMutantsV2.mjs — the defect catalogue for gate:today-shape:v2's mutation proof (V5-TODAYREDESIGN-001).
//
// A DATA FILE, read by tests/harness/vite.harness.v2mutant.mjs (applies one mutant, in memory) and
// scripts/mutate-today-shape-v2.mjs (enumerates, runs the gate per mutant, counts killer families). Since S8c (L8)
// the only Today catalogue: the v1 one (tests/harness/todayMutants.mjs) retired with the old page and its gate.
//
// SHAPE: name → { armedAt, file, find, replace, defect, killers, kind }
//   armedAt   the slice that writes the source this mutant edits. Until it lands, `file`/`find` are null and the
//             mutant is PENDING: listed and counted by the runner, never scored. The slice that lands fills in
//             the exact source text in the same commit (patterns are EXACT source text; the plugin THROWS on a
//             miss — a mutant that silently fails to apply would score SURVIVED, the one result that lies).
//   killers   the §9.1 families expected to kill it (≥ 2 independent ones once all are armed).
//   oneKiller (optional) why ONE family is all that can see this mutant, for good — the runner lists it instead of
//             failing it. Since S8c (every slice landed) a mutant red on one killer WITHOUT it fails the matrix.
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
  // Finish plan L4 (2026-10-14, Dave's D16 + D17): the bar is equal-width cells that wrap and never scroll, and its
  // Water / Feed / Check cells are Needs care's one task filter. chipRowNoScroll's premise (a strip that scrolls with
  // overflow-x:auto) is gone — RETIRED below; its defect, a chip out of reach past the bar's edge, is now the
  // bar scrolling instead of wrapping (cellsScrollSideways) or a cell too narrow for its label (cellMinTooSmall).
  cellsScrollSideways: {
    armedAt: 'S3', kind: 'chrome',
    file: 'src/components/today/v2/JumpBar.jsx',
    find: 'gridTemplateColumns: barColumns(n, oneRow),',
    replace: "gridAutoFlow: 'column', gridAutoColumns: `minmax(${CELL_MIN_REM}rem, 1fr)`, overflowX: 'auto',",
    killers: ['chip-census', 'no-hscroll'],
    defect: 'D16: the cells sit in one row that scrolls sideways at 200% text instead of wrapping (the strip the bar used to be)',
  },
  cellMinTooSmall: {
    armedAt: 'S3', kind: 'chrome',
    file: 'src/components/today/v2/JumpBar.jsx',
    find: 'export const CELL_MIN_REM = 3.75\n',
    replace: 'export const CELL_MIN_REM = 2\n',
    // Measured (L4 mutation run): the spilt labels also widen the bar past its box at 200% text, so no-hscroll reds too.
    killers: ['chip-census', 'no-hscroll'],
    defect: 'D16: the cells never wrap, so at 200% text the labels spill out of cells too narrow for them',
  },
  taskCellNeverPressed: {
    armedAt: ['S3', 'S4'], kind: 'chrome',
    file: 'src/components/today/v2/JumpBar.jsx',
    find: 'aria-pressed={toggle ? String(on) : undefined}',
    replace: "aria-pressed={toggle ? 'false' : undefined}",
    killers: ['interaction', 'chip-census'],
    defect: 'D17: a task cell never reports pressed — the filter is on and a screen reader is never told',
  },
  selectedLooksPlain: {
    armedAt: ['S3', 'S4'], kind: 'chrome',
    file: 'src/components/today/v2/JumpBar.jsx',
    find: 'style={on ? cellOn : cellStyle}',
    replace: 'style={cellStyle}',
    killers: ['chip-census'],
    oneKiller: 'only chip-census compares a pressed cell\'s paint with its own unpressed paint; aria-pressed still flips, so interaction and announce stay green',
    defect: 'D17: the selected task cell looks like every other cell ("where did my Feed rows go?") — only its label weight changes',
  },
  barCellSetsNoFilter: {
    armedAt: ['S3', 'S4'], kind: 'chrome',
    file: 'src/pages/TodayV2.jsx',
    find: '    if (c.task && counts[c.task] > 0) changeCareFilters(',
    replace: '    if (false) changeCareFilters(',
    killers: ['interaction', 'announce'],
    defect: 'D17: a Water / Feed / Check cell only jumps — the task filter is no longer anywhere on the page',
  },
  secondTapKeepsFilter: {
    armedAt: ['S3', 'S4g'], kind: 'chrome',
    file: 'src/pages/TodayV2.jsx',
    find: "tasks: careTask === c.task ? [] : [c.task] })",
    replace: 'tasks: [c.task] })',
    killers: ['announce', 'chip-census'],
    defect: 'D17: a second tap on the selected task cell re-applies its filter instead of clearing it — no way back to all',
  },
  truncateVerdict: {
    armedAt: 'S3', kind: 'chrome',
    file: 'src/components/today/v2/GlanceCard.jsx',
    find: "minHeight: '1.35em', overflowWrap: 'anywhere',",
    replace: "minHeight: '1.35em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',",
    // L3 (finish plan §3.2 row C): the short verdict fits ONE line on every gate state at 426 px (measured 19.44 px on
    // all of them, the longest "Water containers & beds · frost watch tonight"; even v2-bedwait's beds-held sentence
    // with a frost phrase fits), so a restored ellipsis clips no glyph and first-screen's mustShowText cannot see it.
    // verdict-truncation reads the style itself. A second killer needs a fixture whose verdict takes two lines (both
    // lanes holding over a list: "Rain may cover today's list — N still due · …"), which no v2 graft builds today.
    // Re-surveyed at the L3 + L4 + L5 integration (glanceHeadline + urgentPhrase over busy with every graft, alone and
    // gaugerain + bedwait together, with and without busyfull's frost alerts): both lanes hold on none of them, and
    // the longest, "Water containers, skip the beds · frost watch tonight" (L3's busyfull + bedwait trial), is one
    // line. A two-line verdict would need hydrology no real day in the fixtures has, so it stays declared one-killer.
    killers: ['verdict-truncation'],
    oneKiller: 'L3\'s short verdict fits one line on every gate fixture, so a restored ellipsis clips nothing a first-screen text check can see; only verdict-truncation reads the ellipsis style',
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
  // Pre-L7 QA (prepromote-v5-qa.md IMPORTANT 2): the offsets take the bar's height as a constant again. One row, nothing
  // changes; a WRAPPED bar (Android text at 200%) is taller, so every jump lands its header under the second row of cells
  // and a header focused under the pinned bar stays beneath it. Seen only by the shell gate's 200%-text pass (SHELL
  // textScale 2); TodayV2.jumpbar.test.jsx's 104px case is its jsdom twin.
  barHeightConstant: {
    armedAt: ['S3', 'S4'], kind: 'chrome',
    file: 'src/pages/TodayV2.jsx',
    find: '    const read = () => setBarH(Math.ceil(el.getBoundingClientRect().height) || JUMP_BAR_HEIGHT_PX)\n',
    replace: '    const read = () => setBarH(JUMP_BAR_HEIGHT_PX)\n',
    // Measured (2026-10-15): at 200% the bar is 160px in 2 rows; under the mutant every jump lands its header at y=112
    // against a bar ending at 212, four of five headers wholly hidden, and a focused parked header stays at 104.
    killers: ['jump-landing', 'jump-focus', 'sticky'],
    defect: 'the landing offset ignores a wrapped bar: at 200% text a jumped-to header lands under the bar\'s second row (WCAG 2.4.11)',
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
  // L3 (finish plan §3.3, D15, 2026-10-14) retired dropCueInCard and dropFrostInCard (RETIRED_V2, below): on a Protect
  // night the cue and the frost line are no longer in the closed card for a mutant to drop. Their successors guard the
  // fold itself and where the folded words land.
  foldIgnored: {
    armedAt: ['S3', 'S5'], kind: 'chrome',
    file: 'src/pages/TodayV2.jsx',
    find: 'coldRange={data?.cold_range ?? null} waterDue={waterDueLeft} protectShown={protectShown}',
    replace: 'coldRange={data?.cold_range ?? null} waterDue={waterDueLeft} protectShown={false}',
    killers: ['first-screen', 'floors'],
    defect: 'D15 ignored: the glance never learns Protect tonight is on the page, so the cold cue and the frost line stay under the card on a frost night (two more lines above Needs care)',
  },
  frostLeavesDetails: {
    armedAt: 'S3', kind: 'chrome',
    file: 'src/components/today/v2/GlanceCard.jsx',
    find: '{[...(frost.under ? [frost.under] : []), ...frost.details].map((l, i) => <FrostLine key={i} line={l} />)}',
    replace: '{false && [...(frost.under ? [frost.under] : []), ...frost.details].map((l, i) => <FrostLine key={i} line={l} />)}',
    killers: ['region-headcount', 'owner-floors'],
    defect: 'the folded frost sentence is not behind Details either (D15: "full frost sentence behind Details") — on a Protect night it is nowhere',
  },
  pickWordsLost: {
    armedAt: ['S3', 'S5'], kind: 'chrome',
    file: 'src/components/today/v2/ProtectTonight.jsx',
    find: '<span>{pickText || PICK_DEFAULT}</span>',
    replace: '<span>{PICK_DEFAULT}</span>',
    killers: ['header-text'],
    oneKiller: 'the link keeps its one-line box at 426 px in both wordings, so no geometry moves; the words are read by this family alone',
    defect: 'D15: the engine\'s pick cue folds away but its words never reach the pick link — the night\'s pick advice is gone from the page',
  },
  // Review I1 (L3 + L4 + L5 integrated): the fold's OTHER half — with NO Protect section the cue and the first frost line
  // stay under the closed card — was in no gate state, so a fold applied every night survived every family. Armed by
  // v2-frost-noprotect (busyfull with each tender row skipped today): its first screen must hold both lines and its
  // region-headcount counts both with the glance closed.
  cueFoldsWithoutProtect: {
    armedAt: ['S3', 'S5'], kind: 'chrome',
    file: 'src/lib/todayV2/alerts.js',
    find: '  return !!(protectShown && line && COLD_CUES.has(line.cue))\n',
    replace: '  return !!(line && COLD_CUES.has(line.cue))\n',
    killers: ['first-screen', 'region-headcount'],
    defect: 'D15 over-applied: a cold cue folds away on a night with NO Protect section — no pick link is there to carry its words, so the night\'s advice is nowhere on the page',
  },
  frostUnderNeverKept: {
    armedAt: ['S3', 'S5'], kind: 'chrome',
    file: 'src/lib/todayV2/alerts.js',
    find: '  if (protectShown || !all.length) return { under: null, details: all }\n',
    replace: '  return { under: null, details: all }\n',
    killers: ['first-screen', 'region-headcount'],
    defect: 'D15 over-applied: on a frost night with NO Protect section the frost line leaves the card for Details too — the first screen keeps only the verdict\'s phrase',
  },

  // ── S4: needs care (patterns filled by S4, 2026-09-29; exact source text — the plugin throws on a miss)
  clipSpotPanel: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotRow.jsx", find: "{open && <div id={panelId}>{children}</div>}", replace: "{open && <div id={panelId} style={{ height: 0, overflow: 'hidden' }}>{children}</div>}", killers: ["interaction", "visibility"], defect: "the Bag Area panel clipped (height 0, overflow hidden) \u2014 mounted, counted, unseen" },
  hideInsteadOfUnmount: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotRow.jsx", find: "{open && <div id={panelId}>{children}</div>}", replace: "<div id={panelId} hidden={!open}>{children}</div>", killers: ["collapsed-mounted", "visibility"], defect: "closed spot bodies mounted `hidden` instead of unmounted" },
  wrongHeaderCount: { armedAt: "S4", kind: 'chrome', file: "src/pages/TodayV2.jsx", find: "      count: care.length || null,\n", replace: "      count: Math.min(care.length, 20) || null,\n", killers: ["header-text", "count-invariant"], defect: "the Needs care header counts capped rows (20), not all rows" },
  reorderSections: { armedAt: ["S4", "S5"], kind: 'chrome', file: "src/pages/TodayV2.jsx", find: "style={key === 'care' ? careGap : undefined}", replace: "style={key === 'care' ? { ...careGap, order: 9 } : undefined}", killers: ["section-open-set", "first-screen"], defect: "a CSS order: puts Needs care after Resting. S4 re-scheduled it to S4+S5: at S4 the page holds two sections and one instrument for their order (section-open-set orderOf, which reds); the first-screen killer needs Protect (S5) above Needs care" },
  spotReorderOnLog: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/NeedsCare.jsx", find: "  const heldOrder = c?.order\n", replace: "  const heldOrder = null\n", killers: ["spot-order", "group-water-all"], defect: "spots re-rank from the live rows after a log mid-visit (the held order dropped) \u2014 a done spot loses its slot" },
  dropHeaderSummary: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/TodaySection.jsx", find: "        summary={summary == null ? summary : <span data-testid=\"section-summary\">{summary}</span>}\n", replace: "        summary={null}\n", killers: ["header-text", "region-headcount"], defect: "the one-line section summary is removed" },
  // Finish plan L5 (2026-10-14) re-pointed the pattern: the rows now take their meta from the group line (exceptionGroup),
  // so the line the cap edits changed; the defect and its two killers are the same.
  exceptionsCapped: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotBody.jsx", find: "{exRows.map((r) => { const o = ex.own.get(r.key);", replace: "{exRows.slice(0, 5).map((r) => { const o = ex.own.get(r.key);", killers: ["interaction", "count-invariant"], defect: "the exceptions list is capped (5 of 8 shown under \"\u00b7 8\")" },
  // Pre-L7 QA (prepromote-v5-qa.md IMPORTANT 1, 2026-10-15): finish plan L5's opened-spot anatomy, which only jsdom saw.
  // The group line never mounted, every Feed all drawn 32px tall, the picture box gone from every row — each is now seen
  // in real Chrome by the spot families (one census of Bag Area, no task filter) and a second, independent family.
  groupLineDropped: { armedAt: 'S4', kind: 'chrome', file: 'src/components/today/v2/SpotBody.jsx', find: '{ex.line && (', replace: '{false && ex.line && (', killers: ['interaction', 'region-headcount', 'spot-anatomy'], defect: 'L5 §3.6: the differing rows\' group line ("dry fastest · every 2 days · last watered 4 d ago") is never mounted — the rows say nothing of what they share' },
  feedAllShort: { armedAt: 'S4', kind: 'chrome', file: 'src/components/today/v2/SpotBody.jsx', find: 'style={tinted}>', replace: "style={{ ...tinted, minHeight: 0, height: 32 }}>", killers: ['spot-floors', 'spot-reach'], defect: 'a product line\'s Feed all is 32px tall, under the 44px tap floor — the product row keeps its 48px, so no row or height census moves' },
  thumbDropped: { armedAt: 'S4', kind: 'chrome', file: 'src/components/today/v2/PlantCareRow.jsx', find: '<PlantThumb photo={photo} />', replace: '{null}', killers: ['region-headcount', 'spot-anatomy'], defect: 'D18: the 40px picture box is gone from every plant row (Needs care and Protect) — the row is its name alone' },
  uncapCohort: { armedAt: "S4", kind: 'chrome', file: "src/components/today/v2/SpotBody.jsx", find: "  const shown = cohortAll ? cohort.length : Math.min(COHORT_CAP, cohort.length)\n", replace: "  const shown = cohort.length\n", killers: ["interaction", "region-headcount"], defect: "the disclosed cohort renders uncapped (89 rows, no Show more / cap note)" },
  dropExceptions: { armedAt: "S4", kind: 'chrome', file: "src/lib/todayV2/spots.js", find: "  if (rows.length <= SMALL_SPOT_MAX) return null\n", replace: "  if (rows.length) return null\n", killers: ["interaction", "region-headcount"], defect: "the exceptions / cohort split is gone \u2014 every spot lists every row" },
  // BUG-DEFERNOSTRESSOVERRIDE-001 retired bulkIgnoresBedWait and groupBulkIgnoresBedWait: "Water all includes the beds
  // on bed-wait" was their defect and is now the rule (the engine holds the beds that wait; a bed still listed is one
  // it kept). The defect the other way round — the client exclusion coming back — is this one, on v2-bedwait.
  bedWaitExclusionBack: { armedAt: "S4", kind: 'chrome', file: "src/lib/todayV2/spots.js", find: "    if (r.eventType !== 'watering') continue\n    if (exclude && exclude.has(r.key)) continue\n", replace: "    if (r.eventType !== 'watering' || r.inGround) continue\n    if (exclude && exclude.has(r.key)) continue\n", killers: ["header-text", "group-water-all"], defect: "an in-ground bed the engine kept on the list is dropped from Water all again (spot and group)" },
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
  // L4: the filter (and the one announcement of its change) moved from NeedsCare to the page, beside the bar's cells.
  noFilterAnnouncement: { armedAt: ['S3', 'S4g'], kind: 'chrome', file: 'src/pages/TodayV2.jsx', find: '    announce(filterAnnouncement(filterResult(care, next)))\n', replace: '', killers: ['announce', 'announce-once'], defect: '§2.6: a filter change says nothing through the status region (S4\'s state)' },
  emptiedTitleStays: { armedAt: 'S4g', kind: 'chrome', file: 'src/pages/TodayV2.jsx', find: "      title: care.length ? 'Needs care' : needs.caughtUp.title,\n", replace: "      title: 'Needs care',\n", killers: ['header-text', 'empty-focus'], defect: '§2.5: an emptied Needs care keeps the title "Needs care" (S4\'s state) — the header the emptying action focuses does not say it is caught up' },
  dropCaughtUpSummary: { armedAt: 'S4g', kind: 'chrome', file: 'src/pages/TodayV2.jsx', find: '        : needs.caughtUp.summary,\n', replace: '        : null,\n', killers: ['caught-up', 'empty-focus'], defect: '§2.5: the emptied header loses its "N logged today, M watered by rain" line' },
  announceEveryRender: { armedAt: ['S3', 'S4g'], kind: 'chrome', file: 'src/pages/TodayV2.jsx', find: "  const careTask = needs.task\n", replace: "  const careTask = needs.task\n  useEffect(() => { announce(filterAnnouncement(filterResult(care, careFilters))) })\n", killers: ['announce-once', 'announce'], defect: '§2.6: the filter result is said from a render effect — every render repeats it and talks over the run results (a bulk\'s "Watered N…")' },

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
    // L3: the link also shows for a folded pick cue (D15), so the condition grew; re-pointed.
    find: '      {(protect.pick || pickText) && (\n',
    replace: '      {false && (protect.pick || pickText) && (\n',
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
  // L3 (finish plan §3.2): the dry list is the deep-soak line's inline names now — re-pointed at that span.
  dropRegionInOwner_dryList: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/GlanceCard.jsx', find: "{rows.length > 0 && <span data-testid=\"care-drought-list\">{`${rows.map((r) => r.name).join(', ')}.`}</span>}", replace: '{null}', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'dryList' (care-drought-list) is deleted inside the glance details" },
  dropRegionInOwner_feedSuppressed: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/NeedsCare.jsx', find: '<FeedSuppressedList plan={care.plan} compact />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'feedSuppressed' (care-feed-suppressed) is deleted at the foot of Needs care" },
  dropRegionInOwner_rainNote: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/GlanceCard.jsx', find: '<RainHold plan={plan} care={care} record={record} update={update} announce={announce} writesHeld={writesHeld} />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'rainNote' (care-rain-note) is deleted inside the glance details" },
  // Review I5 (BUG-DEFERNOSTRESSOVERRIDE-001): the waiting list's tap sizes. The Water chip is PlantCareRow's, so the
  // first also shortens every Needs care row's chip; only the waiting rows are measured for it.
  // Finish plan L5 (2026-10-14) re-pointed it at the one row anatomy's soft-green main action (PlantRow mainBtn), which
  // replaced the full-height chip cell: the shortened button is now every row's main action (Needs care's Water / Feed
  // / Checked and Protect's Brought in), still read for size by this family alone.
  rainWaterChipShort: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/PlantCareRow.jsx', find: "  minHeight: T.buttonMinHeight, padding: '0 8px', backgroundColor: P.greenPale, borderRadius: T.radiusButton,\n", replace: "  height: 32, alignSelf: 'center', padding: '0 8px', backgroundColor: P.greenPale, borderRadius: T.radiusButton,\n", killers: ['rain-wait-floors'], oneKiller: 'the row keeps its height (its link holds 48px), so no height floor or census moves; the button size is read by this family alone', defect: 'the Water button on a row is 32px tall, under the 48px tap floor' },
  rainToggleShort: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/RainHold.jsx', find: "const textLink = { flexShrink: 0, minHeight: T.buttonMinHeight, minWidth: T.buttonMinHeight,", replace: "const textLink = { flexShrink: 0, minHeight: 30, minWidth: 30,", killers: ['rain-wait-floors'], oneKiller: 'the line it sits on keeps its own 48px, so the open card is no shorter; the control size is read by this family alone. The second guard is jsdom (TodayV2RainHold.test.jsx "the Show / Hide control is T.buttonMinHeight (48) tall and wide"), which this matrix does not run', defect: "the waiting list's Show / Hide is 30px tall, under the 48px tap floor" },
  dropRegionInOwner_basisStamp: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/GlanceCard.jsx', find: '{basis && <p data-testid="today-basis-stamp"', replace: '{false && basis && <p data-testid="today-basis-stamp"', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'basisStamp' (today-basis-stamp) is deleted inside the glance details" },
  // L3: re-pointed at the merged deep-soak line (DryLine) and the compact leaf-wetness mount.
  dropRegionInOwner_droughtLine: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/GlanceCard.jsx', find: '<DryLine plan={plan} />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'droughtLine' (drought-line) is deleted inside the glance details" },
  dropRegionInOwner_leafLine: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/GlanceCard.jsx', find: '<LeafWetnessLine plan={plan} planDate={planDate} compact />', replace: '<></>', killers: ['region-headcount', 'owner-floors'], defect: "the moved region 'leafLine' (leaf-wetness-line) is deleted inside the glance details" },
  // Pre-L7 QA (prepromote-v5-qa.md MINOR): review B1 back — her section's Needs care gets no onFilters, so a tap on one of
  // her spot chips throws and presses nothing. Seen by v2-household's interaction run (her chip's aria-pressed must flip).
  householdChipsDead: { armedAt: 'S6', kind: 'chrome', file: 'src/components/today/v2/HouseholdSection.jsx', find: ' onFilters={changeFilters} writesHeld={writesHeld} />', replace: ' writesHeld={writesHeld} />', killers: ['interaction'], oneKiller: 'only v2-household\'s interaction run opens her section and taps her chips; the semantic second guard is jsdom (TodayV2.household.test.jsx), which this matrix does not run', defect: 'B1: a spot chip in a household member\'s section does nothing — her list cannot be filtered' },
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
  chipRowNoScroll: 'finish plan L4 (Dave\'s D16, 2026-10-14): the bar never scrolls sideways, so there is no overflow-x:auto to lose; its defect (a chip unreachable past the edge) is now cellsScrollSideways and cellMinTooSmall',
  dropCueInCard: 'finish plan L3 (D15): on a Protect night the cue folds into the pick link, so the closed card holds no cue line to drop; foldIgnored and pickWordsLost guard the fold and its words',
  dropFrostInCard: 'finish plan L3 (D15): on a Protect night the frost line is behind Details, not in the closed card; foldIgnored and frostLeavesDetails guard the fold and the full sentence',
}
