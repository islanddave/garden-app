// BUG-GARDENGROUPBYRESET-001 — Garden forgets the grouping: every return to the tab flipped it to Lifecycle.
//
// Dave, 2026-09-29 (prod v4.158.1): "It should ALWAYS remember my last grouping. If I was last in Type, it
// should stay type, if I was last in lifecycle, it should stay with lifecycle, etc."
//
// THE CAUSE, as this file reproduces it. The Type option's value is `crop_type`, and it was in NEITHER
// allow-list: the prefs client refused to send it, so the server kept an older choice (Dave's row said
// 'status', Lifecycle). Every Garden mount then ran the one-shot prefs hydrate, adopted that server value
// over the local choice, and regrouped the list AFTER the scroll restore — so the spot went with it.
//
// NOTHING IS STUBBED AT THE PREFS MODULE EDGE: the real fetchNotificationPrefs / saveGardenGroupBy run and
// only `fetch` is faked, as a server WITH STATE (a PATCH changes what the next GET answers). The allow-list is
// half the bug, so a stubbed client would test nothing. Each mount/unmount pair is a "come back to the Garden
// tab"; the weak-radio cases fail the PATCH the way a dead zone does (fetch rejects).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'

// The prefs client reads its base URL at module load, so it is set before any import runs and put back
// afterwards (AdminConfig.refreshJoin.test.jsx's shape).
const { prevBase } = vi.hoisted(() => {
  const prevBase = process.env.VITE_API_CRITTERS
  process.env.VITE_API_CRITTERS = 'https://critter.test'
  return { prevBase }
})
afterAll(() => {
  if (prevBase === undefined) delete process.env.VITE_API_CRITTERS
  else process.env.VITE_API_CRITTERS = prevBase
})

vi.mock('react-router-dom', () => {
  const sp = new URLSearchParams()
  return {
    Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
    useLocation: () => ({ pathname: '/garden', search: '', state: null }),
    useNavigate: () => () => {},
    useSearchParams: () => [sp, () => {}],
  }
})
// Stable identities, as the real hook's are: Garden's prefs and critter effects are keyed on getToken, so a
// fresh function per render would re-run them forever.
const fetchMock = vi.fn()
const getToken = async () => 'token'
vi.mock('../lib/api.js', async (orig) => ({
  ...(await orig()),
  useApiFetch: () => ({ fetch: fetchMock, getToken }),
  apiFetch: (...a) => fetchMock(...a),
}))
// Whose choice a pending save is: Garden reads the signed-in person from here. One object per person, as a
// provider's value is: a fresh object per call would re-fire every effect keyed on it.
const auth = vi.hoisted(() => ({ id: 'user_dave', byId: {} }))
vi.mock('../context/AuthContext.jsx', async (orig) => {
  const real = await orig()
  const value = () => (auth.byId[auth.id] ??= {
    user: { id: auth.id }, profile: { id: auth.id, display_name: 'Dave' }, loading: false, identity: 'signed-in',
  })
  return { ...real, useAuth: value, useAuthOptional: value }
})
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/CritterSprite.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/LoveMehPopover.jsx', () => ({ default: () => null }))

import Garden from '../pages/Garden.jsx'
import { __resetPrefsFlight } from '../lib/notificationPrefsClient.js'
import { RESUME_MIN_AGE_MS } from '../hooks/useCacheLifecycle.js'

const PLANTS = [
  { id: 'p1', name: 'Sungold', project_id: null, status: 'fruiting', quantity: 1, variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'p2', name: 'Jalapeño', project_id: null, status: 'growing', quantity: 1, variety_ref: { crop_type_slug: 'pepper' } },
]
const GROUPBY_KEY = 'garden.groupBy.v1'
const PENDING_KEY = 'garden.groupBy.pending'

// ── the far side of the wire, with state ─────────────────────────────────────────────────────────────
let server          // the stored prefs row
let patches         // every PATCH body that reached the wire, in order
let gets            // prefs GETs answered
let radio           // 'up' | 'down' — down rejects every PATCH (a dead zone), GETs still answer
let servedFromSW    // the next GET answers as the service worker's cached copy (X-From-Cache)
const answer = (body, headers = {}) => ({
  ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)),
  headers: { get: (k) => headers[k] ?? null },
})
beforeEach(() => {
  server = { critter_visit: 'in_app_only', garden_group_by: 'status', garden_expanded: null, last_garden_view_at: null, coachmark_seen_at: null, opt_in_prompt_seen_at: null }
  patches = []
  gets = 0
  radio = 'up'
  servedFromSW = null
  auth.id = 'user_dave'
  __resetPrefsFlight()
  localStorage.clear()
  fetchMock.mockReset()
  fetchMock.mockImplementation((url) => Promise.resolve(
    url === '/api/plants?view=grid' ? PLANTS : url === '/api/members' ? { members: [] } : [],
  ))
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url)
    const method = init.method || 'GET'
    if (u.endsWith('/api/notifications/prefs')) {
      if (method === 'PATCH') {
        const body = JSON.parse(init.body)
        patches.push(body)
        if (radio === 'down') throw new TypeError('Failed to fetch')
        server = { ...server, ...body }
        return answer(server)
      }
      gets += 1
      if (servedFromSW) { const b = servedFromSW; servedFromSW = null; return answer(b, { 'X-From-Cache': '1' }) }
      return answer(server)
    }
    if (u.endsWith('/api/critters/active')) return answer([])
    if (u.endsWith('/api/notifications/garden-view-opened')) return answer({ last_garden_view_at: null })
    if (u.endsWith('/api/critters/viewed')) return answer([])
    throw new Error(`unexpected ${method} ${u}`)
  }))
})
const realNow = Date.now
afterEach(() => { Date.now = realNow; cleanup(); vi.unstubAllGlobals() })

// Back to the app after a while away: Garden re-reads prefs on a resume past its age gate (useResumeGate). The
// gate reads wall-clock Date.now, so the clock is moved rather than waited on (Garden.resumeGate.test.jsx's way).
async function resumeAfter(ms) {
  const t0 = realNow()
  Date.now = () => t0 + ms
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await flush()
}

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
const groupBySelect = () => screen.getByRole('combobox', { name: /Group by/i })
// One visit to the Garden tab: mount, let the prefs read land, hand back unmount.
async function visitGarden() {
  let utils
  await act(async () => { utils = render(<Garden />) })
  await screen.findByText(/Log many/)
  await flush()
  return utils
}
async function pick(value) {
  await act(async () => { fireEvent.change(groupBySelect(), { target: { value } }) })
  await flush()
}
const groupPatches = () => patches.filter(b => Object.hasOwn(b, 'garden_group_by')).map(b => b.garden_group_by)

describe('BUG-GARDENGROUPBYRESET-001 — Garden keeps the grouping you left it in', () => {
  it('a Type pick reaches the server (crop_type is sendable)', async () => {
    await visitGarden()
    expect(groupBySelect().value).toBe('status')            // the server's Lifecycle, adopted on a first visit
    await pick('crop_type')
    expect(groupPatches()).toEqual(['crop_type'])
    expect(server.garden_group_by).toBe('crop_type')
  })

  it('Type survives every return to the tab while the server started on Lifecycle', async () => {
    const first = await visitGarden()
    await pick('crop_type')
    first.unmount()
    for (let trip = 0; trip < 2; trip++) {
      const again = await visitGarden()
      expect(gets).toBeGreaterThanOrEqual(2 + trip)          // the prefs read did land on this visit
      expect(groupBySelect().value).toBe('crop_type')
      expect(localStorage.getItem(GROUPBY_KEY)).toBe('crop_type')
      again.unmount()
    }
  })

  it('weak radio: a save that never landed keeps the choice across returns and re-sends it', async () => {
    const first = await visitGarden()
    radio = 'down'
    await pick('crop_type')
    expect(groupPatches()).toEqual(['crop_type'])            // tried, and the dead zone ate it
    expect(server.garden_group_by).toBe('status')
    first.unmount()

    const second = await visitGarden()                     // server still says Lifecycle
    expect(groupBySelect().value).toBe('crop_type')
    expect(groupPatches()).toEqual(['crop_type', 'crop_type'])   // re-sent, still no signal
    second.unmount()

    radio = 'up'
    const third = await visitGarden()
    expect(groupBySelect().value).toBe('crop_type')
    expect(server.garden_group_by).toBe('crop_type')       // the retry finally landed
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()   // …and only a confirmed save cleared it
    third.unmount()

    const fourth = await visitGarden()
    expect(groupBySelect().value).toBe('crop_type')
    expect(groupPatches()).toEqual(['crop_type', 'crop_type', 'crop_type'])  // nothing left to send
    fourth.unmount()
  })

  it('the pending marker is written before the save and cleared only by its confirmation', async () => {
    await visitGarden()
    radio = 'down'
    await pick('location')
    expect(JSON.parse(localStorage.getItem(PENDING_KEY))).toEqual({ user: 'user_dave', value: 'location' })
    radio = 'up'
    await pick('crop_type')
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
    expect(server.garden_group_by).toBe('crop_type')
  })

  it('a prefs body the service worker served from its cache never regroups the list', async () => {
    const first = await visitGarden()
    await pick('crop_type')                                // confirmed: server now says Type
    first.unmount()
    servedFromSW = { ...server, garden_group_by: 'status' } // offline: a days-old copy answers instead
    await visitGarden()
    expect(groupBySelect().value).toBe('crop_type')
    expect(localStorage.getItem(GROUPBY_KEY)).toBe('crop_type')
  })

  it('another device\'s choice is still adopted when nothing is pending here', async () => {
    const first = await visitGarden()
    await pick('location')
    first.unmount()
    server.garden_group_by = 'status'                      // changed on the other phone
    await visitGarden()
    expect(groupBySelect().value).toBe('status')
    expect(localStorage.getItem(GROUPBY_KEY)).toBe('status')
  })

  it('a server value Garden cannot offer is not adopted', async () => {
    const first = await visitGarden()
    await pick('location')
    first.unmount()
    server.garden_group_by = 'none'                        // Projects: retired under PROJECTS_HIDDEN
    await visitGarden()
    expect(groupBySelect().value).toBe('location')
    expect(localStorage.getItem(GROUPBY_KEY)).toBe('location')
  })

  it('a server value equal to the local one writes nothing', async () => {
    const first = await visitGarden()
    await pick('crop_type')
    first.unmount()
    // Watch every storage write the next visit makes. The global is swapped rather than the prototype
    // spied: setup.ts may have installed a plain-object shim that a prototype spy would silently miss.
    const real = globalThis.localStorage
    const writes = []
    const watched = {
      getItem: (k) => real.getItem(k),
      setItem: (k, v) => { writes.push(k); real.setItem(k, v) },
      removeItem: (k) => { writes.push(k); real.removeItem(k) },
      clear: () => real.clear(),
      key: (i) => real.key(i),
      get length() { return real.length },
    }
    Object.defineProperty(globalThis, 'localStorage', { value: watched, configurable: true, writable: true })
    try {
      await visitGarden()
      expect(groupBySelect().value).toBe('crop_type')
      expect(writes.filter(k => k.startsWith('garden.groupBy'))).toEqual([])
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: real, configurable: true, writable: true })
    }
  })

  it('another person\'s unsent choice is never sent under this person\'s token', async () => {
    localStorage.setItem(GROUPBY_KEY, 'location')
    localStorage.setItem(PENDING_KEY, JSON.stringify({ user: 'user_jen', value: 'location' }))
    await visitGarden()
    expect(groupPatches()).toEqual([])
    expect(groupBySelect().value).toBe('status')           // this person's own server choice
  })

  it('the first fresh read ends the hydrate for the visit: a later change waits for the next visit, never mid-list', async () => {
    const first = await visitGarden()
    await pick('location')
    first.unmount()
    await visitGarden()                                    // fresh read, equal: decided, and done for this visit
    const reads = gets
    server.garden_group_by = 'status'                      // the other phone changes it while this one is open
    await resumeAfter(RESUME_MIN_AGE_MS + 1000)
    expect(gets).toBe(reads + 1)                           // the resume did read…
    expect(groupBySelect().value).toBe('location')         // …and did not regroup the list under the user
  })

  it('a service-worker copy does not end it: a fresh read on a later resume still gets its say', async () => {
    const first = await visitGarden()
    await pick('location')
    first.unmount()
    server.garden_group_by = 'status'                      // the other phone's choice, not yet seen here
    servedFromSW = { ...server, garden_group_by: 'location' }  // offline: this visit's read is the cached copy
    await visitGarden()
    expect(groupBySelect().value).toBe('location')
    await resumeAfter(RESUME_MIN_AGE_MS + 1000)            // signal back: a fresh read
    expect(groupBySelect().value).toBe('status')
  })

  it('a Type choice made before this build (never sendable) is kept and sent, not overwritten', async () => {
    // What a phone carries into this release: Type stored locally, never sent, the server on Lifecycle.
    localStorage.setItem(GROUPBY_KEY, 'crop_type')
    const first = await visitGarden()
    expect(groupBySelect().value).toBe('crop_type')
    expect(groupPatches()).toEqual(['crop_type'])
    expect(server.garden_group_by).toBe('crop_type')
    first.unmount()
    await visitGarden()
    expect(groupBySelect().value).toBe('crop_type')
  })
})
