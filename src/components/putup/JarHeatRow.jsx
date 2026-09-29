// src/components/putup/JarHeatRow.jsx
// Put-Up release F (06 §4 item 5, §2.1, §2.6) — "Jar & heat": the vessel it is in, about how much is in
// it, and the estimated heat. A collapsed summary row, placed after the Salt block, NEVER expanded by
// itself and collapsed again when a line add starts:
//     "Quart jar × 2 · about 448 g · heat est. 950–3.0k SHU (worked out)"
// plus, when a worked-out figure no longer matches what went in (the server's shu_est_stale), in quiet
// ink: "· worked out before later changes · Work it out again". A typed figure is never flagged.
// Expanded: the vessel chips and a 48px −/+ count; "About ___ in it" (the started row's amount — a
// typed value is never overwritten; the placeholder is the weighed sum of what went in); the heat:
// Work it out (the breakdown sheet) or Type it.
//
// Every write is one merge PUT of the batch (vessel_*, shu_est_*) or one stage PATCH (the started
// row's amount), both accepted on a finished batch (06 §3.13). Required at open: 0 (the census).
import React, { useCallback, useId, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, optionalMarkChrome, inputChrome } from '../forms/formStyles.js'
import ShuSheet from './ShuSheet.jsx'
import { shuRangeWords, aboutPlaceholderGrams, wholeGrams } from './fermentMath.js'

// The vessel presets (06 §2.1: "From the preset (quart jar → 1 qt)"); units all in KITCHEN_UNITS.
export const VESSEL_PRESETS = Object.freeze([
  { label: 'Pint jar', size: 1, unit: 'pint' },
  { label: 'Quart jar', size: 1, unit: 'qt' },
  { label: 'Half-gallon jar', size: 2, unit: 'qt' },
  { label: 'Gallon jar', size: 1, unit: 'gal' },
  { label: 'Crock', size: null, unit: null },
])
export const ABOUT_UNITS = Object.freeze(['g', 'kg', 'cup', 'qt'])
export const BASIS_WORDS = Object.freeze({ computed: 'worked out', typed: 'typed' })

// The live `started` row (the one "About ___ in it" lives on).
export function startedRow(stages) {
  return (Array.isArray(stages) ? stages : []).find(s => s?.stage_kind === 'started') ?? null
}

export function vesselWords(batch) {
  if (!batch?.vessel_label) return null
  const n = Number(batch.vessel_count ?? 1)
  return Number.isFinite(n) && n > 1 ? `${batch.vessel_label} × ${n}` : batch.vessel_label
}

export function aboutWords(started, lines) {
  if (started?.amount != null && started.amount_unit) return `about ${Math.round(Number(started.amount) * 100) / 100} ${started.amount_unit}`
  const g = aboutPlaceholderGrams(lines)
  return g != null ? `about ${wholeGrams(g)} g` : null
}

export function heatWords(batch) {
  const r = shuRangeWords(batch?.shu_est_low, batch?.shu_est_high)
  if (!r) return null
  const basis = BASIS_WORDS[batch.shu_est_basis]
  return `heat ${r}${basis ? ` (${basis})` : ''}`
}

// The one summary line. No vessel, no amount and no heat yet → the section's name, so the row still says
// what it opens.
export function jarHeatSummary(batch, started, lines) {
  const parts = [vesselWords(batch), aboutWords(started, lines), heatWords(batch)].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Jar size, how much is in it, heat'
}

const quiet = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, background: 'none', border: 'none',
  padding: '2px 8px 2px 0', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: T.type.sm, fontWeight: 600,
}

export default function JarHeatRow({ batch, stages, lines, onChanged, open, onToggle, disabled = false }) {
  const { fetch } = useApiFetch()
  const started = startedRow(stages)
  const [about, setAbout] = useState(() => (started?.amount != null ? String(Number(started.amount)) : ''))
  const [aboutUnit, setAboutUnit] = useState(started?.amount_unit ?? 'g')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [shuOpen, setShuOpen] = useState(false)
  const writingRef = useRef(false)
  const aboutId = `jar-about-${useId()}`
  const placeholder = aboutPlaceholderGrams(lines)

  const run = useCallback(async (path, method, body) => {
    if (writingRef.current) return false
    writingRef.current = true
    setBusy(true); setErr(null)
    try {
      await fetch(path, { method, body: JSON.stringify(body) })
      onChanged?.()
      return true
    } catch (e) {
      setErr(describeRefusal(e)?.text ?? 'Couldn’t save that — try again.')
      return false
    } finally { writingRef.current = false; setBusy(false) }
  }, [fetch, onChanged])

  const putBatch = (body) => run(`/api/kitchen-batches/${batch.id}`, 'PUT', body)
  const count = Number(batch.vessel_count ?? 1) || 1
  const saveAbout = () => {
    const t = about.trim().replace(',', '.')
    if (!started) return
    if (t === '') return run(`/api/kitchen-batches/${batch.id}/stages/${started.id}`, 'PATCH', { amount: null, amount_unit: null })
    if (!(Number.isFinite(Number(t)) && Number(t) > 0)) { setErr('That amount needs to be a number more than 0.'); return }
    return run(`/api/kitchen-batches/${batch.id}/stages/${started.id}`, 'PATCH', { amount: t, amount_unit: aboutUnit })
  }

  return (
    <div data-testid="jar-heat" style={{ marginTop: T.space.md }}>
      <button type="button" aria-expanded={open} data-testid="jar-heat-summary" disabled={disabled} onClick={onToggle}
        style={{ display: 'flex', width: '100%', minHeight: T.buttonMinHeight, alignItems: 'center', gap: 8, padding: '6px 0', background: 'none',
          border: 'none', borderTop: `1px solid ${P.border}`, borderBottom: `1px solid ${P.border}`, textAlign: 'left', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: T.type.sm, color: P.dark }}>
        <span style={{ flex: 1 }}>
          <span style={{ color: P.light, fontWeight: 700, fontSize: T.type.xs, letterSpacing: '0.3px', textTransform: 'uppercase', marginRight: 6 }}>Jar & heat</span>
          <span data-testid="jar-heat-words">{jarHeatSummary(batch, started, lines)}</span>
        </span>
        <span aria-hidden="true" style={{ color: P.light }}>{open ? '▴' : '▾'}</span>
      </button>
      {batch.shu_est_stale === true && batch.shu_est_basis === 'computed' && (
        <div data-testid="jar-heat-stale" style={{ color: P.light, fontSize: '0.78rem' }}>
          · worked out before later changes ·{' '}
          <button type="button" style={{ ...quiet, fontWeight: 400 }} data-testid="jar-heat-rework" onClick={() => setShuOpen(true)}>Work it out again</button>
        </div>
      )}
      {open && (
        <div data-testid="jar-heat-panel" style={{ padding: '8px 0' }}>
          <span style={labelChrome} aria-hidden="true">Jar size<span style={optionalMarkChrome}>optional</span></span>
          <div role="group" aria-label="Jar size" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {VESSEL_PRESETS.map(v => (
              <SelectChip key={v.label} touch active={batch.vessel_label === v.label} disabled={busy} data-testid={`jar-vessel-${v.label.replace(/\s+/g, '-').toLowerCase()}`}
                onClick={() => putBatch(batch.vessel_label === v.label
                  ? { vessel_label: null, vessel_size: null, vessel_unit: null }
                  : { vessel_label: v.label, vessel_size: v.size, vessel_unit: v.unit })}>{v.label}</SelectChip>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ ...labelChrome, margin: 0 }}>How many jars</span>
            <button type="button" aria-label="One fewer jar" aria-disabled={count <= 1 ? true : undefined} disabled={busy} data-testid="jar-count-minus"
              onClick={() => { if (count > 1) putBatch({ vessel_count: count - 1 }) }}
              style={{ width: 48, height: 48, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, background: P.white, color: count > 1 ? P.dark : P.light, fontFamily: 'inherit', fontSize: '1.2rem', cursor: 'pointer' }}>−</button>
            <span data-testid="jar-count" style={{ minWidth: 24, textAlign: 'center', fontWeight: 700 }}>{count}</span>
            <button type="button" aria-label="One more jar" disabled={busy || count >= 50} data-testid="jar-count-plus"
              onClick={() => putBatch({ vessel_count: count + 1 })}
              style={{ width: 48, height: 48, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, background: P.white, color: P.dark, fontFamily: 'inherit', fontSize: '1.2rem', cursor: 'pointer' }}>+</button>
          </div>
          {started && (
            <div style={{ marginBottom: 10 }}>
              <label htmlFor={aboutId} style={labelChrome}>About ___ in it<span style={optionalMarkChrome}>optional</span></label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <input id={aboutId} data-testid="jar-about" type="text" inputMode="decimal" value={about} disabled={busy}
                  placeholder={placeholder != null ? wholeGrams(placeholder) : ''} onChange={e => { setAbout(e.target.value); setErr(null) }}
                  style={{ ...inputChrome(false), width: 96, scrollMarginBottom: 96 }} />
                <div role="radiogroup" aria-label="About unit" style={{ display: 'flex', gap: 6 }}>
                  {ABOUT_UNITS.map(u => (
                    <SelectChip key={u} touch role="radio" aria-checked={aboutUnit === u} aria-pressed={undefined} active={aboutUnit === u}
                      disabled={busy} data-testid={`jar-about-unit-${u}`} onClick={() => setAboutUnit(u)}>{u}</SelectChip>
                  ))}
                </div>
                <button type="button" style={quiet} data-testid="jar-about-save" disabled={busy} onClick={saveAbout}>Save</button>
              </div>
              {placeholder != null && about.trim() === '' && (
                <div style={{ color: P.light, fontSize: '0.74rem', marginTop: 2 }}>About {wholeGrams(placeholder)} g, from what went in.</div>
              )}
            </div>
          )}
          <div>
            <span style={{ ...labelChrome }}>Heat</span>
            <div data-testid="jar-heat-figure" style={{ color: P.dark, fontSize: T.type.sm, marginBottom: 4 }}>
              {heatWords(batch) ?? 'Not worked out yet.'}
            </div>
            <button type="button" style={quiet} data-testid="jar-heat-work-it-out" disabled={busy} onClick={() => setShuOpen(true)}>Work it out</button>
          </div>
          {err && <p role="alert" data-alarm-ink-exempt="error" data-testid="jar-heat-error" style={{ color: P.terra, fontSize: T.type.sm, fontWeight: 600, margin: '4px 0 0' }}>{err}</p>}
        </div>
      )}
      <ShuSheet open={shuOpen} batchId={batch.id} scope="batch" onClose={() => setShuOpen(false)}
        onSaved={() => { setShuOpen(false); onChanged?.() }}
        onType={async (r) => {
          await fetch(`/api/kitchen-batches/${batch.id}`, { method: 'PUT', body: JSON.stringify({ shu_est_low: r.low, shu_est_high: r.high }) })
          setShuOpen(false); onChanged?.()
        }} />
    </div>
  )
}
