import { describe, it, expect, vi } from 'vitest'
import { onReconnect, isOnline } from '../lib/reconnect.js'

describe('reconnect (Inc 2 Bite 4)', () => {
  it('onReconnect: fires callback on window.online event', () => {
    const cb = vi.fn()
    const unsub = onReconnect(cb)
    window.dispatchEvent(new Event('online'))
    expect(cb).toHaveBeenCalledTimes(1)
    unsub()
    window.dispatchEvent(new Event('online'))
    expect(cb).toHaveBeenCalledTimes(1)        // not called after unsub
  })

  it('onReconnect: returns no-op when callback missing/invalid', () => {
    const unsub = onReconnect(null)
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('onReconnect: swallows callback exceptions so the event loop is not poisoned', () => {
    const unsub = onReconnect(() => { throw new Error('boom') })
    expect(() => window.dispatchEvent(new Event('online'))).not.toThrow()
    unsub()
  })

  it('isOnline: returns navigator.onLine when present', () => {
    expect(typeof isOnline()).toBe('boolean')
  })
})
