// BUG-PUTUPREPLAYDROPSEDIT-001: How it was made, start changed to "Today", answer lost, Save again untouched.
// Written 2026-10-08 as a check of lane-putupreplay2-20261007 (tip 221d89ef): green there, red when the print
// is taken of the date "Today" came to (a mutation the branch's own 72 tests for this sheet let through).
// Runs as it stands from src/__tests__/. The server stand-in is the route's rule: the key that landed replays
// the batch the first Save made; any OTHER key meets jars that already have a batch and is refused 409.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }), apiFetch: (...a) => fetchSpy(...a) }))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth, useAuth: () => auth }))

import HowItWasMadeSheet from '../components/putup/HowItWasMadeSheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const PATH = '/api/kitchen-batches/from-jars'
const LOST = () => { throw new TypeError('Failed to fetch') }
const apiError = (status, body) => Object.assign(new Error(body?.error ?? `HTTP ${status}`), { status, body })
const JAR = {
  id: 'j-1', label: 'Megatron plain', batch_id: null, harvest_log_id: null, storage_location_id: 'loc-fridge',
  preserved_at: '2026-09-08', preserved_at_precision: 'day', package_count: 2, remaining_count: 2, stock_mode: 'counted', notes: '',
}
const now0 = Date.now()
const FIRST = {
  id: 'kb-first', label: 'Megatron plain', kind: null, kind_other: null, inputs: [], stages: [{ id: 's1', stage_kind: 'started' }],
  created_at: new Date(now0 - 30000).toISOString(), updated_at: new Date(now0 - 30000).toISOString(),
}

const posts = () => fetchSpy.mock.calls.filter(([p, o]) => p === PATH && o?.method === 'POST').map(([, o]) => JSON.parse(o.body))
const otherWrites = () => fetchSpy.mock.calls.filter(([p, o]) => o?.method && o.method !== 'GET' && !(p === PATH && o.method === 'POST')).map(([p, o]) => [o.method, p])
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const save = () => act(async () => { tap('how-submit') })
const failed = () => waitFor(() => expect(screen.getByTestId('how-error').textContent.length).toBeGreaterThan(0))
const loaded = () => waitFor(() => expect(screen.getByTestId('how-made')).toBeTruthy())
const pause = (ms) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

// The route as it behaves: first POST lands with its answer lost; after that the key that landed replays,
// and any other key meets jars that already have a batch.
function wireServer() {
  let landedKey = null
  fetchSpy.mockImplementation((path, o = {}) => {
    const method = (o.method ?? 'GET').toUpperCase()
    if (method === 'GET' && path === '/api/preservation/whats-put-up') return Promise.resolve({ groups: [{ label: 'Fridge', records: [JAR] }] })
    if (method === 'POST' && path === PATH) {
      const body = JSON.parse(o.body)
      if (landedKey == null) { landedKey = body.idempotency_key; try { LOST() } catch (e) { return Promise.reject(e) } }
      if (body.idempotency_key === landedKey) return Promise.resolve({ ...FIRST, replayed: true })
      return Promise.reject(apiError(409, { error: 'jar_has_batch' }))
    }
    return Promise.resolve(null)
  })
}

beforeEach(() => { fetchSpy.mockReset(); localStorage.clear(); clearReloadBlocks() })
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('How it was made, start = Today, untouched retry after a lost answer', () => {
  const mount = () => {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn() }
    render(<DismissRegistryProvider><HowItWasMadeSheet jar={JAR} open {...handlers} /></DismissRegistryProvider>)
    return handlers
  }

  it('Change → Today → answer lost → Save: the SAME key, saved and closed, no 409, nothing else written', async () => {
    wireServer()
    const { onClose, onSaved } = mount()
    await loaded()
    tap('how-start-change'); tap('how-when-today')
    await save(); await failed()
    await pause(25)
    await save()
    await waitFor(() => expect(posts()).toHaveLength(2))
    const [a, b] = posts()
    // The instrument: the two bodies really do carry different instants (the trap's precondition).
    expect(a.started.precision).toBe('exact')
    expect(b.started.date).not.toBe(a.started.date)
    // The question.
    expect(b.idempotency_key).toBe(a.idempotency_key)
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...FIRST, replayed: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('how-error')).toBeNull()
    expect(otherWrites()).toEqual([])
  })

  it('… and a third and fourth lost-then-retried Save under Today still go out under that one key', async () => {
    let n = 0
    let landedKey = null
    fetchSpy.mockImplementation((path, o = {}) => {
      const method = (o.method ?? 'GET').toUpperCase()
      if (method === 'GET' && path === '/api/preservation/whats-put-up') return Promise.resolve({ groups: [{ label: 'Fridge', records: [JAR] }] })
      if (method === 'POST' && path === PATH) {
        const body = JSON.parse(o.body)
        n += 1
        if (landedKey == null) landedKey = body.idempotency_key
        if (n <= 3) { try { LOST() } catch (e) { return Promise.reject(e) } }
        if (body.idempotency_key === landedKey) return Promise.resolve({ ...FIRST, replayed: true })
        return Promise.reject(apiError(409, { error: 'jar_has_batch' }))
      }
      return Promise.resolve(null)
    })
    const { onClose } = mount()
    await loaded()
    tap('how-start-change'); tap('how-when-today')
    for (let i = 0; i < 3; i++) { await save(); await failed(); await pause(10) }
    await save()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(new Set(posts().map(p => p.idempotency_key)).size).toBe(1)
    expect(new Set(posts().map(p => p.started.date)).size).toBe(4)
    expect(otherWrites()).toEqual([])
  })
})
