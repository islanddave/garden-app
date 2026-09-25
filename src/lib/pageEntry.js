// src/lib/pageEntry.js
// BUG-OVERLAYRELOADKEY-001 — WHICH history entry the page tree is showing, read straight off
// window.history.state for code that cannot go through the router (useScrollRestore, whose suites stub
// react-router-dom wholesale).
//
// UNDER A ROUTE OVERLAY the entry is not the page's. OverlayContext pushes the overlay (/search, /log,
// /log/many, /put-up) as its own entry carrying `usr.background`, and App renders the page tree AT that
// background — so useLocation() in the page tree answers with the background, key included. A direct
// read of history.state.key answered with the OVERLAY's key instead. For a page mounted before the
// overlay opened that only paused its saving; a page that MOUNTS under an open overlay pinned itself to
// the overlay's entry for good. That is the everyday Search -> a result -> Back (Search re-opens over a
// re-mounted page) -> X, and every reload or tab restore with an overlay up: the page read nothing on the
// way in, and once the X had taken it home it could file nothing either.
//
// AN OVERLAY CLOSED BY REPLACE puts a new entry, with a new key, where the overlay's was — the fallback
// planOverlayClose takes when it cannot prove where the page's own entry is (another document wrote it,
// a Back marker is on top). The page stays mounted through it. useOverlayDismiss stamps that entry with
// the key of the page entry it continues (CONTINUES_ENTRY_KEY), so the page keeps ONE identity across the
// re-key, and so does an overlay later opened over it (its background carries the stamp in `state`).
//
// These are identities, not positions: planOverlayClose's walk arithmetic reads router keys and idx and
// must never see them.
import { OVERLAY_ROUTES_ENABLED } from './featureFlags.js'

export const CONTINUES_ENTRY_KEY = 'continuesEntry'

const keyOf = (v) => (typeof v === 'string' && v ? v : null)

// The entry a location (a router location, or a background stored in history) answers to: the page
// entry it continues when stamped, else its own router key. null when it carries neither.
export function locationEntryKey(loc) {
  if (!loc || typeof loc !== 'object') return null
  return keyOf(loc.state && loc.state[CONTINUES_ENTRY_KEY]) || keyOf(loc.key)
}

// The entry the page tree shows for a history state ({usr, key, idx}): the overlay's background when
// one is honored — OverlayProvider's own test, flag and shape (validBackground) — else the entry this
// one continues, else the entry's own key. null for an entry react-router has not keyed (its 'default').
export function pageEntryKey(state, overlays = OVERLAY_ROUTES_ENABLED) {
  if (!state || typeof state !== 'object') return null
  const usr = state.usr && typeof state.usr === 'object' ? state.usr : null
  const bg = usr && usr.background
  if (overlays && bg && typeof bg === 'object' && typeof bg.pathname === 'string') return locationEntryKey(bg)
  return keyOf(usr && usr[CONTINUES_ENTRY_KEY]) || keyOf(state.key)
}
