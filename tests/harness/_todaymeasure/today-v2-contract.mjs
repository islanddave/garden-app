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
export const LANDED = ['S0', 'S2']
export const SLICES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']

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
      { family: 'first-screen', armedAt: ['S3', 'S5'], mustContain: ['today-glance', 'weather-cue-line', 'frost-alert-line', 'today-jumpbar', 'today-sec-protect', 'protect-pick'], minCount: { 'protect-row': 3 }, headerTopMax: { care: 'FIRST_SCREEN+60' }, why: '(e) v2-frost; the +60 is §11.0 E4, est., to be recorded' },
      { family: 'jumpbar', armedAt: 'S3', present: true, chips: ['protect', 'water', 'feed', 'check', 'harvest'] },
      { family: 'visual-census', armedAt: ['S3', 'S4'], maxFingerprints: 4, fontSizesExtra: ['1.3rem', '36px', '23px', '0.84rem'], why: '(l) ≤ 4 section-level container fingerprints on busyfull' },
      { family: 'weather-once', armedAt: 'S3', why: 'MF2: with the glance OPEN, exactly one today-weather and no repeated hi/lo text' },
      { family: 'interaction', armedAt: 'S4', steps: [
        { tap: 'jump:water', flip: 'today-sec-care' },
        { tap: 'spot:Bag Area', flip: 'care-spot:Bag Area' },
        { tap: 'cohort:Bag Area', flip: 'care-cohort:Bag Area' },
        { scroll: '2*FIRST_SCREEN' },
        { scroll: 0 },
      ], counts: { afterSpot: { 'care-exceptions-row': 8, 'care-cohort': 1 }, afterCohort: { 'care-cohort-row': 20, 'care-show-more': 1 } }, why: '(d) Bag Area: 8 exception rows + 1 cohort line; disclosed: 20 rows + "Show 69 more"' },
      { family: 'region-headcount', armedAt: ['S3', 'S4', 'S5', 'S6'], why: 'every REGIONS_V2 row owned by v2-frost, counted after its owner is opened' },
    ],
  },
  {
    name: 'v2-busy', fixture: 'busy', clock: S924, prefs: 'prefs.default.json',
    proves: 'Protect open (chill, first seen), Needs care open (small)',
    checks: [
      ...common(),
      { family: 'section-open-set', armedAt: ['S4', 'S5', 'S6'], order: ['protect', 'care', 'harvest', 'resting'], open: ['protect', 'care'], closed: ['harvest', 'resting'] },
      { family: 'collapsed-mounted', armedAt: ['S4', 'S5', 'S6'] },
      { family: 'first-screen', armedAt: ['S3', 'S5'], mustContain: ['today-jumpbar', 'today-sec-protect'], allRows: 'protect-row', headerTopMax: { care: 668 }, why: '(e) v2-busy: bar, Protect header + all rows, Needs care header top ≤ 668 (R16)' },
      { family: 'group-water-all', armedAt: 'S4', group: 'Outside', why: 'MF3: group Water all — spots shrink to done lines, "Outside · watered N · Undo", accessible name "Water all N outside"' },
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
      { family: 'section-open-set', armedAt: ['S4', 'S5'], order: ['protect', 'care'], open: ['care'], closed: ['protect'] },
    ],
  },
  {
    name: 'v2-closed-today', fixture: 'busy', clock: S924, prefs: 'prefs.closed-today.json', local: { todaySeen: { date: '2026-09-24' } },
    proves: 'MF1 (new state): a close acked today holds for the rest of today — both stay closed',
    checks: [
      ...common(),
      { family: 'section-open-set', armedAt: ['S4', 'S5'], order: ['protect', 'care'], open: [], closed: ['protect', 'care'] },
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
      { family: 'group-water-all', armedAt: 'S4', group: 'Outside', expectN: 135 },
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
  { name: 'v2-storage-open', fixture: 'storage', redate: '2026-09-28', clock: AT('2026-09-28'), prefs: 'prefs.default.json', proves: 'Heads-up opens on the first day of the window',
    checks: [...common(), { family: 'section-open-set', armedAt: 'S5', open: ['headsup'] }, { family: 'first-screen', armedAt: 'S5', mustContain: ['today-sec-headsup'] }] },
  { name: 'v2-storage-mid', fixture: 'storage', clock: AT('2026-10-01'), prefs: 'prefs.default.json', proves: 'Heads-up closed mid-window (negative)',
    checks: [...common(), { family: 'section-open-set', armedAt: ['S5', 'S6'], closed: ['headsup', 'putup'] }, { family: 'first-screen', armedAt: 'S5', mustContain: ['today-sec-headsup'] }] },
  { name: 'v2-storage-deadline', fixture: 'storage', redate: '2026-10-08', clock: AT('2026-10-08'), prefs: 'prefs.default.json', proves: 'deadline ≤ 2 days: open, warn plate',
    checks: [...common(), { family: 'section-open-set', armedAt: 'S5', open: ['headsup'] }, { family: 'first-screen', armedAt: 'S5', mustContain: ['today-sec-headsup'] }] },
  { name: 'v2-storage-past', fixture: 'storage', redate: '2026-10-12', clock: AT('2026-10-12'), prefs: 'prefs.default.json', proves: 'grace phase: past copy, closed',
    checks: [...common(), { family: 'section-open-set', armedAt: 'S5', closed: ['headsup'] }] },
  {
    // SF6: household stays opt-in per person, so the lens is switched on for this device before mount.
    name: 'v2-household', fixture: 'busyhh', clock: S924, prefs: 'prefs.default.json', local: { showOthers: true },
    proves: '"Jen\'s care · 15" closed, never auto-opens; the shared skip set',
    checks: [...common(), { family: 'section-open-set', armedAt: 'S6', closed: ['hh-member_j'] }, { family: 'header-text', armedAt: 'S6', counts: { 'hh-member_j': 15 } }],
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
    local: { mirror: { care: { open: false, at: '2026-09-24' } } },
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
  { id: 'weather-cue-line', owner: 'glance (visible closed)', state: 'v2-frost', armedAt: 'S3' },
  { id: 'frost-alert-line', owner: 'glance (visible closed)', state: 'v2-frost', armedAt: 'S3' },
  ...['drought-line', 'leaf-wetness-line', 'today-basis-stamp', 'care-rain-note', 'care-drought-list'].map((id) => ({ id, owner: 'glance details', open: 'glance', state: 'v2-frost', armedAt: 'S3' })),
  { id: 'today-substrate-note', owner: 'Needs care, Feed filter', open: 'care', filter: 'feed', state: 'v2-frost', armedAt: 'S4' },
  { id: 'today-care', owner: 'Needs care section', state: 'v2-busy', armedAt: 'S4' },
  { id: 'care-heading', owner: 'Needs care band', state: 'v2-busy', armedAt: 'S4' },
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
  { id: 'putup-use-soon', owner: 'Put-Up body', open: 'putup', state: 'v2-storage-mid', armedAt: 'S6' },
]
export const NEW_ANCHORS = ['today-glance', 'today-jumpbar', 'today-sec-<key>', 'care-group', 'care-spot', 'care-spot-panel', 'care-exceptions', 'care-cohort', 'care-done-line', 'protect-row', 'protect-pick', 'today-status']

// ── THE SHELL ENTRY (today-shell-v2.mjs over tests/harness/todayshell.*) ───────────────────────────────────
// The platform half of §9.1: what only the real TopChrome, the BottomNav band and the real page-scroll manager
// can show. `shell-instrument` is armed now: it is the shell itself (S0's own deliverable).
export const SHELL = [
  { family: 'shell-instrument', armedAt: 'S0', state: 'v2-busy', why: 'TopChrome paints at BAR_H, the nav band writes --bottom-nav-height, the page band is FIRST_SCREEN, scrollRestoration is manual (the manager is on), the members roster is production-shaped, the prefs GET is observed, and the harness calls usePageScrollManager exactly as AppShell does' },
  { family: 'sticky', armedAt: 'S3', state: 'v2-frost', why: '(f) scrolled to 2 × FIRST_SCREEN: bar top = TopChrome bottom ± 0.5, shown(), height 57 ± 1, elementFromPoint(bar centre) inside the bar, back at 0 exactly one chip row visible (in-view chip checks dropped with the scroll-spy, §13 Simplify 5)' },
  { family: 'jump-landing', armedAt: 'S3', state: 'v2-frost', why: '(g) per chip: target open, header top ∈ [bar bottom, bar bottom + 8], activeElement = header, no horizontal scroll' },
  { family: 'back-restore', armedAt: 'S4', state: 'v2-frost', why: '(m) open Bag Area → tap "Red Acre Cabbage" → Back → Bag Area open, same row top within 1 px' },
]

// ── MUTANT KILLER FAMILIES (§9.1) and the trigger TABLE that replaced the trigger-predicate mutants ──────
export const KILLER_FAMILIES = ['section-open-set', 'collapsed-mounted', 'visibility', 'header-text', 'first-screen', 'sticky', 'jump-landing', 'verdict-truncation', 'chip-census', 'prefs-instrument', 'region-headcount', 'visual-census', 'back-restore']

// §13 Simplify 3: the trigger-predicate mutants (ignoreRemembered, rememberedBeatsUrgent, staleAutoOpens,
// chillOpensEveryNight, headsupAlwaysOpen, householdAlwaysOpen, glanceOpenByDefault) are no longer real-Chrome
// mutants: each is a cell of a table-driven unit test of src/lib/todayV2/triggers.js (S5 writes the module and
// the test that reads this table). openAll / openNone stay as real-Chrome canaries (todayMutantsV2.mjs).
// Each cell: inputs → the open set it must produce. `killedMutant` names the mutant the cell replaces.
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
