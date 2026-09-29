// src/components/putup/putItUp.js
// Put-Up release 1b (V4 §2.4, §3.1–§3.6, §5.1, Appendix B) — the pure half of "Put it up": the chips it
// offers, how a When answer becomes a stored date and precision, what each row may ask, the preview
// of each row's discard-by, the ONE request body, and the words of the completion stub and label hint.
// The sheet (PutItUpSheet.jsx) paints these; it decides nothing a test cannot pin here.
//
// THE WRITE (V4 §5.1): POST /api/kitchen-batches/:id/put-up, ONE statement server-side, keyed by a
// client-minted idempotency_key held in the sheet's draft and reused on every retry (§5.2, §6.5).
// The server resolves each jar's discard-by and basis with the engine module; the preview below uses
// THE SAME module (lambda/preservation/shelfLife.js, imported, not mirrored) so the date shown before
// Save is the date the write stores. The preview is still only a preview: the completion stub and
// What came out render what the server answered.
//
// THE RULINGS (V4 §3, FOODSAFETY-RULING-V101): record and prompt, never assess. Nothing here grades a
// pH, derives a readiness, or words a date as anything but a date with where it came from.
import { resolveShelfLife, addMonths } from '../../../lambda/preservation/shelfLife.js'
import {
  parseYmd, toYmd, shortDay, putUpDateWords, basisWords, KIND_WORDS, ESTIMATED_PRECISIONS, countedSize,
} from './jarWords.js'

export const PUT_IT_UP_CTA = 'Put it up'
export const PUT_IT_UP_TITLE = 'Put it up'
export const FINISH_CTA = 'Put it up and finish'
export const LATER_CTA = 'More to put up later'
export const PUT_IT_UP_SHEET = 'putup'

// ── When (§2.4, §3.6) ─────────────────────────────────────────────────────────────────────────────
export const WHEN_CHIPS = Object.freeze([
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'earlier', label: 'Earlier…' },
  { id: 'unsure', label: 'Not sure' },
])

export const WHEN_ERRORS = Object.freeze({
  none: 'When was it put up? Pick one — or Not sure.',
  earlier: 'Pick roughly when — or tap Not sure.',
  pickdate: 'Pick the date — or tap Not sure.',
  future: "That date hasn't happened yet — pick another.",
  unsure: "There's no date for this batch yet — pick roughly when instead.",
})

function monthStart(y, m) { return new Date(y, m, 1) }

// §3.6's estimate chips as WINDOWS computed from today. Each stores its window's START and one
// precision word; a chip whose window is empty is hidden, so the chips never overlap and leave no gap.
// Returned newest first, Pick a date last.
export function estimateChips(now = new Date()) {
  const y = now.getFullYear(); const m = now.getMonth()
  const thisMonth = monthStart(y, m)
  const lastMonth = monthStart(y, m - 1)
  const twoThree = monthStart(y, m - 3)          // the two months before last month
  const jan1 = monthStart(y, 0)
  const chips = [
    { id: 'this_month', label: 'This month', start: thisMonth, precision: 'month' },
    { id: 'last_month', label: 'Last month', start: lastMonth, precision: 'month' },
    { id: 'two_three', label: '2–3 months ago', start: twoThree, precision: 'season' },
  ]
  // Jan 1 → the start of "2–3 months ago": empty (hidden) when that chip already reaches January.
  if (twoThree.getTime() > jan1.getTime()) chips.push({ id: 'earlier_year', label: 'Earlier this year', start: jan1, precision: 'year' })
  // Last calendar year minus any months a nearer chip covers: empty only if the nearer chips swallowed
  // all of it, which three months cannot.
  const lastYear = monthStart(y - 1, 0)
  if (twoThree.getTime() > lastYear.getTime()) chips.push({ id: 'last_year', label: 'Last year', start: lastYear, precision: 'year' })
  chips.push({ id: 'pickdate', label: 'Pick a date', start: null, precision: 'day' })
  return chips
}

function isSameLocalDay(iso, now) {
  if (!iso) return false
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return false
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

// "Nothing is preselected unless the batch was started or last checked today" (§2.4).
export function preselectWhen(batch, now = new Date()) {
  if (!batch) return null
  return isSameLocalDay(batch.started_at, now) || isSameLocalDay(batch.current_stage_entered_at, now) ? 'today' : null
}

// The date "Not sure" resolves to: the batch's latest dated event, never before its start. Returned
// as a local YYYY-MM-DD, or null when the batch has no dated event at all (then a coarse chip is
// required — the sheet says so rather than inventing a day).
export function notSureDate(batch) {
  if (!batch) return null
  const start = batch.started_at ? new Date(batch.started_at) : null
  const cands = [batch.started_at, batch.current_stage_entered_at]
    .map(v => (v ? new Date(v) : null)).filter(d => d && !Number.isNaN(d.getTime()))
  if (!cands.length) return null
  let latest = cands.reduce((a, b) => (b.getTime() > a.getTime() ? b : a))
  if (start && !Number.isNaN(start.getTime()) && latest.getTime() < start.getTime()) latest = start
  return toYmd(latest)
}

// { when: {date, precision}, words } or { error }. `date` is the jar's put-up day (a DATE column);
// the precision word rides beside it (§3.6). Not sure stores the earliest it could be, precision
// 'after' (§3.6 "Put it up's Not sure").
export function resolveWhen({ chip, estimate = null, pickedDate = '', batch = null, now = new Date() }) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (chip === 'today') return { when: { date: toYmd(today), precision: 'day' }, words: 'today' }
  if (chip === 'yesterday') {
    const d = new Date(today); d.setDate(d.getDate() - 1)
    return { when: { date: toYmd(d), precision: 'day' }, words: 'yesterday' }
  }
  if (chip === 'unsure') {
    const after = notSureDate(batch)
    if (!after) return { error: WHEN_ERRORS.unsure }
    return { when: { date: after, precision: 'after' }, words: `sometime after ${shortDay(after, now)} — the last date we have` }
  }
  if (chip !== 'earlier') return { error: WHEN_ERRORS.none }
  if (!estimate) return { error: WHEN_ERRORS.earlier }
  if (estimate === 'pickdate') {
    const d = parseYmd(pickedDate)
    if (!d) return { error: WHEN_ERRORS.pickdate }
    if (d.getTime() > today.getTime()) return { error: WHEN_ERRORS.future }
    return { when: { date: toYmd(d), precision: 'day' }, words: shortDay(d, now) }
  }
  const c = estimateChips(now).find(x => x.id === estimate)
  if (!c || !c.start) return { error: WHEN_ERRORS.earlier }
  return { when: { date: toYmd(c.start), precision: c.precision }, words: putUpDateWords(toYmd(c.start), c.precision, { now }) }
}

// ── What it is now: method chips by batch kind (Appendix B) ──────────────────────────────────────
// Labels follow the shipped log form's METHOD_GROUPS (PutUp.jsx) so one method reads one way.
export const METHOD_LABELS = Object.freeze({
  whole_freeze: 'Freeze whole', blanch_freeze: 'Blanch & freeze', roast_freeze: 'Roast & freeze',
  dehydrate: 'Dehydrate', powder: 'Powder', passata: 'Passata / sauce', pesto: 'Pesto', hot_sauce: 'Hot sauce',
  can_water_bath: 'Water-bath can', can_pressure: 'Pressure can', jam_preserve: 'Jam / preserve',
  candy: 'Candied (pieces or sweets)', quick_pickle: 'Quick / vinegar pickle', ferment: 'Ferment',
  ferment_mash: 'Fermenting mash (unfinished)', cure_store: 'Cure & store', cold_store: 'Cold store',
  purchased_preserved: 'Bought already preserved', other: 'Other',
})
// Everything More… offers. "Bought already preserved" is not a thing a batch becomes, so it is left out.
export const ALL_PUT_UP_METHODS = Object.freeze(Object.keys(METHOD_LABELS).filter(m => m !== 'purchased_preserved'))

const KIND_METHODS = {
  ferment: ['hot_sauce', 'ferment_mash', 'ferment', 'other'],
  dehydrate: ['dehydrate', 'powder', 'other'],
  candy: ['candy', 'jam_preserve', 'can_water_bath', 'quick_pickle'],
  cure: ['cure_store', 'cold_store', 'other'],
  infuse: ['other'],
}
// ≤ 4 chips + More…; nothing preselected. No kind, Other (and the legacy `age`) → the full list, with
// no More… needed.
export function methodChipsForKind(kind) {
  const list = KIND_METHODS[kind]
  return list ? { chips: list, more: true } : { chips: ALL_PUT_UP_METHODS, more: false }
}

// Which row questions a method allows (§3.3 (d)(e), §3.8).
export const RAW_METHODS = new Set(['hot_sauce', 'pesto', 'other'])
export const TEXTURE_METHODS = new Set(['dehydrate', 'powder'])
export const PH_METHODS = new Set(['ferment', 'ferment_mash', 'hot_sauce', 'quick_pickle', 'jam_preserve',
  'can_water_bath', 'can_pressure', 'passata'])
export const TEXTURE_CHIPS = Object.freeze([
  { value: 'snaps', label: 'Snaps' }, { value: 'bends', label: 'Bends' }, { value: 'still_soft', label: 'Still soft' },
])
export const RAW_LABEL = 'Raw'
export const RAW_HINT = 'Fresh — not cooked, pickled or fermented'
export const IN_OIL_LABEL = 'In oil'

// ── Containers (Appendix B, §4.7): presets carry explicit units; never a bare "oz" ────────────────
export const CONTAINER_PRESETS = Object.freeze([
  { label: '5 oz woozy', size_value: 5, size_unit: 'fl oz' },
  { label: '8 oz woozy', size_value: 8, size_unit: 'fl oz' },
  { label: '4 oz jar', size_value: 4, size_unit: 'fl oz' },
  { label: 'half-pint', size_value: 1, size_unit: 'cup' },
  { label: 'pint', size_value: 1, size_unit: 'pint' },
  { label: 'quart', size_value: 1, size_unit: 'qt' },
  { label: 'bag', size_value: null, size_unit: null },
])

// The household's past labels after the presets, case-insensitively de-duplicated against them.
export function containerChoices(pastLabels = []) {
  const seen = new Set(CONTAINER_PRESETS.map(c => c.label.toLowerCase()))
  const extra = []
  for (const raw of pastLabels ?? []) {
    const l = typeof raw === 'string' ? raw.trim() : ''
    if (!l || seen.has(l.toLowerCase())) continue
    seen.add(l.toLowerCase()); extra.push({ label: l, size_value: null, size_unit: null })
  }
  return [...CONTAINER_PRESETS, ...extra]
}

// ── Places (Appendix B) ──────────────────────────────────────────────────────────────────────────
export const PLACE_TEMPLATES = Object.freeze([
  { label: 'Fridge', kind: 'fridge' }, { label: 'Freezer', kind: 'deep_freezer' },
  { label: 'Pantry shelf', kind: 'pantry' }, { label: 'Counter', kind: 'other' },
])
// The household's own places by label, then a template only for a kind with no place yet. A chip is
// `{ key, label, kind, id? }`; a template chip has no id and is created server-side by find-or-create.
export function placeChips(places = []) {
  const own = [...(places ?? [])].filter(p => p && p.id != null)
    .sort((a, b) => String(a.label).localeCompare(String(b.label)))
    .map(p => ({ key: `id:${p.id}`, id: String(p.id), label: String(p.label ?? ''), kind: p.kind ?? null }))
  const kinds = new Set(own.map(p => p.kind))
  const templates = PLACE_TEMPLATES.filter(t => !kinds.has(t.kind))
    .map(t => ({ key: `new:${t.kind}:${t.label.toLowerCase()}`, id: null, label: t.label, kind: t.kind }))
  return [...own, ...templates]
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────
// A row's shape in the sheet (and in its draft). `place` is a chip ({key,label,kind,id?}) or null.
// Rows 2..N INHERIT container and place from the row above (§2.4) — live, not copied once: changing
// row 1's place moves every inheriting row with it, until that row's own "Change" is tapped, which
// takes the values it was showing as its own.
export function newRow(prev = null) {
  return {
    count: '1', inherit: !!prev, container: null, place: null,
    name: '', lines: [], isRaw: false, inOil: false, texture: null, ph: '', discard: { mode: 'auto', date: '' },
  }
}

// Every row with its inherited container and place resolved.
export function effectiveRows(rows) {
  const out = []
  for (const r of rows ?? []) {
    const above = out[out.length - 1]
    out.push(r.inherit && above ? { ...r, container: above.container, place: above.place } : r)
  }
  return out
}

export function rowSummary(row) {
  const n = Number(row?.count)
  const size = countedSize(Number.isFinite(n) && n >= 1 ? n : 1, row?.container
    ? { container_label: row.container.label } : {})
  return [size, row?.place?.label].filter(Boolean).join(' · ')
}

// The count field: a whole number ≥ 1. The field may hold '' mid-edit; that sends 1 (the stepper
// starts at 1 and the count is not required, V4 §6.3).
export function rowCount(row) {
  const n = Number(row?.count)
  return Number.isInteger(n) && n >= 1 ? n : 1
}

// ── The discard-by preview (§3.1, §3.3) ──────────────────────────────────────────────────────────
// typed > (recipe: none in 1b) > the engine > none. The engine cell comes from shelfLife.js; the two
// 1b rules that need a jar's own answers are applied here in the order §3.3 states them:
//   (d) Raw or In oil anywhere but a freezer → no date (at a freezer the freezer leg applies);
//   (e) dried and marked Bends or Still soft → no date.
// A put-up date known only as `unknown` gets no engine date (§3.1).
const FREEZER_KINDS = new Set(['deep_freezer', 'fridge_freezer'])
export function previewDiscard({ row, method, when, now = new Date() }) {
  const kind = row?.place?.kind ?? null
  if (row?.discard?.mode === 'none') return { date: null, basis: 'typed', words: 'no date · set by hand' }
  if (row?.discard?.mode === 'date') {
    const d = parseYmd(row.discard.date)
    if (!d) return { date: null, basis: 'typed', words: 'pick the date from the label', incomplete: true }
    return { date: toYmd(d), basis: 'typed', words: `discard by ${shortDay(d, now)} · set by hand` }
  }
  if (!method || !when?.date) return null
  const none = { date: null, basis: 'none', words: basisWords('none') }
  if (when.precision === 'unknown') return none
  if ((row?.isRaw || row?.inOil) && !FREEZER_KINDS.has(kind)) return none
  if (TEXTURE_METHODS.has(method) && (row?.texture === 'bends' || row?.texture === 'still_soft')) return none
  const cell = resolveShelfLife(method, kind)
  if (cell.months == null) return none
  const date = addMonths(when.date, cell.months)
  const shown = ESTIMATED_PRECISIONS.has(when.precision) ? `around ${shortDay(date, now)}` : shortDay(date, now)
  return { date, basis: cell.basis, words: `discard by ${shown} · ${basisWords(cell.basis, { method, kind })}` }
}

// Rows with the same date and basis are shown as ONE preview line (§2.4), each with its row numbers.
export function groupPreviews(previews) {
  const groups = []
  previews.forEach((p, i) => {
    if (!p) return
    const g = groups.find(x => x.words === p.words)
    if (g) g.rows.push(i + 1); else groups.push({ words: p.words, rows: [i + 1] })
  })
  return groups
}

// ── The one body (§5.1) ──────────────────────────────────────────────────────────────────────────
function lineBody(l) {
  const label = String(l?.label ?? '').trim()
  if (!label) return null
  const qty = String(l?.qty ?? '').trim()
  const out = { input_kind: 'other', label }
  if (qty !== '' && Number.isFinite(Number(qty)) && Number(qty) > 0 && l.unit) { out.qty = qty; out.qty_unit = l.unit }
  return out
}

function placeBody(place) {
  if (!place) return null
  if (place.id) return { id: place.id }
  return { kind: place.kind, label: String(place.label ?? '').trim() }
}

// { body } or { error, field, row? }. The only refusals are the three required answers (§6.3): when,
// what it is now, and row 1's place (rows 2..N inherit). Everything else is optional and absent when
// unanswered — an absent key, never a guessed default.
export function putUpBody({ key, when, method, rows, sittingLines = [], madeG = '', nextTime = '', finish, batch }) {
  if (!when) return { error: WHEN_ERRORS.none, field: 'when' }
  if (!method) return { error: 'What is it now? Pick one.', field: 'method' }
  const list = effectiveRows(Array.isArray(rows) && rows.length ? rows : [newRow()])
  const out = []
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    const place = r.place
    if (!place) return { error: i === 0 ? 'Where is it going? Pick a place.' : `Where is row ${i + 1} going?`, field: 'place', row: i }
    const row = { count: rowCount(r), place: placeBody(place) }
    if (r.container) {
      row.container_label = r.container.label
      if (r.container.size_value != null && r.container.size_unit) {
        row.size_value = r.container.size_value; row.size_unit = r.container.size_unit
      }
    }
    const name = String(r.name ?? '').trim()
    if (name && name !== String(batch?.label ?? '').trim()) row.name = name
    if (RAW_METHODS.has(method) && r.isRaw) row.is_raw = true
    if (r.inOil) row.in_oil = true
    if (TEXTURE_METHODS.has(method) && r.texture) row.texture = r.texture
    const ph = String(r.ph ?? '').trim()
    if (PH_METHODS.has(method) && ph) row.ph = ph
    if (r.discard?.mode === 'none') row.discard_by = 'none'
    else if (r.discard?.mode === 'date') {
      const d = parseYmd(r.discard.date)
      if (!d) return { error: `Pick the discard date for row ${i + 1} — or let the app work it out.`, field: 'discard', row: i }
      row.discard_by = toYmd(d)
    }
    const lines = (r.lines ?? []).map(lineBody).filter(Boolean)
    if (lines.length) row.added_lines = lines
    out.push(row)
  }
  const body = {
    idempotency_key: key, when, method,
    rows: out,
    finish: finish === true,
  }
  const sl = (sittingLines ?? []).map(lineBody).filter(Boolean)
  if (sl.length) body.sitting_lines = sl
  const made = String(madeG ?? '').trim()
  if (made !== '' && Number.isFinite(Number(made)) && Number(made) > 0) body.made_g = made
  const nt = String(nextTime ?? '').trim()
  if (nt) body.next_time = nt
  return { body }
}

// ── Completion (§2.4) ────────────────────────────────────────────────────────────────────────────
// The label hint names the discard date only when its basis is typed (or recipe), and says "around"
// for an estimated date. `jar` is what the server answered for one row (label, preserved_at,
// preserved_at_precision, use_by_target, use_by_basis) — never the sheet's own guess.
export function labelHint(jar, now = new Date()) {
  if (!jar) return null
  const name = String(jar.label ?? '').trim()
  const dayWords = putUpDateWords(jar.preserved_at, jar.preserved_at_precision ?? 'day', { now })
  const parts = [name, dayWords].filter(Boolean)
  if (jar.use_by_target && (jar.use_by_basis === 'typed' || jar.use_by_basis === 'recipe')) {
    const est = ESTIMATED_PRECISIONS.has(jar.preserved_at_precision) && jar.use_by_basis !== 'typed'
    parts.push(`discard ${est ? 'around ' : ''}${shortDay(jar.use_by_target, now)}`)
  }
  return parts.length ? `Write '${parts.join(' · ')}' on the label` : null
}

// "<name> — put up · 2 × 8 oz woozy · Fridge · Write '…' on the label". One line per row group; the
// stub keeps the first row's hint (the one label a cook writes first) and names every row.
export function completionStub({ batch, rows, jars, now = new Date() }) {
  const name = String(batch?.label ?? '').trim() || 'This batch'
  const parts = effectiveRows(rows).map(r => rowSummary(r)).filter(Boolean)
  const hint = labelHint(Array.isArray(jars) ? jars[0] : null, now)
  return [`${name} — put up`, ...parts, hint].filter(Boolean).join(' · ')
}

export function placeWords(kind) { return KIND_WORDS[kind] ?? null }
