// src/components/PlantingTile.jsx
// V4-THEME-001 (V200 Pass B) — Slice 2. Photo-forward Garden Plants tile. Composes the SAME
// leaves PlantingRow used (FavoriteToggle, PlantStatusBadge, CritterSprite, PhotoUpload) so the
// row->tile swap loses no functionality; only the layout changes (row -> 4:3 photo card).
// Placed OUTSIDE src/components/forms/ so it is exempt from the frozen-barrel ships-dark test
// and the designsys no-hex/no-emoji lint scope; written P/T-token-based regardless. Tile photo
// opens the planting detail page (Variant A: picture = go in).
import React from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'
import { T } from './forms/formStyles.js'
import { formatQty } from '../lib/format.js'
import Icon from './Icon.jsx'
import FavoriteToggle from './FavoriteToggle.jsx'
import PlantStatusBadge from './PlantStatusBadge.jsx'
import CritterSprite from './CritterSprite.jsx'
import PhotoUpload from './PhotoUpload.jsx'
import CaretakerBadge from './CaretakerBadge.jsx'

// No-photo fallback (RES-2): neutral cream 4:3 swatch + a generic seedling SVG (shape, not
// color-only) + a "tap to add first photo" CTA. Species-agnostic: /api/plants carries no
// crop_family and per-crop illustrated art is a separate effort. Pragmatic NOW placeholder;
// upgrades cleanly to per-crop art by swapping SeedlingGlyph.
function SeedlingGlyph({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21V11" />
      <path d="M12 13C12 13 8 13 6 10C5 8.5 5 6 5 6C5 6 8 6 10 8C11.5 9.5 12 13 12 13Z" />
      <path d="M12 11C12 11 15 11 17 8.5C18 7 18 5 18 5C18 5 15.5 5 13.5 7C12.3 8.4 12 11 12 11Z" />
    </svg>
  )
}

export default function PlantingTile({
  planting: pl,
  critters = [],
  onSpriteLongPress = null,
  onSpriteIntersect = null,
  onPhotoUploaded = null,
  flashId = null,
  caretaker = null,
  onOpen = null,
}) {
  const variety = pl.variety_ref?.name
  const hasPhoto = Boolean(pl.featured_photo_view_url)
  // photo-count (option a, frontend-only): render ONLY when a count field is present; omit
  // otherwise. /api/plants does not return one today, so the chip is inert until an additive
  // COUNT lands -- forward-compatible with zero further frontend change.
  const photoCount = Number.isFinite(pl.photo_count) ? pl.photo_count : null

  return (
    <div
      data-testid="planting-tile"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: P.cream,
        border: `1px solid ${P.border}`,
        borderRadius: T.radiusCard,
        overflow: 'visible',
        animation: pl.id === flashId ? 'garden-newrow-highlight 1200ms ease' : undefined,
      }}
    >
      {/* V4-TAPCARD-001 -- whole-card tap target. A stretched Link covers the entire card at a
          low zIndex; it is a SIBLING of the controls (not an ancestor), so a tap navigates only
          where it lands on the link surface. Every interactive control is raised ABOVE it
          (Favorite z6, critters z5, PhotoUpload z2) so occlusion -- not stopPropagation -- keeps
          them operable. Sole carrier of the "Open {name}" accessible name (the photo box below was
          retagged from a Link to a plain div). Non-interactive body spans (name/variety/status/
          caretaker) stay under the overlay so tapping them opens the planting. */}
      <Link
        to={`/projects/${pl.project_id}/plantings/${pl.id}`}
        aria-label={`Open ${pl.name}`}
        data-testid="planting-tile-link"
        onClick={onOpen || undefined}
        style={{ position: 'absolute', inset: 0, zIndex: 1, borderRadius: T.radiusCard, textDecoration: 'none' }}
      />

      {/* MVP-Critter sprites -- same contract as PlantingRow. Peek above the tile's top-left,
          clear of the favorite corner (top-right) and the body below the photo. zIndex 5 so they
          sit above the card chrome but never block the photo link tap target. */}
      {critters.length > 0 && (
        <div style={{ position: 'absolute', top: 4, left: 8, right: 8, display: 'flex', flexWrap: 'wrap', gap: 2, zIndex: 5, pointerEvents: 'auto' }}>
          {critters.map(c => (
            <CritterSprite key={c.id} critter={c} onLongPress={onSpriteLongPress} onIntersect={onSpriteIntersect} spriteSize={22} />
          ))}
        </div>
      )}

      {/* PHOTO (4:3) box. V4-TAPCARD-001: retagged from <Link> to a plain <div> -- the stretched
          card overlay above now owns navigation + the "Open {name}" name. aspect-ratio reserves
          the box (no CLS). RES-4: single origin URL, loading=lazy + decoding=async. */}
      <div
        style={{
          position: 'relative',
          display: 'block',
          width: '100%',
          aspectRatio: '4 / 3',
          borderTopLeftRadius: T.radiusCard,
          borderTopRightRadius: T.radiusCard,
          overflow: 'hidden',
          backgroundColor: P.greenPale,
        }}
      >
        {hasPhoto ? (
          <img
            src={pl.featured_photo_view_url}
            sizes="(max-width: 720px) 50vw, 360px"
            alt=""
            loading="lazy"
            decoding="async"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
            backgroundColor: P.cream, color: P.greenLight, textAlign: 'center', padding: 8,
          }}>
            <SeedlingGlyph size={40} />
            <span style={{ fontSize: T.type.xs, fontWeight: 600, color: P.mid }}>Tap to add first photo</span>
          </div>
        )}

        {photoCount != null && photoCount > 0 && (
          <span
            aria-label={`${photoCount} ${photoCount === 1 ? 'photo' : 'photos'}`}
            style={{
              position: 'absolute', left: 6, bottom: 6,
              display: 'inline-flex', alignItems: 'center',
              fontSize: T.type.xs, fontWeight: 700, lineHeight: 1,
              color: P.white, backgroundColor: 'rgba(26,26,26,0.62)',
              borderRadius: T.radiusBadge, padding: '3px 7px',
            }}
          >
            {photoCount}
          </span>
        )}
      </div>

      {/* Favorite -- bare toggle in the TOP-RIGHT corner, on a soft cream scrim so the star reads
          on any photo. Outside the Link; FavoriteToggle stops propagation internally. */}
      <div style={{
        position: 'absolute', top: 4, right: 4, zIndex: 6,
        borderRadius: '50%', backgroundColor: 'rgba(248,245,240,0.82)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 36, height: 36,
      }}>
        <FavoriteToggle entityType="plant" entityId={pl.id} size="1.25rem" />
      </div>

      {/* BODY -- name (WRAPS, never ellipsis/crush) + qty + variety + lifecycle status badge +
          inline quick PhotoUpload (kept OUTSIDE the nav Link, same wire contract as the row). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{
            fontWeight: 600, color: P.dark, fontSize: T.type.base,
            overflowWrap: 'anywhere', wordBreak: 'break-word', lineHeight: 1.25,
          }}>
            {pl.name}
          </span>
          {pl.quantity > 1 && (
            <span style={{ fontSize: T.type.sm, color: P.green, fontWeight: 600, flexShrink: 0 }}>
              ×{formatQty(pl.quantity)}
            </span>
          )}
        </div>
        {variety && (
          <span style={{ fontSize: T.type.sm, color: P.mid, overflowWrap: 'anywhere' }}>{variety}</span>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {pl.status ? <PlantStatusBadge status={pl.status} /> : <span />}
            {caretaker && <CaretakerBadge caretaker={caretaker} size={18} />}
          </div>
          {/* V4-DESIGNSYS-001 (bite 3): ONE "Add photo" control (media.camera Icon) replaces the former
              dual take/choose emoji buttons — declutters the footer's competing-salience cluster and finishes
              the Garden emoji->Icon language. mode="single" + capture="" opens the native chooser (camera
              OR library on iOS; library-first on Android 13+), and PRESERVES the stable plant-list-photo-<id>
              input-id contract that automated bulk-attach sessions drive. ariaLabel names the icon-only
              control. V4-TAPCARD-001: raised above the stretched card overlay (z1) so it stays tappable. */}
          <span style={{ position: 'relative', zIndex: 2 }}>
          <PhotoUpload
            keyPrefix="plants"
            parentId={pl.id}
            linkage={{ plant_id: pl.id, project_id: pl.project_id }}
            errorMode="surface"
            mode="single"
            capture=""
            buttonLabel={<Icon name="media.camera" size={17} decorative style={{ color: P.mid }} />}
            ariaLabel="Add photo"
            showPreview={false}
            inputId={`plant-list-photo-${pl.id}`}
            onUploadComplete={onPhotoUploaded}
            buttonStyle={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 34, height: 34, padding: 0,
              background: 'transparent', color: P.mid,
              border: `1px solid ${P.border}`, borderRadius: '50%',
              cursor: 'pointer', fontSize: '0.9rem', userSelect: 'none',
            }}
          />
          </span>
        </div>
      </div>
    </div>
  )
}
