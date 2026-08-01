// V4-THEME-001 (V200 Pass B) — Photos WALL (Slice 3). The browse surface for the Garden tab's
// Photos sub-tab: a chronological photo grid grouped by month with sticky headers, opening the
// §10 Lightbox gallery on tap. Reuses the EXISTING /api/photos read shape (same as PhotoLibrary)
// — frontend-only, no schema/backend change. PhotoLibrary stays at /photos for upload + tagging;
// this is read-only browse.
//
// Lives OUTSIDE src/components/forms/, so it is exempt from the forms freeze-guard and the
// no-hex / no-emoji ESLint scope (like PlantingTile). It still composes P/T tokens for chrome.
//
// Grouping/sort is by created_at — the ONLY timestamp /api/photos exposes. Capture-time (EXIF
// DateTimeOriginal) would be the ideal grouping key but is not surfaced by the photos Lambda;
// we do NOT parse EXIF client-side. Swap the key here if/when the API adds a captured_at field.
//
// V4-SPACEPHOTO-001 Lane C — this is the CANONICAL month-grouped gallery renderer. The Space
// gallery is a PROP-CONFIG of it (`path` + `empty` + `renderTileFooter` + `testId`), NOT a fourth
// copy alongside PhotoLibrary's and LocationDetail's grids. Every prop defaults to the shipped
// behavior, so the Garden Photos sub-tab (<PhotosWall /> with no props) is byte-unchanged.
import React, { useState, useCallback, useMemo } from 'react'
import { useCachedFetch } from '../hooks/useCachedFetch.js'
import { P } from '../lib/constants.js'
import TileGrid from './forms/TileGrid.jsx'
import AsyncRegion from './forms/AsyncRegion.jsx'
import Lightbox from './Lightbox.jsx'
import PhotoImg from './PhotoImg.jsx'
import useImageWindow from '../hooks/useImageWindow.js'

const EMPTY_PHOTOS = []   // stable ref so the sort/section memos don't re-run while data is undefined

// Canonical photo-load failure copy, shared with PhotoLibrary's grid. Both surfaces branch on the
// same condition (no status / 5xx ⇒ service-side and worth retrying) and had drifted to two
// near-identical sentences; this is the one string. `subject` names what failed to load, which is
// the only genuinely surface-specific part.
export function photoLoadErrorMessage(error, subject) {
  return (error?.status == null || error.status >= 500)
    ? 'The photo service had a problem. This is usually temporary — please retry.'
    : `Something went wrong loading ${subject}.`
}

// Month bucket key + human label from an ISO-ish timestamp. Falls back to an "Undated" bucket
// (sorted last) when created_at is missing/garbage, so a malformed row never drops out silently.
const UNDATED_KEY = '0000-00'
function monthKey(ts) {
  const t = ts ? Date.parse(ts) : NaN
  if (!Number.isFinite(t)) return UNDATED_KEY
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
function monthLabel(key) {
  if (key === UNDATED_KEY) return 'Undated'
  const [y, m] = key.split('-')
  const mi = Number(m) - 1
  return `${MONTH_NAMES[mi] ?? m} ${y}`
}

export default function PhotosWall({
  path = '/api/photos',        // any /api/photos read (e.g. `?space_id=<uuid>`); scopes the wall
  empty = null,                // node rendered instead of the default zero-photos state
  renderTileFooter = null,     // (photo) => node, rendered UNDER each tile (outside its button)
  testId = 'photos-wall',
  ariaLabelPrefix = 'Photos from',
} = {}) {
  // V4-IMGCACHE-001 D-1: read the photo list through the SWR cache — a revisit paints from cache
  // instead of a refetch-and-re-presign every mount; `refetch` (Retry) force-revalidates. The cache
  // key is identity-scoped AND path-scoped, so a scoped wall never reads the garden-wide bucket.
  const { data, loading, error, refetch } = useCachedFetch(path)
  const photos = data ?? EMPTY_PHOTOS
  // Lightbox state: lbIndex is the FLAT index across all months into the sorted full list. lbFrozen
  // snapshots the slide array at open (regression I4) so a background revalidate can't reorder it and
  // jump the open slide to a different photo.
  const [lbOpen, setLbOpen] = useState(false)
  const [lbIndex, setLbIndex] = useState(0)
  const [lbFrozen, setLbFrozen] = useState(null)

  // Stable flat order = full list sorted by created_at DESC (newest first). The Lightbox `images`
  // array and every tile's flat index both derive from THIS order, so a tapped tile maps 1:1 to
  // its Lightbox slide regardless of which month section it lives in.
  const sorted = useMemo(() => {
    return [...photos].sort((a, b) => {
      const ta = a?.created_at ? Date.parse(a.created_at) : NaN
      const tb = b?.created_at ? Date.parse(b.created_at) : NaN
      const va = Number.isFinite(ta) ? ta : -Infinity  // undated sinks to the bottom
      const vb = Number.isFinite(tb) ? tb : -Infinity
      return vb - va
    })
  }, [photos])

  // BUG-PHOTOTHUMB-001 — window the FLAT list, then section it. Windowing each month's TileGrid
  // instead would bound each month but not the page (12 months x 24 > the 120 the API returns), so
  // the bound has to be applied before grouping. slice(0, shown) preserves indices, so flatIndex
  // below is still the index into the FULL sorted array and the Lightbox mapping is unchanged.
  const win = useImageWindow(sorted.length)
  const windowedPhotos = useMemo(() => sorted.slice(0, win.shown), [sorted, win.shown])

  // Month sections, preserving the sorted (newest-first) order. Each photo carries its flatIndex
  // so a tile knows where it lands in the Lightbox without a second lookup.
  const sections = useMemo(() => {
    const out = []
    let cur = null
    windowedPhotos.forEach((photo, flatIndex) => {
      const key = monthKey(photo?.created_at)
      if (!cur || cur.key !== key) {
        cur = { key, label: monthLabel(key), items: [] }
        out.push(cur)
      }
      cur.items.push({ ...photo, _flatIndex: flatIndex })
    })
    return out
  }, [windowedPhotos])

  // Lightbox images derive from the SAME sorted order, so lbIndex (a flat index) is valid.
  const lbImages = useMemo(
    () => sorted.map(p => ({ src: p?.view_url, photoId: p?.id, alt: p?.caption || 'Garden photo', caption: p?.caption || '' })),
    [sorted]
  )

  const openAt = useCallback((flatIndex) => {
    setLbFrozen(lbImages)   // freeze the slides at open so a revalidate can't reorder them under the open Lightbox
    setLbIndex(flatIndex)
    setLbOpen(true)
  }, [lbImages])

  if (loading) {
    return <p style={{ color: P.light, fontSize: '0.9rem', padding: '8px 0' }}>Loading photos…</p>
  }

  if (error) {
    return (
      <AsyncRegion
        error={photoLoadErrorMessage(error, 'your photos')}
        errorTitle="Couldn’t load your photos"
        onRetry={refetch}
      />
    )
  }

  if (photos.length === 0) {
    if (empty != null) return empty
    return (
      <div style={{ textAlign: 'center', padding: '48px 16px', color: P.light }}>
        <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📷</div>
        <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: P.mid }}>No photos yet</p>
        <p style={{ margin: '6px 0 0', fontSize: '0.82rem' }}>Snap or upload photos and they’ll show up here.</p>
      </div>
    )
  }

  return (
    <div data-testid={testId}>
      {sections.map(section => (
        <section key={section.key} aria-label={section.label} style={{ marginBottom: 20 }}>
          {/* Sticky month header. top:0 pins it under the scroll viewport as the user scrolls a
              tall wall; the Garden shell scrolls the document, so position:sticky is enough. */}
          <h2 style={{
            position: 'sticky', top: 0, zIndex: 2, margin: '0 0 10px',
            padding: '8px 2px', backgroundColor: P.cream,
            fontSize: '0.95rem', fontWeight: 700, color: P.green,
          }}>
            {section.label}
          </h2>
          <TileGrid
            items={section.items}
            columns={3}
            gap={6}
            ariaLabel={`${ariaLabelPrefix} ${section.label}`}
            renderItem={(photo) => (
              <PhotoTile photo={photo} onOpen={() => openAt(photo._flatIndex)}
                footer={renderTileFooter ? renderTileFooter(photo) : null} />
            )}
          />
        </section>
      ))}

      {win.hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
          <button type="button" onClick={win.showMore}
            style={{
              minHeight: 44, padding: '8px 18px', fontSize: '0.85rem', borderRadius: 8,
              border: `1px solid ${P.border}`, background: P.white, color: P.dark, cursor: 'pointer',
            }}>
            Show more ({win.remaining} left)
          </button>
        </div>
      )}

      <Lightbox
        open={lbOpen}
        images={lbFrozen ?? lbImages}
        index={lbIndex}
        onIndexChange={setLbIndex}
        onClose={() => { setLbOpen(false); setLbFrozen(null) }}
      />
    </div>
  )
}

// Square photo tile. aspect-ratio 1/1 keeps the wall a true grid of squares; the image is
// async-decoded and the wall is bounded by useImageWindow above (NOT by loading="lazy", which was
// measured to never fire here — 0 of 120 images requested, BUG-PHOTOTHUMB-001). The whole tile is
// a ≥44px button.
function PhotoTile({ photo, onOpen, footer }) {
  // Open photo {n} — 1-based flat position, a stable accessible label across all months.
  const n = (photo._flatIndex ?? 0) + 1
  const tile = (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open photo ${n}`}
      style={{
        display: 'block', width: '100%', aspectRatio: '1 / 1', minHeight: 44,
        padding: 0, border: `1px solid ${P.border}`, borderRadius: 8, overflow: 'hidden',
        background: P.greenPale, cursor: 'pointer',
      }}
    >
      {photo.view_url && (
        <PhotoImg
          photoId={photo.id}
          initialUrl={photo.view_url}
          alt={photo.caption || 'Garden photo'}
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      )}
    </button>
  )
  // No footer (the shipped Garden wall) → the tile IS the rendered node, byte-unchanged. A footer
  // renders as a SIBLING of the tile, never inside it: the tile is a <button>, and a nested
  // interactive control there would be invalid markup and unreachable by keyboard.
  if (!footer) return tile
  return (
    <>
      {tile}
      <div style={{ marginTop: 4 }}>{footer}</div>
    </>
  )
}
