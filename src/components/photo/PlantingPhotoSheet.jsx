// src/components/photo/PlantingPhotoSheet.jsx
// V4-PHOTOBULK-001 D4b — "several photos of THIS planting", in a box big enough to hold them.
//
// THIS EXISTS BECAUSE THE INLINE VERSION FAILED ON A PHONE. `multiple` was enabled directly on the
// planting card's camera button and reverted the same day: measured at 390x844, ten staged files
// grew the card from ~250px to 802px and pushed the NEXT planting card to y=905 — off an 844px
// screen, so one card staging photos consumed the whole Garden list. Capping the strip fixed the
// geometry and then the screenshot showed the real defect: the compact filename rows collided with
// the card's own status badge, because that footer is a flex row sized for a 34px circle.
//
// The capability was never the problem; the container was. A Sheet gives the staged strip a box of
// its own while leaving the trigger exactly where the user's hand already goes.
//
// WHY <Sheet> RATHER THAN A BESPOKE OVERLAY. Sheet already owns the parts that are easy to get
// wrong and invisible when you do: DismissRegistry registration, Back/Escape arbitration against
// whatever else is open, body-scroll locking, focus capture and restore, and safe-area insets. The
// QuickTagCarousel next door is deliberately NOT built on it — a full-screen photo deck would be
// boxed by a fly-up — but this one is a form, which is exactly Sheet's shape.
//
// NOTHING NEW ABOUT THE UPLOAD ITSELF. This is <PhotoUpload multiple> with the linkage the card
// already passed: same serial queue, same per-file status, same array-form onUploadComplete. The
// sheet contributes a container and a title, and that is the whole of the fix.

import React from 'react'
import Sheet from '../forms/Sheet.jsx'
import PhotoUpload from '../PhotoUpload.jsx'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'

export default function PlantingPhotoSheet({ open, onClose, planting, onUploaded }) {
  if (!planting) return null

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Add photos — ${planting.name}`}
      // `size="full"`: the staged strip is the content, and at the 10-file cap it wants two rows of
      // 88px tiles plus their status lines. A peek sheet would put the strip's own scrollbar inside
      // a sheet that is itself scrolling, which is the nested-scroll trap.
      size="full"
      armsBack
    >
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: T.space.sm }}>
        <p style={{ margin: 0, fontSize: T.type.sm, color: P.mid }}>
          {/* Says where they land. The whole reason this sheet exists is that the target is already
              chosen — unlike the Photo Library's batch, which has to ask. */}
          Everything you pick here attaches to {planting.name}.
        </p>

        <PhotoUpload
          keyPrefix="plants"
          parentId={planting.id}
          linkage={{ plant_id: planting.id, project_id: planting.project_id }}
          errorMode="surface"
          multiple
          buttonLabel="Choose photos"
          ariaLabel={`Choose photos for ${planting.name}`}
          // TRUE here, unlike the card. A sheet has room for thumbnails, and thumbnails are how you
          // tell which of ten near-identical shots of the same plant you meant to drop.
          showPreview
          // ...and having claimed the room, ACTUALLY GIVE IT TO THE STRIP. The strip's built-in cap
          // is a card-footer constant (216px) and it does not know it has been moved: measured at
          // 390x844 in a real browser, the shipped sheet hid 7 of 10 staged tiles behind an inner
          // scrollbar while 391px of screen sat empty above it — a nested scroll inside a panel that
          // was not scrolling at all, which is the exact trap size="full" was chosen to avoid. With
          // no cap the strip grows and the PANEL's own maxHeight/overflow is the single scroller.
          stripMaxHeight="none"
          inputId={`planting-sheet-photo-${planting.id}`}
          onUploadComplete={onUploaded}
          buttonStyle={{
            width: '100%', padding: '14px 16px', borderRadius: T.radiusButton,
            border: `2px dashed ${P.border}`, backgroundColor: P.white,
            color: P.mid, fontSize: T.type.base, fontWeight: 600,
            minHeight: T.tapMinHeight, cursor: 'pointer',
          }}
        />
      </div>
    </Sheet>
  )
}
