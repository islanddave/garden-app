// BUG-STALECLIENT-001 — useAppUpdate: waiting-SW event + stale-shell probe -> one update signal.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { useAppUpdate, VERSION_PROBE_MIN_INTERVAL_MS } from '../hooks/useAppUpdate.js'
import { UPDATE_WAITING_EVENT } from '../lib/registerSW.js'

function Probe({ opts, onApi }) {
  const api = useAppUpdate(opts)
  onApi(api)
  return <span data-testid="state">{api.update ? (api.update.version || 'ready') : 'idle'}</span>
}

const okJson = (data) => Promise.resolve({ ok: true, json: () => Promise.resolve(data) })

describe('useAppUpdate (BUG-STALECLIENT-001)', () => {
  it('signals an update when releases-latest.json is newer than the baked version', async () => {
    const fetchFn = vi.fn(() => okJson({ version: '9.9.9' }))
    let api
    render(<Probe opts={{ fetchFn, appVersion: '1.0.0' }} onApi={(a) => { api = a }} />)
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('9.9.9'))
    // V4-PERFTHEMEA-001: the probe reads the ~1.7 KB single-entry file, NOT the 141 KB history —
    // and still no-store, because a cacheable version probe is BUG-STALECLIENT-002 rebuilt.
    expect(fetchFn).toHaveBeenCalledWith('/releases-latest.json', expect.objectContaining({ cache: 'no-store' }))
    expect(fetchFn).not.toHaveBeenCalledWith('/releases.json', expect.anything())
  })

  it('stays idle when the running version IS the newest', async () => {
    const fetchFn = vi.fn(() => okJson({ version: '1.0.0' }))
    render(<Probe opts={{ fetchFn, appVersion: '1.0.0' }} onApi={() => {}} />)
    await act(() => Promise.resolve())
    await act(() => Promise.resolve())
    expect(screen.getByTestId('state').textContent).toBe('idle')
  })

  it('ignores an ARRAY body — that shape means the two release files got crossed', async () => {
    // Reading d[0].version out of a stray releases.json served at this path would "work" and hide
    // the mix-up. The probe must refuse it so CI's file-equality check is the thing that speaks.
    const fetchFn = vi.fn(() => okJson([{ version: '9.9.9' }]))
    render(<Probe opts={{ fetchFn, appVersion: '1.0.0' }} onApi={() => {}} />)
    await act(() => Promise.resolve())
    await act(() => Promise.resolve())
    expect(screen.getByTestId('state').textContent).toBe('idle')
  })

  it('re-probes on visibilitychange, so a resumed tab still learns about an update', async () => {
    // The resume probe is why payload size matters twice: this fires on every foreground past the
    // 60s throttle, not just at boot. Keeping it is deliberate — it is the stale-shell backstop
    // for a client whose SW update fetch failed silently.
    const fetchFn = vi.fn(() => okJson({ version: '1.0.0' }))
    render(<Probe opts={{ fetchFn, appVersion: '1.0.0' }} onApi={() => {}} />)
    await act(() => Promise.resolve())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // Reach past the 60s throttle: it is wall-clock, so move the clock rather than wait.
    const realNow = Date.now
    Date.now = () => realNow() + VERSION_PROBE_MIN_INTERVAL_MS + 1
    try {
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      await act(() => Promise.resolve())
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(fetchFn).toHaveBeenLastCalledWith('/releases-latest.json', expect.objectContaining({ cache: 'no-store' }))
    } finally {
      Date.now = realNow
    }
  })

  it('stays idle (and does not throw) when the probe fails — offline/hung CDN', async () => {
    const fetchFn = vi.fn(() => Promise.reject(new Error('network dead')))
    render(<Probe opts={{ fetchFn, appVersion: '1.0.0' }} onApi={() => {}} />)
    await act(() => Promise.resolve())
    await act(() => Promise.resolve())
    expect(screen.getByTestId('state').textContent).toBe('idle')
  })

  it('signals on the waiting-SW event and apply() invokes the event apply', async () => {
    const fetchFn = vi.fn(() => okJson(null))
    const swApply = vi.fn()
    let api
    render(<Probe opts={{ fetchFn, appVersion: '1.0.0', reload: vi.fn() }} onApi={(a) => { api = a }} />)
    await act(() => Promise.resolve())
    act(() => {
      window.dispatchEvent(new CustomEvent(UPDATE_WAITING_EVENT, { detail: { apply: swApply } }))
    })
    expect(screen.getByTestId('state').textContent).toBe('ready')
    act(() => { api.apply() })
    expect(swApply).toHaveBeenCalledTimes(1)
  })

  it('apply() falls back to reload when no waiting-SW apply exists (stale shell case)', async () => {
    const fetchFn = vi.fn(() => okJson({ version: '9.9.9' }))
    const reload = vi.fn()
    let api
    render(<Probe opts={{ fetchFn, appVersion: '1.0.0', reload }} onApi={(a) => { api = a }} />)
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('9.9.9'))
    act(() => { api.apply() })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
