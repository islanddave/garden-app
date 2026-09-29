// src/components/putup/jarWords.js
// Put-Up release 1b (V4 §3.2, §3.6, §4.7) — THE WORDS A JAR IS DESCRIBED IN, in one place, so the
// put-up list, the Put it up sheet's preview, its completion stub and batch detail's What came out
// cannot say different things about the same row.
//
// Three families:
//   · date words   — a put-up date at its stored precision ("sometime last month", "in 2025",
//                    "sometime after Sep 1"), never an invented day (§3.6).
//   · discard words — "discard by <date> · <basis words>" and its states (§3.2). The basis words are
//                    viewer-neutral and the banned list (safe, shelf life, keeps, good, ready, done,
//                    expired, table, default, basis …) never appears in anything this file returns.
//   · size words   — a jar with no size at all is legal from 1b (the quantity pair is NULL); it reads
//                    as its container or as nothing, never as "null" or "0".
//
// PURE: no clock, no fetch. Every date in is a YYYY-MM-DD (or anything ymd() reads) and is parsed
// from its parts — `new Date('2026-08-13')` is UTC and lands on the 12th west of Greenwich.
import { describeApprox } from '../../lib/putUpSession.js'

// Mirrors lambda/preservation/jarRules.js VALID_METHODS (parity-tested). Lower case: these are read
// inside a sentence ("general figure: hot sauce, fridge"), never as a heading.
export const METHOD_WORDS = Object.freeze({
  whole_freeze: 'whole freeze', blanch_freeze: 'blanch & freeze', roast_freeze: 'roast & freeze',
  dehydrate: 'dehydrated', powder: 'powder', passata: 'passata / sauce', pesto: 'pesto',
  hot_sauce: 'hot sauce', can_water_bath: 'water-bath canned', can_pressure: 'pressure canned',
  jam_preserve: 'jam / preserve', candy: 'candied', quick_pickle: 'quick pickle', ferment: 'ferment',
  ferment_mash: 'fermenting mash', cure_store: 'cure & store', cold_store: 'cold store',
  purchased_preserved: 'bought preserved', other: 'other',
})

// Mirrors lambda/storage-location VALID_KINDS.
export const KIND_WORDS = Object.freeze({
  deep_freezer: 'deep freezer', fridge_freezer: 'fridge freezer', fridge: 'fridge', pantry: 'pantry shelf',
  cold_storage: 'cellar', other: 'other place',
})

// Cured and cellared produce keep today's words: a quality span, "use by", not a discard date (§2.1).
export const USE_BY_METHODS = new Set(['cure_store', 'cold_store'])

// The precisions that are an ESTIMATE of the put-up date. A derived date from one of these starts at
// the earliest the estimate allows (§3.6) and so renders "around".
export const ESTIMATED_PRECISIONS = new Set(['week', 'month', 'season', 'year', 'after'])

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December']

export function parseYmd(v) {
  if (v == null || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate())
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v))
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

export function toYmd(d) {
  if (!d) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// "Oct 8" in the current year, "Oct 8, 2025" otherwise — the label a cook writes on a lid.
export function shortDay(v, now = new Date()) {
  const d = parseYmd(v)
  if (!d) return ''
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`
}

// THE PUT-UP DATE AT ITS PRECISION. A row written before 1b has a NULL precision and renders exactly
// as it always did (describeApprox over the shipped preserved_at_approx flag, §3.6 last bullet).
export function putUpDateWords(date, precision, { approx = false, now = new Date() } = {}) {
  const d = parseYmd(date)
  if (precision === 'unknown') return 'not sure'
  if (!d) return ''
  switch (precision) {
    case 'month':
      return `sometime in ${MONTHS_LONG[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`}`
    case 'season': {
      // "2–3 months ago" stores the first of its two months.
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1)
      const y = next.getFullYear() === now.getFullYear() ? '' : ` ${next.getFullYear()}`
      return `sometime in ${MONTHS[d.getMonth()]}–${MONTHS[next.getMonth()]}${y}`
    }
    case 'year':
      return `in ${d.getFullYear()}`
    case 'after':
      return `sometime after ${shortDay(d, now)}`
    case 'week':
      return `the week of ${shortDay(d, now)}`
    case 'exact': case 'hour': case 'day':
      return shortDay(d, now)
    default:
      return describeApprox(shortDay(d, now), approx === true)
  }
}

// §3.2 — the words for where a discard date came from. `method`/`kind` only matter for the general
// figure; an unknown one is left out rather than printed as a raw enum.
export function basisWords(basis, { method, kind, recipeName } = {}) {
  switch (basis) {
    case 'typed': return 'set by hand'
    case 'recipe': return recipeName ? `from the recipe: ${recipeName}` : 'from the recipe'
    case 'house': return 'house estimate'
    case 'none': return 'no date — check it before using'
    case 'table': {
      const parts = [METHOD_WORDS[method], KIND_WORDS[kind]].filter(Boolean)
      return parts.length ? `general figure: ${parts.join(', ')}` : 'general figure'
    }
    default: return null
  }
}

// The chip, stated once (§3.2). `status` is the server's use_by_status ('use_soon' | 'past_use_by' |
// anything else). Returns null when there is nothing to say (a pre-1b row with neither a date nor a
// basis keeps today's silence).
export function discardWords({ date, basis, method, kind, status, estimated = false, recipeName, now = new Date() }) {
  const words = basisWords(basis, { method, kind, recipeName })
  if (!date) {
    if (basis === 'typed') return 'no date · set by hand'
    if (basis === 'none') return words
    return null
  }
  const day = shortDay(date, now)
  const shown = estimated && basis !== 'typed' ? `around ${day}` : day
  const useBy = USE_BY_METHODS.has(method)
  let head
  if (status === 'past_use_by') head = useBy ? `use-by passed ${shown}` : `discard date passed ${shown}`
  else head = useBy ? `use by ${shown}` : `discard by ${shown}`
  const tail = [words, status === 'use_soon' ? 'soon' : null].filter(Boolean)
  return [head, ...tail].join(' · ')
}

// ── Size words — contract-F amendment A3: QUANTITY IS THE TOTAL, everywhere ─────────────────────
// preservation_log.quantity_value is the jar row's TOTAL contents (v4-putup-001: "package_count = #
// of containers, distinct from quantity_value = total"; 1b's Put it up writes count × size). So a bare
// quantity is never drawn as "N × Q" — that reads as per-container and would triple the zucchini's
// 2.5 qt. With more than one container it reads "3 containers · 2.5 qt in all"; with one, "2.5 qt".
// A container label that SAYS its own size ("8 oz woozy", "pint") is the per-container word, so it
// keeps "2 × 8 oz woozy" and the total is not repeated beside it. A label with no size of its own
// ("bag") keeps its count and still says the total when there is one.
const SIZED_CONTAINERS = new Set(['5 oz woozy', '8 oz woozy', '4 oz jar', 'half-pint', 'pint', 'quart'])
export function labelCarriesSize(label) {
  const l = String(label ?? '').trim().toLowerCase()
  return !!l && (SIZED_CONTAINERS.has(l) || /\d/.test(l))
}

function hasQuantity({ quantity_value, quantity_unit } = {}) {
  return quantity_value != null && quantity_value !== '' && Number(quantity_value) !== 0 && !!quantity_unit
}

// A quantity as it is said. The column is numeric(10,2), so the driver hands back "2.50" and "2.00";
// they are said "2.5" and "2". Anything that is not a plain decimal is returned as it came.
export function qtyText(v) {
  if (v == null || v === '') return ''
  const s = String(v).trim()
  if (!/^\d+(\.\d+)?$/.test(s)) return s
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

// THE TOTAL OF A WALK ITEM: "How big is each?" × how many, as the TOTAL the column holds (A3). Decimal
// arithmetic on the typed digits, never floats — 3 × 0.83 is 2.49, not 2.4899999999999998 — rounded
// half-up to the column's two places. `each` is the typed text; `count` a whole number ≥ 1. Returns the
// total as text ("2.49", "2", "7.5"), or null when either half is not a plain positive number.
export function totalOfEach(each, count) {
  const m = /^\s*(\d*)(?:\.(\d*))?\s*$/.exec(String(each ?? ''))
  const n = Number(count)
  if (!m || (!m[1] && !m[2]) || !Number.isInteger(n) || n < 1) return null
  const frac = m[2] ?? ''
  let v = BigInt(`${m[1] || '0'}${frac}`) * BigInt(n)          // exact, in units of 10^-frac.length
  if (frac.length > 2) {
    const d = 10n ** BigInt(frac.length - 2)
    v = (v + d / 2n) / d
  } else {
    v *= 10n ** BigInt(2 - frac.length)
  }
  if (v <= 0n) return null
  return qtyText(`${v / 100n}.${String(v % 100n).padStart(2, '0')}`)
}

// The size of one jar row as a headline fragment (the count is said elsewhere on the row). NULL pair
// and no container → nothing, never "null".
export function sizeWords(rec = {}) {
  const { quantity_value, quantity_unit, container_label, package_count } = rec
  if (container_label) return String(container_label)
  if (!hasQuantity(rec)) return ''
  const n = Number(package_count)
  const q = `${qtyText(quantity_value)} ${quantity_unit}`
  return Number.isFinite(n) && n > 1 ? `${q} in all` : q
}

// The count and the size together: "2 × 8 oz woozy" · "3 containers · 2.5 qt in all" · "2.5 qt" ·
// "3 × bag · 2 lb in all" · "1 container". Count first, always a number, never a word.
export function countedSize(count, rec = {}) {
  const n = Number(count)
  const c = Number.isFinite(n) && n >= 1 ? n : 1
  const qty = hasQuantity(rec) ? `${qtyText(rec.quantity_value)} ${rec.quantity_unit}` : null
  const label = rec.container_label ? String(rec.container_label) : null
  if (label) {
    if (labelCarriesSize(label) || !qty) return `${c} × ${label}`
    return `${c} × ${label} · ${qty}${c > 1 ? ' in all' : ''}`
  }
  if (qty) return c > 1 ? `${c} containers · ${qty} in all` : qty
  return c === 1 ? '1 container' : `${c} containers`
}
