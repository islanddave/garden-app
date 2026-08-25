import React, { useCallback, useMemo, useState, useEffect } from 'react'
import { useFindings } from '../hooks/useFindings.js'
import { useApiFetch } from '../lib/api.js'
import FindingsList from '../components/findings/FindingsList.jsx'
import TodayReasoning from '../components/findings/TodayReasoning.jsx'
import GardenVisitors from '../components/findings/GardenVisitors.jsx'
import { P } from '../lib/constants.js'
import { useMembers } from '../hooks/useMembers.js'
import { useAuthOptional } from '../context/AuthContext.jsx'
import { buildProjectsById, effectiveAssignee, lensOptions, buildCaretakerMap } from '../lib/caretakers.js'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'

// Doctor Gardener — the DrG nav tab (/findings). Slice 8 (V4-THEME-001) "real but sparse":
// (1) honest sketch line, (2) Today's reasoning (read-only WHY from the daily plan — explains, does
// not duplicate Today's action list), (3) Health watch (findings from logged events), (4) ambient
// Garden visitors. Care plans CUT (no data source, would duplicate Today); Scan DEFERRED (no real
// entry point — anti-fabrication). Reward-UX V101: ambient only, no streak/badge/interrupt.
//
// DRG-RESOLVE-001: resolved findings are pulled OUT of the active Health watch (they were noise —
// lingered for ISSUE_WINDOW_DAYS with no owner control) and moved into a collapsed "Recently
// resolved" disclosure. The owner can also clear a live issue on their own timeline via the card's
// "Mark resolved" control (operational, not a reward), which PATCHes the source event.
export default function Findings() {
  const { data, loading, error, reload } = useFindings()
  const { fetch } = useApiFetch()
  const { profile } = useAuthOptional()
  const { members } = useMembers()
  // V4-ASSIGNLENS-001 — DrG caretaker lens. Default 'all'; narrowing filters findings by the
  // effective caretaker of each finding's planting (client cross-map from /api/plants+projects).
  const [lens, setLens] = useState(() => { try { return localStorage.getItem('garden.drgLens') || 'all' } catch { return 'all' } })
  const onLens = useCallback((v) => { setLens(v); try { localStorage.setItem('garden.drgLens', v) } catch { /* ignore */ } }, [])
  const careLensOptions = useMemo(() => lensOptions(members, profile?.id), [members, profile])
  const effectiveLens = careLensOptions.some(o => o.value === lens) ? lens : 'all'
  // V4-ASSIGNLENS-002 — same caretaker map the Garden tiles use, for the per-card badge.
  const caretakerMap = useMemo(() => buildCaretakerMap(members, profile?.id), [members, profile])
  const [assigneeByPlant, setAssigneeByPlant] = useState(null)
  useEffect(() => {
    // Load the plant->caretaker map whenever there is >1 caretaker — it now feeds BOTH the lens
    // filter (any non-'all' lens) AND the per-card badges (shown on the 'all'/Everyone view). A
    // single-caretaker household never loads it: no lens narrowing exists and badges add no signal.
    if (caretakerMap.size <= 1 || assigneeByPlant) return
    let on = true
    Promise.all([fetch('/api/plants').catch(() => null), fetch('/api/projects').catch(() => null)])
      .then(([pl, pj]) => {
        if (!on) return
        const plants = Array.isArray(pl) ? pl : []
        const pbid = buildProjectsById(Array.isArray(pj) ? pj : [])
        const m = new Map()
        for (const p of plants) m.set(p.id, effectiveAssignee(p, pbid))
        setAssigneeByPlant(m)
      })
    return () => { on = false }
  }, [caretakerMap, assigneeByPlant, fetch])
  // Fall back to unfiltered until the map loads (no empty flash); then filter by caretaker.
  const lensFilter = useCallback((list) => {
    if (effectiveLens === 'all' || !assigneeByPlant) return list
    return (list || []).filter(fd => (assigneeByPlant.get(fd.plant_id) ?? null) === effectiveLens)
  }, [effectiveLens, assigneeByPlant])

  const all = data?.findings
  const { active, resolved } = useMemo(() => {
    const list = Array.isArray(all) ? all : []
    return {
      active: list.filter(f => f.decay_state !== 'resolved'),
      resolved: list.filter(f => f.decay_state === 'resolved'),
    }
  }, [all])
  const activeShown = useMemo(() => lensFilter(active), [active, lensFilter])
  const resolvedShown = useMemo(() => lensFilter(resolved), [resolved, lensFilter])

  // V4-ASSIGNLENS-002 — per-card caretaker badges (mirrors Garden's showBadges gate). Only when a
  // multi-caretaker household is viewing a set that actually SPANS >1 caretaker do badges add signal;
  // a single-caretaker set suppresses them as noise. Mixed-ness is computed over the union of what we
  // render badges on (active + resolved), so both FindingsList instances agree.
  const showBadges = useMemo(() => {
    if (caretakerMap.size <= 1 || !assigneeByPlant) return false
    const seen = new Set()
    for (const fd of [...activeShown, ...resolvedShown]) {
      seen.add(assigneeByPlant.get(fd.plant_id) ?? null)
      if (seen.size > 1) return true
    }
    return false
  }, [caretakerMap, assigneeByPlant, activeShown, resolvedShown])
  const caretakerFor = useCallback((fd) => (
    showBadges ? (caretakerMap.get(assigneeByPlant?.get(fd.plant_id) ?? null) || null) : null
  ), [showBadges, caretakerMap, assigneeByPlant])

  // BUG-SILENTFAILSWEEP-001 — the rejection is PROPAGATED on purpose: FindingCard awaits this and is
  // the surface for it (it stays put, un-busies and names the failure beside the button that was
  // tapped), and a second message here would report one tap twice. reload() stays inside the chain
  // so a resolve that never landed cannot refresh the list and make the card look handled.
  //
  // The terminal handler below is the part that was missing: with no catch anywhere on this side,
  // the card's catch was the ONLY thing between a failed resolve and an unhandled rejection, which
  // is a guarantee this page cannot make on a child's behalf. `done` still rejects for the awaiting
  // caller — the no-op only claims the branch nobody is holding.
  const handleResolve = useCallback((eventId) => {
    if (!eventId) return Promise.resolve()
    const done = fetch(`/api/events/${eventId}`, { method: 'PATCH', body: JSON.stringify({ resolved: true }) })
      .then(() => reload())
    done.catch(() => {})
    return done
  }, [fetch, reload])

  return (
    <div style={{ padding: 16, paddingBottom: 32, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: P.dark, marginBottom: 4 }}>
        Doctor Gardener
      </h1>
      <p style={{ fontSize: '0.84rem', color: P.light, marginTop: 0, marginBottom: 18, lineHeight: 1.45 }}>
        Doctor Gardener is learning your garden. Right now it explains today&rsquo;s care and flags issues worth a look &mdash; more reasoning lands as it watches longer.
      </p>

      <TodayReasoning />

      {careLensOptions.length > 2 && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '0 0 12px' }}>
          <SegmentedControl options={careLensOptions} value={effectiveLens} onChange={onLens} ariaLabel="Show findings by caretaker" />
        </div>
      )}

      <section aria-labelledby="drg-health-h">
        <h2 id="drg-health-h" style={{ fontSize: '1rem', fontWeight: 700, color: P.dark, margin: '0 0 8px' }}>
          Health watch
        </h2>
        {loading && <div style={{ padding: 20, color: P.light, textAlign: 'center' }}>Loading&hellip;</div>}
        {error && <div style={{ padding: 20, color: P.terra, textAlign: 'center' }}>{error}</div>}
        {!loading && !error && <FindingsList findings={activeShown} onResolve={handleResolve} caretakerFor={caretakerFor} />}

        {!loading && !error && resolvedShown.length > 0 && (
          <details style={{ marginTop: 16 }}>
            <summary style={{
              cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, color: P.light,
              listStyle: 'revert', padding: '4px 0',
            }}>
              Recently resolved ({resolvedShown.length})
            </summary>
            <div style={{ marginTop: 10 }}>
              <FindingsList findings={resolvedShown} caretakerFor={caretakerFor} />
            </div>
          </details>
        )}
      </section>

      <GardenVisitors />
    </div>
  )
}
