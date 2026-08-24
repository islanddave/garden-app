// PlantingDetail — V3-NAV-001 (Lane C / PR2). The dedicated detail page for a single planting.
// Route: /projects/:id/plantings/:plantingId  (matches the /projects/:id/... family; :id is the
// project, :plantingId the planting). Static-imported + route-ErrorBoundary-wrapped in App.jsx,
// mirroring EventDetail (the app uses no React.lazy).
//
// Data: GET /api/plants/:plantingId returns the full enriched record (variety_ref, status,
// sown_at, transplanted_at, qty_*, source_*/lineage_note, project_id, project_name,
// featured_photo_view_url, next_water_at/last_watered_at/watering_interval_days). Planting-scoped
// event log: GET /api/events?project_id=:id&plant_id=:plantingId — the HS-2 server-side filter.
//
// V200 Slice 5b: the header is now a full-bleed photo HERO (HeroPhoto) carrying the planting name
// (rendered AS the page <h1>), lifecycle status, a gold key-fact pill, and a Details pill that
// opens a tabbed Details fly-up (Basics/Care/More). The old flat "Details" card is GONE — its
// rows live in the fly-up. A GrowthStrip narrates the plant's photo timeline; the Photos grid and
// the hero both open the shared Lightbox gallery.
//
// A11y: status is multi-channel (icon + label + color via PlantStatusBadge, never color alone);
// sticky section headers give a jump anchor for the flat single-column layout; scroll-to-top on
// mount (BrowserRouter doesn't reset scroll on push); breadcrumb is arbitrary-depth.
import React, { useState, useEffect, useRef, useCallback, useMemo, useId } from 'react'
// V4-EVENTHISTPAGE-001 (BD0806-19) — the event log used to stop at the first 50 with nothing saying
// so. GET /api/events (Route 4) reads `Math.min(parseInt(limit ?? '50'), 200)`, so 200 is a hard
// server ceiling per request. Route 4 DOES now expose an `offset` param (BUG-PROJEVENTTRUNC-001,
// 2026-08-13) — ProjectDetail uses it because containers exceed the ceiling. This surface deliberately
// does not: no planting comes close, so one ceiling-sized request is still the whole history.
// Prod's busiest planting carries 156 events and none exceed 200, so asking for the ceiling returns
// every planting's complete history today. The rows are then revealed a page at a time client-side —
// a 156-row list dumped into one 390px scroll is not an improvement on a truncated one — and if the
// server ever DOES return exactly the ceiling we say the history is clipped rather than lying quietly.
const EVENT_FETCH_LIMIT = 200
const EVENT_PAGE_SIZE = 50
// BUG-PLANTHARVCURSOR-001 — a BOUND on the harvest-entry drain, not a limit. /api/harvests pages at
// PAGE_LIMIT = 50, and the chips it feeds can only ever land on an event the timeline rendered, so
// EVENT_FETCH_LIMIT/50 = 4 pages already covers every event this page will ever show. 8 is double
// that, which leaves room for the endpoint's page size to shrink without silently clipping. Hitting
// it means something is wrong upstream, so the drain stops and the rowset is treated as a PREFIX
// (the BUG-EXPORTDRAINBOUND-001 rule) rather than as the whole harvest history.
export const MAX_HARVEST_PAGES = 8
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useOverlayNavigate, useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { setReloadBlocked } from '../lib/reloadGate.js'
import PlantingEditor from '../components/PlantingEditor.jsx'
import { useCachedFetch } from '../hooks/useCachedFetch.js'
import { resolvePager, resolveSwipe } from '../lib/plantingSequence.js'
import AssigneePicker from '../components/AssigneePicker.jsx'
import { P } from '../lib/constants.js'
import Icon from '../components/Icon.jsx'
import { formatQty } from '../lib/format.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import Lightbox from '../components/Lightbox.jsx'
import { useOptionalToast } from '../context/ToastContext.jsx'
import Sheet from '../components/forms/Sheet.jsx'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import { useUxFlow, FLOWS } from '../lib/uxEvents.js'
import { PLANT_SOURCE_LABELS , PLANT_CONTAINER_TYPE_LABELS } from '../lib/dropdownRegistry.js'
import HeroPhoto from '../components/planting/HeroPhoto.jsx'
import QuickActions from '../components/planting/QuickActions.jsx'
import LifeStoryTimeline from '../components/planting/LifeStoryTimeline.jsx'
import CropCard from '../components/planting/CropCard.jsx'
import CareStatus from '../components/CareStatus.jsx'
import OverwinterPrompt from '../components/planting/OverwinterPrompt.jsx'
import GrowthStrip from '../components/planting/GrowthStrip.jsx'
import PhotoImg from '../components/PhotoImg.jsx'
import PutUpFromPlanting from '../components/planting/PutUpFromPlanting.jsx'
import HarvestFromPlanting from '../components/planting/HarvestFromPlanting.jsx'
import { formatBotanical } from '../lib/keyFact.js'
import { buildLifeStory } from '../lib/lifeStory.js'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'
import { describeHarvestWeight, sumHarvestWeights, serverWeightTotal, weightBasisLabel, NO_WEIGHT_COPY } from '../lib/harvestWeight.js'
import { vesselDataGaps } from '../lib/vesselData.js'



function fmtDate(value) {
  if (!value) return null
  const d = new Date(typeof value === 'string' && value.length === 10 ? value + 'T00:00:00' : value)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

// V4-PLANTINGRAWDETAIL-001 — the raw value cell for the All-fields tab.
// A null is STATED, never dropped. The curated row arrays all end in `.filter(([, v]) => v)`, and a
// completeness surface that inherited that filter would answer "is germinated_at recorded on this
// planting?" with silence — indistinguishable from the column not existing, which is the one answer
// this tab exists to replace. That same filter is why `false` must survive: sown_at_approx is a real
// boolean column and a falsy-filtered surface would hide every un-approximated date.
// Objects and arrays go through JSON so variety_ref/metadata read as data instead of "[object
// Object]", and an empty string is shown AS an empty string rather than folded into the null copy —
// on a raw surface "" and NULL are different facts and a blank cell is indistinguishable from a bug.
// Nothing else is formatted: the tab's promise is completeness, and per-field prettying here would
// just be a second curated list wearing a different hat.
const RAW_NOT_RECORDED = 'Not recorded'
// Length elision, NOT per-field formatting — the distinction matters and is why this does not
// contradict the note above. featured_photo_view_url is a presigned S3 URL ~700 chars long: dumping
// it whole is a wall of text on a 390px screen and puts a time-limited credential on screen as
// readable text, while adding nothing (the same URL is already the <img src> below). Eliding by
// LENGTH keeps the tab's completeness promise — the field is still listed, still distinguishes ""
// from NULL, still shows its head and its true size — without a rule that knows about any one field.
const RAW_MAX_CHARS = 120
const RAW_HEAD_CHARS = 60
function rawFieldValue(value) {
  if (value === null || value === undefined) return RAW_NOT_RECORDED
  if (typeof value === 'object') return JSON.stringify(value)
  const s = String(value)
  if (s === '') return '""'
  return s.length > RAW_MAX_CHARS ? `${s.slice(0, RAW_HEAD_CHARS)}… (${s.length} chars)` : s
}

export default function PlantingDetail() {
  const { id: projectId, plantingId } = useParams()
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [savingFeatured, setSavingFeatured] = useState(null)  // V4-PHOTOFEATURE-001: photo id in flight
  const ux = useUxFlow(FLOWS.OPEN_PLANTING)
  const navigate = useNavigate()
  const overlayNavigate = useOverlayNavigate()
  // PLANTING-PAGER refs: commit-lock (ignore paging until the target settles), a deferred
  // focus-move to the pager after a paged planting loads, the pager DOM node, and swipe start.
  const navLockRef = useRef(false)
  const pendingFocusRef = useRef(false)
  const pagerRef = useRef(null)
  const swipeRef = useRef(null)

  const [planting, setPlanting] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [unarchiving, setUnarchiving] = useState(false)  // V3-ARCHIVE-001: planting restore path
  const [archiving, setArchiving] = useState(false)      // V4-ARCHIVEINPLACE-001: archive-in-place
  const [refreshKey, setRefreshKey] = useState(0)  // V4-PLANTINGUI-001: bump to refetch events after a quick-log

  // V4-EDITINPLACE-001 (BUG-EDITLEAVESPAGE-001) — Edit opens the form HERE instead of navigating to
  // /garden?edit=<id>. Deliberately component state and NOT a query param: a param would put the
  // open editor in the URL, so a reload would silently reopen it over a planting the user may have
  // moved on from, and it is the param round-trip itself that broke this affordance in the first
  // place. `editorPlants` is fetched lazily on first open — the ONLY thing PlantingEditor wants
  // from a host that this page does not already hold (it feeds the parent-planting lineage picker;
  // an empty list renders that picker with no options rather than failing).
  const [editing, setEditing] = useState(false)
  const [editorDirty, setEditorDirty] = useState(false)
  // V4-SHEETBUSY-001 — the editor's in-flight-write signal, fed to <Sheet busy> below. Separate
  // state from editorDirty because they are different questions with different answers: a Save
  // tapped on an untouched form is busy and NOT dirty, and a half-typed form is dirty and NOT busy.
  const [editorBusy, setEditorBusy] = useState(false)
  const [editorPlants, setEditorPlants] = useState([])

  // The same 3-piece dirty contract Garden.jsx joined in V4-PLANTEDITORWIRE-001, for the same
  // reason and with the same exclusions: the EDITOR is the whole predicate. Everything else this
  // page holds (planting, events, harvests, photos, the Details fly-up tab, the lightbox index) is
  // fetched or ambient chrome that a reload restores, so widening this would hold a deploy for
  // someone merely reading a planting.
  const hasUnsavedInput = editing && editorDirty

  // Inert today in the same forward-compatible way it is inert on Garden — App.jsx registers
  // /plantings/:plantingId without `overlayable`, so no OverlayDirtyProvider sits above this page.
  // It is the shape a flyover would need, and costs nothing to carry now.
  useReportOverlayDirty(hasUnsavedInput)

  // V4-RELOADGATEWIRE-001 shape: per-instance key (reloadGate holds a Set, so a shared literal
  // would let one instance's unmount release another's hold) and a BOOLEAN dep (the cleanup
  // release NOTIFIES registerSW's listeners, so a dep changing mid-form would fire a reload the
  // user is still typing under). This is the guard that actually runs on this surface.
  const reloadGateKey = `planting:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  // Clears dirty as well as open. PlantingEditor releases its own onDirty(false) on unmount, but
  // that lands a commit later; leaving `editorDirty` true in the gap would keep the reload gate
  // held by a form that is already gone.
  const closeEditor = useCallback(() => {
    setEditing(false)
    setEditorDirty(false)
    // Same one-commit-early reasoning for busy: PlantingEditor's unmount release lands a commit
    // later, and a stale true would leave the NEXT open of the editor undismissable from the first
    // frame — the stuck-busy trap the bounded Back guard exists to survive, reached with no write.
    setEditorBusy(false)
  }, [])

  // BUG-DIRTYDISMISSGAP-001 — the guard `dirty` does not actually provide, and this surface is the
  // worst-exposed of the four that pass it.
  //
  // `dirty` gates the BACKDROP TAP only: confirmOnDirty defaults FALSE at both registry call sites
  // (dismissLayers.js:78, backNav.js:75) pending a ConfirmSheet primitive that does not exist, so
  // Escape and Android hardware Back dismiss a dirty form outright. The comment on the <Sheet>
  // below says `dirty` "is what makes decideDismiss confirm before discarding typing" — that is
  // ASPIRATIONAL, describing the contract once confirmOnDirty is on, and it is not true today.
  //
  // Recovery differs per surface and that is what makes this one the priority: EventNew carries a
  // full draftStash so a discarded /log overlay can be restored, SowNow stashes an id. PlantingEditor
  // has NO draft stash, so everything typed here is simply gone. Dave is Android-only, so Back —
  // not Escape — is the gesture that actually fires it.
  //
  // Deliberately the SAME window.confirm shape Garden.jsx uses for the add path (and the line
  // ProjectTypes.jsx:81 / Locations.jsx:179 already draw), so the two hosts of this one editor stay
  // consistent. A per-surface patch, NOT the fix — the fix is ConfirmSheet + confirmOnDirty, or a
  // draft stash in PlantingEditor. Wired to the SHEET only: the editor's own Cancel and its
  // post-save close keep plain closeEditor, because a save that SUCCEEDED must never ask to discard.
  const requestCloseEditor = useCallback(() => {
    if (editorDirty && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm('Discard your changes? What you typed will be lost.')) return
    }
    closeEditor()
  }, [editorDirty, closeEditor])

  // The parent-planting (lineage) picker is the ONLY thing PlantingEditor wants that this page
  // does not already hold. Fetched on first open rather than with the page: it costs a round trip
  // that a reader who never taps Edit should not pay, and an empty list renders that one picker
  // with no options instead of failing. Grid projection because only {id,name} is read.
  useEffect(() => {
    if (!editing || editorPlants.length) return
    let cancelled = false
    fetch('/api/plants?view=grid')
      .then(rows => { if (!cancelled) setEditorPlants(Array.isArray(rows) ? rows : []) })
      .catch(() => { /* lineage picker degrades to empty — never blocks the edit */ })
    return () => { cancelled = true }
  }, [editing, editorPlants.length, fetch])

  // V200 Slice 5b — Details fly-up (tabbed) + Lightbox gallery state.
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [tab, setTab] = useState('basics')
  const [lightboxIndex, setLightboxIndex] = useState(null)  // null = closed
  const [lbFrozen, setLbFrozen] = useState(null)            // slide snapshot at open (regression I4)

  // V4-BACKNAV-001 Slice P — the system Back closes the Details fly-up instead of walking off this
  // page. Scoped to Details only: the Lightbox on this same page is deliberately NOT wired yet (it
  // has its own zoom sub-state, so Back there should arguably reset zoom before closing — a
  // precedence question that belongs to the Slice 3 arbiter, not to a pilot).

  // Event log has its OWN lifecycle (DoD: don't conflate filtered-empty with failed-load).
  const [events, setEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [eventsError, setEventsError] = useState(null)
  // V4-EVENTHISTPAGE-001: how many of the fetched events are on screen. Raised a page at a time by
  // the Show-more control below; reset by the fetch effect so a re-fetch never leaves a stale count.
  const [eventsShown, setEventsShown] = useState(EVENT_PAGE_SIZE)

  // V3-PHOTOMULTI-001 (V1, display-only): every photo linked to THIS planting — uploaded directly
  // (plant_id) or attached to one of its events (event_id). No backend/migration: read the
  // project's photos (same source as the Photo Library) and filter client-side.
  // V4-IMGCACHE-001 D-1: the planting's attached photos through the SWR cache (?attachedTo resolves the
  // plant_id∪event_id union server-side). The de-dup + sort stays a client useMemo over the cached RAW
  // list so the store snapshot ref stays stable (a no-op revalidate doesn't re-derive / remount).
  const attachedKey = planting ? `/api/photos?attachedTo=${planting.id}` : null
  const { data: rawPhotos, loading: photosLoading, refetch: refetchPhotos } = useCachedFetch(attachedKey)
  const photos = useMemo(() => {
    const seen = new Set()
    const mine = (rawPhotos ?? []).filter(p => (seen.has(p.id) ? false : seen.add(p.id)))
    mine.sort((a, b) => String(b.created_at || b.taken_at || '').localeCompare(String(a.created_at || a.taken_at || '')))
    return mine
  }, [rawPhotos])

  // Scroll-to-top on open AND on every paging change. PlantingDetail does NOT remount when only
  // the :plantingId param changes (same <Route element>), so this MUST key on plantingId — a
  // mount-only effect would leave a paged planting scrolled to the previous offset.
  useEffect(() => { window.scrollTo(0, 0) }, [plantingId])

  // PLANTING-PAGER navigation — history REPLACE so Back returns to the originating Garden list
  // instead of replaying every paged step. Commit-locked (navLockRef) until the target loads.
  const go = useCallback((href) => {
    if (!href || navLockRef.current) return
    navLockRef.current = true
    pendingFocusRef.current = true
    navigate(href, { replace: true })
  }, [navigate])

  // Release the commit-lock + move focus to the pager once a paged-to planting has loaded. Keyed
  // on `loading` (the fetch effect flips it) so the lock spans the whole load, not just the nav.
  useEffect(() => {
    if (loading) return
    navLockRef.current = false
    if (pendingFocusRef.current) {
      pendingFocusRef.current = false
      try { pagerRef.current?.focus() } catch { /* jsdom / detached node */ }
    }
  }, [loading, plantingId])

  // Load the planting record. 404 (or ownership mismatch) → friendly not-found, not a thrown error.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setNotFound(false)
    fetch('/api/plants/' + plantingId)
      .then(data => {
        if (cancelled) return
        // Ownership guard: the URL's project segment must match the planting's real project.
        // A hand-edited /projects/<other>/plantings/<id> resolves the planting but to the wrong
        // project → treat as not-found (404 semantics, NOT 403 — don't leak existence).
        if (!data || (projectId && data.project_id && data.project_id !== projectId)) {
          setNotFound(true)
          setLoading(false)
          return
        }
        setPlanting(data)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        // The by-id endpoint 404s when the id isn't in the household → friendly not-found.
        if (err?.status === 404) setNotFound(true)
        else setError(err?.message || 'Failed to load this planting.')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [plantingId, projectId, fetch])

  // Telemetry: fire OPEN_PLANTING once the planting actually resolves (the page truly opened).
  const reachedRef = useRef(false)
  useEffect(() => {
    if (planting && !reachedRef.current) {
      reachedRef.current = true
      ux.step(0, 'opened', { planting_id: planting.id, project_id: planting.project_id })
    }
  }, [planting])  // eslint-disable-line react-hooks/exhaustive-deps

  // Planting-scoped event log via the HS-2 server filter. Only fetch once we have a confirmed,
  // owned planting (so a wrong-project URL never fires a misleading events query).
  useEffect(() => {
    if (!planting) return
    let cancelled = false
    setEventsLoading(true)
    setEventsError(null)
    // A re-fetch is a new list; showing page 3 of the previous one would be a lie about this one.
    setEventsShown(EVENT_PAGE_SIZE)
    // V4-UNSCOPEDROUTES-001: project_id omitted when the planting has none (CaptureFlow rows) —
    // a literal "project_id=null" param would silently match nothing.
    fetch(planting.project_id
      ? `/api/events?project_id=${planting.project_id}&plant_id=${planting.id}&limit=${EVENT_FETCH_LIMIT}`
      : `/api/events?plant_id=${planting.id}&limit=${EVENT_FETCH_LIMIT}`)
      .then(data => {
        if (cancelled) return
        setEvents(data ?? [])
        setEventsLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        // Friendly fixed copy — don't leak raw fetch errors into the grower-facing log.
        setEventsError("Couldn't load this planting's events.")
        setEventsLoading(false)
      })
    return () => { cancelled = true }
  }, [planting, fetch, refreshKey])

  // V4-HARVWEIGHTREAD-001 slice 2 — the harvest weight for THIS planting's timeline. GET /api/events
  // (the event-log source above) does not join harvest_log at all, so an event row carries no
  // quantity and no weight; the harvests read model already derives both. Self-fetched with
  // ?plant=<id> and keyed by event_id, so the same describeHarvestWeight() that renders the Harvests
  // log renders these rows — one read model, not a second derivation that can disagree with it.
  //
  // SECONDARY BY DESIGN: a failure here leaves `harvestByEvent` empty and the timeline renders
  // exactly as it did before, with no error copy. The event log is the page's spine and must not
  // break because an enhancement fetch did. Note the deliberate asymmetry with the Harvests log:
  // there, a quantified row with no derivable weight shows "no weight yet"; here, an event with NO
  // matching entry at all renders NOTHING, because "we did not load it" and "it has no weight" are
  // different facts and only the second one is safe to tell Dave.
  //
  // BUG-PLANTHARVCURSOR-001 — the fetch above was a SINGLE request against an endpoint that pages at
  // PAGE_LIMIT = 50 and hands back a `cursor` when more remain. Nobody followed it, so a planting
  // past 50 picks summed its first page and printed a total short by the rest: no error, no
  // indicator, and short in the one direction Dave would believe. Prod was three days from the first
  // crossing when this was written. Two independent repairs, and the independence is the design:
  //
  //   TOTAL   <- the server's un-capped aggregate. Exact by construction, one request, no loop.
  //   CHIPS   <- a bounded drain. The timeline reveals every event (EVENT_FETCH_LIMIT = 200), so a
  //              row past the boundary would otherwise render with no weight beside it.
  //
  // Because the total never reads the drained entries, a drain that fails or hits its bound costs
  // chips and cannot make the number wrong.
  const [harvests, setHarvests] = useState(null)
  useEffect(() => {
    if (!planting?.id) return
    let cancelled = false
    setHarvests(null)
    const base = `/api/harvests?plant=${planting.id}&timeframe=all`
    const run = async () => {
      const byEvent = new Map()
      let weight = null
      let cursor = null
      let complete = false
      try {
        for (let i = 0; i < MAX_HARVEST_PAGES; i++) {
          // Aggregates ONLY on the first request. The Lambda recomputes the whole GROUPING SETS
          // roll-up over the full range on any request that asks for them, so carrying `aggregates`
          // through the drain would re-derive one un-capped total per page (the same waste
          // BUG-EXPORTDRAINBOUND-001's I-4 note records against the export sheet).
          const data = await fetch(cursor ? `${base}&include=entries&cursor=${encodeURIComponent(cursor)}` : `${base}&include=entries,aggregates`)
          if (cancelled) return
          for (const en of data?.entries ?? []) if (en?.event_id) byEvent.set(en.event_id, en)
          if (i === 0) {
            // The PLANTING-grain member of the roll-up, not `aggregates.weight` (the grand total).
            // They are the same number only when the Lambda honours ?plant=; the planting grain is
            // scoped by its own GROUPING SET, so it stays correct against an older handler that
            // ignores the param and aggregates the whole household. Absent -> null -> say nothing.
            weight = serverWeightTotal((data?.aggregates?.first_pick ?? []).find(f => f?.plant_id === planting.id)?.weight)
          }
          const next = data?.cursor ?? null
          // A stuck cursor (a cache replaying one page, or a keyset bug) would otherwise re-fetch
          // the same rows until the bound; there is nothing further to collect either way.
          if (!next || next === cursor) { complete = true; break }
          cursor = next
        }
      } catch { /* SECONDARY BY DESIGN — keep whatever landed, never surface an error here */ }
      if (!cancelled) setHarvests({ byEvent, weight, complete })
    }
    run()
    return () => { cancelled = true }
  }, [planting, fetch, refreshKey])
  const harvestByEvent = harvests?.byEvent ?? null

  // The planting's own weight total. The server roll-up when the wire carries it; otherwise the
  // local sum, which sumHarvestWeights derives with the same honest arithmetic (estimated and
  // measured added together, counts returned alongside so the line under it can say how much of the
  // number was inferred rather than implying the whole of it was weighed).
  const harvestWeightTotal = useMemo(
    () => harvests?.weight ?? sumHarvestWeights(harvestByEvent ? [...harvestByEvent.values()] : []),
    [harvests, harvestByEvent],
  )

  // SPLIT-ARTIFACT GUARD. The SPA and the harvests Lambda deploy on separate legs, so this page can
  // run against a harvests Lambda that predates V4-HARVWEIGHTREAD-001. That old handler ignores the
  // unknown `plant=` param (returning household-wide entries, capped at PAGE_LIMIT) AND does not
  // project weight_grams — so every entry reads as unweighed and the total below would announce
  // "50 with no weight yet" on every planting, including ones with no harvests at all. Wrong is
  // worse than absent, so we render nothing until the wire actually carries the field.
  // The discriminator is `undefined` vs `null`: the new wire sends weight_grams: null for a genuinely
  // unweighed pick, the old wire omits the key entirely. Checked with `in`, not truthiness — a
  // legitimately-null weight must still count as wire support.
  //
  // BUG-PLANTHARVCURSOR-001 adds the second leg of the same rule. Falling back to the local sum is
  // only honest over a rowset we know is whole: an INCOMPLETE drain is a prefix, and the wire told
  // us so by still holding a cursor. With no server roll-up and no finished drain there is no true
  // number to print, so the block stays dark rather than reprinting the truncation this row fixes.
  const harvestWeightWireReady = useMemo(
    () => !!harvests?.weight || (
      !!harvests?.complete && [...(harvests?.byEvent?.values() ?? [])].some(en => en && 'weight_grams' in en)
    ),
    [harvests],
  )

  // Planting photos (V1 display-only). V4-PHOTOGALLERY-001: the gallery shows every photo ATTACHED to
  // this planting — directly via plant_id, OR through one of its events — no matter which container the
  // photo lives in. The photos Lambda's ?attachedTo=<plantingId> resolves that union server-side (one
  // canonical predicate), so a plant_id-attached photo in a parent/sibling container now appears; the
  // old ?project_id fetch only saw photos in the planting's OWN container and hid the rest. Exclusion of
  // other plantings' photos is now the server's job (WHERE-scoped), so the client just de-dups + sorts.
  // `events` stays in deps as a freshness trigger: logging a new event-photo re-fetches the attached set.
  // events-change freshness trigger: logging a new event-photo bumps `events`, which revalidates the
  // attached-photo set. Skip the initial mount run — the first fetch is already covered by
  // useCachedFetch's own mount-revalidate; only a genuine later `events` change needs to refresh.
  const eventsSettledRef = useRef(false)
  useEffect(() => {
    if (!eventsSettledRef.current) { eventsSettledRef.current = true; return }
    refetchPhotos()
  }, [events, refetchPhotos]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Planting pager (group-bounded prev/next) ───────────────────────────────────────────────
  // Sequence is captured on tap in Garden and read here from a module singleton. null when there
  // is no in-session sequence, <2 items, or this planting isn't in it → no pager, gestures/keys
  // inert. resolvePager only needs plantingId, so it's safe above the load/404 guards.
  const pager = resolvePager(plantingId)
  const prevHref = pager?.prevHref
  const nextHref = pager?.nextHref
  const pagerActive = !!pager && lightboxIndex == null && !detailsOpen && !notFound && !error

  // Keyboard fallback: ArrowLeft/ArrowRight page prev/next. Suppressed while a modal (Lightbox /
  // Details sheet) is open, or focus is in an editable / radiogroup control, so it never hijacks
  // the Lightbox's own arrow keys (Lightbox binds document keydown) or the Details tab radiogroup.
  useEffect(() => {
    if (!pagerActive) return
    function onKey(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const t = e.target
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
      if (t?.closest?.('[role="radiogroup"]')) return
      e.preventDefault()
      go(e.key === 'ArrowLeft' ? prevHref : nextHref)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pagerActive, prevHref, nextHref, go])

  // ── State 1: loading ──────────────────────────────────────────────────────────────────────
  if (loading) return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div></Shell>

  // ── State 3: 404 / not found / ownership mismatch ──────────────────────────────────────────
  if (notFound) {
    return (
      <Shell>
        <Breadcrumb path={[{ label: 'Home', href: '/dashboard' }, { label: 'Planting', href: null }]} />
        <div style={{ ...cardStyle, textAlign: 'center', padding: '40px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
            <Icon name="lifecycle.sprout" size={40} decorative style={{ color: P.greenLight }} />
          </div>
          <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>
            Planting not found
          </p>
          <p style={{ margin: '0 0 20px', color: P.light, fontSize: '0.88rem' }}>
            This planting no longer exists, or it isn’t part of this project.
          </p>
          <Link to={projectId ? `/projects/${projectId}` : '/garden'} style={btnLink}>
            Back to {projectId ? 'project' : 'garden'}
          </Link>
        </div>
      </Shell>
    )
  }

  // ── State 2: fetch-error (loaded but failed) ───────────────────────────────────────────────
  if (error) {
    return (
      <Shell>
        <Breadcrumb path={[{ label: 'Home', href: '/dashboard' }, { label: 'Planting', href: null }]} />
        <div style={{ ...cardStyle, textAlign: 'center', padding: '40px 24px' }}>
          <p style={{ margin: '0 0 16px', color: P.terra, fontSize: '0.9rem' }}>{error}</p>
          <Link to={projectId ? `/projects/${projectId}` : '/garden'} style={btnLink}>
            Back to {projectId ? 'project' : 'garden'}
          </Link>
        </div>
      </Shell>
    )
  }

  if (!planting) return null

  // V3-ARCHIVE-001: restore an archived planting. Plantings were archivable only from the Garden row
  // (with a 6s Undo); after that window an archived planting was hidden everywhere with no restore path.
  // Mirror ProjectDetail: an Archived badge + Unarchive here make a by-id-reachable archived planting recoverable.
  async function handleUnarchive() {
    setUnarchiving(true)
    try {
      const res = await fetch('/api/plants/' + plantingId + '/archive', { method: 'PATCH', body: JSON.stringify({ archived: false }) })
      setPlanting(prev => ({ ...prev, archived_at: res?.archived_at ?? null }))
    } catch (err) {
      console.error('unarchive failed', err)
    } finally {
      setUnarchiving(false)
    }
  }

  // V4-ARCHIVEINPLACE-001 (BD0806-23) — archive the planting FROM the planting page. Until now the
  // only archive affordance lived inside the Garden editor (PlantingEditor.jsx), so putting a
  // finished planting away meant: planting page → Edit → /garden?edit=<id> → open the details
  // disclosure → Archive. Four steps to reach a control whose UNDO has been sitting on this very
  // page since V3-ARCHIVE-001. This is the missing forward half of the pair, and it is the same
  // PATCH the editor and CaptureFlow's undo already use — no new route, no new state machine.
  //
  // STAYS ON THE PAGE, deliberately. The badge flips to Archived and Unarchive appears in the same
  // row the button just left, which makes the reversal permanent instead of a five-second toast
  // race — and since an archived planting is reachable only by a URL you already hold, navigating
  // away would strand the one surface that can bring it back. No confirm dialog for the same
  // reason: archiving is reversible in place, and a modal would re-add exactly the friction this
  // removes. (ProjectDetail gates its archive behind a dialog only because that dialog is SHARED
  // with a destructive delete; there is no delete here.)
  async function handleArchive() {
    setArchiving(true)
    try {
      const res = await fetch('/api/plants/' + plantingId + '/archive', { method: 'PATCH', body: JSON.stringify({ archived: true }) })
      // Server-sourced timestamp, never a client clock: archived_at is what every other surface
      // filters on, and a locally-invented value would disagree with the next record load.
      setPlanting(prev => ({ ...prev, archived_at: res?.archived_at ?? null }))
    } catch (err) {
      console.error('archive failed', err)
      // Failure MUST be audible. The success path is confirmed by the row visibly changing shape,
      // so a silent catch here would leave the row looking exactly un-archived with no way to tell
      // "it didn't work" from "you didn't tap it". Reuses this page's existing error-toast pattern
      // (setFeatured) rather than inventing a second one.
      toast?.show?.({ message: "Couldn't archive this planting", tone: 'error' })
    } finally {
      setArchiving(false)
    }
  }

  const pl = planting
  const name = pl.name || 'Planting'
  const variety = pl.variety_ref?.name
  // First-harvest date: prefer a stored field, else derive from the event log (first_harvest,
  // then any harvest). Events are ORDER BY event_date DESC, so the LAST matching row is earliest.
  const firstHarvestStored = pl.first_harvest_at ?? null
  const firstHarvestEvent = !firstHarvestStored ? deriveFirstHarvest(events) : null
  const firstHarvest = firstHarvestStored ?? firstHarvestEvent
  const botanical = formatBotanical(pl.variety_ref)

  // V4-PHOTOFEATURE-001 — swap the planting's featured (profile) photo. Backend validates the
  // photo is linked to this plant (plants PUT / V2-PHOTO-F1).
  async function setFeatured(ph) {
    if (!ph?.id || savingFeatured || ph.id === planting?.featured_photo_id) return
    setSavingFeatured(ph.id)
    try {
      const updated = await fetch('/api/plants/' + plantingId, {
        method: 'PUT', body: JSON.stringify({ featured_photo_id: ph.id }),
      })
      setPlanting(prev => ({ ...prev, featured_photo_id: updated?.featured_photo_id ?? ph.id, featured_photo_view_url: ph.view_url }))
      toast?.show?.({ message: 'Featured photo updated', tone: 'success' })
    } catch {
      toast?.show?.({ message: "Couldn't set featured photo", tone: 'error' })
    } finally {
      setSavingFeatured(null)
    }
  }

  // ── Gallery: one shared image list for the hero + Photos grid + GrowthStrip. The featured
  // hero photo is index 0 (unshifted if not already represented in the photo set). ──────────
  const galleryFromPhotos = photos.map(p => ({ src: p.view_url, view_url: p.view_url, id: p.id, alt: p.caption || name, caption: p.caption }))
  const featuredUrl = pl.featured_photo_view_url
  const featuredInSet = pl.featured_photo_id != null && photos.some(p => p.id === pl.featured_photo_id)
  const galleryImages = featuredUrl && !featuredInSet
    ? [{ src: featuredUrl, view_url: featuredUrl, id: pl.featured_photo_id, alt: `${name} photo`, caption: null }, ...galleryFromPhotos]
    : galleryFromPhotos
  // Freeze the slide array at open (regression I4): a background revalidate that prepends/reorders
  // photos must not shift the controlled index onto a different photo mid-view. `openLb` snapshots
  // galleryImages then sets the index; onClose clears the snapshot. (Inlined at the call sites rather
  // than an effect/useCallback — galleryImages is computed below the page's early returns.)
  const openLb = (i) => { setLbFrozen(galleryImages); setLightboxIndex(i) }
  // Map a `photos[]` entry to its index inside galleryImages (offset by the unshifted hero).
  const photoIndexOffset = (featuredUrl && !featuredInSet) ? 1 : 0
  // GrowthStrip wants OLDEST-first; photos[] is newest-first, so reverse a shallow copy and
  // carry each photo's gallery index along for thumb -> Lightbox open.
  const growthPhotos = photos
    .map((p, i) => ({ ...p, galleryIndex: i + photoIndexOffset }))
    .slice()
    .reverse()

  // ── Tabbed Details rows (moved out of the old flat card into the fly-up). Each row is
  // [label, value]; only rows with a value render. Per-tab empty -> "Nothing recorded yet.";
  // whole-set empty -> the legacy "No additional details recorded yet." copy. ───────────────
  const basicsRows = [
    ['Variety', variety],
    ['Botanical', botanical ? (botanical.italic ? <i>{botanical.text}</i> : botanical.text) : null],
    ['Location', pl.location_path
      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name="facet.location" size={15} decorative style={{ color: P.light }} />{pl.location_path}
        </span>
      : null],
    ['Quantity', pl.quantity > 1 ? `×${formatQty(pl.quantity)}` : null],
    ['Started with', pl.qty_initial && pl.qty_initial !== pl.quantity ? `×${formatQty(pl.qty_initial)}` : null],
    ['Sown', fmtDate(pl.sown_at) ? `${fmtDate(pl.sown_at)}${pl.sown_at_approx ? ' (approx.)' : ''}` : null],
    ['Transplanted', fmtDate(pl.transplanted_at) ? `${fmtDate(pl.transplanted_at)}${pl.transplanted_at_approx ? ' (approx.)' : ''}` : null],
    ['Source', PLANT_SOURCE_LABELS[pl.source_type] ?? (pl.source_type || null)],
    ['Pot / bag', pl.container_type ? (PLANT_CONTAINER_TYPE_LABELS[pl.container_type] ?? pl.container_type) : null],
    ['Pot size', pl.container_size || null],
  ].filter(([, v]) => v)

  // BUG-CADENCESIZE-001 — vessel gaps STATED rather than hidden. `.filter(([, v]) => v)` above drops any
  // row with an empty value, so a planting with no recorded pot size rendered literally nothing — the one
  // shape that can never prompt anyone to fix it. Now that the watering interval reads container_size for
  // some vessels, that silence is the wrong default: 98 of 228 active plantings have no size on record,
  // and a location named "Bag Area" holds 26 rows recorded as plastic_pot (three photographed, all fabric
  // grow bags). The copy is muted, never a warning colour and never a badge, so it reads as an unfilled
  // field noticed in passing rather than as a task. It only ever describes; the fix is the existing Edit
  // path, untouched.
  //
  // KEPT OUT OF THE EMPTINESS TEST BELOW, deliberately. These rows are supplementary, so on a planting
  // with nothing else recorded they would replace the "No additional details recorded yet." empty state
  // with two rows both reading "Not recorded" — turning a clean empty state into a form stub, which is
  // the chore-list feel this surface is explicitly meant to avoid. They therefore render only when the
  // record is otherwise non-empty, i.e. an in-use planting Dave might actually walk past.
  const vesselGapRows = [
    ['Pot / bag', pl.container_type ? null : vesselGap(pl, 'container_type')],
    ['Pot size', vesselGap(pl, 'container_size')],
    // Only when the RECORDED type contradicts its location — a wrong value is worse than a missing one,
    // because the interval derivation and everything else downstream treat it as known.
    ['Check pot / bag', pl.container_type ? conflictNote(pl) : null],
  ].filter(([, v]) => v)

  const careRows = [
    ['Next watering', renderNextWatering(pl)],
    ['Last watered', fmtDate(pl.last_watered_at)],
    ['Watering interval', Number.isFinite(pl.watering_interval_days) ? `Every ${pl.watering_interval_days} day${pl.watering_interval_days === 1 ? '' : 's'}` : null],
    ['Light', pl.variety_ref?.sun_requirements || null],
    ['Care notes', pl.care_notes || null],
    ['Soil notes', pl.soil_notes || null],
  ].filter(([, v]) => v)

  const moreRows = [
    ['Source ref', pl.source_ref],
    ['Generation', pl.source_generation],
    ['Source planting', pl.parent_plant_id && pl.parent_plant_name
      ? <Link to={`/plantings/${pl.parent_plant_id}`} style={{ color: P.green, textDecoration: 'none' }}>{pl.parent_plant_name} ›</Link>
      : null],
    ['Lineage', pl.lineage_note],
    ['Notes', pl.notes],
    ['First harvest', fmtDate(firstHarvest)],
  ].filter(([, v]) => v)

  // V4-PLANTINGRAWDETAIL-001 (BD-030) — the read-side counterpart to V4-EDITCOMPLETE-001's all-fields
  // rule, which covered EDIT forms only. Basics/Care/More are CURATED: three hand-written arrays that
  // between them name about twenty of the forty-plus columns GET /api/plants/:id returns, so everything
  // outside them (germinated_at, planted_out_at, qty_current/harvested/lost, loss_cause, the four
  // *_approx flags, acquired_mature_*, divergence_type, succession_*, workspace_id, version, metadata)
  // reaches this page and is displayed by nothing. Curation is also why the gap regrows: a column added
  // server-side is invisible until someone remembers to hand-add a row here.
  //
  // So this tab is deliberately NOT a fourth curated list. It iterates the fetched record itself, which
  // is what makes it self-maintaining — a new column shows up the day the API starts returning it, with
  // no edit to this file and no way for the list to drift out of date. Field names render RAW
  // ("sown_at_approx", not "Sown approx.") on purpose: the raw name is what ties a value on this screen
  // to its column, its edit-form field and the ledger row that talks about it.
  const allRows = Object.keys(pl).sort().map(k => [k, rawFieldValue(pl[k])])

  // BUG-CADENCESIZE-001: computed from the REAL rows ONLY — vesselGapRows are deliberately excluded.
  // That exclusion is what preserves the "No additional details recorded yet." empty state on a planting
  // with nothing recorded: the render below checks tabsEmpty BEFORE activeRows, so gap copy alone can
  // never make an empty planting look populated. Adding vesselGapRows to this expression would turn that
  // clean empty state into two rows both reading "Not recorded" — pinned by a guard in
  // PlantingDetail.vesselGaps.test.jsx. allRows is excluded for the same reason and one more: it is
  // never empty, so folding it in would delete that empty state outright.
  const tabsEmpty = basicsRows.length === 0 && careRows.length === 0 && moreRows.length === 0
  const activeRows = tab === 'basics' ? [...basicsRows, ...vesselGapRows]
    : tab === 'care' ? careRows
      : tab === 'more' ? moreRows
        : allRows
  const tabLabel = tab === 'basics' ? 'Basics' : tab === 'care' ? 'Care' : tab === 'more' ? 'More' : 'All fields'

  // PLANTING-PAGER swipe (Pointer Events only — iOS Safari ≥13 / Chrome Android both support them;
  // gated to pointerType 'touch' so a desktop mouse-drag never pages). touch-action:pan-y on the
  // wrapper hands vertical scroll to the compositor and keeps horizontal pointermove flowing.
  function onPointerDown(e) {
    if (e.pointerType !== 'touch' || !pagerActive) { swipeRef.current = null; return }
    if (e.target?.closest?.('[data-hscroll]')) { swipeRef.current = null; return } // let hscrollers own it
    swipeRef.current = { x: e.clientX, y: e.clientY, startX: e.clientX }
  }
  function onPointerUp(e) {
    const s = swipeRef.current
    swipeRef.current = null
    if (!s || e.pointerType !== 'touch' || !pagerActive) return
    const vw = typeof window !== 'undefined' ? window.innerWidth : 0
    const dir = resolveSwipe(e.clientX - s.x, e.clientY - s.y, s.startX, vw)
    if (dir === 'next') go(nextHref)
    else if (dir === 'prev') go(prevHref)
  }
  function onPointerCancel() { swipeRef.current = null }

  return (
    <Shell>
      <div
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{ touchAction: 'pan-y', overscrollBehaviorX: 'contain' }}
      >
      {/* SR-only live announcement of the current planting + position — SPA route changes are
          otherwise silent to screen readers. */}
      <div role="status" aria-live="polite" style={srOnly}>
        {pager ? `${name}, ${pager.index + 1} of ${pager.total}` : ''}
      </div>
      {/* PLANTING-PAGER — group-bounded prev/next. Swipe is primary (wrapper above); these
          always-visible buttons + the N/M · group label are the discoverable fallback and the
          keyboard/desktop path. Rendered only when a Garden group sequence was captured on tap. */}
      {pager && (
        <nav aria-label="Planting pager" style={pagerBar}>
          <button type="button" onClick={() => go(prevHref)} aria-label="Previous planting" style={pagerBtn}>‹</button>
          <div ref={pagerRef} tabIndex={-1} style={pagerLabel}>
            <span style={{ fontWeight: 700 }}>{pager.index + 1} / {pager.total}</span>
            {pager.ctxLabel && <span style={{ color: P.light, marginLeft: 8 }}>{pager.ctxLabel}</span>}
          </div>
          <button type="button" onClick={() => go(nextHref)} aria-label="Next planting" style={pagerBtn}>›</button>
        </nav>
      )}
      <Breadcrumb
        path={[
          { label: 'Home', href: '/dashboard' },
          // V4-UNSCOPEDROUTES-001: record-sourced (the canonical route has no project param).
          // V4-PROJHIDE-001: drop the project crumb entirely when projects aren't user-facing. Flag OFF
          // spreads the one-element array back in, so the path is byte-identical.
          ...(PROJECTS_HIDDEN ? [] : [{ label: pl.project_name || 'Project', href: pl.project_id ? `/projects/${pl.project_id}` : null }]),
          { label: name, href: null },
        ]}
      />

      {/* V200 Slice 5b — full-bleed photo hero (carries the page <h1>, status, key-fact + Details pill).
          onOpenDetails no longer does setTab('basics'): forcing the tab on every open meant the Care
          tab could never become sticky, so no repeat-visit accelerator to the care facts was even
          representable. The tab now persists for the life of the page, which is the whole point of
          it being a tab. Cross-mount persistence is deliberately NOT added — that is a stored
          preference, not a fix for a reset that should never have been here. */}
      <HeroPhoto
        planting={pl}
        src={pl.featured_photo_view_url}
        photoId={pl.featured_photo_id}
        alt={`${name} photo`}
        onOpenLightbox={(i) => openLb(i ?? 0)}
        onOpenDetails={() => setDetailsOpen(true)}
        onStatusChanged={(status) => setPlanting(prev => ({ ...prev, status }))}
      />

      {/* Secondary affordances row — Archive + Log + Edit, plus (archived) the badge and Unarchive.
          Primary name/status live ON the hero; the Favorite is the single hero heart now (dup
          removed), and the caretaker control moved below the Event log. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10,
        flexWrap: 'wrap', margin: '10px 0 14px' }}>
        {pl.archived_at && (
          <span style={{ backgroundColor: P.greenPale, color: P.green, border: `1px solid ${P.greenLight}`, fontSize: '0.75rem', padding: '3px 10px', borderRadius: 12, fontWeight: 600, marginRight: 'auto' }}>
            Archived
          </span>
        )}
        {pl.archived_at && (
          <button onClick={handleUnarchive} disabled={unarchiving} aria-label="Unarchive this planting"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, backgroundColor: P.white, color: P.green,
              border: `1px solid ${P.greenLight}`, borderRadius: 8, padding: '8px 14px', fontSize: '0.85rem',
              fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <Icon name="action.archive" size={16} decorative style={{ color: P.green }} />
            {unarchiving ? 'Working…' : 'Unarchive'}
          </button>
        )}
        {/* V4-ARCHIVEINPLACE-001 — the forward half of the archive pair, mirroring the Unarchive
            button above it. Gated on a LIVE planting so the row never offers both directions at
            once, which also keeps the accessible names unambiguous: `Archive this planting` and
            `Unarchive this planting` are mutually exclusive on any given render, and a
            /Unarchive/i query can never accidentally match this control.
            Placed FIRST in a flex-end row, so it takes the leftmost (least prominent) slot and
            Log/Edit keep the thumb-reachable positions they already had — archiving is a
            once-per-planting act, logging is a daily one. Quieter chrome than its neighbours
            (border/ink at P.border/P.mid rather than the green pair) for the same reason, while
            keeping their shape so the row still reads as one set. minHeight 44 per the house
            touch floor. */}
        {!pl.archived_at && (
          <button
            type="button"
            onClick={handleArchive}
            disabled={archiving}
            aria-label="Archive this planting"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              backgroundColor: P.white, color: P.mid,
              border: `1px solid ${P.border}`, borderRadius: 8,
              padding: '8px 14px', fontSize: '0.85rem', fontWeight: 600,
              minHeight: 44, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
            }}
          >
            <Icon name="action.archive" size={16} decorative style={{ color: P.mid }} />
            {archiving ? 'Archiving…' : 'Archive'}
          </button>
        )}
        {/* V4-QUICKLOG-001 (R10, ATTESTED 14:52Z): "I definitely want a quick log button right
            there… It doesn't have to be prominent." A quiet secondary affordance — same visual
            weight as Edit beside it, NOT a FAB and NOT the primary QuickActions row — that opens
            the EXISTING /log flow (EventNew) prefilled to THIS planting via the shipped
            ?project=&plant= deep-link contract (the same producer HarvestReadyBand/QuickActions
            use; pinned by a4c8c2b I-2). No event_type: this is a general log, Dave picks the type.
            NAVIGATES only — never a one-tap POST, no toast/celebration (Reward-UX: task-required
            action). minHeight 44 per the house touch floor (deliberately not btnGhost's ~34px).
            Project param omitted when the planting has none (V4-UNSCOPEDROUTES-001 CaptureFlow
            rows) — a literal project=undefined would poison EventNew's deep-link seed. */}
        <button
          type="button"
          onClick={() => overlayNavigate(pl.project_id
            ? `/log?project=${pl.project_id}&plant=${pl.id}`
            : `/log?plant=${pl.id}`)}
          aria-label="Log an event for this planting"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            backgroundColor: P.white, color: P.green,
            border: `1px solid ${P.greenLight}`, borderRadius: 8,
            padding: '8px 14px', fontSize: '0.85rem', fontWeight: 600,
            minHeight: 44, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
          }}
        >
          <Icon name="nav.plus" size={16} decorative style={{ color: P.green }} />
          Log
        </button>
        {/* V4-EDITINPLACE-001 — opens the editor ON THIS PAGE. Was a <Link to="/garden?edit=<id>">
            (V3-EDIT-001), which left the planting entirely to reach a form embedded in another
            page. A button, not a link, because it no longer has a destination. */}
        <button
          type="button"
          onClick={() => setEditing(v => !v)}
          aria-expanded={editing}
          aria-controls="planting-editor"
          aria-label="Edit this planting"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            backgroundColor: editing ? P.greenLight : P.white, color: P.green,
            border: `1px solid ${P.greenLight}`, borderRadius: 8,
            padding: '8px 14px', fontSize: '0.85rem', fontWeight: 600,
            minHeight: 44, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
          }}
        >
          <Icon name="action.edit" size={16} decorative style={{ color: P.green }} />
          Edit
        </button>
      </div>

      {/* V4-EDITINPLACE-001 — the editor as a FLY-UP over this page, not a page you travel to.
          A <Sheet>, which is the app's existing flyover primitive and already the one THIS page
          uses for its Details fly-up below (line ~1112): Sheet calls useDismissable once for all
          its render sites with layer LAYER.SHEET, so the dismissal contract — Escape, Android
          hardware Back (`armsBack`) and stack ordering — is the canonical registry's, not
          hand-rolled.

          ⚠️ CORRECTION (BUG-DIRTYDISMISSGAP-001). This comment used to claim `dirty={editorDirty}`
          "is what makes decideDismiss confirm before discarding typing". That was ASPIRATIONAL —
          it describes the contract once confirmOnDirty is on, and confirmOnDirty is FALSE at both
          registry call sites (dismissLayers.js:78, backNav.js:75) pending a ConfirmSheet primitive
          that does not exist. `dirty` gates the BACKDROP TAP alone. Escape and Back discarded a
          half-edited planting outright, with no confirm and — PlantingEditor having no draft stash
          — no recovery. `onClose={requestCloseEditor}` above is the interim guard; `dirty` is kept
          because the backdrop term is real and because it is the signal ConfirmSheet will consume.
          Dave is Android-only, so Back is the primary gesture and the one this protects.
          size="full" matches /log's Sheet — this form is far too tall for a peek.

          NOT a route and NOT a query param, deliberately: a param would put the open editor in the
          URL so a reload would silently reopen it, and the param round-trip is precisely what broke
          this affordance to begin with. `plant={pl}` is the record the page already fetched, so
          opening costs no round trip and cannot render a projected row's blank fields. onUpdated
          patches in place — the same contract OverwinterPrompt above uses — so the page re-labels
          without a refetch and without leaving. */}
      <Sheet
        open={editing}
        title="Edit planting"
        onClose={requestCloseEditor}
        dirty={editorDirty}
        // V4-SHEETBUSY-001. `dirty` alone left this fly-up dismissable mid-save: it gates the
        // backdrop tap only, and confirmOnDirty is still false at both registry call sites, so
        // Escape and Android Back closed a form with a PUT already on the wire — and because that
        // unmounts PlantingEditor, a save that FAILED could no longer render its error.
        busy={editorBusy}
        armsBack
        size="full"
      >
        {editing && (
          <PlantingEditor
            mode="edit"
            plant={pl}
            plants={editorPlants}
            fetch={fetch}
            onDirty={setEditorDirty}
            // The setter itself, not an inline arrow — PlantingEditor holds this behind a ref for
            // the same reason it holds onDirty, and a stable identity means this page never relies
            // on that. Feeds <Sheet busy> above.
            onBusy={setEditorBusy}
            onClose={closeEditor}
            onUpdated={(updated) => {
              setPlanting(prev => (prev ? { ...prev, ...updated } : updated))
              closeEditor()
              toast?.show?.({ message: 'Planting updated', tone: 'success' })
            }}
            onArchived={(patch) => {
              setPlanting(prev => (prev ? { ...prev, ...patch } : prev))
              closeEditor()
            }}
            onDeleted={() => {
              // The page's own subject is gone, so staying would render a 404 of itself.
              setEditorDirty(false)
              navigate('/garden', { replace: true })
            }}
          />
        )}
      </Sheet>

      {/* Slice 5a — live care band: renders only when this planting needs water (calm → null).
          last_watered_at rides in the same record load, so surfacing it here is free and lifts
          "when did I last water this" out of the Details fly-up's non-default Care tab. */}
      <CareStatus nextWaterAt={pl.next_water_at} lastWateredAt={pl.last_watered_at} locationType={pl.location_type} intervalDays={pl.watering_interval_days} />

      {/* V4-OVERWINTERCARE-001 — the writer for the overwintering care attribute, directly under the
          band it changes: marking a planting overwintering is what holds it OUT of water_due and
          swaps it for a reduced-cadence moisture check. Patches the record in place on save (same
          onUpdated contract as CropCard) so the row re-labels without a refetch. */}
      <OverwinterPrompt
        planting={pl}
        onUpdated={(patch) => setPlanting(prev => (prev ? { ...prev, ...patch } : prev))}
      />

      {/* V4-PLANTINGUI-001 — primary quick-actions: water / photo. (V4-STATUSTAP-001: status
          moved to the hero StatusPicker.) */}
      <QuickActions
        planting={pl}
        onLogged={(ev) => {
          setRefreshKey(k => k + 1)
          // Optimistic field updates so the UI reacts before the next full record load; the reload
          // then restores engine-computed values. Preserves all other fields.
          //  • watering/rain → clear next_water_at (care band goes calm; avoids a refetch race)
          //  • germination (CAL-2) → stamp germinated_at so the "It sprouted!" quick-action hides
          //    and the Life-story 🌱 milestone lights up immediately.
          setPlanting(prev => {
            if (!prev) return prev
            const type = ev?.event_type
            const next = { ...prev }
            if (type === 'watering' || type === 'rain') next.next_water_at = null
            if (type === 'germination' && !prev.germinated_at) {
              next.germinated_at = ev?.event_date ?? new Date().toISOString()
              next.germinated_at_approx = false
            }
            return next
          })
        }}
      />

      {/* V4-PLANTINGUI-001 — per-crop slot: maturity/harvest + cultivar attrs + projected facets.
          V4-MATURITYBASIS-001: onUpdated patches the loaded record in place after the "add
          transplant date" prompt saves, so the corrected Est.-harvest window paints immediately
          instead of waiting on a refetch (mirrors the optimistic field updates in onLogged above). */}
      <CropCard
        planting={pl}
        onUpdated={(patch) => setPlanting(prev => (prev ? { ...prev, ...patch } : prev))}
      />

      {/* V4-PLANTINGUI-001 — life-story milestone spine (lifecycle arc; full Event log remains below). */}
      {buildLifeStory(pl).length > 0 && (
        <>
          <SectionHeader>Life story</SectionHeader>
          <div style={cardStyle}>
            <LifeStoryTimeline planting={pl} />
          </div>
        </>
      )}

      {/* ── Growth (V200 Slice 5b — before/after compare + time-lapse over the photo timeline) ── */}
      {(photosLoading || photos.length > 0) && (
        <>
          <SectionHeader>Growth</SectionHeader>
          <div style={cardStyle}>
            {photosLoading ? (
              <div style={{ padding: '8px 0', color: P.light, fontSize: '0.875rem' }}>Loading photos…</div>
            ) : (
              <GrowthStrip
                photos={growthPhotos}
                onOpen={(idx) => openLb(idx)}
                indexBase={growthPhotos[0]?.galleryIndex ?? 0}
              />
            )}
          </div>
        </>
      )}

      {/* ── Harvested (V4-HARVESTQTY-001) — the near end of the spine, immediately upstream of Put
          up: how much actually came off this planting, recent + cumulative. Renders
          UNCONDITIONALLY for the same reason Put up does — "nothing yet" on a planting you are
          looking at is itself the answer, and hiding it would make the section appear only after a
          harvest exists, which reads as a bug. Self-fetches; does not widen /api/plants/:id. ── */}
      <SectionHeader>Harvested</SectionHeader>
      <div style={cardStyle}>
        <HarvestFromPlanting planting={pl} fetch={fetch} />
        {/* V4-HARVWEIGHTREAD-001 slice 2 — the weight axis under the native-unit summary. Rendered
            only once the entries have landed (null = in flight), so the section never flashes a
            "no weight yet" that a resolved fetch is about to contradict. */}
        {harvestWeightWireReady && <PlantingWeightTotal total={harvestWeightTotal} />}
        {/* V4-HARVESTVIEW-001 S4b: crop-filtered jump to the Harvests page (design §2.3). Shown only
            when the crop key resolves, since the destination is filtered by crop_type_slug. */}
        {pl.variety_ref?.crop_type_slug && (
          <div style={{ marginTop: 12, textAlign: 'right' }}>
            <Link to={`/harvests?crop=${encodeURIComponent(pl.variety_ref.crop_type_slug)}`} style={{ color: P.green, textDecoration: 'none', fontSize: '0.82rem', fontWeight: 700 }}>
              All harvests →
            </Link>
          </div>
        )}
      </div>

      {/* ── Put up (V4-PUTUPLINK-001) — the far end of the spine: what this planting yielded that is
          still in the stores. Renders UNCONDITIONALLY (unlike Growth/Photos, which hide when empty):
          the empty state carries the "log a put-up from this planting" affordance, which is exactly
          the moment worth prompting — you are looking at the planting you just picked from. ── */}
      <SectionHeader>Put up</SectionHeader>
      <div style={cardStyle}>
        <PutUpFromPlanting planting={pl} fetch={fetch} />
      </div>

      {/* ── Photos (V3-PHOTOMULTI-001 V1: every photo for this planting; tap -> Lightbox gallery) ── */}
      {(photosLoading || photos.length > 0) && (
        <>
          <SectionHeader>
            Photos
            {!photosLoading && photos.length > 0 && (
              <span style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.82rem', color: P.light }}>({photos.length})</span>
            )}
          </SectionHeader>
          <div style={cardStyle}>
            {photosLoading ? (
              <div style={{ padding: '8px 0', color: P.light, fontSize: '0.875rem' }}>Loading photos…</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
                {photos.map((ph, i) => (
                  <figure key={ph.id} style={{ margin: 0 }}>
                    <button
                      type="button"
                      onClick={() => openLb(i + photoIndexOffset)}
                      aria-label={`Open ${ph.caption || `${name} photo`}`}
                      style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                    >
                      <PhotoImg
                        photoId={ph.id}
                        initialUrl={ph.view_url}
                        alt={ph.caption || `${name} photo`}
                        style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 8, border: `1px solid ${P.border}`, display: 'block' }}
                      />
                    </button>
                    {ph.caption && (
                      <figcaption style={{ marginTop: 4, fontSize: '0.72rem', color: P.light, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {ph.caption}
                      </figcaption>
                    )}
                    {ph.id === planting?.featured_photo_id ? (
                      <div style={{ marginTop: 4, fontSize: '0.7rem', fontWeight: 700, color: P.gold }}>★ Featured</div>
                    ) : (
                      <button type="button" onClick={() => setFeatured(ph)} disabled={savingFeatured != null}
                        style={{ marginTop: 4, fontSize: '0.7rem', fontWeight: 600, color: P.green, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
                        {savingFeatured === ph.id ? 'Setting…' : 'Set as featured'}
                      </button>
                    )}
                  </figure>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Event log (planting-scoped, HS-2) ─────────────────────────────────────────────── */}
      <SectionHeader>
        Event log
        {!eventsLoading && !eventsError && events.length > 0 && (
          <span style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.82rem', color: P.light }}>({events.length})</span>
        )}
      </SectionHeader>
      <div style={cardStyle}>
        {eventsLoading ? (
          <div style={{ padding: '8px 0', color: P.light, fontSize: '0.875rem' }}>Loading events…</div>
        ) : eventsError ? (
          <div style={{ padding: '8px 0', color: P.terra, fontSize: '0.875rem' }}>{eventsError}</div>
        ) : events.length === 0 ? (
          <div style={{ padding: '8px 0', color: P.light, fontSize: '0.875rem' }}>
            No events logged for this planting yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {events.slice(0, eventsShown).map(ev => (
              <Link
                key={ev.id}
                to={`/events/${ev.id}`}
                style={{ textDecoration: 'none', color: 'inherit', display: 'flex', gap: 12, alignItems: 'flex-start' }}
              >
                <span aria-hidden="true" style={{
                  width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                  backgroundColor: P.cream, border: `1px solid ${P.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.95rem',
                }}>
                  <Icon name={`event.${ev.event_type}`} size={18} decorative style={{ color: P.green }} />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, color: P.dark, fontSize: '0.875rem' }}>
                    {ev.title || (ev.event_type || '').replace(/_/g, ' ')}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginTop: 1 }}>
                    <span style={{ fontSize: '0.75rem', color: P.light }}>
                      {fmtDate(ev.event_date) ?? ''}
                    </span>
                    <HarvestWeightChip entry={harvestByEvent?.get(ev.id)} />
                  </div>
                  {ev.notes && (
                    <p style={{ margin: '4px 0 0', color: P.mid, fontSize: '0.82rem', lineHeight: 1.5 }}>{ev.notes}</p>
                  )}
                </div>
              </Link>
            ))}
            {/* V4-EVENTHISTPAGE-001 — full-width, 44pt-min so it is a comfortable thumb target at the
                bottom of a long scroll on a 390px phone. Label carries the REMAINING count, not a
                fixed "50 more", so the last page never over-promises. */}
            {events.length > eventsShown && (
              <button
                type="button"
                data-testid="event-log-show-more"
                onClick={() => setEventsShown(n => n + EVENT_PAGE_SIZE)}
                style={{
                  marginTop: 4, minHeight: 44, width: '100%',
                  backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`,
                  borderRadius: 6, fontSize: '0.85rem', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                }}
              >
                Show more  ·  {events.length - eventsShown} older
              </button>
            )}
            {/* The server returned exactly its hard ceiling, so there may be older events this route
                cannot reach (Route 4 has no offset). Say it rather than truncate silently — silent
                truncation is the bug this ticket exists to fix. */}
            {events.length >= EVENT_FETCH_LIMIT && eventsShown >= events.length && (
              <p data-testid="event-log-ceiling" style={{ margin: '8px 0 0', color: P.light, fontSize: '0.78rem', lineHeight: 1.5 }}>
                Showing the {EVENT_FETCH_LIMIT} most recent events for this planting. Older ones aren&apos;t loaded.
              </p>
            )}
          </div>
        )}
      </div>

      {/* PLANT-ASSIGN-001: per-planting caretaker override, relocated below the Event log (Dave:
          rarely-changed control doesn't need top billing — "set it right there"). Sticky
          SectionHeader gives the flat layout a jump-anchor so it stays discoverable below a long log. */}
      <SectionHeader>Caretaker</SectionHeader>
      <div style={cardStyle}>
        {/* V4-PROJHIDE-001: the inherit label references the project — use a project-neutral label when
            projects aren't user-facing (the underlying inheritance is unchanged). Flag OFF is unchanged. */}
        <AssigneePicker entityType="plant" entityId={pl.id} value={pl.assignee_user_id ?? null} onChanged={(v) => setPlanting(prev => ({ ...prev, assignee_user_id: v }))} inheritLabel={PROJECTS_HIDDEN ? 'Inherits the default caretaker' : (pl.project_name ? `Inherits project: ${pl.project_name}` : 'Inherits the project caretaker')} />
      </div>

      {/* ── V200 Slice 5b — tabbed Details fly-up (Basics / Care / More). The Sheet owns the
          dialog contract (role=dialog/aria-modal/focus-trap+restore/Esc). ──────────────────── */}
      {/* V4-BACKNAV-001 Slice 3a — `armsBack`: Back closes this sheet instead of walking off
          the planting page. Close-in-place surface (read-only tabs, no navigation), so the pushed
          history entry is always consumed on close. */}
      <Sheet open={detailsOpen} title="Details" onClose={() => setDetailsOpen(false)} armsBack>
        <div style={{ padding: '0 24px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* V4-PLANTINGRAWDETAIL-001 — "All" is last and reads as the escape hatch it is: the three
              curated tabs stay the everyday surface, and nothing about them moves. The label is one
              word so four segments still fit a 390px sheet without the inline-flex row overflowing. */}
          <SegmentedControl
            options={[
              { value: 'basics', label: 'Basics' },
              { value: 'care', label: 'Care' },
              { value: 'more', label: 'More' },
              { value: 'all', label: 'All' },
            ]}
            value={tab}
            onChange={setTab}
            ariaLabel="Detail sections"
          />
          <div role="group" aria-label={tabLabel}>
            {/* V4-PLANTINGRAWDETAIL-001: the empty state is a CURATED-tab answer. allRows is built from
                the record itself and always has rows, so answering the All tab with "No additional
                details recorded yet." would hide the raw record on precisely the sparse planting whose
                raw record you opened this tab to read. */}
            {tabsEmpty && tab !== 'all' ? (
              <p style={{ margin: 0, color: P.light, fontSize: '0.88rem' }}>No additional details recorded yet.</p>
            ) : activeRows.length === 0 ? (
              <p style={{ margin: 0, color: P.light, fontSize: '0.88rem' }}>Nothing recorded yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {activeRows.map(([label, value]) => (
                  <div key={label}>
                    <div style={{ fontSize: '0.72rem', fontWeight: 600, color: P.light, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      {label}
                    </div>
                    {/* Raw values go monospace at a smaller size: it signals "this is the record, not
                        a presentation of it", and it keeps a 60-character uuid or a JSON blob legible.
                        wordBreak carries the long ones — the sheet must never push the PAGE sideways. */}
                    <div style={tab === 'all' ? rawValueStyle : detailValueStyle}>{value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Sheet>

      {/* V4-THEME-001 — shared Lightbox gallery (hero + Photos grid + GrowthStrip thumbs feed it). */}
      <Lightbox
        open={lightboxIndex != null}
        images={lbFrozen ?? galleryImages}
        index={lightboxIndex ?? 0}
        onIndexChange={setLightboxIndex}
        onClose={() => { setLbFrozen(null); setLightboxIndex(null) }}
        onSetFeatured={setFeatured}
        featuredId={pl.featured_photo_id}
      />
      </div>
    </Shell>
  )
}

// Render the "Next watering" cell for the Care tab: formatted date + an "Overdue" marker when
// the schedule is in the past. Returns null when there is no scheduled watering.
function renderNextWatering(pl) {
  const next = pl?.next_water_at
  if (!next) return null
  const label = fmtDate(next)
  if (!label) return null
  const overdue = new Date(next).getTime() < Date.now()
  return overdue
    ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {label}
        <span style={{ color: P.terra, fontWeight: 600, fontSize: '0.78rem' }}>Overdue</span>
      </span>
    : label
}

// BUG-CADENCESIZE-001 — muted copy for an unrecorded vessel field, or null when nothing is missing.
// P.light is the same tone the row LABELS already use, so the value reads as quieter than a real value
// rather than as an alert. Deliberately not P.terra: this is an unfilled field, not a problem with the
// plant, and the watering engine has already declined to act on it rather than guessing.
function vesselGap(pl, field) {
  const gap = vesselDataGaps(pl).find((g) => g.field === field && g.kind !== 'type_conflicts_location')
  if (!gap) return null
  return <span style={{ color: P.light, fontStyle: 'italic' }}>{gap.text}</span>
}

// The type-vs-location contradiction. Separated from vesselGap because it attaches to a row that HAS a
// value — the point is that the recorded value looks wrong, which the "Not recorded" copy cannot say.
function conflictNote(pl) {
  const gap = vesselDataGaps(pl).find((g) => g.kind === 'type_conflicts_location')
  if (!gap) return null
  return <span style={{ color: P.light }}>{gap.text}</span>
}

// Derive the earliest harvest from a DESC-ordered event list: prefer a first_harvest event,
// else the earliest 'harvest'. Returns an event_date string or null.
function deriveFirstHarvest(events) {
  if (!Array.isArray(events) || events.length === 0) return null
  const firsts = events.filter(e => e.event_type === 'first_harvest')
  const pool = firsts.length ? firsts : events.filter(e => e.event_type === 'harvest')
  if (!pool.length) return null
  // Events arrive DESC by event_date; the last element is the earliest.
  return pool[pool.length - 1].event_date ?? null
}

// V4-HARVWEIGHTREAD-001 slice 2 — the timeline's weight chip. Same three states, same wording, same
// testids and the same ≈-plus-provenance pairing as the Harvests log (src/pages/Harvests.jsx), because
// a grower reading "≈ 492 g" on one screen and something else on another has to work out whether the
// two mean the same thing. `entry` is the harvests-read-model row for this event, or undefined when
// the event is not a harvest / the enhancement fetch has not landed — both render nothing at all.
function HarvestWeightChip({ entry }) {
  if (!entry) return null
  const wt = describeHarvestWeight(entry)
  // The no-weight chip is suppressed on a row with no amount recorded either, exactly as on the
  // Harvests log: the least informative row in the log does not need to say "nothing" twice.
  const hasQty = entry.harvest_log_id != null && entry.quantity != null
  if (wt.state === 'none') {
    if (!hasQty) return null
    return (
      <span data-testid="harvest-weight-none" title={NO_WEIGHT_COPY} style={{ fontSize: '0.72rem', color: P.light, whiteSpace: 'nowrap' }}>
        no weight yet
      </span>
    )
  }
  // The ≈ is the only at-a-glance mark separating an estimate from a weighing, so it never carries
  // the meaning alone — title + aria-label spell out the provenance for anyone who never hovers.
  //
  // V4-HARVWEIGHTSURF-001 — …except NOBODY hovers, because there is no hover. Dave's only surface is
  // Chrome on Android, where a `title` attribute never fires at all: no long-press, no tap, nothing.
  // So on the device this app is actually used on, the provenance sentence was rendered to a
  // dead-end attribute and the whole basis axis collapsed back onto the bare ≈ glyph the comment
  // above says must not carry the meaning alone. Only ~37% of the weights on this page are real
  // weighings — the other ~63% are resolver-derived — so "where did this number come from" is not a
  // footnote, it is the difference between a measurement and an inference.
  //
  // The basis is therefore rendered VISIBLY, via the shared weightBasisLabel() — the SAME compressed
  // label the Harvests log renders, from the same module, because a grower who reads "typical for
  // this variety" on one screen and "Currently estimated from this variety's typical weight." on
  // another has to work out whether the two mean the same thing. (Both surfaces landed the visible
  // basis in parallel; the long sentence was this file's first cut and was reconciled onto the
  // shared short form at merge.) It is a sibling of the chip, not a child, so the chip's own
  // text/testid/label contract is byte-identical to before.
  //
  // MEASURED rows are labelled too ("weighed"), matching the log: the absence of ≈ is not a
  // disclosure, and the label is what makes the ratchet visible at the one moment it pays off —
  // when a row Dave weighed himself stops being a guess.
  //
  // title/aria-label keep the FULL sentence: they cost nothing, and on a pointer device the tooltip
  // is the only place the longer wording still fits.
  return (
    <>
      <span
        data-testid="harvest-weight"
        title={wt.sourceCopy ?? 'Weighed.'}
        // role="img" (V4-A11YGATE-001) — role=generic cannot hold a name; the comment above says
        // "title/aria-label keep the FULL sentence", and this is what makes the aria half true.
        role="img"
        aria-label={`${wt.estimated ? 'Estimated weight' : 'Weighed'}: ${wt.text}`}
        style={{ fontSize: '0.72rem', fontWeight: 600, color: wt.estimated ? P.light : P.green, whiteSpace: 'nowrap' }}
      >
        {wt.estimated ? `≈ ${wt.text}` : wt.text}
      </span>
      <span aria-hidden="true" style={{ fontSize: '0.7rem', color: P.light }}>·</span>
      {/* Deliberately NOT whiteSpace:nowrap — see the same note in Harvests.jsx. An unbreakable
          label widens the row's min-content past 390px, which is how a prior harvest-row change
          overflowed horizontally. */}
      <span data-testid="harvest-weight-source" style={{ fontSize: '0.7rem', color: P.light, lineHeight: 1.4, minWidth: 0 }}>
        {weightBasisLabel(entry)}
      </span>
    </>
  )
}

// The planting's cumulative weight, under HarvestFromPlanting's native-unit summary. Native units
// stay the headline there — "6 zucchini" is what was picked; this is what it weighed.
//
// The qualifier line is not decoration. A bare total implies every gram was measured, which is false
// for ~all of Dave's rows today, so the counts are printed unconditionally in a fixed order
// (weighed / estimated / no weight yet), each clause omitted only when its count is zero. That
// yields "3 weighed · 9 estimated · 2 with no weight yet" and never a phrasing like "0 of 12
// weighed" that has to be re-read to parse.
function PlantingWeightTotal({ total }) {
  const parts = []
  if (total.measured > 0) parts.push(`${total.measured} weighed`)
  if (total.estimated > 0) parts.push(`${total.estimated} estimated`)
  if (total.unweighed > 0) parts.push(`${total.unweighed} with no weight yet`)
  if (parts.length === 0) return null  // no harvests at all — the section above already says so
  const anyWeight = total.text != null
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${P.border}` }}>
      {anyWeight ? (
        <div
          data-testid="planting-weight-total"
          // role="img" (V4-A11YGATE-001) — same discarded-label class as the row above.
          role="img"
          aria-label={`${total.estimated > 0 ? 'Estimated total' : 'Total'} harvest weight: ${total.text}`}
          style={{ fontSize: '0.95rem', fontWeight: 700, color: P.green }}
        >
          {total.estimated > 0 ? `≈ ${total.text}` : total.text}
        </div>
      ) : (
        <div data-testid="planting-weight-none" style={{ fontSize: '0.85rem', color: P.light }}>{NO_WEIGHT_COPY}</div>
      )}
      <div data-testid="planting-weight-basis" style={{ fontSize: '0.75rem', color: P.light, marginTop: 2 }}>
        {parts.join(' · ')}
      </div>
    </div>
  )
}

// Sticky section header — jump affordance for the flat single-column layout. Sticks under the
// app TopBar (52px) so the user always sees which section they're scrolling within.
function SectionHeader({ children }) {
  return (
    <h2 style={{
      position: 'sticky', top: 52, zIndex: 2,
      margin: '24px 0 12px', padding: '6px 0',
      fontSize: '0.95rem', fontWeight: 700, color: P.dark,
      backgroundColor: P.cream,
    }}>
      {children}
    </h2>
  )
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>{children}</div>
    </div>
  )
}

const cardStyle = { backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 24 }
const btnLink = { backgroundColor: P.green, color: P.white, textDecoration: 'none', borderRadius: 6, padding: '9px 18px', fontSize: '0.88rem', fontWeight: 600, display: 'inline-block' }
// V4-PLANTINGRAWDETAIL-001 — the Details value cell, hoisted out of the JSX now that the All tab
// needs a second variant. detailValueStyle is byte-identical to the inline object it replaces.
const detailValueStyle = { fontSize: '0.9rem', color: P.dark, lineHeight: 1.5, wordBreak: 'break-word' }
const rawValueStyle = {
  ...detailValueStyle, fontSize: '0.8rem',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
const pagerBar = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, margin: '0 0 12px' }
const pagerBtn = {
  width: 44, height: 44, minWidth: 44, borderRadius: 8, border: `1px solid ${P.greenLight}`,
  background: P.white, color: P.green, fontSize: '1.4rem', lineHeight: 1, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}
const pagerLabel = { flex: 1, textAlign: 'center', fontSize: '0.85rem', color: P.dark, outline: 'none' }
const srOnly = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
}
