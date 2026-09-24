// BUG-SAVEDSEEDPARENTONPRODUCE-001 — Saved seeds offered to set a parent PLANT on lots saved out of
// produce (a farm-stand pepper, a gift), which the database refuses a parent for: chk_inventory_seed_
// source_plant is `source_kind IS NULL OR source_kind = 'own_garden' OR source_plant_id IS NULL`. Two
// doors on this page offered it, and both could only fail:
//   · the card's "Set parent plant →" (to /inventory/:id, whose picker then failed the same way);
//   · the stage sheet's "Saved from" picker, whose PATCH runs AFTER the stage POST — so the stage landed
//     and "Stage saved, but the parent plant did not." followed, on every advance and on Start →.
// Each case below is asserted in the same render as its positive control (an own-garden or unrecorded
// lot that still gets the door), so the file reds if the predicate is removed AND if it is loosened to
// "any source_kind" — the ledger title's phrasing, which is wrong for own_garden.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react'

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

const PARENT = {
  id: 'pl-pepper', name: 'Aji Amarillo, bed 2', quantity: 1, variety_id: 'v-aji', project_name: null,
  variety_ref: { id: 'v-aji', name: 'Aji Amarillo', crop_type_slug: 'pepper' }, sown_at: null, succession_order: null,
}
const lot = (over = {}) => ({
  id: 'inv-1', name: 'Aji Amarillo — saved 2026', variety_name: 'Aji Amarillo', category: 'seeds',
  variety_id: 'v-aji', seed_stage: 'stored', seed_process: 'fresh', status: 'active',
  source_plant_id: null, source_kind: null, updated_at: '2026-09-20T12:00:00Z', created_at: '2026-09-20T12:00:00Z',
  ...over,
})

const mount = async (items) => {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([PARENT])
    if (p.startsWith('/api/inventory-items')) return Promise.resolve(items)
    return Promise.resolve([])
  })
  await act(async () => { render(<ToastProvider><SavedSeeds /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
}
const card = (id) => document.querySelector(`[data-testid="seed-lot-card"][data-lot-id="${id}"]`)
const writes = () => fetchSpy.mock.calls.filter(([, o]) => o?.method).map(([p, o]) => `${o.method} ${p}`)

beforeEach(() => { fetchSpy.mockReset() })

describe('Saved seeds — no parent-plant door on a lot the database refuses one (BUG-SAVEDSEEDPARENTONPRODUCE-001)', () => {
  it('a produce lot’s card has no "Set parent plant"; own-garden and unrecorded lots keep theirs', async () => {
    await mount([
      lot({ id: 'lot-stand', source_kind: 'farm_stand' }),
      lot({ id: 'lot-gift', source_kind: 'gift' }),
      lot({ id: 'lot-own', source_kind: 'own_garden' }),
      lot({ id: 'lot-unrecorded' }),
    ])
    await waitFor(() => expect(card('lot-stand')).toBeTruthy())
    expect(within(card('lot-stand')).queryByTestId('set-source-plant')).toBeNull()
    expect(within(card('lot-gift')).queryByTestId('set-source-plant')).toBeNull()
    // The produce card is otherwise whole: its stage correction is still there.
    expect(within(card('lot-stand')).getByTestId('change-stage')).toBeTruthy()
    // own_garden ADMITS a parent (the CHECK's second arm) — the door stays, and so does unrecorded.
    expect(within(card('lot-own')).getByTestId('set-source-plant').getAttribute('href')).toBe('/inventory/lot-own')
    expect(within(card('lot-unrecorded')).getByTestId('set-source-plant').getAttribute('href')).toBe('/inventory/lot-unrecorded')
  })

  it('the advance sheet does not ask a produce lot for its parent, and the save writes no link', async () => {
    await mount([lot({ id: 'lot-stand', seed_stage: 'drying', source_kind: 'farm_stand' })])
    await waitFor(() => expect(card('lot-stand')).toBeTruthy())
    await act(async () => { fireEvent.click(within(card('lot-stand')).getByTestId('advance-stage')) })
    expect(screen.getByTestId('stage-save')).toBeTruthy()          // the sheet IS open
    expect(screen.queryByTestId('stage-source-plant')).toBeNull()
    // stored refuses a blank count (BUG-SEEDZEROSOWABLE-001); typed so the save goes out.
    await act(async () => { fireEvent.change(screen.getByTestId('seed-count-input'), { target: { value: '40' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('stage-save')) })
    await waitFor(() => expect(writes()[0]).toBe('POST /api/inventory-items/lot-stand/seed-stage'))
    expect(writes().some((w) => w.includes('/source-plant'))).toBe(false)
  })

  it.each([
    ['an own-garden lot', 'own_garden'],
    ['an unrecorded one', null],
  ])('the same sheet still asks %s', async (_, kind) => {
    await mount([lot({ id: 'lot-a', seed_stage: 'drying', source_kind: kind })])
    await waitFor(() => expect(card('lot-a')).toBeTruthy())
    await act(async () => { fireEvent.click(within(card('lot-a')).getByTestId('advance-stage')) })
    expect(screen.getByTestId('stage-source-plant')).toBeTruthy()
  })

  it('Start → on a Not started produce lot opens the sheet without the parent picker', async () => {
    // Not started is where produce lots live before their first stage — the lots this door hit most.
    await mount([lot({ id: 'lot-stand', seed_stage: null, seed_process: null, source_kind: 'farm_stand' })])
    const section = await screen.findByTestId('stage-section-unstarted')
    await act(async () => { fireEvent.click(within(section).getByTestId('start-lot')) })
    await act(async () => { fireEvent.click(screen.getByTestId('start-process-fresh')) })
    expect(screen.getByRole('dialog', { name: 'Start in drying' })).toBeTruthy()
    expect(screen.queryByTestId('stage-source-plant')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('stage-save')) })
    await waitFor(() => expect(writes()).toEqual(['POST /api/inventory-items/lot-stand/seed-stage']))
  })
})
