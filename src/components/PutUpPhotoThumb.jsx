// PutUpPhotoThumb — V4-PUTUPPHOTO-001. Renders the photo attached to a put-up.
//
// preservation_log carries photo_id but the preservation Lambda does NOT resolve view URLs: doing
// so would mean copying photo-access.js + the S3 presign client into that function and granting it
// the photos bucket + SECRET/S3_PHOTOS_BUCKET env — an infra change for a thumbnail. Instead this
// resolves lazily against the EXISTING household-scoped GET /api/photos/view-url/:id, one call per
// photo, only for rows that actually have one. No Lambda change, no new deps, no new IAM.
//
// Presigned URLs expire (PHOTO_URL_TTL_SECONDS = 900s). These are short-lived list thumbnails, so a
// stale URL after 15 minutes on an idle screen is acceptable — the next load re-resolves. A failed
// resolve renders NOTHING rather than a broken-image glyph: the put-up record is the payload, the
// photo is garnish, and a broken thumb reads as data loss when none occurred.
import React, { useState, useEffect } from 'react'
import { P } from '../lib/constants.js'

export default function PutUpPhotoThumb({ photoId, fetch, size = 44, alt = 'Put-up photo', onOpen }) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    if (!photoId) { setUrl(null); return }
    let cancelled = false
    Promise.resolve(fetch(`/api/photos/view-url/${photoId}`))
      .then(d => { if (!cancelled && d?.view_url) setUrl(d.view_url) })
      .catch(() => { /* garnish, not payload — stay silent */ })
    return () => { cancelled = true }
  }, [photoId, fetch])

  if (!photoId || !url) return null

  const img = (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      style={{
        width: size, height: size, objectFit: 'cover', borderRadius: 6,
        border: `1px solid ${P.border}`, display: 'block', flexShrink: 0,
      }}
    />
  )

  if (!onOpen) return img
  return (
    <button type="button" onClick={() => onOpen(url)} aria-label={`${alt} — view larger`}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', lineHeight: 0, flexShrink: 0 }}>
      {img}
    </button>
  )
}
