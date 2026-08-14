import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import PhotoView from '../components/photo/PhotoView.jsx'
import { toPhoto, TIER } from '../lib/photoModel.js'
import { invalidatePrefix as invalidatePhotoLists } from '../lib/dataCache.js'
import ErrorBoundary from '../components/ErrorBoundary.jsx'
import ProjectOptions from '../components/ProjectOptions.jsx'
import PlantingSelect from '../components/forms/PlantingSelect.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import { photoLoadErrorMessage } from '../components/PhotosWall.jsx'
import FacebookShareSheet from '../components/FacebookShareSheet.jsx'
import PhotoDeleteConfirm from '../components/photo/PhotoDeleteConfirm.jsx'
import { useOptionalToast } from '../context/ToastContext.jsx'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'
import { useDismissable } from '../context/DismissRegistry.jsx'
import { LAYER } from '../lib/dismissLayers.js'
import useScrollRestore from '../hooks/useScrollRestore.js'

// ---- Photo Library ----
// Browse all photos, upload standalone photos (event_id = null),
// tag / un-tag photos against projects, locations, and plants.
// Photos Lambda GET returns view_url (signed S3 URL) and project_name inline.
// Filter modes 'standalone' and 'untagged' are applied client-side.
// NOTE: photos Lambda POST requires only storage_path; the DB CHECK photos_must_have_parent
// admits any one of project/location/plant/event. The upload form enforces one-of
// project/space/planting (V4-PHOTOLOCFIND-001) — a bare parentless upload would violate the CHECK.
//
// V2-PHOTO-F1 Session 2 (2026-05-13): the upload used shared <PhotoUpload>, which owns the 3-step
// presign/PUT/POST dance and fires it on pick.
// BUG-PHOTOFIRST-001 (2026-08-02) SUPERSEDES that here: this page now stages the file locally and
// drives useUploadPhoto directly on an explicit "Upload photo" press, because <PhotoUpload>'s
// upload-on-pick contract is precisely what forced the attach target to be chosen first. The other
// eight <PhotoUpload> call sites are unchanged and still use it. errorMode="surface" is preserved,
// so the loud-error UX is the same.

// V4-FBSHARE-001 — Graph API caps a multi-photo Page post; the bar refuses past this rather than
// letting the share sheet fail mid-post. Named because it is asserted in three places (the warning,
// the disabled state, the cursor) and a literal that appears three times drifts in two of them.
const MAX_SHARE_PHOTOS = 10

// V4-PHOTOREASSIGN-001 / W-PHOTODEL — which plantings have DESIGNATED this photo as their cover.
//
// `featured_is_explicit` is the whole predicate and it is not a nicety. Both the plants list and the
// projects/spaces reads return an EFFECTIVE hero: COALESCE(explicit pointer, newest photo in the
// gallery). Matching on featured_photo_id alone would therefore name a planting whose "cover" is
// merely the most recent photo — deleting that one promotes the next photo and the user sees no
// change at all, so the disclosure would be crying wolf on the common case and be ignored on the
// real one. featured_is_explicit is true only when the stored pointer RESOLVED (alive + still a
// member), which is exactly "this planting picked this photo on purpose" — the same thing
// eventPhotos.js's cover_for enumerates for the event-delete confirm.
//
// PARTIAL BY CONSTRUCTION, and the confirm's copy is written to be honest about that: this sees
// PLANTINGS only, from the list this page already holds. Containers, zones, inventory items and
// spaces each carry a featured_photo_id that no PhotoLibrary fetch returns, and GET /api/photos
// carries no cover data of any kind. Widening it is a Lambda change. So a NAMED line here is always
// true; the absence of one is never an all-clear (PhotoDeleteConfirm's generic arm covers that).
// With PROJECTS_HIDDEN on — its live value — `plants` is every live planting in the household, so
// the planting axis itself is complete; with the flag off it is project-scoped, which narrows the
// derivation but cannot make it lie.
export function coverForPhoto(photoId, plants) {
  if (!photoId) return []
  return (plants ?? [])
    .filter(p => p?.featured_is_explicit && p?.featured_photo_id === photoId)
    .map(p => ({ id: p.id, name: p.name }))
}

export default function PhotoLibrary() {
  const { fetch: apiFetch } = useApiFetch()

  const [photos,        setPhotos]        = useState([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)  // V3-PHOTODBG-001: visible load-failure state
  const [projects,      setProjects]      = useState([])
  const [locations,     setLocations]     = useState([])

  const [filterProject,  setFilterProject]  = useState('')
  const [filterLocation, setFilterLocation] = useState('')  // V4-PHOTOLOCFIND-001: space filter (server-side subtree)
  const [filterMode,     setFilterMode]     = useState('all')

  const [showUpload,     setShowUpload]     = useState(false)
  const [uploadForm,     setUploadForm]     = useState({ project_id: '', location_id: '', plant_id: '', caption: '', is_public: true })
  const [plantsForUpload, setPlantsForUpload] = useState([])
  const [uploadErr,      setUploadErr]      = useState(null)
  // BUG-PHOTOFIRST-001 (BD-001, Dave 2026-07-31) — PHOTO FIRST, attribute after.
  // This form used to disable the picker until a project/zone/planting was already chosen, because
  // <PhotoUpload> uploads immediately on pick and therefore needs an attach target up front. Dave
  // named that constraint himself and overrode it: he usually does not know what a photo IS until he
  // looks at it, and Log Event already works the other way round (pick photo -> then choose planting).
  // The resolution is to STAGE the file locally and upload on an explicit action, which is exactly
  // what EventNew does. Staging lives here rather than in <PhotoUpload> on purpose: that component
  // has nine call sites whose contract is "uploads on pick", and widening it to a staging mode would
  // put every one of them on a new code path to fix one page's ordering.
  const [stagedFile,    setStagedFile]    = useState(null)
  const [stagedPreview, setStagedPreview] = useState(null)
  const [uploading,     setUploading]     = useState(false)
  const stagedInputRef = useRef(null)
  const stagedUploader = useUploadPhoto({ errorMode: 'surface' })
  // A staged blob URL outlives the component unless revoked. Closing the form or leaving the page
  // with a photo staged and unsent is the ordinary case now that picking comes first.
  useEffect(() => () => { setStagedPreview(prev => { if (prev) URL.revokeObjectURL(prev); return null }) }, [])

  const [modal,          setModal]          = useState(null)
  const [tagForm,        setTagForm]        = useState({ project_id: '', location_id: '', plant_id: '', caption: '' })
  const [plantsForModal, setPlantsForModal] = useState([])
  const [tagging,        setTagging]        = useState(false)
  const [tagErr,         setTagErr]         = useState(null)

  // V4-PHOTOREASSIGN-001 / W-PHOTODEL — the standalone photo delete. Held as the PHOTO, not a
  // boolean: the confirm has to name and show the thing it is about to delete, and the tag modal
  // stays open behind it so a Cancel returns the user exactly where they were.
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting,     setDeleting]     = useState(false)
  const [deleteErr,    setDeleteErr]    = useState(null)
  const toast = useOptionalToast()

  // V4-FBSHARE-001 — multi-select + Facebook Page share
  const [selectMode,  setSelectMode]  = useState(false)
  const [selected,    setSelected]    = useState(() => new Set())
  const [shareOpen,   setShareOpen]   = useState(false)
  const [sharePhotos, setSharePhotos] = useState([])

  // BUG-PICKERCLIP-001 (V4-PICKERUX-001 P0 idiom, EventNew's sticky Save) — select-mode and the
  // upload form are NOT mutually exclusive: enterSelectMode() closes the form, but the "+ Upload"
  // button never leaves select mode, so the z150 fixed action bar below can be on screen while the
  // form's PlantingSelect listbox (z30, in normal flow) is open. The bar wins on z AND on hit
  // testing, so a tap aimed at a planting row lands on "Post to Facebook" or "Cancel" — a wrong
  // action, not a cosmetic overlap. Sharing is never the next act while a planting is being chosen,
  // so suppressing the bar costs nothing and makes the mis-tap structurally impossible.
  const [uploadPickerOpen, setUploadPickerOpen] = useState(false)
  const handleUploadPickerOpenChange = useCallback(open => setUploadPickerOpen(open), [])

  // BUG-PHOTOTHUMB-001 — EXPLICIT windowing, because neither browser mechanism works here.
  // Measured on the live page (2026-07-27): with loading="lazy", 0 of 120 images were ever
  // REQUESTED — not slow, never fetched — which is why the tab sat blank and then filled all at
  // once when something finally forced a layout recalc. Flipping the same elements to eager loaded
  // them instantly, so the URLs and thumbs were always fine; native lazy simply never fires on this
  // absolutely-positioned grid. Flipping ALL 120 to eager instead FROZE the renderer. So the count
  // has to be bounded by us: render a window, grow it on scroll. Also gives the page the "more as
  // you scroll" behavior it lacked when the server limit was cut to 30.
  const PAGE = 24
  // V4-SCROLLRESTORE-001: a restored offset is worthless against a document that came back one page
  // tall — the browser clamps the scroll and the position is lost anyway. The window size is
  // therefore restored WITH the offset, at first render, so the tiles that hold that height exist in
  // the same commit that the photos land in. (The restore loop's clamped scrollTo would also grow
  // the window via the listener below, one PAGE per frame; that converges for a shallow window and
  // races the 20-frame budget for a deep one. Restoring it outright is exact.)
  // Capped hard: a corrupt sessionStorage blob must not be able to mount 1,000 live <img> and
  // re-freeze the renderer (BUG-PHOTOTHUMB-001). The honest value can only be a window the user
  // already grew by scrolling, so the cap never binds in practice.
  const MAX_RESTORED_WINDOW = PAGE * 40
  const { restoredState, saveState } = useScrollRestore({ id: 'photos', ready: !loading })
  const [shown, setShown] = useState(() => {
    const w = Number(restoredState)
    return Number.isFinite(w) ? Math.min(Math.max(w, PAGE), MAX_RESTORED_WINDOW) : PAGE
  })
  useEffect(() => { saveState(shown) }, [shown, saveState])
  // BUG-PHOTOSELSTALE-001: a filter change REPLACES the photos array, so ids picked under the old
  // filter may no longer resolve to a row. The selection is reset here, alongside the window, for
  // the same reason the window is: both describe a view of a list that no longer exists.
  // CLEAR, not intersect — justification at `selectedPhotos` below.
  // Returning `prev` when already empty keeps the Set identity stable so mount and every
  // already-cleared filter change bail out of a re-render instead of churning a fresh Set.
  // V4-SCROLLRESTORE-001: the MOUNT run is skipped. It was always a no-op — `shown` initialised to
  // PAGE and `selected` to an empty Set, and the setSelected branch already bails on an empty Set —
  // but now that the window can be restored above PAGE at first render, an unskipped mount run would
  // collapse it right back and destroy the height the restore needs. Every subsequent (real) filter
  // change behaves exactly as before.
  // Keyed on the filter TUPLE rather than a mount flag: StrictMode runs every effect twice on mount,
  // and a bare "skip the first run" flag would let the second run collapse the restored window in dev.
  const lastFiltersRef = useRef(null)
  useEffect(() => {
    const sig = `${filterProject}|${filterLocation}|${filterMode}`
    if (lastFiltersRef.current === sig) return
    const first = lastFiltersRef.current === null
    lastFiltersRef.current = sig
    if (first) return
    setShown(PAGE)
    setSelected(prev => (prev.size ? new Set() : prev))
  }, [filterProject, filterLocation, filterMode])
  useEffect(() => {
    // Scroll listener rather than IntersectionObserver: IO is the same viewport-intersection
    // machinery native lazy depends on, and that is precisely what is not firing on this layout.
    function onScroll() {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 800) {
        setShown(s => (s < photos.length ? s + PAGE : s))
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll() // a short first page must still be able to grow without a scroll
    return () => window.removeEventListener('scroll', onScroll)
  }, [photos.length])

  // ---- Initial data load ----
  useEffect(() => {
    Promise.all([
      apiFetch('/api/projects'),
      apiFetch('/api/locations/with-path'),
    ]).then(([proj, locs]) => {
      setProjects(proj ?? [])
      setLocations((locs ?? []).filter(l => l.is_active))
    }).catch(() => {})
  }, [apiFetch])

  // ---- Load plants when upload project changes (project-scoped mode — the default). ----
  useEffect(() => {
    if (PROJECTS_HIDDEN) return // V4-PROJHIDE-001: unscoped fetch below
    if (!uploadForm.project_id) { setPlantsForUpload([]); return }
    apiFetch('/api/plants?project_id=' + uploadForm.project_id)
      .then(data => setPlantsForUpload(data ?? []))
      .catch(() => setPlantsForUpload([]))
  }, [apiFetch, uploadForm.project_id])

  // ---- Load plants when modal project changes (project-scoped mode — the default). ----
  useEffect(() => {
    if (PROJECTS_HIDDEN) return // V4-PROJHIDE-001: unscoped fetch below
    if (!tagForm.project_id) { setPlantsForModal([]); return }
    apiFetch('/api/plants?project_id=' + tagForm.project_id)
      .then(data => setPlantsForModal(data ?? []))
      .catch(() => setPlantsForModal([]))
  }, [apiFetch, tagForm.project_id])

  // V4-PROJHIDE-001: with the project chooser hidden, both photo pickers (upload + tag modal) list
  // EVERY live planting from the UNSCOPED source — there is no project step to scope them. project_id
  // is then DERIVED from the chosen plant at onChange (see the pickers below). Fetched once; unarchived.
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
      if (filterMode === 'standalone') data = data.filter(p => !p.event_id)
      // V4-PHOTOLOCFIND-001: a photo attached to ANY parent (event/project/zone/planting) is a
      // finished photo — untagged means attached to nothing (V002 E2: valid untagged photos must
      // not read as unfinished work; the old predicate flagged every deliberate location photo).
      // V4-SPACEPHOTO-001: the space arm is UNCONDITIONAL, deliberately NOT behind
      // SPACE_PHOTOS_ENABLED. space_id becomes non-null the moment the migration + Lambda land,
      // which is independent of this client flag — and this is a PWA, so a stale cached bundle
      // would keep flagging every deliberate space photo as unfinished work.
      //
      // ⚠ THE ORIGINAL INERTNESS CLAIM HERE WAS RIGHT ABOUT THE OUTCOME AND WRONG ABOUT THE
      // MECHANISM, which made it dangerous. It said "provably inert: no photo row carries space_id
      // today". The conjunct was inert for a different reason: the server did not RETURN the field.
      // Only the ?space_id list branch selected p.space_id, so on every row this page ever saw it was
      // `undefined` and `!p.space_id` was unconditionally true — the arm would have stayed inert
      // FOREVER, including after rows started carrying a space_id, silently flagging every space
      // photo as unfinished work (the exact V002-E2 defect the paragraph above exists to prevent).
      // Fixed server-side 2026-08-02: the list decorates rows with space_id whenever the SERVER gate
      // is open. This arm is now load-bearing rather than decorative — do not "simplify" it away, and
      // do not re-derive its inertness from the row data without checking the wire.
      //
      // V4-PHOTOMODEL-001: the hand-written predicate here named FIVE parents and omitted
      // inventory_item_id, so the 6 live inventory-attached photos (measured in prod 2026-08-07)
      // were reported as unfinished work on every visit — the same six BUG-PHOTOPARENT-001 recorded
      // as "no parent link at all". They are fully attached; the four/five-way predicate simply
      // could not see the parent they have. `isAttached` counts all SIX FKs the live
      // photos_must_have_parent CHECK counts, so a new parent kind cannot silently reopen this.
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
  // V2-PHOTO-F1 Session 2: 3-step engine moved into <PhotoUpload> + useUploadPhoto.
  // We retain only the surface-level state: error gating before the picker fires
  // (project_id required) and post-success cleanup (form reset + list reload).
  function clearStaged() {
    setStagedPreview(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    setStagedFile(null)
  }

  function handleUploadComplete() {
    setShowUpload(false)
    setUploadForm({ project_id: '', location_id: '', plant_id: '', caption: '', is_public: true })
    setUploadErr(null)
    clearStaged()
    loadPhotos()
  }

  // BUG-PHOTOFIRST-001: open the picker inside the tap. Same reason CaptureFlow and EventNew do it
  // this way — a picker opened from a later effect has lost the trusted gesture and is suppressed.
  function openStagedPicker(useCamera) {
    const el = stagedInputRef.current
    if (!el) return
    if (useCamera) el.setAttribute('capture', 'environment')
    else el.removeAttribute('capture')
    el.click()
  }

  function onStagedPick(e) {
    const f = e.target.files?.[0]
    e.target.value = ''   // re-picking the same file must refire onChange
    if (!f) return
    setStagedPreview(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f) })
    setStagedFile(f)
    setUploadErr(null)
  }

  async function uploadStaged() {
    if (!stagedFile || targetMissing || uploading) return
    setUploading(true)
    setUploadErr(null)
    const res = await stagedUploader.upload(stagedFile, {
      keyPrefix: 'standalone',
      linkage: photoLinkage,
      caption: photoCaption,
      is_public: uploadForm.is_public,
    })
    setUploading(false)
    if (res?.error) handleUploadError(res.error)
    else handleUploadComplete()
  }

  function handleUploadError(msg) {
    setUploadErr(msg || 'Upload failed.')
  }

  // Build the linkage object the photo component forwards into POST /api/photos.
  // Empty strings become null so the Lambda treats them as "unset" rather than ""
  // (which would fail FK validation for non-uuid columns).
  const photoLinkage = {
    project_id:  uploadForm.project_id || null,
    location_id: uploadForm.location_id || null,
    plant_id:    uploadForm.plant_id    || null,
  }
  const photoCaption = uploadForm.caption.trim() || null
  // V4-PHOTOLOCFIND-001: one-of target gate, matching the photos_must_have_parent CHECK and the
  // handleTag predicate below. Project is no longer singularly required — a space alone is a valid
  // home (the meta-photo case). plant_id is in the predicate for completeness though this form only
  // offers plants after a project is picked.
  const targetMissing = !uploadForm.project_id && !uploadForm.location_id && !uploadForm.plant_id

  // ---- Modal / tag handlers ----
  function openModal(photo) {
    setModal(photo)
    setTagForm({
      project_id:  photo.project_id  ?? '',
      location_id: photo.location_id ?? '',
      plant_id:    photo.plant_id    ?? '',
      caption:     photo.caption     ?? '',   // V4-PHOTOCAPTION-001: editable post-upload
    })
    setTagErr(null)
  }

  async function handleTag(e) {
    e.preventDefault()
    const newProject  = tagForm.project_id  || null
    const newLocation = tagForm.location_id || null
    const newPlant    = tagForm.plant_id    || null
    // V4-PHOTOCAPTION-001: caption now comes from the form (was modal.caption round-tripped
    // unchanged — the PUT always accepted it; only the input was missing). Trimmed-empty → null.
    const newCaption  = tagForm.caption.trim() || null
    // V4-SPACECLIENTGAP-001: the one-of gate must name EVERY parent the 7-clause
    // photos_must_have_parent CHECK counts, not the three it happened to be written against.
    //   - `newPlant` was computed on the line above and then never consulted — a plant-only photo
    //     (plant_id set, no project, no location, no event) failed this guard and could not be
    //     caption-edited at all. That is a LIVE PROD BUG today, independent of the space work.
    //   - `modal.space_id` is the space tier. It reads from the MODAL, not the form, because this
    //     form has no space control by design: the general PUT below does not send space_id and the
    //     Lambda's UPDATE does not SET it, so the attachment survives a re-tag untouched. The
    //     attach/detach path is the dedicated PUT /api/photos/:id/space (see the batch picker on
    //     /space). Reading the persisted value is therefore correct — it is what the row still has
    //     after this request, which is exactly what the CHECK will see.
    // `modal.event_id` keeps its existing meaning: an event-attached photo is always parented.
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

      // V4-IMGCACHE-001 D-1: a re-link moves the photo between location/project/plant buckets, so every
      // cached photo list (?location_id=, ?attachedTo=, the wall) may be stale. PhotoLibrary itself is
      // NOT cached (its grid is a bare <img>, per BUG-PHOTOBLANK-001), but the routed surfaces are.
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

  // ---- V4-PHOTOREASSIGN-001 / W-PHOTODEL: standalone photo delete ----
  //
  // THE ROUTE IS ALREADY RIGHT — this is a call site, not a new capability. DELETE /api/photos/:id
  // (lambda/photos/photoDelete.js) soft-deletes: `deleted_at = now()`, every display pointer nulled
  // in the SAME transaction, no row removed, no S3 object touched, and a restore that puts the photo
  // back and re-promotes it into any hero slot still standing empty. Nothing here may bypass or
  // duplicate that; the client's whole job is to ask, disclose, and re-sync.
  //
  // Path spelled inline exactly as handleTag's PUT spells it — one route, one literal shape, both
  // proven by the same live matcher. (deletedPhotos.js holds the two paths that had NO existing
  // spelling in a component; this one has had one since the tag modal shipped.)
  async function confirmDelete() {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    setDeleteErr(null)
    try {
      await apiFetch('/api/photos/' + deleteTarget.id, { method: 'DELETE' })
      // Every cached photo list still contains this row. dataCache's only consumers are the photo
      // lists (see its header), so this ONE prefix covers the routed surfaces; PhotoLibrary's own
      // grid is uncached and is corrected by the local drop below.
      invalidatePhotoLists('/api/photos')
      // Drop locally rather than refetching: the server answer IS the confirmation, and a refetch
      // would re-presign the whole page to learn one thing already known. `selected` needs no
      // parallel edit — selectedPhotos derives from `photos`, which is the BUG-PHOTOSELSTALE-001
      // rule (one source of truth for "the selection", and it is not the id Set).
      setPhotos(ps => ps.filter(p => p.id !== deleteTarget.id))
      setDeleteTarget(null)
      setModal(null)
      // Operational confirmation of a thing the user explicitly started — the Toast layer's
      // documented carve-out, not a reward channel. It names Recently deleted because the recovery
      // path is the reason this delete is allowed to be low-friction, and a user who has just
      // deleted the wrong photo needs the destination, not congratulations. No undo action: a 5s
      // window is convenience, and this project already learned once (V3-ARCHIVE-001) that shipping
      // it AS the recovery model is how things become unrecoverable.
      toast.show({ message: 'Photo deleted — in Recently deleted' })
    } catch (err) {
      // Keep the sheet OPEN and put the message in it. Closing over a failed write would leave the
      // photo on screen with no explanation, which reads as "the delete silently did nothing".
      setDeleteErr(err?.message || 'Could not delete that photo.')
    }
    setDeleting(false)
  }

  // ---- V4-FBSHARE-001 select-mode + share handlers ----
  function enterSelectMode() { setSelectMode(true); setShowUpload(false) }
  function exitSelectMode() { setSelectMode(false); setSelected(new Set()) }
  function toggleSelect(id) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function openShare(photoList) { setSharePhotos(photoList); setShareOpen(true) }
  // BUG-PHOTOSELSTALE-001 — ONE source of truth for "the selection", and it is this, not `selected`.
  // `selected` is a Set of ids and cannot know whether an id still resolves to a row after the list
  // is refetched; `selectedPhotos` is literally what openShare() posts. So every affordance below —
  // whether the bar exists at all, its count, and the max guard — derives from THIS. That divergence
  // WAS the defect: the bar read `selected.size` ("12 selected", "Max 10") while the button posted
  // `selectedPhotos` (5). Both symptoms Dave would see are the same bug from opposite ends — a
  // silent under-post, and a block on a post that was never over the cap.
  //
  // Deriving here is belt AND braces with the clear above, not a duplicate of it: the clear only
  // covers filter changes, but `photos` is also replaced by loadPhotos() after an upload completes,
  // and that path has no business clearing a selection. Derivation covers every array replacement,
  // including ones not yet written.
  //
  // CLEAR-not-intersect (the effect above). Intersecting looks like it preserves a selection across
  // a filter round-trip, but it cannot: it is lossy in one direction only, so filtering away and
  // back returns fewer photos than it left with. Worse, `photos` is a SERVER PAGE, so an id can be
  // absent from the new page while still matching the new filter — intersect would drop it silently
  // and arbitrarily, which is a harder bug to explain than "the selection reset". And the fail-safe
  // direction matters more than usual for a control that posts PUBLICLY: clearing forces the user to
  // re-pick against the list in front of them, instead of carrying an unreviewed selection across a
  // context change. (Intersecting inside that effect would also be a no-op — `photos` is still the
  // OLD array at that point; the refetch has not resolved. It would have to move into loadPhotos.)
  const selectedPhotos = photos.filter(p => selected.has(p.id))
  const selectionCount = selectedPhotos.length
  const selectionOverMax = selectionCount > MAX_SHARE_PHOTOS
  // Dormant-until-configured: the FB share UI only appears once VITE_API_FACEBOOK_SHARE is wired
  // (set at go-live, after the lambda is deployed). Keeps a half-feature out of prod on any promote.
  const fbShareEnabled = !!import.meta.env.VITE_API_FACEBOOK_SHARE

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '28px 16px 60px' }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
              <Link to="/dashboard" style={{ color: P.green, textDecoration: 'none' }}>Dashboard</Link>
              {' › Photos'}
            </div>
            <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
              Photos
            </h1>
            {/* W-RESTORE — the ONLY entry point to Recently deleted, so it is unconditional. It does
                NOT hide when the list is empty: a recovery surface the user cannot find until after
                they need it is the same failure as not having one, and "where did my deleted photo
                go?" is a question asked from HERE. Rendered under the title rather than beside
                Select/+ Upload because at 390px that row is already two controls wide, and a
                text link next to two filled buttons reads as a third button. */}
            <Link
              to="/photos/deleted"
              style={{
                display: 'inline-flex', alignItems: 'center', minHeight: 44,
                color: P.mid, fontSize: '0.84rem', fontWeight: 600, textDecoration: 'none',
              }}
            >
              Recently deleted
            </Link>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            {photos.length > 0 && fbShareEnabled && (
              <button
                onClick={() => (selectMode ? exitSelectMode() : enterSelectMode())}
                style={{
                  backgroundColor: selectMode ? P.light : P.white,
                  color: selectMode ? P.white : P.green,
                  border: `1px solid ${selectMode ? P.light : P.green}`, borderRadius: 8,
                  padding: '10px 16px', fontSize: '0.88rem', fontWeight: 700, cursor: 'pointer',
                }}
              >
                {selectMode ? 'Cancel' : 'Select'}
              </button>
            )}
            <button
              onClick={() => { setShowUpload(s => !s); setUploadErr(null) }}
              style={{
                backgroundColor: showUpload ? P.light : P.green,
                color: P.white, border: 'none', borderRadius: 8,
                padding: '10px 16px', fontSize: '0.88rem', fontWeight: 700, cursor: 'pointer',
              }}
            >
              {showUpload ? 'Cancel' : '+ Upload'}
            </button>
          </div>
        </div>

        {/* ── Upload form ── */}
        {showUpload && (
          <div style={{
            backgroundColor: P.white, border: `1px solid ${P.border}`,
            borderRadius: 10, padding: 18, marginBottom: 20,
          }}>
            <h2 style={{ margin: '0 0 14px', fontSize: '0.95rem', fontWeight: 700, color: P.mid }}>
              Upload standalone photo
            </h2>
            {uploadErr && <ErrBanner msg={uploadErr} />}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="photo-library-upload-form">

              {/* ── BUG-PHOTOFIRST-001: the photo comes FIRST and is never gated. ── */}
              <input
                ref={stagedInputRef}
                type="file"
                accept="image/*"
                onChange={onStagedPick}
                style={{ display: 'none' }}
                data-testid="pl-staged-input"
              />
              {!stagedPreview ? (
                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="button" data-testid="pl-stage-take" onClick={() => openStagedPicker(true)}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '18px 12px', border: `2px dashed ${P.border}`, borderRadius: 8, cursor: 'pointer', backgroundColor: P.white, color: P.mid, fontSize: '0.88rem', fontWeight: 600 }}>
                    <span style={{ fontSize: '1.3rem' }}>📷</span><span>Take photo</span>
                  </button>
                  <button type="button" data-testid="pl-stage-choose" onClick={() => openStagedPicker(false)}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '18px 12px', border: `2px dashed ${P.border}`, borderRadius: 8, cursor: 'pointer', backgroundColor: P.white, color: P.mid, fontSize: '0.88rem', fontWeight: 600 }}>
                    <span style={{ fontSize: '1.3rem' }}>🖼️</span><span>Choose photo</span>
                  </button>
                </div>
              ) : (
                <div>
                  <img src={stagedPreview} alt="Upload preview" data-testid="pl-staged-preview"
                    style={{ width: '100%', maxHeight: 260, objectFit: 'cover', borderRadius: 10, display: 'block' }} />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                    <button type="button" data-testid="pl-stage-replace" onClick={() => openStagedPicker(false)}
                      style={{ border: `1px solid ${P.border}`, borderRadius: 8, padding: '5px 12px', background: P.white, color: P.mid, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
                      Change photo
                    </button>
                    <button type="button" data-testid="pl-stage-clear" onClick={clearStaged}
                      style={{ border: `1px solid ${P.border}`, borderRadius: 8, padding: '5px 12px', background: P.white, color: P.mid, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
                      Remove
                    </button>
                  </div>
                  {/* Now — and only now — ask where it goes. This ordering IS the fix. */}
                  <p style={{ margin: '10px 0 0', fontSize: '0.82rem', color: P.mid }}>
                    Where does this one go?
                  </p>
                </div>
              )}

              {/* V4-PROJHIDE-001: upload project chooser hidden when projects aren't user-facing. Flag
                  OFF renders it exactly as before. (project_id stays '' when hidden — see report note re:
                  the plant picker below, which is project-scoped.) */}
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
                  {/* V4-PLANTPICKER-001: shared picker. emptyMeaning='project-level' — blank here is
                      a DELIBERATE project-level attach, not an unset field (spec §6.5 tri-state). */}
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

              {/* V4-PUBHIDE-001: is_public toggle removed. */}

              {/* BUG-PHOTOFIRST-001: the one-of-target rule is unchanged (photos_must_have_parent),
                  but it is no longer a PRECONDITION to picking — it is a condition on SENDING. Only
                  say it once a photo is actually staged; before that it is a rule about nothing. */}
              {stagedFile && targetMissing && (
                <p style={{ margin: 0, fontSize: '0.8rem', color: P.light }}>
                  A standalone photo needs at least a project or zone.
                </p>
              )}

              <button
                type="button"
                data-testid="pl-staged-upload"
                onClick={uploadStaged}
                disabled={!stagedFile || targetMissing || uploading}
                style={{
                  backgroundColor: (!stagedFile || targetMissing) ? P.light : P.green,
                  color: P.white, border: 'none', borderRadius: 8, padding: '12px 16px',
                  fontSize: '0.9rem', fontWeight: 700, minHeight: 44,
                  cursor: (!stagedFile || targetMissing || uploading) ? 'not-allowed' : 'pointer',
                  opacity: uploading ? 0.7 : 1,
                }}
              >
                {uploading ? 'Uploading…' : stagedFile ? 'Upload photo' : 'Pick a photo first'}
              </button>
            </div>
          </div>
        )}

        {/* ── Filters ── */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { mode: 'all',        label: 'All' },
            { mode: 'standalone', label: 'No event' },
            { mode: 'untagged',   label: 'Untagged' },
          ].map(({ mode, label }) => {
            const active = filterMode === mode && !filterProject && !filterLocation
            return (
              <button
                key={mode}
                onClick={() => { setFilterMode(mode); setFilterProject(''); setFilterLocation('') }}
                style={{
                  padding: '6px 14px', borderRadius: 20, fontSize: '0.82rem', fontWeight: 600,
                  cursor: 'pointer',
                  border: `1px solid ${active ? P.green : P.border}`,
                  backgroundColor: active ? P.greenPale : P.white,
                  color: active ? P.green : P.mid,
                }}
              >
                {label}
              </button>
            )
          })}
          {/* V4-PROJHIDE-001: project filter hidden when projects aren't user-facing (mode chips +
              space filter remain; filterProject stays '' so no project filter applies). Flag OFF is
              byte-identical. */}
          {!PROJECTS_HIDDEN && (
          <select
            value={filterProject}
            onChange={e => { setFilterProject(e.target.value); setFilterLocation(''); setFilterMode('all') }}
            style={{
              ...selectStyle,
              fontSize: '0.82rem', padding: '6px 30px 6px 10px',
              maxWidth: 200, flexShrink: 1,
              border: filterProject ? `1px solid ${P.green}` : `1px solid ${P.border}`,
              backgroundColor: filterProject ? P.greenPale : P.white,
            }}
          >
            <option value="">Filter by project…</option>
            <ProjectOptions projects={projects} />
          </select>
          )}
          {/* V4-PHOTOLOCFIND-001: space chip — server-side subtree filter (a parent space shows its
              descendants' photos). Mutually exclusive with the project filter, like the mode chips. */}
          <select
            value={filterLocation}
            onChange={e => { setFilterLocation(e.target.value); setFilterProject(''); setFilterMode('all') }}
            style={{
              ...selectStyle,
              fontSize: '0.82rem', padding: '6px 30px 6px 10px',
              maxWidth: 200, flexShrink: 1,
              border: filterLocation ? `1px solid ${P.green}` : `1px solid ${P.border}`,
              backgroundColor: filterLocation ? P.greenPale : P.white,
            }}
          >
            <option value="">Filter by zone…</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
          </select>
        </div>

        {/* ── Grid ── */}
        {loading ? (
          <p style={{ color: P.light, fontSize: '0.9rem' }}>Loading…</p>
        ) : error ? (
          <AsyncRegion
            error={photoLoadErrorMessage(error, 'the gallery')}
            errorTitle="Couldn’t load your photos"
            onRetry={loadPhotos}
          />
        ) : photos.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 16px', color: P.light }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📷</div>
            <p style={{ margin: 0, fontSize: '0.9rem' }}>No photos yet.</p>
            <p style={{ margin: '6px 0 0', fontSize: '0.82rem' }}>Upload your first one above.</p>
          </div>
        ) : (
          // V3-PHOTODBG-001 (4/4): the grid render is wrapped in an ErrorBoundary so a render-time
          // fault in any PhotoCard (malformed photo shape, bad view_url) degrades to a dismissable
          // retry card instead of white-screening the whole Photos page. Mirrors the tag-modal net.
          <ErrorBoundary
            scope="photo-grid"
            fallback={(err, retry) => <PhotoGridErrorFallback retry={() => { retry(); loadPhotos() }} />}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {photos.slice(0, shown).map(photo => (
                <PhotoCard
                  key={photo.id}
                  photo={photo}
                  selectMode={selectMode}
                  selected={selected.has(photo.id)}
                  onClick={() => (selectMode ? toggleSelect(photo.id) : openModal(photo))}
                />
              ))}
            </div>
            {shown < photos.length && (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <button type="button" onClick={() => setShown(s => s + PAGE)}
                  style={{ background: P.white, color: P.green, border: `1px solid ${P.green}`, borderRadius: 8,
                           padding: '11px 20px', fontSize: '0.88rem', fontWeight: 700, cursor: 'pointer', minHeight: 44 }}>
                  Show more ({photos.length - shown} left)
                </button>
              </div>
            )}
          </ErrorBoundary>
        )}
      </div>

      {/* ── Modal ── */}
      {/* V1.2a-3 Increment A (I1/I4): the tag modal is wrapped in an ErrorBoundary so a
          render-time fault (bad photo shape, malformed linkage) degrades to a dismissable
          card instead of white-screening the whole Photo Library. The 405-string bug
          itself (I1) is fixed in the photos Lambda PUT route; this is the defensive net. */}
      {modal && (
        <ErrorBoundary
          scope="photo-tag-modal"
          fallback={(err, retry) => (
            <PhotoModalErrorFallback error={err} retry={retry} onClose={() => setModal(null)} />
          )}
        >
          <PhotoModal
            photo={modal}
            tagForm={tagForm}
            setTagForm={setTagForm}
            plantsForModal={plantsForModal}
            onSave={handleTag}
            onClose={() => setModal(null)}
            tagging={tagging}
            tagErr={tagErr}
            projects={projects}
            locations={locations}
            onShare={fbShareEnabled ? (() => { setModal(null); openShare([modal]) }) : undefined}
            onDelete={() => { setDeleteErr(null); setDeleteTarget(modal) }}
          />
        </ErrorBoundary>
      )}

      {/* W-PHOTODEL — rendered as a SIBLING of the modal, not inside it, and after it in document
          order. Both paint at zIndex 200 (PhotoModal's overlay; Sheet's panel), both register
          LAYER.SHEET, so the arbiter's insertion-order tiebreak and the paint order agree: the
          confirm is topmost on both axes and one Escape closes the confirm only. Nesting it inside
          PhotoModal would put it under that modal's ErrorBoundary and inside its scrollport, which
          is how a fly-up ends up clipped (BUG-PICKERCLIP-001, same page, same cause).
          The modal deliberately STAYS mounted behind it: Cancel must return the user to the photo
          they were looking at, not to the grid. */}
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

      {/* V4-FBSHARE-001 — selection action bar (only in select-mode) */}
      {selectMode && selectionCount > 0 && (
        // BUG-PICKERCLIP-001: hidden — NOT unmounted — while the upload form's planting listbox is
        // open. visibility+pointerEvents keeps the node so the picker's 150ms deferred blur-close
        // cannot flicker an unmounting bar back under a finger mid-gesture. `visibility: hidden`
        // already drops the subtree from the a11y tree and the tab order, so no aria-hidden.
        <div data-testid="pl-select-bar" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 150, background: P.white, borderTop: `1px solid ${P.border}`, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, boxShadow: '0 -2px 10px rgba(0,0,0,0.08)', visibility: uploadPickerOpen ? 'hidden' : 'visible', pointerEvents: uploadPickerOpen ? 'none' : 'auto' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 700, color: P.mid }}>{selectionCount} selected</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {selectionOverMax && <span style={{ fontSize: '0.72rem', color: P.terra }}>{`Max ${MAX_SHARE_PHOTOS}`}</span>}
            <button type="button" onClick={exitSelectMode} style={{ background: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 8, padding: '10px 16px', fontSize: '0.86rem', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
            <button type="button" onClick={() => openShare(selectedPhotos)} disabled={selectionOverMax}
              style={{ background: selectionOverMax ? P.light : P.green, color: P.white, border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: '0.86rem', fontWeight: 700, cursor: selectionOverMax ? 'default' : 'pointer' }}>
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
      />
    </div>
  )
}

// ---- Photo card ----
// Uses photo.view_url (signed S3 URL from Lambda) and photo.project_name (inline JOIN)
function PhotoCard({ photo, onClick, selectMode = false, selected = false }) {
  // V4-PROJHIDE-001: drop the project caption strip when projects aren't user-facing (null → the
  // {project && (...)} strip below renders nothing). Flag OFF keeps photo.project_name.
  const project = PROJECTS_HIDDEN ? null : photo.project_name

  return (
    <button
      onClick={onClick}
      aria-pressed={selectMode ? selected : undefined}
      style={{
        background: 'none',
        border: selected ? `2px solid ${P.green}` : `1px solid ${P.border}`,
        borderRadius: 8, overflow: 'hidden', cursor: 'pointer', padding: 0, textAlign: 'left',
      }}
    >
      <div style={{ position: 'relative', paddingBottom: '100%', backgroundColor: P.photoPlaceholder }}>
        {/* V4-PHOTOMODEL-001 — was a bare <img> with a hand-rolled thumb->full onError swap, the
            last exception in noBareViewUrlImg.static.test.js. The thumb->full degrade is unchanged
            in behavior (still zero-network, still one-shot) but now lives in the model; the bare
            <img> is gone, so the grid also gains the 900s-presign self-heal it never had.
            Still NO loading="lazy" — measured 0 of 120 requested on this grid; `shown` bounds the
            card count instead. */}
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
            color: P.white, fontSize: '0.75rem', fontWeight: 700,
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
// Uses photo.view_url for display
function PhotoModal({ photo, tagForm, setTagForm, plantsForModal, onSave, onClose, tagging, tagErr, projects, locations, onShare, onDelete }) {
  const hasEvent = !!photo.event_id

  // V4-BACKNAV-001 Slice 2 follow-up — PHOTOMODAL_GAP closed. This was a fixed full-viewport overlay
  // with NO role="dialog", NO aria-modal, NO Escape handler and NO focus restore: a backdrop tap was
  // its only exit, and it was invisible to every machine-checkable definition of "modal" — including
  // the freeze test's scan, which is why it had to be tracked by hand. `busy: tagging` keeps a
  // save-in-flight from being dismissed out from under itself, matching the other write surfaces.
  const { isTopmost } = useDismissable({ open: true, onDismiss: onClose, busy: !!tagging, layer: LAYER.SHEET, armsBack: true })
  // Close-in-place: onClose just clears the selected photo, it never navigates.

  return (
    <div
      role="dialog"
      aria-modal={isTopmost ? 'true' : undefined}
      aria-label="Photo details"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        boxSizing: 'border-box',
        backgroundColor: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'env(safe-area-inset-top) 16px env(safe-area-inset-bottom) 16px',
      }}
    >
      {/* V4-KBVIEWPORT-001: 90dvh re-resolves ~731px -> ~460px once interactive-widget shrinks the
          layout viewport, and the tag form's "Plant · optional" field is a PlantingSelect text
          input, so the keyboard IS up on this surface. Photo (300) + the optional caption line +
          Project/Plant/Location + "Save tags" exceeds 460, so this card needs a scrollable path or
          Save is clipped away unreachably.
          NOTE the two conditions for reproducing that: the tag form renders only when the photo is
          NOT attached to an event (the hasEvent branch replaces it with a pointer to the event
          log), and the static caption line now renders only for event-attached photos — on the tag
          form the caption is an editable input (V4-PHOTOCAPTION-001; was set-at-upload-only).

          BUG-PICKERCLIP-001 — that scrollable path used to be a SECOND box: card `overflow: hidden`
          (hard clip) wrapping a `flexShrink: 0` photo and an `overflowY: auto` body. The picker's
          listbox is `position: absolute` inside that body, so the body was its nearest clipping
          ancestor and the usable band was 90dvh MINUS the 300px pinned photo — ~114px with the
          keyboard up. PlantingSelect measures its room against the VISUAL VIEWPORT (and
          hasFixedAncestor() zeroes the chrome insets here, correctly, because this card paints over
          the nav), so it sizes and flips for room this box does not have: flipped up it renders
          `bottom: 100%` into the photo's area and the body clipped essentially all of it. No z-index
          can reach that — the listbox was CLIPPED, not overpainted.
          The fix is e771c94's own idiom taken one step further: ONE scrollport, not two. The card
          is the scroll container (matching Sheet, the app's canonical overlay — `maxHeight` +
          `overflowY: auto`, single scrollport) and the photo stays pinned via `position: sticky`
          rather than by living outside a smaller box. The listbox's nearest clipping ancestor is
          now the full 90dvh card instead of the leftover band, and a flipped listbox paints OVER
          the sticky photo (z30 beats the header's z1) instead of being cut at the body's top edge.
          Explicit white background on the header: content now scrolls UNDER it. */}
      <div data-testid="pl-modal-card" style={{
        backgroundColor: P.white, borderRadius: 12,
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
            onClick={onClose}
            style={{
              position: 'absolute', top: 10, right: 10,
              background: 'rgba(0,0,0,0.55)', color: P.onPhotoFg,
              border: 'none', borderRadius: '50%', width: 30, height: 30,
              cursor: 'pointer', fontSize: '0.9rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >✕</button>
        </div>

        {/* BUG-PICKERCLIP-001: no overflow here. This div being a scroll container is exactly what
            clipped the picker's listbox; the card above owns the single scrollport now. */}
        <div data-testid="pl-modal-body" style={{ padding: '16px 20px 20px' }}>
          {/* V4-PHOTOCAPTION-001: static caption only where there is no editable field (event-attached
              photos have no tag form); on the form the input below owns the caption. */}
          {hasEvent && photo.caption && (
            <p style={{ margin: '0 0 12px', fontSize: '0.88rem', color: P.mid }}>{photo.caption}</p>
          )}

          {onShare && (
            <button type="button" onClick={onShare}
              style={{ width: '100%', marginBottom: 14, background: P.white, color: P.green, border: `1px solid ${P.green}`, borderRadius: 8, padding: '11px', fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer' }}>
              Share to Facebook
            </button>
          )}

          {hasEvent ? (
            <div style={{ backgroundColor: P.cream, borderRadius: 8, padding: '10px 12px' }}>
              <p style={{ margin: 0, fontSize: '0.8rem', color: P.light }}>
                Attached to an event — tags are managed via the event log.
              </p>
            </div>
          ) : (
            <form onSubmit={onSave} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: '0 0 4px', fontSize: '0.77rem', fontWeight: 700, color: P.mid, letterSpacing: '0.4px', textTransform: 'uppercase' }}>
                Tags
              </p>
              {tagErr && <ErrBanner msg={tagErr} />}

              {/* V4-PROJHIDE-001: reassign project chooser hidden when projects aren't user-facing. Flag
                  OFF renders it exactly as before. (project_id stays '' when hidden — the plant picker
                  below is project-scoped; see report note.) */}
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
                  {/* V4-PLANTPICKER-001: shared picker. NOTE the create-vs-edit contract split (spec
                      §6.5 trap): the upload form is target-gated, this modal is NOT — clearing here
                      must stay possible (un-tagging a photo is legitimate). */}
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

              {/* V4-PHOTOCAPTION-001: caption editable post-upload — PUT /api/photos/:id already
                  accepted it; only this input was missing. */}
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

          {/* W-PHOTODEL — the standalone delete, OUTSIDE the hasEvent branch on purpose.
              An event-attached photo is precisely the case this whole row exists for: before this
              control, the only way to remove one was to delete the EVENT it hangs off, destroying a
              real record of a real thing that happened in the garden in order to get rid of an
              image. Putting the delete only on the tag-form arm would leave that exact photo
              unreachable and close the row on paper only.

              Placement is a safety decision, not a layout one: below a divider, at the END of the
              body, so it is never adjacent to "Save tags" — and it is a plain text-weight control,
              not a filled button, so the destructive action is never the most prominent thing in a
              modal whose ordinary purpose is captioning. It only ARMS the confirm; nothing is
              written from here. */}
          {onDelete && (
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${P.border}` }}>
              <button
                type="button"
                data-testid="pl-photo-delete"
                onClick={onDelete}
                disabled={tagging}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: '100%', minHeight: 44,
                  background: 'transparent', color: P.terra,
                  border: `1px solid ${P.border}`, borderRadius: 8,
                  fontSize: '0.88rem', fontWeight: 700,
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
    <div style={{
      backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`,
      borderRadius: 8, padding: '10px 14px', marginBottom: 8,
      fontSize: '0.82rem', color: P.bannerInk,
    }}>
      {msg}
    </div>
  )
}

// ErrorBoundary fallback for the photo-tag modal. Modal-shaped so a render fault
// still reads as "the modal broke" rather than dumping the user back to the grid
// with no explanation. Friendly copy only — never the raw error string.
// ErrorBoundary fallback for the photo GRID (V3-PHOTODBG-001 4/4). A render fault in the grid
// degrades to a contained retry card matching the load-error styling — never a white screen.
function PhotoGridErrorFallback({ retry }) {
  return (
    <AsyncRegion
      error="Something went wrong rendering the gallery. Your photos are safe — please retry."
      errorTitle="Couldn’t display your photos"
      onRetry={retry}
    />
  )
}

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
        backgroundColor: P.white, borderRadius: 12, maxWidth: 420, width: '100%',
        padding: '24px 22px', textAlign: 'center',
      }}>
        <div style={{ fontSize: '2rem', marginBottom: 10 }}>⚠️</div>
        <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '0.95rem' }}>
          This photo couldn’t open
        </p>
        <p style={{ margin: '0 0 18px', color: P.mid, fontSize: '0.85rem' }}>
          Something went wrong loading the tag editor. Your photo is safe — try again, or close and reopen it.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button type="button" onClick={retry} style={primaryBtn(false)}>Try again</button>
          <button type="button" onClick={onClose} style={{
            backgroundColor: 'transparent', color: P.mid, border: `1px solid ${P.border}`,
            borderRadius: 8, padding: '11px 24px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
          }}>Close</button>
        </div>
      </div>
    </div>
  )
}

const fieldLabelStyle = {
  display: 'block', fontSize: '0.77rem', fontWeight: 700,
  color: P.mid, marginBottom: 5, letterSpacing: '0.4px', textTransform: 'uppercase',
}

const inputStyle = {
  width: '100%', padding: '10px 12px',
  border: `1px solid ${P.border}`,
  borderRadius: 7, fontSize: '0.9rem',
  backgroundColor: P.white, boxSizing: 'border-box', fontFamily: 'inherit',
}

const selectStyle = {
  ...inputStyle,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23777' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight: 36, cursor: 'pointer',
}

// dropZoneStyle / clearBtnStyle removed in V2-PHOTO-F1 S2: <PhotoUpload> owns
// the trigger affordance and preview lifecycle now.

const primaryBtn = (disabled) => ({
  backgroundColor: disabled ? P.light : P.green,
  color: P.white, border: 'none', borderRadius: 8,
  padding: '11px 24px', fontSize: '0.9rem', fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer',
})
