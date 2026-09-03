// V5-HARVESTONEDOOR-001 — the `embedded` prop on VoiceHarvest.
//
// WHY THIS FILE EXISTS. The prop shipped with a comment claiming "there is no embedded-only code
// path to test separately", and the pre-promote QA pass showed that was false: there are two
// branches, a suppressed <h1> and a swapped sentence of help text. The comment was the only reason
// the branch had no coverage, so the fix is a test, not a reworded comment.
//
// Both directions are asserted. A test that only checked the embedded case would pass against a
// component that had dropped the heading unconditionally — which is the actual regression risk,
// since /log/voice still resolves in tests and from a stale bookmark and would then render a
// title-less page.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))

import VoiceHarvest from '../pages/VoiceHarvest.jsx'

beforeEach(() => {
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation(path => {
    if (String(path).startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
})

const HEADING = 'Harvest by voice'

describe('VoiceHarvest — the embedded prop', () => {
  it('standalone renders its own heading', async () => {
    render(<VoiceHarvest />)
    await waitFor(() => expect(screen.getByTestId('voice-harvest')).toBeTruthy())
    expect(screen.getByRole('heading', { name: HEADING })).toBeTruthy()
  })

  it('embedded suppresses that heading — the combined page supplies the title', async () => {
    render(<VoiceHarvest embedded />)
    await waitFor(() => expect(screen.getByTestId('voice-harvest')).toBeTruthy())
    expect(screen.queryByRole('heading', { name: HEADING })).toBeNull()
  })

  // The help text is the second branch, and it is the one that would go stale silently: embedded,
  // it must point at the selector directly above rather than name a menu the user is not in.
  it('embedded points at the selector; standalone names the other surface', async () => {
    const { unmount } = render(<VoiceHarvest embedded />)
    await waitFor(() => expect(screen.getByTestId('voice-harvest')).toBeTruthy())
    expect(screen.getByText(/Switch to Manual above/i)).toBeTruthy()
    unmount()

    render(<VoiceHarvest />)
    await waitFor(() => expect(screen.getByTestId('voice-harvest')).toBeTruthy())
    expect(screen.queryByText(/Switch to Manual above/i)).toBeNull()
    expect(screen.getByText(/manual harvest form/i)).toBeTruthy()
  })

  // Everything OTHER than those two branches must be identical, or the prop has grown a behaviour
  // it does not advertise. The record card is the page's core surface and is asserted present in
  // both postures.
  it('renders the same capture surface either way', async () => {
    const { unmount } = render(<VoiceHarvest />)
    await waitFor(() => expect(screen.getByTestId('voice-harvest-record')).toBeTruthy())
    expect(screen.getByTestId('voice-harvest-status')).toBeTruthy()
    unmount()

    render(<VoiceHarvest embedded />)
    await waitFor(() => expect(screen.getByTestId('voice-harvest-record')).toBeTruthy())
    expect(screen.getByTestId('voice-harvest-status')).toBeTruthy()
  })
})
