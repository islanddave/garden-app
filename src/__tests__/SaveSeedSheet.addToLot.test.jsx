// V5-SEEDLOTADDITION-001 (seed release 3) — "Put it in a seed lot I already started", through the
// real Save seed sheet (contract T18, the table of section 6.3; each `row N` below is a row of it).
//
// WHAT IS PINNED is the rule the release hangs on: today's seed lands in the lot ONCE, and the sheet
// never says more than it knows. So every case counts the requests that left (additions POSTs, event
// POSTs, reads of the open-lots list) as well as reading the words on screen, and the unanswered cases
// compare the bodies of the first and second POST key for key.
//
// Both flags are held on by ONE static mock (the flag-off half is SaveSeedSheet.addToLot.flagOff.test.jsx).
// Every reply is built from the contract's recorded examples (seedMix.fixture.js); the pure tables are
// in seedAdditions.test.js. No jest-dom (L-182).
import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

// `offered` is the planting the stubbed picker hands back; a describe that needs another sets it.
const { apiFetchSpy, navigateSpy, toastSpy, offered } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(), navigateSpy: vi.fn(), toastSpy: vi.fn(), offered: { plant: null },
}))

vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()), SEED_MULTI_PARENT: true, SEED_ADD_TO_LOT: true,
}))
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
      <button type="button" data-testid="offer-second" onClick={() => props.onChange(offered.plant.id, offered.plant)}>second</button>
    </div>
  ),
}))

import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { todayLocalISO } from '../lib/dateLocal.js'
import contract from '../../tests/contracts/seed-mix.json'
import {
  additionReply, additionReplayReply, openLotsReply, openLotRow, plantSeedLot, blendReply, refusal, filingCases,
} from './fixtures/seedMix.fixture.js'

const YEAR = todayLocalISO().slice(0, 4)
const OWN = plantSeedLot()                       // drying, 130 approx., one other parent
const ROW = openLotRow()                         // drying, 100 counted, one parent of ANOTHER variety
const LOT_ID = ROW.id
const V_A = { id: ROW.source_plants[0].variety_id, name: ROW.source_plants[0].variety_name, crop_type_slug: ROW.crop_slug, breeding_system: null, variety_rank: 'cultivar' }
const V_B = { id: '00000000-0000-4000-8000-000000000106', name: 'sms-variety-b2-example-run', crop_type_slug: ROW.crop_slug, breeding_system: null, variety_rank: 'cultivar' }
// MEMBER is the plant the own-lots example was read for; OTHER is the plant the open-lots example was.
const MEMBER = { id: ROW.source_plants[0].id, name: 'Bed 2 row', quantity: 1, variety_id: V_A.id, variety_ref: V_A }
const OTHER = { id: openLotsReply().plant_id, name: 'Bed 5 row', quantity: 1, variety_id: V_B.id, variety_ref: V_B }
const SECOND = { id: 'pl-second', name: 'Second row', quantity: 1, variety_id: V_A.id, variety_ref: V_A }
const CROP = 'sms crop b example run'
const MIX = 'sms-variety-b-example-run + sms-variety-b2-example-run mix'

const CHANGED = 'This lot changed somewhere else just now. This is the latest. Tap Add to this lot if it still needs adding.'
const USED_UP = 'That lot is marked used up or no longer in use. Nothing was added. Open the lot to change that first.'
const REFUSED = "Couldn't add to that lot. Nothing was changed."
const OFFLINE = "You're offline. Nothing was added. Your entries stay here until you're back in range."
const CHECKING = 'Checking whether that was added…'
const UNKNOWN = "That didn't finish, so today's seed may or may not have been added. Tap Try again. It will not be added twice."
const LOTS_FAILED = "Couldn't load your lots. Nothing was changed."

// ── The network: one queue of answers per route. The last answer of a queue repeats. ─────────────────
const net = { open: [], add: [], event: [], blend: [] }
const httpErr = (status, body) => Object.assign(new Error(body?.error ?? `HTTP ${status}`), { status, body })
const coded = (code) => { const r = refusal(code); return httpErr(r.status, r.body) }
const timedOut = () => Object.assign(new Error('Request timed out'), { status: 0, timeout: true })
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const answer = (queue) => {
  const next = queue.length > 1 ? queue.shift() : queue[0]
  if (next === undefined) return Promise.reject(new Error('the test queued no answer for this route'))
  if (typeof next === 'function') return next()
  return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
}
const kind = ([url, opts = {}]) => {
  const u = String(url)
  if (u.startsWith('/api/inventory-items/seed-lots-open')) return 'open'
  if (opts.method === 'POST' && /\/seed-additions$/.test(u)) return 'add'
  if (opts.method === 'POST' && u === '/api/events') return 'event'
  if (opts.method === 'POST' && u === '/api/varieties/blend') return 'blend'
  return 'other'
}
const calls = (k) => apiFetchSpy.mock.calls.filter((c) => kind(c) === k)
const bodies = (k) => calls(k).map(([, opts]) => JSON.parse(opts.body))
const counts = () => ({ add: calls('add').length, event: calls('event').length, open: calls('open').length })

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

const onClose = vi.fn()
const onSeedAdded = vi.fn()
const onSeedMaybeAdded = vi.fn()
let jarChecks = 0

beforeEach(() => {
  for (const k of Object.keys(net)) net[k] = []
  net.event = [{ id: 'ev-1' }]
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((...c) => (net[kind(c)] ? answer(net[kind(c)]) : Promise.reject(new Error(`unexpected request ${c[0]}`))))
  navigateSpy.mockReset(); toastSpy.mockReset(); onClose.mockReset(); onSeedAdded.mockReset(); onSeedMaybeAdded.mockReset()
  offered.plant = SECOND
})
// row 26 — whatever a case left on screen says "lot", never the old word.
afterEach(() => {
  const text = document.body.textContent
  if (text.length > 0) jarChecks += 1
  expect(text).not.toMatch(/\bjars?\b/i)
  vi.restoreAllMocks()
})
afterAll(() => {
  expect(jarChecks).toBeGreaterThan(30)
})

const mount = (planting, props = {}) => render(
  <SaveSeedSheet planting={planting} onClose={onClose} onSeedAdded={onSeedAdded} {...props} />,
)
const link = () => screen.queryByTestId('save-seed-put-in-lot')
const text = (id) => screen.queryByTestId(id)?.textContent ?? null
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
const type = (id, value) => fireEvent.change(screen.getByTestId(id), { target: { value } })
const submitBtn = () => screen.getByTestId('save-seed-submit')
// The plant's one open lot, named on the link: the form opens with no read.
async function openNamed(lot = OWN) {
  mount(MEMBER, { ownLots: [lot] })
  await tap('save-seed-put-in-lot')
}
// The general link, the list, and a tap on its first row.
async function openFromList(rows = [ROW], planting = OTHER) {
  net.open = [openLotsReply({ plant_id: planting.id, open_lots: rows })]
  mount(planting)
  await tap('save-seed-put-in-lot')
  await waitFor(() => expect(screen.getAllByTestId('seed-lot-row').length).toBe(rows.length))
  await act(async () => { fireEvent.click(screen.getAllByTestId('seed-lot-row')[0]) })
}

describe('the link in the From block (rows 1-4)', () => {
  it('row 1 — one open lot of this plant: named, with its facts, and the form opens on it with no read', async () => {
    await openNamed()
    expect(counts()).toEqual({ add: 0, event: 0, open: 0 })
    expect(text('seed-add-going-into')).toContain('Going into')
    expect(text('seed-add-going-into')).toContain(OWN.name)
    expect(text('seed-add-going-into')).toContain('Drying · approx. 130 seeds · 13.85 g')
    expect(document.activeElement).toBe(screen.getByTestId('seed-add-going-into'))
    // The plant is on the lot already: nothing about its filing is said, and none is sent.
    expect(screen.queryByTestId('seed-add-refile')).toBeNull()
    net.add = [additionReply({ name: OWN.name, addition: { plant_was_added: false } })]
    await tap('save-seed-submit')
    await waitFor(() => expect(calls('add').length).toBe(1))
    expect(calls('add')[0][0]).toBe(`/api/inventory-items/${OWN.id}/seed-additions`)
    expect(bodies('add')[0].expected_source_plant_ids).toEqual([MEMBER.id, ...OWN.other_parents.map((p) => p.id)])
    expect(Object.keys(bodies('add')[0])).not.toContain('filing')
    expect(counts().open).toBe(0)
  })

  it('row 1 — the link reads "Put it in <lot name>" with the stage and amount on a second line', () => {
    mount(MEMBER, { ownLots: [OWN] })
    expect(link().textContent).toBe(`Put it in ${OWN.name}Drying · approx. 130 seeds · 13.85 g`)
    expect(link().firstChild.textContent).toBe(`Put it in ${OWN.name}`)
  })

  it('row 1 — a lot with nothing to state has no second line', () => {
    mount(MEMBER, { ownLots: [plantSeedLot({ seed_stage: null, seed_count: null, seed_count_estimated: null, seed_weight_g: null, created_at: new Date().toISOString() })] })
    expect(link().textContent).toBe(`Put it in ${OWN.name}`)
  })

  it('row 2 — otherwise the general words, and a tap opens the list with one read', async () => {
    net.open = [openLotsReply()]
    mount(OTHER)
    expect(link().textContent).toBe('Put it in a seed lot I already started')
    await tap('save-seed-put-in-lot')
    expect(text('seed-lot-list-heading')).toBe('Which seed lot?')
    await waitFor(() => expect(screen.getAllByTestId('seed-lot-row').length).toBe(1))
    expect(counts()).toEqual({ add: 0, event: 0, open: 1 })
    expect(calls('open')[0][0]).toBe(`/api/inventory-items/seed-lots-open?plant_id=${OTHER.id}`)
    expect(screen.queryByTestId('save-seed-submit')).toBeNull()
  })

  it('row 2 — two open lots, or one that is not open, is the general link too', () => {
    const { unmount } = mount(MEMBER, { ownLots: [OWN, plantSeedLot({ id: 'lot-2', name: 'Another' })] })
    expect(link().textContent).toBe('Put it in a seed lot I already started')
    unmount()
    mount(MEMBER, { ownLots: [plantSeedLot({ quantity_on_hand: '0.000' })] })
    expect(link().textContent).toBe('Put it in a seed lot I already started')
  })

  it('row 3 — no link once a second plant is in From, and it returns when that plant is taken off', async () => {
    mount(MEMBER, { ownLots: [OWN] })
    expect(link()).toBeTruthy()
    await tap('save-seed-add-plant')
    await tap('offer-second')
    expect(screen.getAllByTestId('save-seed-from-row').length).toBe(2)
    expect(link()).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Remove ${SECOND.name}` })) })
    expect(link().textContent).toContain(`Put it in ${OWN.name}`)
    expect(counts()).toEqual({ add: 0, event: 0, open: 0 })
  })

  it('row 3 — no link for a planting with no variety', () => {
    mount({ id: 'pl-vol', name: 'Volunteer squash', quantity: 1 }, { ownLots: [OWN] })
    expect(screen.getByTestId('save-seed-from')).toBeTruthy()
    expect(link()).toBeNull()
  })

  it('row 3 — no link with no planting (the Seeds door)', () => {
    render(<SaveSeedSheet onClose={onClose} ownLots={[OWN]} />)
    expect(link()).toBeNull()
    expect(counts()).toEqual({ add: 0, event: 0, open: 0 })
  })

  it('row 4 — lots that arrive after the sheet opened do not change the link under the thumb', () => {
    const { rerender } = mount(MEMBER, { ownLots: [] })
    expect(link().textContent).toBe('Put it in a seed lot I already started')
    rerender(<SaveSeedSheet planting={MEMBER} onClose={onClose} onSeedAdded={onSeedAdded} ownLots={[OWN]} />)
    expect(link().textContent).toBe('Put it in a seed lot I already started')
    expect(counts()).toEqual({ add: 0, event: 0, open: 0 })
  })
})

describe('the lot list (row 5)', () => {
  it('loading: says so, and the plant\'s own lots are drawn at once from what the page already read', async () => {
    const pending = defer()
    net.open = [() => pending.promise]
    mount(MEMBER, { ownLots: [OWN, plantSeedLot({ id: 'lot-2', name: 'Second lot', other_parents: [] })] })
    await tap('save-seed-put-in-lot')
    expect(text('seed-lot-list-state')).toBe(`Looking for your other ${CROP} lots…`)
    expect(screen.getByTestId('seed-lot-list-state').getAttribute('role')).toBe('status')
    const drawn = screen.getAllByTestId('seed-lot-row')
    expect(drawn.map((r) => r.firstChild.textContent)).toEqual([OWN.name, 'Second lot'])
    // Two plantings on the first (this one and another): counted. This one alone on the second: unsaid.
    expect(drawn[0].lastChild.textContent).toBe('Has seed from this plant · Drying · approx. 130 seeds · 13.85 g · from 2 plantings')
    expect(drawn[1].lastChild.textContent).toBe('Has seed from this plant · Drying · approx. 130 seeds · 13.85 g')
    expect(document.activeElement).toBe(screen.getByTestId('seed-lot-list-heading'))
    // The read answers: its rows take the list, own lots still first and in the order they were drawn.
    const third = openLotRow({ id: 'lot-3', name: 'Someone else\'s' })
    await act(async () => {
      pending.resolve(openLotsReply({ open_lots: [
        third, openLotRow({ id: 'lot-2', name: 'Second lot', is_member: true, same_variety: true }),
        openLotRow({ id: OWN.id, name: OWN.name, is_member: true, same_variety: true }),
      ] }))
    })
    expect(screen.getAllByTestId('seed-lot-row').map((r) => r.firstChild.textContent)).toEqual([OWN.name, 'Second lot', "Someone else's"])
    expect(screen.queryByTestId('seed-lot-list-state')).toBeNull()
    expect(counts().open).toBe(1)
  })

  it('none: "No <crop> lots to add to right now."', async () => {
    net.open = [openLotsReply({ open_lots: [] })]
    mount(OTHER)
    await tap('save-seed-put-in-lot')
    await waitFor(() => expect(text('seed-lot-list-state')).toBe(`No ${CROP} lots to add to right now.`))
    expect(screen.queryAllByTestId('seed-lot-row').length).toBe(0)
    expect(counts().open).toBe(1)
  })

  it.each([
    ['the request fails', () => httpErr(500, { error: 'boom' })],
    ['an older server answers something that is not a list', () => ({ id: 'seed-lots-open' })],
  ])('failed (%s): says so, offers Try again, and the plant\'s own lots stay usable', async (_n, first) => {
    const bad = first()
    net.open = [bad, openLotsReply({ open_lots: [openLotRow({ id: OWN.id, name: OWN.name, is_member: true, same_variety: true })] })]
    mount(MEMBER, { ownLots: [OWN, plantSeedLot({ id: 'lot-2', name: 'Second lot' })] })
    await tap('save-seed-put-in-lot')
    await waitFor(() => expect(text('seed-lot-list-state')).toBe(`${LOTS_FAILED}Try again`))
    expect(screen.getByTestId('seed-lot-list-state').getAttribute('role')).toBe('alert')
    expect(screen.getAllByTestId('seed-lot-row').every((r) => !r.disabled)).toBe(true)
    expect(counts().open).toBe(1)
    await tap('seed-lot-list-retry')
    await waitFor(() => expect(screen.queryByTestId('seed-lot-list-state')).toBeNull())
    expect(counts().open).toBe(2)
    expect(screen.getAllByTestId('seed-lot-row').length).toBe(1)
  })

  it('from the copy kept for offline use: says it may be out of date, and no row can be tapped', async () => {
    const stale = openLotsReply()
    Object.defineProperty(stale, Symbol.for('garden-app.fromCache'), { value: true })
    net.open = [stale, openLotsReply()]
    mount(OTHER)
    await tap('save-seed-put-in-lot')
    await waitFor(() => expect(text('seed-lot-list-state'))
      .toBe("This list may be out of date. Nothing can be added until you're back in range.Try again"))
    const row = screen.getByTestId('seed-lot-row')
    expect(row.disabled).toBe(true)
    fireEvent.click(row)
    expect(screen.queryByTestId('seed-add-going-into')).toBeNull()
    await tap('seed-lot-list-retry')
    await waitFor(() => expect(screen.getByTestId('seed-lot-row').disabled).toBe(false))
    expect(counts().open).toBe(2)
  })

  it('the divider sits before the first lot of another variety, and only when there is one', async () => {
    const same = openLotRow({ id: 'lot-same', name: 'Same variety', same_variety: true })
    net.open = [openLotsReply({ open_lots: [same, ROW] }), openLotsReply({ open_lots: [same] })]
    const { unmount } = mount(OTHER)
    await tap('save-seed-put-in-lot')
    await waitFor(() => expect(screen.getAllByTestId('seed-lot-row').length).toBe(2))
    const list = screen.getByTestId('seed-lot-list')
    const order = [...list.querySelectorAll('[data-testid="seed-lot-row"], [data-testid="seed-lot-list-divider"]')]
      .map((el) => el.getAttribute('data-testid'))
    expect(order).toEqual(['seed-lot-row', 'seed-lot-list-divider', 'seed-lot-row'])
    expect(text('seed-lot-list-divider')).toBe(`Other ${CROP} lots. Adding to one makes it a mix.`)
    // Line 2: the stage, the amount, and the one parent by name (it is not this plant).
    expect(screen.getAllByTestId('seed-lot-row')[1].lastChild.textContent)
      .toBe(`Drying · 100 seeds · 12.35 g · from ${ROW.source_plants[0].name}`)
    unmount()
    mount(OTHER)
    await tap('save-seed-put-in-lot')
    await waitFor(() => expect(screen.getAllByTestId('seed-lot-row').length).toBe(1))
    expect(screen.queryByTestId('seed-lot-list-divider')).toBeNull()
  })

  it('every row is at least 56 px tall, and the way back returns to the new-lot form as it was', async () => {
    net.open = [openLotsReply()]
    mount(OTHER)
    type('save-seed-count', '12')
    await tap('save-seed-put-in-lot')
    await waitFor(() => expect(screen.getAllByTestId('seed-lot-row').length).toBe(1))
    expect(parseInt(screen.getByTestId('seed-lot-row').style.minHeight, 10)).toBeGreaterThanOrEqual(56)
    expect(text('seed-lot-list-back')).toBe('← Start a new seed lot instead')
    await tap('seed-lot-list-back')
    expect(screen.getByTestId('save-seed-count').value).toBe('12')
    expect(document.activeElement).toBe(link())
    expect(counts()).toEqual({ add: 0, event: 0, open: 1 })
  })
})

describe('the add form before the tap (rows 6-8)', () => {
  it('row 6 — the outcome line follows what is typed, and the basis switch', async () => {
    await openNamed(plantSeedLot({ seed_count: 120, seed_count_estimated: false }))
    expect(text('seed-add-outcome')).toBe("The lot will say approx. 120 seeds, because today's seed is not counted.")
    type('seed-add-count', '30')
    expect(text('seed-add-outcome')).toBe('The lot will say 150 seeds (120 now and 30 today).')
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    expect(text('seed-add-outcome')).toBe('The lot will say approx. 150 seeds (120 now and 30 today).')
    expect(screen.getAllByTestId('seed-add-outcome').length).toBe(1)
    expect(counts()).toEqual({ add: 0, event: 0, open: 0 })
  })

  it('row 6 — a lot with no count says so, by whether it is stored; a lot at 0 with nothing typed says nothing', async () => {
    const now = new Date().toISOString()
    const { unmount } = mount(MEMBER, { ownLots: [plantSeedLot({ seed_count: null, seed_count_estimated: null })] })
    await tap('save-seed-put-in-lot')
    expect(text('seed-add-outcome')).toBe("This lot has no seed count yet. You'll be asked for one when you mark it stored.")
    type('seed-add-count', '25')
    expect(text('seed-add-outcome')).toBe("This lot has no seed count yet. You'll be asked for one when you mark it stored.")
    unmount()
    const second = mount(MEMBER, { ownLots: [plantSeedLot({ seed_count: null, seed_count_estimated: null, seed_stage: 'stored', created_at: now })] })
    await tap('save-seed-put-in-lot')
    expect(text('seed-add-outcome')).toBe("This lot has no seed count yet. You can add one on the lot's page.")
    second.unmount()
    mount(MEMBER, { ownLots: [plantSeedLot({ seed_count: 0, seed_count_estimated: false })] })
    await tap('save-seed-put-in-lot')
    expect(screen.queryByTestId('seed-add-outcome')).toBeNull()
  })

  it('row 7 — a stored lot carries the spoilage line; a drying one does not', async () => {
    const { unmount } = mount(MEMBER, { ownLots: [plantSeedLot({ seed_stage: 'stored', created_at: new Date().toISOString() })] })
    await tap('save-seed-put-in-lot')
    expect(text('seed-add-stored')).toBe('This lot is marked stored. Seed that is not fully dry can spoil the rest.')
    unmount()
    await openNamed()
    expect(screen.queryByTestId('seed-add-stored')).toBeNull()
  })

  it('row 8 — another variety, automatic lot name: the sentence names the mix and the new name, and the filing renames it', async () => {
    const automatic = openLotRow({ name: `${V_A.name} — saved ${YEAR}` })
    await openFromList([automatic])
    expect(text('seed-add-refile')).toContain(
      `${OTHER.name} is recorded under a different variety, so this lot will be filed as a mix and renamed ${MIX} — saved ${YEAR}.`)
    // The set notice for the set as it will be, under the sentence.
    expect(text('seed-add-refile')).toContain(`Mixed seed from ${V_A.name} and ${V_B.name}.`)
    net.blend = [blendReply({ id: 'mix-ab', name: 'The server\'s name for it' })]
    net.add = [additionReply({ filing: true })]
    await tap('save-seed-submit')
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(bodies('blend')).toEqual([{ component_variety_ids: [V_A.id, V_B.id].sort(), create: true }])
    expect(bodies('add')[0].filing).toEqual({
      variety_id: 'mix-ab', expect_variety_id: automatic.variety_id, name: `The server's name for it — saved ${YEAR}`,
    })
    expect(bodies('add')[0].expected_source_plant_ids).toEqual(automatic.source_plants.map((p) => p.id))
    expect(counts()).toEqual({ add: 1, event: 1, open: 1 })
  })

  it('row 8 — another variety, a name he typed: the sentence says the name stays, and the filing carries none', async () => {
    await openFromList([ROW])
    expect(text('seed-add-refile')).toContain(
      `${OTHER.name} is recorded under a different variety, so this lot will be filed as a mix: ${MIX}. Its name stays the same.`)
    net.blend = [blendReply({ id: 'mix-ab' })]
    net.add = [additionReply({ filing: true })]
    await tap('save-seed-submit')
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(bodies('add')[0].filing).toEqual({ variety_id: 'mix-ab', expect_variety_id: ROW.variety_id })
    expect(counts()).toEqual({ add: 1, event: 1, open: 1 })
  })

  // The contract's own cases: A, B and C are variety ids, and the mix route answers a set with the
  // contract's name for it, so `refile_to` is exactly the id the filing must carry.
  it.each(filingCases())('row 8 — $name: sentence only when same_variety is false, filing only when the mix is new', async (c) => {
    const variety = (id) => ({ id, name: `Variety ${id}`, crop_type_slug: ROW.crop_slug, breeding_system: null, variety_rank: 'cultivar' })
    const plant = { id: 'pl-case', name: 'Case row', quantity: 1, variety_id: c.plant_variety, variety_ref: variety(c.plant_variety) }
    const parents = c.parent_varieties.map((v, i) => ({
      ...ROW.source_plants[0], id: `pl-parent-${i}`, name: `Parent ${i}`, variety_id: v, variety_name: v == null ? null : `Variety ${v}`,
    }))
    const row = openLotRow({ variety_id: c.lot_variety, variety_name: `Variety ${c.lot_variety}`, source_plants: parents, is_member: false, same_variety: c.same_variety })
    net.blend = [() => {
      const ids = bodies('blend').at(-1).component_variety_ids
      return Promise.resolve(blendReply({ id: `mix(${ids.join(',')})`, name: `${ids.join(' + ')} mix` }))
    }]
    net.add = [additionReply()]
    await openFromList([row], plant)
    expect(!!screen.queryByTestId('seed-add-refile')).toBe(!c.same_variety)
    await tap('save-seed-submit')
    await waitFor(() => expect(calls('add').length).toBe(1))
    expect(calls('blend').length).toBe(c.same_variety ? 0 : 1)
    const sent = bodies('add')[0]
    expect(Object.keys(sent).includes('filing')).toBe(c.refile)
    if (c.refile) {
      expect(sent.filing.variety_id).toBe(c.refile_to)
      expect(sent.filing.expect_variety_id).toBe(c.lot_variety)
    }
    expect(sent.expected_source_plant_ids).toEqual(parents.map((p) => p.id))
  })
})

describe('after the tap: saved (rows 9, 10, 24, 25)', () => {
  it('row 9 — saved: one POST, one event, the toast names the lot, the host hears, the sheet closes and goes nowhere', async () => {
    await openNamed()
    const reply = additionReply({ name: OWN.name, addition: { plant_was_added: false } })
    net.add = [reply]
    await tap('save-seed-submit')
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(toastSpy).toHaveBeenCalledWith({ message: `Added to ${OWN.name}`, tone: 'success' })
    expect(onSeedAdded).toHaveBeenCalledTimes(1)
    expect(onSeedAdded.mock.calls[0][0]).toEqual(reply)
    expect(onSeedAdded.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0])
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(counts()).toEqual({ add: 1, event: 1, open: 0 })
  })

  it('row 9 — renamed by the write: "Added. The lot is now <new lot name>."', async () => {
    await openFromList([openLotRow({ name: `${V_A.name} — saved ${YEAR}` })])
    net.blend = [blendReply({ id: 'mix-ab', name: MIX })]
    net.add = [additionReply({ filing: true, name: `${MIX} — saved ${YEAR}` })]
    await tap('save-seed-submit')
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1))
    expect(toastSpy).toHaveBeenCalledWith({ message: `Added. The lot is now ${MIX} — saved ${YEAR}.`, tone: 'success' })
    expect(counts()).toEqual({ add: 1, event: 1, open: 1 })
  })

  it.each([
    ['fails', () => httpErr(500, { error: 'boom' })],
    ['times out', () => timedOut()],
  ])('row 10 — the timeline entry %s: the lot is still added, the toast says which half missed, and it is not retried', async (_n, failure) => {
    await openNamed()
    net.add = [additionReply({ name: OWN.name })]
    net.event = [failure()]
    await tap('save-seed-submit')
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(toastSpy).toHaveBeenCalledWith({ message: `Added to ${OWN.name}. The timeline entry didn't save.`, tone: 'error' })
    expect(onSeedAdded).toHaveBeenCalledTimes(1)
    expect(counts()).toEqual({ add: 1, event: 1, open: 0 })
  })

  it('row 10 — renamed AND the timeline entry failed', async () => {
    await openNamed()
    net.add = [additionReply({ name: 'A new name' })]
    net.event = [httpErr(500, { error: 'boom' })]
    await tap('save-seed-submit')
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1))
    expect(toastSpy).toHaveBeenCalledWith({ message: "Added. The lot is now A new name. The timeline entry didn't save.", tone: 'error' })
    expect(counts()).toEqual({ add: 1, event: 1, open: 0 })
  })

  const spec = contract.seed_additions_post
  it.each([
    ['no amount', '', '', false, {}, ''],
    ['a count', '30', '', false, { added_seed_count: 30, added_estimated: false }, ' 30 seeds.'],
    ['an approximate count and a weight', '30', '250 mg', true,
      { added_seed_count: 30, added_estimated: true, added_seed_weight_g: 0.25 }, ' approx. 30 seeds.'],
  ])('rows 24 and 25 — %s: the body holds the contract\'s keys only, and the event says what was POSTed', async (_n, count, weight, approx, extra, said) => {
    await openNamed()
    if (count) type('seed-add-count', count)
    if (weight) type('seed-add-weight', weight)
    if (approx) await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    const reply = additionReply({ name: 'The name as stored' })
    net.add = [reply]
    await tap('save-seed-submit')
    await waitFor(() => expect(calls('event').length).toBe(1))
    const sent = bodies('add')[0]
    const allowed = new Set([...spec.request_required, ...spec.request_optional])
    for (const k of spec.request_required) expect(Object.keys(sent)).toContain(k)
    for (const k of Object.keys(sent)) expect(allowed.has(k)).toBe(true)
    for (const k of spec.request_never) expect(Object.keys(sent)).not.toContain(k)
    expect(sent.plant_id).toBe(MEMBER.id)
    expect(sent.picked_on).toBe(todayLocalISO())
    expect(sent.addition_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(Object.keys(sent).includes('add_seed_count')).toBe(!!count)
    expect(Object.keys(sent).includes('add_estimated')).toBe(!!count)
    expect(Object.keys(sent).includes('add_seed_weight_g')).toBe(!!weight)
    expect(bodies('event')[0]).toEqual({
      plant_id: MEMBER.id, event_type: 'seed_saved', event_date: sent.picked_on,
      notes: `Added seed to "The name as stored".${said}`,
      metadata: { seed_lot_id: reply.id, addition: true, seed_addition_id: reply.addition.id, ...extra },
    })
    expect(counts()).toEqual({ add: 1, event: 1, open: 0 })
  })
})

describe('after the tap: refused (rows 11-13, 22)', () => {
  it('row 11 — lot_changed carrying the lot: redrawn from the answer with no read, and the next tap sends the latest set', async () => {
    await openNamed()
    type('seed-add-count', '30')
    const latest = [...ROW.source_plants, { ...ROW.source_plants[0], id: 'pl-new', name: 'Added elsewhere' }]
    const r = refusal('lot_changed')
    net.add = [
      httpErr(r.status, { ...r.body, source_plant_id: latest[0].id, source_plants: latest, variety_id: ROW.variety_id,
        name: 'Renamed elsewhere', seed_count: 500, seed_count_estimated: false, seed_weight_g: null,
        seed_parent_plant_count: 2, quantity_on_hand: '1.000' }),
      additionReply({ name: 'Renamed elsewhere' }),
    ]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(CHANGED))
    expect(text('seed-add-going-into')).toContain('Renamed elsewhere')
    expect(text('seed-add-going-into')).toContain('Drying · 500 seeds')
    expect(text('seed-add-outcome')).toBe('The lot will say 530 seeds (500 now and 30 today).')
    expect(screen.getByTestId('seed-add-count').value).toBe('30')
    expect(counts()).toEqual({ add: 1, event: 0, open: 0 })
    await tap('save-seed-submit')
    await waitFor(() => expect(calls('add').length).toBe(2))
    expect(bodies('add')[1].expected_source_plant_ids).toEqual(latest.map((p) => p.id))
    expect(bodies('add')[1].addition_key).toBe(bodies('add')[0].addition_key)
  })

  it.each(['parents_changed', 'blend_required', 'lot_changed'])('row 11 — %s with no lot in the answer: the same sentence, and the lot is read again', async (code) => {
    await openFromList([ROW])
    const fresh = openLotRow({ seed_count: 222 })
    net.blend = [blendReply({ id: 'mix-ab' })]
    net.open = [openLotsReply({ plant_id: OTHER.id, open_lots: [fresh] })]
    net.add = [httpErr(refusal(code).status, { error: 'the server\'s own sentence', code })]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-going-into')).toContain('222 seeds'))
    expect(text('seed-add-error')).toBe(CHANGED)
    expect(document.body.textContent).not.toContain("the server's own sentence")
    expect(submitBtn().disabled).toBe(false)
    expect(counts()).toEqual({ add: 1, event: 0, open: 2 })
  })

  it('row 11 — lot_used_up: its own sentence, and nothing more is offered than the form', async () => {
    await openNamed()
    net.add = [coded('lot_used_up')]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(USED_UP))
    expect(document.body.textContent).not.toContain(contract.seed_additions_post.refusals.lot_used_up.error)
    expect(counts()).toEqual({ add: 1, event: 0, open: 0 })
  })

  it.each(['own_source_lot', 'amount_too_large', 'addition_key_conflict', 'variety_mismatch_no_parents', 'parent_without_variety'])(
    'row 11 — %s: the general sentence, never the server\'s', async (code) => {
      await openNamed()
      net.add = [coded(code)]
      await tap('save-seed-submit')
      await waitFor(() => expect(text('seed-add-error')).toBe(REFUSED))
      expect(screen.queryByTestId('seed-add-retry')).toBeNull()
      expect(submitBtn().disabled).toBe(false)
      expect(counts()).toEqual({ add: 1, event: 0, open: 0 })
    })

  it.each([
    ['an older server\'s 400 with no code', () => httpErr(400, { error: 'name is required' })],
    ['a 404 with no code', () => httpErr(404, { error: 'Not found' })],
    ['a 2xx that names no addition', () => ({ id: 'made-by-the-create-arm', name: 'x' })],
  ])('row 12 — %s is not a save: the general sentence, no event, nothing closes', async (_n, first) => {
    await openNamed()
    net.add = [first()]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(REFUSED))
    expect(document.body.textContent).not.toContain('name is required')
    expect(onClose).not.toHaveBeenCalled()
    expect(onSeedAdded).not.toHaveBeenCalled()
    expect(toastSpy).not.toHaveBeenCalled()
    expect(counts()).toEqual({ add: 1, event: 0, open: 0 })
  })

  it.each([
    ['is refused', () => httpErr(400, { error: 'no', code: 'mixed_crop_components' })],
    ['fails', () => httpErr(500, { error: 'boom' })],
    ['times out', () => timedOut()],
    ['answers without a variety', () => ({})],
  ])('row 13 — the mix call %s: the general sentence, the addition is never sent, and the form is as typed', async (_n, first) => {
    await openFromList([ROW])
    type('seed-add-count', '30')
    net.blend = [first()]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(REFUSED))
    expect(screen.getByTestId('seed-add-count').value).toBe('30')
    expect(screen.getByTestId('seed-add-count').disabled).toBe(false)
    expect(submitBtn().disabled).toBe(false)
    expect(counts()).toEqual({ add: 0, event: 0, open: 1 })
  })

  it('row 22 — a 409 with no lot in it, and the read that follows fails: says so, Add is off until a read lands', async () => {
    await openNamed()
    net.add = [httpErr(409, { error: 'x', code: 'lot_changed' })]
    net.open = [httpErr(500, { error: 'boom' }), openLotsReply({ plant_id: MEMBER.id, open_lots: [openLotRow({ id: OWN.id, name: OWN.name, is_member: true, same_variety: true, seed_count: 300 })] })]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(`${LOTS_FAILED}Try again`))
    expect(submitBtn().disabled).toBe(true)
    expect(counts()).toEqual({ add: 1, event: 0, open: 1 })
    // A tap on the disabled button sends nothing.
    fireEvent.click(submitBtn())
    expect(calls('add').length).toBe(1)
    await tap('seed-add-reread')
    await waitFor(() => expect(submitBtn().disabled).toBe(false))
    expect(text('seed-add-going-into')).toContain('300 seeds')
    expect(text('seed-add-error')).toBe(CHANGED)
    expect(counts()).toEqual({ add: 1, event: 0, open: 2 })
  })

  it('row 22 — the read lands but no longer lists the lot: it cannot take seed, and Add stays off', async () => {
    await openNamed()
    net.add = [httpErr(409, { error: 'x', code: 'parents_changed' })]
    net.open = [openLotsReply({ plant_id: MEMBER.id, open_lots: [] })]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(USED_UP))
    expect(submitBtn().disabled).toBe(true)
    expect(counts()).toEqual({ add: 1, event: 0, open: 1 })
  })
})

describe('after the tap: no answer (rows 14-19, 21, 23)', () => {
  it('row 14 — a timeout, then the second try lands: "Checking…", two identical POSTs, one event, the saved ending', async () => {
    await openNamed()
    type('seed-add-count', '30')
    const second = defer()
    net.add = [timedOut(), () => second.promise]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-checking')).toBe(CHECKING))
    expect(screen.getByTestId('seed-add-checking').getAttribute('role')).toBe('status')
    expect(calls('add').length).toBe(2)
    await act(async () => { second.resolve(additionReplayReply({ name: OWN.name })) })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(bodies('add')[1]).toEqual(bodies('add')[0])
    expect(toastSpy).toHaveBeenCalledWith({ message: `Added to ${OWN.name}`, tone: 'success' })
    expect(counts()).toEqual({ add: 2, event: 1, open: 0 })
  })

  it('row 15 — a timeout, then a coded refusal: that code\'s sentence, and the form unlocks', async () => {
    await openNamed()
    net.add = [timedOut(), coded('lot_used_up')]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(USED_UP))
    expect(screen.queryByTestId('seed-add-retry')).toBeNull()
    expect(screen.getByTestId('seed-add-count').disabled).toBe(false)
    expect(counts()).toEqual({ add: 2, event: 0, open: 0 })
  })

  it.each([
    ['a 404 with no code', () => httpErr(404, { error: 'Not found' })],
    ['a 400 with no code', () => httpErr(400, { error: 'name is required' })],
    ['a 2xx that names no addition', () => ({ id: 'x' })],
  ])('row 16 — a timeout, then %s: "may or may not", with Try again', async (_n, second) => {
    await openNamed()
    net.add = [timedOut(), second()]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(`${UNKNOWN}Try again`))
    expect(screen.getByTestId('seed-add-retry').textContent).toBe('Try again')
    expect(onClose).not.toHaveBeenCalled()
    expect(counts()).toEqual({ add: 2, event: 0, open: 0 })
  })

  it.each([
    ['a 500', () => httpErr(500, { error: 'boom' })],
    ['a timeout', () => timedOut()],
  ])('row 17 — %s twice: "may or may not"; Try again is a third POST with the same key and body', async (_n, failure) => {
    await openNamed()
    type('seed-add-count', '30')
    type('seed-add-weight', '2.5')
    net.add = [failure(), failure(), additionReply({ name: OWN.name })]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(`${UNKNOWN}Try again`))
    expect(counts()).toEqual({ add: 2, event: 0, open: 0 })
    await tap('seed-add-retry')
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    const sent = bodies('add')
    expect(sent.length).toBe(3)
    expect(sent[1]).toEqual(sent[0])
    expect(sent[2]).toEqual(sent[0])
    expect(sent[0].add_seed_count).toBe(30)
    expect(counts()).toEqual({ add: 3, event: 1, open: 0 })
  })

  it('row 18 — offline at the tap: the offline sentence, nothing is sent, and the fields keep what was typed', async () => {
    await openNamed()
    type('seed-add-count', '30')
    type('seed-add-weight', '2.5')
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    await tap('save-seed-submit')
    expect(text('seed-add-error')).toBe(OFFLINE)
    expect(screen.getByTestId('seed-add-count').value).toBe('30')
    expect(screen.getByTestId('seed-add-weight').value).toBe('2.5')
    expect(screen.getByTestId('seed-add-count').disabled).toBe(false)
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('row 18 — api.js found no connection before sending: the offline sentence, and no second try', async () => {
    await openNamed()
    net.add = [Object.assign(new Error('You appear to be offline.'), { status: 0, offline: true })]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(OFFLINE))
    expect(counts()).toEqual({ add: 1, event: 0, open: 0 })
  })

  it('row 19 — the connection drops with the request already out: one second try, then "may or may not", not the offline sentence', async () => {
    await openNamed()
    const dropped = () => {
      vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    net.add = [dropped, dropped]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(`${UNKNOWN}Try again`))
    expect(counts()).toEqual({ add: 2, event: 0, open: 0 })
  })

  it('row 21 — the fields and Change lot are locked from the tap until a definite answer, and the event says what was POSTed', async () => {
    await openNamed()
    type('seed-add-count', '30')
    const first = defer()
    const second = defer()
    net.add = [() => first.promise, () => second.promise, additionReply({ name: OWN.name })]
    const lockedNow = () => [
      screen.getByTestId('seed-add-count').disabled, screen.getByTestId('seed-add-weight').disabled,
      screen.getByTestId('seed-add-change-lot').disabled, submitBtn().disabled,
    ]
    const flipSwitch = () => act(async () => { fireEvent.click(screen.getByRole('switch')) })
    await tap('save-seed-submit')
    // Sending.
    expect(submitBtn().textContent).toBe('Adding…')
    expect(lockedNow()).toEqual([true, true, true, true])
    await flipSwitch()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    // Checking.
    await act(async () => { first.reject(timedOut()) })
    await waitFor(() => expect(text('seed-add-checking')).toBe(CHECKING))
    expect(lockedNow()).toEqual([true, true, true, true])
    // "May or may not": still locked; only Try again is live.
    await act(async () => { second.reject(timedOut()) })
    await waitFor(() => expect(text('seed-add-error')).toBe(`${UNKNOWN}Try again`))
    expect(lockedNow()).toEqual([true, true, true, true])
    await flipSwitch()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(submitBtn())
    fireEvent.click(screen.getByTestId('seed-add-change-lot'))
    expect(screen.queryByTestId('seed-lot-list-heading')).toBeNull()
    expect(calls('add').length).toBe(2)
    await tap('seed-add-retry')
    await waitFor(() => expect(calls('event').length).toBe(1))
    expect(bodies('event')[0].metadata.added_seed_count).toBe(bodies('add')[0].add_seed_count)
    expect(bodies('event')[0].metadata.added_estimated).toBe(bodies('add')[0].add_estimated)
    expect(bodies('add')[2]).toEqual(bodies('add')[0])
  })

  it('row 21 — after a definite refusal the form unlocks, and the next tap sends it as it then stands under the same key', async () => {
    await openNamed()
    type('seed-add-count', '30')
    net.add = [coded('amount_too_large'), additionReply({ name: OWN.name })]
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(REFUSED))
    expect(screen.getByTestId('seed-add-count').disabled).toBe(false)
    expect(screen.getByTestId('seed-add-change-lot').disabled).toBe(false)
    type('seed-add-count', '12')
    await tap('save-seed-submit')
    await waitFor(() => expect(calls('event').length).toBe(1))
    expect(bodies('add')[1].add_seed_count).toBe(12)
    expect(bodies('add')[1].addition_key).toBe(bodies('add')[0].addition_key)
    expect(bodies('event')[0].metadata.added_seed_count).toBe(12)
  })

  // Row 23. The sheet as the app holds it: under the registry that asks before a close. `asked()` is the
  // whole question as drawn; the two it can be are spelled out once, here.
  const mountAsked = () => render(
    <DismissRegistryProvider>
      <SaveSeedSheet planting={MEMBER} onClose={onClose} onSeedAdded={onSeedAdded} onSeedMaybeAdded={onSeedMaybeAdded} ownLots={[OWN]} />
    </DismissRegistryProvider>,
  )
  const escape = () => act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
  const asked = () => ['title', 'body', 'confirm', 'cancel'].map((part) => text(`confirm-sheet-${part}`))
  const UNSURE_QUESTION = [
    'Close without checking?',
    "Today's seed may or may not have been added. If you close and add it again, it could go in twice.",
    'Close', 'Keep checking',
  ]
  const ORDINARY_QUESTION = ['Close without adding?', 'What you typed here will not be kept.', 'Discard', 'Keep editing']

  it('row 23 — closing in the "may or may not" state asks a question that is true there; Keep checking leaves the form as it stood', async () => {
    net.add = [timedOut(), timedOut()]
    mountAsked()
    await tap('save-seed-put-in-lot')
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(`${UNKNOWN}Try again`))
    await escape()
    expect(asked()).toEqual(UNSURE_QUESTION)
    // nothing on screen says the seed was not added, or offers to edit a form that is locked
    expect(document.body.textContent).not.toMatch(/without adding|will not be kept|Discard|Keep editing/)
    expect(onClose).not.toHaveBeenCalled()
    await tap('confirm-sheet-cancel')
    expect(screen.queryByTestId('confirm-sheet')).toBeNull()
    expect(text('seed-add-error')).toBe(`${UNKNOWN}Try again`)
    expect(screen.getByTestId('seed-add-retry').disabled).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(onSeedMaybeAdded).not.toHaveBeenCalled()
    expect(counts()).toEqual({ add: 2, event: 0, open: 0 })
  })

  it('row 23 — Close from that question has the host read the plant\'s lots again, then closes: no event, nothing called added', async () => {
    net.add = [timedOut(), timedOut()]
    mountAsked()
    await tap('save-seed-put-in-lot')
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(`${UNKNOWN}Try again`))
    await escape()
    await tap('confirm-sheet-confirm')
    expect(onSeedMaybeAdded).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSeedMaybeAdded.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0])
    expect(onSeedAdded).not.toHaveBeenCalled()
    expect(toastSpy).not.toHaveBeenCalled()
    expect(counts()).toEqual({ add: 2, event: 0, open: 0 })
  })

  it('row 23 — while "Checking…" stands the labelled Close asks the same question, not "Close without adding?"', async () => {
    const second = defer()
    net.add = [timedOut(), () => second.promise]
    mountAsked()
    await tap('save-seed-put-in-lot')
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-checking')).toBe(CHECKING))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
    expect(asked()).toEqual(UNSURE_QUESTION)
    await tap('confirm-sheet-cancel')
    await act(async () => { second.reject(timedOut()) })
    await waitFor(() => expect(text('seed-add-error')).toBe(`${UNKNOWN}Try again`))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('row 23 — while "Adding…" stands and the first answer is still out, closing asks the same question, and Close has the host read the lots again', async () => {
    const first = defer()
    net.add = [() => first.promise]
    mountAsked()
    await tap('save-seed-put-in-lot')
    await tap('save-seed-submit')
    expect(submitBtn().textContent).toBe('Adding…')
    expect(calls('add').length).toBe(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
    expect(asked()).toEqual(UNSURE_QUESTION)
    expect(document.body.textContent).not.toMatch(/without adding|will not be kept|Discard|Keep editing/)
    expect(onClose).not.toHaveBeenCalled()
    await tap('confirm-sheet-confirm')
    expect(onSeedMaybeAdded).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSeedMaybeAdded.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0])
    expect(onSeedAdded).not.toHaveBeenCalled()
    expect(toastSpy).not.toHaveBeenCalled()
    expect(counts()).toEqual({ add: 1, event: 0, open: 0 })
  })

  it('row 23 — a lot picked and nothing sent: the question keeps its own words, and closing reads nothing again', async () => {
    mountAsked()
    await tap('save-seed-put-in-lot')
    type('seed-add-count', '30')
    await escape()
    expect(asked()).toEqual(ORDINARY_QUESTION)
    await tap('confirm-sheet-confirm')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSeedMaybeAdded).not.toHaveBeenCalled()
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('row 23 — once Try again is answered with a definite refusal, the ordinary question is back and closing reads nothing again', async () => {
    net.add = [timedOut(), timedOut(), coded('amount_too_large')]
    mountAsked()
    await tap('save-seed-put-in-lot')
    await tap('save-seed-submit')
    await waitFor(() => expect(text('seed-add-error')).toBe(`${UNKNOWN}Try again`))
    await tap('seed-add-retry')
    await waitFor(() => expect(text('seed-add-error')).toBe(REFUSED))
    await escape()
    expect(asked()).toEqual(ORDINARY_QUESTION)
    await tap('confirm-sheet-confirm')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSeedMaybeAdded).not.toHaveBeenCalled()
  })

  it('row 23 — the new-lot form is not asked that question: one Escape closes it, as before', async () => {
    render(
      <DismissRegistryProvider>
        <SaveSeedSheet planting={MEMBER} onClose={onClose} ownLots={[OWN]} />
      </DismissRegistryProvider>,
    )
    type('save-seed-count', '5')
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByTestId('confirm-sheet')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('the key (row 20)', () => {
  it('twenty taps on one form are one key; Change lot and a new pick are another', async () => {
    net.open = [openLotsReply({ plant_id: MEMBER.id, open_lots: [openLotRow({ id: OWN.id, name: OWN.name, is_member: true, same_variety: true })] })]
    await openNamed()
    net.add = [coded('own_source_lot')]
    for (let i = 1; i <= 20; i += 1) {
      await tap('save-seed-submit')
      await waitFor(() => expect(calls('add').length).toBe(i))
    }
    const keys = new Set(bodies('add').map((b) => b.addition_key))
    expect(keys.size).toBe(1)
    await tap('seed-add-change-lot')
    await waitFor(() => expect(screen.getAllByTestId('seed-lot-row').length).toBe(1))
    await act(async () => { fireEvent.click(screen.getByTestId('seed-lot-row')) })
    await tap('save-seed-submit')
    await waitFor(() => expect(calls('add').length).toBe(21))
    expect(keys.has(bodies('add')[20].addition_key)).toBe(false)
    expect(counts().event).toBe(0)
  })

  it('a count or weight the route would refuse is answered on the form, and nothing is sent', async () => {
    await openNamed()
    type('seed-add-count', '0')
    await tap('save-seed-submit')
    expect(text('seed-add-error')).toBe('Type a whole number of seeds, 1 or more, or leave it blank.')
    type('seed-add-count', '')
    type('seed-add-weight', '0.0004')
    await tap('save-seed-submit')
    expect(text('seed-add-error')).toBe('That is too little to weigh. Leave it blank instead.')
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })
})

describe('a new lot is still a new lot (the flag-on half of contract T20)', () => {
  const SELF = 'src/__tests__/SaveSeedSheet.addToLot.test.jsx'
  const TWIN = 'src/__tests__/SaveSeedSheet.addToLot.flagOff.test.jsx'
  const block = (file) => {
    const src = readFileSync(resolve(process.cwd(), file), 'utf8')
    const from = src.indexOf('// SAME-INPUTS-BEGIN')
    const to = src.indexOf('// SAME-INPUTS-END')
    expect(from, `${file} has no SAME-INPUTS block`).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    return src.slice(from, to)
  }
  it('this file and the flag-off file hold the same inputs and the same expected requests', () => {
    expect(block(SELF).length).toBeGreaterThan(2000)
    expect(block(TWIN)).toBe(block(SELF))
  })

  const save = async () => {
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  }
  const open = () => {
    offered.plant = S_SECOND
    apiFetchSpy.mockImplementation((url, opts) => Promise.resolve(sameInputReply(url, opts)))
    mount(S_FIRST, { ownLots: [OWN] })
    // The link is on screen and is not tapped: it adds nothing to a save that does not use it.
    expect(link()).toBeTruthy()
  }
  const STEPS = sameInputSteps(open, save)
  const EXPECTED = sameInputSaves(YEAR)
  it.each(Object.keys(EXPECTED))('%s: the requests are the ones the flag-off sheet sends, and neither new route is asked', async (name) => {
    await STEPS[name]()
    expect(sameInputSent(apiFetchSpy)).toEqual(EXPECTED[name])
    expect(counts()).toEqual({ add: 0, event: EXPECTED[name].filter((r) => r.url === '/api/events').length, open: 0 })
    expect(onSeedAdded).not.toHaveBeenCalled()
  })
})
