/**
 * src/lib/mode.js
 *
 * Bite 2 of Post-V2 UX overhaul Increment 2: Field/Desk mode toggle scaffold.
 * (Dave-call #3 from roadmap §4: manual session-persistent mode toggle with
 * visible status; default Field on touch/mobile, Desk on desktop.)
 *
 * This module exports the MODE constants and the `useMode()` hook. The
 * provider implementation lives in src/context/ModeContext.jsx — separating
 * the constants/hook surface from the provider keeps imports clean for the
 * bites that follow (B3 reads mode in BottomNav / FieldCapture; B4/B5 branch
 * capture behavior on mode without needing to touch the provider).
 *
 * Persistence: sessionStorage (per-tab, cleared at tab close). Per Open
 * Question Q2: granularity is GLOBAL — one mode for the whole app at a time;
 * per-page override is NOT supported. See decomposition doc §Open questions.
 *
 * Operational surface (not reward) — Reward UX V100 does not apply. See
 * project CLAUDE.md §Reward UX Rule falsifiability test.
 */

export const MODE = Object.freeze({
  FIELD: 'field',
  DESK:  'desk',
})

export const MODE_VALUES = Object.freeze([MODE.FIELD, MODE.DESK])

// Session storage key — namespaced to avoid collision with future toggles.
export const MODE_STORAGE_KEY = 'gardenApp.mode'

// Re-export useMode + ModeProvider from the context module so consumers can
// import either the constants or the hook from one place.
export { useMode, ModeProvider } from '../context/ModeContext.jsx'
