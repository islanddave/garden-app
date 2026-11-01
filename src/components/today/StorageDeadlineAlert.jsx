// An OPERATIONAL ALERT for storage-crop deadlines, deliberately not a band. HarvestReadyBand (a
// standing "these look ready" list, always there and mostly speculative, handing the reader a triage
// job) has ZERO render sites; building into it would ship an inert feature. "Dig the sweet potatoes
// this week or lose them" is categorically different: time-bounded, actionable, and failing to act
// destroys the crop. `gardening.md` §Reward UX draws exactly that line: frost/heat/watering-crisis/
// disease warnings are operational alerts, explicitly NOT reward surfaces.
//
// THE SHAPE IS THE FEATURE: it renders NOTHING unless a sourced deadline is actually near. The
// absence is what makes the presence mean something. Do not "fix" the silence by widening the
// criteria: the moment this shows a row that is merely plausible, it is the ready band again.
//
// AMBIENT, NOT AN INTERRUPT. The interrupt-exception in §Reward UX PERMITS an interrupt for
// simultaneously time-sensitive + actionable + harm-on-inaction events (imminent plant loss is
// named), but permitting is not requiring, and any interrupt needs explicit approval, which has NOT
// been given. So: an in-flow note on the surface opened daily. No push, no modal, no toast, no
// sheet, no overlay, no sound, no haptic, no count badge, and no call to
// Notification.requestPermission().
//
// TWO TIME BOUNDS, BOTH LOAD-BEARING:
//  • `upcoming` is silent, from the lib: before the check window opens there is nothing honest to
//    say, and a countdown would be the assertion form wearing a clock.
//  • `past` is silent again after PAST_GRACE_DAYS. storageDeadlines' own `past` phase runs from the
//    deadline to Dec 31 (the year rolls at New Year), so rendering every past record would leave a
//    "window has passed" line standing on Today for weeks: a standing list with extra steps.
//
// STATUS GATE. `ended`/`failed` plantings are dropped: telling the user to lift a planting they
// have already closed out makes the alert ignorable. `harvested` is deliberately NOT dropped:
// constants.js labels that DB value "Harvesting", i.e. picking is in progress, which for a storage
// crop does not mean the ground is empty.
//
// COPY IS THE DATASET'S, VERBATIM. `src/data/storageDeadlines.json` owns the words and carries the
// provenance rule; this file renders `check_copy`/`past_copy` and adds no claim of its own. Copy is
// check-form ("start checking X"), never assertion-form ("X is ready"): the one date in the
// dataset is a regional proxy for vine kill, an observed plant state nobody is recording.
//
// Ambient posture matches its neighbours on Today: self-fetching, error swallowed, hidden when
// empty, and pure date math with `todayISO` injectable so nothing depends on the test clock.
import React, { useMemo } from 'react'
import { useCachedFetch } from '../../hooks/useCachedFetch.js'
import { P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'
import { todayLocalISO } from '../../lib/dateLocal.js'
import {
  plantingsWithOpenDeadline,
  DEADLINES_BY_CROP_TYPE,
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
 *
 * Each group also carries the window's own dates (`checkFromISO`, `deadlineISO`, from
 * storageDeadlineStatus) and the dataset's `displayName`, which the redesigned Today's Heads-up
 * reads: its auto-open keys on the day the window opens and the last two days before the deadline,
 * and its date plate names the deadline. ADDITIVE ONLY: this component renders none of them, so
 * V1's alert is unchanged.
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
      g = {
        slug, phase: status.phase, copy: status.copy, daysUntil: status.daysUntil, names: [],
        checkFromISO: status.checkFromISO, deadlineISO: status.deadlineISO,
        displayName: DEADLINES_BY_CROP_TYPE[slug]?.display_name ?? null,
      }
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
  // Shares ONE /api/plants request with CareNeeded rather than issuing a second copy of the same
  // large list on the same paint (dataCache's in-flight dedup: both mount inside one tick, so the
  // second register/revalidate joins the first's promise). Still ambient and self-fetching: the
  // hook owns the request, this component owns nothing but the render.
  // Error stays SWALLOWED: a cold failure leaves `data` undefined, and storageDeadlineGroups
  // returns [] for anything that isn't an array, so the alert renders nothing.
  const { data: plantings } = useCachedFetch('/api/plants')

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
