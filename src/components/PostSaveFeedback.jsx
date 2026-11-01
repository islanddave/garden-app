import React from 'react'
import { P } from '../lib/constants.js'

// ── NON-BLOCKING post-save strip ──
// The form underneath stays mounted and live: a body-replacing card would cost a "Log another"
// dismissal per harvest, existing solely to undo the UI's own takeover.
// This component is the FEEDBACK ZONE only: rows 1-2 of the multi-row sticky band whose row 3
// (Done + Save) lives in EventNew, because Save was always there and Done must be present from mount
// even before any save.
//
// `inOverlay` is deliberately NOT a prop: the `inOverlay && confirmation` guard stays in EventNew as
// the RENDER DECISION.
//
// TWO VISUALLY SEPARATED ZONES (MANDATORY — not cosmetic). Row 1 is UTILITY: it carries the
// reversal of a write and must be reliably noticed. Row 2 is a REWARD SURFACE under gardening.md
// §Reward UX and must be ignorable — plain recessive static text, never a badge, never a count-up,
// never an entrance transition or colour pop (those channels are banned by name).
//
// LIFETIME — NO TIMER, EVER. The strip persists until the next save supersedes it or the overlay
// closes. Never dismissed on a timer, never cleared by typing: clearing on input would remove the
// undo path at exactly the moment the user realises the error. A timed toast is a race the user
// always loses. Do not reintroduce it.
//
// ZERO ANIMATION — not "respects prefers-reduced-motion", none at all. A moving element in
// the band the thumb is about to tap is a mis-tap hazard.
//
// Deliberately absent from the strip:
//   - View event / View planting links: a <Link> ends the burst this strip exists to protect.
//   - the large emoji block and the "for {projName}" sub-line: row 1 is single-line.
//   - a `preserve` prop: with the form live, BOTH PreserveOffer hosts would mount at once.
//     EventNew's form-body host covers every path, so this component does not host it.
//   - any focus effect — see the FOCUS note below.
//
// FOCUS: this component NEVER moves focus, on purpose. With the form live, moving focus makes "the
// form stays live" FALSE for keyboard and TalkBack users, and on Chrome Android a programmatic
// focus move can dismiss or re-raise the soft keyboard, jolting the band the user is about to tap.
//
// props:
//   confirmation {eventId,projectId,plantId,plantName,projName,eventLabel,eventEmoji,undone,error,photoError,
//                 photoFailCount,photoTotal}
//     photoFailCount/photoTotal — absent or <= 1 renders the singular sentence; a save can carry N
//     photos, and "The photo didn't upload" after three of five failed is a false report.
//   seasonLine        string | null — already carries its household-scope qualifier
//   savesThisSession  number — successful overlay saves this mount; count renders at >= 2
//   actions           {onUndo}
export default function PostSaveFeedback({ confirmation, seasonLine, savesThisSession, actions }) {
  const undone = !!confirmation.undone
  // The confirmation names the TARGET. plantId is
  // RESPONSE-sourced (the saved row's truth); plantName is the client-state label, so if it didn't
  // resolve the dash phrase is simply omitted rather than mislabeling the row.
  const targetPhrase = confirmation.plantId
    ? (confirmation.plantName ? ` — ${confirmation.plantName}` : '')
    : ' — no planting attached'
  const confirmText = undone
    ? `↩ Removed${confirmation.plantName ? ` — ${confirmation.plantName}` : ''}`
    : `✓ Logged ${confirmation.eventLabel}${targetPhrase}`

  // WCAG 2.5.3: the accessible name CONTAINS the visible label ("Undo") and adds the direct object.
  // Naming a specific record is the load-bearing channel that keeps Undo from being misread as
  // "leave the screen" — it is the only discriminator that works under time pressure, in peripheral
  // vision, and for a screen reader simultaneously.
  const undoName = `Undo — ${confirmation.plantName ?? confirmation.eventLabel}`

  const photoErr = confirmation.photoError && !undone ? confirmation.photoError : null
  const photoFailCount = confirmation.photoFailCount ?? 0
  const photoTotal = confirmation.photoTotal ?? 0
  const hasAlert = !!(confirmation.error || photoErr)
  // Threshold derived, not tuned. At n=1 a count merely restates the confirmation the user just
  // read; n=2 is the first value carrying information the confirmation does not. Reads a property
  // of the TASK (burst length), never identity.
  const showCount = savesThisSession >= 2
  const showSeason = !!seasonLine && !undone
  // An error and an ambient brag must never co-occupy — a season total beside a failed
  // undo reads as celebrating the failure. The alert REPLACES row 2.
  const showRow2 = !hasAlert && (showCount || showSeason)

  return (
    <div
      data-testid="post-save-strip"
      style={{
        backgroundColor: P.greenPale, borderTop: `1px solid ${P.greenLight}`,
        padding: '10px 12px 12px', boxSizing: 'border-box',
      }}
    >
      {/* ── row 1 — UTILITY. Confirmation truncates; Undo never shrinks.
             LOAD-BEARING, not stylistic: `flex: 1; minWidth: 0` + ellipsis on the text and
             `flex: 0 0 auto` on Undo keep an arbitrary plant name from ever pushing the row's
             min-content width past the viewport. ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* LIVE REGION — this node and NOTHING else. role="status" carries implicit
            aria-atomic="true", so the whole region re-announces on ANY change inside it. The season
            line (async arrival) or the count (changes every save) inside would re-read the entire
            confirmation mid-form. It is also the a11y expression of the two-zone split: the
            utility half is announced, the reward half is available-on-swipe but silent. */}
        <div
          role="status"
          aria-live="polite"
          style={{
            flex: 1, minWidth: 0, margin: 0, color: P.green, fontWeight: 700, fontSize: '0.92rem',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {confirmText}
        </div>
        {/* Undo sits OUTSIDE the live region. ToastContext puts its button inside role="status" —
            deliberately not copied: that leaves the user having heard about a control they must then
            hunt for. 44x44 visual, not hit-slop: the toast's ~28px sizing clears WCAG 2.5.8 AA only
            and fails 2.5.5 AAA plus this app's own 44px convention. Withdrawn once undone. */}
        {!undone && (
          <button
            type="button"
            onClick={actions.onUndo}
            aria-label={undoName}
            style={{
              flex: '0 0 auto',
              background: 'transparent', border: 'none', color: P.mid, fontWeight: 600,
              fontSize: '0.88rem', cursor: 'pointer', minHeight: 44, minWidth: 44,
              padding: '10px 12px', fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <span aria-hidden="true">↩</span> Undo
          </button>
        )}
      </div>

      {/* ── row 2 — REWARD SURFACE (ambient). Plain recessive static text. Outside the live region
             (both change asynchronously / per save). Rendered only when it has content. ── */}
      {showRow2 && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {showCount && (
            <p style={{ margin: 0, color: P.mid, fontSize: '0.8rem', fontWeight: 400 }}>
              {savesThisSession} logged this session
            </p>
          )}
          {showCount && showSeason && <span aria-hidden="true" style={{ color: P.light, fontSize: '0.8rem' }}>·</span>}
          {showSeason && (
            /* Season total. STATIC text, NOT a link — the strip's zero-link count is a pinned
               invariant. Hidden once undone: the just-logged harvest was removed, so the total
               would be stale. */
            <p style={{ margin: 0, color: P.mid, fontSize: '0.8rem', fontWeight: 400 }}>{seasonLine}</p>
          )}
        </div>
      )}

      {/* ── alert — SINGLE node holding BOTH failures. They can co-occur, and every test uses
             singular getByRole('alert'). Replaces row 2 when present.
             An undo failure is the one that must never be dropped: a swallowed DELETE 500 leaves the
             event alive while the user believes it is gone. ── */}
      {hasAlert && (
        <div role="alert" style={{ marginTop: 4, color: P.terra, fontSize: '0.8rem', fontWeight: 600 }}>
          {confirmation.error && <p style={{ margin: 0 }}>{confirmation.error}</p>}
          {/* The singular arm's text is pinned — EventNew.test.jsx and
              EventNewPostSaveFeedback.characterization.test.jsx both match /photo didn't upload/,
              which "photos didn't upload" would NOT satisfy. The plural arm is additive. */}
          {photoErr && (photoFailCount > 1
            ? <p style={{ margin: 0 }}>⚠️ {photoFailCount} of {photoTotal} photos didn&apos;t upload: {photoErr}</p>
            : <p style={{ margin: 0 }}>⚠️ The photo didn&apos;t upload: {photoErr}</p>)}
        </div>
      )}
    </div>
  )
}

// Action style — min 44pt touch target. EventNew's always-present `Done` imports it; the strip has
// no primary action.
export const confirmBtnGhost = { backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 8, padding: '10px 16px', minHeight: 44, fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
