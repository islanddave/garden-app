// src/components/forms/ScopeChecklist.jsx
// Lane D / Phase D — the bulk-log SCOPE + 500-cap exclusion checklist, extracted from
// LogMany (behavior-preserving). This is the OTHER half of Phase D: where EventTypePicker
// is a single-select button-grid, this is a scope selector + server dry-run exclusion list.
// They share the SelectChip selection grammar (NOT a mode= switch) — plan §5 Phase D.
//
// Contract:
//   - scope / onScopeChange     controlled scope ({type:'all'|'project'|'space', ...})
//   - projects / locations      for the scope chips + project <select>
//   - eventType / eventDate      drive the dry-run body + retrigger the preview
//   - verbLabel                  humanized event verb for the headline copy
//   - runDryRun({scope,eventType,eventDate,signal}) -> Promise<{count,capped,plantings:[{id,name}]}>
//                                parent-supplied (closes over useApiFetch); `signal` enables
//                                AbortController cancellation + race-safety
//   - onSelectionChange({committedCount, excludedIds})  fires whenever the net selection
//                                changes so the parent can build the confirm body + button state
//
// Net-count rule (plan §5 Phase D): never make the user mentally compute the set
// difference — when any planting is skipped we render "N matched − M skipped → K will
// be logged" continuously, aria-live so it's announced as toggles happen.
import React, { useState, useEffect, useCallback } from 'react'
import { P } from '../../lib/constants.js'
import ProjectOptions from '../ProjectOptions.jsx'
import SelectChip from './SelectChip.jsx'

// FIX-3: per-DEVICE default selection (true=start all selected [Dave], false=start none [Jen]).
// Device-local expedient; server-side per-user migration tracked as V4-LOGMANY-001.
const DEFAULT_SEL_KEY = 'quicklog.defaultAllSelected'

export default function ScopeChecklist({
  scope,
  onScopeChange,
  projects = [],
  locations = [],
  eventType,
  eventDate = '',
  verbLabel = 'log',
  runDryRun,
  onSelectionChange,
}) {
  const [preview, setPreview] = useState(null)       // { count, capped, plantings:[{id,name}] }
  const [excluded, setExcluded] = useState(() => new Set())
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState(null)
  const [showList, setShowList] = useState(false)
  const [defaultAllSelected, setDefaultAllSelected] = useState(() => {
    try { const v = localStorage.getItem(DEFAULT_SEL_KEY); return v === null ? true : v === '1' } catch (e) { return true }
  })

  // Server-accurate dry-run preview on scope / event-type / date change. AbortController
  // makes rapid scope toggling race-safe: a superseded request can neither clobber the
  // current scope's preview nor surface its (aborted) rejection. Replaces the old `on` flag.
  useEffect(() => {
    if (!runDryRun) return
    const ctrl = new AbortController()
    setPreviewing(true); setPreviewError(null); setExcluded(new Set())
    Promise.resolve(runDryRun({ scope, eventType, eventDate, signal: ctrl.signal }))
      .then(r => {
        if (ctrl.signal.aborted) return
        setPreview(r); setPreviewing(false)
        setExcluded(defaultAllSelected ? new Set() : new Set((r?.plantings || []).map(pl => pl.id)))
      })
      .catch(err => {
        if (ctrl.signal.aborted || err?.name === 'AbortError') return
        setPreviewError(err.message); setPreview(null); setPreviewing(false)
      })
    return () => ctrl.abort()
    // defaultAllSelected intentionally NOT a dep: flipping it re-applies via applyDefaultSel
    // without a refetch (preserves prior LogMany behavior).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, eventType, eventDate, runDryRun])

  const toggleExclude = useCallback((id) => {
    setExcluded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }, [])

  // FIX-3: flip the per-device default and re-apply to the current preview immediately.
  const applyDefaultSel = useCallback((on) => {
    setDefaultAllSelected(on)
    try { localStorage.setItem(DEFAULT_SEL_KEY, on ? '1' : '0') } catch (e) {}
    setExcluded(on ? new Set() : new Set((preview?.plantings || []).map(pl => pl.id)))
  }, [preview])

  const plantings = preview?.plantings || []
  const total = plantings.length
  const committed = plantings.filter(p => !excluded.has(p.id))
  const committedCount = committed.length
  const excludedCount = total - committedCount

  // Lift the committed selection up so the parent can build the confirm body + button.
  useEffect(() => {
    onSelectionChange?.({ committedCount, excludedIds: [...excluded] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedCount, excluded])

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <SelectChip active={scope.type === 'all'} onClick={() => onScopeChange({ type: 'all' })}>All active</SelectChip>
          <SelectChip active={scope.type === 'project'} onClick={() => onScopeChange(scope.type === 'project' ? scope : { type: 'project', project_id: projects[0]?.id })}>By project</SelectChip>
          <SelectChip active={scope.type === 'space'} onClick={() => onScopeChange(scope.type === 'space' ? scope : { type: 'space', location_id: locations[0]?.id })}>By space</SelectChip>
        </div>
        {scope.type === 'project' && (
          <select value={scope.project_id ?? ''} onChange={e => onScopeChange({ type: 'project', project_id: e.target.value })} style={selectStyle} aria-label="Project">
            <ProjectOptions projects={projects} />
          </select>
        )}
        {scope.type === 'space' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {locations.map(l => (
              <SelectChip key={l.id} small active={scope.location_id === l.id} onClick={() => onScopeChange({ type: 'space', location_id: l.id })}>{l.name}</SelectChip>
            ))}
          </div>
        )}
      </div>

      <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
        {previewing ? (
          <p style={{ margin: 0, color: P.light, textAlign: 'center' }}>Counting…</p>
        ) : previewError ? (
          <p role="alert" style={{ margin: 0, color: P.terra, textAlign: 'center', fontSize: '0.85rem' }}>{previewError}</p>
        ) : preview ? (
          <>
            <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>
              Log <span style={{ color: P.green }}>{verbLabel}</span> on <span style={{ color: P.green }}>{committedCount}</span> {committedCount === 1 ? 'planting' : 'plantings'}
            </p>
            {excludedCount > 0 && (
              <p data-testid="net-count" aria-live="polite" style={{ margin: '0 0 8px', color: P.dark, fontSize: '0.83rem', fontWeight: 600 }}>
                {total} matched − {excludedCount} skipped → {committedCount} will be logged
              </p>
            )}
            {preview.capped && <p style={{ margin: '0 0 8px', color: P.terra, fontSize: '0.8rem' }}>Showing first 500 — narrow the scope to log more.</p>}
            {scope.type === 'space' && (
              <p style={{ margin: '0 0 8px', color: P.light, fontSize: '0.78rem' }}>Plantings with no space aren't included — use “All active” to cover everything.</p>
            )}
            {total > 0 && (
              <button type="button" onClick={() => setShowList(v => !v)} style={linkBtn}>
                {showList ? 'Hide' : 'Review'} {total} {total === 1 ? 'planting' : 'plantings'} {excludedCount > 0 ? `(${excludedCount} skipped)` : ''}
              </button>
            )}
            {total > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 0', fontSize: '0.8rem', color: P.mid, cursor: 'pointer' }}>
                <input type="checkbox" checked={defaultAllSelected} onChange={e => applyDefaultSel(e.target.checked)} />
                Start with everything selected
              </label>
            )}
            {showList && (
              <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {plantings.map(pl => {
                  const off = excluded.has(pl.id)
                  return (
                    <li key={pl.id}>
                      <button type="button" onClick={() => toggleExclude(pl.id)} aria-pressed={!off}
                        style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, minHeight: 44,
                          background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                          color: off ? P.light : P.dark, textDecoration: off ? 'line-through' : 'none', fontSize: '0.88rem' }}>
                        <span aria-hidden="true" style={{ color: off ? P.light : P.green }}>{off ? '○' : '✓'}</span>
                        {pl.name}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        ) : (
          <p style={{ margin: 0, color: P.light, textAlign: 'center' }}>No plantings match this scope.</p>
        )}
      </div>
    </>
  )
}

const linkBtn = { background: 'none', border: 'none', color: P.green, fontSize: '0.83rem', fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit', textDecoration: 'underline' }
const selectStyle = { width: '100%', minHeight: 44, padding: '8px 12px', borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '0.9rem', fontFamily: 'inherit', backgroundColor: P.white, color: P.dark }
