// src/components/putup/fermentMath.js
// Put-Up release F — the ferment arithmetic and vocabulary the batch surface SHOWS before anything is
// written: the salt helper's live line ("3.5% of veg + water (448 g) → 15.7 g"), what each salt line
// says it was (aimed vs actual), the "About ___ in it" placeholder, and the heat estimate's words.
//
// CLIENT MIRRORS, bound by src/__tests__/fermentMathParity.test.js to the Lambda's own modules
// (lambda/preservation/kitchenBatch.js MASS_G / WATER_G / KITCHEN_UNITS / the F vocabularies, and
// saltMath.js) the moment they are on this branch — and to the golden table (06 §5.3) now, which both
// lanes pin independently. The server stores its own facts; nothing here is trusted by a write. The
// heat estimate itself is NEVER computed here: it is GET /:id/shu-estimate's (contract-F §2.5), and
// this file only words its answer.
//
// PURE: no React, no clock, no fetch.

// ── units (contract-F conventions; 06 §1.4 and its water-conversion rule) ───────────────────────────────────────────────────
export const KITCHEN_UNITS = Object.freeze([
  'g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'fl oz', 'cup', 'pint', 'qt', 'gal',
  'count', 'clove', 'head', 'bunch', 'pinch', 'peck', 'bushel', 'half-bushel', 'flat', 'jar', 'bag', 'other',
])
// Grams per unit — the one mass table.
export const MASS_G = Object.freeze({ g: 1, kg: 1000, oz: 28.3495, lb: 453.592 })
// Grams per unit for a role='water' line ONLY (1 g/ml). Every other volume is "no weight".
export const WATER_G = Object.freeze({
  ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, 'fl oz': 29.5735, cup: 236.588, pint: 473.176,
  qt: 946.353, gal: 3785.41,
})
export const isMassUnit = (u) => Object.prototype.hasOwnProperty.call(MASS_G, u)
export function gramsOf(qty, unit, { water = false } = {}) {
  if (qty == null || qty === '' || unit == null) return null
  const n = Number(qty)
  if (!Number.isFinite(n)) return null
  if (isMassUnit(unit)) return n * MASS_G[unit]
  if (water && Object.prototype.hasOwnProperty.call(WATER_G, unit)) return n * WATER_G[unit]
  return null
}

// ── the F vocabularies (chk_kbi_form, chk_kbi_salt_method, chk_kbi_salt_base, chk_ksl_acts) ─────────
export const KITCHEN_FORMS = Object.freeze(['fresh', 'frozen', 'dried', 'cooked'])
export const FORM_LABELS = Object.freeze({ fresh: 'Fresh', frozen: 'Frozen', dried: 'Dried', cooked: 'Cooked' })
export const SALT_METHODS = Object.freeze(['dry', 'brine', 'rinsed'])
export const SALT_METHOD_LABELS = Object.freeze({ dry: 'Dry', brine: 'Brine', rinsed: 'Salted then rinsed' })
// The chips, in the order the design gives them (Veg only · Veg + water · Water only). 'peppers' is a
// 1b-era word the CHECK still admits and no F writer writes; it is only ever READ back (06 §3.1).
export const SALT_BASES = Object.freeze(['produce', 'all', 'water'])
export const SALT_BASE_LABELS = Object.freeze({ produce: 'Veg only', all: 'Veg + water', water: 'Water only' })
export const SALT_BASE_WORDS = Object.freeze({ produce: 'veg', all: 'veg + water', water: 'water', peppers: 'the peppers' })
export const ACTS = Object.freeze(['topped_up', 'pushed_under', 'skimmed'])
export const ACT_LABELS = Object.freeze({
  topped_up: 'Topped up brine', pushed_under: 'Pushed it back under', skimmed: 'Skimmed the top',
})
// Dried chilies count ×7 (low) to ×10 (high) the FRESH rating (Dave's card rule; 17:1x — a typed
// rating is always the fresh pepper's).
export const DRIED_FACTOR = Object.freeze({ low: 7, high: 10 })

// ── the salt helper (06, the salt sections) ──────────────────────────────────────────────────────────────────
// produce = every live weighed line with no role and no put_up_stage_id (spices and sugar included);
// water = the role='water' lines at 1 g/ml; all = both. Salt lines and sitting lines are in no base. A
// line in no mass unit is "no weight" — named, never guessed.
export function saltBase(lines, base) {
  let produce = 0
  let water = 0
  const noWeight = []
  const leftOut = []
  for (const l of lines ?? []) {
    if (!l || l.role === 'salt' || l.put_up_stage_id != null) continue
    const isWater = l.role === 'water'
    const g = gramsOf(l.qty, l.qty_unit, { water: isWater })
    if (g == null) { noWeight.push(l.label); continue }
    if (isWater) {
      if (base === 'produce') leftOut.push(l.label); else water += g
    } else if (base === 'water') {
      leftOut.push(l.label)
    } else {
      produce += g
    }
  }
  const grams = base === 'produce' ? produce : base === 'water' ? water : produce + water
  return { grams, no_weight: noWeight, left_out: leftOut }
}
export const saltGrams = (pct, baseG) => (Number(pct) / 100) * Number(baseG)
export const actualPct = (qtyG, baseG) => (Number(qtyG) / Number(baseG)) * 100
// One decimal, half-up, as shown ("15.7 g", "3.0%").
export const oneDecimal = (x) => (Math.floor(Number(x) * 10 + 0.5) / 10).toFixed(1)
// Whole grams with thousands separators, as a base is said ("1,870 g").
export const wholeGrams = (x) => Math.round(Number(x)).toLocaleString('en-US')
// A typed percent: "3.5", "3.5%", " 3,5 " → 3.5; anything else → null. 0 < p ≤ 100 (chk_kbi_salt_pct_range).
export function parsePct(v) {
  const s = String(v ?? '').trim().replace('%', '').replace(',', '.').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null
}
export function parseGrams(v) {
  const s = String(v ?? '').trim().replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

// "3.5% of veg + water (448 g) → 15.7 g salt". The live line under the % field.
export function saltLiveWords({ pct, base, baseG }) {
  const g = saltGrams(pct, baseG)
  return `${pct}% of ${SALT_BASE_WORDS[base] ?? base} (${wholeGrams(baseG)} g) → ${oneDecimal(g)} g salt`
}

// "left out: water 250 ml · no weight: onion, garlic" — what the base did not count, named.
export function saltAsideWords({ left_out: leftOut = [], no_weight: noWeight = [] } = {}) {
  const parts = []
  if (leftOut.length) parts.push(`left out: ${leftOut.join(', ')}`)
  if (noWeight.length) parts.push(`no weight: ${noWeight.join(', ')}`)
  return parts.join(' · ')
}

// "3.500" (numeric off the wire) → "3.5"; "10.000" → "10".
const trimPct = (p) => String(Math.round(Number(p) * 1000) / 1000)

// What a stored salt line says it was (06 §3.2, FS minor). Every salt line shows BOTH the aimed % and
// the actual, re-derived from its grams — so editing the grams later keeps the aim and moves the
// actual. A rinsed soak is never presented as the ferment's salt %. A grams-only line is its grams.
export function saltLineWords(line) {
  if (!line) return ''
  const qtyG = gramsOf(line.qty, line.qty_unit)
  const put = qtyG != null ? `${oneDecimal(qtyG)} g` : (line.qty != null ? `${line.qty} ${line.qty_unit ?? ''}`.trim() : null)
  const method = line.salt_method ? SALT_METHOD_LABELS[line.salt_method] ?? null : null
  if (line.salt_method === 'rinsed') {
    const soak = line.base_g != null ? `${trimPct(line.salt_pct)}% of ${wholeGrams(line.base_g)} g soak water` : null
    return [method, soak, put ? `put in ${put}` : null, "soaked, then rinsed off, so not what's in the jar"]
      .filter(Boolean).join(' · ')
  }
  if (line.salt_pct == null || line.base_g == null || qtyG == null) {
    return [method, put].filter(Boolean).join(' · ')
  }
  // The golden table's words exactly (06 §5.3 "Petri card"): "aimed 3.5% · put in 13.5 g = 3.0% of 448 g".
  const of = `${wholeGrams(line.base_g)} g`
  return [method, `aimed ${trimPct(line.salt_pct)}%`, `put in ${put} = ${oneDecimal(actualPct(qtyG, line.base_g))}% of ${of}`]
    .filter(Boolean).join(' · ')
}

// ── "About ___ in it" (06 §2.8): the placeholder is the weighed sum of what went in ─────────────────
// Live, not salt, not a sitting line, in a mass unit OR a water line. A typed "About" is never replaced.
export function aboutPlaceholderGrams(lines) {
  let sum = 0
  let any = false
  for (const l of lines ?? []) {
    if (!l || l.role === 'salt' || l.put_up_stage_id != null) continue
    const g = gramsOf(l.qty, l.qty_unit, { water: l.role === 'water' })
    if (g != null) { sum += g; any = true }
  }
  return any ? sum : null
}

// ── heat words (06 §2.6.5) ──────────────────────────────────────────────────────────────────────────
// Two significant figures: under 1,000 an integer (950); otherwise k with one decimal where needed
// (3.0k, 16k), and M past a million. "est." is always said, in the same ink as the number.
function twoSig(n) {
  if (n === 0) return 0
  const mag = Math.floor(Math.log10(Math.abs(n)))
  const f = 10 ** (mag - 1)
  return Math.round(n / f) * f
}
function kPart(n) {
  if (n >= 1e6) {
    const m = twoSig(n) / 1e6
    return { text: m < 10 ? m.toFixed(1) : String(Math.round(m)), unit: 'M' }
  }
  if (n >= 1000) {
    const k = twoSig(n) / 1000
    return { text: k < 10 ? k.toFixed(1) : String(Math.round(k)), unit: 'k' }
  }
  return { text: String(Math.round(twoSig(n))), unit: '' }
}
export function formatShu(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return null
  const p = kPart(v)
  return `${p.text}${p.unit}`
}
// "est. 950–3.0k SHU", "est. 1.7–5.3k SHU", "est. 16–23k SHU", "est. 3.0k SHU". When both ends share
// a unit it is said once, at the end. null when there is no figure — never "0" from absence.
export function shuRangeWords(low, high) {
  if (low == null || low === '') return null
  const lo = Number(low)
  const hi = high == null || high === '' ? lo : Number(high)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo) return null
  const a = kPart(lo)
  const b = kPart(hi)
  if (a.text === b.text && a.unit === b.unit) return `est. ${a.text}${a.unit} SHU`
  if (a.unit === b.unit) return `est. ${a.text}–${b.text}${b.unit} SHU`
  return `est. ${a.text}${a.unit}–${b.text}${b.unit} SHU`
}

// "Listed heat" as typed on a line: "2500", "2,500–8,000", "2500-8000", "30k" → { low, high } whole
// SHU; blank → null (no rating); anything else → { error }. 0 is a rating ("counted as 0").
export function parseRating(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/shu/g, '').replace(/,/g, '').replace(/\s+/g, '')
  if (!s) return null
  const one = (t) => {
    const m = /^(\d+(?:\.\d+)?)(k)?$/.exec(t)
    if (!m) return null
    const n = Number(m[1]) * (m[2] ? 1000 : 1)
    return Number.isFinite(n) ? Math.round(n) : null
  }
  const parts = s.split(/[–—-]|to/).filter(Boolean)
  if (parts.length === 1) {
    const n = one(parts[0])
    return n == null ? { error: 'Type the heat as a number, like 2500 or 2500–8000.' } : { low: n, high: n }
  }
  if (parts.length === 2) {
    const lo = one(parts[0]); const hi = one(parts[1])
    if (lo == null || hi == null) return { error: 'Type the heat as a number, like 2500 or 2500–8000.' }
    return lo <= hi ? { low: lo, high: hi } : { low: hi, high: lo }
  }
  return { error: 'Type the heat as a number, like 2500 or 2500–8000.' }
}
export function ratingWords(low, high) {
  if (low == null) return ''
  const lo = Number(low).toLocaleString('en-US')
  const hi = high == null || Number(high) === Number(low) ? null : Number(high).toLocaleString('en-US')
  return hi ? `${lo}–${hi} SHU` : `${lo} SHU`
}
