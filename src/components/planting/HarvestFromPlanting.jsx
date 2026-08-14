// HarvestFromPlanting — V4-HARVESTQTY-001. "How much has actually come off THIS planting."
// Sibling of PutUpFromPlanting: same {planting, fetch} contract, same self-fetch posture. It reads
// GET /api/events/harvest-summary?plant_id=<id> rather than widening GET /api/plants/:id — the
// shared planting payload is on every planting surface and is not worth the blast radius.
//
// All aggregation lives in src/lib/harvestSummary.js (pure, clock-free). This file only renders.
// The server supplies et_today so no client clock or timezone guess enters the computation.
//
// READ-ONLY. Logging a harvest lives on QuickActions / the event flow; duplicating it here would
// mean two places to keep in step with the harvest validators.
import React, { useState, useEffect, useMemo } from 'react'
import { P } from '../../lib/constants.js'
import { formatDate } from '../../lib/format.js'
import { summarizeHarvests, formatEntries, cropNoun, harvestWindow, etDay } from '../../lib/harvestSummary.js'
// growYear.js imports etDay FROM harvestSummary.js, so this file is the LEAF that may import both.
// The reverse (harvestSummary -> growYear) would be a cycle — see growYearSlice below.
import { growYearOfDayKey, growYearSpan } from '../../lib/growYear.js'

const WINDOW_DAYS = 14

// V4-SEASONCONV-001 — the season bucket is the GROW year (Nov 1 - Oct 31), not the calendar year.
// Every other harvest surface already buckets on the grow year (Harvests.jsx, useHarvestSnapshot,
// HarvestTimeframeChips, harvestExport, and all four lambda/harvests/* modules); this table was the
// last calendar-year holdout, so a Nov or Dec pick would read as "next year" here and "this season"
// everywhere else in the app.
//
// The convergence lives in the CALLER on purpose. summarizeHarvests' existing opts.seasonStart
// override CANNOT express a grow year: it derives seasonEnd as `${seasonStart.slice(0,4)}-12-31`
// (harvestSummary.js:94), so passing '2025-11-01' yields a two-month season 2025-11-01..2025-12-31 —
// wrong end, silently, with no error. Widening that lib is out of the question here (it is shared,
// and growYear.js already imports etDay from it, so a growYear import back would close a cycle).
// Instead: pre-filter the rows to the grow-year span and reuse summarizeHarvests' OWN allTime bucket
// over that subset. Same aggregation code path, no second bucketing implementation to drift.
//
// Clock-free like the lib it wraps: `today` is the server's et_today, never new Date().
export function growYearSlice(rows, today, timeZone) {
  const growYear = growYearOfDayKey(etDay(today, timeZone))
  if (growYear == null) return { growYear: null, rows: [] }
  const { start, end } = growYearSpan(growYear) // half-open [prev Nov 1, this Nov 1)
  const keep = (r) => {
    const d = etDay(r?.event_date, timeZone)
    return d != null && d >= start && d < end
  }
  return { growYear, rows: (Array.isArray(rows) ? rows : []).filter(keep) }
}

export default function HarvestFromPlanting({ planting, fetch }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!planting?.id) return
    let cancelled = false
    setLoading(true); setFailed(false)
    Promise.resolve(fetch(`/api/events/harvest-summary?plant_id=${planting.id}`))
      .then(d => {
        if (cancelled) return
        setData(d ?? null)
        setLoading(false)
      })
      .catch(() => { if (!cancelled) { setFailed(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [planting, fetch])

  const noun = cropNoun(planting)
  const summary = useMemo(() => summarizeHarvests(data?.rows ?? [], {
    today: data?.et_today,
    windowDays: WINDOW_DAYS,
    unattributedRows: data?.unattributed ?? [],
    timeZone: data?.time_zone,
  }), [data])

  // V4-SEASONCONV-001. Deliberately NOT summary.year — that bucket is still calendar-year and is now
  // unread by any production surface. Must sit above the early returns: it is a hook.
  const season = useMemo(() => {
    const timeZone = data?.time_zone
    const today = data?.et_today
    const attributed = growYearSlice(data?.rows ?? [], today, timeZone)
    const unlinked = growYearSlice(data?.unattributed ?? [], today, timeZone)
    return {
      growYear: attributed.growYear,
      bucket: summarizeHarvests(attributed.rows, {
        today,
        windowDays: WINDOW_DAYS,
        unattributedRows: unlinked.rows,
        timeZone,
      }).allTime,
    }
  }, [data])

  if (failed) {
    return <div style={{ padding: '8px 0', color: P.light, fontSize: '0.85rem' }}>
      Couldn&rsquo;t load harvests from this planting.
    </div>
  }
  if (loading) {
    return <div style={{ padding: '8px 0', color: P.light, fontSize: '0.875rem' }}>Loading&hellip;</div>
  }

  if (!summary.hasAny) {
    const orphans = summary.allTime.unattributed
    return (
      <div>
        <div style={{ fontSize: '0.875rem', color: P.mid }}>
          Nothing harvested from this planting yet.
        </div>
        {orphans > 0 && <UnlinkedNote n={orphans} />}
      </div>
    )
  }

  // `window_` (trailing underscore) — `window` is the global; shadowing it inside a component is a
  // footgun waiting for the next person who reaches for window.matchMedia in this file.
  const window_ = harvestWindow(summary)
  // "2026 season" = the season ENDING Oct 2026 (growYear.js:3-4), matching harvestExport.js:28 and
  // the Harvests page chips. Renaming alongside the math is not cosmetic: leaving "This year (2026)"
  // over a Nov-1-based bucket would ship a mislabelled number the moment the two diverge.
  const seasonLabel = season.growYear ? `${season.growYear} season` : 'This season'
  const rows = [
    { key: 'recent', label: `Last ${WINDOW_DAYS} days`, b: summary.recent },
    { key: 'year', label: seasonLabel, b: season.bucket },
    { key: 'all', label: 'All time', b: summary.allTime },
  ]

  return (
    <div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <caption style={{ captionSide: 'top', textAlign: 'left', fontSize: '0.78rem', color: P.light, paddingBottom: 6 }}>
          Harvested from this planting
        </caption>
        <tbody>
          {rows.map(({ key, label, b }) => (
            <tr key={key} style={{ borderTop: key === 'recent' ? 'none' : `1px solid ${P.cream}` }}>
              <th scope="row" style={{ textAlign: 'left', fontWeight: 500, fontSize: '0.8rem',
                color: P.mid, padding: '7px 10px 7px 0', whiteSpace: 'nowrap' }}>
                {label}
              </th>
              <td style={{ textAlign: 'right', fontSize: '0.9rem', fontWeight: 600, color: P.dark, padding: '7px 0' }}>
                {formatEntries(b.entries, noun)}
                {b.events > 0 && (
                  <span style={{ fontWeight: 400, color: P.light, fontSize: '0.78rem' }}>
                    {` · ${b.events} ${b.events === 1 ? 'pick' : 'picks'}`}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {summary.lastHarvestDate && (
        <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 8 }}>
          Last picked {formatDate(summary.lastHarvestDate)}
        </div>
      )}
      {/* Observed harvest window. Descriptive, never predictive — see harvestWindow() for why a
          predicted first-pick date was measured and dropped. Hidden for a single-day history,
          which the "Last picked" line above already states. */}
      {window_?.isSpan && (
        <div data-testid="harvest-window" style={{ fontSize: '0.78rem', color: P.light, marginTop: 2 }}>
          {`Picking over ${window_.days} days · ${formatDate(window_.first)} – ${formatDate(window_.last)}`}
        </div>
      )}
      {summary.allTime.unattributed > 0 && <UnlinkedNote n={summary.allTime.unattributed} />}
    </div>
  )
}

// Unattributed harvests are shown, never silently dropped: a figure that reads low with no
// explanation is worse than a figure with a visible caveat.
function UnlinkedNote({ n }) {
  return (
    <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 6 }}>
      {`+${n} harvest${n === 1 ? '' : 's'} in this project not linked to a plant`}
    </div>
  )
}
