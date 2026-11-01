// Recently deleted: the durable recovery surface for photos. The delete affordance and
// EventDeleteConfirm's copy ("recoverable from Recently deleted") promise a recovery path; this page is
// what makes that sentence true.
//
// Soft-delete-only, visibly. There is no "delete permanently" and no "empty trash" here: that is a rule
// (never hard-delete user-meaningful data), not an omission. The only verb is Restore. The list only
// ever grows, so it is ordered most-recently-deleted first and capped server-side: a recovery surface,
// not an archive browser.
//
// Restoring a photo is operational: no celebration, badge or count-up, only the ambient toast the Toast
// primitive documents as its operational carve-out.
//
// Mobile is the gate (Android Chrome, ~390px). Each row is thumb + text + a 44px-minimum Restore
// control that wraps to its own line rather than shrinking below the tap floor. Nothing here is
// destructive, so the safe action is allowed to be the easy one.
import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { formatDate } from '../lib/format.js'
import { DELETED_PHOTOS_PATH, restorePhotoPath } from '../lib/deletedPhotos.js'
import { DELETED_ENTITY_KINDS, rowsFromResponse } from '../lib/deletedEntities.js'
import { invalidatePrefix } from '../lib/dataCache.js'
import { useOptionalToast } from '../context/ToastContext.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import SharedEmptyState from '../components/forms/EmptyState.jsx'
import Button from '../components/forms/Button.jsx'
import ErrorBanner from '../components/forms/ErrorBanner.jsx'
import PhotoView from '../components/photo/PhotoView.jsx'
import { TIER } from '../lib/photoModel.js'

// The row's secondary line. A photo can be deleted while carrying any of six parents, and the user is
// choosing between thumbnails that may look alike (two byte-identical photos of the same tomato), so
// the parent name is load-bearing identification, not decoration. project_name is the only parent name
// the list endpoint joins, matching the live photo list.
export function rowSubtitle(photo) {
  const parts = []
  if (photo?.project_name) parts.push(photo.project_name)
  const when = formatDate(photo?.deleted_at)
  if (when) parts.push(`Deleted ${when}`)
  return parts.join(' · ')
}

function PhotoRow({ photo, busy, onRestore }) {
  // The primitive owns tier selection, not this page: thumb_url is a presigned string on EVERY row
  // whether or not the object exists, so a `thumb_url || view_url` fallback never falls through
  // (photoPrimitive.static.test.js). PhotoView's chain degrades on the real error event, with no network
  // round-trip, and re-mints the presign at 900s.
  //
  // A photo whose presign failed server-side renders nothing here (PhotoView returns null); the row
  // still lists and still restores.
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

      {/* Flex-basis is the breakpoint, measured: at 390px the row has 334px of content width, and 64
          thumb + 170 basis + 119 button + gaps overflows it, so the button wraps to its own line and the
          caption gets 258px instead of 125px, which keeps a 3-line caption at 3 lines. On the 700px
          desktop container the same numbers fit on one line. */}
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

// The empty state is the DEFAULT state of this page: nothing is ever deleted automatically, so a
// household that has not deleted anything sees only this. It has to answer the question the user
// arrived with ("where do deleted photos go?") rather than just report zero. Chrome comes from the
// shared primitive; the Link below stays at this call site because its inline-flex + 44px minHeight is
// pinned by RecentlyDeleted.test.jsx and is this page's own decision.
export function EmptyState() {
  return (
    <SharedEmptyState
      emoji="🗑️"
      title="Nothing deleted"
      body="Photos you delete land here and stay until you put them back. Nothing is ever removed permanently."
      action={(
        <>
          {/* A 17px-tall tap target on a 390px Android screen was the only way out of an otherwise blank
              page, hence inline-flex + minHeight. The breadcrumb above is the app's small-link idiom; this
              is a primary action in an empty state. */}
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
        </>
      )}
    />
  )
}


// One section per non-photo entity type. Each loads itself, so one entity type failing does not blank
// the others (a section that errors says so in its own space and offers its own retry). A section with
// nothing in it renders NOTHING: the page-level empty state already answers "where do deleted things
// go?", and a "No deleted cultivars" heading per section would bury the one that has rows.
export function DeletedEntitySection({ kind, apiFetch, toast }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [restoreError, setRestoreError] = useState(null)
  const [restoringId, setRestoringId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setRows(rowsFromResponse(kind, await apiFetch(kind.listPath)))
    } catch (err) {
      setRows([])
      setLoadError(err?.message || `Could not load deleted ${kind.label.toLowerCase()}.`)
    }
    setLoading(false)
  }, [apiFetch, kind])

  useEffect(() => { load() }, [load])

  const restore = useCallback(async (row) => {
    if (restoringId) return
    setRestoringId(row.id)
    setRestoreError(null)
    try {
      const reply = await apiFetch(kind.restorePath(row.id), { method: 'POST' })
      // Drop locally rather than refetching — the server answer IS the confirmation.
      setRows((prev) => prev.filter((r) => r.id !== row.id))
      // Every cached list that filtered this row out is now wrong. Containers invalidate the
      // plantings prefix too: restoring one can make previously-invisible plantings appear.
      for (const prefix of kind.invalidatePrefixes) invalidatePrefix(prefix)
      toast?.show?.({ message: kind.toastFor ? kind.toastFor(reply) : kind.toast })
    } catch (err) {
      setRestoreError(err?.message || 'Could not restore that item.')
    }
    setRestoringId(null)
  }, [apiFetch, kind, restoringId, toast])

  if (loading) return null
  if (!loadError && rows.length === 0) return null

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{
        margin: '0 0 8px', color: P.green, fontSize: '1rem', fontWeight: 700,
      }}>
        {kind.label}
      </h2>
      {loadError && <ErrorBanner>{loadError}</ErrorBanner>}
      {restoreError && <ErrorBanner>{restoreError}</ErrorBanner>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((row) => {
          const sub = kind.subtitle(row)
          const when = formatDate(row.deleted_at)
          const busy = restoringId === row.id
          return (
            <li
              key={row.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                padding: '10px 0', borderBottom: `1px solid ${P.line ?? '#e6e2d8'}`,
              }}
            >
              <div style={{ minWidth: 0, flex: '1 1 60%' }}>
                <div style={{ color: P.dark, fontSize: '0.95rem', fontWeight: 600 }}>
                  {row.name || 'Untitled'}
                </div>
                <div style={{ color: P.mid, fontSize: '0.82rem' }}>
                  {[sub, when && `Deleted ${when}`].filter(Boolean).join(' · ')}
                </div>
              </div>
              {/* 44px tap floor, wrapping to its own line rather than shrinking, like the photo rows. */}
              <Button
                onClick={() => restore(row)}
                disabled={busy}
                aria-label={busy ? undefined : `Restore ${row.name || 'item'}`}
                style={{ minWidth: 96, minHeight: 44, marginLeft: 'auto' }}
              >
                {busy ? 'Restoring…' : 'Restore'}
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
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
          Deleted photos, containers, plantings, locations and cultivars are kept here. Restore
          anything any time — nothing expires. Restore a container first if the plantings inside it
          are missing from the list.
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

        {DELETED_ENTITY_KINDS.map((kind) => (
          <DeletedEntitySection key={kind.key} kind={kind} apiFetch={apiFetch} toast={toast} />
        ))}
      </div>
    </div>
  )
}
