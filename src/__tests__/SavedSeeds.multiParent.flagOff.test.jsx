// V5-SEEDMULTIPARENT-001 release 2b — SEED_MULTI_PARENT OFF is the release's forward undo, so every
// read surface must render what it rendered before, whatever the rows carry. The rows here DO carry a
// mixed parent set: the point is that nothing reads it. Pinned shapes are the pre-release ones.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state, ...r }) => (
    <a href={typeof to === 'string' ? to : '#'} data-state={state ? JSON.stringify(state) : undefined} {...r}>{children}</a>
  ),
  useNavigate: () => () => {},
}))
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()), SEED_MULTI_PARENT: false,
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import SeedLotsFromPlanting, { mixedWithLine } from '../components/planting/SeedLotsFromPlanting.jsx'
import { sowPacketFromItem } from '../components/seed/SowSheet.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { seedsReturnState } from '../lib/seedsRoutes.js'
import { refusal } from './fixtures/seedMix.fixture.js'

const PICKER = [{
  id: 'pl-sungold', name: 'Sungold cage', quantity: 1, variety_id: 'v-sungold', project_name: null,
  variety_ref: { id: 'v-sungold', name: 'Sungold', crop_type_slug: 'tomato' }, sown_at: null, succession_order: null,
}]
const sp = (over = {}) => ({
  id: 'pl-sungold', name: 'NAME FROM THE ROW', variety_id: 'v-sungold', variety_name: 'Sungold',
  breeding_system: 'f1', variety_rank: 'cultivar', crop_slug: 'tomato', archived: false, deleted: false, ...over,
})
const MIXED = [sp(), sp({ id: 'pl-brandy', variety_id: 'v-brandy', variety_name: 'Brandywine', breeding_system: 'open_pollinated' })]
const lot = (over = {}) => ({
  id: 'inv-1', name: 'Sungold — saved 2026', variety_name: 'Sungold', category: 'seeds', variety_id: 'v-sungold',
  breeding_system: 'f1', seed_stage: 'drying', seed_process: null, status: 'active', source_kind: 'own_garden',
  source_plant_id: 'pl-sungold', source_plants: MIXED, updated_at: '2026-08-30T12:00:00Z', ...over,
})

let patchReply
const mount = async (items) => {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method === 'PATCH') return patchReply()
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve(PICKER)
    if (p.startsWith('/api/inventory-items')) return Promise.resolve(items)
    return Promise.resolve([])
  })
  await act(async () => { render(<ToastProvider><SavedSeeds /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
}

beforeEach(() => {
  fetchSpy.mockReset()
  patchReply = () => Promise.resolve({ ok: true })
})

describe('flag off — the Saved seeds card is the pre-release card', () => {
  for (const [kind, row] of [['staged', lot()], ['Not started', lot({ seed_stage: null, created_at: '2026-08-30T12:00:00Z' })]]) {
    it(`${kind}: one parent from source_plant_id via the picker cache, the F2 chip alone`, async () => {
      await mount([row])
      const line = await screen.findByTestId('lot-source-plant')
      // The cache's name and the planting's page, not the row's names and not a count.
      expect(line.textContent).toBe('Saved from Sungold cage →')
      expect(line.getAttribute('href')).toBe('/plantings/pl-sungold')
      expect(JSON.parse(line.getAttribute('data-state'))).toEqual(seedsReturnState('/seeds?view=saved'))
      expect(screen.queryByTestId('lot-mixed')).toBeNull()
      expect(screen.queryByTestId('lot-part-f2')).toBeNull()
      // The F2 badge in the block it always had: one Badge in a plain div, margin and nothing else.
      const f2 = screen.getByTestId('lot-f2')
      expect(f2.textContent).toBe('F2 — won’t come true')
      expect(f2.parentElement.getAttribute('style')).toBe('margin-top: 5px;')
      expect(f2.parentElement.children).toHaveLength(1)
    })
  }

  it('a parent the cache does not hold (archived) prints nothing, as before', async () => {
    await mount([lot({ source_plant_id: 'pl-archived', source_plants: [sp({ id: 'pl-archived', archived: true })] })])
    await waitFor(() => expect(fetchSpy.mock.calls.some(([p]) => String(p).startsWith('/api/plants?view=picker'))).toBe(true))
    expect(screen.queryByTestId('lot-source-plant')).toBeNull()
    expect(screen.queryByTestId('lot-source-plant-gone')).toBeNull()
  })

  it('the stage sheet prints what it printed before: the request\'s own message', async () => {
    const no = refusal('multi_parent_lot')
    patchReply = () => Promise.reject(Object.assign(new Error(no.body.error), no))
    await mount([lot({ source_plant_id: null })])
    await act(async () => { fireEvent.click(screen.getByTestId('advance-stage')) })
    fireEvent.focus(screen.getByTestId('stage-source-plant-select'))
    await waitFor(() => expect(screen.getByTestId('ps-opt-pl-sungold')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('ps-opt-pl-sungold')) })
    await act(async () => { fireEvent.change(screen.getByTestId('seed-count-input'), { target: { value: '12' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('stage-save')) })
    const patch = fetchSpy.mock.calls.find(([, o]) => o?.method === 'PATCH')
    expect(patch[0]).toBe('/api/inventory-items/inv-1/source-plant')
    expect(JSON.parse(patch[1].body)).toEqual({ source_plant_id: 'pl-sungold' })
    await waitFor(() => expect(document.body.textContent).toContain(no.body.error))
    expect(document.body.textContent).not.toContain('This lot already has more than one plant')
  })
})

describe('flag off — the planting page list and the Sow packet', () => {
  const OTHERS = [{ id: 'pl-brandy', name: 'Brandywine row', variety_name: 'Brandywine' }]

  it('no "Mixed with" line, and the variety stays on the dot line of an automatic name', () => {
    expect(mixedWithLine(OTHERS)).toBeNull()
    render(
      <SeedLotsFromPlanting failed={false} lots={[{
        id: 'lot-a', name: 'Sungold — saved 2026', variety_name: 'Sungold', seed_stage: 'stored',
        quantity_on_hand: '1.000', other_parents: OTHERS,
      }]} />,
    )
    expect(screen.queryByTestId('lot-mixed-with')).toBeNull()
    expect(document.querySelector('li').textContent).toBe('Sungold — saved 2026Sungold · Stored')
  })

  it('the packet has exactly the four keys it had', () => {
    expect(Object.keys(sowPacketFromItem(lot())).sort()).toEqual(['id', 'saved', 'title', 'varietyId'])
  })
})
