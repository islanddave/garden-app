// src/components/putup/LineAdder.jsx
// Put-Up release F (06 §4 item 3; contract-F §2.2) — adding ONE line to what went in: a name field that
// searches the household's plantings (with their recent picks) and put-ups, or keeps a typed name.
// Mounted by What went in (the line is written at once) and by Put it up's "added at the end" (the
// line joins the sitting's body) — so a line is asked for the same way wherever it goes in.
//
// WHAT IT ASKS (census: 1 required at open — the name):
//   · a planting hit → an optional "Which pick?" ("No particular pick" preselected);
//   · a put-up hit, counted → "How many?" (a 48px −/+ stepper starting at 1) + optional grams that went in;
//     weighed → "How many g?" with "about 92 g left after";
//   · a typed name → kept as typed.
//   · the amount, with unit chips g · oz · lb · ml · count, preselected from the batch's last line; an
//     amount with no unit is refused inline ("Pick a unit for 412"), never a server 400.
//   · "More about it": form, Listed heat (when a form is set or there is no variety to fall back on),
//     brand, where from, note.
// The Add button is PINNED (sticky, above the keyboard) only while the name or amount field has focus;
// otherwise it sits in the flow. One button either way, so it is never on screen twice.
//
// The host owns the write: `onAdd(body)` resolves true when it landed. The draft's idempotency key is
// minted with the draft and reused on every retry, so a retried Add after a lost answer is a replay.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, optionalMarkChrome, inputChrome } from '../forms/formStyles.js'
import { mintKey } from '../kitchen/idempotencyKey.js'
import {
  lineSearchUrl, QUICK_UNITS, defaultUnit, emptyDraft, lineBody, jarHitWords, plantingHitWords, pickWords,
  gramsLeftAfter, hitKey, offerListedHeat, DRIED_NOTE,
} from './lines.js'
import { KITCHEN_FORMS, FORM_LABELS } from './fermentMath.js'

const SEARCH_DEBOUNCE_MS = 250
const MIN_QUERY = 2
const MASS_CHIPS = ['g', 'oz', 'lb', 'kg']

const link = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, minWidth: 44, background: 'none', border: 'none',
  padding: '2px 8px 2px 0', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: T.type.sm, fontWeight: 600,
}
const hitBtn = {
  display: 'block', width: '100%', textAlign: 'left', minHeight: 48, padding: '8px 10px', background: P.white,
  border: 'none', borderBottom: `1px solid ${P.border}`, cursor: 'pointer', fontFamily: 'inherit', fontSize: T.type.sm,
  color: P.dark,
}

function Stepper({ value, onChange, disabled, name, idPrefix }) {
  const n = Number(value)
  const count = Number.isInteger(n) && n >= 1 ? n : 1
  const btn = (on) => ({ width: 48, height: 48, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, background: P.white,
    color: on ? P.dark : P.light, fontSize: '1.2rem', cursor: on ? 'pointer' : 'default', fontFamily: 'inherit' })
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button type="button" aria-label={`One fewer — ${name}`} aria-disabled={count <= 1 ? true : undefined} disabled={disabled}
        data-testid={`${idPrefix}-count-minus`} onClick={() => { if (count > 1) onChange(String(count - 1)) }} style={btn(count > 1)}>−</button>
      <input type="text" inputMode="numeric" aria-label={`How many — ${name}`} data-testid={`${idPrefix}-count`} value={value}
        disabled={disabled} onChange={e => onChange(e.target.value.replace(/[^0-9]/g, ''))}
        style={{ ...inputChrome(false), width: 64, minHeight: 44, textAlign: 'center' }} />
      <button type="button" aria-label={`One more — ${name}`} disabled={disabled} data-testid={`${idPrefix}-count-plus`}
        onClick={() => onChange(String(count + 1))} style={btn(true)}>+</button>
    </div>
  )
}

// `pinnable` false keeps the Add button in the flow — inside a sheet whose own footer is pinned, a
// second pinned bar would sit on it. `excludeJarIds`: jars the host has already named (a put-up sitting
// may draw from a jar once), left out of the matches.
export default function LineAdder({
  lines = [], onAdd, idPrefix = 'line-add', disabled = false, forms = KITCHEN_FORMS, preset = null,
  presetSeq = 0, label = 'What went in?', addLabel = 'Add', onStarted, pinnable = true, excludeJarIds = [],
}) {
  const { fetch } = useApiFetch()
  const unit0 = useMemo(() => defaultUnit(lines), [lines])
  const [draft, setDraft] = useState(() => emptyDraft(mintKey(), { unit: unit0 }))
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState(null)
  const [searchErr, setSearchErr] = useState(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [focused, setFocused] = useState(null)       // 'name' | 'qty' | null — pins the Add button
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const writingRef = useRef(false)
  const seqRef = useRef(0)
  const nameRef = useRef(null)
  const qtyRef = useRef(null)
  const nameId = `${idPrefix}-name-${useId()}`
  const listId = `${idPrefix}-hits-${useId()}`

  // [Water] (or any host preset): a fresh draft, prefilled, with the amount focused.
  useEffect(() => {
    if (!presetSeq || !preset) return
    setDraft({ ...emptyDraft(mintKey(), { unit: unit0, role: preset.role ?? null, label: preset.label ?? '' }) })
    setQuery(preset.label ?? '')
    setHits(null); setErr(null)
    requestAnimationFrame?.(() => qtyRef.current?.focus())
  }, [presetSeq]) // eslint-disable-line react-hooks/exhaustive-deps

  // The search: debounced, sequence-guarded (a late answer for an older query never paints).
  useEffect(() => {
    const q = query.trim()
    if (draft.source || draft.role || q.length < MIN_QUERY) { setHits(null); setSearchErr(null); return undefined }
    const seq = ++seqRef.current
    const t = setTimeout(() => {
      Promise.resolve()
        .then(() => fetch(lineSearchUrl(q)))
        .then(r => {
          if (seq !== seqRef.current) return
          setHits({ plantings: Array.isArray(r?.plantings) ? r.plantings : [], put_ups: Array.isArray(r?.put_ups) ? r.put_ups : [] })
          setSearchErr(null)
        })
        .catch(() => { if (seq === seqRef.current) { setHits(null); setSearchErr("Couldn't search just now — you can still add it by name.") } })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [draft.role, draft.source, fetch, query])

  const set = (patch) => { setDraft(d => ({ ...d, ...patch })); setErr(null) }
  const pick = (source) => {
    const hit = source.hit
    const patch = { source, label: hit.label ?? '' }
    if (source.kind === 'jar') {
      if (hit.stock_mode === 'weighed') patch.unit = 'g'
      if (hit.suggested_form && forms.includes(hit.suggested_form)) patch.form = hit.suggested_form
      patch.countDrawn = '1'
    }
    setDraft(d => ({ ...d, ...patch }))
    setQuery(hit.label ?? '')
    setHits(null); setErr(null)
    onStarted?.()
  }
  const clearSource = () => { setDraft(d => ({ ...d, source: null })); setErr(null) }

  const add = useCallback(async () => {
    if (writingRef.current) return
    const res = lineBody({ ...draft, label: draft.source ? draft.label : query }, { ordinal: null })
    if (res.error) {
      setErr(res.error)
      if (res.field === 'name') nameRef.current?.focus()
      else if (res.field === 'qty' || res.field === 'unit') qtyRef.current?.focus()
      return
    }
    writingRef.current = true
    setBusy(true); setErr(null)
    let ok = false
    try { ok = await onAdd(res.body) } catch { ok = false }
    writingRef.current = false
    setBusy(false)
    if (ok) {
      // A fresh draft and a fresh key — the next line is a new event.
      setDraft(emptyDraft(mintKey(), { unit: draft.role ? unit0 : (draft.unit || unit0) }))
      setQuery(''); setHits(null); setMoreOpen(false)
    }
  }, [draft, onAdd, query, unit0])

  const src = draft.source
  const jar = src?.kind === 'jar' ? src.hit : null
  const weighed = jar?.stock_mode === 'weighed'
  const planting = src?.kind === 'planting' ? src.hit : null
  const unitChoices = weighed ? MASS_CHIPS : QUICK_UNITS
  const after = weighed ? gramsLeftAfter(jar, draft.qty, draft.unit) : null
  const pinned = pinnable && (focused === 'name' || focused === 'qty')
  const jarHits = hits ? hits.put_ups.filter(h => !excludeJarIds.includes(h.preservation_log_id)) : []
  const rating = offerListedHeat(draft) || String(draft.rating ?? '').trim() !== ''
  const q = query.trim()
  const exactHit = hits && [...hits.plantings, ...(hits.put_ups ?? [])].some(h => String(h.label ?? '').trim().toLowerCase() === q.toLowerCase())

  return (
    <div data-testid={idPrefix} style={{ marginTop: T.space.sm }}>
      {/* Required (the census counts it through aria-required), but no red asterisk: this field sits on
          batch detail's body, where the alarm inks stay off (BatchDetailView's inherited rulings). */}
      <label htmlFor={nameId} style={labelChrome}>{label}</label>
      <input ref={nameRef} id={nameId} data-testid={`${idPrefix}-name`} type="text" value={query} maxLength={120}
        aria-required="true" aria-autocomplete="list" aria-controls={hits ? listId : undefined} disabled={disabled || busy}
        placeholder={draft.role === 'water' ? 'Water' : 'Search your plantings and put-ups, or type a name'}
        onFocus={() => setFocused('name')} onBlur={() => setFocused(f => (f === 'name' ? null : f))}
        onChange={e => {
          const v = e.target.value
          setQuery(v)
          if (draft.source && v.trim() !== String(draft.source.hit?.label ?? '').trim()) clearSource()
          else setErr(null)
          if (v.trim() && !draft.source) onStarted?.()
        }}
        style={{ ...inputChrome(!!err && !q), scrollMarginBottom: 72 }} />

      {searchErr && <div data-testid={`${idPrefix}-search-error`} style={{ color: P.light, fontSize: '0.78rem', marginTop: 4 }}>{searchErr}</div>}

      {hits && !src && (
        <ul id={listId} data-testid={`${idPrefix}-hits`} aria-label="Matches" style={{ listStyle: 'none', margin: '4px 0 0', padding: 0,
          border: `1px solid ${P.border}`, borderRadius: T.radiusButton, overflow: 'hidden' }}>
          {hits.plantings.map(h => (
            <li key={hitKey(h)}>
              <button type="button" style={hitBtn} data-testid={`${idPrefix}-hit-${hitKey(h)}`}
                onClick={() => pick({ kind: 'planting', hit: h, pickId: null })}>
                {plantingHitWords(h)} <span style={{ color: P.light }}>· from the garden</span>
              </button>
            </li>
          ))}
          {jarHits.map(h => (
            <li key={hitKey(h)}>
              <button type="button" style={hitBtn} data-testid={`${idPrefix}-hit-${hitKey(h)}`}
                onClick={() => pick({ kind: 'jar', hit: h })}>
                {jarHitWords(h)} <span style={{ color: P.light }}>· put up</span>
              </button>
            </li>
          ))}
          {q && !exactHit && (
            <li>
              <button type="button" style={{ ...hitBtn, color: P.mid }} data-testid={`${idPrefix}-typed`}
                onClick={() => { setHits(null); qtyRef.current?.focus() }}>
                Use “{q}” as it is
              </button>
            </li>
          )}
        </ul>
      )}

      {src && (
        <div data-testid={`${idPrefix}-source`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, color: P.mid, fontSize: '0.82rem' }}>
          <span>{planting ? `${plantingHitWords(planting)} · from the garden` : jarHitWords(jar)}</span>
          <button type="button" style={{ ...link, fontWeight: 400 }} data-testid={`${idPrefix}-source-clear`} disabled={busy}
            onClick={() => { clearSource(); nameRef.current?.focus() }}>Change</button>
        </div>
      )}

      {planting && Array.isArray(planting.recent_picks) && planting.recent_picks.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <span style={labelChrome} aria-hidden="true">Which pick?<span style={optionalMarkChrome}>optional</span></span>
          <div role="radiogroup" aria-label="Which pick?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {[{ harvest_log_id: null }, ...planting.recent_picks].map(pk => {
              const on = (src.pickId ?? null) === (pk.harvest_log_id ?? null)
              return (
                <SelectChip key={pk.harvest_log_id ?? 'none'} touch role="radio" aria-checked={on} aria-pressed={undefined}
                  active={on} disabled={busy} data-testid={`${idPrefix}-pick-${pk.harvest_log_id ?? 'none'}`}
                  onClick={() => setDraft(d => ({ ...d, source: { ...d.source, pickId: pk.harvest_log_id ?? null } }))}>
                  {pk.harvest_log_id ? pickWords(pk) : 'No particular pick'}
                </SelectChip>
              )
            })}
          </div>
        </div>
      )}

      {jar && !weighed && (
        <div style={{ marginTop: 8 }}>
          <span style={labelChrome} aria-hidden="true">How many?<span style={optionalMarkChrome}>starts at 1</span></span>
          <Stepper value={draft.countDrawn} onChange={v => set({ countDrawn: v })} disabled={busy} name={draft.label || 'this'} idPrefix={idPrefix} />
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <label htmlFor={`${nameId}-qty`} style={labelChrome}>
          {weighed ? 'How many g?' : jar ? 'g that went in' : 'How much?'}
          {!weighed && <span style={optionalMarkChrome}>optional</span>}
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input ref={qtyRef} id={`${nameId}-qty`} data-testid={`${idPrefix}-qty`} type="text" inputMode="decimal" value={draft.qty}
            disabled={disabled || busy} onChange={e => set({ qty: e.target.value })}
            onFocus={() => setFocused('qty')} onBlur={() => setFocused(f => (f === 'qty' ? null : f))}
            style={{ ...inputChrome(false), width: 96, scrollMarginBottom: 72 }} />
          <div role="radiogroup" aria-label="Unit" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {unitChoices.map(u => (
              <SelectChip key={u} touch role="radio" aria-checked={draft.unit === u} aria-pressed={undefined} active={draft.unit === u}
                disabled={busy} data-testid={`${idPrefix}-unit-${u}`} onClick={() => set({ unit: draft.unit === u && !weighed ? null : u })}>
                {u}
              </SelectChip>
            ))}
          </div>
        </div>
        {weighed && after != null && (
          <div role="status" data-testid={`${idPrefix}-left-after`} style={{ marginTop: 4, color: P.mid, fontSize: '0.78rem' }}>
            about {after} g left after
          </div>
        )}
      </div>

      {!draft.role && (
        <div style={{ marginTop: 4 }}>
          <button type="button" aria-expanded={moreOpen} style={link} data-testid={`${idPrefix}-more`} disabled={busy}
            onClick={() => setMoreOpen(o => !o)}>
            {moreOpen ? '− Less about it' : '+ More about it'}
          </button>
          {moreOpen && (
            <div data-testid={`${idPrefix}-more-panel`} style={{ marginTop: 4 }}>
              <span style={labelChrome} aria-hidden="true">Form<span style={optionalMarkChrome}>optional</span></span>
              <div role="group" aria-label="Form" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {forms.map(f => (
                  <SelectChip key={f} touch active={draft.form === f} disabled={busy} data-testid={`${idPrefix}-form-${f}`}
                    onClick={() => set({ form: draft.form === f ? null : f })}>{FORM_LABELS[f]}</SelectChip>
                ))}
              </div>
              {rating && (
                <div style={{ marginBottom: 8 }}>
                  <label htmlFor={`${nameId}-heat`} style={labelChrome}>Listed heat (SHU)<span style={optionalMarkChrome}>optional</span></label>
                  <input id={`${nameId}-heat`} data-testid={`${idPrefix}-heat`} type="text" inputMode="text" value={draft.rating}
                    placeholder="e.g. 2500–8000" disabled={busy} onChange={e => set({ rating: e.target.value })}
                    style={{ ...inputChrome(false), width: 180, scrollMarginBottom: 72 }} />
                  <div style={{ marginTop: 4, color: P.light, fontSize: '0.74rem' }}>
                    The fresh pepper’s rating{draft.form === 'dried' ? ` — ${DRIED_NOTE}` : ''}.
                  </div>
                </div>
              )}
              <label htmlFor={`${nameId}-brand`} style={labelChrome}>Brand<span style={optionalMarkChrome}>optional</span></label>
              <input id={`${nameId}-brand`} data-testid={`${idPrefix}-brand`} type="text" maxLength={120} value={draft.brand}
                disabled={busy} onChange={e => set({ brand: e.target.value })} style={{ ...inputChrome(false), marginBottom: 8, scrollMarginBottom: 72 }} />
              <label htmlFor={`${nameId}-from`} style={labelChrome}>Where from<span style={optionalMarkChrome}>optional</span></label>
              <input id={`${nameId}-from`} data-testid={`${idPrefix}-from`} type="text" maxLength={120} value={draft.sourceLabel}
                disabled={busy} onChange={e => set({ sourceLabel: e.target.value })} style={{ ...inputChrome(false), marginBottom: 8, scrollMarginBottom: 72 }} />
              <label htmlFor={`${nameId}-note`} style={labelChrome}>Note<span style={optionalMarkChrome}>optional</span></label>
              <input id={`${nameId}-note`} data-testid={`${idPrefix}-note`} type="text" value={draft.note}
                disabled={busy} onChange={e => set({ note: e.target.value })} style={{ ...inputChrome(false), scrollMarginBottom: 72 }} />
            </div>
          )}
        </div>
      )}

      {err && <div role="alert" data-alarm-ink-exempt="error" data-testid={`${idPrefix}-error`} style={{ marginTop: 6, color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</div>}

      {/* ONE Add. Pinned above the keyboard only while the name or amount field has focus (06 §4 item 3),
          so the finger that just typed reaches it; in the flow otherwise. mousedown is prevented so a
          tap on it does not blur the field first and un-pin it mid-tap. */}
      <div data-testid={`${idPrefix}-bar`} data-pinned={pinned ? 'true' : 'false'}
        style={pinned
          ? { position: 'sticky', bottom: 0, zIndex: 5, background: P.white, borderTop: `1px solid ${P.border}`, padding: `${T.space.sm}px 0`, marginTop: 8 }
          : { marginTop: 8 }}>
        <button type="button" data-testid={`${idPrefix}-submit`} disabled={disabled || busy}
          onMouseDown={e => e.preventDefault()} onClick={add}
          style={{ minHeight: T.buttonMinHeight, width: '100%', padding: '8px 16px', borderRadius: T.radiusButton,
            cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: T.type.sm2, fontWeight: 700,
            color: P.white, background: P.green, border: `1px solid ${P.green}`, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Adding…' : addLabel}
        </button>
      </div>
    </div>
  )
}
