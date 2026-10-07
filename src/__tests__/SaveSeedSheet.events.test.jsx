// V5-SEEDMULTIPARENT-001 release 2b — the timeline: one seed_saved entry PER PARENT.
//
// A jar gathered off three plantings has to show on all three plants, so the one event the sheet has
// written since V4-SEEDEVENT-001 becomes one per row of the "From" block. Three properties make that
// safe, and each has a way to be wrong that a count of requests cannot see:
//   • IN TURN, never at once. N writes racing each other race one reward grant; the sheet awaits each
//     before sending the next. Proven here by holding one parent's write on a deferred promise and
//     reading what has NOT happened yet.
//   • NEVER RETRIED. A write that landed with its reply lost would be written twice by a retry: two
//     entries on one plant, which is worse than none (the plant's page lists the jar either way).
//   • SILENT. Nobody asked for the entry and nobody can act on its failure, so one failed write of
//     three leaves the toast, the routing and the sheet exactly as a clean save leaves them.
// And one about the route: the SINGLE POST /api/events, once per parent. There is no batch call.
//
// The fetch mock routes by URL, and the event route by the body's `plant_id`, never by call order:
// "the second event failed" has to mean a particular plant's, whatever order the sheet sent them in.
// No timers. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, toastSpy, garden } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(), navigateSpy: vi.fn(), toastSpy: vi.fn(), garden: { plants: [] },
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
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value }) => <span data-testid="variety-picker-value">{value?.id ?? 'none'}</span>,
}))
vi.mock('../components/forms', async (importActual) => ({
  ...(await importActual()),
  PlantingSelect: (props) => (
    <div data-testid={props['data-testid']}>
      {garden.plants.map((p) => (
        <button key={p.id} type="button" data-testid={`offer-${p.id}`} onClick={() => props.onChange(p.id, p)}>
          {p.name}
        </button>
      ))}
    </div>
  ),
}))

import SaveSeedSheet, { seedSavedNote } from '../components/planting/SaveSeedSheet.jsx'
import { todayLocalISO } from '../lib/dateLocal.js'
import { blendReply, lotReply } from './fixtures/seedMix.fixture.js'

const YEAR = todayLocalISO().slice(0, 4)
const LOT = lotReply()

const V_CARMEN = { id: 'v-carmen', name: 'Carmen', crop_type_slug: 'pepper', breeding_system: 'f1', variety_rank: 'cultivar' }
const V_NARDELLO = { id: 'v-nardello', name: 'Jimmy Nardello', crop_type_slug: 'pepper', breeding_system: 'open_pollinated', variety_rank: 'cultivar' }
const EAST = { id: 'pl-east', name: 'Carmen east', quantity: 1, variety_ref: V_CARMEN }
const WEST = { id: 'pl-west', name: 'Carmen west', quantity: 1, variety_ref: V_CARMEN }
const SOUTH = { id: 'pl-south', name: 'Carmen south', quantity: 1, variety_ref: V_CARMEN }
const NARDELLO = { id: 'pl-nardello', name: 'Nardello by the shed', quantity: 1, variety_ref: V_NARDELLO }

const deferred = () => {
  let resolve; let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/**
 * Route by URL. `events` maps a plant_id to the function that answers THAT plant's event write; any
 * plant not named resolves. `fail` lists path fragments to reject (the stage, the measure).
 */
const route = ({ events = {}, fail = [] } = {}) => apiFetchSpy.mockImplementation((path, opts = {}) => {
  const p = String(path)
  const body = opts.body ? JSON.parse(opts.body) : null
  if (fail.some((frag) => p.includes(frag))) return Promise.reject(new Error('boom'))
  if (p === '/api/varieties/blend' && opts.method === 'POST') return Promise.resolve(blendReply())
  if (p === '/api/inventory-items' && opts.method === 'POST') return Promise.resolve(LOT)
  if (p === '/api/events' && opts.method === 'POST') {
    const answer = events[body.plant_id]
    return answer ? answer(body) : Promise.resolve({ id: `evt-${body.plant_id}` })
  }
  if (p.endsWith('/seed-stage') || p.endsWith('/seed-measure')) return Promise.resolve({ ok: true })
  return Promise.reject(new Error(`unrouted ${opts.method} ${p}`))
})

const onClose = vi.fn()
const mount = (planting, props = {}) => render(<SaveSeedSheet planting={planting} onClose={onClose} {...props} />)
const addPlanting = (p) => {
  fireEvent.click(screen.getByTestId('save-seed-add-plant'))
  fireEvent.click(screen.getByTestId(`offer-${p.id}`))
}
const submit = () => fireEvent.click(screen.getByTestId('save-seed-submit'))
const eventCalls = () => apiFetchSpy.mock.calls.filter(([p]) => /\/events/.test(String(p)))
const eventBodies = () => eventCalls().map(([, o]) => JSON.parse(o.body))
const eventPlants = () => eventBodies().map((b) => b.plant_id)
/** Flush the microtasks a settled promise has queued, without waiting on any timer. */
const settle = () => act(async () => { await Promise.resolve() })

/** Three plantings of one variety, opened from the first. */
const mountThree = (props) => { mount(EAST, props); addPlanting(WEST); addPlanting(SOUTH) }

beforeEach(() => {
  garden.plants = [EAST, WEST, SOUTH, NARDELLO]
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); toastSpy.mockReset(); onClose.mockReset()
  route()
})

describe('one seed_saved event per parent', () => {
  it('writes one for each row of the From block, in row order, and nothing else', async () => {
    mountThree()
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(eventPlants()).toEqual(['pl-east', 'pl-west', 'pl-south'])
  })

  it('every one goes through the single POST /api/events: there is no batch call', async () => {
    mountThree()
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    for (const [path, opts] of eventCalls()) {
      expect(path).toBe('/api/events')
      expect(opts.method).toBe('POST')
      // One event per body: an object naming one plant, never an array of them.
      const body = JSON.parse(opts.body)
      expect(Array.isArray(body)).toBe(false)
      expect(typeof body.plant_id).toBe('string')
      expect(Object.prototype.hasOwnProperty.call(body, 'events')).toBe(false)
    }
    expect(eventCalls()).toHaveLength(3)
  })

  it('each carries the same payload it always has, for its own plant', async () => {
    mountThree()
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    const note = seedSavedNote(`Carmen — saved ${YEAR}`)
    for (const [i, id] of ['pl-east', 'pl-west', 'pl-south'].entries()) {
      expect(eventCalls()[i][1].body).toBe(JSON.stringify({
        plant_id: id,
        event_type: 'seed_saved',
        event_date: todayLocalISO(),
        notes: note,
        metadata: { seed_lot_id: LOT.id },
      }))
    }
  })

  it('the note names the jar and never the other plants', async () => {
    // It is permanent. Taking a mis-tapped plant off the jar later would leave a clause about it
    // false on the other plants' timelines; the entry links to the jar, which shows the live set.
    mountThree()
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    for (const body of eventBodies()) {
      expect(body.notes).not.toMatch(/east|west|south|mixed with/i)
      expect(body.notes).toBe(`Seed lot "Carmen — saved ${YEAR}". No count yet — recorded when it's marked stored.`)
    }
  })

  it('a mix: one per planting, the note naming the lot as it was sent', async () => {
    mount(EAST)
    addPlanting(NARDELLO)
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(eventPlants()).toEqual(['pl-east', 'pl-nardello'])
    const sentName = JSON.parse(apiFetchSpy.mock.calls.find(([p]) => p === '/api/inventory-items')[1].body).name
    expect(sentName).toBe(`${blendReply().name} — saved ${YEAR}`)
    for (const body of eventBodies()) expect(body.notes).toBe(seedSavedNote(sentName))
  })

  it('one planting still writes exactly one', async () => {
    mount(EAST)
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(eventPlants()).toEqual(['pl-east'])
  })

  it('a planting removed before Save gets no event', async () => {
    mountThree()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Carmen west' }))
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(eventPlants()).toEqual(['pl-east', 'pl-south'])
  })

  it('each note carries the stage that LANDED, and none when the stage write failed', async () => {
    mountThree()
    fireEvent.click(screen.getByTestId('save-seed-process-dry'))
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    // The stage is written before the first event, so every note can state it.
    const order = apiFetchSpy.mock.calls.map(([p]) => String(p))
    expect(order.findIndex((p) => p.endsWith('/seed-stage'))).toBeLessThan(order.indexOf('/api/events'))
    for (const body of eventBodies()) expect(body.notes).toBe(seedSavedNote(`Carmen — saved ${YEAR}`, 'drying'))
  })

  it('a stage write that failed leaves the clause off every note', async () => {
    route({ fail: ['/seed-stage'] })
    mountThree()
    fireEvent.click(screen.getByTestId('save-seed-process-dry'))
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(eventBodies()).toHaveLength(3)
    for (const body of eventBodies()) expect(body.notes).not.toMatch(/drying|fermenting/)
  })
})

describe('in turn, never at once', () => {
  it('holds on one parent’s write: the next is not sent, and the save has not finished', async () => {
    const east = deferred()
    route({ events: { 'pl-east': () => east.promise } })
    mountThree()
    submit()
    await waitFor(() => expect(eventPlants()).toEqual(['pl-east']))
    await settle()

    // The first write is still out. Nothing after it has happened.
    expect(eventPlants()).toEqual(['pl-east'])
    expect(toastSpy).not.toHaveBeenCalled()
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('save-seed-submit').textContent).toBe('Saving…')

    // It FAILS. The other two are still attempted, each once, and the save ends as a clean one.
    await act(async () => { east.reject(new Error('events 500')) })
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(eventPlants()).toEqual(['pl-east', 'pl-west', 'pl-south'])
    expect(toastSpy).toHaveBeenCalledTimes(1)
    expect(toastSpy.mock.calls[0][0]).toEqual({ message: 'Seed lot saved', tone: 'success' })
    expect(navigateSpy).toHaveBeenCalledTimes(1)
    expect(navigateSpy.mock.calls[0][0]).toBe(`/inventory/${LOT.id}`)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('save-seed-error')).toBeNull()
  })

  it('the third waits for the second, which waits for the first', async () => {
    const east = deferred()
    const west = deferred()
    route({ events: { 'pl-east': () => east.promise, 'pl-west': () => west.promise } })
    mountThree()
    submit()
    await waitFor(() => expect(eventPlants()).toEqual(['pl-east']))
    await act(async () => { east.resolve({ id: 'evt-east' }) })
    await waitFor(() => expect(eventPlants()).toEqual(['pl-east', 'pl-west']))
    await settle()
    expect(eventPlants()).toEqual(['pl-east', 'pl-west'])
    expect(toastSpy).not.toHaveBeenCalled()
    await act(async () => { west.resolve({ id: 'evt-west' }) })
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(eventPlants()).toEqual(['pl-east', 'pl-west', 'pl-south'])
  })

  it('a host that owns the ending is told only after the last parent’s write', async () => {
    const south = deferred()
    route({ events: { 'pl-south': () => south.promise } })
    const onSaved = vi.fn()
    mountThree({ onSaved })
    submit()
    await waitFor(() => expect(eventPlants()).toEqual(['pl-east', 'pl-west', 'pl-south']))
    await settle()
    expect(onSaved).not.toHaveBeenCalled()
    await act(async () => { south.resolve({ id: 'evt-south' }) })
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(onSaved.mock.calls[0][0]).toBe(LOT)
    expect(navigateSpy).not.toHaveBeenCalled()
  })
})

describe('never retried, and a failure says nothing', () => {
  const failing = () => Promise.reject(Object.assign(new Error('events 500'), { status: 500 }))

  it('the MIDDLE parent’s write fails: one attempt for it, and both neighbours still written', async () => {
    route({ events: { 'pl-west': failing } })
    mountThree()
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(eventPlants()).toEqual(['pl-east', 'pl-west', 'pl-south'])
    expect(eventPlants().filter((id) => id === 'pl-west')).toHaveLength(1)
  })

  it('leaves the toast, the routing and the sheet exactly as a clean save leaves them', async () => {
    route({ events: { 'pl-west': failing } })
    mountThree()
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy).toHaveBeenCalledTimes(1)
    expect(toastSpy.mock.calls[0][0]).toEqual({ message: 'Seed lot saved', tone: 'success' })
    expect(navigateSpy.mock.calls).toEqual([[`/inventory/${LOT.id}`]])
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('save-seed-error')).toBeNull()
  })

  it('EVERY write failing is still a saved lot, with one attempt per parent', async () => {
    route({ events: { 'pl-east': failing, 'pl-west': failing, 'pl-south': failing } })
    mountThree()
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(eventPlants()).toEqual(['pl-east', 'pl-west', 'pl-south'])
    expect(toastSpy.mock.calls[0][0]).toEqual({ message: 'Seed lot saved', tone: 'success' })
    expect(navigateSpy).toHaveBeenCalledTimes(1)
  })

  it('a timeout is not retried either', async () => {
    route({ events: { 'pl-east': () => Promise.reject(Object.assign(new Error('Request timed out'), { status: 0, timeout: true })) } })
    mountThree()
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(eventPlants()).toEqual(['pl-east', 'pl-west', 'pl-south'])
  })
})

describe('no lot, no events', () => {
  it('a refused lot writes nothing on any plant', async () => {
    apiFetchSpy.mockImplementation((path) => (String(path) === '/api/inventory-items'
      ? Promise.reject(Object.assign(new Error('nope'), { status: 500, body: { error: 'nope' } }))
      : Promise.resolve({ id: 'x' })))
    mountThree()
    submit()
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())
    expect(eventCalls()).toHaveLength(0)
  })
})
