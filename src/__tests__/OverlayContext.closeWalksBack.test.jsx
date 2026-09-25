// BUG-OVERLAYDISMISSREKEY-001 — closing an overlay (its X, backdrop, Escape, or a Done that dismisses)
// returns to the page's OWN history entry, the way the system Back does, instead of replacing the
// overlay's entry with a second copy of the page.
//
// What the replace cost, both measured here against dev 2e576239 before the fix:
//   1. the page stayed mounted under a key it never opened on, so useScrollRestore saved nothing for
//      the rest of the visit (Back from a detail landed at the top — gate:seeds-scroll flow d);
//   2. the stack held the page twice, so the first Back after a close stayed on the page.
//
// Real BrowserRouter + DismissRegistryProvider + OverlayProvider in App.jsx's two-tree shape, and the
// real Sheet with kind="route" as OverlayHost renders it, because the close runs through the Sheet's
// own controls and the registry's Escape listener. jsdom's history traversal is asynchronous (popstate
// lands after a task, measured ~50ms in SearchPeek.test.jsx), so every landing is awaited. No jest-dom
// (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react'
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import {
  OverlayProvider, useOverlay, OverlayLink, useOverlayDismiss, useOverlayBackground, useOverlayNavigate, planOverlayClose,
} from '../context/OverlayContext.jsx'
import Sheet from '../components/forms/Sheet.jsx'
import SheetRowLink from '../components/SheetRowLink.jsx'
import { MARKER_KEY, MARKER_VERSION, readMarker } from '../lib/backNav.js'

// The overlay: the real Sheet as OverlayHost renders it (onClose = the dismiss), with a Done that calls
// the same dismiss (LogMany's) and a peek that PUSHES inside the overlay carrying its background, as
// Search's result peek does — so a close from there is two entries deep.
function OverlayStandIn() {
  const dismiss = useOverlayDismiss()
  const background = useOverlayBackground()
  const navigate = useNavigate()
  return (
    <Sheet open onClose={dismiss} ariaLabel="Search stand-in" kind="route">
      <div data-testid="overlay">
        <ContentDone />
        <button type="button" data-testid="peek" onClick={() => navigate('/search?peek=1', { state: { background } })}>peek</button>
      </div>
    </Sheet>
  )
}
// The content's own Done in its OWN component — its own useOverlayDismiss, as LogMany's Done and
// EventNew's ghost button have — so a Done and the host's X are two hook instances, as in the app.
function ContentDone() {
  const dismiss = useOverlayDismiss()
  return <button type="button" data-testid="done" onClick={dismiss}>done</button>
}
// BottomNav's +LOG door, in miniature: an armed sheet (armsBack, so the registry pushes a Back marker)
// whose row is a SheetRowLink with `overlay` — on tap it closes the sheet and REPLACE-opens the overlay
// into the marker's slot (SheetRowLink.jsx). The marker copied the page's idx, and a replace keeps it.
function PlusLogDoor() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button type="button" data-testid="plus-log" onClick={() => setOpen(true)}>+LOG</button>
      <Sheet open={open} onClose={() => setOpen(false)} ariaLabel="Create new" armsBack>
        <SheetRowLink to="/search" overlay onClick={() => setOpen(false)} data-testid="row-log">Log an event</SheetRowLink>
      </Sheet>
    </>
  )
}
// An overlay opened by replace over the page's OWN entry (no marker): that entry is gone, so there is
// nothing behind the overlay to walk back to.
function ReplaceOpener() {
  const nav = useOverlayNavigate()
  return <button type="button" data-testid="open-replace" onClick={() => nav('/search', { replace: true })}>replace-open</button>
}
// An entry written by the bundle BEFORE this release: a background with no historyEntry.
function LegacyOpener() {
  const loc = useLocation()
  return <Link to="/search" state={{ background: loc }} data-testid="open-legacy">legacy</Link>
}
function Shell() {
  const { pageLocation, overlayLocation, background } = useOverlay()
  return (
    <>
      <Routes location={pageLocation}>
        <Route path="/today" element={<Link to="/list" data-testid="to-list">list</Link>} />
        <Route path="/list" element={(
          <div data-testid="list">
            <OverlayLink to="/search" data-testid="open">open</OverlayLink>
            <LegacyOpener />
            <ReplaceOpener />
            <PlusLogDoor />
          </div>
        )} />
      </Routes>
      {background && (
        <Routes location={overlayLocation}>
          <Route path="/search" element={<OverlayStandIn />} />
        </Routes>
      )}
    </>
  )
}

const key = () => window.history.state?.key
const path = () => window.location.pathname + window.location.search
const overlayOpen = () => !!screen.queryByTestId('overlay')
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 80)) })
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
const tapClose = () => act(async () => { fireEvent.click(document.querySelector('[data-sheet-close]')) })

beforeEach(() => { window.history.replaceState(null, '', '/today') })
afterEach(() => {
  cleanup()
  document.body.style.overflow = ''
  document.body.style.overscrollBehavior = ''
})

// /today → /list by a push, so the list has an entry of its own with one behind it.
async function toList() {
  render(<BrowserRouter><DismissRegistryProvider><OverlayProvider><Shell /></OverlayProvider></DismissRegistryProvider></BrowserRouter>)
  await tap('to-list')
  await waitFor(() => expect(screen.getByTestId('list')).toBeTruthy())
  return key()
}
async function open(id = 'open') {
  await tap(id)
  await waitFor(() => expect(overlayOpen()).toBe(true))
  expect(path()).toBe('/search')
}
async function closedOnto(expectedPath) {
  await waitFor(() => expect(overlayOpen()).toBe(false))
  await settle()
  expect(path()).toBe(expectedPath)
}
async function backLandsOn(expectedPath) {
  await act(async () => { window.history.back() })
  await waitFor(() => expect(path()).toBe(expectedPath))
}

describe('closing an overlay returns to the page\'s own history entry', () => {
  it('the X: back on the list\'s own entry, and ONE Back then leaves the list', async () => {
    const k1 = await toList()
    await open()
    await tapClose()
    await closedOnto('/list')
    expect(key()).toBe(k1)
    await backLandsOn('/today')
  })

  it('the backdrop closes the same way', async () => {
    const k1 = await toList()
    await open()
    // Sheet renders its backdrop as the dialog's previous sibling; a tap there calls onClose directly
    // (not requestDismiss), so it is its own door.
    await act(async () => { fireEvent.click(document.querySelector('[role="dialog"]').previousElementSibling) })
    await closedOnto('/list')
    expect(key()).toBe(k1)
    await backLandsOn('/today')
  })

  it('Escape and Done close the same way', async () => {
    const k1 = await toList()
    await open()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await closedOnto('/list')
    expect(key()).toBe(k1)
    await open()
    await tap('done')
    await closedOnto('/list')
    expect(key()).toBe(k1)
    await backLandsOn('/today')
  })

  it('the +LOG door (opened by replace into an armed sheet\'s Back marker): the X lands on the list, and ONE Back leaves it', async () => {
    const k1 = await toList()
    await tap('plus-log')
    // The instrument: the sheet really armed Back, so the row really opens by REPLACE over a marker that
    // carries the list's idx. Without the marker this is just the header-Search case again.
    await waitFor(() => expect(readMarker(window.history.state)).toBeTruthy())
    expect(window.history.state.idx).toBeTypeOf('number')
    const listIdx = window.history.state.idx
    await tap('row-log')
    await waitFor(() => expect(overlayOpen()).toBe(true))
    expect(path()).toBe('/search')
    expect(window.history.state.idx).toBe(listIdx)
    expect(readMarker(window.history.state)).toBe(null)
    await tapClose()
    await closedOnto('/list')
    expect(key()).toBe(k1)
    await backLandsOn('/today')
  })

  it('from a peek pushed inside the overlay (two entries deep), one close still lands on the list', async () => {
    const k1 = await toList()
    await open()
    await tap('peek')
    await waitFor(() => expect(path()).toBe('/search?peek=1'))
    expect(overlayOpen()).toBe(true)
    await tapClose()
    await closedOnto('/list')
    expect(key()).toBe(k1)
    await backLandsOn('/today')
  })
})

// Counted at history.go, where react-router's navigate(-n) lands, rather than read off where the stack
// ends up: jsdom resolves two go(-1) queued in one task to the SAME entry, so a landing assertion alone
// cannot tell one walk from two — and whether Chrome compounds them is exactly what must not be relied on.
describe('a walk back is not idempotent, so it is guarded', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const walks = (go) => go.mock.calls.filter(([delta]) => delta < 0).length

  it('a second close before the first lands (a double tap) walks back once', async () => {
    const k1 = await toList()
    await open()
    const go = vi.spyOn(window.history, 'go')
    await act(async () => {
      fireEvent.click(document.querySelector('[data-sheet-close]'))
      fireEvent.click(screen.getByTestId('done'))
    })
    expect(walks(go)).toBe(1)
    await closedOnto('/list')
    expect(key()).toBe(k1)
  })

  it('Escape auto-repeat (three keydowns before the pop lands) walks back once', async () => {
    const k1 = await toList()
    await open()
    const go = vi.spyOn(window.history, 'go')
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      fireEvent.keyDown(document, { key: 'Escape' })
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(walks(go)).toBe(1)
    await closedOnto('/list')
    expect(key()).toBe(k1)
  })

  // The window a pending-walk guard cannot see: history is ALREADY on the page's entry (a system Back,
  // or the first press's walk, has landed) but BrowserRouter commits locations in a transition, so the
  // overlay is still on screen. A replace here would overwrite the page's own entry.
  it('the X pressed after a Back has landed but before React has committed leaves the page\'s entry alone', async () => {
    const k1 = await toList()
    await open()
    let pressedInWindow = false
    const onPop = () => {
      window.removeEventListener('popstate', onPop)
      const x = document.querySelector('[data-sheet-close]')
      if (x && window.history.state?.key === k1) { pressedInWindow = true; fireEvent.click(x) }
    }
    window.addEventListener('popstate', onPop)
    const go = vi.spyOn(window.history, 'go')
    const replace = vi.spyOn(window.history, 'replaceState')
    await act(async () => { window.history.back(); await new Promise((r) => setTimeout(r, 80)) })
    // The instrument: the X really was pressed in that window. Without it this is a plain system Back.
    expect(pressedInWindow).toBe(true)
    await closedOnto('/list')
    expect(walks(go)).toBe(0)
    expect(replace.mock.calls.length).toBe(0)
    expect(key()).toBe(k1)
    await backLandsOn('/today')
  })

  it('a walk that never lands does not leave the X dead: past the wait, a close falls back to replace', async () => {
    const k1 = await toList()
    await open()
    // The traversal is swallowed (a cancelled or impossible walk), so the overlay stays up.
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await tapClose()
    await settle()
    expect(walks(go)).toBe(1)
    expect(overlayOpen()).toBe(true)
    now += 200                                        // a slow phone, still well inside the wait
    await tapClose()                                  // inside the wait: still waiting for the walk
    await settle()
    expect(walks(go)).toBe(1)
    expect(overlayOpen()).toBe(true)
    now += 2000
    await tapClose()                                  // past it: close the old way
    await closedOnto('/list')
    expect(walks(go)).toBe(1)
    expect(key()).not.toBe(k1)                         // the replace path, by construction
  })

  it('the overlay re-entered by Forward can be closed again (the guard is released)', async () => {
    const k1 = await toList()
    await open()
    await tapClose()
    await closedOnto('/list')
    await act(async () => { window.history.forward() })
    await waitFor(() => expect(overlayOpen()).toBe(true))
    await tapClose()
    await closedOnto('/list')
    expect(key()).toBe(k1)
  })
})

describe('when the page\'s entry cannot be proven, the old replace stands', () => {
  it('an overlay opened by the previous bundle (no historyEntry) closes by replace, onto a new entry', async () => {
    const k1 = await toList()
    await open('open-legacy')
    await tapClose()
    await closedOnto('/list')
    // The instrument: this is the replace path, so the key is new. Without it this test could not tell
    // the fallback from the walk.
    expect(key()).not.toBe(k1)
  })

  it('a background written by another document (the service worker\'s post-update reload) is never walked from', async () => {
    await toList()
    await open()
    const bg = window.history.state?.usr?.background
    expect(bg?.historyEntry?.doc).toBeTypeOf('string')   // the instrument: this open recorded its entry
    vi.resetModules()
    const reloaded = await import('../context/OverlayContext.jsx')
    expect(reloaded.planOverlayClose(bg, window.history.state)).toEqual({ kind: 'replace' })
  })

  it('an open that records nothing carries nothing stale: replace-opened from a page that is already an overlay\'s background', async () => {
    await toList()
    await open()
    expect(window.history.state?.usr?.background?.historyEntry).toBeTruthy()
    // The page tree's location is now the background, historyEntry included. Open again from it, by
    // replace with no marker under us: that records nothing, so it must carry nothing either.
    await tap('open-replace')
    await waitFor(() => expect(overlayOpen()).toBe(true))
    expect(window.history.state?.usr?.background?.pathname).toBe('/list')
    expect(window.history.state?.usr?.background?.historyEntry).toBe(undefined)
  })

  it('an overlay opened by replace over the page itself (no marker) closes onto the page, never walking off it', async () => {
    const k1 = await toList()
    await tap('open-replace')
    await waitFor(() => expect(overlayOpen()).toBe(true))
    await tapClose()
    await closedOnto('/list')
    expect(key()).not.toBe(k1)                         // the list's entry was overwritten by the open
    await backLandsOn('/today')
  })
})

describe('planOverlayClose', () => {
  const DOC = 'doc-1'
  const bg = (idx, extra = {}) => ({ pathname: '/list', search: '', key: 'k1', historyEntry: { idx, doc: DOC }, ...extra })
  const st = (idx, extra = {}) => ({ usr: {}, key: 'k2', idx, ...extra })

  it('walks back the distance to the page\'s entry, up to ten', () => {
    for (let steps = 1; steps <= 10; steps += 1) {
      expect(planOverlayClose(bg(4), st(4 + steps), DOC)).toEqual({ kind: 'back', steps })
    }
    expect(planOverlayClose(bg(4), st(15), DOC)).toEqual({ kind: 'replace' })
  })
  it('counts the marker\'s slot for an overlay opened by replace into it (the +LOG door)', () => {
    const slot = (idx) => bg(idx, { historyEntry: { idx, doc: DOC, markerSlot: true } })
    expect(planOverlayClose(slot(4), st(4), DOC)).toEqual({ kind: 'back', steps: 1 })
    expect(planOverlayClose(slot(4), st(5), DOC)).toEqual({ kind: 'back', steps: 2 })   // a peek inside it
  })
  it('does nothing when already standing on the page\'s entry (the walk landed, React not yet)', () => {
    expect(planOverlayClose(bg(4), st(4, { key: 'k1' }), DOC)).toEqual({ kind: 'none' })
    // react-router's own fallback key: an entry with no key yet is 'default'.
    expect(planOverlayClose(bg(0, { key: 'default' }), { idx: 0 }, DOC)).toEqual({ kind: 'none' })
    // Checked before the evidence: a system Back landed under an overlay the previous bundle opened (no
    // historyEntry). Replacing here would overwrite the page's own entry.
    const { historyEntry: _drop, ...legacy } = bg(4)
    expect(planOverlayClose(legacy, st(4, { key: 'k1' }), DOC)).toEqual({ kind: 'none' })
  })
  it('replaces when it cannot prove where the page\'s entry is', () => {
    const { historyEntry: _drop, ...legacy } = bg(4)
    expect(planOverlayClose(legacy, st(5), DOC)).toEqual({ kind: 'replace' })                 // written before this release
    expect(planOverlayClose(bg(4), st(5), 'doc-2')).toEqual({ kind: 'replace' })              // written before a reload
    expect(planOverlayClose(bg(4), { key: 'k2' }, DOC)).toEqual({ kind: 'replace' })         // no idx: not BrowserRouter
    expect(planOverlayClose(bg(4), null, DOC)).toEqual({ kind: 'replace' })
    expect(planOverlayClose(bg(4), st(4), DOC)).toEqual({ kind: 'replace' })                  // same place, other key
    expect(planOverlayClose(bg(4), st(3), DOC)).toEqual({ kind: 'replace' })                  // behind it
    expect(planOverlayClose(bg(4), st(15), DOC)).toEqual({ kind: 'replace' })                 // not a stack this file built
    expect(planOverlayClose(undefined, st(5), DOC)).toEqual({ kind: 'replace' })
  })
  it('replaces when a Back marker sits on top (it copies the idx under it, so the walk would stop one short)', () => {
    expect(planOverlayClose(bg(4), st(5, { [MARKER_KEY]: { v: MARKER_VERSION, seq: 1 } }), DOC)).toEqual({ kind: 'replace' })
    // Any version: a marker written by an older bundle copied the idx just the same.
    expect(planOverlayClose(bg(4), st(5, { [MARKER_KEY]: { v: 1, seq: 1 } }), DOC)).toEqual({ kind: 'replace' })
  })
  it('a MemoryRouter background (no key, no historyEntry) is never read as already home', () => {
    expect(planOverlayClose({ pathname: '/today', search: '' }, null, DOC)).toEqual({ kind: 'replace' })
  })
})
