// src/hooks/useScrollRestore.js
// V4-SCROLLRESTORE-001 (BD0806-05) — "I lose my place when I hit Back", generalised.
//
// WHAT THIS IS. Garden already restores scroll correctly in prod (V4-NAVSTATE-001/002). The
// decision half of that is pure and tested in src/lib/scrollRestore.js; the DRIVER half was inline
// in Garden.jsx and therefore reachable from exactly one page. This hook is that driver, extracted,
// with three changes Garden's version could not make as a page-local global:
//
//   1. KEYED PER HISTORY ENTRY, not per route. Garden stores one module-scoped `lastGardenScrollY`,
//      so arriving at Garden from ANYWHERE restores the last offset — including a fresh forward
//      navigation, where the user has never been down the page. Here the offset is filed under the
//      history entry it belongs to (react-router keeps its entry key in window.history.state.key —
//      the same field DismissRegistry is careful to merge rather than clobber), so Back restores and
//      a forward navigation is inert.
//   2. NO ROUTER IMPORT. The key is read from window.history.state directly rather than through
//      useLocation(). Five PhotoLibrary suites replace 'react-router-dom' wholesale with a stub that
//      exports only <Link>; a useLocation() in this file would fault the page in all of them. The
//      value read is the same one react-router wrote.
//   3. A VIEW-STATE CHANNEL (saveState / restoredState) alongside the offset — see ORDERING below.
//
// ORDERING — the coupling is the whole problem. A surface that refetches on mount has NO document
// height at the instant a restore would fire, so a naive restore lands on a spinner, gets clamped to
// ~0 by the browser, and the position is lost anyway. Three things handle that, in order:
//
//   (a) The restore is gated on `ready` (the page's own loading flag going false), so the first
//       attempt happens in the commit that painted the content, not before it.
//   (b) `restoredState` is readable at FIRST RENDER, before any effect runs, so a page can shape its
//       initial fetch or its initial window size with it (FeedPage asks for the depth the user had
//       paged to; PhotoLibrary re-opens its tile window). That is what makes the content tall enough
//       to hold the target offset at all, rather than hoping it grows in time.
//   (c) restoreStep()'s retry loop absorbs whatever height still arrives late (images, fonts, a
//       window that grows on scroll). A clamped scrollTo is itself a growth trigger — see the long
//       note in src/lib/scrollRestore.js.
//
// WHEN THE TARGET EXCEEDS THE NEW CONTENT HEIGHT the browser clamps silently and restoreStep keeps
// returning RETRY until the ~20-frame budget is spent, then EXHAUSTED. The user is left at the
// bottom of the content that does exist — the closest reachable point to where they were — and the
// loop stops. It never spins, never fights, and never throws. That is deliberate: the DONE/EXHAUSTED
// distinction exists so an anchor-based fallback can branch on it later; inventing one now is not
// this ticket.
//
// NEVER FIGHT THE USER: a wheel/touchstart/keydown at any point hands control back permanently for
// that mount.
//
// STORAGE is an in-memory Map (the Back case never leaves the document) mirrored best-effort into
// sessionStorage so the position survives the PWA's cache-first service-worker swap. Declared
// expedient per the Cross-Device State rule: this is tab-scoped, non-user-meaningful view state, it
// is capped at MAX_ENTRIES, and nothing reads it but this hook.
import { useCallback, useEffect, useRef, useState } from 'react'
import { restoreStep, hasRestoreTarget } from '../lib/scrollRestore.js'
import { pageEntryKey } from '../lib/pageEntry.js'

const STORE_KEY = 'garden.scrollRestore.v1'
// Deep enough to cover any realistic back-stack in one session, small enough that the JSON written
// on pagehide stays trivial. Oldest entry is evicted first (Map preserves insertion order).
const MAX_ENTRIES = 20

let mem = null

function store() {
  if (mem) return mem
  mem = new Map()
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        // A hand-edited or half-written blob must not be able to feed a non-numeric offset into the
        // restore loop; hasRestoreTarget would reject it later, but rejecting it here keeps the
        // store's shape an invariant rather than a hope.
        if (v && typeof v === 'object' && Number.isFinite(v.y)) mem.set(k, { y: v.y, s: v.s })
      }
    }
  } catch { /* private mode, quota, corrupt blob — the in-memory half still works */ }
  return mem
}

function flush() {
  try { window.sessionStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(store()))) }
  catch { /* best effort, never load-bearing */ }
}

// react-router (BrowserRouter, v7) keeps {usr, key, idx} in window.history.state and restores it on
// popstate, so this is stable across a Back and distinct for every forward navigation. The 'default'
// fallback is the same literal react-router uses for the entry that has no state yet, and it is what
// jsdom (no history state) sees — inert there, because nothing ever saves a non-zero offset.
// The entry is the one the PAGE TREE shows (pageEntryKey): under a route overlay that is the overlay's
// background, not the overlay's own entry, and an entry an overlay's replace-close left behind answers
// to the page entry it continues (BUG-OVERLAYRELOADKEY-001, src/lib/pageEntry.js).
function entryKey(id) {
  let k = null
  try { k = pageEntryKey(window.history && window.history.state) } catch { /* opaque origin */ }
  return `${id}|${k || 'default'}`
}

function readEntry(key) { return store().get(key) }

function writeEntry(key, y, s) {
  const m = store()
  // Do not mint an entry for a visit that has nothing to say. Overwriting an EXISTING entry with 0
  // is kept, though — that is the user deliberately scrolling back to the top.
  if (!hasRestoreTarget(y) && s === undefined && !m.has(key)) return
  m.delete(key)
  m.set(key, { y, s })
  while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value)
}

// Test seam only. Production code must not reach into the store.
export function __resetScrollRestoreStore() {
  mem = null
  try { window.sessionStorage.removeItem(STORE_KEY) } catch { /* ignore */ }
}
export function __seedScrollRestoreEntry(id, y, s) { writeEntry(entryKey(id), y, s) }
export function __peekScrollRestoreEntry(id) { return readEntry(entryKey(id)) }

/**
 * Restore this history entry's scroll offset once the surface's content has landed.
 *
 * @param {object}  opts
 * @param {string}  opts.id     Surface namespace ('photos', 'feed', …). Combined with the history
 *                              entry key, so two surfaces can never read each other's offset.
 * @param {boolean} opts.ready  The page's content is committed — normally `!loading`. The restore
 *                              does not start until this is true.
 * @param {boolean} [opts.stateAtTop=false]  Hand back the saved view state even when there is no
 *                              offset to restore (V5-SEEDSPOLISH-001). For pages whose view state is
 *                              DISCLOSURE — folded groups, an expanded card — which the user sets
 *                              without scrolling at all. Off by default because FeedPage and
 *                              PhotoLibrary size their first fetch or tile window from the state, and
 *                              a user sitting at the top needs none of that depth.
 * @returns {{restoredState: any, saveState: (v:any)=>void}}
 *   restoredState — the view state saved with this entry's offset, available at FIRST RENDER so it
 *                   can seed a lazy useState or the initial fetch. `undefined` when there is nothing
 *                   to restore (fresh entry, or the user was at the top anyway — unless stateAtTop).
 *   saveState     — record the current view state to persist alongside the offset. Stable identity;
 *                   call it from an effect.
 */
export default function useScrollRestore({ id, ready, stateAtTop = false }) {
  const keyRef = useRef(null)
  if (keyRef.current === null) keyRef.current = entryKey(id)
  // The id that key was built from, so `write` can re-derive it and ask whether this mount's entry is
  // still the current one. A ref rather than a dep keeps write, and so saveState, stable.
  const idRef = useRef(id)

  // Snapshotted at first render, before any save can run, so it is immune to the writes this same
  // mount is about to make.
  const [saved] = useState(() => readEntry(keyRef.current))
  const targetY = saved && Number.isFinite(saved.y) ? saved.y : 0
  const armed = hasRestoreTarget(targetY)

  const stateRef = useRef(saved ? saved.s : undefined)
  // WRITES ARE CLOSED UNTIL THE RESTORE RESOLVES. Otherwise the mount's own scrollY of 0 — or a
  // clamped intermediate offset from our own scrollTo — overwrites the very target we are trying to
  // reach, and the second Back lands short. An unmount that happens while still closed deliberately
  // leaves the stored target intact.
  const openRef = useRef(!armed)
  const doneRef = useRef(!armed)

  const write = useCallback(() => {
    if (!openRef.current) return
    // ONLY THE ENTRY THIS MOUNT BELONGS TO MAY BE WRITTEN (BUG-SAVEDSEEDSBACKTOP-001). Once the router
    // has pushed or popped, window.scrollY describes the NEXT page. The unmount cleanup runs after React
    // has swapped the DOM, when Chrome has already clamped the offset to that page's short first paint
    // (Saved seeds → a planting's "Loading…" read 56 and overwrote the 4,147 the listener had saved),
    // and a scroll event that clamp fires can land before the cleanup does. react-router writes
    // history.state synchronously in the click, and the browser does before popstate, so by either read
    // the key has moved on and the last write made while the entry was current stands. A sheet's Back
    // marker keeps the key (DismissRegistry merges it), so saving continues under an open sheet, and a
    // route overlay's entry resolves to its background (entryKey), so it continues under one of those
    // too: the window still scrolls the page under the sheet, never the overlay's content.
    if (entryKey(idRef.current) !== keyRef.current) return
    writeEntry(keyRef.current, window.scrollY, stateRef.current)
  }, [])

  const saveState = useCallback((value) => { stateRef.current = value; write() }, [write])

  // Any real input hands control back for good: it cancels a running restore and re-opens writes so
  // wherever the user goes is what gets stored.
  useEffect(() => {
    const takeover = () => { doneRef.current = true; openRef.current = true }
    const opts = { passive: true }
    window.addEventListener('wheel', takeover, opts)
    window.addEventListener('touchstart', takeover, opts)
    window.addEventListener('keydown', takeover, opts)
    return () => {
      window.removeEventListener('wheel', takeover, opts)
      window.removeEventListener('touchstart', takeover, opts)
      window.removeEventListener('keydown', takeover, opts)
    }
  }, [])

  useEffect(() => {
    const onScroll = () => write()
    const onHide = () => { write(); flush() }
    window.addEventListener('scroll', onScroll, { passive: true })
    // pagehide, not unload: an installed PWA is frozen/discarded rather than unloaded, and unmount
    // alone does not fire when Chrome tears the document down.
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', onHide)
      // write() saves only while this entry is still current (see write): an unmount caused by a
      // navigation leaves the listener's last write in place. flush() persists either way.
      write(); flush()
    }
  }, [write])

  useEffect(() => {
    if (!ready || doneRef.current) return
    let frames = 0
    let raf = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      if (doneRef.current) { openRef.current = true; return }   // user took over mid-flight
      try { window.scrollTo(0, targetY) } catch { /* jsdom stubs scrollTo */ }
      frames += 1
      if (restoreStep({ currentY: window.scrollY, targetY, frames }) === 'RETRY') {
        raf = requestAnimationFrame(tick)
        return
      }
      // DONE and EXHAUSTED both latch and both re-open writes. They differ only in whether we
      // landed, which nothing branches on yet.
      doneRef.current = true
      openRef.current = true
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelled = true; cancelAnimationFrame(raf) }
  }, [ready, targetY])

  // Read from the first-render SNAPSHOT, never from stateRef — restoredState must stay stable
  // across re-renders even after the page has started calling saveState with newer values.
  // Gated on `armed`: with no offset to restore there is no view to reconstruct either, and a page
  // that acted on it would refetch a deep page for a user who was sitting at the top. `stateAtTop`
  // lifts that gate for a page whose state is disclosure rather than depth: an entry only exists for
  // a history entry this page has already saved into, so a defined value still means "Back", never a
  // fresh visit.
  return { restoredState: (armed || stateAtTop) && saved ? saved.s : undefined, saveState }
}
