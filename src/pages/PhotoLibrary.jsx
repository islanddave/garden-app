import React, { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { T } from '../lib/tokens.js'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { setReloadBlocked } from '../lib/reloadGate.js'
import PhotoView from '../components/photo/PhotoView.jsx'
import { toPhoto, TIER, photoDate } from '../lib/photoModel.js'
import { invalidatePrefix as invalidatePhotoLists } from '../lib/dataCache.js'
import ErrorBoundary from '../components/ErrorBoundary.jsx'
import ProjectOptions from '../components/ProjectOptions.jsx'
import PlantingSelect from '../components/forms/PlantingSelect.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import FilterChipRow from '../components/forms/FilterChipRow.jsx'
import TagFilterBar from '../components/forms/TagFilterBar.jsx'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import { useCropFacetOptions } from '../hooks/useCropFacetOptions.js'
import {
  cropIndex, cropOfPhoto, filterByCrop, sortPhotos, activeFilterPills,
  PHOTO_FILTER_MODES, PHOTO_SORT_MODES, DEFAULT_PHOTO_SORT,
} from '../lib/photoFilters.js'
import { chevronDataUri } from '../components/forms/formStyles.js'
import { photoLoadErrorMessage } from '../components/PhotosWall.jsx'
import FacebookShareSheet from '../components/FacebookShareSheet.jsx'
import PhotoDeleteConfirm from '../components/photo/PhotoDeleteConfirm.jsx'
import QuickTagCarousel from '../components/photo/QuickTagCarousel.jsx'
import { useOptionalToast } from '../context/ToastContext.jsx'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'

// Higher than PhotoUpload/EventNew's 10 because this is the drain surface; matches the photos
// Lambda's MAX_BATCH (index.js) so client and server caps state one number, though this path does not
// use that route.
const MAX_STAGED = 20
let stagedSeq = 0
const nextStagedId = () => `pl-staged-${++stagedSeq}`
import { useDismissable } from '../context/DismissRegistry.jsx'
import { LAYER } from '../lib/dismissLayers.js'
import useScrollRestore from '../hooks/useScrollRestore.js'
// etDay/HARVEST_TZ rather than a local date compare: "today" must be the same garden day the harvest
// log uses, or a photo and the pick it documents can land on different days across midnight.
import { etDay } from '../lib/harvestSummary.js'
import { HARVEST_TZ } from '../lib/growYear.js'
import { snapshotFiles } from '../lib/fileSnapshot.js'

// Device-local memory of the zone filter, mirroring LogMany.jsx's SCOPE_KEY ('quicklog.lastScope').
// Same namespaced-by-surface shape, same write-on-change / validate-on-restore contract.
const LOC_FILTER_KEY = 'photos.lastLocationFilter'

// Byte-identical to EventNew's, PlantingSelect's and SavedSeeds' path: dataCache keys on the path,
// so any drift (a trailing slash, a reordered param) mints a second cache bucket.
const PICKER_PATH = '/api/plants?view=picker'

// Photo Library: browse all photos, upload standalone photos (event_id = null), and tag / un-tag
// photos against projects, locations and plants. The photos Lambda GET returns view_url (signed S3
// URL) and project_name inline; filter modes 'standalone' and 'untagged' are applied client-side.
// The photos Lambda POST requires only storage_path, but the DB CHECK photos_must_have_parent needs
// one of project/location/plant/event, so the upload form enforces one of project/space/planting.
// Uploads are staged locally and sent on an explicit "Upload photo" press via useUploadPhoto, not
// <PhotoUpload>, whose upload-on-pick contract would force the attach target to be chosen first.
// errorMode="surface" keeps errors loud.

// Graph API caps a multi-photo Page post; the bar refuses past this rather than letting the share
// sheet fail mid-post. Used by the warning, the disabled state and the cursor.
const MAX_SHARE_PHOTOS = 10

// Which plantings have designated this photo as their cover.
// `featured_is_explicit` is the whole predicate: the plants and projects/spaces reads return an
// effective hero, COALESCE(explicit pointer, newest photo), so matching featured_photo_id alone would
// name plantings whose "cover" is merely the newest photo, where deleting it changes nothing visible.
// It is true only when the stored pointer resolved (alive and still a member), the same thing
// eventPhotos.js's cover_for enumerates for the event-delete confirm.
// Partial by construction: it sees plantings only, from the list this page holds. Containers,
// zones, inventory items and spaces carry a featured_photo_id no PhotoLibrary fetch returns, and GET
// /api/photos has no cover data. So a named line is always true; its absence is never an all-clear
// (PhotoDeleteConfirm's generic arm covers that).
export function coverForPhoto(photoId, plants) {
  if (!photoId) return []
  return (plants ?? [])
    .filter(p => p?.featured_is_explicit && p?.featured_photo_id === photoId)
    .map(p => ({ id: p.id, name: p.name }))
}

// Seed for the quick-tag carousel's shortcut row: the plantings a list of photos is already attached
// to, most recent first, capped, so the first photo of a drain offers plausible targets; the user's
// own MRU displaces it within a few tags. It takes whichever list built the deck (see openQuickTag),
// so a global deck never offers shortcuts drawn only from the filtered project; deck and seed are
// stored as one object so they cannot drift.
const SEED_CAP = 8
function seedFromPhotos(source) {
  const seen = new Set()
  const out = []
  // created_at, not photoDate(): this answers "which plants has the user been working with lately",
  // which is about recent activity, not when the frames were taken.
  const recent = (source ?? []).slice().sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
  for (const p of recent) {
    if (!p.plant_id || seen.has(p.plant_id)) continue
    seen.add(p.plant_id)
    out.push(p.plant_id)
    if (out.length >= SEED_CAP) break
  }
  return out
}

export default function PhotoLibrary() {
  const { fetch: apiFetch } = useApiFetch()

  const [photos,        setPhotos]        = useState([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)  // visible load-failure state
  const [projects,      setProjects]      = useState([])
  const [locations,     setLocations]     = useState([])

  const [filterProject,  setFilterProject]  = useState('')
  const [filterLocation, setFilterLocation] = useState('')  // space filter (server-side subtree)
  const [filterMode,     setFilterMode]     = useState('all')
  // The crop facet, a Set owned here and session-ephemeral (FilterChipRow's contract): a narrowing
  // whose risk is being left on by accident. The zone filter persists because a zone is where you are.
  const [cropSel, setCropSel] = useState(() => new Set())
  // Two directions only: the list carries no name, weight or crop of its own (see photoFilters.js).
  const [sortOrder, setSortOrder] = useState(DEFAULT_PHOTO_SORT)

  // The crop axis. GET /api/photos returns plant_id and nothing else about the planting, so the crop
  // comes from a join against the picker projection: small, no presigned URLs, and usually warm in
  // dataCache. The wide `/api/plants` is project-scoped with PROJECTS_HIDDEN off, so the crop filter
  // would silently vanish; the picker path works in both flag states. Archived plantings are absent
  // from both the projection and the photo list, so the join has no systematic hole.
  // Both reads are gated on a photo actually naming a planting: otherwise there is no crop to derive,
  // the requests are pure latency, and the Untagged view correctly shows no crop row.
  // A plain effect rather than useCachedFetch: useCachedFetch calls `fetchRef.current(path).then(...)`
  // unguarded, so a fetch that returns undefined throws inside a passive effect and takes the page
  // down. useCropTypes wraps the call in `Promise.resolve()` for the same reason, and so does this.
  const anyPlantPhoto = useMemo(() => photos.some(p => p?.plant_id), [photos])
  const [plantsForCrop, setPlantsForCrop] = useState([])
  useEffect(() => {
    if (!anyPlantPhoto) return undefined
    let alive = true
    Promise.resolve(apiFetch(PICKER_PATH))
      .then(rows => { if (alive) setPlantsForCrop(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (alive) setPlantsForCrop([]) })
    return () => { alive = false }
  }, [apiFetch, anyPlantPhoto])
  const cropByPlantId = useMemo(() => cropIndex(plantsForCrop), [plantsForCrop])
  // Stable because useCropFacetOptions takes it as a memo dep and this page can hold ~1,400 rows; an
  // inline arrow would re-count them on every keystroke in the upload form.
  const cropSlugOf = useCallback(p => cropOfPhoto(p, cropByPlantId), [cropByPlantId])
  // Universe from `photos`, the pre-crop-filter list, so a chip tap can never collapse the row to the
  // one crop already chosen (the self-collapse trap useHarvestFilterOptions.js documents).
  const { options: cropOptions, pinned: cropPinned, labelBySlug: cropLabelBySlug } =
    useCropFacetOptions(photos, cropSlugOf, { enabled: anyPlantPhoto })
  // The row renders only when it could change the answer: one crop across every photo is furniture.
  const cropFacetEligible = cropOptions.length >= 2
  const toggleCrop = useCallback(slug => {
    setCropSel(prev => { const n = new Set(prev); n.has(slug) ? n.delete(slug) : n.add(slug); return n })
  }, [])
  const clearCrops = useCallback(() => setCropSel(prev => (prev.size ? new Set() : prev)), [])
  // The rendered list: filter then sort, both non-mutating and in src/lib so they are covered. The
  // grid, window, "Show more" count, selection derivation and Select-mode gate all read this, because
  // a photo the chips have hidden must not be shareable, countable or scrollable-to.
  const visiblePhotos = useMemo(
    () => sortPhotos(filterByCrop(photos, cropSel, cropByPlantId), sortOrder),
    [photos, cropSel, cropByPlantId, sortOrder],
  )

  // The zone filter remembers itself, in Log Many's idiom (`quicklog.lastScope`).
  // Not restored at first render: a saved id is applied only after it is checked against the live
  // location list, because a deleted or deactivated zone would fire `?location_id=<dead>` and land the
  // user on an empty library with a filter they never chose.
  const restoredFilterRef = useRef(false)
  const selectLocationFilter = useCallback(id => {
    setFilterLocation(id)
    try { localStorage.setItem(LOC_FILTER_KEY, id) } catch (e) {}
  }, [])

  // The active-filter breadcrumb. Labels are resolved here against the lists this page holds, so
  // photoFilters.js stays free of the page's fetches and unit-testable.
  const activePills = useMemo(() => activeFilterPills({
    mode: filterMode,
    cropSel,
    cropLabelBySlug,
    locationId: filterLocation,
    locationLabel: locations.find(l => String(l.id) === String(filterLocation))?.full_path ?? '',
    projectId: filterProject,
    projectLabel: projects.find(p => String(p.id) === String(filterProject))?.name ?? '',
  }), [filterMode, cropSel, cropLabelBySlug, filterLocation, locations, filterProject, projects])

  // Per-pill removal, switching on the builder-stamped `kind` rather than re-parsing the chip id.
  const removeFilterPill = useCallback(tag => {
    if (tag?.kind === 'mode') setFilterMode('all')
    else if (tag?.kind === 'crop') setCropSel(prev => { const n = new Set(prev); n.delete(tag.slug); return n })
    else if (tag?.kind === 'zone') selectLocationFilter('')
    else if (tag?.kind === 'project') setFilterProject('')
  }, [selectLocationFilter])

  // The one-tap escape. It clears the persisted zone too (through selectLocationFilter), or the sticky
  // filter would re-narrow the library on the next visit.
  const clearAllFilters = useCallback(() => {
    setFilterMode('all')
    setFilterProject('')
    selectLocationFilter('')
    setCropSel(prev => (prev.size ? new Set() : prev))
  }, [selectLocationFilter])

  const [showUpload,     setShowUpload]     = useState(false)
  const [uploadForm,     setUploadForm]     = useState({ project_id: '', location_id: '', plant_id: '', caption: '', is_public: true })
  const [plantsForUpload, setPlantsForUpload] = useState([])
  const [uploadErr,      setUploadErr]      = useState(null)
  // Photo first, attribute after: the user often does not know what a photo is until they look at it,
  // so files are staged locally and uploaded on an explicit action, as EventNew does. Staging lives
  // here, not in <PhotoUpload>, whose many call sites rely on upload-on-pick.
  // [{ id, file, url, status, error }] in pick order. One list shape even with the flag off, so the
  // read sites do not fork into an untested flag-off path.
  const [stagedItems,   setStagedItems]   = useState([])
  const [uploading,     setUploading]     = useState(false)
  // Set only when a batch finished with at least one failure: the count above the button. Per-file
  // errors live on the items themselves.
  const [batchSummary,  setBatchSummary]  = useState(null)
  // { done, total } while picked files are copied out of the picker's handles, else null. Picking is
  // not instant, and this stops a tap on twenty photos looking like a dead button.
  const [stagedPreparing, setStagedPreparing] = useState(null)
  // Photos with no parent, as of the last unscoped list fetch. `null` means "not measured yet"; the
  // badge's `> 0` test treats null and 0 alike, so the distinction matters only to future readers.
  const [untaggedCount, setUntaggedCount] = useState(null)

  // The drain deck, or null when the carousel is closed. Holds the photos, not a boolean: the carousel
  // freezes its list at mount so the deck cannot shrink under the user's finger.
  const [quickTagDeck, setQuickTagDeck] = useState(null)
  const stagedInputRef = useRef(null)
  const stagedUploader = useUploadPhoto({ errorMode: 'surface' })
  // A staged blob URL outlives the component unless revoked; leaving with photos staged and unsent is
  // ordinary. Reads the updater's `prev` so it can never revoke a stale list.
  useEffect(() => () => {
    setStagedItems(prev => { for (const it of prev) URL.revokeObjectURL(it.url); return [] })
  }, [])

  const [modal,          setModal]          = useState(null)
  const [tagForm,        setTagForm]        = useState({ project_id: '', location_id: '', plant_id: '', caption: '' })
  const [plantsForModal, setPlantsForModal] = useState([])
  const [tagging,        setTagging]        = useState(false)
  const [tagErr,         setTagErr]         = useState(null)

  // The standalone photo delete. Held as the photo, not a boolean: the confirm names and shows what it
  // deletes, and the tag modal stays open behind it so Cancel returns the user where they were.
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting,     setDeleting]     = useState(false)
  const [deleteErr,    setDeleteErr]    = useState(null)
  const toast = useOptionalToast()

  // Multi-select + Facebook Page share.
  const [selectMode,  setSelectMode]  = useState(false)
  const [selected,    setSelected]    = useState(() => new Set())
  const [shareOpen,   setShareOpen]   = useState(false)
  const [sharePhotos, setSharePhotos] = useState([])
  // The share sheet composes text in its own state, so it reports dirtiness through onDirtyChange
  // into the reload gate. The setter is referentially stable, so the sheet's effect fires only on a
  // real flip.
  const [shareDirty,  setShareDirty]  = useState(false)

  // Select mode and the upload form can both be open (the "+ Upload" button never leaves select mode),
  // and the z150 fixed action bar wins over the form's PlantingSelect listbox on z and hit testing, so
  // a tap aimed at a planting row would hit "Post to Facebook" or "Cancel". The bar is suppressed while
  // the picker is open.
  const [uploadPickerOpen, setUploadPickerOpen] = useState(false)
  const handleUploadPickerOpenChange = useCallback(open => setUploadPickerOpen(open), [])

  // Explicit windowing: native loading="lazy" never fires on this absolutely-positioned grid (images
  // are never requested), and all-eager froze the renderer. So render a window and grow it on scroll.
  const PAGE = 24
  // The window size is restored with the scroll offset at first render, so the tiles that give the
  // page its height exist in the same commit as the photos; otherwise the browser clamps the restored
  // scroll. Capped so a corrupt sessionStorage value cannot mount 1,000 live <img>.
  const MAX_RESTORED_WINDOW = PAGE * 40
  const { restoredState, saveState } = useScrollRestore({ id: 'photos', ready: !loading })
  const [shown, setShown] = useState(() => {
    const w = Number(restoredState)
    return Number.isFinite(w) ? Math.min(Math.max(w, PAGE), MAX_RESTORED_WINDOW) : PAGE
  })
  useEffect(() => { saveState(shown) }, [shown, saveState])
  // A filter change replaces the set the window and selection describe, so both reset. Clear, not
  // intersect (see `selectedPhotos`). Returning `prev` when empty keeps the Set identity stable.
  // The mount run is skipped so a restored window is not collapsed. Keyed on the filter tuple rather
  // than a mount flag: StrictMode runs effects twice on mount, and a bare skip-first flag would let the
  // second run collapse it in dev. The crop selection is in the tuple (it changes the set); sort is
  // not, because reordering neither invalidates a selection nor justifies discarding scroll depth.
  const lastFiltersRef = useRef(null)
  useEffect(() => {
    const sig = `${filterProject}|${filterLocation}|${filterMode}|${[...cropSel].sort().join(',')}`
    if (lastFiltersRef.current === sig) return
    const first = lastFiltersRef.current === null
    lastFiltersRef.current = sig
    if (first) return
    setShown(PAGE)
    setSelected(prev => (prev.size ? new Set() : prev))
  }, [filterProject, filterLocation, filterMode, cropSel])
  useEffect(() => {
    // A scroll listener, not IntersectionObserver: IO is the same machinery native lazy depends on,
    // which is what is not firing on this layout.
    function onScroll() {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 800) {
        setShown(s => (s < visiblePhotos.length ? s + PAGE : s))
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll() // a short first page must still be able to grow without a scroll
    return () => window.removeEventListener('scroll', onScroll)
    // The rendered length, not the fetched one: keyed on `photos.length` the window would keep
    // growing past the end of a crop-filtered grid.
  }, [visiblePhotos.length])

  // ---- Initial data load ----
  useEffect(() => {
    Promise.all([
      apiFetch('/api/projects'),
      apiFetch('/api/locations/with-path'),
    ]).then(([proj, locs]) => {
      const live = (locs ?? []).filter(l => l.is_active)
      setProjects(proj ?? [])
      setLocations(live)
      // Restore the saved zone filter only if it still names a live zone. `live` is the list the
      // <select> renders, so a surviving id has an <option>; a dead one is dropped silently and the
      // user gets the unfiltered library.
      try {
        const saved = localStorage.getItem(LOC_FILTER_KEY)
        if (!restoredFilterRef.current && saved && live.some(l => String(l.id) === saved)) {
          // One-shot: this effect re-runs when `apiFetch` changes identity (and twice under
          // StrictMode); re-restoring would re-null the ref below without a state change, and the next
          // real filter change would wrongly read as the first.
          restoredFilterRef.current = true
          // Rewind the filter-change ref so the effect above treats the restore as the first filter
          // state, not a change; otherwise it runs `setShown(PAGE)` and collapses the restored window.
          lastFiltersRef.current = null
          setFilterLocation(saved)
        }
      } catch (e) {}
    }).catch(() => {})
  }, [apiFetch])

  // ---- Load plants when the upload project changes (project-scoped mode, the default). ----
  useEffect(() => {
    if (PROJECTS_HIDDEN) return // unscoped fetch below
    if (!uploadForm.project_id) { setPlantsForUpload([]); return }
    apiFetch('/api/plants?project_id=' + uploadForm.project_id)
      .then(data => setPlantsForUpload(data ?? []))
      .catch(() => setPlantsForUpload([]))
  }, [apiFetch, uploadForm.project_id])

  // ---- Load plants when the modal project changes (project-scoped mode, the default). ----
  useEffect(() => {
    if (PROJECTS_HIDDEN) return // unscoped fetch below
    if (!tagForm.project_id) { setPlantsForModal([]); return }
    apiFetch('/api/plants?project_id=' + tagForm.project_id)
      .then(data => setPlantsForModal(data ?? []))
      .catch(() => setPlantsForModal([]))
  }, [apiFetch, tagForm.project_id])

  // With the project chooser hidden, both photo pickers (upload + tag modal) list every live planting
  // from the unscoped source; project_id is derived from the chosen plant at onChange. Fetched once.
  useEffect(() => {
    if (!PROJECTS_HIDDEN) return
    apiFetch('/api/plants')
      .then(data => {
        const live = (data ?? []).filter(p => !p.archived_at)
        setPlantsForUpload(live); setPlantsForModal(live)
      })
      .catch(() => { setPlantsForUpload([]); setPlantsForModal([]) })
  }, [apiFetch])

  // ---- Photos query ----
  const loadPhotos = useCallback(async () => {
    setLoading(true)
    setError(null)
    const qs = filterProject ? `?project_id=${filterProject}`
             : filterLocation ? `?location_id=${filterLocation}`
             : ''
    try {
      let data = await apiFetch('/api/photos' + qs) ?? []

      // The untagged count turns "Untagged" from a filter into a visible to-do after a bulk upload.
      // Only from an unscoped fetch: a scoped response is a subset, and its count would render in a
      // chip that reads as global. The badge keeps its last unscoped value instead. `isAttached` is
      // photoModel's, so this and the filter below cannot drift apart.
      if (!filterProject && !filterLocation) {
        setUntaggedCount(data.filter(p => !toPhoto(p).isAttached).length)
      }
      // "Today" is keyed on created_at, not capture time: it serves the tagging workflow ("what
      // arrived today that I have not dealt with"), and after bulk-uploading older photos a
      // capture-time filter could not see any of them. The day is the garden day in HARVEST_TZ, the
      // boundary the harvest log groups by. Client-side and complete: /api/photos returns the whole
      // list in one response.
      if (filterMode === 'today') {
        const todayKey = etDay(new Date(), HARVEST_TZ)
        data = data.filter(p => etDay(p.created_at, HARVEST_TZ) === todayKey)
      }
      if (filterMode === 'standalone') data = data.filter(p => !p.event_id)
      // Untagged means attached to no parent: a photo attached to any parent is finished work.
      // `isAttached` counts all six FKs the photos_must_have_parent CHECK counts (inventory items
      // included), so a new parent kind cannot silently reopen this. The space arm is unconditional,
      // not behind SPACE_PHOTOS_ENABLED: space_id arrives when the server gate opens, independent of
      // this client flag, and a stale cached bundle must not flag space photos as unfinished. The list
      // decorates rows with space_id only when the server gate is open, so do not judge this arm's
      // effect from the row data without checking the wire.
      if (filterMode === 'untagged')   data = data.filter(p => !toPhoto(p).isAttached)
      setPhotos(data)
    } catch (err) {
      setPhotos([])
      setError(err)   // apiFetch throws with .status on non-2xx; surface instead of masking as empty
    }
    setLoading(false)
  }, [apiFetch, filterProject, filterLocation, filterMode])

  useEffect(() => { loadPhotos() }, [loadPhotos])

  // ---- Upload handlers ----
  function clearStaged() {
    setStagedItems(prev => { for (const it of prev) URL.revokeObjectURL(it.url); return prev.length ? [] : prev })
    setBatchSummary(null)
  }

  function removeStagedItem(id) {
    setStagedItems(prev => {
      const hit = prev.find(s => s.id === id)
      // An in-flight upload is uncancellable; keep its row and its URL until the queue settles.
      if (!hit || hit.status === 'uploading') return prev
      URL.revokeObjectURL(hit.url)
      return prev.filter(s => s.id !== id)
    })
  }

  function handleUploadComplete() {
    setShowUpload(false)
    setUploadForm({ project_id: '', location_id: '', plant_id: '', caption: '', is_public: true })
    setUploadErr(null)
    clearStaged()
    loadPhotos()
  }

  // Open the picker inside the tap: a picker opened from a later effect has lost the trusted gesture
  // and is suppressed. No camera arm.
  function openStagedPicker() {
    const el = stagedInputRef.current
    if (!el) return
    el.click()
  }

  // Bytes are copied here at pick time, not held as picker handles. uploadStaged() reads files one at
  // a time on the Upload tap, and by then Android may have reclaimed the temporary handles (Chrome's
  // "requested file could not be read ... after a reference to a file was acquired"); the first
  // photo's decode is itself the memory pressure. Thumbnails keep rendering because an object URL is
  // a pointer, not a copy. Mechanism: lib/fileSnapshot.js. Picking is async (one copy per photo),
  // hence the "Preparing" line, and an unreadable photo is reported while the user is still picking.
  async function onStagedPick(e) {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''   // re-picking the same file must refire onChange
    if (!picked.length) return
    setUploadErr(null)
    setBatchSummary(null)

    // Room is computed twice on purpose. Here it bounds the copying; the updater below re-derives it
    // from `prev` and is the authority, because this function awaits and `stagedItems` may be a render
    // behind when it resumes.
    const roomNow = Math.max(0, MAX_STAGED - stagedItems.length)
    const candidates = picked.slice(0, roomNow)
    if (!candidates.length) return

    setStagedPreparing({ done: 0, total: candidates.length })
    let ok = [], failed = []
    try {
      ;({ ok, failed } = await snapshotFiles(
        candidates,
        (done, total) => setStagedPreparing({ done, total }),
      ))
    } finally {
      setStagedPreparing(null)
    }

    if (failed.length) {
      // Named, not counted: with nine failures the user needs to know WHICH photo to re-pick.
      const names = failed.map(f => f.file?.name).filter(Boolean)
      setUploadErr(
        `${failed.length} of ${candidates.length} couldn't be read and ${failed.length === 1 ? 'was' : 'were'} not added` +
        `${names.length ? ` (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''})` : ''}` +
        '. Re-pick from the gallery and try again.'
      )
    }
    if (!ok.length) return

    setStagedItems(prev => {
      const room = Math.max(0, MAX_STAGED - prev.length)
      const accepted = ok.slice(0, room)
      if (!accepted.length) return prev
      // The object URL comes from the snapshot: one pointing at the replaced handle dies with it.
      return prev.concat(accepted.map(({ file }) => ({
        id: nextStagedId(), file, url: URL.createObjectURL(file), status: 'staged', error: null,
      })))
    })
  }

  // One serial queue for both destinations. With a target chosen, every photo attaches to it. With no
  // target and more than one photo, the batch goes to the inbox: `intake_status='pending_tag'` and no
  // parent, which photos_must_have_parent admits for exactly this status and POST /api/photos stores.
  // Those rows surface under "Untagged" and drain through the tag modal.
  // Not POST /api/photos/batch: it is presign-only, so it would bypass stripImageFile (GPS removal),
  // the 800px thumb the grid's payload depends on, and the relay-upload fallback. The inbox is
  // defined by the intake_status column, not the storage prefix.
  // Serial: one decode at a time keeps memory bounded.
  async function uploadStaged() {
    if (!stagedItems.length || uploading || (targetMissing && !canUploadUntagged)) return
    setUploading(true)
    setUploadErr(null)
    setBatchSummary(null)

    const toInbox = targetMissing
    const linkage = toInbox ? { intake_status: 'pending_tag' } : photoLinkage
    let failed = 0
    // The first failure's own text: it is the part the user can act on ("Upload stalled — …"); a
    // generic "Upload failed." would lose it.
    let firstError = null
    const total = stagedItems.length

    for (const item of stagedItems) {
      setStagedItems(prev => prev.map(s => (s.id === item.id ? { ...s, status: 'uploading', error: null } : s)))
      const res = await stagedUploader.upload(item.file, {
        keyPrefix: 'standalone',
        linkage,
        caption: photoCaption,
        is_public: uploadForm.is_public,
      })
      if (res?.error) {
        failed += 1
        if (!firstError) firstError = res.error
        setStagedItems(prev => prev.map(s => (s.id === item.id ? { ...s, status: 'error', error: res.error } : s)))
      } else {
        setStagedItems(prev => prev.map(s => (s.id === item.id ? { ...s, status: 'done', error: null } : s)))
      }
    }

    setUploading(false)

    // All failed: surface, keep the form open, keep the files.
    if (failed === total) {
      handleUploadError(total === 1 ? firstError : `None of the ${total} photos uploaded — ${firstError}`)
      return
    }
    // A partial failure keeps the form open: drop the ones that landed and keep the failures staged
    // so the retry is one tap, not a re-pick.
    if (failed > 0) {
      setStagedItems(prev => {
        for (const s of prev) if (s.status === 'done') URL.revokeObjectURL(s.url)
        return prev.filter(s => s.status !== 'done')
      })
      // Carries the reason, not just the count: with one photo left the strip collapses to the bare
      // preview, so this line is the only place the failure can speak.
      setBatchSummary(`${total - failed} of ${total} uploaded — the rest are still here to retry. ${firstError}`)
      loadPhotos()
      return
    }
    handleUploadComplete()
  }

  function handleUploadError(msg) {
    setUploadErr(msg || 'Upload failed.')
  }

  // ---- The one-at-a-time drain ----

  // The deck is global because the badge is global: `untaggedCount` is recomputed only from an
  // unscoped fetch. Under a project filter every row has a project_id, so a deck built from `photos`
  // would be empty and the tap a silent no-op. So fetch the unscoped list when, and only when, a scope
  // filter is active; with no filter `photos` already is that list. When a value is deliberately
  // global, every consumer of it must be global too.
  const [quickTagOpening, setQuickTagOpening] = useState(false)
  const openQuickTag = useCallback(async () => {
    if (quickTagOpening) return          // the fetch below is a round trip; a second tap must not race it
    const scoped = Boolean(filterProject || filterLocation)
    let source = photos
    if (scoped) {
      setQuickTagOpening(true)
      try {
        source = await apiFetch('/api/photos') ?? []
      } catch (err) {
        // An unreachable list is not "nothing to tag": say so rather than a tap that does nothing.
        toast.show({ message: "Couldn't load the untagged photos — try again.", tone: 'error' })
        return
      } finally {
        setQuickTagOpening(false)
      }
    }
    // Oldest first by photoDate(), i.e. capture order: the carousel replays a garden walk in the
    // order it happened (spatial memory), which is also what lets the shortcut MRU converge. Upload
    // order is just the order S3 acknowledged the files.
    const pending = source
      .filter(p => !toPhoto(p).isAttached)
      .slice()
      .sort((a, b) => String(photoDate(a) ?? '').localeCompare(String(photoDate(b) ?? '')))
    // Reconcile the held badge to the global truth just measured: in the empty case the tapped count
    // disappears instead of the tap appearing to fail, and a count left stale by another device heals.
    setUntaggedCount(pending.length)
    if (!pending.length) return
    // Deck and seed are one piece of state so they cannot drift; the seed comes from whichever list
    // built the deck, which under a scope filter this component never held.
    setQuickTagDeck({ photos: pending, seed: seedFromPhotos(source) })
  }, [photos, filterProject, filterLocation, apiFetch, quickTagOpening, toast])


  // One photo left the inbox. Update in place rather than refetching: a refetch mid-drain would
  // re-sort the grid under the modal, and the carousel holds its own frozen deck.
  const handleQuickTagAssigned = useCallback((photoId, plantId, planting) => {
    setPhotos(ps => ps.map(p => (
      p.id === photoId
        ? { ...p, plant_id: plantId, project_id: planting?.project_id ?? p.project_id, intake_status: null }
        : p
    )))
    setUntaggedCount(c => (typeof c === 'number' && c > 0 ? c - 1 : c))
    invalidatePhotoLists('/api/photos')
  }, [])

  // The linkage forwarded into POST /api/photos. Empty strings become null so the Lambda treats them
  // as unset rather than "" (which fails FK validation).
  const photoLinkage = {
    project_id:  uploadForm.project_id || null,
    location_id: uploadForm.location_id || null,
    plant_id:    uploadForm.plant_id    || null,
  }
  const photoCaption = uploadForm.caption.trim() || null
  // One-of target gate, matching the photos_must_have_parent CHECK and the handleTag predicate below.
  // A space alone is a valid home.
  const targetMissing = !uploadForm.project_id && !uploadForm.location_id && !uploadForm.plant_id

  // The one place the no-target rule is relaxed, deliberately narrowly. A parentless photo is legal
  // only as `intake_status='pending_tag'` (the CHECK's other arm), but its home is still unstated, so
  // it takes more than one staged photo and an explicit tap on a differently-labelled button. The >1
  // condition is the load-bearing one: a single untagged photo is almost always a slip the rule should
  // catch, while a deliberate camera-roll drain is many photos whose homes differ.
  const canUploadUntagged = stagedItems.length > 1

  // ---- Modal / tag handlers ----
  function openModal(photo) {
    setModal(photo)
    setTagForm({
      project_id:  photo.project_id  ?? '',
      location_id: photo.location_id ?? '',
      plant_id:    photo.plant_id    ?? '',
      caption:     photo.caption     ?? '',   // editable post-upload
    })
    setTagErr(null)
  }

  // ---- The reload gate ----
  // Three editable regions that can hold content at once (enterSelectMode() collapses the upload
  // form without clearing it, the tag modal opens over it, the share sheet over either), so the gate
  // is their union.
  // 1. Upload form: staged files sit in memory while the user decides where they go, so a reload
  //    lands squarely in that window; `caption` is free text. Not gated on `showUpload`: "Select"
  //    sets showUpload=false as a side effect, and that would drop the hold on staged files the user
  //    will see again. The pickers are not counted (one tap to redo, and meaningful only with a
  //    staged file, which holds the gate already). `is_public` has no control here. No `uploading`
  //    term: staged items are cleared only in handleUploadComplete(), so they span the upload.
  // 2. Tag modal: seeded from the photo by openModal(), so dirty means differs-from-the-row, which
  //    releases on a revert. The `modal` term matters: closing leaves tagForm populated, but a reopen
  //    re-seeds, so a dismissed edit is unreachable and holding a deploy for it would wedge updates.
  //    Compared against `modal` directly; the comparison must keep mirroring openModal() above.
  // 3. Share sheet: its free text lives in FacebookShareSheet's state, so it reports a boolean. Not
  //    `shareOpen`: a merely opened sheet holds no content.
  // Excluded: the selection (view state, cleared on any filter change), the delete confirm, the
  // filters and `shown` (restored from sessionStorage by useScrollRestore).
  const modalDirty = !!(modal && (
    tagForm.project_id  !== (modal.project_id  ?? '') ||
    tagForm.location_id !== (modal.location_id ?? '') ||
    tagForm.plant_id    !== (modal.plant_id    ?? '') ||
    tagForm.caption     !== (modal.caption     ?? '')
  ))

  const hasUnsavedInput = !!(stagedItems.length || uploadForm.caption.trim() || modalDirty || shareDirty)

  useReportOverlayDirty(hasUnsavedInput)

  // /photos is not an overlayable route, so the hook above is a no-op and this gate is what protects
  // the page. Per-instance key and a boolean dep, as in EventNew.jsx's reload gate.
  const reloadGateKey = `photo-library:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  async function handleTag(e) {
    e.preventDefault()
    const newProject  = tagForm.project_id  || null
    const newLocation = tagForm.location_id || null
    const newPlant    = tagForm.plant_id    || null
    // Trimmed-empty caption → null.
    const newCaption  = tagForm.caption.trim() || null
    // The one-of gate names every parent the photos_must_have_parent CHECK counts, so a plant-only
    // photo can be edited. `modal.space_id` reads from the modal, not the form: this form has no space
    // control, the PUT below does not send space_id and the Lambda's UPDATE does not set it, so the
    // persisted value is what the CHECK will see. Space attach/detach is PUT /api/photos/:id/space.
    // An event-attached photo is always parented.
    if (!newProject && !newLocation && !newPlant && !modal.event_id && !modal.space_id) {
      setTagErr('A standalone photo needs at least a project, zone, or plant.')
      return
    }

    setTagging(true)
    setTagErr(null)

    try {
      await apiFetch('/api/photos/' + modal.id, {
        method: 'PUT',
        body: JSON.stringify({
          project_id:  newProject,
          location_id: newLocation,
          plant_id:    newPlant,
          caption:     newCaption,
          tags:        modal.tags ?? null,
        }),
      })

      // A re-link moves the photo between buckets, so every cached photo list may be stale.
      // PhotoLibrary's own grid is not cached, but the routed surfaces are.
      invalidatePhotoLists('/api/photos')

      const updatedProjectName = projects.find(p => p.id === newProject)?.name ?? null

      setPhotos(ps => ps.map(p =>
        p.id === modal.id
          ? { ...p, project_id: newProject, location_id: newLocation, plant_id: newPlant, caption: newCaption, project_name: updatedProjectName }
          : p
      ))
      setModal(null)
      setTagging(false)
    } catch (err) {
      setTagging(false)
      setTagErr(err.message)
    }
  }

  // ---- Standalone photo delete ----
  // DELETE /api/photos/:id (lambda/photos/photoDelete.js) soft-deletes: `deleted_at = now()`, display
  // pointers nulled in the same transaction, no row removed, no S3 object touched, and restore
  // re-promotes it into any empty hero slot. The client only asks, discloses and re-syncs; nothing
  // here may bypass or duplicate that. The path is spelled exactly as handleTag's PUT spells it.
  async function confirmDelete() {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    setDeleteErr(null)
    try {
      await apiFetch('/api/photos/' + deleteTarget.id, { method: 'DELETE' })
      // Every cached photo list still contains this row; dataCache's only consumers are photo lists,
      // so this one prefix covers the routed surfaces. The local grid is corrected below.
      invalidatePhotoLists('/api/photos')
      // Drop locally rather than refetching: the server answer is the confirmation. The selection
      // needs no parallel edit because selectedPhotos derives from the photo list.
      setPhotos(ps => ps.filter(p => p.id !== deleteTarget.id))
      setDeleteTarget(null)
      setModal(null)
      // Operational confirmation of a user-started action (the Toast layer's carve-out, not a reward
      // channel). It names Recently deleted because that recovery path is what lets this delete be
      // low-friction. No undo action: a 5s window is not a recovery model.
      toast.show({ message: 'Photo deleted — in Recently deleted' })
    } catch (err) {
      // Keep the sheet open with the message: closing over a failed write leaves the photo on screen
      // with no explanation.
      setDeleteErr(err?.message || 'Could not delete that photo.')
    }
    setDeleting(false)
  }

  // ---- Select mode + share ----
  function enterSelectMode() { setSelectMode(true); setShowUpload(false) }
  function exitSelectMode() { setSelectMode(false); setSelected(new Set()) }
  function toggleSelect(id) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function openShare(photoList) { setSharePhotos(photoList); setShareOpen(true) }
  // The one source of truth for the selection is this, not the id Set: an id cannot tell whether it
  // still resolves to a row, and this is what openShare() posts. The bar's existence, count and max
  // guard all derive from it, so the count shown and the photos posted can never disagree.
  // Derived from the rendered list: a photo hidden by the crop chips must not be counted, capped or
  // posted publicly. Deriving covers every replacement of the list (an upload completing, a quick-tag
  // assignment), not just the filter changes the clear effect handles.
  // The filter-change effect clears rather than intersects: `photos` is a server page, so intersecting
  // would drop ids silently and arbitrarily, and for a control that posts publicly the safe failure is
  // making the user re-pick against the list in front of them.
  const selectedPhotos = visiblePhotos.filter(p => selected.has(p.id))
  const selectionCount = selectedPhotos.length
  const selectionOverMax = selectionCount > MAX_SHARE_PHOTOS
  // The FB share UI appears only once VITE_API_FACEBOOK_SHARE is configured, keeping a half-feature
  // out of prod on any promote.
  const fbShareEnabled = !!import.meta.env.VITE_API_FACEBOOK_SHARE

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '28px 16px 60px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: T.space.lg }}>
          <div>
            <div style={{ fontSize: T.type.sm, color: P.light, marginBottom: 8 }}>
              <Link to="/dashboard" style={{ color: P.green, textDecoration: 'none' }}>Dashboard</Link>
              {' › Photos'}
            </div>
            <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
              Photos
            </h1>
            {/* The only entry point to Recently deleted, so it is unconditional, including when the list
                is empty ("where did my deleted photo go?" is asked from here). Under the title because
                at 390px the button row is full and a link there reads as a third button. */}
            <Link
              to="/photos/deleted"
              style={{
                display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
                color: P.mid, fontSize: '0.84rem', fontWeight: 600, textDecoration: 'none',
              }}
            >
              Recently deleted
            </Link>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: T.space.lg }}>
            {visiblePhotos.length > 0 && fbShareEnabled && (
              <button
                onClick={() => (selectMode ? exitSelectMode() : enterSelectMode())}
                style={{
                  backgroundColor: selectMode ? P.light : P.white,
                  color: selectMode ? P.white : P.green,
                  border: `1px solid ${selectMode ? P.light : P.green}`, borderRadius: T.radiusButton,
                  padding: '10px 16px', fontSize: T.type.sm2, fontWeight: 700, cursor: 'pointer',
                }}
              >
                {selectMode ? 'Cancel' : 'Select'}
              </button>
            )}
            <button
              onClick={() => { setShowUpload(s => !s); setUploadErr(null) }}
              style={{
                backgroundColor: showUpload ? P.light : P.green,
                color: P.white, border: 'none', borderRadius: T.radiusButton,
                padding: '10px 16px', fontSize: T.type.sm2, fontWeight: 700, cursor: 'pointer',
              }}
            >
              {showUpload ? 'Cancel' : '+ Upload'}
            </button>
          </div>
        </div>

        {/* Upload form */}
        {showUpload && (
          <div style={{
            backgroundColor: P.white, border: `1px solid ${P.border}`,
            borderRadius: T.radiusCard, padding: 18, marginBottom: T.space.lg,
          }}>
            <h2 style={{ margin: '0 0 14px', fontSize: T.type.md, fontWeight: 700, color: P.mid }}>
              Upload standalone photo
            </h2>
            {uploadErr && <ErrBanner msg={uploadErr} />}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="photo-library-upload-form">

              {/* The photo comes first and is never gated. */}
              <input
                ref={stagedInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={onStagedPick}
                style={{ display: 'none' }}
                data-testid="pl-staged-input"
              />
              {/* Choose is the only entry (no camera arm). */}
              {stagedItems.length === 0 ? (
                <div style={{ display: 'flex', gap: T.space.sm }}>
                  <button type="button" data-testid="pl-stage-choose" onClick={openStagedPicker}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '18px 12px', border: `2px dashed ${P.border}`, borderRadius: T.radiusButton, cursor: 'pointer', backgroundColor: P.white, color: P.mid, fontSize: T.type.sm2, fontWeight: 600 }}>
                    <span style={{ fontSize: '1.3rem' }}>🖼️</span><span>Choose photo</span>
                  </button>
                </div>
              ) : (
                <div>
                  {/* One staged photo keeps the full-width 260px preview in every state, failure
                      included: with one photo the reason belongs in the single aggregate line
                      (`batchSummary` for partial, the banner for all-failed), not a per-row copy
                      (PhotoLibrary.test.jsx pins this). Several render as a tiled strip, where
                      per-row errors answer "which one". */}
                  {stagedItems.length === 1 ? (
                    <img src={stagedItems[0].url} alt="Upload preview" data-testid="pl-staged-preview"
                      style={{ width: '100%', maxHeight: 260, objectFit: 'cover', borderRadius: T.radiusCard, display: 'block' }} />
                  ) : (
                    // Height-capped: twenty 84px tiles wrap tall enough to push the zone picker and
                    // Upload below the fold at 390x844, defeating the see-then-place ordering (measured
                    // in tests/harness/photobulk.jsx; jsdom cannot see it). 216px is two rows plus the
                    // status line; scrolling inside keeps every thumbnail reachable at constant cost.
                    <ul data-testid="pl-staged-strip"
                        style={{ display: 'flex', flexWrap: 'wrap', gap: T.space.sm, listStyle: 'none',
                                 padding: 0, margin: 0, maxHeight: 216, overflowY: 'auto' }}>
                      {stagedItems.map((item, i) => (
                        <li key={item.id} data-testid="pl-staged-item" data-status={item.status}
                            style={{ position: 'relative', width: 84 }}>
                          <img src={item.url} alt={`Staged photo ${i + 1} of ${stagedItems.length}`}
                            style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: T.radiusButton,
                                     display: 'block', border: `1px solid ${P.border}`,
                                     opacity: item.status === 'uploading' ? 0.55 : 1 }} />
                          {item.status !== 'uploading' && (
                            <button type="button" data-testid="pl-staged-remove"
                              onClick={() => removeStagedItem(item.id)}
                              aria-label={`Remove ${item.file?.name ?? `photo ${i + 1}`}`}
                              style={{ position: 'absolute', top: 3, right: 3, background: 'rgba(0,0,0,0.55)',
                                       color: P.white, border: 'none', borderRadius: T.radiusPill,
                                       width: 20, height: 20, cursor: 'pointer', fontSize: T.type.xs, lineHeight: 1 }}>×</button>
                          )}
                          <div data-testid="pl-staged-status"
                               style={{ fontSize: T.type.xs, textAlign: 'center', marginTop: T.space.xs,
                                        color: item.status === 'error' ? P.photoErrorInk : P.mid }}>
                            {item.status === 'uploading' ? 'Uploading…'
                              : item.status === 'done' ? 'Added'
                              : item.status === 'error' ? 'Failed' : 'Ready'}
                          </div>
                          {item.status === 'error' && item.error && (
                            <div role="alert" data-testid="pl-staged-error"
                                 style={{ fontSize: T.type.xs, color: P.photoErrorInk, textAlign: 'center' }}>
                              {item.error}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                    <button type="button" data-testid="pl-stage-replace" onClick={openStagedPicker}
                      style={{ border: `1px solid ${P.border}`, borderRadius: T.radiusButton, padding: '5px 12px', background: P.white, color: P.mid, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
                      {stagedItems.length > 0 ? 'Add more' : 'Change photo'}
                    </button>
                    <button type="button" data-testid="pl-stage-clear" onClick={clearStaged}
                      style={{ border: `1px solid ${P.border}`, borderRadius: T.radiusButton, padding: '5px 12px', background: P.white, color: P.mid, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
                      {stagedItems.length > 1 ? 'Remove all' : 'Remove'}
                    </button>
                  </div>
                  {/* Only now ask where it goes; this ordering is the point of the form. */}
                  <p style={{ margin: '10px 0 0', fontSize: T.type.sm, color: P.mid }}>
                    {stagedItems.length > 1 ? `Where do these ${stagedItems.length} go?` : 'Where does this one go?'}
                  </p>
                </div>
              )}

              {/* Upload project chooser, hidden when projects are not user-facing. */}
              {!PROJECTS_HIDDEN && (
              <div>
                <label style={fieldLabelStyle}>Project  ·  or pick a zone below</label>
                <select
                  value={uploadForm.project_id}
                  onChange={e => setUploadForm(f => ({ ...f, project_id: e.target.value, plant_id: '' }))}
                  style={selectStyle}
                >
                  <option value="">— Select project —</option>
                  <ProjectOptions projects={projects} />
                </select>
              </div>
              )}

              {plantsForUpload.length > 0 && (
                <div>
                  <label style={fieldLabelStyle} htmlFor="pl-upload-plant">Plant  ·  optional</label>
                  {/* emptyMeaning='project-level': blank is a deliberate project-level attach, not an
                      unset field. */}
                  <PlantingSelect
                    id="pl-upload-plant"
                    plants={plantsForUpload}
                    value={uploadForm.plant_id}
                    onChange={id => setUploadForm(f => PROJECTS_HIDDEN
                      ? { ...f, plant_id: id, project_id: id ? (plantsForUpload.find(p => p.id === id)?.project_id ?? f.project_id) : f.project_id }
                      : { ...f, plant_id: id })}
                    emptyMeaning={PROJECTS_HIDDEN ? 'none' : 'project-level'}
                    onOpenChange={handleUploadPickerOpenChange}
                  />
                </div>
              )}

              <div>
                <label style={fieldLabelStyle}>{PROJECTS_HIDDEN ? 'Zone  ·  optional' : 'Zone  ·  or pick a project above'}</label>
                <select
                  value={uploadForm.location_id}
                  onChange={e => setUploadForm(f => ({ ...f, location_id: e.target.value }))}
                  style={selectStyle}
                >
                  <option value="">— None —</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
                </select>
              </div>

              <div>
                <label style={fieldLabelStyle}>Caption  ·  optional</label>
                <input
                  value={uploadForm.caption}
                  onChange={e => setUploadForm(f => ({ ...f, caption: e.target.value }))}
                  placeholder="What are you seeing?"
                  style={inputStyle}
                />
              </div>

              {/* The one-of-target rule (photos_must_have_parent) is a condition on sending, not on
                  picking, so it is stated only once a photo is staged. A batch has a second legal
                  destination (Untagged), so each branch says what will happen, not only what is
                  forbidden. */}
              {stagedItems.length > 0 && targetMissing && !canUploadUntagged && (
                <p style={{ margin: 0, fontSize: '0.8rem', color: P.light }}>
                  A standalone photo needs at least a project or zone.
                </p>
              )}
              {canUploadUntagged && targetMissing && (
                <p data-testid="pl-untagged-notice" style={{ margin: 0, fontSize: '0.8rem', color: P.mid }}>
                  No target chosen — these {stagedItems.length} will go to Untagged, where you can
                  tag them one at a time.
                </p>
              )}
              {batchSummary && (
                <p role="status" data-testid="pl-batch-summary" style={{ margin: 0, fontSize: '0.8rem', color: P.mid }}>
                  {batchSummary}
                </p>
              )}
              {/* Picking copies the bytes, so a twenty-photo pick has a visible duration. */}
              {stagedPreparing && (
                <p role="status" data-testid="pl-staged-preparing" style={{ margin: 0, fontSize: '0.8rem', color: P.mid }}>
                  Preparing {stagedPreparing.done} of {stagedPreparing.total}…
                </p>
              )}

              <button
                type="button"
                data-testid="pl-staged-upload"
                onClick={uploadStaged}
                disabled={!stagedItems.length || (targetMissing && !canUploadUntagged) || uploading}
                style={{
                  backgroundColor: (!stagedItems.length || (targetMissing && !canUploadUntagged)) ? P.light : P.green,
                  color: P.white, border: 'none', borderRadius: T.radiusButton, padding: '12px 16px',
                  fontSize: T.type.base, fontWeight: 700, minHeight: T.tapMinHeight,
                  cursor: (!stagedItems.length || (targetMissing && !canUploadUntagged) || uploading) ? 'not-allowed' : 'pointer',
                  opacity: uploading ? 0.7 : 1,
                }}
              >
                {uploading ? 'Uploading…'
                  : !stagedItems.length ? 'Pick a photo first'
                  : targetMissing && canUploadUntagged ? `Upload ${stagedItems.length} to Untagged`
                  : stagedItems.length > 1 ? `Upload ${stagedItems.length} photos`
                  : 'Upload photo'}
              </button>
            </div>
          </div>
        )}

        {/* Filters. The mode chips, the crop chips and the scope select compose: `mode` and crop
            are client-side layers applied after the ?project_id=/?location_id= response lands. */}
        <div style={{ display: 'flex', gap: 8, marginBottom: T.space.md, flexWrap: 'wrap', alignItems: 'center' }}>
          {PHOTO_FILTER_MODES.map(({ value: mode, label }) => {
            // Chip order lives in photoFilters.PHOTO_FILTER_MODES so the chips and the breadcrumb
            // agree on labels. A mode chip is active whenever its mode is on, whatever the scope.
            const active = filterMode === mode
            // The count rides only the Untagged chip, and only once measured and non-zero: a "0" is
            // noise, and a badge before the first list lands would assert an inbox not yet checked.
            const badge = mode === 'untagged' && untaggedCount > 0 ? untaggedCount : null
            const chipStyle = {
              padding: '6px 14px', borderRadius: T.radiusPill, fontSize: T.type.sm, fontWeight: 600,
              cursor: 'pointer',
              border: `1px solid ${active ? P.green : P.border}`,
              backgroundColor: active ? P.greenPale : P.white,
              color: active ? P.green : P.mid,
            }
            const filterChip = (
              <button
                key={mode}
                data-testid={`pl-filter-${mode}`}
                onClick={() => setFilterMode(mode)}
                style={badge == null ? chipStyle : {
                  ...chipStyle,
                  // Left half of a split pill: square off the seam so the two segments read as one
                  // control with two jobs.
                  borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRight: 'none',
                }}
              >
                {/* The number belongs to the accessible name of the segment that owns it, never a
                    decorative sibling. */}
                {badge == null ? label : `${label}`}
              </button>
            )
            if (badge == null) return filterChip
            // Tapping the count opens the tagging view; tapping the word filters. Two buttons, not
            // one with two hit zones: a <button> inside a <button> is invalid HTML, and a split by
            // coordinate is undiscoverable and untestable.
            return (
              <span key={mode} style={{ display: 'inline-flex' }}>
                {filterChip}
                <button
                  type="button"
                  data-testid="pl-filter-untagged-count"
                  aria-label={`Tag ${badge} untagged ${badge === 1 ? 'photo' : 'photos'} one at a time`}
                  onClick={openQuickTag}
                  // Under a scope filter the handler makes a round trip first, so the tap has a
                  // duration; disabling shows it is in progress rather than looking dead.
                  disabled={quickTagOpening}
                  aria-busy={quickTagOpening || undefined}
                  style={{
                    ...chipStyle,
                    borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
                    backgroundColor: P.greenPale, color: P.green,
                    borderColor: active ? P.green : P.border,
                    fontWeight: 700,
                    cursor: quickTagOpening ? 'progress' : 'pointer',
                    opacity: quickTagOpening ? 0.6 : 1,
                  }}
                >{badge}</button>
              </span>
            )
          })}
          {/* Project filter, hidden when projects are not user-facing (filterProject stays ''). */}
          {!PROJECTS_HIDDEN && (
          <select
            value={filterProject}
            onChange={e => { setFilterProject(e.target.value); selectLocationFilter('') }}
            style={{
              ...selectStyle,
              fontSize: T.type.sm, padding: '6px 30px 6px 10px',
              maxWidth: 200, flexShrink: 1,
              border: filterProject ? `1px solid ${P.green}` : `1px solid ${P.border}`,
              backgroundColor: filterProject ? P.greenPale : P.white,
            }}
          >
            <option value="">Filter by project…</option>
            <ProjectOptions projects={projects} />
          </select>
          )}
          {/* Zone filter: server-side subtree (a parent space shows its descendants' photos). */}
          <select
            value={filterLocation}
            // Zone and project clear each other because the server scopes by only one
            // (`?project_id=… : ?location_id=… : ''` in loadPhotos). Mode and crop chips are
            // client-side layers on top, which is why those compose and this pair cannot.
            onChange={e => { selectLocationFilter(e.target.value); setFilterProject('') }}
            style={{
              ...selectStyle,
              fontSize: T.type.sm, padding: '6px 30px 6px 10px',
              maxWidth: 200, flexShrink: 1,
              border: filterLocation ? `1px solid ${P.green}` : `1px solid ${P.border}`,
              backgroundColor: filterLocation ? P.greenPale : P.white,
            }}
          >
            <option value="">Filter by zone…</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
          </select>
        </div>

        {/* The crop facet: the shared FilterChipRow (multi-select OR, pinned two plus `More ▾`).
            A chip means "filed under a planting of that crop", from plant_id, not what the photo
            shows; photos attached only to an event, zone or project match no chip, and the
            breadcrumb below keeps that from being a silent disappearance. `onClear` is passed even
            though the breadcrumb also clears, because the row is where the fingers are. */}
        {cropFacetEligible && (
          <div style={{ marginBottom: T.space.md }}>
            <FilterChipRow
              options={cropOptions}
              selected={cropSel}
              onToggle={toggleCrop}
              pinned={cropPinned}
              onClear={clearCrops}
              trayMaxHeight={200}
              aria-label="Filter photos by crop"
              data-testid="pl-crop-filter"
            />
          </div>
        )}

        {/* Sort. Oldest-first is what a drain wants (the photo that has waited longest).
            SegmentedControl, not chips: the two orders are mutually exclusive. Rendered only over a
            populated grid; above an empty state it would offer to reorder nothing. */}
        {!loading && !error && visiblePhotos.length > 1 && (
          <div style={{ marginBottom: T.space.md, maxWidth: 260 }}>
            <SegmentedControl
              options={PHOTO_SORT_MODES}
              value={sortOrder}
              onChange={setSortOrder}
              ariaLabel="Sort photos by date"
              data-testid="pl-sort"
            />
          </div>
        )}

        {/* The active-filter breadcrumb answers "why am I seeing so few?" when several narrowings
            compose, some easy to miss (a collapsed crop tray, a zone select scrolled off). Uses the
            shared TagFilterBar for per-pill removal. The count says what is shown, not what is
            hidden: mode and zone narrow at fetch time, so the page cannot know what they hold back. */}
        {activePills.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: T.space.md }}>
            {/* "Clear all", not "Clear": FilterChipRow's own Clear wipes only the crop chips, and two
                buttons with the same word and different blast radii make the user guess. */}
            <TagFilterBar filters={activePills} onRemove={removeFilterPill} onClear={clearAllFilters} clearLabel="Clear all" />
            {!loading && !error && (
              <div role="status" aria-live="polite" data-testid="pl-filter-cue" style={{
                fontSize: '0.78rem', color: P.mid, backgroundColor: P.greenPale,
                border: `1px solid ${P.border}`, borderRadius: 6, padding: '4px 10px',
                alignSelf: 'flex-start',
              }}>
                {visiblePhotos.length === 1 ? '1 photo shown' : `${visiblePhotos.length} photos shown`}
              </div>
            )}
          </div>
        )}

        {/* Grid */}
        {loading ? (
          <p style={{ color: P.light, fontSize: T.type.base }}>Loading…</p>
        ) : error ? (
          <AsyncRegion
            error={photoLoadErrorMessage(error, 'the gallery')}
            errorTitle="Couldn’t load your photos"
            onRetry={loadPhotos}
          />
        ) : visiblePhotos.length === 0 ? (
          // Two emptinesses, told apart: "No photos yet" would read as data loss to someone with a
          // full library and filters on.
          <div style={{ textAlign: 'center', padding: '48px 16px', color: P.light }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📷</div>
            {activePills.length > 0 ? (
              <>
                <p data-testid="pl-empty-filtered" style={{ margin: 0, fontSize: T.type.base }}>
                  No photos match these filters.
                </p>
                <button type="button" onClick={clearAllFilters} style={{
                  marginTop: 12, padding: '10px 20px', fontSize: T.type.sm2, fontWeight: 700,
                  minHeight: T.tapMinHeight, borderRadius: T.radiusButton,
                  border: `1px solid ${P.green}`, background: P.white, color: P.green, cursor: 'pointer',
                }}>Clear filters</button>
              </>
            ) : (
              <>
                <p data-testid="pl-empty-first-run" style={{ margin: 0, fontSize: T.type.base }}>No photos yet.</p>
                <p style={{ margin: '6px 0 0', fontSize: T.type.sm }}>Upload your first one above.</p>
              </>
            )}
          </div>
        ) : (
          // A render-time fault in any PhotoCard degrades to a retry card instead of white-screening
          // the page. Mirrors the tag-modal net.
          <ErrorBoundary
            scope="photo-grid"
            fallback={(err, retry) => <PhotoGridErrorFallback retry={() => { retry(); loadPhotos() }} />}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {visiblePhotos.slice(0, shown).map(photo => (
                <PhotoCard
                  key={photo.id}
                  photo={photo}
                  selectMode={selectMode}
                  selected={selected.has(photo.id)}
                  onClick={() => (selectMode ? toggleSelect(photo.id) : openModal(photo))}
                />
              ))}
            </div>
            {shown < visiblePhotos.length && (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <button type="button" onClick={() => setShown(s => s + PAGE)}
                  style={{ background: P.white, color: P.green, border: `1px solid ${P.green}`, borderRadius: T.radiusButton,
                           padding: '11px 20px', fontSize: T.type.sm2, fontWeight: 700, cursor: 'pointer', minHeight: T.tapMinHeight }}>
                  Show more ({visiblePhotos.length - shown} left)
                </button>
              </div>
            )}
          </ErrorBoundary>
        )}
      </div>

      {/* Tag modal, wrapped in an ErrorBoundary so a render-time fault (bad photo shape, malformed
          linkage) degrades to a dismissable card instead of white-screening the page. */}
      {modal && (
        <ErrorBoundary
          scope="photo-tag-modal"
          fallback={(err, retry) => (
            <PhotoModalErrorFallback error={err} retry={retry} onClose={() => setModal(null)} />
          )}
        >
          {/* `dirty` is the same differs-from-the-row predicate the reload gate computes, threaded
              down: PhotoModal holds neither the seed nor the form state. One definition for the deploy
              gate and the discard confirm. */}
          <PhotoModal
            photo={modal}
            tagForm={tagForm}
            setTagForm={setTagForm}
            plantsForModal={plantsForModal}
            onSave={handleTag}
            onClose={() => setModal(null)}
            dirty={modalDirty}
            tagging={tagging}
            tagErr={tagErr}
            projects={projects}
            locations={locations}
            onShare={fbShareEnabled ? (() => { setModal(null); openShare([modal]) }) : undefined}
            onDelete={() => { setDeleteErr(null); setDeleteTarget(modal) }}
          />
        </ErrorBoundary>
      )}

      {/* The delete confirm is a sibling of the modal, after it in document order. Both paint at
          zIndex 200 and register LAYER.SHEET, so the arbiter's insertion-order tiebreak and the paint
          order agree: the confirm is topmost and one Escape closes only it. Nested inside PhotoModal it
          would sit in that modal's scrollport and get clipped. The modal stays mounted behind it so
          Cancel returns the user to the photo. */}
      <PhotoDeleteConfirm
        open={!!deleteTarget}
        photo={deleteTarget}
        coverFor={coverForPhoto(deleteTarget?.id, plantsForModal)}
        sharingEnabled={fbShareEnabled}
        busy={deleting}
        error={deleteErr}
        onCancel={() => { if (!deleting) { setDeleteTarget(null); setDeleteErr(null) } }}
        onConfirm={confirmDelete}
      />

      {/* Selection action bar (select mode only) */}
      {selectMode && selectionCount > 0 && (
        // Hidden, not unmounted, while the upload form's planting listbox is open, so the picker's
        // 150ms deferred blur-close cannot flicker an unmounting bar back under a finger.
        // `visibility: hidden` already drops it from the a11y tree and tab order, so no aria-hidden.
        <div data-testid="pl-select-bar" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 150, background: P.white, borderTop: `1px solid ${P.border}`, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, boxShadow: '0 -2px 10px rgba(0,0,0,0.08)', visibility: uploadPickerOpen ? 'hidden' : 'visible', pointerEvents: uploadPickerOpen ? 'none' : 'auto' }}>
          <span style={{ fontSize: T.type.base, fontWeight: 700, color: P.mid }}>{selectionCount} selected</span>
          <div style={{ display: 'flex', gap: T.space.sm, alignItems: 'center' }}>
            {selectionOverMax && <span style={{ fontSize: T.type.xs, color: P.terra }}>{`Max ${MAX_SHARE_PHOTOS}`}</span>}
            <button type="button" onClick={exitSelectMode} style={{ background: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, padding: '10px 16px', fontSize: '0.86rem', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
            <button type="button" onClick={() => openShare(selectedPhotos)} disabled={selectionOverMax}
              style={{ background: selectionOverMax ? P.light : P.green, color: P.white, border: 'none', borderRadius: T.radiusButton, padding: '10px 16px', fontSize: '0.86rem', fontWeight: 700, cursor: selectionOverMax ? 'default' : 'pointer' }}>
              Post to Facebook
            </button>
          </div>
        </div>
      )}

      <FacebookShareSheet
        open={shareOpen}
        photos={sharePhotos}
        onClose={() => setShareOpen(false)}
        onPosted={() => exitSelectMode()}
        onDirtyChange={setShareDirty}
      />

      {/* Rendered last on purpose. It registers LAYER.SHEET and paints Z.sheet (200), the pair
          layerMatchesPaint.test.js keeps honest; at equal layer the arbiter's tiebreak is insertion
          order and same-z fixed paint order is DOM order, so being last makes Back/Escape resolve to
          the deck. It is full-bleed: anything drawn over it would be a control for a photo it is not
          showing. */}
      {quickTagDeck && (
        <QuickTagCarousel
          photos={quickTagDeck.photos}
          plants={plantsForModal}
          seedTargets={quickTagDeck.seed}
          apiFetch={apiFetch}
          onAssigned={handleQuickTagAssigned}
          onClose={() => setQuickTagDeck(null)}
        />
      )}
    </div>
  )
}

// ---- Photo card ----
function PhotoCard({ photo, onClick, selectMode = false, selected = false }) {
  // No project caption strip when projects are not user-facing.
  const project = PROJECTS_HIDDEN ? null : photo.project_name

  return (
    <button
      onClick={onClick}
      aria-pressed={selectMode ? selected : undefined}
      // Test seam: <PhotoView> resolves a presigned URL, so under jsdom the grid has no addressable
      // <img> to count.
      data-testid="pl-photo-card"
      style={{
        background: 'none',
        border: selected ? `2px solid ${P.green}` : `1px solid ${P.border}`,
        borderRadius: T.radiusButton, overflow: 'hidden', cursor: 'pointer', padding: 0, textAlign: 'left',
      }}
    >
      <div style={{ position: 'relative', paddingBottom: '100%', backgroundColor: P.photoPlaceholder }}>
        {/* PhotoView, never a bare <img> (noBareViewUrlImg.static.test.js): it owns the one-shot
            thumb->full degrade and the presign self-heal. No loading="lazy": it never fires on this
            grid; `shown` bounds the card count instead. */}
        <PhotoView
          photo={photo}
          tier={TIER.THUMB}
          alt={photo.caption ?? 'Garden photo'}
          decoding="async"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {selectMode && (
          <span aria-hidden="true" style={{
            position: 'absolute', top: 6, left: 6, width: 22, height: 22, borderRadius: '50%',
            border: `2px solid ${P.white}`, backgroundColor: selected ? P.green : 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: P.white, fontSize: T.type.xs2, fontWeight: 700,
          }}>{selected ? '✓' : ''}</span>
        )}
        {!photo.event_id && (
          <span style={{
            position: 'absolute', top: 4, right: 4,
            backgroundColor: 'rgba(0,0,0,0.5)', color: P.onPhotoFg,
            fontSize: '0.6rem', fontWeight: 700, borderRadius: 4, padding: '2px 5px',
          }}>
            standalone
          </span>
        )}
      </div>
      {project && (
        <div style={{ padding: '5px 7px', backgroundColor: P.white }}>
          <div style={{ fontSize: '0.7rem', color: P.mid, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {project}
          </div>
        </div>
      )}
    </button>
  )
}

// ---- Photo modal ----
function PhotoModal({ photo, tagForm, setTagForm, plantsForModal, onSave, onClose, dirty = false, tagging, tagErr, projects, locations, onShare, onDelete }) {
  const hasEvent = !!photo.event_id

  // A real dialog: role, aria-modal, Escape, Android Back and focus restore through the arbiter.
  // `busy: tagging` keeps an in-flight save from being dismissed under itself. `dirty` is the page's
  // `modalDirty` (differs-from-the-row, never truthiness, since every field is pre-seeded), and
  // `confirmOnDirty` asks before Escape or Back discards a half-edited tag form.
  const { isTopmost, requestDismiss } = useDismissable({
    open: true, onDismiss: onClose, dirty, busy: !!tagging, layer: LAYER.SHEET, armsBack: true,
    confirmOnDirty: true,
    confirmTitle: 'Discard these changes?',
    confirmBody: 'Your edits to this photo have not been saved. They cannot be recovered.',
  })
  // Close-in-place: onClose clears the selected photo and never navigates.
  // The backdrop tap and the ✕ go through the arbiter too, like Sheet's labelled Close
  // (DismissRegistry.jsx): otherwise Escape and Back would ask while a tap discarded silently.
  // requestDismiss falls back to onClose whenever the provider declines ownership.
  return (
    <div
      role="dialog"
      aria-modal={isTopmost ? 'true' : undefined}
      aria-label="Photo details"
      onClick={e => { if (e.target === e.currentTarget) requestDismiss() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        boxSizing: 'border-box',
        backgroundColor: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'env(safe-area-inset-top) 16px env(safe-area-inset-bottom) 16px',
      }}
    >
      {/* One scrollport: the card is the scroll container (maxHeight 90dvh + overflowY auto, like
          Sheet) and the photo stays pinned with `position: sticky`. With the keyboard up 90dvh
          shrinks to ~460px, so the tag form needs a scrollable path or Save is unreachable. A second,
          inner scroll box would become the PlantingSelect listbox's clipping ancestor and cut it off
          (it sizes itself against the visual viewport, not this box); with one scrollport a flipped
          listbox paints over the sticky photo (z30 beats the header's z1). The header has an explicit
          white background because content scrolls under it. */}
      <div data-testid="pl-modal-card" style={{
        backgroundColor: P.white, borderRadius: T.radiusBadge,
        maxWidth: 480, width: '100%', maxHeight: '90dvh', overflowY: 'auto',
      }}>

        <div style={{ position: 'sticky', top: 0, zIndex: 1, backgroundColor: P.white }}>
          <PhotoView
            photo={photo}
            tier={TIER.FULL}
            alt={photo.caption ?? 'Photo'}
            style={{ width: '100%', borderRadius: '12px 12px 0 0', display: 'block', maxHeight: 300, objectFit: 'cover' }}
          />
          <button
            onClick={requestDismiss}
            style={{
              position: 'absolute', top: 10, right: 10,
              background: 'rgba(0,0,0,0.55)', color: P.onPhotoFg,
              border: 'none', borderRadius: '50%', width: 30, height: 30,
              cursor: 'pointer', fontSize: T.type.base,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >✕</button>
        </div>

        {/* No overflow here: a scroll container at this level is what clipped the picker's listbox. */}
        <div data-testid="pl-modal-body" style={{ padding: '16px 20px 20px' }}>
          {/* Static caption only where there is no editable field (event-attached photos have no tag
              form). */}
          {hasEvent && photo.caption && (
            <p style={{ margin: '0 0 12px', fontSize: T.type.sm2, color: P.mid }}>{photo.caption}</p>
          )}

          {onShare && (
            <button type="button" onClick={onShare}
              style={{ width: '100%', marginBottom: 14, background: P.white, color: P.green, border: `1px solid ${P.green}`, borderRadius: T.radiusButton, padding: '11px', fontSize: T.type.base, fontWeight: 700, cursor: 'pointer' }}>
              Share photo
            </button>
          )}

          {hasEvent ? (
            <div style={{ backgroundColor: P.cream, borderRadius: T.radiusButton, padding: '10px 12px' }}>
              <p style={{ margin: 0, fontSize: '0.8rem', color: P.light }}>
                Attached to an event — tags are managed via the event log.
              </p>
            </div>
          ) : (
            <form onSubmit={onSave} style={{ display: 'flex', flexDirection: 'column', gap: T.space.sm }}>
              <p style={{ margin: '0 0 4px', fontSize: '0.77rem', fontWeight: 700, color: P.mid, letterSpacing: '0.4px', textTransform: 'uppercase' }}>
                Tags
              </p>
              {tagErr && <ErrBanner msg={tagErr} />}

              {/* Reassign project chooser, hidden when projects are not user-facing. */}
              {!PROJECTS_HIDDEN && (
              <div>
                <label style={fieldLabelStyle}>Project</label>
                <select
                  value={tagForm.project_id}
                  onChange={e => setTagForm(f => ({ ...f, project_id: e.target.value, plant_id: '' }))}
                  style={selectStyle}
                >
                  <option value="">— None —</option>
                  <ProjectOptions projects={projects} />
                </select>
              </div>
              )}

              {plantsForModal.length > 0 && (
                <div>
                  <label style={fieldLabelStyle} htmlFor="pl-modal-plant">Plant  ·  optional</label>
                  {/* Unlike the target-gated upload form, clearing here must stay possible:
                      un-tagging a photo is legitimate. */}
                  <PlantingSelect
                    id="pl-modal-plant"
                    plants={plantsForModal}
                    value={tagForm.plant_id}
                    onChange={id => setTagForm(f => PROJECTS_HIDDEN
                      ? { ...f, plant_id: id, project_id: id ? (plantsForModal.find(p => p.id === id)?.project_id ?? f.project_id) : f.project_id }
                      : { ...f, plant_id: id })}
                    emptyMeaning="project-level"
                  />
                </div>
              )}

              <div>
                <label style={fieldLabelStyle}>Location</label>
                <select
                  value={tagForm.location_id}
                  onChange={e => setTagForm(f => ({ ...f, location_id: e.target.value }))}
                  style={selectStyle}
                >
                  <option value="">— None —</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
                </select>
              </div>

              <div>
                <label style={fieldLabelStyle} htmlFor="pl-modal-caption">Caption  ·  optional</label>
                <input
                  id="pl-modal-caption"
                  value={tagForm.caption}
                  onChange={e => setTagForm(f => ({ ...f, caption: e.target.value }))}
                  placeholder="What are you seeing?"
                  style={inputStyle}
                />
              </div>

              <button type="submit" disabled={tagging} style={{ ...primaryBtn(tagging), alignSelf: 'flex-start' }}>
                {tagging ? 'Saving…' : 'Save tags'}
              </button>
            </form>
          )}

          {/* The standalone delete sits outside the hasEvent branch on purpose: otherwise removing an
              event-attached photo would mean deleting the event it hangs off. Placement is a safety
              decision: below a divider at the end of the body, never adjacent to "Save tags", and a
              text-weight control so the destructive action is never the most prominent thing. It only
              arms the confirm; nothing is written from here. */}
          {onDelete && (
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${P.border}` }}>
              <button
                type="button"
                data-testid="pl-photo-delete"
                onClick={onDelete}
                disabled={tagging}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: '100%', minHeight: T.tapMinHeight,
                  background: 'transparent', color: P.terra,
                  border: `1px solid ${P.border}`, borderRadius: T.radiusButton,
                  fontSize: T.type.sm2, fontWeight: 700,
                  cursor: tagging ? 'not-allowed' : 'pointer',
                  opacity: tagging ? 0.6 : 1,
                }}
              >
                Delete photo
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ErrBanner({ msg }) {
  return (
    <div data-testid="pl-err-banner" style={{
      backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`,
      borderRadius: T.radiusButton, padding: '10px 14px', marginBottom: 8,
      fontSize: T.type.sm, color: P.bannerInk,
    }}>
      {msg}
    </div>
  )
}

// ErrorBoundary fallback for the photo grid: a contained retry card matching the load-error styling.
function PhotoGridErrorFallback({ retry }) {
  return (
    <AsyncRegion
      error="Something went wrong rendering the gallery. Your photos are safe — please retry."
      errorTitle="Couldn’t display your photos"
      onRetry={retry}
    />
  )
}

// ErrorBoundary fallback for the tag modal. Modal-shaped so a render fault reads as "the modal broke"
// rather than dropping the user back to the grid. Friendly copy only, never the raw error string.
function PhotoModalErrorFallback({ retry, onClose }) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200, boxSizing: 'border-box',
        backgroundColor: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'env(safe-area-inset-top) 16px env(safe-area-inset-bottom) 16px',
      }}
    >
      <div style={{
        backgroundColor: P.white, borderRadius: T.radiusBadge, maxWidth: 420, width: '100%',
        padding: '24px 22px', textAlign: 'center',
      }}>
        <div style={{ fontSize: '2rem', marginBottom: T.space.sm }}>⚠️</div>
        <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: T.type.md }}>
          This photo couldn’t open
        </p>
        <p style={{ margin: '0 0 18px', color: P.mid, fontSize: '0.85rem' }}>
          Something went wrong loading the tag editor. Your photo is safe — try again, or close and reopen it.
        </p>
        <div style={{ display: 'flex', gap: T.space.sm, justifyContent: 'center' }}>
          <button type="button" onClick={retry} style={primaryBtn(false)}>Try again</button>
          <button type="button" onClick={onClose} style={{
            backgroundColor: 'transparent', color: P.mid, border: `1px solid ${P.border}`,
            borderRadius: T.radiusButton, padding: '11px 24px', fontSize: T.type.base, fontWeight: 600, cursor: 'pointer',
          }}>Close</button>
        </div>
      </div>
    </div>
  )
}

const fieldLabelStyle = {
  display: 'block', fontSize: '0.77rem', fontWeight: 700,
  color: P.mid, marginBottom: T.space.xs, letterSpacing: '0.4px', textTransform: 'uppercase',
}

const inputStyle = {
  width: '100%', padding: '10px 12px',
  border: `1px solid ${P.border}`,
  borderRadius: T.radiusField, fontSize: T.type.base,
  backgroundColor: P.white, boxSizing: 'border-box', fontFamily: 'inherit',
}

const selectStyle = {
  ...inputStyle,
  appearance: 'none',
  // Shared builder, not a hardcoded hex, so the chevron follows P.light like every other select.
  backgroundImage: chevronDataUri(P.light),
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight: 36, cursor: 'pointer',
}

const primaryBtn = (disabled) => ({
  backgroundColor: disabled ? P.light : P.green,
  color: P.white, border: 'none', borderRadius: T.radiusButton,
  padding: '11px 24px', fontSize: T.type.base, fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer',
})
