import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerServiceWorker, UPDATE_WAITING_EVENT } from '../lib/registerSW.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

function makeEnv({ hasController = false, readyState = 'complete', visibilityState = 'visible' } = {}) {
  const registration = { update: vi.fn().mockResolvedValue(undefined) }
  const sw = new EventTarget()
  sw.controller = hasController ? {} : null
  sw.register = vi.fn().mockResolvedValue(registration)
  const nav = { serviceWorker: sw }
  const win = Object.assign(new EventTarget(), { location: { reload: vi.fn() } })
  const doc = Object.assign(new EventTarget(), { readyState, visibilityState })
  const reload = vi.fn()
  return { registration, sw, nav, win, doc, reload }
}

describe('registerServiceWorker (V3-CACHE-001 self-heal)', () => {
  it('no-ops and returns a teardown fn when serviceWorker is unsupported', () => {
    const teardown = registerServiceWorker({ nav: {}, win: new EventTarget(), doc: new EventTarget() })
    expect(typeof teardown).toBe('function')
    expect(() => teardown()).not.toThrow()
  })

  it('registers /sw.js when the document is already loaded', async () => {
    const env = makeEnv({ readyState: 'complete' })
    registerServiceWorker(env)
    await flush()
    expect(env.sw.register).toHaveBeenCalledWith('/sw.js')
  })

  it('registers on window load when the document is not yet complete', async () => {
    const env = makeEnv({ readyState: 'loading' })
    registerServiceWorker(env)
    await flush()
    expect(env.sw.register).not.toHaveBeenCalled()
    env.win.dispatchEvent(new Event('load'))
    await flush()
    expect(env.sw.register).toHaveBeenCalledWith('/sw.js')
  })

  it('does NOT reload on first install (no prior controller)', async () => {
    const env = makeEnv({ hasController: false })
    registerServiceWorker(env)
    await flush()
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()
  })

  it('reloads exactly once when a new SW takes control of an already-controlled page', async () => {
    const env = makeEnv({ hasController: true })
    registerServiceWorker(env)
    await flush()
    env.sw.dispatchEvent(new Event('controllerchange'))
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
  })

  it('calls registration.update() on visibilitychange when visible', async () => {
    const env = makeEnv({ visibilityState: 'visible' })
    registerServiceWorker(env)
    await flush()
    env.doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(env.registration.update).toHaveBeenCalled()
  })

  it('does NOT call update() on visibilitychange when hidden', async () => {
    const env = makeEnv({ visibilityState: 'hidden' })
    registerServiceWorker(env)
    await flush()
    env.doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(env.registration.update).not.toHaveBeenCalled()
  })

  it('calls registration.update() on pageshow (bfcache restore)', async () => {
    const env = makeEnv({ visibilityState: 'visible' })
    registerServiceWorker(env)
    await flush()
    env.win.dispatchEvent(new Event('pageshow'))
    await flush()
    expect(env.registration.update).toHaveBeenCalled()
  })

  it('teardown removes listeners so later events are inert', async () => {
    const env = makeEnv({ hasController: true })
    const teardown = registerServiceWorker(env)
    await flush()
    teardown()
    env.sw.dispatchEvent(new Event('controllerchange'))
    env.doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(env.reload).not.toHaveBeenCalled()
    expect(env.registration.update).not.toHaveBeenCalled()
  })

  it('swallows a rejecting registration.update() without throwing', async () => {
    const env = makeEnv({ visibilityState: 'visible' })
    env.registration.update = vi.fn().mockRejectedValue(new Error('boom'))
    registerServiceWorker(env)
    await flush()
    expect(() => env.doc.dispatchEvent(new Event('visibilitychange'))).not.toThrow()
    await flush()
    expect(env.registration.update).toHaveBeenCalled()
  })
})

// BUG-STALECLIENT-001 — waiting-SW announcement + forced activation path.
describe('registerServiceWorker waiting-SW announcement (BUG-STALECLIENT-001)', () => {
  function makeUpdateEnv({ hasController = true, waiting = null } = {}) {
    const registration = Object.assign(new EventTarget(), {
      update: vi.fn().mockResolvedValue(undefined),
      waiting,
      installing: null,
    })
    const sw = new EventTarget()
    sw.controller = hasController ? {} : null
    sw.register = vi.fn().mockResolvedValue(registration)
    const nav = { serviceWorker: sw }
    const win = Object.assign(new EventTarget(), { location: { reload: vi.fn() } })
    const doc = Object.assign(new EventTarget(), { readyState: 'complete', visibilityState: 'visible' })
    return { registration, sw, nav, win, doc, reload: vi.fn() }
  }

  it('announces a waiting SW already parked at registration time (page controlled)', async () => {
    const waiting = { postMessage: vi.fn() }
    const env = makeUpdateEnv({ hasController: true, waiting })
    const events = []
    env.win.addEventListener(UPDATE_WAITING_EVENT, (e) => events.push(e))
    registerServiceWorker(env)
    await flush()
    expect(events.length).toBe(1)
    expect(typeof events[0].detail.apply).toBe('function')
    events[0].detail.apply()
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('does NOT announce on first install (no controller)', async () => {
    const env = makeUpdateEnv({ hasController: false, waiting: { postMessage: vi.fn() } })
    const events = []
    env.win.addEventListener(UPDATE_WAITING_EVENT, (e) => events.push(e))
    registerServiceWorker(env)
    await flush()
    expect(events.length).toBe(0)
  })

  it('announces when an update installs while the page is open (updatefound -> installed)', async () => {
    const env = makeUpdateEnv({ hasController: true, waiting: null })
    const events = []
    env.win.addEventListener(UPDATE_WAITING_EVENT, (e) => events.push(e))
    registerServiceWorker(env)
    await flush()
    const installing = Object.assign(new EventTarget(), { state: 'installing', postMessage: vi.fn() })
    env.registration.installing = installing
    env.registration.dispatchEvent(new Event('updatefound'))
    installing.state = 'installed'
    env.registration.waiting = installing
    installing.dispatchEvent(new Event('statechange'))
    expect(events.length).toBe(1)
    events[0].detail.apply()
    expect(installing.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('apply() is a safe no-op if the waiting worker is gone by the time it runs', async () => {
    const waiting = { postMessage: vi.fn() }
    const env = makeUpdateEnv({ hasController: true, waiting })
    const events = []
    env.win.addEventListener(UPDATE_WAITING_EVENT, (e) => events.push(e))
    registerServiceWorker(env)
    await flush()
    env.registration.waiting = null
    expect(() => events[0].detail.apply()).not.toThrow()
    expect(waiting.postMessage).not.toHaveBeenCalled()
  })
})

// Page <-> SW contract: the page posts SKIP_WAITING; the SW must actually listen for it.
describe('public/sw.js SKIP_WAITING contract', () => {
  const SRC = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8')
  it('sw.js has a message listener that calls skipWaiting on SKIP_WAITING', () => {
    expect(SRC).toMatch(/addEventListener\('message'/)
    expect(SRC).toMatch(/type === 'SKIP_WAITING'\) self\.skipWaiting\(\)/)
  })
})
