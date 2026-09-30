// src/components/pantry/pantryRows.js
// Put-Up B′ release 2 (V4 §2.5 The Pantry, §3.2 basis words, §6.1) — the pure half of the Pantry list:
// how the server's rows are grouped, searched and said, and which ONE inline action a row offers.
// PantryView.jsx paints these; nothing here fetches, renders or reads a clock it was not handed.
//
// THE ROW is the pinned contract's (GET /api/pantry): { stock_kind: 'put_up'|'pantry_item', stock_id,
// name, group_key, group_label, place: {id,label,kind}|null, where_from, from_garden, plant_id,
// crop_type_slug, batch_id, stock_mode: 'counted'|'weighed'|'item', count_left, count_made, grams_left,
// method, discard: {date, basis, status: 'ok'|'soon'|'past'|null}, acquired_at, created_by, updated_at }.
// The server sorts by group then name and classifies discard status; this module never re-decides
// either (the same rule StoresView held for use_by_status: "the server classifies, this only selects").
import { discardWords, parseYmd } from '../putup/jarWords.js'

export const PUT_UP = 'put_up'
export const PANTRY_ITEM = 'pantry_item'

// The one key a row is known by across both tables (the server's (stock_kind, stock_id) pair).
export function rowKey(row) {
  return row ? `${row.stock_kind}:${row.stock_id}` : ''
}

export function isItem(row) { return row?.stock_kind === PANTRY_ITEM }
export function isJar(row) { return row?.stock_kind === PUT_UP }

// Consecutive rows with the same group_key form one group, in the order the server sent them.
export function groupRows(rows) {
  const out = []
  for (const r of rows ?? []) {
    if (!r) continue
    const key = String(r.group_key ?? '')
    const last = out[out.length - 1]
    if (last && last.key === key) last.rows.push(r)
    else out.push({ key, label: String(r.group_label ?? r.group_key ?? ''), rows: [r] })
  }
  return out
}

// ── "Use soon" (V4 §3.2: the only filter name; Today's band links here with ?filter=use-soon) ──────
export const USE_SOON_FILTER = 'use-soon'
export function isUseSoon(row) {
  const s = row?.discard?.status
  return s === 'soon' || s === 'past'
}
export function onlyUseSoon(rows) {
  return (rows ?? []).filter(isUseSoon)
}

// ── The page search (V4 §2.5): name/label match only, case-insensitive, over the Pantry list plus
// whatever else the page hands in (the recipes lane's loaded recipes, via `extraSearchItems`). ─────
export function normalizeQuery(q) {
  return String(q ?? '').trim().toLowerCase()
}
export function nameMatches(name, q) {
  const n = normalizeQuery(q)
  return !!n && String(name ?? '').toLowerCase().includes(n)
}

// Hits: rows first (in list order), then the extra items. An extra item is `{ key, name, kindLabel?,
// onOpen }` — the host decides what opening one means (a recipe opens recipe detail).
export function searchHits(rows, extraItems, q) {
  if (!normalizeQuery(q)) return []
  const hits = []
  for (const r of rows ?? []) {
    if (nameMatches(r?.name, q)) hits.push({ key: rowKey(r), name: r.name, row: r })
  }
  for (const it of extraItems ?? []) {
    if (it && nameMatches(it.name, q)) hits.push({ key: `extra:${it.key ?? it.name}`, name: it.name, extra: it })
  }
  return hits
}

// ── What a row says ────────────────────────────────────────────────────────────────────────────────
// How many left: "3 left" for counted stock, "about 412 g left" for weighed (V4 §2.5, 06 §1.4), nothing
// for a bought item (no counts on bought items, §10.3).
export function leftWords(row) {
  if (!row || isItem(row)) return null
  if (row.stock_mode === 'weighed') {
    const g = Number(row.grams_left)
    return row.grams_left != null && Number.isFinite(g) ? `about ${Math.round(g)} g left` : null
  }
  const n = row.count_left
  if (n == null || !Number.isFinite(Number(n))) return null
  return `${Number(n)} left`
}

// The ONE inline action (V4 §2.5): Used one while a counted row has more than one left; Used it up
// when one is left, when it is uncounted (weighed) and on a bought item.
export const USED_ONE = 'used_one'
export const USED_UP = 'used_up'
export const ACTION_LABELS = Object.freeze({ [USED_ONE]: 'Used one', [USED_UP]: 'Used it up' })
export function inlineAction(row) {
  if (!row) return null
  if (isJar(row) && row.stock_mode === 'counted' && Number(row.count_left) > 1) return USED_ONE
  return USED_UP
}

// The server's discard status in the words jarWords.discardWords reads (use_by_status's values).
const STATUS_WORDS = { soon: 'use_soon', past: 'past_use_by' }

// FOODSAFETY-RULING-V101 §8.2: a house-sourced date is distinguishable on the surface. The methods whose
// figure is the house's (the client half of shelfLife.js HOUSE_SOURCED_SHELF_LIFE); a jar of one written
// before 1b stored a basis has none on the wire, and still says "house estimate", never nothing.
export const HOUSE_METHODS = new Set(['candy'])
export function effectiveBasis(row) {
  const d = row?.discard
  if (!d) return null
  if (d.basis) return d.basis
  return isJar(row) && d.date && HOUSE_METHODS.has(row.method) ? 'house' : null
}

// The discard-by chip, stated once (V4 §3.2), through the shipped basis-words helper. A bought item
// shows a date only if one was typed (§2.5); anything else about it is silence, never "no date".
export function discardChip(row, now = new Date()) {
  const d = row?.discard
  if (!d) return null
  if (isItem(row) && !(d.basis === 'typed' && d.date)) return null
  return discardWords({
    date: d.date ?? null, basis: effectiveBasis(row), method: row.method ?? null, kind: row.place?.kind ?? null,
    status: STATUS_WORDS[d.status] ?? null, now,
  })
}

// "had it 12 days" — a bought item's age, only when the day it came in is known (V4 §2.5). An estimated
// acquired date (a month, a season) is not a known day, so it says nothing rather than a false count.
const KNOWN_DAY = new Set(['day', 'exact', 'hour'])
export function ageWords(row, now = new Date()) {
  if (!isItem(row) || !row.acquired_at) return null
  const p = row.acquired_precision
  if (p != null && !KNOWN_DAY.has(p)) return null
  const d = parseYmd(row.acquired_at)
  if (!d) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((today.getTime() - d.getTime()) / 86400000)
  if (days < 0) return null
  if (days === 0) return 'got it today'
  return `had it ${days} ${days === 1 ? 'day' : 'days'}`
}

// The in-place line after a use, for the person who acted (V4 §2.5 "3 left · used one · Undo"). `jar`
// is what the use route answered ({remaining_count, ...}); the count said is the SERVER's, never the
// row's own arithmetic, because the other person may have used one in between.
export function afterUseWords({ action, jar }) {
  if (action === USED_ONE) {
    const left = jar?.remaining_count
    return left != null ? `${Number(left)} left · used one` : 'used one'
  }
  if (action === 'went_bad') return 'marked gone bad'
  if (action === 'gave_away') {
    const left = jar?.remaining_count
    return left != null ? `${Number(left)} left · gave some away` : 'gave some away'
  }
  return 'used it up'
}
