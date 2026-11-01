// careNeeded.js — Care-Needed-Today canonicalizer. SINGLE SOURCE OF TRUTH for which plantings need
// care today, the event each need logs, its due-state, and ordering. BOTH the CareNeeded component AND
// the parity test consume this; the component does ZERO classification/ordering of its own.
// Pure: a daily-plan `plan` object in, a canonical row array out. No fetch, no effects. A planting
// present in two buckets yields two rows (two distinct needs/events).
// Dormant carries no action and is excluded from the actionable list.

// isDailyCadence is imported rather than re-derived so "what counts as daily" has ONE definition
// across the two surfaces that answer it from different inputs (this file reads the daily plan's
// `interval`, CareStatus reads entity_memory's `watering_interval_days`).
import { isDailyCadence } from './waterDue.js'
import { agreedTonightLow, withoutLowClause } from './tonightLow.js'
import { bedsWaitForRain } from './wateringScale.js'

// Bucket -> the event_type a one-tap log writes (identical to the Log form's write path so the
// events Lambda side effects — critter award + entity_memory.next_water_at — fire). dormant: none.
export const NEED_EVENT_TYPE = {
  water_due: 'watering',
  no_history: 'watering',
  fertilize: 'fertilizing',
  pest: 'observation',
  cold: 'brought_inside',
  // A winter soil check logs a moisture_check, NOT a watering. The usual answer is "still damp", and
  // logging a watering for that would falsify last_water and, in the two quiescent regimes, teach the
  // model to keep a cold pot wet.
  overwintering: 'moisture_check',
}

// The SECONDARY event a row may offer alongside its primary log: "I went and felt it, it's still damp."
//
// It stays a SECONDARY action rather than another NEED_EVENT_TYPE entry: the bucket is still
// water_due, the row still primarily wants watering, and the bulk/group machinery keys off
// NEED_EVENT_TYPE. moisture_check is in BATCH_EXCLUDED_TYPES because "none of these 500 need water" is
// a fabricated observation, so it must never reach a bulk button.
export const MOISTURE_CHECK_EVENT = 'moisture_check'

// water_due ONLY. Both exclusions are correctness, not taste:
//   no_history    — DONE_EVENTS.no_history is ['watering','rain']. Declaring the soil damp
//                   establishes no watering history, so the server would NOT check the card off.
//                   Offering it here would optimistically hide a row that returns on the next plan
//                   read, which is worse than no control at all.
//   overwintering — NEED_EVENT_TYPE.overwintering already IS moisture_check. A second control would
//                   post the identical event as the chip beside it.
// Every other need is off the watering clock entirely.
export function canMoistureCheck(row) {
  return !!row && row.need === 'water_due'
}

// Bucket -> short care verb (the "By type" group label + chip label). Text channel, never color-only.
export const NEED_LABEL = {
  water_due: 'Water',
  no_history: 'Water',
  fertilize: 'Feed',
  pest: 'Check',
  cold: 'Protect',
  overwintering: 'Check',
  // A planting waiting for rain (lib/rainHold.js) is offered the ordinary Water. A LABEL only: rain_skipped
  // is not in NEED_ORDER or NEED_EVENT_TYPE, so buildCareNeeded never lists one.
  rain_skipped: 'Water',
}

// Render/auto-expand order. Water needs lead (most time-sensitive), then never-watered, feed, pest, cold.
// overwintering sits LAST: a fortnightly-to-monthly winter check is the least time-sensitive row on
// the list, and it must never push a same-day freeze protection down the page.
export const NEED_ORDER = ['water_due', 'no_history', 'fertilize', 'pest', 'cold', 'overwintering']

// One-clause primary reason. Mirrors the engine's per-bucket reason strings (single clause; any
// supporting detail is the row's secondary/expand content, not here).
export function needReason(need, it) {
  switch (need) {
    case 'water_due':
      if (it.rain_note) return it.rain_note
      // A daily-cadence row never says "overdue". `overdue_by = dW - wi` on wi=1 is just "days since
      // watering, minus one": it counts the calendar, not a deficit, and across many daily plantings it
      // renders a met-then-skipped cadence as a growing backlog. Naming the cadence explains why the row
      // is back again this morning. Past WATER_STALE_DAYS the row states the RECORD as a fact instead
      // ("last watered 5d ago"), the same claim-what-you-know move waterStaleness makes below: a long
      // gap on a daily plant stays visible, no longer as an accusation.
      if (isDailyCadence(it.interval)) {
        const ds = it.days_since
        return (typeof ds === 'number' && ds >= WATER_STALE_DAYS)
          ? 'Daily — last watered ' + ds + 'd ago'
          : 'Daily — due today'
      }
      if (typeof it.overdue_by === 'number' && it.overdue_by > 0) return it.overdue_by + 'd overdue'
      return 'Due today'
    case 'no_history':
      return 'Never watered'
    case 'fertilize':
      return [it.item, it.apply].filter(Boolean).join(' · ') || 'Feed due'
    case 'pest':
      return it.label || 'Scout for pests'
    case 'cold':
      return it.text || 'Protect tonight'
    case 'overwintering':
      // The engine writes the full clause (soil-check-due / never-checked / window-ended); it is the
      // only place that knows the regime and the elapsed days, so this mirrors rather than re-derives.
      return it.reason || (it.exit_due ? 'Overwintering window ended' : 'Winter soil check due')
    default:
      return it.project || ''
  }
}

// Synthetic severity tier from the fields the plan DOES expose (no next_water_at in plan items).
// Shares the waterDue.js SEVERITY_STYLES vocabulary so Today rows and the detail CareStatus band never
// disagree. Non-water needs are "needed today" => gold.
export function needTier(need, it) {
  if (need === 'water_due') {
    // Daily cadence pins to gold ("needed today") and never escalates on elapsed days, the same rule as
    // severityTier, so the Today row and the detail band still agree. Colour is not the channel carrying
    // the long-gap signal anyway; needReason's text is (SC 1.4.1).
    if (isDailyCadence(it.interval)) return 'gold'
    const o = it.overdue_by
    if (typeof o === 'number') {
      if (o >= 3) return 'terra-bold'
      if (o >= 1) return 'terra'
    }
    return 'gold'
  }
  return 'gold'
}

// "Is the engine letting dry in-ground beds wait for tomorrow's rain?" — the one client-side copy of
// its dry-bed deferral (wateringScale.bedsWaitForRain: 0.50"/60%, a null PoP fails closed). A fact
// about the forecast, NOT a filter on any list: the engine owns the hold (the beds that wait are in
// rain_skipped), so an in-ground row still on the list is one the engine decided needs water (a fresh
// transplant), and excluding in-ground rows would skip exactly those.
export function bedWaitActive(plan) {
  const h = plan && plan.hydrology
  if (!h) return false
  return bedsWaitForRain(h)
}

// The BULK candidate set for one event_type: the rows of that type, in-ground beds included (see
// bedWaitActive above). ONE predicate for every bulk control — the global "Log all" pill, a section's
// "Water all", and the V2 buttons after them — so no two can claim different work.
//
// Keyed on the row's PRIMARY eventType, so the "Moist" check a water_due row offers is never a bulk
// candidate (MOISTURE_CHECK_EVENT above: "none of these 500 need water" is a fabricated observation).
// An overwintering row, whose primary type IS moisture_check, is one.
//
// candidateRows keeps the rows, in list order (the chooser sheet renders them, the fan-out posts them);
// candidateKeys is the same set as keys, which is what runBulk takes and what a button counts.
export function candidateRows(rows, etype) {
  return rows.filter(r => r.eventType === etype)
}
export function candidateKeys(rows, etype) {
  return new Set(candidateRows(rows, etype).map(r => r.key))
}

// The canonical flat row list. Excludes engine-marked `done` items. Order = NEED_ORDER, preserving each
// bucket's engine array order (water is pre-sorted most-overdue-first by the engine). This is the
// regression-locked output.
export function buildCareNeeded(plan) {
  if (!plan) return []
  // On a night the frost line names as tonight, Today prints ONE low for the night
  // (src/lib/tonightLow.js). A Protect card's reason ends in the ENGINE's plan low ("bring inside
  // tonight (low 43°F)"), which on those nights can be a second number for the same night, so it drops
  // that trailing clause and keeps the instruction. WHICH cards appear, and their words, are untouched:
  // that is the engine's care decision (coldFor), and a display rule must not move it.
  const dropColdLow = agreedTonightLow(plan) != null
  const rows = []
  for (const need of NEED_ORDER) {
    const items = Array.isArray(plan[need]) ? plan[need] : []
    for (const it of items) {
      if (it && it.done) continue
      // overdueBy is suppressed AT THE SOURCE for a daily cadence rather than filtered at each render
      // site. It is meaningless there (see needReason), and every downstream consumer — rowSeverity
      // today, whatever reads the row next — then gets the right answer without having to know the rule.
      // The raw engine value is still on the plan payload; `interval` rides along so the rule stays
      // checkable.
      const daily = isDailyCadence(it.interval)
      rows.push({
        key: it.id + ':' + need,
        plantingId: it.id,
        name: it.name || it.crop || 'Planting',
        crop: it.crop || null,
        project: it.project || null,
        projectId: it.project_id || null,
        need,
        eventType: NEED_EVENT_TYPE[need],
        reason: (need === 'cold' && dropColdLow) ? withoutLowClause(needReason(need, it)) : needReason(need, it),
        tier: needTier(need, it),
        interval: typeof it.interval === 'number' ? it.interval : null,
        overdueBy: (!daily && typeof it.overdue_by === 'number') ? it.overdue_by : null,
        inGround: !!it.in_ground,
        never: !!it.never,
        // Is this row's reason a restatement of what needTier already encodes as colour? TRUE only for
        // a plain non-daily water row: needReason then returns "Nd overdue" or "Due today", and needTier
        // maps the same overdue_by onto terra-bold / terra / gold. Two channels, one fact, so the
        // renderer drops the text one and the row loses its second line.
        //
        // Deliberately NARROW. It is false for a rain_note ("0.38\" rain didn't cover the gap"), for
        // "Never watered", for a stale daily record ("Daily — last watered 9d ago"), for the
        // daily-cadence framing, and for every non-water need — a pest label or "Protect tonight" is
        // content no colour carries, and all non-water needs are gold regardless.
        //
        // Computed HERE, next to needReason, so the two cannot drift: whoever changes what a reason
        // says is looking at the rule that decides whether it is worth printing.
        reasonRedundant: need === 'water_due' && !it.rain_note && !daily,
      })
    }
  }
  return rows
}

// The two buckets that ride the watering clock. water_due is an INFERENCE from elapsed time;
// no_history is a FACT ("never watered"). They score the same for ordering but are treated
// differently by the staleness cap below, which only ever withholds inferences.
const WATER_NEEDS = new Set(['water_due', 'no_history'])

// Per-row severity. A water row is worth its presence (1) plus its overdue days; anything else is
// present but not on an overdue clock, so it scores a fraction of one row. A daily-cadence water row
// therefore scores exactly its presence — buildCareNeeded nulls its overdueBy — which is the point: a
// large daily group should win the auto-expand sort on its MASS, not on a phantom day-backlog that
// would let it out-shout every genuinely lapsed weekly planting.
function rowSeverity(r) {
  if (!WATER_NEEDS.has(r.need)) return 0.5
  return 1 + (typeof r.overdueBy === 'number' && r.overdueBy > 0 ? r.overdueBy : 0)
}

// Group-severity score = the SUM of row severities, i.e. the group's total overdue-day backlog with
// each row's presence counted once.
//
// Not max(overdue_by): max cannot see mass and inverts the screen when a small group has one old
// outlier while a group holding most of the list is only a few days overdue (the list would open
// auto-expanded on the small group behind many collapsed headers). Sum lets the biggest real backlog
// lead; a single outlier can still win, but only against a group it genuinely outweighs.
//
// REJECTED: mean overdue (max's twin — a 1-row group at 19 beats 116 rows at 3, same defect);
// max × log(count) (tunable, unexplainable, and no more correct than the thing it replaces).
export function groupSeverity(rows) {
  let s = 0
  for (const r of rows) s += rowSeverity(r)
  return s
}

// Group rows for render. mode: 'location' (by location, else project) | 'type' (by care need).
// Returns [{ key, label, rows, severity }].
//
// `orderKeys` PINS the location-mode order. Severity is summed from the rows PRESENT, so an
// unconditional sort would drop a group's score on every log and re-sort the page WHILE a finger is on
// it, sliding a section out from under the next tap. The severity sort is right for choosing what
// leads on ARRIVAL and wrong as a continuous function of a list the user is actively draining. Callers
// pass the order computed from the FULL row set once, so position is a property of the plan rather than
// of how far through it you are.
//
// Unranked keys fall to the end on severity — a group can only APPEAR mid-session via enrichment
// settling or an undo, and appending is the one placement that cannot move a row already under a
// finger. 'type' mode is unaffected: NEED_ORDER is fixed.
export function groupRows(rows, mode, orderKeys) {
  const map = new Map()
  for (const r of rows) {
    const gkey = mode === 'type' ? r.need : (r.locationId || r.projectId || '_none')
    const glabel = mode === 'type' ? NEED_LABEL[r.need] : (r.locationName || r.project || 'Other')
    if (!map.has(gkey)) map.set(gkey, { key: gkey, label: glabel, rows: [] })
    map.get(gkey).rows.push(r)
  }
  const groups = [...map.values()].map(g => ({ ...g, severity: groupSeverity(g.rows) }))
  if (mode === 'type') {
    groups.sort((a, b) => NEED_ORDER.indexOf(a.key) - NEED_ORDER.indexOf(b.key))
  } else if (Array.isArray(orderKeys) && orderKeys.length) {
    const rank = new Map()
    orderKeys.forEach((k, i) => { if (!rank.has(k)) rank.set(k, i) })
    groups.sort((a, b) => {
      const ra = rank.has(a.key) ? rank.get(a.key) : Number.POSITIVE_INFINITY
      const rb = rank.has(b.key) ? rank.get(b.key) : Number.POSITIVE_INFINITY
      if (ra !== rb) return ra - rb
      return (b.severity - a.severity) || a.label.localeCompare(b.label)
    })
  } else {
    // Most-overdue group first (auto-expand target); ties broken by label for determinism.
    groups.sort((a, b) => (b.severity - a.severity) || a.label.localeCompare(b.label))
  }
  return groups
}

// ADHD chunking, as a cumulative ROW budget across groups rather than an all-or-nothing gate on the
// total (8 rows: expand-all defeats chunking). A budget degrades: a 9-need day opens as many groups as
// fit in 8 rows instead of collapsing all but one. Named BUDGET, not THRESHOLD, because the semantics
// are cumulative.
export const EXPAND_ROW_BUDGET = 8

// Which groups open on load. Walks groups in their sorted order (groupRows put the heaviest first)
// and opens them while the running row count fits the budget. The LEAD group always opens even when
// it alone blows the budget — an opening screen with every group collapsed shows nothing, which is
// the failure this whole path exists to avoid. Pure: the component holds only the user's overrides.
export function autoExpandKeys(groups, budget = EXPAND_ROW_BUDGET) {
  const keys = new Set()
  if (!Array.isArray(groups) || groups.length === 0) return keys
  let used = 0
  for (const g of groups) {
    const n = Array.isArray(g.rows) ? g.rows.length : 0
    if (keys.size === 0) { keys.add(g.key); used = n; continue }
    if (used + n > budget) break
    keys.add(g.key); used += n
  }
  return keys
}

// ── Watering staleness ──────────────────────────────────────────────────────────────────────────
// The surface would assert "194 plantings are thirsty" when what it actually knows is "194 plantings
// have no recent record." The cause is a PHASE-LOCKING artifact, not a cadence defect: the whole garden
// is watered in one batch action, so every planting's due-clock locks into one cohort and the due count
// jumps (42 -> 237) in a single day, then self-resolves the moment it is logged. Re-tuning intervals or
// the guessed-cadence rate cannot fix that; what can be fixed is the claim.
//
// N = 3 DAYS, from two independent anchors. (a) The engine's own naked fallback interval is 3 days, so
// by day 3 of silence every planting has crossed its clock on elapsed time alone; before that a long
// list still carries information (the wi=1 cohort really is due). (b) Against 30 days of stored plans it
// fires on every wall day and stays silent on every big list whose record is fresh.
export const WATER_STALE_DAYS = 3

// Rows a group renders while stale. ~One phone screen of 48px rows; the rest is one tap away and the
// group header still carries the TRUE count, so nothing disappears from the mental model.
export const WATER_STALE_CAP = 20

// Is today's water list resting on absence-of-record? Reads `days_since`, which the engine already
// emits on every water_due row, so this costs ZERO new requests and no plan-shape change. MEDIAN,
// deliberately: min() is defeated by the wi=1 cohort (it reads 1 or 2 even on a huge list, so a
// min-based flag could never fire) and max() is defeated by a single long-gap straggler (it would fire
// every day). The median says what we actually want to claim — that more than half of these rows rest
// on a record at least N days old. Lower median on even counts, so the flag never overstates.
// Absent/unparseable days_since => not stale: we only ever suppress an assertion when we can
// positively show the record is old.
export function waterStaleness(plan, staleDays = WATER_STALE_DAYS) {
  const items = Array.isArray(plan && plan.water_due) ? plan.water_due : []
  const ds = []
  for (const it of items) {
    if (it && !it.done && typeof it.days_since === 'number' && isFinite(it.days_since)) ds.push(it.days_since)
  }
  if (ds.length === 0) return { stale: false, daysSince: null, sampled: 0 }
  ds.sort((a, b) => a - b)
  const median = ds[(ds.length - 1) >> 1]
  return { stale: median >= staleDays, daysSince: median, sampled: ds.length }
}

// Withhold water_due rows past `limit`, keeping every other row. Rows arrive most-overdue-first
// (engine order, preserved by buildCareNeeded), so the kept ones are the longest-waiting.
//
// water_due ONLY. no_history means "this planting has never been watered" — a fact, not an inference
// from elapsed time — so a stale record is no reason to hide it, and pest/feed/cold needs are not on
// the watering clock at all. Same reasoning that keeps moisture_check out of the no_history done-set.
//
// Returns the input array by identity when nothing is withheld, so a non-stale day re-renders
// exactly as before.
export function capStaleRows(rows, limit = WATER_STALE_CAP) {
  const src = rows || []
  if (!(typeof limit === 'number' && limit >= 0)) return { rows: src, hidden: 0 }
  let kept = 0, hidden = 0
  const out = []
  for (const r of src) {
    if (r.need !== 'water_due') { out.push(r); continue }
    if (kept < limit) { out.push(r); kept++ } else hidden++
  }
  return hidden ? { rows: out, hidden } : { rows: src, hidden: 0 }
}

// Within a location group, split rows into in-ground beds vs containers/pots. A row is a BED if it's
// in_ground or its container_type is a ground bed; everything else is a container. Rows may carry
// container_type only when the component enriched them from /api/plants; absent => falls back to the
// inGround flag the plan already carries. Pure, order-preserving.
const BED_CONTAINER_TYPES = new Set(['in_ground', 'raised_bed'])
export function isBedRow(r) {
  return !!(r && (r.inGround || BED_CONTAINER_TYPES.has(r.containerType)))
}
export function splitContainersBeds(rows) {
  const beds = [], containers = []
  for (const r of (rows || [])) (isBedRow(r) ? beds : containers).push(r)
  return { beds, containers }
}

// The dormant bucket from the engine. Deliberately NOT part of buildCareNeeded: dormancy carries no
// action, so folding it into the actionable list would put a row on the care list that nothing can be
// logged against. It is a separate ambient list because a dormant planting is otherwise hidden from
// every arm of the app, so an overwintered crop that wakes up would have nowhere to be seen.
//
// `resumable` gates the Resume action and is fail-CLOSED on the dangerous direction. Only
// reason==='status' resumes: that status was set by a human tap and no automation ever clears it (the
// one-way trap overwinter.js names). reason==='profile' is the Lithops cadence flag — it has no status
// to clear and its whole purpose is "watering now = rot/death", so offering to end its dormancy is the
// one thing this list must never do. A plan stored BEFORE the engine shipped `reason` carries neither
// value: those rows still LIST (visibility needs no Lambda) but stay un-resumable until the
// discriminator is live, rather than guessing from the note string. Pure; preserves engine order.
export function dormantRows(plan) {
  const items = (plan && Array.isArray(plan.dormant)) ? plan.dormant : []
  return items.filter(Boolean).map(it => ({
    key: it.id + ':dormant',
    plantingId: it.id,
    name: it.name || it.crop || 'Planting',
    crop: it.crop || null,
    project: it.project || null,
    projectId: it.project_id || null,
    note: it.note || null,
    resumable: it.reason === 'status',
  }))
}

// The feed-suppressed POPULATION the engine emits. Twin of dormantRows above and, like it,
// deliberately NOT part of buildCareNeeded: a suppressed planting has no action to log, so folding it
// in would put a row on the actionable list that nothing can be logged against. Such plantings produce
// NO Feed card, ever, which on Today is indistinguishable from plantings everybody forgot.
//
// THREE states, not two, and that is the whole point of the shape. `feed_suppressed` follows a
// CONDITIONAL spread, NOT dormancy_suppressed's unconditional zero: the key is ABSENT — not
// present-and-zero — whenever nothing in the run is suppressed, and every plan row stored before the
// feature shipped is absent too.
//   'absent' — no key. We do not know whether the gate ran. Asserts NOTHING.
//   'none'   — key present, empty. The gate RAN and suppressed nobody. That is a fact.
//   'listed' — rows.
// Collapsing absent into none is the defect this exists to prevent: it would let a surface claim
// "every planting is on calendar feeding" from a stored plan that never evaluated the question.
// Both no-row states render nothing today (there is no planting to name), so the distinction is
// currently invisible — it is kept in the DATA so no later consumer can borrow the wrong one.
//
// A non-array value is 'absent', never 'none': a malformed payload is not evidence the gate found
// nothing. An array of only junk entries maps to zero rows and so reports 'none' — the gate ran and
// produced nothing nameable, which is what the surface can honestly say. Pure; preserves engine order.
export const FEED_SUPPRESSED_ABSENT = 'absent'
export const FEED_SUPPRESSED_NONE = 'none'
export const FEED_SUPPRESSED_LISTED = 'listed'

export function feedSuppressedRows(plan) {
  const raw = plan ? plan.feed_suppressed : undefined
  if (!Array.isArray(raw)) return { state: FEED_SUPPRESSED_ABSENT, rows: [] }
  const rows = raw.filter(Boolean).map(it => ({
    key: it.id + ':feed_suppressed',
    plantingId: it.id,
    name: it.name || it.crop || 'Planting',
    crop: it.crop || null,
    project: it.project || null,
    projectId: it.project_id || null,
    rule: it.rule || null,
    reason: it.reason || null,
  }))
  return { state: rows.length ? FEED_SUPPRESSED_LISTED : FEED_SUPPRESSED_NONE, rows }
}

// The drought signal the engine writes onto the dormancy_suppressed bucket. Third of the ambient
// selectors, after dormantRows and feedSuppressedRows, and deliberately their shape: a suppressed
// planting has no action to log, so `dormancy_suppressed` stays OUT of NEED_ORDER — folding it in
// would put a one-tap Water on the exact plantings whose profile says never water by interval.
//
// PER-ITEM gate, not per-bucket, which is why this needs no absent/none/listed triple like
// feedSuppressedRows. `dormancy_suppressed` is spread UNCONDITIONALLY (empty array when nobody is
// suppressed), so the key's presence asserts nothing; the `drought` key is written per item and ONLY
// when the space's signal is `dry`. A space reading `ok` or `insufficient` therefore emits the bucket
// with no `drought` on any item -> zero rows -> nothing rendered, which is the correct silence.
//
// THE DAY COUNT IS THE CLAIM. A row whose dry_days is not a positive finite number is DROPPED, never
// rendered with a guess: the engine is the only thing that knows how long the run is, and a note that
// says something slightly wrong about a dry plant is worse than no note. `deep_soak_in` is a clarifier
// rather than the claim, so a missing one only drops the parenthetical and keeps the row.
//
// WORDING mirrors droughtSignal.js: 0.60 in is the in-ground `deep` class of RAIN_DEPTH_TIERS, not
// light rain and not a gauge's resolution, so the statistic is "no DEEP SOAK in N days" and must NEVER
// be reworded to "no rain in N days" — that category slip makes the claim false. The depth is read off
// the payload rather than restated as a constant here, so a retune moves both together.
// `truncated` means the run is at least this long (it ran past the engine's read window). Pure;
// preserves engine order.
export function droughtRows(plan) {
  const items = (plan && Array.isArray(plan.dormancy_suppressed)) ? plan.dormancy_suppressed : []
  const rows = []
  for (const it of items) {
    const d = it && it.drought
    if (!d || typeof d.dry_days !== 'number' || !isFinite(d.dry_days) || d.dry_days <= 0) continue
    const depth = (typeof d.deep_soak_in === 'number' && isFinite(d.deep_soak_in))
      ? ' (≥' + d.deep_soak_in.toFixed(2) + ' in)' : ''
    rows.push({
      key: it.id + ':drought',
      plantingId: it.id,
      name: it.name || it.crop || 'Planting',
      crop: it.crop || null,
      project: it.project || null,
      projectId: it.project_id || null,
      rule: it.rule || null,
      dryDays: d.dry_days,
      truncated: !!d.truncated,
      lastDeepSoak: d.last_deep_soak || null,
      reason: 'No deep soak' + depth + ' in ' + (d.truncated ? 'at least ' : '')
        + d.dry_days + ' day' + (d.dry_days === 1 ? '' : 's'),
    })
  }
  return rows
}
