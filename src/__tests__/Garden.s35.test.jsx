import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'

// Mock react-router-dom to avoid Router context.
vi.mock('react-router-dom', () => {
  const sp = new URLSearchParams()
  return {
    Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
    useLocation: () => ({ pathname: '/garden', search: '', state: null }),
    useNavigate: () => () => {},
    useSearchParams: () => [sp, () => {}],
  }
})

// Mock useApiFetch to return both fetch + getToken (production shape).
const fetchMock = vi.fn()
const getTokenMock = vi.fn().mockResolvedValue('test-token')
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }), apiFetch: (...a) => fetchMock(...a) }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))

// Mock critterClient — capture markCrittersViewed calls.
const fetchActiveCrittersMock = vi.fn()
const markCrittersViewedMock = vi.fn()
const patchSpeciesPrefsMock = vi.fn()
vi.mock('../lib/critterClient.js', () => ({
  fetchActiveCritters: (...a) => fetchActiveCrittersMock(...a),
  markCrittersViewed: (...a) => markCrittersViewedMock(...a),
  patchSpeciesPrefs: (...a) => patchSpeciesPrefsMock(...a),
}))

// Mock CritterSprite — synchronously invoke onIntersect with the critter prop on mount,
// so we can test Garden's accumulator wiring without the IntersectionObserver.
vi.mock('../components/CritterSprite.jsx', () => ({
  default: ({ critter, onIntersect }) => {
    React.useEffect(() => {
      if (typeof onIntersect === 'function' && critter) onIntersect(critter)
    }, [critter, onIntersect])
    return <span data-testid="critter-sprite" data-critter-id={critter?.id ?? ''} />
  },
}))

// Mock LoveMehPopover — passive renderer. (BaselineResidents retired V101 2026-06-01.)
vi.mock('../components/LoveMehPopover.jsx', () => ({ default: () => null }))

import Garden from '../pages/Garden.jsx'

const PROJECTS = [
  { id: 'a', name: 'Tomatoes', status: 'active', parent_project_id: null, is_public: true },
]
const PLANTS = [
  { id: 'p1', name: 'Sungold', project_id: 'a', status: 'growing', quantity: 1 },
  { id: 'p2', name: 'Black Krim', project_id: 'a', status: 'growing', quantity: 1 },
]
const CRITTERS = [
  { id: 'c-aaa', species_id: 3, plant_id: 'p1', target_id: 'p1', target_kind: 'plant',
    earned_at: new Date().toISOString(), viewed_at: null, dot_visible_after: new Date().toISOString() },
  { id: 'c-bbb', species_id: 4, plant_id: 'p2', target_id: 'p2', target_kind: 'plant',
    earned_at: new Date().toISOString(), viewed_at: null, dot_visible_after: new Date().toISOString() },
]

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  fetchActiveCrittersMock.mockReset()
  markCrittersViewedMock.mockReset()
  patchSpeciesPrefsMock.mockReset()
  fetchMock.mockImplementation((url) =>
    Promise.resolve(url === '/api/projects' ? PROJECTS : url === '/api/plants' ? PLANTS : []))
  fetchActiveCrittersMock.mockResolvedValue(CRITTERS)
  markCrittersViewedMock.mockResolvedValue([])
})

afterEach(() => { cleanup() })

async function renderGarden() {
  await act(async () => { render(<Garden />) })
  await screen.findByText(/Log many/)
  // Expand Tomatoes so plantings (and critter sprites) render.
  await act(async () => {
    screen.getByLabelText(/Expand Tomatoes/).click()
  })
}

describe('Garden Session 3.5 — per-sprite actually_seen accumulator (§3.26)', () => {
  it('on unmount, flushes with actuallySeenCritterIds = ids of all sprites that intersected', async () => {
    const { unmount } = await act(async () => render(<Garden />))
    await screen.findByText(/Log many/)
    await act(async () => { screen.getByLabelText(/Expand Tomatoes/).click() })
    // Wait a microtask for the mocked CritterSprite's onIntersect useEffect.
    await act(async () => { await Promise.resolve() })
    // Now unmount.
    await act(async () => { unmount() })
    expect(markCrittersViewedMock).toHaveBeenCalled()
    const lastCall = markCrittersViewedMock.mock.calls.at(-1)[0]
    expect(lastCall.actuallySeenCritterIds).toBeInstanceOf(Array)
    expect(lastCall.actuallySeenCritterIds).toEqual(expect.arrayContaining(['c-aaa', 'c-bbb']))
    expect(lastCall.actuallySeenCritterIds).toHaveLength(2)
    // Race-window header source = gardenOpenedAtRef ISO string.
    expect(typeof lastCall.openedAt).toBe('string')
    expect(lastCall.openedAt).toMatch(/T.*Z$/)
  })

  it('on visibilitychange → hidden, flushes accumulated ids', async () => {
    await renderGarden()
    await act(async () => { await Promise.resolve() })
    // Fire visibility change to hidden.
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(markCrittersViewedMock).toHaveBeenCalled()
    const call = markCrittersViewedMock.mock.calls.find(([arg]) =>
      Array.isArray(arg.actuallySeenCritterIds) && arg.actuallySeenCritterIds.length > 0
    )
    expect(call).toBeDefined()
    expect(call[0].actuallySeenCritterIds).toEqual(expect.arrayContaining(['c-aaa', 'c-bbb']))
  })

  it('visibilitychange → visible does NOT flush', async () => {
    await renderGarden()
    await act(async () => { await Promise.resolve() })
    markCrittersViewedMock.mockClear()
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    // The visibility→visible already had a refresh listener wired pre-S3.5; it must NOT call markCrittersViewed.
    expect(markCrittersViewedMock).not.toHaveBeenCalled()
  })

  it('after a hidden-flush, accumulator is drained → second flush has empty/null ids (bulk fallback)', async () => {
    await renderGarden()
    await act(async () => { await Promise.resolve() })
    // First flush (hidden) — drains accumulator.
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    markCrittersViewedMock.mockClear()
    // Second flush (still hidden) — accumulator now empty → actuallySeenCritterIds === null.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(markCrittersViewedMock).toHaveBeenCalledTimes(1)
    expect(markCrittersViewedMock.mock.calls[0][0].actuallySeenCritterIds).toBeNull()
  })

  it('when no sprites intersect (e.g., empty garden), unmount flush passes actuallySeenCritterIds=null', async () => {
    // Override critters fetch to return [] for this test.
    fetchActiveCrittersMock.mockResolvedValue([])
    const { unmount } = await act(async () => render(<Garden />))
    await screen.findByText(/Log many/)
    await act(async () => { await Promise.resolve() })
    markCrittersViewedMock.mockClear()
    await act(async () => { unmount() })
    expect(markCrittersViewedMock).toHaveBeenCalledTimes(1)
    expect(markCrittersViewedMock.mock.calls[0][0].actuallySeenCritterIds).toBeNull()
  })
})
