import { describe, it, expect, vi } from 'vitest'
import { registerServiceWorker } from '../lib/registerSW.js'

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
