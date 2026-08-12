// harvestExport.js — V4-HARVEXPORT-001. The harvest export, as PURE text.
//
// Deliberately a dumb `(rows, opts) -> string` util beside harvestSummary.js and NOT an export
// framework (design §2c): the generalization promise ("extend past harvests") is satisfied by the
// shape of these functions, not by machinery nobody has a second caller for yet.
//
// PURE and clock-free — `generatedOn` and `currentYear` are ARGUMENTS. Every string is built from
// the SAME primitives the Harvests page renders with (unitsLine / formatEntry / fmtFirstPick /
// weightParts / groupByDay / dayLabel), because the export's entire value is that it reconciles
// with what Dave just looked at. A second formatting path here would drift on the first change.
//
// NO UNIT CONVERSION, ever. 3 cups + 2 heads is not 5 of anything, and grams are 73.5% server-
// ESTIMATED — a converted number in a spreadsheet is a fabricated measurement. Units are emitted
// natively and the weight line always carries its measured/estimated/unweighed qualifier.
import { unitsLine, formatEntry, fmtFirstPick, seasonTotalPhrase } from './harvestSummary.js'
import { formatGrams, weightParts } from './harvestWeight.js'
import { groupByDay, dayLabel } from './harvestGrouping.js'

// The server's timeframe vocabulary, in words. This is the WHOLE date-range surface: arbitrary
// from/to needs a Lambda parseTimeframe change and is deliberately deferred (design §2c) — do not
// "helpfully" add it here.
export function timeframeLabel(timeframe) {
  const t = String(timeframe ?? '')
  if (t === '') return 'All time'
  if (t === '7d') return 'Last 7 days'
  if (t === 'month') return 'This month'
  const m = /^season:(\d{4})$/.exec(t)
  if (m) return `${m[1]} season`
  return t
}

// Line 2 of every export: what this text is scoped to. Names the crop filter explicitly rather than
// letting an omission read as "everything" — a partial export that looks total is the failure mode
// that makes an export untrustworthy.
export function scopeLine(timeframe, cropNames = []) {
  const crops = cropNames.length > 0 ? cropNames.join(', ') : 'All crops'
  return `${timeframeLabel(timeframe)} · ${crops}`
}

function header(title, timeframe, cropNames, generatedOn) {
  return [`Garden harvests — ${title}`, scopeLine(timeframe, cropNames), `Generated ${generatedOn}`, '']
}

// The weight block, in the page's own honesty phrasing. Absent `weight` (an older harvests Lambda —
// the frontend deploys ahead of it) emits NOTHING: the old response cannot tell "no weight recorded"
// apart from "this API doesn't compute weight", and only the first is safe to state.
function weightLine(weight) {
  if (!weight) return null
  const parts = weightParts(weight)
  if (parts.length === 0) return null
  const text = formatGrams(weight.grams)
  const value = text == null ? 'none derivable yet' : `${weight.estimated > 0 ? '≈ ' : ''}${text}`
  return `Total weight: ${value} (${parts.join(' · ')})`
}

/**
 * Totals mode. `aggregates` is a GET /api/harvests aggregates object, already narrowed to the
 * selected crops by the caller (the server takes a single `crop` param, so multi-select filters
 * client-side — see HarvestExportSheet).
 *
 * Variety sub-lines are NOT optional (design §2c, adjudicated): the January seed-ordering use is
 * variety-grain — "Pepper — 300 count" cannot decide which of 49 cultivars earned a reorder.
 * First-pick lines answer "did it produce before frost". Unquantified counts are included so the
 * export never silently under-reports what was picked.
 */
export function buildTotalsExport({ aggregates, timeframe = '', cropNames = [], generatedOn, currentYear = null, cropFilterActive = false, projectsHidden = false } = {}) {
  const crops = aggregates?.crops ?? []
  const other = aggregates?.other ?? []
  const firstPick = aggregates?.first_pick ?? []
  const lines = header('Totals', timeframe, cropNames, generatedOn)
  if (crops.length === 0 && other.length === 0) {
    lines.push('No harvests match.')
    return lines.join('\n')
  }
  for (const c of crops) {
    const totals = unitsLine(c.units, c.crop_name)
    const segs = [totals, c.unquantified > 0 ? `+${c.unquantified} unrecorded` : ''].filter(Boolean)
    lines.push(`${c.crop_name} — ${segs.join(' · ') || 'no amount recorded'}`)
    const varieties = Array.isArray(c.varieties) ? c.varieties : []
    // Same rule the page uses: a single unnamed variety is just the crop total again, so it would
    // add a line that repeats the one above it.
    const showVarieties = varieties.length > 1 || (varieties.length === 1 && !!varieties[0].variety_name)
    if (showVarieties) {
      for (const v of varieties) {
        const vl = unitsLine(v.units, c.crop_name) || (v.unquantified > 0 ? `+${v.unquantified} unrecorded` : '')
        lines.push(`  ${v.variety_name || 'Unspecified'} — ${vl || 'no amount recorded'}`)
      }
    }
    for (const f of firstPick.filter((p) => p.crop_type_slug === c.crop_type_slug)) {
      lines.push(`  First pick ${fmtFirstPick(f.first_pick_date, currentYear)}${f.planting_name ? ` · ${f.planting_name}` : ''}`)
    }
  }
  const wl = weightLine(aggregates?.weight)
  if (wl) { lines.push('', wl) }
  // Unassigned rides ONLY an unfiltered export: under a crop filter these slug-less events cannot be
  // said to belong to the selected crops, and including them would be an unattributable addition to
  // a filtered total. The sheet states this rule in copy so the omission is never a silent one.
  if (other.length > 0 && !cropFilterActive) {
    lines.push('', 'Unassigned')
    for (const o of other) {
      const ol = unitsLine(o.units, null) || (o.unquantified > 0 ? `+${o.unquantified} unrecorded` : '')
      lines.push(`  ${projectsHidden ? 'Unattributed' : (o.project_name || 'A project')} — ${ol || 'no amount recorded'}`)
    }
  }
  return lines.join('\n')
}

/** Log mode: day-grouped lines, in the feed's own order and labels. */
export function buildLogExport({ entries = [], timeframe = '', cropNames = [], generatedOn, currentYear = null } = {}) {
  const lines = header('Log', timeframe, cropNames, generatedOn)
  if (entries.length === 0) {
    lines.push('No harvests match.')
    return lines.join('\n')
  }
  const sections = groupByDay(entries)
  sections.forEach((sec, i) => {
    if (i > 0) lines.push('')
    lines.push(dayLabel(sec.day_key, currentYear))
    for (const e of sec.entries) {
      const name = e.variety_name || e.crop_name || e.planting_name || 'Harvest'
      const countNoun = e.crop_name || e.variety_name || null
      const hasQty = e.harvest_log_id != null && e.quantity != null
      const qty = hasQty ? formatEntry({ quantity: e.quantity, unit: e.unit }, countNoun) : 'no amount recorded'
      lines.push(`  ${name} — ${qty}`)
    }
  })
  return lines.join('\n')
}

/**
 * ONE narrated header line, prepended for SHARE only — the shared-table framing a human recipient
 * needs. Copy stays byte-plain (design §2c): a notes app or a spreadsheet wants the data, not a
 * sentence about it.
 *
 * Built on `seasonTotalPhrase` (the idle primitive named in the design). `leadFacts` is deliberately
 * NOT used: it takes a harvestPost BATCH (one evening's logging session, clustered on created_at)
 * and computes "picked tonight" facts, which are false of a season-scoped export. Reaching for it
 * here would produce a confidently wrong sentence — exactly the class this codebase keeps writing
 * honesty rules about.
 */
export function narratedHeader({ mode, aggregates, entries = [], timeframe = '' } = {}) {
  const scope = timeframeLabel(timeframe).toLowerCase()
  if (mode === 'log') {
    const n = entries.length
    return `My garden, ${scope} — ${n} harvest${n === 1 ? '' : 's'} logged:`
  }
  const crops = aggregates?.crops ?? []
  if (crops.length === 0) return `My garden, ${scope}:`
  const phrase = seasonTotalPhrase(crops[0])
  const more = crops.length - 1
  const tail = more > 0 ? ` and ${more} more crop${more === 1 ? '' : 's'}` : ''
  return phrase ? `My garden, ${scope} — ${phrase}${tail}:` : `My garden, ${scope} — ${crops.length} crop${crops.length === 1 ? '' : 's'}:`
}
