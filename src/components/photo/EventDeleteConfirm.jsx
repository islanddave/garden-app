// DD9 / W-EVTDEL — "the app does not guess about the cover photo. It discloses and offers."
//
// WHAT THIS REPLACES AND WHY. The original design blanket-CLEARED a parent's featured_photo_id
// whenever an event carrying a photo was deleted. Dave rejected it outright, and the measurement is
// why: over two months, 12 deleted events had photos, 11 of those photos are still live, and 0 are
// currently the cover photo of anything. The condition has arisen exactly ONCE. Meanwhile the
// deletions that DO recur are same-planting data fixes (delete Suyo Long, re-log Suyo Long) — which
// is exactly the case a blanket clear gets wrong. A rule that fires almost never, guesses when it
// does, and guesses against the odds. The decision moves to the moment the user actually knows the
// answer.
//
// THE CONTRACT, and each clause is load-bearing:
//   • UNCHECKED IS THE DEFAULT, and it must be asserted, not assumed. A checked default silently
//     inverts the entire decision — the app would be back to guessing, just with a checkbox drawn
//     on top of the guess.
//   • Unchecked == today's behaviour EXACTLY. Detach + re-parent per BUG-EVTCASCADE-001; the cover
//     pointer is untouched; no write, no guess.
//   • The checkbox appears whenever the event has a photo — NOT only when that photo is a cover
//     photo. "Sometimes I definitely do wanna delete the photo also" (Dave, 2026-08-12).
//   • When a photo IS a cover photo, the dialog NAMES the parent. That naming is the whole
//     disclosure: it converts defect D1 from silent to visible. D1 is NOT auto-fixed by this — a
//     wrongly-attached photo can still end up as a planting's face — but it becomes disclosed at
//     the moment of deletion and a two-tap fix afterwards. That is the accepted trade.
//
// WHY A COMPONENT AND NOT window.confirm: window.confirm cannot hold a checkbox. That is the entire
// reason this is a component change rather than a copy change. Composed from the frozen `Sheet`
// primitive per src/components/forms/FROZEN.md — compose, never hand-roll a dialog.
//
// RECOVERY FRAMING (DD8): the checked path routes through W-DEL's SOFT delete, so the photo is
// recoverable from Recently deleted, forever. The copy says so. This is what lets a destructive
// confirm carry proportionate rather than maximal friction — forgiveness is durable, so the dialog
// does not have to behave as though it is not.
//
// PRESENTATIONAL ONLY. It owns no fetch and no cache invalidation; the caller owns both. `busy`
// exists so the caller can keep the sheet up and the controls disabled while its own write is in
// flight rather than closing optimistically over a request that may fail.
import React, { useState } from 'react'
import { P } from '../../lib/constants.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'

// "A", "A and B", "A, B and 2 more" — a name list that stays readable at 390px and never becomes a
// wall of text. Naming the parent is the disclosure, so the first two names are always spelled out.
export function coverNames(names) {
  const n = names.filter(Boolean)
  if (n.length === 0) return ''
  if (n.length === 1) return n[0]
  if (n.length === 2) return `${n[0]} and ${n[1]}`
  return `${n[0]}, ${n[1]} and ${n.length - 2} more`
}

// THE CHECKBOX STATE LIVES IN A CHILD THAT ONLY EXISTS WHILE THE SHEET IS OPEN, and that is a
// correctness decision rather than a tidiness one. Sheet returns null when closed, so this body
// unmounts on close and remounts on open — which makes `useState(false)` the SINGLE, OBSERVABLE
// source of the default. Re-opening therefore resets the tick for free: a sticky tick is a checked
// default arriving one interaction later, and harder to see.
//
// The first version instead kept the state in the parent and reset it with
// `useEffect(() => { if (open) setDeletePhotos(false) }, [open])`. That reset MASKED the
// initializer: flipping it to `useState(true)` — the exact "a checked default silently inverts the
// whole decision" mutation the plan warns about — left every test GREEN, because the effect
// overwrote it before any assertion could see it. It also left one committed frame rendering a
// CHECKED box, since effects run after paint. Two spellings of one default, the load-bearing one
// unfalsifiable. Now there is a single spelling and a mutation to it is directly visible.
function ConfirmBody({ eventCount, photoCount, coverFor, busy, onCancel, onConfirm }) {
  const [deletePhotos, setDeletePhotos] = useState(false)

  const manyEvents = eventCount > 1
  const hasPhotos = photoCount > 0
  const manyPhotos = photoCount > 1
  const covers = coverFor.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean)

  const photoLabel = manyPhotos ? `Also delete all ${photoCount} photos` : 'Also delete the photo'

  // The consequence sentence. Present tense, concrete, and it changes with the checkbox — the user
  // reads what WILL happen given the choice currently made, not a generic warning.
  let coverLine = null
  if (hasPhotos && covers.length > 0) {
    const subject = manyPhotos ? 'These photos are the cover photo for' : 'This photo is the cover photo for'
    coverLine = deletePhotos
      ? `${subject} ${coverNames(covers)}. It will be removed from there.`
      : `${subject} ${coverNames(covers)}. It will stay there.`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 8 }}>
        <p style={{ margin: 0, color: P.mid, fontSize: '0.95rem', lineHeight: 1.45 }}>
          {manyEvents
            ? 'These log entries will be removed from the planting’s history.'
            : 'This log entry will be removed from the planting’s history.'}
        </p>

        {hasPhotos && (
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
            {/* 44px minimum target, and the LABEL wraps the input so the whole row is tappable —
                a bare 16px checkbox at 390px is the mis-tap this sheet exists to avoid. */}
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                minHeight: 44,
                cursor: 'pointer',
                fontSize: '0.95rem',
                color: P.dark,
                fontWeight: 600,
              }}
            >
              <input
                type="checkbox"
                checked={deletePhotos}
                disabled={busy}
                onChange={(e) => setDeletePhotos(e.target.checked)}
                style={{ width: 22, height: 22, accentColor: P.green, flexShrink: 0 }}
              />
              {photoLabel}
            </label>
            {coverLine && (
              <p data-testid="cover-disclosure" style={{ margin: 0, color: P.bannerInk, fontSize: '0.85rem', lineHeight: 1.45 }}>
                {coverLine}
              </p>
            )}
            <p style={{ margin: 0, color: P.light, fontSize: '0.8rem', lineHeight: 1.45 }}>
              {deletePhotos
                ? `${manyPhotos ? 'Deleted photos are' : 'A deleted photo is'} recoverable from Recently deleted.`
                : `${manyPhotos ? 'The photos stay' : 'The photo stays'} in your garden photos.`}
            </p>
          </div>
        )}

        {/* BUTTON ORDER IS A SAFETY DECISION, not a style one. Dave is on Android Chrome; in a
            bottom sheet the BOTTOM-most control is the one the thumb reaches most easily, so the
            destructive action must not sit there. Delete goes above, Cancel at the bottom (the iOS
            action-sheet arrangement, for the same reason), full-width and stacked with a real gap —
            never side by side, where a 390px row puts a destructive target one thumb-width from a
            safe one. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Button variant="danger" onClick={() => onConfirm?.({ deletePhotos })} loading={busy} loadingLabel="Deleting…" style={{ width: '100%' }}>
            {manyEvents ? `Delete ${eventCount} events` : 'Delete event'}
            {deletePhotos ? (manyPhotos ? ` and ${photoCount} photos` : ' and photo') : ''}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy} style={{ width: '100%' }}>
            Cancel
          </Button>
        </div>
    </div>
  )
}

export default function EventDeleteConfirm({
  open,
  eventCount = 1,
  photoCount = 0,
  coverFor = [],
  busy = false,
  onCancel,
  onConfirm,
}) {
  const title = eventCount > 1 ? `Delete these ${eventCount} events?` : 'Delete this event?'
  return (
    <Sheet open={open} onClose={onCancel} title={title} busy={busy} closeLabel="Cancel">
      <ConfirmBody
        eventCount={eventCount}
        photoCount={photoCount}
        coverFor={coverFor}
        busy={busy}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </Sheet>
  )
}
