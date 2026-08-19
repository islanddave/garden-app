// V4-BATCHUNDO-001 — the confirm that gates the durable batch undo.
//
// WHAT IS AT STAKE HERE, in numbers measured on prod: Dave fires ~3.3 bulk logs a day averaging 30
// plantings, and the largest in the last 60 days wrote 157 rows. So this surface exists to fix an
// unrecoverable-mistake problem WITHOUT introducing a second one — a mis-tap that silently removes
// 157 entries would be a strictly worse defect than the one the feature closes. Hence: the count is
// in the body sentence AND on the button face, and the button that fires it is not the one the thumb
// lands on by default.
//
// THIS UNDO IS NOT RECOVERABLE FROM THE APP, and the copy says so plainly. That is not pessimism —
// it is checked: the events Lambda has no restore route, and src/lib/deletedEntities.js (which
// drives the Recently deleted page) covers projects, plantings, locations, varieties and photos and
// NOT events. PhotoDeleteConfirm can promise "restore it any time" because a restore genuinely
// exists; borrowing that reassurance here would be a false one, and a confirm that under-states its
// own consequence is the failure this component is built against.
//
// DISMISSAL GOES THROUGH <Sheet>, WHICH GOES THROUGH DismissRegistry — not a hand-rolled
// outside-click handler. The registry (context/DismissRegistry.jsx) is the app's single arbiter of
// Escape, Android Back, layer ordering and busy/dirty coordination across its consumers, and Dave is
// on Chrome/Android where Back is the primary dismissal gesture, not a nicety. `armsBack` is TRUE
// deliberately: this surface closes in place (it does not navigate), which is exactly the membership
// test in Sheet's header, and Back must dismiss it WITHOUT undoing anything.
//
// PRESENTATIONAL ONLY, like PhotoDeleteConfirm: no fetch, no cache invalidation, no toast. `busy`
// holds the sheet up with its controls disabled while the caller's DELETE is in flight rather than
// closing optimistically over a request that may fail, and `error` renders IN the sheet so a failed
// undo lands where the user is looking instead of behind a surface that just vanished.
import React from 'react'
import { P } from '../lib/constants.js'
import Sheet from './forms/Sheet.jsx'
import Button from './forms/Button.jsx'
import ErrorBanner from './forms/ErrorBanner.jsx'
import { formatDate } from '../lib/format.js'
import { prettyEventType } from '../lib/feed.js'

// "30 entries" / "1 entry". A count of exactly one is reachable (a batch can be logged against a
// single planting), and "1 entries" on a destructive button reads like a bug in the thing you are
// about to trust with 157 rows.
export function entriesPhrase(count) {
  return count === 1 ? '1 entry' : `${count} entries`
}

export default function BatchUndoConfirm({ open, batch = null, count = null, busy = false, error = null, onCancel, onConfirm }) {
  const known = Number.isFinite(count) && count > 0
  const type = prettyEventType(batch?.event_type ?? '') || 'bulk log'
  const when = formatDate(batch?.event_date)

  return (
    <Sheet
      open={!!open && !!batch}
      onClose={onCancel}
      title="Undo this bulk log?"
      closeLabel="Cancel"
      // `busy` while the DELETE is in flight: the registry swallows Escape/Back and Sheet no-ops the
      // backdrop tap, so a stray gesture cannot dismiss the sheet mid-write.
      busy={busy}
      armsBack
    >
      <div data-testid="batch-undo-body" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 16px 8px' }}>
        {error && <ErrorBanner data-testid="batch-undo-error">{error}</ErrorBanner>}

        {/* Identification. "Which bulk log is this" is load-bearing on a destructive surface — the
            feed can show several same-type batches from one afternoon and they are indistinguishable
            by type alone. */}
        <div style={{ border: `1px solid ${P.border}`, borderRadius: 10, padding: 12, backgroundColor: P.cream }}>
          <div data-testid="batch-undo-identity" style={{ color: P.dark, fontSize: '0.95rem', fontWeight: 700, textTransform: 'capitalize' }}>
            {type}{known ? ` · ${entriesPhrase(count)}` : ''}
          </div>
          {when && (
            <div style={{ color: P.light, fontSize: '0.82rem', marginTop: 2 }}>Logged {when}</div>
          )}
        </div>

        {/* THE COUNT SENTENCE. The number is stated in prose as well as on the button because the
            button face is what the thumb reads and the sentence is what the eye reads, and 157 is
            exactly the case where those must not disagree. The non-numeric arm is a genuine
            fallback, not decoration: every batch the list endpoint returns carries an exact
            item_count, so if that number is ever missing this must decline to invent one rather
            than render "removes 0 entries" over a real batch. */}
        <p style={{ margin: 0, color: P.mid, fontSize: '0.95rem', lineHeight: 1.45 }}>
          {known ? (
            <>This removes <strong data-testid="batch-undo-count" style={{ fontWeight: 700, color: P.dark }}>all {entriesPhrase(count)}</strong> logged in this batch.</>
          ) : (
            <>This removes <strong style={{ fontWeight: 700, color: P.dark }}>every entry</strong> logged in this batch.</>
          )}
          {' '}Watering, harvest and care history for those plantings goes back to what it was before.
        </p>

        <p style={{ margin: 0, color: P.terra, fontSize: '0.85rem', lineHeight: 1.45 }}>
          There is no way to put them back from the app — you would have to log them again.
        </p>

        {/* BUTTON ORDER IS A SAFETY DECISION, copied from PhotoDeleteConfirm / EventDeleteConfirm
            rather than re-argued: in a bottom sheet on a 390px Android screen the BOTTOM-most
            control is where the thumb rests, so the destructive action must not sit there. Stacked
            full-width with a real gap — never side by side, where one thumb-width separates a
            destructive target from a safe one. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* testids, not names: Sheet's own mandatory close control is ALSO labelled "Cancel"
              (closeLabel), so a by-name query resolves to two buttons and a test written against it
              silently asserts the wrong one. */}
          <Button data-testid="batch-undo-confirm" variant="danger" onClick={() => onConfirm?.()} loading={busy} loadingLabel="Undoing…" style={{ width: '100%' }}>
            {known ? `Undo ${entriesPhrase(count)}` : 'Undo this bulk log'}
          </Button>
          <Button data-testid="batch-undo-cancel" variant="secondary" onClick={onCancel} disabled={busy} style={{ width: '100%' }}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
