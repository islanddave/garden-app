import React, { useState, useMemo, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../../lib/constants.js'
import { SEVERITY_STYLES } from '../../lib/waterDue.js'
import { useApiFetch } from '../../lib/api.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import GroupByControl from '../forms/GroupByControl.jsx'
import Sheet from '../forms/Sheet.jsx'
import Icon from '../Icon.jsx'
import {
  buildCareNeeded, groupRows, bedWaitActive,
  NEED_EVENT_TYPE, NEED_LABEL, NEED_ORDER, EXPAND_ALL_THRESHOLD,
} from '../../lib/careNeeded.js'

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

function todayLocalISO() {
  const d = new Date()
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

// Per-day suppress set (suppress-for-today, client-only — build-plan lock-blocker #1). sessionStorage
// keyed by date so it survives a PWA reload within the day and self-empties on a new date. Cross-device
// sync is deferred (V4-TODAYLOC-001 sibling) — needs a server suppress endpoint.
function skipKeyName() { return 'today-skipped:' + todayLocalISO() }
function readSkipped() {
  try { return new Set(JSON.parse(sessionStorage.getItem(skipKeyName()) || '[]')) }
  catch { return new Set() }
}
function writeSkipped(set) {
  try { sessionStorage.setItem(skipKeyName(), JSON.stringify([...set])) } catch { return }
}

function eventBody(row) {
  return {
    project_id: row.projectId, event_type: row.eventType, event_date: todayLocalISO(),
    plant_id: row.plantingId, is_public: false, has_photo: false,
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

function Group({ group, expanded, onToggle, pendingKeys, onLog, onSkip }) {
  const panelId = 'care-group-' + group.key
  return (
    <div style={{ border: '1px solid ' + P.border, borderRadius: 12, background: P.white, overflow: 'hidden' }}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={panelId}
        style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: P.dark, minHeight: 52 }}>
        <span style={{ flex: 1, fontSize: '0.98rem', fontWeight: 700 }}>{group.label}</span>
        <span style={{ fontSize: '0.78rem', fontWeight: 800, color: P.green, background: P.greenPale, borderRadius: 999, padding: '2px 9px' }}>{group.rows.length}</span>
        <span aria-hidden="true" style={{ color: P.light, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
      </button>
      {expanded && (
        <div id={panelId} role="list">
          {group.rows.map(r => (
            <Row key={r.key} row={r} pending={pendingKeys.has(r.key)} onLog={onLog} onSkip={onSkip} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function CareNeeded({ plan }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [mode, setMode] = useState('location')
  const [logged, setLogged] = useState(() => new Set())   // optimistic local drop (V3-TODAYDONE parity)
  const [pendingKeys, setPendingKeys] = useState(() => new Set())
  const [skipped, setSkipped] = useState(readSkipped)
  const [overrides, setOverrides] = useState(() => ({}))  // explicit per-group expand/collapse
  const [bulkType, setBulkType] = useState(null)          // event_type whose bulk fly-up is open
  const [bulkChecked, setBulkChecked] = useState(() => new Set())
  const [bulkProgress, setBulkProgress] = useState(null)  // { done, total } during fan-out
  const liveRef = useRef(null)

  const allRows = useMemo(() => buildCareNeeded(plan), [plan])
  const rows = useMemo(
    () => allRows.filter(r => !logged.has(r.key) && !skipped.has(r.key)),
    [allRows, logged, skipped],
  )
  const groups = useMemo(() => groupRows(rows, mode), [rows, mode])
  const total = rows.length
  const expandAll = total <= EXPAND_ALL_THRESHOLD
  const autoExpandKey = groups.length ? groups[0].key : null  // most-overdue group (groupRows sorts it first)

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
        onUndo: () => {
          if (id) fetch('/api/events/' + id, { method: 'DELETE' }).catch(() => {})
          setLogged(prev => { const n = new Set(prev); n.delete(row.key); return n })
        },
      })
    } catch {
      toast.show({ message: 'Couldn’t log — tap to retry', tone: 'error' })
    } finally {
      setPending(row.key, false)
    }
  }, [fetch, toast, pendingKeys, rows.length, setPending, announce])

  const skipRow = useCallback((row) => {
    setSkipped(prev => { const n = new Set(prev).add(row.key); writeSkipped(n); return n })
    announce('Skipped ' + row.name + ' for today')
  }, [announce])

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

  const runBulk = useCallback(async () => {
    const targets = candidatesFor(bulkType).filter(r => bulkChecked.has(r.key))
    if (!targets.length) { setBulkType(null); return }
    setBulkProgress({ done: 0, total: targets.length })
    const createdIds = []
    const doneKeys = []
    let failures = 0
    for (let i = 0; i < targets.length; i++) {
      const row = targets[i]
      try {
        const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify(eventBody(row)) })
        if (res && res.id) createdIds.push(res.id)
        doneKeys.push(row.key)
      } catch { failures++ }
      setBulkProgress({ done: i + 1, total: targets.length })
    }
    if (doneKeys.length) setLogged(prev => { const n = new Set(prev); doneKeys.forEach(k => n.add(k)); return n })
    setBulkType(null); setBulkProgress(null)
    const okMsg = 'Logged ' + doneKeys.length + (failures ? ' — ' + failures + ' failed' : '')
    announce(okMsg)
    if (failures) toast.show({ message: okMsg, tone: 'error' })
    else toast.showUndo({
      message: okMsg,
      onUndo: () => {
        createdIds.forEach(id => fetch('/api/events/' + id, { method: 'DELETE' }).catch(() => {}))
        setLogged(prev => { const n = new Set(prev); doneKeys.forEach(k => n.delete(k)); return n })
      },
    })
  }, [fetch, toast, bulkType, bulkChecked, candidatesFor, announce])

  const isExpanded = (g) => (g.key in overrides) ? overrides[g.key] : (expandAll || g.key === autoExpandKey)

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

          {presentTypes.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {presentTypes.map(et => {
                const n = candidatesFor(et).length
                return (
                  <button key={et} type="button" onClick={() => openBulk(et)}
                    style={{ minHeight: 36, border: '1px solid ' + P.greenLight, background: P.greenPale, color: P.green, borderRadius: 999, padding: '6px 12px', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer' }}>
                    Log all {bulkLabel(et)} ({n})
                  </button>
                )
              })}
            </div>
          )}

          {groups.map(g => (
            <Group key={g.key} group={g} expanded={isExpanded(g)}
              onToggle={() => setOverrides(prev => ({ ...prev, [g.key]: !((g.key in prev) ? prev[g.key] : (expandAll || g.key === autoExpandKey)) }))}
              pendingKeys={pendingKeys} onLog={logRow} onSkip={skipRow} />
          ))}

          <RainNote plan={plan} />
        </>
      )}

      <Sheet open={!!bulkType} onClose={() => setBulkType(null)} title={bulkType ? 'Log all ' + bulkLabel(bulkType) : ''}>
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
            <button type="button" onClick={runBulk} disabled={!!bulkProgress || bulkChecked.size === 0}
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
