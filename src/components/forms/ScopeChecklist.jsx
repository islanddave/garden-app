// src/components/forms/ScopeChecklist.jsx
// Lane D / Phase D — the bulk-log SCOPE + 500-cap exclusion checklist, extracted from
// LogMany (behavior-preserving). This is the OTHER half of Phase D: where EventTypePicker
// is a single-select button-grid, this is a scope selector + server dry-run exclusion list.
// They share the SelectChip selection grammar (NOT a mode= switch) — plan §5 Phase D.
//
// Contract:
//   - scope / onScopeChange     controlled scope ({type:'all'|'project'|'space', ...})
//   - projects / locations      for the scope chips + project <select>
//   - eventType / eventDate      drive the dry-run body + retrigger the preview
//   - verbLabel                  humanized event verb for the headline copy
//   - runDryRun({scope,eventType,eventDate,signal}) -> Promise<{count,capped,plantings:[{id,name}]}>
//                                parent-supplied (closes over useApiFetch); `signal` enables
//                                AbortController cancellation + race-safety
//   - onSelectionChange({committedCount, excludedIds, selectionState})  fires whenever the net
//                                selection changes so the parent can build the confirm body +
//                                button state. `selectionState` is the RESUMABLE form of the
//                                selection (see the decisions model below) — the parent stashes it
//                                and hands it back as `initialSelection` after a dismiss/reload.
//   - initialSelection           OPTIONAL restore payload, shape {decisions:{[id]:bool}, baseline,
//                                touched}. Read ONCE, in the useState initializers: LogMany only
//                                mounts this component after its own async draft load has resolved
//                                (`if (!ready) return <Spinner/>`), so a seed is always available on
//                                the first render and a re-sync effect would only be able to stomp
//                                live edits.
//   - primaryAction             OPTIONAL ReactNode (V4-LOGMANYUXREFRESH-001 S3). The caller's own
//                                commit control, rendered in the PICK frame's bottom track. Passed
//                                as a NODE rather than a render prop because it takes no arguments
//                                from here — this component owns where it sits, never what it does.
//                                The caller must suppress its own in-page copy while
//                                `onSelectionChange`'s `frameOpen` is true, or the same button is in
//                                the document twice.
//   - renderRowExtra(planting, {excluded}) -> ReactNode | null   OPTIONAL (V4-WATERMATH-001 F0).
//                                Renders BESIDE a review-list row, for a per-row override of a
//                                batch-level value. Deliberately a render prop: this component
//                                stays a scope/exclusion widget and learns nothing about watering
//                                vocabulary — the caller owns the value and its semantics. Absent
//                                (the default) a row renders exactly as before: the toggle button
//                                is the row's only child and still fills its width.
//
// Net-count rule (plan §5 Phase D): never make the user mentally compute the set
// difference — when any planting is skipped we render "N matched − M skipped → K will
// be logged" continuously, aria-live so it's announced as toggles happen.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { P } from '../../lib/constants.js'
import ProjectOptions from '../ProjectOptions.jsx'
import SelectChip from './SelectChip.jsx'
import { PROJECTS_HIDDEN } from '../../lib/featureFlags.js'
import { useApiFetch } from '../../lib/api.js'
import { fetchNotificationPrefs, saveLogManyAllSelected } from '../../lib/notificationPrefsClient.js'
import { T, inputChrome } from './formStyles.js'
import FilterChipRow from './FilterChipRow.jsx'
// bandOrder is a PURE exported function (the computePlacement discipline — PlantingSelect.jsx:94),
// already unit-tested on its own in PlantingSelectBandOrder.test.js. Imported rather than
// re-implemented: a second copy of the pins→recents→alphabetical rule is how the two crop chip rows
// in this app start disagreeing about what "recent" means.
import { bandOrder } from './PlantingSelect.jsx'
import { readCropRank } from '../../lib/cropLogLedger.js'
import { useHandedness } from '../../hooks/useHandedness.js'
import { useDismissable } from '../../context/DismissRegistry.jsx'
import { LAYER } from '../../lib/dismissLayers.js'
import {
  useComboboxInput, looseIncludes, kbToggleBtnStyle, micToggleBtnStyle, toggleSlotsPaddingStyle,
} from '../../lib/comboboxInput.js'

// FIX-3: per-DEVICE default selection (true=start all selected [Dave], false=start none [Jen]).
// Device-local expedient; server-side per-user migration tracked as V4-LOGMANY-001.
const DEFAULT_SEL_KEY = 'quicklog.defaultAllSelected'
// Hoisted so the preference and the selection `baseline` below seed from ONE read. They start life
// as the same answer and diverge only when the user overrides the baseline for a single batch.
function readDefaultSel() {
  try { const v = localStorage.getItem(DEFAULT_SEL_KEY); return v === null ? true : v === '1' } catch (e) { return true }
}

// V4-LOGMANYUXREFRESH-001 S1 — crop chip thresholds, deliberately the SAME numbers PlantingSelect
// uses (CHIPS_MIN_ROWS / CHIPS_MIN_CROPS / PIN_COUNT / RANK_WINDOW_DAYS): the two crop chip rows in
// this app must appear and disappear on the same rule, or "why are the chips here but not there"
// becomes a support question with no answer.
const CHIPS_MIN_ROWS = 8
const CHIPS_MIN_CROPS = 2
const PIN_COUNT = 2
const RANK_WINDOW_DAYS = 60
const TRAY_MAX_H = 184
// The NULL bucket. Three live plantings on prod carry no crop type, and V4-LOGMANYCROPFILTER-001
// names dropping them silently as the same class of defect as BUG-LOGMANYPROJECTLESS-001 — so they
// get a chip of their own rather than becoming unreachable the moment any chip is active.
const UNGROUPED = '__ungrouped__'
const slugOf = (pl) => pl?.crop_type_slug || UNGROUPED
const titleizeSlug = s => String(s).split(/[-_]/).map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
const chipLabel = s => (s === UNGROUPED ? 'Ungrouped' : titleizeSlug(s))

export default function ScopeChecklist({
  scope,
  onScopeChange,
  projects = [],
  locations = [],
  eventType,
  eventDate = '',
  verbLabel = 'log',
  runDryRun,
  onSelectionChange,
  renderRowExtra,
  initialSelection,
  primaryAction,
}) {
  const [preview, setPreview] = useState(null)       // { count, capped, plantings:[{id,name}] }
  // V4-LOGMANYUXREFRESH-001 S0 — THE SELECTION IS NOW DURABLE STATE, not a by-product of the last
  // dry-run. It was `excluded: Set`, reset to empty on line 1 of the preview effect and re-seeded
  // from the default in its .then, so a hand-built selection was destroyed with no warning by ANY
  // of: a zone chip, an event-type tile, a date change. Three states replace it:
  //
  //   decisions  Map<plantId, boolean>  EXPLICIT per-planting choices (true = log it). Persists
  //              across every re-preview, and deliberately keeps ids that have fallen OUT of the
  //              current scope — dropping them would silently re-include, on the next widening, a
  //              planting the user went out of their way to skip. That is a worse bug than the one
  //              this fixes, so the map is the record and the intersection with the live preview is
  //              taken at read time (excludedIds below) rather than at write time.
  //   baseline   what an UNDECIDED planting gets. Seeded from the stored preference, but a separate
  //              value so a session-scoped "Select none" can flip it without writing a preference
  //              (S1) and so a re-preview cannot undo a choice the user has already made.
  //   touched    has the user changed the selection at all this session. Drives both the baseline
  //              re-seed rule below and the parent's unsaved-input guards. Pristine-safe: false on
  //              mount, flipped only by a deliberate tap.
  const [decisions, setDecisions] = useState(() => new Map(Object.entries(initialSelection?.decisions ?? {})))
  const [baseline, setBaseline] = useState(() => initialSelection?.baseline ?? readDefaultSel())
  const [touched, setTouched] = useState(() => !!initialSelection?.touched)
  // Read inside the preview effect, which must NOT list `touched` as a dep — doing so would refire
  // the server dry-run on the user's first row tap.
  const touchedRef = useRef(touched)
  touchedRef.current = touched
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState(null)
  const [showList, setShowList] = useState(false)
  const [defaultAllSelected, setDefaultAllSelected] = useState(readDefaultSel)
  const { getToken } = useApiFetch()

  // V4-LOGMANY-001 — adopt this USER's stored default once, on mount.
  //
  // SERVER WINS HERE, unlike the skip set. These are different kinds of value: the suppress set is
  // an append-only log of actions taken on a device (so union), whereas this is a single stated
  // preference (so last-write-wins, and the server holds the last write). This is also the value
  // most likely to be WRONG locally — the localStorage default is per-device, so on a shared phone
  // it currently holds whoever signed in last.
  //
  // `=== 'boolean'` and not a truthiness check: `false` is Jen's real preference, and a falsy guard
  // would silently refuse to adopt it, leaving her on Dave's default forever.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const prefs = await fetchNotificationPrefs({ getToken })
      if (!alive || !prefs) return
      const v = prefs.log_many_all_selected
      if (typeof v !== 'boolean') return          // null = never set; keep the local/default answer
      setDefaultAllSelected(v)
      try { localStorage.setItem(DEFAULT_SEL_KEY, v ? '1' : '0') } catch (e) { /* private mode */ }
    })()
    return () => { alive = false }
  }, [getToken])

  // V4-LOGMANYLOC-001: location hierarchy for the 2-tier "By space" picker. Zones = level-0
  // (or parentless) locations; picking a zone or sub-location cascades to descendants
  // server-side (lambda/events batch resolver). Tolerant of the minimal {id,name} shape used
  // in tests (no parent_id => treated as a zone).
  const { zones, childrenByParent, rootOf } = useMemo(() => {
    const byId = new Map(locations.map(l => [l.id, l]))
    const childrenByParent = new Map()
    for (const l of locations) {
      if (l.parent_id && byId.has(l.parent_id)) {
        if (!childrenByParent.has(l.parent_id)) childrenByParent.set(l.parent_id, [])
        childrenByParent.get(l.parent_id).push(l)
      }
    }
    for (const arr of childrenByParent.values()) {
      arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name).localeCompare(String(b.name)))
    }
    const zones = locations
      .filter(l => !l.parent_id || !byId.has(l.parent_id))
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    const rootOf = (id) => {
      let cur = byId.get(id), guard = 0
      while (cur?.parent_id && byId.has(cur.parent_id) && guard++ < 12) cur = byId.get(cur.parent_id)
      return cur?.id
    }
    return { zones, childrenByParent, rootOf }
  }, [locations])

  const activeZoneId = scope.type === 'space' ? rootOf(scope.location_id) : null
  const activeZoneName = zones.find(z => z.id === activeZoneId)?.name
  const activeZoneChildren = activeZoneId ? (childrenByParent.get(activeZoneId) ?? []) : []

  // Server-accurate dry-run preview on scope / event-type / date change. AbortController
  // makes rapid scope toggling race-safe: a superseded request can neither clobber the
  // current scope's preview nor surface its (aborted) rejection. Replaces the old `on` flag.
  useEffect(() => {
    if (!runDryRun) return
    const ctrl = new AbortController()
    setPreviewing(true); setPreviewError(null)
    Promise.resolve(runDryRun({ scope, eventType, eventDate, signal: ctrl.signal }))
      .then(r => {
        if (ctrl.signal.aborted) return
        setPreview(r); setPreviewing(false)
        // V4-LOGMANYUXREFRESH-001 S0 — the ONLY selection write left in this effect, and it is
        // conditional. Re-seeding the baseline from the stored preference is the old behaviour and
        // is still right for an UNTOUCHED form (it is how a Jen-defaulted mount starts empty). Once
        // the user has picked anything it is destructive: a back-date after choosing three
        // plantings would put the whole scope back. `touchedRef`, not `touched`, so this stays out
        // of the dep array — see its declaration.
        if (!touchedRef.current) setBaseline(defaultAllSelected)
      })
      .catch(err => {
        if (ctrl.signal.aborted || err?.name === 'AbortError') return
        setPreviewError(err.message); setPreview(null); setPreviewing(false)
      })
    return () => ctrl.abort()
    // defaultAllSelected intentionally NOT a dep: flipping it re-applies via applyDefaultSel
    // without a refetch (preserves prior LogMany behavior).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, eventType, eventDate, runDryRun])

  // Records an EXPLICIT decision rather than flipping set membership, so the choice survives a
  // re-preview and cannot be re-derived (wrongly) from a baseline that has since moved.
  const toggleExclude = useCallback((id) => {
    setTouched(true)
    setDecisions(prev => {
      const n = new Map(prev)
      n.set(id, !(prev.has(id) ? prev.get(id) : baseline))
      return n
    })
  }, [baseline])

  // V4-LOGMANY-001 / V4-USERPREFS-001: flip the default and re-apply to the current preview
  // immediately. localStorage stays as the SYNCHRONOUS local layer — it seeds useState on first
  // render, so removing it would make the checkbox flicker to the wrong state on every mount while
  // the prefs GET is in flight. The server write is fire-and-forget on top of it.
  //
  // Flipping the STORED preference is still a full reset (that is what it always did, and stating a
  // new default while keeping the old default's consequences would be incoherent), so it clears the
  // decisions AND un-touches the form — a later scope change then re-seeds from the new preference.
  // The session-scoped Select none / Select all shown pair below is the affordance that does NOT
  // write a preference.
  const applyDefaultSel = useCallback((on) => {
    setDefaultAllSelected(on)
    try { localStorage.setItem(DEFAULT_SEL_KEY, on ? '1' : '0') } catch (e) {}
    saveLogManyAllSelected({ getToken, value: on })
    setBaseline(on); setDecisions(new Map()); setTouched(false)
  }, [getToken])

  // BUG-BATCHORDER-001: display order only. The server-side ORDER BY in lambda/events is what makes
  // the 500-cap deterministic; this mirrors EventNew.jsx:736's localeCompare so both log surfaces
  // present the same list the same way regardless of Postgres collation. Order-independent consumers
  // (total, committed) are unaffected.
  const plantings = useMemo(
    () => [...(preview?.plantings || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [preview]
  )
  const isKept = useCallback(
    (id) => (decisions.has(id) ? decisions.get(id) : baseline),
    [decisions, baseline],
  )
  const total = plantings.length

  // ── V4-LOGMANYUXREFRESH-001 S1: find, don't scroll ─────────────────────────
  // The list had NO text input at all and exactly one narrowing axis (zone). At 239 plantings that
  // is a 240px window over ~11,500px of alphabetical names — not a chooser. Two filters, ANDed, and
  // they narrow WHAT IS SHOWN ONLY: neither one selects, deselects, or touches a decision. That
  // separation is the whole safety property here — an invisible filter that also changed the
  // committed set would be the silent-omission class again.
  const [query, setQuery] = useState('')
  const [chipSelection, setChipSelection] = useState(() => new Set())
  const searchRef = useRef(null)
  const hand = useHandedness()
  // ── V4-LOGMANYUXREFRESH-001 S3: PICK mode ──────────────────────────────────
  // The model change the design (§5.1) calls "pick, don't un-pick". BULK is the shipped model
  // unchanged — an EXCLUSION list over a server-resolved scope, which is the right shape for
  // "water the whole Bag Area". PICK starts empty and you add, which is the shape for "these three"
  // and the one Dave has been fighting the app to simulate.
  //
  // ONE COMMIT, and this is why no server change is needed to ship it: PICK rides the existing wire
  // contract as scope + `exclude_plant_ids` = the COMPLEMENT of what was picked. The decisions/
  // baseline model S0 introduced already expresses that exactly — baseline false, explicit `true`
  // per pick — so the two modes are two SURFACES over one selection state, not two selections.
  // A native `{type:'ids'}` scope is a later slice (S4) and touches the Lambda.
  const [mode, setMode] = useState(() => (initialSelection?.mode === 'pick' ? 'pick' : 'bulk'))
  const [frameOpen, setFrameOpen] = useState(false)
  // V4-BACKNAV-001 — register the frame at the layer it PAINTS (DIALOG = 1000, the same pairing
  // Lightbox / ZoomableImage / CritterFactsPopover use). Without this, Escape over an open frame is
  // arbitrated to the hosting Sheet and dismisses the WHOLE Log Many overlay from underneath a
  // picker the user is mid-way through, because the registry would not know anything is above it.
  // `armsBack` is deliberately NOT set: it defaults false, so Android Back still falls through to
  // the router exactly as it does today. Arming it (Back closes the frame, not the page) is the
  // natural follow-up and is a history-semantics change that belongs with the back-nav suite.
  // Provider-safe: with no DismissApiContext this is inert and everything below is unchanged.
  useDismissable({ open: frameOpen, onDismiss: () => setFrameOpen(false), layer: LAYER.DIALOG })
  const {
    kbMode, enableKeyboard, disableKeyboard, isDeliberateBlur, voiceSupported, voiceState, toggleVoice,
  } = useComboboxInput({
    // `open` gates the hook's per-interaction mode reset, so BOTH doors into the search field have
    // to feed it — otherwise a frame opened after a review-list close would inherit the last kbMode
    // instead of returning to this surface's keyboard-less default.
    open: showList || frameOpen, inputRef: searchRef, onVoiceText: (t) => setQuery(t),
    // V4-PICKERALL-001 "let me see the whole list": the list opens with the on-screen keyboard
    // SUPPRESSED, because the review list is something Dave reads before he types. The ⌨ toggle
    // raises it. Same default VarietyPicker ships.
    defaultMode: 'none',
  })
  // isDeliberateBlur is consumed even though this input has no blur-close to guard — reading it
  // keeps the hook's contract honest if a dismissal behaviour is ever added, and marks the
  // deliberate divergence from PlantingSelect (which does close on blur).
  void isDeliberateBlur

  const cropUniverse = useMemo(() => {
    const counts = new Map()
    for (const pl of plantings) counts.set(slugOf(pl), (counts.get(slugOf(pl)) ?? 0) + 1)
    return [...counts]
  }, [plantings])
  // Pins are DATA-DRIVEN (top-2 by live count), not a hardcoded crop list: on measured prod data
  // that is tomato + pepper, 35% of the garden behind two chips, and it re-derives itself as the
  // garden changes. Ungrouped is never pinned — it is a fallback bucket, not a crop.
  const pinnedSlugs = useMemo(
    () => cropUniverse.filter(([s]) => s !== UNGROUPED)
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, PIN_COUNT).map(([s]) => s),
    [cropUniverse],
  )
  const chipsEligible = cropUniverse.length >= CHIPS_MIN_CROPS && total >= CHIPS_MIN_ROWS
  // The rank ledger is READ here and never written — cropLogLedger.js:15-19 excludes Log Many from
  // writing to it on purpose, because a 40-planting watering pass would mark every crop in the
  // garden "recently logged" and flatten the ranking into noise for every other surface.
  // Read once per list-OPEN (not per render, not on mount), mirroring PlantingSelect's rankNonce:
  // a chip order that reorders under the user's thumb is worse than a slightly stale one.
  const [rankNonce, setRankNonce] = useState(0)
  useEffect(() => { if (showList || frameOpen) setRankNonce(n => n + 1) }, [showList, frameOpen])
  const cropRank = useMemo(
    () => (rankNonce === 0 ? null : readCropRank({ windowDays: RANK_WINDOW_DAYS })),
    [rankNonce],
  )
  const chipOptions = useMemo(
    () => bandOrder({
      options: cropUniverse.map(([s]) => ({ value: s, label: chipLabel(s) })),
      pinned: pinnedSlugs, rank: cropRank, counts: new Map(cropUniverse),
    }),
    [cropUniverse, pinnedSlugs, cropRank],
  )
  const toggleChip = useCallback((slug) => {
    setChipSelection(prev => { const n = new Set(prev); if (n.has(slug)) n.delete(slug); else n.add(slug); return n })
  }, [])
  const clearChips = useCallback(() => setChipSelection(new Set()), [])

  const shown = useMemo(() => {
    let list = plantings
    const q = query.trim()
    // looseIncludes, not toLowerCase().includes(): voice returns "sun ray" for "Sunray". The crop
    // slug is in the haystack so typing "pepper" narrows even where no name carries the word.
    if (q) list = list.filter(pl => looseIncludes(pl.name, q) || looseIncludes(pl.crop_type_slug, q))
    if (chipsEligible && chipSelection.size > 0) list = list.filter(pl => chipSelection.has(slugOf(pl)))
    return list
  }, [plantings, query, chipSelection, chipsEligible])
  const hiddenCount = total - shown.length

  // Session-scoped bulk selection. NEITHER of these writes a preference: the only clear-all on this
  // screen used to be the "Start with everything selected" checkbox, which fires
  // saveLogManyAllSelected to the server — so using it as a one-batch gesture permanently changed
  // Dave's default for every future batch. Select none moves the BASELINE (so plantings that arrive
  // later, from a widened scope, also start off) and drops the stale decisions with it.
  const selectNone = useCallback(() => {
    setTouched(true); setBaseline(false); setDecisions(new Map())
  }, [])
  // "…all shown" and not "…all": with a filter on, the useful gesture is "take this whole crop",
  // and a control that silently reached past the filter would be exactly the invisible-filter trap.
  const selectAllShown = useCallback(() => {
    setTouched(true)
    setDecisions(prev => { const n = new Map(prev); for (const pl of shown) n.set(pl.id, true); return n })
  }, [shown])

  // S3 — CANDIDATE ORDER: recency-pinned crop bands, then alphabetical inside each band.
  // Derived from `chipOptions`, which is already `bandOrder`'s output (pins → recents band →
  // alphabetical tail), rather than from a second ranking rule: the chip row and the list underneath
  // it must agree about what "recent" means, and two independent implementations of that is exactly
  // how they start disagreeing. A crop with no band position sorts last, then by name.
  const bandRank = useMemo(() => new Map(chipOptions.map((o, i) => [o.value, i])), [chipOptions])
  const candidates = useMemo(
    () => [...shown].sort((a, b) =>
      (bandRank.get(slugOf(a)) ?? Number.MAX_SAFE_INTEGER) - (bandRank.get(slugOf(b)) ?? Number.MAX_SAFE_INTEGER)
      || String(a.name || '').localeCompare(String(b.name || ''))),
    [shown, bandRank],
  )
  // THE ANSWER TO FAILURE MODE (d), and it is computed over `plantings`, never `shown`: a planting
  // that is picked but currently hidden by a filter still has to appear in the tray, or the filter
  // becomes a way to lose track of a pick — the same invisible-filter trap in a new costume.
  //
  // Order is `plantings` order (alphabetical), NOT tap order, and that is a trade: most-recent-first
  // would put every new pick where the eye already is, but it reorders the tray — and every chip in
  // it carries a REMOVE — under a thumb that is mid-batch. The confirmation a tap landed comes from
  // the count at the tray's fixed left edge and from the row's own ✓, both of which move instantly;
  // the chip itself may be off to the right in a long selection. Flagged for Dave's smoke pass.
  const picked = useMemo(() => plantings.filter(p => isKept(p.id)), [plantings, isKept])

  // Switching modes is a MODEL switch, so it moves the baseline and drops the decisions taken under
  // the old model. PICK starts empty (§5.1 "starts empty, you add"); BULK returns to the user's own
  // stored default, which is the whole point of that preference. `touched` is set because this is a
  // deliberate act with consequences worth stashing and worth guarding a backdrop tap against — the
  // same test `eventDate` passes and a bare mount fails.
  const switchMode = useCallback((next) => {
    if (next === mode) { if (next === 'pick') setFrameOpen(true); return }
    setMode(next)
    setTouched(true)
    setDecisions(new Map())
    setBaseline(next === 'pick' ? false : defaultAllSelected)
    setQuery(''); setChipSelection(new Set())
    setShowList(false)
    setFrameOpen(next === 'pick')
  }, [mode, defaultAllSelected])

  // THE INTERSECTION, taken here rather than in the decisions map: `excludedIds` is what rides in
  // the POST body and what the net-count line reports, so it must name only plantings the current
  // scope actually resolved. Decisions about anything else stay in the map, unreported, ready for
  // the moment that planting comes back into scope. Computed over `plantings`, NEVER `shown` — the
  // filters narrow the view, not the batch.
  const excludedIds = useMemo(() => plantings.filter(p => !isKept(p.id)).map(p => p.id), [plantings, isKept])
  const excludedCount = excludedIds.length
  const committedCount = total - excludedCount

  // The resumable form of the selection, handed to the parent so a dismiss/reload can restore it.
  // `mode` rides in it: coming back from a dismiss into BULK with a PICK-shaped selection would show
  // a 236-exclusion review list where the user left a 3-planting pick.
  const selectionState = useMemo(
    () => ({ decisions: Object.fromEntries(decisions), baseline, touched, mode }),
    [decisions, baseline, touched, mode],
  )

  // Lift the committed selection up so the parent can build the confirm body + button.
  // `frameOpen` is a SIBLING key, deliberately not part of selectionState: the parent needs it to
  // suppress its own copy of the primary action while the frame is showing one, and it is transient
  // UI position, not selection — stashing it would reopen a full-screen picker on a restore.
  useEffect(() => {
    onSelectionChange?.({ committedCount, excludedIds, selectionState, frameOpen })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedCount, excludedIds, selectionState, frameOpen])

  // ── The two filter controls, authored ONCE and rendered on both surfaces ─────────────────────
  // The BULK review list and the S3 PICK frame narrow the same `shown` memo through the same field
  // and the same chip row. Two copies of this markup would be two places for the keyboard-less
  // default, the handedness offsets and the mic wiring to drift apart on one page.
  const searchField = (
    <div style={{ position: 'relative' }}>
      <input
        ref={searchRef}
        type="text"
        value={query}
        inputMode={kbMode}
        onChange={e => setQuery(e.target.value)}
        aria-label="Search these plantings"
        data-testid="sc-search"
        placeholder="Search plantings"
        autoComplete="off"
        style={{
          ...inputChrome(false), minHeight: T.tapMinHeight,
          ...(toggleSlotsPaddingStyle({ showKb: true, showMic: voiceSupported, hand }) ?? null),
        }}
      />
      {/* V4-PICKERKB-002 — the two-way keyboard toggle, byte-identical in behaviour to
          PlantingSelect's: the list opens keyboard-less and this raises it. Chrome
          Android will not re-read inputMode on a focused element, which is why the swap
          lives in the shared hook rather than here. */}
      <button
        type="button"
        onMouseDown={e => e.preventDefault()}
        onClick={kbMode === 'text' ? disableKeyboard : enableKeyboard}
        aria-label={kbMode === 'text' ? 'Hide the keyboard and browse plantings' : 'Type to search plantings'}
        aria-pressed={kbMode === 'text'}
        data-testid="sc-kb"
        style={kbToggleBtnStyle(hand)}
      >
        <span aria-hidden="true">{kbMode === 'text' ? '⌄' : '⌨'}</span>
      </button>
      {/* V4-PICKERVOICE-001 — speak the name. Feature-detected, so it is simply absent
          in jsdom/Firefox; a denied mic is a quiet disabled state, never a modal. */}
      {voiceSupported && (
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={voiceState === 'denied' ? undefined : toggleVoice}
          aria-label={
            voiceState === 'denied' ? 'Microphone unavailable'
            : voiceState === 'listening' ? 'Stop listening'
            : 'Speak to search plantings'
          }
          aria-pressed={voiceState === 'listening'}
          aria-disabled={voiceState === 'denied' || undefined}
          data-testid="sc-mic"
          style={micToggleBtnStyle(voiceState, hand)}
        >
          <span aria-hidden="true">🎤</span>
        </button>
      )}
    </div>
  )
  const chipRow = chipsEligible ? (
    <div style={{ marginTop: 8 }}>
      <FilterChipRow
        options={chipOptions}
        selected={chipSelection}
        onToggle={toggleChip}
        pinned={pinnedSlugs}
        onClear={clearChips}
        trayMaxHeight={TRAY_MAX_H}
        aria-label="Filter by crop"
        data-testid="sc-crop-chips"
      />
    </div>
  ) : null
  // The LOUD ACTIVE-FILTER SIGNAL. A filter that silently narrows a selection list is how a user
  // concludes a planting is gone; the count is always stated, and it is stated as HIDDEN (not as
  // "showing N") so the missing rows are the subject.
  const shownNote = (
    <div data-testid="sc-shown-note" aria-live="polite" style={{ margin: '8px 0 0', fontSize: '0.78rem', color: P.mid }}>
      {hiddenCount > 0
        ? `Showing ${shown.length} of ${total} — ${hiddenCount} hidden by filters`
        : `Showing all ${total}`}
    </div>
  )

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        {/* ── V4-LOGMANYUXREFRESH-001 S3: the mode switch (§5.1 "two modes, one commit") ──
            SelectChip and not SegmentedControl, deliberately: SegmentedControl's options are
            `minHeight: 40`, so adopting it here would plant two fresh sub-44 targets on the exact
            path the S2 half of this row is raising, in a primitive this lane does not own. These
            read as chips because the scope chips directly beneath them are chips. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }} role="group" aria-label="How to choose plantings">
          <SelectChip touch active={mode === 'bulk'} data-testid="sc-mode-bulk" onClick={() => switchMode('bulk')}>Everything in a scope</SelectChip>
          <SelectChip touch active={mode === 'pick'} data-testid="sc-mode-pick" onClick={() => switchMode('pick')}>Pick plantings</SelectChip>
        </div>
        {/* V4-LOGMANYUXREFRESH-001 S2 — every chip on the selection path carries `touch` (48px, the
            same variant the harvest quantity chips use). SelectChip's own comment recorded the
            omission: "Default (undefined) is byte-identical to before, so LogMany and ScopeChecklist
            are untouched." They are no longer untouched. `touch` raises HEIGHT to 48 and WIDTH only
            to 44 — deliberately, per that comment: a 48px width floor wraps a 6-chip row onto two
            lines. Measured at 390px in this lane: the zone row still renders on one line and the
            page grew 24px in total, with nothing sticky below it to be pushed under. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <SelectChip touch active={scope.type === 'all'} onClick={() => onScopeChange({ type: 'all' })}>All active</SelectChip>
          {/* V4-PROJHIDE-001: the "By project" scope chip is hidden when projects aren't user-facing
              (All active / By zone remain). Flag OFF renders the chip exactly as before. */}
          {!PROJECTS_HIDDEN && (
            <SelectChip touch active={scope.type === 'project'} onClick={() => onScopeChange(scope.type === 'project' ? scope : { type: 'project', project_id: projects[0]?.id })}>By project</SelectChip>
          )}
          {/* V4-SPACECLIENTGAP-001 (Dave 2026-08-02): LABEL is "By zone" — these chips select level-0
              locations (Deck/Drive/House/Pasture/Stable/Yard), which are ZONES. "Space" is now
              reserved for the property tier above them. The WIRE VALUE `scope.type === 'space'` is
              deliberately UNCHANGED: it is the contract POST /api/events/batch validates, and
              renaming it here would 400 every batch log. Copy-only rename, never the protocol. */}
          <SelectChip touch active={scope.type === 'space'} onClick={() => onScopeChange(scope.type === 'space' ? scope : { type: 'space', location_id: zones[0]?.id })}>By zone</SelectChip>
        </div>
        {/* V4-PROJHIDE-001: the project <select> follows its chip — hidden when projects aren't user-facing. */}
        {!PROJECTS_HIDDEN && scope.type === 'project' && (
          <select value={scope.project_id ?? ''} onChange={e => onScopeChange({ type: 'project', project_id: e.target.value })} style={selectStyle} aria-label="Project">
            <ProjectOptions projects={projects} />
          </select>
        )}
        {scope.type === 'space' && (
          <div>
            {/* Tier 1 — zones */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="group" aria-label="Zone">
              {zones.map(z => (
                <SelectChip key={z.id} small touch active={rootOf(scope.location_id) === z.id} onClick={() => onScopeChange({ type: 'space', location_id: z.id })}>{z.name}</SelectChip>
              ))}
            </div>
            {/* Tier 2 — sub-locations of the active zone (cascade includes descendants) */}
            {activeZoneChildren.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, paddingLeft: 4 }} role="group" aria-label={`Within ${activeZoneName}`}>
                <SelectChip small touch active={scope.location_id === activeZoneId} onClick={() => onScopeChange({ type: 'space', location_id: activeZoneId })}>All {activeZoneName}</SelectChip>
                {activeZoneChildren.map(c => (
                  <SelectChip key={c.id} small touch active={scope.location_id === c.id} onClick={() => onScopeChange({ type: 'space', location_id: c.id })}>{c.name}</SelectChip>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
        {previewing ? (
          <p style={{ margin: 0, color: P.light, textAlign: 'center' }}>Counting…</p>
        ) : previewError ? (
          <p role="alert" style={{ margin: 0, color: P.terra, textAlign: 'center', fontSize: '0.85rem' }}>{previewError}</p>
        ) : preview ? (
          <>
            <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>
              Log <span style={{ color: P.green }}>{verbLabel}</span> on <span style={{ color: P.green }}>{committedCount}</span> {committedCount === 1 ? 'planting' : 'plantings'}
            </p>
            {/* S3 gates this to BULK. The net-count rule is "never make the user compute the set
                difference", and in PICK mode the exclusion framing states it BACKWARDS: a user who
                tapped three plantings would read "239 matched − 236 skipped", which is arithmetically
                true and describes an action nobody took. The pick summary below carries the same
                guarantee in the mode's own vocabulary, and carries the same aria-live with it. */}
            {mode === 'bulk' && excludedCount > 0 && (
              <p data-testid="net-count" aria-live="polite" style={{ margin: '0 0 8px', color: P.dark, fontSize: '0.83rem', fontWeight: 600 }}>
                {total} matched − {excludedCount} skipped → {committedCount} will be logged
              </p>
            )}
            {preview.capped && <p style={{ margin: '0 0 8px', color: P.terra, fontSize: '0.8rem' }}>Showing first 500 — narrow the scope to log more.</p>}
            {scope.type === 'space' && (
              <p style={{ margin: '0 0 8px', color: P.light, fontSize: '0.78rem' }}>Plantings with no zone aren't included — use “All active” to cover everything.</p>
            )}
            {mode === 'bulk' && total > 0 && (
              <button type="button" onClick={() => setShowList(v => !v)} style={linkBtn}>
                {showList ? 'Hide' : 'Review'} {total} {total === 1 ? 'planting' : 'plantings'} {excludedCount > 0 ? `(${excludedCount} skipped)` : ''}
              </button>
            )}
            {/* ── S3: the PICK card, shown when the full-screen frame is CLOSED ──────────────
                Not a second selection surface — a door back into the one frame, plus the count,
                so leaving the frame to set a date or a note never hides what is picked. */}
            {mode === 'pick' && (
              <div style={{ marginTop: 4 }}>
                <p data-testid="sc-pick-summary" aria-live="polite" style={{ margin: '0 0 8px', color: P.mid, fontSize: '0.83rem' }}>
                  {committedCount === 0
                    ? `Nothing picked yet — choose from ${total}.`
                    : `${committedCount} of ${total} picked.`}
                </p>
                <button type="button" data-testid="sc-open-pick" onClick={() => setFrameOpen(true)} style={{ ...bulkBtn, width: '100%' }}>
                  {committedCount === 0 ? 'Pick plantings' : `Change picks (${committedCount})`}
                </button>
              </div>
            )}
            {/* V4-LOGMANYUXREFRESH-001 S2 — the TARGET here is the <label>, not the box: a click
                anywhere on a label toggles its control, so raising the label to the 44px floor
                raises the tap target even though a 44px checkbox glyph would be absurd. The box
                itself goes 13px → 20px because at 13px it is also hard to READ which way it is
                set, and that is the other half of why this control gets mis-tapped. */}
            {mode === 'bulk' && total > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 0', fontSize: '0.8rem', color: P.mid, cursor: 'pointer', minHeight: T.tapMinHeight }}>
                <input type="checkbox" checked={defaultAllSelected} onChange={e => applyDefaultSel(e.target.checked)}
                  data-testid="sc-default-all" style={{ width: 20, height: 20, flex: '0 0 auto' }} />
                Start with everything selected
              </label>
            )}
            {/* ── V4-LOGMANYUXREFRESH-001 S1: the two ways IN ──────────────────────────────
                Rendered inside the open list, above the scroller, so the controls that narrow it
                are attached to the thing they narrow. Everything here is view-only — see the
                `shown` memo. */}
            {mode === 'bulk' && showList && total > 0 && (
              <div style={{ marginTop: 10 }}>
                {searchField}
                {chipRow}
                {shownNote}
                {/* SESSION-SCOPED, and that is the whole point: the only clear-all this screen had
                    was the "Start with everything selected" checkbox, which writes a preference to
                    the server — using it to clear one batch changed Dave's default for every future
                    batch. Neither of these touches it. */}
                {/* Plain buttons, NOT SelectChip: these are momentary actions, and SelectChip
                    hardcodes aria-pressed, which would announce "Select none, not pressed" — a
                    toggle that is off — to TalkBack. Same 48px target the chips carry. */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0 0' }}>
                  <button type="button" onClick={selectNone} data-testid="sc-select-none" style={bulkBtn}>Select none</button>
                  <button type="button" onClick={selectAllShown} data-testid="sc-select-shown" style={bulkBtn}>
                    {hiddenCount > 0 ? `Select all ${shown.length} shown` : 'Select all'}
                  </button>
                </div>
              </div>
            )}
            {mode === 'bulk' && showList && (
              <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {shown.length === 0 && (
                  <li data-testid="sc-no-matches" style={{ padding: '12px 0', textAlign: 'center', color: P.light, fontSize: '0.83rem' }}>
                    No planting here matches that. Clear the search or the crop chips to see all {total}.
                  </li>
                )}
                {shown.map(pl => {
                  const off = !isKept(pl.id)
                  // The extra node is a SIBLING of the toggle button, never a child: nesting an
                  // interactive control inside a <button> is invalid HTML and, on Chrome Android,
                  // makes the inner tap toggle the row instead of doing its own job.
                  const extra = renderRowExtra ? renderRowExtra(pl, { excluded: off }) : null
                  return (
                    <li key={pl.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button type="button" onClick={() => toggleExclude(pl.id)} aria-pressed={!off}
                        style={{ flex: 1, minWidth: 0, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, minHeight: 44,
                          background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                          color: off ? P.light : P.dark, textDecoration: off ? 'line-through' : 'none', fontSize: '0.88rem' }}>
                        <span aria-hidden="true" style={{ color: off ? P.light : P.green }}>{off ? '○' : '✓'}</span>
                        {pl.name}
                      </button>
                      {extra}
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        ) : (
          <p style={{ margin: 0, color: P.light, textAlign: 'center' }}>No plantings match this scope.</p>
        )}
      </div>

      {/* ══ V4-LOGMANYUXREFRESH-001 S3 — THE PICK FRAME (design §5.2) ════════════════════════════
          THE GEOMETRY IS THE POINT, and it is copied from the weigh-in frame Dave rated "100% A+"
          (EventNew.jsx `weigh-frame`, `gridTemplateRows: 'auto 1fr auto'`): tracks 1 and 3 are
          `auto` so they are pinned to the top and bottom edges, track 2 is `1fr` and is THE ONLY
          SCROLLER on screen. What it replaces is a 240px window over ~11,500px of names nested
          inside a page that also scrolls — two scrollers, neither of them the whole list.

          `position: fixed; inset: 0` rather than the weigh frame's in-flow `height: calc(100dvh -
          52px)`, because this surface has two hosts and neither of them is a fixed-height column:
          /log/many renders full-page inside a scrolling Shell AND as an overlay inside Sheet's
          `maxHeight … overflowY: auto` panel. A fixed layer takes the viewport from both, and no
          ancestor here establishes a containing block (Sheet's panel sets no transform/filter/
          contain), so it resolves against the viewport in both. index.html carries
          `interactive-widget=resizes-content`, so the Android IME shrinks the LAYOUT viewport and
          track 3 rides up with the keyboard instead of hiding behind it — the same property the
          weigh frame depends on.
          zIndex 1000 is the house full-screen-layer value (Lightbox, ZoomableImage,
          CritterFactsPopover); it clears Sheet's panel at 200 and stays under ConfirmSheet/Toast
          at 1190/1200, which must still be able to interrupt. */}
      {frameOpen && (
        <div data-testid="pick-frame" role="group" aria-label="Pick plantings"
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: P.cream,
            display: 'grid', gridTemplateRows: 'auto 1fr auto',
            // minmax(0,1fr) on the COLUMN, for the reason the weigh frame documents: an implicit
            // grid column is `auto`, which sizes to MAX-CONTENT, so one long planting name would
            // widen the whole frame past 390px and `overflow: hidden` would CLIP rather than
            // scroll — silently putting the tray and the primary action off-screen.
            gridTemplateColumns: 'minmax(0, 1fr)', overflow: 'hidden',
            // The page behind is STILL SCROLLABLE while this layer is up (full-page /log/many has no
            // Sheet, so nothing has locked the body). Without this, a drag that starts on track 1 or
            // track 3 — neither of which scrolls — chains to the document and drags the page around
            // underneath the frame. `overscroll-behavior` applies to any scroll container including
            // an `overflow: hidden` one, so it stops the chain here. Deliberately NOT a
            // document.body lock: Sheet.jsx owns a module-level REFCOUNTED body lock for the overlay
            // host, and a second, unrefcounted writer would restore '' on close and unlock the sheet
            // that is still open around us.
            overscrollBehavior: 'contain',
          }}
        >
          {/* ── TRACK 1 — fixed, top: the two ways in ─────────────────────────────────────── */}
          <div style={{ padding: '10px 16px 8px', borderBottom: `1px solid ${P.border}`, backgroundColor: P.white, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <button type="button" data-testid="pick-done" onClick={() => setFrameOpen(false)} style={frameDoneBtn}>Done</button>
              <span style={{ flex: 1, minWidth: 0, fontWeight: 700, color: P.dark, fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Pick plantings
              </span>
            </div>
            {searchField}
            {chipRow}
            {shownNote}
            {/* §5.3's answer to "search returns 46 tomatoes": state the number, then offer the BULK
                exit from inside pick mode rather than more scrolling. Only while a filter is
                actually narrowing — with nothing hidden it would read as "select all 239". */}
            {hiddenCount > 0 && shown.length > 0 && (
              <button type="button" data-testid="pick-select-shown" onClick={selectAllShown} style={{ ...bulkBtn, margin: '8px 0 0' }}>
                Select all {shown.length} shown
              </button>
            )}
          </div>

          {/* ── TRACK 2 — flex, THE ONLY SCROLLER: candidates ─────────────────────────────── */}
          <ul data-testid="pick-list"
            style={{
              listStyle: 'none', margin: 0, padding: '4px 16px', minHeight: 0,
              overflowY: 'auto',
              // MANDATORY, same reason as PlantingSelect's listbox: without it a flick that reaches
              // the end of the list chains to whatever is behind the layer and drags the page out
              // from under the thumb mid-choice.
              overscrollBehavior: 'contain',
              display: 'flex', flexDirection: 'column', gap: 2,
            }}
          >
            {candidates.length === 0 && (
              <li data-testid="pick-no-matches" style={{ padding: '16px 0', textAlign: 'center', color: P.light, fontSize: '0.83rem' }}>
                No planting here matches that. Clear the search or the crop chips to see all {total}.
              </li>
            )}
            {candidates.map(pl => {
              const on = isKept(pl.id)
              return (
                <li key={pl.id}>
                  {/* TAPPING ADDS. `aria-pressed` and not a checkbox: this is a toggle button whose
                      pressed state IS "picked", which is what TalkBack should announce, and it is
                      the same grammar the review list rows already use. */}
                  <button type="button" onClick={() => toggleExclude(pl.id)} aria-pressed={on}
                    data-testid={`pick-row-${pl.id}`}
                    style={{
                      width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10,
                      minHeight: T.tapMinHeight, padding: '4px 6px', borderRadius: T.radiusField,
                      background: on ? P.greenPale : 'none', border: 'none', cursor: 'pointer',
                      fontFamily: 'inherit', color: P.dark, minWidth: 0,
                    }}>
                    <span aria-hidden="true" style={{ color: on ? P.green : P.light, fontWeight: 700 }}>{on ? '✓' : '+'}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.88rem', fontWeight: on ? 700 : 400 }}>
                      {pl.name}
                    </span>
                    {/* The crop type on the row is what makes 46 near-identical tomato names
                        distinguishable at a glance, and it is the dimension the S1 Lambda change
                        put on the wire. Slug-less plantings say so rather than showing nothing. */}
                    <span style={{ flex: '0 0 auto', color: P.light, fontSize: '0.75rem' }}>{chipLabel(slugOf(pl))}</span>
                  </button>
                </li>
              )
            })}
          </ul>

          {/* ── TRACK 3 — fixed, bottom, thumb zone: the answer to failure mode (d) ─────────
              What is selected is ALWAYS on screen, in the thumb zone, and never behind a collapsed
              disclosure. The tray scrolls HORIZONTALLY on purpose: a wrapping tray would grow track
              3 without bound and eat the scroller above it, which is the height the list needs. */}
          <div style={{ padding: '8px 16px calc(10px + env(safe-area-inset-bottom))', borderTop: `1px solid ${P.border}`, backgroundColor: P.white, minWidth: 0 }}>
            <div data-testid="pick-tray" aria-live="polite"
              style={{ display: 'flex', gap: 6, alignItems: 'center', overflowX: 'auto', overscrollBehavior: 'contain', paddingBottom: 6, minWidth: 0 }}>
              {picked.length === 0 ? (
                <span style={{ color: P.light, fontSize: '0.8rem', whiteSpace: 'nowrap' }}>Nothing picked yet</span>
              ) : (
                <>
                  <span data-testid="pick-count" style={{ flex: '0 0 auto', color: P.mid, fontSize: '0.8rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {picked.length} picked
                  </span>
                  {picked.map(pl => (
                    <button key={pl.id} type="button" onClick={() => toggleExclude(pl.id)}
                      data-testid={`pick-chip-${pl.id}`}
                      aria-label={`Remove ${pl.name}`}
                      style={trayChip}>
                      <span style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.name}</span>
                      {/* U+00D7, not U+2715: the design-system guard bans the dingbat block in
                          forms/**, and this file's emoji deferral is a debt entry to shrink, not a
                          licence to add to. */}
                      <span aria-hidden="true" style={{ fontWeight: 700 }}>×</span>
                    </button>
                  ))}
                </>
              )}
            </div>
            {primaryAction}
          </div>
        </div>
      )}
    </>
  )
}

// V4-LOGMANYUXREFRESH-001 S2 — `Review N plantings` is the ONLY door into the list, and it measured
// 15px tall at 390px (harness, this lane): `padding: 0` on an inline-block button leaves the line box
// as the whole target. inline-flex + the named floor is the minimum change that raises it — the font
// size and the underline are untouched, so the control looks the same and is 44px to a thumb.
// alignItems centres the text inside the taller box rather than leaving it top-aligned.
const linkBtn = { background: 'none', border: 'none', color: P.green, fontSize: '0.83rem', fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit', textDecoration: 'underline', display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight }
// S1 — the session-scoped bulk actions. Authored against T.* names (the ramp retune is a separate
// decision, V4-RAMPSDONTMATCH-001) and at the 48px comfort target rather than the 44px floor: these
// are one-thumb controls on a bench, reached mid-batch.
const bulkBtn = {
  minHeight: T.buttonMinHeight, padding: T.chipPadSm, borderRadius: T.radiusPill,
  border: `1px solid ${P.border}`, backgroundColor: P.white, color: P.green,
  fontFamily: 'inherit', fontSize: T.type.sm, fontWeight: 600, cursor: 'pointer',
}
const selectStyle = { width: '100%', minHeight: 44, padding: '8px 12px', borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '0.9rem', fontFamily: 'inherit', backgroundColor: P.white, color: P.dark }
// S3 — the frame's own chrome. At the 48px comfort target, not the 44px floor: both are reached
// one-handed mid-batch, and the tray chips carry a destructive action (remove a pick) at the very
// bottom edge of the screen where a mis-tap is least recoverable.
const frameDoneBtn = {
  flex: '0 0 auto', minHeight: T.buttonMinHeight, padding: T.chipPadSm, borderRadius: T.radiusPill,
  border: `1px solid ${P.greenLight}`, backgroundColor: P.white, color: P.green,
  fontFamily: 'inherit', fontSize: T.type.sm, fontWeight: 700, cursor: 'pointer',
}
const trayChip = {
  flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6,
  minHeight: T.buttonMinHeight, padding: T.chipPadSm, borderRadius: T.radiusPill,
  border: `1px solid ${P.green}`, backgroundColor: P.greenPale, color: P.green,
  fontFamily: 'inherit', fontSize: T.type.sm, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
}
