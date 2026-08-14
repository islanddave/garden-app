// V4-HARVSCROLLANCHOR-001 (BD-016) + V4-HARVPOSTSAVESCROLL-001 (BD-017) — the two moments this
// form moves the user's attention without moving the page.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. jsdom has no layout engine, no scroll position and no soft
// keyboard, so it cannot show that quantity/weight/Save actually clear the keyboard, or that the
// planting picker was in fact above the fold. Those are device claims and are deliberately NOT
// asserted here (same posture as EventNew.harvestQtyChips.test.jsx).
//
// What IS provable, and what both defects actually were, is that NOTHING CALLED SCROLL AT ALL —
// EventNew contained zero scrollIntoView/scrollTo call sites. So this file pins the call: that it
// happens, on the right element, with block:'start' (the header at the TOP is what frees the space
// below), and that it does not fire on surfaces it would be wrong on. A stub on
// Element.prototype.scrollIntoView is required because jsdom does not implement it — which is also
// why the production helper guards on typeof before calling.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1' } },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (<a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>),
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANT = { id: 'plant-1', name: 'Sungold', project_id: 'proj-1' }

// Every scrollIntoView call, tagged with the id of the element it was called ON — the whole point
// is WHICH element got anchored, which a bare call-count cannot distinguish.
let scrollCalls = []

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return Promise.resolve(dataRef.postResult)
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (String(path).startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

function renderEventNew(query = 'event_type=harvest&project=proj-1') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

async function pickPlanting(id = 'plant-1') {
  fireEvent.focus(screen.getByLabelText('Plant or group'))
  fireEvent.click(await screen.findByTestId(`ps-opt-${id}`))
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  scrollCalls = []
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = [PLANT]
  dataRef.postResult = { id: 'evt-1' }
  try { localStorage.clear() } catch { /* noop */ }
  // jsdom ships no scrollIntoView at all — this defines it rather than spying on an existing fn.
  Element.prototype.scrollIntoView = function scrollIntoView(opts) {
    scrollCalls.push({ id: this.id, opts })
  }
  wireApiFetch()
})

afterEach(() => {
  delete Element.prototype.scrollIntoView
})

describe('EventNew — harvest scroll anchoring (V4-HARVSCROLLANCHOR-001)', () => {
  it('the harvest section carries the DOM handle the anchor scrolls to', async () => {
    renderEventNew(); await flushLoad()
    // If FormSection ever stops forwarding `id`, the anchor silently becomes a no-op and every
    // behavioral assertion below would still pass against a null lookup. Pin the handle itself.
    expect(document.getElementById('harvest-section')).not.toBeNull()
    expect(document.getElementById('planting-section')).not.toBeNull()
  })

  it('focusing the quantity field anchors the HARVEST section header to the viewport top', async () => {
    renderEventNew(); await flushLoad()
    expect(scrollCalls).toEqual([])
    fireEvent.focus(screen.getByLabelText('Harvest quantity'))
    expect(scrollCalls.length).toBe(1)
    expect(scrollCalls[0].id).toBe('harvest-section')
    // block:'start' is the load-bearing option — 'center' or 'nearest' would leave the panel
    // straddling the keyboard, which is the defect rather than the fix.
    expect(scrollCalls[0].opts.block).toBe('start')
  })

  it('anchors the SECTION, not the input — scrolling the field into view is what the browser already did', async () => {
    renderEventNew(); await flushLoad()
    fireEvent.focus(screen.getByLabelText('Harvest quantity'))
    expect(scrollCalls.map(c => c.id)).not.toContain('harvest-quantity')
  })

  it('a chip tap does NOT scroll — the fast path never opens a keyboard, so there is nothing to clear', async () => {
    renderEventNew(); await flushLoad()
    fireEvent.click(screen.getByTestId('qty-chip-3'))
    expect(screen.getByLabelText('Harvest quantity').value).toBe('3')
    expect(scrollCalls).toEqual([])
  })
})

describe('EventNew — post-save scroll restore (V4-HARVPOSTSAVESCROLL-001)', () => {
  it('sends the user back to the planting picker the confirmation just told them to use', async () => {
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.click(screen.getByTestId('qty-chip-4'))
    scrollCalls = []   // discard anything the picking interaction produced
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    // The anchor is rAF-deferred so it measures after the reset commits.
    await act(async () => { await new Promise(r => requestAnimationFrame(r)) })
    const ids = scrollCalls.map(c => c.id)
    expect(ids).toContain('planting-section')
    expect(scrollCalls.find(c => c.id === 'planting-section').opts.block).toBe('start')
  })

  it('does not scroll on a FAILED save — the form must stay where the error is', async () => {
    renderEventNew(); await flushLoad()
    await pickPlanting()
    // No quantity: validateHarvest refuses the POST and surfaces an inline error.
    scrollCalls = []
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await new Promise(r => requestAnimationFrame(r)) })
    expect(postCalls.length).toBe(0)
    expect(scrollCalls.map(c => c.id)).not.toContain('planting-section')
  })
})
