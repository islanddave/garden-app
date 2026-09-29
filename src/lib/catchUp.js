// catchUp.js — V5-PLANTSTARTDATES-001. The pure half of /plants/catch-up: who is listed, which
// months a picker offers, which day a month is stored as, and the exact PUT body. No React, so every
// rule here is testable without rendering the page.
//
// WHY THE PAGE EXISTS. Plantings added in a hurry carry no start date at all, and a planting with
// neither a sown date nor a planted-out date cannot say when anything went in — on its own detail
// page, in the maturity estimate, or on the public website (eight published plantings at authoring:
// King of the North, Purple Tiger, Biquinho Yellow F1, Emerald Green, Piquin, Palmetto Punch,
// Sweet Chocolate, Black Krim). Most of those dates are recoverable to the month from memory or
// from the photos, which is the precision this page asks for and the precision it records.
import { growYearOfDayKey } from './growYear.js'
import { etDay } from './harvestSummary.js'
import { buildLocationGroupedList, SORT_ALPHA } from './projectTree.js'

// LISTED = live AND has NEITHER start date. Any status, ended and failed included: a start date is
// part of the record whether or not the plant is still growing. Deleted and archived rows never
// arrive from GET /api/plants (both are filtered in SQL); they are refused here as well so the rule
// holds for any list handed in, not only for the one read the page makes today.
// Only sown_at and planted_out_at count. germinated_at/transplanted_at do not answer "when did this
// go in" (a transplant date alone is a potting-on), and the legacy planted_at column is not in the
// list read at all.
export function needsStartDates(p) {
  if (!p || p.deleted_at != null || p.archived_at != null) return false
  return !p.sown_at && !p.planted_out_at
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// 'YYYY-MM' -> 'Sep 2026'. String math, never a Date: a Date built from a bare month parses as UTC
// midnight, which is the previous evening in New York, and the label would name the wrong month.
export function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym ?? ''))
  if (!m) return ''
  return `${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}`
}

// Today as an ET day key ('YYYY-MM-DD'), the zone every garden date is judged in.
export function todayKey(now = new Date()) {
  return etDay(now)
}

// The grow year a planting belongs to (growYear.js: Nov 1 – Oct 31, "2026" = the season ending
// Oct 2026) is the one its record was created in. For a planting added this season that IS the 2026
// grow year; a planting carried over from last season gets last season's months rather than months it
// cannot have started in. No usable created_at falls back to the grow year today is in.
export function plantingGrowYear(p, today) {
  return growYearOfDayKey(etDay(p?.created_at)) ?? growYearOfDayKey(today)
}

// The months a picker offers: that grow year, Nov first, oldest first, and NOTHING AFTER TODAY'S
// MONTH — a start date cannot be in the future, so a future month is never offered as a choice.
export function monthOptions(growYear, today) {
  const cap = String(today).slice(0, 7)
  const out = []
  for (let i = 0; i < 12; i++) {
    const m = ((10 + i) % 12) + 1 // 11, 12, 1 … 10
    const ym = `${m >= 11 ? growYear - 1 : growYear}-${String(m).padStart(2, '0')}`
    if (ym > cap) break
    out.push(ym)
  }
  return out
}

// THE DAY A MONTH IS STORED AS: the 15th. PlantingEditor has no month precision to copy — it stores
// the exact day typed plus a separate "approx" checkbox — so this follows the one coarse-date rule
// the app already has: Put-Up's coarseDate stores a vague answer as its window's MIDPOINT with
// approx=true (lib/putUpSession.js). Mid-month is also the day that is never more than about two
// weeks from the truth. Clamped to today for the current month before its 15th, for the same
// never-in-the-future reason coarseDate clamps.
export function monthToDate(ym, today) {
  const d = `${ym}-15`
  return d > today ? today : d
}

// The planted-out month may equal the sown month but not precede it. TransplantDatePrompt holds the
// sow date as the same hard floor for the same reason: an out-of-order pair is a record that
// contradicts itself.
export function outBeforeSown(draft) {
  return Boolean(draft?.sown && draft?.plantedOut && draft.plantedOut < draft.sown)
}

// The PUT body: ONLY the chosen date(s), each with its *_approx = true. Nothing else rides along —
// the Lambda's PUT is a COALESCE partial update, so an absent key leaves that column untouched, and
// the BUG-SOWNAPPROXORPHAN-001 guard there drops any flag sent without its date.
export function catchUpBody(draft, today) {
  const body = {}
  if (draft?.sown) {
    body.sown_at = monthToDate(draft.sown, today)
    body.sown_at_approx = true
  }
  if (draft?.plantedOut) {
    body.planted_out_at = monthToDate(draft.plantedOut, today)
    body.planted_out_at_approx = true
  }
  return body
}

// Location groups, reusing Garden's own location grouping so the groups, their order and the
// "Unsorted" bucket read exactly as they do under Garden's group-by-location. That helper emits empty
// locations on purpose (a place to fill); a to-do list does not want them.
export function groupCatchUpRows(rows, locations) {
  return buildLocationGroupedList(rows, SORT_ALPHA, locations).filter(g => g.count > 0)
}

// 'Drive › Raised bed 2'. The group helper labels a nested location by its own name only, and with
// empty groups dropped a child can appear without its parent above it, so the header carries the
// path. Cycle-safe: a parent loop stops at the first repeat rather than walking forever.
export function locationPath(id, locations) {
  const byId = new Map((locations || []).filter(l => l && l.id).map(l => [l.id, l]))
  const names = []
  const seen = new Set()
  let cur = byId.get(id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    names.unshift(cur.name || 'Location')
    cur = cur.parent_id ? byId.get(cur.parent_id) : null
  }
  return names.join(' › ')
}
