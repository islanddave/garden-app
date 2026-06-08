import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { MODE, MODE_VALUES, MODE_STORAGE_KEY } from '../lib/mode.js'

/**
 * src/context/ModeContext.jsx
 *
 * Bite 2 of Post-V2 UX overhaul Increment 2: Field/Desk mode toggle scaffold.
 *
 * Provides the global "Field" vs "Desk" mode for the app (Dave-call #3 from
 * roadmap §4). Bite 2 is no-op visible scaffolding: the chip shows current
 * mode and toggles, but no other surface branches on mode yet. Bite 3 will
 * gate the FieldCapture page on `useMode() === MODE.FIELD` and swap the
 * BottomNav +LOG affordance for the mic button in Field mode.
 *
 * Defaults (V3-DESK-001, Dave+Jen 2026-06-08):
 *   - Desk ALWAYS, regardless of device/pointer. The desk/home view is used
 *     far more than field even on mobile, so Field is the alternate the user
 *     opts into via the toggle (no longer auto-selected on touch devices).
 * Persisted to sessionStorage so the user's explicit toggle survives
 * navigation but resets at tab close (per spec: "manual session-persistent").
 *
 * Defensive against environments where matchMedia / sessionStorage are
 * unavailable (server-side render, locked-down browsers, jsdom variants).
 * On failure, falls back to Desk and silently no-ops persistence.
 */

const ModeContext = createContext(null)

function detectDefaultMode() {
  // V3-DESK-001: default is Desk for every device. Field is opt-in via the
  // toggle, no longer auto-selected on coarse-pointer (touch) devices.
  return MODE.DESK
}

function readStoredMode() {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null
    const raw = window.sessionStorage.getItem(MODE_STORAGE_KEY)
    if (raw && MODE_VALUES.includes(raw)) return raw
  } catch {}
  return null
}

function writeStoredMode(value) {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return
    window.sessionStorage.setItem(MODE_STORAGE_KEY, value)
  } catch {}
}

export function ModeProvider({ children, initialMode }) {
  const [mode, setModeState] = useState(() => {
    if (initialMode && MODE_VALUES.includes(initialMode)) return initialMode
    const stored = readStoredMode()
    if (stored) return stored
    return detectDefaultMode()
  })

  // Persist any mode change (including the initial detected default — so the
  // chip's first render value is the source of truth across reloads in the
  // same tab session).
  useEffect(() => {
    writeStoredMode(mode)
  }, [mode])

  const setMode = useCallback((next) => {
    if (!MODE_VALUES.includes(next)) return
    setModeState(next)
  }, [])

  const toggleMode = useCallback(() => {
    setModeState((prev) => (prev === MODE.FIELD ? MODE.DESK : MODE.FIELD))
  }, [])

  const isField = mode === MODE.FIELD
  const isDesk  = mode === MODE.DESK

  return (
    <ModeContext.Provider value={{ mode, setMode, toggleMode, isField, isDesk }}>
      {children}
    </ModeContext.Provider>
  )
}

export function useMode() {
  const ctx = useContext(ModeContext)
  if (!ctx) throw new Error('useMode must be called inside ModeProvider')
  return ctx
}
