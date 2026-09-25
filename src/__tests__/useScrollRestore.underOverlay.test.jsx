// BUG-OVERLAYRELOADKEY-001 — a page that MOUNTS under an open route overlay keeps its place, and a page
// whose overlay closes by REPLACE keeps saving it.
//
// Before: useScrollRestore keyed its offsets by window.history.state.key read at first render. Under an
// overlay that is the OVERLAY's entry, not the page's, so:
//   1. Search -> open a result -> Back (Search re-opens over a re-mounted page) -> X: the page read
//      nothing on the way in, and once the X had walked it home (its own key) it could save nothing, so
//      the next Back from a detail landed where the list was before Search (or at the top);
//   2. an overlay the close could not walk back from (a reload or tab restore with it open, one opened by
//      the previous bundle, a Back marker on top) closed by replace onto a NEW key: saving stopped there
//      too, mounted before the overlay or not.
// Real BrowserRouter + DismissRegistryProvider + OverlayProvider in App.jsx's two-tree shape, the real
// Sheet (kind="route") whose close is the real useOverlayDismiss, and the real hook. jsdom has no layout,
// so the scroll surface is modelled: scrollTo clamps to `maxScroll`, as Chrome does. The real-Chrome
// proof of case 1 is gate:seeds-scroll flow h. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react'
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { OverlayProvider, useOverlay, OverlayLink, useOverlayDismiss } from '../context/OverlayContext.jsx'
import Sheet from '../components/forms/Sheet.jsx'
import useScrollRestore, { __resetScrollRestoreStore } from '../hooks/useScrollRestore.js'
import { CONTINUES_ENTRY_KEY } from '../lib/pageEntry.js'

// ---- scroll model ----
let maxScroll = 5000
function setScrollY(y) {
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })
}
const userScrollsTo = (y) => act(async () => { setScrollY(y); window.dispatchEvent(new Event('scroll')) })

let mounts = 0
function ListPage() {
  useScrollRestore({ id: 'list', ready: true })
  React.useEffect(() => { mounts += 1 }, [])
  return (
    <div data-testid="list">
      <OverlayLink to="/search" data-testid="open">open</OverlayLink>
      <LegacyOpener />
      <Link to="/detail" data-testid="to-detail">detail</Link>
    </div>
  )
}
// An entry written by the bundle before v4.151.0: a background with no historyEntry, so the close cannot
// prove where the page's entry is and replaces — the same branch a reload or a tab restore takes.
function LegacyOpener() {
  const loc = useLocation()
  return <Link to="/search" state={{ background: loc }} data-testid="open-legacy">legacy</Link>
}
// PlantingDetail's reset on mount: a pushed page starts at the top.
function Detail() {
  React.useEffect(() => { window.scrollTo(0, 0) }, [])
  return <div data-testid="detail">detail</div>
}
// Search, in miniature: a result is a plain <Link> to the page, a PUSH with no background (Search.jsx).
function SearchOverlay() {
  const dismiss = useOverlayDismiss()
  return (
    <Sheet open onClose={dismiss} ariaLabel="Search stand-in" kind="route">
      <div data-testid="overlay"><Link to="/detail" data-testid="result">a result</Link></div>
    </Sheet>
  )
}
function Shell() {
  const { pageLocation, overlayLocation, background } = useOverlay()
  return (
    <>
      <Routes location={pageLocation}>
        <Route path="/today" element={<Link to="/list" data-testid="to-list">list</Link>} />
        <Route path="/list" element={<ListPage />} />
        <Route path="/detail" element={<Detail />} />
      </Routes>
      {background && (
        <Routes location={overlayLocation}>
          <Route path="/search" element={<SearchOverlay />} />
        </Routes>
      )}
    </>
  )
}

const key = () => window.history.state?.key
const path = () => window.location.pathname
const overlayOpen = () => !!screen.queryByTestId('overlay')
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
const tapClose = () => act(async () => { fireEvent.click(document.querySelector('[data-sheet-close]')) })
const stored = () => { try { return JSON.parse(window.sessionStorage.getItem('garden.scrollRestore.v1')) || {} } catch { return {} } }
const back = () => act(async () => { window.history.back() })
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 80)) })

const realRaf = window.requestAnimationFrame
const realCaf = window.cancelAnimationFrame
const realScrollTo = window.scrollTo
beforeEach(() => {
  __resetScrollRestoreStore()
  mounts = 0
  maxScroll = 5000
  setScrollY(0)
  window.scrollTo = (x, y) => { setScrollY(Math.max(0, Math.min(typeof x === 'object' ? x.top : y, maxScroll))) }
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0)
  window.cancelAnimationFrame = (id) => clearTimeout(id)
  window.history.replaceState(null, '', '/today')
})
afterEach(() => {
  cleanup()
  document.body.style.overflow = ''
  document.body.style.overscrollBehavior = ''
  window.requestAnimationFrame = realRaf
  window.cancelAnimationFrame = realCaf
  window.scrollTo = realScrollTo
  __resetScrollRestoreStore()
})

// /today -> /list by a push, so the list has an entry of its own.
async function toList() {
  render(<BrowserRouter><DismissRegistryProvider><OverlayProvider><Shell /></OverlayProvider></DismissRegistryProvider></BrowserRouter>)
  await tap('to-list')
  await waitFor(() => expect(screen.getByTestId('list')).toBeTruthy())
  return key()
}
async function openOverlay(id = 'open') {
  await tap(id)
  await waitFor(() => expect(overlayOpen()).toBe(true))
  expect(path()).toBe('/search')
}
// Search -> a result -> Back: Search re-opens over a list that has just re-mounted.
async function resultThenBack() {
  const before = mounts
  await tap('result')
  await waitFor(() => expect(screen.getByTestId('detail')).toBeTruthy())
  expect(overlayOpen()).toBe(false)
  await back()
  await waitFor(() => expect(overlayOpen()).toBe(true))
  await waitFor(() => expect(screen.getByTestId('list')).toBeTruthy())
  // The instrument: the list really re-mounted UNDER the overlay. Without it this is the v4.151.0 case.
  expect(mounts).toBe(before + 1)
  expect(path()).toBe('/search')
}
async function closeOnto(expectedPath) {
  await tapClose()
  await waitFor(() => expect(overlayOpen()).toBe(false))
  await settle()
  expect(path()).toBe(expectedPath)
}
// A detail and Back: the list re-mounts on the entry it is on and restores what it saved there.
async function detailAndBack() {
  await tap('to-detail')
  await waitFor(() => expect(screen.getByTestId('detail')).toBeTruthy())
  expect(window.scrollY).toBe(0)
  await back()
  await waitFor(() => expect(screen.getByTestId('list')).toBeTruthy())
  await settle()
}

describe('a page that mounts under an open overlay files its place under its OWN entry', () => {
  it('Search -> a result -> Back -> X: the list comes back where it was, and keeps saving after the X', async () => {
    const k1 = await toList()
    await userScrollsTo(900)
    await openOverlay()
    await resultThenBack()
    // Under the overlay the re-mounted list restores its own entry's offset (it used to read the overlay's
    // entry, find nothing, and stay where the detail left the window: 0).
    await waitFor(() => expect(window.scrollY).toBe(900))
    await closeOnto('/list')
    expect(key()).toBe(k1)                                   // the walk, as v4.151.0 closes
    // After the X the list keeps saving: a new place, then a detail and Back, lands on the new place.
    await userScrollsTo(1200)
    await detailAndBack()
    expect(key()).toBe(k1)
    await waitFor(() => expect(window.scrollY).toBe(1200))
    expect(stored()['list|' + k1].y).toBe(1200)
  })

  it('the push off the overlay does not file the next page\'s clamped offset under the list', async () => {
    const k1 = await toList()
    await userScrollsTo(900)
    await openOverlay()
    await resultThenBack()
    await waitFor(() => expect(window.scrollY).toBe(900))
    // react-router pushes synchronously in the click; the clamp to the detail's first paint (and the
    // scroll event it fires) lands before the list's cleanup runs. Neither may be filed under the list.
    await act(async () => {
      fireEvent.click(screen.getByTestId('result'))
      setScrollY(56)
      window.dispatchEvent(new Event('scroll'))
    })
    await waitFor(() => expect(screen.getByTestId('detail')).toBeTruthy())
    expect(stored()['list|' + k1].y).toBe(900)
  })
})

describe('an overlay closed by replace leaves the page one identity', () => {
  it('mounted before the overlay: after a replace-close the list keeps saving, and Back restores it', async () => {
    const k1 = await toList()
    await userScrollsTo(700)
    await openOverlay('open-legacy')
    await closeOnto('/list')
    // The instrument: this is the replace path — a new key — stamped with the entry it continues.
    expect(key()).not.toBe(k1)
    expect(window.history.state?.usr?.[CONTINUES_ENTRY_KEY]).toBe(k1)
    await userScrollsTo(1500)
    await detailAndBack()
    await waitFor(() => expect(window.scrollY).toBe(1500))
  })

  it('mounted under the overlay (a reload or tab restore with it open): restores, then keeps saving through the replace', async () => {
    const k1 = await toList()
    await userScrollsTo(800)
    await openOverlay('open-legacy')
    await resultThenBack()
    await waitFor(() => expect(window.scrollY).toBe(800))
    await closeOnto('/list')
    expect(key()).not.toBe(k1)
    await userScrollsTo(1600)
    await detailAndBack()
    await waitFor(() => expect(window.scrollY).toBe(1600))
    // Both copies of the list in the stack are one visit: they share the offset.
    expect(stored()['list|' + k1].y).toBe(1600)
  })

  it('an overlay opened over the replaced entry, and closed by replace again, still continues the ORIGINAL entry', async () => {
    const k1 = await toList()
    await openOverlay('open-legacy')
    await closeOnto('/list')
    const k2 = key()
    expect(k2).not.toBe(k1)
    await openOverlay('open-legacy')
    await closeOnto('/list')
    expect(key()).not.toBe(k2)
    expect(window.history.state?.usr?.[CONTINUES_ENTRY_KEY]).toBe(k1)
  })
})
