// OPS-TODAYVIEWPORTWIDTH-001 — the "Viewport (CSS px)" row on Debug & smoke.
//
// The row exists so Dave can read his phone's REAL CSS viewport off the phone itself: Android's
// Display size setting moves the effective width on identical hardware, so no spec sheet and no
// constant in this repo can stand in for it. That makes the two ways this row can quietly lie the
// two things worth pinning:
//   1. it prints a number that did not come from the window (a default, a guess, a copy-paste), and
//   2. it prints the number the window had at MOUNT and never again — a rotation or a Display-size
//      change then leaves a confident, stale reading on screen.
// Both are asserted against values set on the window here and read back off the row, with two
// different sets in one test so that no constant can satisfy both.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn().mockResolvedValue([]), getToken: vi.fn() }),
  apiFetch: vi.fn().mockResolvedValue([]),
}))

import DebugMenu from '../pages/DebugMenu.jsx'

const KEYS = ['innerWidth', 'innerHeight', 'devicePixelRatio']
let saved

function setWindow({ w, h, dpr }) {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true, writable: true })
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true, writable: true })
}

// The value half of the row, found through its own label so no other row's text can satisfy it.
function viewportValue() {
  const labels = screen.getAllByText('Viewport (CSS px)')
  expect(labels).toHaveLength(1)
  return labels[0].parentElement.lastElementChild.textContent
}

beforeEach(() => { saved = KEYS.map(k => [k, Object.getOwnPropertyDescriptor(window, k)]) })
afterEach(() => {
  for (const [k, d] of saved) { if (d) Object.defineProperty(window, k, d); else delete window[k] }
})

describe('DebugMenu — Viewport (CSS px)', () => {
  it('shows the width, height and pixel ratio this window reports, not numbers written down', () => {
    // Deliberately not jsdom's 1024 x 768 @1 and not any phone preset, so a default or a constant
    // cannot match by accident.
    setWindow({ w: 413, h: 777, dpr: 2.75 })
    render(<MemoryRouter><DebugMenu /></MemoryRouter>)
    expect(viewportValue()).toBe('413 × 777 @2.75×')
  })

  it('follows a resize and a rotation instead of keeping the mount-time reading', () => {
    setWindow({ w: 413, h: 777, dpr: 2.75 })
    render(<MemoryRouter><DebugMenu /></MemoryRouter>)
    expect(viewportValue()).toBe('413 × 777 @2.75×')

    // Display size changed on the phone: a resize.
    setWindow({ w: 390, h: 844, dpr: 3 })
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(viewportValue()).toBe('390 × 844 @3×')

    // Turned sideways: ONLY orientationchange fires here, so this step fails if that listener goes.
    setWindow({ w: 844, h: 390, dpr: 3 })
    act(() => { window.dispatchEvent(new Event('orientationchange')) })
    expect(viewportValue()).toBe('844 × 390 @3×')
  })
})
