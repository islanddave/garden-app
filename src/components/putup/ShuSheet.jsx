// src/components/putup/ShuSheet.jsx
// Put-Up release F (06 §2.6; Dave 15:55 "your recipe way", 17:1x) — "Work it out": the estimated heat,
// shown with what it was worked out from, and saved only when he says so.
//
// THE SERVER WORKS IT OUT (GET /:id/shu-estimate, contract-F §2.5); this sheet says the answer in
// words. The answer is exactly one of:
//   · a figure — always "est.", two significant figures, with its breakdown: each counted line's grams,
//     form and listed heat (a dried line "counted 7–10× as dried"), the ones not counted named, the
//     weight it was divided by, and the line that gives most of the heat;
//   · "Can't work it out: <names> — no listed heat / no weight", with Type it one tap away;
//   · "Nothing with a listed heat — type it".
// NEVER 0 FROM ABSENCE. "Save this estimate" writes it (POST …/shu-estimate/save, basis 'computed', the
// server recomputing); "Type it" writes his own figure (basis 'typed'), which nothing ever overwrites.
// Heat never ranks, tints or badges anything; the words are the only ink.
//
// Required at open: 0 (the census). <Sheet armsBack>, busy while writing.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import { labelChrome, inputChrome } from '../forms/formStyles.js'
import { shuRangeWords, ratingWords, parseRating, FORM_LABELS, DRIED_FACTOR } from './fermentMath.js'

export const SHU_SHEET_TITLE = 'Heat estimate'
const WHY_WORDS = { no_rating: 'no listed heat', no_weight: 'no weight' }
const SOURCE_WORDS = { typed: 'as typed', variety: 'from the variety' }
// What the weight it was divided by IS (shuEstimate.js denominator_source): a jar with no additions of
// its own is the sitting's figure, so its weight is the sitting's Made too.
const DENOMINATOR_WORDS = { about: ' (what you said is in it)', made: ' made', sitting: ' made', row: ' in these bottles' }

// "Can't work it out: gochugaru — no listed heat · onion — no weight". One name per line that lacks one.
export function refusalWords(est) {
  if (!est?.refusal) return null
  if (est.refusal === 'no_heat_lines') return 'Nothing with a listed heat — type it.'
  if (est.refusal === 'mash_in_missing') return 'How much mash went into this bottling? Add “Mash in” on each put-up, then work it out.'
  if (est.refusal === 'row_net_unknown') return 'Can’t work it out: how much is in these bottles.'
  if (est.refusal === 'not_found') return 'That put-up is not in this batch any more.'
  const missing = Array.isArray(est.missing) ? est.missing : []
  const byLabel = new Map()
  for (const m of missing) {
    const k = m.label ?? 'something'
    byLabel.set(k, [...(byLabel.get(k) ?? []), WHY_WORDS[m.why] ?? m.why])
  }
  const parts = [...byLabel].map(([label, whys]) => `${label} — ${[...new Set(whys)].join(', ')}`)
  return parts.length ? `Can’t work it out: ${parts.join(' · ')}` : 'Can’t work it out yet.'
}

// The line that gives most of the heat (by its high end), named once.
export function dominantLine(breakdown) {
  const rows = Array.isArray(breakdown) ? breakdown : []
  let best = null
  for (const b of rows) {
    const heat = Number(b.grams) * Number(b.factor_high ?? 1) * Number(b.rating_high ?? 0)
    if (Number.isFinite(heat) && heat > 0 && (!best || heat > best.heat)) best = { label: b.label, heat }
  }
  return best?.label ?? null
}

export function breakdownWords(b) {
  const grams = `${Math.round(Number(b.grams))} g${b.grams_derived ? ', from the bag size' : ''}`
  const form = b.form && FORM_LABELS[b.form] ? FORM_LABELS[b.form].toLowerCase() : null
  const heat = `${ratingWords(b.rating_low, b.rating_high)} ${SOURCE_WORDS[b.rating_source] ?? ''}`.trim()
  const dried = Number(b.factor_high) > 1 ? `counted ${DRIED_FACTOR.low}–${DRIED_FACTOR.high}× as dried` : null
  return [b.label, grams, form, heat, dried].filter(Boolean).join(' · ')
}

export default function ShuSheet({ open, batchId, scope = 'batch', id = null, title = SHU_SHEET_TITLE, canSave = true, onClose, onSaved, onType }) {
  if (!open) return null
  return <ShuOpen batchId={batchId} scope={scope} id={id} title={title} canSave={canSave} onClose={onClose} onSaved={onSaved} onType={onType} />
}

function ShuOpen({ batchId, scope, id, title, canSave, onClose, onSaved, onType }) {
  const { fetch } = useApiFetch()
  const [est, setEst] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [saving, setSaving] = useState(false)
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')
  const writingRef = useRef(false)
  const typedId = `shu-typed-${useId()}`

  useEffect(() => {
    let alive = true
    const q = `scope=${encodeURIComponent(scope)}${id ? `&id=${encodeURIComponent(id)}` : ''}`
    Promise.resolve()
      .then(() => fetch(`/api/kitchen-batches/${batchId}/shu-estimate?${q}`))
      .then(r => { if (alive) { setEst(r ?? null); setLoading(false) } })
      .catch(() => { if (alive) { setErr('Couldn’t work it out just now — try again.'); setLoading(false) } })
    return () => { alive = false }
  }, [batchId, fetch, id, scope])

  const save = useCallback(async () => {
    if (writingRef.current) return
    writingRef.current = true
    setSaving(true); setErr(null)
    try {
      const out = await fetch(`/api/kitchen-batches/${batchId}/shu-estimate/save`, { method: 'POST', body: JSON.stringify(id ? { scope, id } : { scope }) })
      setSaving(false); writingRef.current = false
      onSaved?.(out)
    } catch (e) {
      setSaving(false); writingRef.current = false
      setErr(describeRefusal(e)?.text ?? 'Couldn’t save that — try again.')
    }
  }, [batchId, fetch, id, onSaved, scope])

  const saveTyped = useCallback(async () => {
    if (writingRef.current) return
    const r = parseRating(typed)
    if (!r || r.error) { setErr(r?.error ?? 'Type the heat as a number, like 950 or 950–3000.'); return }
    writingRef.current = true
    setSaving(true); setErr(null)
    try {
      await onType?.(r)
      setSaving(false); writingRef.current = false
    } catch (e) {
      setSaving(false); writingRef.current = false
      setErr(describeRefusal(e)?.text ?? 'Couldn’t save that — try again.')
    }
  }, [onType, typed])

  const figure = est && !est.refusal ? shuRangeWords(est.low, est.high) : null
  const refusal = refusalWords(est)
  const top = figure ? dominantLine(est.breakdown) : null
  const notCounted = (est?.not_counted ?? []).map(n => n.label).filter(Boolean)

  return (
    <Sheet open onClose={onClose} title={title} size="full" busy={saving} armsBack>
      <div data-testid="shu-sheet" data-scope={scope} style={{ padding: '0 18px 12px' }}>
        {loading && <p style={{ color: P.light, fontSize: T.type.sm }}>Working it out…</p>}
        {figure && (
          <>
            <p data-testid="shu-figure" style={{ margin: '4px 0 6px', color: P.dark, fontSize: T.type.lg, fontWeight: 700 }}>{figure}</p>
            <p style={{ margin: '0 0 8px', color: P.mid, fontSize: '0.82rem' }}>
              Worked out from each pepper’s listed heat and weight
              {est.denominator_g ? `, over ${Math.round(Number(est.denominator_g))} g` : ''}
              {DENOMINATOR_WORDS[est.denominator_source] ?? ''}.
              {est.about_ignored ? ' Used the weight of what went in.' : ''}
            </p>
            <ul data-testid="shu-breakdown" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {(est.breakdown ?? []).map(b => (
                <li key={`${b.line_id ?? b.label}`} style={{ padding: '4px 0', borderBottom: `1px solid ${P.border}`, color: P.dark, fontSize: T.type.sm }}>
                  {breakdownWords(b)}
                </li>
              ))}
            </ul>
            {top && <p data-testid="shu-dominant" style={{ margin: '6px 0 0', color: P.mid, fontSize: '0.82rem' }}>Most of the heat: {top}</p>}
          </>
        )}
        {refusal && <p data-testid="shu-refusal" style={{ margin: '4px 0 8px', color: P.dark, fontSize: T.type.sm }}>{refusal}</p>}
        {est?.refusal === 'cannot_work_it_out' && (
          <p style={{ margin: '0 0 8px', color: P.mid, fontSize: '0.78rem' }}>Add it on the line (tap the line above in What went in), or type the heat yourself.</p>
        )}
        {notCounted.length > 0 && (
          <p data-testid="shu-not-counted" style={{ margin: '6px 0 0', color: P.light, fontSize: '0.78rem' }}>not counted: {notCounted.join(', ')}</p>
        )}
        {err && <p role="alert" data-testid="shu-error" style={{ color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</p>}
        {onType && (
          typing ? (
            <div style={{ marginTop: 10 }}>
              <label htmlFor={typedId} style={labelChrome}>Heat you’re putting on it (SHU)</label>
              <input id={typedId} data-testid="shu-typed" type="text" value={typed} placeholder="e.g. 950–3000" disabled={saving}
                onChange={e => { setTyped(e.target.value); setErr(null) }} style={{ ...inputChrome(false), width: 180 }} />
              <div style={{ marginTop: 8 }}>
                <Button data-testid="shu-typed-save" variant="secondary" loading={saving} loadingLabel="Saving…" onClick={saveTyped}>Save what I typed</Button>
              </div>
            </div>
          ) : (
            <button type="button" data-testid="shu-type-it" onClick={() => setTyping(true)}
              style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, marginTop: 8, background: 'none', border: 'none',
                padding: '2px 8px 2px 0', color: P.green, fontFamily: 'inherit', fontSize: T.type.sm, fontWeight: 600, cursor: 'pointer' }}>
              Type it
            </button>
          )
        )}
      </div>
      {figure && canSave && (
        <div style={{ position: 'sticky', bottom: 0, background: P.white, padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}` }}>
          <Button data-testid="shu-save" variant="primary" loading={saving} loadingLabel="Saving…" onClick={save} style={{ width: '100%' }}>
            Save this estimate
          </Button>
        </div>
      )}
    </Sheet>
  )
}
