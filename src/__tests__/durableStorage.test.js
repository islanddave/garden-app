import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { requestPersistence, isPersistent, getQuotaEstimate } from '../lib/durableStorage.js'

const realNavigator = globalThis.navigator

function withNavigator(nav, fn) {
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true })
  return fn().finally(() => {
    Object.defineProperty(globalThis, 'navigator', { value: realNavigator, configurable: true })
  })
}

describe('durableStorage (Inc 2 Bite 4)', () => {
  it('isPersistent: reports unsupported when navigator.storage missing', async () => {
    await withNavigator({}, async () => {
      const r = await isPersistent()
      expect(r.supported).toBe(false)
    })
  })

  it('isPersistent: reports persistent boolean when API available', async () => {
    await withNavigator({
      storage: { persisted: () => Promise.resolve(true) },
    }, async () => {
      const r = await isPersistent()
      expect(r.supported).toBe(true)
      expect(r.persistent).toBe(true)
    })
    await withNavigator({
      storage: { persisted: () => Promise.resolve(false) },
    }, async () => {
      const r = await isPersistent()
      expect(r.supported).toBe(true)
      expect(r.persistent).toBe(false)
    })
  })

  it('requestPersistence: short-circuits when already persistent', async () => {
    const persistSpy = vi.fn(() => Promise.resolve(false))
    await withNavigator({
      storage: { persisted: () => Promise.resolve(true), persist: persistSpy },
    }, async () => {
      const r = await requestPersistence()
      expect(r.supported).toBe(true)
      expect(r.granted).toBe(true)
      expect(persistSpy).not.toHaveBeenCalled()
    })
  })

  it('requestPersistence: calls persist() when not currently persistent', async () => {
    const persistSpy = vi.fn(() => Promise.resolve(true))
    await withNavigator({
      storage: { persisted: () => Promise.resolve(false), persist: persistSpy },
    }, async () => {
      const r = await requestPersistence()
      expect(r.supported).toBe(true)
      expect(r.granted).toBe(true)
      expect(persistSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('requestPersistence: returns granted=false when persist() rejects', async () => {
    await withNavigator({
      storage: { persisted: () => Promise.resolve(false), persist: () => Promise.reject(new Error('x')) },
    }, async () => {
      const r = await requestPersistence()
      expect(r.supported).toBe(true)
      expect(r.granted).toBe(false)
    })
  })

  it('requestPersistence: returns supported=false when API missing', async () => {
    await withNavigator({}, async () => {
      const r = await requestPersistence()
      expect(r.supported).toBe(false)
    })
  })

  it('getQuotaEstimate: returns supported=false when API missing', async () => {
    await withNavigator({}, async () => {
      const r = await getQuotaEstimate()
      expect(r.supported).toBe(false)
    })
  })

  it('getQuotaEstimate: returns usage/quota numbers when available', async () => {
    await withNavigator({
      storage: { estimate: () => Promise.resolve({ usage: 12345, quota: 100000000 }) },
    }, async () => {
      const r = await getQuotaEstimate()
      expect(r.supported).toBe(true)
      expect(r.usage).toBe(12345)
      expect(r.quota).toBe(100000000)
    })
  })
})
