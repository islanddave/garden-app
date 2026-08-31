// V4-HARVDUAL-001 Slice B — the optional weight field on both harvest write surfaces.
//
// The behaviours worth pinning are the ones where a plausible implementation silently loses or
// fabricates data, rather than the ones that merely look wrong:
//   * an empty weight must not become 0 (Number('') === 0 would read as "the user weighed nothing")
//   * the EDIT box must seed ONLY from a weight the user typed — never from an ESTIMATE, because
//     re-saving would launder a guess into a recorded measurement
//   * clearing the EDIT box must send an explicit null (remove my weight), not omit the key
//   * the count-only fast path must be completely unchanged
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
import { toGrams, WEIGHT_UNITS, MAX_PLAUSIBLE_WEIGHT_G } from '../lib/harvest-constants.js'

const HARVEST_EVENT = (harvest) => ({
  id: 'e1', project_id: 'p1', event_type: 'harvest',
  event_date: '2026-08-01T12:00:00.000Z', title: null,
  notes: null, private_notes: null, quantity: null, is_public: true,
  metadata: null, flagged_as_issue: false, severity: null, resolved_at: null,
  project_name: 'Tomatoes 2026',
  harvest,
})

function renderEventDetail() {
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
async function openEdit() {
  await act(async () => { fireEvent.click(screen.getByText('Edit')) })
}
function lastPatchBody() {
  const call = [...apiFetchSpy.mock.calls].reverse()
    .find(([, opts]) => opts && (opts.method === 'PATCH' || opts.method === 'PUT'))
  return call ? JSON.parse(call[1].body) : null
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset()
  dataRef.project = { id: 'p1', name: 'Tomatoes 2026' }
  apiFetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/events/e1' && (!opts || !opts.method)) return Promise.resolve(dataRef.event)
    if (path === '/api/projects/p1') return Promise.resolve(dataRef.project)
    if (opts && (opts.method === 'PATCH' || opts.method === 'PUT')) return Promise.resolve(dataRef.event)
    return Promise.resolve(null)
  })
})

describe('EventDetail — weight box seeding', () => {
  it('seeds from a weight the user typed (measured, non-weight unit)', async () => {
    dataRef.event = HARVEST_EVENT({
      id: 'h1', quantity: 5, unit: 'count', quality_rating: null,
      weight_grams: 337, weight_estimated: false,
    })
    renderEventDetail(); await flushLoad(); await openEdit()
    expect(screen.getByLabelText(/Weight \(optional\)/i).value).toBe('337')
  })

  it('stays BLANK when the stored weight is only an estimate', async () => {
    // 40 g here is derived from the variety reference, not weighed. Showing it would invite the
    // user to re-save it as though it were measured.
    dataRef.event = HARVEST_EVENT({
      id: 'h1', quantity: 5, unit: 'count', quality_rating: null,
      weight_grams: 40, weight_estimated: true,
    })
    renderEventDetail(); await flushLoad(); await openEdit()
    expect(screen.getByLabelText(/Weight \(optional\)/i).value).toBe('')
    expect(screen.getByText(/Currently estimated/i)).toBeTruthy()
  })

  it('stays BLANK when the weight was DERIVED from a weight-unit quantity', async () => {
    // "3 lb" already lives in the Amount/Unit pair above; echoing 1360.776 g into the weight box
    // would duplicate the same fact in two editable places.
    dataRef.event = HARVEST_EVENT({
      id: 'h1', quantity: 3, unit: 'lb', quality_rating: null,
      weight_grams: 1360.776, weight_estimated: false,
    })
    renderEventDetail(); await flushLoad(); await openEdit()
    expect(screen.getByLabelText(/Weight \(optional\)/i).value).toBe('')
  })

  it('stays blank when there is no weight at all', async () => {
    dataRef.event = HARVEST_EVENT({
      id: 'h1', quantity: 5, unit: 'count', quality_rating: null,
      weight_grams: null, weight_estimated: null,
    })
    renderEventDetail(); await flushLoad(); await openEdit()
    expect(screen.getByLabelText(/Weight \(optional\)/i).value).toBe('')
    expect(screen.queryByText(/Currently estimated/i)).toBeNull()
  })
})

describe('EventDetail — weight box submission', () => {
  const COUNT_ONLY = {
    id: 'h1', quantity: 5, unit: 'count', quality_rating: null,
    weight_grams: null, weight_estimated: null,
  }

  it('sends an explicit null when left blank, so a cleared weight really clears', async () => {
    dataRef.event = HARVEST_EVENT({ ...COUNT_ONLY, weight_grams: 337, weight_estimated: false })
    renderEventDetail(); await flushLoad(); await openEdit()
    fireEvent.change(screen.getByLabelText(/Weight \(optional\)/i), { target: { value: '' } })
    await act(async () => { fireEvent.click(screen.getByText(/^Save/)) })
    const body = lastPatchBody()
    expect(body.harvest).toHaveProperty('weight')
    expect(body.harvest.weight).toBeNull()
  })

  it('sends the number and its unit when filled', async () => {
    dataRef.event = HARVEST_EVENT(COUNT_ONLY)
    renderEventDetail(); await flushLoad(); await openEdit()
    fireEvent.change(screen.getByLabelText(/Weight \(optional\)/i), { target: { value: '337' } })
    await act(async () => { fireEvent.click(screen.getByText(/^Save/)) })
    const body = lastPatchBody()
    expect(body.harvest.weight).toBe(337)
    expect(body.harvest.weight_unit).toBe('g')
  })

  it('never coerces a blank weight to 0', async () => {
    dataRef.event = HARVEST_EVENT(COUNT_ONLY)
    renderEventDetail(); await flushLoad(); await openEdit()
    await act(async () => { fireEvent.click(screen.getByText(/^Save/)) })
    expect(lastPatchBody().harvest.weight).not.toBe(0)
  })

  it('leaves quantity and unit untouched by the weight field', async () => {
    dataRef.event = HARVEST_EVENT(COUNT_ONLY)
    renderEventDetail(); await flushLoad(); await openEdit()
    fireEvent.change(screen.getByLabelText(/Weight \(optional\)/i), { target: { value: '337' } })
    await act(async () => { fireEvent.click(screen.getByText(/^Save/)) })
    const body = lastPatchBody()
    expect(body.harvest.quantity).toBe(5)
    expect(body.harvest.unit).toBe('count')
  })

  it('offers every scale unit and no harvest-only unit', async () => {
    dataRef.event = HARVEST_EVENT(COUNT_ONLY)
    renderEventDetail(); await flushLoad(); await openEdit()
    const opts = [...screen.getByLabelText(/Weight unit/i).querySelectorAll('option')].map(o => o.value)
    expect(opts).toEqual(WEIGHT_UNITS)
    expect(opts).not.toContain('count')
    expect(opts).not.toContain('cup')
  })
})

describe('EventDetail — weight validation blocks the round trip', () => {
  const base = { id: 'h1', quantity: 5, unit: 'count', quality_rating: null, weight_grams: null, weight_estimated: null }

  async function saveWith(value) {
    dataRef.event = HARVEST_EVENT(base)
    renderEventDetail(); await flushLoad(); await openEdit()
    fireEvent.change(screen.getByLabelText(/Weight \(optional\)/i), { target: { value } })
    await act(async () => { fireEvent.click(screen.getByText(/^Save/)) })
  }

  it('rejects a zero or negative weight without PATCHing', async () => {
    await saveWith('0')
    expect(lastPatchBody()).toBeNull()
    expect(screen.getByText(/greater than zero/i)).toBeTruthy()
  })

  it('rejects an implausible weight after unit conversion', async () => {
    await saveWith(String(MAX_PLAUSIBLE_WEIGHT_G + 1))
    expect(lastPatchBody()).toBeNull()
    expect(screen.getByText(/higher than expected/i)).toBeTruthy()
  })
})

describe('client conversion helper', () => {
  it('matches the grams the server would compute', () => {
    expect(toGrams(11.9, 'oz')).toBeCloseTo(337.36, 1)
    expect(toGrams(1, 'lb')).toBeCloseTo(453.592, 3)
    expect(toGrams(337)).toBe(337)
  })
})
