// stats-kit/format — number, date and word helpers for the Season stats page. Pure; no React.
//
// Dates in the season-stats contract are 'YYYY-MM-DD' day keys. They are handled with string math and
// Date.UTC only, never `new Date('YYYY-MM-DD')` read back in local time — that form is UTC midnight,
// the previous evening in America/New_York, and would shift every label by a day (growYear.js has the
// same rule).

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const CARE_KINDS = ['water', 'feed', 'pests', 'starts', 'upkeep', 'checkins']
export const CARE_LABEL = { water: 'Water', feed: 'Feed', pests: 'Pests', starts: 'Starts', upkeep: 'Upkeep', checkins: 'Check-ins' }

// Mirrors HEAT_BANDS in lambda/varieties/crop-derive.js (order = mildest first).
export const HEAT_BANDS = ['sweet', 'mild', 'medium', 'hot', 'very_hot', 'superhot']
export const HEAT_BAND_LABEL = { sweet: 'Sweet', mild: 'Mild', medium: 'Medium', hot: 'Hot', very_hot: 'Very hot', superhot: 'Superhot' }
// Top of each band in SHU (crop-derive.js max + 1, so a band runs [previous top, top)). Sweet is 0 only.
export const HEAT_BAND_TOP = { sweet: 0, mild: 1000, medium: 10000, hot: 50000, very_hot: 250000, superhot: Infinity }
export function heatBandOf(shu) {
  if (!isNum(shu) || shu < 0) return null
  if (shu === 0) return 'sweet'
  return HEAT_BANDS.find((b) => b !== 'sweet' && shu < HEAT_BAND_TOP[b]) ?? null
}

// 1300000 -> '1.3M', 350000 -> '350k', 2500 -> '2.5k', 200 -> '200'.
export function fmtShu(n) {
  if (!isNum(n)) return ''
  const short = (x) => String(Math.round(x * 10) / 10)
  if (n >= 1e6) return `${short(n / 1e6)}M`
  if (n >= 1e3) return `${short(n / 1e3)}k`
  return String(Math.round(n))
}

// compute.py SOURCE_GROUP buckets, in the order the bar draws them.
export const SOURCE_GROUPS = ['nursery', 'seed', 'rescued', 'gift', 'other', 'none']
export const SOURCE_GROUP_LABEL = {
  nursery: 'Nursery', seed: 'From seed', rescued: 'Rescued', gift: 'Gift', other: 'Swap, division & other', none: 'Not recorded',
}

const KIND_WORD = {
  nursery: 'nursery', seed_company: 'seed company', market: 'market', brand: 'brand on the tag', person: 'person',
  farm_stand: 'farm stand', plant_swap: 'plant swap', retail: 'store', own_garden: 'your garden',
}
// A kind the page has no word for is shown with its underscores opened up, never dropped.
export const kindWord = (kind) => (kind ? KIND_WORD[kind] ?? String(kind).replace(/_/g, ' ') : '')

export const isNum = (n) => typeof n === 'number' && Number.isFinite(n)
export const num = (n, fallback = 0) => (isNum(n) ? n : fallback)

export function fmtInt(n) {
  if (!isNum(n)) return ''
  return Math.round(n).toLocaleString('en-US')
}

export function fmtLb(n, digits = 1) {
  if (!isNum(n)) return ''
  return n.toFixed(digits)
}

export function fmtPct(share) {
  if (!isNum(share)) return ''
  return `${Math.round(share * 100)}%`
}

export const plural = (n, one, many) => (n === 1 ? one : (many ?? `${one}s`))
export const countOf = (n, one, many) => `${fmtInt(n)} ${plural(n, one, many)}`

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/

// Day number since the epoch (UTC), or null for junk. Callers branch on null; nothing downstream sees NaN.
export function dayNum(key) {
  const m = DAY_RE.exec(String(key ?? ''))
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 864e5
}

export function dayKeyOf(n) {
  const d = new Date(n * 864e5)
  return d.toISOString().slice(0, 10)
}

// 'Jul 2'
export function monthDay(key) {
  const m = DAY_RE.exec(String(key ?? ''))
  if (!m) return ''
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`
}

// First-of-month day numbers from the month holding d0 through the month holding d1.
export function monthStarts(d0, d1) {
  if (!isNum(d0) || !isNum(d1) || d1 < d0) return []
  const out = []
  const s = new Date(d0 * 864e5)
  let y = s.getUTCFullYear()
  let mo = s.getUTCMonth()
  for (;;) {
    const n = Date.UTC(y, mo, 1) / 864e5
    if (n > d1) break
    out.push({ day: n, label: MONTHS[mo] })
    mo += 1
    if (mo === 12) { mo = 0; y += 1 }
  }
  return out
}

export const cropWord = (slug) => (slug ? String(slug).replace(/_/g, ' ') : '')
export const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')

// A list read out loud: "a", "a and b", "a, b and c".
export function listWords(items) {
  const xs = items.filter(Boolean)
  if (xs.length <= 1) return xs.join('')
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}
