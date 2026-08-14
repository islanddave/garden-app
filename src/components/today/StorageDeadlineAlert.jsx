// src/components/today/StorageDeadlineAlert.jsx — V4-STORAGEDEADLINE-001.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT. The ledger row asked for these deadlines inside
// HarvestReadyBand. That band has ZERO render sites: Dave unmounted it from Today on 2026-08-13
// (BD-008 / V4-HIDEREADYBAND-001) precisely because he was ignoring it, and ignoring it was the
// right call — a standing "these look ready" list is always there, mostly speculative, and hands
// the reader a triage job. Building into it would have shipped an inert feature.
//
// Dave's ruling 2026-08-14: build this as an OPERATIONAL ALERT, not a band. "Dig the sweet potatoes
// this week or lose them" is a categorically different statement from "these look ready" — it is
// time-bounded, actionable, and failing to act destroys the crop. `gardening.md` §Reward UX draws
// exactly that line: frost/heat/watering-crisis/disease warnings are operational alerts, explicitly
// NOT reward surfaces.
//
// THE SHAPE IS THE FEATURE: it renders NOTHING unless a sourced deadline is actually near. On
// 2026-08-14 that means it renders nothing at all, and will keep rendering nothing until Oct 1.
// The absence is what makes the presence mean something. Do not "fix" the silence by widening the
// criteria — the moment this shows a row that is merely plausible, it is the ready band again.
//
// AMBIENT, NOT AN INTERRUPT. The interrupt-exception in §Reward UX PERMITS an interrupt for
// simultaneously time-sensitive + actionable + harm-on-inaction events (imminent plant loss is
// named), but permitting is not requiring, and any interrupt needs explicit Dave approval which has
// NOT been given. So: an in-flow note on the surface he already opens daily. No push, no modal, no
// toast, no sheet, no overlay, no sound, no haptic, no count badge, and no call to
// Notification.requestPermission(). If an interrupt is ever wanted, that is a separate Dave call.
//
// TWO TIME BOUNDS, BOTH LOAD-BEARING:
//  • `upcoming` is silent, from the lib — before the check window opens there is nothing honest to
//    say, and a countdown would be the assertion form wearing a clock.
//  • `past` is silent again after PAST_GRACE_DAYS. storageDeadlines' own `past` phase runs from the
//    deadline to Dec 31 (the year rolls at New Year), so rendering every past record would leave a
//    "window has passed" line standing on Today for 77 days. That is a standing list with extra
//    steps — the exact thing this component exists to not be.
//
// STATUS GATE. `ended`/`failed` plantings are dropped: telling Dave to lift a planting he has
// already closed out is the fastest way to make the alert ignorable. `harvested` is deliberately
// NOT dropped — constants.js labels that DB value "Harvesting" (V3-STATUS-003), i.e. picking is in
// progress, which for a storage crop does not mean the ground is empty.
//
// COPY IS THE DATASET'S, VERBATIM. `src/data/storageDeadlines.json` owns the words and carries the
// provenance rule; this file renders `check_copy`/`past_copy` and adds no claim of its own. Copy is
// check-form ("start checking X"), never assertion-form ("X is ready") — the one date in the
// dataset is a regional proxy for a soil temperature nobody is measuring.
//
// Ambient posture matches its neighbours on Today: self-fetching, error swallowed, hidden when
// empty, and pure date math with `todayISO` injectable so nothing depends on the test clock.
import React, { useEffect, useMemo, useState } from 'react'
import { useApiFetch } from '../../lib/api.js'
import { P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'
import {
  plantingsWithOpenDeadline,
  PHASE_PAST,
} from '../../lib/storageDeadlines.js'

/** Never a third orient decision, same reasoning as CULTIVATION_LEAD_CAP. The live dataset can
 *  produce at most one group today; the cap is a ceiling on future data, not a filter on this. */
export const STORAGE_DEADLINE_CAP = 2

/** How long a missed deadline keeps saying so. Two weeks is long enough to still be actionable
 *  ("worth checking whether any are still in the ground") and short enough that it stops being
 *  furniture. Beyond it the alert goes silent rather than nagging until January. */
export const PAST_GRACE_DAYS = 14

/** Named plantings shown per crop before eliding. Names, not a count — a count is a badge. */
const NAMES_SHOWN = 3

/** Plantings the alert must not speak about, regardless of deadline. */
const CLOSED_STATUSES = new Set(['ended', 'failed'])

// Same local-ISO convention as CultivationLead/CareNeeded: bucket against the day Dave is looking at.
function todayLocalISO() {
  const d = new Date()
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

function plantingLabel(p) {
  const n = String(p?.name ?? '').trim()
  return n || 'Unnamed planting'
}

/**
 * Pure group builder, exported for tests.
 *
 * One group per CROP, not per planting — two sweet potato beds are one thing to go and do, and
 * repeating the same sourced sentence twice would read as two separate problems. Returns [] for
 * junk input and never throws; [] is the overwhelmingly common and CORRECT result.
 */
export function storageDeadlineGroups(plantings, todayISO, cap = STORAGE_DEADLINE_CAP) {
  if (!Array.isArray(plantings) || plantings.length === 0) return []

  const open = plantingsWithOpenDeadline(
    plantings.filter(p => p && !CLOSED_STATUSES.has(String(p.status ?? ''))),
    todayISO,
  )

  const byCrop = new Map()
  for (const { planting, status } of open) {
    // Grace bound on the past phase. daysUntil is negative once the deadline is behind us.
    if (status.phase === PHASE_PAST && status.daysUntil < -PAST_GRACE_DAYS) continue
    if (!status.copy) continue // no sourced sentence for this phase -> nothing honest to render
    const slug = planting?.variety_ref?.crop_type_slug
    if (!slug) continue
    let g = byCrop.get(slug)
    if (!g) {
      g = { slug, phase: status.phase, copy: status.copy, daysUntil: status.daysUntil, names: [] }
      byCrop.set(slug, g)
    }
    g.names.push(plantingLabel(planting))
  }

  return [...byCrop.values()]
    .map(g => ({ ...g, names: g.names.slice(0, NAMES_SHOWN) }))
    .sort((a, b) => a.daysUntil - b.daysUntil || a.slug.localeCompare(b.slug))
    .slice(0, cap)
}

export default function StorageDeadlineAlert({ todayISO = null }) {
  const { fetch } = useApiFetch()
  const [plantings, setPlantings] = useState(null)

  useEffect(() => {
    let alive = true
    fetch('/api/plants')
      .then(d => { if (alive) setPlantings(Array.isArray(d) ? d : []) })
      .catch(() => { /* ambient: never surface a fetch error onto Today */ })
    return () => { alive = false }
  }, [fetch])

  const day = todayISO ?? todayLocalISO()
  const groups = useMemo(() => storageDeadlineGroups(plantings, day), [plantings, day])

  // Renders NOTHING when nothing is at risk — never a blank strip, never a heading over silence.
  if (groups.length === 0) return null

  return (
    <div data-testid="storage-deadline-alert" style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {groups.map(g => (
        <div
          key={g.slug}
          data-testid={`storage-deadline-${g.slug}`}
          style={{
            background: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: 10,
            padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'flex-start',
          }}
        >
          <Icon name="severity.med" size={16} decorative style={{ flex: '0 0 auto', marginTop: 2 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '0.88rem', fontWeight: 600, color: P.dark, lineHeight: 1.4 }}>{g.copy}</div>
            {g.names.length > 0 && (
              <div style={{ fontSize: '0.78rem', color: P.mid, marginTop: 3, lineHeight: 1.35 }}>
                {g.names.join(' · ')}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
