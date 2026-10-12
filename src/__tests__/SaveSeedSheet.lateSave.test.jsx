// A NEW lot whose save lands after the sheet was closed.
//
// Dave 2026-10-12, on the add-to-a-lot form: a save that lands after he closed the sheet still says it
// worked, and leaves him where he is. The new-lot form is the same sheet with the same Close, live
// while "Saving…" stands, so the same rule is applied to it here: "Seed lot saved" is still said, the
// host still hears (so what it draws can be read again), and nothing navigates or closes a second time.
//
// The hosts below are the two shapes the doors come in: one that takes the ending over with `onSaved`
// (Seeds), and one that leaves the ending to the sheet (the planting page, the log menu), which is told
// through `onSavedAfterClose`. Each takes the sheet away on close, as every door does.
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
  id: 'pl-1', name: 'Brandywine — bed 3',
  variety_ref: { id: 'var-brandy', name: 'Brandywine' },
}
const LOT = { id: 'lot-1' }

const defer = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const timedOut = () => Object.assign(new Error('Request timed out'), { status: 0, timeout: true })
const posts = (path) => fetchSpy.mock.calls.filter(([p, o]) => o?.method === 'POST' && String(p) === path)

const onClose = vi.fn()
const onSaved = vi.fn()
const onSavedAfterClose = vi.fn()

let held
function Host({ takesEnding }) {
  const [shown, setShown] = React.useState(true)
  if (!shown) return <p data-testid="host-page">the page under the sheet</p>
  const ending = takesEnding ? { onSaved } : { onSavedAfterClose }
  return <SaveSeedSheet planting={PLANTING} onClose={() => { onClose(); setShown(false) }} {...ending} />
}
const mount = async (takesEnding) => {
  await act(async () => render(<DismissRegistryProvider><Host takesEnding={takesEnding} /></DismissRegistryProvider>))
  await act(async () => { await Promise.resolve() })
}
const tapSave = async () => {
  await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })
  expect(screen.getByTestId('save-seed-submit').textContent).toBe('Saving…')
}
const closeWhileSaving = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
  // No question is asked of a new-lot form: the sheet goes at once.
  expect(screen.queryByTestId('confirm-sheet')).toBeNull()
  expect(screen.getByTestId('host-page')).toBeTruthy()
  expect(onClose).toHaveBeenCalledTimes(1)
}

beforeEach(() => {
  navigateSpy.mockReset()
  toastSpy.mockReset()
  onClose.mockReset()
  onSaved.mockReset()
  onSavedAfterClose.mockReset()
  held = defer()
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (opts.method === 'POST' && String(url) === '/api/inventory-items') return held.promise
    return Promise.resolve({ id: 'evt-1' })
  })
  window.history.replaceState({ __base: 1 }, '')
})

describe('a new lot saved after the sheet was closed', () => {
  it('a host that leaves the ending to the sheet: "Seed lot saved" is said, the host hears, nothing navigates, nothing closes twice', async () => {
    await mount(false)
    await tapSave()
    await closeWhileSaving()
    expect(toastSpy).not.toHaveBeenCalled()

    await act(async () => { held.resolve(LOT) })
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1))
    expect(toastSpy).toHaveBeenCalledWith({ message: 'Seed lot saved', tone: 'success' })
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSavedAfterClose).toHaveBeenCalledTimes(1)
    expect(onSavedAfterClose.mock.calls[0][0]).toEqual(LOT)
    expect(screen.getByTestId('host-page')).toBeTruthy()
    expect(screen.queryByTestId('save-seed-submit')).toBeNull()
    // One lot asked for, once; its timeline entry written all the same.
    expect(posts('/api/inventory-items')).toHaveLength(1)
    expect(posts('/api/events')).toHaveLength(1)
  })

  it('a host that takes the ending over: it is told the sheet was closed, and nothing closes twice', async () => {
    await mount(true)
    await tapSave()
    await closeWhileSaving()

    await act(async () => { held.resolve(LOT) })
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1))
    expect(toastSpy).toHaveBeenCalledWith({ message: 'Seed lot saved', tone: 'success' })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSaved.mock.calls[0]).toEqual([LOT, { stageWritten: null, closed: true }])
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(posts('/api/inventory-items')).toHaveLength(1)
  })

  // The controls: a sheet that is still open ends as it always did.
  it('still open, sheet\'s own ending: it closes once and goes to the lot, and the closed-only callback is not used', async () => {
    await mount(false)
    await tapSave()
    await act(async () => { held.resolve(LOT) })
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledTimes(1))
    expect(navigateSpy.mock.calls[0]).toEqual(['/inventory/lot-1', { replace: true }])
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSavedAfterClose).not.toHaveBeenCalled()
    expect(toastSpy).toHaveBeenCalledWith({ message: 'Seed lot saved', tone: 'success' })
  })

  it('still open, host\'s ending: onSaved hears what it always heard, with no word of a close', async () => {
    await mount(true)
    await tapSave()
    await act(async () => { held.resolve(LOT) })
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(onSaved.mock.calls[0]).toEqual([LOT, { stageWritten: null }])
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(navigateSpy).not.toHaveBeenCalled()
  })
})

// What a save that FAILS after the close does today, pinned so that it is known: nothing at all.
describe('a new lot whose save fails after the sheet was closed', () => {
  for (const [what, err] of [['is refused', () => Object.assign(new Error('nope'), { status: 400 })], ['times out', timedOut]]) {
    it(`the create ${what}: nothing is said, nothing navigates, no host is called, nothing is sent again`, async () => {
      await mount(false)
      await tapSave()
      await closeWhileSaving()
      await act(async () => { held.reject(err()) })
      await act(async () => { await Promise.resolve() })
      expect(toastSpy).not.toHaveBeenCalled()
      expect(navigateSpy).not.toHaveBeenCalled()
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(onSavedAfterClose).not.toHaveBeenCalled()
      expect(screen.getByTestId('host-page')).toBeTruthy()
      expect(posts('/api/inventory-items')).toHaveLength(1)
      expect(posts('/api/events')).toHaveLength(0)
    })
  }
})
