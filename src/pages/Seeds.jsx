// ONE home for seed: My seeds, Saved seeds and Sow now (reached from a More-menu row).
//
// A shell, on HarvestLog's pattern: a title, the view's actions, a view switch, the ferment line, and
// ONLY the active view mounted. Saved seeds and Sow now keep their own logic and render here with
// `embedded`; My seeds is new.
//
// What the shell owns, and why each lives here rather than in a view:
//   · The seed rows (useSeedItems). My seeds, Saved seeds and the ferment line read the same rows; one
//     fetch, patched or reloaded on every write, keeps them from disagreeing one tap apart.
//   · The frame. One max-width and one 16 px inset for all three views, so the content column does not
//     jump on a switch.
//   · "Sown ✓". Switching views unmounts Sow now, so the confirmation is held here with the planting each
//     sow created, and the chip's "See the planting" link survives a view switch too.
//   · Save seed. The sheet opens from the header on My seeds and Saved seeds and confirms IN PLACE
//     (onSaved): the new lot is outlined in the view you are on, and the page never switches view.
//
// The URL is the view (`?view=mine|saved|sow`), and view switches REPLACE: on Android Back is the
// primary gesture, and a push per switch would make Back walk through the switches instead of leaving
// the page. A door that names a view opens it. A bare /seeds settles its view ONCE, while the body is
// still loading, and writes it into the URL with replace BEFORE any view mounts: the views' scroll
// restore keys on the history entry, and a replace after they mounted would re-key it (and would delete
// an armed sheet's Back marker). After that nothing writes the URL except a switch the user makes,
// which can only happen with no sheet open.
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

// A second orientation cue beside the switch, whose active state is weak.
const QUESTION = {
  mine:  'What seed do I have?',
  saved: 'Where is the seed I’m saving?',
  sow:   'What can I sow now?',
}

const MINE_HREF = seedsHref('mine')

// The view a bare /seeds lands on: Saved seeds while any lot is fermenting or drying (the
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

  // Settle a bare (or unrecognised) view once the rows are in, before any body mounts. Keyed on the
  // URL, not on the mount: More → Seeds while already on Seeds lands on a bare /seeds with this page
  // still mounted, and a once-per-mount guard left that visit on the loading state forever.
  useEffect(() => {
    if (view) return
    const next = defaultSeedsView(store.items, store.error)
    if (!next) return
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
  // Bring a lot into view in Saved seeds: the ferment line, and "Change stage in Saved seeds →" on My
  // seeds rows and on Sow now's "Still in process" cards.
  const goToLot = useCallback((id) => {
    if (view !== 'saved') switchView('saved')
    outline(id)
  }, [view, switchView, outline])
  // A switch the USER makes ends the last highlight: a view mounts fresh on every switch, and one still
  // holding an old highlight would clear the filters the user set there and scroll back to the lot on
  // every return.
  const userSwitch = useCallback((next) => {
    if (next === view) return
    setHighlight(null)
    switchView(next)
  }, [view, switchView])

  // Packet id -> the planting its sow created (null when the create named none).
  const [sownIds, setSownIds] = useState(() => new Map())
  const onSown = useCallback((id, plantingId) => setSownIds((prev) => new Map(prev).set(id, plantingId ?? null)), [])
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

        <div style={{ marginBottom: 6 }}>
          <SegmentedControl
            small
            options={SEEDS_VIEWS}
            value={view ?? undefined}
            onChange={userSwitch}
            ariaLabel="Which seeds"
            data-testid="seeds-view-switch"
          />
        </div>

        <FermentLine items={store.items} onGo={goToLot} />

        {view && view !== 'sow' && <StaleBand store={store} />}

        {/* My seeds draws its own question line: it carries Expand all / Collapse all. */}
        {view && view !== 'mine' && <p data-testid="seeds-question" style={questionStyle}>{QUESTION[view]}</p>}

        {!view && <AsyncRegion loading />}

        {/* One boundary PER VIEW, keyed on it, with the header and switch outside: a Sow now engine
            throw (see sowEngine.js) costs that view and leaves the other two one tap away, the crash
            isolation /sow and /seeds/saved had as separate routes. */}
        {view && (
          <ErrorBoundary key={view} scope={`seeds-${view}`} fallback={<ViewFallback />}>
            {view === 'mine' && <MySeeds store={store} highlight={highlight} onGoToLot={goToLot} />}
            {view === 'saved' && <SavedSeeds embedded store={store} highlight={highlight} onHighlight={outline} />}
            {view === 'sow' && <SowNow embedded sownIds={sownIds} onSown={onSown} onArchived={onArchived} onGoToLot={goToLot} />}
          </ErrorBoundary>
        )}
      </div>

      {/* Opened with NO planting prop, deliberately: the sheet asks where the seed came from, and the
          variety arrives through its picker, the projection that carries the notice. A synthetic planting
          here would switch the sheet to the planting branch and silence that notice. */}
      {saving && <SaveSeedSheet onClose={() => setSaving(false)} onSaved={onSaved} />}
    </div>
  )
}

// The ferment line: the app's only overdue-ferment warning, under the switch on EVERY view, so it cannot
// live only on the view you are not looking at. Ambient text with no toast, badge, push or sound
// (operational, not a reward). Once shown it keeps its height for the rest of the visit, so a write that
// clears the last due ferment does not jolt the list up under the outline that write is showing.
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

// Spacing above the list is budgeted: at 360x640, with the ferment line showing, My seeds' FOLDED first
// screen must hold >= 3 crop-group HEADERS fully between the top bar and the nav (gate:seeds-page (e)),
// and every px here comes out of that.
const frameStyle = { maxWidth: 720, margin: '0 auto', padding: '12px 16px 90px' }
// Identical height on every view: the action slot is always there, empty on Sow now, so the switch
// and everything under it sit at the same place whichever view is showing.
const headerStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
  minHeight: T.tapMinHeight, marginBottom: 8,
}
const titleStyle = { margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }
const actionsStyle = { display: 'flex', alignItems: 'center', gap: 8, minHeight: T.tapMinHeight }
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
const questionStyle = { margin: '0 0 6px', color: P.mid, fontSize: T.type.sm }
const staleStyle = {
  display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 10px', padding: '8px 12px',
  backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: T.radiusButton,
  color: P.dark, fontSize: T.type.sm,
}
const staleRetry = {
  minHeight: T.tapMinHeight, padding: '0 12px', borderRadius: T.radiusButton, border: `1px solid ${P.border}`,
  backgroundColor: P.white, color: P.dark, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
