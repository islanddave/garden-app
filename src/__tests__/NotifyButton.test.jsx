// Unit tests for src/components/NotifyButton.jsx
// Exercises the feature-flag short-circuit, engagement gate, permission states,
// click → requestPermission → POST flow, error surfacing, and the push-P0 gate
// order (iOS-not-installed guidance MUST render even when window.Notification
// is absent — which is exactly the iOS Safari in-browser condition).
//
// The component is gated by a module-level NOTIFY_ENABLED const (default false);
// tests pass enabled={true} to drive the full component.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

import NotifyButton from '../components/NotifyButton.jsx'

// ─── window stubs ─────────────────────────────────────────────────────────────
let origNotification
let origMatchMedia
let requestPermissionMock

function stubNotification(permission = 'default', resolveTo = 'granted') {
  requestPermissionMock = vi.fn().mockResolvedValue(resolveTo)
  origNotification = Object.getOwnPropertyDescriptor(window, 'Notification')
  // Assign a constructor-ish mock carrying static permission + requestPermission.
  const NotificationMock = function () {}
  NotificationMock.permission = permission
  NotificationMock.requestPermission = requestPermissionMock
  Object.defineProperty(window, 'Notification', {
    value: NotificationMock,
    configurable: true,
    writable: true,
  })
}

function removeNotification() {
  origNotification = Object.getOwnPropertyDescriptor(window, 'Notification')
  delete window.Notification
}

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

function stubUserAgent(ua) {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: ua,
    configurable: true,
  })
}

function restoreUserAgent() {
  // The stub is an own property shadowing the Navigator.prototype getter.
  delete window.navigator.userAgent
}

function stubMatchMedia(standalone = false) {
  origMatchMedia = window.matchMedia
  window.matchMedia = vi.fn().mockImplementation(query => ({
    matches: query === '(display-mode: standalone)' ? standalone : false,
    media: query,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

beforeEach(() => {
  fetchSpy.mockReset()
  stubMatchMedia(false)
  // jsdom default UA is not iOS, so the iOS branch stays inactive unless a test
  // explicitly overrides navigator.userAgent.
})

afterEach(() => {
  if (origNotification) {
    Object.defineProperty(window, 'Notification', origNotification)
  } else {
    delete window.Notification
  }
  origNotification = undefined
  if (origMatchMedia) window.matchMedia = origMatchMedia
  origMatchMedia = undefined
})

describe('NotifyButton — feature flag', () => {
  it('renders null with enabled defaulting to false (production posture)', () => {
    stubNotification('default')
    const { container } = render(<NotifyButton eventCount={10} harvestCount={5} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('NotifyButton — engagement gate', () => {
  it('renders null when enabled but eventCount < 3 and harvestCount === 0', () => {
    stubNotification('default')
    const { container } = render(
      <NotifyButton enabled={true} eventCount={2} harvestCount={0} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the button when enabled and eventCount >= 3', () => {
    stubNotification('default')
    render(<NotifyButton enabled={true} eventCount={3} harvestCount={0} />)
    expect(screen.getByText('Enable reminders')).toBeTruthy()
  })

  it('renders the button when enabled and harvestCount >= 1 even if eventCount is 0', () => {
    stubNotification('default')
    render(<NotifyButton enabled={true} eventCount={0} harvestCount={1} />)
    expect(screen.getByText('Enable reminders')).toBeTruthy()
  })
})

describe('NotifyButton — capability gate', () => {
  it('renders null when Notification is not in window (non-iOS)', () => {
    removeNotification()
    const { container } = render(
      <NotifyButton enabled={true} eventCount={10} harvestCount={5} />
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('NotifyButton — iOS gate order (push-P0)', () => {
  afterEach(() => restoreUserAgent())

  it('renders the guidance tile on iOS Safari not installed EVEN WITHOUT window.Notification', () => {
    // The real iOS Safari in-browser condition: iOS UA, not standalone, and no
    // Notification API at all. Before the gate-order fix this rendered null.
    stubUserAgent(IOS_UA)
    removeNotification()
    render(<NotifyButton enabled={true} eventCount={5} harvestCount={2} />)
    expect(screen.getByText('Reminders work best in the installed app')).toBeTruthy()
  })

  it('A2HS how-to is collapsed by default, expands and collapses on tap, and never requests permission', () => {
    stubUserAgent(IOS_UA)
    // Notification present WITH a spy — belt and braces: even when the API
    // exists, the iOS-not-installed path must never call requestPermission.
    stubNotification('default')
    render(<NotifyButton enabled={true} eventCount={5} harvestCount={2} />)
    expect(requestPermissionMock).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.queryByTestId('notify-install-howto')).toBeNull()
    fireEvent.click(screen.getByText(/How to install/))
    const howto = screen.getByTestId('notify-install-howto')
    expect(howto.querySelectorAll('li').length).toBe(3)
    expect(howto.textContent).toContain('Add to Home Screen')
    fireEvent.click(screen.getByText(/How to install/))
    expect(screen.queryByTestId('notify-install-howto')).toBeNull()
    // Neither render nor tile taps may fire a permission request or a POST.
    expect(requestPermissionMock).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('engagement gate still hides the iOS guidance tile at low activity', () => {
    stubUserAgent(IOS_UA)
    removeNotification()
    const { container } = render(
      <NotifyButton enabled={true} eventCount={2} harvestCount={0} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('iOS installed (standalone) with Notification available falls through to the actionable state', () => {
    stubUserAgent(IOS_UA)
    stubMatchMedia(true)
    stubNotification('default')
    render(<NotifyButton enabled={true} eventCount={5} harvestCount={2} />)
    expect(screen.getByText('Enable reminders')).toBeTruthy()
    expect(screen.queryByText('Reminders work best in the installed app')).toBeNull()
  })

  it('iOS installed WITHOUT Notification (iOS < 16.4) renders null, not the guidance tile', () => {
    stubUserAgent(IOS_UA)
    stubMatchMedia(true)
    removeNotification()
    const { container } = render(
      <NotifyButton enabled={true} eventCount={5} harvestCount={2} />
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('NotifyButton — permission states', () => {
  it("'granted' renders the passive 'Reminders on' copy", () => {
    stubNotification('granted')
    render(<NotifyButton enabled={true} eventCount={5} />)
    expect(screen.getByText('Reminders on')).toBeTruthy()
    expect(screen.queryByText('Enable reminders')).toBeNull()
  })

  it("'denied' renders blocked copy and an expandable how-to", () => {
    stubNotification('denied')
    render(<NotifyButton enabled={true} eventCount={5} />)
    expect(screen.getByText('Reminders blocked')).toBeTruthy()
    // How-to collapsed by default.
    expect(screen.queryByTestId('notify-howto')).toBeNull()
    fireEvent.click(screen.getByText(/How to enable/))
    const howto = screen.getByTestId('notify-howto')
    expect(howto).toBeTruthy()
    expect(howto.querySelectorAll('li').length).toBe(3)
  })
})

describe('NotifyButton — click flow', () => {
  it('does NOT POST on mount — only on click', () => {
    stubNotification('default')
    render(<NotifyButton enabled={true} eventCount={5} />)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('clicking calls requestPermission and POSTs subscribe on granted', async () => {
    stubNotification('default', 'granted')
    fetchSpy.mockResolvedValueOnce({ ok: true })
    render(<NotifyButton enabled={true} eventCount={5} />)
    await act(async () => {
      fireEvent.click(screen.getByText('Enable reminders'))
    })
    expect(requestPermissionMock).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [path, opts] = fetchSpy.mock.calls[0]
    expect(path).toBe('/api/notifications/subscribe')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ permission_state: 'granted' })
    // Transitions to the passive granted state.
    expect(screen.getByText('Reminders on')).toBeTruthy()
  })

  it('shows the inline error notice when the POST fails (non-2xx)', async () => {
    stubNotification('default', 'granted')
    const err = new Error('HTTP 500')
    err.status = 500
    err.body = { error: 'server boom' }
    fetchSpy.mockRejectedValueOnce(err)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<NotifyButton enabled={true} eventCount={5} />)
    await act(async () => {
      fireEvent.click(screen.getByText('Enable reminders'))
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('notify-error').textContent).toContain('Couldn\'t save preference')
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('stays in default state and does not POST when permission resolves to default (prompt dismissed)', async () => {
    stubNotification('default', 'default')
    render(<NotifyButton enabled={true} eventCount={5} />)
    await act(async () => {
      fireEvent.click(screen.getByText('Enable reminders'))
    })
    expect(requestPermissionMock).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByText('Enable reminders')).toBeTruthy()
  })
})
