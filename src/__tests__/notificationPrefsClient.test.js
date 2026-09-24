// notificationPrefsClient tests — MVP-Critter Session 4 Phase A.
// Mirrors src/__tests__/critterClient.test.js patterns.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TOKEN = 'tk-abc'
const PREFS_OK = { critter_visit: 'in_app_only', quiet_hours_start: '21:00:00', quiet_hours_end: '07:00:00' }

async function loadModule(envValue) {
  vi.resetModules()
  vi.stubGlobal('import.meta', { env: { VITE_API_CRITTERS: envValue } })
  // Vitest exposes import.meta.env via stubbing on vi
  if (envValue == null) {
    vi.stubEnv('VITE_API_CRITTERS', '')
  } else {
    vi.stubEnv('VITE_API_CRITTERS', envValue)
  }
  return await import('../lib/notificationPrefsClient.js')
}

describe('notificationPrefsClient', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  describe('fetchNotificationPrefs', () => {
    it('returns null when VITE_API_CRITTERS unset', async () => {
      const mod = await loadModule('')
      const res = await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })
      expect(res).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('returns null when getToken returns null', async () => {
      const mod = await loadModule('https://staging.example.com/')
      const res = await mod.fetchNotificationPrefs({ getToken: async () => null })
      expect(res).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('GETs /api/notifications/prefs with bearer token and returns prefs', async () => {
      const mod = await loadModule('https://staging.example.com/')
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => PREFS_OK })
      const res = await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })
      expect(res).toEqual(PREFS_OK)
      expect(global.fetch).toHaveBeenCalledTimes(1)
      const [url, init] = global.fetch.mock.calls[0]
      expect(url).toBe('https://staging.example.com/api/notifications/prefs')
      expect(init.method).toBe('GET')
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    })

    it('strips trailing slash from VITE_API_CRITTERS', async () => {
      const mod = await loadModule('https://staging.example.com/')
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => PREFS_OK })
      await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })
      const [url] = global.fetch.mock.calls[0]
      expect(url).toBe('https://staging.example.com/api/notifications/prefs')
    })

    it('returns null on non-OK response', async () => {
      const mod = await loadModule('https://staging.example.com')
      global.fetch.mockResolvedValueOnce({ ok: false, status: 500 })
      const res = await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })
      expect(res).toBeNull()
    })

    it('NEVER rejects on fetch error', async () => {
      const mod = await loadModule('https://staging.example.com')
      global.fetch.mockRejectedValueOnce(new Error('network blip'))
      const res = await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })
      expect(res).toBeNull()
    })
  })

  // V5-NAVCUSTOM-001 (QA IMPORTANT-2) — the SW offline-cache marker, carried across the parse boundary
  // the way apiFetch carries it (api.test.js, SW-STALEAPI-001). public/sw.js answers a prefs GET whose
  // network attempt failed outright from its cache — HTTP 200, stamped X-From-Cache — and without the
  // marker NavPrefsContext took that days-old body for the truth.
  // KILLING MUTATION: drop the defineProperty (or read the wrong header). RESULT: RED on the first case.
  describe('fetchNotificationPrefs — the SW offline-cache marker', () => {
    const res = (body, headers) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } })

    it('marks a body the service worker served from its cache', async () => {
      const mod = await loadModule('https://staging.example.com')
      mod.__resetPrefsFlight()
      const { isFromCache, FROM_CACHE_HEADER } = await import('../lib/api.js')
      global.fetch.mockResolvedValueOnce(res({ more_pins: ['seeds'] }, { [FROM_CACHE_HEADER]: '1' }))
      const prefs = await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })
      expect(prefs).toEqual({ more_pins: ['seeds'] })
      expect(isFromCache(prefs)).toBe(true)
    })

    it('does NOT mark a live network body', async () => {
      const mod = await loadModule('https://staging.example.com')
      mod.__resetPrefsFlight()
      const { isFromCache } = await import('../lib/api.js')
      global.fetch.mockResolvedValueOnce(res({ more_pins: ['seeds'] }))
      expect(isFromCache(await mod.fetchNotificationPrefs({ getToken: async () => TOKEN }))).toBe(false)
    })

    // Every existing caller spreads, JSON-encodes or key-walks prefs: the marker must be invisible.
    it('the marker is invisible to Object.keys, spread and JSON', async () => {
      const mod = await loadModule('https://staging.example.com')
      mod.__resetPrefsFlight()
      const { isFromCache, FROM_CACHE_HEADER } = await import('../lib/api.js')
      global.fetch.mockResolvedValueOnce(res({ a: 1, b: 2 }, { [FROM_CACHE_HEADER]: '1' }))
      const prefs = await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })
      expect(Object.keys(prefs)).toEqual(['a', 'b'])
      expect(JSON.parse(JSON.stringify(prefs))).toEqual({ a: 1, b: 2 })
      expect(isFromCache({ ...prefs })).toBe(false)
    })

    it('tolerates a header-less stubbed response (what most component tests hand it)', async () => {
      const mod = await loadModule('https://staging.example.com')
      mod.__resetPrefsFlight()
      const { isFromCache } = await import('../lib/api.js')
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ a: 1 }) })
      const prefs = await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })
      expect(prefs).toEqual({ a: 1 })
      expect(isFromCache(prefs)).toBe(false)
    })
  })

  // V5-ADMINCENTER-001 — SINGLE FLIGHT. This route had eight independent callers each fetching on
  // their own mount, three of which mount in the same frame on /today, and the admin centre's nav
  // config read would have been a ninth. The dedup lives here rather than at any call site so all
  // nine collapse with no call-site change.
  describe('fetchNotificationPrefs — single flight', () => {
    it('collapses concurrent callers into ONE request, and gives them all the same answer', async () => {
      const mod = await loadModule('https://staging.example.com')
      mod.__resetPrefsFlight()
      // A deferred response, so all three calls are genuinely in flight together — resolving
      // immediately would let each one settle before the next started and the case would pass
      // against a resolver with no latch at all.
      let release
      global.fetch.mockReturnValue(new Promise(r => { release = () => r({ ok: true, json: async () => PREFS_OK }) }))
      const calls = [
        mod.fetchNotificationPrefs({ getToken: async () => TOKEN }),
        mod.fetchNotificationPrefs({ getToken: async () => TOKEN }),
        mod.fetchNotificationPrefs({ getToken: async () => TOKEN }),
      ]
      await Promise.resolve()
      release()
      const results = await Promise.all(calls)
      expect(global.fetch).toHaveBeenCalledTimes(1)
      for (const r of results) expect(r).toEqual(PREFS_OK)
    })

    // DEDUP, NOT CACHE — the property that makes this safe to drop under eight existing callers.
    // A caller that re-reads after its own PATCH (SettingsNotifications, the admin centre) must
    // still hit the network. If this ever reds, the latch has become a cache and eight surfaces
    // that never asked for one are serving stale prefs.
    it('does NOT cache: a call after the first settles refetches', async () => {
      const mod = await loadModule('https://staging.example.com')
      mod.__resetPrefsFlight()
      global.fetch.mockResolvedValue({ ok: true, json: async () => PREFS_OK })
      await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })
      await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    // The latch must clear on the failure path too, or one blip at boot leaves every later caller
    // joined to a settled null for the life of the page.
    it('clears the latch after a failure, so the next caller can retry', async () => {
      const mod = await loadModule('https://staging.example.com')
      mod.__resetPrefsFlight()
      global.fetch.mockRejectedValueOnce(new Error('network blip'))
      expect(await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })).toBeNull()
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => PREFS_OK })
      expect(await mod.fetchNotificationPrefs({ getToken: async () => TOKEN })).toEqual(PREFS_OK)
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })
  })

  // V5-ADMINCENTER-001 wrote a GLOBAL nav_tabs order; V5-NAVCUSTOM-001 retired that path from the SPA
  // (D4, Dave 2026-09-24: only his bar changes). The per-person bar is saveBarLayout over bar_layout —
  // a different key and shape — so a nav_tabs writer has no business existing anywhere now.
  it('exports no nav_tabs writer — the per-person bar is saveBarLayout', async () => {
    const mod = await loadModule('https://staging.example.com')
    expect(mod.saveNavTabs).toBeUndefined()
    // Anti-vacuity: the module still loads and still exports its per-user writers, so the assertion
    // above is about one missing export and not about a failed import.
    expect(typeof mod.fetchNotificationPrefs).toBe('function')
    expect(typeof mod.saveBarLayout).toBe('function')
    expect(typeof mod.saveMorePins).toBe('function')
  })

  describe('patchNotificationPrefs', () => {
    it('returns null when VITE_API_CRITTERS unset', async () => {
      const mod = await loadModule('')
      const res = await mod.patchNotificationPrefs({ getToken: async () => TOKEN, critterVisit: 'off' })
      expect(res).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('returns null when critterVisit is invalid', async () => {
      const mod = await loadModule('https://staging.example.com')
      const res = await mod.patchNotificationPrefs({ getToken: async () => TOKEN, critterVisit: 'bogus' })
      expect(res).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('returns null when no fields provided', async () => {
      const mod = await loadModule('https://staging.example.com')
      const res = await mod.patchNotificationPrefs({ getToken: async () => TOKEN })
      expect(res).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('PATCHes with bearer + body when critterVisit provided', async () => {
      const mod = await loadModule('https://staging.example.com')
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...PREFS_OK, critter_visit: 'off' }) })
      const res = await mod.patchNotificationPrefs({ getToken: async () => TOKEN, critterVisit: 'off' })
      expect(res.critter_visit).toBe('off')
      const [url, init] = global.fetch.mock.calls[0]
      expect(url).toBe('https://staging.example.com/api/notifications/prefs')
      expect(init.method).toBe('PATCH')
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
      expect(init.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(init.body)).toEqual({ critter_visit: 'off' })
    })

    it('NEVER rejects on fetch error', async () => {
      const mod = await loadModule('https://staging.example.com')
      global.fetch.mockRejectedValueOnce(new Error('network blip'))
      const res = await mod.patchNotificationPrefs({ getToken: async () => TOKEN, critterVisit: 'off' })
      expect(res).toBeNull()
    })

    it('accepts all valid critterVisit values', async () => {
      const mod = await loadModule('https://staging.example.com')
      for (const v of ['off', 'in_app_only', 'system']) {
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ critter_visit: v }) })
        const res = await mod.patchNotificationPrefs({ getToken: async () => TOKEN, critterVisit: v })
        expect(res.critter_visit).toBe(v)
      }
    })
  })

  describe('saveGardenGroupBy', () => {
    it('returns null when VITE_API_CRITTERS unset', async () => {
      const mod = await loadModule('')
      const res = await mod.saveGardenGroupBy({ getToken: async () => TOKEN, value: 'type' })
      expect(res).toBeNull()
    })
    it('returns null on an invalid value (no fetch)', async () => {
      const mod = await loadModule('https://staging.example.com')
      const res = await mod.saveGardenGroupBy({ getToken: async () => TOKEN, value: 'bogus' })
      expect(res).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })
    it('PATCHes garden_group_by and returns the updated row', async () => {
      const mod = await loadModule('https://staging.example.com')
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ garden_group_by: 'lifecycle' }) })
      const res = await mod.saveGardenGroupBy({ getToken: async () => TOKEN, value: 'lifecycle' })
      expect(res).toEqual({ garden_group_by: 'lifecycle' })
      const [url, opts] = global.fetch.mock.calls[0]
      expect(url).toBe('https://staging.example.com/api/notifications/prefs')
      expect(opts.method).toBe('PATCH')
      expect(JSON.parse(opts.body)).toEqual({ garden_group_by: 'lifecycle' })
    })
    it('returns null on a non-ok response', async () => {
      const mod = await loadModule('https://staging.example.com')
      global.fetch.mockResolvedValueOnce({ ok: false })
      const res = await mod.saveGardenGroupBy({ getToken: async () => TOKEN, value: 'type' })
      expect(res).toBeNull()
    })
  })

  describe('saveGardenSortOrder', () => {
    it('returns null when VITE_API_CRITTERS unset', async () => {
      const mod = await loadModule('')
      expect(await mod.saveGardenSortOrder({ getToken: async () => TOKEN, value: 'alpha' })).toBeNull()
    })
    it('returns null on an invalid value (no fetch)', async () => {
      const mod = await loadModule('https://staging.example.com')
      const res = await mod.saveGardenSortOrder({ getToken: async () => TOKEN, value: 'sideways' })
      expect(res).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })
    it('PATCHes garden_sort_order and returns the updated row', async () => {
      const mod = await loadModule('https://staging.example.com')
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ garden_sort_order: 'recency' }) })
      const res = await mod.saveGardenSortOrder({ getToken: async () => TOKEN, value: 'recency' })
      expect(res).toEqual({ garden_sort_order: 'recency' })
      const [url, opts] = global.fetch.mock.calls[0]
      expect(url).toBe('https://staging.example.com/api/notifications/prefs')
      expect(opts.method).toBe('PATCH')
      expect(JSON.parse(opts.body)).toEqual({ garden_sort_order: 'recency' })
    })
  })

  describe('saveGardenExpanded', () => {
    it('returns null when VITE_API_CRITTERS unset', async () => {
      const mod = await loadModule('')
      expect(await mod.saveGardenExpanded({ getToken: async () => TOKEN, ids: ['a'] })).toBeNull()
    })
    it('returns null on a non-array / non-string-element value (no fetch)', async () => {
      const mod = await loadModule('https://staging.example.com')
      expect(await mod.saveGardenExpanded({ getToken: async () => TOKEN, ids: 'nope' })).toBeNull()
      expect(await mod.saveGardenExpanded({ getToken: async () => TOKEN, ids: [1, 2] })).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })
    it('PATCHes garden_expanded and returns the updated row', async () => {
      const mod = await loadModule('https://staging.example.com')
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ garden_expanded: '["a","b"]' }) })
      const res = await mod.saveGardenExpanded({ getToken: async () => TOKEN, ids: ['a', 'b'] })
      expect(res).toEqual({ garden_expanded: '["a","b"]' })
      const [url, opts] = global.fetch.mock.calls[0]
      expect(url).toBe('https://staging.example.com/api/notifications/prefs')
      expect(opts.method).toBe('PATCH')
      expect(JSON.parse(opts.body)).toEqual({ garden_expanded: ['a', 'b'] })
    })
  })

  describe('saveGardenBloomSeen', () => {
    it('returns null when VITE_API_CRITTERS unset', async () => {
      const mod = await loadModule('')
      expect(await mod.saveGardenBloomSeen({ getToken: async () => TOKEN, ids: ['robin'] })).toBeNull()
    })
    it('returns null on an invalid value (no fetch)', async () => {
      const mod = await loadModule('https://staging.example.com')
      expect(await mod.saveGardenBloomSeen({ getToken: async () => TOKEN, ids: [42] })).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })
    it('PATCHes garden_bloom_seen and returns the updated row', async () => {
      const mod = await loadModule('https://staging.example.com')
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ garden_bloom_seen: '["robin"]' }) })
      const res = await mod.saveGardenBloomSeen({ getToken: async () => TOKEN, ids: ['robin'] })
      expect(res).toEqual({ garden_bloom_seen: '["robin"]' })
      expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ garden_bloom_seen: ['robin'] })
    })
  })

  describe('saveGardenHelperRung1', () => {
    it('returns null when VITE_API_CRITTERS unset', async () => {
      const mod = await loadModule('')
      expect(await mod.saveGardenHelperRung1({ getToken: async () => TOKEN })).toBeNull()
    })
    it('PATCHes garden_helper_rung1_seen=true', async () => {
      const mod = await loadModule('https://staging.example.com')
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ garden_helper_rung1_seen: true }) })
      const res = await mod.saveGardenHelperRung1({ getToken: async () => TOKEN })
      expect(res).toEqual({ garden_helper_rung1_seen: true })
      expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ garden_helper_rung1_seen: true })
    })
  })

  describe('CRITTER_VISIT_VALUES', () => {
    it('exports the canonical allowed values', async () => {
      const mod = await loadModule('https://staging.example.com')
      expect(mod.CRITTER_VISIT_VALUES).toEqual(['off', 'in_app_only', 'system'])
    })
  })
})

// ─── Phase B — fire-and-forget POST tests (Routes 6, 9, 10) ─────────────────

describe('notificationPrefsClient — Phase B fire-and-forget POSTs', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

  describe('recordGardenViewOpened (Route 6)', () => {
    it('returns null when VITE_API_CRITTERS unset', async () => {
      const { recordGardenViewOpened } = await loadModule(null)
      const res = await recordGardenViewOpened({ getToken: () => Promise.resolve(TOKEN) })
      expect(res).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('returns null when getToken returns null (no auth)', async () => {
      const { recordGardenViewOpened } = await loadModule('https://critter.test/')
      const res = await recordGardenViewOpened({ getToken: () => Promise.resolve(null) })
      expect(res).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('POSTs /api/notifications/garden-view-opened with bearer + keepalive', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ last_garden_view_at: '2026-05-29T17:00:00Z' }),
      })
      const { recordGardenViewOpened } = await loadModule('https://critter.test/')
      const res = await recordGardenViewOpened({ getToken: () => Promise.resolve(TOKEN) })
      expect(res).toBe('2026-05-29T17:00:00Z')
      const [url, opts] = global.fetch.mock.calls[0]
      expect(url).toBe('https://critter.test/api/notifications/garden-view-opened')
      expect(opts.method).toBe('POST')
      expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`)
      expect(opts.keepalive).toBe(true)
    })

    it('returns null on non-OK response (no throw)', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
      const { recordGardenViewOpened } = await loadModule('https://critter.test/')
      expect(await recordGardenViewOpened({ getToken: () => Promise.resolve(TOKEN) })).toBeNull()
    })

    it('NEVER rejects on fetch error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('boom'))
      const { recordGardenViewOpened } = await loadModule('https://critter.test/')
      expect(await recordGardenViewOpened({ getToken: () => Promise.resolve(TOKEN) })).toBeNull()
    })
  })

  describe('recordCoachmarkDismissed (Route 9)', () => {
    it('returns null when env unset', async () => {
      const { recordCoachmarkDismissed } = await loadModule(null)
      expect(await recordCoachmarkDismissed({ getToken: () => Promise.resolve(TOKEN) })).toBeNull()
    })

    it('POSTs /api/notifications/coachmark-dismissed', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ coachmark_seen_at: '2026-05-29T17:00:01.5Z' }),
      })
      const { recordCoachmarkDismissed } = await loadModule('https://critter.test/')
      const res = await recordCoachmarkDismissed({ getToken: () => Promise.resolve(TOKEN) })
      expect(res).toBe('2026-05-29T17:00:01.5Z')
      const [url, opts] = global.fetch.mock.calls[0]
      expect(url).toBe('https://critter.test/api/notifications/coachmark-dismissed')
      expect(opts.method).toBe('POST')
      expect(opts.keepalive).toBe(true)
    })

    it('NEVER rejects', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('boom'))
      const { recordCoachmarkDismissed } = await loadModule('https://critter.test/')
      expect(await recordCoachmarkDismissed({ getToken: () => Promise.resolve(TOKEN) })).toBeNull()
    })
  })

  describe('recordOptInDismissed (Route 10)', () => {
    it('returns null when env unset', async () => {
      const { recordOptInDismissed } = await loadModule(null)
      expect(await recordOptInDismissed({ getToken: () => Promise.resolve(TOKEN) })).toBeNull()
    })

    it('POSTs /api/notifications/opt-in-dismissed', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ opt_in_prompt_seen_at: '2026-05-29T17:00:02Z' }),
      })
      const { recordOptInDismissed } = await loadModule('https://critter.test/')
      const res = await recordOptInDismissed({ getToken: () => Promise.resolve(TOKEN) })
      expect(res).toBe('2026-05-29T17:00:02Z')
      const [url, opts] = global.fetch.mock.calls[0]
      expect(url).toBe('https://critter.test/api/notifications/opt-in-dismissed')
      expect(opts.method).toBe('POST')
      expect(opts.keepalive).toBe(true)
    })

    it('NEVER rejects', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('boom'))
      const { recordOptInDismissed } = await loadModule('https://critter.test/')
      expect(await recordOptInDismissed({ getToken: () => Promise.resolve(TOKEN) })).toBeNull()
    })
  })
})

// ─── V5-NAVCUSTOM-001 — the two REPORTED savers (pins, the per-person bar) ─────────────────────
//
// Unlike every writer above, these report { ok } | { ok:false, status } — NavPrefsContext decides
// keep-and-retry (status 0, 5xx) versus roll-back (4xx) from that split, so a status that lies is a
// pin that silently vanishes or silently never saves. Each case names the mutation that reds it.
describe('notificationPrefsClient — saveMorePins / saveBarLayout (reported)', () => {
  const BASE = 'https://staging.example.com'
  const okJson = { ok: true, status: 200, json: async () => ({}) }
  const body = (i = 0) => JSON.parse(global.fetch.mock.calls[i][1].body)

  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

  it('saveMorePins PATCHes exactly { more_pins } to the prefs route and reports ok', async () => {
    const mod = await loadModule(BASE)
    global.fetch.mockResolvedValueOnce(okJson)
    expect(await mod.saveMorePins({ getToken: async () => TOKEN, ids: ['seeds', 'photos'] })).toEqual({ ok: true })
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe(`${BASE}/api/notifications/prefs`)
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(body()).toEqual({ more_pins: ['seeds', 'photos'] })
  })

  // U4 / CONTRACT §3 — the route merges with COALESCE, so null means "unchanged". Removing the last
  // pin has to send an EMPTY ARRAY or the pin stays on the server forever.
  // KILLING MUTATION: skip the request (or send null) for an empty list. RESULT: RED.
  it('sends [] — not null, not nothing — when the last pin goes', async () => {
    const mod = await loadModule(BASE)
    global.fetch.mockResolvedValueOnce(okJson)
    expect(await mod.saveMorePins({ getToken: async () => TOKEN, ids: [] })).toEqual({ ok: true })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][1].body).toBe('{"more_pins":[]}')
  })

  it('saveBarLayout PATCHes exactly { bar_layout: { order, hidden } }, dropping any other key', async () => {
    const mod = await loadModule(BASE)
    global.fetch.mockResolvedValueOnce(okJson)
    const layout = { order: ['today', 'create', 'garden', 'harvests', 'put-up'], hidden: ['put-up'], bar: ['x'], moved: ['put-up'] }
    expect(await mod.saveBarLayout({ getToken: async () => TOKEN, layout })).toEqual({ ok: true })
    expect(body()).toEqual({ bar_layout: { order: ['today', 'create', 'garden', 'harvests', 'put-up'], hidden: ['put-up'] } })
  })

  // The server's own answer is passed through verbatim. KILLING MUTATION: collapse every failure to
  // status 0. RESULT: RED — a refused pin would be retried forever instead of rolled back.
  it('reports the server’s status on a non-OK response', async () => {
    const mod = await loadModule(BASE)
    for (const status of [400, 401, 403, 500, 503]) {
      global.fetch.mockResolvedValueOnce({ ok: false, status })
      expect(await mod.saveMorePins({ getToken: async () => TOKEN, ids: ['seeds'] })).toEqual({ ok: false, status })
      global.fetch.mockResolvedValueOnce({ ok: false, status })
      expect(await mod.saveBarLayout({ getToken: async () => TOKEN, layout: { order: ['today', 'garden', 'create', 'harvests', 'put-up'], hidden: [] } }))
        .toEqual({ ok: false, status })
    }
  })

  // status 0 = never reached the server. KILLING MUTATION: report a missing token as 401 (the old
  // saveNavTabs shape). RESULT: RED — offline, the safe getToken returns null, and a 401 would make
  // NavPrefsContext roll back a pin the person just made instead of keeping it pending.
  it('reports status 0 — never reached the server — for no token, a network error and an unset base', async () => {
    const mod = await loadModule(BASE)
    expect(await mod.saveMorePins({ getToken: async () => null, ids: ['seeds'] })).toEqual({ ok: false, status: 0 })
    global.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await mod.saveMorePins({ getToken: async () => TOKEN, ids: ['seeds'] })).toEqual({ ok: false, status: 0 })
    const unset = await loadModule('')
    expect(await unset.saveBarLayout({ getToken: async () => TOKEN, layout: { order: ['today', 'garden', 'create', 'harvests', 'put-up'], hidden: [] } }))
      .toEqual({ ok: false, status: 0 })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  // The house 15s bound, from api.js — not a second constant. KILLING MUTATIONS: drop the signal
  // (the request hangs past 15s), or bound it with a different number. RESULT: RED on the abort.
  it('aborts at api.js’s API_TIMEOUT_MS and reports status 0', async () => {
    const mod = await loadModule(BASE)
    const { API_TIMEOUT_MS } = await import('../lib/api.js')
    expect(API_TIMEOUT_MS).toBe(15000)
    vi.useFakeTimers()
    let signal
    global.fetch.mockImplementation((_url, init) => new Promise((_, reject) => {
      signal = init.signal
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const pending = mod.saveMorePins({ getToken: async () => TOKEN, ids: ['seeds'] })
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS - 1)
    expect(signal, 'no AbortSignal was passed to fetch').toBeTruthy()
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    expect(await pending).toEqual({ ok: false, status: 0 })
  })

  it('carries no timeout literal of its own — the bound is imported', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/notificationPrefsClient.js'), 'utf8')
    expect(src).toMatch(/import \{[^}]*\bAPI_TIMEOUT_MS\b[^}]*\} from '\.\/api\.js'/)
    expect(src).not.toMatch(/\b15_?000\b/)
  })

  // Local refusal: the payload the contract refuses is not sent. KILLING MUTATION: delete a shape
  // check. RESULT: RED — the request goes out (and would 400 on the server).
  it('refuses, without a request, pin lists the contract rejects', async () => {
    const mod = await loadModule(BASE)
    const refused = { ok: false, status: 400, local: true }
    const bad = [
      null, 'seeds', ['Seeds'], ['/seeds'], [7], ['seeds', 'seeds'],
      Array.from({ length: 33 }, (_, i) => `row-${i}`),
    ]
    for (const ids of bad) expect(await mod.saveMorePins({ getToken: async () => TOKEN, ids }), JSON.stringify(ids)).toEqual(refused)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('refuses, without a request, layouts the contract rejects — hiding ＋ or Today, a short order', async () => {
    const mod = await loadModule(BASE)
    const refused = { ok: false, status: 400, local: true }
    const bad = [
      null, {}, { order: ['today', 'garden', 'create', 'harvests'], hidden: [] },
      { order: ['today', 'garden', 'create', 'harvests', 'put-up'], hidden: ['create'] },
      { order: ['today', 'garden', 'create', 'harvests', 'put-up'], hidden: ['today'] },
      { order: ['today', 'garden', 'create', 'harvests', 'put-up'] },
    ]
    for (const layout of bad) expect(await mod.saveBarLayout({ getToken: async () => TOKEN, layout }), JSON.stringify(layout)).toEqual(refused)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

// I6, re-aimed (design §8): AN OLD CLIENT IGNORES THE NEW PREFS FIELDS. A bundle from before this
// release keeps running on a phone until its service worker updates, and it saves prefs through these
// same fire-and-forget writers. The route merges column by column with COALESCE, so a key a request
// does not carry is left alone — which is only safe if no writer ever carries more_pins, bar_layout
// or can_edit_bar by accident (say, by echoing the prefs object it read). Each writer sends exactly
// its own key. KILLING MUTATION: have any writer spread the prefs it was handed into its body.
// RESULT: RED — an old bundle's harmless save would then clear Dave's pins or his bar.
describe('I6 — every other prefs writer names only its own key', () => {
  const NEW_FIELDS = ['more_pins', 'bar_layout', 'can_edit_bar']
  beforeEach(() => { global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) })
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

  it('no fire-and-forget writer sends a pin, a layout or the editor flag', async () => {
    const mod = await loadModule('https://staging.example.com')
    const getToken = async () => TOKEN
    const writers = {
      saveGardenGroupBy: () => mod.saveGardenGroupBy({ getToken, value: 'type' }),
      saveGardenSortOrder: () => mod.saveGardenSortOrder({ getToken, value: 'alpha' }),
      saveGardenExpanded: () => mod.saveGardenExpanded({ getToken, ids: ['a'] }),
      saveGardenBloomSeen: () => mod.saveGardenBloomSeen({ getToken, ids: ['robin'] }),
      saveGardenHelperRung1: () => mod.saveGardenHelperRung1({ getToken }),
      patchNotificationPrefs: () => mod.patchNotificationPrefs({ getToken, critterVisit: 'off' }),
      saveTodaySkipped: () => mod.saveTodaySkipped({ getToken, date: '2026-09-24', keys: ['k'] }),
      saveLogManyAllSelected: () => mod.saveLogManyAllSelected({ getToken, value: false }),
      saveHandedness: () => mod.saveHandedness({ getToken, value: 'left' }),
      saveWhatsNewSeen: () => mod.saveWhatsNewSeen({ getToken, version: '4.146.0' }),
    }
    for (const [name, call] of Object.entries(writers)) {
      global.fetch.mockClear()
      await call()
      expect(global.fetch, name).toHaveBeenCalledTimes(1)
      const body = JSON.parse(global.fetch.mock.calls[0][1].body)
      expect(Object.keys(body), `${name} sent more than its own key`).toHaveLength(1)
      for (const f of NEW_FIELDS) expect(Object.hasOwn(body, f), `${name} sent ${f}`).toBe(false)
    }
    // …and the two new writers send ONLY their own field.
    global.fetch.mockClear()
    await mod.saveMorePins({ getToken, ids: ['seeds'] })
    expect(Object.keys(JSON.parse(global.fetch.mock.calls[0][1].body))).toEqual(['more_pins'])
    global.fetch.mockClear()
    await mod.saveBarLayout({ getToken, layout: { order: ['today', 'garden', 'create', 'harvests', 'put-up'], hidden: [] } })
    expect(Object.keys(JSON.parse(global.fetch.mock.calls[0][1].body))).toEqual(['bar_layout'])
  })
})
