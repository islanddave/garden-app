import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import CritterOptInPrompt from '../components/CritterOptInPrompt.jsx'
import { DEFAULT_OPT_IN_COPY } from '../lib/critterCoachmarkCopy.js'

afterEach(() => { cleanup() })

describe('CritterOptInPrompt', () => {
  it('renders nothing when not eligible', () => {
    const { container } = render(<CritterOptInPrompt eligible={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the default copy when eligible', () => {
    render(<CritterOptInPrompt eligible={true} />)
    const el = screen.getByTestId('critter-opt-in-prompt')
    expect(el.textContent).toBe(DEFAULT_OPT_IN_COPY)
  })

  it('default copy contains the "Settings → Notifications" self-nav cue (no button, just text)', () => {
    expect(DEFAULT_OPT_IN_COPY).toMatch(/Settings\s*→\s*Notifications/i)
  })

  it('renders custom copy when passed', () => {
    render(<CritterOptInPrompt eligible={true} copy="Anything." />)
    expect(screen.getByTestId('critter-opt-in-prompt').textContent).toBe('Anything.')
  })

  it('uses role=status + aria-live=polite', () => {
    render(<CritterOptInPrompt eligible={true} />)
    const el = screen.getByTestId('critter-opt-in-prompt')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-live')).toBe('polite')
  })

  it('does NOT render any button — informational only per §3.8 + permission discipline rule', () => {
    render(<CritterOptInPrompt eligible={true} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()  // no <a href> either — user must self-nav
  })

  it('NEVER auto-calls Notification.requestPermission() on mount or unmount', () => {
    const requestPermission = vi.fn()
    const originalNotification = global.Notification
    global.Notification = { requestPermission }
    const { unmount } = render(<CritterOptInPrompt eligible={true} onDismiss={() => {}} />)
    unmount()
    expect(requestPermission).not.toHaveBeenCalled()
    global.Notification = originalNotification
  })

  it('SUPPRESSION-FLAG FIX (§3.8): onDismiss FIRES on unmount when eligible (prompt rendered)', () => {
    const onDismiss = vi.fn()
    const { unmount } = render(<CritterOptInPrompt eligible={true} onDismiss={onDismiss} />)
    unmount()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('SUPPRESSION-FLAG FIX (§3.8): onDismiss does NOT fire when ineligible (prompt suppressed)', () => {
    const onDismiss = vi.fn()
    const { unmount } = render(<CritterOptInPrompt eligible={false} onDismiss={onDismiss} />)
    unmount()
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
