import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  setReloadBlocked,
  isReloadBlocked,
  onReloadUnblocked,
  clearReloadBlocks,
} from '../lib/reloadGate.js'
import { registerServiceWorker } from '../lib/registerSW.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

// Same shape as registerSW.test.js's env: everything injectable, no real SW support needed.
function makeEnv({ hasController = true, visibilityState = 'visible' } = {}) {
  const registration = { update: vi.fn().mockResolvedValue(undefined) }
  const sw = new EventTarget()
  sw.controller = hasController ? {} : null
  sw.register = vi.fn().mockResolvedValue(registration)
  const nav = { serviceWorker: sw }
  const win = Object.assign(new EventTarget(), { location: { reload: vi.fn() } })
  const doc = Object.assign(new EventTarget(), { readyState: 'complete', visibilityState })
  return { registration, sw, nav, win, doc, reload: vi.fn() }
}

beforeEach(() => { clearReloadBlocks() })

describe('reloadGate primitive (OPS-SWRELOADGUARD-001)', () => {
  it('is unblocked with no holds', () => {
    expect(isReloadBlocked()).toBe(false)
  })

  it('holds and releases by key, notifying only on the last release', () => {
    const seen = vi.fn()
    const off = onReloadUnblocked(seen)
    setReloadBlocked('event-new', true)
    expect(isReloadBlocked()).toBe(true)
    setReloadBlocked('event-new', false)
    expect(isReloadBlocked()).toBe(false)
    expect(seen).toHaveBeenCalledTimes(1)
    off()
  })

  it('a second dirty surface cannot release the first surface hold', () => {
    const seen = vi.fn()
    const off = onReloadUnblocked(seen)
    setReloadBlocked('event-new', true)
    setReloadBlocked('put-up', true)
    setReloadBlocked('put-up', false)
    expect(isReloadBlocked()).toBe(true)
    expect(seen).not.toHaveBeenCalled()
    setReloadBlocked('event-new', false)
    expect(isReloadBlocked()).toBe(false)
    expect(seen).toHaveBeenCalledTimes(1)
    off()
  })

  it('releasing a key that was never held does not notify', () => {
    const seen = vi.fn()
    const off = onReloadUnblocked(seen)
    setReloadBlocked('never-held', false)
    expect(seen).not.toHaveBeenCalled()
    off()
  })

  it('unsubscribe stops further notifications', () => {
    const seen = vi.fn()
    const off = onReloadUnblocked(seen)
    off()
    setReloadBlocked('event-new', true)
    setReloadBlocked('event-new', false)
    expect(seen).not.toHaveBeenCalled()
  })

  it('a throwing listener does not stop the others', () => {
    const seen = vi.fn()
    const offA = onReloadUnblocked(() => { throw new Error('boom') })
    const offB = onReloadUnblocked(seen)
    setReloadBlocked('event-new', true)
    expect(() => setReloadBlocked('event-new', false)).not.toThrow()
    expect(seen).toHaveBeenCalledTimes(1)
    offA(); offB()
  })

  it('clearReloadBlocks drops holds WITHOUT notifying (test/teardown reset)', () => {
    const seen = vi.fn()
    const off = onReloadUnblocked(seen)
    setReloadBlocked('event-new', true)
    clearReloadBlocks()
    expect(isReloadBlocked()).toBe(false)
    expect(seen).not.toHaveBeenCalled()
    off()
  })

  it('ignores a falsy key rather than holding forever under an unreleasable id', () => {
    setReloadBlocked('', true)
    setReloadBlocked(undefined, true)
    expect(isReloadBlocked()).toBe(false)
  })
})

describe('registerServiceWorker reload gating (OPS-SWRELOADGUARD-001)', () => {
  it('reloads immediately on controllerchange when no form is dirty', async () => {
    const env = makeEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('DEFERS the reload while a form is dirty', async () => {
    const env = makeEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    setReloadBlocked('event-new', true)
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()
    teardown()
  })

  it('applies the deferred reload the moment the dirty flag clears', async () => {
    const env = makeEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    setReloadBlocked('event-new', true)
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()
    setReloadBlocked('event-new', false)
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('stays deferred while ANY surface is still dirty', async () => {
    const env = makeEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    setReloadBlocked('event-new', true)
    setReloadBlocked('put-up', true)
    env.sw.dispatchEvent(new Event('controllerchange'))
    setReloadBlocked('put-up', false)
    expect(env.reload).not.toHaveBeenCalled()
    setReloadBlocked('event-new', false)
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('reloads only once even if the gate cycles again afterwards', async () => {
    const env = makeEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    setReloadBlocked('event-new', true)
    env.sw.dispatchEvent(new Event('controllerchange'))
    setReloadBlocked('event-new', false)
    setReloadBlocked('event-new', true)
    setReloadBlocked('event-new', false)
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('takes the second chance on resume when the gate cleared with no notification', async () => {
    const env = makeEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    setReloadBlocked('event-new', true)
    env.sw.dispatchEvent(new Event('controllerchange'))
    clearReloadBlocks() // cleared silently, as a bundle swap or an unmount race can
    env.doc.dispatchEvent(new Event('visibilitychange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('resume does NOT reload while the form is still dirty', async () => {
    const env = makeEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    setReloadBlocked('event-new', true)
    env.sw.dispatchEvent(new Event('controllerchange'))
    env.doc.dispatchEvent(new Event('visibilitychange'))
    env.win.dispatchEvent(new Event('pageshow'))
    expect(env.reload).not.toHaveBeenCalled()
    teardown()
  })

  it('still checks for updates on resume while deferred — defer must not disarm the self-heal', async () => {
    const env = makeEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    setReloadBlocked('event-new', true)
    env.sw.dispatchEvent(new Event('controllerchange'))
    env.doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(env.registration.update).toHaveBeenCalled()
    teardown()
  })

  it('teardown unsubscribes from the gate — a later release cannot reload a dead registration', async () => {
    const env = makeEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    setReloadBlocked('event-new', true)
    env.sw.dispatchEvent(new Event('controllerchange'))
    teardown()
    setReloadBlocked('event-new', false)
    expect(env.reload).not.toHaveBeenCalled()
  })

  it('a dirty form does not resurrect the first-install no-reload guard', async () => {
    const env = makeEnv({ hasController: false })
    const teardown = registerServiceWorker(env)
    await flush()
    setReloadBlocked('event-new', true)
    env.sw.dispatchEvent(new Event('controllerchange'))
    setReloadBlocked('event-new', false)
    expect(env.reload).not.toHaveBeenCalled()
    teardown()
  })
})
