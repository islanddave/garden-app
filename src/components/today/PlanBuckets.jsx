import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../../lib/constants.js'

// Collapsed-by-default task buckets for the Today surface (DRG-TODAY-002). Reads the persisted plan the
// overnight engine wrote: { water_due[], no_history[], fertilize[], pest[], cold[], dormant[] }. Each row
// deep-links to its planting detail. Operational surface (no reward-UX rules): no celebration/streak/badge.

// Every task item carries { id (planting), name, crop, project, project_id, in_ground }. Deep-link to the
// planting detail when we have both ids, else fall back to the Garden list.
// V3-TODAYDONE-001: each actionable bucket maps to a suggested event type; tapping a row opens a
// PRE-FILLED Log (project + planting + event type) so logging it checks the item off for the day.
const SUGGEST_EVENT = {
  water_due: 'watering', no_history: 'watering', fertilize: 'fertilizing',
  pest: 'observation', cold: 'brought_inside',
}
function itemHref(bucketKey, it) {
  const evt = SUGGEST_EVENT[bucketKey]
  if (evt && it.project_id && it.id) return `/log?project=${it.project_id}&plant=${it.id}&event_type=${evt}`
  return (it.project_id && it.id) ? `/projects/${it.project_id}/plantings/${it.id}` : '/garden'
}

function subLine(bucketKey, it) {
  switch (bucketKey) {
    case 'water_due': {
      if (it.rain_note) return it.rain_note   // DRG-WATERCREDIT-001: engine's reason string (rain credit / under-threshold / fresh transplant)
      const overdue = it.overdue_by > 0 ? `${it.overdue_by}d overdue` : 'due today'
      return `${overdue}${it.project ? ' · ' + it.project : ''}`
    }
    case 'no_history':
      return `No watering logged yet${it.project ? ' · ' + it.project : ''}`
    case 'fertilize':
      return [it.item, it.apply].filter(Boolean).join(' · ')
    case 'pest':
      return it.label || 'Scout for pests'
    case 'cold':
      return it.text || 'Protect tonight'
    case 'dormant':
      return it.note || 'Dormant — skip routine care'
    default:
      return it.project || ''
  }
}

function Row({ bucketKey, it }) {
  return (
    <Link
      to={itemHref(bucketKey, it)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none',
        padding: '10px 12px', borderTop: `1px solid ${P.border}`, color: P.dark,
        opacity: 1, minHeight: 48,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.92rem', fontWeight: 600, color: P.dark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {it.name || it.crop || 'Planting'}
        </div>
        <div style={{ fontSize: '0.76rem', color: P.light, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {subLine(bucketKey, it)}
        </div>
      </div>
      <span aria-hidden="true" style={{ color: P.light, fontSize: '1rem', flexShrink: 0 }}>›</span>
    </Link>
  )
}

function Bucket({ def, items }) {
  const [open, setOpen] = useState(false)
  // V3-TODAYDONE-001: items already logged today are `done` and drop out of the bucket for the day;
  // the bucket itself falls off once everything in it is checked.
  const all = items || []
  const pending = all.filter(it => !it.done)
  const doneCount = all.length - pending.length
  if (pending.length === 0) return null
  const panelId = `bucket-${def.key}`
  return (
    <div style={{ border: `1px solid ${P.border}`, borderRadius: 12, background: P.white, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
          padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer',
          fontFamily: 'inherit', color: P.dark, minHeight: 52,
        }}
      >
        <span aria-hidden="true" style={{ fontSize: '1.25rem', flexShrink: 0 }}>{def.emoji}</span>
        <span style={{ flex: 1, fontSize: '0.98rem', fontWeight: 700 }}>{def.label}</span>
        <span style={{
          fontSize: '0.78rem', fontWeight: 800, color: def.accent || P.green,
          background: def.accentBg || P.greenPale, borderRadius: 999, padding: '2px 9px', flexShrink: 0,
        }}>{pending.length}</span>
        <span aria-hidden="true" style={{ color: P.light, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>▾</span>
      </button>
      {open && (
        <div id={panelId} role="list">
          {pending.map((it, i) => <Row key={it.id || i} bucketKey={def.key} it={it} />)}
          {doneCount > 0 && (
            <div style={{ padding: '8px 12px', borderTop: `1px solid ${P.border}`, fontSize: '0.74rem', color: P.light }}>
              ✓ {doneCount} done today
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const BUCKETS = [
  { key: 'water_due',  label: 'Water',           emoji: '💧', accent: '#2563eb', accentBg: '#e0ecff' },
  { key: 'no_history', label: 'Never watered',   emoji: '🆕', accent: P.gold,    accentBg: P.warn },
  { key: 'fertilize',  label: 'Feed',            emoji: '🌿', accent: P.green,   accentBg: P.greenPale },
  { key: 'pest',       label: 'Pest watch',      emoji: '🐛', accent: P.terra,   accentBg: P.alert },
  { key: 'cold',       label: 'Cold protection', emoji: '🌡️', accent: P.blue,    accentBg: '#e6f0fa' },
  { key: 'dormant',    label: 'Dormant',         emoji: '💤', accent: P.light,   accentBg: '#eee' },
]

export default function PlanBuckets({ plan }) {
  const total = BUCKETS.reduce((n, b) => n + ((plan?.[b.key] || []).filter(it => !it.done).length), 0)
  // DRG-WATERCREDIT-001: ambient note so rain-credited plantings aren't silently absent from Water.
  const skipped = Array.isArray(plan?.rain_skipped) ? plan.rain_skipped.length : 0
  const rainLine = skipped > 0 ? (
    <div style={{ fontSize: '0.78rem', color: P.light, padding: '4px 6px', textAlign: total === 0 ? 'center' : 'left' }}>
      🌧️ {skipped} planting{skipped > 1 ? 's' : ''} skipped — recent rain counts as watering
    </div>
  ) : null
  if (total === 0) {
    return (
      <div style={{ padding: '28px 16px', textAlign: 'center', color: P.light }}>
        <div style={{ fontSize: '1.4rem', marginBottom: 6 }}>🌿</div>
        <div style={{ fontSize: '0.95rem', fontWeight: 600, color: P.mid, marginBottom: 4 }}>
          Nothing needs you today.
        </div>
        <div style={{ fontSize: '0.82rem', lineHeight: 1.4 }}>
          Your plants are on track — enjoy the garden.
        </div>
        {rainLine}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {BUCKETS.map(def => <Bucket key={def.key} def={def} items={plan?.[def.key]} />)}
      {rainLine}
    </div>
  )
}
