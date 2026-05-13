// CritterImage — render a launch critter by slug.
// Looks up entries in src/data/critters-launch-5.json (the V1.2b launch 5).
// Falls back to a tier-colored placeholder card when the image asset is missing
// (covers offline / 404 / pre-art-load gracefully).
//
// Props:
//   slug:       string (required)  — critter slug (e.g., 'honeybee', 'lacewing')
//   shiny:      boolean             — render shiny_image_url if present
//   size:       number (default 64) — pixel side length (square)
//   className:  string               — optional pass-through
//   alt:        string               — optional explicit alt; otherwise composed from name/common_name
//   onClick:    fn                   — optional click handler
//
// Notes:
//   - Inline styles only (matches VarietyPicker.jsx + project convention — NOT Tailwind).
//   - Uses P palette + critter's tier_color accent.
//   - Placeholder card surfaces species common name + tier color so the UI still
//     reads as "a critter goes here" when art is missing.
//
// V3 path:
//   - This file resolves critters from a static JSON because V1.2b ships before the
//     critter_definitions table exists. When V3 schema lands, swap the lookup for
//     a hook like useCritter(slug) that reads from the DB-backed catalog.

import React, { useState } from 'react'
import crittersData from '../data/critters-launch-5.json'
import { P } from '../lib/constants.js'

// Index by slug at module-load time — O(1) lookups in render.
const BY_SLUG = Object.fromEntries(crittersData.map(c => [c.slug, c]))

export default function CritterImage({
  slug,
  shiny = false,
  size = 64,
  className,
  alt,
  onClick,
}) {
  const critter = BY_SLUG[slug]
  const [imgErr, setImgErr] = useState(false)

  if (!critter) {
    // Unknown slug — render a neutral missing-asset card so the UI doesn't crash.
    return (
      <div
        role="img"
        aria-label={alt || `Missing critter: ${slug}`}
        className={className}
        onClick={onClick}
        style={missingCardStyle(size)}
        title={`Unknown critter slug: ${slug}`}
      >
        <span style={{ fontSize: Math.max(10, size * 0.18), color: P.terra, fontWeight: 700 }}>
          ?
        </span>
      </div>
    )
  }

  const src = shiny && critter.shiny_image_url ? critter.shiny_image_url : critter.image_url
  const label = alt || `${critter.name} the ${critter.common_name}`

  // Image load failure → tier-colored placeholder card (does NOT throw).
  if (imgErr || !src) {
    return (
      <div
        role="img"
        aria-label={label}
        className={className}
        onClick={onClick}
        style={placeholderCardStyle(size, critter.tier_color)}
        title={`${critter.name} · ${critter.common_name}`}
      >
        <div style={{
          fontSize: Math.max(9, size * 0.13),
          fontWeight: 700,
          color: P.dark,
          textAlign: 'center',
          lineHeight: 1.1,
          padding: '0 6px',
          wordBreak: 'break-word',
        }}>
          {critter.common_name}
        </div>
        <div style={{
          marginTop: 4,
          width: Math.max(8, size * 0.22),
          height: Math.max(4, size * 0.06),
          borderRadius: 999,
          backgroundColor: critter.tier_color,
        }} />
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={label}
      width={size}
      height={size}
      className={className}
      onClick={onClick}
      onError={() => setImgErr(true)}
      style={imgStyle(size, onClick)}
      loading="lazy"
      draggable={false}
    />
  )
}

// ── Styles ─────────────────────────────────────────────────────────────

const imgStyle = (size, clickable) => ({
  width: size,
  height: size,
  objectFit: 'contain',
  borderRadius: Math.max(6, size * 0.08),
  cursor: clickable ? 'pointer' : 'default',
  userSelect: 'none',
  display: 'block',
})

const placeholderCardStyle = (size, tierColor) => ({
  width: size,
  height: size,
  borderRadius: Math.max(6, size * 0.08),
  border: `2px solid ${tierColor}`,
  backgroundColor: P.cream,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  boxSizing: 'border-box',
  cursor: 'default',
})

const missingCardStyle = (size) => ({
  width: size,
  height: size,
  borderRadius: Math.max(6, size * 0.08),
  border: `2px dashed ${P.terra}`,
  backgroundColor: P.cream,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxSizing: 'border-box',
})
