import { useMemo } from 'react'
import { useCachedFetch } from '../../../hooks/useCachedFetch.js'
import { storageDeadlineGroups } from '../StorageDeadlineAlert.jsx'
import { headsupTrigger } from '../../../lib/todayV2/triggers.js'
import { todayLocalISO } from '../../../lib/dateLocal.js'

// useHeadsUp — Heads-up's STATE, owned by the page (V5-TODAYREDESIGN-001 S5; plan-v2 §1.5, §3, D5 "storage
// deadlines"). The groups are V1's own (StorageDeadlineAlert's storageDeadlineGroups: sourced deadlines only,
// check-form copy verbatim, ended / failed plantings dropped, 14-day grace, at most two), read off the shared
// /api/plants request and the DEVICE date — never the plan, so it renders with no plan and a stale plan does not
// silence it. The trigger (triggers.js headsupTrigger): the day a window opens, and the last two days before its
// deadline.
const SHORT = { month: 'short', day: 'numeric', timeZone: 'UTC' }
export const plateDate = (iso) => (iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', SHORT) : '')

// The copy's verbatim prefix — up to its first " — " — and the rest (§4 "Heads-up row").
export function splitCopy(copy) {
  const s = String(copy || '')
  const i = s.indexOf(' — ')
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 3)]
}

// The date plate: "by Oct 10" while the window is open, "was due Oct 10" in the grace phase.
export const plateText = (g) => `${g.phase === 'past' ? 'was due' : 'by'} ${plateDate(g.deadlineISO)}`
// The last two days before the deadline, the deadline day included: the plate turns warn (§4, §5.9).
export const deadlineSoon = (g) => g.phase === 'check' && typeof g.daysUntil === 'number' && g.daysUntil >= 0 && g.daysUntil <= 2

// The band's one-line summary (§1.5): one group reads its own words and plate ("Start checking sweet potatoes
// for lifting · by Oct 10"); two read each crop's name and plate.
export function headsupSummary(groups) {
  if (!groups.length) return null
  if (groups.length === 1) return `${splitCopy(groups[0].copy)[0]} · ${plateText(groups[0])}`
  return groups.map((g) => `${g.displayName || g.slug} ${plateText(g)}`).join(' · ')
}

export function useHeadsUp() {
  const plants = useCachedFetch('/api/plants')
  const today = todayLocalISO()
  const groups = useMemo(() => storageDeadlineGroups(plants.data, today), [plants.data, today])
  const trigger = useMemo(() => headsupTrigger(groups, today), [groups, today])
  // No `settled` of its own: the page's ready point already waits for /api/plants through useProtect.
  return { groups, count: groups.length, trigger, today, summary: headsupSummary(groups) }
}
