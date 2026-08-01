// src/components/SpaceHero.jsx — V4-SPACEPHOTO-001 Lane C. The SPACE specialization of the
// tier-agnostic PhotoHero shell. Sibling to planting/HeroPhoto.jsx: same shell, different slots.
//
// The shell owns the box, both scrims, the floating Back/Share and the no-photo CTA position;
// this file owns only the space chrome that fills those slots — the property NAME rendered as the
// page <h1> over the bottom scrim, and a no-photo prompt. Deliberately EMPTY where the planting
// hero is busy: no status picker, no crop pills, no favorite, no Details fly-up. A Space is a
// place, not a lifecycle; the identity photo is the whole point of the surface.
//
// Do NOT add a mode/variant prop to PhotoHero or PhotoImg to serve this — composition, not
// configuration, is the rule that let this file exist at all.
import React from 'react'
import { P } from '../lib/constants.js'
import Icon from './Icon.jsx'
import PhotoHero from './PhotoHero.jsx'

// P.onPhotoFg is the palette's on-photo ink; the rgba text-shadow mirrors HeroPhoto's (an
// intentional literal — an alpha ramp has no hex token, and this file is outside the no-hex scope).
const nameStyle = {
  margin: 0, color: P.onPhotoFg, fontSize: '1.4rem', fontWeight: 700,
  lineHeight: 1.2, wordBreak: 'break-word', textShadow: '0 1px 3px rgba(0,0,0,0.8)',
}

function BottomOverlay({ name, subtitle }) {
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 3,
      padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <h1 style={nameStyle}>{name}</h1>
      {subtitle && (
        <p style={{ margin: 0, color: P.onPhotoFg, fontSize: '0.8rem', fontWeight: 500,
          opacity: 0.9, textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
          {subtitle}
        </p>
      )}
    </div>
  )
}

export default function SpaceHero({ name, subtitle, src, photoId, onOpenImage, emptyState }) {
  const label = name || 'Your space'
  return (
    <PhotoHero
      src={src}
      photoId={photoId}
      alt={src ? `${label} feature photo` : ''}
      onOpenImage={src ? onOpenImage : undefined}
      openLabel={`View the ${label} feature photo`}
      shareTitle={label}
      shareLabel={`Share ${label}`}
      emptyState={emptyState ?? <DefaultNoPhoto />}
      overlay={<BottomOverlay name={label} subtitle={subtitle} />}
    />
  )
}

// Fallback CTA body when the caller supplies no richer empty state. The shell centers it.
function DefaultNoPhoto() {
  return (
    <>
      <Icon name="media.camera" size={56} decorative style={{ color: P.greenLight }} />
      <p style={{ margin: 0, color: P.mid, fontSize: '0.85rem', fontWeight: 600 }}>
        No feature photo yet
      </p>
    </>
  )
}
