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
import { summarizeHarvests, formatEntries, cropNoun, harvestWindow } from '../../lib/harvestSummary.js'

const WINDOW_DAYS = 14

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
  const seasonYear = String(summary.seasonStart ?? '').slice(0, 4)
  const rows = [
    { key: 'recent', label: `Last ${WINDOW_DAYS} days`, b: summary.recent },
    { key: 'year', label: seasonYear ? `This year (${seasonYear})` : 'This year', b: summary.year },
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
