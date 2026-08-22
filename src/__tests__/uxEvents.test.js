/**
 * src/__tests__/uxEvents.test.js
 * Inc 0 M1 telemetry client util.
 *
 * Covers:
 *   - FLOWS allowlist matches the Lambda's server-side set
 *   - getSessionId is stable within a session
 *   - sendUxEvent is a no-op (no fetch) when VITE_API_UX_EVENTS is unset
 *   - sendUxEvent POSTs the bearer token + payload when the endpoint IS configured
 *   - sendUxEvent NEVER rejects, even when fetch throws (telemetry must not affect UX)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FLOWS, getSessionId, sendUxEvent } from '../lib/uxEvents.js'

describe('uxEvents FLOWS + session', () => {
  it('declares the M1 flows + open_planting + the photo_upload diagnostic flow', () => {
    // V4-PHOTOUPLOADINSTR-001. The comment that stood here called open_planting a "documented
    // temporary double-signal" alongside reach_planting. It was neither temporary nor a signal: the
    // Lambda allowlist never learned it, so it wrote ZERO prod rows from 2026-06-03 to 2026-08-22
    // while PlantingDetail replaced ProjectDetail as the way in. This list passing was never
    // evidence the flow worked — it only ever described the client half.
    // lambda/ux-events/flowLockstep.test.js is what checks the halves against each other.
    expect(Object.values(FLOWS).sort()).toEqual(['create_project', 'log_watering', 'open_planting', 'photo_upload', 'reach_planting', 'voice_input'])
  })

  it('getSessionId is stable across calls', () => {
    const a = getSessionId()
    const b = getSessionId()
    expect(a).toBe(b)
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
  })
})

describe('sendUxEvent when endpoint is NOT configured (test env)', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('no-ops without calling fetch (VITE_API_UX_EVENTS unset in vitest env)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const getToken = vi.fn().mockResolvedValue('tok')
    await expect(sendUxEvent(getToken, { flowId: 'create_project', tapCount: 3 })).resolves.toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('sendUxEvent when endpoint IS configured', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('POSTs the token + payload to the configured base', async () => {
    vi.stubEnv('VITE_API_UX_EVENTS', 'https://ux.test/')
    vi.resetModules()
    const fresh = await import('../lib/uxEvents.js')
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)
    const getToken = vi.fn().mockResolvedValue('tok-123')

    await fresh.sendUxEvent(getToken, { flowId: 'log_watering', stepIndex: 1, tapCount: 2 })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://ux.test/api/ux-events')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer tok-123')
    expect(opts.keepalive).toBe(true)
    const body = JSON.parse(opts.body)
    expect(body.flow_id).toBe('log_watering')
    expect(body.tap_count).toBe(2)
    expect(body.session_id).toBeTruthy()
    vi.unstubAllEnvs()
  })

  it('swallows fetch errors and still resolves', async () => {
    vi.stubEnv('VITE_API_UX_EVENTS', 'https://ux.test/')
    vi.resetModules()
    const fresh = await import('../lib/uxEvents.js')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const getToken = vi.fn().mockResolvedValue('tok')
    await expect(fresh.sendUxEvent(getToken, { flowId: 'create_project' })).resolves.toBeUndefined()
    vi.unstubAllEnvs()
  })
})
