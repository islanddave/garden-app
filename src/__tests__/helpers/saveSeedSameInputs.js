// The three new-lot saves both SaveSeedSheet.addToLot files drive (flag on) and
// SaveSeedSheet.addToLot.flagOff (SEED_ADD_TO_LOT off), and every request each one makes, in order.
// One copy, so "flag off" and "flag on" cannot each pass on its own answer (contract T20).
// Never import featureFlags here: each importer holds its own static flag mock.
import { screen, fireEvent } from '@testing-library/react'

const S_A = { id: 'v-a', name: 'Ace', crop_type_slug: 'pepper', breeding_system: 'open_pollinated', variety_rank: 'cultivar' }
const S_B = { id: 'v-b', name: 'Jimmy Nardello', crop_type_slug: 'pepper', breeding_system: 'open_pollinated', variety_rank: 'cultivar' }
export const S_FIRST = { id: 'pl-first', name: 'Ace row', quantity: 1, variety_id: 'v-a', variety_ref: S_A }
export const S_SECOND = { id: 'pl-second', name: 'Jimmy row', quantity: 1, variety_id: 'v-b', variety_ref: S_B }
const S_MIX = { id: 'v-mix', name: 'Ace + Jimmy Nardello mix' }
const sLot = (name, varietyId, plantIds) => ({
  url: '/api/inventory-items', method: 'POST',
  body: { name, category: 'seeds', type: 'consumable', unit: 'packet', quantity_on_hand: 1, variety_id: varietyId, source_plant_id: plantIds[0], source_plant_ids: plantIds, idempotency_key: 'KEY' },
})
const sEvent = (plantId, name, stage = '') => ({
  url: '/api/events', method: 'POST',
  body: {
    plant_id: plantId, event_type: 'seed_saved', event_date: 'TODAY',
    notes: `Seed lot "${name}"${stage}. No count yet — recorded when it's marked stored.`,
    metadata: { seed_lot_id: 'lot-new' },
  },
})
export const sameInputSaves = (year) => ({
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
export const sameInputSteps = (open, save) => ({
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
// The replies both files give those requests, and the list of what was sent, with today's date masked
// and the create's key too (BUG-NEWLOTNOIDEMPOTENCYKEY-001): a key that is a uuid reads KEY, and a body
// with none, or with anything else in its place, is listed as it was sent and fails the comparison.
export const sameInputReply = (url, opts = {}) => {
  const u = String(url)
  if (opts.method === 'POST' && u === '/api/varieties/blend') return S_MIX
  if (opts.method === 'POST' && u === '/api/inventory-items') return { id: 'lot-new' }
  if (opts.method === 'PUT' && u.endsWith('/seed-measure')) return { seed_parent_plant_count: JSON.parse(opts.body).seed_parent_plant_count ?? null }
  return { id: 'x' }
}
export const sameInputSent = (spy) => spy.mock.calls
  .filter(([, o]) => o?.method)
  .map(([url, o]) => ({ url: String(url), method: o.method, body: JSON.parse(o.body) }))
  .map((r) => (r.url === '/api/events' ? { ...r, body: { ...r.body, event_date: 'TODAY' } } : r))
  .map((r) => (r.url === '/api/inventory-items' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(r.body.idempotency_key)
    ? { ...r, body: { ...r.body, idempotency_key: 'KEY' } } : r))
