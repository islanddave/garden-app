/**
 * src/lib/mode.js
 *
 * Field/Desk mode toggle scaffold: a manual session-persistent mode toggle with visible status.
 * Default is Desk for ALL devices; Field is the opt-in alternate.
 *
 * This module exports the MODE constants only. The provider and the `useMode()`
 * hook live in src/context/ModeContext.jsx, which imports these constants —
 * so they are deliberately not re-exported from here (that would be an import
 * cycle). Import the hook from the context module.
 *
 * Persistence: sessionStorage (per-tab, cleared at tab close). Granularity is
 * GLOBAL — one mode for the whole app at a time; per-page override is NOT supported.
 *
 * Operational surface (not reward) — Reward UX V100 does not apply.
 */

export const MODE = Object.freeze({
  FIELD: 'field',
  DESK:  'desk',
})

export const MODE_VALUES = Object.freeze([MODE.FIELD, MODE.DESK])

// Session storage key — namespaced to avoid collision with future toggles.
export const MODE_STORAGE_KEY = 'gardenApp.mode'
