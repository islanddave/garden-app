import React from 'react'
import { useNavigate } from 'react-router-dom'
import { P } from '../lib/constants.js'
import SeverityBadge from '../components/SeverityBadge.jsx'

// ─── Dashboard Tile: Heads Up ────────────────────────────────────────────────
// Surfaces stale projects from the dashboard Lambda's `heads_up` payload.
// FLAG-REMOVAL (2026-06-10): the planting-flagging UI was retired; reason='flagged' rows are
// filtered out upstream in Dashboard.jsx (server payload intentionally unchanged).
//
// Prop contract:
//   headsUp: Array<{
//     project_id: string,
//     name: string,
//     reason: 'stale',
//     severity: 1 | 2 | 3 | null,
//     event_at: string | null,
//     days_stale: number | null,
//   }> | undefined
//   onDataRefresh?: () => void  — reserved for future use; accepted but unused.
//
// Render branches:
//   undefined   → skeleton / loading state
//   []          → friendly "all clear" empty state
//   populated   → tile card listing each row
//
// IMPORTANT: rows render in the exact server-returned order. The dashboard Lambda
// already orders by `severity DESC, event_at ASC` and dedups projects. No
// client-side sort or dedup — trusting server order is required.

// "N days" phrasing shared by both reason branches.
function daysAgoPhrase(days) {
  if (typeof days !== 'number') return null
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

// Secondary line under the project name, by reason.
function secondaryLine(row) {
  // reason === 'stale'
  if (row.event_at == null) return 'No recent observations'
  const phrase = daysAgoPhrase(row.days_stale)
  return phrase ? `Last observed ${phrase}` : 'Last observed recently'
}

export default function HeadsUpTile({ headsUp, onDataRefresh }) {
  // onDataRefresh is reserved for future use — accepted gracefully, intentionally unused.
  void onDataRefresh

  const navigate = useNavigate()

  // ── Loading / skeleton state ──────────────────────────────────────────────
  if (headsUp === undefined) {
    return (
      <div style={{ padding: 16, color: '#888', fontStyle: 'italic' }}>
        Tile loading...
      </div>
    )
  }

  // ── Empty state — no stale projects ───────────────────────────────────────
  if (headsUp.length === 0) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '14px 16px',
        backgroundColor: P.white,
        border: `1.5px solid ${P.border}`,
        borderRadius: '10px',
        marginBottom: '28px',
      }}>
        <span style={{ fontSize: '1.4rem' }}>👀</span>
        <div>
          <div style={{ fontSize: '0.75rem', color: P.mid, fontWeight: 500, marginBottom: '1px' }}>
            HEADS UP
          </div>
          <div style={{ fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>
            All clear — no stale projects
          </div>
        </div>
      </div>
    )
  }

  // ── Populated — list each row in server-returned order ────────────────────
  function goToRow(row) {
    // reason === 'stale' — navigate to the project page, no query param.
    // NOTE: the heads_up payload has no event_id, so we cannot deeplink to a
    // specific event — project page only.
    navigate(`/projects/${row.project_id}`)
  }

  return (
    <div style={{
      backgroundColor: P.white,
      border: `1.5px solid ${P.border}`,
      borderRadius: '10px',
      marginBottom: '28px',
      overflow: 'hidden',
    }}>
      <div style={{
        fontSize: '0.75rem',
        color: P.mid,
        fontWeight: 500,
        padding: '14px 16px 8px',
      }}>
        👀 HEADS UP
      </div>
      <div style={{ borderTop: `1px solid ${P.border}` }}>
        {headsUp.map((row, i) => (
          <button
            key={`${row.project_id}-${i}`}
            type="button"
            onClick={() => goToRow(row)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              minHeight: 44,
              textAlign: 'left',
              padding: '11px 16px',
              background: P.white,
              border: 'none',
              borderBottom: i < headsUp.length - 1 ? `1px solid ${P.border}` : 'none',
              cursor: 'pointer',
            }}
          >
            <SeverityBadge
              reason={row.reason}
              daysStale={row.days_stale}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontWeight: 600,
                color: P.dark,
                fontSize: '0.88rem',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {row.name}
              </div>
              <div style={{ fontSize: '0.72rem', color: P.light, marginTop: 1 }}>
                {secondaryLine(row)}
              </div>
            </div>
            <span style={{ fontSize: '0.8rem', color: P.mid, flexShrink: 0 }}>
              →
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
