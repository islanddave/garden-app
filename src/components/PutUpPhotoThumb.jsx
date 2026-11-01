// PutUpPhotoThumb — renders the photo attached to a put-up.
//
// preservation_log carries photo_id but the preservation Lambda does NOT resolve view URLs: doing so
// would mean copying photo-access.js + the S3 presign client into that function and granting it the
// photos bucket — an infra change for a thumbnail. Instead the id resolves lazily against the EXISTING
// household-scoped GET /api/photos/view-url/:id.
//
// <PhotoView resolveById> runs <PhotoImg>'s fetch-on-mount path (a photoId with no initialUrl mints
// once on mount), so the thumb inherits the self-heal / storm-dedup / concurrency / viewport-gate
// machinery (same endpoint, same cache, one request per id) without rendering PhotoImg directly,
// which the photo-primitive drift guard bans. `tier` is deliberately not passed: asking for a thumb
// would cost a second round-trip, not worth it for the handful of put-up rows on a page (unlike a
// big thumb grid). Omitting the tier resolves the original in exactly one request.
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
