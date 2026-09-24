// BUG-SAVEDSEEDSBACKTOP-001 follow-up (qa-v4148 MINOR) — the contract between the dismiss registry's Back
// marker and useScrollRestore. The hook now writes ONLY while the history entry it mounted on is current
// (its entry key still window.history.state.key). An armed sheet pushes a marker entry, and that is safe
// only because arm() MERGES history.state, carrying react-router's `key` onto the marker entry. If the
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
