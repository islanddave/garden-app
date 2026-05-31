import React from 'react'
// SettingsNotifications page tests — Phase A.
// Spec: revision §3.17 (disclosure-button + radio-group ARIA), §3.24 (PWA gate),
//       §6 deferred note (SYSTEM bi-state flag).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'

const getTokenMock = vi.fn(async () => 'tk-abc')
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }),
}))

const fetchPrefsMock = vi.fn()
const patchPrefsMock = vi.fn()
vi.mock('../lib/notificationPrefsClient.js', () => ({
  CRITTER_VISIT_VALUES: ['off', 'in_app_only', 'system'],
  fetchNotificationPrefs: (...args) => fetchPrefsMock(...args),
  patchNotificationPrefs: (...args) => patchPrefsMock(...args),
}))

// Default SYSTEM disabled (Phase A current state).
vi.mock('../lib/featureFlags.js', () => ({
  SYSTEM_NOTIFICATIONS_ENABLED: false,
  VARIETY_REF_UI_SHIPPED: false,
  CATCH_UP_EDITOR_SHIPPED: false,
}))

import SettingsNotifications, { isPwaInstalled } from '../pages/SettingsNotifications.jsx'

function setupPwa(installed) {
  const matchMedia = vi.fn().mockImplementation((q) => ({
    matches: installed && q === '(display-mode: standalone)',
    media: q, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: matchMedia })
}

describe('SettingsNotifications', () => {
  beforeEach(() => {
    fetchPrefsMock.mockResolvedValue({ critter_visit: 'in_app_only' })
    patchPrefsMock.mockResolvedValue({ critter_visit: 'in_app_only' })
    setupPwa(false)
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders the disclosure button with aria-expanded=false initially', async () => {
    const { findByTestId } = render(<SettingsNotifications />)
    const btn = await findByTestId('critter-notif-disclosure')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('fetches prefs on mount and reflects critter_visit in disclosure label', async () => {
    fetchPrefsMock.mockResolvedValueOnce({ critter_visit: 'off' })
    const { findByTestId } = render(<SettingsNotifications />)
    const btn = await findByTestId('critter-notif-disclosure')
    await waitFor(() => expect(btn.textContent).toContain('Off'))
  })

  it('expands radiogroup on disclosure-button click', async () => {
    const { findByTestId, queryByTestId } = render(<SettingsNotifications />)
    const btn = await findByTestId('critter-notif-disclosure')
    await waitFor(() => expect(btn.textContent).toContain('In-app only'))
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(queryByTestId('critter-notif-radiogroup')).toBeTruthy()
  })

  it('renders OFF and IN_APP_ONLY radios when SYSTEM flag is false (bi-state collapse)', async () => {
    const { findByTestId, queryByTestId } = render(<SettingsNotifications />)
    const btn = await findByTestId('critter-notif-disclosure')
    fireEvent.click(btn)
    await waitFor(() => expect(queryByTestId('critter-notif-radiogroup')).toBeTruthy())
    expect(queryByTestId('critter-notif-option-off')).toBeTruthy()
    expect(queryByTestId('critter-notif-option-in_app_only')).toBeTruthy()
    expect(queryByTestId('critter-notif-option-system')).toBeNull()
    expect(queryByTestId('critter-notif-option-system-blocked')).toBeNull()
  })

  it('radiogroup has role=radiogroup and radios have role=radio', async () => {
    const { findByTestId } = render(<SettingsNotifications />)
    const btn = await findByTestId('critter-notif-disclosure')
    fireEvent.click(btn)
    const group = await findByTestId('critter-notif-radiogroup')
    expect(group.getAttribute('role')).toBe('radiogroup')
    const opt = await findByTestId('critter-notif-option-off')
    expect(opt.getAttribute('role')).toBe('radio')
  })

  it('clicking a radio fires patch with the chosen value and updates aria-checked', async () => {
    const { findByTestId } = render(<SettingsNotifications />)
    const btn = await findByTestId('critter-notif-disclosure')
    fireEvent.click(btn)
    const off = await findByTestId('critter-notif-option-off')
    fireEvent.click(off)
    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(1))
    expect(patchPrefsMock.mock.calls[0][0].critterVisit).toBe('off')
    expect(off.getAttribute('aria-checked')).toBe('true')
  })

  it('writes a polite live-region announcement after selection', async () => {
    const { findByTestId } = render(<SettingsNotifications />)
    const btn = await findByTestId('critter-notif-disclosure')
    fireEvent.click(btn)
    const off = await findByTestId('critter-notif-option-off')
    fireEvent.click(off)
    const live = await findByTestId('critter-notif-announcement')
    await waitFor(() => expect(live.textContent).toBe('Critter notifications set to Off'))
    expect(live.getAttribute('aria-live')).toBe('polite')
  })

  it('reverts on patch failure and announces failure', async () => {
    patchPrefsMock.mockResolvedValueOnce(null)
    const { findByTestId } = render(<SettingsNotifications />)
    const btn = await findByTestId('critter-notif-disclosure')
    fireEvent.click(btn)
    const off = await findByTestId('critter-notif-option-off')
    fireEvent.click(off)
    const live = await findByTestId('critter-notif-announcement')
    await waitFor(() => expect(live.textContent).toContain('Failed to save'))
    await waitFor(() => expect(off.getAttribute('aria-checked')).toBe('false'))
  })

  it('Escape on a radio collapses the group', async () => {
    const { findByTestId, queryByTestId } = render(<SettingsNotifications />)
    const btn = await findByTestId('critter-notif-disclosure')
    fireEvent.click(btn)
    const off = await findByTestId('critter-notif-option-off')
    fireEvent.keyDown(off, { key: 'Escape' })
    await waitFor(() => expect(queryByTestId('critter-notif-radiogroup')).toBeNull())
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('ArrowDown on a radio moves focus to the next radio', async () => {
    const { findByTestId } = render(<SettingsNotifications />)
    const btn = await findByTestId('critter-notif-disclosure')
    fireEvent.click(btn)
    const off = await findByTestId('critter-notif-option-off')
    const inapp = await findByTestId('critter-notif-option-in_app_only')
    off.focus()
    fireEvent.keyDown(off, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(inapp))
  })

  it('does NOT call Notification.requestPermission()', async () => {
    const reqMock = vi.fn()
    Object.defineProperty(window, 'Notification', {
      configurable: true, writable: true,
      value: { requestPermission: reqMock, permission: 'default' },
    })
    const { findByTestId } = render(<SettingsNotifications />)
    const btn = await findByTestId('critter-notif-disclosure')
    fireEvent.click(btn)
    const off = await findByTestId('critter-notif-option-off')
    fireEvent.click(off)
    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalled())
    expect(reqMock).not.toHaveBeenCalled()
  })
})

describe('isPwaInstalled helper', () => {
  beforeEach(() => {
    setupPwa(false)
    if ('standalone' in navigator) delete navigator.standalone
  })

  it('returns false in a standard browser (not standalone, no navigator.standalone)', () => {
    expect(isPwaInstalled()).toBe(false)
  })

  it('returns true when matchMedia standalone matches', () => {
    setupPwa(true)
    expect(isPwaInstalled()).toBe(true)
  })

  it('returns true when navigator.standalone is true (iOS legacy signal)', () => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, writable: true, value: true })
    expect(isPwaInstalled()).toBe(true)
  })
})
