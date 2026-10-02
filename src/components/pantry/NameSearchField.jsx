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
//
// `under` (optional): what a host puts DIRECTLY under the name, above the match list — so it is still on
// screen with the keyboard up and the matches showing. Put something up puts its way out to Start a batch
// there. Absent, the field is as it was.
//
// Put-Up R2a (lane Dn; PLAN-R2-V2 "Name search (A4)", amendments C3, C6, D9, rulings Dn-1, Dn-2):
//   · TWO PATHS. An answer with `hits` (an array) is walked in the SERVER's order and never re-sorted:
//     plantings, put-ups, pantry items, crops and varieties, as ranked. An answer with no `hits` (an older
//     Lambda, a stand-in) is read by its arms, as it always was.
//   · A STOCK HIT KEEPS ITS PLACE. For a put-up or pantry-item hit the line and the pick ARE the host's
//     Pantry row with that id when the host has one (it carries `place`, which "already here" and "move it
//     here" key on). `stockRows` null means "use the server's stock hits". One jar is one line.
//   · SAME-NAMED PLANTINGS are told apart: a planting hit whose name another planting hit shares says its
//     wave and sown date after the name. The sown DAY is read off the text of `sown_at`, never through a
//     Date in the device's zone (the planting chooser's own label prints a day early west of UTC).
//   · A TYPED NAME carries the crop the answer resolved for the text on screen, dropped on any edit.
//   · AT MOST SIX ROWS, then "More matches…", which shows the rest.
//   · A PICKED NAME STAYS EDITABLE and keeps its hit; one line under it says what it is tied to; "Search
//     again" drops the hit. What the line says beyond the name (a wave, a sown date) is held HERE, never in
//     the What and never in a draft: a What this field did not pick says its own name.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { labelChrome, requiredMarkChrome, inputChrome } from '../forms/formStyles.js'
import { lineSearchUrl, catalogHitWords } from '../putup/lines.js'
import { nameMatches, rowKey, leftWords, PUT_UP, PANTRY_ITEM } from './pantryRows.js'

const SEARCH_DEBOUNCE_MS = 250
const MIN_QUERY = 2
const MAX_STOCK_HITS = 8
// With the keyboard up about four 48 px rows fit under the name; six, then the rest behind one more row.
export const MAX_MATCH_ROWS = 6
export const MORE_MATCHES_TEXT = 'More matches…'
export const SEARCH_AGAIN_TEXT = 'Search again'

const hitBtn = {
  display: 'block', width: '100%', textAlign: 'left', minHeight: 48, padding: '8px 10px', background: P.white,
  border: 'none', borderBottom: `1px solid ${P.border}`, cursor: 'pointer', fontFamily: 'inherit', fontSize: T.type.sm,
  color: P.dark,
}
const quietBtn = {
  minHeight: 48, minWidth: 48, background: 'none', border: 'none', color: P.green, fontWeight: 600,
  fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer',
}

const trimmed = (v) => String(v ?? '').trim()
const folded = (v) => trimmed(v).toLowerCase()

// "Apr 10" — the calendar day `sown_at` NAMES (its first ten characters, YYYY-MM-DD), printed as the
// planting chooser prints one. Formatted in UTC from a UTC date, so the device's zone never moves the day:
// a date-only value and a midnight-UTC timestamp both read the day they say. null when there is no day.
export function sownDayWords(sownAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(sownAt ?? ''))
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const at = new Date(Date.UTC(y, mo - 1, d))
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// The names (trimmed, case-folded) more than one planting hit in an answer goes by.
export function sharedPlantingNames(plantings) {
  const seen = new Set()
  const shared = new Set()
  for (const p of plantings ?? []) {
    const n = folded(p?.label)
    if (!n) continue
    if (seen.has(n)) shared.add(n)
    else seen.add(n)
  }
  return shared
}

// A planting hit's name. Alone, unless another planting hit shares it: then "Name — wave 2, sown Apr 10",
// the planting chooser's shape, with whichever of the two the hit carries (an answer without them — an
// older Lambda — says the name alone, never "undefined").
export function plantingHitName(hit, shared = null) {
  const base = trimmed(hit?.label) || 'A planting'
  if (!shared || !shared.has(folded(hit?.label))) return base
  const bits = []
  const wave = hit.succession_order
  if (wave != null && wave !== '' && Number.isInteger(Number(wave))) bits.push(`wave ${Number(wave)}`)
  const day = sownDayWords(hit.sown_at)
  if (day) bits.push(`sown ${day}`)
  return bits.length ? `${base} — ${bits.join(', ')}` : base
}
export function plantingHitLine(hit, shared = null) {
  return `${plantingHitName(hit, shared)} · ${hit?.ended ? 'planting, ended' : 'planting'}`
}

// The one line under a picked name: what the name is tied to. A slug is never printed, so a crop is said
// only by a label; a put-up or a bought item ties the name to nothing, and says nothing.
export function tiedWords(source, label) {
  const l = trimmed(label)
  if (!l) return null
  if (source === 'planting') return `from your planting: ${l}`
  if (source === 'crop') return `crop: ${l}`
  if (source === 'variety') return `variety: ${l}`
  return null
}

// Which hit a picked What holds — the key the field's own words are held under.
function tieKey(what) {
  if (!what) return null
  if (what.source === 'planting') return `planting:${what.plant_id}`
  if (what.source === 'variety') return `variety:${what.variety_id}`
  if (what.source === 'crop') return `crop:${what.crop_type_slug}`
  return String(what.source)
}

// A server stock hit in the Pantry row's shape (no place: the line search does not send one).
const jarAsRow = (j) => ({
  stock_kind: PUT_UP, stock_id: j.preservation_log_id, name: j.label ?? '', crop_type_slug: j.crop_type_slug ?? null,
  variety_id: j.variety_id ?? null, place: null,
})
const itemAsRow = (i) => ({
  stock_kind: PANTRY_ITEM, stock_id: i.pantry_item_id, name: i.label ?? '', crop_type_slug: i.crop_type_slug ?? null,
  variety_id: null, place: null,
})
// The host's own Pantry row for a stock hit, when it holds one.
function hostRow(stockRows, kind, id) {
  if (!Array.isArray(stockRows)) return null
  return stockRows.find(r => r && r.stock_kind === kind && String(r.stock_id) === String(id)) ?? null
}

// The ranked answer, one row per hit, in the order the server sent them.
function rankedRows(hits, stockRows) {
  const shared = sharedPlantingNames(hits.filter(h => h?.kind === 'planting'))
  const seen = new Set()
  const out = []
  for (const h of hits) {
    let row = null
    if (h?.kind === 'planting' && h.plant_id != null) row = { key: `planting:${h.plant_id}`, kind: 'planting', hit: h, name: plantingHitName(h, shared), words: plantingHitLine(h, shared) }
    else if (h?.kind === 'put_up' && h.preservation_log_id != null) row = { kind: 'stock', row: hostRow(stockRows, PUT_UP, h.preservation_log_id) ?? jarAsRow(h) }
    else if (h?.kind === 'pantry_item' && h.pantry_item_id != null) row = { kind: 'stock', row: hostRow(stockRows, PANTRY_ITEM, h.pantry_item_id) ?? itemAsRow(h) }
    else if (h?.kind === 'crop' && h.crop_type_slug) row = { key: `crop:${h.crop_type_slug}`, kind: 'crop', hit: h, words: catalogHitWords(h) }
    else if (h?.kind === 'variety' && h.variety_id != null) row = { key: `variety:${h.variety_id}`, kind: 'variety', hit: h, words: catalogHitWords(h) }
    if (!row) continue
    if (row.kind === 'stock') row.key = rowKey(row.row)
    if (seen.has(row.key)) continue
    seen.add(row.key)
    out.push(row)
  }
  return out
}

// An answer with no `hits`, read by its arms: the plantings, then what we have — the host's Pantry rows
// when it has them (they carry the place), else the answer's put-ups. Never both, so one jar is never
// offered twice. Before any answer (and when the search fails) the host's rows are all there is.
function armRows(answer, stockRows, q) {
  const plantings = answer?.plantings ?? []
  const shared = sharedPlantingNames(plantings)
  const stock = Array.isArray(stockRows)
    ? stockRows.filter(r => nameMatches(r?.name, q)).slice(0, MAX_STOCK_HITS)
    : (answer?.put_ups ?? []).slice(0, MAX_STOCK_HITS).map(jarAsRow)
  return [
    ...plantings.map(h => ({ key: `planting:${h.plant_id}`, kind: 'planting', hit: h, name: plantingHitName(h, shared), words: plantingHitLine(h, shared) })),
    ...stock.map(r => ({ key: rowKey(r), kind: 'stock', row: r })),
  ]
}

// The label the answer carried for a crop, or null: a resolved crop is a slug, and a slug is never shown.
function cropLabelIn(r, slug) {
  const crops = [...(Array.isArray(r?.crops) ? r.crops : []), ...(Array.isArray(r?.hits) ? r.hits.filter(h => h?.kind === 'crop') : [])]
  return trimmed(crops.find(c => c?.crop_type_slug === slug && trimmed(c.label))?.label) || null
}

// `value`: { source, name, plant_id?, crop_type_slug?, variety_id? } | null.
// `source`: 'typed' | 'planting' | 'put_up' | 'pantry_item' | 'crop' | 'variety'.
export default function NameSearchField({
  value, onChange, fetch, stockRows = null, placeId = null, onOpenExisting, onMoveHere,
  idPrefix = 'what', label = 'What is it?', invalid = false, inputRef = null, disabled = false, under = null,
}) {
  const [hits, setHits] = useState(null)
  const [searchErr, setSearchErr] = useState(null)
  const [showAll, setShowAll] = useState(false)
  // What this field knows about the picked hit beyond the What: { key, label } — the words its line says.
  const [tie, setTie] = useState(null)
  // The label the last answer carried for the typed text's resolved crop: { slug, label }.
  const [typedCrop, setTypedCrop] = useState(null)
  const seqRef = useRef(0)
  const nameEl = useRef(null)
  const listEl = useRef(null)
  const toRevealed = useRef(false)
  const inputId = `${idPrefix}-input-${useId()}`
  const tieId = `${idPrefix}-tie-${useId()}`
  const text = value?.name ?? ''
  const picked = !!(value && value.source && value.source !== 'typed')

  // The answer of a search is applied to the What the host holds THEN, through the callback it holds then.
  const live = useRef({ value, onChange })
  live.current = { value, onChange }

  // A picked What this field did not pick itself (a restored draft, a door opened from a planting) says its
  // own name, as it stood when it arrived; a What that is no longer picked holds nothing.
  const key = picked ? tieKey(value) : null
  if (picked && tie?.key !== key) setTie({ key, label: trimmed(text) })
  else if (!picked && tie) setTie(null)

  const setInput = useCallback((el) => {
    nameEl.current = el
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef) inputRef.current = el
  }, [inputRef])

  useEffect(() => {
    const q = text.trim()
    // Every change of the text (or of picked) outdates the answer in flight: a late one never paints, and
    // never puts its crop on a name it was not resolved for.
    const seq = ++seqRef.current
    setShowAll(false)
    setTypedCrop(null)
    if (picked || q.length < MIN_QUERY) { setHits(null); setSearchErr(null); return undefined }
    const t = setTimeout(() => {
      Promise.resolve()
        .then(() => fetch(lineSearchUrl(q)))
        .then(r => {
          if (seq !== seqRef.current) return
          setHits({
            plantings: Array.isArray(r?.plantings) ? r.plantings : [], put_ups: Array.isArray(r?.put_ups) ? r.put_ups : [],
            ranked: Array.isArray(r?.hits) ? r.hits : null,
          })
          setSearchErr(null)
          // The typed name's crop is the one THIS answer resolved for the text on screen, or none.
          const slug = typeof r?.resolved_crop === 'string' && r.resolved_crop ? r.resolved_crop : null
          const cropLabel = slug ? cropLabelIn(r, slug) : null
          setTypedCrop(slug && cropLabel ? { slug, label: cropLabel } : null)
          const now = live.current
          if ((now.value?.crop_type_slug ?? null) !== slug) {
            now.onChange(slug ? { source: 'typed', name: now.value?.name ?? q, crop_type_slug: slug } : { source: 'typed', name: now.value?.name ?? q })
          }
        })
        .catch(() => { if (seq === seqRef.current) { setHits(null); setSearchErr("Couldn't search just now — the name you type is kept.") } })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [fetch, picked, text])

  const rows = useMemo(() => {
    const q = text.trim()
    if (picked || q.length < MIN_QUERY) return []
    return hits?.ranked ? rankedRows(hits.ranked, stockRows) : armRows(hits, stockRows, q)
  }, [hits, picked, stockRows, text])
  const shown = showAll ? rows : rows.slice(0, MAX_MATCH_ROWS)

  // "More matches…" was the row under the finger: focus goes to the first row it revealed.
  useEffect(() => {
    if (!showAll || !toRevealed.current) return
    toRevealed.current = false
    listEl.current?.querySelectorAll?.('button')?.[MAX_MATCH_ROWS]?.focus?.()
  }, [showAll])

  // An edited name KEEPS its hit (the planting, crop and variety a pick filled); a typed name drops the
  // crop resolved for the text it was, until the next answer.
  function type(v) { onChange(picked ? { ...value, name: v } : { source: 'typed', name: v }) }
  // A pick answers the question: the keyboard goes down so the next one is on screen.
  function leaveName() { nameEl.current?.blur?.() }
  function pickPlanting(row) {
    const h = row.hit
    leaveName()
    setTie({ key: `planting:${h.plant_id}`, label: trimmed(h.label) ? row.name : '' })
    onChange({ source: 'planting', name: trimmed(h.label), plant_id: h.plant_id,
      crop_type_slug: h.crop_type_slug ?? null, variety_id: h.variety_id ?? null })
  }
  function pickCatalog(row) {
    const h = row.hit
    leaveName()
    setTie({ key: row.key, label: trimmed(h.label) })
    if (row.kind === 'variety') onChange({ source: 'variety', name: trimmed(h.label), variety_id: h.variety_id, crop_type_slug: h.crop_type_slug ?? null })
    else onChange({ source: 'crop', name: trimmed(h.label), crop_type_slug: h.crop_type_slug })
  }
  function pickStock(r) {
    leaveName()
    const here = placeId != null && r.place?.id != null && String(r.place.id) === String(placeId)
    if (here && onOpenExisting) { onOpenExisting(r); return }
    if (placeId != null && r.place?.id != null && onMoveHere) { onMoveHere(r); return }
    onChange({ source: r.stock_kind, name: String(r.name ?? '').trim(), crop_type_slug: r.crop_type_slug ?? null,
      variety_id: r.variety_id ?? null })
  }
  function pick(row) {
    if (row.kind === 'planting') pickPlanting(row)
    else if (row.kind === 'stock') pickStock(row.row)
    else pickCatalog(row)
  }
  function searchAgain() {
    onChange({ source: 'typed', name: text })
    nameEl.current?.focus?.()
  }

  function stockWords(r) {
    const here = placeId != null && r.place?.id != null && String(r.place.id) === String(placeId)
    const left = leftWords(r)
    if (here) return [r.name, 'already here', left].filter(Boolean).join(' · ')
    if (placeId != null && r.place?.id != null && onMoveHere) return `${r.name} · in ${r.place.label} — That's this one → move it here`
    return [r.name, r.place?.label, left].filter(Boolean).join(' · ')
  }

  const tied = picked
    ? tiedWords(value.source, tie?.key === key ? tie.label : text)
    : (value?.crop_type_slug && typedCrop?.slug === value.crop_type_slug ? tiedWords('crop', typedCrop.label) : null)
  const tieLine = tied && (
    <span id={tieId} data-testid={`${idPrefix}-tie`} style={{ fontSize: T.type.sm, color: P.mid }}>{tied}</span>
  )

  return (
    <div>
      <label htmlFor={inputId} style={labelChrome}>{label}<span style={requiredMarkChrome} aria-hidden="true">*</span></label>
      <input id={inputId} ref={setInput} type="text" value={text} disabled={disabled} data-testid={`${idPrefix}-name`}
        aria-required="true" aria-invalid={invalid || undefined} aria-describedby={tied ? tieId : undefined} autoComplete="off"
        onChange={e => type(e.target.value)} placeholder="Type a name"
        style={{ ...inputChrome(invalid), width: '100%', minHeight: T.buttonMinHeight }} />
      {picked ? (
        <div data-testid={`${idPrefix}-picked`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {tieLine}
          <button type="button" data-testid={`${idPrefix}-change`} disabled={disabled} onClick={searchAgain} style={quietBtn}>
            {SEARCH_AGAIN_TEXT}
          </button>
        </div>
      ) : (tieLine && <div style={{ marginTop: 4 }}>{tieLine}</div>)}
      {under}
      {searchErr && <div style={{ color: P.mid, fontSize: T.type.sm, marginTop: 4 }}>{searchErr}</div>}
      {shown.length > 0 && (
        <ul ref={listEl} aria-label={`Matches for ${text.trim()}`} style={{ listStyle: 'none', margin: '6px 0 0', padding: 0,
          border: `1px solid ${P.border}`, borderRadius: T.radiusButton, overflow: 'hidden' }}>
          {shown.map(row => (
            <li key={row.key}>
              <button type="button" style={hitBtn} disabled={disabled} data-testid={`${idPrefix}-hit-${row.key}`}
                onClick={() => pick(row)}>
                {row.kind === 'stock' ? stockWords(row.row) : row.words}
              </button>
            </li>
          ))}
          {rows.length > shown.length && (
            <li key="more">
              <button type="button" style={{ ...hitBtn, color: P.green, fontWeight: 600 }} disabled={disabled}
                data-testid={`${idPrefix}-more`} onClick={() => { toRevealed.current = true; setShowAll(true) }}>
                {MORE_MATCHES_TEXT}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
