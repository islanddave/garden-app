// src/components/putup/SaltBlock.jsx
// Put-Up release F (06, the salt sections and §4 item 4; Dave 15:05: "aims 3.5% of water+ingredients for peppers;
// needs % + which weight group; brine optional") — the salt helper, INSIDE What went in and always
// reachable (never gated on line grams).
//
// ONE BLOCK PER SALT LINE, each saying both what was aimed and what went in ("aimed 3.5% · put in 13.5 g
// = 3.0% of 448 g"); tap one to edit its grams or note, or take it out. Then a SALT STEP to add one:
//   · how (Ferment only): Dry · Brine · Salted then rinsed — or "No salt" on a batch with no salt line;
//   · the % he aims for (no default % — ever);
//   · what it is a % of: Veg only · Veg + water · Water only (suggested from the lines, one tap to
//     change), or "Weighed it all together" (one typed reading off the scale, the jar tared first);
//   · rinsed (kimchi's soak) instead asks the soak water's weight — that soak is never a line, is in no
//     base, and its % is never presented as the ferment's (FS-I4);
//   · the live line "3.5% of veg + water (448 g) → [15.7] g salt" with the grams EDITABLE before
//     anything is written (HS-I5), and "left out: … · no weight: …" naming what the % did not count;
//   · "I put in 15.7 g" (48px) is the ONLY thing that writes. "I just know the grams" writes a grams-only
//     salt line. "+ Another salt step" adds another.
// Required at open: 0 (the census). The grams are computed in decimal and stored unrounded (15.68); the
// words round to one decimal. What it writes is a keyed line (contract-F §2.2), role 'salt'.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, optionalMarkChrome, inputChrome } from '../forms/formStyles.js'
import { mintKey } from '../kitchen/idempotencyKey.js'
import LineSheet from './LineSheet.jsx'
import { nextOrdinal } from './lines.js'
import {
  SALT_METHODS, SALT_METHOD_LABELS, SALT_BASES, SALT_BASE_LABELS, saltBase, saltGrams, oneDecimal, wholeGrams,
  saltLivePrefix, saltAsideWords, saltLineWords, parsePct, parseGrams,
} from './fermentMath.js'

export const SALT_ERRORS = Object.freeze({
  pct: 'What % are you aiming for?',
  base: 'Nothing weighed to take a % of yet — add the amounts, or weigh it all together.',
  scale: 'How much does what is in the jar weigh? (Tare the jar first.)',
  soak: 'How much soak water, in g?',
  grams: 'How many g of salt went in?',
})
const round4 = (x) => String(Math.round(Number(x) * 10000) / 10000)

// A base is SUGGESTED, never assumed: veg + water when there is a water line (Dave's own convention),
// veg only otherwise. The chip shows it and one tap changes it.
export function suggestedBase(lines) {
  return (lines ?? []).some(l => l?.role === 'water') ? 'all' : 'produce'
}

export function newStep() {
  return { key: mintKey(), method: null, pct: '', base: null, together: false, scaleG: '', soakG: '', grams: null, gramsOnly: false }
}

// { body, grams } or { error, field }. `grams` is the unrounded number written.
export function saltStepBody(step, { lines, ferment, ordinal = null }) {
  const method = ferment && SALT_METHODS.includes(step.method) ? step.method : null
  const base = { idempotency_key: step.key, input_kind: 'other', label: 'Salt', role: 'salt', qty_unit: 'g' }
  if (ordinal != null) base.ordinal = ordinal
  if (method) base.salt_method = method
  const typedGrams = step.grams != null && String(step.grams).trim() !== '' ? parseGrams(step.grams) : null
  if (step.grams != null && String(step.grams).trim() !== '' && typedGrams == null) return { error: SALT_ERRORS.grams, field: 'grams' }
  if (step.gramsOnly) {
    if (typedGrams == null) return { error: SALT_ERRORS.grams, field: 'grams' }
    return { body: { ...base, qty: round4(typedGrams) }, grams: typedGrams }
  }
  const pct = parsePct(step.pct)
  if (method === 'rinsed') {
    const soak = parseGrams(step.soakG)
    if (soak == null) return { error: SALT_ERRORS.soak, field: 'soak' }
    if (pct == null) return { error: SALT_ERRORS.pct, field: 'pct' }
    const g = typedGrams ?? saltGrams(pct, soak)
    return { body: { ...base, qty: round4(g), salt_pct: pct, salt_base: 'water', base_g: round4(soak), base_from: 'scale' }, grams: g }
  }
  if (pct == null) return { error: SALT_ERRORS.pct, field: 'pct' }
  let baseG
  let baseWord
  if (step.together) {
    baseG = parseGrams(step.scaleG)
    if (baseG == null) return { error: SALT_ERRORS.scale, field: 'scale' }
    baseWord = 'all'
  } else {
    baseWord = step.base ?? suggestedBase(lines)
    baseG = saltBase(lines, baseWord).grams
    if (!(baseG > 0)) return { error: SALT_ERRORS.base, field: 'base' }
  }
  const g = typedGrams ?? saltGrams(pct, baseG)
  return {
    body: { ...base, qty: round4(g), salt_pct: pct, salt_base: baseWord, base_g: round4(baseG), base_from: step.together ? 'scale' : 'lines' },
    grams: g,
  }
}

const quiet = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, background: 'none', border: 'none',
  padding: '2px 8px 2px 0', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: T.type.sm, fontWeight: 600,
}

function SaltStep({ step, onChange, lines, ferment, onWrite, pctRef, idPrefix, busy }) {
  const id = useId()
  const set = (patch) => onChange({ ...step, ...patch })
  const baseWord = step.base ?? suggestedBase(lines)
  const pct = parsePct(step.pct)
  const rinsed = ferment && step.method === 'rinsed'
  const b = rinsed ? null : saltBase(lines, baseWord)
  const baseG = rinsed ? parseGrams(step.soakG) : step.together ? parseGrams(step.scaleG) : b.grams
  const computed = pct != null && baseG > 0 ? saltGrams(pct, baseG) : null
  const shownGrams = step.grams != null ? step.grams : (computed != null ? oneDecimal(computed) : '')
  const res = saltStepBody(step, { lines, ferment })
  const writeLabel = step.gramsOnly
    ? (parseGrams(step.grams) != null ? `I put in ${oneDecimal(parseGrams(step.grams))} g` : 'I put in the salt')
    : (res.grams != null ? `I put in ${oneDecimal(res.grams)} g` : 'I put in the salt')

  return (
    <div data-testid={`${idPrefix}`} style={{ border: `1px solid ${P.border}`, borderRadius: T.radiusBadge, padding: '10px 12px', marginTop: 8 }}>
      {ferment && (
        <div style={{ marginBottom: 8 }}>
          <span style={labelChrome} aria-hidden="true">How<span style={optionalMarkChrome}>optional</span></span>
          <div role="group" aria-label="How was it salted?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {SALT_METHODS.map(m => (
              <SelectChip key={m} touch active={step.method === m} disabled={busy} data-testid={`${idPrefix}-method-${m}`}
                onClick={() => set({ method: step.method === m ? null : m, grams: null })}>{SALT_METHOD_LABELS[m]}</SelectChip>
            ))}
          </div>
        </div>
      )}
      {step.gramsOnly ? (
        <div>
          <label htmlFor={`${id}-g`} style={labelChrome}>Salt that went in, g</label>
          <input id={`${id}-g`} data-testid={`${idPrefix}-grams`} type="text" inputMode="decimal" value={step.grams ?? ''}
            disabled={busy} onChange={e => set({ grams: e.target.value })} style={{ ...inputChrome(false), width: 110, scrollMarginBottom: 120 }} />
        </div>
      ) : (
        <>
          {rinsed && (
            <div style={{ marginBottom: 8 }}>
              <label htmlFor={`${id}-soak`} style={labelChrome}>Soak water, g</label>
              <input id={`${id}-soak`} data-testid={`${idPrefix}-soak`} type="text" inputMode="decimal" value={step.soakG}
                disabled={busy} onChange={e => set({ soakG: e.target.value, grams: null })} style={{ ...inputChrome(false), width: 110, scrollMarginBottom: 120 }} />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <label htmlFor={`${id}-pct`} style={{ ...labelChrome, margin: 0 }}>Salt %</label>
            <input ref={pctRef} id={`${id}-pct`} data-testid={`${idPrefix}-pct`} type="text" inputMode="decimal" value={step.pct}
              placeholder="e.g. 3.5" disabled={busy} onChange={e => set({ pct: e.target.value, grams: null })}
              style={{ ...inputChrome(false), width: 90, scrollMarginBottom: 120 }} />
          </div>
          {!rinsed && !step.together && (
            <div role="group" aria-label="A % of what?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {SALT_BASES.map(bw => (
                <SelectChip key={bw} touch active={baseWord === bw} disabled={busy} data-testid={`${idPrefix}-base-${bw}`}
                  onClick={() => set({ base: bw, grams: null })}>{SALT_BASE_LABELS[bw]}</SelectChip>
              ))}
            </div>
          )}
          {!rinsed && (
            <div style={{ marginBottom: 8 }}>
              <SelectChip touch active={step.together} disabled={busy} data-testid={`${idPrefix}-together`}
                onClick={() => set({ together: !step.together, grams: null })}>Weighed it all together</SelectChip>
              {step.together && (
                <div style={{ marginTop: 8 }}>
                  <label htmlFor={`${id}-scale`} style={labelChrome}>Weight of what’s in the jar, g (tare the jar first)</label>
                  <input id={`${id}-scale`} data-testid={`${idPrefix}-scale`} type="text" inputMode="decimal" value={step.scaleG}
                    disabled={busy} onChange={e => set({ scaleG: e.target.value, grams: null })} style={{ ...inputChrome(false), width: 110, scrollMarginBottom: 120 }} />
                </div>
              )}
            </div>
          )}
          {/* The live line, the payoff: kept in view with the % focused (the layout gate asserts it). */}
          <div aria-live="polite" data-testid={`${idPrefix}-live`} style={{ color: P.dark, fontSize: T.type.sm, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {pct != null && baseG > 0 ? (
              <>
                <span data-testid={`${idPrefix}-live-words`}>
                  {rinsed ? `${pct}% of ${wholeGrams(baseG)} g soak water →` : saltLivePrefix({ pct, base: step.together ? 'all' : baseWord, baseG })}
                </span>
                <input aria-label="Grams of salt" data-testid={`${idPrefix}-live-grams`} type="text" inputMode="decimal" value={shownGrams}
                  disabled={busy} onChange={e => set({ grams: e.target.value })} style={{ ...inputChrome(false), width: 80, scrollMarginBottom: 120 }} />
                <span>g salt</span>
              </>
            ) : (
              <span style={{ color: P.light }}>{pct == null ? 'Type the % to see the grams.' : SALT_ERRORS.base}</span>
            )}
          </div>
          {rinsed && pct != null && baseG > 0 && (
            <div style={{ color: P.mid, fontSize: '0.78rem', marginTop: 2 }}>Soaked, then rinsed off, so not what’s in the jar.</div>
          )}
          {!rinsed && !step.together && b && saltAsideWords(b) && (
            <div data-testid={`${idPrefix}-aside`} style={{ color: P.light, fontSize: '0.78rem', marginTop: 2 }}>{saltAsideWords(b)}</div>
          )}
        </>
      )}
      <button type="button" data-testid={`${idPrefix}-write`} disabled={busy} onClick={() => onWrite(step)}
        style={{ minHeight: T.buttonMinHeight, marginTop: 8, padding: '8px 16px', borderRadius: T.radiusButton, cursor: 'pointer',
          fontFamily: 'inherit', fontSize: T.type.sm2, fontWeight: 700, color: P.green, background: P.white, border: `1px solid ${P.green}` }}>
        {writeLabel}
      </button>
      <div>
        <button type="button" style={{ ...quiet, fontWeight: 400, color: P.mid }} data-testid={`${idPrefix}-grams-only`} disabled={busy}
          onClick={() => set({ gramsOnly: !step.gramsOnly, grams: null })}>
          {step.gramsOnly ? 'Work it out from a %' : 'I just know the grams'}
        </button>
      </div>
    </div>
  )
}

export default function SaltBlock({ batch, lines, onChanged, focusSeq = 0, disabled = false }) {
  const { fetch } = useApiFetch()
  const all = Array.isArray(lines) ? lines : []
  const saltLines = all.filter(l => l.role === 'salt' && l.put_up_stage_id == null)
  const ferment = batch?.kind === 'ferment'
  const [steps, setSteps] = useState(() => (saltLines.length ? [] : [newStep()]))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [status, setStatus] = useState(null)
  const [sheetFor, setSheetFor] = useState(null)
  const [takenOut, setTakenOut] = useState([])
  const writingRef = useRef(false)
  const firstPctRef = useRef(null)

  // [Salt] in What went in: open a step if none is open, then focus its % (it never writes by itself).
  useEffect(() => {
    if (!focusSeq) return
    if (!steps.length) setSteps([newStep()])
    requestAnimationFrame?.(() => {
      firstPctRef.current?.scrollIntoView?.({ block: 'center' })
      firstPctRef.current?.focus()
    })
  }, [focusSeq]) // eslint-disable-line react-hooks/exhaustive-deps

  const write = useCallback(async (step) => {
    if (writingRef.current) return
    const res = saltStepBody(step, { lines: all, ferment, ordinal: nextOrdinal(all) })
    if (res.error) { setErr(res.error); return }
    writingRef.current = true
    setBusy(true); setErr(null); setStatus(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}/inputs`, { method: 'POST', body: JSON.stringify({ inputs: [res.body] }) })
      setSteps(ss => ss.filter(s => s.key !== step.key))
      setStatus(`Added · Salt ${oneDecimal(res.grams)} g`)
      onChanged?.()
    } catch (e) {
      setErr(describeRefusal(e)?.text ?? "Couldn't add the salt — try again. What you typed is still here.")
    } finally { writingRef.current = false; setBusy(false) }
  }, [all, batch.id, ferment, fetch, onChanged])

  // "No salt" (Ferment, no live salt line): a merge PUT the server refuses while a salt line is live
  // (409 has_salt_line — "Take the salt line out first."). Undone by clearing it.
  const setNoSalt = useCallback(async (on) => {
    if (writingRef.current) return
    writingRef.current = true
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}`, { method: 'PUT', body: JSON.stringify({ no_salt: on ? true : null }) })
      onChanged?.()
    } catch (e) {
      setErr(describeRefusal(e)?.text ?? "Couldn't save that — try again.")
    } finally { writingRef.current = false; setBusy(false) }
  }, [batch.id, fetch, onChanged])

  const restore = useCallback(async (line) => {
    if (writingRef.current) return
    writingRef.current = true
    try {
      await fetch(`/api/kitchen-batches/${batch.id}/inputs/${line.id}/restore`, { method: 'POST', body: '{}' })
      setTakenOut(t => t.filter(x => x.id !== line.id))
      onChanged?.()
    } catch (e) {
      setErr(describeRefusal(e)?.text ?? "Couldn't put it back — try again.")
    } finally { writingRef.current = false }
  }, [batch.id, fetch, onChanged])

  const noSalt = batch?.no_salt === true
  return (
    <div data-testid="salt-block" style={{ marginTop: T.space.sm }}>
      <div style={{ color: P.light, fontSize: T.type.xs, fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase' }}>Salt</div>
      {saltLines.map(l => (
        <button key={l.id} type="button" data-testid={`salt-line-${l.id}`} disabled={disabled} onClick={() => setSheetFor(l)}
          style={{ display: 'block', width: '100%', textAlign: 'left', minHeight: T.buttonMinHeight, padding: '6px 0', background: 'none',
            border: 'none', borderBottom: `1px solid ${P.border}`, cursor: 'pointer', fontFamily: 'inherit', fontSize: T.type.sm, color: P.dark }}>
          {saltLineWords(l) || 'Salt'}{l.edited_at ? <span style={{ color: P.light }}> · edited</span> : null}
        </button>
      ))}
      {takenOut.map(l => (
        <div key={`out-${l.id}`} data-testid="salt-taken-out" style={{ display: 'flex', alignItems: 'center', minHeight: T.buttonMinHeight, color: P.light, fontSize: T.type.sm }}>
          <span style={{ flex: 1 }}><s>Salt</s> · Taken out</span>
          <button type="button" style={quiet} data-testid={`salt-taken-out-undo-${l.id}`} onClick={() => restore(l)}>Undo</button>
        </div>
      ))}
      {noSalt && (
        <div data-testid="salt-none" style={{ display: 'flex', alignItems: 'center', minHeight: T.buttonMinHeight, color: P.mid, fontSize: T.type.sm }}>
          <span style={{ flex: 1 }}>No salt</span>
          <button type="button" style={quiet} data-testid="salt-none-undo" disabled={busy} onClick={() => setNoSalt(false)}>Undo</button>
        </div>
      )}
      {!noSalt && steps.map((st, i) => (
        <SaltStep key={st.key} step={st} idPrefix={`salt-step-${i}`} lines={all} ferment={ferment} busy={busy || disabled}
          pctRef={i === 0 ? firstPctRef : undefined}
          onChange={next => { setSteps(ss => ss.map(s => (s.key === st.key ? next : s))); setErr(null) }} onWrite={write} />
      ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 4 }}>
        {!noSalt && (
          <button type="button" style={quiet} data-testid="salt-another" disabled={busy || disabled}
            onClick={() => setSteps(ss => [...ss, newStep()])}>+ {saltLines.length || steps.length ? 'Another salt step' : 'A salt step'}</button>
        )}
        {ferment && !noSalt && saltLines.length === 0 && (
          <button type="button" style={{ ...quiet, color: P.mid }} data-testid="salt-none-set" disabled={busy || disabled}
            onClick={() => setNoSalt(true)}>No salt</button>
        )}
      </div>
      {status && <p role="status" data-testid="salt-status" style={{ margin: '4px 0 0', color: P.mid, fontSize: '0.82rem' }}>{status}</p>}
      {err && <p role="alert" data-alarm-ink-exempt="error" data-testid="salt-error" style={{ margin: '4px 0 0', color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</p>}
      <LineSheet open={!!sheetFor} batchId={batch.id} line={sheetFor} onClose={() => setSheetFor(null)}
        onSaved={() => { setSheetFor(null); onChanged?.() }}
        onTakenOut={({ line }) => { setSheetFor(null); setTakenOut(t => [...t.filter(x => x.id !== line.id), line]); onChanged?.() }} />
    </div>
  )
}
