// src/pages/Seeds.jsx — V5-SEEDSTAB-001. ONE home for seed: My seeds · Saved seeds · Sow now.
//
// Dave, 2026-09-18: "consolidate Seeds into a single tab - save seeds, sow now, inventory seeds, etc
// should have a home properly in the app." Design: project-state/design-seedshome-V102-20260918.md
// (crucibled; D1 = a More-menu row, D2 = the change list approved as listed).
//
// A SHELL, on HarvestLog's pattern: a title, the view's actions, a view switch, the ferment line, and
// ONLY the active view mounted. Saved seeds and Sow now keep their own logic byte-for-byte and render
// here with `embedded`; My seeds is new.
//
// WHAT THE SHELL OWNS, and why each lives here rather than in a view:
//   · THE SEED ROWS (useSeedItems). My seeds, Saved seeds and the ferment line read the same ~330
//     rows; one fetch, patched or reloaded on every write, keeps them from disagreeing one tap apart.
//   · THE FRAME. One max-width and one 16 px inset for all three views, so the content column does not
//     jump on a switch (Sow now's inset moved 20 -> 16 px; a named, re-baselined change).
//   · "SOWN ✓". Switching views unmounts Sow now, and a confirmation held there died with it.
//   · SAVE SEED. The sheet opens from the header on My seeds and Saved seeds and confirms IN PLACE
//     (onSaved): the new lot is outlined in the view you are on, and the page never switches view.
//
// THE URL IS THE VIEW (`?view=mine|saved|sow`), and view switches REPLACE: Android Back is Dave's
// primary gesture, and a push per switch would make Back walk him through his own indecision instead
// of leaving the page. A door that names a view opens it. A bare /seeds settles its view ONCE, while
// the body is still loading, and writes it into the URL with replace BEFORE any view mounts — the
// views' scroll restore keys on the history entry, and a replace after they mounted would re-key it
// (and would delete an armed sheet's Back marker). After that nothing writes the URL except a switch
// the user makes, which can only happen with no sheet open.
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import ErrorBoundary from '../components/ErrorBoundary.jsx'
import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { useSeedItems } from '../hooks/useSeedItems.js'
import { dueFerments, hasLotInProcess } from '../components/seed/seedLots.js'
import {
  SEEDS_VIEWS, resolveView, seedsHref, addPacketHref, seedsReturnState, peekSeedAdded, clearSeedAdded,
} from '../lib/seedsRoutes.js'
import { P } from '../lib/constants.js'
import { T } from '../components/forms/formStyles.js'
import MySeeds from './MySeeds.jsx'
import SavedSeeds from './SavedSeeds.jsx'
import SowNow from './SowNow.jsx'

// A second orientation cue beside the switch, whose active state is weak (BUG-SEGCTRLCONTRAST-001).
const QUESTION = {
  mine:  'What seed do I have?',
  saved: 'Where is the seed I’m saving?',
  sow:   'What can I sow now?',
}

const MINE_HREF = seedsHref('mine')

// §4.2 — the view a bare /seeds lands on: Saved seeds while any lot is fermenting or drying (the
// likeliest task, and it stays stable for weeks), else My seeds; never Sow now. A failed load lands on
// My seeds, which says so and offers Retry. Urgency is NOT carried by the landing — the ferment line
// under the switch carries it on every view.
export function defaultSeedsView(items, error) {
  if (items == null) return error ? 'mine' : null
  return hasLotInProcess(items) ? 'saved' : 'mine'
}

export default function Seeds() {
  const [params, setParams] = useSearchParams()
  const view = resolveView(params.get('view'))
  const store = useSeedItems()

  // Settle a bare (or unrecognised) view once the rows are in, before any body mounts.
  const settledRef = useRef(false)
  useEffect(() => {
    if (view || settledRef.current) return
    const next = defaultSeedsView(store.items, store.error)
    if (!next) return
    settledRef.current = true
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      p.set('view', next)
      return p
    }, { replace: true })
  }, [view, store.items, store.error, setParams])

  const switchView = useCallback((next) => {
    if (next === view) return
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      p.set('view', next)
      p.delete('lot')
      return p
    }, { replace: true })
  }, [view, setParams])

  // ── Outline a lot once (§4.6) ────────────────────────────────────────────────────────────────────
  // `?lot=` is the arrival hint (seq 0 — a view that restored a scroll position ignores it). A write
  // made here outlines its own row with a fresh seq, so the same lot can be outlined again.
  const seqRef = useRef(0)
  const [highlight, setHighlight] = useState(() => {
    // A row the add form just created (it left with navigate(-1) and could carry nothing back).
    const added = peekSeedAdded()
    if (added) { seqRef.current = 1; return { id: added, seq: 1 } }
    const lot = params.get('lot')
    return lot ? { id: lot, seq: 0 } : null
  })
  useEffect(() => { clearSeedAdded() }, [])
  const outline = useCallback((id) => {
    if (id == null) return
    seqRef.current += 1
    setHighlight({ id: String(id), seq: seqRef.current })
  }, [])
  // Bring a lot into view in Saved seeds: the ferment line and "Change stage in Saved seeds →".
  const goToLot = useCallback((id) => {
    if (view !== 'saved') switchView('saved')
    outline(id)
  }, [view, switchView, outline])

  const [sownIds, setSownIds] = useState(() => new Set())
  const onSown = useCallback((id) => setSownIds((prev) => new Set(prev).add(id)), [])
  const onArchived = useCallback((id, season) => {
    store.patch(id, (row) => ({ ...row, sow_archived_season: season }))
  }, [store.patch])  // eslint-disable-line react-hooks/exhaustive-deps

  const [saving, setSaving] = useState(false)
  const onSaved = useCallback((lot) => {
    store.reload()
    if (lot?.id) outline(lot.id)
  }, [store.reload, outline])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div data-testid="seeds-page" style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={frameStyle}>
        <div style={headerStyle}>
          <h1 style={titleStyle}>Seeds</h1>
          <div data-testid="seeds-actions" style={actionsStyle}>
            {view === 'mine' && (
              <>
                <Link
                  to={addPacketHref(MINE_HREF)}
                  state={seedsReturnState(MINE_HREF)}
                  data-testid="seeds-add"
                  style={filledAction}
                >
                  + Add seeds
                </Link>
                <button type="button" onClick={() => setSaving(true)} data-testid="seeds-save-seed" style={outlinedAction}>
                  Save seed
                </button>
              </>
            )}
            {view === 'saved' && (
              <button type="button" onClick={() => setSaving(true)} data-testid="seeds-save-seed" style={filledActionBtn}>
                + Save seed
              </button>
            )}
          </div>
        </div>

        <div style={{ marginBottom: 8 }}>
          <SegmentedControl
            small
            options={SEEDS_VIEWS}
            value={view ?? undefined}
            onChange={switchView}
            ariaLabel="Which seeds"
            data-testid="seeds-view-switch"
          />
        </div>

        <FermentLine items={store.items} onGo={goToLot} />

        {view && view !== 'sow' && <StaleBand store={store} />}

        {view && <p data-testid="seeds-question" style={questionStyle}>{QUESTION[view]}</p>}

        {!view && <AsyncRegion loading />}

        {/* One boundary PER VIEW, keyed on it, with the header and switch outside: a Sow now engine
            throw (sowEngine.js:1391 documents one class) costs that view and leaves the other two one
            tap away — the crash isolation /sow and /seeds/saved had as separate routes. */}
        {view && (
          <ErrorBoundary key={view} scope={`seeds-${view}`} fallback={<ViewFallback />}>
            {view === 'mine' && <MySeeds store={store} highlight={highlight} onGoToLot={goToLot} />}
            {view === 'saved' && <SavedSeeds embedded store={store} highlight={highlight} onHighlight={outline} />}
            {view === 'sow' && <SowNow embedded sownIds={sownIds} onSown={onSown} onArchived={onArchived} />}
          </ErrorBoundary>
        )}
      </div>

      {/* Opened with NO planting prop, deliberately: the sheet asks where the seed came from, and the
          variety arrives through its picker — the projection that carries the F1 notice. A synthetic
          planting here would switch the sheet to the planting branch and silence that notice. */}
      {saving && <SaveSeedSheet onClose={() => setSaving(false)} onSaved={onSaved} />}
    </div>
  )
}

// The ferment line (§4.5): the app's only overdue-ferment warning, under the switch on EVERY view, so
// it cannot live only on the view you are not looking at. Ambient text — no toast, badge, push or
// sound (Reward UX V102 puts interrupts out of scope, and this is operational either way). Once shown
// it keeps its height for the rest of the visit, so a write that clears the last due ferment does not
// jolt the list up under the outline that write is showing.
function FermentLine({ items, onGo }) {
  const due = useMemo(() => dueFerments(items), [items])
  const shownRef = useRef(false)
  if (due.length) shownRef.current = true
  if (!due.length && !shownRef.current) return null
  if (!due.length) return <div aria-hidden="true" style={{ ...fermentStyle, visibility: 'hidden' }}>·</div>
  const first = due[0]
  const name = first.item.variety_name || first.item.name || 'A lot'
  const text = due.length === 1
    ? `${name} ferment — day ${first.days}, ${first.level === 'alarm' ? 'overdue' : 'check it'}`
    : `${due.length} ferments need checking`
  return (
    <button
      type="button"
      data-testid="seeds-ferment-line"
      data-level={first.level}
      onClick={() => onGo(first.item.id)}
      style={{ ...fermentStyle, color: first.level === 'alarm' ? P.severityUrgent : P.statusInkGold }}
    >
      <span style={{ fontWeight: 600 }}>{text}</span>
      <span> · Saved seeds →</span>
    </button>
  )
}

// Offline, or a refresh that failed after the rows landed: the rows on screen may be old, so say so and
// offer Retry. A cached list presented as fresh is exactly how a ferment reads "day 3" off last
// week's copy.
function StaleBand({ store }) {
  const offline = store.fromCache
  const refreshFailed = !!store.error && store.items != null
  if (!offline && !refreshFailed) return null
  return (
    <div data-testid="seeds-stale" role="status" style={staleStyle}>
      <span style={{ flex: 1 }}>
        {offline ? 'Offline — showing the last copy saved on this phone.' : 'Couldn’t refresh — showing the last copy.'}
      </span>
      <button type="button" onClick={store.reload} style={staleRetry}>Retry</button>
    </div>
  )
}

function ViewFallback({ retry }) {
  return (
    <div role="alert" data-testid="seeds-view-error" style={{ padding: '24px 0', textAlign: 'center', color: P.terra }}>
      <p style={{ margin: '0 0 10px' }}>This view failed to load. The other two still work.</p>
      <button type="button" onClick={retry} style={staleRetry}>Try again</button>
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────────────────────────
const frameStyle = { maxWidth: 720, margin: '0 auto', padding: '20px 16px 90px' }
// Identical height on every view: the action slot is always there, empty on Sow now, so the switch
// and everything under it sit at the same place whichever view is showing.
const headerStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
  minHeight: T.buttonMinHeight, marginBottom: 10,
}
const titleStyle = { margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }
const actionsStyle = { display: 'flex', alignItems: 'center', gap: 8, minHeight: T.buttonMinHeight }
const actionBase = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: T.tapMinHeight,
  padding: '0 12px', borderRadius: T.radiusButton, fontSize: T.type.sm, fontWeight: 700,
  textDecoration: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}
const filledAction = { ...actionBase, backgroundColor: P.green, color: P.white, border: 'none' }
const filledActionBtn = { ...filledAction }
const outlinedAction = { ...actionBase, backgroundColor: P.white, color: P.green, border: `1px solid ${P.green}` }
const fermentStyle = {
  display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '6px 0',
  minHeight: T.tapMinHeight, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit',
}
const questionStyle = { margin: '6px 0 12px', color: P.mid, fontSize: T.type.sm }
const staleStyle = {
  display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 10px', padding: '8px 12px',
  backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: T.radiusButton,
  color: P.dark, fontSize: T.type.sm,
}
const staleRetry = {
  minHeight: T.tapMinHeight, padding: '0 12px', borderRadius: T.radiusButton, border: `1px solid ${P.border}`,
  backgroundColor: P.white, color: P.dark, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
