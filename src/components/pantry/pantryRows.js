// src/components/pantry/pantryRows.js
// Put-Up B′ release 2 (V4 §2.5 The Pantry, §3.2 basis words, §6.1) — the pure half of the Pantry list:
// how the server's rows are grouped, searched and said, and which ONE inline action a row offers.
// PantryView.jsx paints these; nothing here fetches, renders or reads a clock it was not handed.
//
// THE ROW is the pinned contract's (GET /api/pantry): { stock_kind: 'put_up'|'pantry_item', stock_id,
// name, group_key, group_label, place: {id,label,kind}|null, where_from, from_garden, plant_id,
// crop_type_slug, batch_id, stock_mode: 'counted'|'weighed'|'item', count_left, count_made, grams_left,
// method, discard: {date, basis, status: 'ok'|'soon'|'past'|null}, acquired_at, created_by, updated_at }.
// Put-Up R2a: every row also carries, AS STORED, quantity_value (a number or null), quantity_unit,
// source_kind, source_label — a bought item's amount and where it is from. `where_from` stays the server's
// derived words (the planting first, else the stored source).
// The server sorts by group then name and classifies discard status; this module never re-decides
// either (the same rule StoresView held for use_by_status: "the server classifies, this only selects").
import { discardWords, parseYmd, qtyText } from '../putup/jarWords.js'
// The engine's own list, imported (as putItUp.js imports the engine), so there is no copy to drift.
import { HOUSE_SOURCED_SHELF_LIFE } from '../../../lambda/preservation/shelfLife.js'
// The server's own mass table, imported for the same reason: the factors a typed weight was turned into grams with.
import { MASS_G, isMassUnit } from '../../../lambda/preservation/kitchenBatch.js'

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

// Hits: rows first (in list order), then the extra items. An extra item is the recipes lane's
// `{ kind: 'recipe', id, name, type_label?, keeps? }` (or `{ key, name, kindLabel? }`), with an optional
// `onOpen` — the host decides what opening one means (a recipe opens recipe detail).
export function extraKey(it) {
  return `extra:${it.kind ? `${it.kind}:` : ''}${it.id ?? it.key ?? it.name}`
}
export function extraLabel(it) {
  return it.kindLabel ?? it.type_label ?? it.kind ?? null
}
export function searchHits(rows, extraItems, q) {
  if (!normalizeQuery(q)) return []
  const hits = []
  for (const r of rows ?? []) {
    if (nameMatches(r?.name, q)) hits.push({ key: rowKey(r), name: r.name, row: r })
  }
  for (const it of extraItems ?? []) {
    if (it && nameMatches(it.name, q)) hits.push({ key: extraKey(it), name: it.name, extra: it })
  }
  return hits
}

// ── What a row says ────────────────────────────────────────────────────────────────────────────────
// What is left of a WEIGHED bag (one container sized in a weight), IN THE UNIT IT WAS TYPED IN (Put-Up R2a,
// UX I-2): "about 1 lb left" · "about 12 oz left" · "about 1.5 kg left". A bag typed in grams, and one whose
// unit was never stored or is not a weight, says whole grams ("about 412 g left", V4 §2.5, 06 §1.4).
// `grams` is the server's count of what is left and `unit` the row's quantity_unit AS STORED. The factors
// are the ones the server made those grams with (MASS_G: its create seeds quantity_value × the factor, its
// row multiplies the same way), so a fresh 1 lb divides back to 1. At most two decimals, no trailing zeros
// (qtyText). Less than 0.01 of the unit would print as 0 for something that is still there, so it is said
// in grams. null when the grams are not a number.
// THE ONE PLACE these words are built: the planting page's put-up row (planting/plantingKitchen.js) says
// them through here too, so the two surfaces cannot disagree about one bag.
export function weighedLeftWords(grams, unit) {
  if (grams == null) return null
  const g = Number(grams)
  if (!Number.isFinite(g)) return null
  if (unit !== 'g' && isMassUnit(unit)) {
    const n = g / MASS_G[unit]
    if (n >= 0.01) return `about ${qtyText(n.toFixed(2))} ${unit} left`
  }
  return `about ${Math.round(g)} g left`
}

// How many left: "3 left" for counted stock, what is left of a weighed bag in its own unit
// (weighedLeftWords), nothing for a bought item (no counts on bought items, §10.3).
export function leftWords(row) {
  if (!row || isItem(row)) return null
  if (row.stock_mode === 'weighed') return weighedLeftWords(row.grams_left, row.quantity_unit)
  const n = row.count_left
  if (n == null || !Number.isFinite(Number(n))) return null
  return `${Number(n)} left`
}

// ── A bought item's amount (Put-Up R2a) ──────────────────────────────────────────────────────────
// "2 lb" · "1.5 qt" · "12 count" · "1 bag" · "2 bags" · "2 bunches". AS LOGGED: nothing decrements it, so
// it is what was got, never what remains — it is never followed by "left", and it is not `leftWords`.
// A unit written out as a WORD takes its plural when the number is not one; an abbreviation never does
// (2 lb, 4 fl oz), and neither does "count" (12 count). The units are the server's stored singulars
// (lambda/preservation/kitchenBatch.js KITCHEN_UNITS); one that is not in this list is said as it is stored.
export const UNIT_PLURALS = Object.freeze({
  cup: 'cups', pint: 'pints', clove: 'cloves', head: 'heads', bunch: 'bunches', pinch: 'pinches', peck: 'pecks',
  bushel: 'bushels', 'half-bushel': 'half-bushels', flat: 'flats', jar: 'jars', bag: 'bags',
})
export function unitWords(unit, value) {
  const u = String(unit ?? '')
  return Number(value) === 1 ? u : (UNIT_PLURALS[u] ?? u)
}
// A bought item's amount as it is said, or null when it has none. A put-up's size is said in its own
// words (jarWords.sizeWords, in the row sheet), so a put-up row answers null here.
export function amountWords(row) {
  if (!isItem(row)) return null
  const v = row.quantity_value
  const unit = typeof row.quantity_unit === 'string' ? row.quantity_unit.trim() : ''
  if (v == null || v === '' || !unit) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return `${qtyText(v)} ${unitWords(unit, n)}`
}

// The row's detail line: place · where from · the batch it came from · what is left, or a bought item's
// amount (· how long a bought item has been had). `batchName` is the host's (the names read,
// pantryApi.listBatchNames): a jar whose batch the host cannot name says nothing about it — never
// "from undefined".
// `finished` (Put-Up R2a): the row is one the person's own use just finished (finishedByUse) and is still
// on screen for its Undo. What it says is left is the count from BEFORE that use, so it is not said: the
// line under it ("used it up", "marked gone bad") is what is true now. Decided here, where a row is drawn,
// and never in leftWords, which the name search and the Walk also print.
export function detailWords(row, { now = new Date(), batchName = null, finished = false } = {}) {
  const batch = typeof batchName === 'string' && batchName.trim() ? `from ${batchName.trim()}` : null
  return [inPlaceGroup(row) ? null : row?.place?.label, row?.where_from, batch, finished ? null : leftWords(row), amountWords(row),
    ageWords(row, now)].filter(Boolean).join(' · ')
}

// Is this row sitting under a heading that IS its place? Grouped By place the server's group_key is the
// place's id, so the row's own place would only repeat the heading above it; grouped By what it is the key
// is the crop, and the place is news. Read off the row itself, so a list that is being regrouped (the new
// grouping asked for, the old rows still on screen) never drops or doubles the place for a moment.
export function inPlaceGroup(row) {
  return row?.place?.id != null && String(row.group_key ?? '') === String(row.place.id)
}

// SEVERAL LEFT: a counted put-up with more than one left. The ONE test two things hang on, so they cannot
// drift: the row's inline action (Used one, not Used it up) and whether the row sheet's Went bad asks how
// many (Went bad…) or acts at once (Went bad). A weighed bag's count is null on the server's row
// (pantryItems.js jarRow), so it is never "several"; neither is a bought item.
export function severalLeft(row) {
  return isJar(row) && row.stock_mode === 'counted' && Number(row.count_left) > 1
}

// The ONE inline action (V4 §2.5): Used one while a counted row has more than one left; Used it up
// when one is left, when it is uncounted (weighed) and on a bought item.
export const USED_ONE = 'used_one'
export const USED_UP = 'used_up'
export const ACTION_LABELS = Object.freeze({ [USED_ONE]: 'Used one', [USED_UP]: 'Used it up' })
export function inlineAction(row) {
  if (!row) return null
  return severalLeft(row) ? USED_ONE : USED_UP
}

// The server's discard status in the words jarWords.discardWords reads (use_by_status's values).
const STATUS_WORDS = { soon: 'use_soon', past: 'past_use_by' }

// FOODSAFETY-RULING-V101 §8.2: a house-sourced date is distinguishable on the surface. The methods whose
// figure is the house's (shelfLife.js HOUSE_SOURCED_SHELF_LIFE); a jar of one written before 1b stored a
// basis has none on the wire, and still says "house estimate", never nothing.
export const HOUSE_METHODS = new Set(HOUSE_SOURCED_SHELF_LIFE)
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
    status: STATUS_WORDS[d.status] ?? null, recipeName: d.recipe_name ?? row.recipe_name ?? null, now,
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

// What the use route says is left, as a number — or null when it did not say.
function leftAfter(jar) {
  const left = jar?.remaining_count
  return left != null && Number.isFinite(Number(left)) ? Number(left) : null
}

// The in-place line after a use, for the person who acted (V4 §2.5 "3 left · used one · Undo"). `jar`
// is what the use route answered ({remaining_count, ...}) and `use` the use row it wrote ({count_used,
// ...}); the counts said are the SERVER's, never the row's own arithmetic, because the other person may
// have used one in between. Went bad that left some says both counts ("4 left · 2 went bad"); Went bad
// that took all of it keeps "marked gone bad".
export function afterUseWords({ action, jar, use }) {
  if (action === USED_ONE) {
    const left = jar?.remaining_count
    return left != null ? `${Number(left)} left · used one` : 'used one'
  }
  if (action === 'went_bad') {
    const left = leftAfter(jar)
    if (left == null || left <= 0) return 'marked gone bad'
    const n = Number(use?.count_used)
    return Number.isInteger(n) && n > 0 ? `${left} left · ${n} went bad` : `${left} left · some went bad`
  }
  if (action === 'gave_away') {
    const left = jar?.remaining_count
    return left != null ? `${Number(left)} left · gave some away` : 'gave some away'
  }
  return 'used it up'
}

// The in-place line after a move: "<name> — moved to <place> · <the discard words of the row the server
// answered>" (PLAN-V3 D4). The date, its basis and its status are the ANSWER's, never worked out here: a
// put-up's move answers the jar (use_by_target, use_by_basis, use_by_status); a bought item's answers the
// item, whose date a move never touches. `place` is the chip that was tapped. An answer that is not a row
// (nothing came back) leaves the line at the name and the place.
const ANSWER_STATUS = { ok: 'ok', use_soon: 'soon', past_use_by: 'past' }
export function movedWords({ row, place, saved, now = new Date() }) {
  const name = String(row?.name ?? '').trim() || 'It'
  const to = String(place?.label ?? '').trim()
  const head = to ? `${name} — moved to ${to}` : `${name} — moved`
  if (!row || !saved || typeof saved !== 'object') return head
  let discard
  if (isItem(row)) {
    const date = 'use_by_target' in saved ? (saved.use_by_target ?? null) : (row.discard?.date ?? null)
    discard = { date, basis: date ? 'typed' : null, status: date && date === row.discard?.date ? (row.discard?.status ?? null) : null }
  } else {
    if (!('use_by_target' in saved) && !('use_by_basis' in saved)) return head
    discard = { ...(row.discard ?? {}), date: saved.use_by_target ?? null, basis: saved.use_by_basis ?? null,
      status: ANSWER_STATUS[saved.use_by_status] ?? null }
  }
  const words = discardChip({
    ...row, method: saved.method ?? row.method ?? null, discard,
    place: { id: saved.storage_location_id ?? place?.id ?? null, label: to || null, kind: place?.kind ?? null },
  }, now)
  return words ? `${head} · ${words}` : head
}

// Did that use FINISH the row? A row that is still live after a use (Used one, some given away, some gone
// bad) keeps its inline action beside the Undo; one the use finished (used up, all of it gone bad, nothing
// left) shows only its Undo. Went bad is finished unless the server says some are left — the answer that
// keeps today's rule for a discard of everything, whatever the answer carried.
export function finishedByUse(recent) {
  if (!recent) return false
  const left = leftAfter(recent.jar)
  if (recent.action === USED_ONE || recent.action === 'gave_away') return left != null && left <= 0
  if (recent.action === 'went_bad') return !(left != null && left > 0)
  return true
}
