import React, { useState, useRef, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { P } from '../lib/constants.js'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import Sheet from '../components/forms/Sheet.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import QualityDots from '../components/QualityDots.jsx'
import StatTile from '../components/StatTile.jsx'
import Sparkline from '../components/Sparkline.jsx'
import HarvestTimeframeChips from '../components/HarvestTimeframeChips.jsx'
import HarvestExportSheet from '../components/HarvestExportSheet.jsx'
import { useHarvests } from '../hooks/useHarvests.js'
import { useHarvestSnapshot } from '../hooks/useHarvestSnapshot.js'
import { useHarvestFilterOptions } from '../hooks/useHarvestFilterOptions.js'
import { groupByDay, dayLabel, relativeDay } from '../lib/harvestGrouping.js'
import { fmtQuantity, unitLabel, formatEntry, unitsLine, fmtFirstPick, addDays, etDay } from '../lib/harvestSummary.js'
import { describeHarvestWeight, weightBasisLabel, formatGrams, weightParts, NO_WEIGHT_COPY } from '../lib/harvestWeight.js'
import { currentGrowYear, growYearOfDayKey, growYearSpan, growYearOptions, HARVEST_TZ } from '../lib/growYear.js'
import { PROJECTS_HIDDEN, HARVEST_QUALITY_HIDDEN } from '../lib/featureFlags.js'
import useScrollRestore from '../hooks/useScrollRestore.js'

// V4-SCROLLRESTORE-001 (BD0806-05) — how many extra keyset pages a Back will re-walk. useHarvests
// pages by opaque CURSOR, so depth cannot be re-requested in one shot the way FeedPage does it with
// a raised limit; each page needs the previous page's cursor. Two extra requests is the budget, the
// same reach FeedPage's limit=90 buys. Deeper than that, the restore lands at the bottom of what
// came back with "Earlier this season" still offered — strictly better than page 1.
const MAX_RESTORE_PAGES = 2

// Harvests — V4-HARVESTVIEW-001 S2a/S2b + S4 (V4-HARVDEFAULT-001). Route + snapshot strip + Log feed
// + Totals, reading the shipped GET /api/harvests. Retrospective/reflective: never prompts, counts
// down, or scores (design §1). Snapshot self-labels FIXED windows (design §3b) so it's independent of
// the Log filter. Crop/project scope the LOG only (design §3b) — they're dropped from the query on
// the Totals tab. S4: bare arrivals land on TOTALS scoped to the season (BD-004 — Dave's stated
// retrieval mode is totals); the season chip + grow-year sheet live in HarvestTimeframeChips; per-crop
// sparklines ride the additive crops[].weekly Lambda field.

export default function Harvests() {
  // S4: EventNew's post-harvest line + PlantingDetail's "All harvests →" land here pre-filtered to a
  // crop via ?crop=<slug>. Seeded once on mount; the pickers drive local state from there (no two-way
  // URL sync in V1 — server-persisted last filter is a named phase-2 item, design §9).
  const [searchParams] = useSearchParams()
  // V4-HARVDEFAULT-001: bare arrivals default to TOTALS; a ?crop= arrival keeps landing on the LOG.
  // The ?crop= guard protects the live producer PlantingDetail's "All harvests →" and the deep-link
  // pin below — an aggregate row is not "all harvests" for the planting the user just left.
  const arrivedWithCrop = !!searchParams.get('crop')

  // ── V4-SCROLLRESTORE-001 (BD0806-05) — back-nav restore ─────────────────────────────────────────
  //
  // This page needs more than an offset, and the reason is structural rather than a nicety. Every
  // row in the Log deep-links out (a planting, or the event editor), so Back-to-/harvests is the
  // ordinary way back — and on that Back the page rebuilds from nothing: it lands on TOTALS (the
  // V4-HARVDEFAULT-001 bare-arrival default), with no filters, holding one page of entries. Aiming a
  // restored 1,400px offset at that is not a near miss; it is a different document, and the browser
  // clamps it to the bottom of a page the user was never on. So the whole shape the offset was
  // measured against comes back with it: which view, the filter machine's state, and the depth.
  //
  // The filter tuple is restored WHOLE, never in part — the timeframe together with the default it
  // is judged against and the touched flag — because `filterActive` and the off-season re-anchor
  // effect both read those three as a set. Restoring a subset is how you get a page claiming a
  // filter is active when it is showing the default, or re-anchoring the timeframe out from under a
  // scroll position that was just restored against the old one.
  //
  // This is NOT filter persistence, and does not pre-empt the server-persisted last filter that
  // design §9 names as phase 2: the hook only returns state for a history entry that has a real
  // scroll offset filed against it, so a fresh arrival, a forward navigation, a new tab, and a user
  // who never scrolled all behave exactly as they did before.
  const [restoreReady, setRestoreReady] = useState(false)
  const { restoredState, saveState } = useScrollRestore({ id: 'harvests', ready: restoreReady })
  // Shape-checked, not trusted: the hook mirrors into sessionStorage, so this value is whatever that
  // blob contains. Every field below re-checks its own type and falls through to the shipped
  // default, so a partial or hand-edited entry degrades to today's behaviour rather than to a crash.
  const restored = restoredState && typeof restoredState === 'object' ? restoredState : null
  const restoredStr = (v, fallback) => (typeof v === 'string' ? v : fallback)

  const [view, setView] = useState(() => (
    restored?.v === 'log' || restored?.v === 'totals' ? restored.v : (arrivedWithCrop ? 'log' : 'totals')
  )) // 'log' | 'totals'
  // V4-HARVDEFAULT-001 + boss condition C1: the bare-arrival default timeframe is the CURRENT
  // grow-year (from season 2 on, an all-time blend dilutes "what THIS season gave" into a number that
  // never visibly moves off-season). ?crop= arrivals keep '' (All time) — silently rescoping the
  // shipped "All harvests →" link to one season would contradict its own label and render an EMPTY
  // log for prior-season/overwintered plantings.
  const [timeframe, setTimeframe] = useState(() => (
    restoredStr(restored?.tf, arrivedWithCrop ? '' : `season:${currentGrowYear(new Date())}`)
  )) // '' = all time
  const [crop, setCrop] = useState(() => restoredStr(restored?.c, searchParams.get('crop') || '')) // crop_type_slug; '' = all crops
  const [cropLabel, setCropLabel] = useState(() => restoredStr(restored?.cl, ''))
  const [project, setProject] = useState(() => restoredStr(restored?.p, '')) // project_id (uuid); '' = all projects
  const [projectLabel, setProjectLabel] = useState(() => restoredStr(restored?.pl, ''))
  const [cropSheetOpen, setCropSheetOpen] = useState(false)
  const [projectSheetOpen, setProjectSheetOpen] = useState(false)
  // V4-HARVEXPORT-001: the page has no overflow menu (and minting one to HIDE a Dave-requested
  // feature is the worst scent), so Export is a visible header-right text affordance.
  const [exportOpen, setExportOpen] = useState(false)
  // The arrival DEFAULT is not a user-chosen filter: the empty-state chooser + clear-filters
  // affordance must not read it as one (a first-run user at the untouched default sees first-run
  // copy, never "No harvests match these filters"). Updated if the off-season effect re-anchors.
  // V4-SCROLLRESTORE-001: restored together with `timeframe`, never separately — the pair is what
  // `filterActive` compares, so restoring one without the other is what makes a page show the
  // "Clear filters" empty state over its own untouched default.
  const defaultTimeframeRef = useRef(restoredStr(restored?.dtf, arrivedWithCrop ? '' : `season:${currentGrowYear(new Date())}`))
  const timeframeTouched = useRef(restored?.tt === true)
  const changeTimeframe = (v) => { timeframeTouched.current = true; setTimeframe(v) }

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
  const { crops: cropOptions, projects: projectOptions, minFirstPickDay } = useHarvestFilterOptions()
  // A filter is ACTIVE when the user narrowed something: crop/project, or a timeframe that is
  // neither All time (the widest scope — it can hide nothing) nor the untouched arrival default.
  const filterActive = crop !== '' || project !== '' || (timeframe !== '' && timeframe !== defaultTimeframeRef.current)

  // V4-HARVDEFAULT-001 — canon harvest-view §5 OFF-SEASON rule: a bare arrival re-anchors ONCE to the
  // LAST COMPLETED season when the current one reads off-season — no harvest in >30 days (or none at
  // all this season) while earlier-season history exists. January seed-ordering runs on exactly the
  // last completed season's data; a near-empty current season would pin a number that never moves.
  // Data-driven, never calendar-gated; skipped the moment the user touches the timeframe, and never
  // on a ?crop= arrival (boss C1 — that arrival stays All time).
  // V4-SCROLLRESTORE-001: a restored entry counts as already re-anchored. Its saved timeframe/default
  // pair IS the outcome of this effect on the visit being restored, so re-running it could only
  // either no-op or move the timeframe — and moving it would swap the list out from under a scroll
  // offset that was measured against the old one, which is the exact failure this restore exists to
  // prevent. "Once" is per user-visit, and a Back is the same visit.
  const reanchored = useRef(!!restored)
  useEffect(() => {
    if (arrivedWithCrop || timeframeTouched.current || reanchored.current || !snapshot) return
    const cur = currentGrowYear(new Date())
    if (timeframe !== `season:${cur}`) return
    const minYear = growYearOfDayKey(minFirstPickDay)
    if (minYear == null || minYear >= cur) return // no earlier-season history to fall back on
    const lastKey = snapshot.lastHarvest?.day_key ?? null
    const offSeason = lastKey == null || lastKey < addDays(etDay(new Date(), HARVEST_TZ), -30)
    if (!offSeason) return
    reanchored.current = true
    defaultTimeframeRef.current = `season:${cur - 1}`
    setTimeframe(`season:${cur - 1}`)
  }, [arrivedWithCrop, snapshot, minFirstPickDay, timeframe])

  // Season-sheet universe: continuous range from the earliest harvest's grow-year (UNFILTERED
  // all-time first_pick, design §2b — the page's own aggregates are timeframe-scoped and would
  // self-collapse) up to the current season. Empty seasons included; they render the honest empty state.
  const seasonYears = growYearOptions(minFirstPickDay, currentGrowYear(new Date()))

  // V4-SCROLLRESTORE-001, the depth half. Re-walk the Log to the number of entries the user had
  // opened before letting the offset restore fire; without it the offset aims at a one-page document
  // and the browser clamps it. Bounded twice — by request count (MAX_RESTORE_PAGES) and by the
  // server's own cursor running out — so a page that keeps answering without growing `entries` can
  // never turn one Back into an unbounded fetch loop. Only the Log pages; Totals has no depth.
  const restoredDepth = view === 'log' && Number.isFinite(restored?.n) ? restored.n : 0
  const [depthRestored, setDepthRestored] = useState(false)
  const depthWalks = useRef(0)
  useEffect(() => {
    if (depthRestored || loading || loadingMore) return
    if (entries.length >= restoredDepth || !hasMore || depthWalks.current >= MAX_RESTORE_PAGES) {
      setDepthRestored(true)
      return
    }
    depthWalks.current += 1
    loadMore()
  }, [depthRestored, loading, loadingMore, hasMore, entries.length, restoredDepth]) // eslint-disable-line react-hooks/exhaustive-deps

  // The hook's `ready` is fed through state rather than passed inline, because the value it gates on
  // (`loading`, from useHarvests) is only available BELOW the hook call — and the hook has to be
  // called above the useState initializers that read its restored view/filter state.
  useEffect(() => { if (!loading && depthRestored) setRestoreReady(true) }, [loading, depthRestored])

  useEffect(() => {
    saveState({
      v: view, tf: timeframe, dtf: defaultTimeframeRef.current, tt: timeframeTouched.current,
      c: crop, cl: cropLabel, p: project, pl: projectLabel, n: entries.length,
    })
  }, [saveState, view, timeframe, crop, cropLabel, project, projectLabel, entries.length])

  const clearAll = () => { setTimeframe(''); setCrop(''); setCropLabel(''); setProject(''); setProjectLabel('') }
  // "See in log →" from an expanded Totals crop row: filter the Log to that crop and switch tabs
  // (design §3c: a Totals crop-row tap switches to Log with a visible dismissible filter pill).
  const seeInLog = (slug, name) => { setCrop(slug); setCropLabel(name); setView('log') }

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '24px 16px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h1 style={{ margin: '0 0 2px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Harvests</h1>
            <p style={{ margin: '0 0 16px', fontSize: '0.82rem', color: P.light }}>What the garden gave you.</p>
          </div>
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            style={{ flex: '0 0 auto', minHeight: 48, padding: '0 6px', background: 'transparent', border: 'none', color: P.green, fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer' }}
          >
            Export
          </button>
        </div>

        <SnapshotStrip snapshot={snapshot} onOpenLog={() => setView('log')} onOpenTotals={() => setView('totals')} />

        <div style={{ marginBottom: 12 }}>
          <SegmentedControl
            options={[{ value: 'log', label: 'Log' }, { value: 'totals', label: 'Totals' }]}
            value={view}
            onChange={setView}
            ariaLabel="Harvests view: Log or Totals"
          />
        </div>

        {/* ONE shared timeframe control above BOTH views (design §2b) — the season chip + grow-year
            sheet live inside it, so no invisible active filter is representable across the toggle. */}
        <HarvestTimeframeChips value={timeframe} onChange={changeTimeframe} seasonYears={seasonYears} />

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
          <TotalsView aggregates={aggregates} onSeeInLog={seeInLog} timeframe={timeframe} />
        )}
      </div>

      {/* The sheet OWNS its fetch, seeded from the page's current view/filters — it opens ready, not
          as a configuration wall (design §2c). Mounted only while open so its load effect can't run
          behind the page. */}
      {exportOpen && (
        <HarvestExportSheet
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          defaultFormat={view === 'log' ? 'log' : 'totals'}
          initialTimeframe={timeframe}
          initialCrops={crop ? [crop] : []}
          cropOptions={cropOptions}
          seasonYears={seasonYears}
        />
      )}

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
    // V4-PROJHIDE-001: keep the planting deep-link; drop the bare-project fallback when projects are
    // hidden (tile becomes non-navigable). Flag OFF unchanged.
    // BUG-SEARCHDEADTAP-001: the planting arm no longer requires project_id — it links to the
    // CANONICAL un-scoped route (App.jsx:199, V4-UNSCOPEDROUTES-001), so a Snap-created planting with
    // no project_id is reachable instead of falling through to a bare-project link or to null.
    ? (lh.plant_id && !lh.planting_removed ? `/plantings/${lh.plant_id}` : (!PROJECTS_HIDDEN && lh.project_id ? `/projects/${lh.project_id}` : null))
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

// (S4: the timeframe chip row moved to src/components/HarvestTimeframeChips.jsx — the ONE shared
// control, reused by the export sheet — and grew the season chip + grow-year sheet there.)

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
  // V4-BACKNAV-001 Slice P — Android Back closes the picker instead of leaving /harvests. Safe here
  // because the picker opens and closes IN PLACE: selecting a row sets local filter state and closes,
  // it never navigates, so the pushed entry is always still on top and is always consumed.
  // `id` is per-instance (there are two PickerSheets on this page — crop and project) so the two
  // never mistake each other's marker for their own.
  return (
    <Sheet open={open} onClose={onClose} title={title} armsBack>
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
  // V4-HARVWEIGHTREAD-001. The native-unit amount above stays THE headline — grams are a second axis,
  // not a replacement, because "6 zucchini" is what was picked and 1.4 kg is what it weighed.
  // The no-weight chip is deliberately suppressed on rows with no amount either: a harvest with
  // nothing recorded is already saying so on the line above, and repeating it adds noise to the
  // one row that is least informative.
  const wt = describeHarvestWeight(e)

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
        {/* V4-HIDEQUALITY-001: output side of the same hide. The row still CARRIES quality_rating
            from the API — only the rendering is gated, so a rollback needs no data backfill. */}
        {!HARVEST_QUALITY_HIDDEN && <QualityDots value={e.quality_rating} />}
        {/* V4-HARVWEIGHTSURF-001. The previous comment here named the hazard and then shipped into
            it: "a symbol nobody hovers is not a disclosure" — and then delivered the disclosure
            through title=, which NOBODY CAN HOVER on Chrome for Android, the only browser this app
            is read in. So the ≈ was carrying the meaning alone after all, on the ~63% of rows whose
            weight was never actually weighed. The basis now renders as VISIBLE TEXT beside the
            number. It is ambient by construction — plain text, no tap target, no popover, nothing
            to dismiss. title= is kept for pointer devices, where it still adds the full sentence
            this chip has no room for. */}
        {wt.state !== 'none' && (
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, minWidth: 0 }}>
            <span
              data-testid="harvest-weight"
              title={wt.sourceCopy ?? 'Weighed.'}
              aria-label={`${wt.estimated ? 'Estimated weight' : 'Weighed'}: ${wt.text}`}
              style={{ fontSize: '0.74rem', fontWeight: 600, color: wt.estimated ? P.light : P.green, whiteSpace: 'nowrap' }}
            >
              {wt.estimated ? `≈ ${wt.text}` : wt.text}
            </span>
            <span aria-hidden="true" style={{ fontSize: '0.72rem', color: P.light }}>·</span>
            {/* Deliberately NOT whiteSpace:nowrap. The number must never wrap mid-value, but the
                label may — at 390px an unbreakable label widens the row's min-content past the
                viewport, which is exactly how a prior harvest-row change overflowed horizontally
                (min-content 399px against a 390px screen). Letting it break caps the row's
                min-content at the widest single WORD instead of the widest string. */}
            <span data-testid="harvest-weight-basis" style={{ fontSize: '0.72rem', color: P.light, minWidth: 0 }}>
              {weightBasisLabel(e)}
            </span>
          </span>
        )}
        {wt.state === 'none' && hasQty && (
          <span
            data-testid="harvest-weight-none"
            title={NO_WEIGHT_COPY}
            style={{ fontSize: '0.74rem', color: P.light, whiteSpace: 'nowrap' }}
          >
            no weight yet
          </span>
        )}
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
// (S5: fmtFirstPick + unitsLine + weightParts moved to src/lib — the Totals EXPORT renders the same
// strings from the same code, which is the only way "the export reconciles with the page" stays true.)

// V4-HARVESTVIEW-001 S4 (sparkline): map a crop's ADDITIVE weekly[] field to bare Sparkline values.
// Absent field (older Lambda — the frontend deploys ahead and a rollback must hold) -> null, render
// nothing: the TotalsWeight precedent. Under All time the marks window to the CURRENT season
// (all-years-in-one-row is unreadable and undefined, design §2b); every other timeframe is already
// server-scoped, so the buckets pass through as-is.
function sparkValues(weekly, timeframe) {
  if (!Array.isArray(weekly)) return null
  let rows = weekly
  if (!timeframe) {
    const span = growYearSpan(currentGrowYear(new Date()))
    rows = weekly.filter((w) => w.week_start >= span.start && w.week_start < span.end)
  }
  return rows.map((w) => Number(w.count))
}

function TotalsView({ aggregates, onSeeInLog, timeframe }) {
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
      <TotalsWeight weight={aggregates?.weight} />
      {crops.map((c) => (
        <CropTotalRow
          key={c.crop_type_slug}
          crop={c}
          firstPicks={firstPick.filter((f) => f.crop_type_slug === c.crop_type_slug)}
          sparkValues={sparkValues(c.weekly, timeframe)}
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
function CropTotalRow({ crop: c, firstPicks, sparkValues, open, onToggle, onSeeInLog }) {
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
          <CropWeightLine weight={c.weight} />
          {c.unquantified > 0 && (
            <span style={{ display: 'block', fontSize: '0.75rem', color: P.light, marginTop: 2 }}>+{c.unquantified} unrecorded</span>
          )}
          {/* S4 sparkline: null when crops[].weekly is absent (older Lambda) — renders NOTHING. */}
          {sparkValues && sparkValues.length > 0 && (
            <span style={{ display: 'block', marginTop: 6 }}>
              <Sparkline values={sparkValues} ariaLabel={`${c.crop_name}: weekly harvest activity`} />
            </span>
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
                  First pick {fmtFirstPick(f.first_pick_date, new Date().getFullYear())}{f.planting_name ? ` · ${f.planting_name}` : ''}
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

// ── Weight on the aggregates surface (V4-HARVWEIGHTREAD-001) ───────────────────────────────────────
// The weight objects come off GET /api/harvests already summed — grams are `numeric` in Postgres, so
// the arithmetic happens there and arrives exact — and they carry the SAME field names
// sumHarvestWeights() produces client-side (grams/measured/estimated/unweighed), so this surface,
// PlantingDetail's per-planting total and the log row chip cannot drift apart in meaning.
//
// The counts are never optional next to a number. A bare "12 kg" claims every gram was weighed,
// which is false for nearly every row today; the qualifier prints in a fixed order (weighed /
// estimated / no weight yet), each clause dropped only when its count is zero — the same phrasing
// PlantingWeightTotal uses in src/pages/PlantingDetail.jsx.

// The whole-universe total, above the crop rows. "Total weight", NOT "season weight": the timeframe
// chips still scope the Totals tab (only crop/project are dropped there), so a Last-7-days number
// labelled as the season would be wrong four times out of five.
//
// `weight` is undefined against a harvests Lambda older than this feature — the frontend can and
// does deploy ahead of it. That renders NOTHING: the old response cannot distinguish "no weight
// recorded" from "this API doesn't compute weight", and only the first is safe to tell Dave.
function TotalsWeight({ weight }) {
  if (!weight) return null
  const parts = weightParts(weight)
  if (parts.length === 0) return null
  const text = formatGrams(weight.grams)
  return (
    <div style={{ background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: P.light, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total weight</div>
      {text ? (
        <div
          data-testid="totals-weight"
          aria-label={`${weight.estimated > 0 ? 'Estimated total' : 'Total'} harvest weight: ${text}`}
          style={{ fontSize: '1.05rem', fontWeight: 700, color: P.green, marginTop: 2 }}
        >
          {weight.estimated > 0 ? `≈ ${text}` : text}
        </div>
      ) : (
        <div data-testid="totals-weight-none" style={{ fontSize: '0.85rem', color: P.light, marginTop: 2 }}>{NO_WEIGHT_COPY}</div>
      )}
      <div data-testid="totals-weight-basis" style={{ fontSize: '0.75rem', color: P.light, marginTop: 2 }}>{parts.join(' · ')}</div>
    </div>
  )
}

// The same two lines on a crop row, under its native-unit line — which stays the headline, exactly as
// on the log: "14 tomatoes" is what was picked, 1.4 kg is what it weighed. Spans, because this
// renders inside the row's expand button.
function CropWeightLine({ weight }) {
  if (!weight) return null
  const text = formatGrams(weight.grams)
  if (text == null) {
    // Nothing weighable under this crop. Row-level, so it borrows the log row's short chip +
    // title pairing rather than the full sentence, which would repeat once per crop and stop being
    // read. The counts line goes with it: with no number to qualify, "2 with no weight yet" is the
    // same fact twice — the same double-negative suppression the log row does.
    if (weight.unweighed === 0) return null
    return (
      <span data-testid="crop-weight-none" title={NO_WEIGHT_COPY} style={{ display: 'block', fontSize: '0.75rem', color: P.light, marginTop: 2 }}>
        no weight yet
      </span>
    )
  }
  return (
    <>
      <span
        data-testid="crop-weight"
        aria-label={`${weight.estimated > 0 ? 'Estimated total' : 'Total'} harvest weight: ${text}`}
        style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: P.green, marginTop: 2 }}
      >
        {weight.estimated > 0 ? `≈ ${text}` : text}
      </span>
      <span data-testid="crop-weight-basis" style={{ display: 'block', fontSize: '0.72rem', color: P.light }}>
        {weightParts(weight).join(' · ')}
      </span>
    </>
  )
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
  return <AsyncRegion error={message} errorTitle="Couldn’t load your harvests" onRetry={onRetry} />
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
