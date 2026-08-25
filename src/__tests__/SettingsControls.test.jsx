// V4-HANDEDNESSCONTROLS-001 (BD-054) — the setting itself.
//
// Dave chose a REAL SETTING over a hardcoded left-handed layout ("I want a setting if at all
// possible. My usage may easily change based on setup/kitchen space"), so the thing under test here
// is that the choice is (a) reachable, (b) applied on tap with no save step, (c) persisted locally,
// and (d) pushed to the per-user store. The LAYOUT consequences are pinned on the surfaces
// themselves — HarvestWatchBand.test.jsx, NumberPad.handedness.test.jsx, comboboxHandedness.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const getTokenMock = vi.hoisted(() => vi.fn(async () => 'tok'))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(), getToken: getTokenMock }) }))

const saveHandednessMock = vi.hoisted(() => vi.fn(async () => null))
const fetchPrefsMock = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../lib/notificationPrefsClient.js', () => ({
  saveHandedness: saveHandednessMock,
  fetchNotificationPrefs: fetchPrefsMock,
}))

import SettingsControls from '../pages/SettingsControls.jsx'
import { HANDEDNESS_KEY, HANDEDNESS_EVENT } from '../lib/handedness.js'
import { __resetHandednessSync } from '../hooks/useHandedness.js'

beforeEach(() => {
  localStorage.clear()
  saveHandednessMock.mockClear()
  fetchPrefsMock.mockClear()
  fetchPrefsMock.mockResolvedValue(null)
  __resetHandednessSync()
})

const opt = (hand) => screen.getByTestId(`handedness-option-${hand}`)
const previewOrder = () => [...screen.getByTestId('handedness-preview').children].map(el => el.textContent)

describe('SettingsControls — the handedness setting', () => {
  it('offers both hands as radios and starts on right-handed when never set', async () => {
    render(<SettingsControls />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('radiogroup', { name: 'Handedness' })).toBeTruthy()
    expect(opt('right').getAttribute('aria-checked')).toBe('true')
    expect(opt('left').getAttribute('aria-checked')).toBe('false')
  })

  it('applies on tap — no save button, no confirm step', async () => {
    render(<SettingsControls />)
    await act(async () => { await Promise.resolve() })
    // Nothing that would gate the choice behind a second action.
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull()
    await userEvent.click(opt('left'))
    expect(opt('left').getAttribute('aria-checked')).toBe('true')
    expect(opt('right').getAttribute('aria-checked')).toBe('false')
  })

  it('persists the choice locally, so the layout is right on the very next cold start', async () => {
    render(<SettingsControls />)
    await act(async () => { await Promise.resolve() })
    await userEvent.click(opt('left'))
    expect(localStorage.getItem(HANDEDNESS_KEY)).toBe('left')
    await userEvent.click(opt('right'))
    expect(localStorage.getItem(HANDEDNESS_KEY)).toBe('right')
  })

  it('pushes the choice to the per-user store — fire-and-forget, never awaited', async () => {
    render(<SettingsControls />)
    await act(async () => { await Promise.resolve() })
    await userEvent.click(opt('left'))
    expect(saveHandednessMock).toHaveBeenCalledTimes(1)
    expect(saveHandednessMock.mock.calls[0][0].value).toBe('left')
  })

  it('the local write lands even when the server write fails — the setting is not network-gated', async () => {
    // Pre-migration this PATCH is REJECTED by the Lambda allowlist on every call. The setting must
    // still work; that is the whole reason localStorage is the synchronous layer and not a cache of
    // a server round-trip.
    saveHandednessMock.mockRejectedValueOnce(new Error('400'))
    render(<SettingsControls />)
    await act(async () => { await Promise.resolve() })
    await userEvent.click(opt('left'))
    expect(localStorage.getItem(HANDEDNESS_KEY)).toBe('left')
    expect(opt('left').getAttribute('aria-checked')).toBe('true')
  })

  it('the preview shows which control lands under the thumb, and flips with the choice', async () => {
    // A radio label cannot convey "the destructive control moves away from your thumb". The preview
    // is a real orderByThumb row, so it cannot drift from the surfaces it describes.
    render(<SettingsControls />)
    await act(async () => { await Promise.resolve() })
    expect(previewOrder()).toEqual(['Not yet', 'Log harvest'])
    await userEvent.click(opt('left'))
    expect(previewOrder()).toEqual(['Log harvest', 'Not yet'])
  })

  it('adopts a stored per-user value from the server on mount, and announces it', async () => {
    // Guards the "server wins for a single stated preference" branch. Cross-device sync is inert
    // until the column lands, but the client half must be correct when it does.
    fetchPrefsMock.mockResolvedValue({ handedness: 'left' })
    let fired = 0
    const onChange = () => { fired += 1 }
    window.addEventListener(HANDEDNESS_EVENT, onChange)
    try {
      render(<SettingsControls />)
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(localStorage.getItem(HANDEDNESS_KEY)).toBe('left')
      expect(fired).toBe(1)
      expect(opt('left').getAttribute('aria-checked')).toBe('true')
    } finally { window.removeEventListener(HANDEDNESS_EVENT, onChange) }
  })

  it('an ABSENT server value never stomps the local choice — unset is not a preference', async () => {
    localStorage.setItem(HANDEDNESS_KEY, 'left')
    fetchPrefsMock.mockResolvedValue({ handedness: null, critter_visit: 'off' })
    render(<SettingsControls />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(localStorage.getItem(HANDEDNESS_KEY)).toBe('left')
  })

  it('an UNKNOWN server value is ignored rather than normalised into a fake choice', async () => {
    localStorage.setItem(HANDEDNESS_KEY, 'left')
    fetchPrefsMock.mockResolvedValue({ handedness: 'ambidextrous' })
    render(<SettingsControls />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // normalizeHand would have turned this into 'right' and written it, which would read back as a
    // deliberate choice on the next cold start.
    expect(localStorage.getItem(HANDEDNESS_KEY)).toBe('left')
  })

  it('records the Harvests-header exemption on the page, so the omission reads as a decision', async () => {
    // Dave, 2026-08-25: the Weigh-in button stays right permanently — he taps it before picking
    // anything up. Without this line the un-flipped button looks like a bug to its next reader.
    render(<SettingsControls />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(/weigh-in button on the Harvests header stays on the right/i)).toBeTruthy()
  })
})

// NAMED MUTATION TARGETS (each VERIFIED red on the listed test, 2026-08-25):
//   choose() writes local but never calls saveHandedness   => the per-user store test
//   choose() calls saveHandedness but never writes local   => the persistence + failure tests
//   useHandednessSync adopts any string (no HANDS check)   => the unknown-server-value test
//   useHandednessSync adopts null as 'right'               => the absent-server-value test
//   the preview uses a fixed order instead of orderByThumb => the preview test
