// V5-TODAYREDESIGN-001 — the preview switch as SHIPPED until the phone-comparison slice (S8a): featureFlags
// TODAY_V2_PREVIEW_ROW is false, so Debug & smoke shows no "New Today (preview)" row and /today ignores a
// stored garden.todayV2 (a phone that turned the preview on earlier is not held on the unfinished page with no
// row to turn it off). The row and the chooser with the constant TRUE are TodayRoute.test.jsx's.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../pages/Today.jsx', () => ({ default: () => <div data-testid="today-v1" /> }))
vi.mock('../pages/TodayV2.jsx', () => ({ default: () => <div data-testid="today-v2" /> }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(async () => ({})) }) }))

import TodayRoute from '../components/today/v2/TodayRoute.jsx'
import DebugMenu from '../pages/DebugMenu.jsx'
import { TODAY_V2_PREVIEW_ROW } from '../lib/featureFlags.js'
import { readTodayV2Flag } from '../lib/todayV2Flag.js'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => cleanup())

describe('the preview row, hidden until S8a (TODAY_V2_PREVIEW_ROW false)', () => {
  it('ships false — flipping it is the S8a change, made on purpose with this test', () => {
    expect(TODAY_V2_PREVIEW_ROW).toBe(false)
  })

  it('Debug & smoke renders no "New Today (preview)" row', () => {
    render(<MemoryRouter><DebugMenu /></MemoryRouter>)
    expect(screen.getByText('Debug & smoke')).toBeTruthy()
    expect(screen.queryByTestId('debug-today-v2')).toBeNull()
    expect(screen.queryByRole('button', { name: /New Today \(preview\)/ })).toBeNull()
  })

  it('/today stays the current Today with garden.todayV2 stored "1" — the stale flag is ignored, not deleted', () => {
    localStorage.setItem('garden.todayV2', '1')
    expect(readTodayV2Flag()).toBe(true)
    render(<TodayRoute />)
    expect(screen.getByTestId('today-v1')).toBeTruthy()
    expect(screen.queryByTestId('today-v2')).toBeNull()
    expect(localStorage.getItem('garden.todayV2')).toBe('1')
  })
})
