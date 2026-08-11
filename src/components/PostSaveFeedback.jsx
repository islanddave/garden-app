import React, { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'

// ── V4-LOGCONF-001 (C1+C2): durable overlay confirmation — replaces the sheet body ──
// V4-HARVFEEDBACK-001 S5a: lifted VERBATIM out of EventNew.jsx (the `inOverlay && confirmation`
// early return). Extraction only — zero behaviour change; the whole point is to make the follow-on
// S5b independently revertible. `inOverlay` is deliberately NOT a prop: the `inOverlay &&
// confirmation` guard stays in EventNew as the RENDER DECISION, so this component never couples to
// the overlay-surface signal.
//
// Pattern copied from LogMany's proven result screen (:248-269). Overlay-only: the full-page
// branch keeps the global toast + always-visible form (see EventNew's handleSubmit). Dismissed ONLY
// by explicit action: Close (primary → dismiss overlay), View event + View planting (sibling
// secondaries, literal nouns — EventDetail / PlantingDetail from the POST response; the planting
// one renders only when the event has a plant_id — V4-VIEWPLANT-001), Log another (rapid entry,
// V3-EVENT-001 — the form is already reset underneath), Undo (tertiary: separated placement + icon
// + lighter weight, not color alone; ≥44pt). The action footer is sticky with
// env(safe-area-inset-bottom) ON the footer. (The visualViewport lift that used to be here went
// with V4-KBVIEWPORT-001: interactive-widget=resizes-content puts the layout viewport above the
// keyboard, so a sticky bottom:0 footer is already clear of it.)
//
// props:
//   confirmation {eventId,projectId,plantId,plantName,projName,eventLabel,eventEmoji,undone,error,photoError}
//   seasonLine   string | null
//   preserve     {Component,onOpen,onDismiss} | null — the V4-HARVESTCENTER-001 "preserve this?"
//                offer. INJECTED rather than imported: PreserveOffer is DOUBLE-HOSTED (here and in
//                EventNew's form body, which covers the full-page path and the post-"Log another"
//                form), and its single definition deliberately stays in EventNew.jsx. Importing it
//                from there would make this module circular with its own parent.
//   actions      {onUndo,onLogAnother,onClose}
export default function PostSaveFeedback({ confirmation, seasonLine, preserve, actions }) {
  const closeBtnRef = useRef(null)
  // Deliberate focus management (C1): when the card appears (and again when Undo lands), move focus
  // to the primary Close action. Keyed on the PHASE string, not the confirmation object, so an undo
  // FAILURE (error added, phase unchanged) never yanks focus away from the retryable Undo button.
  // (BUG-SOWFOCUS-001 class: never key a focus effect on an identity that changes per render.)
  // Moved here WITH the card in S5a — the ref belongs to the Close button, which lives here now.
  // Equivalent to its old home in EventNew: EventNew has no other .focus() call, so the child-runs-
  // before-parent effect ordering cannot lose a race it never had.
  const confirmPhase = confirmation ? (confirmation.undone ? 'undone' : 'logged') : null
  useEffect(() => {
    if (confirmPhase) closeBtnRef.current?.focus()
  }, [confirmPhase])

  const viewHref = (!confirmation.undone && confirmation.eventId)
    ? `/events/${confirmation.eventId}` : null
  // V4-VIEWPLANT-001: sibling secondary to View event, shown ONLY when the created event has a
  // planting (response plant_id). V4-UNSCOPEDROUTES-001: both links use the canonical un-scoped
  // routes, so they no longer require a projectId — the knock-on that made "View planting"
  // silently disappear for project-less plantings is closed.
  const viewPlantingHref = (!confirmation.undone && confirmation.plantId)
    ? `/plantings/${confirmation.plantId}` : null
  const PreserveOffer = preserve?.Component ?? null

  return (
    <div style={{ backgroundColor: P.cream, display: 'flex', flexDirection: 'column', minHeight: '45dvh' }}>
      <div style={{ maxWidth: 600, width: '100%', margin: '0 auto', padding: '24px 16px 8px', flex: 1, boxSizing: 'border-box' }}>
        <div style={{ backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 10, padding: 20, textAlign: 'center' }}>
          <div role="status" aria-live="polite">
            {confirmation.undone ? (
              <p style={{ margin: 0, fontWeight: 700, color: P.green, fontSize: '1.05rem' }}>
                <span aria-hidden="true">↩ </span>Event removed
              </p>
            ) : (
              <>
                <div style={{ fontSize: '2rem', lineHeight: 1, marginBottom: 8 }} aria-hidden="true">{confirmation.eventEmoji}</div>
                {/* V4-LOGTARGET-001: the confirmation names the TARGET, not just the project.
                    plantId is RESPONSE-sourced (the saved row's truth): planting attached → name
                    it; none → say so plainly. Static text on the existing card (Reward-UX ambient;
                    no new surface). plantName is the client-state label; if it didn't resolve the
                    dash phrase is simply omitted rather than mislabeling the row. */}
                <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.green, fontSize: '1.05rem' }}>
                  ✓ Logged {confirmation.eventLabel}
                  {confirmation.plantId
                    ? (confirmation.plantName ? ` — ${confirmation.plantName}` : '')
                    : ' — no planting attached'}
                </p>
                <p style={{ margin: 0, color: P.mid, fontSize: '0.85rem' }}>for {confirmation.projName}</p>
              </>
            )}
          </div>
          {/* V4-HARVESTVIEW-001 S4a: ambient season-total line (design §2). STATIC text, NOT a link
              — the card's link count is a pinned B5 invariant (EventNewOverlaySlice2). Outside the
              role=status region so it isn't re-announced when it arrives async. Hidden once undone
              (the just-logged harvest was removed, so the total would be stale). */}
          {seasonLine && !confirmation.undone && (
            <p style={{ margin: '10px 0 0', color: P.green, fontSize: '0.9rem', fontWeight: 600 }}>{seasonLine}</p>
          )}
          {confirmation.error && (
            <p role="alert" style={{ margin: '10px 0 0', color: P.terra, fontSize: '0.82rem', fontWeight: 600 }}>
              {confirmation.error}
            </p>
          )}
          {/* BUG-PHOTOUPLOADHANG-001: a swallowed photo failure must still be VISIBLE. Static
              text, NO link — the card's link count is a pinned B5 invariant. */}
          {confirmation.photoError && !confirmation.undone && (
            <p role="alert" style={{ margin: '10px 0 0', color: P.terra, fontSize: '0.82rem', fontWeight: 600 }}>
              ⚠️ The photo didn't upload: {confirmation.photoError}
            </p>
          )}
          {!confirmation.undone && (
            <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${P.greenLight}` }}>
              <button type="button" onClick={actions.onUndo} style={{
                background: 'transparent', border: 'none', color: P.mid, fontWeight: 500,
                fontSize: '0.88rem', cursor: 'pointer', minHeight: 44, minWidth: 44,
                padding: '10px 14px', fontFamily: 'inherit',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                <span aria-hidden="true">↩</span> Undo this log
              </button>
            </div>
          )}
        </div>
        {PreserveOffer && !confirmation.undone && (
          <PreserveOffer
            onOpen={preserve.onOpen}
            onDismiss={preserve.onDismiss}
          />
        )}
      </div>
      <div style={{
        // V4-KBVIEWPORT-001: bottom:0, not a keyboard inset. This footer is sticky inside the
        // Sheet's own scrollport, and the Sheet already reserves
        // `calc(12px + env(safe-area-inset-bottom))` (Sheet.jsx) at its foot.
        position: 'sticky', bottom: 0, zIndex: 200, backgroundColor: P.cream,
        borderTop: `1px solid ${P.border}`, padding: '10px 16px',
        paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
        display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap',
      }}>
        <button type="button" onClick={actions.onLogAnother} style={confirmBtnGhost}>
          Log another
        </button>
        {viewHref && (
          <Link to={viewHref} style={{ ...confirmBtnGhost, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
            View event
          </Link>
        )}
        {viewPlantingHref && (
          <Link to={viewPlantingHref} style={{ ...confirmBtnGhost, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', maxWidth: 180 }}>
            {/* long plant names: clamp the label text (ellipsis needs the inner span — an
                inline-flex box won't ellipsize itself), keep the 44pt target; the footer's
                flexWrap stacks/wraps at ~390px rather than shrinking targets */}
            <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {confirmation.plantName ? `View ${confirmation.plantName}` : 'View planting'}
            </span>
          </Link>
        )}
        <button type="button" ref={closeBtnRef} onClick={actions.onClose} style={confirmBtnPrimary}>
          Close
        </button>
      </div>
    </div>
  )
}

// V4-LOGCONF-001 action styles — mirror LogMany's result-screen buttons; min 44pt touch targets.
// Moved from EventNew.jsx with the card in S5a: these two consts had no other consumer there.
const confirmBtnPrimary = { backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 8, padding: '11px 18px', minHeight: 44, fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }
const confirmBtnGhost = { backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 8, padding: '10px 16px', minHeight: 44, fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
