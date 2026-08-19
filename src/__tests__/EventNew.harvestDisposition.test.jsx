// V4-HARVDISPOSITION-001 (capture half) — the create form's optional pick-outcome chip row.
//
// WHAT THIS FILE PINS. The writer lane proved the SQL end-to-end against a real Postgres; the one
// thing it could not prove is that any pixel ever sends a value. That is this file: a chip tap
// reaches the POST body as one of the four CHECK values, and — the assertion that matters more —
// NOT tapping it sends no key at all, because 703 of the 707 live harvests are ordinary picks and
// the create body for those must stay byte-identical to before the feature existed.
//
// Harness copied from EventNew.harvestQtyChips.test.jsx. PLANTING_REQUIRED_ENABLED is TRUE in
// source, and `harvest` is a plant-predicated type, so every save here picks a planting first —
// that is the real prod path. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { HARVEST_DISPOSITION_VALUES } from '../lib/harvestDisposition.js'

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

// The row is collapsed on the fast path, so reaching a chip is two taps by design.
function openDisposition() {
  fireEvent.click(screen.getByTestId('harvest-disposition-toggle'))
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

describe('EventNew — harvest disposition, the round trip to the POST body', () => {
  it('a chip tap reaches the POST body as the stored vocabulary value', async () => {
    // THE ROUND-TRIP ASSERTION. Not "the chip looks selected" — the value must leave the client.
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '1' } })
    openDisposition()
    fireEvent.click(screen.getByTestId('harvest-disposition-aborted'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].harvest.disposition).toBe('aborted')
    // Spelled exactly as the CHECK stores it — 'Aborted' is a 23514, and the label is title-cased.
    expect(HARVEST_DISPOSITION_VALUES).toContain(postCalls[0].harvest.disposition)
  })

  it('every one of the four values is reachable and sends itself, not a neighbour', async () => {
    // Guards the mapping, not just the mechanism: a chip table that renders four buttons all wired
    // to the same value would pass a single-value test forever.
    for (const value of HARVEST_DISPOSITION_VALUES) {
      postCalls.length = 0
      const view = renderEventNew(); await flushLoad()
      await pickPlanting()
      fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2' } })
      openDisposition()
      fireEvent.click(screen.getByTestId(`harvest-disposition-${value}`))
      fireEvent.click(screen.getByText('Save'))
      await waitFor(() => expect(postCalls.length).toBe(1))
      expect(postCalls[0].harvest.disposition, `chip ${value} sent the wrong value`).toBe(value)
      view.unmount()
    }
  })

  it('the quantity and the weight still ride along — this is an ADDITION, not a replacement', async () => {
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    // By id, not by /weight/i — that matches the unit <Select> too and returns two elements.
    fireEvent.change(document.getElementById('harvest-weight'), { target: { value: '120' } })
    openDisposition()
    fireEvent.click(screen.getByTestId('harvest-disposition-damaged'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    const h = postCalls[0].harvest
    expect(h.quantity).toBe(3)
    expect(h.weight).toBe(120)
    expect(h.disposition).toBe('damaged')
  })
})

describe('EventNew — it is genuinely OPTIONAL, which is the majority path', () => {
  it('a normal pick saves with NO disposition key in the body at all', async () => {
    // THE OPTIONALITY ASSERTION. 703 of 707. The form must submit untouched, and the body must not
    // grow a key — absent and null are equivalent on CREATE, but one shape for both write paths is
    // what stops the client learning a false equivalence it would carry to the EDIT path.
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '4' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].harvest.quantity).toBe(4)
    expect(
      Object.prototype.hasOwnProperty.call(postCalls[0].harvest, 'disposition'),
      'an untouched form must not send the key',
    ).toBe(false)
  })

  it('nothing is preselected, and the row is COLLAPSED until asked for', async () => {
    // A default would destroy the NULL semantics: it would put a recorded outcome on 703 ordinary
    // picks. And an expanded row would push Save toward the fold on the one form built for speed.
    renderEventNew(); await flushLoad()
    expect(screen.queryByTestId('harvest-disposition-group')).toBeNull()
    openDisposition()
    const group = screen.getByTestId('harvest-disposition-group')
    const pressed = Array.from(group.querySelectorAll('button'))
      .filter(b => b.getAttribute('aria-pressed') === 'true')
    expect(pressed).toEqual([])
  })

  it('no save is blocked by leaving it alone — no error, no gate', async () => {
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '1' } })
    openDisposition()  // opened and deliberately not answered
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a set value can be taken back — the chip toggles off and the key goes away', async () => {
    // Without this a mis-tap is permanent on a form that has no undo, which is the reason users
    // stop volunteering optional data at all.
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '1' } })
    openDisposition()
    fireEvent.click(screen.getByTestId('harvest-disposition-culled'))
    fireEvent.click(screen.getByTestId('harvest-disposition-culled'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(Object.prototype.hasOwnProperty.call(postCalls[0].harvest, 'disposition')).toBe(false)
  })

  it('the explicit Clear button does the same thing, for the users who never find a toggle', async () => {
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '1' } })
    openDisposition()
    fireEvent.click(screen.getByTestId('harvest-disposition-dropped'))
    fireEvent.click(screen.getByTestId('harvest-disposition-clear'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(Object.prototype.hasOwnProperty.call(postCalls[0].harvest, 'disposition')).toBe(false)
  })
})
