// Put-Up UX pass R1 (prep) — src/components/kitchen/sheetLanding.js. landAfterClose is the Start sheet's
// landing, moved into a helper so any armed sheet can hand over to the page the same way: close first, wait
// for the sheet's own Back entry to be consumed (or the fallback), then call on — ONCE.
//
// WHAT THIS FILE HOLDS:
//   • unarmed (no marker on the current entry): close, then `then`, at once and in that order;
//   • armed: `then` waits for the popstate, runs once, and no later popstate or timer runs it again;
//   • armed and nothing consumes the entry: `then` runs once at the fallback, and not before;
//   • under the REAL <Sheet armsBack> and registry: `then` sees the sheet gone and the marker consumed;
//   • StartBatchSheet.jsx still exports LAND_FALLBACK_MS, and it is the helper's own.
// The Start sheet's own landing tests (PutUpStartSheet.test.jsx) run unedited over the same code.
// MUTATION: land at once even when a Back entry is armed -> "calls then once after a popstate, and not
// before it" reds here, and so does the Start sheet's own "hands the batch over only after…" there.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn() }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import { landAfterClose, LAND_FALLBACK_MS } from '../components/kitchen/sheetLanding.js'
import { LAND_FALLBACK_MS as FROM_THE_START_SHEET } from '../components/kitchen/StartBatchSheet.jsx'
import Sheet from '../components/forms/Sheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { MARKER_KEY, MARKER_VERSION, readMarker } from '../lib/backNav.js'

const armed = () => !!readMarker(window.history.state)
const armMarker = () => window.history.replaceState({ __floor: 1, [MARKER_KEY]: { v: MARKER_VERSION, seq: 1 } }, '')
const pop = () => window.dispatchEvent(new PopStateEvent('popstate'))

beforeEach(() => { window.history.replaceState({ __floor: 1 }, '') })
afterEach(() => { vi.useRealTimers() })

describe('landAfterClose — no Back entry armed', () => {
  it('closes, then calls on at once, in that order, and only once', () => {
    vi.useFakeTimers()
    const order = []
    const close = vi.fn(() => order.push('close'))
    const then = vi.fn(() => order.push('then'))
    expect(armed()).toBe(false)
    landAfterClose(close, then)
    expect(order).toEqual(['close', 'then'])
    // Nothing was left listening or waiting: a later Back and the whole fallback window change nothing.
    pop()
    vi.advanceTimersByTime(LAND_FALLBACK_MS * 3)
    expect(close).toHaveBeenCalledTimes(1)
    expect(then).toHaveBeenCalledTimes(1)
  })

  it('a stale marker of another version does not count as armed', () => {
    window.history.replaceState({ [MARKER_KEY]: { v: 1, id: 'old' } }, '')
    const then = vi.fn()
    landAfterClose(() => {}, then)
    expect(then).toHaveBeenCalledTimes(1)
  })

  it('takes a missing close or a missing then without a throw', () => {
    const then = vi.fn()
    expect(() => landAfterClose(undefined, then)).not.toThrow()
    expect(then).toHaveBeenCalledTimes(1)
    const close = vi.fn()
    expect(() => landAfterClose(close)).not.toThrow()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('landAfterClose — the sheet\'s Back entry is armed', () => {
  it('calls then once after a popstate, and not before it', () => {
    vi.useFakeTimers()
    armMarker()
    const order = []
    const close = vi.fn(() => order.push('close'))
    const then = vi.fn(() => order.push('then'))
    landAfterClose(close, then)
    expect(order).toEqual(['close'])
    vi.advanceTimersByTime(LAND_FALLBACK_MS - 1)
    expect(then).not.toHaveBeenCalled()
    pop()
    expect(order).toEqual(['close', 'then'])
    expect(then).toHaveBeenCalledTimes(1)
  })

  it('calls then once after the fallback when no popstate comes', () => {
    vi.useFakeTimers()
    armMarker()
    const then = vi.fn()
    landAfterClose(() => {}, then)
    vi.advanceTimersByTime(LAND_FALLBACK_MS - 1)
    expect(then).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(then).toHaveBeenCalledTimes(1)
  })

  it('never twice: a second popstate and the fallback after a popstate change nothing', () => {
    vi.useFakeTimers()
    armMarker()
    const then = vi.fn()
    landAfterClose(() => {}, then)
    pop()
    pop()
    vi.advanceTimersByTime(LAND_FALLBACK_MS * 3)
    pop()
    expect(then).toHaveBeenCalledTimes(1)
  })

  it('never twice: a popstate after the fallback changes nothing', () => {
    vi.useFakeTimers()
    armMarker()
    const then = vi.fn()
    landAfterClose(() => {}, then)
    vi.advanceTimersByTime(LAND_FALLBACK_MS)
    pop()
    vi.advanceTimersByTime(LAND_FALLBACK_MS * 3)
    expect(then).toHaveBeenCalledTimes(1)
  })

  it('waits the fallback it is given, and LAND_FALLBACK_MS when given none', () => {
    vi.useFakeTimers()
    armMarker()
    const quick = vi.fn()
    const usual = vi.fn()
    landAfterClose(() => {}, quick, 50)
    landAfterClose(() => {}, usual)
    vi.advanceTimersByTime(49)
    expect(quick).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(quick).toHaveBeenCalledTimes(1)
    expect(usual).not.toHaveBeenCalled()
    vi.advanceTimersByTime(LAND_FALLBACK_MS - 50)
    expect(usual).toHaveBeenCalledTimes(1)
    expect(LAND_FALLBACK_MS).toBe(1000)
  })

  it('one landing is not finished by another: each waits for its own call', () => {
    vi.useFakeTimers()
    armMarker()
    const first = vi.fn()
    landAfterClose(() => {}, first)
    pop()
    const second = vi.fn()
    landAfterClose(() => {}, second)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    pop()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})

// THE REAL THING: the shared <Sheet armsBack> under the real registry, on jsdom's own history. The
// registry pushes the marker when the sheet opens and pops it when the sheet goes; `then` must not run
// until that pop has landed.
describe('landAfterClose — under a real armed Sheet', () => {
  function Host({ then, withRegistry = true }) {
    const [open, setOpen] = useState(true)
    const tree = open
      ? (
        <Sheet open onClose={() => setOpen(false)} title="A sheet" armsBack>
          <button type="button" data-testid="hand-over" onClick={() => landAfterClose(() => setOpen(false), then)}>Go</button>
        </Sheet>
      )
      : <p data-testid="page">the page</p>
    return withRegistry ? <DismissRegistryProvider>{tree}</DismissRegistryProvider> : tree
  }
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 60)) })

  it('then runs only after the sheet has closed AND its Back entry is consumed', async () => {
    const seen = []
    const then = vi.fn(() => seen.push({ sheetOpen: !!screen.queryByRole('dialog'), markerCurrent: armed() }))
    await act(async () => { render(<Host then={then} />) })
    await waitFor(() => expect(armed()).toBe(true))
    expect(armed()).toBe(true)
    await act(async () => { fireEvent.click(screen.getByTestId('hand-over')) })
    await settle()
    await waitFor(() => expect(then).toHaveBeenCalledTimes(1))
    expect(seen).toEqual([{ sheetOpen: false, markerCurrent: false }])
    expect(screen.getByTestId('page')).toBeTruthy()
  })

  it('with no registry there is no Back entry, and then runs in the same tick as the tap', async () => {
    const then = vi.fn()
    await act(async () => { render(<Host then={then} withRegistry={false} />) })
    expect(armed()).toBe(false)
    fireEvent.click(screen.getByTestId('hand-over'))
    expect(then).toHaveBeenCalledTimes(1)
  })
})

describe('the Start sheet still exports the ceiling', () => {
  it('LAND_FALLBACK_MS from StartBatchSheet.jsx is the helper\'s own', () => {
    expect(FROM_THE_START_SHEET).toBe(LAND_FALLBACK_MS)
    expect(FROM_THE_START_SHEET).toBe(1000)
  })
})
