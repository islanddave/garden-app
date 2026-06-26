// V4-PLANTINGUI-001 — hero photo for the planting detail header. Full-width featured image
// (vs the old 64px thumbnail), graceful seed-emoji fallback when no photo. Current skin.
import React from 'react'
import { P } from '../../lib/constants.js'
import ZoomableImage from '../ZoomableImage.jsx'

export default function HeroPhoto({ src, alt }) {
  if (src) {
    return (
      <ZoomableImage
        src={src}
        alt={alt || 'Planting photo'}
        loading="lazy"
        style={{ width: '100%', maxHeight: 260, objectFit: 'cover', borderRadius: 12,
          border: `1px solid ${P.border}`, display: 'block' }}
      />
    )
  }
  return (
    <div aria-hidden="true" style={{ width: '100%', height: 140, display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: '3rem', backgroundColor: P.greenPale, borderRadius: 12,
      border: `1px solid ${P.border}` }}>🌱</div>
  )
}
