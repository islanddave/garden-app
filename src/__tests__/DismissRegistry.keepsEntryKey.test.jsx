// BUG-SAVEDSEEDSBACKTOP-001 follow-up (qa-v4148 MINOR) — the contract between the dismiss registry's Back
// marker and useScrollRestore. The hook now writes ONLY while the history entry it mounted on is current
// (its page entry, pageEntryKey(window.history.state), unchanged). An armed sheet pushes a marker entry, and
// that is safe only because arm() MERGES history.state, carrying react-router's `key` onto the marker entry
// — and, since BUG-OVERLAYRELOADKEY-001, the whole `usr` too: under a route overlay the page entry is the
// overlay's `usr.background`, and an entry an overlay's replace-close left answers to `usr.continuesEntry`. If the
// marker ever carried a new key, every saveState made under an open sheet would be dropped in silence and
// Back to the list would restore what it held before the sheet opened. Nothing pinned that: a marker with a
// new key passed 33 suites / 429 tests (Dismiss*, BackNav*, *scrollRestore*, MySeeds*, SavedSeeds*).
//
// Real jsdom history, real provider, real Sheet, real hook. No jest-dom (L-182).
import React, { useState, useEffect } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import Sheet from '../components/forms/Sheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'
import useScrollRestore, { __peekScrollRestoreEntry } from '../hooks/useScrollRestore.js'
import { pageEntryKey, CONTINUES_ENTRY_KEY } from '../lib/pageEntry.js'

function setScrollY(y) {
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })
}

// A list page with a close-in-place sheet (armsBack, like SaveSeedSheet) whose action changes the list's
// view state while the sheet is still open, the moment the page's saveState effect fires.
function ListPage() {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState('folded')
  const { saveState } = useScrollRestore({ id: 'surf', ready: true })
  useEffect(() => { saveState({ view }) }, [view, saveState])
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>open sheet</button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Save seed" armsBack>
        <button type="button" onClick={() => setView('expanded')}>expand the card</button>
        <button type="button" onClick={() => setOpen(false)}>done</button>
      </Sheet>
    </>
  )
}

beforeEach(() => {
  setScrollY(0)
  // The entry as BrowserRouter leaves it: {usr, key, idx}.
  window.history.replaceState({ usr: null, key: 'entry-A', idx: 3 }, '')
})
afterEach(() => { cleanup(); window.history.replaceState(null, '') })

describe('an armed sheet keeps the entry key, so saving continues under it', () => {
  it('opening it leaves history.state.key alone, and a saveState made under it is filed under the entry', async () => {
    render(<DismissRegistryProvider><ListPage /></DismissRegistryProvider>)
    act(() => { setScrollY(900); window.dispatchEvent(new Event('scroll')) })
    expect(__peekScrollRestoreEntry('surf')).toEqual({ y: 900, s: { view: 'folded' } })

    act(() => { fireEvent.click(screen.getByText('open sheet')) })
    // The instrument: the sheet really armed, so the current entry IS the marker entry the sheet pushed.
    expect(readMarker(window.history.state)).toBeTruthy()
    expect(window.history.state.key).toBe('entry-A')
    expect(window.history.state.idx).toBe(3)

    act(() => { fireEvent.click(screen.getByText('expand the card')) })
    act(() => { fireEvent.click(screen.getByText('done')) })
    // Closing by its own control pops the marker (disarm's back()); land back on entry-A proper.
    await waitFor(() => expect(readMarker(window.history.state)).toBeNull())
    expect(window.history.state.key).toBe('entry-A')
    expect(__peekScrollRestoreEntry('surf')).toEqual({ y: 900, s: { view: 'expanded' } })
  })
})

// The page entry must survive the marker too, not just the key: a sheet armed over a page that sits under a
// route overlay, and over an entry an overlay's replace-close left behind (qa-overlayreload MINOR 5 — a
// marker that kept only key + idx passed every overlay and scroll suite).
describe('an armed sheet keeps the PAGE entry, so saving continues under it', () => {
  it.each([
    ['a page under a route overlay', { usr: { background: { pathname: '/list', search: '', key: 'entry-A' } }, key: 'entry-S', idx: 4 }],
    ['an entry a replace-close left', { usr: { [CONTINUES_ENTRY_KEY]: 'entry-A' }, key: 'entry-R', idx: 3 }],
  ])('%s: arming leaves pageEntryKey alone, and a saveState made under it is filed under the page entry', async (_label, base) => {
    window.history.replaceState(base, '')
    expect(pageEntryKey(window.history.state)).toBe('entry-A')
    render(<DismissRegistryProvider><ListPage /></DismissRegistryProvider>)
    act(() => { setScrollY(900); window.dispatchEvent(new Event('scroll')) })
    act(() => { fireEvent.click(screen.getByText('open sheet')) })
    expect(readMarker(window.history.state)).toBeTruthy()
    expect(pageEntryKey(window.history.state)).toBe('entry-A')
    act(() => { fireEvent.click(screen.getByText('expand the card')) })
    act(() => { fireEvent.click(screen.getByText('done')) })
    await waitFor(() => expect(readMarker(window.history.state)).toBeNull())
    expect(__peekScrollRestoreEntry('surf')).toEqual({ y: 900, s: { view: 'expanded' } })
  })
})
