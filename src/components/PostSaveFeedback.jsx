import React from 'react'
import { P } from '../lib/constants.js'

// ── V4-HARVFEEDBACK-001 S5b: NON-BLOCKING post-save strip (spec s5b-strip-spec-V100-20260810) ──
// Supersedes the S5a body-replacing card (V4-LOGCONF-001 C1+C2). MEASURED on-device (harness at
// eeb7019): overlay costs 5N+1 taps for N harvests, full-page 4N+1 — the entire difference is the
// "Log another" dismissal, i.e. exactly 1 tap per harvest, existing solely to undo the UI's own
// takeover. Against a 5-tap-per-harvest baseline that is ~20% of the interaction.
// This component is now the FEEDBACK ZONE only: rows 1-2 of the multi-row sticky band whose row 3
// (Done + Save) lives in EventNew, because Save was always there and Done must be present from mount
// even before any save. The form underneath stays mounted and live.
//
// `inOverlay` is still deliberately NOT a prop: the `inOverlay && confirmation` guard stays in
// EventNew as the RENDER DECISION (S5a contract, unchanged).
//
// TWO VISUALLY SEPARATED ZONES (spec §1, MANDATORY — not cosmetic). Row 1 is UTILITY: it carries the
// reversal of a write and must be reliably noticed. Row 2 is a REWARD SURFACE under gardening.md
// §Reward UX and must be ignorable — plain recessive static text, never a badge, never a count-up,
// never an entrance transition or colour pop (those channels are banned by name).
//
// LIFETIME — NO TIMER, EVER. The strip persists until the next save supersedes it or the overlay
// closes. Never dismissed on a timer, never cleared by typing: clearing on input would remove the
// undo path at exactly the moment the user realises the error. V4-LOGCONF-001 earned this — the
// global toast was "a 5s race the user always loses". Do not reintroduce the race.
//
// ZERO ANIMATION (spec §6) — not "respects prefers-reduced-motion", none at all. A moving element in
// the band the thumb is about to tap is a mis-tap hazard.
//
// DROPPED HERE vs the S5a card, each deliberately (spec §4):
//   - View event   (§4.1) a <Link> ends the burst this slice exists to protect.
//   - View planting(§4.2) same; a real regression against shipped V4-VIEWPLANT-001, FLAGGED for Dave.
//   - the 2rem emoji block and the "for {projName}" sub-line (§8 budget: row 1 is single-line).
//   - the `preserve` prop (§4.5): with the form live, BOTH PreserveOffer hosts would mount at once.
//     EventNew's form-body host covers every path, so this component no longer hosts it at all.
//   - the confirmPhase-keyed focus effect + closeBtnRef — see the FOCUS note below.
//
// FOCUS: this component NEVER moves focus, and that is an INTENTIONAL CONTRACT REVERSAL, not drift.
// The S5a card pinned focus onto its Close button in two separate tests. That effect existed ONLY
// because the card replaced the sheet body. With the form live, moving focus makes "the form stays
// live" FALSE for keyboard and TalkBack users — the premise of the whole slice — and on Chrome
// Android a programmatic focus move can dismiss or re-raise the soft keyboard, jolting the band the
// user is about to tap. The effect, the ref, and the useRef import are deleted on purpose.
//
// props:
//   confirmation {eventId,projectId,plantId,plantName,projName,eventLabel,eventEmoji,undone,error,photoError}
//   seasonLine        string | null — already carries its household-scope qualifier (spec §4.3)
//   savesThisSession  number — successful overlay saves this mount (spec §7); count renders at >= 2
//   actions           {onUndo}
export default function PostSaveFeedback({ confirmation, seasonLine, savesThisSession, actions }) {
  const undone = !!confirmation.undone
  // V4-LOGTARGET-001 (carried forward verbatim): the confirmation names the TARGET. plantId is
  // RESPONSE-sourced (the saved row's truth); plantName is the client-state label, so if it didn't
  // resolve the dash phrase is simply omitted rather than mislabeling the row.
  const targetPhrase = confirmation.plantId
    ? (confirmation.plantName ? ` — ${confirmation.plantName}` : '')
    : ' — no planting attached'
  const confirmText = undone
    ? `↩ Removed${confirmation.plantName ? ` — ${confirmation.plantName}` : ''}`
    : `✓ Logged ${confirmation.eventLabel}${targetPhrase}`

  // Spec §5 / WCAG 2.5.3: the accessible name CONTAINS the visible label ("Undo") and adds the direct
  // object. Spec §3.1: naming a specific record is the load-bearing channel that keeps Undo from
  // being misread as "leave the screen" — it is the only discriminator that works under time
  // pressure, in peripheral vision, and for a screen reader simultaneously.
  const undoName = `Undo — ${confirmation.plantName ?? confirmation.eventLabel}`

  const photoErr = confirmation.photoError && !undone ? confirmation.photoError : null
  const hasAlert = !!(confirmation.error || photoErr)
  // Spec §7: threshold derived, not tuned. At n=1 a count merely restates the confirmation the user
  // just read; n=2 is the first value carrying information the confirmation does not. Reads a
  // property of the TASK (burst length), never identity — Jen on a 12-harvest day gets the count,
  // Dave logging one watering does not.
  const showCount = savesThisSession >= 2
  const showSeason = !!seasonLine && !undone
  // Spec §4.4: an error and an ambient brag must never co-occupy — a season total beside a failed
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
      {/* ── row 1 — UTILITY. Confirmation truncates; Undo never shrinks (spec §5).
             LOAD-BEARING, not stylistic: the harness measured the harvest row's min-content width at
             399px against a 390px viewport — this surface is ALREADY 9px horizontally overflowing on
             Dave's device (a separate pre-existing bug). `flex: 1; minWidth: 0` + ellipsis on the
             text and `flex: 0 0 auto` on Undo is what keeps this row from adding to it: an arbitrary
             plant name can never push the row's min-content width past the viewport. ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* LIVE REGION — this node and NOTHING else (spec §6). role="status" carries implicit
            aria-atomic="true", so the whole region re-announces on ANY change inside it. The season
            line (async arrival) or the count (changes every save) inside would re-read the entire
            confirmation mid-form. Already earned and written down in S5a — carried forward, not
            re-derived. It is also the a11y expression of the §1 split: the utility half is
            announced, the reward half is available-on-swipe but silent. */}
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
            hunt for. Geometry inherited from the S5a card VERBATIM (44x44 visual, not hit-slop):
            the toast's ~28px sizing clears WCAG 2.5.8 AA only and fails 2.5.5 AAA plus this app's own
            44px convention everywhere else. Withdrawn once undone. */}
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
            /* V4-HARVESTVIEW-001 S4a season total. STATIC text, NOT a link — the strip's zero-link
               count is a pinned invariant (rescoped from the card's B5 link count). Hidden once
               undone: the just-logged harvest was removed, so the total would be stale. */
            <p style={{ margin: 0, color: P.mid, fontSize: '0.8rem', fontWeight: 400 }}>{seasonLine}</p>
          )}
        </div>
      )}

      {/* ── alert — SINGLE node holding BOTH failures (spec §4.4/§6). They can co-occur, and every
             test uses singular getByRole('alert'). Replaces row 2 when present.
             V4-LOGCONF-001 undo failure is the one that must never be dropped: the full-page toast's
             undo is `.catch(() => {})`, so a DELETE 500 leaves the event alive while the toast
             expires and the user believes it is gone. ── */}
      {hasAlert && (
        <div role="alert" style={{ marginTop: 4, color: P.terra, fontSize: '0.8rem', fontWeight: 600 }}>
          {confirmation.error && <p style={{ margin: 0 }}>{confirmation.error}</p>}
          {photoErr && <p style={{ margin: 0 }}>⚠️ The photo didn&apos;t upload: {photoErr}</p>}
        </div>
      )}
    </div>
  )
}

// V4-LOGCONF-001 action style — min 44pt touch target. Kept here (rather than moving back to
// EventNew) so the S5a extraction boundary stays intact; EventNew's always-present `Done` imports it.
// confirmBtnPrimary went with the card's Close button — the strip has no primary action.
export const confirmBtnGhost = { backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 8, padding: '10px 16px', minHeight: 44, fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
