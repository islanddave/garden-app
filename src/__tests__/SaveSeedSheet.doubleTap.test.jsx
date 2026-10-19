// BUG-SEEDSTAGEDOUBLETAP-001 — one Save of the sheet is one save: one create, one stage POST.
//
// `if (busy) return` reads React state, so two clicks dispatched before the sheet re-renders both
// pass it with the old closure. The second would create again under the draft's key and, when a
// process is chosen, append a second entry to seed_lot_stage_log, which has no DELETE route. The ref
// set before the first await stops it; both clicks below land in ONE act, so nothing renders between
// them, and these cases red without the ref.
//
// A save from ANOTHER sheet of the same draft is a different case, answered by seedLotKey.js and
// SaveSeedSheet.createKey.test.jsx; this is one sheet, tapped twice.
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
const posts = (path) => fetchSpy.mock.calls.filter(([p, o]) => o?.method === 'POST' && String(p) === path)

let held
const onSaved = vi.fn()
const mount = async () => {
  await act(async () => render(
    <DismissRegistryProvider><SaveSeedSheet planting={PLANTING} onClose={() => {}} onSaved={onSaved} /></DismissRegistryProvider>,
  ))
  await act(async () => { await Promise.resolve() })
}
const doubleTap = async () => {
  await act(async () => {
    const save = screen.getByTestId('save-seed-submit')
    fireEvent.click(save)
    fireEvent.click(save)
  })
}

beforeEach(() => {
  navigateSpy.mockReset()
  toastSpy.mockReset()
  onSaved.mockReset()
  held = defer()
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (opts.method === 'POST' && String(url) === '/api/inventory-items') return held.promise
    return Promise.resolve({ id: 'evt-1' })
  })
  window.history.replaceState({ __base: 1 }, '')
})

describe('SaveSeedSheet — two clicks before a render are one save (BUG-SEEDSTAGEDOUBLETAP-001)', () => {
  it('with a process chosen: one create, then ONE stage POST', async () => {
    await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-process-dry')) })
    await doubleTap()
    expect(posts('/api/inventory-items')).toHaveLength(1)

    await act(async () => { held.resolve(LOT) })
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(posts('/api/inventory-items')).toHaveLength(1)
    expect(posts('/api/inventory-items/lot-1/seed-stage')).toHaveLength(1)
    expect(JSON.parse(posts('/api/inventory-items/lot-1/seed-stage')[0][1].body)).toEqual({ stage: 'drying', seed_process: 'dry' })
  })

  it('the guard lets go when the save ends: Save after a failed create is sent', async () => {
    await mount()
    await doubleTap()
    expect(posts('/api/inventory-items')).toHaveLength(1)
    await act(async () => { held.reject(Object.assign(new Error('Request timed out'), { status: 0, timeout: true })) })
    await waitFor(() => expect(screen.getByTestId('save-seed-submit').textContent).not.toBe('Saving…'))

    held = defer()
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })
    expect(posts('/api/inventory-items')).toHaveLength(2)
  })
})
