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
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import TileGrid from './forms/TileGrid.jsx'
import Lightbox from './Lightbox.jsx'

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

export default function PhotosWall() {
  const { fetch } = useApiFetch()
  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Lightbox state: lbIndex is the FLAT index across all months into the sorted full list.
  const [lbOpen, setLbOpen] = useState(false)
  const [lbIndex, setLbIndex] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetch('/api/photos') ?? []
      setPhotos(Array.isArray(data) ? data : [])
    } catch (err) {
      setPhotos([])
      setError(err)
    }
    setLoading(false)
  }, [fetch])

  useEffect(() => { load() }, [load])

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

  // Month sections, preserving the sorted (newest-first) order. Each photo carries its flatIndex
  // so a tile knows where it lands in the Lightbox without a second lookup.
  const sections = useMemo(() => {
    const out = []
    let cur = null
    sorted.forEach((photo, flatIndex) => {
      const key = monthKey(photo?.created_at)
      if (!cur || cur.key !== key) {
        cur = { key, label: monthLabel(key), items: [] }
        out.push(cur)
      }
      cur.items.push({ ...photo, _flatIndex: flatIndex })
    })
    return out
  }, [sorted])

  // Lightbox images derive from the SAME sorted order, so lbIndex (a flat index) is valid.
  const lbImages = useMemo(
    () => sorted.map(p => ({ src: p?.view_url, alt: p?.caption || 'Garden photo', caption: p?.caption || '' })),
    [sorted]
  )

  const openAt = useCallback((flatIndex) => {
    setLbIndex(flatIndex)
    setLbOpen(true)
  }, [])

  if (loading) {
    return <p style={{ color: P.light, fontSize: '0.9rem', padding: '8px 0' }}>Loading photos…</p>
  }

  if (error) {
    return (
      <div role="alert" style={{ textAlign: 'center', padding: '40px 16px', background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 10 }}>
        <div style={{ fontSize: '2.2rem', marginBottom: 10 }}>⚠️</div>
        <p style={{ margin: 0, fontSize: '0.92rem', color: P.dark, fontWeight: 600 }}>Couldn’t load your photos</p>
        <p style={{ margin: '6px 0 14px', fontSize: '0.82rem', color: P.mid }}>
          {(error?.status == null || error.status >= 500)
            ? 'The photo service had a problem — usually temporary. Please retry.'
            : 'Something went wrong loading your photos.'}
        </p>
        <button type="button" onClick={load} style={{ minHeight: 44, padding: '8px 18px', fontSize: '0.85rem', borderRadius: 8, border: `1px solid ${P.alertBorder}`, background: P.white, color: P.dark, cursor: 'pointer' }}>Retry</button>
      </div>
    )
  }

  if (photos.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 16px', color: P.light }}>
        <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📷</div>
        <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: P.mid }}>No photos yet</p>
        <p style={{ margin: '6px 0 0', fontSize: '0.82rem' }}>Snap or upload photos and they’ll show up here.</p>
      </div>
    )
  }

  return (
    <div data-testid="photos-wall">
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
            ariaLabel={`Photos from ${section.label}`}
            renderItem={(photo) => (
              <PhotoTile photo={photo} onOpen={() => openAt(photo._flatIndex)} />
            )}
          />
        </section>
      ))}

      <Lightbox
        open={lbOpen}
        images={lbImages}
        index={lbIndex}
        onIndexChange={setLbIndex}
        onClose={() => setLbOpen(false)}
      />
    </div>
  )
}

// Square photo tile. aspect-ratio 1/1 keeps the wall a true grid of squares; the image is
// lazy + async-decoded so a long wall stays cheap without virtualization (a future enhancement
// if libraries ever balloon past a few hundred photos). The whole tile is a ≥44px button.
function PhotoTile({ photo, onOpen }) {
  // Open photo {n} — 1-based flat position, a stable accessible label across all months.
  const n = (photo._flatIndex ?? 0) + 1
  return (
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
        <img
          src={photo.view_url}
          alt={photo.caption || 'Garden photo'}
          loading="lazy"
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      )}
    </button>
  )
}
