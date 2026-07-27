// BUG-STALECLIENT-001 — UpdateBanner: hidden when current, shows Refresh on the waiting-SW
// event, dismiss hides it. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import UpdateBanner from '../components/UpdateBanner.jsx'
import { UPDATE_WAITING_EVENT } from '../lib/registerSW.js'

// The banner's hook probes /releases.json on mount; give it a quiet, current answer.
function mockFetchCurrent() {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })))
}

describe('UpdateBanner (BUG-STALECLIENT-001)', () => {
  it('renders nothing when no update is known', async () => {
    mockFetchCurrent()
    const { container } = render(<UpdateBanner />)
    await act(() => Promise.resolve())
    expect(container.firstChild).toBe(null)
    vi.unstubAllGlobals()
  })

  it('shows the banner + Refresh on the waiting-SW event, and Refresh applies', async () => {
    mockFetchCurrent()
    const swApply = vi.fn()
    render(<UpdateBanner />)
    await act(() => Promise.resolve())
    act(() => {
      window.dispatchEvent(new CustomEvent(UPDATE_WAITING_EVENT, { detail: { apply: swApply } }))
    })
    expect(screen.getByRole('status')).toBeDefined()
    expect(screen.getByText(/new version of the app is ready/i)).toBeDefined()
    fireEvent.click(screen.getByText('Refresh'))
    expect(swApply).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('dismiss hides the banner', async () => {
    mockFetchCurrent()
    const { container } = render(<UpdateBanner />)
    await act(() => Promise.resolve())
    act(() => {
      window.dispatchEvent(new CustomEvent(UPDATE_WAITING_EVENT, { detail: { apply: vi.fn() } }))
    })
    expect(screen.getByRole('status')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Dismiss update notice'))
    expect(container.firstChild).toBe(null)
    vi.unstubAllGlobals()
  })
})
