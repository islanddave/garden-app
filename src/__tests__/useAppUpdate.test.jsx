// BUG-STALECLIENT-001 — useAppUpdate: waiting-SW event + stale-shell probe -> one update signal.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { useAppUpdate } from '../hooks/useAppUpdate.js'
import { UPDATE_WAITING_EVENT } from '../lib/registerSW.js'

function Probe({ opts, onApi }) {
  const api = useAppUpdate(opts)
  onApi(api)
  return <span data-testid="state">{api.update ? (api.update.version || 'ready') : 'idle'}</span>
}

const okJson = (data) => Promise.resolve({ ok: true, json: () => Promise.resolve(data) })

describe('useAppUpdate (BUG-STALECLIENT-001)', () => {
  it('signals an update when releases.json is newer than the baked version', async () => {
    const fetchFn = vi.fn(() => okJson([{ version: '9.9.9' }]))
    let api
    render(<Probe opts={{ fetchFn, appVersion: '1.0.0' }} onApi={(a) => { api = a }} />)
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('9.9.9'))
    expect(fetchFn).toHaveBeenCalledWith('/releases.json', expect.objectContaining({ cache: 'no-store' }))
  })

  it('stays idle when the running version IS the newest', async () => {
    const fetchFn = vi.fn(() => okJson([{ version: '1.0.0' }]))
    render(<Probe opts={{ fetchFn, appVersion: '1.0.0' }} onApi={() => {}} />)
    await act(() => Promise.resolve())
    await act(() => Promise.resolve())
    expect(screen.getByTestId('state').textContent).toBe('idle')
  })

  it('stays idle (and does not throw) when the probe fails — offline/hung CDN', async () => {
    const fetchFn = vi.fn(() => Promise.reject(new Error('network dead')))
    render(<Probe opts={{ fetchFn, appVersion: '1.0.0' }} onApi={() => {}} />)
    await act(() => Promise.resolve())
    await act(() => Promise.resolve())
    expect(screen.getByTestId('state').textContent).toBe('idle')
  })

  it('signals on the waiting-SW event and apply() invokes the event apply', async () => {
    const fetchFn = vi.fn(() => okJson([]))
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
    const fetchFn = vi.fn(() => okJson([{ version: '9.9.9' }]))
    const reload = vi.fn()
    let api
    render(<Probe opts={{ fetchFn, appVersion: '1.0.0', reload }} onApi={(a) => { api = a }} />)
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('9.9.9'))
    act(() => { api.apply() })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
