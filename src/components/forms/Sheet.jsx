// src/components/forms/Sheet.jsx
// V4-THEME-001 (V200 Pass B) — canonical bottom-sheet fly-up. ONE fly-up grammar for the
// V200 "fly-ups over page shifts" principle (favorites, plant details, quick-log, LogMany,
// "Why this"). Backdrop + slide-up panel rounded at the top, grab handle, safe-area inset.
// a11y: role=dialog + aria-modal, accessible name (title|ariaLabel), Escape to close,
// focus moved into the panel on open and RESTORED to the prior element on close, backdrop
// tap-to-dismiss. Reduced-motion: the panel still appears; no required motion to operate.
// Ships DARK (no runtime importer until the adopting slice).
import React, { useEffect, useRef } from 'react'
import { P } from '../../lib/constants.js'

export default function Sheet({ open, onClose, title, ariaLabel, children }) {
  const panelRef = useRef(null)
  const restoreRef = useRef(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement
    const panel = panelRef.current
    // Move focus into the panel (first focusable, else the panel itself).
    const focusable = panel?.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    ;(focusable || panel)?.focus()

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onClose?.(); return }
      if (e.key !== 'Tab' || !panel) return
      const items = panel.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!items.length) return
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const el = restoreRef.current
      if (el && typeof el.focus === 'function') el.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 90, backgroundColor: 'rgba(0,0,0,0.3)' }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title || ariaLabel}
        tabIndex={-1}
        style={{
          position: 'fixed',
          bottom: 0, left: 0, right: 0,
          maxHeight: '85vh',
          overflowY: 'auto',
          backgroundColor: P.white,
          borderRadius: '16px 16px 0 0',
          boxShadow: '0 -4px 20px rgba(0,0,0,0.14)',
          zIndex: 100,
          paddingTop: 8,
          paddingBottom: 'calc(12px + env(safe-area-inset-bottom))',
          outline: 'none',
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: P.border, margin: '0 auto 8px' }} />
        {title && (
          <div style={{ padding: '4px 24px 8px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>
            {title}
          </div>
        )}
        {children}
      </div>
    </>
  )
}
