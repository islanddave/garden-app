// BUG-STALECLIENT-001 — UpdateBanner: hidden when current, shows Refresh on the waiting-SW
// event, dismiss hides it. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import UpdateBanner from '../components/UpdateBanner.jsx'
import { UPDATE_WAITING_EVENT } from '../lib/registerSW.js'

// The banner's hook probes /releases-latest.json on mount; give it a quiet, current answer.
function mockFetchCurrent() {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(null) })))
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

  // V4-PERFTHEMEA-001 — THE test that gates the releases.json split. The probe now reads a
  // different, much smaller file; if that rewiring breaks, the app silently stops noticing new
  // versions and nothing else in the suite would say so (BUG-STALECLIENT-002 is exactly that
  // failure, already on the ledger). End-to-end through the real component and the real hook:
  // a bumped version on the wire must put a Refresh banner on screen.
  it('raises the banner on a version bump served at /releases-latest.json', async () => {
    const fetchFn = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '99.0.0' }) }))
    vi.stubGlobal('fetch', fetchFn)
    render(<UpdateBanner />)
    await waitFor(() => expect(screen.getByRole('status')).toBeDefined())
    // The VERSION in the copy, not just the banner: it proves the number came off the wire rather
    // than the banner having been raised by some other signal.
    expect(screen.getByText(/v99\.0\.0 is ready/i)).toBeDefined()
    expect(screen.getByText('Refresh')).toBeDefined()
    expect(fetchFn).toHaveBeenCalledWith('/releases-latest.json', expect.objectContaining({ cache: 'no-store' }))
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
