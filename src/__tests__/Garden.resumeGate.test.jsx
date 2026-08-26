// V4-PERFTHEMEA-001 — Garden's resume age gate.
//
// MEASURED BEFORE: alt-tabbing back into Garden re-fired GET /api/critters/active and
// GET /api/notifications/prefs on EVERY visibilitychange, with no age gate — while the three
// cached lists on the same page (projects / plants?view=grid / locations) had been gated at
// RESUME_MIN_AGE_MS since dataCache shipped. Two uncached round trips on a cold radio for a glance
// at another app and back.
//
// WHAT THIS FILE PINS, and why each half is needed:
//   · inside the window  → ZERO gated reads. Without this the gate can be deleted and stay green.
//   · outside the window → the reads DO happen. Without this a gate that never opens (the obvious
//     regression: an inverted comparison) also stays green, and the page silently stops
//     revalidating for the whole session.
//   · the analytics POST fires either way. It is a WRITE, not a round trip the user waits on;
//     gating it would quietly redefine what garden-view telemetry counts.
//   · the constant is IMPORTED from useCacheLifecycle, not restated. Asserting against a local
//     literal would let the page and the cache layer disagree about "too stale" and pass.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RESUME_MIN_AGE_MS } from '../hooks/useCacheLifecycle.js'

vi.mock('react-router-dom', () => {
  const sp = new URLSearchParams()
  return {
    Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
    useLocation: () => ({ pathname: '/garden', search: '', state: null }),
    useNavigate: () => () => {},
    useSearchParams: () => [sp, () => {}],
  }
})

const fetchMock = vi.fn()
const getTokenMock = vi.fn().mockResolvedValue('test-token')
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }), apiFetch: (...a) => fetchMock(...a) }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))

const fetchActiveCrittersMock = vi.fn()
const markCrittersViewedMock = vi.fn()
const patchSpeciesPrefsMock = vi.fn()
vi.mock('../lib/critterClient.js', () => ({
  fetchActiveCritters: (...a) => fetchActiveCrittersMock(...a),
  markCrittersViewed: (...a) => markCrittersViewedMock(...a),
  patchSpeciesPrefs: (...a) => patchSpeciesPrefsMock(...a),
}))

const fetchPrefsMock = vi.fn()
const recordGardenViewOpenedMock = vi.fn()
vi.mock('../lib/notificationPrefsClient.js', () => ({
  fetchNotificationPrefs: (...a) => fetchPrefsMock(...a),
  recordGardenViewOpened: (...a) => recordGardenViewOpenedMock(...a),
  recordCoachmarkDismissed: vi.fn(),
  recordOptInDismissed: vi.fn(),
  CRITTER_VISIT_VALUES: ['off', 'in_app_only', 'system'],
  GARDEN_GROUP_BY_VALUES: ['none', 'type', 'lifecycle', 'heat', 'determinacy', 'day_length', 'allium_type', 'basil_use', 'location', 'group', 'freeform', 'status'],
  GARDEN_SORT_ORDER_VALUES: ['alpha', 'recency'],
  GARDEN_EXPANDED_MAX: 2000,
  patchNotificationPrefs: vi.fn(),
  saveGardenGroupBy: vi.fn(),
  saveGardenSortOrder: vi.fn(),
  saveGardenExpanded: vi.fn(),
}))

vi.mock('../components/CritterSprite.jsx', () => ({ default: () => <span data-testid="critter-sprite" /> }))
vi.mock('../components/LoveMehPopover.jsx', () => ({ default: () => null }))

import Garden from '../pages/Garden.jsx'

const PROJECTS = [{ id: 'a', name: 'Tomatoes', status: 'active', parent_project_id: null, is_public: true }]
const PLANTS = [{ id: 'p1', name: 'Sungold', project_id: 'a', status: 'growing', quantity: 1 }]

const realNow = Date.now

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  fetchActiveCrittersMock.mockReset().mockResolvedValue([])
  markCrittersViewedMock.mockReset()
  fetchPrefsMock.mockReset().mockResolvedValue({ critter_visit: 'in_app_only', last_garden_view_at: null, coachmark_seen_at: null, opt_in_prompt_seen_at: null })
  recordGardenViewOpenedMock.mockReset()
  fetchMock.mockImplementation((url) =>
    Promise.resolve(url === '/api/projects' ? PROJECTS : url === '/api/plants?view=grid' ? PLANTS : []))
})

afterEach(() => { Date.now = realNow; cleanup() })

async function renderGarden() {
  await act(async () => { render(<Garden />) })
  await screen.findByText(/Log many/)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

// The gate reads wall-clock Date.now, so a resume is simulated by moving the clock rather than by
// waiting. Fake timers are avoided on purpose: this component's mount path awaits real promises.
async function resumeAfter(ms) {
  const t0 = realNow()
  Date.now = () => t0 + ms
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve(); await Promise.resolve()
  })
}

describe('Garden resume age gate (V4-PERFTHEMEA-001)', () => {
  it('a resume INSIDE the age window issues zero gated reads', async () => {
    await renderGarden()
    expect(fetchActiveCrittersMock).toHaveBeenCalledTimes(1)   // the mount, which is never gated
    expect(fetchPrefsMock).toHaveBeenCalledTimes(1)

    await resumeAfter(RESUME_MIN_AGE_MS - 1000)

    expect(fetchActiveCrittersMock).toHaveBeenCalledTimes(1)
    expect(fetchPrefsMock).toHaveBeenCalledTimes(1)
  })

  it('a resume OUTSIDE the age window issues them', async () => {
    // The other half of the gate. A gate that never opens is as broken as no gate at all, and it
    // fails in the direction nobody notices: stale data with no request to explain it.
    await renderGarden()
    await resumeAfter(RESUME_MIN_AGE_MS + 1000)

    expect(fetchActiveCrittersMock).toHaveBeenCalledTimes(2)
    expect(fetchPrefsMock).toHaveBeenCalledTimes(2)
  })

  it('records the garden-view analytics POST on a gated resume too', async () => {
    // Deliberately NOT gated: it is a write, and gating it would silently stop counting quick
    // returns as garden views.
    await renderGarden()
    const before = recordGardenViewOpenedMock.mock.calls.length
    await resumeAfter(RESUME_MIN_AGE_MS - 1000)
    expect(recordGardenViewOpenedMock.mock.calls.length).toBe(before + 1)
  })

  it('re-arms: a second resume past the window after a gated one does read', async () => {
    await renderGarden()
    await resumeAfter(RESUME_MIN_AGE_MS - 1000)
    expect(fetchPrefsMock).toHaveBeenCalledTimes(1)
    // Measured from the last read, not from the last resume — a gated resume must not restart the
    // clock, or a tab flapping every 4 minutes would never revalidate at all.
    await resumeAfter(RESUME_MIN_AGE_MS + 1000)
    expect(fetchPrefsMock).toHaveBeenCalledTimes(2)
    expect(fetchActiveCrittersMock).toHaveBeenCalledTimes(2)
  })

  it('a hidden→ transition is not a resume and reads nothing', async () => {
    await renderGarden()
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      await resumeAfter(RESUME_MIN_AGE_MS + 1000)
      expect(fetchPrefsMock).toHaveBeenCalledTimes(1)
      expect(fetchActiveCrittersMock).toHaveBeenCalledTimes(1)
    } finally {
      hidden.mockRestore()
    }
  })

  it('uses the cache layer\'s constant, not a second copy of it', () => {
    // One answer to "how stale is too stale". If this ever needs changing it changes in
    // useCacheLifecycle.js and both the cached and uncached halves of the page move together.
    expect(RESUME_MIN_AGE_MS).toBe(5 * 60 * 1000)
    const src = readFileSync(resolve(process.cwd(), 'src/pages/Garden.jsx'), 'utf8')
    expect(src).toContain("import { RESUME_MIN_AGE_MS } from '../hooks/useCacheLifecycle.js'")
    // No locally-defined threshold shadowing the import.
    expect(src).not.toMatch(/const\s+RESUME_MIN_AGE_MS\s*=/)
  })
})
