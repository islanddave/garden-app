// src/components/photo/PhotoView.jsx — V4-PHOTOMODEL-001. THE photo primitive.
//
// One component, one way to render a photo. It COMPOSES <PhotoImg> rather than extending it:
// PhotoImg's contract is frozen at "owns the presigned-URL lifecycle, gains no tier prop", and
// tier/derivative selection is exactly the concern that was missing. PhotoView owns that half —
// which source to render and how to degrade — and delegates expiry self-healing downward.
//
// Split of responsibility:
//   photoModel.js  — WHAT a photo is (parents, sources, expiry)
//   PhotoView      — WHICH source to render, and the degrade chain
//   PhotoImg       — keeping that source's presigned URL alive (900s TTL re-mint)
//
// LAZY LOADING: `loading="lazy"` is BANNED app-wide (noNativeLazyImages.static.test.js, empty
// allow-list) because it was MEASURED not to fire — 120 images with correct srcs, 9 in viewport,
// 0 network requests (2026-07-27, live). Deferral here is done by bounding how many PhotoViews
// exist, via useImageWindow at the consumer. Adding the attribute here would make images silently
// stop loading, which is the failure this component exists to prevent.
import React, { useState, useCallback } from 'react'
import PhotoImg from '../PhotoImg.jsx'
import { toPhoto, sourceChain, TIER } from '../../lib/photoModel.js'

// photo  — a raw /api/photos row OR an already-canonical photo (toPhoto is idempotent)
// tier   — TIER.THUMB for grids/tiles, TIER.FULL for hero/lightbox/modal
// alt    — overrides the model's derived alt; pass "" for a decorative image
// Every other prop (style, className, decoding, data-testid, aria-*) forwards to PhotoImg, which
// forwards it to the <img> AND to its placeholder box, so layout never shifts between states.
export default function PhotoView({ photo, tier = TIER.FULL, alt, onOpen, onError, ...rest }) {
  // Index into the source chain. A thumb that fails degrades to the full original that came down in
  // the SAME list response — zero network, because a missing thumb is the expected case
  // (BUG-PHOTONEWTHUMB-001: only the 913 backfilled photos actually have one, yet thumb_url is a
  // non-empty presigned string on all 1094 rows, so its truthiness proves nothing).
  const [step, setStep] = useState(0)

  const p = toPhoto(photo)
  const chain = sourceChain(p, tier)

  // Reset the degrade cursor when the consumer swaps in a different photo (windowed grids and the
  // Lightbox both reuse one instance across ids). Render-time, matching PhotoImg's own adoption
  // idiom — an effect here would paint one frame of the previous photo's degraded source.
  const [prevId, setPrevId] = useState(p?.id ?? null)
  if ((p?.id ?? null) !== prevId) {
    setPrevId(p?.id ?? null)
    setStep(0)
  }

  const atLast = step >= chain.length - 1
  const source = chain[Math.min(step, chain.length - 1)] ?? null

  // Advance the chain on the FIRST failure of a non-final source. PhotoImg only re-mints when it is
  // given a photoId, so while a cheap in-hand degrade is still available we withhold it — that keeps
  // the missing-thumb case free of a network round-trip. On the final source we hand the id over and
  // PhotoImg's expiry self-heal takes charge.
  const handleError = useCallback((ev) => {
    onError?.(ev)
    setStep(s => (s + 1 < chain.length ? s + 1 : s))
  }, [onError, chain.length])

  if (!p || !source) return null

  return (
    <PhotoImg
      photoId={atLast ? p.id : undefined}
      initialUrl={source.url}
      alt={alt === undefined ? p.alt : alt}
      onOpen={onOpen}
      onError={handleError}
      {...rest}
    />
  )
}
