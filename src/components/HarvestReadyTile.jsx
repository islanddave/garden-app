// W2 dashboard tile — "Harvest ready" surface (V1.2a-2 Session 3).
// Lists projects with status 'harvesting' as tappable rows that deep-link to
// the harvest log form. Includes an ambient time-blindness severity dot on the
// "observed N days ago" line — an ADHD-friendly cue that a harvesting project
// hasn't been looked at recently.

import React from 'react'
import { useNavigate } from 'react-router-dom'
import { P } from '../lib/constants.js'

// "Observed N days ago" copy from days_since_obs (null => not yet observed).
function observedLabel(daysSinceObs) {
  if (daysSinceObs == null) return 'Not yet observed'
  if (daysSinceObs === 0) return 'Observed today'
  if (daysSinceObs === 1) return 'Observed yesterday'
  return `Observed ${daysSinceObs} days ago`
}

// Ambient time-blindness severity dot:
//   <= 2 days (or null) -> no dot (neutral, recently seen)
//   3-6 days            -> muted-gold dot (drifting)
//   >= 7 days           -> terra dot (overdue for a look)
// Returns null when no dot should render — dot stays visually subordinate
// to the row label (small ~8px).
function severityDotColor(daysSinceObs) {
  if (daysSinceObs == null) return null
  if (daysSinceObs >= 7) return P.terra
  if (daysSinceObs >= 3) return P.warnBorder
  return null
}

function SeverityDot({ daysSinceObs }) {
  const color = severityDotColor(daysSinceObs)
  if (!color) return null
  return (
    <span
      data-testid="harvest-severity-dot"
      data-dot-color={color}
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: color,
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  )
}

// Standard tile card chrome — matches WaterMeTile / GiveAttentionTile.
function tileCardStyle() {
  return {
    backgroundColor: P.white,
    border: `1.5px solid ${P.border}`,
    borderRadius: 10,
    marginBottom: 28,
    overflow: 'hidden',
  }
}

const TILE_LABEL_STYLE = {
  fontSize: '0.75rem',
  color: P.mid,
  fontWeight: 500,
  marginBottom: 4,
}

export default function HarvestReadyTile({ harvestReady, onDataRefresh }) {
  const navigate = useNavigate()
  // onDataRefresh is accepted for forward-compat (inline log/refresh in a later
  // wave). Intentionally unused here — reference it so linters don't flag it.
  void onDataRefresh

  // Branch 1: undefined => still loading. Subtle italic placeholder, matching
  // the W1 HarvestReadyTilePlaceholder look in Dashboard.jsx.
  if (harvestReady === undefined) {
    return (
      <div
        data-testid="harvest-ready-skeleton"
        style={{ padding: 16, color: '#888', fontStyle: 'italic' }}
      >
        Tile loading...
      </div>
    )
  }

  // Branch 2: empty array => friendly empty state in standard tile chrome.
  if (harvestReady.length === 0) {
    return (
      <div data-testid="harvest-ready-empty" style={tileCardStyle()}>
        <div style={{ padding: '14px 16px' }}>
          <div style={TILE_LABEL_STYLE}>🧺 HARVEST READY</div>
          <div style={{ fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>
            Nothing ready to harvest yet
          </div>
        </div>
      </div>
    )
  }

  function goToLog(projectId) {
    navigate(`/log?project=${projectId}&event_type=harvest`)
  }

  // Branch 3: populated => tile card with one tappable row per project.
  return (
    <div data-testid="harvest-ready-tile" style={tileCardStyle()}>
      <div style={{ padding: '14px 16px 6px' }}>
        <div style={TILE_LABEL_STYLE}>🧺 HARVEST READY</div>
      </div>
      <div style={{ borderTop: `1px solid ${P.border}` }}>
        {harvestReady.map((p, i) => (
          <button
            key={p.project_id}
            type="button"
            onClick={() => goToLog(p.project_id)}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              width: '100%',
              textAlign: 'left',
              minHeight: 44,
              padding: '11px 16px',
              background: P.white,
              border: 'none',
              borderBottom:
                i < harvestReady.length - 1 ? `1px solid ${P.border}` : 'none',
              cursor: 'pointer',
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontWeight: 600,
                  color: P.green,
                  fontSize: '0.9rem',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {p.name}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: '0.72rem',
                  color: P.light,
                  marginTop: 2,
                }}
              >
                <SeverityDot daysSinceObs={p.days_since_obs} />
                <span>{observedLabel(p.days_since_obs)}</span>
              </div>
            </div>
            <span
              style={{
                fontSize: '0.78rem',
                color: P.green,
                fontWeight: 600,
                flexShrink: 0,
                whiteSpace: 'nowrap',
              }}
            >
              + Log harvest
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
