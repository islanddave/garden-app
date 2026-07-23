import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import QualityDots from '../components/QualityDots.jsx'
import { useHarvests } from '../hooks/useHarvests.js'
import { groupByDay, dayLabel } from '../lib/harvestGrouping.js'
import { fmtQuantity, unitLabel, formatEntry } from '../lib/harvestSummary.js'

// Harvests — V4-HARVESTVIEW-001 S2a (first user-visible slice). Route + Log feed + minimal Totals,
// reading the shipped GET /api/harvests. Retrospective/reflective surface: never prompts, counts down,
// or scores (design §1). Snapshot strip + filters = S2b; Totals expansion + sparkline + year selector
// = S3. HarvestEntry is page-local here; extraction to a shared EventRow primitive is the S3 job.

const displayYear = () => new Date().getFullYear()

export default function Harvests() {
  const [view, setView] = useState('log') // 'log' | 'totals'
  const { entries, aggregates, hasMore, loading, loadingMore, error, reload, loadMore } = useHarvests()

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '24px 16px 60px' }}>
        <h1 style={{ margin: '0 0 2px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Harvests</h1>
        <p style={{ margin: '0 0 16px', fontSize: '0.82rem', color: P.light }}>
          What the garden gave you.
        </p>

        <div style={{ marginBottom: 18 }}>
          <SegmentedControl
            options={[{ value: 'log', label: 'Log' }, { value: 'totals', label: 'Totals' }]}
            value={view}
            onChange={setView}
            ariaLabel="Harvests view: Log or Totals"
          />
        </div>

        {loading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : view === 'log' ? (
          <LogView entries={entries} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} />
        ) : (
          <TotalsView aggregates={aggregates} />
        )}
      </div>
    </div>
  )
}

// ── Log ──────────────────────────────────────────────────────────────────────────────────────────
function LogView({ entries, hasMore, loadingMore, onLoadMore }) {
  if (!entries || entries.length === 0) {
    return (
      <EmptyState
        emoji="🧺"
        title="Your harvests will collect here"
        body="The first one starts the season — log a harvest and it shows up here."
      />
    )
  }
  const sections = groupByDay(entries)
  const year = displayYear()
  return (
    <div>
      {sections.map((sec) => (
        <div key={sec.day_key} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: '0.78rem', fontWeight: 700, color: P.mid, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 8px 2px' }}>
            {dayLabel(sec.day_key, year)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sec.entries.map((e) => <HarvestEntry key={e.event_id} entry={e} />)}
          </div>
        </div>
      ))}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          style={{ width: '100%', marginTop: 4, padding: '12px', background: P.white, color: P.green, border: `1px solid ${P.border}`, borderRadius: 10, fontSize: '0.88rem', fontWeight: 700, cursor: loadingMore ? 'default' : 'pointer' }}
        >
          {loadingMore ? 'Loading…' : 'Earlier this season →'}
        </button>
      )}
    </div>
  )
}

function HarvestEntry({ entry: e }) {
  const removed = e.planting_removed
  const unassigned = e.plant_id == null
  const name = e.variety_name || e.crop_name || e.planting_name || 'Harvest'
  const countNoun = e.crop_name || e.variety_name || null
  const hasQty = e.harvest_log_id != null && e.quantity != null
  const qtyText = hasQty ? formatEntry({ quantity: e.quantity, unit: e.unit }, countNoun) : 'harvest logged — no amount recorded'

  // Row tap target (design §3b): planting detail anchored at the event; unassigned → its project;
  // deleted planting → not navigable.
  const mainTo = !removed && !unassigned && e.project_id && e.plant_id
    ? `/projects/${e.project_id}/plantings/${e.plant_id}`
    : (unassigned && e.project_id ? `/projects/${e.project_id}` : null)
  const editTo = e.project_id && e.event_id ? `/projects/${e.project_id}/events/${e.event_id}` : null

  const body = (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: '0.95rem', fontWeight: 700, color: P.dark }}>{name}</span>
        <span style={{ fontSize: '0.88rem', fontWeight: 600, color: hasQty ? P.green : P.light, whiteSpace: 'nowrap' }}>{qtyText}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
        {e.event_type === 'first_harvest' && (
          <span style={{ fontSize: '0.74rem', fontWeight: 700, color: P.green }}>First harvest 🌱</span>
        )}
        <QualityDots value={e.quality_rating} />
        {Array.isArray(e.photos) && e.photos.length > 0 && (
          <span style={{ fontSize: '0.74rem', color: P.light }} aria-label={`${e.photos.length} photo${e.photos.length === 1 ? '' : 's'}`}>📷 {e.photos.length}</span>
        )}
      </div>
      {(unassigned || removed) && (
        <div style={{ fontSize: '0.76rem', color: P.light, marginTop: 3 }}>
          {removed ? 'planting removed' : `Logged to ${e.project_name || 'a project'}`}
        </div>
      )}
      {e.note_excerpt && (
        <div style={{ fontSize: '0.8rem', color: P.mid, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.note_excerpt}</div>
      )}
    </>
  )

  const cardStyle = { flex: 1, minWidth: 0, background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '11px 13px', textAlign: 'left', textDecoration: 'none', color: 'inherit' }

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
      {mainTo
        ? <Link to={mainTo} style={cardStyle}>{body}</Link>
        : <div style={cardStyle}>{body}</div>}
      {editTo && (
        <Link
          to={editTo}
          aria-label="Open this harvest event"
          style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', padding: '0 10px', background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, color: P.light, textDecoration: 'none', fontSize: '0.8rem', fontWeight: 700 }}
        >
          Edit
        </Link>
      )}
    </div>
  )
}

// ── Totals (minimal: per-crop native-unit sums; expansion/sparkline/year selector = S3) ────────────
function TotalsView({ aggregates }) {
  const crops = aggregates?.crops ?? []
  const other = aggregates?.other ?? []
  if (crops.length === 0 && other.length === 0) {
    return <EmptyState emoji="🧺" title="No totals yet" body="Once you log harvests, season totals show up here by crop." />
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {crops.map((c) => (
        <div key={c.crop_type_slug} style={{ background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 14px' }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: P.dark, marginBottom: 2 }}>{c.crop_name}</div>
          <div style={{ fontSize: '0.88rem', color: P.green, fontWeight: 600 }}>{unitsLine(c.units, c.crop_name)}</div>
          {c.unquantified > 0 && (
            <div style={{ fontSize: '0.75rem', color: P.light, marginTop: 2 }}>+{c.unquantified} unrecorded</div>
          )}
        </div>
      ))}
      {other.length > 0 && (
        <div style={{ background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 14px' }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: P.mid, marginBottom: 4 }}>Unassigned</div>
          {other.map((o) => (
            <div key={o.project_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: '0.84rem', color: P.mid, padding: '2px 0' }}>
              <span>{o.project_name || 'A project'}</span>
              <span style={{ fontWeight: 600 }}>{unitsLine(o.units, null) || `+${o.unquantified} unrecorded`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// "4.5 cups · 12 tomatoes" — one native unit per segment, no conversion (design §3c).
function unitsLine(units, cropName) {
  if (!Array.isArray(units) || units.length === 0) return ''
  return units.map((u) => `${fmtQuantity(u.total)} ${unitLabel(u.unit, u.total, cropName)}`.trim()).join(' · ')
}

// ── Shared states ──────────────────────────────────────────────────────────────────────────────────
function EmptyState({ emoji, title, body }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 20px', color: P.light }}>
      <div style={{ fontSize: '2.4rem', marginBottom: 10 }} aria-hidden="true">{emoji}</div>
      <p style={{ margin: '0 0 6px', fontSize: '0.98rem', fontWeight: 700, color: P.mid }}>{title}</p>
      <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.5 }}>{body}</p>
    </div>
  )
}

function ErrorState({ message, onRetry }) {
  return (
    <div role="alert" style={{ textAlign: 'center', padding: '40px 16px', background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 10 }}>
      <div style={{ fontSize: '2.2rem', marginBottom: 10 }} aria-hidden="true">⚠️</div>
      <p style={{ margin: 0, fontSize: '0.92rem', color: P.dark, fontWeight: 600 }}>Couldn’t load your harvests</p>
      <p style={{ margin: '6px 0 14px', fontSize: '0.82rem', color: P.mid }}>{message}</p>
      <button type="button" onClick={onRetry} style={{ padding: '8px 18px', fontSize: '0.85rem', borderRadius: 8, border: `1px solid ${P.alertBorder}`, background: P.white, color: P.dark, cursor: 'pointer' }}>Retry</button>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} style={{ height: 62, background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, opacity: 0.6 }} />
      ))}
    </div>
  )
}
