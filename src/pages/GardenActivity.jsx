// Garden Activity — admin-only success-metric diagnostic (Post-V2 UX Overhaul — Increment 0).
// Spec: success-metric-instrumentation-spec-V001-20260522.1620.md §3.
//
// Jen-invisible (Reward UX V100 §8): NO nav link anywhere, not surfaced in settings/help/onboarding.
// The real security is the Lambda's ADMIN_CLERK_SUBS allowlist (fail-closed); this page just shows a
// neutral placard to non-admins. Diagnostic ONLY — numbers, no celebration, no badges, no streaks.
//
// Three panels:
//   M1 — tap-count to completion per flow (target: <=2 to start, <=3 to complete a simple log).
//   M2 — capture-events/week (flat-or-up is healthy; a drop is a regression signal).
//   M3 — agent-proposal accept-rate, with the 40% canary line. Not available until the Inc-3 tasks table.

import React, { useState, useEffect, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'

const FLOW_LABELS = {
  log_watering: 'Log a watering',
  reach_planting: 'Reach a planting',
  create_project: 'Create a project',
}

export default function GardenActivity() {
  const { fetch } = useApiFetch()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [forbidden, setForbidden] = useState(false)

  const load = useCallback(() => {
    setLoading(true); setError(null); setForbidden(false)
    fetch('/api/ux-events?admin=1')
      .then((d) => { setData(d); setLoading(false) })
      .catch((err) => {
        if (err?.status === 403) { setForbidden(true); setLoading(false); return }
        setError(err?.message ?? String(err)); setLoading(false)
      })
  }, [fetch])

  useEffect(() => { load() }, [load])

  if (forbidden) return <NeutralPlacard />
  if (loading) return <Shell><p>Loading…</p></Shell>
  if (error) return <Shell><p style={{ color: '#b94a3a' }}>Error: {error}</p></Shell>

  return (
    <Shell>
      <h1 style={{ marginTop: 0, fontSize: '1.4rem' }}>Garden Activity</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Admin-only diagnostic for the UX overhaul. Captured {data?.generated_at ? new Date(data.generated_at).toLocaleString() : '—'}.
      </p>

      <M1Panel byFlow={data?.m1?.by_flow ?? []} windowDays={data?.m1?.window_days} />
      <M2Panel byWeek={data?.m2?.by_week ?? []} windowWeeks={data?.m2?.window_weeks} />
      <M3Panel m3={data?.m3 ?? { available: false, canary_threshold: 0.40 }} />

      <button type="button" onClick={load}
        style={{ marginTop: 20, padding: '6px 14px', borderRadius: 4, border: '1px solid #bbb', background: '#fff', cursor: 'pointer' }}>
        Refresh
      </button>
    </Shell>
  )
}

function Panel({ title, subtitle, children }) {
  return (
    <section style={{ marginTop: 20, padding: 16, background: '#fff', border: '1px solid #ddd', borderRadius: 8 }}>
      <h2 style={{ margin: '0 0 2px', fontSize: '1.05rem' }}>{title}</h2>
      {subtitle && <p style={{ margin: '0 0 12px', color: '#888', fontSize: '0.82rem' }}>{subtitle}</p>}
      {children}
    </section>
  )
}

function M1Panel({ byFlow, windowDays }) {
  const byId = {}
  byFlow.forEach((r) => { byId[r.flow_id] = r })
  const flows = ['log_watering', 'reach_planting', 'create_project']
  const anyData = byFlow.length > 0
  return (
    <Panel title="M1 — Taps to completion"
           subtitle={`Last ${windowDays ?? 30} days · target ≤2 to start, ≤3 to complete a simple log`}>
      {!anyData && <EmptyNote>No completed flows recorded yet. Populates once the M1 hooks ship and the flows run.</EmptyNote>}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#666', borderBottom: '1px solid #eee' }}>
            <th style={{ padding: '6px 8px' }}>Flow</th>
            <th style={{ padding: '6px 8px' }}>Samples</th>
            <th style={{ padding: '6px 8px' }}>Avg</th>
            <th style={{ padding: '6px 8px' }}>Median</th>
            <th style={{ padding: '6px 8px' }}>Min</th>
            <th style={{ padding: '6px 8px' }}>Max</th>
          </tr>
        </thead>
        <tbody>
          {flows.map((f) => {
            const r = byId[f]
            return (
              <tr key={f} style={{ borderBottom: '1px solid #f3f3f3' }}>
                <td style={{ padding: '6px 8px', fontWeight: 600 }}>{FLOW_LABELS[f]}</td>
                <td style={{ padding: '6px 8px' }}>{r?.samples ?? '—'}</td>
                <td style={{ padding: '6px 8px' }}>{r?.avg_taps ?? '—'}</td>
                <td style={{ padding: '6px 8px' }}>{r?.median_taps != null ? Number(r.median_taps).toFixed(1) : '—'}</td>
                <td style={{ padding: '6px 8px' }}>{r?.min_taps ?? '—'}</td>
                <td style={{ padding: '6px 8px' }}>{r?.max_taps ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Panel>
  )
}

function M2Panel({ byWeek, windowWeeks }) {
  const max = byWeek.reduce((m, w) => Math.max(m, w.captures ?? 0), 0) || 1
  return (
    <Panel title="M2 — Capture-events / week"
           subtitle={`Last ${windowWeeks ?? 8} weeks · derived from existing logs · flat-or-up is healthy`}>
      {byWeek.length === 0 && <EmptyNote>No capture events in the window.</EmptyNote>}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 120, marginTop: 8 }}>
        {byWeek.map((w) => (
          <div key={w.iso_week} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div style={{ fontSize: '0.72rem', color: '#666' }}>{w.captures}</div>
            <div title={`${w.iso_week}: ${w.captures}`}
                 style={{ width: '100%', maxWidth: 36, height: `${Math.round((w.captures / max) * 90) + 2}px`, background: '#4a7c59', borderRadius: '3px 3px 0 0' }} />
            <div style={{ fontSize: '0.66rem', color: '#999', transform: 'rotate(-30deg)', whiteSpace: 'nowrap' }}>{w.iso_week}</div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function M3Panel({ m3 }) {
  const canary = m3?.canary_threshold ?? 0.40
  const rate = m3?.accept_rate
  const available = m3?.available && rate != null
  const pct = available ? Math.round(rate * 100) : 0
  return (
    <Panel title="M3 — Agent-proposal accept-rate"
           subtitle={`THE CANARY · below ${Math.round(canary * 100)}% → pull back agent autonomy`}>
      {!available && (
        <EmptyNote>
          {m3?.reason ?? 'Not available yet'} — surfaces once the care-brain task layer ships (Increment 3).
        </EmptyNote>
      )}
      <div style={{ position: 'relative', height: 26, background: '#eee', borderRadius: 6, overflow: 'hidden', marginTop: 8 }}>
        {available && (
          <div style={{ height: '100%', width: `${pct}%`, background: rate >= canary ? '#4a7c59' : '#b94a3a', transition: 'width 200ms ease' }} />
        )}
        {/* 40% canary line always drawn */}
        <div aria-label={`canary line ${Math.round(canary * 100)}%`}
             style={{ position: 'absolute', top: 0, bottom: 0, left: `${Math.round(canary * 100)}%`, width: 2, background: '#c0392b' }} />
      </div>
      <p style={{ margin: '6px 0 0', fontSize: '0.82rem', color: '#666' }}>
        {available ? `${pct}% accepted (${m3.accepted}/${m3.proposed})` : 'Awaiting agent-proposed tasks'}
        {' · canary at '}{Math.round(canary * 100)}%
      </p>
    </Panel>
  )
}

function EmptyNote({ children }) {
  return <p style={{ margin: '0 0 10px', padding: '8px 10px', background: '#fffbe5', border: '1px solid #e7dca0', borderRadius: 6, fontSize: '0.82rem', color: '#7a6a20' }}>{children}</p>
}

function Shell({ children }) {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 880, margin: '0 auto' }}>
      {children}
    </div>
  )
}

function NeutralPlacard() {
  // Non-admin landing: reveal nothing about the surface (Jen-invisible).
  return (
    <div role="status" style={{ padding: '48px 20px', textAlign: 'center', color: '#666' }}>
      <p>Nothing to see here.</p>
    </div>
  )
}
