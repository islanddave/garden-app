import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../../lib/constants.js'
import { SEVERITY_STYLES } from '../../lib/waterDue.js'
import { useApiFetch } from '../../lib/api.js'
import { useCachedFetch } from '../../hooks/useCachedFetch.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import GroupByControl from '../forms/GroupByControl.jsx'
import Sheet from '../forms/Sheet.jsx'
import Icon from '../Icon.jsx'
import PhotoImg from '../PhotoImg.jsx'
import {
  buildCareNeeded, groupRows, bedWaitActive, autoExpandKeys, waterStaleness, capStaleRows,
  bulkWaterNote, dormantRows,
  NEED_EVENT_TYPE, NEED_LABEL, NEED_ORDER, EXPAND_ROW_BUDGET, WATER_STALE_CAP, splitContainersBeds,
} from '../../lib/careNeeded.js'
import { fetchNotificationPrefs, saveTodaySkipped, readTodaySkipped } from '../../lib/notificationPrefsClient.js'

// CareNeeded — Slice 7 (V4-THEME-001) Care-Needed-Today. REPLACES the care-type PlanBuckets:
// location-grouped (default) need rows with ONE-TAP inline logging, per-need bulk, undo, and a
// suppress-for-today "skip". Operational surface (Reward-UX V101 §7): ambient only — no
// celebration / streak / badge / interrupt; the undo toast is operational, not a reward.
//
// Read-path parity: ALL "which plantings / which need / what order" logic lives in careNeeded.js
// (buildCareNeeded). This component only renders what that canonicalizer emits + owns interaction
// state. One-tap log goes through the IDENTICAL Log-form write path (POST /api/events) so the
// events Lambda side effects (critter award + entity_memory.next_water_at) fire; undo soft-deletes.

const GROUP_OPTS = [
  { value: 'location', label: 'By location' },
  { value: 'type', label: 'By type' },
]

// Stable identity for "no enrichment yet" so enrichedRows doesn't re-memo on every render.
const NO_ENRICHMENT = Object.freeze({})

function todayLocalISO() {
  const d = new Date()
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

// Per-day suppress set (suppress-for-today). V4-TODAYLOC-002 / V4-USERPREFS-001 closed the two
// halves this comment used to defer.
//
// localStorage, NOT sessionStorage. The row was filed as a CROSS-DEVICE gap, but sessionStorage
// made it a same-device one too: the set died with the tab, so skipping a watering row in the
// garden and coming back minutes later showed it again. That is the failure Dave actually
// reported. localStorage is the offline-durable local layer; the server sync below is the
// cross-device one. Still keyed by date, so it self-empties on a new day exactly as before.
//
// LOCAL IS AUTHORITATIVE ON WRITE, ALWAYS. Every skip lands here first and synchronously — the
// server call is fire-and-forget after the fact. A skip made standing in a dead spot in the garden
// must behave identically to one made on wifi.
function skipKeyName() { return 'today-skipped:' + todayLocalISO() }
function readSkipped() {
  try { return new Set(JSON.parse(localStorage.getItem(skipKeyName()) || '[]')) }
  catch { return new Set() }
}
function writeSkipped(set) {
  try { localStorage.setItem(skipKeyName(), JSON.stringify([...set])) } catch { return }
}

function eventBody(row) {
  return {
    project_id: row.projectId, event_type: row.eventType, event_date: todayLocalISO(),
    plant_id: row.plantingId, is_public: true, has_photo: false,
    notes: null, private_notes: null, quantity: null, metadata: null,
  }
}

// Synthetic inline status chip — shares the waterDue SEVERITY_STYLES tokens + a text verb so the
// Today row and the detail CareStatus band never disagree (one mental model, two components). Three
// channels (SC 1.4.1): mono event icon + text verb + token color. role=img label carried by Icon.
function StatusChip({ row }) {
  const s = SEVERITY_STYLES[row.tier] || SEVERITY_STYLES.gold
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
      backgroundColor: s.bg, border: '1px solid ' + s.border, color: s.text,
      borderRadius: 999, padding: '3px 9px', fontSize: '0.72rem', fontWeight: 700,
    }}>
      <Icon name={'event.' + row.eventType} size={14} decorative style={{ color: s.text }} />
      {NEED_LABEL[row.need]}
    </span>
  )
}

function Row({ row, pending, onLog, onSkip }) {
  const detailHref = (row.projectId && row.plantingId)
    ? '/projects/' + row.projectId + '/plantings/' + row.plantingId
    : '/garden'
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', borderTop: '1px solid ' + P.border }}>
      {/* Secondary zone: open detail (whole row body). */}
      <Link to={detailHref} style={{
        flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px', textDecoration: 'none', color: P.dark, minHeight: 48,
      }}>
        {row.thumb && (
          <PhotoImg photoId={row.photoId} initialUrl={row.thumb} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: 'cover', flexShrink: 0, border: '1px solid ' + P.border }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.92rem', fontWeight: 600, color: P.dark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.name}
          </div>
          <div style={{ fontSize: '0.76rem', color: P.light, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.reason}
          </div>
        </div>
        <StatusChip row={row} />
      </Link>
      {/* Skip (suppress-for-today) — quiet secondary control. */}
      <button type="button" onClick={() => onSkip(row)} aria-label={'Skip ' + row.name + ' today'}
        style={{ flexShrink: 0, width: 44, minHeight: 48, border: 'none', borderLeft: '1px solid ' + P.border, background: 'none', color: P.light, cursor: 'pointer', fontSize: '0.7rem' }}>
        Skip
      </button>
      {/* Primary zone: dominant one-tap Log. */}
      <button type="button" onClick={() => onLog(row)} disabled={pending}
        aria-label={'Log ' + NEED_LABEL[row.need] + ' for ' + row.name}
        style={{
          flexShrink: 0, minWidth: 64, minHeight: 48, border: 'none', borderLeft: '1px solid ' + P.border,
          background: pending ? P.greenPale : P.green, color: pending ? P.green : P.white,
          fontWeight: 700, fontSize: '0.82rem', cursor: pending ? 'default' : 'pointer',
        }}>
        {pending ? '…' : 'Log'}
      </button>
    </div>
  )
}

function SubHeader({ label }) {
  return (
    <div style={{ padding: '6px 14px 2px', fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: P.light, background: P.white }}>{label}</div>
  )
}

function Group({ group, expanded, onToggle, pendingKeys, onLog, onSkip, mode, onShowAll }) {
  const panelId = 'care-group-' + group.key
  return (
    <div style={{ border: '1px solid ' + P.border, borderRadius: 12, background: P.white, overflow: 'hidden' }}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={panelId}
        style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: P.dark, minHeight: 52 }}>
        <span style={{ flex: 1, fontSize: '0.98rem', fontWeight: 700 }}>{group.label}</span>
        {/* TRUE count, never the capped one — the staleness cap changes what renders, not what exists. */}
        <span style={{ fontSize: '0.78rem', fontWeight: 800, color: P.green, background: P.greenPale, borderRadius: 999, padding: '2px 9px' }}>{group.count}</span>
        <span aria-hidden="true" style={{ color: P.light, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
      </button>
      {expanded && (
        <div id={panelId} role="list">
          {(() => {
            const R = (r) => <Row key={r.key} row={r} pending={pendingKeys.has(r.key)} onLog={onLog} onSkip={onSkip} />
            if (mode === 'location') {
              const { beds, containers } = splitContainersBeds(group.rows)
              // Only show the sub-split when a location actually mixes both lanes.
              if (beds.length && containers.length) {
                return (
                  <>
                    <SubHeader label={'Containers & pots (' + containers.length + ')'} />
                    {containers.map(R)}
                    <SubHeader label={'In-ground & beds (' + beds.length + ')'} />
                    {beds.map(R)}
                  </>
                )
              }
            }
            return group.rows.map(R)
          })()}
          {group.hidden > 0 && (
            <button type="button" onClick={onShowAll}
              style={{ display: 'block', width: '100%', minHeight: 44, borderTop: '1px solid ' + P.border, border: 'none', background: 'none', color: P.green, fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer' }}>
              Show {group.hidden} more
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function CareNeeded({ plan }) {
  // getToken comes off useApiFetch rather than useAuth directly — that is the documented seam
  // (api.js:160): every component test already mocks useApiFetch, so routing token acquisition
  // through it keeps the Clerk/AuthProvider dependency out of this component's tests. Importing
  // useAuth here instead reds all 14 CareNeeded cases with "must be used inside <AuthProvider>".
  const { fetch, getToken } = useApiFetch()
  const toast = useOptionalToast()
  const [mode, setMode] = useState('location')
  const [logged, setLogged] = useState(() => new Set())   // optimistic local drop (V3-TODAYDONE parity)
  const [pendingKeys, setPendingKeys] = useState(() => new Set())
  const [skipped, setSkipped] = useState(readSkipped)

  // V4-TODAYLOC-002 — pull the other device's skips in once on mount, UNIONED into the local set.
  //
  // UNION, NOT REPLACE, and the direction matters. Replacing local with server would erase a skip
  // made moments ago offline on this phone the instant a stale server value arrived. Union is also
  // the correct merge for what this set actually is: within a single day it only ever grows, and
  // the two devices are both appending to it. The cost of union is that an un-skip cannot
  // propagate — there is no un-skip affordance, so that cost is currently zero, and this comment
  // is here so that whoever adds one knows to revisit the merge rather than discover it.
  //
  // Writes the merged set back to localStorage so the union survives the next cold start even if
  // the network is gone by then. Best-effort throughout: fetchNotificationPrefs never throws and
  // returns null on env-unset/unauth/failure, in which case the local set simply stands.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const prefs = await fetchNotificationPrefs({ getToken })
      if (!alive || !prefs) return
      const remote = readTodaySkipped(prefs, todayLocalISO())
      if (remote.length === 0) return
      setSkipped(prev => {
        const merged = new Set(prev)
        let added = false
        for (const k of remote) if (!merged.has(k)) { merged.add(k); added = true }
        if (!added) return prev            // identity-stable: no needless re-render or re-write
        writeSkipped(merged)
        return merged
      })
    })()
    return () => { alive = false }
  }, [getToken])
  const [overrides, setOverrides] = useState(() => ({}))  // explicit per-group expand/collapse
  const [bulkType, setBulkType] = useState(null)          // event_type whose bulk fly-up is open
  const [bulkChecked, setBulkChecked] = useState(() => new Set())
  const [bulkProgress, setBulkProgress] = useState(null)  // { done, total } during fan-out
  const liveRef = useRef(null)

  // V4-TODAYLOC-001 — best-effort enrichment for true location grouping + thumbnails. Joins
  // /api/plants (location_id, container_type, featured thumb) with /api/locations/with-path
  // (id -> full_path name). Degrades silently to project-proxy grouping if either fetch fails.
  //
  // /api/plants goes through dataCache so this shares ONE request with StorageDeadlineAlert (and
  // with the sibling CareNeeded that the household lens mounts per caretaker) instead of each
  // instance pulling its own ~0.5-1 MB copy of the same 243-row list on one paint.
  const { data: plants } = useCachedFetch('/api/plants')
  // Tri-state on purpose: undefined = not settled, null = settled-but-failed, array = settled ok.
  const [locPaths, setLocPaths] = useState(undefined)
  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => fetch('/api/locations/with-path'))
      .catch(() => null)
      .then(d => { if (alive) setLocPaths(Array.isArray(d) ? d : null) })
    return () => { alive = false }
  }, [fetch])

  // Enrich only once BOTH sources have settled. The previous Promise.all made that atomicity
  // implicit; splitting the fetches makes it load-bearing, because groupRows derives a group's KEY
  // from locationId but its LABEL from locationName — so applying plants before the paths land
  // would show each group under its project name for a beat and then flip it to the location name.
  const enrichById = useMemo(() => {
    if (locPaths === undefined || !Array.isArray(plants)) return NO_ENRICHMENT
    const nameById = new Map()
    if (Array.isArray(locPaths)) for (const l of locPaths) nameById.set(l.id, l.full_path || l.name || null)
    const map = {}
    for (const pl of plants) {
      map[pl.id] = {
        locationId: pl.location_id || null,
        locationName: (pl.location_id && nameById.get(pl.location_id)) || null,
        containerType: pl.container_type || null,
        thumb: pl.featured_photo_view_url || null,
        photoId: pl.featured_photo_id || null,
      }
    }
    return map
  }, [plants, locPaths])

  const allRows = useMemo(() => buildCareNeeded(plan), [plan])
  const rows = useMemo(
    () => allRows.filter(r => !logged.has(r.key) && !skipped.has(r.key)),
    [allRows, logged, skipped],
  )
  const enrich = useCallback(
    (r) => { const e = enrichById[r.plantingId]; return e ? { ...r, ...e } : r },
    [enrichById],
  )
  const enrichedRows = useMemo(() => rows.map(enrich), [rows, enrich])
  // BUG-TODAYCAREREORDER-001 (BD-036) — the ordering set. Deliberately NOT `rows`: it withholds
  // `skipped` but keeps `logged`, so the layout is computed against the list as it stood when Dave
  // arrived and does not move as he drains it. Logging is the side effect he named — tapping Log
  // down a location group dropped that group's summed severity and slid the section out from under
  // his finger onto the next plant. Skips stay withheld because a skip is an explicit user action
  // (his rule permits re-sorting on those) AND because they persist all day across devices, so
  // counting them would rank a group by work already declined.
  const orderingRows = useMemo(
    () => allRows.filter(r => !skipped.has(r.key)).map(enrich),
    [allRows, skipped, enrich],
  )
  // Staleness state (skeptic seat): when half the water list rests on a record >= WATER_STALE_DAYS
  // old, the honest claim is "no recent record", not "N plantings are thirsty" — so the note below
  // says so and each group renders at most WATER_STALE_CAP water rows until Dave asks for the rest.
  //
  // The cap is applied PER GROUP, after grouping. Capping the flat row list globally (most-overdue
  // first) would undo the group-severity fix in the same breath: on live 2026-08-17 the 20
  // most-overdue rows are 4 from a 4-row outlier group and 14 from the 116-row one, so the outlier
  // group would win the severity sort again inside the capped set. Per-group keeps the ordering
  // honest and puts the cap exactly where the wall is.
  //
  // The cap does NOT touch the bulk candidate set below. "Log all watering (194)" is Dave asserting
  // what HE did — an input, not a claim this surface is making — and 92% of his watering goes
  // through that one action, so taxing it to make a display point would be the wrong trade.
  const staleness = useMemo(() => waterStaleness(plan), [plan])
  const [showCapped, setShowCapped] = useState(false)
  const capping = staleness.stale && !showCapped
  // BD-036 — the pinned layout, computed once per (plan, mode, capping) from `orderingRows`. It
  // supplies BOTH the group order and the auto-expand set, because both were functions of the
  // draining list: autoExpandKeys walks groups filling a row budget, so logging rows out of a group
  // freed budget and silently opened a collapsed section further down the page — the same finger-
  // level movement as the re-sort, from a second source. Capping is included because it changes the
  // row counts the budget is spent against.
  const pinnedGroups = useMemo(() => {
    const gs = groupRows(orderingRows, mode)
    return gs.map(g => {
      const c = capping ? capStaleRows(g.rows, WATER_STALE_CAP) : { rows: g.rows, hidden: 0 }
      return { ...g, rows: c.rows, hidden: c.hidden, count: g.rows.length }
    })
  }, [orderingRows, mode, capping])
  const pinnedOrder = useMemo(() => pinnedGroups.map(g => g.key), [pinnedGroups])
  const groups = useMemo(() => {
    const gs = groupRows(enrichedRows, mode, pinnedOrder)
    return gs.map(g => {
      const c = capping ? capStaleRows(g.rows, WATER_STALE_CAP) : { rows: g.rows, hidden: 0 }
      return { ...g, rows: c.rows, hidden: c.hidden, count: g.rows.length }
    })
  }, [enrichedRows, mode, capping, pinnedOrder])
  const total = rows.length
  const autoKeys = useMemo(() => autoExpandKeys(pinnedGroups, EXPAND_ROW_BUDGET), [pinnedGroups])

  const announce = useCallback((msg) => { if (liveRef.current) liveRef.current.textContent = msg }, [])

  const setPending = useCallback((key, on) => {
    setPendingKeys(prev => { const n = new Set(prev); if (on) n.add(key); else n.delete(key); return n })
  }, [])

  // One-tap: await-then-fade. On failure restore the row + error toast (never fade-and-forget — L-104).
  const logRow = useCallback(async (row) => {
    if (pendingKeys.has(row.key)) return
    setPending(row.key, true)
    try {
      const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify(eventBody(row)) })
      const id = res && res.id
      setLogged(prev => new Set(prev).add(row.key))
      const remaining = rows.length - 1
      announce('Logged ' + NEED_LABEL[row.need] + ' for ' + row.name + ' — ' + remaining + ' remaining')
      toast.showUndo({
        message: 'Logged ' + NEED_LABEL[row.need] + ' for ' + row.name,
        onUndo: async () => {
          // WS-A5: only un-fade the row once the DELETE is confirmed. A failed undo must KEEP the
          // row hidden — re-surfacing it lets it be re-logged as a duplicate (L-104). A 404 means
          // the event is already gone, so re-surfacing is safe there.
          if (!id) { setLogged(prev => { const n = new Set(prev); n.delete(row.key); return n }); return }
          try {
            await fetch('/api/events/' + id, { method: 'DELETE' })
            setLogged(prev => { const n = new Set(prev); n.delete(row.key); return n })
          } catch (e) {
            if (e?.status === 404) {
              setLogged(prev => { const n = new Set(prev); n.delete(row.key); return n })
            } else {
              toast.show({ message: 'Couldn’t undo — the log is still saved', tone: 'error' })
            }
          }
        },
      })
    } catch {
      toast.show({ message: 'Couldn’t log — tap to retry', tone: 'error' })
    } finally {
      setPending(row.key, false)
    }
  }, [fetch, toast, pendingKeys, rows.length, setPending, announce])

  const skipRow = useCallback((row) => {
    setSkipped(prev => {
      const n = new Set(prev).add(row.key)
      writeSkipped(n)
      // V4-TODAYLOC-002 — fire-and-forget cross-device sync, AFTER the local write. Deliberately
      // not awaited and deliberately not error-handled here: saveTodaySkipped never throws and the
      // skip is already applied locally, so a dead network costs nothing but the sync. Sends the
      // WHOLE set rather than a delta — the column is a snapshot, the set is small, and a
      // last-write-wins snapshot cannot half-apply the way an append protocol can drop one entry.
      saveTodaySkipped({ getToken, date: todayLocalISO(), keys: [...n] })
      return n
    })
    announce('Skipped ' + row.name + ' for today')
  }, [announce, getToken])

  // Bulk: the candidate set for an event_type = visible rows of that type, MINUS in-ground beds when
  // bed-wait is active (watering only). Client-side fan-out of single POSTs (the batch endpoint is
  // scope-based single-type — it cannot name this id-subset). Best-effort; aggregate undo.
  const bedWait = useMemo(() => bedWaitActive(plan), [plan])
  const candidatesFor = useCallback((etype) => rows.filter(r => {
    if (r.eventType !== etype) return false
    if (etype === 'watering' && bedWait && r.inGround) return false
    return true
  }), [rows, bedWait])

  const presentTypes = useMemo(() => {
    const seen = []
    for (const need of NEED_ORDER) {
      const et = NEED_EVENT_TYPE[need]
      if (!seen.includes(et) && candidatesFor(et).length) seen.push(et)
    }
    return seen
  }, [candidatesFor])

  const openBulk = useCallback((etype) => {
    setBulkType(etype)
    setBulkChecked(new Set(candidatesFor(etype).map(r => r.key)))
    setBulkProgress(null)
  }, [candidatesFor])

  const runBulk = useCallback(async (etype, keys) => {
    const targets = candidatesFor(etype).filter(r => keys.has(r.key))
    if (!targets.length) { setBulkType(null); return }
    setBulkProgress({ done: 0, total: targets.length })
    const created = []   // { id, key } per successfully-created row (id known = undoable)
    let failures = 0
    for (let i = 0; i < targets.length; i++) {
      const row = targets[i]
      try {
        const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify(eventBody(row)) })
        created.push({ id: (res && res.id) || null, key: row.key })
      } catch { failures++ }
      setBulkProgress({ done: i + 1, total: targets.length })
    }
    const doneKeys = created.map(c => c.key)
    if (doneKeys.length) setLogged(prev => { const n = new Set(prev); doneKeys.forEach(k => n.add(k)); return n })
    setBulkType(null); setBulkProgress(null)
    const okMsg = 'Logged ' + doneKeys.length + (failures ? ' — ' + failures + ' failed' : '')
    announce(okMsg)
    if (failures) toast.show({ message: okMsg, tone: 'error' })
    else toast.showUndo({
      message: okMsg,
      // WS-A5: await each DELETE; only un-fade rows whose delete is confirmed (or 404 = already
      // gone). Rows we can't confirm stay hidden, so a failed undo can't re-surface → re-log a dup.
      onUndo: async () => {
        const undoneKeys = []
        await Promise.all(created.map(async c => {
          if (!c.id) return
          try { await fetch('/api/events/' + c.id, { method: 'DELETE' }); undoneKeys.push(c.key) }
          catch (e) { if (e?.status === 404) undoneKeys.push(c.key) }
        }))
        if (undoneKeys.length) setLogged(prev => { const n = new Set(prev); undoneKeys.forEach(k => n.delete(k)); return n })
        if (undoneKeys.length < created.length) {
          toast.show({ message: 'Couldn’t undo ' + (created.length - undoneKeys.length) + ' of ' + created.length + ' — those logs are still saved', tone: 'error' })
        }
      },
    })
  }, [fetch, toast, candidatesFor, announce])

  const isExpanded = (g) => (g.key in overrides) ? overrides[g.key] : autoKeys.has(g.key)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div ref={liveRef} role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }} />

      {total === 0 ? (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: P.light }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: P.green, marginBottom: 4 }}>All caught up</div>
          <div style={{ fontSize: '0.82rem', lineHeight: 1.4 }}>Nothing needs care today — enjoy the garden.</div>
          <RainNote plan={plan} center />
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: '0.95rem', fontWeight: 700, color: P.dark, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Needs care today
            </h2>
            <GroupByControl options={GROUP_OPTS} value={mode} onChange={setMode} />
          </div>

          {staleness.stale && (
            <div style={{ fontSize: '0.78rem', color: P.light, lineHeight: 1.4, padding: '0 2px' }}>
              No recent watering record — half of these rest on a check {staleness.daysSince}+ days old.
              {capping && ' Showing the longest-waiting ' + WATER_STALE_CAP + ' per group.'}
            </div>
          )}

          {presentTypes.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {presentTypes.map(et => {
                const n = candidatesFor(et).length
                return (
                  <span key={et} style={{ display: 'inline-flex', alignItems: 'stretch', border: '1px solid ' + P.greenLight, background: P.greenPale, borderRadius: 999, overflow: 'hidden' }}>
                    <button type="button" disabled={!!bulkProgress}
                      onClick={() => runBulk(et, new Set(candidatesFor(et).map(r => r.key)))}
                      aria-label={'Log all ' + bulkLabel(et) + ' (' + n + ')'}
                      style={{ minHeight: 36, border: 'none', background: 'none', color: P.green, padding: '6px 12px', fontSize: '0.8rem', fontWeight: 700, cursor: bulkProgress ? 'default' : 'pointer' }}>
                      Log all {bulkLabel(et)} ({n})
                    </button>
                    <button type="button" disabled={!!bulkProgress} onClick={() => openBulk(et)}
                      aria-label={'Choose which ' + bulkLabel(et) + ' to log'}
                      style={{ minHeight: 36, width: 34, border: 'none', borderLeft: '1px solid ' + P.greenLight, background: 'none', color: P.green, fontSize: '0.8rem', fontWeight: 700, cursor: bulkProgress ? 'default' : 'pointer' }}>
                      ⋯
                    </button>
                  </span>
                )
              })}
            </div>
          )}

          {/* BUG-CADENCEONEDAY-001 — the list's true unit, stated directly under the button that
              applies it. Counts the SAME candidate set the pill logs (bed-wait exclusions included),
              so the two numbers can never disagree. Ambient copy, same weight as the staleness note
              above: a fact about the work, not another thing to do. */}
          {(() => {
            const note = bulkWaterNote(candidatesFor('watering').length, total)
            return note && (
              <div style={{ fontSize: '0.78rem', color: P.light, lineHeight: 1.4, padding: '0 2px', marginTop: -4 }}>
                {note}
              </div>
            )
          })()}

          {groups.map(g => (
            <Group key={g.key} group={g} expanded={isExpanded(g)}
              onToggle={() => setOverrides(prev => ({ ...prev, [g.key]: !((g.key in prev) ? prev[g.key] : autoKeys.has(g.key)) }))}
              pendingKeys={pendingKeys} onLog={logRow} onSkip={skipRow} mode={mode}
              onShowAll={() => setShowCapped(true)} />
          ))}

          <RainNote plan={plan} />
        </>
      )}

      {/* Outside the ternary on purpose: a dormant planting is hidden whether or not anything else
          needs care today, so it must render in the empty state too. */}
      <DormantList plan={plan} />

      {/* V4-BACKNAV-001 Slice P (extended) — close-in-place: setBulkType(null) never navigates. */}
      <Sheet armsBack open={!!bulkType} onClose={() => setBulkType(null)} busy={!!bulkProgress} title={bulkType ? 'Log all ' + bulkLabel(bulkType) : ''}>
        {bulkType && (
          <div style={{ padding: '4px 16px 8px' }}>
            <p style={{ fontSize: '0.82rem', color: P.light, margin: '0 0 10px' }}>
              {bulkProgress ? 'Logging ' + bulkProgress.done + ' of ' + bulkProgress.total + '…'
                : 'Only today’s ' + bulkLabel(bulkType) + ' needs — pre-checked.'}
            </p>
            <div role="list" style={{ maxHeight: '46vh', overflowY: 'auto' }}>
              {candidatesFor(bulkType).map(r => {
                const on = bulkChecked.has(r.key)
                return (
                  <label key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid ' + P.border, fontSize: '0.88rem', color: P.dark, cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} disabled={!!bulkProgress}
                      onChange={() => setBulkChecked(prev => { const n = new Set(prev); if (on) n.delete(r.key); else n.add(r.key); return n })} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                    <span style={{ fontSize: '0.74rem', color: P.light }}>{r.reason}</span>
                  </label>
                )
              })}
            </div>
            <button type="button" onClick={() => runBulk(bulkType, bulkChecked)} disabled={!!bulkProgress || bulkChecked.size === 0}
              style={{ marginTop: 12, width: '100%', minHeight: 46, border: 'none', borderRadius: 12, background: bulkChecked.size ? P.green : P.greenPale, color: bulkChecked.size ? P.white : P.green, fontWeight: 700, fontSize: '0.9rem', cursor: bulkChecked.size ? 'pointer' : 'default' }}>
              {bulkProgress ? 'Logging ' + bulkProgress.done + ' of ' + bulkProgress.total + '…' : 'Log all (' + bulkChecked.size + ')'}
            </button>
          </div>
        )}
      </Sheet>
    </div>
  )
}

function bulkLabel(etype) {
  if (etype === 'watering') return 'watering'
  if (etype === 'fertilizing') return 'feeding'
  if (etype === 'observation') return 'checks'
  if (etype === 'brought_inside') return 'protection'
  return 'care'
}

// V4-DORMANTRESUME-001 — the dormant plantings the engine emits and nothing has ever rendered.
// Ambient, like RainNote: dormancy is not work, so this is never a card and never an interrupt.
// It exists because dormant is excluded from the care engine AND from every dashboard arm, which
// left an overwintered crop with no surface at all — and no way back, since nothing but a human
// tap clears the status.
//
// Resume writes through the SAME endpoint and payload as the hero StatusPicker
// (PUT /api/plants/:id {status}), so there is one status write path in the app, not two.
// Target is 'vegetative': the canonical growing-but-not-yet-flowering state, which is where garlic,
// asparagus, strawberry and a Christmas cactus all actually restart. Anything more specific the
// gardener can still set on the planting itself.
function DormantList({ plan }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [resumed, setResumed] = useState(() => new Set())
  const [pending, setPending] = useState(() => new Set())
  const rows = useMemo(() => dormantRows(plan).filter(r => !resumed.has(r.plantingId)), [plan, resumed])
  if (rows.length === 0) return null

  async function resume(row) {
    if (pending.has(row.plantingId)) return
    setPending(prev => new Set(prev).add(row.plantingId))
    try {
      await fetch('/api/plants/' + row.plantingId, {
        method: 'PUT',
        body: JSON.stringify({ status: 'vegetative' }),
      })
      setResumed(prev => new Set(prev).add(row.plantingId))
      toast?.show?.({ message: row.name + ' is growing again', tone: 'success' })
    } catch {
      // Never optimistic: a failed resume must leave the row where it was, or the planting goes
      // back to being invisible while still dormant — the exact state this list exists to end.
      toast?.show?.({ message: 'Couldn’t resume ' + row.name, tone: 'error' })
    } finally {
      setPending(prev => { const n = new Set(prev); n.delete(row.plantingId); return n })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 2px' }}>
      <h3 style={{ fontSize: '0.82rem', fontWeight: 700, color: P.dark, margin: 0 }}>Dormant</h3>
      <div style={{ fontSize: '0.78rem', color: P.light, lineHeight: 1.4 }}>
        Resting — no routine care. Resume one when it starts growing again.
      </div>
      {rows.map(row => (
        <div key={row.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, flexWrap: 'wrap', minHeight: 44 }}>
          {/* Same name treatment as Row above: minWidth:0 + ellipsis is what keeps an unbreakable
              long name from widening the page at 390px rather than shrinking. */}
          <Link to={'/plantings/' + row.plantingId} style={{ fontSize: '0.85rem', color: P.dark,
            textDecoration: 'none', flex: '1 1 auto', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.name}
          </Link>
          {row.resumable && (
            <button type="button" onClick={() => resume(row)} disabled={pending.has(row.plantingId)}
              aria-label={'Resume ' + row.name}
              style={{ minHeight: 32, padding: '5px 12px', borderRadius: 12, border: '1px solid ' + P.border,
                backgroundColor: P.white, color: P.dark, fontSize: '0.78rem', fontWeight: 600,
                cursor: 'pointer', opacity: pending.has(row.plantingId) ? 0.6 : 1, flex: '0 0 auto' }}>
              Resume
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// Ambient rain-credit note (DRG-WATERCREDIT-001) — quiet, never a card/interrupt.
function RainNote({ plan, center }) {
  const n = Array.isArray(plan && plan.rain_skipped) ? plan.rain_skipped.length : 0
  if (!n) return null
  return (
    <div style={{ fontSize: '0.78rem', color: P.light, padding: '4px 6px', textAlign: center ? 'center' : 'left' }}>
      Rain handled watering for {n} planting{n > 1 ? 's' : ''} — recent rain counts.
    </div>
  )
}
