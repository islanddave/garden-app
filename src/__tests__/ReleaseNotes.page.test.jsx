// BUG-RELNOTES-001 — ReleaseNotes page: the fetch is BOUNDED (a hung connection surfaces the
// error state + Try again instead of "Loading…" forever) and retry refetches. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import ReleaseNotes, { RELEASES_FETCH_TIMEOUT_MS } from '../pages/ReleaseNotes.jsx'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

// A fetch that never responds but honours its AbortSignal — the shape of a stalled CDN socket.
function hangingFetch() {
  return vi.fn((url, opts = {}) => new Promise((_, reject) => {
    const sig = opts.signal
    if (sig) sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }))
}

describe('ReleaseNotes bounded fetch (BUG-RELNOTES-001)', () => {
  it('a hung fetch times out into the error state with a Try again button', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())
    render(<ReleaseNotes />)
    expect(screen.getByText('Loading…')).toBeDefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(RELEASES_FETCH_TIMEOUT_MS + 50) })
    expect(screen.getByText(/couldn't load release notes/i)).toBeDefined()
    expect(screen.getByText('Try again')).toBeDefined()
  })

  it('Try again refetches and renders releases on success', async () => {
    vi.useFakeTimers()
    const hang = hangingFetch()
    vi.stubGlobal('fetch', hang)
    render(<ReleaseNotes />)
    await act(async () => { await vi.advanceTimersByTimeAsync(RELEASES_FETCH_TIMEOUT_MS + 50) })
    expect(screen.getByText('Try again')).toBeDefined()
    vi.useRealTimers()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve([{ version: '9.9.9', date: '2026-07-27', highlights: ['It works'] }]),
    })))
    fireEvent.click(screen.getByText('Try again'))
    await waitFor(() => expect(screen.getByText('v9.9.9')).toBeDefined())
    expect(screen.getByText('It works')).toBeDefined()
  })
})
