/**
 * src/__tests__/useWhatsNew.test.js
 *
 * useWhatsNew's first-run write, and when it must not happen. With nothing seen locally the hook marks
 * the newest release seen and pushes it to the server, so a first run shows no dot. The server column
 * was COALESCE(new, old) (lambda/critter/index.js, Route 8), so that push REPLACED whatever was stored;
 * it now keeps the larger version, but a deployed Lambda can trail the client, so the hook still holds
 * back on its own.
 * The hook used to do this whenever the prefs read came back with no value — including when the read
 * had FAILED — which marked a release the person had never opened as seen on every device.
 *
 * The real hook and the real whatsNew.js run. Only the edges are stubbed: the prefs read, the prefs
 * write, and the static release file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const { prefsImpl, fetchPrefsSpy, saveSeenSpy, getToken } = vi.hoisted(() => {
  const prefsImpl = { current: async () => null }
  return {
    prefsImpl,
    fetchPrefsSpy: vi.fn((...a) => prefsImpl.current(...a)),
    saveSeenSpy: vi.fn(),
    // One function for the whole file: the hook keys its effect on getToken's identity.
    getToken: () => Promise.resolve('t'),
  }
})

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ getToken }) }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: fetchPrefsSpy,
  saveWhatsNewSeen: saveSeenSpy,
}))

import { useWhatsNew } from '../hooks/useWhatsNew.js'
import { readSeen, writeSeen } from '../lib/whatsNew.js'

const LATEST = '9.9.9'
const OLDER = '9.9.8'
// A prefs body as GET /api/notifications/prefs returns it for a person with no row: every per-user
// column present and null (readUserPrefs in lambda/critter/index.js).
const noRow = () => ({ critter_visit: 'in_app_only', whats_new_last_seen: null, more_pins: null, bar_layout: null })
// api.js's marker on a body the service worker served from its cache after the network read failed.
const fromCache = (body) => Object.defineProperty(body, Symbol.for('garden-app.fromCache'), { value: true, enumerable: false })

// Rendered and settled: `latest` is set in the same callback that decides the dot, so once it reads
// LATEST the first-run branch has run (or been skipped).
async function mount(prefs) {
  prefsImpl.current = typeof prefs === 'function' ? prefs : async () => prefs
  const view = renderHook(() => useWhatsNew())
  await waitFor(() => expect(view.result.current.latest).toBe(LATEST))
  return view
}

beforeEach(() => {
  localStorage.clear()
  fetchPrefsSpy.mockClear()
  saveSeenSpy.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: LATEST }) })))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('nothing seen locally + the prefs read did not reach the server', () => {
  // KILLING MUTATION: delete the `if (!prefs || servedFromCache(prefs)) return` line in the first-run
  // branch (the code as shipped before this fix). RESULT: RED — LATEST is written locally and PATCHed.
  it.each([
    ['came back null (no token, a non-2xx answer, an unreadable body)', async () => null],
    ['rejected', async () => { throw new Error('offline') }],
  ])('the read %s: nothing is written here, nothing is sent, and no dot', async (_name, prefs) => {
    const { result } = await mount(prefs)
    expect(fetchPrefsSpy).toHaveBeenCalledTimes(1)
    expect(readSeen()).toBeNull()
    expect(saveSeenSpy).not.toHaveBeenCalled()
    expect(result.current.unseen).toBe(false)
  })

  // KILLING MUTATION: drop `servedFromCache(prefs)` from that guard. RESULT: RED — a cached body with
  // no value is taken for the server's answer.
  it('the service worker answered from its cache: the same — a cached "no value" is not the server’s', async () => {
    const { result } = await mount(fromCache(noRow()))
    expect(readSeen()).toBeNull()
    expect(saveSeenSpy).not.toHaveBeenCalled()
    expect(result.current.unseen).toBe(false)
  })

  // What the skip buys. Before the fix the failed launch wrote LATEST here, so this second launch read
  // local as AHEAD of the server, showed no dot, and pushed LATEST over the server's OLDER.
  it('then a later launch reaches the server, which holds an older release: the dot shows and nothing is pushed', async () => {
    const failed = await mount(null)
    failed.unmount()
    const { result } = await mount({ ...noRow(), whats_new_last_seen: OLDER })
    await waitFor(() => expect(result.current.unseen).toBe(true))
    expect(readSeen()).toBe(OLDER)
    expect(saveSeenSpy).not.toHaveBeenCalled()
  })
})

describe('nothing seen locally + the server answered', () => {
  // AS BEFORE — green before and after the fix. KILLING MUTATION: widen the guard to skip whenever the
  // server has no value (`return` unconditionally). RESULT: RED — a real first run writes nothing.
  it('and holds no value: a real first run — the newest release is marked seen here and pushed once, no dot', async () => {
    const { result } = await mount(noRow())
    await waitFor(() => expect(readSeen()).toBe(LATEST))
    expect(saveSeenSpy).toHaveBeenCalledTimes(1)
    expect(saveSeenSpy).toHaveBeenCalledWith({ getToken, version: LATEST })
    expect(result.current.unseen).toBe(false)
  })

  // AS BEFORE. The first-run branch is not reached at all when either side has a value.
  it('and holds an older release: the dot shows, and the server’s value is cached here', async () => {
    const { result } = await mount({ ...noRow(), whats_new_last_seen: OLDER })
    await waitFor(() => expect(result.current.unseen).toBe(true))
    expect(readSeen()).toBe(OLDER)
    expect(saveSeenSpy).not.toHaveBeenCalled()
  })
})

describe('something seen locally + the prefs read failed', () => {
  // AS BEFORE — the skip is scoped to "nothing seen locally". A failed read leaves the local answer standing.
  it('the local answer decides the dot', async () => {
    writeSeen(OLDER)
    const { result } = await mount(null)
    await waitFor(() => expect(result.current.unseen).toBe(true))
    expect(readSeen()).toBe(OLDER)
  })
})

// BUG-WHATSNEWSTALELOCALPUSH-001 — the "local is ahead, push it up" write. After a read that did not
// reach the server `remote` is null because it is UNKNOWN, and this device may be the stale one.
describe('something seen locally + the prefs read did not reach the server: nothing is pushed', () => {
  // KILLING MUTATION: delete the `if (!prefs || servedFromCache(prefs)) return` line in the else-branch
  // (the code as shipped before this fix). RESULT: RED — OLDER is PATCHed over whatever the server holds.
  it.each([
    ['came back null', async () => null],
    ['rejected', async () => { throw new Error('offline') }],
  ])('the read %s', async (_name, prefs) => {
    writeSeen(OLDER)
    const { result } = await mount(prefs)
    await waitFor(() => expect(result.current.unseen).toBe(true))
    expect(saveSeenSpy).not.toHaveBeenCalled()
    expect(readSeen()).toBe(OLDER)
  })

  // KILLING MUTATION: drop `servedFromCache(prefs)` from that guard. RESULT: RED on both rows — a
  // cached body is taken for the server's answer and the local value is sent over it.
  it.each([
    ['with no value', () => fromCache(noRow())],
    ['with an older value than this device', () => fromCache({ ...noRow(), whats_new_last_seen: OLDER })],
  ])('the service worker answered from its cache %s', async (_name, body) => {
    writeSeen(LATEST)
    const { result } = await mount(body())
    expect(saveSeenSpy).not.toHaveBeenCalled()
    expect(readSeen()).toBe(LATEST)
    expect(result.current.unseen).toBe(false)
  })
})

// The only path by which reading Release Notes on one device reaches the server when the tap's own
// PATCH did not land (offline, or seen before the column existed).
describe('something seen locally + the server answered', () => {
  // KILLING MUTATION: widen the else-branch guard to `return` unconditionally. RESULT: RED on both
  // rows — a device that is genuinely ahead never tells the server.
  it.each([
    ['holds no value', null],
    ['holds an older release', OLDER],
  ])('and %s: the local value is pushed, once, and there is no dot', async (_name, remote) => {
    writeSeen(LATEST)
    const { result } = await mount({ ...noRow(), whats_new_last_seen: remote })
    await waitFor(() => expect(saveSeenSpy).toHaveBeenCalledTimes(1))
    expect(saveSeenSpy).toHaveBeenCalledWith({ getToken, version: LATEST })
    expect(readSeen()).toBe(LATEST)
    expect(result.current.unseen).toBe(false)
  })

  it.each([
    ['the same release', LATEST, LATEST, false],
    ['a newer release than this device', OLDER, LATEST, false],
  ])('and holds %s: nothing is pushed', async (_name, local, remote, unseen) => {
    writeSeen(local)
    const { result } = await mount({ ...noRow(), whats_new_last_seen: remote })
    await waitFor(() => expect(readSeen()).toBe(remote))
    expect(saveSeenSpy).not.toHaveBeenCalled()
    expect(result.current.unseen).toBe(unseen)
  })

  // Dotted integers, not text: '9.10.0' sorts below '9.9.0' as a string.
  it('and holds 9.9.0 against a local 9.10.0: 9.10.0 is the newer one and is pushed', async () => {
    writeSeen('9.10.0')
    await mount({ ...noRow(), whats_new_last_seen: '9.9.0' })
    await waitFor(() => expect(saveSeenSpy).toHaveBeenCalledWith({ getToken, version: '9.10.0' }))
    expect(readSeen()).toBe('9.10.0')
  })
})
