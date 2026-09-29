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
let gets            // prefs GETs sent
let radio           // 'up' | 'down' — down rejects every PATCH (a dead zone), GETs still answer
let servedFromSW    // the next GET answers as the service worker's cached copy (X-From-Cache)
let holds           // requests parked by hold(): the next GET / PATCH waits for its release
const answer = (body, headers = {}) => ({
  ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)),
  headers: { get: (k) => headers[k] ?? null },
})
// Park the next request of `method` until the returned release is awaited. A parked GET answers with the row
// as it stood when it was SENT (a read that left before a save carries the row from before it); a parked
// PATCH is applied only when released (a slow save). AdminConfig.refreshJoin.test.jsx's shape.
function hold(method) {
  let release
  holds[method].push(new Promise(r => { release = r }))
  return async () => { release(); await flush() }
}
beforeEach(() => {
  server = { critter_visit: 'in_app_only', garden_group_by: 'status', garden_expanded: null, last_garden_view_at: null, coachmark_seen_at: null, opt_in_prompt_seen_at: null }
  patches = []
  gets = 0
  radio = 'up'
  servedFromSW = null
  holds = { GET: [], PATCH: [] }
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
        const gate = holds.PATCH.shift()
        if (gate) await gate
        if (radio === 'down') throw new TypeError('Failed to fetch')
        server = { ...server, ...body }
        return answer(server)
      }
      gets += 1
      if (servedFromSW) { const b = servedFromSW; servedFromSW = null; return answer(b, { 'X-From-Cache': '1' }) }
      const snapshot = JSON.parse(JSON.stringify(server))    // the row as of THIS request
      const gate = holds.GET.shift()
      if (gate) await gate
      return answer(snapshot)
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

// A macrotask, not a fixed count of microtasks: every chain the stub starts is promise-only, so one timer tick
// drains all of it however many hops a released request takes. (A count of 8 left a released read's landing
// for after the assertions — a false green, found when probe 2 passed on the code it must fail on.)
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
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
    expect(JSON.parse(localStorage.getItem(PENDING_KEY))).toEqual({ user: 'user_dave', value: 'location', at: expect.any(Number) })
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

  // rimpact #4: ONLY the mount-time read may adopt. A later read in the visit may keep or re-send, never regroup the
  // list under someone already looking at it; another device's change arrives at the next mount.
  it('a later read in the visit never adopts: another device\'s change waits for the next mount, never mid-list', async () => {
    const first = await visitGarden()
    await pick('location')
    first.unmount()
    await visitGarden()                                    // mount-time read, equal: nothing to do
    const reads = gets
    server.garden_group_by = 'status'                      // the other phone changes it while this one is open
    await resumeAfter(RESUME_MIN_AGE_MS + 1000)
    expect(gets).toBe(reads + 1)                           // the resume did read…
    expect(groupBySelect().value).toBe('location')         // …and did not regroup the list under the user
  })

  it('…the same after an SW copy at mount: the fresh read on the resume does not adopt either; the next mount does', async () => {
    const first = await visitGarden()
    await pick('location')
    first.unmount()
    server.garden_group_by = 'status'                      // the other phone's choice, not yet seen here
    servedFromSW = { ...server, garden_group_by: 'location' }  // offline: this visit's mount read is the cached copy
    const second = await visitGarden()
    expect(groupBySelect().value).toBe('location')
    await resumeAfter(RESUME_MIN_AGE_MS + 1000)            // signal back: a fresh read, but not at mount
    expect(groupBySelect().value).toBe('location')
    second.unmount()
    Date.now = realNow
    await visitGarden()                                    // the next mount takes the other phone's choice
    expect(groupBySelect().value).toBe('status')
  })

  it('a later read still re-sends a choice waiting since the mount — the signal came back while Garden stayed open', async () => {
    const first = await visitGarden()
    radio = 'down'                                         // saves are lost; reads still answer (a flaky radio)
    await pick('crop_type')                                // lost to the dead zone
    first.unmount()
    await visitGarden()                                    // a fresh mount read: re-sent, lost again
    expect(groupBySelect().value).toBe('crop_type')
    expect(groupPatches()).toEqual(['crop_type', 'crop_type'])
    radio = 'up'
    await resumeAfter(RESUME_MIN_AGE_MS + 1000)            // a resume read, radio back
    expect(groupPatches()).toEqual(['crop_type', 'crop_type', 'crop_type'])
    expect(server.garden_group_by).toBe('crop_type')
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
    expect(groupBySelect().value).toBe('crop_type')
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

// The QA seat's rework (qa-groupbypersist.md): reads and saves that cross on the wire, and the one-time pass on a
// shared phone. Each starts where Dave's phone most likely starts after the update — Lifecycle stored locally AND
// on his row — unless it says otherwise.
describe('BUG-GARDENGROUPBYRESET-001 rework — reads and saves that cross', () => {
  // Dave's phone after the update, as QA traced it: Lifecycle stored locally AND on his row, and the first Garden
  // visit already made — nothing to send, and the one-time pass spent on it. Without that first visit the one-time
  // pass would still be armed, and on the old code it happens to re-send a stored Type: the join case then passes
  // on the code it must fail on (it did, until this helper).
  async function afterFirstOpen() {
    localStorage.setItem(GROUPBY_KEY, 'status')
    ;(await visitGarden()).unmount()
    gets = 0
  }

  it('QA MINOR 4 (probe 2): a read that left before a confirmed save, joined by the next visit, is not adopted', async () => {
    await afterFirstOpen()
    const releaseRead = hold('GET')                          // visit 1's prefs read is slow (a weak radio)
    const first = await visitGarden()
    expect(groupBySelect().value).toBe('status')
    await pick('crop_type')                                  // Type: its save lands and is confirmed…
    expect(server.garden_group_by).toBe('crop_type')
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
    first.unmount()                                          // …into a planting, and straight back
    await visitGarden()
    expect(gets).toBe(1)                                     // this visit JOINED visit 1's read (the precondition)
    await releaseRead()                                      // it lands now, carrying the row from BEFORE the save
    expect(groupBySelect().value).toBe('crop_type')
    expect(localStorage.getItem(GROUPBY_KEY)).toBe('crop_type')
  })

  it('QA MINOR 4: a read the next visit sent itself, while that save was still on the wire, is not adopted either', async () => {
    // Not a join, so dropping the join on a confirmed save would not reach it: the read must carry the mark.
    await afterFirstOpen()
    const first = await visitGarden()
    const releaseSave = hold('PATCH')                        // the Type save is slow
    await pick('crop_type')
    first.unmount()
    const releaseRead = hold('GET')
    await visitGarden()                                      // its own read, sent while the save is out…
    expect(gets).toBe(2)
    await releaseSave()                                      // …the save is applied and confirmed first…
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
    await releaseRead()                                      // …then the read answers, from before it
    expect(groupBySelect().value).toBe('crop_type')
  })

  it('QA MINOR 5 (probe 4): a pick settles its own visit — the visit\'s late read, from before the save, is not adopted', async () => {
    await afterFirstOpen()
    const releaseRead = hold('GET')
    await visitGarden()
    await pick('crop_type')                                  // confirmed while the visit's own read is still out
    await releaseRead()
    expect(groupBySelect().value).toBe('crop_type')
  })

  it('QA MINOR 5: while the pick\'s own save is still out, the visit\'s late read neither adopts nor sends it again', async () => {
    // Only the pick's latch covers this one: nothing is confirmed yet, so nothing marks the read. Without the latch
    // the read re-sends the waiting pick ON TOP of its first save, and two overlapping saves never confirm.
    await afterFirstOpen()
    const releaseRead = hold('GET')
    await visitGarden()
    const releaseSave = hold('PATCH')
    await pick('crop_type')
    await releaseRead()
    expect(groupBySelect().value).toBe('crop_type')
    expect(groupPatches()).toEqual(['crop_type'])
    await releaseSave()
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()     // the one save, alone on the wire, confirmed
  })

  it('QA MINOR 6 (probe 6): the one-time pass never sends one person\'s old choice onto another\'s empty row', async () => {
    localStorage.setItem(GROUPBY_KEY, 'crop_type')           // Dave's Type from the old build, on a shared phone
    auth.id = 'user_jen'                                     // Jen opens Garden first after the update…
    server.garden_group_by = null                            // …and her row has no grouping
    await visitGarden()
    expect(groupPatches()).toEqual([])
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
    expect(groupBySelect().value).toBe('crop_type')          // the phone's own grouping, as before this build
  })

  it('the one-time pass waits for a fresh read: an SW copy with no grouping neither marks nor spends it', async () => {
    localStorage.setItem(GROUPBY_KEY, 'crop_type')           // the old build's never-sent Type
    servedFromSW = { ...server, garden_group_by: null }       // offline at the first open after the update
    const first = await visitGarden()
    expect(groupPatches()).toEqual([])                       // a cached copy gives the pass nothing to go on
    first.unmount()
    await visitGarden()                                      // signal back: the row says Lifecycle
    expect(groupBySelect().value).toBe('crop_type')
    expect(groupPatches()).toEqual(['crop_type'])
  })

  it('rimpact #2: on a shared phone the one-time pass is each person\'s — Jen first does not spend it for Dave', async () => {
    localStorage.setItem(GROUPBY_KEY, 'crop_type')           // Dave's Type from the old build
    auth.id = 'user_jen'
    server.garden_group_by = null                            // Jen's row: no grouping
    const jens = await visitGarden()
    expect(groupPatches()).toEqual([])                       // nothing sent onto her row
    jens.unmount()
    auth.id = 'user_dave'
    server.garden_group_by = 'status'                        // Dave's row: Lifecycle, as in prod
    await visitGarden()
    expect(groupBySelect().value).toBe('crop_type')          // his old Type is kept…
    expect(groupPatches()).toEqual(['crop_type'])            // …and sent, as his
    expect(server.garden_group_by).toBe('crop_type')
  })

  it('rimpact #8: a choice waiting more than 7 days yields to a differing value — not re-sent over it, the mark dropped', async () => {
    localStorage.setItem(GROUPBY_KEY, 'crop_type')
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    localStorage.setItem(PENDING_KEY, JSON.stringify({ user: 'user_dave', value: 'crop_type', at: eightDaysAgo }))
    await visitGarden()                                      // the row says Lifecycle — a newer choice, elsewhere
    expect(groupPatches()).toEqual([])
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
    expect(groupBySelect().value).toBe('status')
  })

  it('…while a choice waiting under 7 days still goes out over it', async () => {
    localStorage.setItem(GROUPBY_KEY, 'crop_type')
    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000
    localStorage.setItem(PENDING_KEY, JSON.stringify({ user: 'user_dave', value: 'crop_type', at: sixDaysAgo }))
    await visitGarden()
    expect(groupPatches()).toEqual(['crop_type'])
    expect(groupBySelect().value).toBe('crop_type')
  })
})
