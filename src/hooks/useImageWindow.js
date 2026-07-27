// src/hooks/useImageWindow.js
// BUG-PHOTOTHUMB-001 — app-owned image windowing, because NEITHER browser mechanism works here.
//
// Measured on the live app (2026-07-27, Dave's own browser): with loading="lazy", 0 of 120 <img>
// with correct srcs were ever REQUESTED — not slow, never fetched — which is why image surfaces sat
// blank and then filled all at once when something finally forced a layout recalc. The same
// elements flipped to eager loaded instantly, so URLs/presigns/S3/thumbs were fine the whole time;
// native lazy simply never fires on these grids. But flipping ALL 120 to eager FROZE the renderer,
// so "just remove lazy" is not sufficient either: the number of live <img> elements has to be
// bounded by US.
//
// Scroll listener rather than IntersectionObserver, deliberately: IO is the same
// viewport-intersection machinery native lazy depends on, and that is precisely what is not firing.
// Do not "improve" this to IO without first proving IO fires on the target surface.
//
// Extracted from the PhotoLibrary fix verified live in v3.68.0 (24/24 in 596ms, was 0/120 forever)
// so every image surface shares one implementation instead of N copies.
import { useState, useEffect, useCallback } from 'react'

export const IMAGE_WINDOW_PAGE = 24

// total    — full item count the window is drawn from
// page     — how many to add per growth step
// enabled  — false = pass-through (show everything, attach no listener), so a caller can opt in
//            per surface without branching around the hook call
// resetKey — change it to collapse the window back to one page (filter/route change)
export default function useImageWindow(total, { page = IMAGE_WINDOW_PAGE, enabled = true, resetKey } = {}) {
  const [shown, setShown] = useState(page)

  useEffect(() => { setShown(page) }, [page, resetKey])

  // `shown` is in the deps deliberately: after each growth step this re-runs and re-checks whether
  // the page is STILL shorter than the viewport + buffer, so the first screen fills itself without
  // needing a single scroll event to fire. It converges rather than runs away — each step makes the
  // document taller, and growth stops as soon as content exceeds viewport + 800 (measured: a
  // 2122px-tall viewport settles at 48 of 211 and stops). Bounded by `total` regardless.
  // This matters because the whole bug class here is browser viewport machinery NOT firing; the
  // initial fill must not depend on it. Scroll + the Show-more button then handle the rest.
  useEffect(() => {
    if (!enabled) return
    function onScroll() {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 800) {
        setShown(s => (s < total ? s + page : s))
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll() // a first page shorter than the viewport must still be able to grow without a scroll
    return () => window.removeEventListener('scroll', onScroll)
  }, [total, page, enabled, shown])

  const showMore = useCallback(() => setShown(s => s + page), [page])

  if (!enabled) {
    return { shown: total, showMore: () => {}, hasMore: false, remaining: 0 }
  }
  return { shown, showMore, hasMore: shown < total, remaining: Math.max(0, total - shown) }
}
