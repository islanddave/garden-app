// V5-TODAYREDESIGN-001 — the row and the default as SHIPPED. featureFlags TODAY_V2_PREVIEW_ROW (Dave's D14,
// 2026-09-29, design-todayux-V100-20260928.md round 4) and TODAY_V2_DEFAULT (S8b / L7: the redesign is the
// default) are both TRUE and NOT mocked here, so this file reds if either is flipped. Debug & smoke shows "New
// Today on this phone" to both users, on, its subtitle saying how to use the old page, and the switch drives
// /today on this phone. The false branch of the row is TodayRoute.previewHidden.test.jsx's; the switch's finer
// behaviour is TodayRoute.test.jsx's.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../pages/Today.jsx', () => ({ default: () => <div data-testid="today-v1" /> }))
vi.mock('../pages/TodayV2.jsx', () => ({ default: () => <div data-testid="today-v2" /> }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(async () => ({})) }) }))

import TodayRoute from '../components/today/v2/TodayRoute.jsx'
import DebugMenu from '../pages/DebugMenu.jsx'
import { TODAY_V2_PREVIEW_ROW, TODAY_V2_DEFAULT } from '../lib/featureFlags.js'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => cleanup())

describe('the row and the default as shipped (D14 row visible to both users; S8b redesign by default)', () => {
  it('both ship true — hiding the row or undoing the default is a deliberate flip, made with this test', () => {
    expect(TODAY_V2_PREVIEW_ROW).toBe(true)
    expect(TODAY_V2_DEFAULT).toBe(true)
  })

  it('Debug & smoke renders the row, on, its subtitle saying how to use the old page, and it toggles', () => {
    render(<MemoryRouter><DebugMenu /></MemoryRouter>)
    const t = screen.getByRole('button', { name: /^New Today on this phone/ })
    expect(t).toBe(screen.getByTestId('debug-today-v2'))
    const sub = screen.getByText(/^Now the standard Today page\./)
    expect(t.contains(sub)).toBe(true)
    expect(sub.textContent).toContain('Only this phone changes; turn it off to use the old page.')
    expect(screen.queryByText(/Early preview/)).toBeNull()
    expect(t.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(t)
    expect(localStorage.getItem('garden.todayV2')).toBe('0')
    expect(t.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(t)
    expect(localStorage.getItem('garden.todayV2')).toBe('1')
    expect(t.getAttribute('aria-pressed')).toBe('true')
  })

  it('the switch reaches /today: the redesign first, off → the old Today, on → the redesign', () => {
    render(<><MemoryRouter><DebugMenu /></MemoryRouter><TodayRoute /></>)
    expect(screen.getByTestId('today-v2')).toBeTruthy()
    expect(screen.queryByTestId('today-v1')).toBeNull()
    fireEvent.click(screen.getByTestId('debug-today-v2'))
    expect(screen.getByTestId('today-v1')).toBeTruthy()
    expect(screen.queryByTestId('today-v2')).toBeNull()
    fireEvent.click(screen.getByTestId('debug-today-v2'))
    expect(screen.getByTestId('today-v2')).toBeTruthy()
    expect(screen.queryByTestId('today-v1')).toBeNull()
  })

  it('a phone that turned the preview on before S8b ("1" stored) stays on the redesign', () => {
    localStorage.setItem('garden.todayV2', '1')
    render(<TodayRoute />)
    expect(screen.getByTestId('today-v2')).toBeTruthy()
  })
})
