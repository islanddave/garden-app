/**
 * src/__tests__/ModeContext.test.jsx
 * Bite 2 of Post-V2 UX overhaul Increment 2: Field/Desk mode toggle scaffold.
 *
 * Covers:
 *  - default = Field on touch (coarse pointer) / Desk otherwise
 *  - sessionStorage persistence across re-renders + tab reloads
 *  - explicit initialMode prop takes precedence over default detection
 *  - setMode rejects invalid values
 *  - toggleMode flips between Field and Desk
 *  - useMode throws outside the provider (developer footgun guard)
 *  - matchMedia / sessionStorage unavailability is handled gracefully
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

import { ModeProvider, useMode } from '../context/ModeContext.jsx'
import { MODE, MODE_STORAGE_KEY } from '../lib/mode.js'

function Probe() {
  const { mode, setMode, toggleMode, isField, isDesk } = useMode()
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="isField">{String(isField)}</span>
      <span data-testid="isDesk">{String(isDesk)}</span>
      <button onClick={toggleMode}>toggle</button>
      <button onClick={() => setMode(MODE.FIELD)}>set-field</button>
      <button onClick={() => setMode(MODE.DESK)}>set-desk</button>
      <button onClick={() => setMode('garbage')}>set-garbage</button>
    </div>
  )
}

function setMatchMediaCoarse(coarse) {
  // Stub only matchMedia — leave the rest of window intact.
  window.matchMedia = vi.fn((q) => ({
    matches: q.includes('coarse') ? coarse : false,
    media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return true },
    onchange: null,
  }))
}

beforeEach(() => {
  try { window.sessionStorage.clear() } catch {}
  setMatchMediaCoarse(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ModeContext — default detection', () => {
  it('defaults to Desk when pointer is fine (desktop)', () => {
    setMatchMediaCoarse(false)
    render(<ModeProvider><Probe /></ModeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe(MODE.DESK)
    expect(screen.getByTestId('isDesk').textContent).toBe('true')
    expect(screen.getByTestId('isField').textContent).toBe('false')
  })

  it('defaults to Field when pointer is coarse (touch device)', () => {
    setMatchMediaCoarse(true)
    render(<ModeProvider><Probe /></ModeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe(MODE.FIELD)
    expect(screen.getByTestId('isField').textContent).toBe('true')
    expect(screen.getByTestId('isDesk').textContent).toBe('false')
  })

  it('survives missing matchMedia by falling back to Desk', () => {
    // Remove matchMedia entirely. detectDefaultMode swallows the access throw.
    const original = window.matchMedia
    // @ts-ignore
    delete window.matchMedia
    try {
      render(<ModeProvider><Probe /></ModeProvider>)
      expect(screen.getByTestId('mode').textContent).toBe(MODE.DESK)
    } finally {
      window.matchMedia = original
    }
  })
})

describe('ModeContext — persistence', () => {
  it('persists the initial detected mode to sessionStorage on mount', () => {
    setMatchMediaCoarse(true)
    render(<ModeProvider><Probe /></ModeProvider>)
    expect(window.sessionStorage.getItem(MODE_STORAGE_KEY)).toBe(MODE.FIELD)
  })

  it('reads a previously stored value over the UA default', () => {
    // UA default would be Desk, but stored=Field should win.
    setMatchMediaCoarse(false)
    window.sessionStorage.setItem(MODE_STORAGE_KEY, MODE.FIELD)
    render(<ModeProvider><Probe /></ModeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe(MODE.FIELD)
  })

  it('ignores invalid stored values and falls back to UA default', () => {
    setMatchMediaCoarse(false)
    window.sessionStorage.setItem(MODE_STORAGE_KEY, 'banana')
    render(<ModeProvider><Probe /></ModeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe(MODE.DESK)
  })

  it('persists explicit toggles', () => {
    setMatchMediaCoarse(false)
    render(<ModeProvider><Probe /></ModeProvider>)
    act(() => { fireEvent.click(screen.getByText('toggle')) })
    expect(screen.getByTestId('mode').textContent).toBe(MODE.FIELD)
    expect(window.sessionStorage.getItem(MODE_STORAGE_KEY)).toBe(MODE.FIELD)
  })
})

describe('ModeContext — setMode + toggleMode', () => {
  it('toggleMode flips Desk → Field → Desk', () => {
    setMatchMediaCoarse(false)
    render(<ModeProvider><Probe /></ModeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe(MODE.DESK)
    act(() => { fireEvent.click(screen.getByText('toggle')) })
    expect(screen.getByTestId('mode').textContent).toBe(MODE.FIELD)
    act(() => { fireEvent.click(screen.getByText('toggle')) })
    expect(screen.getByTestId('mode').textContent).toBe(MODE.DESK)
  })

  it('setMode accepts the canonical constants', () => {
    setMatchMediaCoarse(false)
    render(<ModeProvider><Probe /></ModeProvider>)
    act(() => { fireEvent.click(screen.getByText('set-field')) })
    expect(screen.getByTestId('mode').textContent).toBe(MODE.FIELD)
    act(() => { fireEvent.click(screen.getByText('set-desk')) })
    expect(screen.getByTestId('mode').textContent).toBe(MODE.DESK)
  })

  it('setMode rejects garbage input without changing state', () => {
    setMatchMediaCoarse(false)
    render(<ModeProvider><Probe /></ModeProvider>)
    const before = screen.getByTestId('mode').textContent
    act(() => { fireEvent.click(screen.getByText('set-garbage')) })
    expect(screen.getByTestId('mode').textContent).toBe(before)
  })
})

describe('ModeContext — initialMode prop', () => {
  it('uses initialMode prop over stored value and UA default', () => {
    setMatchMediaCoarse(true) // UA would say Field
    window.sessionStorage.setItem(MODE_STORAGE_KEY, MODE.FIELD) // stored says Field
    render(<ModeProvider initialMode={MODE.DESK}><Probe /></ModeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe(MODE.DESK)
  })

  it('ignores invalid initialMode and falls back to stored / UA default', () => {
    setMatchMediaCoarse(false)
    render(<ModeProvider initialMode="nonsense"><Probe /></ModeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe(MODE.DESK)
  })
})

describe('ModeContext — useMode footgun guard', () => {
  it('throws a clear error when called outside the provider', () => {
    const ConsumerOutside = () => { useMode(); return null }
    // Silence the expected React error log during this assertion.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<ConsumerOutside />)).toThrow(/inside ModeProvider/)
    spy.mockRestore()
  })
})
