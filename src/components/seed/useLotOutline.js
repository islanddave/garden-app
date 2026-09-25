// src/components/seed/useLotOutline.js — V5-SEEDSTAB-001 §4.6: after a write, the row itself is the
// confirmation.
//
// A save inside Seeds never switches view and never navigates, so "it worked" has to be visible where
// the user already is: the affected row or card scrolls into sight and carries a static 2 px outline
// for about two seconds. Operational feedback, not a reward surface — no motion beyond the scroll,
// which is instant under prefers-reduced-motion, and no colour-only cue (the outline is a shape).
//
// `highlight` is `{ id, seq }` from the Seeds shell. `seq` makes a second highlight of the same lot
// fire again. `seq === 0` is the ARRIVAL hint from the URL (`?lot=`); `skipArrival` drops it when the
// view restored a scroll position, so Back to a list the user had scrolled does not yank them to the
// lot the page was first opened on.
import { useEffect, useRef, useState } from 'react'
import { usePageScrollYield } from '../../hooks/usePageScrollManager.js'

export const OUTLINE_MS = 2000

function prefersReducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

// ONCE per highlight ({id, seq}), not once per time `ready` turns true. A view's `ready` falls and
// rises whenever the lot is filtered out and back in, and each rise used to scroll the page back to a
// lot outlined long ago (pre-promote regression pass #2, finding A/B).
export function useLotOutline(highlight, { ready, skipArrival = false } = {}) {
  // An object, not the id: a second highlight of the SAME lot must restart the timer and scroll again.
  const [shown, setShown] = useState(null)
  const firedRef = useRef(null)
  const id = highlight?.id != null ? String(highlight.id) : null
  const seq = highlight?.seq ?? 0
  // BUG-DETAILPAGESCARRYSCROLL-001 (rimpact-scrollmanager-built N4): the outline scrolls on purpose — a row
  // the add form just created, after its navigate(-1) — so a Back restore still pulling toward the old
  // place stops for good first instead of yanking the page back from the row. A no-op outside the manager.
  const yieldScroll = usePageScrollYield()

  useEffect(() => {
    if (!ready || !id) return
    if (seq === 0 && skipArrival) return
    const key = `${id}|${seq}`
    if (firedRef.current === key) return
    firedRef.current = key
    setShown({ id, key })
    // skipArrival is read once per highlight; a later restore must not re-fire an old one.
  }, [ready, id, seq])  // eslint-disable-line react-hooks/exhaustive-deps

  // The outline's own life: scroll to it once and clear it after OUTLINE_MS, independent of `ready`,
  // so a lot filtered out mid-outline does not keep its outline forever.
  useEffect(() => {
    if (!shown) return undefined
    if (typeof document !== 'undefined') {
      const el = document.querySelector(`[data-lot-id="${shown.id}"]`)
      if (el && typeof el.scrollIntoView === 'function') {
        yieldScroll()
        el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      }
    }
    const t = setTimeout(() => setShown(null), OUTLINE_MS)
    return () => clearTimeout(t)
  }, [shown, yieldScroll])

  return shown?.id ?? null
}

// The outline itself, shared so every view draws the same one. P.green on the white card is well past
// the 3:1 non-text contrast floor; the offset keeps it off the card's own border.
export function outlineStyle(color) {
  return { outline: `2px solid ${color}`, outlineOffset: 2 }
}
