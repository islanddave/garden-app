import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApiFetch } from '../../../lib/api.js'
import { useCachedFetch } from '../../../hooks/useCachedFetch.js'
import { useMembers } from '../../../hooks/useMembers.js'
import { useCareActions } from '../useCareActions.js'
import { enrichRows, locationIndex } from '../../../lib/todayV2/spots.js'
import { coldRows, protectOrder, protectSummary, pickNight } from '../../../lib/todayV2/protect.js'
import { protectTier, protectTrigger, tonightLowRaw, frostNamesTonight } from '../../../lib/todayV2/triggers.js'
import { agreedTonightLow } from '../../../lib/tonightLow.js'
import { readShowOthers, memberFirstName } from '../../../lib/householdView.js'
import { loggedKey } from './needsCareStore.js'
import { useTodayLogged } from './useTodayLogged.js'
import { seenKey, readSeen, markSeen } from './todaySeen.js'

// useProtect — Protect tonight's STATE, owned by the page (V5-TODAYREDESIGN-001 S5), as useNeedsCare owns Needs
// care's: the header count and summary, the chip count, the trigger and the visit's held order are all taken at
// the ready point, before the body (ProtectTonight.jsx) mounts — and the body is unmounted while closed.
//
// Rows: the viewer's cold rows, plus — only when this person has the household view on (SF6, lib/householdView.js,
// the one reader) — every other member's, each named ("Jen"); minus the keys held elsewhere in this tab
// (useTodayLogged over needsCareStore's `today-logged:`, shared with Needs care: a Back remount can paint the last
// good plan before the refetch, §6.3). The write paths (Covered / Cover all → `cover`, Brought in → `brought_inside`, Skip →
// the one shared skip set) are useCareActions', with the V2 options. /api/plants + /api/locations place each row
// in its spot (spots.js), through the same cached requests Needs care reads.
//
// The tier (triggers.js) reads the ONE low Today prints and the frost line naming tonight; the trigger adds the
// chill first-night rule, read from this device's today-seen store — and this hook MARKS every protect planting
// it shows on a fresh plan (a stale plan marks nothing: its day is not tonight).
const SILENT = { show() {}, showUndo() {} }
const NOOP = () => {}

export function useProtect({ plan, planDate, userId, stale, householdPlans, careRows }) {
  const { fetch, getToken } = useApiFetch()
  const plants = useCachedFetch('/api/plants')
  const locations = useCachedFetch('/api/locations')
  const [showOthers] = useState(readShowOthers)
  const { members, loading: membersLoading } = useMembers()

  const logKey = loggedKey(userId, planDate)
  const { held, claim } = useTodayLogged(logKey)
  const own = useMemo(() => coldRows(plan, null), [plan])
  const others = useMemo(() => (showOthers && Array.isArray(householdPlans)
    ? householdPlans.flatMap((hp) => coldRows(hp && hp.plan, memberFirstName(members, hp && hp.user_id)))
    : []), [showOthers, householdPlans, members])
  const allRows = useMemo(() => [...own, ...others].filter((r) => !held.has(r.key)), [own, others, held])
  const actions = useCareActions({ allRows, planDate, fetch, getToken, toast: SILENT, announce: NOOP })

  // As useNeedsCare: an errored /api/plants is no plant list (review 4160.2 IMPORTANT-3), so no Unplaced cover row.
  const plantList = Array.isArray(plants.data) && !plants.error ? plants.data : null
  const locPayload = locations.data && !locations.error ? locations.data : null
  const enrich = useCallback((rows) => enrichRows(rows, { plan, plants: plantList, locations: locPayload }), [plan, plantList, locPayload])
  const rows = useMemo(() => enrich(actions.rows), [enrich, actions.rows])
  // Every cold row of the plan day, handled or not — a handled row keeps its place as a done line (§2.5).
  const allEnriched = useMemo(() => enrich(allRows), [enrich, allRows])
  const groupOrder = useMemo(() => locationIndex(locPayload).groupOrder, [locPayload])
  // Names wait for the roster only when a household row needs one, so a first paint never says "Someone else".
  const settled = !plants.loading && !locations.loading && !(others.length && membersLoading)

  const agreed = useMemo(() => agreedTonightLow(plan), [plan])
  const lowRaw = tonightLowRaw(plan, agreed)
  const lowF = agreed ? agreed.lowF : (lowRaw != null ? Math.round(lowRaw) : null)
  const frostTonight = useMemo(() => frostNamesTonight(plan), [plan])
  // The NIGHT's tier (the summary's words, the pick link) over every cold row of the day, so handling rows
  // mid-visit never changes what the night is; the trigger below reads the rows still to do.
  const tier = allRows.length ? protectTier({ lowRaw, frostTonight, levels: allRows.map((r) => r.level) }) : null
  const sKey = seenKey(userId)
  const trigger = useMemo(
    () => protectTrigger({ rows, lowRaw, frostTonight, seen: readSeen(sKey, planDate), planDate, stale }),
    [rows, lowRaw, frostTonight, sKey, planDate, stale],
  )

  // First sightings, device-local: every protect planting this fresh plan shows. Same-day marks never change the
  // trigger (first seen on the plan day still counts as the first night), so the order against the ready point
  // does not matter.
  const seenIds = allRows.filter((r) => r.level === 'protect').map((r) => r.plantingId).join(',')
  useEffect(() => {
    if (!stale && planDate && sKey && seenIds) markSeen(sKey, planDate, seenIds.split(','))
  }, [stale, planDate, sKey, seenIds])

  // The visit's held order, taken at the ready point over "rows minus skipped, logged kept" (as Needs care's).
  const snapshot = useCallback(() => ({
    order: protectOrder(allEnriched.filter((r) => !actions.skipped.has(r.key)), careRows, groupOrder),
    rowsDone: {}, batches: {}, failed: {}, open: [],
  }), [allEnriched, actions.skipped, careRows, groupOrder])
  // The summary names the rows still to do in the order the body lists them (the same spot order).
  const summary = useMemo(() => {
    if (!rows.length) return null
    const rank = new Map(protectOrder(rows, careRows, groupOrder).map((k, i) => [k, i]))
    return protectSummary({ tier, lowF, rows: [...rows].sort((a, b) => rank.get(a.key) - rank.get(b.key)) })
  }, [rows, careRows, groupOrder, tier, lowF])

  return {
    rows, allEnriched, count: rows.length, tier, lowF, trigger, settled, actions, getToken, logKey, claim, snapshot,
    pick: pickNight(tier), summary,
  }
}
