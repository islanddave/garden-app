// V5-SEEDLOTADDITION-001 (seed release 3) — FLAG OFF (contract T20). SEED_ADD_TO_LOT false is this
// release's forward undo, and it has to be the sheet release 2b shipped: no link in the From block,
// no request to either new route, and a Save seed whose every request body is the one the flag-on
// sheet sends for the same inputs. "The same inputs" is the SAME-INPUTS block below: the same text
// is in SaveSeedSheet.addToLot.test.jsx, which drives the same three saves with both flags on, compares
// them with the same list, and fails if the two copies of the block ever differ.
//
// ONE static mock, SEED_MULTI_PARENT on and SEED_ADD_TO_LOT off. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, toastSpy } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(), navigateSpy: vi.fn(), toastSpy: vi.fn(),
}))

vi.mock('../lib/featureFlags.js', async (o) => ({ ...(await o()), SEED_MULTI_PARENT: true, SEED_ADD_TO_LOT: false }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => apiFetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../context/ToastContext.jsx', () => ({
  useOptionalToast: () => ({ show: toastSpy }),
  useToast: () => ({ show: toastSpy }),
}))
vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => <div data-testid="variety-picker-stub" /> }))
vi.mock('../components/forms', async (importActual) => ({
  ...(await importActual()),
  PlantingSelect: (props) => (
    <div data-testid={props['data-testid']}>
      <button type="button" data-testid="offer-second" onClick={() => props.onChange(S_SECOND.id, S_SECOND)}>second</button>
    </div>
  ),
}))

import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { addToLotAvailable } from '../components/seed/seedAdditions.js'
import { todayLocalISO } from '../lib/dateLocal.js'
import { plantSeedLot } from './fixtures/seedMix.fixture.js'

// SAME-INPUTS-BEGIN — this block is byte-identical in SaveSeedSheet.addToLot.test.jsx (both flags on) and
// SaveSeedSheet.addToLot.flagOff.test.jsx (SEED_ADD_TO_LOT off); the flag-on file reads both and fails if
// they differ. Three new-lot saves and every request each one makes, in order. The two files drive the
// same taps and compare with this one list, so "flag off" and "flag on" cannot each pass on its own answer.
const S_A = { id: 'v-a', name: 'Ace', crop_type_slug: 'pepper', breeding_system: 'open_pollinated', variety_rank: 'cultivar' }
const S_B = { id: 'v-b', name: 'Jimmy Nardello', crop_type_slug: 'pepper', breeding_system: 'open_pollinated', variety_rank: 'cultivar' }
const S_FIRST = { id: 'pl-first', name: 'Ace row', quantity: 1, variety_id: 'v-a', variety_ref: S_A }
const S_SECOND = { id: 'pl-second', name: 'Jimmy row', quantity: 1, variety_id: 'v-b', variety_ref: S_B }
const S_MIX = { id: 'v-mix', name: 'Ace + Jimmy Nardello mix' }
const sLot = (name, varietyId, plantIds) => ({
  url: '/api/inventory-items', method: 'POST',
  body: { name, category: 'seeds', type: 'consumable', unit: 'packet', quantity_on_hand: 1, variety_id: varietyId, source_plant_id: plantIds[0], source_plant_ids: plantIds },
})
const sEvent = (plantId, name, stage = '') => ({
  url: '/api/events', method: 'POST',
  body: {
    plant_id: plantId, event_type: 'seed_saved', event_date: 'TODAY',
    notes: `Seed lot "${name}"${stage}. No count yet — recorded when it's marked stored.`,
    metadata: { seed_lot_id: 'lot-new' },
  },
})
const sameInputSaves = (year) => ({
  'one planting, nothing typed': [
    sLot(`Ace — saved ${year}`, 'v-a', ['pl-first']),
    sEvent('pl-first', `Ace — saved ${year}`),
  ],
  'one planting, a count, a weight and a process': [
    sLot(`Ace — saved ${year}`, 'v-a', ['pl-first']),
    { url: '/api/inventory-items/lot-new/seed-measure', method: 'PUT', body: { seed_count: 40, seed_count_estimated: true, seed_weight_g: 2.5 } },
    { url: '/api/inventory-items/lot-new/seed-stage', method: 'POST', body: { stage: 'drying', seed_process: 'dry' } },
    sEvent('pl-first', `Ace — saved ${year}`, ', drying'),
  ],
  'two plantings of two varieties, a plant count': [
    { url: '/api/varieties/blend', method: 'POST', body: { component_variety_ids: ['v-a', 'v-b'], create: true } },
    sLot(`Ace + Jimmy Nardello mix — saved ${year}`, 'v-mix', ['pl-first', 'pl-second']),
    { url: '/api/inventory-items/lot-new/seed-measure', method: 'PUT', body: { seed_parent_plant_count: 3 } },
    sEvent('pl-first', `Ace + Jimmy Nardello mix — saved ${year}`),
    sEvent('pl-second', `Ace + Jimmy Nardello mix — saved ${year}`),
  ],
})
// How each is driven, given the file's own way of opening the sheet on S_FIRST and of tapping Save.
const sameInputSteps = (open, save) => ({
  'one planting, nothing typed': async () => { open(); await save() },
  'one planting, a count, a weight and a process': async () => {
    open()
    fireEvent.change(screen.getByTestId('save-seed-count'), { target: { value: '40' } })
    fireEvent.click(screen.getByTestId('save-seed-count-estimated'))
    fireEvent.change(screen.getByTestId('save-seed-weight'), { target: { value: '2.5' } })
    fireEvent.click(screen.getByTestId('save-seed-process-dry'))
    await save()
  },
  'two plantings of two varieties, a plant count': async () => {
    open()
    fireEvent.click(screen.getByTestId('save-seed-add-plant'))
    fireEvent.click(screen.getByTestId('offer-second'))
    fireEvent.change(screen.getByTestId('save-seed-plant-count'), { target: { value: '3' } })
    await save()
  },
})
// The replies both files give those requests, and the list of what was sent, with today's date masked.
const sameInputReply = (url, opts = {}) => {
  const u = String(url)
  if (opts.method === 'POST' && u === '/api/varieties/blend') return S_MIX
  if (opts.method === 'POST' && u === '/api/inventory-items') return { id: 'lot-new' }
  if (opts.method === 'PUT' && u.endsWith('/seed-measure')) return { seed_parent_plant_count: JSON.parse(opts.body).seed_parent_plant_count ?? null }
  return { id: 'x' }
}
const sameInputSent = (spy) => spy.mock.calls
  .filter(([, o]) => o?.method)
  .map(([url, o]) => ({ url: String(url), method: o.method, body: JSON.parse(o.body) }))
  .map((r) => (r.url === '/api/events' ? { ...r, body: { ...r.body, event_date: 'TODAY' } } : r))
// SAME-INPUTS-END

const OWN = plantSeedLot()
const onClose = vi.fn()
const onSeedAdded = vi.fn()
const newRoutes = () => apiFetchSpy.mock.calls.filter(([url]) => /seed-lots-open|seed-additions/.test(String(url)))

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); toastSpy.mockReset(); onClose.mockReset(); onSeedAdded.mockReset()
  apiFetchSpy.mockImplementation((url, opts) => Promise.resolve(sameInputReply(url, opts)))
})

const mount = () => render(
  <SaveSeedSheet planting={S_FIRST} onClose={onClose} onSeedAdded={onSeedAdded} ownLots={[OWN]} />,
)
const save = async () => {
  await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })
  await waitFor(() => expect(onClose).toHaveBeenCalled())
}
const STEPS = sameInputSteps(mount, save)
const EXPECTED = sameInputSaves(todayLocalISO().slice(0, 4))

describe('SEED_ADD_TO_LOT off — the sheet is release 2b\'s', () => {
  it('the one reader answers off, with SEED_MULTI_PARENT still on', () => {
    expect(addToLotAvailable()).toBe(false)
  })

  it('no link in the From block, whatever lots the host passes, and the From block is still there', () => {
    mount()
    expect(screen.getByTestId('save-seed-from')).toBeTruthy()
    expect(screen.getByTestId('save-seed-add-plant')).toBeTruthy()
    expect(screen.queryByTestId('save-seed-put-in-lot')).toBeNull()
    expect(screen.queryByTestId('seed-lot-list-heading')).toBeNull()
    expect(screen.queryByTestId('seed-add-going-into')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Put it in/)
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it.each(Object.keys(EXPECTED))('%s: every request is the flag-on one, and neither new route is asked', async (name) => {
    await STEPS[name]()
    expect(newRoutes()).toEqual([])
    expect(sameInputSent(apiFetchSpy)).toEqual(EXPECTED[name])
    expect(onSeedAdded).not.toHaveBeenCalled()
  })
})
