/**
 * src/lib/mode.js
 *
 * Bite 2 of Post-V2 UX overhaul Increment 2: Field/Desk mode toggle scaffold.
 * (Dave-call #3 from roadmap §4: manual session-persistent mode toggle with
 * visible status.) V3-DESK-001 (2026-06-08): default is Desk for ALL devices;
 * Field is the opt-in alternate (was: Field on touch/mobile, Desk on desktop).
 *
 * This module exports the MODE constants only. The provider and the `useMode()`
 * hook live in src/context/ModeContext.jsx, which imports these constants —
 * so they are deliberately not re-exported from here (that would be an import
 * cycle). Import the hook from the context module.
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
