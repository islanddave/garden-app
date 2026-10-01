// src/components/pantry/NameSearchField.jsx
// Put-Up B′ release 2 (V4 §2.5a "the name search"; §2.2 Put something up and Walk a place) — "What is
// it?". One text field over the SHIPPED name search (GET /api/kitchen-batches/line-search: the
// household's plantings, and its put-ups) plus the Pantry rows the host already holds (put-ups and bought
// items, each with its place). A typed name with no hit is kept as a name (a label).
//
// A hit fills what it knows: a planting → its planting, crop and variety ("Fresh, as picked" keeps them
// on a bought-item save); a put-up or item → its name and crop. In the Walk (`placeId` set) a stock hit
// AT this place reads "already here" and opens that row instead of logging it twice; one at another
// place reads "That's this one → move it here" (V4 §2.2 duplicate prevention).
//
// Every hit is ONE button (no nested interactive), 48 px tall, named from its visible words.
import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { labelChrome, requiredMarkChrome, inputChrome } from '../forms/formStyles.js'
import { lineSearchUrl } from '../putup/lines.js'
import { nameMatches, rowKey, leftWords } from './pantryRows.js'

const SEARCH_DEBOUNCE_MS = 250
const MIN_QUERY = 2
const MAX_STOCK_HITS = 8

const hitBtn = {
  display: 'block', width: '100%', textAlign: 'left', minHeight: 48, padding: '8px 10px', background: P.white,
  border: 'none', borderBottom: `1px solid ${P.border}`, cursor: 'pointer', fontFamily: 'inherit', fontSize: T.type.sm,
  color: P.dark,
}

// `value`: { source, name, plant_id?, crop_type_slug?, variety_id? } | null.
export default function NameSearchField({
  value, onChange, fetch, stockRows = null, placeId = null, onOpenExisting, onMoveHere,
  idPrefix = 'what', label = 'What is it?', invalid = false, inputRef = null, disabled = false,
}) {
  const [hits, setHits] = useState(null)
  const [searchErr, setSearchErr] = useState(null)
  const seqRef = useRef(0)
  const inputId = `${idPrefix}-input-${useId()}`
  const text = value?.name ?? ''
  const picked = value && value.source && value.source !== 'typed'

  useEffect(() => {
    const q = text.trim()
    if (picked || q.length < MIN_QUERY) { setHits(null); setSearchErr(null); return undefined }
    const seq = ++seqRef.current
    const t = setTimeout(() => {
      Promise.resolve()
        .then(() => fetch(lineSearchUrl(q)))
        .then(r => {
          if (seq !== seqRef.current) return
          setHits({ plantings: Array.isArray(r?.plantings) ? r.plantings : [], put_ups: Array.isArray(r?.put_ups) ? r.put_ups : [] })
          setSearchErr(null)
        })
        .catch(() => { if (seq === seqRef.current) { setHits(null); setSearchErr("Couldn't search just now — the name you type is kept.") } })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [fetch, picked, text])

  // What we have: the host's Pantry rows when it has them (they carry the place), else the line
  // search's put-ups. Never both, so one jar is never offered twice.
  const stockHits = useMemo(() => {
    const q = text.trim()
    if (picked || q.length < MIN_QUERY) return []
    if (Array.isArray(stockRows)) return stockRows.filter(r => nameMatches(r?.name, q)).slice(0, MAX_STOCK_HITS)
    return (hits?.put_ups ?? []).slice(0, MAX_STOCK_HITS).map(j => ({
      stock_kind: 'put_up', stock_id: j.preservation_log_id, name: j.label ?? '', crop_type_slug: j.crop_type_slug ?? null,
      variety_id: j.variety_id ?? null, place: null,
    }))
  }, [hits, picked, stockRows, text])

  const plantings = picked ? [] : (hits?.plantings ?? [])

  function type(v) { onChange({ source: 'typed', name: v }) }
  function pickPlanting(h) {
    onChange({ source: 'planting', name: String(h.label ?? '').trim(), plant_id: h.plant_id,
      crop_type_slug: h.crop_type_slug ?? null, variety_id: h.variety_id ?? null })
  }
  function pickStock(r) {
    const here = placeId != null && r.place?.id != null && String(r.place.id) === String(placeId)
    if (here && onOpenExisting) { onOpenExisting(r); return }
    if (placeId != null && r.place?.id != null && onMoveHere) { onMoveHere(r); return }
    onChange({ source: r.stock_kind, name: String(r.name ?? '').trim(), crop_type_slug: r.crop_type_slug ?? null,
      variety_id: r.variety_id ?? null })
  }

  function stockWords(r) {
    const here = placeId != null && r.place?.id != null && String(r.place.id) === String(placeId)
    const left = leftWords(r)
    if (here) return [r.name, 'already here', left].filter(Boolean).join(' · ')
    if (placeId != null && r.place?.id != null && onMoveHere) return `${r.name} · in ${r.place.label} — That's this one → move it here`
    return [r.name, r.place?.label, left].filter(Boolean).join(' · ')
  }

  const showList = !picked && (plantings.length > 0 || stockHits.length > 0)

  return (
    <div>
      <label htmlFor={inputId} style={labelChrome}>{label}<span style={requiredMarkChrome} aria-hidden="true">*</span></label>
      {picked ? (
        <div data-testid={`${idPrefix}-picked`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: T.type.base, fontWeight: 600, color: P.dark }}>
            {text}{value.source === 'planting' ? ' · from your planting' : ''}
          </span>
          <button type="button" data-testid={`${idPrefix}-change`} disabled={disabled}
            onClick={() => onChange({ source: 'typed', name: text })}
            style={{ minHeight: 48, minWidth: 48, background: 'none', border: 'none', color: P.green, fontWeight: 600,
              fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer' }}>
            Change
          </button>
        </div>
      ) : (
        <input id={inputId} ref={inputRef} type="text" value={text} disabled={disabled} data-testid={`${idPrefix}-name`}
          aria-required="true" aria-invalid={invalid || undefined} autoComplete="off"
          onChange={e => type(e.target.value)} placeholder="Type a name"
          style={{ ...inputChrome(invalid), width: '100%', minHeight: 48 }} />
      )}
      {searchErr && <div style={{ color: P.mid, fontSize: T.type.sm, marginTop: 4 }}>{searchErr}</div>}
      {showList && (
        <ul aria-label={`Matches for ${text.trim()}`} style={{ listStyle: 'none', margin: '6px 0 0', padding: 0,
          border: `1px solid ${P.border}`, borderRadius: T.radiusButton, overflow: 'hidden' }}>
          {plantings.map(h => (
            <li key={`planting:${h.plant_id}`}>
              <button type="button" style={hitBtn} disabled={disabled} data-testid={`${idPrefix}-hit-planting:${h.plant_id}`}
                onClick={() => pickPlanting(h)}>
                {String(h.label ?? '').trim() || 'A planting'} · planting
              </button>
            </li>
          ))}
          {stockHits.map(r => (
            <li key={rowKey(r)}>
              <button type="button" style={hitBtn} disabled={disabled} data-testid={`${idPrefix}-hit-${rowKey(r)}`}
                onClick={() => pickStock(r)}>
                {stockWords(r)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
