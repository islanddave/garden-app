// micArbiter — V5-HARVESTVOICEFLOW-001 S1.
//
// These pin the arbiter's own contract. The regression that actually matters — that mounting
// several pickers does not disable any of them — cannot be tested here and lives in
// CaptureFlow.micArbiter.test.jsx, against the real surface, per C7.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { acquireMic, releaseMic, micHolder, isMicHeld, resetMicArbiter } from '../lib/micArbiter.js'

beforeEach(() => resetMicArbiter())

describe('micArbiter', () => {
  it('is unheld before anything acquires', () => {
    expect(isMicHeld()).toBe(false)
    expect(micHolder()).toBe(null)
  })

  it('a single acquire holds the mic and names its surface', () => {
    acquireMic('Picker', () => {})
    expect(isMicHeld()).toBe(true)
    expect(micHolder()).toBe('Picker')
  })

  it('a second acquire stops the first and takes the slot', () => {
    const stopA = vi.fn()
    const stopB = vi.fn()
    acquireMic('A', stopA)
    acquireMic('B', stopB)
    expect(stopA).toHaveBeenCalledTimes(1)
    expect(stopB).not.toHaveBeenCalled()
    expect(micHolder()).toBe('B')
  })

  it('the evicted owner is already displaced when its stop() runs', () => {
    // Order matters: the new holder must be installed BEFORE the eviction, so an evictee whose
    // stop() synchronously dispatches its own end cannot release the incoming owner's hold.
    let holderDuringEviction = 'not called'
    acquireMic('A', () => { holderDuringEviction = micHolder() })
    acquireMic('B', () => {})
    expect(holderDuringEviction).toBe('B')
  })

  it('a stale release is a no-op and reports false', () => {
    const tokenA = acquireMic('A', () => {})
    acquireMic('B', () => {})
    expect(releaseMic(tokenA)).toBe(false)
    expect(micHolder()).toBe('B')
  })

  it('a late release from an evicted owner cannot steal the mic', () => {
    // The real sequence: onend is a browser event, so it arrives AFTER the handover.
    let lateRelease
    const tokenA = acquireMic('A', () => { lateRelease = () => releaseMic(tokenA) })
    acquireMic('B', () => {})
    lateRelease()
    expect(isMicHeld()).toBe(true)
    expect(micHolder()).toBe('B')
  })

  it('the current holder releases successfully and leaves the mic free', () => {
    const token = acquireMic('A', () => {})
    expect(releaseMic(token)).toBe(true)
    expect(isMicHeld()).toBe(false)
  })

  it('releasing twice is harmless', () => {
    const token = acquireMic('A', () => {})
    expect(releaseMic(token)).toBe(true)
    expect(releaseMic(token)).toBe(false)
  })

  it('acquiring after a release does not stop the released owner again', () => {
    const stopA = vi.fn()
    const token = acquireMic('A', stopA)
    releaseMic(token)
    acquireMic('B', () => {})
    expect(stopA).not.toHaveBeenCalled()
  })

  it('an evictee that throws does not prevent the new owner from taking the mic', () => {
    acquireMic('A', () => { throw new Error('engine already dead') })
    expect(() => acquireMic('B', () => {})).not.toThrow()
    expect(micHolder()).toBe('B')
  })

  it('release(null) and release(undefined) are no-ops', () => {
    acquireMic('A', () => {})
    expect(releaseMic(null)).toBe(false)
    expect(releaseMic(undefined)).toBe(false)
    expect(micHolder()).toBe('A')
  })

  it('a missing stop function does not throw on eviction', () => {
    acquireMic('A', undefined)
    expect(() => acquireMic('B', () => {})).not.toThrow()
  })

  it('two owners sharing a label are still distinct — the label is not an identity', () => {
    // Three PlantingSelects mount with the same debugLabel. If the label were the identity, the
    // second one's release would free the third one's hold.
    const first  = acquireMic('Picker', () => {})
    acquireMic('Picker', () => {})
    expect(releaseMic(first)).toBe(false)
    expect(isMicHeld()).toBe(true)
  })

  it('evicts exactly once across a chain of handovers', () => {
    const stops = [vi.fn(), vi.fn(), vi.fn()]
    acquireMic('A', stops[0])
    acquireMic('B', stops[1])
    acquireMic('C', stops[2])
    expect(stops[0]).toHaveBeenCalledTimes(1)
    expect(stops[1]).toHaveBeenCalledTimes(1)
    expect(stops[2]).not.toHaveBeenCalled()
    expect(micHolder()).toBe('C')
  })
})
