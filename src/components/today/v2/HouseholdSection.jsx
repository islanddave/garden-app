import React, { useCallback, useEffect, useMemo } from 'react'
import TodaySection from './TodaySection.jsx'
import NeedsCare from './NeedsCare.jsx'
import { useNeedsCare } from './useNeedsCare.js'
import { taskCounts } from '../../../lib/todayV2/chips.js'

// HouseholdSection — one other member's care on the redesigned Today ("Jen's care · 15", summary "Water 8 ·
// Feed 7"). V5-TODAYREDESIGN-001 S6; plan-v2 §1.0 row 7, §1.6, §2.9, §13 SF6.
//
// SHOWN ONLY WHEN the viewer has the household view on — V1's per-device opt-in (lib/householdView.js
// readShowOthers(), SF6) — and only for a member with care rows today; the page decides both, and names the
// member by householdView's memberFirstName() ("Jen", else "Someone else"), as V1 does (TodayV2). The
// section is CLOSED by default and NEVER opens by itself: no trigger reads a household plan, so its open/closed
// comes only from an explicit tap (Layer 1, key `hh-<first 8 of the member's sub>`) or Expand/Collapse all.
//
// THE SAME ROW ANATOMY: the body IS the Needs care body (NeedsCare) over the member's plan — groups, spots, Water
// all, Not today, the plant rows — through the same page-level state hook (useNeedsCare → useCareActions), so its
// skips land in the page's ONE shared skip set (careStore), the set V1's household list reads too. Logging on a
// member's planting goes through the same household-scoped POST /api/events (V4-ASSIGNLENS-001).
//
// NO COLD ROWS: useNeedsCare keeps the care needs only (water / never / feed / check). A member's tender plants on
// a frost night belong to Protect tonight, labelled "(Jen)" (S5; plan §10 item 6, Dave's default) — one home each.
//
// Its visit state is the member's own slot on the visit record (record.hh[<key>]): NeedsCare reads and writes
// `record.care`, so it is handed a VIEW of the record whose `care` is that slot, and an update that writes the slot
// back. The slot's held layout (group + spot order, exceptions) is taken on the section's first render — the
// visit's ready point — and restored with the record on a Back return. The list's session stores (its filter
// selection, its logged-today guard) are scoped to this section, never shared with the viewer's own Needs care.
export const householdKey = (userId) => 'hh-' + String(userId ?? '').slice(0, 8)

const TASK_WORDS = [['water', 'Water'], ['feed', 'Feed'], ['check', 'Check']]

export function householdSummary(rows) {
  const n = taskCounts(rows)
  return TASK_WORDS.filter(([t]) => n[t] > 0).map(([t, w]) => `${w} ${n[t]}`).join(' · ') || 'All caught up.'
}

export default function HouseholdSection({ sectionKey, name, plan, planDate, viewerId, stale, record, update, announce, open, onToggle, writesHeld }) {
  const listId = `${viewerId || 'anon'}~${sectionKey}`
  const needs = useNeedsCare({ plan, planDate, userId: listId, stale })

  const snapshot = needs.snapshot
  useEffect(() => {
    if (!record || record.hh?.[sectionKey]) return
    update((r) => (r.hh?.[sectionKey] ? r : { ...r, hh: { ...(r.hh || {}), [sectionKey]: snapshot() } }))
  }, [record, sectionKey, update, snapshot])

  const view = useMemo(() => (record ? { ...record, care: record.hh?.[sectionKey] || null } : record), [record, sectionKey])
  const updateView = useCallback((fn) => update((r) => {
    const next = fn({ ...r, care: r.hh?.[sectionKey] || {} })
    return { ...r, hh: { ...(r.hh || {}), [sectionKey]: next.care } }
  }), [update, sectionKey])

  return (
    <TodaySection
      sectionKey={sectionKey}
      title={`${name}’s care`}
      count={needs.rows.length || null}
      summary={householdSummary(needs.rows)}
      open={open}
      onToggle={onToggle}
    >
      <NeedsCare care={needs} record={view} update={updateView} announce={announce} planDate={planDate} userId={listId} writesHeld={writesHeld} />
    </TodaySection>
  )
}
