// V4-HARVDISPOSITION-001 (capture half) — the EDIT half, which is the one that is easy to miss.
//
// THE DEFECT THIS FILE EXISTS TO PREVENT. EventDetail builds an EXPLICIT harvest object on every
// save — `{ quantity, unit, quality_rating, weight, weight_unit }` — and the server reads an absent
// key as "leave it alone". So a disposition set at CREATE was reachable by nothing: the server
// preserved it faithfully and the client had no way to send a different value, forever. A create-only
// capture UI looks complete in a demo and is uncorrectable in the field.
//
// The harness models the server's real preserve semantics (keys the client omits keep their stored
// value), so a missing key shows up as "the value did not change" rather than as a thrown error —
// which is exactly how it would present to Dave.
//
// Harness copied from EventDetail.treatmentProduct.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy, navigateSpy, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { event: null, project: { id: 'p1', name: 'Tomatoes 2026' } },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
// V4-REANCHORFLAG-001: useAuthOptional is owed because EventDetail's edit form now mounts
// PlantingSelect, which self-fetches through useCachedFetch. Null user on purpose — that puts
// the hook on its plain fetch branch rather than the module-level dataCache, so one test's
// plantings cannot leak into the next.
vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
  useAuthOptional: () => ({ user: null }),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn(),
  }),
}))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigateSpy }
})

import EventDetail from '../pages/EventDetail.jsx'

// A harvest event with a paired harvest_log row — the shape GET /api/events/:id returns, including
// the `disposition` the read half now projects.
const harvestEvent = (disposition = null) => ({
  id: 'e1', project_id: 'p1', plant_id: 'pl1', location_id: null,
  event_type: 'harvest', event_date: '2026-08-01T00:00:00Z',
  title: 'Picked the Sungolds', notes: '', private_notes: '', quantity: '', is_public: false,
  flagged_as_issue: false, severity: null,
  treatment_product_text: null, treatment_category: null, treatment_amount: null, pest_target: null,
  harvest: {
    id: 'h1', quantity: 3, unit: 'count', quality_rating: null,
    weight_grams: 180, weight_estimated: true, weight_basis: 'cultivar',
    disposition,
  },
})

function setup(ev) {
  dataRef.event = { ...ev }
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/events/e1') {
      if (opts?.method === 'PUT') {
        // The server's preserve semantics, modelled: the harvest sub-object is merged key-by-key,
        // so a key the client OMITS keeps its stored value. This is what makes the assertions below
        // behavioural — omit `disposition` from EventDetail's explicit object and the stored value
        // survives untouched, which is precisely the bug.
        const sent = JSON.parse(opts.body)
        const { harvest, ...rest } = sent
        dataRef.event = {
          ...dataRef.event, ...rest,
          harvest: { ...dataRef.event.harvest, ...(harvest ?? {}) },
        }
        return Promise.resolve({ ...dataRef.event })
      }
      return Promise.resolve(dataRef.event)
    }
    if (path === '/api/projects/p1') return Promise.resolve(dataRef.project)
    return Promise.resolve(null)
  })
  return render(
    <MemoryRouter initialEntries={['/projects/p1/events/e1']}>
      <Routes><Route path="/projects/:id/events/:eventId" element={<EventDetail />} /></Routes>
    </MemoryRouter>,
  )
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/e1'))
  await act(async () => { await Promise.resolve() })
}

async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
}

async function save() {
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
  await waitFor(() => expect(apiFetchSpy.mock.calls.some(c => c[1]?.method === 'PUT')).toBe(true))
}

const savedHarvest = () => {
  const call = apiFetchSpy.mock.calls.find(c => c[1]?.method === 'PUT')
  expect(call, 'a PUT must have been issued').toBeTruthy()
  const body = JSON.parse(call[1].body)
  expect(body.harvest, 'a harvest event must send the harvest sub-object').toBeTruthy()
  return body.harvest
}

beforeEach(() => { apiFetchSpy.mockReset() })

describe('a disposition set at create can be CHANGED afterwards', () => {
  it('marking an ordinary pick "damaged" sends it on the PUT', async () => {
    // THE ASSERTION THE WHOLE LANE TURNS ON. If `disposition` is missing from EventDetail's explicit
    // harvest object, the PUT body carries no such key and this reads `undefined` — red, by value,
    // with no error thrown anywhere. That is the shape of the real defect.
    setup(harvestEvent(null)); await flushLoad()
    await openEditor()
    fireEvent.click(screen.getByTestId('ev-harvest-disposition-toggle'))
    fireEvent.click(screen.getByTestId('ev-harvest-disposition-damaged'))
    await save()
    expect(savedHarvest().disposition).toBe('damaged')
  })

  it('an already-recorded value can be REPLACED with a different one', async () => {
    // The stored value must also be on screen to replace: the panel force-opens when a value is set,
    // so this reaches the chips without tapping the disclosure at all.
    setup(harvestEvent('aborted')); await flushLoad()
    await openEditor()
    const group = screen.getByTestId('ev-harvest-disposition-group')
    expect(group, 'a recorded disposition must not be hidden behind a collapsed row').toBeTruthy()
    expect(screen.getByTestId('ev-harvest-disposition-aborted').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('ev-harvest-disposition-dropped'))
    await save()
    expect(savedHarvest().disposition).toBe('dropped')
  })

  it('an already-recorded value can be CLEARED back to a normal pick', async () => {
    // Explicit null, NOT an absent key — the server's three-intent contract reads absent as
    // "untouched", so a clear that omitted the key would be a silent no-op.
    setup(harvestEvent('culled')); await flushLoad()
    await openEditor()
    fireEvent.click(screen.getByTestId('ev-harvest-disposition-clear'))
    await save()
    const h = savedHarvest()
    expect(h.disposition).toBeNull()
    expect(
      Object.prototype.hasOwnProperty.call(h, 'disposition'),
      'a clear must send the key with null, never omit it',
    ).toBe(true)
  })
})

describe('an unrelated edit does not destroy a recorded disposition', () => {
  it('fixing the amount on an "aborted" pick round-trips the disposition unchanged', async () => {
    // BUG-TREATMENTPRODUCT-001 restated for this column: the form sends the harvest object whole on
    // every save, so a seed that could not read the stored value would write null over it on a bare
    // quantity fix. This is why the GET projects h.disposition.
    setup(harvestEvent('aborted')); await flushLoad()
    await openEditor()
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '5' } })
    await save()
    const h = savedHarvest()
    expect(h.quantity).toBe(5)
    expect(h.disposition, 'an unrelated edit must not blank the column').toBe('aborted')
  })

  it('an untouched harvest with no disposition still sends null, and stays null', async () => {
    // The majority path on the edit form. Unlike CREATE (which omits the key), this object always
    // states the user's full intent, so null here is correct and inert.
    setup(harvestEvent(null)); await flushLoad()
    await openEditor()
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Picked the Sungolds again' } })
    await save()
    expect(savedHarvest().disposition).toBeNull()
  })
})

describe('the read half — the seed the edit form depends on', () => {
  it('a stored disposition arrives selected, not blank', async () => {
    // Directly guards the seed. Seeding a blind null would leave every chip unpressed while the row
    // carried a value, and the next save would then write that blank back.
    setup(harvestEvent('dropped')); await flushLoad()
    await openEditor()
    expect(screen.getByTestId('ev-harvest-disposition-dropped').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('ev-harvest-disposition-culled').getAttribute('aria-pressed')).toBe('false')
  })

  it('a non-harvest event renders no disposition control at all', async () => {
    // The panel is gated on the paired harvest_log row, like the rest of the harvest edit fields.
    setup({ ...harvestEvent(null), event_type: 'watering', harvest: null })
    await flushLoad()
    await openEditor()
    expect(screen.queryByTestId('ev-harvest-disposition-block')).toBeNull()
  })
})
