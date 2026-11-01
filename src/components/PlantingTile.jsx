// src/components/PlantingTile.jsx
// Photo-forward Garden Plants tile (4:3 photo card). Composes the SAME leaves PlantingRow used
// (FavoriteToggle, PlantStatusBadge, CritterSprite, PhotoUpload), so only the layout differs from the
// row. Placed OUTSIDE src/components/forms/ so it is exempt from the frozen-barrel ships-dark test
// and the designsys no-hex/no-emoji lint scope; written P/T-token-based regardless. The tile photo
// opens the planting detail page.
import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'
import { T } from './forms/formStyles.js'
import { formatQty } from '../lib/format.js'
import Icon from './Icon.jsx'
import FavoriteToggle from './FavoriteToggle.jsx'
import PlantStatusBadge from './PlantStatusBadge.jsx'
import CritterSprite from './CritterSprite.jsx'
import PhotoUpload from './PhotoUpload.jsx'
import PlantingPhotoSheet from './photo/PlantingPhotoSheet.jsx'
import PhotoView from './photo/PhotoView.jsx'
import { TIER } from '../lib/photoModel.js'
import CaretakerBadge from './CaretakerBadge.jsx'
import { CRITTERS_QUIET } from '../lib/featureFlags.js'

// No-photo fallback: neutral cream 4:3 swatch + a generic seedling SVG (shape, not color-only) + a
// "tap to add first photo" CTA. Species-agnostic: /api/plants carries no crop_family. Swap
// SeedlingGlyph to upgrade to per-crop art.
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
  // The batch sheet's open state. Local to the card: a shared one would need the caller to track
  // which planting it belongs to.
  const [sheetOpen, setSheetOpen] = useState(false)
  const variety = pl.variety_ref?.name
  const hasPhoto = Boolean(pl.featured_photo_view_url)

  // V4-PHOTOUI-001 — call-site adapter onto the mandated PhotoView primitive.
  //
  // A PLANTING IS NOT A PHOTO, and the difference is load-bearing: photoModel reads `raw.id`, and a
  // planting's `id` is the PLANT id. Passing `photo={pl}` straight through would hand PhotoImg the
  // plant id as its photoId and re-point the presign self-heal at /api/photos/view-url/<plantId>, a
  // 404 and a permanent blank the first time a URL expires, with no symptom any static or jsdom
  // test could see. Hence the explicit remap.
  //
  // NOT the resolveById arm: /api/plants presigns, so the URL is already in hand. photoModel maps
  // featured_photo_view_url to the FULL source and featured_photo_thumb_url to the THUMB, so
  // tier=THUMB yields a two-entry chain and PhotoView renders `initialUrl` with no per-tile mount
  // fetch. That matters here: this tile renders 24-at-a-time in a windowed Garden grid.
  // plant_id is the photo's real parent (the featured photo is auto-promoted from this plant's own
  // photos); PhotoView does not read parentage, but a fabricated orphan would be a lie in the model.
  const photo = React.useMemo(() => (hasPhoto ? {
    id: pl.featured_photo_id ?? null,
    featured_photo_view_url: pl.featured_photo_view_url,
    featured_photo_thumb_url: pl.featured_photo_thumb_url ?? null,
    plant_id: pl.id,
  } : null), [hasPhoto, pl.featured_photo_id, pl.featured_photo_view_url, pl.featured_photo_thumb_url, pl.id])
  // photo-count: render ONLY when a count field is present; omit otherwise. /api/plants does not
  // return one today, so the chip is inert until an additive COUNT lands.
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
      {/* V4-TAPCARD-001 -- whole-card tap target. A stretched Link covers the entire card at a low
          zIndex; it is a SIBLING of the controls (not an ancestor), so a tap navigates only where it
          lands on the link surface. Every interactive control is raised ABOVE it (Favorite z6,
          critters z5, PhotoUpload z2) so occlusion -- not stopPropagation -- keeps them operable.
          Sole carrier of the "Open {name}" accessible name. Non-interactive body spans (name/
          variety/status/caretaker) stay under the overlay so tapping them opens the planting. */}
      <Link
        // Link DIRECT, not through the /projects redirect shim: the shim lands in the right place
        // but the project id is visible in the address bar for the hop. The shim route stays
        // registered for old bookmarks.
        to={`/plantings/${pl.id}`}
        aria-label={`Open ${pl.name}`}
        data-testid="planting-tile-link"
        onClick={onOpen || undefined}
        style={{ position: 'absolute', inset: 0, zIndex: 1, borderRadius: T.radiusCard, textDecoration: 'none' }}
      />

      {/* MVP-Critter sprites -- same contract as PlantingRow. Peek above the tile's top-left, clear
          of the favorite corner (top-right) and the body below the photo. zIndex 5 so they sit above
          the card chrome but never block the photo link tap target.

          V4-CRITTERQUIET-001: under CRITTERS_QUIET the strip still MOUNTS -- each CritterSprite
          renders as an invisible viewport sentinel so the per-critter mark-viewed contract
          (onIntersect -> Garden seenIdsRef -> actually_seen_critter_ids) is unchanged; see the note
          in CritterSprite.jsx for why dropping the strip is a data change, not a visual one. The
          strip loses its stacking context (zIndex 5 -> 0) and its pointerEvents, so an invisible
          22px band cannot sit above, or steal a tap from, the stretched card link. */}
      {critters.length > 0 && (
        <div style={{
          position: 'absolute', top: 4, left: 8, right: 8,
          display: 'flex', flexWrap: 'wrap', gap: 2,
          zIndex: CRITTERS_QUIET ? 0 : 5,
          pointerEvents: CRITTERS_QUIET ? 'none' : 'auto',
        }}>
          {critters.map(c => (
            <CritterSprite
              key={c.id}
              critter={c}
              onLongPress={CRITTERS_QUIET ? null : onSpriteLongPress}
              onIntersect={onSpriteIntersect}
              spriteSize={22}
              quiet={CRITTERS_QUIET}
            />
          ))}
        </div>
      )}

      {/* PHOTO (4:3) box. A plain div, not a Link: the stretched card overlay above owns navigation
          and the "Open {name}" name. aspect-ratio reserves the box (no CLS). Single origin URL,
          decoding=async. NO loading="lazy" (BUG-PHOTOTHUMB-001: 0 of 120 images were ever requested
          with it); the tile count is instead bounded by TileGrid's windowSize on the Garden grids.

          V4-PERFTHEMEA-001 — tier=THUMB, not FULL. This box is ~180 CSS px wide; originals average
          2.97 MB against 163 KB for their thumbs/ derivative (18.7x). A few featured heroes have no
          thumb; PhotoView's degrade chain falls onto featured_photo_view_url, already in hand from the
          same list response, so recovering costs one 404 and NO extra round-trip. */}
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
          <PhotoView
            photo={photo}
            tier={TIER.THUMB}
            sizes="(max-width: 720px) 50vw, 360px"
            alt=""
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
            // role="img" (V4-A11YGATE-001): without it the span is role=generic and the label is
            // discarded, so the badge announces the bare digit with no noun.
            role="img"
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

      {/* Favorite -- bare toggle in the TOP-RIGHT corner, on a soft cream scrim so the star reads on
          any photo. Outside the Link; FavoriteToggle stops propagation internally. */}
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
          {/* ONE "Add photo" control (media.camera Icon); ariaLabel names the icon-only control.
              PhotoUpload has exactly one behaviour: open the native chooser, never the camera. The
              stable plant-list-photo-<id> input-id contract that automated bulk-attach sessions drive
              is UNCHANGED. V4-TAPCARD-001: raised above the stretched card overlay (z1) so it stays
              tappable.

              V4-PHOTOBULK-001 D4b — the batch path is a SHEET, and this button opens it. Do NOT put
              `multiple` back on the PhotoUpload below: inline, ten staged files grew the card from
              ~250px to 802px (measured at 390x844 with tests/harness/photostrips.jsx) and pushed the
              next planting card off the screen, and the compact filename rows collided with this
              card's status badge because this footer is a flex row sized for a 34px circle. Neither
              half is reachable from a unit test (jsdom returns zero for every getBoundingClientRect).

              So the single-photo tap stays one pick straight to upload (the fastest path for the
              common case), and "several" gets its own box via PlantingPhotoSheet. */}
          <span style={{ position: 'relative', zIndex: 2 }}>
          <PhotoUpload
            keyPrefix="plants"
            parentId={pl.id}
            linkage={{ plant_id: pl.id, project_id: pl.project_id }}
            errorMode="surface"
            buttonLabel={<Icon name="media.camera" size={17} decorative style={{ color: P.mid }} />}
            // Label stays "Add photo": Garden.photoUpload.test.jsx pins it, and the button opening a
            // sheet does not make the name wrong. Pluralising is a copy decision.
            ariaLabel="Add photo"
            showPreview={false}
            inputId={`plant-list-photo-${pl.id}`}
            // The camera button opens the batch sheet. The component stays mounted so
            // `input#plant-list-photo-<id>` remains on every row and still uploads when driven
            // directly: the automated bulk-attach contract (Garden.photoUpload.test.jsx) is about the
            // INPUT, not the button.
            onTriggerClick={() => setSheetOpen(true)}
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

      <PlantingPhotoSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        planting={pl}
        onUploaded={(photos) => {
          setSheetOpen(false)
          // Multi mode hands back an ARRAY; the card's consumer (Garden's refetchPlants) ignores
          // its argument entirely, so it is forwarded unchanged rather than unwrapped.
          if (typeof onPhotoUploaded === 'function') onPhotoUploaded(photos)
        }}
      />
    </div>
  )
}
