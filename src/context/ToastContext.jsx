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
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react'
import { P } from '../lib/constants.js'
import { Toast } from '../components/forms'

const ToastCtx = createContext(null)

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

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const dismiss = useCallback((id) => setToasts(ts => ts.filter(t => t.id !== id)), [])
  const show = useCallback(({ message, tone = 'success', duration = 2500 }) => {
    const id = ++_seq
    setToasts(ts => [...ts, { id, kind: 'msg', message, tone, duration }])
    return id
  }, [])
  const showUndo = useCallback(({ message, onUndo, duration = 5000 }) => {
    const id = ++_seq
    setToasts(ts => [...ts, { id, kind: 'undo', message, onUndo, duration }])
    return id
  }, [])
  const api = useMemo(() => ({ show, showUndo, dismiss }), [show, showUndo, dismiss])

  return (
    <ToastCtx.Provider value={api}>
      {children}
      {toasts.map((t, i) => t.kind === 'undo'
        ? <UndoToast key={t.id} toast={t} offset={i}
            onUndo={() => { try { t.onUndo && t.onUndo() } finally { dismiss(t.id) } }}
            onDismiss={() => dismiss(t.id)} />
        : <Toast key={t.id} message={t.message} tone={t.tone} duration={t.duration}
            onDone={() => dismiss(t.id)} style={{ bottom: 24 + i * 56 }} />
      )}
    </ToastCtx.Provider>
  )
}

// Operational undo toast (mirrors the retired Dashboard-local UndoToast, now global).
function UndoToast({ toast, offset, onUndo, onDismiss }) {
  React.useEffect(() => {
    if (!toast.duration) return
    const id = setTimeout(onDismiss, toast.duration)
    return () => clearTimeout(id)
  }, [toast.duration, onDismiss])
  return (
    <div role="status" style={{
      position: 'fixed', bottom: 70 + offset * 56, left: '50%', transform: 'translateX(-50%)',
      backgroundColor: P.dark, color: P.white, borderRadius: 10, padding: '10px 14px 10px 18px',
      boxShadow: '0 6px 18px rgba(0,0,0,0.3)', fontSize: '0.88rem', zIndex: 1200,
      display: 'flex', alignItems: 'center', gap: 14, maxWidth: 'calc(100% - 32px)',
    }}>
      <span>{toast.message}</span>
      <button type="button" onClick={onUndo} style={{
        background: 'transparent', color: P.greenLight, border: `1px solid ${P.greenLight}`,
        borderRadius: 6, padding: '5px 12px', fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer',
      }}>Undo</button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" style={{
        background: 'transparent', color: P.white, border: 'none', fontSize: '1.1rem', cursor: 'pointer', lineHeight: 1,
      }}>×</button>
    </div>
  )
}
