/**
 * src/__tests__/GardenHelper.test.jsx
 * Bite 1 of Post-V2 UX overhaul Increment 2: Rung-1 advisory helper-prompt UI.
 *
 * Covers:
 *  - Renders the composer surface (heading, textarea, Send button)
 *  - Send button is disabled until the note is non-empty (after trim)
 *  - navigator.share is preferred when present; falls back to clipboard
 *  - clipboard path shows "Copied" confirmation
 *  - share path shows "Shared" confirmation
 *  - error path shows manual-copy fallback (the assembled prompt)
 *  - Rung-1 explainer shows by default, dismisses + persists in localStorage
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import GardenHelper from '../pages/GardenHelper.jsx'
import { HELPER_PROMPT_FENCE } from '../lib/helperPrompt.js'

beforeEach(() => {
  try { window.localStorage.clear() } catch {}
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GardenHelper — composer surface', () => {
  it('renders the heading, textarea, and Send button', () => {
    render(<GardenHelper />)
    expect(screen.getByRole('heading', { name: /Garden Helper/i })).toBeDefined()
    expect(screen.getByLabelText(/What's on your mind/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /Send to Claude/i })).toBeDefined()
  })

  it('links back to Dashboard', () => {
    render(<GardenHelper />)
    const back = screen.getByText(/← Dashboard/).closest('a')
    expect(back).not.toBeNull()
    expect(back.getAttribute('href')).toBe('/dashboard')
  })

  it('Send button is disabled when textarea is empty', () => {
    render(<GardenHelper />)
    const btn = screen.getByRole('button', { name: /Send to Claude/i })
    expect(btn.hasAttribute('disabled')).toBe(true)
  })

  it('Send button is disabled when textarea contains only whitespace', () => {
    render(<GardenHelper />)
    const ta = screen.getByLabelText(/What's on your mind/i)
    fireEvent.change(ta, { target: { value: '   \n  \t  ' } })
    const btn = screen.getByRole('button', { name: /Send to Claude/i })
    expect(btn.hasAttribute('disabled')).toBe(true)
  })

  it('Send button enables when non-empty text is entered', () => {
    render(<GardenHelper />)
    const ta = screen.getByLabelText(/What's on your mind/i)
    fireEvent.change(ta, { target: { value: 'basil wilting' } })
    const btn = screen.getByRole('button', { name: /Send to Claude/i })
    expect(btn.hasAttribute('disabled')).toBe(false)
  })
})

describe('GardenHelper — Send to Claude (share path)', () => {
  it('uses navigator.share when available and shows shared status', async () => {
    const shareSpy = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', {
      ...window.navigator,
      share: shareSpy,
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    })

    render(<GardenHelper />)
    const ta = screen.getByLabelText(/What's on your mind/i)
    fireEvent.change(ta, { target: { value: 'tomato leaves curling' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send to Claude/i }))
    })

    expect(shareSpy).toHaveBeenCalledTimes(1)
    const shareArg = shareSpy.mock.calls[0][0]
    expect(shareArg.text).toContain('tomato leaves curling')
    expect(shareArg.text).toContain(HELPER_PROMPT_FENCE.open)
    expect(screen.getByText(/Shared/)).toBeDefined()
  })

  it('falls back to clipboard when share is unavailable, showing copied status', async () => {
    const writeTextSpy = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', {
      ...window.navigator,
      share: undefined,
      clipboard: { writeText: writeTextSpy },
    })

    render(<GardenHelper />)
    const ta = screen.getByLabelText(/What's on your mind/i)
    fireEvent.change(ta, { target: { value: 'seedling damping off' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send to Claude/i }))
    })

    expect(writeTextSpy).toHaveBeenCalledTimes(1)
    const written = writeTextSpy.mock.calls[0][0]
    expect(written).toContain('seedling damping off')
    expect(written).toContain(HELPER_PROMPT_FENCE.open)
    expect(screen.getByText(/Copied to clipboard/)).toBeDefined()
  })

  it('falls back to clipboard when share throws (cancelled or failed)', async () => {
    const shareSpy = vi.fn(() => Promise.reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })))
    const writeTextSpy = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', {
      ...window.navigator,
      share: shareSpy,
      clipboard: { writeText: writeTextSpy },
    })

    render(<GardenHelper />)
    const ta = screen.getByLabelText(/What's on your mind/i)
    fireEvent.change(ta, { target: { value: 'aphids on kale' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send to Claude/i }))
    })

    expect(shareSpy).toHaveBeenCalledTimes(1)
    expect(writeTextSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Copied to clipboard/)).toBeDefined()
  })

  it('shows manual-copy fallback when both share and clipboard fail', async () => {
    vi.stubGlobal('navigator', {
      ...window.navigator,
      share: undefined,
      clipboard: undefined,
    })

    render(<GardenHelper />)
    const ta = screen.getByLabelText(/What's on your mind/i)
    fireEvent.change(ta, { target: { value: 'cucumber beetles' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send to Claude/i }))
    })

    expect(screen.getByText(/Couldn't copy or share/)).toBeDefined()
    const fallback = screen.getByTestId('manual-copy-fallback')
    expect(fallback.textContent).toContain('cucumber beetles')
    expect(fallback.textContent).toContain(HELPER_PROMPT_FENCE.open)
  })
})

describe('GardenHelper — Rung-1 explainer (Dave-call #5)', () => {
  it('shows the explainer by default for a fresh visit', () => {
    render(<GardenHelper />)
    expect(screen.getByLabelText(/Rung-1 explainer/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /Got it/ })).toBeDefined()
  })

  it('dismissing the explainer hides it and persists in localStorage', () => {
    render(<GardenHelper />)
    fireEvent.click(screen.getByRole('button', { name: /Got it/ }))
    expect(screen.queryByLabelText(/Rung-1 explainer/i)).toBeNull()
    expect(window.localStorage.getItem('gardenHelper.rung1ExplainerDismissed')).toBe('1')
  })

  it('does NOT show the explainer when localStorage already records dismissal', () => {
    window.localStorage.setItem('gardenHelper.rung1ExplainerDismissed', '1')
    render(<GardenHelper />)
    expect(screen.queryByLabelText(/Rung-1 explainer/i)).toBeNull()
  })
})
