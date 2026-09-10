// src/context/ToastContext.jsx
// Global OPERATIONAL toast layer. App-root provider so ANY route can surface a
// confirmation or an undo toast that renders anywhere — not bound to one page
// (previously the log-event undo only rendered on Dashboard via location.state).
//
// ⚠ REWARD-UX BOUNDARY (gardening.md Reward UX Rule V101): this layer is the
// carve-out class ONLY — confirmations of a task the user explicitly started
// (a save) + the operational 5s undo. NEVER dispatch rewards/achievements/
// streaks/XP/critters/milestones here — those deliver as ambient in-context
// flourish (V101 lists toasts/snackbars/count-up overlays as prohibited reward
// channels). Keep this provider operational-only.
//
// ── STACK POLICY (2026-09-10) ────────────────────────────────────────────────
// Toasts were individually `position: fixed` at `toastStackBottom(i)` — a 56px
// per-index stride — with nothing bounding the queue. On Today's care list, where
// ONE TAP PER ROW is the primary interaction, four faults compounded:
//   1. NOTHING CAPPED THE QUEUE. Each tap pushed a 5s undo toast, so walking down
//      a 14-row water list inside 5s put 14 toasts on screen at once.
//   2. THE TIMERS NEVER FIRED. Each toast's dismiss timer listed its `onDone` /
//      `onDismiss` closure as an effect dep, and the provider hands down a fresh
//      closure every render — so every new toast RESTARTED the timer of every
//      toast already up. Fast tapping kept the whole stack alive indefinitely.
//   3. THE STRIDE WAS A GUESS. An undo toast with a long plant name ("Megatron
//      Jalapeños") wraps to 2-3 lines beside its Undo + × buttons — ~90px tall,
//      not 56px — so consecutive toasts overlapped into one unreadable slab.
//   4. IT RAN OFF THE TOP. 14 x 56px = 784px of offset on a ~780px viewport: the
//      stack covered the entire app, nav and search button included.
// The fix is structural rather than a bigger stride: ONE fixed container, flex
// column, real `gap` — children size themselves, so no stride can ever be wrong —
// plus timers that own their own lifetime, a hard MAX_VISIBLE_TOASTS cap, and
// same-group coalescing so repeat taps of ONE action collapse into a single toast
// whose Undo covers every tap in the group. Coalescing is what actually matches
// the workflow: "Logged Water for 12 plants · Undo" is the true statement, and it
// is the same shape the bulk "Log all watering" path has always produced.
import React, { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react'
import { P } from '../lib/constants.js'
import { Toast } from '../components/forms'
// Direct import, NOT via the forms barrel: formsPrimitivesFreeze.test.js pins the barrel's export
// set exactly, and this offset constant is layout plumbing rather than a frozen primitive.
import { TOAST_BOTTOM } from '../components/forms/Toast.jsx'

const ToastCtx = createContext(null)

// Hard ceiling on concurrent toasts; beyond it the OLDEST is dropped. The newest confirmation is
// the one the user's thumb just earned, and an undo is a time-boxed affordance anyway — so aging
// one out is the honest loss to take. With group coalescing below, hitting this cap now requires
// interleaving three genuinely DIFFERENT actions, not repeating one.
export const MAX_VISIBLE_TOASTS = 3

export function useToast() {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}

// useOptionalToast — like useToast but resilient outside a provider (returns a no-op api).
// For OPERATIONAL confirmations from components that may render in test harnesses or routes
// not wrapped in <ToastProvider>. Same reward-UX boundary applies: operational-only.
const NOOP_TOAST = { show: () => null, showUndo: () => null, dismiss: () => {} }
export function useOptionalToast() {
  return useContext(ToastCtx) || NOOP_TOAST
}

let _seq = 0

// Trim from the FRONT so the queue never exceeds the cap. Pure: safe to call inside a state updater.
const capped = (ts) => (ts.length <= MAX_VISIBLE_TOASTS ? ts : ts.slice(ts.length - MAX_VISIBLE_TOASTS))

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const dismiss = useCallback((id) => setToasts(ts => ts.filter(t => t.id !== id)), [])

  // Mirrors "which toast id is currently live for a group", rebuilt from `toasts` in an effect so
  // it can never outlive the toast it points at (cap-drop, timeout, or × dismiss all clear it).
  // Used ONLY to hand a caller back the merged id; the merge decision itself happens inside the
  // state updater below, where it reads the authoritative list and cannot race.
  const groupsRef = useRef(new Map())
  React.useEffect(() => {
    const m = new Map()
    for (const t of toasts) if (t.group) m.set(t.group, t.id)
    groupsRef.current = m
  }, [toasts])

  const show = useCallback(({ message, tone = 'success', duration = 2500 }) => {
    const id = ++_seq
    setToasts(ts => capped([...ts, { id, kind: 'msg', message, tone, duration }]))
    return id
  }, [])

  // `detail` (V4-WATERMATH-001 F0): optional secondary line under the message — a fact ABOUT the
  // record just written (e.g. the watering amount class the row now carries), so the user can see
  // what was stored while the undo is still on screen. Still operational: it states what happened,
  // never how well it went. NOT a reward channel (see the boundary note at the top of this file).
  //
  // `group` + `groupMessage` (2026-09-10): opt-in coalescing. Pass a stable `group` key and a
  // `groupMessage(count) -> string`, and repeat calls arriving while that group's toast is still on
  // screen MERGE into it instead of stacking: the count rises, the message re-renders from
  // groupMessage, the 5s window restarts, and Undo runs every accumulated handler. Callers that
  // omit `group` behave exactly as before — one call, one toast.
  const showUndo = useCallback(({ message, detail = null, onUndo, duration = 5000, group = null, groupMessage = null }) => {
    const id = ++_seq
    setToasts(ts => {
      const prior = group ? ts.find(t => t.kind === 'undo' && t.group === group) : null
      if (prior) {
        const count = prior.count + 1
        // The group's FIRST call owns the wording: every later tap is the same action on another
        // row, so the label must not flip mid-stack if a caller varies it.
        const fmt = prior.groupMessage || groupMessage
        return ts.map(t => t.id !== prior.id ? t : {
          ...prior,
          count,
          message: fmt ? fmt(count) : prior.message,
          // A per-row detail line stops being true once the toast speaks for N rows.
          detail: null,
          undos: [...prior.undos, onUndo],
          // Restarts the auto-dismiss window — it belongs to the LAST tap, not the first.
          nonce: prior.nonce + 1,
        })
      }
      return capped([...ts, {
        id, kind: 'undo', group, groupMessage, message, detail,
        undos: [onUndo], count: 1, duration, nonce: 0,
      }])
    })
    // A merged call returns the id of the toast it merged INTO, so a caller holding the id (e.g.
    // InactiveProjects' toastIdRef) still points at something real.
    return group && groupsRef.current.has(group) ? groupsRef.current.get(group) : id
  }, [])

  const api = useMemo(() => ({ show, showUndo, dismiss }), [show, showUndo, dismiss])

  return (
    <ToastCtx.Provider value={api}>
      {children}
      {toasts.length > 0 && (
        <div
          // ONE fixed element for the whole layer. Children are flow items in a flex column, so
          // each sizes to its own wrapped height and `gap` does the spacing — which is exactly why
          // no per-index offset survives here: there is no stride left to get wrong.
          // zIndex 1200 was the old UndoToast value (the higher of the two the layer used); both
          // kinds now share one stacking context instead of competing at 1000 vs 1200.
          style={{
            position: 'fixed', bottom: TOAST_BOTTOM, left: 0, right: 0, zIndex: 1200,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            padding: '0 16px',
            // The container spans the viewport so children can centre, so it must not swallow taps
            // on the app behind it. Interactive children opt back in individually.
            pointerEvents: 'none',
          }}
        >
          {toasts.map(t => t.kind === 'undo'
            ? <UndoToast key={t.id} toast={t}
                onUndo={() => {
                  // Each handler is isolated: one throwing must not strand the rest, and the toast
                  // must clear either way.
                  try { for (const fn of t.undos) { try { fn && fn() } catch { /* per-handler */ } } }
                  finally { dismiss(t.id) }
                }}
                onDismiss={() => dismiss(t.id)} />
            : <Toast key={t.id} inStack message={t.message} tone={t.tone} duration={t.duration}
                onDone={() => dismiss(t.id)} />
          )}
        </div>
      )}
    </ToastCtx.Provider>
  )
}

// Operational undo toast (mirrors the retired Dashboard-local UndoToast, now global).
function UndoToast({ toast, onUndo, onDismiss }) {
  // onDismiss lives in a ref so the timer depends only on (duration, nonce). As an effect dep it
  // was a fresh closure every render, so each new toast restarted this one's timer — fault 2 in
  // the STACK POLICY note above. `nonce` bumps on every merge into this group, which restarts the
  // window deliberately: the 5s undo belongs to the most recent tap.
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  React.useEffect(() => {
    if (!toast.duration) return
    const id = setTimeout(() => dismissRef.current(), toast.duration)
    return () => clearTimeout(id)
  }, [toast.duration, toast.nonce])
  return (
    <div role="status" style={{
      // Position and spacing belong to the container; this is a plain flow child.
      backgroundColor: P.dark, color: P.white, borderRadius: 10, padding: '10px 14px 10px 18px',
      boxShadow: '0 6px 18px rgba(0,0,0,0.3)', fontSize: '0.88rem',
      display: 'flex', alignItems: 'center', gap: 14, maxWidth: '100%',
      // The container is pass-through; Undo and × must still be tappable.
      pointerEvents: 'auto',
    }}>
      {/* flex COLUMN for the text so a detail line stacks under the message instead of racing it
          for the row's width; minWidth 0 keeps a long plant name from pushing Undo off-panel. */}
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span>{toast.message}</span>
        {toast.detail && (
          <span style={{ fontSize: '0.78rem', opacity: 0.85 }}>{toast.detail}</span>
        )}
      </span>
      <button type="button" onClick={onUndo} style={{
        background: 'transparent', color: P.greenLight, border: `1px solid ${P.greenLight}`,
        borderRadius: 6, padding: '5px 12px', fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer',
        flexShrink: 0,
      }}>Undo</button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" style={{
        background: 'transparent', color: P.white, border: 'none', fontSize: '1.1rem', cursor: 'pointer',
        lineHeight: 1, flexShrink: 0,
      }}>×</button>
    </div>
  )
}
