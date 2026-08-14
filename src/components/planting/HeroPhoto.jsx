// src/components/planting/HeroPhoto.jsx — V200 Slice 5b photo hero, PLANTING specialization.
// The hero SHELL (container/scrims/Back/Share/no-photo box) now lives in the tier-agnostic
// PhotoHero; this file owns only the planting chrome it fills those slots with: the bottom overlay
// carrying the planting NAME (rendered AS the page <h1> so the heading role still resolves to the
// name), the lifecycle status picker, crop-type + gold key-fact pills, the Details pill that opens
// the tabbed Details fly-up (owned by the parent), the hero Favorite (entityType="plant"), and the
// no-photo per-crop-family illustrated placeholder + "add first photo" deep-link.
//
// Do NOT re-inline a shell here — one hero shell, specialized twice (planting + space).
import React from 'react'
import { OverlayLink } from '../../context/OverlayContext.jsx'
import { P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'
import FavoriteToggle from '../FavoriteToggle.jsx'
import StatusPicker from './StatusPicker.jsx'
import { formatQty } from '../../lib/format.js'
import { selectKeyFact, selectCropType, cropFamilyGlyph } from '../../lib/keyFact.js'
import PhotoHero, { HERO_FLOAT_BTN } from '../PhotoHero.jsx'

function BottomOverlay({ name, planting, keyFact, cropType, onOpenDetails, onStatusChanged }) {
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 3,
      padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h1 style={{ margin: 0, color: P.white, fontSize: '1.4rem', fontWeight: 700,
        lineHeight: 1.2, wordBreak: 'break-word', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
        {name}
      </h1>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* V4-STATUSTAP-001 — the status face is now the single tappable status control. */}
        <StatusPicker planting={planting} onStatusChanged={onStatusChanged} />
        {/* V4-PLANTQTY-001 — how many are in this planting, above the fold. The number was already
            rendered, but only inside the Details fly-up's Basics tab (PlantingDetail's
            `basicsRows`), which is a tap away from the page you are already looking at; "×6
            zucchini / ×30 basil" is a fact you read AT the planting, not one you go looking for.
            It stays in the fly-up too — that sheet is the complete record and duplicating one
            pill there is cheaper than orphaning the "Started with" row beside it.
            ×1 is HIDDEN, matching PlantingTile.jsx and forms/PlantingSelect.jsx: 123 of 258 live
            plantings are single, so rendering it would add a pill saying nothing to ~half of all
            planting pages. `> 1` on the raw value is deliberate — quantity is numeric(N,3) and
            arrives as the string "3.000", which the relational compare coerces, while null and
            undefined both fall through false. formatQty then rounds to the integer Dave asked
            for everywhere (Dave directive 2026-06-15). */}
        {planting?.quantity > 1 && (
          <span data-testid="hero-quantity" style={{ backgroundColor: 'rgba(255,255,255,0.92)', color: P.green,
            fontSize: '0.78rem', fontWeight: 700, padding: '4px 10px', borderRadius: 12, whiteSpace: 'nowrap' }}>
            ×{formatQty(planting.quantity)}
          </span>
        )}
        {/* V4-ABOVEFOLD-001 — crop TYPE above the fold (complements the key-fact pill). */}
        {cropType && (
          <span style={{ backgroundColor: 'rgba(255,255,255,0.92)', color: P.green, fontSize: '0.78rem',
            fontWeight: 700, padding: '4px 10px', borderRadius: 12, whiteSpace: 'nowrap' }}>
            {cropType}
          </span>
        )}
        {keyFact && (
          <span style={{ backgroundColor: P.warn, color: P.statusInkGold, fontSize: '0.78rem',
            fontWeight: 700, padding: '4px 10px', borderRadius: 12, whiteSpace: 'nowrap' }}>
            {keyFact}
          </span>
        )}
        <button type="button" onClick={onOpenDetails} aria-haspopup="dialog"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, backgroundColor: P.white,
            color: P.dark, border: 'none', borderRadius: 12, padding: '5px 12px', minHeight: 32,
            fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
          <Icon name="action.info" size={16} decorative style={{ color: P.dark }} />
          Details
        </button>
      </div>
    </div>
  )
}

// Per-crop-family illustrated placeholder + "add first photo" deep-link. Fills PhotoHero's
// no-photo CTA slot (PhotoHero owns the centered box; this is only its content).
function NoPhotoCta({ planting }) {
  return (
    <>
      <Icon name={cropFamilyGlyph(planting)} size={56} decorative style={{ color: P.greenLight }} />
      <OverlayLink to={`/log?project=${planting.project_id}&plant=${planting.id}`}
        aria-label="Add the first photo for this planting"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44,
          backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 10,
          padding: '0 16px', fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none' }}>
        <Icon name="media.camera" size={18} decorative surface="inverse" style={{ color: P.white }} />
        Tap to add first photo
      </OverlayLink>
    </>
  )
}

export default function HeroPhoto({ planting, src, photoId, alt, onOpenLightbox, onOpenDetails, onStatusChanged }) {
  const pl = planting || {}
  const name = pl.name || 'Planting'
  return (
    <PhotoHero
      src={src}
      photoId={photoId}
      alt={alt || `${name} photo`}
      onOpenImage={() => onOpenLightbox?.(0)}
      openLabel={`View ${name} photo`}
      shareTitle={name}
      shareLabel="Share this planting"
      actions={(
        <span style={{ ...HERO_FLOAT_BTN, color: P.white }}>
          <FavoriteToggle entityType="plant" entityId={pl.id} size="1.5rem" />
        </span>
      )}
      emptyState={<NoPhotoCta planting={pl} />}
      overlay={(
        <BottomOverlay name={name} planting={pl} keyFact={selectKeyFact(pl)} cropType={selectCropType(pl)}
          onOpenDetails={onOpenDetails} onStatusChanged={onStatusChanged} />
      )}
    />
  )
}
