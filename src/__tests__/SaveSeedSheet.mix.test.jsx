// V5-SEEDMULTIPARENT-001 release 2b — the MIX, made at Save, and every way a save can stop before
// the lot exists.
//
// The sheet's first draft called POST /api/varieties/blend "when the set settles". That is not a
// testable trigger, and the route is a find-or-CREATE into a variety list every picker in the app
// reads: a call per pick leaves a mix behind for every set passed through, and needs a loading state,
// a failure state and a rule for a Save pressed mid-call. So the mix is STEP 0 OF SAVE, for the set
// actually being saved. What that leaves to pin:
//   • the order and the bodies: mix, then the lot filed under the RETURNED id, with both parent keys;
//   • the name: the lot name is rebuilt from the RETURNED name while it is untouched, never after;
//   • failure of each kind, at the mix and at the lot: nothing after it is sent, the sheet stays open
//     on every field as typed, and the sentence is the client's own, never the server's (one of the
//     server's reads "Reload and try again", which here would throw the entries away);
//   • 409 parents_changed on the lot: sent once more, silently.
//
// EVERY REPLY AND REFUSAL COMES FROM THE CONTRACT FIXTURE (fixtures/seedMix.fixture.js, built from
// tests/contracts/seed-mix.json), and the plantings below are built from the contract's own
// source_plants, so the ids the sheet sends are the ids the fixture's replies and refusals name.
// The fetch mock routes by URL and method, never by call order. No timers. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
// Offers every planting in `garden.plants`, whatever its crop: the refusal cases need a set the real
// crop-filtered picker would never have listed (a planting that changed after it was listed).
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

import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { todayLocalISO } from '../lib/dateLocal.js'
import { blendReply, lotReply, measureReply, refusal } from './fixtures/seedMix.fixture.js'

const YEAR = todayLocalISO().slice(0, 4)

// The contract's example jar: three plantings of two varieties, one crop.
const [SP_A, SP_A2, SP_B] = lotReply().source_plants
const plantingOf = (sp, over = {}) => ({
  id: sp.id, name: sp.name, quantity: 1, variety_id: sp.variety_id,
  variety_ref: {
    id: sp.variety_id, name: sp.variety_name, crop_type_slug: sp.crop_slug,
    breeding_system: sp.breeding_system, variety_rank: sp.variety_rank,
  },
  ...over,
})
const A = plantingOf(SP_A)
const A2 = plantingOf(SP_A2)
const B = plantingOf(SP_B)
// Same variety row as B but recorded under another crop: what a planting looks like when its variety
// was re-cropped after the picker listed it.
const OTHER_CROP = plantingOf(SP_B, {
  id: 'pl-other-crop', name: 'Sungold by the gate', variety_id: 'v-sungold',
  variety_ref: { id: 'v-sungold', name: 'Sungold', crop_type_slug: 'tomato', breeding_system: 'f1', variety_rank: 'cultivar' },
})

const SAVE_FAILED = "Couldn't save just now. Nothing was saved. Your entries are still here. Tap Save seed to try again."
const SAVE_OFFLINE = "You're offline. Nothing was saved. Your entries stay here until you're back in range."
const SAVE_UNCONFIRMED = "That didn't finish, so the jar may or may not have saved. Look in Seeds before you tap Save seed again."
const NEEDS_UPDATE = 'This jar needs the latest version of the app. Nothing was saved.'

/** A rejection shaped the way src/lib/api.js throws a non-2xx: message, status, body. */
const httpError = ({ status, body }) => Object.assign(new Error(body?.error ?? `HTTP ${status}`), { status, body })
const reject = (r) => () => Promise.reject(httpError(r))

/** Route by URL and method. Each handler gets the parsed body; override any of them per test. */
const route = (over = {}) => {
  const handlers = {
    blend: () => Promise.resolve(blendReply()),
    lot: () => Promise.resolve(lotReply()),
    measure: (body) => Promise.resolve(measureReply({ seed_parent_plant_count: body.seed_parent_plant_count ?? null })),
    stage: () => Promise.resolve({ ok: true }),
    event: () => Promise.resolve({ id: 'evt' }),
    ...over,
  }
  apiFetchSpy.mockImplementation((path, opts = {}) => {
    const p = String(path)
    const body = opts.body ? JSON.parse(opts.body) : null
    if (p === '/api/varieties/blend' && opts.method === 'POST') return handlers.blend(body)
    if (p === '/api/inventory-items' && opts.method === 'POST') return handlers.lot(body)
    if (p.endsWith('/seed-measure') && opts.method === 'PUT') return handlers.measure(body)
    if (p.endsWith('/seed-stage') && opts.method === 'POST') return handlers.stage(body)
    if (p === '/api/events' && opts.method === 'POST') return handlers.event(body)
    return Promise.reject(new Error(`unrouted ${opts.method} ${p}`))
  })
}

const onClose = vi.fn()
const mount = (planting, props = {}) => render(<SaveSeedSheet planting={planting} onClose={onClose} {...props} />)
const addPlanting = (p) => {
  fireEvent.click(screen.getByTestId('save-seed-add-plant'))
  fireEvent.click(screen.getByTestId(`offer-${p.id}`))
}
const submit = () => fireEvent.click(screen.getByTestId('save-seed-submit'))
const errorText = () => screen.queryByTestId('save-seed-error')?.textContent ?? null
const sequence = () => apiFetchSpy.mock.calls.map(([p, o]) => `${o?.method} ${p}`)
const calls = (path, method = 'POST') => apiFetchSpy.mock.calls
  .filter(([p, o]) => String(p) === path && o?.method === method)
const bodyOf = (call) => JSON.parse(call[1].body)
const blendCalls = () => calls('/api/varieties/blend')
const lotCalls = () => calls('/api/inventory-items')
const eventCalls = () => calls('/api/events')

/** A + B: two varieties, so a mix. */
const mountMix = (props) => { mount(A, props); addPlanting(B) }

beforeEach(() => {
  garden.plants = [A, A2, B, OTHER_CROP]
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); toastSpy.mockReset(); onClose.mockReset()
  route()
})

describe('the mix is step 0 of Save', () => {
  it('asks the mix route first, then files the lot under the variety it RETURNED', async () => {
    mountMix()
    expect(apiFetchSpy).not.toHaveBeenCalled()
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())

    expect(sequence()).toEqual([
      'POST /api/varieties/blend',
      'POST /api/inventory-items',
      'POST /api/events',
      'POST /api/events',
    ])
    expect(blendCalls()[0][1].body).toBe(JSON.stringify({
      component_variety_ids: [SP_A.variety_id, SP_B.variety_id],
      create: true,
    }))
    // Every key, in order: the pre-release body with the filed variety swapped for the mix and the
    // whole set beside the legacy key.
    expect(lotCalls()[0][1].body).toBe(JSON.stringify({
      name: `${blendReply().name} — saved ${YEAR}`,
      category: 'seeds',
      type: 'consumable',
      unit: 'packet',
      quantity_on_hand: 1,
      variety_id: blendReply().id,
      source_plant_id: A.id,
      source_plant_ids: [A.id, B.id],
    }))
    expect(toastSpy).toHaveBeenCalledTimes(1)
    expect(toastSpy.mock.calls[0][0]).toEqual({ message: 'Seed lot saved', tone: 'success' })
    expect(errorText()).toBeNull()
  })

  it('names the varieties once each, in uuid order, whatever order the plantings were picked in', async () => {
    // Three plantings, two varieties, opened from the SECOND variety's planting.
    mount(B)
    addPlanting(A)
    addPlanting(A2)
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(bodyOf(blendCalls()[0]).component_variety_ids).toEqual([SP_A.variety_id, SP_B.variety_id])
    const lot = bodyOf(lotCalls()[0])
    // Rows keep pick order; the legacy key is the first ROW, not the first variety.
    expect(lot.source_plant_ids).toEqual([B.id, A.id, A2.id])
    expect(lot.source_plant_id).toBe(B.id)
  })

  it('one variety across the plantings never calls the mix route', async () => {
    mount(A)
    addPlanting(A2)
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(blendCalls()).toHaveLength(0)
    expect(bodyOf(lotCalls()[0]).variety_id).toBe(SP_A.variety_id)
  })

  it('an untouched lot name is rebuilt from the RETURNED name, and the timeline note carries it', async () => {
    // The server names a mix from its leaves, may suffix a clashing name, and keeps a name the mix
    // was given by hand. The client's preview cannot know any of that.
    route({ blend: () => Promise.resolve(blendReply({ name: 'Back fence nasturtiums' })) })
    mountMix()
    // On screen before Save: the client's own reading.
    expect(screen.getByTestId('save-seed-name').value)
      .toBe(`${SP_A.variety_name} + ${SP_B.variety_name} mix — saved ${YEAR}`)
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(bodyOf(lotCalls()[0]).name).toBe(`Back fence nasturtiums — saved ${YEAR}`)
    for (const call of eventCalls()) {
      expect(bodyOf(call).notes).toContain(`Seed lot "Back fence nasturtiums — saved ${YEAR}"`)
    }
  })

  it('a lot name that was typed is sent as typed', async () => {
    route({ blend: () => Promise.resolve(blendReply({ name: 'Back fence nasturtiums' })) })
    mountMix()
    fireEvent.change(screen.getByTestId('save-seed-name'), { target: { value: '  Jar on the sill  ' } })
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(bodyOf(lotCalls()[0]).name).toBe('Jar on the sill')
    expect(bodyOf(lotCalls()[0]).variety_id).toBe(blendReply().id)
  })

  it('hands a host the lot the create returned, as before', async () => {
    const created = lotReply()
    route({ lot: () => Promise.resolve(created) })
    const onSaved = vi.fn()
    mountMix({ onSaved })
    fireEvent.click(screen.getByTestId('save-seed-process-dry'))
    submit()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onSaved.mock.calls[0][0]).toBe(created)
    expect(onSaved.mock.calls[0][1]).toStrictEqual({ stageWritten: 'drying' })
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('a second tap while the mix call is in flight sends nothing more', async () => {
    let release
    route({ blend: () => new Promise((res) => { release = () => res(blendReply()) }) })
    mountMix()
    submit()
    submit()
    await act(async () => { release() })
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(blendCalls()).toHaveLength(1)
    expect(lotCalls()).toHaveLength(1)
  })
})

// ── nothing was saved ───────────────────────────────────────────────────────────────────────────
// One assertion set for every stop before the lot exists: the request after it was never sent, no
// follow-up ran, nothing closed or navigated, no toast, and the sheet is still holding what was typed.
const fillIn = () => {
  fireEvent.change(screen.getByTestId('save-seed-name'), { target: { value: 'Jar on the sill' } })
  fireEvent.change(screen.getByTestId('save-seed-count'), { target: { value: '40' } })
  fireEvent.change(screen.getByTestId('save-seed-plant-count'), { target: { value: '3' } })
  fireEvent.click(screen.getByTestId('save-seed-process-dry'))
}
const expectNothingSavedAndEntriesKept = () => {
  expect(eventCalls()).toHaveLength(0)
  expect(apiFetchSpy.mock.calls.filter(([p]) => /seed-measure|seed-stage/.test(String(p)))).toHaveLength(0)
  expect(toastSpy).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  expect(navigateSpy).not.toHaveBeenCalled()
  expect(screen.getByTestId('save-seed-name').value).toBe('Jar on the sill')
  expect(screen.getByTestId('save-seed-count').value).toBe('40')
  expect(screen.getByTestId('save-seed-plant-count').value).toBe('3')
  expect(screen.getByTestId('save-seed-process-dry').getAttribute('aria-pressed')).toBe('true')
  expect(screen.getAllByTestId('save-seed-from-row')).toHaveLength(2)
  // Re-tryable: Save is live again, and there is no Reload control anywhere on the sheet.
  const save = screen.getByTestId('save-seed-submit')
  expect(save.disabled).toBe(false)
  expect(save.textContent).toBe('Save seed')
  expect(screen.queryByRole('button', { name: /reload/i })).toBeNull()
}

describe('the mix call fails: no lot is asked for, and the sentence is the client’s', () => {
  const SERVER_409 = 'This mix was changed at the same moment. Reload and try again.'
  const SERVER_429 = 'Rate limit exceeded — 60/hour for plant_varieties.create'

  it.each([
    ['405, a Lambda older than the route', { status: 405, body: { error: 'Method not allowed' } }, NEEDS_UPDATE],
    ['409, changed at the same moment', { status: 409, body: { error: SERVER_409 } }, SAVE_FAILED],
    ['429, the create rate limit', { status: 429, body: { error: SERVER_429 } }, SAVE_FAILED],
    ['500', { status: 500, body: { error: 'Internal error' } }, SAVE_FAILED],
    ['400 component_unknown', refusal('component_unknown'), SAVE_FAILED],
    ['400 blend_needs_two', refusal('blend_needs_two'), SAVE_FAILED],
    ['400 blend_too_many', refusal('blend_too_many'), SAVE_FAILED],
  ])('%s', async (_label, refused, sentence) => {
    route({ blend: reject(refused) })
    mountMix()
    fillIn()
    submit()
    await waitFor(() => expect(errorText()).toBe(sentence))
    expect(errorText()).not.toContain(refused.body.error)
    expect(lotCalls()).toHaveLength(0)
    expectNothingSavedAndEntriesKept()
  })

  it('no connection: says offline, from the browser’s own error with no status', async () => {
    route({ blend: () => Promise.reject(new TypeError('Failed to fetch')) })
    mountMix()
    fillIn()
    submit()
    await waitFor(() => expect(errorText()).toBe(SAVE_OFFLINE))
    expect(lotCalls()).toHaveLength(0)
    expectNothingSavedAndEntriesKept()
  })

  it('a timeout is not "offline": the general sentence', async () => {
    route({ blend: () => Promise.reject(Object.assign(new Error('Request timed out'), { status: 0, timeout: true })) })
    mountMix()
    fillIn()
    submit()
    await waitFor(() => expect(errorText()).toBe(SAVE_FAILED))
    expect(errorText()).not.toContain('timed out')
    expect(lotCalls()).toHaveLength(0)
    expectNothingSavedAndEntriesKept()
  })

  it('a reply with no variety id is a failure, not a lot filed under nothing', async () => {
    route({ blend: () => Promise.resolve(blendReply({ id: null, exists: false })) })
    mountMix()
    fillIn()
    submit()
    await waitFor(() => expect(errorText()).toBe(SAVE_FAILED))
    expect(lotCalls()).toHaveLength(0)
    expectNothingSavedAndEntriesKept()
  })

  it('400 mixed_crop_components names the planting whose crop differs', async () => {
    route({ blend: reject(refusal('mixed_crop_components')) })
    mount(A)
    addPlanting(OTHER_CROP)
    fillIn()
    submit()
    await waitFor(() => expect(errorText())
      .toBe("Sungold by the gate is a different crop, so it can't share this jar. Remove it and save again."))
    expect(lotCalls()).toHaveLength(0)
    expectNothingSavedAndEntriesKept()
  })

  it('tapping Save again asks the mix route again (it is idempotent) and then saves', async () => {
    let attempt = 0
    route({ blend: () => (attempt++ === 0 ? Promise.reject(httpError({ status: 500, body: { error: 'x' } })) : Promise.resolve(blendReply())) })
    mountMix()
    submit()
    await waitFor(() => expect(errorText()).toBe(SAVE_FAILED))
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(blendCalls()).toHaveLength(2)
    expect(lotCalls()).toHaveLength(1)
    expect(bodyOf(lotCalls()[0]).variety_id).toBe(blendReply().id)
    // The sentence from the first try is cleared by the second.
    expect(toastSpy.mock.calls[0][0]).toEqual({ message: 'Seed lot saved', tone: 'success' })
  })
})

describe('the lot is refused: the client’s own sentence, naming the plant', () => {
  it('parent_without_variety names the planting the route named', async () => {
    // The fixture's refusal carries the contract example's first planting id, which is A's.
    const refused = refusal('parent_without_variety')
    expect(refused.body.plant_id).toBe(A.id)
    route({ lot: reject(refused) })
    mountMix()
    fillIn()
    submit()
    await waitFor(() => expect(errorText())
      .toBe(`${A.name} has no variety recorded, so it can't share a jar. Remove it, or save it as its own jar.`))
    expect(errorText()).not.toContain(refused.body.error)
    expect(lotCalls()).toHaveLength(1)
    expectNothingSavedAndEntriesKept()
  })

  it('parent_without_variety for a planting that is not on the sheet falls back to the general sentence', async () => {
    const refused = refusal('parent_without_variety')
    route({ lot: reject({ ...refused, body: { ...refused.body, plant_id: 'not-a-row' } }) })
    mountMix()
    fillIn()
    submit()
    await waitFor(() => expect(errorText()).toBe(SAVE_FAILED))
    expectNothingSavedAndEntriesKept()
  })

  it('mixed_crop_parents carries no plant, so the sheet finds the row whose crop differs from the first', async () => {
    const refused = refusal('mixed_crop_parents')
    expect(Object.keys(refused.body).sort()).toEqual(['code', 'error'])
    route({ lot: reject(refused) })
    mount(A)
    addPlanting(OTHER_CROP)
    fillIn()
    submit()
    await waitFor(() => expect(errorText())
      .toBe("Sungold by the gate is a different crop, so it can't share this jar. Remove it and save again."))
    expect(errorText()).not.toContain(refused.body.error)
    expectNothingSavedAndEntriesKept()
  })

  it('mixed_crop_parents with no differing row on the sheet does not name the wrong plant', async () => {
    route({ lot: reject(refusal('mixed_crop_parents')) })
    mountMix()
    fillIn()
    submit()
    await waitFor(() => expect(errorText()).toBe(SAVE_FAILED))
    expectNothingSavedAndEntriesKept()
  })

  it.each([
    ['400 blend_required', refusal('blend_required')],
    ['400 with a sentence and no code', { status: 400, body: { error: 'source_plant_id must be one of source_plant_ids' } }],
    ['400 with a code this build does not know', { status: 400, body: { error: 'a newer refusal', code: 'something_new' } }],
    ['405 from the LOT route is not the "latest version" case', { status: 405, body: { error: 'Method not allowed' } }],
    ['500', { status: 500, body: { error: 'Internal error' } }],
  ])('%s: the general sentence, never the server’s', async (_label, refused) => {
    route({ lot: reject(refused) })
    mountMix()
    fillIn()
    submit()
    await waitFor(() => expect(errorText()).toBe(SAVE_FAILED))
    expect(errorText()).not.toContain(refused.body.error)
    expect(lotCalls()).toHaveLength(1)
    expectNothingSavedAndEntriesKept()
  })

  // The lot POST that never answered may have landed with only its reply lost, so the sheet does not
  // claim "nothing was saved": that sentence would invite a second tap and a second jar.
  it('a connection that drops at the lot, while online: does not claim nothing was saved', async () => {
    route({ lot: () => Promise.reject(new TypeError('Failed to fetch')) })
    mountMix()
    fillIn()
    submit()
    await waitFor(() => expect(errorText()).toBe(SAVE_UNCONFIRMED))
    expect(errorText()).not.toContain('Nothing was saved')
    expectNothingSavedAndEntriesKept()
  })

  it('a timeout at the lot: does not claim nothing was saved', async () => {
    route({ lot: () => Promise.reject(Object.assign(new Error('Request timed out'), { status: 0, timeout: true })) })
    mountMix()
    fillIn()
    submit()
    await waitFor(() => expect(errorText()).toBe(SAVE_UNCONFIRMED))
    expect(errorText()).not.toContain('timed out')
    expectNothingSavedAndEntriesKept()
  })

  describe('navigator.onLine false', () => {
    // An own property over the prototype's getter; deleting it puts jsdom's `true` back.
    beforeEach(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }) })
    afterEach(() => { delete navigator.onLine })

    it('says offline whatever the browser called its error', async () => {
      route({ lot: () => Promise.reject(new Error('Load failed')) })
      mountMix()
      fillIn()
      submit()
      await waitFor(() => expect(errorText()).toBe(SAVE_OFFLINE))
      expectNothingSavedAndEntriesKept()
    })
  })
})

describe('409 parents_changed on the lot: sent once more, silently', () => {
  const refused = refusal('parents_changed')

  it('a second try that lands is a clean save: no sentence, one toast, the same body twice', async () => {
    let attempt = 0
    route({ lot: () => (attempt++ === 0 ? Promise.reject(httpError(refused)) : Promise.resolve(lotReply())) })
    mountMix()
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(lotCalls()).toHaveLength(2)
    expect(lotCalls()[1][1].body).toBe(lotCalls()[0][1].body)
    // The mix was not asked for again: the retry is of the lot alone.
    expect(blendCalls()).toHaveLength(1)
    expect(errorText()).toBeNull()
    expect(toastSpy).toHaveBeenCalledTimes(1)
    expect(toastSpy.mock.calls[0][0]).toEqual({ message: 'Seed lot saved', tone: 'success' })
    expect(eventCalls()).toHaveLength(2)
  })

  it('refused twice: the general sentence, no third try, and not the server’s "Reload"', async () => {
    route({ lot: reject(refused) })
    mountMix()
    fillIn()
    submit()
    await waitFor(() => expect(errorText()).toBe(SAVE_FAILED))
    expect(refused.body.error).toMatch(/Reload/)
    expect(errorText()).not.toMatch(/Reload/i)
    expect(lotCalls()).toHaveLength(2)
    expectNothingSavedAndEntriesKept()
  })

  it('a different refusal on the second try is answered as itself', async () => {
    let attempt = 0
    route({ lot: () => Promise.reject(httpError(attempt++ === 0 ? refused : refusal('parent_without_variety'))) })
    mountMix()
    submit()
    await waitFor(() => expect(errorText()).toContain('has no variety recorded'))
    expect(lotCalls()).toHaveLength(2)
  })

  it('any other 409 is not retried', async () => {
    route({ lot: reject({ status: 409, body: { error: 'conflict', code: 'lot_changed' } }) })
    mountMix()
    submit()
    await waitFor(() => expect(errorText()).toBe(SAVE_FAILED))
    expect(lotCalls()).toHaveLength(1)
  })

  it('a one-planting save is retried the same way', async () => {
    let attempt = 0
    route({ lot: () => (attempt++ === 0 ? Promise.reject(httpError(refused)) : Promise.resolve(lotReply())) })
    mount(A)
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(lotCalls()).toHaveLength(2)
    expect(errorText()).toBeNull()
  })
})

describe('after the lot exists, "nothing was saved" is never said', () => {
  it('a host callback that throws gets the sentence that says the lot DID save', async () => {
    const onSaved = vi.fn(() => { throw new Error('host blew up') })
    mountMix({ onSaved })
    submit()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    await waitFor(() => expect(errorText())
      .toBe('The seed lot was saved, but something went wrong after that. Look for it in Seeds before you save again.'))
    expect(errorText()).not.toContain('host blew up')
    expect(lotCalls()).toHaveLength(1)
  })
})
