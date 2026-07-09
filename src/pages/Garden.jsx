import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { loadGroupsExpanded, saveGroupsExpanded } from '../lib/projectTree.js'
import { Link, useSearchParams } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import ProjectStatusBadge from '../components/ProjectStatusBadge.jsx'
import FavoriteToggle from '../components/FavoriteToggle.jsx'
import LoveMehPopover from '../components/LoveMehPopover.jsx'
import { fetchActiveCritters, markCrittersViewed, patchSpeciesPrefs } from '../lib/critterClient.js'
import { fetchNotificationPrefs, recordGardenViewOpened, recordCoachmarkDismissed, recordOptInDismissed, saveGardenGroupBy, saveGardenExpanded } from '../lib/notificationPrefsClient.js'
import CritterCoachmark from '../components/CritterCoachmark.jsx'
import CritterOptInPrompt from '../components/CritterOptInPrompt.jsx'
import { OPT_IN_CRITTER_THRESHOLD } from '../lib/critterCoachmarkCopy.js'
import { SYSTEM_NOTIFICATIONS_ENABLED } from '../lib/featureFlags.js'
import { BY_ID as SPECIES_BY_ID } from '../lib/critterSpecies.js'
import { buildGardenTree, nodeHasChildren, loadExpanded, saveExpanded, buildTagGroupedList, loadGroupBy, saveGroupBy, SORT_ALPHA } from '../lib/projectTree.js'
import GroupByControl from '../components/forms/GroupByControl.jsx'
import FacetGroupHeader from '../components/forms/FacetGroupHeader.jsx'
import TileGrid from '../components/forms/TileGrid.jsx'
import PlantingTile from '../components/PlantingTile.jsx'
import { setPlantingSequence } from '../lib/plantingSequence.js'
import { useEntityTagsBulk } from '../hooks/useTags.js'
import PlantingEditor from '../components/PlantingEditor.jsx'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import PhotosWall from '../components/PhotosWall.jsx'
import { useMembers } from '../hooks/useMembers.js'
import { useAuthOptional } from '../context/AuthContext.jsx'
import { buildProjectsById, effectiveAssignee, buildCaretakerMap, lensOptions, hasMixedCaretakers } from '../lib/caretakers.js'

// Garden — Increment 1 of the post-V2 UX overhaul. Unifies the old Projects + Plants
// tabs into ONE nested accordion: projects form a parent/child tree; each project's
// plantings hang under it as leaf rows. Collapsed-first (ADHD-overwhelm mitigation).
//
// Variant A interaction (ratified Dave+Jen 2026-05-23, garden-tab-mockup-V002):
//   • leading PHOTO thumbnail → OPENS the node's detail page (picture = go in)
//   • row BODY + chevron      → PEEK (expand/collapse children)  (row = look inside)
//   • leaf rows (no children) → whole row OPENS
// Frontend-only: composes /api/projects + /api/plants (no backend/schema change).

// V200 Slice 3: Plants|Photos sub-tab. Remembered in-session via a module-level var (NOT a
// server pref this slice) so switching tabs and back doesn't reset the choice; each sub-tab
// owns its own grouping state, so per-sub-tab grouping is preserved automatically.
let lastSubtab = 'plants'
// V4-NAVSTATE-001: last Garden scroll offset, preserved across drill-in + back (module-scoped so it
// survives the tab's unmount/remount).
let lastGardenScrollY = 0

export default function Garden() {
  const { fetch, getToken } = useApiFetch()
  const { profile } = useAuthOptional()
  const { members } = useMembers()
  const [careLens, setCareLens] = useState(() => { try { return localStorage.getItem('garden.careLens') || 'all' } catch { return 'all' } })
  const onCareLensChange = useCallback((v) => { setCareLens(v); try { localStorage.setItem('garden.careLens', v) } catch { /* ignore */ } }, [])
  const [subtab, setSubtabState] = useState(lastSubtab)
  const setSubtab = useCallback((v) => { lastSubtab = v; setSubtabState(v) }, [])
  const [projects, setProjects] = useState([])
  const [plants,   setPlants]   = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  // V4-NAVSTATE-001: keep Garden's scroll position across a drill-in + back. Save continuously,
  // restore once after content has loaded (height stable). Guarded so it is inert on first visit
  // and in tests (lastGardenScrollY stays 0 until a real scroll happens).
  useEffect(() => {
    const onScroll = () => { lastGardenScrollY = window.scrollY }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  // Restore once content has loaded (height stable). Inert on first visit / in tests (offset 0).
  const scrollRestoredRef = useRef(false)
  useEffect(() => {
    if (loading || scrollRestoredRef.current) return
    scrollRestoredRef.current = true
    if (lastGardenScrollY > 0) {
      const y = lastGardenScrollY
      requestAnimationFrame(() => { try { window.scrollTo(0, y) } catch { /* jsdom noop */ } })
    }
  }, [loading])
  const [expanded, setExpanded] = useState(() => loadExpanded())
  // V4 cross-device disclosure: localStorage paints instantly; server pref is source of truth,
  // hydrated once below. persistExpanded wraps the local save + fire-and-forget server push; an
  // explicit toggle latches the ref so a late server hydrate can't clobber it.
  const expandedHydratedRef = useRef(false)
  const persistExpanded = useCallback((set) => {
    saveExpanded(set); expandedHydratedRef.current = true
    saveGardenExpanded({ getToken, ids: [...set] })
  }, [getToken])
  // V4-GARDENIA-001: faceted group-by overlay. tagMap = whole-garden plant->tags map; inert/empty
  // until VITE_API_TAGS is wired, so the control stays hidden and the legacy tree is unchanged.
  const [groupBy, setGroupBy] = useState(() => loadGroupBy())
  // V4 cross-device: localStorage paints instantly; the server pref
  // (user_notification_prefs.garden_group_by) is the cross-device source of truth, hydrated ONCE on
  // the first prefs fetch below. An explicit user change latches the ref so a late server hydrate
  // never clobbers it.
  const groupByHydratedRef = useRef(false)
  const onGroupByChange = useCallback((v) => {
    setGroupBy(v); saveGroupBy(v); groupByHydratedRef.current = true
    saveGardenGroupBy({ getToken, value: v })
  }, [getToken])
  const { entities: tagMap } = useEntityTagsBulk('plant')
  const facetOptions = useMemo(() => {
    const present = new Set()
    for (const id in (tagMap || {})) {
      const e = tagMap[id]
      for (const t of [...(e.direct || []), ...(e.projected || [])]) present.add(t.facet)
    }
    const ORDER = ['type', 'lifecycle', 'heat', 'determinacy', 'day_length', 'allium_type', 'basil_use', 'location', 'group', 'freeform']
    const LABELS = { type: 'Type', lifecycle: 'Lifespan', heat: 'Heat', determinacy: 'Determinacy', day_length: 'Day Length', allium_type: 'Allium', basil_use: 'Basil', location: 'Location', group: 'Group', freeform: 'Tags' }
    const opts = [{ value: 'none', label: 'Projects' }]
    for (const fct of ORDER) if (present.has(fct)) opts.push({ value: fct, label: LABELS[fct] || fct })
    // 'status' groups by the planting's LIFECYCLE stage (seed->...->ended). Always available
    // (every planting has a status), so appended unconditionally — it is NOT a tag facet.
    opts.push({ value: 'status', label: 'Lifecycle' })
    return opts
  }, [tagMap])
  // MVP-Critter Session 3: active critters for this household, grouped by plant_id.
  const [critters, setCritters] = useState([])
  // D-INV-1 long-press popover state. anchorEl is the long-pressed sprite DOM node.
  const [popover, setPopover] = useState({ open: false, critter: null, anchorEl: null })
  // V3-IA: Plantings page retired — its add/edit machinery lives here now.
  // editor: null | { mode:'add' } | { mode:'edit', plant }. Opened by query params
  // (?add=1 / ?edit=<id> / packet deep-link params), mirroring the old Plants.jsx contract.
  const [searchParams, setSearchParams] = useSearchParams()
  const sourceInventoryItemId = searchParams.get('source_inventory_item_id') || null
  const queryVarietyId        = searchParams.get('variety_id') || null
  const [editor, setEditor] = useState(null)
  // V3-GARDEN-001: transient id of the just-created planting. Drives an ambient in-row
  // highlight/fade so the new row is acknowledged WITHOUT a toast/modal/banner (reward-UX
  // ambient rule). Cleared ~1200ms after create (matches the @keyframes duration below).
  const [flashId, setFlashId] = useState(null)
  // V3-ARCHIVE-001: ambient archive confirmation + Undo (operational confirmation of a
  // user-initiated action — Toast carve-out; non-modal, auto-dismiss, never a reward surface).
  const [archiveUndo, setArchiveUndo] = useState(null) // { id, name, expiresAt }

  // Session 3.5 (§3.26): per-sprite actually-seen accumulator.
  // CritterSprite fires onIntersect ONCE per id when IO-gate trips (sprite enters viewport).
  // Drained on Garden unmount (route change) AND on visibilitychange → hidden (tab background).
  const seenIdsRef = useRef(new Set())
  const onSpriteIntersect = useCallback((critter) => {
    if (critter && critter.id) seenIdsRef.current.add(critter.id)
  }, [])

  // Phase B (§3.7, §3.8, §3.9): coachmark + opt-in prompt state.
  // prefs.last_garden_view_at READ here is the value BEFORE this visit's Route 6 POST —
  // it reflects the user's PRIOR garden-view (used to detect "second visit" eligibility).
  const [prefs, setPrefs] = useState(null)

  useEffect(() => {
    let on = true
    Promise.all([fetch('/api/projects'), fetch('/api/plants')])
      .then(([proj, pl]) => {
        if (!on) return
        setProjects(proj ?? [])
        setPlants(pl ?? [])
        setLoading(false)
      })
      .catch(err => { if (!on) return; setError(err.message); setLoading(false) })
    return () => { on = false }
  }, [fetch])

  // MVP-Critter Session 3: fetch active critters on mount + visibilitychange.
  // critterClient is fire-and-forget — silent no-op when VITE_API_CRITTERS unset.
  useEffect(() => {
    let on = true
    function refresh() {
      fetchActiveCritters({ getToken }).then(list => { if (on) setCritters(list) })
    }
    refresh()
    function onVis() { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => { on = false; document.removeEventListener('visibilitychange', onVis) }
  }, [getToken])

  // MVP-Critter Phase B (§3.7): fetch notification prefs + record garden-view-opened.
  // ORDER MATTERS: fetch prefs FIRST (capturing prior last_garden_view_at — the "before this
  // visit" signal that gates coachmark eligibility per §3.9 second-visit rule), THEN post
  // Route 6 (updates server-side last_garden_view_at to now — next visit will see THIS value).
  // Same fire-and-forget contract as critterClient — silent no-op when VITE_API_CRITTERS unset.
  useEffect(() => {
    let on = true
    async function refreshPrefsAndRecord() {
      const p = await fetchNotificationPrefs({ getToken })
      if (on) setPrefs(p)
      // Cross-device hydrate (once): adopt the server group-by if set, caching it locally.
      if (on && !groupByHydratedRef.current && p && typeof p.garden_group_by === 'string' && p.garden_group_by) {
        groupByHydratedRef.current = true
        setGroupBy(p.garden_group_by)
        saveGroupBy(p.garden_group_by)
      }
      if (on && !expandedHydratedRef.current && p && typeof p.garden_expanded === 'string') {
        try {
          const arr = JSON.parse(p.garden_expanded)
          if (Array.isArray(arr)) {
            expandedHydratedRef.current = true
            const set = new Set(arr.filter(x => typeof x === 'string'))
            setExpanded(set); saveExpanded(set)
          }
        } catch { /* corrupt server value — ignore, keep local */ }
      }
      // Fire Route 6 AFTER capturing prev prefs (the post updates last_garden_view_at).
      recordGardenViewOpened({ getToken })
    }
    refreshPrefsAndRecord()
    function onVis() {
      if (document.visibilityState === 'visible') refreshPrefsAndRecord()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => { on = false; document.removeEventListener('visibilitychange', onVis) }
  }, [getToken])

  // MVP-Critter Session 3 + 3.5: mark unviewed critters as viewed.
  // Session 3 path = bulk PATCH /api/critters/viewed (legacy, still supported when no sprites IO'd).
  // Session 3.5 path = drain seenIdsRef and pass actuallySeenCritterIds → Lambda marks ONLY those.
  // Race-window header (x-garden-view-opened-at) preserved in both paths.
  //
  // Flush boundaries:
  //   • Garden unmount (route change out)
  //   • document visibilitychange → hidden (tab background; iOS PWA app switch)
  // Both flushes drain + clear the ref so re-mount/re-foreground starts fresh.
  const gardenOpenedAtRef = useRef(new Date().toISOString())
  const flushSeen = useCallback(() => {
    const ids = Array.from(seenIdsRef.current)
    seenIdsRef.current.clear()
    // Pass null when no sprites IO'd → Lambda falls back to bulk-mark (preserves Stage 3 dot clear).
    markCrittersViewed({
      getToken,
      openedAt: gardenOpenedAtRef.current,
      actuallySeenCritterIds: ids.length > 0 ? ids : null,
    })
  }, [getToken])

  useEffect(() => {
    function onVis() {
      if (document.visibilityState === 'hidden') flushSeen()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      // Unmount flush — route change out of Garden.
      flushSeen()
    }
  }, [flushSeen])

  // Long-press handler — opens popover anchored to the long-pressed sprite element.
  const onSpriteLongPress = useCallback((critter, e) => {
    const anchorEl = e?.currentTarget ?? null
    setPopover({ open: true, critter, anchorEl })
  }, [])

  // Popover pick handler — translate action → weight via D-INV-1 mapping (§3.29).
  const onPrefsPick = useCallback((action) => {
    if (!popover.critter) return
    const weight = action === 'love' ? 2.0 : action === 'meh' ? 0.5 : action === 'reset' ? 1.0 : null
    if (weight != null) {
      patchSpeciesPrefs({ getToken, speciesId: popover.critter.species_id, weight })
      // Fire-and-forget; no toast per §3.29. Pulse confirmation is already inside popover.
    }
  }, [getToken, popover.critter])

  const closePopover = useCallback(() => {
    setPopover({ open: false, critter: null, anchorEl: null })
  }, [])

  // ?add=1 (FAB create sheet) or packet/variety deep-link params open the Add form.
  // ?add strips immediately (replace) so a repeat deep-link re-triggers; the packet
  // params persist until close so the editor can fetch/prefill (old Plants.jsx contract).
  useEffect(() => {
    if (searchParams.get('add') === '1' || sourceInventoryItemId || queryVarietyId) {
      setEditor(e => (e && e.mode === 'add') ? e : { mode: 'add' })
      if (searchParams.get('add') === '1') {
        const next = new URLSearchParams(searchParams)
        next.delete('add')
        setSearchParams(next, { replace: true })
      }
    }
  }, [searchParams, sourceInventoryItemId, queryVarietyId, setSearchParams])

  // V3-EDIT-001: ?edit=<plantingId> (PlantingDetail Edit button) opens that planting's
  // edit form, then strips the param (replace) so a repeat deep-link re-triggers.
  useEffect(() => {
    const editId = searchParams.get('edit')
    if (!editId || loading) return
    const next = new URLSearchParams(searchParams)
    next.delete('edit')
    setSearchParams(next, { replace: true })
    const target = plants.find(p => String(p.id) === String(editId))
    if (target) {
      setEditor({ mode: 'edit', plant: target })
      setTimeout(() => {
        document.getElementById('planting-editor')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
      }, 60)
    }
  }, [searchParams, loading, plants, setSearchParams])

  const closeEditor = useCallback(() => {
    setEditor(null)
    if (sourceInventoryItemId || queryVarietyId) {
      const next = new URLSearchParams(searchParams)
      next.delete('source_inventory_item_id')
      next.delete('variety_id')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams, sourceInventoryItemId, queryVarietyId])

  // V3-IA photo restore + V3-GARDEN-001 logging-loop fix: refetch the full /api/plants list.
  // Declared ABOVE the create/update/delete handlers so they can call it to re-hydrate rows.
  // WHY (V3-GARDEN-001): the POST /api/plants response lacks the nested variety_ref join, so an
  // optimistic prepend shows a variety-less row until a reload. Refetching pulls the hydrated row
  // (variety_ref + server-side featured_photo_view_url auto-promote) without a tab refresh.
  // Same contract as the retired Plants.jsx.
  const refetchPlants = useCallback(async () => {
    try {
      const fresh = await fetch('/api/plants')
      setPlants(fresh ?? [])
    } catch {
      /* non-fatal — stale row heals on next mount */
    }
  }, [fetch])

  const onPlantCreated = useCallback((pl) => {
    // Optimistic prepend (instant feedback) — the row is variety-less until refetch hydrates it.
    setPlants(prev => [pl, ...prev])
    // Auto-expand the new planting's project so the row is actually visible (it hangs under it).
    if (pl?.project_id != null) {
      setExpanded(prev => {
        const next = new Set(prev).add(pl.project_id)
        persistExpanded(next)
        return next
      })
    }
    // Ambient new-row acknowledgment: flash the row, then clear (no toast/banner — §reward-UX).
    setFlashId(pl?.id ?? null)
    setTimeout(() => setFlashId(null), 1200)
    // Re-hydrate from the server so variety_ref (and featured photo) populate the row.
    refetchPlants()
  }, [refetchPlants, setFlashId])

  const onPlantUpdated = useCallback((pl) => {
    setPlants(prev => prev.map(x => x.id === pl.id ? pl : x))
    refetchPlants()
  }, [refetchPlants])

  const onPlantDeleted = useCallback((id) => {
    setPlants(prev => prev.filter(x => x.id !== id))
    refetchPlants()
  }, [refetchPlants])

  const onPlantArchived = useCallback((plant) => {
    // Remove from the active list immediately (it's now hidden), refetch for truth, offer Undo.
    setPlants(prev => prev.filter(x => x.id !== plant.id))
    refetchPlants()
    setArchiveUndo({ id: plant.id, name: plant.name ?? 'Planting', expiresAt: Date.now() + 6000 })
  }, [refetchPlants])

  const undoArchive = useCallback(async () => {
    if (!archiveUndo) return
    const id = archiveUndo.id
    setArchiveUndo(null)
    try {
      await fetch('/api/plants/' + id + '/archive', { method: 'PATCH', body: JSON.stringify({ archived: false }) })
    } catch { /* non-fatal */ }
    refetchPlants()
  }, [archiveUndo, fetch, refetchPlants])

  useEffect(() => {
    if (!archiveUndo) return
    const remaining = archiveUndo.expiresAt - Date.now()
    if (remaining <= 0) { setArchiveUndo(null); return }
    const t = setTimeout(() => setArchiveUndo(null), remaining)
    return () => clearTimeout(t)
  }, [archiveUndo])

  const toggle = useCallback((id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      persistExpanded(next)
      return next
    })
  }, [])

  // Group critters by plant_id (target_id falls back to plant_id) for O(1) lookup in PlantingTile.
  const crittersByPlantId = useMemo(() => {
    const m = new Map()
    for (const c of critters) {
      const key = c.plant_id ?? c.target_id
      if (!key) continue
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(c)
    }
    return m
  }, [critters])

  // Phase B eligibility (§3.7, §3.9 step 3). V101 (2026-06-01): baseline residents RETIRED —
  // robin/honeybee (1,2) are earnable commons and COUNT toward coachmark/opt-in like any critter
  // (coupling=YES, Dave 2026-06-01). Filter is now all critters with a valid species_id.
  const earnedCritters = useMemo(
    () => critters.filter(c => Number.isInteger(c.species_id)),
    [critters]
  )

  const earliestEarnedAt = useMemo(() => {
    let min = null
    for (const c of earnedCritters) {
      const t = c.earned_at ? Date.parse(c.earned_at) : NaN
      if (Number.isFinite(t) && (min === null || t < min)) min = t
    }
    return min
  }, [earnedCritters])

  // Coachmark renders on SECOND garden-view visit after first earned critter (§3.9 step 3).
  // "Second visit" detected via: prev last_garden_view_at > earliestEarnedAt
  //   (i.e., user has already visited Garden at least once SINCE the first earned critter
  //   was earned — that prior visit was the unmediated Stage 2 delight beat).
  const coachmarkEligible = useMemo(() => {
    if (!prefs) return false
    if (prefs.coachmark_seen_at) return false
    if (earnedCritters.length === 0) return false
    if (earliestEarnedAt === null) return false
    const prev = prefs.last_garden_view_at ? Date.parse(prefs.last_garden_view_at) : NaN
    if (!Number.isFinite(prev)) return false
    return prev > earliestEarnedAt
  }, [prefs, earnedCritters, earliestEarnedAt])

  // Opt-in renders only when SYSTEM_NOTIFICATIONS_ENABLED feature flag is true (currently false in V2.x).
  // Phase B opt-in code ships dormant per §3.8 suppression-flag fix — when the flag flips post-V2.x,
  // the prompt activates on first eligible critter event AFTER the flip (no permanent suppression).
  const optInEligible = useMemo(() => {
    if (!SYSTEM_NOTIFICATIONS_ENABLED) return false
    if (!prefs) return false
    if (!prefs.coachmark_seen_at) return false
    if (prefs.opt_in_prompt_seen_at) return false
    return earnedCritters.length >= OPT_IN_CRITTER_THRESHOLD
  }, [prefs, earnedCritters])

  // Dismiss callbacks — fire-and-forget POSTs (NEVER throw, NEVER block render).
  // recordCoachmarkDismissed fires ONLY when CritterCoachmark's 1500ms min-visible gate passes.
  // recordOptInDismissed fires ONLY when CritterOptInPrompt actually rendered (suppression-flag fix §3.8).
  const onCoachmarkDismiss = useCallback(() => {
    recordCoachmarkDismissed({ getToken })
  }, [getToken])

  const onOptInDismiss = useCallback(() => {
    recordOptInDismissed({ getToken })
  }, [getToken])

  // V4-ASSIGNLENS-001 — caretaker lens derived values. Declared AFTER all useState (projects/plants/
  // members) and BEFORE the early returns so hook order is stable (rules-of-hooks). Default 'all'
  // (Everyone) keeps the current no-hide behaviour; 'Mine'/per-person NARROWS the view.
  const projectsById = useMemo(() => buildProjectsById(projects), [projects])
  const caretakerMap = useMemo(() => buildCaretakerMap(members, profile?.id), [members, profile])
  const careLensOptions = useMemo(() => lensOptions(members, profile?.id), [members, profile])
  const effectiveLens = careLensOptions.some(o => o.value === careLens) ? careLens : 'all'
  const visiblePlants = useMemo(() => (
    effectiveLens === 'all' ? plants : plants.filter(pl => effectiveAssignee(pl, projectsById) === effectiveLens)
  ), [plants, effectiveLens, projectsById])
  const showBadges = useMemo(() => (
    effectiveLens === 'all' && caretakerMap.size > 1 && hasMixedCaretakers(visiblePlants, projectsById)
  ), [effectiveLens, caretakerMap, visiblePlants, projectsById])
  const caretakerFor = useCallback((pl) => (
    showBadges ? (caretakerMap.get(effectiveAssignee(pl, projectsById)) || null) : null
  ), [showBadges, caretakerMap, projectsById])

  if (loading) return <Shell><Spinner /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>

  const effectiveGroupBy = facetOptions.some(o => o.value === groupBy) ? groupBy : 'none'
  const tree = buildGardenTree(projects, visiblePlants, SORT_ALPHA)

  return (
    <Shell>
      {/* V3-GARDEN-001 ambient new-row ack: one-time @keyframes injection (mirrors the
          CritterArrival injected-<style> precedent — there is NO global CSS file). A new
          planting row gets a brief background highlight that fades out. Pure visual flourish:
          no toast/modal/banner/snackbar/sound/haptic/badge, no text copy (reward-UX ambient rule). */}
      <style>{`
        @keyframes garden-newrow-highlight {
          0%   { background-color: rgba(123,168,90,0.35); }
          60%  { background-color: rgba(123,168,90,0.18); }
          100% { background-color: transparent; }
        }
      `}</style>
      {/* MVP-Critter Phase B: coachmark (§3.7) + opt-in prompt (§3.8).
          Both ambient inline strips, NEVER overlays. Render null when not eligible. */}
      <CritterCoachmark eligible={coachmarkEligible} onDismiss={onCoachmarkDismiss} />
      <CritterOptInPrompt eligible={optInEligible} onDismiss={onOptInDismiss} />

      {/* V3-IA: no page title — the Garden tab is self-evident. V200 Slice 3 adds the
          Plants|Photos sub-tab switch; Plants-only controls stay on the Plants sub-tab. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        <SegmentedControl
          options={[{ value: 'plants', label: 'Plants' }, { value: 'photos', label: 'Photos' }]}
          value={subtab}
          onChange={setSubtab}
          ariaLabel="Plants or Photos"
        />
        {subtab === 'plants' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {facetOptions.length > 1 && (
              <GroupByControl options={facetOptions} value={effectiveGroupBy} onChange={onGroupByChange} />
            )}
            <Link to="/capture" data-testid="snap-entry-garden" style={btnGhost}>📸 Snap</Link>
            <Link to="/log/many" style={btnGhost}>⚡ Log many</Link>
            {/* V4-APPBAR-003: Favorites rehomed here from the retired header heart (Dave: into the Garden tab). */}
            <Link to="/favorites" aria-label="Favorites" style={btnGhost}>♥ Favorites</Link>
          </div>
        )}
      </div>

      {subtab === 'plants' && careLensOptions.length > 2 && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 16 }}>
          <SegmentedControl options={careLensOptions} value={effectiveLens} onChange={onCareLensChange} ariaLabel="Show plantings by caretaker" />
        </div>
      )}

      {subtab === 'photos' && <PhotosWall />}

      {subtab === 'plants' && editor && (
        <PlantingEditor
          mode={editor.mode}
          plant={editor.plant ?? null}
          plants={plants}
          projects={projects.filter(p => !p.archived_at)}
          fetch={fetch}
          sourceInventoryItemId={editor.mode === 'add' ? sourceInventoryItemId : null}
          varietyId={editor.mode === 'add' ? queryVarietyId : null}
          onCreated={onPlantCreated}
          onUpdated={onPlantUpdated}
          onDeleted={onPlantDeleted}
          onArchived={onPlantArchived}
          onClose={closeEditor}
        />
      )}

      {subtab === 'plants' && (effectiveGroupBy !== 'none' ? (
        <FacetedGarden
          plants={visiblePlants} tagMap={tagMap} facet={effectiveGroupBy}
          crittersByPlantId={crittersByPlantId} onSpriteLongPress={onSpriteLongPress}
          onSpriteIntersect={onSpriteIntersect} onPhotoUploaded={refetchPlants} flashId={flashId}
          caretakerFor={caretakerFor} />
      ) : tree.length === 0 ? (
        <EmptyState />
      ) : (
        <div role="tree" aria-label="Garden" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tree.map(node => (
            <TreeNode key={node.project.id} node={node} expanded={expanded} onToggle={toggle} level={1}
              crittersByPlantId={crittersByPlantId}
              onSpriteLongPress={onSpriteLongPress}
              onSpriteIntersect={onSpriteIntersect}
              onPhotoUploaded={refetchPlants}
              flashId={flashId}
              caretakerFor={caretakerFor} />
          ))}
        </div>
      ))}

      {/* MVP-Critter Session 3 D-INV-1: long-press species-prefs popover.
          Anchored to long-pressed sprite. Single instance at a time. */}
      <LoveMehPopover
        open={popover.open}
        anchorRef={{ current: popover.anchorEl }}
        species={popover.critter ? SPECIES_BY_ID[popover.critter.species_id] : null}
        onPick={onPrefsPick}
        onClose={closePopover}
      />

      {archiveUndo && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          backgroundColor: P.dark, color: P.white, padding: '10px 14px 10px 18px', borderRadius: 8,
          fontSize: '0.9rem', boxShadow: '0 4px 16px rgba(0,0,0,0.18)', zIndex: 1000,
          display: 'flex', alignItems: 'center', gap: 14, maxWidth: '92%',
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Archived <strong>{archiveUndo.name}</strong>
          </span>
          <button type="button" onClick={undoArchive} style={{
            background: 'none', border: 'none', color: P.greenLight, fontWeight: 700,
            fontSize: '0.9rem', cursor: 'pointer', flexShrink: 0,
          }}>Undo</button>
        </div>
      )}
    </Shell>
  )
}

function TreeNode({ node, expanded, onToggle, level, crittersByPlantId, onSpriteLongPress, onSpriteIntersect, onPhotoUploaded, flashId, caretakerFor = () => null }) {
  const { project: p, depth, children, plantings } = node
  const hasKids = nodeHasChildren(node)
  const isOpen  = hasKids && expanded.has(p.id)
  const indent = depth * 20

  const summary = hasKids
    ? `${children.length ? children.length + (children.length === 1 ? ' project' : ' projects') : ''}${children.length && plantings.length ? ' · ' : ''}${plantings.length ? plantings.length + (plantings.length === 1 ? ' planting' : ' plantings') : ''}`
    : ''

  const nameMeta = (
    <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: P.green, fontSize: '0.95rem' }}>{p.name}</span>
      </div>
      {summary && <div style={{ fontSize: '0.75rem', color: P.light, marginTop: 2 }}>{summary}</div>}
      {p.location_path && <div style={{ fontSize: '0.78rem', color: P.mid, marginTop: 2 }}>📍 {p.location_path}</div>}
    </div>
  )

  return (
    <div role="treeitem" aria-level={level} aria-expanded={hasKids ? isOpen : undefined} style={{ paddingLeft: indent }}>
      <div style={{
        backgroundColor: P.white, border: `1px solid ${P.border}`,
        borderLeft: depth > 0 ? `3px solid ${P.greenLight}` : `1px solid ${P.border}`,
        borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        {/* PHOTO / icon — OPENS detail (Variant A: picture = go in) */}
        <Link to={`/projects/${p.id}`} aria-label={`Open ${p.name}`} style={thumbWrap}>
          {p.featured_photo_view_url
            ? <img src={p.featured_photo_view_url} alt="" style={thumbImg} />
            : <span aria-hidden="true" style={{ fontSize: '1.25rem' }}>🌿</span>}
        </Link>

        {/* BODY — PEEK (toggle) when it has children; OPEN when it's a leaf */}
        {hasKids ? (
          <button type="button" onClick={() => onToggle(p.id)} aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${p.name}`} style={bodyBtn}>
            {nameMeta}
          </button>
        ) : (
          <Link to={`/projects/${p.id}`} style={{ ...bodyBtn, textDecoration: 'none' }}>
            {nameMeta}
          </Link>
        )}

        <FavoriteToggle entityType="project" entityId={p.id} />

        <ProjectStatusBadge status={p.status} />

        {hasKids ? (
          <button type="button" onClick={() => onToggle(p.id)} aria-hidden="true" tabIndex={-1}
            style={chevronBtn}>
            <span style={{ display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', color: P.mid }}>›</span>
          </button>
        ) : (
          <span style={{ color: P.border, fontSize: '1rem', flexShrink: 0, width: 28, textAlign: 'center' }}>›</span>
        )}
      </div>

      {isOpen && (
        <div role="group" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {plantings.length > 0 && (
            <TileGrid items={plantings} columns={2} gap={12} ariaLabel="Plantings"
              renderItem={(pl) => (
                <PlantingTile planting={pl}
                  critters={crittersByPlantId?.get(pl.id) ?? []}
                  onSpriteLongPress={onSpriteLongPress}
                  onSpriteIntersect={onSpriteIntersect}
                  onPhotoUploaded={onPhotoUploaded}
                  flashId={flashId}
                  caretaker={caretakerFor(pl)}
                  onOpen={() => setPlantingSequence({
                    items: plantings.map(x => ({ projectId: x.project_id, plantingId: x.id, name: x.name })),
                    ctxLabel: p.name,
                  })} />
              )} />
          )}
          {children.map(c => <TreeNode key={c.project.id} node={c} expanded={expanded} onToggle={onToggle} level={level + 1}
            crittersByPlantId={crittersByPlantId}
            onSpriteLongPress={onSpriteLongPress}
            onSpriteIntersect={onSpriteIntersect}
            onPhotoUploaded={onPhotoUploaded}
            flashId={flashId}
            caretakerFor={caretakerFor} />)}
        </div>
      )}
    </div>
  )
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 88px)', backgroundColor: P.cream, position: 'relative' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px', position: 'relative' }}>{children}</div>
    </div>
  )
}
// V4-GARDENIA-001: faceted Garden render. Group-by overlay over the SAME PlantingTile the legacy
// tree uses, so plantings look identical; the by-project tree (effectiveGroupBy==='none') is
// untouched and remains golden-gated. A planting may appear under multiple groups (multi-membership).
function FacetedGarden({ plants, tagMap, facet, crittersByPlantId, onSpriteLongPress, onSpriteIntersect, onPhotoUploaded, flashId, caretakerFor = () => null }) {
  // Sections COLLAPSED by default (Dave 2026-06-26): track the EXPANDED set instead of collapsed,
  // so an empty set = everything collapsed. Toggling a header adds/removes it from expandedGroups.
  const [expandedGroups, setExpandedGroups] = useState(() => loadGroupsExpanded())
  const toggle = useCallback((slug) => setExpandedGroups(prev => {
    const next = new Set(prev); next.has(slug) ? next.delete(slug) : next.add(slug); saveGroupsExpanded(next); return next
  }), [])
  const groups = buildTagGroupedList(plants, tagMap, facet) || []
  if (groups.length === 0) return <EmptyState />
  // Expand-all / Collapse-all — complements collapse-by-default so the whole view is one tap away.
  const allExpanded = groups.length > 0 && groups.every(g => expandedGroups.has(g.slug))
  const toggleAll = () => setExpandedGroups(() => { const next = allExpanded ? new Set() : new Set(groups.map(g => g.slug)); saveGroupsExpanded(next); return next })
  return (
    <div role="tree" aria-label="Garden grouped by tag" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" onClick={toggleAll}
          aria-label={allExpanded ? 'Collapse all sections' : 'Expand all sections'}
          style={{ ...btnGhost, cursor: 'pointer', padding: '4px 10px', fontSize: '0.78rem' }}>
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      {groups.map(g => {
        const isCollapsed = !expandedGroups.has(g.slug)
        return (
          <div key={g.slug} role="group">
            <FacetGroupHeader label={g.label} count={g.count} facet={g.facet} value={g.slug}
              isUnsorted={g.isUnsorted} collapsed={isCollapsed} onToggle={() => toggle(g.slug)} />
            {!isCollapsed && (
              <div style={{ marginTop: 8 }}>
                <TileGrid items={g.plantings} columns={2} gap={12} ariaLabel={g.label}
                  renderItem={(pl) => (
                    <PlantingTile planting={pl}
                      critters={crittersByPlantId?.get(pl.id) ?? []}
                      onSpriteLongPress={onSpriteLongPress} onSpriteIntersect={onSpriteIntersect}
                      onPhotoUploaded={onPhotoUploaded} flashId={flashId}
                      caretaker={caretakerFor(pl)}
                      onOpen={() => setPlantingSequence({
                        items: g.plantings.map(x => ({ projectId: x.project_id, plantingId: x.id, name: x.name })),
                        ctxLabel: g.label,
                      })} />
                  )} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Spinner() { return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div> }
function ErrMsg({ msg }) { return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div> }

function EmptyState() {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8 }}>
      <div style={{ fontSize: '3rem', marginBottom: 12 }}>🌿</div>
      <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>Your garden is empty</p>
      <p style={{ margin: '0 0 24px', color: P.light, fontSize: '0.875rem' }}>
        Start a project, then add plantings to it. Everything you grow lives here.
      </p>
      <Link to="/projects/new" style={btnLink}>Create your first project</Link>
    </div>
  )
}

const thumbWrap = {
  flexShrink: 0, width: 40, height: 40, borderRadius: 8, overflow: 'hidden',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  backgroundColor: P.greenPale, textDecoration: 'none',
}
const thumbImg = { width: 40, height: 40, objectFit: 'cover', display: 'block' }
const bodyBtn = {
  flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', minHeight: 44,
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
}
const chevronBtn = {
  flexShrink: 0, width: 36, minHeight: 44, background: 'none', border: 'none',
  cursor: 'pointer', fontSize: '1.1rem', display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const btnLink = { backgroundColor: P.green, color: P.white, textDecoration: 'none', borderRadius: 6, padding: '9px 14px', fontSize: '0.85rem', fontWeight: 600 }
const btnGhost = { backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`, textDecoration: 'none', borderRadius: 6, padding: '8px 13px', fontSize: '0.85rem', fontWeight: 600 }
