// BUG-SEEDSTAGEDOUBLETAP-001 — one tap of Save on the stage sheet sends one stage POST.
//
// seed_lot_stage_log is append-only (no DELETE route), so a second POST is a row someone deletes by
// hand. `disabled={busy}` only holds once React has rendered it; two clicks dispatched before that
// render both reach submitStage with the old `busy` in their closure. The ref guard is what stops the
// second one, and these cases red without it (both clicks below land in ONE act, so nothing renders
// between them).
//
// The other half — the route answering a repeat 200 without writing — is
// lambda/inventory-items/seed-stage-repeat.test.js and the BUG-SEEDSTAGEDOUBLETAP-001 block of
// tests/integration/seed-lifecycle.int.test.js.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useNavigate: () => () => {},
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const DRYING = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 8, seed_count: 8, seed_count_estimated: false, unit: 'packet',
  variety_id: 'v-melon', source_plant_id: 'pl-melon', seed_stage: 'drying', seed_process: 'wet',
  variety_name: 'Green Flesh', stage_entered_at: '2026-08-25T12:00:00Z', year_harvested: 2026,
}

const defer = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

let held
const STAGE_PATH = '/api/inventory-items/inv-1/seed-stage'
const mount = async () => {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method === 'POST' && p === STAGE_PATH) return held.promise
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([])
    if (p.startsWith('/api/inventory-items')) return Promise.resolve([DRYING])
    return Promise.resolve([])
  })
  await act(async () => { render(<ToastProvider><SavedSeeds /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
}
const stagePosts = () => fetchSpy.mock.calls.filter(([p, o]) => o?.method === 'POST' && String(p) === STAGE_PATH)
const openCorrection = async () => {
  await act(async () => { fireEvent.click(screen.getByTestId('change-stage')) })
  await act(async () => { fireEvent.change(screen.getByTestId('stage-select'), { target: { value: 'stored' } }) })
  await act(async () => { fireEvent.change(screen.getByTestId('stage-date'), { target: { value: '2026-09-01' } }) })
}
// Two clicks before any render: the shape a disabled button cannot stop.
const doubleTap = async () => {
  await act(async () => {
    const save = screen.getByTestId('stage-save')
    fireEvent.click(save)
    fireEvent.click(save)
  })
}

beforeEach(() => {
  fetchSpy.mockReset()
  held = defer()
})

describe('SavedSeeds stage sheet — one Save, one stage POST (BUG-SEEDSTAGEDOUBLETAP-001)', () => {
  it('two clicks before the sheet re-renders send ONE stage POST', async () => {
    await mount()
    await openCorrection()
    await doubleTap()
    expect(stagePosts()).toHaveLength(1)
    expect(JSON.parse(stagePosts()[0][1].body)).toMatchObject({ stage: 'stored', entered_at: '2026-09-01T12:00:00' })

    await act(async () => { held.resolve({ id: 'log-1' }) })
    expect(await screen.findByText('✓ Corrected to stored')).toBeTruthy()
    expect(stagePosts()).toHaveLength(1)
  })

  it('the guard lets go when the request ends: a Save after a failed one is sent', async () => {
    // A guard that never cleared would turn one timeout into a sheet that can never save again.
    await mount()
    await openCorrection()
    await doubleTap()
    expect(stagePosts()).toHaveLength(1)
    await act(async () => { held.reject(Object.assign(new Error('Request timed out'), { status: 0, timeout: true })) })
    expect(await screen.findByText('Request timed out')).toBeTruthy()

    held = defer()
    await act(async () => { fireEvent.click(screen.getByTestId('stage-save')) })
    expect(stagePosts()).toHaveLength(2)
  })
})
