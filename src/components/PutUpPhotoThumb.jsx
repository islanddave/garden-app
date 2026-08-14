// PutUpPhotoThumb — V4-PUTUPPHOTO-001. Renders the photo attached to a put-up.
//
// preservation_log carries photo_id but the preservation Lambda does NOT resolve view URLs: doing so
// would mean copying photo-access.js + the S3 presign client into that function and granting it the
// photos bucket — an infra change for a thumbnail. Instead the id resolves lazily against the EXISTING
// household-scoped GET /api/photos/view-url/:id.
//
// A2b routed this through <PhotoImg>'s fetch-on-mount path (a photoId with no initialUrl mints once
// on mount) so the thumb inherited the self-heal / storm-dedup / concurrency / viewport-gate
// machinery for free — but rendering PhotoImg directly is exactly what the V4-PHOTOMODEL-001 drift
// guard bans, and this file sat on its allow-list solely because the primitive could not express an
// id-only photo. It can now: <PhotoView resolveById> runs the SAME PhotoImg mount-mint underneath,
// so the mechanism is unchanged (same endpoint, same cache, same one request per id) while this
// surface leaves the allow-list. `tier` is not passed on purpose — the id-only arm is tier-blind
// (view-url mints the original; no thumb derivative is addressable by id), and claiming a tier we
// do not get is the BUG-PHOTONEWTHUMB-001 mistake in miniature.
//
// fallback='none' keeps the silent-collapse contract: a missing/failed/pending photo renders NOTHING
// rather than a broken-image glyph — the put-up record is the payload, the photo is garnish, and a
// broken thumb reads as data loss when none occurred. (The legacy `fetch` prop the call sites pass is
// still unused — the resolve runs on the same household-scoped useApiFetch, one layer down.)
import React from 'react'
import { P } from '../lib/constants.js'
import PhotoView from './photo/PhotoView.jsx'

export default function PutUpPhotoThumb({ photoId, size = 44, alt = 'Put-up photo', onOpen }) {
  if (!photoId) return null
  return (
    <PhotoView
      photo={{ id: photoId }}
      resolveById
      fallback="none"
      alt={alt}
      onOpen={onOpen}
      width={size}
      height={size}
      style={{
        width: size, height: size, objectFit: 'cover', borderRadius: 6,
        border: `1px solid ${P.border}`, display: 'block', flexShrink: 0,
      }}
    />
  )
}
