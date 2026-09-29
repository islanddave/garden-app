// V5-TODAYREDESIGN-001 — the preview row as SHIPPED, by Dave's D14 (2026-09-29, design-todayux-V100-20260928.md
// round 4): featureFlags TODAY_V2_PREVIEW_ROW is TRUE and is NOT mocked here, so this file reds if the constant is
// flipped back. Debug & smoke shows "New Today (preview) on this phone" to both users, its subtitle opening "Early
// preview — not finished." so Jen knows to leave it alone, and the switch drives /today on this phone.
// The false branch is TodayRoute.previewHidden.test.jsx's; the switch's finer behaviour is TodayRoute.test.jsx's.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../pages/Today.jsx', () => ({ default: () => <div data-testid="today-v1" /> }))
vi.mock('../pages/TodayV2.jsx', () => ({ default: () => <div data-testid="today-v2" /> }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(async () => ({})) }) }))

import TodayRoute from '../components/today/v2/TodayRoute.jsx'
import DebugMenu from '../pages/DebugMenu.jsx'
import { TODAY_V2_PREVIEW_ROW } from '../lib/featureFlags.js'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => cleanup())

describe('the preview row as shipped (D14: visible to both users, marked early preview)', () => {
  it('ships true — hiding the row again is a deliberate flip, made with this test', () => {
    expect(TODAY_V2_PREVIEW_ROW).toBe(true)
  })

  it('Debug & smoke renders the row, its subtitle opening "Early preview — not finished.", and it toggles', () => {
    render(<MemoryRouter><DebugMenu /></MemoryRouter>)
    const t = screen.getByRole('button', { name: /^New Today \(preview\) on this phone/ })
    expect(t).toBe(screen.getByTestId('debug-today-v2'))
    const sub = screen.getByText(/^Early preview — not finished\./)
    expect(t.contains(sub)).toBe(true)
    expect(sub.textContent).toContain('Only this phone changes; turn it off to go back.')
    expect(t.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(t)
    expect(localStorage.getItem('garden.todayV2')).toBe('1')
    expect(t.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(t)
    expect(localStorage.getItem('garden.todayV2')).toBeNull()
    expect(t.getAttribute('aria-pressed')).toBe('false')
  })

  it('the switch reaches /today: on → the redesign, off → the current Today', () => {
    render(<><MemoryRouter><DebugMenu /></MemoryRouter><TodayRoute /></>)
    expect(screen.getByTestId('today-v1')).toBeTruthy()
    fireEvent.click(screen.getByTestId('debug-today-v2'))
    expect(screen.getByTestId('today-v2')).toBeTruthy()
    expect(screen.queryByTestId('today-v1')).toBeNull()
    fireEvent.click(screen.getByTestId('debug-today-v2'))
    expect(screen.getByTestId('today-v1')).toBeTruthy()
    expect(screen.queryByTestId('today-v2')).toBeNull()
  })
})
