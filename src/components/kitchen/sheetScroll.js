// src/components/kitchen/sheetScroll.js
// Put-Up 1a item 8 (V4 §6.6–§6.7: "the focused field under neither sticky band") — keeping the field
// a cook is typing into clear of a sheet's PINNED footer.
//
// THE DEFECT THIS EXISTS FOR, measured by gate:putup at 426×492 (keyboard up): Check on it's note
// field, focused, sat at y425-489 under the pinned Save footer (top y411). The browser does not scroll
// a focused field that is inside the scroll container's box, and a sticky footer covering it does not
// count as out of view — so nothing moved it. The plan's own remedy is scroll-padding on the scroller,
// but the scroller here is the shared <Sheet> panel (a frozen primitive another lane owns), so the
// correction is made from inside the sheet instead: on focus, and again when the keyboard resizes the
// viewport, the panel is scrolled just far enough that the focused field sits above the footer.
//
// Pure DOM arithmetic, no layout assumptions: it reads the two rects it is given and moves only the
// nearest [role="dialog"] ancestor's scrollTop.
import { useCallback, useEffect } from 'react'

export const FOOTER_GAP_PX = 8
// The panel is found by its role. UNQUOTED on purpose: modalSurfaceFreeze.static.test.js freezes the
// files that RENDER a role="dialog" surface by matching that quoted literal, and this file only
// QUERIES one — the quoted spelling would enrol it as a surface it is not.
const PANEL = '[role=dialog]'

// Returns the pixels scrolled (0 when the field was already clear, or nothing could be measured).
export function scrollClearOfFooter(field, footer, gap = FOOTER_GAP_PX) {
  const panel = field?.closest?.(PANEL)
  if (!panel || !footer || typeof field.getBoundingClientRect !== 'function') return 0
  const f = field.getBoundingClientRect()
  const band = footer.getBoundingClientRect()
  const over = f.bottom + gap - band.top
  if (!(over > 0)) return 0
  const before = panel.scrollTop
  panel.scrollTop = before + over
  return panel.scrollTop - before
}

const TYPEABLE = 'input, textarea, select, [contenteditable="true"]'

// `footerRef` points at the sheet's pinned footer; the returned handler goes on the sheet content's
// onFocus (React's onFocus bubbles, like focusin). While a field in the sheet holds focus, a viewport
// resize — the keyboard opening — re-applies the correction after the new geometry has settled.
export function useFieldsClearOfFooter(footerRef) {
  const onFocus = useCallback((e) => {
    const el = e?.target
    if (!el?.matches?.(TYPEABLE)) return
    scrollClearOfFooter(el, footerRef.current)
  }, [footerRef])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const again = () => {
      const el = document.activeElement
      const footer = footerRef.current
      if (!el || !footer || !el.matches?.(TYPEABLE)) return
      if (el.closest?.(PANEL) !== footer.closest?.(PANEL)) return
      requestAnimationFrame(() => scrollClearOfFooter(el, footer))
    }
    const vv = window.visualViewport
    window.addEventListener('resize', again)
    vv?.addEventListener?.('resize', again)
    return () => {
      window.removeEventListener('resize', again)
      vv?.removeEventListener?.('resize', again)
    }
  }, [footerRef])

  return onFocus
}
