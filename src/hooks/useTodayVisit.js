// useTodayVisit — the redesigned Today's VISIT, Layer 2 (plan-v2 §2.1, §2.2). V5-TODAYREDESIGN-001 S2.
//
// WHAT A VISIT IS. It starts at the page's READY point (§6.4) on a mount that is NOT a page-scroll-manager
// return (app launch, a tab tap, a push from another page), and again whenever plan_date changes while the
// page is mounted — the day changes in place, never by remounting. It CONTINUES across a POP return (Back
// from a planting, a reload, a tab restore) for the same user and plan day: the stored record is restored
// exactly, in the first render, so the page-scroll manager's pixel restore lands on the same layout.
//
// THE RECORD (visitLayout.js, sessionStorage 'today-visit:<user>:<plan_date>:v2'):
//   order.sections  the sections present at the ready point — their slots are held for the visit
//   layer1          Layer 1 (useTodaySections) as read at the ready point, per present section
//   overlay         visit-only opens/closes: Expand/Collapse all, a chip jump (S3), a trigger (S5)
//   triggers        the trigger descriptors that fired at the ready point (S5) — a close made while one has
//                   the section open is what records a date-scoped ack
//   order.chips     the jump-bar chips present at the ready point (S3) — held for the visit
//   filter          a jump chip's PRE-SELECT INTENT per section (S3 writes it, S4's filter row reads it):
//                   filter.care = { tasks: ['water'|'feed'|'check'], n } — "replace the task filter with this
//                   task". `n` counts the chip taps of this visit, so a second tap of the same chip is a new
//                   intent; a reader applies each n once. Visit-only, like every overlay here.
// Effective open = overlay > layer1 > closed. An explicit header tap is the page's to route: it writes Layer
// 1 (useTodaySections.remember) and calls `tap`, which records the new state and clears the overlay, so the
// tap wins for the rest of the visit. A section that appears mid-visit is in no snapshot: it is closed.
//
// `start()` is the page's snapshot at the ready point, called during render: it must be pure.
import { useCallback, useEffect, useState } from 'react'
import { usePageScrollReturnAtMount } from './usePageScrollManager.js'
import { visitLayoutKey, readVisitRecord, writeVisitRecord, V2_LIST } from '../components/today/visitLayout.js'

const newVisitId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export function effectiveOpen(record, key) {
  if (!record) return false
  const o = record.overlay?.[key]
  if (o === 'open') return true
  if (o === 'closed') return false
  return record.layer1?.[key] === true
}

export function useTodayVisit({ userId, planDate, ready, start }) {
  const returned = usePageScrollReturnAtMount()
  const key = visitLayoutKey(userId, planDate, V2_LIST)
  const [state, setState] = useState(null) // { planDate, record }

  let record = state && state.planDate === (planDate ?? null) ? state.record : null
  if (!record && ready) {
    // A return restores this tab's record for the day; anything else — or a return with nothing stored, or a
    // day that changed under a mounted page (a new key, nothing stored under it) — is a fresh visit.
    const restored = returned ? readVisitRecord(key) : null
    record = restored || { id: newVisitId(), triggers: {}, overlay: {}, ...start(), v: 1, kind: 'v2' }
    setState({ planDate: planDate ?? null, record })
  }

  useEffect(() => { if (record && key) writeVisitRecord(key, record) }, [key, record])
  // A new plan day whose visit has not started yet (the page is re-reading prefs for it): keep showing the
  // last visit rather than blanking the sections for that moment. Shown only — never stored under the new
  // day's key, where a Back would restore it as that day's layout.
  const shown = record || (!ready && state ? state.record : null)

  const update = useCallback((fn) => {
    setState((s) => (s && s.record ? { ...s, record: fn(s.record) } : s))
  }, [])

  // An explicit header tap: this is now the section's state for the visit; any overlay on it is spent.
  const tap = useCallback((section, open) => update((r) => {
    const overlay = { ...r.overlay }
    delete overlay[section]
    return { ...r, layer1: { ...r.layer1, [section]: !!open }, overlay }
  }), [update])

  // Expand all / Collapse all, a chip jump: visit-only, never remembered.
  const overlayAll = useCallback((sections, value) => update((r) => {
    const overlay = { ...r.overlay }
    for (const s of sections) overlay[s] = value
    return { ...r, overlay }
  }), [update])

  // A jump chip's pre-select intent for a section's filter row (S3 → S4): replaces the section's intent and
  // counts the tap, so the same chip tapped twice is two intents.
  const setFilter = useCallback((section, value) => update((r) => {
    const prev = r.filter?.[section]
    return { ...r, filter: { ...(r.filter || {}), [section]: { ...value, n: ((prev && prev.n) || 0) + 1 } } }
  }), [update])

  const isOpen = useCallback((section) => effectiveOpen(shown, section), [shown])

  // S4: a slice's own fields on the record (Needs care's open spots, done lines, runs) — `fn(record)` → record.
  return { record: shown, returned, isOpen, tap, overlayAll, update, setFilter }
}
