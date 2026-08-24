// careNeeded.js — Slice 7 (V4-THEME-001) Care-Needed-Today canonicalizer.
// SINGLE SOURCE OF TRUTH for which plantings need care today, the event each need logs, its
// due-state, and ordering. BOTH the CareNeeded component AND the parity test consume this; the
// component does ZERO classification/ordering of its own (read-path parity anchor — L-104/L-237).
// Pure: a daily-plan `plan` object in, a canonical row array out. No fetch, no effects, no engine
// or care-contract change (frontend-only): we derive everything from the buckets the engine
// already emits. A planting present in two buckets yields two rows (two distinct needs/events).
// Dormant carries no action and is excluded from the actionable list.

// isDailyCadence is imported rather than re-derived so "what counts as daily" has ONE definition
// across the two surfaces that answer it from two different inputs — this file reads the daily
// plan's `interval`, CareStatus reads entity_memory's `watering_interval_days` — and cannot drift.
import { isDailyCadence } from './waterDue.js'

// Bucket -> the event_type a one-tap log writes (identical to the Log form's write path so the
// events Lambda side effects — critter award + entity_memory.next_water_at — fire). dormant: none.
export const NEED_EVENT_TYPE = {
  water_due: 'watering',
  no_history: 'watering',
  fertilize: 'fertilizing',
  pest: 'observation',
  cold: 'brought_inside',
  // V4-OVERWINTER-001: a winter soil check logs a moisture_check, NOT a watering. The whole point of
  // the reduced cadence is that the answer is usually "still damp" — logging a watering for that would
  // falsify last_water and, in the two quiescent regimes, teach the model to keep a cold pot wet.
  overwintering: 'moisture_check',
}

// Bucket -> short care verb (the "By type" group label + chip label). Text channel, never color-only.
export const NEED_LABEL = {
  water_due: 'Water',
  no_history: 'Water',
  fertilize: 'Feed',
  pest: 'Check',
  cold: 'Protect',
  overwintering: 'Check',
}

// Render/auto-expand order. Water needs lead (most time-sensitive), then never-watered, feed, pest, cold.
// V4-OVERWINTER-001 sits LAST: a fortnightly-to-monthly winter check is the least time-sensitive row on
// the list, and it must never push a same-day freeze protection down the page.
export const NEED_ORDER = ['water_due', 'no_history', 'fertilize', 'pest', 'cold', 'overwintering']

// One-clause primary reason. Mirrors the engine's per-bucket reason strings (single clause; any
// supporting detail is the row's secondary/expand content, not here).
export function needReason(need, it) {
  switch (need) {
    case 'water_due':
      if (it.rain_note) return it.rain_note
      // BUG-CADENCEONEDAY-001 — a daily-cadence row never says "overdue". `overdue_by = dW - wi` on
      // wi=1 is just "days since watering, minus one": it counts the calendar, not a deficit, and
      // across the ~80 plantings that carry wi=1 it renders a met-then-skipped cadence as a growing
      // backlog. Naming the cadence is the honest replacement — it explains why the row is back
      // again this morning. Past WATER_STALE_DAYS the row states the RECORD as a fact instead
      // ("last watered 5d ago"), the same claim-what-you-know move waterStaleness makes below: a
      // genuinely long gap on a daily plant is still visible, it is just no longer an accusation.
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
// Shares the waterDue.js SEVERITY_STYLES vocabulary so Today rows and the detail CareStatus band
// never disagree (one mental model — L-075). Non-water needs are "needed today" => gold.
export function needTier(need, it) {
  if (need === 'water_due') {
    // Daily cadence pins to gold ("needed today") and never escalates on elapsed days — same rule as
    // severityTier, so the Today row and the detail band still agree (L-075). Colour is not the
    // channel carrying the long-gap signal anyway; needReason's text is (SC 1.4.1).
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

// Bed-wait exclusion signal — matches the engine's rain callout gate (tomorrow_precip_in>=0.3
// && pop>=50): "water containers today, let in-ground beds wait". When active, in-ground beds are
// excluded from the BULK watering pre-check (still individually loggable). rain_skipped plantings
// are already withheld by the engine, so this only guards bulk over-watering of beds.
export function bedWaitActive(plan) {
  const h = plan && plan.hydrology
  if (!h) return false
  const amt = typeof h.tomorrow_precip_in === 'number' ? h.tomorrow_precip_in : 0
  const pop = typeof h.tomorrow_pop === 'number' ? h.tomorrow_pop : 0
  return amt >= 0.3 && pop >= 50
}

// The canonical flat row list. Excludes engine-marked `done` items (V3-TODAYDONE-001) — same set
// the current PlanBuckets surfaces. Order = NEED_ORDER, preserving each bucket's engine array order
// (water is pre-sorted most-overdue-first by the engine). This is the regression-locked output.
export function buildCareNeeded(plan) {
  if (!plan) return []
  const rows = []
  for (const need of NEED_ORDER) {
    const items = Array.isArray(plan[need]) ? plan[need] : []
    for (const it of items) {
      if (it && it.done) continue
      // BUG-CADENCEONEDAY-001 — overdueBy is suppressed AT THE SOURCE for a daily cadence rather
      // than filtered at each render site. It is meaningless there (see needReason), and every
      // downstream consumer — rowSeverity today, whatever reads the row next — then gets the right
      // answer without having to know the rule. The raw engine value is still on the plan payload
      // for anyone who genuinely wants it; `interval` rides along so the rule stays checkable.
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
        reason: needReason(need, it),
        tier: needTier(need, it),
        interval: typeof it.interval === 'number' ? it.interval : null,
        overdueBy: (!daily && typeof it.overdue_by === 'number') ? it.overdue_by : null,
        inGround: !!it.in_ground,
        never: !!it.never,
        // BD-036b — is this row's reason a restatement of what needTier already encodes as colour?
        // TRUE only for a plain non-daily water row: needReason then returns "Nd overdue" or "Due
        // today", and needTier maps the same overdue_by onto terra-bold / terra / gold. Two channels,
        // one fact, on the rows that make up most of the list — so the renderer drops the text one
        // and the row loses its second line.
        //
        // Deliberately NARROW. It is false for a rain_note ("0.38\" rain didn't cover the gap"),
        // for "Never watered", for a stale daily record ("Daily — last watered 9d ago"), for the
        // daily-cadence framing BUG-CADENCEONEDAY-001 added on purpose, and for every non-water
        // need — a pest label or "Protect tonight" is content no colour carries, and all non-water
        // needs are gold regardless, so their colour says nothing at all.
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
// therefore scores exactly its presence — buildCareNeeded nulls its overdueBy — which is the point:
// a 60-row daily group should win the auto-expand sort on its MASS, not on a phantom day-backlog
// that would let 36% of the garden out-shout every genuinely-lapsed weekly planting.
function rowSeverity(r) {
  if (!WATER_NEEDS.has(r.need)) return 0.5
  return 1 + (typeof r.overdueBy === 'number' && r.overdueBy > 0 ? r.overdueBy : 0)
}

// Group-severity score = the SUM of row severities, i.e. the group's total overdue-day backlog with
// each row's presence counted once.
//
// Was max(overdue_by), which cannot see mass and inverted the screen on live data: on 2026-08-17
// "Legacy Pasture In-Ground" (4 rows, one 19-day outlier) scored 19 and "Bag Area" (116 rows = 60%
// of the list, max overdue 3) scored 3, so the list opened auto-expanded on 4 of 206 items behind 12
// collapsed headers. Sum makes that 70 vs 400 — the biggest real backlog leads. A single outlier can
// still win, but only against a group it genuinely outweighs.
//
// REJECTED: mean overdue (max's twin — a 1-row group at 19 beats 116 rows at 3, same defect);
// max × log(count) (tunable, unexplainable, and no more correct than the thing it replaces).
export function groupSeverity(rows) {
  let s = 0
  for (const r of rows) s += rowSeverity(r)
  return s
}

// Group rows for render. mode: 'location' (by project proxy — the only location-ish field the plan
// carries; TRUE location names + Containers/beds sub-split are deferred to V4-TODAYLOC-001, blocked
// on container_type population) | 'type' (by care need). Returns [{ key, label, rows, severity }].
//
// BUG-TODAYCAREREORDER-001 (BD-036) — `orderKeys` PINS the location-mode order. Severity is summed
// from the rows PRESENT, so under the old unconditional sort every log removed a row, dropped its
// group's score, and re-sorted the page WHILE Dave's finger was on it — he tapped Log down a
// location group and a section slid out from under him, mis-tapping the next plant. The severity
// sort is right for choosing what leads on ARRIVAL and wrong as a continuous function of a list the
// user is actively draining. Callers pass the order computed from the FULL row set once, so
// position becomes a property of the plan rather than of how far through it you are.
//
// Unranked keys fall to the end on severity — a group can only APPEAR mid-session via enrichment
// settling or an undo, and appending is the one placement that cannot move a row already under a
// finger. 'type' mode is unaffected: NEED_ORDER is fixed, so it never had the defect.
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
// total. Same tuned chunk size as the old EXPAND_ALL_THRESHOLD (8 — expand-all defeats chunking,
// build-plan Slice 7); what changed is that "8 total needs => expand everything, 9 => expand exactly
// one group" had a cliff in it. A budget degrades: a 9-need day opens as many groups as fit in 8
// rows instead of collapsing all but one. Renamed because the semantics moved — a constant that
// still read THRESHOLD would be silently reinterpreted by the next reader.
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

// ── Effort denomination (BUG-CADENCEONEDAY-001) — REMOVED 2026-08-24, V4-TODAYVERBIAGE-001 ──────
// `bulkWaterNote` lived here and rendered "One bulk water covers 111 of these 113." under the bulk
// pill. Its reasoning was that a row count prices one tap as a hundred jobs, which is true and is
// why the note was written. Dave asked for it gone anyway: "I understand the arithmetic." The
// mis-pricing it corrected is a thing he learned once, not a thing he needs restated daily, and
// this list is read in the garden on a phone.
//
// Kept as a comment rather than silently vanishing because the NEXT person to notice that a row
// count over-states the work will re-derive exactly this note. It was already tried. If it comes
// back it needs a new reason, not this one.
// ── Watering staleness (V4-WATERMATH-001 / skeptic seat) ────────────────────────────────────────
// The wall this exists for is a PHASE-LOCKING artifact, not a cadence defect: Dave waters the whole
// garden in one batch action, so every planting's due-clock locks into one cohort and the due count
// jumps 42 -> 237 in a single day, then self-resolves the moment he logs. Live: it sat at 232-258
// for eight straight days in late July. Re-tuning intervals or the guessed-cadence rate cannot fix
// that. What CAN be fixed is the claim: the surface asserts "194 plantings are thirsty" when what it
// actually knows is "194 plantings have no recent record."
//
// N = 3 DAYS, from two independent anchors. (a) The engine's own naked fallback interval is 3 days,
// so by day 3 of silence every planting in the garden has crossed its clock on elapsed time alone —
// before that a long list still carries information (the wi=1 cohort really is due). (b) It
// discriminates on 30 days of live stored plans: it fires on every wall day (08-17 median 4, 08-16
// median 3, 07-30 median 3, 07-24 median 3 — all 153-194 due) and stays silent on every big list
// whose record is fresh (08-15 134 due at median 2, 07-26 154 at 2, 08-08 109 at 1).
export const WATER_STALE_DAYS = 3

// Rows a group renders while stale. ~One phone screen of 48px rows; the rest is one tap away and the
// group header still carries the TRUE count, so nothing disappears from the mental model.
export const WATER_STALE_CAP = 20

// Is today's water list resting on absence-of-record? Reads `days_since` — the engine already emits
// it on every water_due row (engine.js:604) — so this costs ZERO new requests and no plan-shape
// change. MEDIAN, deliberately: min() is defeated by the wi=1 cohort (it read 1 or 2 on all 30 live
// days including the 194-item one, so a min-based flag could never fire) and max() is defeated by a
// single 19-day straggler (it would fire every day). The median says what we actually want to claim
// — that more than half of these rows rest on a record at least N days old. Lower median on even
// counts, so the flag never overstates. Absent/unparseable days_since => not stale: we only ever
// suppress an assertion when we can positively show the record is old.
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

// V4-TODAYLOC-001 — within a location group, split rows into in-ground beds vs containers/pots.
// A row is a BED if it's in_ground or its container_type is a ground bed; everything else is a
// container. Rows may carry container_type only when the component enriched them from /api/plants;
// absent => falls back to the inGround flag the plan already carries. Pure, order-preserving.
const BED_CONTAINER_TYPES = new Set(['in_ground', 'raised_bed'])
export function isBedRow(r) {
  return !!(r && (r.inGround || BED_CONTAINER_TYPES.has(r.containerType)))
}
export function splitContainersBeds(rows) {
  const beds = [], containers = []
  for (const r of (rows || [])) (isBedRow(r) ? beds : containers).push(r)
  return { beds, containers }
}

// V4-DORMANTRESUME-001 — the dormant bucket, which the engine has always emitted and no surface has
// ever read. Deliberately NOT part of buildCareNeeded: dormancy carries no action, so folding it
// into the actionable list would put a row on the care list that nothing can be logged against.
// It is a separate ambient list instead — the point is that a dormant planting is otherwise hidden
// from every arm of the app, so an overwintered crop that wakes up has nowhere to be seen.
//
// `resumable` gates the Resume action and is fail-CLOSED on the dangerous direction. Only
// reason==='status' resumes: that status was set by a human tap and no automation ever clears it
// (the one-way trap overwinter.js:203 names). reason==='profile' is the Lithops cadence flag — it
// has no status to clear and its whole purpose is "watering now = rot/death", so offering to end
// its dormancy is the one thing this list must never do. A plan stored BEFORE the engine shipped
// `reason` carries neither value: those rows still LIST (visibility is the SPA's half of the fix
// and needs no Lambda) but stay un-resumable until the discriminator is live, rather than guessing
// from the note string. Pure; preserves engine order.
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
