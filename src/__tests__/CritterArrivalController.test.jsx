import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'

// Stage 1 flash coverage. Relocated 2026-06-01 from Dashboard.critter-backfill.test.jsx:
// the Stage-1 backfill effect moved out of Dashboard.jsx into the global CritterArrivalController
// at commit d3448d9 (2026-05-30, "reward redesign — global CritterArrival flash"), which orphaned
// the Dashboard test. This file tests the live owner of that logic + the V101 baseline-retirement
// change (robin/honeybee species 1-2 now animate; the species_id<=2 exclusion was removed).

const mockLocation = { pathname: '/garden', state: null }
vi.mock('react-router-dom', () => ({ useLocation: () => mockLocation }))

const getTokenMock = vi.fn().mockResolvedValue('tk')
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ getToken: getTokenMock }) }))

const fetchActiveCrittersMock = vi.fn()
vi.mock('../lib/critterClient.js', () => ({ fetchActiveCritters: (...a) => fetchActiveCrittersMock(...a) }))

// CritterArrival renders the arriving critter; expose its id when present.
vi.mock('../components/CritterArrival.jsx', () => ({
  default: ({ critter }) => critter ? <div data-testid="critter-arrival" data-critter-id={critter.id} /> : null,
}))

import CritterArrivalController from '../components/CritterArrivalController.jsx'

function critter(over = {}) {
  return {
    id: 'c-fresh', species_id: 3, plant_id: 'p1', target_id: 'p1', target_kind: 'plant',
    earned_at: new Date().toISOString(), viewed_at: null, dot_visible_after: new Date().toISOString(), ...over,
  }
}

beforeEach(() => { sessionStorage.clear(); fetchActiveCrittersMock.mockReset() })
afterEach(() => { cleanup() })

async function renderController() {
  await act(async () => { render(<CritterArrivalController />) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('CritterArrivalController — global Stage 1 flash (relocated from Dashboard backfill)', () => {
  it('renders Stage 1 arrival when a fresh critter is active', async () => {
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-fresh', species_id: 3 })])
    await renderController()
    const el = screen.queryByTestId('critter-arrival')
    expect(el).not.toBeNull()
    expect(el?.getAttribute('data-critter-id')).toBe('c-fresh')
  })

  it('V101: renders Stage 1 for robin/honeybee (species 1-2) — baselines retired, they now animate', async () => {
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'b1', species_id: 1 })])
    await renderController()
    expect(screen.queryByTestId('critter-arrival')?.getAttribute('data-critter-id')).toBe('b1')
  })

  it('does NOT render when the critter was earned long ago (fresh window expired)', async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString()  // 10min > 5min FRESH_WINDOW_MS
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-old', earned_at: old })])
    await renderController()
    expect(screen.queryByTestId('critter-arrival')).toBeNull()
  })

  it('does NOT render when the critter is already viewed', async () => {
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-viewed', viewed_at: new Date().toISOString() })])
    await renderController()
    expect(screen.queryByTestId('critter-arrival')).toBeNull()
  })

  it('picks the FRESHEST critter when multiple are active', async () => {
    const t1 = new Date(Date.now() - 5000).toISOString()
    const t2 = new Date(Date.now() - 1000).toISOString()
    fetchActiveCrittersMock.mockResolvedValue([
      critter({ id: 'c-older', species_id: 3, earned_at: t1 }),
      critter({ id: 'c-newer', species_id: 5, earned_at: t2 }),
    ])
    await renderController()
    expect(screen.queryByTestId('critter-arrival')?.getAttribute('data-critter-id')).toBe('c-newer')
  })

  it('sessionStorage de-dup: does NOT re-render a critter already in shown list', async () => {
    sessionStorage.setItem('gardenApp.stage1ShownIds', JSON.stringify(['c-fresh']))
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-fresh' })])
    await renderController()
    expect(screen.queryByTestId('critter-arrival')).toBeNull()
  })

  it('after rendering, persists critter id to sessionStorage for de-dup', async () => {
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-fresh' })])
    await renderController()
    const shown = JSON.parse(sessionStorage.getItem('gardenApp.stage1ShownIds') ?? '[]')
    expect(shown).toContain('c-fresh')
  })

  it('caps stored shown-ids list to 50 entries', async () => {
    const initial = Array.from({ length: 60 }, (_, i) => `c-${i}`)
    sessionStorage.setItem('gardenApp.stage1ShownIds', JSON.stringify(initial))
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-fresh-new' })])
    await renderController()
    const shown = JSON.parse(sessionStorage.getItem('gardenApp.stage1ShownIds') ?? '[]')
    expect(shown.length).toBeLessThanOrEqual(50)
    expect(shown).toContain('c-fresh-new')
  })

  it('fetchActiveCritters returning [] is a no-op', async () => {
    fetchActiveCrittersMock.mockResolvedValue([])
    await renderController()
    expect(screen.queryByTestId('critter-arrival')).toBeNull()
  })

  it('fetchActiveCritters throwing is a no-op (never crashes)', async () => {
    fetchActiveCrittersMock.mockRejectedValue(new Error('network'))
    await renderController()
    expect(screen.queryByTestId('critter-arrival')).toBeNull()
  })

  it('V3-CRITTER-002: re-polls when location.state changes (LogMany batch trigger)', async () => {
    // Simulates: LogMany.confirm() calls navigate('.', { state: { critterCheck: Date.now() }, replace: true })
    // after a successful batch POST. The controller fires on location.state dep change, polling
    // for the newly-awarded critter without a pathname change.
    fetchActiveCrittersMock.mockResolvedValue([])
    let rerender
    await act(async () => {
      const r = render(<CritterArrivalController />)
      rerender = r.rerender
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(fetchActiveCrittersMock).toHaveBeenCalledTimes(1)

    // Simulate the navigate state push from LogMany (same pathname, new state object).
    mockLocation.state = { critterCheck: 999 }
    await act(async () => {
      rerender(<CritterArrivalController />)
      await Promise.resolve(); await Promise.resolve()
    })
    expect(fetchActiveCrittersMock).toHaveBeenCalledTimes(2)

    mockLocation.state = null  // reset for subsequent tests
  })
})
