// src/components/putup/lines.js
// Put-Up release F — a batch LINE, as the surface says it and as a write sends it (06 §4 item 3,
// contract-F §2.2). The rules for each line kind live here once so What went in, the line sheet, the
// salt helper and Put it up's additions cannot build two different bodies for one answer.
//
// THE FOUR WAYS A LINE COMES IN (Dave 15:55: "lets not lose the linking to existing plantings … and
// from existing putups"):
//   · a planting, no pick needed          → input_kind 'garden'  (plant_id)
//   · a pick from that planting           → input_kind 'harvest' (harvest_log_id; the planting is
//                                           copied server-side)
//   · a draw from something put up        → input_kind 'put_up'  (preservation_log_id; a counted jar
//                                           takes count_drawn, a weighed bag takes grams)
//   · a typed name                        → input_kind 'other'   (the name kept as typed)
// B′ release 3 adds two (V4 §2.5a's whole corpus):
//   · a bought item in the Pantry         → input_kind 'pantry'  (pantry_item_id)
//   · a crop or a variety                 → input_kind 'other'   (its name, and its crop_type_slug)
// and a typed name carries the search's resolved crop when there is one (an exact variety name).
// Salt and water are typed lines with a role. Every line carries its own idempotency_key, minted when
// the draft was begun and reused on every retry (V4 §5.2).
//
// PURE: no React, no fetch, no clock.
import {
  KITCHEN_FORMS, FORM_LABELS, isMassUnit, gramsOf, parseRating, ratingWords, DRIED_FACTOR,
} from './fermentMath.js'

export const LINE_SEARCH_PATH = '/api/kitchen-batches/line-search'
export const lineSearchUrl = (q) => `${LINE_SEARCH_PATH}?q=${encodeURIComponent(String(q ?? '').trim())}`
// The unit chips the add row offers (06 §4 item 3). Every one is in KITCHEN_UNITS.
export const QUICK_UNITS = Object.freeze(['g', 'oz', 'lb', 'ml', 'count'])
export const FROM_GARDEN_WORDS = 'from the garden'

// The unit preselected on a new line: the batch's most recently added line with one of the quick
// units ("g in practice"), else g. A household-wide "last unit" needs a read no route offers, so the
// batch's own lines stand in for it.
export function defaultUnit(lines) {
  const withUnit = (lines ?? []).filter(l => l && QUICK_UNITS.includes(l.qty_unit) && l.role !== 'salt')
  if (!withUnit.length) return 'g'
  const newest = withUnit.reduce((a, b) => (String(b.added_at ?? '') >= String(a.added_at ?? '') ? b : a))
  return newest.qty_unit
}

// Display order is `ordinal NULLS FIRST, added_at, id` (legacy lines first); a new line goes last.
export function nextOrdinal(lines) {
  const ords = (lines ?? []).map(l => Number(l?.ordinal)).filter(Number.isInteger)
  return ords.length ? Math.max(...ords) + 1 : 1
}

// A legacy bulk pick row: a 'harvest' line written by the shipped predicate path, which never set an
// ordinal. Those keep the count-and-reveal; every F line is always visible.
export const isLegacyPick = (l) => !!l && l.input_kind === 'harvest' && l.ordinal == null

function trimNum(v) {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return String(Math.round(n * 100) / 100)
}

// "Megatron jalapeño · 412 g · fresh" / "Carrots · 1 used · 150 g" / "Reaper · 8 g" / "Onion".
// The "from the garden" words are the COMPONENT's (a separate span with an aria-hidden mark), so this
// string is the line itself and nothing about its provenance.
export function lineWords(line) {
  if (!line) return ''
  const parts = [String(line.label ?? '').trim() || 'Something that went in']
  if (line.input_kind === 'put_up' && line.count_drawn != null) parts.push(`${line.count_drawn} used`)
  if (line.qty != null && line.qty_unit) parts.push(`${trimNum(line.qty)} ${line.qty_unit}`)
  else if (line.input_kind === 'harvest' && line.qty == null && line.ordinal == null) parts.push('the whole pick')
  if (line.form && FORM_LABELS[line.form]) parts.push(FORM_LABELS[line.form].toLowerCase())
  if (line.brand) parts.push(line.brand)
  if (line.shu_rating_low != null) {
    parts.push(Number(line.shu_rating_low) === 0 && (line.shu_rating_high == null || Number(line.shu_rating_high) === 0)
      ? 'counted as 0' : `listed ${ratingWords(line.shu_rating_low, line.shu_rating_high)}`)
  }
  return parts.join(' · ')
}

// "counted 7–10× as dried" — shown beside a dried line's typed rating so the rule is visible (06 §6 Q1).
export const DRIED_NOTE = `counted ${DRIED_FACTOR.low}–${DRIED_FACTOR.high}× as dried`

// ── line-search hits ────────────────────────────────────────────────────────────────────────────────
export function hitKey(hit) {
  if (!hit) return null
  // B′ release 3: a ranked hit carries its own key (planting:/jar:/pantry:/crop:/variety:) — a pantry
  // item from a planting has a plant_id too, so the key must come first.
  if (hit.key) return hit.key
  if (hit.plant_id) return `planting:${hit.plant_id}`
  if (hit.preservation_log_id) return `jar:${hit.preservation_log_id}`
  return null
}

// What a jar hit says in the result list: its name, how it is stocked, what is left.
export function jarHitWords(hit) {
  if (!hit) return ''
  const parts = [String(hit.label ?? '').trim() || 'A put-up']
  if (hit.stock_mode === 'weighed') {
    const left = hit.remaining_amount != null ? Number(hit.remaining_amount) : gramsOf(hit.quantity_value, hit.quantity_unit)
    if (left != null && Number.isFinite(left)) parts.push(`about ${Math.round(left)} g left`)
  } else {
    const left = hit.remaining_count ?? hit.package_count
    if (left != null) parts.push(`${left} left`)
  }
  return parts.join(' · ')
}

export function plantingHitWords(hit) {
  if (!hit) return ''
  const n = Array.isArray(hit.recent_picks) ? hit.recent_picks.length : 0
  return [String(hit.label ?? '').trim() || 'A planting', n ? `${n} recent ${n === 1 ? 'pick' : 'picks'}` : 'planting'].join(' · ')
}

// B′ release 3 — the words for the other ranked hits.
export function pantryHitWords(hit) {
  if (!hit) return ''
  return [String(hit.label ?? '').trim() || 'Something bought', hit.place_label].filter(Boolean).join(' · ')
}
export function catalogHitWords(hit) {
  if (!hit) return ''
  return [String(hit.label ?? '').trim(), hit.kind === 'variety' ? 'variety' : 'crop'].filter(Boolean).join(' · ')
}
// The one line a ranked hit says, and its quiet tail.
export function rankedHitWords(hit) {
  if (!hit) return { text: '', tail: '' }
  if (hit.kind === 'planting') return { text: plantingHitWords(hit), tail: hit.ended ? 'ended · from the garden' : 'from the garden' }
  if (hit.kind === 'put_up') return { text: jarHitWords(hit), tail: 'put up' }
  if (hit.kind === 'pantry_item') return { text: pantryHitWords(hit), tail: 'in the pantry' }
  return { text: String(hit.label ?? '').trim(), tail: hit.kind === 'variety' ? 'variety' : 'crop' }
}
// The draft source a ranked hit becomes.
export function sourceOfHit(hit) {
  if (!hit) return null
  if (hit.kind === 'planting') return { kind: 'planting', hit, pickId: null }
  if (hit.kind === 'put_up') return { kind: 'jar', hit }
  if (hit.kind === 'pantry_item') return { kind: 'pantry', hit }
  if (hit.kind === 'crop' || hit.kind === 'variety') return { kind: 'catalog', hit }
  return null
}

export function pickWords(pick) {
  if (!pick) return ''
  const parts = []
  if (pick.picked_on) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(pick.picked_on))
    parts.push(m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : String(pick.picked_on))
  }
  if (pick.qty != null && pick.qty_unit) parts.push(`${trimNum(pick.qty)} ${pick.qty_unit}`)
  return parts.join(' · ') || 'A pick'
}

// A weighed bag's grams after this draw: "about 92 g left after". null when it cannot be said.
export function gramsLeftAfter(hit, qty, unit) {
  if (!hit || hit.stock_mode !== 'weighed') return null
  const now = hit.remaining_amount != null ? Number(hit.remaining_amount) : gramsOf(hit.quantity_value, hit.quantity_unit)
  const take = gramsOf(qty, unit)
  if (now == null || take == null || !Number.isFinite(now)) return null
  return Math.max(0, Math.round(now - take))
}

// ── the draft and its body ──────────────────────────────────────────────────────────────────────────
// A draft: { key, source: null | { kind:'planting', hit, pickId } | { kind:'jar', hit },
//            label, qty, unit, countDrawn, form, rating, brand, sourceLabel, note, role }
export function emptyDraft(key, { unit = 'g', role = null, label = '' } = {}) {
  return { key, source: null, label, qty: '', unit: role === 'water' ? 'ml' : unit, countDrawn: '1', form: null,
    rating: '', brand: '', sourceLabel: '', note: '', role }
}

export const LINE_ERRORS = Object.freeze({
  name: 'What went in? Type a name or pick one.',
  weighed: 'How many g went in? That one is weighed.',
  weighedUnit: 'That one is weighed — give it in g, oz, lb or kg.',
  count: 'How many — a whole number, 1 or more.',
  amount: 'That amount needs to be a number more than 0.',
})
export const unitNeeded = (qty) => `Pick a unit for ${String(qty).trim()}`

function textOrNull(v) {
  const s = String(v ?? '').trim()
  return s ? s : null
}

// { body } or { error, field }. Only what the draft answered is sent: an absent key, never a guess.
export function lineBody(draft, { ordinal = null, crop = null } = {}) {
  if (!draft) return { error: LINE_ERRORS.name, field: 'name' }
  const src = draft.source
  const label = textOrNull(draft.label) ?? textOrNull(src?.hit?.label)
  const qtyText = String(draft.qty ?? '').trim()
  const qty = qtyText === '' ? null : Number(qtyText.replace(',', '.'))
  if (qty != null && !(Number.isFinite(qty) && qty > 0)) return { error: LINE_ERRORS.amount, field: 'qty' }
  if (qty != null && !draft.unit) return { error: unitNeeded(qtyText), field: 'unit' }
  const body = { idempotency_key: draft.key }
  if (src?.kind === 'planting') {
    if (src.pickId) { body.input_kind = 'harvest'; body.harvest_log_id = src.pickId } else { body.input_kind = 'garden'; body.plant_id = src.hit.plant_id }
    if (label) body.label = label
    if (src.hit.crop_type_slug) body.crop_type_slug = src.hit.crop_type_slug
  } else if (src?.kind === 'jar') {
    body.input_kind = 'put_up'
    body.preservation_log_id = src.hit.preservation_log_id
    if (label) body.label = label
    if (src.hit.stock_mode === 'weighed') {
      if (qty == null) return { error: LINE_ERRORS.weighed, field: 'qty' }
      if (!isMassUnit(draft.unit)) return { error: LINE_ERRORS.weighedUnit, field: 'unit' }
    } else {
      const n = Number(String(draft.countDrawn ?? '1').trim() || '1')
      if (!Number.isInteger(n) || n < 1) return { error: LINE_ERRORS.count, field: 'count' }
      body.count_drawn = n
    }
  } else if (src?.kind === 'pantry') {
    body.input_kind = 'pantry'
    body.pantry_item_id = src.hit.pantry_item_id
    if (label) body.label = label
    if (src.hit.crop_type_slug) body.crop_type_slug = src.hit.crop_type_slug
  } else if (src?.kind === 'catalog') {
    if (!label) return { error: LINE_ERRORS.name, field: 'name' }
    body.input_kind = 'other'
    body.label = label
    if (src.hit.crop_type_slug) body.crop_type_slug = src.hit.crop_type_slug
  } else {
    if (!label) return { error: LINE_ERRORS.name, field: 'name' }
    body.input_kind = 'other'
    body.label = label
    if (crop && !draft.role) body.crop_type_slug = crop
  }
  if (qty != null) { body.qty = qtyText.replace(',', '.'); body.qty_unit = draft.unit }
  if (draft.role === 'water' && (!src || src.kind == null)) body.role = 'water'
  if (!body.role) {
    if (draft.form && KITCHEN_FORMS.includes(draft.form)) body.form = draft.form
    const r = parseRating(draft.rating)
    if (r?.error) return { error: r.error, field: 'rating' }
    if (r) { body.shu_rating_low = r.low; body.shu_rating_high = r.high }
  }
  const brand = textOrNull(draft.brand); if (brand) body.brand = brand.slice(0, 120)
  const from = textOrNull(draft.sourceLabel); if (from) body.source_label = from
  const note = textOrNull(draft.note); if (note) body.note = note
  if (ordinal != null) body.ordinal = ordinal
  return { body }
}

// "Added · Water 800 ml" — the one announcement after an add (role=status).
export function addedWords(body) {
  if (!body) return ''
  const amount = body.qty != null ? ` ${trimNum(body.qty)} ${body.qty_unit}` : (body.count_drawn ? ` · ${body.count_drawn} used` : '')
  return `Added · ${body.label ?? 'it'}${amount}`
}

// Listed heat is offered when a form is set or the line has no variety rating to fall back on
// (06 §4 item 3). A typed line never has a variety; a planting or a jar might.
export function offerListedHeat(draft) {
  if (!draft) return false
  if (draft.role) return false
  if (draft.form) return true
  const src = draft.source
  // A crop/variety hit or a pantry item is a typed-kind line on the server: no variety rating reaches it.
  return !src || src.kind === 'catalog' || src.kind === 'pantry' || !(src.hit?.variety_id)
}

// The fields a line PATCH may carry (contract-F §2.2 allowlist), and the changed subset of a sheet's
// values against what was stored — the only keys a Save sends, and the values Undo sends back.
export const LINE_PATCH_KEYS = Object.freeze([
  'label', 'qty', 'qty_unit', 'form', 'brand', 'source_label', 'note', 'shu_rating_low', 'shu_rating_high',
  'role', 'salt_pct', 'salt_base', 'base_g', 'salt_method', 'base_from', 'ordinal',
])
function same(a, b) {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  const na = Number(a); const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb
  return String(a) === String(b)
}
export function linePatch(stored, next) {
  const patch = {}
  const undo = {}
  for (const k of LINE_PATCH_KEYS) {
    if (!(k in next)) continue
    if (!same(stored?.[k] ?? null, next[k] ?? null)) { patch[k] = next[k] ?? null; undo[k] = stored?.[k] ?? null }
  }
  // The amount travels as a pair both ways (the route refuses half of it).
  for (const [a, b] of [['qty', 'qty_unit']]) {
    if (a in patch || b in patch) {
      patch[a] = next[a] ?? null; patch[b] = next[b] ?? null
      undo[a] = stored?.[a] ?? null; undo[b] = stored?.[b] ?? null
    }
  }
  return { patch, undo, changed: Object.keys(patch).length > 0 }
}
