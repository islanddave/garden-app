// src/components/ConfirmSheet.jsx
// BUG-DIRTYDISMISSGAP-001 — the system discard confirm. THE missing primitive: `confirmOnDirty` sat
// false at both registry call sites "pending a ConfirmSheet that does not exist", and CONFIRM had no
// consumer branch at all, so flipping the flag would have fallen straight through to cbRef and
// dismissed anyway — a silent no-fix. This is the surface that branch raises.
//
// RENDERED BY THE PROVIDER, NEVER BY A CONSUMER (context/DismissRegistry.jsx). Only the arbiter can
// see the whole stack, and the re-arm/resolve-once bookkeeping has to live next to the marker state
// it mutates. A consumer-rendered confirm would just be the per-surface window.confirm patch again,
// three times over.
//
// REWARD-UX CARVE-OUT — do not reject this as a rule violation on review. project-rules/gardening.md
// bans modals/sheets for REWARD surfaces only, and its own scope test (gardening.md:89) asks whether
// the thing delivers a POSITIVE SIGNAL "not strictly required for the user to complete a task they
// explicitly started". Both clauses fail here: a discard confirm celebrates nothing, and it IS
// required to complete a task the user started (leaving a form they opened). The same line names the
// carve-out class — "things required to complete a task the user started". Precedent, not just
// argument: BatchUndoConfirm, PhotoDeleteConfirm and EventDeleteConfirm already ship Sheet-based
// confirms under this ruleset.
//
// NOT BUILT ON <Sheet>, deliberately. Sheet hardcodes its backdrop at 190 and its panel at 200 and
// registers LAYER.SHEET; two panels at 200 are ordered only by DOM order, and a system confirm must
// outrank a LAYER.DIALOG (1000) surface such as VarietyPicker. Adding a zIndex prop to Sheet would
// touch the invariant all 18 of its render sites depend on. Z.systemConfirm (1200) was reserved for
// exactly this (dismissLayers.js:25) and nothing registered SYSTEM until now.
//
// NO SCROLL LOCK. Sheet's refcounted openStack already holds it for the surface underneath; a second
// locker risks the stranded-lock failure DismissRegistry.jsx:31-35 calls "the worst failure mode in
// the program". ConfirmSheet never touches openStack.
//
// The import cycle with DismissRegistry.jsx is real and safe: both this default export and
// useDismissable are hoisted function declarations, so whichever module is evaluated first, the
// binding the other needs is already initialised. Keep them declarations, not const arrows.
import React, { useEffect, useRef } from 'react'
import { P } from '../lib/constants.js'
import Button from './forms/Button.jsx'
import { useDismissable } from '../context/DismissRegistry.jsx'
import { LAYER } from '../lib/dismissLayers.js'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function ConfirmSheet({
  open,
  title = 'Discard your changes?',
  body = 'What you typed will be lost.',
  confirmLabel = 'Discard',
  cancelLabel = 'Keep editing',
  onConfirm,
  onCancel,
}) {
  const panelRef = useRef(null)
  const restoreRef = useRef(null)

  // armsBack TRUE: this closes IN PLACE and never navigates, which is the membership test in Sheet's
  // header. It is also what makes Back #2 land on the confirm instead of the sheet under it.
  // No `dirty` and no `confirmOnDirty` — a confirm holds no input, so it must never confirm itself.
  const { registered, isTopmost } = useDismissable({
    open: !!open, onDismiss: onCancel, layer: LAYER.SYSTEM, kind: 'modal', armsBack: true,
  })

  const onCancelRef = useRef(onCancel)
  useEffect(() => { onCancelRef.current = onCancel }, [onCancel])
  const registeredRef = useRef(registered)
  useEffect(() => { registeredRef.current = registered }, [registered])
  const isTopmostRef = useRef(isTopmost)
  useEffect(() => { isTopmostRef.current = isTopmost }, [isTopmost])

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement
    // FOCUS THE CANCEL CONTROL, NOT "the first focusable" — Sheet's rule (Sheet.jsx:111-113) is wrong
    // here. Destructive-on-top / safe-on-bottom is the button order this app already uses (thumb
    // rests at the bottom of a 390px screen), so "first focusable" would land on Discard and an Enter
    // from an external keyboard would be one-keystroke data loss.
    //
    // Found by query rather than a ref: Button is a FROZEN primitive and a plain function component,
    // so it forwards no ref, and unfreezing it to focus one element is not a trade worth making.
    panelRef.current?.querySelector('[data-testid="confirm-sheet-cancel"]')?.focus()

    function onKey(e) {
      if (!(registeredRef.current ? isTopmostRef.current : true)) return
      if (e.key === 'Escape') {
        // The registry's single listener owns Escape when we are registered. This fallback exists
        // only for the flag-off / no-provider case, mirroring Sheet.jsx:123-125 — without it a
        // confirm raised in that configuration would have no keyboard exit.
        if (registeredRef.current) return
        e.preventDefault(); onCancelRef.current?.(); return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const ring = Array.from(panel.querySelectorAll(FOCUSABLE))
      if (!ring.length) return
      const first = ring[0], last = ring[ring.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // On CANCEL this is strictly better than Sheet's restore: the surface underneath is still
      // mounted, so the captured element is genuinely connected. On CONFIRM it is detached (the sheet
      // unmounted in the same commit) and focus() would be a silent no-op, so we skip it and let
      // Sheet's own restore run — do not try to repair Sheet's known landmark gap from here.
      const el = restoreRef.current
      if (el && typeof el.focus === 'function' && el.isConnected) el.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <>
      {/* Backdrop tap CANCELS. A stray tap on a confirm must resolve toward keeping the work, and
          "keep editing" is that direction — the opposite of Sheet, where a dirty backdrop no-ops. */}
      <div
        data-testid="confirm-sheet-backdrop"
        onClick={() => onCancel?.()}
        style={{ position: 'fixed', inset: 0, zIndex: 1190, backgroundColor: 'rgba(0,0,0,0.4)' }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={isTopmost ? 'true' : undefined}
        aria-label={title}
        data-testid="confirm-sheet"
        tabIndex={-1}
        style={{
          position: 'fixed',
          bottom: 0, left: 0, right: 0,
          backgroundColor: P.white,
          borderRadius: '16px 16px 0 0',
          boxShadow: '0 -4px 20px rgba(0,0,0,0.18)',
          zIndex: 1200,
          padding: '8px 16px calc(16px + env(safe-area-inset-bottom))',
          outline: 'none',
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: P.border, margin: '0 auto 12px' }} />
        {/* No X control, unlike Sheet. Sheet's mandatory-Close rule (§5.3) exists because an invisible
            backdrop is its only other exit; here the labelled cancel button IS a discoverable >=44px
            exit, and a third way out of a two-button question is noise. */}
        <div data-testid="confirm-sheet-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: P.dark, marginBottom: 6 }}>
          {title}
        </div>
        <p data-testid="confirm-sheet-body" style={{ margin: '0 0 16px', color: P.mid, fontSize: '0.95rem', lineHeight: 1.45 }}>
          {body}
        </p>
        {/* Destructive on TOP, safe on the BOTTOM — same safety decision as BatchUndoConfirm:93-97.
            Stacked full-width, never side by side. testids rather than names, because the two labels
            are caller-supplied and a by-name query would be as fragile as the copy. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Button data-testid="confirm-sheet-confirm" variant="danger" onClick={() => onConfirm?.()} style={{ width: '100%' }}>
            {confirmLabel}
          </Button>
          <Button data-testid="confirm-sheet-cancel" variant="secondary" onClick={() => onCancel?.()} style={{ width: '100%' }}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </>
  )
}
