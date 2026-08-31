// useSuppressBottomNav — the session posture's "the screen becomes the task" mechanism, extracted
// for the second consumer (V4-PUTUPSESSION-001's freezer walk).
//
// BottomNav is App-level chrome and a page cannot re-render it, so a session hides it the way the
// app's own keyboard suppression already does: `visibility: hidden` on the <nav> PLUS
// `--bottom-nav-height: 0px`, TOGETHER, so the paint and the reserved inset can never disagree for
// a frame (BottomNav.jsx:183-197 states that invariant). Worth 56px of the most thumb-reachable
// strip on the device, occupied entirely by targets that ABANDON the session.
//
// WHY THIS IS A COPY AND NOT AN IMPORT FROM EventNew.jsx. EventNew carries the original and it is
// frozen — OPS-WEIGHINUXFROZEN-001, Dave: "frame is perfect. 100% A+". Editing it to import from
// here would be a change to the weigh-in surface for no behavioural gain, so the duplication is
// deliberate: this file is additive and EventNew is untouched. The style element carries its OWN id
// so the two can never fight over one node if a future surface mounts both.
//
// Effect cleanup is what makes "the nav must come back the moment he leaves" structural rather than
// a promise: unmount, a flag flip and a route change all restore it.
import { useEffect } from 'react'

const NAV_STYLE_ID = 'putup-walk-nav-suppress'

export function useSuppressBottomNav(active, styleId = NAV_STYLE_ID) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined
    const root = document.documentElement
    const prevInset = root.style.getPropertyValue('--bottom-nav-height')
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = 'nav[aria-label="Main navigation"]{visibility:hidden !important}'
    document.head.appendChild(style)
    root.style.setProperty('--bottom-nav-height', '0px')
    return () => {
      style.remove()
      // Restore the PREVIOUS value rather than the constant: BottomNav owns this var and may have
      // been mid-suppression (keyboard up) when the session mounted. Writing 56px back here would
      // fight it. An empty previous value means "never set" — remove, don't invent one.
      if (prevInset) root.style.setProperty('--bottom-nav-height', prevInset)
      else root.style.removeProperty('--bottom-nav-height')
    }
  }, [active, styleId])
}

export default useSuppressBottomNav
