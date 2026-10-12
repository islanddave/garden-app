// BUG-NEWLOTNOIDEMPOTENCYKEY-001 — the NEW lot's create carries a key, one per draft.
//
// The add-to-a-lot form has always sent a key with its write; this form sent none, so a create whose
// answer was lost and was saved again, or a draft closed mid-save, typed again and saved before the
// first landed, could make two lots. The key is the client's half: the same draft sends the same key,
// from the open sheet or from one opened again, and anything typed differently is another draft.
//
// The lot's Lambda does not read the key yet, so its two possible answers are both played here: the
// same lot twice (a server that knows the key answers the second request with the first one's lot) and
// two lots (the server as it stands). The first must end as one save; the second as it always did.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'

const { navigateSpy, fetchSpy, toastSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn(), fetchSpy: vi.fn(), toastSpy: vi.fn() }))

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn(async () => 'tok') }),
  apiFetch: vi.fn(async () => ({})),
}))
vi.mock('../context/ToastContext.jsx', async (orig) => ({
  ...(await orig()),
  useOptionalToast: () => ({ show: toastSpy }),
}))
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: () => <div data-testid="variety-picker-stub" />,
}))

import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'

const PLANTING = {
  id: 'pl-1', name: 'Brandywine — bed 3', quantity: 1,
  variety_ref: { id: 'var-brandy', name: 'Brandywine' },
}
const LOT = { id: 'lot-1' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const defer = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const timedOut = () => Object.assign(new Error('Request timed out'), { status: 0, timeout: true })
const calls = (method, test) => fetchSpy.mock.calls.filter(([p, o]) => (o?.method ?? 'GET') === method && test(String(p)))
const posts = (path) => calls('POST', (p) => p === path)
const createBodies = () => posts('/api/inventory-items').map(([, o]) => JSON.parse(o.body))
const keys = () => createBodies().map((b) => b.idempotency_key)

const onClose = vi.fn()
const onSavedAfterClose = vi.fn()

// The door: it takes the sheet away on close, as every door does, and can open it again.
function Host() {
  const [shown, setShown] = React.useState(true)
  if (!shown) return <button type="button" data-testid="open-again" onClick={() => setShown(true)}>Save seed</button>
  return <SaveSeedSheet planting={PLANTING} onClose={() => { onClose(); setShown(false) }} onSavedAfterClose={onSavedAfterClose} />
}
const mount = async () => {
  await act(async () => render(<DismissRegistryProvider><Host /></DismissRegistryProvider>))
  await act(async () => { await Promise.resolve() })
}
const openAgain = async () => {
  await act(async () => { fireEvent.click(screen.getByTestId('open-again')) })
  await act(async () => { await Promise.resolve() })
}
const type = (testId, value) => fireEvent.change(screen.getByTestId(testId), { target: { value } })
const tapSave = async () => {
  await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })
  expect(screen.getByTestId('save-seed-submit').textContent).toBe('Saving…')
}
const closeWhileSaving = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
  expect(screen.getByTestId('open-again')).toBeTruthy()
}
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

// Every case types its own lot name: the key is kept outside the sheet, per draft, and one case's
// draft must not be the next one's.
let n = 0
let lotName
// One answer held per create, in the order they were asked.
let creates

beforeEach(() => {
  navigateSpy.mockReset()
  toastSpy.mockReset()
  onClose.mockReset()
  onSavedAfterClose.mockReset()
  lotName = `Brandywine, key case ${++n}`
  creates = []
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (opts.method === 'POST' && String(url) === '/api/inventory-items') {
      const held = defer()
      creates.push(held)
      return held.promise
    }
    return Promise.resolve({ id: 'x' })
  })
  window.history.replaceState({ __base: 1 }, '')
})

describe('the same draft sends the same key', () => {
  it('a create that timed out and is saved again from the open sheet: one key, a uuid, on both', async () => {
    await mount()
    type('save-seed-name', lotName)
    await tapSave()
    await act(async () => { creates[0].reject(timedOut()) })
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())

    await tapSave()
    await act(async () => { creates[1].resolve(LOT) })
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1))

    expect(keys()).toHaveLength(2)
    expect(keys()[0]).toMatch(UUID)
    expect(keys()[1]).toBe(keys()[0])
    // The key is the only thing the request gained: the rest of the two bodies is one body.
    const [a, b] = createBodies()
    expect(a).toEqual(b)
    expect(a.name).toBe(lotName)
  })

  it('the silent second send after "one of those plants changed" carries the key the first one did', async () => {
    await mount()
    type('save-seed-name', lotName)
    await tapSave()
    await act(async () => { creates[0].reject(Object.assign(new Error('x'), { status: 409, body: { error: 'x', code: 'parents_changed' } })) })
    await waitFor(() => expect(creates).toHaveLength(2))
    await act(async () => { creates[1].resolve(LOT) })
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1))
    expect(keys()[0]).toMatch(UUID)
    expect(keys()[1]).toBe(keys()[0])
  })

  it('closed while saving, opened again, typed again and saved before the first lands: the same key', async () => {
    await mount()
    type('save-seed-name', lotName)
    await tapSave()
    await closeWhileSaving()

    await openAgain()
    type('save-seed-name', lotName)
    await tapSave()

    expect(creates).toHaveLength(2)
    expect(keys()[0]).toMatch(UUID)
    expect(keys()[1]).toBe(keys()[0])
  })

  it('the first landed while the sheet opened again was being typed in: its save still carries the same key', async () => {
    await mount()
    type('save-seed-name', lotName)
    await tapSave()
    await closeWhileSaving()
    await openAgain()
    type('save-seed-name', lotName)

    await act(async () => { creates[0].resolve(LOT) })
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1))

    await tapSave()
    expect(keys()[0]).toMatch(UUID)
    expect(keys()[1]).toBe(keys()[0])
  })
})

describe('another draft is another key', () => {
  it('the name changed after a lost answer: the second save is a different lot and says so with a new key', async () => {
    await mount()
    type('save-seed-name', lotName)
    await tapSave()
    await act(async () => { creates[0].reject(timedOut()) })
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())

    type('save-seed-name', `${lotName}, renamed`)
    await tapSave()
    expect(keys()[1]).toMatch(UUID)
    expect(keys()[1]).not.toBe(keys()[0])
  })

  // The count is not in the create's body: it rides the second request. One key never stands for two
  // different saves, so it is part of the draft all the same.
  it('a count added after a lost answer: a new key, though the create body is the one sent before', async () => {
    await mount()
    type('save-seed-name', lotName)
    await tapSave()
    await act(async () => { creates[0].reject(timedOut()) })
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())

    type('save-seed-count', '40')
    await tapSave()
    const [a, b] = createBodies()
    expect({ ...b, idempotency_key: null }).toEqual({ ...a, idempotency_key: null })
    expect(b.idempotency_key).toMatch(UUID)
    expect(b.idempotency_key).not.toBe(a.idempotency_key)
  })

  it('a save the open sheet saw finish ends its key: the same words typed into the next sheet are a new lot', async () => {
    await mount()
    type('save-seed-name', lotName)
    await tapSave()
    await act(async () => { creates[0].resolve(LOT) })
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledTimes(1))

    await openAgain()
    type('save-seed-name', lotName)
    await tapSave()
    expect(keys()[1]).toMatch(UUID)
    expect(keys()[1]).not.toBe(keys()[0])
  })

  it('a sheet opened after a late save was said: the same words are a new lot, with a new key', async () => {
    await mount()
    type('save-seed-name', lotName)
    await tapSave()
    await closeWhileSaving()
    await act(async () => { creates[0].resolve(LOT) })
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1))

    await openAgain()
    type('save-seed-name', lotName)
    await tapSave()
    expect(keys()[1]).toMatch(UUID)
    expect(keys()[1]).not.toBe(keys()[0])
  })
})

// A server that knows the key answers the second request with the lot the first one made. Both saves
// then hold the same lot, and it is finished once: one count, one stage, one timeline entry, one toast.
describe('two saves of one draft answered with the same lot', () => {
  const draftWithMeasures = () => {
    type('save-seed-name', lotName)
    type('save-seed-count', '40')
    fireEvent.click(screen.getByTestId('save-seed-process-dry'))
  }
  const once = () => {
    expect(calls('PUT', (p) => p === '/api/inventory-items/lot-1/seed-measure')).toHaveLength(1)
    expect(posts('/api/inventory-items/lot-1/seed-stage')).toHaveLength(1)
    expect(posts('/api/events')).toHaveLength(1)
    expect(toastSpy).toHaveBeenCalledTimes(1)
    expect(toastSpy).toHaveBeenCalledWith({ message: 'Seed lot saved', tone: 'success' })
  }

  it('the closed sheet\'s answer comes first: it finishes the lot, and the open sheet then closes and goes where that save led', async () => {
    await mount()
    draftWithMeasures()
    await tapSave()
    await closeWhileSaving()
    await openAgain()
    draftWithMeasures()
    await tapSave()
    expect(keys()[1]).toBe(keys()[0])

    await act(async () => { creates[0].resolve(LOT) })
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1))
    expect(onSavedAfterClose).toHaveBeenCalledTimes(1)
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('save-seed-submit').textContent).toBe('Saving…')

    await act(async () => { creates[1].resolve({ ...LOT }) })
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledTimes(1))
    // The stage the first save wrote is where this one goes: the queue, on the lot.
    expect(String(navigateSpy.mock.calls[0][0])).toMatch(/lot-1/)
    expect(String(navigateSpy.mock.calls[0][0])).not.toBe('/inventory/lot-1')
    expect(screen.getByTestId('open-again')).toBeTruthy()
    expect(onClose).toHaveBeenCalledTimes(2)
    await settle()
    once()
    expect(onSavedAfterClose).toHaveBeenCalledTimes(1)
  })

  it('the open sheet\'s answer comes first: it finishes the lot, and the closed one then does nothing at all', async () => {
    await mount()
    draftWithMeasures()
    await tapSave()
    await closeWhileSaving()
    await openAgain()
    draftWithMeasures()
    await tapSave()

    await act(async () => { creates[1].resolve(LOT) })
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalledTimes(2)

    await act(async () => { creates[0].resolve({ ...LOT }) })
    await settle()
    once()
    expect(onSavedAfterClose).not.toHaveBeenCalled()
    expect(navigateSpy).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('the first answer was lost, the second names a lot: that save finishes it, whoever made it', async () => {
    await mount()
    draftWithMeasures()
    await tapSave()
    await act(async () => { creates[0].reject(timedOut()) })
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())
    await tapSave()
    await act(async () => { creates[1].resolve(LOT) })
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledTimes(1))
    once()
  })
})

// The server as it stands does not know the key: two requests are two lots. Each is finished by its own
// save, exactly as before the key existed.
describe('two saves of one draft answered with two lots', () => {
  it('each lot gets its timeline entry and its "Seed lot saved"', async () => {
    await mount()
    type('save-seed-name', lotName)
    await tapSave()
    await closeWhileSaving()
    await openAgain()
    type('save-seed-name', lotName)
    await tapSave()

    await act(async () => { creates[0].resolve({ id: 'lot-1' }) })
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1))
    await act(async () => { creates[1].resolve({ id: 'lot-2' }) })
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2))

    const entries = posts('/api/events').map(([, o]) => JSON.parse(o.body).metadata.seed_lot_id)
    expect(entries).toEqual(['lot-1', 'lot-2'])
    expect(navigateSpy).toHaveBeenCalledTimes(1)
    expect(navigateSpy.mock.calls[0][0]).toBe('/inventory/lot-2')
  })
})
