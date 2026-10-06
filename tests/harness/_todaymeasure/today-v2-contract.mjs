// today-v2-contract.mjs — THE gate:today-shape:v2 CONTRACT, as data (V5-TODAYREDESIGN-001 S0).
//
// Source: Projects/Gardening/_todayux_20260928/plan-v2.md §9.1 (states, assertions a–m, REGIONS map, mutant
// families), §8 (which slice arms what), §13 (boss amendments MF1–MF3, SF4–SF6, Simplify 3 — they supersede
// §9.1 where they conflict, and each place they did is marked below).
//
// Imported by BOTH sides: the harness (tests/harness/_todaymeasure/v2wire.js, in the browser) reads the state
// table to build each state's payloads and local seeds; the gate (scripts/layout-gate/today-shape-v2.mjs,
// in node) reads it to decide what to assert. One table, so the page served and the page judged cannot
// describe different states. Pure data plus two pure helpers: no DOM, no node imports.
//
// ── HOW A CHECK ARMS ────────────────────────────────────────────────────────────────────────────────────
// Every check names the slice(s) whose surface it measures (`armedAt`). A check is ARMED when every slice it
// names is in LANDED; otherwise it is PENDING. The gate runs ARMED checks and FAILS on them; it PRINTS every
// PENDING check, counts it, and never reports it as passed. A slice arms its checks by adding itself to
// LANDED in the same commit that builds the surface (and recording the v2 budget on a clean tree). Not an
// ordinal: SF12 lets S4 land before S3, so "everything up to S4" would arm S3's checks over nothing.
//
// A PENDING check is not a hole the gate hides: the banner says "N PENDING — not measured, not passed", the
// S8c DoD is "zero PENDING", and `--arm-all` (the self-test) runs every check today, against a stub V2, and
// must go red on the census — the proof that each armed-later check CAN fail once armed.
// S2 (2026-09-28): the section component, the visit layer + local mirror and the route toggle — see the S2
// notes on ANCHORS.ready and v2-remembered below.
// S3 (2026-09-29): the glance card + the jump bar. Checks that measure S3's surface TOGETHER with a later slice's
// were split, so the S3 half arms now and the rest keeps waiting (each split is marked "S3 split" below); the
// shell's sticky / jump-landing checks need a page taller than one screen, which only S4's Needs care body gives
// on these fixtures (the S3 build report has the measured heights), so they arm at S3 + S4.
// S4 (2026-09-29): Needs care — groups, spots, exceptions + cohort, filters, Not today, done lines, the care
// trigger (§3's Needs care half: v2-hot / v2-never / v2-routine prove it). Its own checks below are marked
// "S4-scoped": they measure the Needs care surface alone, so they hold before and after S3/S5/S6 land (the
// full-page versions of the same families stay armed at their slice combinations).
// S3 and S4 were built in parallel on the same base and merged by the integrator (build-int-s3s4.md).
// S4g (2026-09-29, wave 4, parallel with S5 and S6): Needs care follow-ups (build-s4.md "Not done / gaps") —
// MF3's "Not logged · Retry" on the spot row itself, the filter result announcement (§2.6), the emptied header
// "Needs care · all caught up" (§2.5). Its checks measure the Needs care surface alone, on v2-busy / v2-frost.
// S5 (2026-09-29): Protect tonight + Heads-up and §3's other two trigger halves (triggers.js openAtStart: one
// evaluation at the ready point for protect / headsup / care). Arms every check whose slices are now all landed —
// the Protect half of the v2-frost / v2-busy first screens, visibility on v2-frost, the busy-seen / closed-today /
// routine / freeze / storage / remembered-urgent / stale open sets. Rows S5 changed are marked "S5:" below.
// S6 (2026-09-29, wave 4, parallel with S5 and S4g): Harvest, From your Put-Up, Resting's rows, the household
// sections, the Sow link row. Its own checks are marked "S6-scoped" where the full-page version also needs S5
// (Protect, Heads-up). New family `owner-floors`: a section (or the glance) opened from the default render must be
// at least as tall as the budget recorded — the geometric witness that a region moved into an owner was not
// deleted inside it (dropRegionInOwner), independent of region-headcount's element census.
// S4g, S5 and S6 were built in parallel on the same base and merged by the integrator (build-int2.md).
export const LANDED = ['S0', 'S2', 'S3', 'S4', 'S4g', 'S5', 'S6']
export const SLICES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S4g', 'S5', 'S6', 'S7', 'S8']

export function isArmed(check, landed = LANDED, armAll = false) {
  if (armAll) return true
  const need = Array.isArray(check.armedAt) ? check.armedAt : [check.armedAt]
  return need.every((s) => landed.includes(s))
}

// First screen = the viewport minus TopChrome (BAR_H) and BottomNav (BOTTOM_NAV_HEIGHT_PX). The GATE computes
// it from those source constants (836 − 52 − 56 = 728 today) until Dave's phone step-0 reading replaces it
// (plan §9.3 step 0). Stated here as the formula, never as a number, so a moved constant moves the gate.
export const FIRST_SCREEN = 'VIEWPORT.h - TopChrome BAR_H - BOTTOM_NAV_HEIGHT_PX'

// Section keys, in their fixed order (plan §1.0). `hh-<member8>` sections sit after resting.
export const SECTION_ORDER = ['protect', 'headsup', 'care', 'harvest', 'putup', 'resting']

// Anchor conventions the checks read (plan §9.1 "New anchors"). A section is `today-sec-<key>`; its header
// toggle is the first `[aria-expanded]` inside it; rows are the ROW_TESTIDS. S2+ may rename an anchor only in
// the same commit as this table, deliberately and visibly — the v1 contract's rule, carried over.
export const ANCHORS = {
  version: 'data-today-version',
  // S2: the §6.4 ready point, where the sections paint. The version anchor paints at mount, before the plan
  // lands, so readiness keyed on it alone read an empty page on a fast machine and a full one on a slow one.
  ready: 'data-today-ready',
  prefsLoaded: 'data-prefs-loaded',
  section: 'today-sec-',
  glance: 'today-glance',
  jumpbar: 'today-jumpbar',
  status: 'today-status',
}
export const ROW_TESTIDS = ['protect-row', 'care-row', 'care-spot', 'care-group', 'care-exceptions', 'care-cohort']

// ── STATES (§9.1 table, amended by §13) ─────────────────────────────────────────────────────────────────
// fixture: the v1 payload the state starts from (todaymeasure.jsx's states: busy, busyfull, busyhh, quiet,
//          noplan, storage). grafts: v2-grafts.json keys applied in order. redate: serve the plan dated this
//          day (storage variants). prefs: the GET /api/notifications/prefs body. prefsDelayMs: answer late.
// local:   device seeds written BEFORE mount (the V2 route reads them in useState initialisers):
//          todaySeen {date}          — today-seen:<user> marks every cold card of the served plan first-seen on `date`
//          mirror {…entries}         — today-sections:<user> = {v:1, s:{…}, dirty:[]}
//          showOthers true           — garden.today.showOthers = '1' (SF6: household stays opt-in per person)
// clock:   the pinned instant (todaymeasure.html ?clock=). ET 10:30 on the named day.
const AT = (day) => `${day}T14:30:00.000Z`
const S924 = AT('2026-09-24')

// Common checks every state with a plan carries (the §9.1 (a)/(e)/(h)/(j) floor of the contract).
const common = ({ plan = true, glanceClosed = true } = {}) => [
  { family: 'prefs-instrument', armedAt: 'S0', why: 'the prefs GET is observed exactly once (seam b); a V2 that never reads prefs cannot honour Layer 1' },
  { family: 'version', armedAt: 'S2', why: 'data-today-version="2" — the V2 route mounted, not V1' },
  { family: 'prefs-loaded-attr', armedAt: 'S2', why: 'data-prefs-loaded matches the observed GET' },
  { family: 'no-hscroll', armedAt: 'S2', why: '(h) no horizontal overflow; only the chip strip may scroll sideways, with overflow-x:auto' },
  { family: 'floors', armedAt: 'S2', why: '(j) floors before ceilings — contentBottom, controls ≥ 1, from the v2 budget' },
  { family: 'first-screen', armedAt: 'S2', mustContain: ['today-title', 'today-date'], why: '(e) title + date fully inside [0, FIRST_SCREEN)' },
  // Integration 2: plan-v2 "Visual" — card-in-card → none (D8: flat bands, each item its own white card). Measured on
  // the merged S4g + S5 + S6 page: no card inside a card on any of the 20 default renders. Armed with every slice whose
  // surface draws a card (the glance S3, spot rows S4, Protect / Heads-up rows S5, the bands and household S6).
  { family: 'card-nesting', armedAt: ['S3', 'S4', 'S5', 'S6'], why: 'plan-v2 Visual "card-in-card → none" (D8): no card (a radius with a fill or a four-sided border) inside another card on the default render' },
  ...(plan ? [
    { family: 'glance', armedAt: 'S3', present: true, closed: glanceClosed, why: '(e) the closed glance card on the first screen' },
    { family: 'verdict-truncation', armedAt: 'S3', why: '(e) verdict untruncated: scrollWidth ≤ clientWidth, last glyph inside the card' },
  ] : [
    { family: 'glance', armedAt: 'S3', present: false, why: 'no glance without a plan (weather comes from the plan)' },
  ]),
]

export const STATES = [
  {
    name: 'v2-frost', fixture: 'busyfull', clock: S924, prefs: 'prefs.default.json',
    proves: 'Protect open (frost), Needs care open (small), frost/cue in card, verdict untruncated',
    checks: [
      ...common(),
      { family: 'section-open-set', armedAt: ['S4', 'S5', 'S6'], order: ['protect', 'care', 'harvest', 'resting'], open: ['protect', 'care'], closed: ['harvest', 'resting'] },
      { family: 'collapsed-mounted', armedAt: ['S4', 'S5', 'S6'] },
      { family: 'visibility', armedAt: ['S4', 'S5'] },
      { family: 'header-text', armedAt: ['S4', 'S5', 'S6'], counts: { protect: 5, care: 233, resting: 9 }, why: 'fixture facts: cold 5; water 168 + feed 58 + check 7; dormant 9' },
      // S3 split: the glance, its cue + frost lines, the bar and the WHOLE verdict (every glyph painted, inside its
      // clip) are S3's and arm now; Protect's header, pick link, rows and the Needs care ceiling wait for S5.
      { family: 'first-screen', armedAt: 'S3', mustContain: ['today-glance', 'weather-cue-line', 'frost-alert-line', 'today-jumpbar'], mustShowText: ['today-verdict'], why: '(e) v2-frost, the S3 half: the closed glance card with both alert lines, the bar, and a verdict nothing cuts off' },
      // S5 recorded the §11.0 E4 estimate (+60, "est., to be recorded"): measured 797 on the S5 tree (Roboto pin,
      // 426×836) — the glance card with the cue and the two-line frost line is 223 (S3), Protect's band 48 + pick link
      // 44 + five 48px rows, one of them the three-line "Tuberous Begonia (bronze-leaf, hanging)" at 76. +72 = 800.
      { family: 'first-screen', armedAt: ['S3', 'S5'], mustContain: ['today-sec-protect', 'protect-pick'], minCount: { 'protect-row': 3 }, headerTopMax: { care: 'FIRST_SCREEN+72' }, why: '(e) v2-frost; E4 recorded at S5 (measured 797)' },
      // S3 split: the bar carries a chip for every section on the page, in the fixed order (at S3: Water / Feed /
      // Check — Needs care is the only chip-bearing section built); the full set waits for Protect (S5) and Harvest (S6).
      { family: 'jumpbar', armedAt: 'S3', present: true, chipsOfPresent: ['protect', 'water', 'feed', 'check', 'harvest'] },
      { family: 'jumpbar', armedAt: ['S3', 'S5', 'S6'], present: true, chips: ['protect', 'water', 'feed', 'check', 'harvest'] },
      // S3 (new family, named in KILLER_FAMILIES by S0): every chip 48 tall, numbers only on the work chips, and at
      // 200% text (WCAG 1.4.4; Android font scaling) every chip still reachable inside the strip.
      { family: 'chip-census', armedAt: 'S3', why: 'chips ≥ 48px; numbers only on Protect/Water/Feed/Check; at 200% text the strip scrolls (overflow-x auto) and no chip is stranded past its edge' },
      // Integration S3 × S4 (first run of this family — neither lane alone could arm it): + 0.78rem, an INHERITED
      // line like the cue/frost lines' 0.84rem (plan §4 "the unchanged … lines keep their own"): V1's
      // FeedSuppressedList (CareNeeded.jsx), reused unchanged at the foot of Needs care (REGIONS
      // care-feed-suppressed), prints 0.78rem. Measured: with only that component's 0.78rem → 0.82rem the census
      // passed on v2-frost, so it is the one source. Restyling the line for V2 is a design call, not the gate's.
      // Integration 2 (orchestrator, 2026-09-29) — plan §9.1(l)'s cap of 4 fingerprints is replaced by an IDENTITY
      // check, in this commit, with this reason: the glance card and the row card are ONE material (white, 1px
      // P.border, radius 10 — measured on the merged S4g + S5 + S6 page, 2026-09-29), so the design's four surfaces
      // (glance card, bar, band, row card) give THREE distinct fingerprints, and a count of 4 let one extra treatment
      // through (extraCardFingerprint survived the S3 + S4 matrix twice). Every section-level container fingerprint
      // on v2-frost must now be one of these, verbatim as the gate measures them; a new surface is added here, in the
      // commit that adds it, with its reason. (Harvest's bare watch rows add a hairline fingerprint when Harvest is
      // open — v2-remembered — outside this census, which runs on v2-frost's default render only.)
      { family: 'visual-census', armedAt: ['S3', 'S4'], surfaces: {
        'glance card + row card (one material)': 'rgb(255, 255, 255) | 1px solid rgb(212, 201, 190) | 10px | none',
        'jump bar': 'rgb(248, 245, 240) | 0px none rgb(0, 0, 0) | 0px | none',
        'section band': 'rgb(230, 240, 232) | 0px none rgb(31, 81, 56) | 7px | none',
      }, fontSizesExtra: ['1.3rem', '36px', '23px', '0.84rem', '0.78rem'], why: '(l) every section-level container fingerprint on busyfull is one of the design surfaces (identity, not a count)' },
      { family: 'weather-once', armedAt: 'S3', why: 'MF2: with the glance OPEN, exactly one today-weather and no repeated hi/lo text' },
      // S4 split the §9.1 phase list: the Water chip is S3's, so the chip step arms with S3 AND S4. Needs care is
      // OPEN at the ready point on this state (the small-pot trigger), so the chip cannot flip today-sec-care's
      // aria-expanded (the step VOIDed as first written); what it always moves is the Water task filter's
      // pre-select (aria-pressed false → true, S3 → S4 through the visit record), so that is the step's flip.
      // Counts are of VISIBLE rows (§9.1 (d) "every row under an open body passes shown()"), exact — with the
      // Water filter on, as §9.1's phases run (tap the Water chip, open Bag Area, show the cohort).
      // S4's lane also carried these phases without the chip (armed at S4 alone); merged, a second run on the
      // same page would re-tap Bag Area CLOSED, so this one run carries them.
      { family: 'interaction', armedAt: ['S3', 'S4'], steps: [
        { tap: 'jump:water', flip: 'task-filter:Water' },
        { tap: 'spot:Bag Area', flip: 'care-spot:Bag Area' },
        { tap: 'cohort:Bag Area', flip: 'care-cohort:Bag Area' },
        { scroll: '2*FIRST_SCREEN' },
        { scroll: 0 },
      ], counts: { afterSpot: { 'care-exceptions-row': 8, 'care-cohort': 1 }, afterCohort: { 'care-cohort-row': 20, 'care-show-more': 1 } }, why: '(d) Bag Area: 8 exception rows + 1 cohort line; disclosed: 20 rows + "Show 69 more"' },
      { family: 'header-text', armedAt: 'S4', counts: { care: 233 }, why: 'S4-scoped: water 168 + feed 58 + check 7' },
      { family: 'count-invariant', armedAt: 'S4', why: 'S4-scoped §2.4: the Needs care header count = Σ spot counts, no filter' },
      // S3: each REGIONS_V2 row arms with its OWN slice (the gate skips a row whose armedAt has not landed), so
      // the glance's rows count from S3 and S4–S6's rows join as they land. S4's lane carried its own S4-scoped
      // copy of this check (armed at S4 alone); merged, the two counted the same rows, so this one is kept.
      { family: 'region-headcount', armedAt: 'S3', why: 'every ARMED REGIONS_V2 row owned by v2-frost, counted after its owner is opened' },
      // S4g (§2.6 / §5.6): each filter change — a task chip, a spot chip, either Clear, a jump chip's pre-select —
      // says its result ONCE through today-status; opening and closing a spot (a re-render, no filter change) says
      // nothing. Words on the 09-24 plan (the plan's own example first). Files `announce` (the words) and
      // `announce-once` (writes counted by a MutationObserver). `jump` is S3's chip, so the check names S3 too.
      { family: 'announce', armedAt: ['S3', 'S4g'], steps: [
        { press: 'tasks:Water', say: 'Needs care: Water, 168 in 8 spots.' },
        { press: 'tasks:Feed', say: 'Needs care: Water and Feed, 226 in 9 spots.' },
        { quiet: 'spot:Trough' },
        { clear: 'tasks', say: 'Needs care: everything, 233 in 9 spots.' },
        { press: 'spots:Bag Area', say: 'Needs care: Bag Area, 141 in 1 spot.' },
        { clear: 'spots', say: 'Needs care: everything, 233 in 9 spots.' },
        { jump: 'check', say: 'Needs care: Check, 7 in 2 spots.' },
      ], why: '§2.6: "Needs care: Water, 168 in 8 spots." — once per filter change, not per render' },
      // S4g (§2.5 + §5.5): Drive-Shade's Water all (5 logged), then Not today on every spot left — the header stays and
      // reads the emptied wording (logged today = done items + store = 5 here; rain = busyfull's 70 rain_skipped), no
      // count, focus on it. Runs LAST on this state (it leaves Needs care empty).
      { family: 'caught-up', armedAt: 'S4g', water: 'Drive-Shade', title: 'Needs care · all caught up', summary: '5 logged today, 70 covered by rain', why: '§2.5: an emptied Needs care reads "Needs care · all caught up" with "N logged today, M covered by rain"; §5.5 focus to its header' },
      // S6-scoped: busyfull carries a composable harvest batch AND the watch list, so Harvest exists between Needs care
      // and Resting; nothing opens it (never a trigger). Its header names, never counts; the Sow row is the door alone.
      { family: 'section-open-set', armedAt: ['S4', 'S6'], orderOf: ['care', 'harvest', 'resting'], closed: ['harvest', 'resting'], why: 'S6-scoped: Harvest between Needs care and Resting, closed by default' },
      { family: 'header-text', armedAt: 'S6', noCount: ['harvest'], summaries: { harvest: '20 picks · logged an hour ago · check Palla Rossa Mavrik Radicchio, Gourmet Blend Beets, Red Acre Cabbage…' }, sowRow: 'All sow windows ›', why: 'S6: the Harvest header names the compose band\'s picks line and the watch band\'s own first three (no count, no denominator); the Sow link row is exactly its door while the 2027 freeze holds (09-24 has two dated engine lines to hide)' },
      { family: 'owner-floors', armedAt: 'S6', owners: ['glance', 'care', 'harvest', 'resting'], why: 'S6: each owner of a moved region, opened from the default render, is at least its recorded height — a region deleted inside it (dropRegionInOwner) shortens it' },
    ],
  },
  {
    name: 'v2-busy', fixture: 'busy', clock: S924, prefs: 'prefs.default.json',
    proves: 'Protect open (chill, first seen), Needs care open (small)',
    checks: [
      ...common(),
      { family: 'section-open-set', armedAt: ['S4', 'S5', 'S6'], order: ['protect', 'care', 'harvest', 'resting'], open: ['protect', 'care'], closed: ['harvest', 'resting'] },
      { family: 'collapsed-mounted', armedAt: ['S4', 'S5', 'S6'] },
      // S3 split: the glance and the bar arm now; Protect and the R16 ceiling wait for S5.
      { family: 'first-screen', armedAt: 'S3', mustContain: ['today-glance', 'today-jumpbar'], mustShowText: ['today-verdict'], why: '(e) v2-busy, the S3 half: the glance and the bar on the first screen' },
      // S5 — R16's 668 (from §1.2's ≈ 658 est.) is MISSED by 5px on the real fixture: measured 673, because the glance
      // card is 148 (est. 145) and the three-line "Tuberous Begonia (bronze-leaf, hanging)" row is 76 (est. 66 — at the
      // plan's own ≈160px column no two-line wrap of that name exists). Re-stated as the claim R16 makes, the Needs
      // care header WHOLE on the first screen: top ≤ FIRST_SCREEN − 48 (the resolver sums '+' terms). FLAGGED for the
      // orchestrator in build-s5.md — a ruling's number moved, with the measurement, not quietly.
      { family: 'first-screen', armedAt: ['S3', 'S5'], mustContain: ['today-sec-protect'], allRows: 'protect-row', headerTopMax: { care: 'FIRST_SCREEN+-48' }, why: '(e) v2-busy: bar, Protect header + all rows, the Needs care header whole on the first screen (R16 re-stated at S5: measured 673)' },
      { family: 'group-water-all', armedAt: 'S4', group: 'Outside', expectN: 154, run: true, why: 'MF3: group Water all — spots shrink to done lines, "Outside · watered N · Undo", accessible name "Water all N outside"; its ONE Undo deletes exactly the created ids' },
      { family: 'section-open-set', armedAt: 'S4', orderOf: ['care', 'resting'], open: ['care'], closed: ['resting'], why: 'S4-scoped: Needs care opens on the small-pot trigger, before Resting' },
      { family: 'collapsed-mounted', armedAt: 'S4', why: 'S4-scoped: closed sections AND closed spots mount no rows' },
      { family: 'visibility', armedAt: 'S4', why: 'S4-scoped: the open Needs care shows its groups and spots, each ≥ 48px' },
      { family: 'header-text', armedAt: 'S4', counts: { care: 233 }, careSummary: '8 tray cells due · 9 spots', spotNotToday: true, why: 'S4-scoped: header count, the SF8 summary, a Not today on every spot (D6)' },
      { family: 'count-invariant', armedAt: 'S4', why: 'S4-scoped §2.4: the Needs care header count = Σ spot counts, no filter' },
      { family: 'region-headcount', armedAt: 'S4', why: 'S4-scoped: today-care, care-heading, care-group-bulk + care-spot-bulk on the default render' },
      // S4g (MF3 "failures stay per spot 'Not logged · Retry'"): the Outside Water all with its first `fail` writes
      // failing (the harness answers them 503, __h.failPosts). The group line counts what landed; every touched spot
      // reads its OWN share (done line or "Watered N"); each spot holding a failure stays a CLOSED row with "N not
      // logged" + Retry and no Water all; focus lands on the first Retry (§5.5); the Retries complete the run (group
      // line back to the full N) and its ONE Undo returns the page to its rest counts. Families filed: spot-retry
      // (the round trip), header-text (the words on the rows, the header count after Undo), group-water-all (a spot's
      // own share on its done line), retry-focus (§5.5), announce (the result in the status region).
      { family: 'spot-retry', armedAt: 'S4g', group: 'Outside', fail: 2, why: 'MF3: a failed write stays on its spot — "N not logged" + Retry on the closed row, out of Water all; Retry completes the run; one Undo' },
      // S6-scoped: busy has the watch list but no fresh harvest batch — Harvest is the watch band alone.
      { family: 'section-open-set', armedAt: ['S4', 'S6'], orderOf: ['care', 'harvest', 'resting'], closed: ['harvest', 'resting'], why: 'S6-scoped: Harvest between Needs care and Resting, closed by default' },
      { family: 'header-text', armedAt: 'S6', noCount: ['harvest'], summaries: { harvest: 'check Palla Rossa Mavrik Radicchio, Gourmet Blend Beets, Red Acre Cabbage…' }, sowRow: 'All sow windows ›', why: 'S6: names, no count; the Sow link row is exactly its door while the 2027 freeze holds' },
      // OPS-TODAYV2GATECOVERAGE-001 (review-dbl-recut-gatefix-delta-20261006 IMPORTANT-1): flows driven by TRUSTED taps
      // (CDP input, event.isTrusted seen on the page), each from a fresh load of this state. Files `trusted-taps` (what
      // the page shows) and `post-once` (what the wire saw). Not armed, known open: Feed all's missing done line and
      // Undo (MINOR-4); the `alive` gap under forced timing (Q4).
      { family: 'trusted-taps', armedAt: 'S4', flow: 'away-back', spot: 'Drive-Shade', why: 'a Water all left mid-run that ends while Today is away: Back shows "<Spot> · watered N" with its Undo, every planting posted once, the Undo deletes N' },
      { family: 'trusted-taps', armedAt: 'S4', flow: 'close-reopen', spot: 'Drive-Shade', why: 'a Water all whose section is closed mid-run and reopened after it ends: the line and its Undo' },
      { family: 'trusted-taps', armedAt: 'S4', flow: 'row-tap', spot: 'Drive-Shade', why: 'D11: a one-row Water leaves "<plant> · watered" + Undo, the spot offers "the other N−1"; its Undo deletes the one event' },
      { family: 'trusted-taps', armedAt: 'S4', flow: 'two-spots', spots: ['Bag Area', 'Drive-Shade'], why: 'two spots\' Water all in flight together: both land with their own line and Undo, no planting posted twice' },
      { family: 'trusted-taps', armedAt: 'S4', flow: 'feed-all', why: 'Feed all: "Logged N in <product>." in the status region, every planting posted once' },
    ],
  },
  {
    // MF1 supersedes §9.1's "both closed (negative)": the acks are dated the day BEFORE, so they no longer
    // hold. Needs care re-opens on its trigger (small); Protect stays closed because its chill plants were
    // first seen yesterday (chill first-seen is unchanged by MF1), so no trigger fires and Layer 1's close holds.
    name: 'v2-busy-seen', fixture: 'busy', clock: S924, prefs: 'prefs.busy-seen.json', local: { todaySeen: { date: '2026-09-23' } },
    proves: 'MF1: an ack dated yesterday does not hold today — Needs care re-opens (small); Protect stays closed (chill already seen)',
    checks: [
      ...common(),
      // S5: `order` → `orderOf`. The busy fixture also carries Resting (9 dormant), and Harvest joins at S6, so the
      // strict whole-page order can never be [protect, care]; the pair's relative order is the claim.
      { family: 'section-open-set', armedAt: ['S4', 'S5'], orderOf: ['protect', 'care'], open: ['care'], closed: ['protect'] },
    ],
  },
  {
    name: 'v2-closed-today', fixture: 'busy', clock: S924, prefs: 'prefs.closed-today.json', local: { todaySeen: { date: '2026-09-24' } },
    proves: 'MF1 (new state): a close acked today holds for the rest of today — both stay closed',
    checks: [
      ...common(),
      // S5: `orderOf`, for the reason given on v2-busy-seen.
      { family: 'section-open-set', armedAt: ['S4', 'S5'], orderOf: ['protect', 'care'], open: [], closed: ['protect', 'care'] },
    ],
  },
  {
    name: 'v2-routine', fixture: 'busy', grafts: ['routine'], clock: S924, prefs: 'prefs.default.json',
    proves: 'routine watering never opens Needs care',
    checks: [...common(), { family: 'section-open-set', armedAt: ['S4', 'S5'], closed: ['care'], open: ['protect'] }],
  },
  {
    name: 'v2-hot', fixture: 'busy', grafts: ['routine', 'hot'], clock: S924, prefs: 'prefs.default.json',
    proves: 'a hot day (≥ 88°F) with a container due opens Needs care',
    checks: [...common(), { family: 'section-open-set', armedAt: 'S4', open: ['care'] }],
  },
  {
    name: 'v2-never', fixture: 'busy', grafts: ['routine', 'never'], clock: S924, prefs: 'prefs.default.json',
    proves: 'a never-watered planting opens Needs care',
    checks: [...common(), { family: 'section-open-set', armedAt: 'S4', open: ['care'] }],
  },
  {
    name: 'v2-freeze', fixture: 'busy', grafts: ['freeze'], clock: S924, prefs: 'prefs.default.json',
    proves: 'spot cover rows; the urgent verdict phrase; the pick link',
    checks: [
      ...common(),
      { family: 'section-open-set', armedAt: 'S5', open: ['protect'] },
      { family: 'first-screen', armedAt: ['S3', 'S5'], mustContain: ['protect-pick'] },
      // OPS-TODAYV2GATECOVERAGE-001: v2-frost has five single cards and no Cover all; this state has the spot rows.
      // Not armed, known open: a Cover all left mid-run draws no done line on Back (MINOR-1, same on prod).
      { family: 'trusted-taps', armedAt: 'S5', flow: 'cover-all', spot: 'Trough', why: 'Cover all round trip by trusted taps: "<Spot> · covered N" with ONE Undo, the Undo, the button back; no cover posted twice' },
    ],
  },
  {
    // SF4: rebuilt through the e6dbd74 gate (build-v2-grafts.mjs) — 17 beds moved to rain_skipped, 2 declared
    // carve-outs stay. v2-grafts.json `bedwait.expect` carries the numbers the page must show (Outside Water all 135).
    name: 'v2-bedwait', fixture: 'busy', grafts: ['bedwait'], clock: S924, prefs: 'prefs.default.json',
    proves: 'In-Ground "Beds wait for rain", no button; Outside Water all 135',
    checks: [
      ...common(),
      { family: 'header-text', armedAt: 'S4', buttons: { 'care-group-bulk:Outside': 'Water all 135' }, spotNoButton: ['In-Ground'] },
      { family: 'group-water-all', armedAt: 'S4', group: 'Outside', expectN: 135, run: true },
    ],
  },
  {
    name: 'v2-quiet', fixture: 'quiet', clock: S924, prefs: 'prefs.default.json',
    proves: 'text floors; no chip bar; the care done line; the whole page inside the first screen',
    checks: [
      ...common(),
      { family: 'jumpbar', armedAt: 'S3', present: false },
      { family: 'first-screen', armedAt: 'S2', mustContain: ['care-empty', 'cultivation-lead'], wholePage: true },
    ],
  },
  {
    name: 'v2-noplan', fixture: 'noplan', clock: S924, prefs: 'prefs.default.json',
    proves: 'no glance; the no-plan sentence',
    checks: [
      ...common({ plan: false }),
      { family: 'first-screen', armedAt: 'S2', mustContain: ['today-noplan-card'] },
    ],
  },
  // S5: + region-headcount, so the REGIONS row this state owns (storage-deadline-alert → the Heads-up body) is counted
  // at all: the family only runs on a state that carries a check of it.
  { name: 'v2-storage-open', fixture: 'storage', redate: '2026-09-28', clock: AT('2026-09-28'), prefs: 'prefs.default.json', proves: 'Heads-up opens on the first day of the window',
    checks: [...common(), { family: 'section-open-set', armedAt: 'S5', open: ['headsup'] }, { family: 'first-screen', armedAt: 'S5', mustContain: ['today-sec-headsup'] }, { family: 'region-headcount', armedAt: 'S5' }] },
  { name: 'v2-storage-mid', fixture: 'storage', clock: AT('2026-10-01'), prefs: 'prefs.default.json', proves: 'Heads-up closed mid-window (negative)',
    checks: [...common(), { family: 'section-open-set', armedAt: ['S5', 'S6'], closed: ['headsup', 'putup'] }, { family: 'first-screen', armedAt: 'S5', mustContain: ['today-sec-headsup'] },
      // S6-scoped: the storage state's four jars (storage-grafts.json use_soon) are the one fixture with a Put-Up shelf.
      // This state had no region-headcount check, so REGIONS' putup-use-soon row (v2-storage-mid, S6) was never counted.
      { family: 'section-open-set', armedAt: 'S6', closed: ['putup'], why: 'S6-scoped: From your Put-Up exists and never opens by itself' },
      { family: 'header-text', armedAt: 'S6', noCount: ['putup'], summaries: { putup: 'Summer Squash (past date) · Plum · Basil · Basil' }, why: 'S6: the use-soon slice by name, past date marked, no count (plan §1.5)' },
      { family: 'region-headcount', armedAt: 'S6', why: 'S6: putup-use-soon counted inside Put-Up once opened' },
      { family: 'owner-floors', armedAt: 'S6', owners: ['putup'], why: 'S6: Put-Up opened is at least its recorded height' }] },
  { name: 'v2-storage-deadline', fixture: 'storage', redate: '2026-10-08', clock: AT('2026-10-08'), prefs: 'prefs.default.json', proves: 'deadline ≤ 2 days: open, warn plate',
    checks: [...common(), { family: 'section-open-set', armedAt: 'S5', open: ['headsup'] }, { family: 'first-screen', armedAt: 'S5', mustContain: ['today-sec-headsup'] }] },
  { name: 'v2-storage-past', fixture: 'storage', redate: '2026-10-12', clock: AT('2026-10-12'), prefs: 'prefs.default.json', proves: 'grace phase: past copy, closed',
    checks: [...common(), { family: 'section-open-set', armedAt: 'S5', closed: ['headsup'] }] },
  {
    // SF6: household stays opt-in per person, so the lens is switched on for this device before mount.
    name: 'v2-household', fixture: 'busyhh', clock: S924, prefs: 'prefs.default.json', local: { showOthers: true },
    proves: '"Jen\'s care · 15" closed, never auto-opens; the shared skip set',
    // S6: + her summary (task counts, plan §1.6), and a region-headcount — this state had none, so REGIONS'
    // today-household row (v2-household, S6) was never counted. The shared skip set is a unit test
    // (TodayV2.household.test.jsx), not a geometry.
    checks: [...common(), { family: 'section-open-set', armedAt: 'S6', closed: ['hh-member_j'] }, { family: 'header-text', armedAt: 'S6', counts: { 'hh-member_j': 15 }, summaries: { 'hh-member_j': 'Water 8 · Feed 7' } },
      { family: 'region-headcount', armedAt: 'S6', why: 'S6: today-household on the default render (her section closed)' }],
  },
  {
    name: 'v2-remembered', fixture: 'busy', clock: S924, prefs: 'prefs.remembered.json',
    proves: 'Layer 1 open applied (harvest, resting) across days',
    // S2 builds the Resting band (count, names, explainer), so its half of this state arms at S2: the one S2
    // state where a SERVER value decides the open set — without it a dropped prefs read (prefsClientDark,
    // skipPrefsFetch) would red nothing but the instrument. Harvest waits for its band (S6).
    checks: [...common(),
      { family: 'section-open-set', armedAt: 'S2', open: ['resting'], why: 'the server\'s remembered open, read at the visit start' },
      { family: 'section-open-set', armedAt: ['S2', 'S6'], open: ['harvest', 'resting'] }],
  },
  {
    // MF1: the ack carries no ids any more ({t} only, dated today) — escalation chill → frost still re-opens.
    name: 'v2-remembered-urgent', fixture: 'busyfull', clock: S924, prefs: 'prefs.remembered-urgent.json',
    proves: 'a chill ack does not hold against tonight\'s frost: escalation re-opens Protect',
    checks: [...common(), { family: 'section-open-set', armedAt: 'S5', open: ['protect'] }],
  },
  {
    name: 'v2-remembered-conflict', fixture: 'busy', clock: S924, prefs: 'prefs.remembered-conflict.json', prefsDelayMs: 300,
    // S4: the care trigger exists now (small), and a close with no ack holds nothing (MF1) — the mirror's close
    // names the reason it was made against, as a real close made while the trigger held the section open would.
    local: { mirror: { care: { open: false, at: '2026-09-24', ack: { r: 'small' } } } },
    proves: 'the mirror wins this visit; nothing above the fold moves between ready and +2.5 s',
    checks: [...common(), { family: 'section-open-set', armedAt: 'S2', closed: ['care'] }, { family: 'remembered-conflict', armedAt: 'S2' }],
  },
  {
    name: 'v2-stale', fixture: 'busy', grafts: ['stale'], clock: S924, prefs: 'prefs.default.json',
    proves: 'a stale plan shows the stale marker and opens nothing',
    checks: [...common(), { family: 'stale-marker', armedAt: 'S3' }, { family: 'section-open-set', armedAt: ['S4', 'S5'], open: [] }],
  },
]

// ── REGIONS (§9.1 map: v1 id → v2 owner / state). "open" = the gate opens the owner, then pins count ≥ 1.
export const REGIONS_V2 = [
  { id: 'today-title', owner: 'title row', state: '*', armedAt: 'S2' },
  { id: 'today-date', owner: 'date', state: '*', armedAt: 'S2' },
  { id: 'today-weather', owner: 'glance', open: 'glance', state: 'v2-frost', armedAt: 'S3' },
  // S3: `closed` — counted with the glance CLOSED (the gate closes it first), since "visible closed" is the claim.
  { id: 'weather-cue-line', owner: 'glance (visible closed)', closed: 'glance', state: 'v2-frost', armedAt: 'S3' },
  { id: 'frost-alert-line', owner: 'glance (visible closed)', closed: 'glance', state: 'v2-frost', armedAt: 'S3' },
  ...['drought-line', 'leaf-wetness-line', 'today-basis-stamp', 'care-rain-note', 'care-drought-list'].map((id) => ({ id, owner: 'glance details', open: 'glance', state: 'v2-frost', armedAt: 'S3' })),
  { id: 'today-substrate-note', owner: 'Needs care, Feed filter', open: 'care', filter: 'feed', state: 'v2-frost', armedAt: 'S4' },
  { id: 'today-care', owner: 'Needs care section', state: 'v2-busy', armedAt: 'S4' },
  { id: 'care-group-bulk', owner: 'Outside group label (MF3)', state: 'v2-busy', armedAt: 'S4' },
  { id: 'care-spot-bulk', owner: 'a spot row\'s Water all', state: 'v2-busy', armedAt: 'S4' },
  { id: 'care-heading', owner: 'Needs care band', state: 'v2-busy', armedAt: 'S4' },
  // S4: a band's one-line summary is a region of its own (D2 "a header with a count and a one-line summary"):
  // a 2-line band is still the 48px min-height band, so no geometry family can see the line vanish.
  { id: 'section-summary', owner: 'a section band\'s one-line summary', state: 'v2-busy', armedAt: 'S4' },
  { id: 'care-cap-note', owner: 'disclosed cohort in Bag Area', open: 'cohort:Bag Area', state: 'v2-frost', armedAt: 'S4' },
  { id: 'care-show-more', owner: 'disclosed cohort in Bag Area (control)', open: 'cohort:Bag Area', state: 'v2-frost', armedAt: 'S4' },
  { id: 'care-moist', owner: 'plant rows in an opened spot (control)', open: 'spot:Bag Area', state: 'v2-frost', armedAt: 'S4' },
  // REMOVED by D3/D7 — declared, not dropped: its replacements carry the one-tap path.
  { id: 'care-bulk-chips', removed: true, replacedBy: ['care-group-bulk', 'care-spot-bulk'], state: 'v2-frost', armedAt: 'S4' },
  { id: 'care-dormant', owner: 'Resting', open: 'resting', state: 'v2-frost', armedAt: 'S6' },
  { id: 'care-feed-suppressed', owner: 'foot of Needs care', open: 'care', state: 'v2-frost', armedAt: 'S4' },
  { id: 'care-empty', owner: 'quiet done line', state: 'v2-quiet', armedAt: 'S2' },
  { id: 'today-watch-band', owner: 'Harvest', open: 'harvest', state: 'v2-frost', armedAt: 'S6' },
  { id: 'compose-harvest-band', owner: 'Harvest', open: 'harvest', state: 'v2-frost', armedAt: 'S6' },
  { id: 'cultivation-lead', owner: 'Sow link row', state: '*', armedAt: 'S6' },
  { id: 'today-household', owner: 'household sections', state: 'v2-household', armedAt: 'S6' },
  { id: 'today-noplan-card', owner: 'the no-plan sentence', state: 'v2-noplan', armedAt: 'S2' },
  { id: 'storage-deadline-alert', owner: 'Heads-up body', state: 'v2-storage-open', armedAt: 'S5' },
  // S5: a NEW anchor, not a v1 region (as S4's section-summary): the frost-night pick link inside Protect (§1.1). Counted
  // after its owner is opened, so the link going missing is seen by a second family beside the first screen.
  { id: 'protect-pick', owner: 'Protect tonight, frost / freeze nights (§1.1)', open: 'protect', state: 'v2-frost', armedAt: 'S5' },
  { id: 'putup-use-soon', owner: 'Put-Up body', open: 'putup', state: 'v2-storage-mid', armedAt: 'S6' },
]
export const NEW_ANCHORS = ['today-glance', 'today-jumpbar', 'today-sec-<key>', 'care-group', 'care-spot', 'care-spot-panel', 'care-exceptions', 'care-cohort', 'care-done-line', 'protect-row', 'protect-pick', 'today-status',
  // S4g: a spot's failure line and its Retry (MF3).
  'care-spot-failed', 'care-spot-retry']

// ── THE SHELL ENTRY (today-shell-v2.mjs over tests/harness/todayshell.*) ───────────────────────────────────
// The platform half of §9.1: what only the real TopChrome, the BottomNav band and the real page-scroll manager
// can show. `shell-instrument` is armed now: it is the shell itself (S0's own deliverable).
export const SHELL = [
  { family: 'shell-instrument', armedAt: 'S0', state: 'v2-busy', why: 'TopChrome paints at BAR_H, the nav band writes --bottom-nav-height, the page band is FIRST_SCREEN, scrollRestoration is manual (the manager is on), the members roster is production-shaped, the prefs GET is observed, and the harness calls usePageScrollManager exactly as AppShell does' },
  // S3: armed at S3 + S4. The bar can only pin, and a jump can only land a header under it, on a page taller than
  // one screen; at S3 alone every v2 state ends above the fold (measured, S3 build report), and S4's Needs care
  // body — opened by the Water chip, the first step of both checks — is what makes v2-frost long enough.
  { family: 'sticky', armedAt: ['S3', 'S4'], state: 'v2-frost', why: '(f) after the Water jump, scrolled to 2 × FIRST_SCREEN (clamped to the page): bar top = TopChrome bottom ± 0.5, shown(), height 57 ± 1, elementFromPoint(bar centre) inside the bar; back at 0 exactly one bar, in flow (in-view chip checks dropped with the scroll-spy, §13 Simplify 5)' },
  { family: 'jump-landing', armedAt: ['S3', 'S4'], state: 'v2-frost', why: '(g) per chip: target open, header top ∈ [bar bottom, bar bottom + 8] once the scroll settles, activeElement = header, no horizontal scroll. Integration S3 × S4: a landing the page is too short for (the Feed / Check pre-select shrinks Needs care) stops at the page end with the header wholly on screen below the bar; at least one jump per run must land strictly' },
  // Integration S3 × S4: the focus a jump leaves, judged apart from the landing — the second, independent killer for
  // jumpNoOffset (2.4.11: the focused header wholly hidden, hit-tested) and noFocusAfterJump (2.4.3: a real Tab does
  // not continue inside the section). Measured over the same pass of chip jumps as jump-landing.
  { family: 'jump-focus', armedAt: ['S3', 'S4'], state: 'v2-frost', why: 'per chip: the focused header is not wholly hidden by TopChrome or the bar (WCAG 2.4.11, hit-tested over the header), and one real Tab continues inside the jumped-to section (WCAG 2.4.3; R5 — TalkBack and the keyboard carry on from the header)' },
  { family: 'back-restore', armedAt: 'S4', state: 'v2-frost', why: '(m) open Bag Area → tap "Red Acre Cabbage" → Back → Bag Area open, same row top within 1 px' },
]

// ── MUTANT KILLER FAMILIES (§9.1) and the trigger TABLE that replaced the trigger-predicate mutants ──────
export const KILLER_FAMILIES = ['section-open-set', 'collapsed-mounted', 'visibility', 'header-text', 'first-screen', 'sticky', 'jump-landing', 'verdict-truncation', 'chip-census', 'prefs-instrument', 'region-headcount', 'visual-census', 'back-restore', 'jump-focus',
  // S4g: MF3's failure round trip, §5.5's focus after it, §5.6's status region (its words, and once per change),
  // §2.5's emptied header and §5.5's focus when a section empties.
  'spot-retry', 'retry-focus', 'announce', 'announce-once', 'caught-up', 'empty-focus',
  // OPS-TODAYV2GATECOVERAGE-001: the flows driven by trusted taps — what the page shows, and what the wire saw.
  'trusted-taps', 'post-once',
  // S6: a section (or the glance) opened from the default render is at least its recorded height.
  'owner-floors',
  // Integration 2: no card inside a card (plan-v2 Visual, D8).
  'card-nesting']

// §13 Simplify 3: the trigger-predicate mutants (ignoreRemembered, rememberedBeatsUrgent, staleAutoOpens,
// chillOpensEveryNight, headsupAlwaysOpen, householdAlwaysOpen, glanceOpenByDefault) are no longer real-Chrome
// mutants: each is a cell of a table-driven unit test of src/lib/todayV2/triggers.js (S5 writes the module and
// the test that reads this table). openAll / openNone stay as real-Chrome canaries (todayMutantsV2.mjs).
// Each cell: inputs → the open set it must produce. `killedMutant` names the mutant the cell replaces.
// ── FILTER × ACTION CELLS (review 4160.2 IMPORTANT-4; the orchestrator's call, 2026-09-29: pinned AS THEY BEHAVE,
// no change). No gate state reaches either cell. Each predicate is pinned by the page test titled with its `cell` in
// src/__tests__/TodayV2NeedsCare.test.jsx (real TodayV2, Dave's 09-24 plan); changing either is a design change,
// made here and there in one commit.
export const FILTER_ACTION_CELLS = [
  {
    cell: 'spot filter × group Water all',
    predicate: 'Under a spot filter the group Water all counts only the spots the filter shows ("Water all 48 outside" under Trough + In-Ground). Its result is ONE group line, "Outside · watered N" with one Undo, that replaces the group button for the rest of the visit, filter cleared or not; every other spot of the group keeps its own Water all.',
  },
  {
    cell: 'task filter × Not today',
    predicate: 'Not today on a spot skips only the rows of the tasks the filter shows (plan §2.5): under Water, the spot\'s feed and check rows stay due, and the spot comes back live with them once the filter is cleared.',
  },
]

export const TRIGGER_CELLS = [
  { cell: 'frost night opens Protect', plan: { lowRaw: 41.8, frostTonight: true, coldLevels: ['protect'] }, ack: null, expectOpen: ['protect'], killedMutant: 'openNone' },
  { cell: 'chill first seen opens Protect', plan: { lowRaw: 47, coldLevels: ['protect'] }, seen: 'unset', ack: null, expectOpen: ['protect'], killedMutant: 'openNone' },
  { cell: 'chill seen yesterday does not re-open', plan: { lowRaw: 47, coldLevels: ['protect'] }, seen: 'yesterday', ack: null, expectOpen: [], killedMutant: 'chillOpensEveryNight' },
  { cell: 'optional-only night never opens', plan: { lowRaw: 52, coldLevels: ['optional'] }, ack: null, expectOpen: [], killedMutant: 'openAll' },
  { cell: 'chill ack today holds (MF1)', plan: { lowRaw: 47, coldLevels: ['protect'] }, seen: 'today', ack: { section: 'protect', at: 'today', t: 'chill' }, expectOpen: [], killedMutant: 'ignoreRemembered' },
  { cell: 'chill ack yesterday does not hold (MF1)', plan: { lowRaw: 47, coldLevels: ['protect'] }, seen: 'today', ack: { section: 'protect', at: 'yesterday', t: 'chill' }, expectOpen: ['protect'], killedMutant: 'rememberedBeatsUrgent' },
  { cell: 'escalation chill → frost re-opens the same day', plan: { lowRaw: 38, coldLevels: ['protect'] }, ack: { section: 'protect', at: 'today', t: 'chill' }, expectOpen: ['protect'], killedMutant: 'rememberedBeatsUrgent' },
  { cell: 'hardfreeze at 33', plan: { lowRaw: 33, coldLevels: ['protect'] }, ack: { section: 'protect', at: 'today', t: 'frost' }, expectOpen: ['protect'], killedMutant: 'rememberedBeatsUrgent' },
  { cell: 'stale plan opens nothing', plan: { stale: true, lowRaw: 30, coldLevels: ['bring_in'], small: true }, ack: null, expectOpen: [], killedMutant: 'staleAutoOpens' },
  { cell: 'small pots due open Needs care', plan: { small: true }, ack: null, expectOpen: ['care'], killedMutant: 'openNone' },
  { cell: 'routine watering never opens Needs care', plan: { waterDue: 168, small: false, hot: false, never: 0 }, ack: null, expectOpen: [], killedMutant: 'openAll' },
  { cell: 'hot day with a container due opens Needs care', plan: { hot: true, containerDue: true }, ack: null, expectOpen: ['care'], killedMutant: 'openNone' },
  { cell: 'new reason type re-opens the same day (MF1)', plan: { small: true, never: 1 }, ack: { section: 'care', at: 'today', r: 'small' }, expectOpen: ['care'], killedMutant: 'ignoreRemembered' },
  { cell: 'storage window first day opens Heads-up', storage: { today: '2026-09-28', checkFrom: '2026-09-28', deadline: '2026-10-10' }, expectOpen: ['headsup'], killedMutant: 'headsupAlwaysOpen' },
  { cell: 'storage mid-window stays closed', storage: { today: '2026-10-01', checkFrom: '2026-09-28', deadline: '2026-10-10' }, expectOpen: [], killedMutant: 'headsupAlwaysOpen' },
  { cell: 'storage deadline in 2 days opens', storage: { today: '2026-10-08', checkFrom: '2026-09-28', deadline: '2026-10-10' }, expectOpen: ['headsup'], killedMutant: 'headsupAlwaysOpen' },
  { cell: 'household never auto-opens', plan: { small: true }, household: true, expectOpenExcludes: ['hh-*'], killedMutant: 'householdAlwaysOpen' },
  { cell: 'glance never auto-opens', plan: { frostTonight: true }, expectOpenExcludes: ['glance'], killedMutant: 'glanceOpenByDefault' },
]

// The browser half needs the pinned day for a state (local seeds are dated); the node half needs a lookup.
export const stateByName = (n) => STATES.find((s) => s.name === n) || null
