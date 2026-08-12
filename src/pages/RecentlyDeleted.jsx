// W-RESTORE — "Recently deleted", the durable recovery surface for photos (plan V100 §3, DD8).
//
// WHY THIS PAGE EXISTS. The delete affordance and EventDeleteConfirm's copy — "recoverable from
// Recently deleted" — shipped in the same session as the DELETE route, and there was no Recently
// deleted anywhere in the app. The data was always recoverable (soft delete, deleted_at, every
// relation preserved); the PLACE was not. A destructive control that advertises a recovery path the
// user cannot reach is worse than one that admits it is final, because the user's belief about the
// system is wrong in the direction that makes them careless. This page is what makes that sentence
// true.
//
// SOFT-DELETE-ONLY, VISIBLY. There is no "delete permanently" and no "empty trash" here, and that is
// a rule (never hard-delete user-meaningful data), not an omission to be tidied up later. The only
// verb on this page is Restore. Consequence worth stating: the list only ever grows, so it is
// ordered most-recently-deleted first and capped server-side — it is a recovery surface, not an
// archive browser.
//
// REWARD-UX: restoring a photo is operational. No celebration, no badge, no count-up — an ambient
// toast confirming the thing the user just asked for, which is the Toast primitive's documented
// operational carve-out.
//
// MOBILE IS THE GATE (Android Chrome, ~390px). Each row is thumb + text + a 44px-minimum Restore
// control that wraps to its own line rather than shrinking below the tap floor. Nothing on this page
// is destructive, so unlike EventDeleteConfirm there is no control that has to be kept away from the
// thumb path — the safe action is allowed to be the easy one.
import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { formatDate } from '../lib/format.js'
import { DELETED_PHOTOS_PATH, restorePhotoPath } from '../lib/deletedPhotos.js'
import { invalidatePrefix } from '../lib/dataCache.js'
import { useOptionalToast } from '../context/ToastContext.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import Button from '../components/forms/Button.jsx'
import ErrorBanner from '../components/forms/ErrorBanner.jsx'
import PhotoView from '../components/photo/PhotoView.jsx'
import { TIER } from '../lib/photoModel.js'

// The row's secondary line. A photo can be deleted while carrying any of six parents, and the user
// is choosing between thumbnails that may look alike (the incident that started this whole lane was
// two BYTE-IDENTICAL photos of the same tomato), so the parent name is load-bearing identification,
// not decoration. project_name is the only parent name the list endpoint joins — matching the live
// photo list exactly rather than inventing a second, richer shape for this one surface.
export function rowSubtitle(photo) {
  const parts = []
  if (photo?.project_name) parts.push(photo.project_name)
  const when = formatDate(photo?.deleted_at)
  if (when) parts.push(`Deleted ${when}`)
  return parts.join(' · ')
}

function PhotoRow({ photo, busy, onRestore }) {
  // THE PRIMITIVE OWNS TIER SELECTION, not this page. The first draft hand-rolled
  // `thumb_url || view_url` with an onError fallback, which photoPrimitive.static.test.js caught:
  // thumb_url is a presigned string on EVERY row whether or not the object exists, so `||` never
  // falls through and the degrade is a fiction (BUG-PHOTONEWTHUMB-001). PhotoView's chain degrades
  // on the real error event, with no network round-trip, and re-mints the presign at 900s.
  //
  // A photo whose presign failed server-side renders nothing here (PhotoView returns null) — the row
  // still lists and still restores. Losing the preview is a worse preview, never a lost photo.
  const tile = { width: 64, height: 64, objectFit: 'cover', borderRadius: 8, flexShrink: 0, backgroundColor: P.cream }
  return (
    <li
      style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: 12, marginBottom: 10,
        backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
      }}
    >
      <PhotoView photo={photo} tier={TIER.THUMB} alt={photo.caption || 'Deleted photo'} style={tile} />

      {/* FLEX-BASIS IS THE BREAKPOINT, measured rather than guessed. At 390px (Android Chrome) the
          row has 334px of content width; 64 thumb + 170 basis + 119 button + gaps overflows it, so
          the button wraps to its own line and the caption gets 258px instead of the 125px a
          120px basis left it — measured in the layout harness, where a 3-line caption became a
          4-line one and the parent name broke mid-phrase. On the 700px desktop container the same
          numbers fit on one line, so nothing is traded away there. */}
      <div style={{ flex: '1 1 170px', minWidth: 0 }}>
        <div style={{ color: P.dark, fontSize: '0.92rem', fontWeight: 600, overflowWrap: 'anywhere' }}>
          {photo.caption || 'Untitled photo'}
        </div>
        <div style={{ color: P.light, fontSize: '0.8rem', marginTop: 2, overflowWrap: 'anywhere' }}>
          {rowSubtitle(photo)}
        </div>
      </div>

      <Button
        variant="secondary"
        onClick={() => onRestore(photo)}
        loading={busy}
        loadingLabel="Restoring…"
        // aria-label carries the caption so a screen-reader user hears WHICH photo a Restore acts on;
        // the visible label stays one short word because at 390px a per-row sentence is a wall.
        // Dropped while busy on purpose — an aria-label OVERRIDES the child text, so keeping it would
        // silence the "Restoring…" swap that is the only in-flight feedback this control has.
        aria-label={busy ? undefined : `Restore ${photo.caption || 'photo'}`}
        style={{ minWidth: 96, marginLeft: 'auto' }}
      >
        Restore
      </Button>
    </li>
  )
}

// The empty state is the DEFAULT state of this page, not an edge case: nothing is ever deleted
// automatically, so a household that has not deleted anything sees only this. It has to answer the
// question the user arrived with ("where do deleted photos go?") rather than just report a count of
// zero — otherwise the DD9 confirm's promise reads as unfulfilled the first time anyone checks it.
export function EmptyState() {
  return (
    <div style={{ textAlign: 'center', padding: '32px 8px', color: P.mid }}>
      <div aria-hidden="true" style={{ fontSize: '2rem', marginBottom: 10 }}>🗑️</div>
      <p style={{ margin: '0 0 8px', color: P.dark, fontSize: '0.95rem', fontWeight: 600 }}>
        Nothing deleted
      </p>
      <p style={{ margin: '0 auto', maxWidth: 320, fontSize: '0.88rem', lineHeight: 1.5 }}>
        Photos you delete land here and stay until you put them back. Nothing is ever removed
        permanently.
      </p>
      <div style={{ marginTop: 12 }}>
        {/* Measured at 104x17 in the layout harness before the inline-flex + minHeight — a 17px-tall
            tap target on a 390px Android screen, and the ONLY way out of an otherwise blank page.
            The breadcrumb above it is the app's existing small-link idiom and is left alone; this one
            is a primary action in an empty state, which is a different thing. */}
        <Link
          to="/photos"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minHeight: 44, padding: '0 12px',
            color: P.green, fontWeight: 600, textDecoration: 'none',
          }}
        >
          Back to Photos
        </Link>
      </div>
    </div>
  )
}

export default function RecentlyDeleted() {
  const { fetch: apiFetch } = useApiFetch()
  const toast = useOptionalToast()

  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  // TWO error states, deliberately. A LOAD failure replaces the region (there is nothing to show);
  // a RESTORE failure must NOT — routing it through the same state would blank the list the user is
  // working in and take away the other rows' Restore buttons because one row failed.
  const [loadError, setLoadError] = useState(null)
  const [restoreError, setRestoreError] = useState(null)
  const [restoringId, setRestoringId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setRestoreError(null)
    try {
      setPhotos((await apiFetch(DELETED_PHOTOS_PATH)) ?? [])
    } catch (err) {
      setPhotos([])
      setLoadError(err?.message || 'Could not load recently deleted photos.')
    }
    setLoading(false)
  }, [apiFetch])

  useEffect(() => { load() }, [load])

  const restore = useCallback(async (photo) => {
    if (restoringId) return
    setRestoringId(photo.id)
    setRestoreError(null)
    try {
      await apiFetch(restorePhotoPath(photo.id), { method: 'POST' })
      // Drop the row locally rather than refetching: the server answer IS the confirmation, and a
      // refetch would re-presign every remaining row to learn one thing we already know.
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id))
      // The photo is live again, so every cached photo list that filtered it out is now wrong. The
      // page the user goes back to is the one that must show it.
      invalidatePrefix('/api/photos')
      toast.show({ message: 'Photo restored' })
    } catch (err) {
      // A 409 here is the typed duplicate case (the same bytes were re-uploaded while this one sat
      // deleted) and its message is actionable, so it is shown rather than flattened to "failed".
      setRestoreError(err?.message || 'Could not restore that photo.')
    }
    setRestoringId(null)
  }, [apiFetch, restoringId, toast])

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '28px 16px 60px' }}>
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
          <Link to="/photos" style={{ color: P.green, textDecoration: 'none' }}>Photos</Link>
          {' › Recently deleted'}
        </div>
        <h1 style={{ margin: '0 0 8px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
          Recently deleted
        </h1>
        <p style={{ margin: '0 0 20px', color: P.mid, fontSize: '0.88rem', lineHeight: 1.5 }}>
          Deleted photos are kept here. Restore one any time — nothing expires.
        </p>

        <AsyncRegion
          loading={loading}
          error={loadError}
          empty={!loading && !loadError && photos.length === 0}
          emptyLabel={<EmptyState />}
          onRetry={load}
          errorTitle="Couldn’t load Recently deleted"
          loadingLabel="Loading deleted photos…"
        >
          {restoreError && <ErrorBanner>{restoreError}</ErrorBanner>}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {photos.map((photo) => (
              <PhotoRow
                key={photo.id}
                photo={photo}
                busy={restoringId === photo.id}
                onRestore={restore}
              />
            ))}
          </ul>
        </AsyncRegion>
      </div>
    </div>
  )
}
