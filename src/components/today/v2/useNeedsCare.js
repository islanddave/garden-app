import { useMemo, useCallback } from 'react'
import { useApiFetch } from '../../../lib/api.js'
import { useCachedFetch } from '../../../hooks/useCachedFetch.js'
import { buildCareNeeded, bedWaitActive } from '../../../lib/careNeeded.js'
import { useCareActions } from '../useCareActions.js'
import { locationIndex, enrichRows, takeOrder, exceptionKeys, careSummary, loggedTodayCount, caughtUpSummary, CAUGHT_UP_TITLE, OUTSIDE } from '../../../lib/todayV2/spots.js'
import { careReasons, careTrigger } from '../../../lib/todayV2/triggers.js'
import { loggedKey, readLogged } from './needsCareStore.js'
import { useTodayLogged } from './useTodayLogged.js'

// useNeedsCare — the redesigned Today's Needs care STATE, owned by the page (V5-TODAYREDESIGN-001 S4). The
// page needs it above the section: the header count and summary, the auto-open trigger and the visit's held
// order are all taken at the ready point (§6.4), before the body mounts — and the body (NeedsCare.jsx) is
// unmounted while the section is closed, so the care state cannot live there.
//
// Rows: buildCareNeeded(plan) (careNeeded.js decides WHICH plantings need WHAT), minus cold rows (Protect
// tonight's alone, §2.4) and minus the keys held elsewhere in this tab — logged today before this mount, or
// claimed by a run an earlier mount started (useTodayLogged over needsCareStore: a Back remount can paint
// the last good plan before the refetch — §6.3). The write paths and the optimistic fades are
// useCareActions', with the V2 options (S4). /api/plants + /api/locations join the rows to spots and groups
// (spots.js); both are read through useCachedFetch, so Protect and Heads-up (S5) share the one request.
const CARE_NEEDS = new Set(['water_due', 'no_history', 'fertilize', 'pest', 'overwintering'])
const SILENT = { show() {}, showUndo() {} }
const NOOP = () => {}

export function useNeedsCare({ plan, planDate, userId, stale }) {
  const { fetch, getToken } = useApiFetch()
  const plants = useCachedFetch('/api/plants')
  const locations = useCachedFetch('/api/locations')
  const settled = !plants.loading && !locations.loading
  const logKey = loggedKey(userId, planDate)
  // Writes this mount makes land in the hook's own fades; `held` is what other mounts logged or still hold.
  const { held, claim } = useTodayLogged(logKey)
  const due = useMemo(() => buildCareNeeded(plan).filter((r) => CARE_NEEDS.has(r.need)), [plan])
  const allRows = useMemo(() => due.filter((r) => !held.has(r.key)), [due, held])
  const bedWait = useMemo(() => bedWaitActive(plan), [plan])
  const actions = useCareActions({ allRows, bedWait, planDate, fetch, getToken, toast: SILENT, announce: NOOP })

  // A failed read is no read, for either list (review 4160.2 IMPORTANT-3): an errored /api/plants may still carry a
  // body (an empty array), and read as "no plantings anywhere" it would put the whole garden in one Unplaced spot.
  const plantList = Array.isArray(plants.data) && !plants.error ? plants.data : null
  const locPayload = locations.data && !locations.error ? locations.data : null
  const enrich = useCallback((rows) => enrichRows(rows, { plan, plants: plantList, locations: locPayload }), [plan, plantList, locPayload])
  const rows = useMemo(() => enrich(actions.rows), [enrich, actions.rows])
  // Every row of the plan day, handled or not — a handled row keeps its place as a done line (§2.5).
  const allEnriched = useMemo(() => enrich(allRows), [enrich, allRows])
  const groupOrder = useMemo(() => locationIndex(locPayload).groupOrder, [locPayload])
  // §3: the trigger reads the ACTIVE rows; a failed /api/plants means no container types, so small = false.
  const reasons = useMemo(() => careReasons({ rows, plan }), [rows, plan])
  const trigger = useMemo(() => careTrigger(reasons, { stale }), [reasons, stale])
  const spotCount = useMemo(() => new Set(rows.map((r) => r.spotKey)).size, [rows])
  const summary = useMemo(() => careSummary({ reasons, rows, spotCount }), [reasons, rows, spotCount])

  // The visit's held Needs care layout, taken at the ready point over "rows minus skipped, LOGGED KEPT"
  // (BD-036's orderingRows): group + spot order, each spot's differing rows, the 3 largest spots the spot
  // filter pins. Pure — useTodayVisit calls it during render.
  const snapshot = useCallback(() => {
    const ordering = enrich(allRows.filter((r) => !actions.skipped.has(r.key)))
    const order = takeOrder(ordering, groupOrder)
    const exceptions = {}
    const bySpot = new Map()
    for (const r of ordering) { if (!bySpot.has(r.spotKey)) bySpot.set(r.spotKey, []); bySpot.get(r.spotKey).push(r) }
    for (const [k, rs] of bySpot) exceptions[k] = exceptionKeys(rs.filter((r) => r.task === 'water'))
    const pinned = [...bySpot.entries()].sort((a, b) => (b[1].length - a[1].length) || String(a[1][0].spotName).localeCompare(String(b[1][0].spotName))).slice(0, 3).map(([k]) => k)
    return { order, exceptions, pinned, open: [], cohort: [], shown: {}, products: [], batches: {}, rowsDone: {} }
  }, [enrich, allRows, actions.skipped, groupOrder])

  // §2.5 (S4g): the emptied header — "Needs care · all caught up" over "95 logged today, 70 covered by rain".
  // The store is read live (a cheap sessionStorage read): every log and Undo re-renders the page anyway.
  const rainCovered = Array.isArray(plan?.rain_skipped) ? plan.rain_skipped.length : 0
  const loggedToday = loggedTodayCount(plan, readLogged(logKey))

  return {
    plan, settled, rows, allEnriched, count: rows.length, reasons, trigger, summary, spotCount, bedWait, actions, getToken, logKey, claim,
    rainCovered, loggedToday,
    caughtUp: { title: CAUGHT_UP_TITLE, summary: caughtUpSummary({ logged: loggedToday, rain: rainCovered }) },
    // Spots are LOCATIONS only when both reads answered (enrichRows); otherwise they are projects, with no group
    // header and no group Water all — the /api/locations fallback, now for a failed /api/plants too.
    snapshot, groupOrder, locationsOk: !!locPayload && !!plantList, outside: OUTSIDE,
    substrate: plan?.substrate?.msg && !plan?.substrate?.on_hold ? plan.substrate.msg : null,
  }
}
