// V4-HARVESTQTY-001 — pure aggregation seam for the per-planting "Harvested" summary.
// SQL selects rows; ALL bucketing/conversion/formatting happens here so it is unit-testable
// without a DB and without a clock. summarizeHarvests takes `today` as an ARGUMENT — there is
// deliberately no `new Date()` anywhere in this file (a jsdom test that constructs "now"
// internally goes flaky at midnight, and the ET-vs-UTC boundary is the whole point of the
// computation). The server hands the client its ET today; tests hand it a fixture.

// Mass class ONLY. Cross-class conversion is forbidden: count/bunch/head/cup are discrete or
// volumetric and 3 cups + 2 heads is not 5 of anything. Canonical unit is grams.
const MASS_G = { g: 1, kg: 1000, lb: 453.59237, oz: 28.349523125 }

export function isMassUnit(unit) { return Object.prototype.hasOwnProperty.call(MASS_G, unit) }

function normUnit(u) {
  const s = String(u ?? '').trim().toLowerCase()
  return s === '' ? 'count' : s
}

// event_date may arrive as a bare 'YYYY-MM-DD' (already ET-normalized by the endpoint) or as a
// full timestamptz ISO string. The bare form is used verbatim; anything else is projected into
// the target zone, so 2025-12-31T23:00 ET (= 2026-01-01T04:00Z) resolves to '2025-12-31'.
export function etDay(value, timeZone = 'America/New_York') {
  if (value == null || value === '') return null
  if (value instanceof Date) return isNaN(value.getTime()) ? null : fmtZoned(value, timeZone)
  const s = String(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : fmtZoned(d, timeZone)
}

function fmtZoned(d, timeZone) {
  // en-CA yields YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

// Calendar-day arithmetic on YYYY-MM-DD via UTC anchors — no local-zone drift.
export function addDays(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

function aggregate(rows) {
  let massG = 0
  const massByUnit = new Map()
  const other = new Map()
  for (const r of rows) {
    const q = Number(r.quantity)
    if (!Number.isFinite(q) || q <= 0) continue
    const unit = normUnit(r.unit)
    if (isMassUnit(unit)) {
      const g = q * MASS_G[unit]
      massG += g
      massByUnit.set(unit, (massByUnit.get(unit) ?? 0) + g)
    } else {
      other.set(unit, (other.get(unit) ?? 0) + q)
    }
  }
  const entries = []
  if (massG > 0) {
    // Render the mass total in the DOMINANT source unit (most grams contributed); ties break on
    // unit name asc so the choice is deterministic across runs.
    let dominant = null
    for (const [u, g] of [...massByUnit.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      dominant = u; break
    }
    entries.push({ unit: dominant, quantity: massG / MASS_G[dominant], converted: massByUnit.size > 1 })
  }
  for (const [unit, quantity] of other) entries.push({ unit, quantity, converted: false })
  // Deterministic ordering: quantity desc, then unit name asc. A nondeterministic string here
  // breaks snapshots and makes the surface read differently on every render.
  entries.sort((a, b) => b.quantity - a.quantity || a.unit.localeCompare(b.unit))
  return entries
}

/**
 * rows / opts.unattributedRows: [{ quantity, unit, event_date }]
 * opts.today: 'YYYY-MM-DD' in the reporting zone (REQUIRED — no internal clock).
 * opts.windowDays: size of the "recent" window, INCLUSIVE of today (14 => today and the 13
 *   calendar days before it; a harvest dated today-13 is IN, today-14 is OUT).
 * opts.seasonStart: 'YYYY-MM-DD' calendar-YEAR start. The "this year" bucket is
 *   [seasonStart, Dec 31 of seasonStart's year] — a 23:00 ET Dec 31 pick belongs to the OLD year.
 */
export function summarizeHarvests(rows, opts = {}) {
  const { today, windowDays = 14, timeZone = 'America/New_York' } = opts
  const list = Array.isArray(rows) ? rows : []
  const unattributed = Array.isArray(opts.unattributedRows) ? opts.unattributedRows : []
  if (!today) {
    return emptySummary(windowDays)
  }
  const seasonStart = opts.seasonStart || `${String(today).slice(0, 4)}-01-01`
  const seasonEnd = `${seasonStart.slice(0, 4)}-12-31`
  const recentStart = addDays(today, -(windowDays - 1))

  const withDay = list.map(r => ({ ...r, _day: etDay(r.event_date, timeZone) })).filter(r => r._day)
  const unWithDay = unattributed.map(r => ({ ...r, _day: etDay(r.event_date, timeZone) })).filter(r => r._day)

  const inRecent = r => r._day >= recentStart && r._day <= today
  const inSeason = r => r._day >= seasonStart && r._day <= seasonEnd

  const recentRows = withDay.filter(inRecent)
  const seasonRows = withDay.filter(inSeason)

  const days = withDay.map(r => r._day).sort()

  return {
    recent: bucket(recentRows, unWithDay.filter(inRecent)),
    year: bucket(seasonRows, unWithDay.filter(inSeason)),
    allTime: bucket(withDay, unWithDay),
    firstHarvestDate: days[0] ?? null,
    lastHarvestDate: days[days.length - 1] ?? null,
    windowDays,
    recentStart,
    seasonStart,
    hasAny: withDay.length > 0,
  }
}

function bucket(rows, unattributedRows) {
  return { entries: aggregate(rows), events: rows.length, unattributed: unattributedRows.length }
}

function emptySummary(windowDays) {
  const empty = { entries: [], events: 0, unattributed: 0 }
  return {
    recent: empty, year: empty, allTime: empty,
    firstHarvestDate: null, lastHarvestDate: null,
    windowDays, recentStart: null, seasonStart: null, hasAny: false,
  }
}

// numeric(N,3) serializes as "3.000" — never print it raw. Up to 2dp, trailing zeros trimmed.
export function fmtQuantity(n) {
  const num = Number(n)
  if (!Number.isFinite(num)) return String(n ?? '')
  return String(Math.round(num * 100) / 100)
}

const PLURAL_UNITS = { cup: 'cups', bunch: 'bunches', head: 'heads' }

function pluralize(noun, n) {
  if (n === 1) return noun
  if (/(s|x|z|ch|sh)$/i.test(noun)) return noun + 'es'
  if (/[^aeiou]y$/i.test(noun)) return noun.slice(0, -1) + 'ies'
  if (/[^aeiou]o$/i.test(noun)) return noun + 'es'
  return noun + 's'
}

// 'count' is a SCHEMA token, never user-facing. It renders as the crop noun when one is known
// ("3 tomatoes") and as a bare number otherwise ("3") — never as "3 count".
export function unitLabel(unit, quantity, countNoun) {
  if (unit === 'count') return countNoun ? pluralize(String(countNoun), quantity) : ''
  if (isMassUnit(unit)) return unit
  return PLURAL_UNITS[unit] ? (quantity === 1 ? unit : PLURAL_UNITS[unit]) : unit
}

export function formatEntry(entry, countNoun) {
  const q = fmtQuantity(entry.quantity)
  const label = unitLabel(entry.unit, Number(entry.quantity), countNoun)
  return label ? `${q} ${label}` : q
}

export function formatEntries(entries, countNoun) {
  if (!entries || entries.length === 0) return '—'
  return entries.map(e => formatEntry(e, countNoun)).join(' · ')
}

// crop_type_slug ('sweet-pepper') → a display noun ('sweet pepper') for the count-unit label.
export function cropNoun(planting) {
  const slug = planting?.variety_ref?.crop_type_slug
  if (!slug) return null
  return String(slug).replace(/[-_]+/g, ' ').trim() || null
}
