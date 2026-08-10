// V4-HARVQTYCHIPS-001 — harvest quantity quick-pick chips.
//
// WHY THIS EXISTS, and what it can and cannot prove. 83.2% of the 519 prod harvest_log rows are
// integers 1-6 and 87.1% are a single character, so a chip row turns the two-interaction "tap the
// field, type a digit" into ONE tap for five of every six harvests. The larger win is not the tap
// but the SOFT KEYBOARD never opening on the fast path — on a 390px Android viewport the keypad
// takes roughly half the height and pushes Save below the fold.
//
// jsdom has NO layout engine and no soft keyboard, so this file CANNOT prove the keyboard win or
// the fold position — the last two defects on this exact surface were invisible to 148 passing
// tests and fell out immediately on a 390px render. Those claims need an on-device artifact and
// are deliberately NOT asserted here. What this file pins is the state machine: a chip writes the
// quantity, the POST carries it, selection is reflected, the free-text path is untouched, and the
// chips are an ADDITION rather than a replacement (the field is still there for the 16.8% tail).
//
// Flag note: PLANTING_REQUIRED_ENABLED is TRUE in source as of 2026-08-10, and `harvest` is a
// plant-predicated type — so every save here picks a planting first. That is the real prod path.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = [PLANT]
  dataRef.postResult = { id: 'evt-1' }
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('EventNew — harvest quantity chips (V4-HARVQTYCHIPS-001)', () => {
  it('renders exactly the measured fast-path set 1-6, in order', async () => {
    renderEventNew(); await flushLoad()
    const group = screen.getByRole('group', { name: 'Harvest quantity quick pick' })
    const labels = Array.from(group.querySelectorAll('button')).map(b => b.textContent)
    // Pinned to the measured set. Widening it is a deliberate act that must re-measure, not a drift.
    expect(labels).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('ONE chip tap sets the quantity — no typing into the field', async () => {
    renderEventNew(); await flushLoad()
    expect(screen.getByLabelText('Harvest quantity').value).toBe('')
    fireEvent.click(screen.getByTestId('qty-chip-3'))
    // The single assertion the whole slice exists for: the value arrived without a keystroke.
    expect(screen.getByLabelText('Harvest quantity').value).toBe('3')
  })

  it('a chip-picked quantity reaches the POST body as a number', async () => {
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.click(screen.getByTestId('qty-chip-4'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].harvest.quantity).toBe(4)
  })

  it('reflects selection state via aria-pressed, and moves it on a second pick', async () => {
    renderEventNew(); await flushLoad()
    fireEvent.click(screen.getByTestId('qty-chip-2'))
    expect(screen.getByTestId('qty-chip-2').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('qty-chip-5').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByTestId('qty-chip-5'))
    expect(screen.getByTestId('qty-chip-2').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('qty-chip-5').getAttribute('aria-pressed')).toBe('true')
  })

  it('the free-text field is UNTOUCHED — the 16.8% tail still types a decimal and posts it', async () => {
    // The anti-regression assertion. Chips are an addition; if a future change hides the field
    // behind a "More" affordance, this REDs and the tail's cost must be re-argued.
    renderEventNew(); await flushLoad()
    await pickPlanting()
    const field = screen.getByLabelText('Harvest quantity')
    fireEvent.change(field, { target: { value: '2.5' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].harvest.quantity).toBe(2.5)
  })

  it('typing a tail value after a chip pick overrides it, and no chip stays lit', async () => {
    renderEventNew(); await flushLoad()
    fireEvent.click(screen.getByTestId('qty-chip-6'))
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '12' } })
    expect(screen.getByLabelText('Harvest quantity').value).toBe('12')
    expect(screen.getByTestId('qty-chip-6').getAttribute('aria-pressed')).toBe('false')
  })

  it('a chip pick clears a standing harvest validation error', async () => {
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/Enter a quantity greater than zero/i)).toBeTruthy()
    fireEvent.click(screen.getByTestId('qty-chip-1'))
    expect(screen.queryByText(/Enter a quantity greater than zero/i)).toBeNull()
  })

  it('the chips do not render for a non-harvest event type', async () => {
    renderEventNew('event_type=watering&project=proj-1'); await flushLoad()
    expect(screen.queryByRole('group', { name: 'Harvest quantity quick pick' })).toBeNull()
  })
})
