// Put-Up R2a, lane I (the integrator; render review, mobile I-1) — the door hands the page's reload hold to the
// saved line with NO GAP.
//
// THE DEFECT. A deploy reaches the phone while the door is dirty: the reload is deferred behind the door's hold.
// He taps Save. In ONE commit the door unmounts and the completion line mounts. React runs every passive
// cleanup before any passive mount, so the door let go first, the gate was empty for a moment, registerSW's
// deferred reload fired, and the page reloaded: the row was saved and listed, with no line, no Undo and no
// "How it was made →". The line took its hold in a passive effect. It now takes it in a layout effect, which
// runs in the commit itself — before the door's passive cleanup — so the gate is never empty in between.
//
// EVERYTHING HERE IS REAL: the real door, the real CompletionLine, the real lib/reloadGate.js and the real
// lib/registerSW.js, on BOTH hosts that draw the line — the Pantry page and the planting page's section.
// The control is the order lane P already pinned: a deploy that lands AFTER the line shows is held too, and
// fires once the line goes.
// MUTATION: the line's hold back in useEffect -> "a deploy while the door is dirty, then Save" reds on both hosts.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({ useCropTypes: () => ({ cropTypes: [], loading: false }) }))
vi.mock('../context/AuthContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useAuthOptional: () => ({ user: { id: 'user_dave' }, profile: null, loading: false, identity: 'signed-in' }),
}))
vi.mock('../components/PutUpPhotoThumb.jsx', () => ({ default: () => null }))

import PutUp from '../pages/PutUp.jsx'
import PlantingKitchen from '../components/planting/PlantingKitchen.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { registerServiceWorker } from '../lib/registerSW.js'

const NOW = new Date(2026, 9, 1, 14, 0)
const PLANTING = { id: 'pl-1', name: 'Sungold cherry', variety_id: 'var-sg', variety_ref: { id: 'var-sg', name: 'Sungold', crop_type_slug: 'tomato' } }

const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)) })
const flush = () => new Promise((r) => setTimeout(r, 0))
const line = () => screen.queryByTestId('pantry-completion')
const tap = (id) => fireEvent.click(screen.getByTestId(id))

// registerSW.test.js's env, with a prior controller: a controllerchange is an UPDATE (the reload path).
function makeSwEnv() {
  const registration = { update: vi.fn().mockResolvedValue(undefined) }
  const sw = new EventTarget()
  sw.controller = {}
  sw.register = vi.fn().mockResolvedValue(registration)
  const win = Object.assign(new EventTarget(), { location: { reload: vi.fn() } })
  const doc = Object.assign(new EventTarget(), { readyState: 'complete', visibilityState: 'visible' })
  return { nav: { serviceWorker: sw }, sw, win, doc, reload: vi.fn() }
}
const deploy = (env) => act(() => { env.sw.dispatchEvent(new Event('controllerchange')) })

// The planting page's two reads, answered from what was saved (the section re-reads after a save).
function plantingWorld() {
  const jars = []
  const plantOf = (path) => new URL(path, 'http://x').searchParams.get('plant_id')
  const fake = pantryFetch({ overrides: {
    'GET /api/preservation/whats-put-up': ({ path }) => {
      const mine = jars.filter(j => String(j.plant_id) === plantOf(path))
      return { group_by: 'storage', groups: PLACES.map(p => ({ group_key: p.id, label: p.label, records: mine.filter(j => j.storage_location_id === p.id) }))
        .filter(g => g.records.length) }
    },
    'GET /api/kitchen-batches': ({ path }) => ({ plant_id: plantOf(path), batches: [], kept_fresh: [] }),
  } })
  const fn = async (path, options = {}) => {
    const r = await fake(path, options)
    if ((options.method || 'GET') === 'POST' && path === '/api/preservation') {
      jars.push({ id: r.id, plant_id: r.plant_id ?? null, label: r.label, method: r.method, storage_location_id: r.storage_location_id,
        package_count: r.package_count, remaining_count: r.package_count, preserved_at: r.preserved_at, use_by_target: r.use_by_target,
        use_by_basis: r.use_by_basis, storage_kind: PLACES.find(p => p.id === r.storage_location_id)?.kind ?? null })
    }
    return r
  }
  fn.calls = fake.calls
  return fn
}

// Each host, to the point where its door is open. The Pantry's door opens empty and is given a name; the
// planting's opens on its planting. Neither is dirty yet on the planting host: the place and the method are.
const HOSTS = [
  ['the Pantry page', async () => {
    stableFetch.fn = pantryFetch()
    render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
    await screen.findByTestId('pantry-view')
    fireEvent.click(screen.getAllByTestId('putup-door')[0])
    await screen.findByTestId('door-place-id:loc-1')
    await settle()
    fireEvent.change(screen.getByTestId('door-what-name'), { target: { value: 'Sungold cherry' } })
  }],
  ['the planting page', async () => {
    const world = plantingWorld()
    stableFetch.fn = world
    render(<MemoryRouter initialEntries={['/planting']}><PlantingKitchen planting={PLANTING} fetch={world} now={NOW} /></MemoryRouter>)
    fireEvent.click(await screen.findByTestId('putup-from-planting-door'))
    await screen.findByTestId('door-place-id:loc-1')
    await settle()
  }],
]
// The door's other two answers: it is dirty from here, and holds the reload.
async function answer() {
  tap('door-place-id:loc-1'); tap('door-method-whole_freeze')
  await waitFor(() => expect(isReloadBlocked()).toBe(true))
}
// Save: the host closes the door and draws the line, in one commit.
async function save() {
  tap('door-save')
  await waitFor(() => expect(screen.queryByTestId('door-sheet')).toBeNull())
  await settle()
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); clearReloadBlocks()
  window.scrollTo = vi.fn()
})
afterEach(() => { cleanup(); clearReloadBlocks() })

describe.each(HOSTS)('the door hands the reload hold to the saved line — %s', (_host, openDoor) => {
  it('a deploy while the door is dirty, then Save: the line shows with its Undo and the page has not reloaded', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    await openDoor()
    await answer()
    deploy(env)                                                              // a new service worker takes the page mid-entry
    expect(env.reload).not.toHaveBeenCalled()                                // deferred behind the door's hold
    await save()
    expect(env.reload).not.toHaveBeenCalled()                                // …and handed to the line, with no gap
    expect(line()).toBeTruthy()
    expect(line().textContent).toContain('Sungold cherry — put up')
    expect(screen.getByTestId('pantry-completion-undo')).toBeTruthy()
    expect(isReloadBlocked()).toBe(true)
    // The deferred reload was held, not lost: it fires once the line goes.
    tap('pantry-completion-close')
    await waitFor(() => expect(env.reload).toHaveBeenCalledTimes(1))
    expect(line()).toBeNull()
    teardown()
  })

  it('the control — a deploy after the line shows is held, and fires once the line goes', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    await openDoor()
    await answer()
    await save()
    expect(line()).toBeTruthy()
    deploy(env)
    expect(env.reload).not.toHaveBeenCalled()
    tap('pantry-completion-close')
    await waitFor(() => expect(env.reload).toHaveBeenCalledTimes(1))
    teardown()
  })
})
