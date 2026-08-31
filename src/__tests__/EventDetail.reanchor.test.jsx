// V4-REANCHORFLAG-001 — the re-anchor CONTROL: move a logged event to a different planting.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT is the destructive workaround, measured on prod
// audit_events over 2026-08-20 → 08-30: eleven harvests soft-deleted by a real user, four with the
// unmistakable delete-and-re-log signature (one harvest destroyed, one created seconds later on a
// different plant, same event date). That workaround loses the event id, breaks the undo evidence
// and re-fires the Lambda side effects. So the load-bearing assertion here is not "the picker
// renders" — it is that correcting the anchor is a PUT to the SAME event id, with no DELETE and no
// POST anywhere on the path (`moves it rather than deletes-and-recreates`, below).
//
// It also closes what EventDetail.editFields.test.jsx:165-171 named as deliberately-uncovered:
// nothing in EventDetail wrote form.plant_id, so the emit branch had no reachable trigger and the
// flag conjunct could not be falsified. It now has one.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy, navigateSpy, dataRef, flags } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { event: null, project: { id: 'p1', name: 'Tomatoes 2026' } },
  flags: { EVENT_REANCHOR_ENABLED: true },
}))

// Same getter harness as editFields: the control is flag-gated, so BOTH states have to be
// reachable from one file or the "flag OFF leaves EventDetail byte-identical" claim is untestable.
// Every other flag keeps its real value — PROJECTS_HIDDEN and WATER_DEPTH_EDIT_ENABLED also route
// this page.
vi.mock('../lib/featureFlags.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, get EVENT_REANCHOR_ENABLED() { return flags.EVENT_REANCHOR_ENABLED } }
})

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
// useAuthOptional returns NO user deliberately: PlantingSelect self-fetches through useCachedFetch,
// and a null sub puts that hook on its plain fetch-on-mount branch (useCachedFetch.js:35). The
// cached branch would write into the module-level dataCache and leak one test's plantings into the
// next. The fetch still goes out through apiFetchSpy either way.
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

// The prod shape: a harvest anchored to a planting, in a project. `planting_name` is what the GET
// join-projects (lambda/events/index.js:2419) and what the read view names the anchor with.
const HARVEST = {
  id: 'e1', project_id: 'p1', plant_id: 'pl-1', location_id: null,
  event_type: 'harvest', event_date: '2026-08-29T00:00:00Z',
  title: '', notes: '', private_notes: '', quantity: '', is_public: false,
  flagged_as_issue: false, severity: null,
  planting_name: 'Cherry Rescue 1',
  harvest: { id: 'h1', quantity: 4, unit: 'count', quality_rating: null, weight_grams: null, weight_estimated: null, weight_basis: null, disposition: null },
}

const PLANTS = [
  { id: 'pl-1', name: 'Cherry Rescue 1', quantity: 1, project_id: 'p1', project_name: 'Tomatoes 2026', variety_ref: null },
  { id: 'pl-2', name: 'Black Cherry', quantity: 1, project_id: 'p2', project_name: 'Cherries 2026', variety_ref: null },
]

function setup(ev = HARVEST) {
  dataRef.event = { ...ev }
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/events/e1') {
      // The PUT's real RETURNING is a column allow-list with NO planting_name — modelled exactly,
      // because the carry-forward assertion at the bottom is meaningless against a mock that
      // helpfully returns one.
      if (opts?.method === 'PUT') {
        const { planting_name, ...cols } = dataRef.event
        return Promise.resolve({ ...cols, ...JSON.parse(opts.body) })
      }
      return Promise.resolve(dataRef.event)
    }
    if (path === '/api/projects/p1') return Promise.resolve(dataRef.project)
    if (String(path).startsWith('/api/plants')) return Promise.resolve(PLANTS)
    return Promise.resolve(null)
  })
  return render(
    <MemoryRouter initialEntries={['/projects/p1/events/e1']}>
      <Routes><Route path="/projects/:id/events/:eventId" element={<EventDetail />} /></Routes>
    </MemoryRouter>,
  )
}

async function clickEdit() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/e1'))
  await act(async () => { await Promise.resolve() })
  fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }))
  // The picker self-fetches on mount; settle it so the seeded planting resolves to its chip.
  await act(async () => { await Promise.resolve() })
}

// Change the anchor the way a user does: the picker arrives collapsed to a chip naming the current
// planting, "Change" re-opens the list, the row commits.
async function chooseplanting(id) {
  fireEvent.click(screen.getByRole('button', { name: 'Change' }))
  fireEvent.click(await screen.findByTestId(`ps-opt-${id}`))
}

const save = () => fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
const writes = () => apiFetchSpy.mock.calls.filter(c => c[1]?.method && c[1].method !== 'GET')
const putBody = () => {
  const call = apiFetchSpy.mock.calls.find(c => c[1]?.method === 'PUT')
  expect(call, 'a PUT must have been issued').toBeTruthy()
  return JSON.parse(call[1].body)
}

beforeEach(() => { flags.EVENT_REANCHOR_ENABLED = true })

describe('the re-anchor control', () => {
  it('flag OFF — the control is not on screen at all', async () => {
    // The byte-identical promise (featureFlags.js:123) as something checkable. Positive control
    // first: absence only means anything on a form that actually opened.
    flags.EVENT_REANCHOR_ENABLED = false
    setup(); await clickEdit()
    expect(screen.getByLabelText(/title/i)).toBeTruthy()
    expect(screen.queryByTestId('evtdetail-planting')).toBeNull()
    expect(screen.queryByTestId('evtdetail-planting-chip')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
  })

  it('flag ON — the control renders SEEDED to the planting the event is already on', async () => {
    // Seeded, not blank: an unseeded picker would make "no change" impossible to express and every
    // save a potential move.
    setup(); await clickEdit()
    expect(screen.getByTestId('evtdetail-planting-chip').textContent).toContain('Cherry Rescue 1')
  })

  it('flag ON, untouched form — saves with no anchor keys and asks nothing', async () => {
    setup(); await clickEdit()
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'first pick' } })
    save()
    await waitFor(() => expect(apiFetchSpy.mock.calls.some(c => c[1]?.method === 'PUT')).toBe(true))
    const b = putBody()
    expect(b.title).toBe('first pick')                    // positive control
    expect(b.plant_id).toBeUndefined()
    expect(b.project_id).toBeUndefined()
    expect(screen.queryByTestId('reanchor-disclosure')).toBeNull()
  })
})

describe('the move is confirmed before it is written', () => {
  it('changing the anchor holds the save and asks, naming BOTH plantings', async () => {
    setup(); await clickEdit()
    await chooseplanting('pl-2')
    save()
    // Nothing on the wire yet — this is the whole point of the confirm step.
    await act(async () => { await Promise.resolve() })
    expect(writes()).toHaveLength(0)
    const disclosure = screen.getByTestId('reanchor-disclosure').textContent
    expect(disclosure).toContain('Cherry Rescue 1')
    expect(disclosure).toContain('Black Cherry')
  })

  it('cancelling writes nothing and keeps the choice, so Save asks again', async () => {
    setup(); await clickEdit()
    await chooseplanting('pl-2')
    save()
    fireEvent.click(await screen.findByTestId('reanchor-cancel'))
    await act(async () => { await Promise.resolve() })
    expect(writes()).toHaveLength(0)
    expect(screen.queryByTestId('reanchor-disclosure')).toBeNull()
    save()
    expect(screen.getByTestId('reanchor-disclosure')).toBeTruthy()
  })

  it('confirming MOVES the event — one PUT to the same id, never a delete-and-recreate', async () => {
    // THE INVARIANT. The destructive workaround this ticket replaces is DELETE /api/events/e1 +
    // POST /api/events; the whole value of the control is that the row keeps its id, its audit
    // trail and its harvest_log pairing. Asserted as a census of every non-GET call, so a future
    // implementation that "helpfully" re-logs the harvest fails here rather than shipping.
    setup(); await clickEdit()
    await chooseplanting('pl-2')
    save()
    fireEvent.click(await screen.findByRole('button', { name: 'Move it' }))
    await waitFor(() => expect(apiFetchSpy.mock.calls.some(c => c[1]?.method === 'PUT')).toBe(true))

    const w = writes()
    expect(w).toHaveLength(1)
    expect(w[0][0]).toBe('/api/events/e1')
    expect(w[0][1].method).toBe('PUT')
    expect(w.some(c => c[1].method === 'DELETE')).toBe(false)
    expect(w.some(c => c[1].method === 'POST')).toBe(false)

    const b = putBody()
    expect(b.plant_id).toBe('pl-2')
    // The planting decides the project; the server derives it too (deriveEventProjectId), but the
    // client must not send the stale one alongside a new planting.
    expect(b.project_id).toBe('p2')
    // Still a harvest edit, not a re-creation: the harvest block rides along unchanged.
    expect(b.harvest.quantity).toBe(4)
  })

  it('after the move the read view names the NEW planting', async () => {
    // The PUT's RETURNING carries no planting_name, so a bare setEvent(response) would blank the
    // Planting row entirely — a move that reports success by erasing the only evidence of where
    // the event now lives.
    setup(); await clickEdit()
    await chooseplanting('pl-2')
    save()
    fireEvent.click(await screen.findByRole('button', { name: 'Move it' }))
    await waitFor(() => expect(screen.queryByTestId('event-planting')).toBeTruthy())
    expect(screen.getByTestId('event-planting').textContent).toContain('Black Cherry')
    expect(screen.getByTestId('event-planting').textContent).not.toContain('Cherry Rescue 1')
  })
})

describe('the un-anchor trap', () => {
  it('clearing the planting refuses to save rather than reporting a move that never happens', async () => {
    // `newPlantId = body.plant_id ?? oldPlantId` (lambda/events/index.js:1595) — a null plant_id is
    // a server-side NO-OP, so an unguarded client would show a successful save that moved nothing.
    setup(); await clickEdit()
    fireEvent.click(screen.getByRole('button', { name: 'Clear planting selection' }))
    save()
    await act(async () => { await Promise.resolve() })
    expect(writes()).toHaveLength(0)
    expect(screen.getByText(/not left without one/i)).toBeTruthy()
    expect(screen.queryByTestId('reanchor-disclosure')).toBeNull()
  })
})
