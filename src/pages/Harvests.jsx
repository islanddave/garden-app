import React, { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { P } from '../lib/constants.js'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import Sheet from '../components/forms/Sheet.jsx'
import QualityDots from '../components/QualityDots.jsx'
import StatTile from '../components/StatTile.jsx'
import { useHarvests } from '../hooks/useHarvests.js'
import { useHarvestSnapshot } from '../hooks/useHarvestSnapshot.js'
import { useHarvestFilterOptions } from '../hooks/useHarvestFilterOptions.js'
import { groupByDay, dayLabel, relativeDay } from '../lib/harvestGrouping.js'
import { fmtQuantity, unitLabel, formatEntry, etDay } from '../lib/harvestSummary.js'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'

// Harvests — V4-HARVESTVIEW-001 S2a/S2b. Route + snapshot strip + Log feed + minimal Totals, reading
// the shipped GET /api/harvests. Retrospective/reflective: never prompts, counts down, or scores
// (design §1). Snapshot self-labels FIXED windows (design §3b) so it's independent of the Log filter.
// S2b part 1 added the snapshot strip + timeframe chips; part 2 adds crop + project picker sheets +
// dismissible pills. Crop/project scope the LOG only (design §3b) — they're dropped from the query on
// the Totals tab, so minimal Totals stays the whole-season overview until S3's year selector lands.

const HARVEST_TZ = 'America/New_York'
const currentGrowYear = (d) => (d.getMonth() >= 10 ? d.getFullYear() + 1 : d.getFullYear())

export default function Harvests() {
  // S4: EventNew's post-harvest line + PlantingDetail's "All harvests →" land here pre-filtered to a
  // crop via ?crop=<slug>. Seeded once on mount; the pickers drive local state from there (no two-way
  // URL sync in V1 — server-persisted last filter is a named phase-2 item, design §9).
  const [searchParams] = useSearchParams()
  const [view, setView] = useState('log') // 'log' | 'totals'
  const [timeframe, setTimeframe] = useState('') // '' = all time
  const [crop, setCrop] = useState(() => searchParams.get('crop') || '') // crop_type_slug; '' = all crops
  const [cropLabel, setCropLabel] = useState('')
  const [project, setProject] = useState('') // project_id (uuid); '' = all projects
  const [projectLabel, setProjectLabel] = useState('')
  const [cropSheetOpen, setCropSheetOpen] = useState(false)
  const [projectSheetOpen, setProjectSheetOpen] = useState(false)

  // Crop/project scope the LOG (design §3b: "filters scope the Log only"). On the Totals tab we drop
  // them so the minimal Totals shows the timeframe-only aggregate universe (its own year selector +
  // row-tap-to-filter arrive in S3). No filter active → params identical across views → no refetch on
  // a Log↔Totals toggle; a refetch happens only when a crop/project filter is actually set.
  const logScoped = view === 'log'
  const { entries, aggregates, hasMore, loading, loadingMore, error, reload, loadMore } = useHarvests({
    timeframe: timeframe || undefined,
    crop: logScoped ? (crop || undefined) : undefined,
    project: logScoped ? (project || undefined) : undefined,
  })
  const { snapshot } = useHarvestSnapshot()
  const { crops: cropOptions, projects: projectOptions } = useHarvestFilterOptions()
  const filterActive = timeframe !== '' || crop !== '' || project !== ''

  const clearAll = () => { setTimeframe(''); setCrop(''); setCropLabel(''); setProject(''); setProjectLabel('') }
  // "See in log →" from an expanded Totals crop row: filter the Log to that crop and switch tabs
  // (design §3c: a Totals crop-row tap switches to Log with a visible dismissible filter pill).
  const seeInLog = (slug, name) => { setCrop(slug); setCropLabel(name); setView('log') }

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '24px 16px 60px' }}>
        <h1 style={{ margin: '0 0 2px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Harvests</h1>
        <p style={{ margin: '0 0 16px', fontSize: '0.82rem', color: P.light }}>What the garden gave you.</p>

        <SnapshotStrip snapshot={snapshot} onOpenLog={() => setView('log')} onOpenTotals={() => setView('totals')} />

        <div style={{ marginBottom: 12 }}>
          <SegmentedControl
            options={[{ value: 'log', label: 'Log' }, { value: 'totals', label: 'Totals' }]}
            value={view}
            onChange={setView}
            ariaLabel="Harvests view: Log or Totals"
          />
        </div>

        <TimeframeChips value={timeframe} onChange={setTimeframe} />

        {view === 'log' && (
          <FilterControls
            cropValue={crop ? (cropLabel || cropOptions.find((o) => o.crop_type_slug === crop)?.display_name || crop) : ''}
            onOpenCrop={() => setCropSheetOpen(true)}
            onClearCrop={() => { setCrop(''); setCropLabel('') }}
            projectValue={project ? (projectLabel || project) : ''}
            onOpenProject={() => setProjectSheetOpen(true)}
            onClearProject={() => { setProject(''); setProjectLabel('') }}
          />
        )}

        {loading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : view === 'log' ? (
          <LogView entries={entries} filterActive={filterActive} onClearFilters={clearAll} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} />
        ) : (
          <TotalsView aggregates={aggregates} onSeeInLog={seeInLog} />
        )}
      </div>

      <PickerSheet
        open={cropSheetOpen}
        onClose={() => setCropSheetOpen(false)}
        title="Filter by crop"
        allLabel="All crops"
        emptyText="No crops logged yet."
        selected={crop}
        options={cropOptions.map((c) => ({ value: c.crop_type_slug, label: c.display_name }))}
        onSelect={(value, label) => { setCrop(value); setCropLabel(label); setCropSheetOpen(false) }}
      />
      {/* V4-PROJHIDE-001: no project picker sheet when the Project filter is hidden. Flag OFF mounts it as before. */}
      {!PROJECTS_HIDDEN && (
      <PickerSheet
        open={projectSheetOpen}
        onClose={() => setProjectSheetOpen(false)}
        title="Filter by project"
        allLabel="All projects"
        emptyText="No projects yet."
        selected={project}
        options={projectOptions.map((p) => ({ value: p.id, label: p.name }))}
        onSelect={(value, label) => { setProject(value); setProjectLabel(label); setProjectSheetOpen(false) }}
      />
      )}
    </div>
  )
}

// ── Snapshot strip (design §3a): 3 static, tappable tiles; fixed windows, filter-independent ───────
function SnapshotStrip({ snapshot, onOpenLog, onOpenTotals }) {
  if (!snapshot) return null
  const { lastHarvest: lh, seasonCropCount, last7 } = snapshot
  const todayKey = etDay(new Date(), HARVEST_TZ)

  const lhName = lh ? (lh.variety_name || lh.crop_name || lh.planting_name || 'Harvest') : null
  const lhQty = lh && lh.harvest_log_id != null && lh.quantity != null ? formatEntry({ quantity: lh.quantity, unit: lh.unit }, lh.crop_name) : null
  const lhTo = lh
    // V4-PROJHIDE-001: keep the planting deep-link (shim → /plantings/:id); drop the bare-project
    // fallback when projects are hidden (tile becomes non-navigable). Flag OFF unchanged.
    ? (lh.plant_id && !lh.planting_removed && lh.project_id ? `/projects/${lh.project_id}/plantings/${lh.plant_id}` : (!PROJECTS_HIDDEN && lh.project_id ? `/projects/${lh.project_id}` : null))
    : null

  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
      <StatTile
        label="Last harvest"
        primary={lh ? (lhQty ? `${lhName} · ${lhQty}` : lhName) : 'None yet'}
        secondary={lh ? relativeDay(lh.day_key, todayKey) : 'this season'}
        to={lhTo || undefined}
      />
      <StatTile
        label="Last 7 days"
        primary={last7.count > 0 ? last7Phrase(last7.top) : 'A quiet week'}
        secondary={last7.count > 0 ? `${last7.count} pick${last7.count === 1 ? '' : 's'}` : undefined}
        onClick={onOpenLog}
      />
      <StatTile
        label="This season"
        primary={`${seasonCropCount} crop${seasonCropCount === 1 ? '' : 's'}`}
        secondary="Nov–Oct"
        onClick={onOpenTotals}
      />
    </div>
  )
}

// "3 cups blueberries · 6 zucchini" — native units when a crop's window is single-unit + fully
// quantified; otherwise a count phrase ("5 blueberry picks"). Design §3a(b) mixed-unit fallback.
function last7Phrase(top) {
  return top.map((c) => {
    const name = String(c.name || '').toLowerCase()
    if (c.nativeUnit && c.nativeUnit.unit !== 'count') return `${fmtQuantity(c.nativeUnit.total)} ${unitLabel(c.nativeUnit.unit, c.nativeUnit.total)} ${name}`
    if (c.nativeUnit && c.nativeUnit.unit === 'count') return `${fmtQuantity(c.nativeUnit.total)} ${name}`
    return `${c.count} ${name} pick${c.count === 1 ? '' : 's'}`
  }).join(' · ')
}

function TimeframeChips({ value, onChange }) {
  const growYear = currentGrowYear(new Date())
  const chips = [
    { value: '', label: 'All time' },
    { value: '7d', label: 'Last 7 days' },
    { value: 'month', label: 'This month' },
    { value: `season:${growYear}`, label: 'This season' },
  ]
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }} role="group" aria-label="Filter by timeframe">
      {chips.map((c) => {
        const active = value === c.value
        return (
          <button
            key={c.value || 'all'}
            type="button"
            onClick={() => onChange(c.value)}
            aria-pressed={active}
            style={{ padding: '6px 14px', borderRadius: 20, fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', border: `1px solid ${active ? P.green : P.border}`, backgroundColor: active ? P.greenPale : P.white, color: active ? P.green : P.mid }}
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Crop/project filters (design §3b): picker sheets rendering dismissible pills, Log-scoped ────────
function FilterControls({ cropValue, onOpenCrop, onClearCrop, projectValue, onOpenProject, onClearProject }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }} role="group" aria-label={PROJECTS_HIDDEN ? 'Filter by crop' : 'Filter by crop or project'}>
      <FilterPill placeholder="Crop" value={cropValue} onOpen={onOpenCrop} onClear={onClearCrop} />
      {/* V4-PROJHIDE-001: the Project filter is hidden when projects aren't user-facing — crop is the axis. Flag OFF renders both pills. */}
      {!PROJECTS_HIDDEN && (
        <FilterPill placeholder="Project" value={projectValue} onOpen={onOpenProject} onClear={onClearProject} />
      )}
    </div>
  )
}

// One pill: tap the label to open the picker; when a value is set, an adjacent × clears it. Selection
// is conveyed by both text (the chosen name) and color — never color alone (design §3b special rows).
function FilterPill({ placeholder, value, onOpen, onClear }) {
  const active = !!value
  return (
    <div style={{ display: 'inline-flex', alignItems: 'stretch', borderRadius: 20, overflow: 'hidden', border: `1px solid ${active ? P.green : P.border}` }}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={active ? `${placeholder}: ${value}. Change filter` : `Filter by ${placeholder.toLowerCase()}`}
        style={{ padding: active ? '6px 8px 6px 14px' : '6px 14px', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', border: 'none', backgroundColor: active ? P.greenPale : P.white, color: active ? P.green : P.mid, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        {active ? value : placeholder}
        {!active && <span aria-hidden="true" style={{ fontSize: '0.7rem', opacity: 0.7 }}>▾</span>}
      </button>
      {active && (
        <button
          type="button"
          onClick={onClear}
          aria-label={`Clear ${placeholder.toLowerCase()} filter`}
          style={{ padding: '0 11px', border: 'none', borderLeft: `1px solid ${P.green}`, backgroundColor: P.greenPale, color: P.green, cursor: 'pointer', fontSize: '1rem', fontWeight: 700, lineHeight: 1, display: 'inline-flex', alignItems: 'center' }}
        >
          ×
        </button>
      )}
    </div>
  )
}

// Picker sheet (reuses the canonical Sheet fly-up): an "All" reset row + one row per option, the
// active row checked. Options come from useHarvestFilterOptions (the UNFILTERED universe), so the list
// never collapses when a filter is applied.
function PickerSheet({ open, onClose, title, allLabel, emptyText, selected, options, onSelect }) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div role="listbox" aria-label={title} style={{ padding: '2px 8px 8px', display: 'flex', flexDirection: 'column' }}>
        <PickerRow label={allLabel} selected={selected === ''} onClick={() => onSelect('', '')} />
        {options.length === 0 ? (
          <div style={{ padding: '14px 16px', fontSize: '0.85rem', color: P.light }}>{emptyText}</div>
        ) : (
          options.map((o) => (
            <PickerRow key={o.value} label={o.label} selected={selected === o.value} onClick={() => onSelect(o.value, o.label)} />
          ))
        )}
      </div>
    </Sheet>
  )
}

function PickerRow({ label, selected, onClick }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', padding: '12px 16px', minHeight: 44, background: selected ? P.greenPale : 'transparent', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: '0.92rem', fontWeight: selected ? 700 : 500, color: selected ? P.green : P.dark }}
    >
      <span>{label}</span>
      {selected && <span aria-hidden="true" style={{ color: P.green, fontWeight: 700 }}>✓</span>}
    </button>
  )
}

// ── Log ──────────────────────────────────────────────────────────────────────────────────────────
function LogView({ entries, filterActive, onClearFilters, hasMore, loadingMore, onLoadMore }) {
  if (!entries || entries.length === 0) {
    return filterActive
      ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: P.light }}>
          <p style={{ margin: '0 0 12px', fontSize: '0.95rem', fontWeight: 600, color: P.mid }}>No harvests match these filters.</p>
          <button type="button" onClick={onClearFilters} style={{ padding: '8px 18px', fontSize: '0.85rem', borderRadius: 8, border: `1px solid ${P.border}`, background: P.white, color: P.green, fontWeight: 700, cursor: 'pointer' }}>Clear filters</button>
        </div>
      )
      : <EmptyState emoji="🧺" title="Your harvests will collect here" body="The first one starts the season — log a harvest and it shows up here." />
  }
  const sections = groupByDay(entries)
  const year = new Date().getFullYear()
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

  const mainTo = !removed && !unassigned && e.project_id && e.plant_id
    ? `/projects/${e.project_id}/plantings/${e.plant_id}`
    // V4-PROJHIDE-001: an unassigned (plantless) harvest has no planting to open; don't fall back to
    // the hidden project page. Flag OFF keeps the project link.
    : (unassigned && !PROJECTS_HIDDEN && e.project_id ? `/projects/${e.project_id}` : null)
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
          {/* V4-PROJHIDE-001: this row shows for project-level (plantless) harvests — neutral wording
              when projects aren't user-facing. Flag OFF keeps the "Logged to {project}" copy. */}
          {removed ? 'planting removed' : (PROJECTS_HIDDEN ? 'Logged without a planting' : `Logged to ${e.project_name || 'a project'}`)}
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

// ── Totals (S3-a: per-crop rows expand IN PLACE — variety sub-rows, first-pick dates, unquantified
// count, "See in log →". Global sparkline + independent year selector = S3-b/S3-c.) ────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// Absolute, judgment-free first-pick date (design §6: neutral fact, never "9 days late"). "Jun 14";
// the year is appended only when it isn't the current calendar year. Pure string math on the day_key.
function fmtFirstPick(dayKey) {
  const [y, m, d] = String(dayKey).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return String(dayKey)
  const cur = new Date().getFullYear()
  return `${MONTHS[m - 1]} ${d}${y !== cur ? `, ${y}` : ''}`
}

function TotalsView({ aggregates, onSeeInLog }) {
  const [expanded, setExpanded] = useState(() => new Set())
  const crops = aggregates?.crops ?? []
  const other = aggregates?.other ?? []
  const firstPick = aggregates?.first_pick ?? []
  if (crops.length === 0 && other.length === 0) {
    return <EmptyState emoji="🧺" title="No totals yet" body="Once you log harvests, season totals show up here by crop." />
  }
  const toggle = (slug) => setExpanded((prev) => {
    const n = new Set(prev)
    if (n.has(slug)) n.delete(slug); else n.add(slug)
    return n
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {crops.map((c) => (
        <CropTotalRow
          key={c.crop_type_slug}
          crop={c}
          firstPicks={firstPick.filter((f) => f.crop_type_slug === c.crop_type_slug)}
          open={expanded.has(c.crop_type_slug)}
          onToggle={() => toggle(c.crop_type_slug)}
          onSeeInLog={onSeeInLog}
        />
      ))}
      {other.length > 0 && (
        <div style={{ background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 14px' }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: P.mid, marginBottom: 4 }}>Unassigned</div>
          {other.map((o) => (
            <div key={o.project_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: '0.84rem', color: P.mid, padding: '2px 0' }}>
              {/* V4-PROJHIDE-001: the Unassigned breakdown is grouped by project — neutral row label
                  when projects aren't user-facing. Flag OFF keeps the project name. */}
              <span>{PROJECTS_HIDDEN ? 'Unattributed' : (o.project_name || 'A project')}</span>
              <span style={{ fontWeight: 600 }}>{unitsLine(o.units, null) || `+${o.unquantified} unrecorded`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// One expandable crop total. Collapsed = crop name + per-unit season total + unquantified count.
// Expanded (in place) adds variety sub-rows, first-pick date per planting, and the See-in-log jump.
function CropTotalRow({ crop: c, firstPicks, open, onToggle, onSeeInLog }) {
  const varieties = Array.isArray(c.varieties) ? c.varieties : []
  // A single unnamed variety is just the crop total again — only surface sub-rows when they add info.
  const showVarieties = varieties.length > 1 || (varieties.length === 1 && !!varieties[0].variety_name)
  return (
    <div style={{ background: P.white, border: `1px solid ${P.border}`, borderRadius: 10 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '12px 14px', cursor: 'pointer', borderRadius: 10 }}
      >
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: '0.95rem', fontWeight: 700, color: P.dark, marginBottom: 2 }}>{c.crop_name}</span>
          <span style={{ display: 'block', fontSize: '0.88rem', color: P.green, fontWeight: 600 }}>{unitsLine(c.units, c.crop_name)}</span>
          {c.unquantified > 0 && (
            <span style={{ display: 'block', fontSize: '0.75rem', color: P.light, marginTop: 2 }}>+{c.unquantified} unrecorded</span>
          )}
        </span>
        <span aria-hidden="true" style={{ flex: '0 0 auto', color: P.light, fontSize: '0.8rem', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>▶</span>
      </button>
      {open && (
        <div style={{ padding: '0 14px 12px', borderTop: `1px solid ${P.border}` }}>
          {showVarieties && (
            <div style={{ marginTop: 8 }}>
              {varieties.map((v) => (
                <div key={v.variety_id ?? '__novar__'} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: '0.83rem', color: P.mid, padding: '3px 0' }}>
                  <span>{v.variety_name || 'Unspecified'}</span>
                  <span style={{ fontWeight: 600 }}>{unitsLine(v.units, c.crop_name) || (v.unquantified > 0 ? `+${v.unquantified} unrecorded` : '')}</span>
                </div>
              ))}
            </div>
          )}
          {firstPicks.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {firstPicks.map((f) => (
                <div key={f.plant_id} style={{ fontSize: '0.8rem', color: P.mid }}>
                  First pick {fmtFirstPick(f.first_pick_date)}{f.planting_name ? ` · ${f.planting_name}` : ''}
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => onSeeInLog?.(c.crop_type_slug, c.crop_name)}
            style={{ marginTop: 10, padding: '6px 0', background: 'transparent', border: 'none', color: P.green, fontSize: '0.83rem', fontWeight: 700, cursor: 'pointer' }}
          >
            See in log →
          </button>
        </div>
      )}
    </div>
  )
}

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
