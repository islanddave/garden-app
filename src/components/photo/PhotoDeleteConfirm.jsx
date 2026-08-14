// V4-PHOTOREASSIGN-001 / W-PHOTODEL — the STANDALONE photo delete confirm.
//
// WHY THIS EXISTS. `DELETE /api/photos/:id` shipped with W-DEL and has been correct since: soft
// delete, hero pointers nulled atomically, restore from Recently deleted forever. But until this
// component the route had exactly TWO call sites in the whole SPA, and BOTH sat inside the
// event-delete flow (EventDetail + ProjectDetail). So a blurry shot, a duplicate, a picture of a
// thumb could only be removed by deleting the EVENT it hung off — destroying a real record of a real
// thing that happened in the garden in order to get rid of an image. That is the wrong primitive,
// and it is the surviving half of the row.
//
// A SECOND CONFIRM DIALECT WOULD BE THE OTHER FAILURE. EventDeleteConfirm already settled how this
// project confirms a destructive photo action — disclose the cover-photo consequence in a sentence
// that names the parent, say plainly that the delete is recoverable, put the destructive button
// ABOVE Cancel because Dave is on Android Chrome and the bottom of a fly-up is the thumb's home,
// compose the frozen Sheet rather than hand-rolling a dialog. This follows all of it. The
// differences are only where the SUBJECT differs: there is no opt-in checkbox here, because the
// photo is not a side effect of this delete — it IS the delete.
//
// WHAT IT MAY AND MAY NOT ASSERT — the honest-disclosure rule that shapes the copy.
// EventDeleteConfirm receives a COMPLETE `cover_for` from the events Lambda (eventPhotos.js
// enumerates featured_photo_id AND featured_image_id across all four cover entities), so its SILENCE
// is meaningful: no line means not a cover photo. This surface has no such source — GET /api/photos
// returns no cover data at all, and widening it is a Lambda change this lane may not make. The
// caller derives what it CAN see (see coverForPhoto in PhotoLibrary.jsx) and that derivation is
// partial by construction. So:
//   • A NAMED cover line is only ever rendered from real data, and it is a positive claim.
//   • The absence of a named cover line NEVER means "this is not a cover photo". The generic line
//     below is what stands in that case — it states the consequence without claiming to have
//     checked. Replacing it with silence would turn a partial check into a false all-clear, which
//     is the exact class of defect EventDeleteConfirm's header is about.
// If a future lane adds cover data to the photo list, the generic arm can be deleted and the
// silence made meaningful — that is the migration, and it is a strict improvement, not a rewrite.
//
// PRESENTATIONAL ONLY, like its sibling: no fetch, no cache invalidation, no toast. `busy` keeps the
// sheet up and its controls disabled while the caller's DELETE is in flight rather than closing
// optimistically over a request that may fail, and `error` renders IN the sheet so a failure lands
// where the user is looking instead of behind a surface that just vanished.
import React from 'react'
import { P } from '../../lib/constants.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import ErrorBanner from '../forms/ErrorBanner.jsx'
import PhotoView from './PhotoView.jsx'
import { TIER } from '../../lib/photoModel.js'
import { coverNames } from './EventDeleteConfirm.jsx'

// coverNames is IMPORTED from EventDeleteConfirm, not re-implemented. "A, B and 2 more" is the
// disclosure's readability contract at 390px, and a second spelling of it is a second thing to
// drift — the two confirms must not disagree about how many parents get spelled out. (Import only:
// that file is the event-delete surface and is not modified by this lane.)

// The identification line. Two byte-identical photos of the same tomato is the incident that started
// the whole photo-delete lane, so "which photo is this" is load-bearing on a DESTRUCTIVE surface,
// not decoration — and the sheet covers the bottom of the modal that was showing it.
function PhotoIdentity({ photo }) {
  const tile = { width: 56, height: 56, objectFit: 'cover', borderRadius: 8, flexShrink: 0, backgroundColor: P.cream }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {/* PhotoView, never a bare <img>: the tier degrade and the 900s presign re-mint belong to the
          primitive (photoPrimitive / noBareViewUrlImg). A photo whose presign failed renders nothing
          and the row still reads — a worse preview, never a blocked delete. */}
      <PhotoView photo={photo} tier={TIER.THUMB} alt={photo?.caption || 'Photo to delete'} style={tile} />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: P.dark, fontSize: '0.92rem', fontWeight: 600, overflowWrap: 'anywhere' }}>
          {photo?.caption || 'Untitled photo'}
        </div>
        {photo?.project_name && (
          <div style={{ color: P.light, fontSize: '0.8rem', marginTop: 2, overflowWrap: 'anywhere' }}>
            {photo.project_name}
          </div>
        )}
      </div>
    </div>
  )
}

function ConfirmBody({ photo, coverFor, sharingEnabled, busy, error, onCancel, onConfirm }) {
  const covers = coverFor.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean)

  return (
    <div data-testid="photo-delete-body" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 16px 8px' }}>
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <PhotoIdentity photo={photo} />

      {/* RECOVERY FIRST, and stated as a fact rather than a reassurance. This is what lets a
          destructive control carry proportionate instead of maximal friction: forgiveness here is
          durable (no expiry, no 5-second window), and the page that makes it true already exists and
          is linked from the Photos header. */}
      <p style={{ margin: 0, color: P.mid, fontSize: '0.95rem', lineHeight: 1.45 }}>
        It moves to <strong style={{ fontWeight: 700 }}>Recently deleted</strong>. Nothing is removed
        permanently — restore it from there any time.
      </p>

      <div
        style={{
          border: `1px solid ${P.border}`,
          borderRadius: 10,
          padding: 12,
          backgroundColor: P.cream,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {covers.length > 0 ? (
          <p data-testid="cover-disclosure" style={{ margin: 0, color: P.bannerInk, fontSize: '0.85rem', lineHeight: 1.45 }}>
            {`This photo is the cover photo for ${coverNames(covers)}. Deleting it clears that cover — restoring the photo puts it back unless something else has taken the spot.`}
          </p>
        ) : (
          // See the header: this is NOT "we checked and it is clear". It is the consequence stated
          // without a claim to have checked, which is the only honest thing to say from a surface
          // that cannot see every cover pointer.
          <p data-testid="cover-disclosure-generic" style={{ margin: 0, color: P.bannerInk, fontSize: '0.85rem', lineHeight: 1.45 }}>
            If this photo is the cover photo anywhere, that cover is cleared until you restore it.
          </p>
        )}

        {/* share_log.photo_id is a RETAIN pointer, not a null-on-delete one (lambda/photos/
            photoDelete.js PHOTO_POINTERS): a soft delete inside this app cannot retract a post
            already made to an external Facebook Page, so erasing the local record of it would make
            the ledger lie. Say the true thing instead. Gated on the share feature being configured
            at all — an unconditional Facebook sentence on every photo delete is noise for a user who
            has never shared anything. */}
        {sharingEnabled && (
          <p data-testid="share-disclosure" style={{ margin: 0, color: P.light, fontSize: '0.8rem', lineHeight: 1.45 }}>
            Deleting it here does not remove it from anywhere you have already shared it.
          </p>
        )}
      </div>

      {/* BUTTON ORDER IS A SAFETY DECISION, copied deliberately from EventDeleteConfirm rather than
          re-argued: in a bottom sheet on a 390px Android screen the BOTTOM-most control is the one
          the thumb reaches by default, so the destructive action must not sit there. Stacked
          full-width with a real gap — never side by side, where one thumb-width separates a
          destructive target from a safe one. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* testids, not names: Sheet's own mandatory close control is ALSO labelled "Cancel"
            (closeLabel), so a by-name query resolves to two buttons and a test written against it
            silently asserts the wrong one. */}
        <Button data-testid="photo-delete-confirm" variant="danger" onClick={() => onConfirm?.()} loading={busy} loadingLabel="Deleting…" style={{ width: '100%' }}>
          Delete photo
        </Button>
        <Button data-testid="photo-delete-cancel" variant="secondary" onClick={onCancel} disabled={busy} style={{ width: '100%' }}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export default function PhotoDeleteConfirm({
  open,
  photo = null,
  coverFor = [],
  sharingEnabled = false,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}) {
  // Sheet returns null when closed, so the body unmounts on close — the same property
  // EventDeleteConfirm relies on to keep its default single-spelling. Nothing here is stateful, but
  // the `photo &&` guard keeps a mid-close render from reaching into a null photo.
  return (
    <Sheet open={!!open && !!photo} onClose={onCancel} title="Delete this photo?" busy={busy} closeLabel="Cancel">
      <ConfirmBody
        photo={photo}
        coverFor={coverFor}
        sharingEnabled={sharingEnabled}
        busy={busy}
        error={error}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </Sheet>
  )
}
