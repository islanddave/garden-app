// Canonical bottom-sheet fly-up: backdrop + slide-up panel rounded at the top, grab handle,
// safe-area inset. a11y: role=dialog + aria-modal, accessible name (title|ariaLabel), Escape to
// close, focus moved into the panel on open and RESTORED to the prior element on close, backdrop
// tap-to-dismiss. Reduced-motion: the panel still appears; no required motion to operate.
//
// Props with non-obvious contracts (defaults preserve every consumer that omits them):
//   size='peek'|'full'   peek = 85vh; full = near-fullscreen for long forms.
//   dirty=false          when true, a backdrop tap NO-OPS (a stray tap must not discard a dirty
//                        form). Escape + the Close button stay live regardless.
//   busy                 a write is in flight. Also blocks the backdrop tap; `dirty` keeps its
//                        meaning (unsaved user input).
//   closeLabel='Close'   a11y label for the mandatory visible Close control: the 36x4 grab handle
//                        has no drag handler (a false affordance) and an invisible backdrop is not a
//                        discoverable exit, so a real >=44px labelled Close is required.
// Also: refcounted body scroll-lock (overflow:hidden + overscroll-behavior:contain, restored on the
// LAST close, unconditionally, so a stacked sheet cannot strand the lock and brick the app); Escape
// TOPMOST-arbitration (only the top sheet responds, so one Escape does not fire two onCloses);
// focus-selector hardening (:not([disabled]) + hidden/aria-hidden filter).
//
// Escape arbitration and aria-modal ownership belong to the shared DismissRegistry when one is
// present (context/DismissRegistry.jsx). openStack STAYS: it owns the refcounted body scroll-lock,
// a Sheet-visual concern the other modal surfaces do not share. When `registered` is false (an
// isolated test or legacy path with no provider) the module's own openStack arbitrates alone.
//
// `dirty` is no longer backdrop-only ON A SITE THAT PASSES `confirmOnDirty`: there it also makes
// Escape, Android Back and the labelled Close raise the registry's ConfirmSheet instead of
// discarding. Sites that do not pass it are unchanged.
import React, { useEffect, useRef } from 'react'
import { P } from '../../lib/constants.js'
import { useDismissable } from '../../context/DismissRegistry.jsx'
import { LAYER } from '../../lib/dismissLayers.js'

// Module-level stack of OPEN sheets (each mounted-open Sheet pushes an opaque token). Drives two
// cross-instance concerns that a per-instance effect cannot see: (a) refcounted body scroll-lock
// and (b) Escape topmost-arbitration. Popped on close/unmount.
const openStack = []
let savedOverflow = null
let savedOverscroll = null

function lockBodyScroll() {
  if (openStack.length !== 1) return // only the FIRST sheet captures + locks; nested pushes no-op
  const b = document.body
  savedOverflow = b.style.overflow
  savedOverscroll = b.style.overscrollBehavior
  b.style.overflow = 'hidden'
  b.style.overscrollBehavior = 'contain'
}
function unlockBodyScroll() {
  if (openStack.length !== 0) return // only the LAST close restores
  const b = document.body
  b.style.overflow = savedOverflow ?? ''
  b.style.overscrollBehavior = savedOverscroll ?? ''
  savedOverflow = savedOverscroll = null
}

// :not([disabled]) hardening + a jsdom-safe visibility filter (offsetParent is unreliable without a
// layout engine, so only declaratively-hidden nodes are excluded, never layout-derived ones).
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
function focusablesIn(panel) {
  if (!panel) return []
  return Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
    (el) =>
      !el.hasAttribute('hidden') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      el.style.display !== 'none' &&
      el.style.visibility !== 'hidden'
  )
}

// `kind` and `armsBack` are EXPLICIT props, not inherited.
//
// Sheet calls useDismissable ONCE on behalf of every <Sheet> render site, so if Back membership
// were implied by registration it would silently enrol BottomNav's +LOG and More sheets, whose
// every row closes the sheet AND navigates, orphaning the pushed entry and costing a permanent
// extra Back on the app's most frequent path. So the arming decision is made at each render site and
// defaults to OFF.
//   armsBack: the close-in-place Sheets.
//   kind='route': App.jsx's OverlayHost only; the router already owns a real entry for it.
// `confirmOnDirty` (+ its copy) is a per-render-site opt-in, defaulting OFF for the same reason:
// `dirty` does not mean the same thing at every site. Only the three PlantingEditor hosts opt in
// today. See the deciders in lib/dismissLayers.js and lib/backNav.js for why the per-entry term
// exists at all.
// `headerStart` fills the header row's EMPTY LEFT SLOT on a sheet with no title (BottomNav's More
// sheet puts its "Edit tab bar" door there). Ignored when `title` is set, since the title owns that
// slot. Whatever goes here is the caller's: in an armsBack sheet, a control that NAVIGATES must be a
// SheetRowLink, or it strands the armed Back entry.
// `confirmCopy` is the discard question's words for the state the sheet is in right now ({ title,
// body, confirmLabel, cancelLabel }, any of them), passed straight to the registry, which reads it
// only when the question is raised. Absent, the question is the registered confirmTitle /
// confirmBody with the registry's own buttons.
// `refocusKey` is for a sheet that can open BEFORE its form is in (the Sow sheet's "Loading
// places…"): focus is placed once, at open, so it lands on Close and would stay there. When the key
// changes WHILE the sheet is open, the open-time choice is made again, only if focus is still where
// that choice left it (or nowhere), so focus the user has moved is never taken back. Absent, or
// unchanged since the open, nothing happens.
export default function Sheet({ open, onClose, title, ariaLabel, children, size = 'peek', dirty = false, busy = false, closeLabel = 'Close', kind = 'modal', armsBack = false, backIntercept = null, confirmOnDirty = false, confirmTitle = null, confirmBody = null, confirmCopy = null, headerStart = null, refocusKey }) {
  const panelRef = useRef(null)
  const restoreRef = useRef(null)
  const initialFocusRef = useRef(null)
  const refocusKeyRef = useRef(refocusKey)
  const focusedForKeyRef = useRef(refocusKey)
  useEffect(() => { refocusKeyRef.current = refocusKey }, [refocusKey])
  const { registered, isTopmost, requestDismiss } = useDismissable({
    open, onDismiss: onClose, dirty, busy, layer: LAYER.SHEET, kind, armsBack, backIntercept,
    confirmOnDirty, confirmTitle, confirmBody, confirmCopy,
  })
  // Latest-value refs: keep the keydown handler current WITHOUT making onClose/dirty deps of the
  // focus effect. Callers pass inline closures recreated every render; if their identity drove the
  // effect, every parent re-render (e.g. a keystroke updating form state) would re-run it and yank
  // focus back to the first field. Focus-on-open must fire ONLY on open change.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  const dirtyRef = useRef(dirty)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  // Same latest-value pattern for the registry signals: the key handler below lives in an
  // [open]-keyed effect and must read these fresh without re-running (re-running yanks focus).
  const registeredRef = useRef(registered)
  useEffect(() => { registeredRef.current = registered }, [registered])
  const isTopmostRef = useRef(isTopmost)
  useEffect(() => { isTopmostRef.current = isTopmost }, [isTopmost])

  useEffect(() => {
    if (!open) return
    // Register on the open-sheet stack BEFORE locking (lock reads openStack.length).
    const token = {}
    openStack.push(token)
    lockBodyScroll()

    restoreRef.current = document.activeElement
    const panel = panelRef.current
    // Move focus into the panel: first focusable that is NOT the Close control (so forms still open
    // on their first field), else the Close control, else the panel itself.
    const items = focusablesIn(panel)
    const initial = items.find((el) => !el.hasAttribute('data-sheet-close')) || items[0] || panel
    initial?.focus()
    initialFocusRef.current = initial
    focusedForKeyRef.current = refocusKeyRef.current

    function onKey(e) {
      // Topmost gate. When registered, the REGISTRY is the authority (it can see Lightbox and the
      // other non-Sheet dialogs that openStack cannot); otherwise fall back to openStack, which
      // arbitrates correctly among Sheets.
      const top = registeredRef.current ? isTopmostRef.current : openStack[openStack.length - 1] === token
      if (!top) return
      // Escape (SC 2.1.1). When registered, the registry's single listener owns Escape; this
      // handler must NOT also fire it, or one press would close the sheet twice over.
      if (e.key === 'Escape') {
        if (registeredRef.current) return
        e.preventDefault(); onCloseRef.current?.(); return
      }
      if (e.key !== 'Tab' || !panel) return
      const ring = focusablesIn(panel)
      if (!ring.length) return
      const first = ring[0], last = ring[ring.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Pop THIS token wherever it sits (robust to out-of-order close), then maybe unlock.
      const i = openStack.indexOf(token)
      if (i !== -1) openStack.splice(i, 1)
      unlockBodyScroll()
      // Focus restore, with a DETACHED-NODE guard (SC 2.4.3): a node already removed from the
      // document still has a .focus method. A Back-driven close pops history, the router commits,
      // and the trigger unmounts in the SAME commit as this cleanup, so that case is routine.
      //
      // The guard makes the detached case EXPLICIT, it does not repair it: focus() on a detached
      // node is a silent no-op, so focus still lands on <body>, where TalkBack's reading cursor
      // resets to the top of the page with no announcement. The real fix needs a stable focus
      // destination, and THE APP HAS NONE: no <main>, no role="main", no tabIndex={-1} landmark in
      // the tree. Adding one is a change to the app shell with its own blast radius. Do not "fix"
      // this by focusing the panel; the panel is unmounting too.
      const el = restoreRef.current
      if (el && typeof el.focus === 'function' && el.isConnected) el.focus()
    }
    // Deps = [open] ONLY (onClose/dirty read via ref): fire on open transitions, never on incidental
    // parent re-renders, or a keystroke steals focus back to the first field.
  }, [open])

  // Declared AFTER the open effect on purpose: on the commit that opens the sheet the key was just
  // recorded above, so this is a no-op there and only a change made while open gets past the guard.
  useEffect(() => {
    if (!open || refocusKey === focusedForKeyRef.current) return
    focusedForKeyRef.current = refocusKey
    const panel = panelRef.current
    const active = document.activeElement
    if (active !== initialFocusRef.current && active !== panel && active !== document.body) return
    const items = focusablesIn(panel)
    const initial = items.find((el) => !el.hasAttribute('data-sheet-close')) || items[0] || panel
    initial?.focus()
    initialFocusRef.current = initial
  }, [open, refocusKey])

  if (!open) return null

  // Backdrop tap: dirty guard. When dirty a stray backdrop tap no-ops; Escape/Close stay live.
  // ALSO guarded on `busy`: a write in flight is not unsaved input (so it is not `dirty`), but it
  // must not be dismissable by a stray tap either, and on mobile a stray backdrop tap is far
  // likelier than an Escape press.
  const onBackdrop = () => { if (!dirty && !busy) onClose?.() }

  const maxHeight = size === 'full' ? 'calc(100dvh - env(safe-area-inset-top) - 8px)' : '85vh'

  // The cap must govern the PAINTED box, and by default it does not. The panel is content-box (no
  // reset in this app), so paddingTop 8 + paddingBottom 12 are added OUTSIDE maxHeight: at 390x500
  // with a full batch staged the cap resolved to 492px, the panel painted 512px, and since it is
  // bottom:0 the extra 20px went out of the TOP of the screen (grab handle at y=-4, panel at y=-12).
  // Measured in tests/harness/sheetcensus.jsx.
  //
  // SCOPED TO `full`, DELIBERATELY: that keeps this a one-line change rather than a sizing-model
  // change. Peek has the same 20px arithmetic but CANNOT overshoot: its cap is 85vh, so the panel
  // tops out at 15vh-20px from the top edge, positive on any viewport over ~133px (+55 at worst, at
  // 390x500). Border-box there would fix nothing and would cost every peek sheet 20px of visible
  // content (PhotoDeleteConfirm at 390x500 measures 417px of content against a 425px cap, so it
  // would flip from "fits whole" to "scrolls"). Peek's 85vh is 20px optimistic, not broken;
  // correcting it is a separate call.
  //
  // Costs 20px of visible content on a `full` sheet already at its cap (492 -> 472 at vh=500),
  // unavoidable: 492px of content plus 20px of padding cannot paint inside a 492px budget. Those
  // surfaces already scroll, so this lengthens a scroll rather than clipping anything.
  const boxSizing = size === 'full' ? 'border-box' : 'content-box'

  return (
    <>
      <div
        onClick={onBackdrop}
        style={{ position: 'fixed', inset: 0, zIndex: 190, backgroundColor: 'rgba(0,0,0,0.3)' }}
      />
      <div
        ref={panelRef}
        role="dialog"
        // SINGLE-MODALITY INVARIANT. Two simultaneously-rendered elements with aria-modal="true" is
        // invalid ARIA (modality is undefined and screen readers resolve it inconsistently), and it
        // occurs: PlantingDetail renders its Details Sheet and a Lightbox from independent state.
        // Only the topmost claims modality; unregistered (no provider) keeps the unconditional "true".
        aria-modal={isTopmost ? 'true' : undefined}
        aria-label={title || ariaLabel}
        tabIndex={-1}
        style={{
          position: 'fixed',
          bottom: 0, left: 0, right: 0,
          maxHeight,
          boxSizing,
          overflowY: 'auto',
          backgroundColor: P.white,
          borderRadius: '16px 16px 0 0',
          boxShadow: '0 -4px 20px rgba(0,0,0,0.14)',
          zIndex: 200,
          paddingTop: 8,
          paddingBottom: 'calc(12px + env(safe-area-inset-bottom))',
          outline: 'none',
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: P.border, margin: '0 auto 8px' }} />
        {/* Header row: title (if any) + the mandatory visible, labelled Close (>=44px). */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '0 8px 4px' }}>
          {title ? (
            <div style={{ flex: 1, padding: '4px 16px 4px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>
              {title}
            </div>
          ) : headerStart ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', minWidth: 0 }}>{headerStart}</div>
          ) : (
            <div style={{ flex: 1 }} />
          )}
          {/* ROUTED THROUGH THE ARBITER, not straight to onClose. Escape and Back both ask before
              discarding on an opted-in surface; a Close button that called onClose directly would
              be the one exit that still discarded silently, and the MOST discoverable one.
              requestDismiss falls back to onClose whenever the provider declines ownership (not
              opted in, not dirty, or no provider), so every other render site is unchanged. */}
          <button
            type="button"
            data-sheet-close="true"
            onClick={() => requestDismiss()}
            aria-label={closeLabel}
            style={{
              flexShrink: 0, width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: 'none', color: P.mid, cursor: 'pointer', borderRadius: 8,
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </>
  )
}
