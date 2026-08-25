// BUG-WEIGHPADSAVEBAND-001 — the WIRING half of the clearance rule.
//
// saveBandLayout.test.js proves the arithmetic; scripts/layout-gate/save-band-clearance.mjs proves
// the pixels in real Chrome. Neither notices if EventNew simply stops calling the helper — deleting
// both call sites leaves every other test in the suite green, which is the same
// nothing-guards-the-deletion hole EventNew.harvestScrollAnchor.test.jsx was written to close for
// the scroll anchor. So this file pins the call: that it happens, at which two moments, and that it
// does NOT happen on surfaces where scrolling the user would be wrong.
//
// The helper is mocked rather than exercised: what is under test here is EventNew's decision to
// call it, and a real call in jsdom would read zero rects and prove nothing either way.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, searchParamsRef, clearSpy } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
  clearSpy: vi.fn(() => 0),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))

// WEIGH_IN_FRAME_ENABLED false, explicitly. The clearance rule exists because the shipped Save band
// is a STICKY OVERLAY that content can slide under; the frame (now the shipped default) has no such
// band — track 3 is a real grid track the pad cannot go beneath — so EventNew deliberately does not
// call clearWeightPadOfSaveBand on that arm (see the `!sessionFrame` guards at both call sites).
// This file is therefore rollback-arm coverage — and the frame arm's counterpart NEGATIVE is the
// last describe block below, so the deliberate omission is asserted rather than merely untested.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
  WEIGH_IN_FRAME_ENABLED: false,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (<a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>),
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

// Constants pass through: EventNew renders the band's `bottom` from SAVE_BAND_BOTTOM_INSET_PX, and
// PickerSaveCollision.test.jsx asserts that rendered value. Stubbing it would break that file for
// an unrelated reason.
vi.mock('../lib/saveBandLayout.js', async (importActual) => ({
  ...(await importActual()),
  clearWeightPadOfSaveBand: clearSpy,
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANT = { id: 'plant-1', name: 'Sungold', project_id: 'proj-1' }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') return Promise.resolve({ id: 'evt-1' })
    if (path === '/api/projects') return Promise.resolve([PROJECT])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (String(path).startsWith('/api/plants')) return Promise.resolve([PLANT])
    return Promise.resolve(null)
  })
}

async function renderPanel(query) {
  searchParamsRef.current = new URLSearchParams(query)
  const out = render(<ToastProvider><EventNew /></ToastProvider>)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  return out
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  clearSpy.mockClear()
  searchParamsRef.current = new URLSearchParams()
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('EventNew — sticky-band clearance wiring (BUG-WEIGHPADSAVEBAND-001)', () => {
  it('the weigh-in session renders the weight keypad this rule is about', async () => {
    // If the pad ever stops rendering, every assertion below would pass against nothing.
    await renderPanel('session=harvest')
    expect(screen.getByLabelText('Harvest weight keypad')).not.toBeNull()
  })

  it('focusing the weight field clears the keypad of the band', async () => {
    await renderPanel('session=harvest')
    expect(clearSpy).not.toHaveBeenCalled()
    fireEvent.focus(screen.getByLabelText('Harvest weight'))
    expect(clearSpy).toHaveBeenCalledTimes(1)
  })

  it('a weight-keypad press clears it too — the pad-only path never focuses the field', async () => {
    // The pad writes harvest.weight directly (NumberPad calls its own onChange), so a weigh-in
    // done entirely on the keypad would never reach the focus handler above. This is the trigger
    // that matters when the Android keyboard never comes up.
    await renderPanel('session=harvest')
    fireEvent.click(screen.getByTestId('wt-key-3'))
    expect(screen.getByLabelText('Harvest weight').value).toBe('3')
    expect(clearSpy).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire on quantity focus — the anchor owns that moment', async () => {
    // V4-HARVSCROLLANCHOR-001 already scrolls here. A second scroll would fight the smooth anchor
    // mid-animation and, once the session ledger has grown the band, would push the field being
    // typed into off the top of the viewport for a pad the user has not reached yet.
    await renderPanel('session=harvest')
    fireEvent.focus(screen.getByLabelText('Harvest quantity'))
    expect(clearSpy).not.toHaveBeenCalled()
  })

  it('does NOT fire on a quantity-keypad press', async () => {
    await renderPanel('session=harvest')
    fireEvent.click(screen.getByTestId('qty-chip-4'))
    expect(screen.getByLabelText('Harvest quantity').value).toBe('4')
    expect(clearSpy).not.toHaveBeenCalled()
  })

  it('stays inert on the non-session harvest panel, which has no weight keypad at all', async () => {
    await renderPanel('event_type=harvest')
    expect(screen.queryByLabelText('Harvest weight keypad')).toBeNull()
    fireEvent.focus(screen.getByLabelText('Harvest weight'))
    expect(clearSpy).not.toHaveBeenCalled()
  })
})

// The shipped arm. Every assertion above describes the ROLLBACK path now, so without this block the
// live weigh-in would have no statement about the clearance scroll at all — and "the tests are
// green" would mean the arm nobody uses is green. The frame deletes the scroll deliberately (track 3
// is a real grid track, not a sticky overlay, so nothing can slide under it), and a deletion nothing
// asserts is a deletion that comes back silently.
describe('EventNew — the shipped frame does NOT scroll for a band it does not have', () => {
  async function renderFrame(query) {
    vi.resetModules()
    vi.doMock('../lib/featureFlags.js', async (importActual) => ({
      ...(await importActual()),
      PROJECTS_HIDDEN: false, PLANTING_REQUIRED_ENABLED: false, WEIGH_IN_FRAME_ENABLED: true,
    }))
    // clearSpy must survive resetModules, so re-register the saveBandLayout mock on the fresh graph.
    vi.doMock('../lib/saveBandLayout.js', async (importActual) => ({
      ...(await importActual()),
      clearWeightPadOfSaveBand: clearSpy,
    }))
    const { default: EventNewFrame } = await import('../pages/EventNew.jsx')
    // Same fresh module graph, or ToastProvider is a different context object entirely.
    const { ToastProvider: FreshToastProvider } = await import('../context/ToastContext.jsx')
    searchParamsRef.current = new URLSearchParams(query)
    const out = render(<FreshToastProvider><EventNewFrame /></FreshToastProvider>)
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
    await act(async () => { await Promise.resolve() })
    return out
  }

  afterEach(() => {
    vi.doUnmock('../lib/featureFlags.js')
    vi.doUnmock('../lib/saveBandLayout.js')
    vi.resetModules()
  })

  it('mounts the frame and its weight keypad (else the negatives below are vacuous)', async () => {
    await renderFrame('session=harvest')
    expect(screen.getByTestId('weigh-frame')).not.toBeNull()
    expect(screen.getByLabelText('Harvest weight keypad')).not.toBeNull()
    expect(screen.queryByTestId('save-sticky')).toBeNull()
  })

  it('neither weight focus nor a weight-keypad press calls the clearance helper', async () => {
    await renderFrame('session=harvest')
    fireEvent.focus(screen.getByLabelText('Harvest weight'))
    expect(clearSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('wt-key-3'))
    // The pad still writes the field — the deletion is the SCROLL, not the input path.
    expect(screen.getByLabelText('Harvest weight').value).toBe('3')
    expect(clearSpy).not.toHaveBeenCalled()
  })
})
