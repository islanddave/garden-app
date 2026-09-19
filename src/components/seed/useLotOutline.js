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
import { useEffect, useState } from 'react'

export const OUTLINE_MS = 2000

function prefersReducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export function useLotOutline(highlight, { ready, skipArrival = false } = {}) {
  const [outlined, setOutlined] = useState(null)
  const id = highlight?.id != null ? String(highlight.id) : null
  const seq = highlight?.seq ?? 0

  useEffect(() => {
    if (!ready || !id) return undefined
    if (seq === 0 && skipArrival) return undefined
    setOutlined(id)
    const t = setTimeout(() => setOutlined(null), OUTLINE_MS)
    return () => clearTimeout(t)
    // skipArrival is read once per highlight; a later restore must not re-fire an old one.
  }, [ready, id, seq])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!outlined || typeof document === 'undefined') return
    const el = document.querySelector(`[data-lot-id="${outlined}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    }
  }, [outlined])

  return outlined
}

// The outline itself, shared so every view draws the same one. P.green on the white card is well past
// the 3:1 non-text contrast floor; the offset keeps it off the card's own border.
export function outlineStyle(color) {
  return { outline: `2px solid ${color}`, outlineOffset: 2 }
}
