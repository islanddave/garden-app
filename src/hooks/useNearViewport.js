// src/hooks/useNearViewport.js — V5-SEEDCARDS-001. Which rows of a long list are within reach of the
// viewport, for a list whose page height does NOT depend on what is mounted in it.
//
// WHY NOT useImageWindow. That hook mounts a first page of N items and grows it whenever the viewport
// comes within 800px of the DOCUMENT bottom. Right for PhotosWall and TileGrid, which window ITEMS: each
// step makes the page taller, so growth follows the scroll. My seeds renders every row at full height
// whether its thumbnail is mounted or not (a fixed 40x40 box), so the page never grows: thumbnails past
// the first page never mounted while an open group was scrolled, and then ALL mounted at once near the
// bottom — the BUG-PHOTOTHUMB-001 burst the window exists to prevent (QA pre-promote review, 2026-09-19:
// a 60-row group scrolled to rows ~24-38 showed 24 thumbnails; near the bottom, 60 of 60 at once).
//
// WHY NOT IntersectionObserver, or loading="lazy". useImageWindow's header records the measurement:
// native lazy loading never fired on these surfaces on the live app (0 of 120 images requested), and IO
// is the machinery lazy rides on — "do not improve this to IO without first proving IO fires on the
// target surface". So this reads the rows' own boxes: on scroll and resize (passive, at most once per
// animation frame) and after every render (a group opened, a filter applied). Rows sit in document order
// in one column, so their boxes only move down the list: a binary search finds the first row in reach
// and the walk stops at the first row past it — O(log n + rows in reach) reads, and no writes.
//
// A row IN REACH (its box within `reach` px of the viewport) stays in the returned Set until `resetKey`
// changes, so a thumbnail never unmounts under the thumb as it scrolls; a filter or fold change starts
// over from what is in reach at that moment, measured before paint, so a row still on screen keeps its
// image through the change. A row with no box (jsdom, a hidden tab) is never in reach.
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'

export const REACH_PX = 800

const frame = (f) => (typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(f) : window.setTimeout(f, 16))
const cancelFrame = (id) => (typeof window.cancelAnimationFrame === 'function' ? window.cancelAnimationFrame(id) : window.clearTimeout(id))

// rootRef  — the element holding the rows
// selector — what a row is, inside it
// keyOf    — a row element's key (what the caller looks up in the returned Set)
// resetKey — change it to start over from what is in reach now (a filter or a fold changed)
export default function useNearViewport(rootRef, { selector, keyOf, reach = REACH_PX, resetKey } = {}) {
  const [near, setNear] = useState(() => new Set())
  const nearRef = useRef(near)

  // The rows in reach now, added to `from`; `from` itself when nothing new is in reach.
  const read = useRef(null)
  read.current = (from) => {
    const rows = rootRef.current ? rootRef.current.querySelectorAll(selector) : []
    const top = -reach, bottom = window.innerHeight + reach
    let lo = 0, hi = rows.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rows[mid].getBoundingClientRect().bottom < top) lo = mid + 1
      else hi = mid
    }
    let next = null
    for (let i = lo; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect()
      if (r.top > bottom) break
      if (!r.height) continue
      const k = keyOf(rows[i])
      if (!from.has(k)) (next ??= new Set(from)).add(k)
    }
    return next ?? from
  }

  const commit = useCallback((n) => {
    if (n === nearRef.current) return
    nearRef.current = n
    setNear(n)
  }, [])

  const pending = useRef(0)
  const schedule = useCallback(() => {
    if (pending.current) return
    pending.current = frame(() => {
      pending.current = 0
      commit(read.current(nearRef.current))
    })
  }, [commit])

  const firstKey = useRef(true)
  useLayoutEffect(() => {
    if (firstKey.current) { firstKey.current = false; return }
    commit(read.current(new Set()))
  }, [resetKey, commit])

  useEffect(() => { schedule() })

  useEffect(() => {
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (pending.current) cancelFrame(pending.current)
      pending.current = 0
    }
  }, [schedule])

  return near
}
