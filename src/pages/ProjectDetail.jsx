import React, { useState, useEffect, useRef, useCallback, useId } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { setReloadBlocked } from '../lib/reloadGate.js'
import AssigneePicker from '../components/AssigneePicker.jsx'
import { P, PROJECT_STATUSES, APP_URL } from '../lib/constants.js'
import { EVENT_TYPE_META, requiresPlanting, creatableEventTypes } from '../lib/eventTypes.js'
import { PLANTING_REQUIRED_ENABLED } from '../lib/featureFlags.js'
import Icon from '../components/Icon.jsx'
import ProjectStatusBadge from '../components/ProjectStatusBadge.jsx'
import { formatQty } from '../lib/format.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import PhotoUpload from '../components/PhotoUpload.jsx'
import FavoriteToggle from '../components/FavoriteToggle.jsx'
import VarietyPicker from '../components/VarietyPicker.jsx'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { useUxFlow, FLOWS } from '../lib/uxEvents.js'
import { loadSortOrder, saveSortOrder, applyNameSort } from '../lib/projectTree.js'
import ProjectOptions from '../components/ProjectOptions.jsx'
import SortToggle from '../components/SortToggle.jsx'
import PlantStatusBadge from '../components/PlantStatusBadge.jsx'
import PhotoImg from '../components/PhotoImg.jsx'
// DD9 / W-EVTDEL adoption: the disclose-and-offer delete confirm (shared with EventDetail —
// the two event-delete surfaces must stay behaviorally identical).
import EventDeleteConfirm from '../components/photo/EventDeleteConfirm.jsx'
import { PlantForm, Field, Input, Select, Textarea, Button, ErrorBanner, PlantingSelect } from '../components/forms'
import { CROP_CHIPS_AUTO } from '../components/forms/PlantingSelect.jsx'
// V4-CROPLISTORDER-001 (BD-010): crop-rank ledger write on the mini-logger save.
import { recordCropLog } from '../lib/cropLogLedger.js'
import Spinner from '../components/forms/Spinner.jsx'
import { clearPatch, SERVER_CLEARABLE } from '../lib/clearKeys.js'
import useScrollRestore from '../hooks/useScrollRestore.js'


// BUG-PROJEVENTTRUNC-001 — the project event log used to stop at 50 with nothing saying so.
//
// There was never a client-side slice here; this page rendered every row it was given and passed no
// limit, so the 50 was Route 4's SERVER default. Asking for the ceiling takes 35 of the 44 affected
// prod projects to their complete history in one request. The other 9 need real paging (the busiest
// carries 5,257 events), which Route 4 now supports via &offset= — see the contract note on that
// handler. 200 is therefore the PAGE SIZE here, not a ceiling.
const EVENT_PAGE_SIZE = 200

// V4-PICKERGATE-001 — what THIS surface can submit, not the whole vocabulary.
//
// The mini-logger's POST body (handleLogEvent) has no `harvest` key and no `metadata` key at all,
// so every type whose API contract requires one was a guaranteed 400 from here: harvest has been
// since it shipped, and V4-LOSSUI-001 added failed / given_away when it opened the creation gate.
//
// plantScoped: the form DOES carry a plant_id — it has a planting picker, required by
// handleLogEvent for predicating types — so the ~34 planting-predicating types stay offered.
const MINI_LOGGER_EVENT_TYPES = creatableEventTypes({ capturePanels: false, plantScoped: true })

// V4-SCROLLRESTORE-001 (BD0806-05) — how much of a paged log a Back re-opens.
//
// FeedPage restores its depth in ONE round trip by raising the limit. That is not available here:
// Route 4 clamps limit at 200 and 200 is already this page's page size, so depth past the first page
// is necessarily N requests, walked in sequence (offset paging needs the previous page's length).
// Two extra requests is the budget — 600 rows, the same three-pages-deep reach FeedPage's limit=90
// buys. Prod's busiest project holds 4,517 visible events; a user deeper than 600 lands at the
// bottom of what came back with Show more still offered, which is strictly better than page 1 and
// costs a Back no more than three requests.
const MAX_RESTORED_EVENTS = EVENT_PAGE_SIZE * 3
const MAX_RESTORE_PAGES = 2

const eventsPath = (projectId, offset) =>
  `/api/events?project_id=${projectId}&limit=${EVENT_PAGE_SIZE}&offset=${offset}`

// Route 4 answers a bare array unless the request carries &offset=, and this page always sends it —
// so the envelope is what prod returns. The array arm is NOT dead code and must not be "cleaned up":
// the Lambda and the SPA deploy separately (two pipelines, deployed in that order), so between them
// this page runs against a Lambda that has never heard of offset. Tolerating both shapes is what
// makes that window a smaller page instead of a blank log. Exported for its test.
export function normalizeEventPage(data, pageSize = EVENT_PAGE_SIZE) {
  if (Array.isArray(data)) return { events: data, hasMore: data.length >= pageSize }
  return { events: Array.isArray(data?.events) ? data.events : [], hasMore: data?.has_more === true }
}

// BUG-DELNOOPOK-001 fallout. The DELETE routes now answer 404 rather than {ok:true} when nothing
// matched, and apiFetch THROWS on any non-2xx — so the delete handlers below caught a 404 and
// stopped, leaving the user parked on a page whose record is already gone. From the user's seat,
// deleting something that is already deleted is the outcome they asked for. Narrow on purpose: only
// 404. A 403, a 500 or a timeout (status 0) still fails loudly and must not navigate away.
const isAlreadyGone = (err) => err?.status === 404

// BUG-PROJDELORPHAN-001: a REJECTION marker, deliberately not `[]`. The pre-delete orphan check
// used to `catch { setChildProjects([]) }`, and `[]` is also what a project with no sub-projects
// reads as — so the dialog could not tell "we could not ask" from "nothing will be orphaned", and
// both landed on the same render: no warning, no list, "Delete project?". On a destructive path a
// network error was being shown to the user as a safety assurance.
const CHILD_FETCH_FAILED = Symbol('child-fetch-failed')

function todayLocal() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

// V4-DIRTYGUARDSWEEP-001 — the edit form's seed, hoisted out of startEdit so the dirty predicate
// diffs against the SAME shape the form was opened with. Inlined in both places, these two would
// drift the first time a field is added to the edit form, and the drift would be silent: the guard
// would simply stop noticing that field.
function projectEditSeed(project) {
  return {
    name:              project.name,
    slug:              project.slug,
    description:       project.description ?? '',
    status:            project.status,
    start_date:        project.start_date  ?? '',
    is_public:         project.is_public,
    location_id:       project.location_id ?? '',
    parent_project_id: project.parent_project_id ?? '',
  }
}

function emptyEventForm() {
  return {
    event_type:    'observation',
    plant_id:      '',
    event_date:    todayLocal(),
    title:         '',
    notes:         '',
    private_notes: '',
    quantity:      '',
    is_public:     true,
  }
}

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function generateSlug(name, startDate) {
  const year = startDate
    ? new Date(startDate + 'T00:00:00').getFullYear()
    : new Date().getFullYear()
  return `${slugify(name)}-${year}`
}

// V4-EVTDELCONFIRM-001 — coverFor for the confirm sheet: the union of every photo's cover_for
// entries, deduped by entity (one planting covered by two of the event's photos must be named
// ONCE — the disclosure names parents, not photo-parent pairs). Duplicated verbatim in
// EventDetail.jsx: this lane's file budget is the two callsites + lambda + tests, so no shared
// lib module; the two copies must not diverge (same rule as the sheet itself).
function coverForFromPhotos(photos) {
  const seen = new Set()
  const out = []
  for (const ph of photos ?? []) {
    for (const c of ph.cover_for ?? []) {
      const key = `${c.type}:${c.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ id: c.id, name: c.name })
    }
  }
  return out
}

// The partial-failure report, shared copy across both delete surfaces (see confirmEventDelete's
// header comment for the continue-and-report decision this narrates).
function photoDeleteFailureCopy(failed, total) {
  if (total === 1) return 'The event was deleted, but its photo could not be deleted — it is still in your garden photos.'
  return `The event was deleted, but ${failed} of ${total} photos could not be deleted — they are still in your garden photos.`
}

// BUG-EVENTDELSILENT-001 — the two honest outcomes of a failed event delete, in the same banner and
// the same voice as photoDeleteFailureCopy above. Each names where the event actually is, because
// that is the only thing the user needs to decide what to do next.
const EVENT_DELETE_FAILED_COPY =
  'The event could not be deleted — it is still in your log. Check your connection and try again.'
const EVENT_DELETE_STALE_LIST_COPY =
  'The event was deleted, but the log could not refresh — reopen this project to see the current list.'

// BUG-PROJCONFIRMDELSILENT-001 — the same two-honest-outcomes treatment for the PROJECT-level
// actions, which were the third silent catch on this page. Split by verb because the two leave the
// project in different places and "try again" means a different button in each case.
const PROJECT_DELETE_FAILED_COPY =
  'The project could not be deleted — it is still here. Check your connection and try again.'
const PROJECT_ARCHIVE_FAILED_COPY =
  'The project could not be archived — it is still active. Check your connection and try again.'

// I7 fix (2026-05-18, V1.2a-3 Increment C / PR-C2): STATUS_COLORS replaced by
// shared getStatusColors() from src/lib/status.js (single source of truth across
// Dashboard / ProjectList / ProjectDetail).

export default function ProjectDetail() {
  const { id }   = useParams()
  const navigate = useNavigate()
  const { fetch, getToken } = useApiFetch()
  // M1 telemetry (Inc 0) — reach_planting. Fire-and-forget.
  const ux = useUxFlow(FLOWS.REACH_PLANTING)
  const reachedRef = useRef(false)

  const [project,      setProject]      = useState(null)
  // Fires once when the project (and its plantings) load. Proxy signal: ProjectDetail is
  // the surface where plantings are viewed (no dedicated planting route yet). Precise
  // taps-from-app-open is a cross-route refinement (deferred per tap-fidelity note).
  useEffect(() => {
    if (project && !reachedRef.current) {
      reachedRef.current = true
      ux.step(0, 'reached', { project_id: project.id })
    }
  }, [project])  // eslint-disable-line react-hooks/exhaustive-deps
  const [locPath,      setLocPath]      = useState(null)
  const [locations,    setLocations]    = useState([])
  const [allProjects,  setAllProjects]  = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [editing,      setEditing]      = useState(false)
  const [form,         setForm]         = useState(null)
  const [saving,       setSaving]       = useState(false)
  const [saveErr,      setSaveErr]      = useState(null)

  const [events,        setEvents]        = useState([])
  const [eventsLoading, setEventsLoading] = useState(true)
  // BUG-PROJEVENTTRUNC-001 paging state. hasMore comes from the server envelope, never from a
  // client guess, so the button disappears on the page that proves the history is complete.
  const [eventsHasMore, setEventsHasMore] = useState(false)
  const [eventsMore,    setEventsMore]    = useState(false)
  // V4-SCROLLRESTORE-001: false until the back-nav depth walk below has finished (or decided there
  // is nothing to walk). Declared HERE, above the hook that reads it, because the hook's `ready` and
  // the walk's target depth would otherwise be mutually dependent at first render.
  const [depthRestored, setDepthRestored] = useState(false)
  const [showLogForm,   setShowLogForm]   = useState(false)
  const [eventForm,     setEventForm]     = useState(emptyEventForm())
  const [loggingEvent,  setLoggingEvent]  = useState(false)
  const [logErr,        setLogErr]        = useState(null)
  const [deletingId,    setDeletingId]    = useState(null)
  // DD9 / W-EVTDEL: the event id armed for deletion — non-null renders the confirm sheet.
  const [confirmDeleteEventId, setConfirmDeleteEventId] = useState(null)
  // V4-EVTDELCONFIRM-001: the armed event's photos, lazily fetched on the delete tap — keyed by
  // event id so a slow response for an abandoned arm can never populate a DIFFERENT event's sheet.
  const [confirmPhotoInfo, setConfirmPhotoInfo] = useState(null) // { evId, photos } | null
  // Partial photo-delete failure report (continue-and-report; see confirmEventDelete).
  const [deleteErr, setDeleteErr] = useState(null)
  const logFormRef = useRef(null)
  // BUG-PHOTOUPLOADKBD-001: the mini-logger's photo trigger is a <button> that clicks this input.
  const miniPhotoInputRef = useRef(null)

  // V2-PHOTO-F1 Session 2: staged photo for inline mini-event-logger. Mirrors
  // EventNew's pattern — file selected first, uploaded after event POST so the
  // S3 key resolves under events/{eventId}/.
  const [miniPhotoFile,    setMiniPhotoFile]    = useState(null)
  const [miniPhotoPreview, setMiniPhotoPreview] = useState(null)
  const miniPhotoUploader = useUploadPhoto({ errorMode: 'swallow' })

  const [plants,        setPlants]        = useState([])
  const [plantsLoading, setPlantsLoading] = useState(true)
  // V3-ORDER-001: persisted sort order for this project's plantings. DEFAULT = recency.
  const [sortOrder,     setSortOrder]     = useState(() => loadSortOrder())
  const onSortChange = useCallback((order) => { setSortOrder(order); saveSortOrder(order) }, [])
  const [showAddPlant,  setShowAddPlant]  = useState(false)
  // V1.2a-4 S1 (PROJ-RESCOPE / V102 §5.1 #4): plantForm shape extended with
  // optional lifecycle/source/lineage fields. All NULL-tolerant server-side.
  // sown_at_approx toggles whether sown_at is treated as an exact date.
  const [plantForm,     setPlantForm]     = useState({
    name: '', variety: null, quantity: '1', notes: '', status: '',
    sown_at: '', sown_at_approx: false,
    qty_initial: '',
    source_type: '', source_ref: '', source_generation: '',
    lineage_note: '', parent_plant_id: '',
    container_type: '', container_size: '', location_id: '',
  })
  const [addingPlant,   setAddingPlant]   = useState(false)
  const [plantErr,      setPlantErr]      = useState(null)

  const [deleting,        setDeleting]        = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [childProjects,    setChildProjects]    = useState([])
  // BUG-PROJDELORPHAN-001 — the *LoadFailed flag the swallowed rejection above needs, so the dialog
  // renders "we could not ask" instead of the reassuring childless branch. `childrenRechecking`
  // exists only so the in-dialog Retry cannot be double-fired while a check is in flight.
  const [childrenLoadFailed,  setChildrenLoadFailed]  = useState(false)
  const [childrenRechecking,  setChildrenRechecking]  = useState(false)
  // BUG-PROJCONFIRMDELSILENT-001 — separate from `deleteErr` ON PURPOSE, and the reason is position,
  // not taste: deleteErr's banner sits above the EVENT TIMELINE, several screens below the header on
  // a 390px phone. The project delete/archive buttons are in the header, so reporting their failure
  // down there is the same silence in a different costume. Same grammar as the rest of the family
  // (named copy constant, role="alert" ErrorBanner, cleared when the action is re-armed) — the only
  // thing that differs is that the banner renders next to the control that failed.
  const [projectActionErr, setProjectActionErr] = useState(null)
  const [moveOpen,  setMoveOpen]  = useState(false)
  const [moveSel,   setMoveSel]   = useState('')   // '' = top level
  const [moving,    setMoving]    = useState(false)
  const [moveErr,   setMoveErr]   = useState(null)
  const [lastMove,  setLastMove]  = useState(null) // { op_id, toName } for inline Undo

  // Load project + events + locations + all projects in parallel
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setEventsLoading(true)
    Promise.all([
      fetch('/api/projects/' + id),
      fetch(eventsPath(id, 0)),
      fetch('/api/locations/with-path'),
      fetch('/api/projects'),
    ]).then(([proj, eventsData, locs, projects]) => {
      if (cancelled) return
      if (!proj) { setError('Project not found.'); setLoading(false); setEventsLoading(false); return }
      setProject(proj)
      setLocPath(proj.location_path ?? null)
      setLocations((locs ?? []).filter(l => l.is_active))
      // Exclude current project from re-parent picker
      setAllProjects((projects ?? []).filter(p => p.id !== id && p.name))
      const page = normalizeEventPage(eventsData)
      setEvents(page.events)
      setEventsHasMore(page.hasMore)
      setLoading(false)
      setEventsLoading(false)
    }).catch(err => {
      if (cancelled) return
      setError(err.message || 'Failed to load project.')
      setLoading(false)
      setEventsLoading(false)
    })
    return () => { cancelled = true }
  }, [id, fetch])

  // Load plants separately
  useEffect(() => {
    if (!id) return
    let cancelled = false
    setPlantsLoading(true)
    fetch('/api/plants?project_id=' + id)
      .then(data => {
        if (cancelled) return
        setPlants(data ?? [])
        setPlantsLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setPlantsLoading(false)
      })
    return () => { cancelled = true }
  }, [id, fetch])

  // Deliberately refetches page 0 ONLY and resets paging, rather than re-walking every page the
  // user had opened. One request after a write, which is what the delete-confirm suite pins; the
  // cost is that someone who had paged deep collapses back to the first page after logging or
  // deleting an event. Re-walking N pages would multiply every write by N requests to restore a
  // scroll position the write already disturbed.
  async function refreshEvents() {
    const page = normalizeEventPage(await fetch(eventsPath(id, 0)))
    setEvents(page.events)
    setEventsHasMore(page.hasMore)
  }

  // Appends the next page. Dedupes by id because OFFSET paging is positional: an event logged (or
  // deleted) between two page fetches shifts every later row by one, which without this would
  // duplicate a row or, worse, hide one. The server's total ORDER BY makes that a narrow window
  // rather than a routine occurrence, but the window is real on a shared garden.
  async function loadMoreEvents() {
    if (eventsMore || !eventsHasMore) return
    setEventsMore(true)
    try {
      const page = normalizeEventPage(await fetch(eventsPath(id, events.length)))
      setEvents(prev => {
        const seen = new Set(prev.map(e => e.id))
        return [...prev, ...page.events.filter(e => !seen.has(e.id))]
      })
      setEventsHasMore(page.hasMore)
    } catch (err) {
      console.error('load more events failed', err)
    } finally {
      setEventsMore(false)
    }
  }

  // ── V4-SCROLLRESTORE-001 (BD0806-05) — back-nav restore for this page ───────────────────────────
  //
  // Every row in the event log deep-links to /projects/:id/events/:eventId, so Back-to-here is the
  // routine path out of that page, and today it lands the user at the top of a log they had scrolled
  // deep into. The offset itself is the shipped hook's job; what this page owns is making the
  // document TALL ENOUGH to hold that offset before the restore fires.
  //
  // That is not decoration. The log is server-paged (BUG-PROJEVENTTRUNC-001, Route 4 &offset=) and a
  // remount fetches page 0 only, so a user who had pressed "Show more" twice comes back to a document
  // a third its old height; the browser clamps the restoring scrollTo to that height and the place is
  // lost however faithfully the offset was remembered. So the DEPTH is re-requested first, and the
  // hook is held at `ready: false` until it is.
  //
  // Bounded twice on purpose — by rows (MAX_RESTORED_EVENTS) and by request count
  // (MAX_RESTORE_PAGES). The row bound alone is not enough: loadMoreEvents dedupes by id, so a server
  // answering with rows this page already holds would leave events.length flat forever and turn one
  // Back into an unbounded fetch loop. The request bound makes that terminate at 2.
  const { restoredState: restoredDepthRaw, saveState: saveEventDepth } = useScrollRestore({
    id: 'project-detail',
    ready: !loading && !eventsLoading && depthRestored,
  })
  const restoredDepth = Math.min(Math.max(Number(restoredDepthRaw) || 0, 0), MAX_RESTORED_EVENTS)
  const depthWalks = useRef(0)

  useEffect(() => { saveEventDepth(events.length) }, [events.length, saveEventDepth])

  useEffect(() => {
    if (depthRestored || eventsLoading || eventsMore) return
    if (events.length >= restoredDepth || !eventsHasMore || depthWalks.current >= MAX_RESTORE_PAGES) {
      setDepthRestored(true)
      return
    }
    depthWalks.current += 1
    loadMoreEvents()
  }, [depthRestored, eventsLoading, eventsMore, eventsHasMore, events.length, restoredDepth]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAddPlant(e) {
    e.preventDefault()
    setAddingPlant(true)
    setPlantErr(null)
    const qty = parseInt(plantForm.quantity, 10)
    const qtyInitialRaw = parseInt(plantForm.qty_initial, 10)
    // qty_initial defaults to quantity if blank/invalid (per V102 §5.1 #4 + B.2).
    const qtyInitial = isNaN(qtyInitialRaw) || qtyInitialRaw < 1
      ? (isNaN(qty) || qty < 1 ? 1 : qty)
      : qtyInitialRaw
    try {
      const data = await fetch('/api/plants', {
        method: 'POST',
        body: JSON.stringify({
          project_id: id,
          name:       plantForm.name.trim(),
          variety:    plantForm.variety?.name ?? null, // BUG-02/03: dual-write legacy name + canonical id
          variety_id: plantForm.variety?.id ?? null,
          quantity:   isNaN(qty) || qty < 1 ? 1 : qty,
          notes:      plantForm.notes.trim()   || null,
          status:     plantForm.status || null, // E1: project-create gains status; '' -> null == prior server default
          // V1.2a-4 S1: lifecycle/source/lineage extension. All optional.
          sown_at:           plantForm.sown_at         || null,
          sown_at_approx:    !!plantForm.sown_at_approx,
          qty_initial:       qtyInitial,
          source_type:       plantForm.source_type    || null,
          source_ref:        plantForm.source_ref.trim()        || null,
          source_generation: plantForm.source_generation.trim() || null,
          lineage_note:      plantForm.lineage_note.trim()      || null,
          // V3-FORM-001: parity with Garden-path add (PlantingEditor) — capture lineage parent.
          parent_plant_id:   plantForm.parent_plant_id || null,
          container_type:    plantForm.container_type || null,
          container_size:    (plantForm.container_size ?? '').trim() || null,
          location_id:       plantForm.location_id || null,
        }),
      })
      setPlants(p => [...p, data])
      setPlantForm({
        name: '', variety: null, quantity: '1', notes: '', status: '',
        sown_at: '', sown_at_approx: false,
        qty_initial: '',
        source_type: '', source_ref: '', source_generation: '',
        lineage_note: '', parent_plant_id: '',
        container_type: '', container_size: '', location_id: '',
      })
      setShowAddPlant(false)
    } catch (err) {
      setPlantErr(err.message)
    }
    setAddingPlant(false)
  }

  async function handleLogEvent(e) {
    e.preventDefault()
    // V4-PLANTREQUIRED-001 (Lane 3, flag-gated, O4): the mini-logger was the app's biggest orphan
    // source — a project-level POST with no plant_id. Inert unless PLANTING_REQUIRED_ENABLED.
    if (PLANTING_REQUIRED_ENABLED && requiresPlanting(eventForm.event_type) && !eventForm.plant_id) {
      setLogErr('Choose a planting for this event.'); return
    }
    setLoggingEvent(true)
    setLogErr(null)
    try {
      const created = await fetch('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          project_id:    id,
          event_type:    eventForm.event_type,
          plant_id:      eventForm.plant_id || null,
          event_date:    eventForm.event_date,
          title:         eventForm.title.trim()         || null,
          notes:         eventForm.notes.trim()         || null,
          private_notes: eventForm.private_notes.trim() || null,
          quantity:      eventForm.quantity.trim()       || null,
          is_public:     eventForm.is_public,
          has_photo:     !!miniPhotoFile,
        }),
      })

      // V4-CROPLISTORDER-001 (BD-010): the event row exists — mark the crop's log day for
      // picker chip ranking. Slug resolved from the already-loaded project plants; String()
      // compare mirrors PlantingSelect's own id convention. No-op when plant-less/unresolvable.
      if (eventForm.plant_id) {
        const rankSlug = plants.find(p => String(p.id) === String(eventForm.plant_id))?.variety_ref?.crop_type_slug
        if (rankSlug) recordCropLog(rankSlug, eventForm.event_date)
      }

      // V2-PHOTO-F1 S2: upload staged photo (if any) — non-fatal via 'swallow'.
      const newEventId = created?.id
      if (miniPhotoFile && newEventId) {
        await miniPhotoUploader.upload(miniPhotoFile, {
          keyPrefix: 'events',
          parentId:  newEventId,
          linkage:   { project_id: id, event_id: newEventId },
          is_public: eventForm.is_public,
        })
      }

      // MVP-Critter — critters are awarded SERVER-SIDE by the events Lambda hook
      // (Phase B++ refactor 2026-05-30). No client call needed; if a plant picker is added
      // to this form later, the server-side hook auto-handles it.

      setEventForm(emptyEventForm())
      clearMiniPhoto()
      setShowLogForm(false)
      await refreshEvents()
    } catch (err) {
      setLogErr(err.message)
    }
    setLoggingEvent(false)
  }

  function handleMiniPhotoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setMiniPhotoFile(file)
    if (miniPhotoPreview) URL.revokeObjectURL(miniPhotoPreview)
    setMiniPhotoPreview(URL.createObjectURL(file))
  }

  function clearMiniPhoto() {
    setMiniPhotoFile(null)
    if (miniPhotoPreview) URL.revokeObjectURL(miniPhotoPreview)
    setMiniPhotoPreview(null)
  }

  // DD9 / W-EVTDEL adoption — same sheet, same confirm/cancel semantics as EventDetail's delete
  // (the two event-delete surfaces must not diverge). The row's × tap ARMS the sheet; the event
  // DELETE fires only from its Delete button and is byte-identical to the window.confirm era.
  //
  // V4-EVTDELCONFIRM-001 — the photo path is now REACHABLE, via a LAZY per-event read: the project
  // events list deliberately carries no photo data (no list bloat for a rarely-used path), so the
  // single-event GET — which now reports photos + cover usage, see lambda/events/eventPhotos.js —
  // is fetched only when a delete is armed. One read per delete-tap. Non-blocking (the sheet opens
  // instantly; the offer populates when the read lands) and non-fatal (a failed read degrades to
  // the component defaults 0/[], i.e. the unchecked default — no offer is safer than a wrong one,
  // and the delete itself is never blocked).
  function handleDeleteEvent(evId) {
    setConfirmDeleteEventId(evId)
    setDeleteErr(null)
    setConfirmPhotoInfo(null)
    fetch('/api/events/' + evId)
      .then(ev => setConfirmPhotoInfo({ evId, photos: ev?.photos ?? [] }))
      .catch(() => setConfirmPhotoInfo({ evId, photos: [] }))
  }

  // { deletePhotos } honored with the SAME semantics as EventDetail.handleDelete (the two surfaces
  // must not diverge — same order, same copy, same failure posture):
  //   • UNCHECKED (the asserted default) is the pre-DD9 behavior EXACTLY — server-side detach +
  //     re-parent; no photo write fires from this client.
  //   • CHECKED fires the live DELETE /api/photos/:id per photo, ONLY after the event DELETE
  //     succeeded. W-DEL soft deletes — recoverable from Recently deleted, as the sheet promises.
  //   • PARTIAL FAILURE is continue-and-report: independent idempotent deletes, so one failure
  //     must not strand the rest; a failed delete leaves that photo exactly where the unchecked
  //     path leaves all of them (live in the gallery). Reported as an honest count in the banner
  //     above the timeline; the event delete itself still refreshes the list.
  async function confirmEventDelete({ deletePhotos } = {}) {
    const evId = confirmDeleteEventId
    if (!evId || deletingId) return
    const photos = confirmPhotoInfo?.evId === evId ? confirmPhotoInfo.photos : []
    setDeletingId(evId)
    // BUG-EVENTDELSILENT-001: which side of the DELETE a throw came from decides the copy. A
    // failure before this flips means the event is still in the log; after it means the event is
    // gone and only the on-screen list is stale. Reporting either as the other is the same lie in
    // the opposite direction, and "the delete failed" said over a row that is actually gone would
    // send the user back to re-delete something that no longer exists.
    let deleted = false
    try {
      // Same 404 tolerance as the project delete above, for the same reason: an event already
      // deleted (another device, a double-tap, a retried request) must still close the sheet and
      // refresh the list, or the row sits there looking undeletable. The photo deletes below stay
      // gated on the event delete NOT having failed for a real reason — an already-gone event is
      // not a real reason to skip them.
      try {
        await fetch('/api/events/' + evId, { method: 'DELETE' })
      } catch (err) {
        if (!isAlreadyGone(err)) throw err
      }
      deleted = true
      if (deletePhotos && photos.length > 0) {
        // busy={deletingId != null} keeps the sheet up and disabled across these too.
        const results = await Promise.allSettled(
          photos.map(p => fetch('/api/photos/' + p.id, { method: 'DELETE' }))
        )
        const failed = results.filter(r => r.status === 'rejected').length
        if (failed > 0) setDeleteErr(photoDeleteFailureCopy(failed, photos.length))
      }
      await refreshEvents()
    } catch (e) {
      console.error('delete event failed', e)
      // BUG-EVENTDELSILENT-001: this catch used to end at the console.error above — the sheet shut,
      // the spinner cleared, the row stayed put and nothing was said, so the only reading available
      // to the user was "it worked, the list is stale". EventDetail.handleDelete has surfaced this
      // since it shipped (setError + close the sheet so the banner is visible); the two event-delete
      // surfaces must not diverge, and on this one they did. Functional update so a photo-delete
      // report already written above is not clobbered — that message is the more actionable one.
      // No Retry button here: the row's × is the retry, and it is still on screen precisely because
      // the delete did not land.
      setDeleteErr(prev => prev ?? (deleted ? EVENT_DELETE_STALE_LIST_COPY : EVENT_DELETE_FAILED_COPY))
    }
    setDeletingId(null)
    // Closing the sheet is what makes the banner above the timeline visible — same reason
    // EventDetail closes its own sheet before reporting.
    setConfirmDeleteEventId(null)
  }

  // V3-REPARENT-001: first-class Move (atomic reparent + pre-move snapshot) with inline Undo.
  // Uses the dedicated /reparent endpoint (op_id dedup + optimistic version + restore path),
  // distinct from the edit-form parent select (which stays a plain PUT for now).
  function openMove() {
    setMoveSel(project.parent_project_id ?? '')
    setMoveErr(null)
    setMoveOpen(true)
  }

  function reparentErrCopy(err) {
    const st = err?.status
    if (st === 409) return 'This project changed on another device. Reload and try again.'
    if (st === 422 && /cycle/i.test(err?.message ?? '')) return "You can't move a project into one of its own sub-projects."
    if (st === 422) return err?.message || 'That destination isn’t valid.'
    return err?.message || 'Move failed.'
  }

  async function handleMove() {
    const newParentId = moveSel || null
    if (newParentId === project.id) { setMoveErr("A project can't be its own parent."); return }
    setMoving(true); setMoveErr(null)
    const op_id = crypto.randomUUID()
    try {
      const res = await fetch('/api/projects/' + id + '/reparent', {
        method: 'POST',
        body: JSON.stringify({ new_parent_id: newParentId, op_id, expected_version: project.version }),
      })
      const toName = allProjects.find(p => p.id === newParentId)?.name ?? 'top level'
      setProject(p => ({ ...p, parent_project_id: res.parent_project_id ?? null, version: res.version ?? p.version }))
      setLastMove({ op_id, toName })
      setMoveOpen(false)
    } catch (err) {
      setMoveErr(reparentErrCopy(err))
    }
    setMoving(false)
  }

  async function handleUndoMove() {
    if (!lastMove) return
    setMoving(true); setMoveErr(null)
    const op_id = crypto.randomUUID()
    try {
      const res = await fetch('/api/projects/' + id + '/reparent/restore', {
        method: 'POST',
        body: JSON.stringify({ op_id, source_op_id: lastMove.op_id, expected_version: project.version }),
      })
      setProject(p => ({ ...p, parent_project_id: res.parent_project_id ?? null, version: res.version ?? p.version }))
      setLastMove(null)
    } catch (err) {
      setMoveErr(reparentErrCopy(err))
    }
    setMoving(false)
  }

  function startEdit() {
    setForm(projectEditSeed(project))
    setSaveErr(null)
    setEditing(true)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setSaveErr(null)
    try {
      const updated = await fetch('/api/projects/' + id, {
        method: 'PUT',
        body: JSON.stringify({
          name:              form.name.trim(),
          slug:              form.slug.trim(),
          description:       form.description.trim() || null,
          status:            form.status,
          start_date:        form.start_date         || null,
          is_public:         form.is_public,
          location_id:       form.location_id        || null,
          parent_project_id: form.parent_project_id  || null,
          // BUG-COALESCECLEAR-001. The `|| null` above is exactly the bug: the server binds these
          // through COALESCE, where null and absent are the same token, so emptying one of these
          // boxes returned 200 and silently kept the old value. `clear` is the only way to say NULL.
          //
          // Derived from the RENDERED field set only — never from every key of form state — and
          // only for a field that HELD a value and is now empty. Filtered through the server's own
          // allowlist so an un-clearable key is dropped here rather than 400-ing the whole save and
          // losing the user's other edits with it.
          ...clearPatch(
            ['description', 'start_date', 'location_id'],
            form, project, { allowed: SERVER_CLEARABLE.projects }),
        }),
      })
      const loc = locations.find(l => l.id === (form.location_id || null))
      setLocPath(loc?.full_path ?? null)
      setProject(updated)
      setEditing(false)
    } catch (err) {
      const msg = err.message ?? ''
      setSaveErr(
        msg.includes('23505') || msg.toLowerCase().includes('already') || msg.toLowerCase().includes('duplicate')
          ? `Slug "${form.slug}" is already taken.`
          : msg.includes('cannot be its own parent')
          ? 'A project cannot be its own parent.'
          : msg || 'Failed to save.'
      )
    }
    setSaving(false)
  }

  // Check for child projects before allowing delete.
  //
  // BUG-PROJDELORPHAN-001: hoisted out of handleDeleteClick so the dialog's Retry re-runs the SAME
  // check rather than a second spelling of it, and a rejection now resolves to CHILD_FETCH_FAILED
  // rather than `[]` — see the marker's note. childProjects stays `[]` on failure (there is nothing
  // truthful to list); childrenLoadFailed is what the dialog branches on.
  async function loadChildProjects() {
    const children = await fetch('/api/projects?parent_id=' + id).catch(() => CHILD_FETCH_FAILED)
    const failed = children === CHILD_FETCH_FAILED
    setChildrenLoadFailed(failed)
    setChildProjects(failed ? [] : (children ?? []))
  }

  async function handleDeleteClick() {
    // BUG-PROJCONFIRMDELSILENT-001: arming clears a stale banner, same as handleDeleteEvent does for
    // the event path. This is the ONLY arm for confirmDelete (both its buttons live in the dialog),
    // so one clear here covers both verbs.
    setProjectActionErr(null)
    // The check still runs BEFORE the dialog opens, as it always has: the dialog's whole job is to
    // report what it found, so opening ahead of the answer would only move the lie earlier.
    await loadChildProjects()
    setDeleteDialogOpen(true)
  }

  async function recheckChildProjects() {
    if (childrenRechecking) return
    setChildrenRechecking(true)
    await loadChildProjects()
    setChildrenRechecking(false)
  }

  async function confirmDelete(archive) {
    setDeleting(true)
    setDeleteDialogOpen(false)
    try {
      if (archive) {
        // V3-ARCHIVE-001 (Decision 2): real archive — sets archived_at (hides from active lists).
        // status is an orthogonal lifecycle label, left untouched. by-id detail still opens, so
        // we stay on the page and surface an Archived badge + Unarchive affordance below.
        const res = await fetch('/api/projects/' + id + '/archive', {
          method: 'PATCH',
          body: JSON.stringify({ archived: true }),
        })
        setProject(p => ({ ...p, archived_at: res?.archived_at ?? new Date().toISOString() }))
        setDeleting(false)
      } else {
        // A 404 here means the project is already gone — deleted on another device, or a retry of
        // a delete that actually landed. Navigating away IS the correct outcome; the alternative
        // is stranding the user on a detail page for a record that no longer exists. Anything
        // else rethrows to the catch below, which keeps them here with the button re-enabled.
        try {
          await fetch('/api/projects/' + id, { method: 'DELETE' })
        } catch (err) {
          if (!isAlreadyGone(err)) throw err
        }
        navigate('/projects')
      }
    } catch (err) {
      console.error('delete/archive failed', err)
      // BUG-PROJCONFIRMDELSILENT-001: this catch used to end at the console.error above. The dialog
      // had already closed (line ~730), the spinner cleared, and the page looked exactly as it does
      // after a successful archive-in-place — so a tap on a destructive control produced no evidence
      // at all that it had not happened. Third member of the family; the delete/archive split is the
      // same "name where the thing actually is" rule the event copy follows. A 404 never reaches
      // here (already-gone is the outcome the user asked for), so anything caught is a real failure.
      setProjectActionErr(archive ? PROJECT_ARCHIVE_FAILED_COPY : PROJECT_DELETE_FAILED_COPY)
      setDeleting(false)
    }
  }

  async function handleUnarchive() {
    setDeleting(true)
    try {
      const res = await fetch('/api/projects/' + id + '/archive', {
        method: 'PATCH',
        body: JSON.stringify({ archived: false }),
      })
      setProject(p => ({ ...p, archived_at: res?.archived_at ?? null }))
    } catch (err) {
      console.error('unarchive failed', err)
    } finally {
      setDeleting(false)
    }
  }

  // ── Dirty guard (V4-DIRTYGUARDSWEEP-001) ───────────────────────────────────
  // Three independent forms live on this page and any of them can be open, so the predicate is a
  // union of three terms with three different seedings — the Locations shape, not EventNew's single
  // truthiness sweep. Declared above the early returns because hooks cannot live below them; every
  // term reads false while the project is still loading, which is correct.
  //
  // Each term is gated on its OWN visibility flag, and those flags are load-bearing rather than
  // decorative: Cancel on all three collapses the form WITHOUT clearing it, so without them text the
  // user has already dismissed off-screen would hold a deploy they can neither see nor resolve.
  //
  // The project edit form is seeded from the row, so its term is differs-from-the-row. Merely
  // tapping Edit must not hold an update.
  const editDirty = !!(editing && form && project &&
    Object.entries(projectEditSeed(project)).some(([k, v]) => form[k] !== v))

  // The mini event logger seeds event_type/event_date/is_public on arrival, so those three are
  // excluded — counting them would fire the moment the form opens. plant_id and the crop chips are
  // one tap to redo and stay out for the same reason PlantingSelect stays out of the sibling pages'
  // predicates. miniPhotoFile is IN: the file is staged in memory and only uploaded after the event
  // POST, so a reload loses the photo outright.
  const logDirty = !!(showLogForm && (
    eventForm.title.trim() || eventForm.notes.trim() || eventForm.private_notes.trim() ||
    eventForm.quantity.trim() || miniPhotoFile
  ))

  // The add-planting form arrives with quantity '1' and everything else empty, so quantity is a
  // differs-from-seed test and the rest are truthiness. Typed fields only: status, source_type,
  // container_type, parent_plant_id, location_id and sown_at_approx are all single-tap selects, and
  // a re-tap is not the data loss this gate defends. `variety` counts — it is a real search-and-pick.
  const addPlantDirty = !!(showAddPlant && (
    plantForm.name.trim() || plantForm.notes.trim() || plantForm.sown_at ||
    plantForm.qty_initial.trim() || plantForm.source_ref.trim() ||
    plantForm.source_generation.trim() || plantForm.lineage_note.trim() ||
    (plantForm.container_size ?? '').trim() || plantForm.variety ||
    plantForm.quantity !== '1'
  ))

  // Deliberately excluded: the Move picker (`moveSel` is one dropdown tap against a '' seed), the
  // delete/confirm dialogs (transient), `sortOrder` (already persisted to storage by onSortChange),
  // and the events paging state (server-backed, refetchable).
  const hasUnsavedInput = !!(editDirty || logDirty || addPlantDirty)

  useReportOverlayDirty(hasUnsavedInput)

  // Per-instance key and a cleanup release, for the reasons EventNew.jsx:975-991 sets out: the
  // release is required so a navigated-away dirty form cannot wedge updates forever, and it is safe
  // to release from the cleanup only because the dep is a BOOLEAN — while the user keeps typing the
  // deps compare equal and the effect never re-runs mid-form.
  const reloadGateKey = `project-detail:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  if (loading) return <Shell><Spinner block /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>
  if (!project) return null

  // V4-EVTDELCONFIRM-001: the armed event's photos — only when the lazy read's id still matches
  // the armed id (a stale response for an abandoned arm must never populate another event's sheet).
  const confirmPhotos = confirmPhotoInfo?.evId === confirmDeleteEventId ? confirmPhotoInfo.photos : []

  // M14 — the event-log count badge, made to agree with the list in every state.
  //
  // The events lane refused project.event_count outright, and was right about the COUNT it was
  // looking at: a plain COUNT over event_log that knew nothing about the archived-planting filter
  // shipped in the same change, reading (67) above a log that correctly rendered nothing on four
  // prod projects. But event_count is a live query in lambda/projects, not a stored column, so the
  // fix belonged at the source — it now carries the list's own archived-planting predicate (see the
  // long note there) and is exactly the number of rows this list can return.
  //
  // The client still does not trust it blindly, because the Lambda and the SPA deploy through
  // SEPARATE pipelines: for a window after an SPA-first deploy, event_count is whatever the old
  // Lambda says. So the rule is "never contradict something the user can see":
  //   • whole list on screen (no Show more) -> count the rendered rows. Exact by construction, and
  //     immune to a stale server total — this is the branch that covers the four all-archived
  //     projects, and it renders no badge at all there, because the log is empty.
  //   • list is a prefix -> report the server total, which is the "200 of 4,517" the badge is for.
  //     Nothing on screen can contradict it, and a total SMALLER than the rows already loaded is
  //     self-evidently stale, so that falls back to the loaded count with a "+".
  const serverEventTotal = Number.isFinite(project.event_count) ? project.event_count : null
  const eventCountBadge = !eventsHasMore
    ? String(events.length)
    : (serverEventTotal != null && serverEventTotal >= events.length
        ? String(serverEventTotal)
        : `${events.length}+`)


  return (
    <Shell>
      <Breadcrumb path={[{ label: 'Home', href: '/dashboard' }, { label: project.name, href: null }]} />

      {/* Parent breadcrumb — shown when project has a parent */}
      {project.parent_project_id && project.parent_project_name && (
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 12 }}>
          Part of:{' '}
          <Link
            to={`/projects/${project.parent_project_id}`}
            style={{ color: P.green, textDecoration: 'none', fontWeight: 600 }}
          >
            {project.parent_project_name}
          </Link>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 16 }}>
        <div>
          <h1 style={{ margin: '0 0 6px', color: P.green, fontSize: '1.4rem', fontWeight: 700 }}>
            {project.name}
          </h1>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* V1.2a-3 Increment A (I3-affordance): projects were the one favoritable
                entity type with no star control anywhere. */}
            <FavoriteToggle entityType="project" entityId={project.id} />
            {/* PLANT-ASSIGN-001: whole-project caretaker (engine routes plantings here unless overridden) */}
            <AssigneePicker entityType="project" entityId={project.id} value={project.assignee_user_id ?? null} onChanged={(v) => setProject(p => ({ ...p, assignee_user_id: v }))} />
            <ProjectStatusBadge status={project.status} />
            {project.archived_at && (
              <span style={{
                backgroundColor: P.greenPale, color: P.green, border: `1px solid ${P.greenLight}`,
                fontSize: '0.75rem', padding: '3px 10px', borderRadius: 12, fontWeight: 600,
              }}>
                Archived
              </span>
            )}
            {project.is_public && (
              <a href={`${APP_URL}/garden/${project.slug}`} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '0.75rem', color: P.green, textDecoration: 'none' }}>
                🌐 View public page ↗
              </a>
            )}
          </div>
          {!eventsLoading && events.length > 0 && (
            <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 6 }}>
              Last: <Icon name={`event.${events[0].event_type}`} size={14} decorative style={{ color: P.light, verticalAlign: '-0.1em' }} /> {events[0].event_type.replace(/_/g, ' ')} · {daysAgo(events[0].event_date)}
            </div>
          )}
        </div>
        {!editing && (
          <div style={{ display: 'flex', gap: 8 }}>
            {project.archived_at && (
              <button onClick={handleUnarchive} disabled={deleting} style={outlineBtn}>
                {deleting ? 'Working…' : 'Unarchive'}
              </button>
            )}
            <button onClick={openMove} style={outlineBtn}>Move</button>
            <button onClick={startEdit} style={outlineBtn}>Edit</button>
            <button
              onClick={handleDeleteClick}
              disabled={deleting}
              style={{ ...outlineBtn, color: P.terra, borderColor: P.alertBorder }}
            >
              {deleting ? 'Working…' : 'Delete'}
            </button>
          </div>
        )}
      </div>

      {/* BUG-PROJCONFIRMDELSILENT-001: directly under the Delete/Archive/Unarchive row, so the
          report is on screen with the control that failed at 390px rather than several scrolls
          below it. Retry is those same buttons, still enabled — no separate Retry needed. */}
      {projectActionErr && (
        <ErrorBanner data-testid="project-action-error" style={{ marginBottom: 16 }}>{projectActionErr}</ErrorBanner>
      )}

      {/* V3-REPARENT-001 inline Undo (ambient, non-toast) */}
      {lastMove && !moveOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0',
          background: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 8,
          padding: '8px 12px', fontSize: '0.85rem', color: P.green }}>
          <span>Moved to {lastMove.toName === 'top level' ? 'top level' : `“${lastMove.toName}”`}.</span>
          <button data-testid="reparent-undo" onClick={handleUndoMove} disabled={moving} style={{ ...ghostBtn, padding: '4px 12px' }}>
            {moving ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      )}

      {/* V3-REPARENT-001 Move modal */}
      {moveOpen && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}
          onClick={() => !moving && setMoveOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: P.white, borderRadius: 12,
            padding: 22, width: '100%', maxWidth: 420 }}>
            <h2 style={{ margin: '0 0 14px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>
              Move “{project.name}”
            </h2>
            <label style={{ display: 'block', fontSize: '0.8rem', color: P.mid, marginBottom: 6 }}>New parent</label>
            <select value={moveSel} onChange={e => setMoveSel(e.target.value)} disabled={moving}
              style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: `1px solid ${P.border}`, fontSize: '0.9rem' }}>
              <option value="">— Top level (no parent) —</option>
              <ProjectOptions projects={allProjects} />
            </select>
            {moveErr && <p style={{ color: P.terra, fontSize: '0.82rem', marginTop: 10 }}>{moveErr}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
              <button onClick={() => setMoveOpen(false)} disabled={moving} style={ghostBtn}>Cancel</button>
              <button data-testid="reparent-submit" onClick={handleMove} disabled={moving} style={primaryBtn(moving)}>
                {moving ? 'Moving…' : 'Move'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteDialogOpen && (
        <DeleteDialog
          childProjects={childProjects}
          checkFailed={childrenLoadFailed}
          rechecking={childrenRechecking}
          onRecheck={recheckChildProjects}
          onArchive={() => confirmDelete(true)}
          onDelete={() => confirmDelete(false)}
          onCancel={() => setDeleteDialogOpen(false)}
        />
      )}

      {editing ? (
        <form onSubmit={handleSave} style={cardStyle}>
          <h2 style={{ margin: '0 0 18px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>Edit project</h2>
          <ErrorBanner>{saveErr}</ErrorBanner>

          <Field label="Name *" style={{ marginBottom: 14 }}>
            <Input required value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: generateSlug(e.target.value, f.start_date) }))} />
          </Field>

          {/* BUG-08 (2.1.1): Slug input hidden from the edit form — humans don't need it now.
              Slug is still auto-generated from name/start_date (generateSlug calls below) and
              saved silently via handleSave (form.slug). Only the UI control is removed. */}

          {/* BUG-02 (variety-ref model): Variety/Species removed from the project-edit form.
              Taxonomy lives on PLANTINGS (variety_id, set via VarietyPicker in Add-Plant), not on
              plant_projects (which has no variety_id and no species column — species was silently
              dropped, variety text never displayed). Removed rather than wired to avoid duplicating
              variety attachment at two levels. Existing project.variety text is preserved (PUT no
              longer sends it, so COALESCE keeps it) but is no longer user-editable here. */}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Start date" style={{ marginBottom: 14 }}>
              <Input type="date" value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value, slug: generateSlug(f.name, e.target.value) }))} />
            </Field>
            <Field label="Status" style={{ marginBottom: 14 }}>
              <Select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {[...PROJECT_STATUSES].sort((a, b) => a.localeCompare(b)).map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
          </div>

          <Field label="Location" style={{ marginBottom: 14 }}>
            <Select value={form.location_id} onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))}>
              <option value="">— None —</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
            </Select>
          </Field>

          {/* ── Re-parent picker ── */}
          <Field label="Nest under another project?" style={{ marginBottom: 14 }} help="Optional — leave blank for a top-level project.">
            <Select
              value={form.parent_project_id}
              onChange={e => setForm(f => ({ ...f, parent_project_id: e.target.value }))}
            >
              <option value="">None — top-level project</option>
              {allProjects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>

          <Field label="Description" style={{ marginBottom: 14 }}>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={3} />
          </Field>

          {/* V4-PUBHIDE-001: is_public toggle removed. */}

          <div style={{ display: 'flex', gap: 12, paddingTop: 16, borderTop: `1px solid ${P.border}` }}>
            <Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…">
              Save changes
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div style={cardStyle}>
          <Fields project={project} locPath={locPath} />
        </div>
      )}

      {/* ---- Plants ---- */}
      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: P.dark }}>
            Plantings
            {plants.length > 0 && (
              <span style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.82rem', color: P.light }}>({plants.length})</span>
            )}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {plants.length > 1 && <SortToggle order={sortOrder} onChange={onSortChange} label="Sort plantings" />}
            <button onClick={() => { setShowAddPlant(v => !v); setPlantErr(null) }}
              style={showAddPlant ? ghostBtn : outlineBtn}>
              {showAddPlant ? 'Cancel' : '+ Add planting'}
            </button>
          </div>
        </div>

        {showAddPlant && (
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <PlantForm
              value={plantForm}
              onChange={patch => setPlantForm(f => ({ ...f, ...patch }))}
              onSubmit={handleAddPlant}
              submitting={addingPlant}
              error={plantErr}
              submitLabel="Add planting"
              submittingLabel="Adding…"
              onCancel={() => { setShowAddPlant(false); setPlantErr(null) }}
              plantingOptions={plants.map(p => ({ id: p.id, name: p.name }))}
              locations={locations}
              detailsDefaultOpen
              idPrefix="add-plant"
            />
          </div>
        )}

        {plantsLoading ? (
          <div style={{ padding: '16px 0', color: P.light, fontSize: '0.875rem' }}>Loading…</div>
        ) : plants.length === 0 ? (
          <div style={{ padding: '24px 20px', textAlign: 'center', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8, color: P.light, fontSize: '0.875rem' }}>
            No plantings yet — add individuals or groups above.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* V3-ORDER-001: same shared comparator/order as Garden + /plants so a planting
                sits in the identical position across every surface. Default recency. */}
            {applyNameSort(plants, sortOrder).map(plant => (
              /* V3-NAV-001 (PR2): the name/photo region is a dedicated nav target to the
                 PlantingDetail page; the photo-upload control is a SIBLING (never nested in
                 the link) to avoid invalid <button>-inside-<a> and the ADHD two-target mis-tap. */
              <div key={plant.id} style={{
                backgroundColor: P.white, border: `1px solid ${P.border}`,
                borderRadius: 8, padding: '8px 12px', minHeight: 44,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
              }}>
                {/* Dedicated name/photo nav region → PlantingDetail. Whole region is one tap
                    target (≥44px via card minHeight + padding); controls below are siblings. */}
                <Link
                  to={`/projects/${id}/plantings/${plant.id}`}
                  aria-label={`Open ${plant.name}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0,
                           textDecoration: 'none', color: 'inherit', minHeight: 44 }}
                >
                  {/* V1.2a-3 Increment A (I2a-display): the plant's featured photo.
                      Read-back surface for the photo→plant linkage that already worked. */}
                  {plant.featured_photo_view_url
                    ? <PhotoImg
                        photoId={plant.featured_photo_id}
                        initialUrl={plant.featured_photo_view_url}
                        alt=""
                        style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover',
                                 flexShrink: 0, border: `1px solid ${P.border}` }}
                      />
                    : <span aria-hidden="true" style={{ width: 40, height: 40, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '1.1rem', backgroundColor: P.greenPale, borderRadius: 8 }}>🌱</span>}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>
                      {plant.name}
                      {plant.quantity > 1 && (
                        <span style={{ marginLeft: 8, fontSize: '0.78rem', color: P.mid,
                          backgroundColor: P.greenPale, borderRadius: 10, padding: '1px 7px' }}>
                          ×{formatQty(plant.quantity)}
                        </span>
                      )}
                    </div>
                    {plant.variety_ref?.name && (
                      <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 2 }}>{plant.variety_ref.name}</div>
                    )}
                  </div>
                </Link>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  {/* Multi-channel status (WCAG 1.4.1): icon + label, never color alone. */}
                  {plant.status && <PlantStatusBadge status={plant.status} />}
                  {/* V2-PHOTO-F1 S2: per-plant upload trigger on each card. */}
                  <PhotoUpload
                    keyPrefix="plants"
                    parentId={plant.id}
                    linkage={{ plant_id: plant.id, project_id: id }}
                    errorMode="surface"
                    buttonLabel={<Icon name="media.camera" decorative size={20} />}
                    ariaLabel="Add photo"
                    showPreview={false}
                    inputId={`plant-photo-${plant.id}`}
                    buttonStyle={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 44, height: 44, padding: 0,
                      background: 'transparent', color: P.mid,
                      border: `1px solid ${P.border}`, borderRadius: '50%',
                      cursor: 'pointer', fontSize: '0.95rem', userSelect: 'none',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Project photos (V2-PHOTO-F1 Session 2) ---- */}
      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: P.dark }}>
            Project photos
          </h2>
        </div>
        <div style={{ ...cardStyle }}>
          <p style={{ margin: '0 0 12px', fontSize: '0.85rem', color: P.mid }}>
            Add photos directly to this project — they will appear in the Photo Library tagged with this project.
          </p>
          <PhotoUpload
            keyPrefix="projects"
            parentId={id}
            linkage={{ project_id: id }}
            errorMode="surface"
            buttonLabel={<><Icon name="media.camera" decorative size={18} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />Add photo</>}
            inputId={`project-photo-${id}`}
          />
        </div>
      </div>

      {/* ---- Event Log ---- */}
      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: P.dark }}>
            Event log
            {/* The old badge read `({events.length})` against an unpaged fetch, so it displayed a
                flat 50 on a 5,257-event project and presented the truncation as the total. M14
                finished the job: see the eventCountBadge derivation above for why the server total
                is now trustworthy and where it is still deliberately not trusted. */}
            {events.length > 0 && (
              <span style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.82rem', color: P.light }}>
                ({eventCountBadge})
              </span>
            )}
          </h2>
          <button
            onClick={() => {
              setShowLogForm(v => !v)
              setLogErr(null)
              if (!showLogForm) setTimeout(() => logFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50)
            }}
            style={showLogForm ? ghostBtn : primaryBtn(false)}
          >
            {showLogForm ? 'Cancel' : '+ Log event'}
          </button>
        </div>

        {showLogForm && (
          <form ref={logFormRef} onSubmit={handleLogEvent} style={{ ...cardStyle, marginBottom: 20 }}>
            {logErr && <ErrBanner msg={logErr} />}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Field label="Event type *" style={{ marginBottom: 14 }}>
                <Select
                  value={eventForm.event_type}
                  onChange={e => setEventForm(f => ({ ...f, event_type: e.target.value }))}
                >
                  {[...MINI_LOGGER_EVENT_TYPES].sort((a, b) => a.localeCompare(b)).map(t => (
                    <option key={t} value={t}>
                      {EVENT_TYPE_META[t]?.label ?? t.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Date *" style={{ marginBottom: 14 }}>
                <Input
                  type="date"
                  required
                  value={eventForm.event_date}
                  onChange={e => setEventForm(f => ({ ...f, event_date: e.target.value }))}
                />
              </Field>
            </div>

            {/* V4-PLANTREQUIRED-001 (O4): the mini-logger gains a planting picker so a project-page
                log can carry a planting. Optional by default; required only when the flag is on and
                the type predicates on a plant (D2). Controlled by the already-loaded project plants. */}
            <Field
              label={PLANTING_REQUIRED_ENABLED && requiresPlanting(eventForm.event_type) ? 'Planting *' : 'Planting (optional)'}
              style={{ marginBottom: 14 }}
            >
              <PlantingSelect
                plants={plants}
                value={eventForm.plant_id}
                onChange={pid => setEventForm(f => ({ ...f, plant_id: pid }))}
                required={PLANTING_REQUIRED_ENABLED && requiresPlanting(eventForm.event_type)}
                placeholder="— Choose a planting —"
                aria-label="Planting"
                data-testid="projdetail-mini-planting"
                // V4-CROPFILTER-001: crop chips on the mini-logger's picker (§1b enabled sites).
                cropChips={CROP_CHIPS_AUTO}
              />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
              <Field label="Title (optional)" style={{ marginBottom: 14 }}>
                <Input
                  value={eventForm.title}
                  onChange={e => setEventForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. First true leaves visible"
                />
              </Field>
              <Field label="Quantity (optional)" style={{ marginBottom: 14 }}>
                <Input
                  value={eventForm.quantity}
                  onChange={e => setEventForm(f => ({ ...f, quantity: e.target.value }))}
                  placeholder="e.g. 6 plants"
                />
              </Field>
            </div>

            <Field label="Notes (public)" style={{ marginBottom: 14 }}>
              <Textarea
                value={eventForm.notes}
                onChange={e => setEventForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Visible on public page…"
                style={{ height: 64 }}
              />
            </Field>

            <Field label="Private notes (never public)" style={{ marginBottom: 14 }}>
              <Textarea
                value={eventForm.private_notes}
                onChange={e => setEventForm(f => ({ ...f, private_notes: e.target.value }))}
                placeholder="Dosage, stress signs, anything you don't want to share…"
                style={{ height: 52, borderColor: P.warnBorder, backgroundColor: P.warn }}
              />
            </Field>

            {/* V2-PHOTO-F1 S2: inline photo capture for the mini-logger.
                Uses staged-file pattern (file picked here, uploaded after event POST). */}
            <Field label="Photo · optional" style={{ marginBottom: 14 }}>
              {miniPhotoPreview ? (
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  <img
                    src={miniPhotoPreview} alt="Preview"
                    style={{ maxWidth: '100%', maxHeight: 180, borderRadius: 8, display: 'block', border: `1px solid ${P.border}` }}
                  />
                  <button type="button" onClick={clearMiniPhoto}
                    aria-label="Remove staged photo"
                    style={{
                      position: 'absolute', top: 6, right: 6,
                      background: 'rgba(0,0,0,0.55)', color: P.white,
                      border: 'none', borderRadius: '50%',
                      width: 26, height: 26, cursor: 'pointer', fontSize: '0.8rem',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>✕</button>
                </div>
              ) : (
                // BUG-PHOTOUPLOADKBD-001: was a <label> wrapping the display:none input — no
                // tabindex, no role, and the input out of the tab order, so the only way to stage a
                // photo here was a pointer. Now a real <button> that clicks the input. The wrapper
                // <div> is load-bearing: Field clones only its FIRST element child and silently
                // DROPS any later one (Field.jsx:63-83), so button+input must arrive as one child.
                // aria-label rather than the visible copy: "Tap to…" is wrong for a keyboard user.
                <div>
                  <button
                    type="button"
                    onClick={() => miniPhotoInputRef.current?.click()}
                    aria-label="Take or choose a photo"
                    data-testid="mini-photo-trigger"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                      width: '100%', boxSizing: 'border-box',
                      padding: '14px 12px', border: `2px dashed ${P.border}`, borderRadius: 8,
                      cursor: 'pointer', backgroundColor: P.cream, color: P.mid, fontSize: '0.85rem',
                      fontFamily: 'inherit', fontWeight: 'inherit', lineHeight: 'inherit',
                      margin: 0, appearance: 'none', WebkitAppearance: 'none',
                    }}>
                    <Icon name="media.camera" decorative size={20} />
                    <span>Tap to take or choose a photo</span>
                  </button>
                  <input
                    ref={miniPhotoInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleMiniPhotoChange}
                    aria-hidden="true"
                    tabIndex={-1}
                    style={{ display: 'none' }}
                    data-testid="mini-photo-input"
                  />
                </div>
              )}
            </Field>

            {/* V4-PUBHIDE-001: inline event is_public toggle removed. */}

            <div style={{ display: 'flex', gap: 12, paddingTop: 14, borderTop: `1px solid ${P.border}` }}>
              <button type="submit" disabled={loggingEvent} style={primaryBtn(loggingEvent)}>
                {loggingEvent ? 'Saving…' : 'Save event'}
              </button>
              <button type="button" onClick={() => { setShowLogForm(false); setLogErr(null) }} style={ghostBtn}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* V4-EVTDELCONFIRM-001: the continue-and-report surface for a partial photo-delete
            failure — same copy as EventDetail's banner (the two surfaces must not diverge). */}
        {deleteErr && <ErrorBanner style={{ marginBottom: 12 }}>{deleteErr}</ErrorBanner>}

        {eventsLoading ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: P.light, fontSize: '0.875rem' }}>Loading…</div>
        ) : events.length === 0 ? (
          <div style={{ padding: '32px 20px', textAlign: 'center', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8, color: P.light, fontSize: '0.875rem' }}>
            No events yet — log the first one above.
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 18, top: 0, bottom: 0, width: 2, backgroundColor: P.border }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {events.map((ev, i) => (
                <EventRow
                  key={ev.id}
                  event={ev}
                  projectId={id}
                  isLast={i === events.length - 1}
                  deleting={deletingId === ev.id}
                  onDelete={() => handleDeleteEvent(ev.id)}
                />
              ))}
              {/* An explicit button, not infinite scroll. Matches the shipped pattern on
                  PlantingDetail, PhotoLibrary and Harvests; full width and 44pt-min so it is a
                  comfortable thumb target at the bottom of a long scroll on a 390px phone. The
                  label cannot carry a remaining count — the server sends has_more, not a total —
                  so it promises nothing it cannot keep. */}
              {eventsHasMore && (
                <button
                  type="button"
                  data-testid="project-event-log-show-more"
                  onClick={loadMoreEvents}
                  disabled={eventsMore}
                  style={{
                    marginTop: 4, minHeight: 44, width: '100%',
                    backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`,
                    borderRadius: 6, fontSize: '0.85rem', fontWeight: 600, fontFamily: 'inherit',
                    cursor: eventsMore ? 'default' : 'pointer',
                  }}
                >
                  {eventsMore ? 'Loading…' : 'Show more  ·  older events'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* DD9 / W-EVTDEL: kept mounted-open with busy while the write is in flight, per the
          component's contract — never closed optimistically over a request that may fail.
          V4-EVTDELCONFIRM-001: photoCount/coverFor now populated from the lazy per-event read. */}
      <EventDeleteConfirm
        open={confirmDeleteEventId != null}
        photoCount={confirmPhotos.length}
        coverFor={coverForFromPhotos(confirmPhotos)}
        busy={deletingId != null}
        onCancel={() => setConfirmDeleteEventId(null)}
        onConfirm={confirmEventDelete}
      />
    </Shell>
  )
}

function DeleteDialog({ childProjects, checkFailed, rechecking, onRecheck, onArchive, onDelete, onCancel }) {
  const hasChildren = childProjects.length > 0
  const top3 = childProjects.slice(0, 3)
  const extra = childProjects.length - 3

  return (
    <div style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        backgroundColor: P.white, borderRadius: 12, padding: 28,
        maxWidth: 440, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <h2 style={{ margin: '0 0 12px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>
          {checkFailed
            ? 'We couldn’t check for sub-projects'
            : hasChildren ? 'This project has sub-projects' : 'Delete project?'}
        </h2>

        {/* BUG-PROJDELORPHAN-001 — same grammar as the app's other failed-load notices (role="alert"
            + an inline Retry). Permanent delete is WITHDRAWN here, not merely annotated: the "This
            will permanently remove the project" line below is the exact copy a failed check used to
            produce, and a warning the user can tap straight past is that same assurance in a louder
            font. Archive stays offered — it is non-destructive, it is what this dialog recommends
            anyway, and it leaves every sub-project attached whether or not one exists. */}
        {checkFailed && (
          <div
            role="alert"
            data-testid="project-delete-check-failed"
            style={{
              marginBottom: 16, padding: '10px 12px', borderRadius: 6,
              backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`,
              fontSize: '0.85rem', color: P.terra,
            }}
          >
            Couldn’t check what is filed under this project, so we can’t tell you what deleting it
            would leave behind. Permanent delete is unavailable until that check runs.
            <button
              type="button"
              onClick={onRecheck}
              disabled={rechecking}
              data-testid="project-delete-recheck"
              style={{
                marginLeft: 8, padding: 0, border: 'none', background: 'none',
                color: P.terra, fontSize: '0.85rem', fontWeight: 600,
                textDecoration: 'underline', cursor: rechecking ? 'default' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {rechecking ? 'Checking…' : 'Retry'}
            </button>
          </div>
        )}

        {!checkFailed && hasChildren && (
          <div style={{ marginBottom: 16 }}>
            <p style={{ margin: '0 0 8px', fontSize: '0.88rem', color: P.mid }}>
              {childProjects.length} sub-project{childProjects.length !== 1 ? 's' : ''} will become top-level projects if you delete this one:
            </p>
            <ul style={{ margin: '0 0 8px', paddingLeft: 20 }}>
              {top3.map(c => (
                <li key={c.id} style={{ fontSize: '0.85rem', color: P.dark, marginBottom: 3 }}>{c.name}</li>
              ))}
              {extra > 0 && (
                <li style={{ fontSize: '0.85rem', color: P.light }}>…and {extra} more</li>
              )}
            </ul>
          </div>
        )}

        {!checkFailed && !hasChildren && (
          <p style={{ margin: '0 0 20px', fontSize: '0.88rem', color: P.mid }}>
            This will permanently remove the project. This action cannot be undone.
          </p>
        )}

        <p style={{ margin: '0 0 20px', fontSize: '0.83rem', color: P.light }}>
          Recommended: archive instead to keep the record without cluttering your active list.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={onArchive} style={{
            backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 6,
            padding: '10px 20px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', textAlign: 'center',
          }}>
            Archive instead (recommended)
          </button>
          {!checkFailed && (
            <button onClick={onDelete} style={{
              backgroundColor: 'transparent', color: P.terra,
              border: `1px solid ${P.alertBorder}`, borderRadius: 6,
              padding: '9px 20px', fontSize: '0.88rem', cursor: 'pointer',
            }}>
              Delete permanently
            </button>
          )}
          <button onClick={onCancel} style={ghostBtn}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function Fields({ project: p, locPath }) {
  const rows = [
    ['Variety',     p.variety_ref?.name],
    ['Species',     p.variety_ref?.species],
    ['Start date',  p.start_date ? new Date(p.start_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null],
    ['Location',    locPath ? `📍 ${locPath}` : null],
    // BUG-08 (2.1.1): Slug line hidden from detail display (humans don't need it; still populated in DB).
    ['Description', p.description],
  ].filter(([, v]) => v)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: P.light, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
          <div style={{ fontSize: '0.9rem', color: P.dark }}>{value}</div>
        </div>
      ))}
      {rows.length === 0 && <p style={{ color: P.light, margin: 0 }}>No additional details.</p>}
    </div>
  )
}

function EventRow({ event: ev, projectId, isLast, deleting, onDelete }) {
  const icon = <Icon name={`event.${ev.event_type}`} size={20} decorative style={{ color: P.green }} />
  const d = new Date(ev.event_date)
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <Link to={`/projects/${projectId}/events/${ev.id}`}
      style={{ textDecoration: 'none', color: 'inherit', display: 'flex', gap: 14, paddingBottom: isLast ? 0 : 18 }}>
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        backgroundColor: P.white, border: `2px solid ${P.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '1rem', flexShrink: 0, position: 'relative', zIndex: 1,
      }}>
        {icon}
      </div>

      <div style={{
        flex: 1, backgroundColor: P.white, border: `1px solid ${P.border}`,
        borderRadius: 8, padding: '10px 14px', marginBottom: isLast ? 0 : 2,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 2 }}>
              <span style={{ fontWeight: 600, color: P.dark, fontSize: '0.875rem' }}>
                {ev.title || ev.event_type.replace(/_/g, ' ')}
              </span>
              {ev.title && (
                <span style={{ fontSize: '0.75rem', color: P.light, fontStyle: 'italic' }}>
                  {ev.event_type.replace(/_/g, ' ')}
                </span>
              )}
              {ev.quantity && (
                <span style={{
                  fontSize: '0.73rem', color: P.mid,
                  backgroundColor: P.greenPale, borderRadius: 10, padding: '1px 7px',
                }}>
                  {ev.quantity}
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.75rem', color: P.light, marginBottom: ev.notes || ev.private_notes ? 6 : 0 }}>
              {dateStr}
            </div>
            {ev.notes && (
              <p style={{ margin: '0 0 4px', color: P.mid, fontSize: '0.83rem', lineHeight: 1.5 }}>
                {ev.notes}
              </p>
            )}
            {ev.private_notes && (
              <p style={{
                margin: 0, color: P.mid, fontSize: '0.8rem', lineHeight: 1.5,
                backgroundColor: P.warn, borderRadius: 4, padding: '4px 8px',
                borderLeft: `3px solid ${P.warnBorder}`,
              }}>
                🔒 {ev.private_notes}
              </p>
            )}
          </div>
          <button
            onClick={(e) => { e.preventDefault(); onDelete() }}
            disabled={deleting}
            title="Delete event"
            style={{
              background: 'none', border: 'none', cursor: deleting ? 'not-allowed' : 'pointer',
              color: P.light, fontSize: '1rem', padding: '2px 4px', lineHeight: 1, flexShrink: 0,
            }}
          >
            {deleting ? '…' : '×'}
          </button>
        </div>
      </div>
    </Link>
  )
}

function daysAgo(dateStr) {
  const d = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>{children}</div>
    </div>
  )
}
function ErrMsg({ msg }) { return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div> }
function ErrBanner({ msg }) {
  return <div style={{ backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: '0.875rem', color: P.bannerInk }}>{msg}</div>
}

const cardStyle  = { backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 28 }
const primaryBtn = (disabled) => ({ backgroundColor: disabled ? P.light : P.green, color: P.white, border: 'none', borderRadius: 6, padding: '9px 20px', fontSize: '0.88rem', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' })
const ghostBtn   = { backgroundColor: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 6, padding: '9px 20px', fontSize: '0.88rem', cursor: 'pointer' }
const outlineBtn = { backgroundColor: 'transparent', color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 6, padding: '7px 18px', fontSize: '0.85rem', cursor: 'pointer' }
