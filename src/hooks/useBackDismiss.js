// V4-BACKNAV-001 Slice P — the vertical pilot (decision V200 §6).
//
// Gives a transient, non-route surface its own history entry so the Android system Back CLOSES IT
// instead of switching tabs or exiting the app (requirement B2). One hook, opt-in per surface,
// behind BACKNAV_ENABLED. Rollback is deleting the hook call.
//
// AN OPAQUE MARKER, NOT A URL. Needing a history entry is not the same as needing a URL: a
// transient sheet must be poppable by Back but must never be deep-linkable (a bookmarked "filter
// picker open" is incoherent, and on a cold load the route would render with the picker's parent
// state reset). Conflating those two is what forces a false route-promotion hybrid. So we push an
// entry at the SAME url carrying a marker in history.state.
//
// WHY NOT BottomNav's sheets, which the plan originally named as the pilot: every row in BOTH the
// +LOG and More sheets closes the sheet AND navigates. That leaves our pushed entry ORPHANED below
// the destination — the user would then need two Backs where one used to do, on the app's most
// frequent path. An extra Back forever is a worse regression than the papercut being fixed. This
// hook is therefore for surfaces that OPEN AND CLOSE IN PLACE. `PlantingDetail`'s Details sheet and
// `Harvests`' filter pickers are exactly that; the navigating sheets need the Slice-3 arbiter, which
// can see the navigation and replace rather than orphan.
//
// STATE IS MERGED, NEVER REPLACED. react-router owns window.history.state as {usr, key, idx} and
// @remix-run/router's own source warns that writing it directly "will result in bugs" — clobbering
// `idx` desynchronises the router's index from the real stack. Replacing state wholesale has also
// already shipped a real bug in this app once (LogMany: it destroyed `background`, unmounted the
// overlay, and made the success screen + Undo unreachable for a batch already written to the DB).
import { useEffect, useRef } from 'react'
import { BACKNAV_ENABLED } from '../lib/featureFlags.js'

export const MARKER_KEY = '__backnav'
export const MARKER_VERSION = 1

// history.state is untrusted input: it survives a reload AND a deploy, so a marker written by an
// older bundle can be read by a newer one. Validated by version AND id, degrading to "not ours"
// (Back behaves exactly as before this feature) rather than acting on a shape we do not understand.
export function readMarker(state) {
  const m = state && state[MARKER_KEY]
  if (!m || m.v !== MARKER_VERSION || typeof m.id !== 'string') return null
  return m
}

export function useBackDismiss({ open, onDismiss, id }) {
  const cbRef = useRef(onDismiss)
  useEffect(() => { cbRef.current = onDismiss }, [onDismiss])

  // Set while WE are the ones calling history.back() (to consume our own entry after a Close-button
  // dismissal). Without it, that back() would fire popstate and re-enter onDismiss on an already
  // closed surface.
  const selfPopRef = useRef(false)

  useEffect(() => {
    if (!BACKNAV_ENABLED) return
    if (!open) return
    if (typeof window === 'undefined' || !window.history) return

    const prevState = window.history.state || {}
    window.history.pushState(
      { ...prevState, [MARKER_KEY]: { v: MARKER_VERSION, id } },
      ''
    )

    function onPop() {
      if (selfPopRef.current) { selfPopRef.current = false; return }
      // Dismiss ONLY if the entry that just became current is no longer OURS. Every open instance
      // has a popstate listener on window, so without this check a single Back closes every open
      // surface at once — B2 says close the topmost and NOTHING else. After popping B's entry the
      // current marker is A's: B sees "not mine, I was popped" and closes; A sees "still mine" and
      // stays. It also makes the hook correct when some other entry is pushed and popped above us.
      const cur = readMarker(window.history.state)
      if (cur && cur.id === id) return
      cbRef.current?.()
    }
    window.addEventListener('popstate', onPop)

    return () => {
      window.removeEventListener('popstate', onPop)
      // Closed by the labelled Close, the backdrop, or Escape — our entry is still sitting on top of
      // the stack, so consume it. Otherwise the stack grows by one per open/close cycle and the
      // user's Back count drifts further from what they expect on every interaction.
      //
      // GUARDED on the marker still being CURRENT. If the surface closed because the app navigated
      // away, a new entry sits above ours and history.back() would walk the user BACKWARD off the
      // page they just opened. Doing nothing there leaves one orphan entry, which is the lesser
      // evil and the reason this hook is scoped to close-in-place surfaces.
      const cur = readMarker(window.history.state)
      if (cur && cur.id === id) {
        selfPopRef.current = true
        window.history.back()
      }
    }
  }, [open, id])
}
