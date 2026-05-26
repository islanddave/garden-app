import React from 'react'
import { useNavigate } from 'react-router-dom'
import { P } from '../lib/constants.js'
import { todayBand } from '../lib/todayBand.js'

// Garden-tab "Today" band (Inc 1 — full band). The Dashboard surfaces watering/harvest/attention
// tiles, but the Dashboard was dropped from the nav (NAV-IA-1) — so the primary Garden surface
// needs its own glance-and-act for "what needs me now". This band merges the actionable signals
// /api/dashboard already returns (watering overdue + flagged issues + harvest-ready + long-unseen)
// into one ranked list; each row is a reason-label + tap-to-log. It is an OPERATIONAL ALERT
// (harm-prevention + time-sensitive opportunity), NOT a reward surface — ambient, in-context, no
// push/modal/sound/interrupt; recent-activity (a recognition feed) is excluded and stays on the
// Dashboard. Renders NOTHING when nothing needs attention (ADHD-overwhelm: no empty clutter).
// Render cap <=5 (C5); any remainder shows as a non-interactive "+N more" count.

export default function GardenTodayStrip({ dashboard = null }) {
  const navigate = useNavigate()
  const { visible, more } = todayBand(dashboard)
  if (visible.length === 0) return null

  return (
    <section aria-label="Needs attention today" style={{ marginBottom: 16 }}>
      <div style={{ fontSize: '0.72rem', color: P.mid, fontWeight: 700, letterSpacing: '0.04em', marginBottom: 6, paddingLeft: 2 }}>
        TODAY · NEEDS ATTENTION
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.map(it => (
          <button
            key={it.key}
            type="button"
            onClick={() => navigate(it.to)}
            aria-label={`${it.label}: ${it.projectName} — ${it.detail}. Tap to log.`}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
              padding: '10px 12px', minHeight: 44,
              backgroundColor: it.style.bg, border: `1.5px solid ${it.style.border}`,
              borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: '1.05rem', flexShrink: 0 }}>{it.emoji}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.68rem', color: P.mid, fontWeight: 700, letterSpacing: '0.02em' }}>
                {it.label.toUpperCase()}
              </div>
              <div style={{ fontWeight: 700, color: it.style.text, fontSize: '0.92rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.projectName}
              </div>
              <div style={{ fontSize: '0.74rem', color: P.mid, marginTop: 1 }}>
                {it.detail} · tap to log →
              </div>
            </div>
          </button>
        ))}
      </div>
      {more > 0 && (
        <div style={{ fontSize: '0.72rem', color: P.light, marginTop: 6, paddingLeft: 2 }}>
          + {more} more in your garden
        </div>
      )}
    </section>
  )
}
