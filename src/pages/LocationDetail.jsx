import React, { useState, useEffect } from 'react'
import { useCachedFetch } from '../hooks/useCachedFetch.js'
import { useParams, useNavigate } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import PhotoUpload from '../components/PhotoUpload.jsx'
import PhotoImg from '../components/PhotoImg.jsx'
import Spinner from '../components/forms/Spinner.jsx'

const EMPTY_LOC_PHOTOS = []   // stable ref while the cache is empty

// DEFERRED:
//   - Sub-location list (children of this location) → V2
//   - Edit/delete actions → V2 (currently managed from Locations list page)
//   - Full hierarchy breadcrumb (Space → Zone → Area → ...) → V2

function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>{children}</div>
    </div>
  )
}

export default function LocationDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { fetch } = useApiFetch()
  const [location, setLocation] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // V4-PHOTOLOCFIND-001: this space's gallery — ?location_id= walks the subtree server-side,
  // so a parent space also shows its descendants' photos.
  // V4-IMGCACHE-001 D-1: location photos through the SWR cache. `loadPhotos` (refetch) also fires from
  // onUploadComplete so the grid refreshes after an upload without a remount.
  const { data: locPhotos, loading: photosLoading, refetch: loadPhotos } = useCachedFetch(id ? `/api/photos?location_id=${id}` : null)
  const photos = locPhotos ?? EMPTY_LOC_PHOTOS

  useEffect(() => {
    let mounted = true
    fetch('/api/locations/' + id)
      .then(data => {
        if (!mounted) return
        setLocation(data)
        setLoading(false)
      })
      .catch(e => {
        if (!mounted) return
        setError(e.message ?? 'Location not found')
        setLoading(false)
      })
    return () => { mounted = false }
  }, [id, fetch])


  if (loading) return <Shell><Spinner block /></Shell>
  if (error) return (
    <Shell>
      <p style={{ color: P.terra, marginBottom: 12 }}>{error}</p>
      <button
        onClick={() => navigate('/locations')}
        style={{ background: P.white, border: `1px solid ${P.border}`, borderRadius: 8, color: P.green, cursor: 'pointer', fontSize: '0.9rem', fontWeight: 600, padding: '8px 14px' }}
      >
        ← All locations
      </button>
    </Shell>
  )

  return (
    <Shell>
      <Breadcrumb path={[{ label: 'Home', href: '/dashboard' }, { label: location.name, href: null }]} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 16 }}>
        <div>
          <h1 style={{ margin: '0 0 6px', color: P.green, fontSize: '1.4rem', fontWeight: 700 }}>
            {location.name}
          </h1>
        </div>
        <button
          onClick={() => navigate('/locations')}
          style={{ background: 'none', border: 'none', color: P.green, cursor: 'pointer', fontSize: '0.9rem', padding: 0 }}
        >
          ← All locations
        </button>
      </div>

      {location.description && (
        <div style={{
          background: P.white, border: `1px solid ${P.sage}`,
          borderRadius: 10, padding: '14px 18px', marginBottom: 20,
          fontSize: '0.9rem', color: P.dark, lineHeight: 1.6,
        }}>
          {location.description}
        </div>
      )}

      {location.is_active != null && (
        <div style={{
          background: P.white, border: `1px solid ${P.sage}`,
          borderRadius: 10, padding: '14px 18px',
          fontSize: '0.87rem', color: P.dark,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px' }}>
            <span style={{ color: P.light }}>Status</span>
            <span>{location.is_active ? 'Active' : 'Inactive'}</span>
          </div>
        </div>
      )}

      {/* ---- Location photos (V2-PHOTO-F1 Session 2) ---- */}
      <div style={{ marginTop: 28 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>
          Location photos
        </h2>
        <div style={{
          background: P.white, border: `1px solid ${P.sage}`,
          borderRadius: 10, padding: '14px 18px',
        }}>
          <p style={{ margin: '0 0 12px', fontSize: '0.85rem', color: P.mid }}>
            Add photos of this location — they appear in the Photo Library tagged with this location.
          </p>
          <PhotoUpload
            keyPrefix="locations"
            parentId={location.id}
            linkage={{ location_id: location.id }}
            errorMode="surface"
            mode="both"
            onUploadComplete={loadPhotos}
            inputId={`location-photo-${location.id}`}
          />
        </div>

        {/* Gallery (V4-PHOTOLOCFIND-001) — makes the upload promise above true: photos land here
            and in the Photo Library's space filter. Includes descendant spaces via the server walk. */}
        {photosLoading ? (
          <p style={{ margin: '14px 0 0', fontSize: '0.85rem', color: P.light }}>Loading photos…</p>
        ) : photos.length > 0 && (
          <div data-testid="location-photo-grid"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 14 }}>
            {photos.map(photo => (
              <div key={photo.id} style={{ position: 'relative', paddingBottom: '100%', backgroundColor: P.photoPlaceholder, borderRadius: 8, overflow: 'hidden', border: `1px solid ${P.border}` }}>
                {(photo.thumb_url || photo.view_url) && (
                  <PhotoImg
                    photoId={photo.id}
                    initialUrl={photo.thumb_url || photo.view_url}
                    fallback="none"
                    alt={photo.caption ?? 'Space photo'}
                    decoding="async"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Shell>
  )
}
