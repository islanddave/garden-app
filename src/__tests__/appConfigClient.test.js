// appConfigClient tests — V5-ADMINCENTER-001. The GLOBAL config client.
//
// Mirrors src/__tests__/notificationPrefsClient.test.js's harness, because the module mirrors that
// module's shape: same Function URL base (VITE_API_CRITTERS), same never-throws posture, different
// SCOPE. Everything in notificationPrefsClient writes a row keyed by created_by; everything here
// writes a row keyed by `key` alone, which is what Dave's 2026-09-08 ruling made necessary.
//
// TWO PROPERTIES THIS FILE IS FOR:
//   1. THE READ DEGRADES TO NULL, NEVER THROWS AND NEVER RETURNS A HALF-VALUE. null is what
//      resolveNavTabs turns into the shipped bar, so "the config read failed" and "nothing is
//      configured" must be the same value at the consumer. Any other failure mode risks an empty nav
//      on a device with no address bar.
//   2. THE WRITE REPORTS ITS OUTCOME. It backs a user-initiated Save, and the page has to tell a
//      403 (the server says you are not an admin) from an outage from a rejected order.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const TOKEN = 'tk-abc'
const BASE = 'https://staging.example.com'
const ORDER = ['harvests', 'today', 'create', 'garden', 'put-up']

async function loadModule(envValue) {
  vi.resetModules()
  vi.stubEnv('VITE_API_CRITTERS', envValue ?? '')
  return await import('../lib/appConfigClient.js')
}

describe('appConfigClient', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

  describe('fetchAppConfig', () => {
    it('GETs /api/app-config on the critter base with a bearer token', async () => {
      // The path is the contract clientRouteLambdaContract.test.js checks against the Lambda's
      // declared routes; the BASE is the point of the whole transport argument — same origin as
      // /api/critters/active, so no new preconnect and no new cold start.
      const mod = await loadModule(BASE)
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ nav_tabs: ORDER }) })
      expect(await mod.fetchAppConfig({ getToken: async () => TOKEN })).toEqual({ nav_tabs: ORDER })
      const [url, init] = global.fetch.mock.calls[0]
      expect(url).toBe(`${BASE}/api/app-config`)
      expect(init.method).toBe('GET')
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    })

    it('strips a trailing slash from the base rather than double-slashing the path', async () => {
      const mod = await loadModule(`${BASE}/`)
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ nav_tabs: null }) })
      await mod.fetchAppConfig({ getToken: async () => TOKEN })
      expect(global.fetch.mock.calls[0][0]).toBe(`${BASE}/api/app-config`)
    })

    it('returns { nav_tabs: null } through untouched — no row is a real answer', async () => {
      // The live state: app_config has zero rows, so this is what every boot gets today. It must
      // arrive at the consumer as null, which resolveNavTabs renders as the shipped bar.
      const mod = await loadModule(BASE)
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ nav_tabs: null }) })
      expect(await mod.fetchAppConfig({ getToken: async () => TOKEN })).toEqual({ nav_tabs: null })
    })

    it('returns null without a request when the base or the token is missing', async () => {
      const unset = await loadModule('')
      expect(await unset.fetchAppConfig({ getToken: async () => TOKEN })).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
      const mod = await loadModule(BASE)
      expect(await mod.fetchAppConfig({ getToken: async () => null })).toBeNull()
      expect(await mod.fetchAppConfig({})).toBeNull()
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('returns null and NEVER throws on a non-ok status, a network error, or bad JSON', async () => {
      // Each of these would otherwise reach AppConfigProvider's promise chain; a provider that can
      // reject takes the app down through the shell boundary, and nav layout is not worth that.
      const mod = await loadModule(BASE)
      global.fetch.mockResolvedValueOnce({ ok: false, status: 500 })
      await expect(mod.fetchAppConfig({ getToken: async () => TOKEN })).resolves.toBeNull()
      global.fetch.mockRejectedValueOnce(new Error('offline'))
      await expect(mod.fetchAppConfig({ getToken: async () => TOKEN })).resolves.toBeNull()
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('not json') } })
      await expect(mod.fetchAppConfig({ getToken: async () => TOKEN })).resolves.toBeNull()
    })

    it('rejects a non-object body — a 200 that is not a config is not a config', async () => {
      // The CloudFront 404 -> 200 /index.html trap (useAppUpdate.js:24-29) reaches clients as an ok
      // response whose json() is not the shape asked for. Returning it would put a string or an
      // array where the provider expects an object.
      const mod = await loadModule(BASE)
      for (const body of ['<!doctype html>', 42, null]) {
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => body })
        expect(await mod.fetchAppConfig({ getToken: async () => TOKEN })).toBeNull()
      }
    })

    it('SINGLE FLIGHT: concurrent callers share one request', async () => {
      const mod = await loadModule(BASE)
      let release
      global.fetch.mockReturnValueOnce(new Promise(r => { release = () => r({ ok: true, json: async () => ({ nav_tabs: ORDER }) }) }))
      const both = Promise.all([
        mod.fetchAppConfig({ getToken: async () => TOKEN }),
        mod.fetchAppConfig({ getToken: async () => TOKEN }),
      ])
      release()
      expect(await both).toEqual([{ nav_tabs: ORDER }, { nav_tabs: ORDER }])
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it('DEDUP, NOT CACHE: a read after the first settles hits the network again', async () => {
      // The distinction the admin centre depends on — it re-reads immediately after its own save and
      // must see the new value, not a latched copy of the old one.
      const mod = await loadModule(BASE)
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ nav_tabs: null }) })
      await mod.fetchAppConfig({ getToken: async () => TOKEN })
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ nav_tabs: ORDER }) })
      expect(await mod.fetchAppConfig({ getToken: async () => TOKEN })).toEqual({ nav_tabs: ORDER })
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('clears the latch after a FAILED request too', async () => {
      // In `finally`, not after the await: a stuck latch would turn dedup into a permanent cache of
      // a failure, so one bad boot read would render the shipped bar forever.
      const mod = await loadModule(BASE)
      global.fetch.mockRejectedValueOnce(new Error('offline'))
      expect(await mod.fetchAppConfig({ getToken: async () => TOKEN })).toBeNull()
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ nav_tabs: ORDER }) })
      expect(await mod.fetchAppConfig({ getToken: async () => TOKEN })).toEqual({ nav_tabs: ORDER })
    })
  })

  describe('saveNavTabs', () => {
    it('PATCHes /api/app-config with nav_tabs as the ONLY key', async () => {
      const mod = await loadModule(BASE)
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ nav_tabs: ORDER }) })
      const res = await mod.saveNavTabs({ getToken: async () => TOKEN, tabs: ORDER })
      expect(res).toEqual({ ok: true, config: { nav_tabs: ORDER } })
      const [url, init] = global.fetch.mock.calls[0]
      expect(url).toBe(`${BASE}/api/app-config`)
      expect(init.method).toBe('PATCH')
      // Alone: the route accepts nothing else, and batching would put an unrelated setting into a
      // request the server may reject whole.
      expect(JSON.parse(init.body)).toEqual({ nav_tabs: ORDER })
    })

    it('does NOT write through the per-user prefs route', async () => {
      // The wrong door, named explicitly. PATCH /api/notifications/prefs writes
      // user_notification_prefs keyed by created_by and cannot implement a global setting at all.
      const mod = await loadModule(BASE)
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      await mod.saveNavTabs({ getToken: async () => TOKEN, tabs: ORDER })
      expect(global.fetch.mock.calls[0][0]).not.toContain('/api/notifications/prefs')
    })

    it('reports the 403 refusal distinctly rather than as a bare failure', async () => {
      // This is the server saying "you are not an admin" — the only authorization signal the client
      // gets, and the one the page turns into its neutral placard. There is no client admin list.
      const mod = await loadModule(BASE)
      global.fetch.mockResolvedValueOnce({ ok: false, status: 403 })
      expect(await mod.saveNavTabs({ getToken: async () => TOKEN, tabs: ORDER })).toEqual({ ok: false, status: 403 })
    })

    it('reports a rejected order (400) distinctly from a refusal', async () => {
      const mod = await loadModule(BASE)
      global.fetch.mockResolvedValueOnce({ ok: false, status: 400 })
      expect(await mod.saveNavTabs({ getToken: async () => TOKEN, tabs: ORDER })).toEqual({ ok: false, status: 400 })
    })

    it('reports status 0 — never reached the server — and NEVER throws', async () => {
      const mod = await loadModule(BASE)
      global.fetch.mockRejectedValueOnce(new Error('offline'))
      expect(await mod.saveNavTabs({ getToken: async () => TOKEN, tabs: ORDER })).toEqual({ ok: false, status: 0 })
    })

    it('reports 401 without a request when there is no token', async () => {
      const mod = await loadModule(BASE)
      expect(await mod.saveNavTabs({ getToken: async () => null, tabs: ORDER })).toEqual({ ok: false, status: 401 })
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('refuses a payload that is not a list of strings without spending a round trip', async () => {
      // Not the security boundary — the Lambda's fail-closed ADMIN_CLERK_SUBS gate is. This only
      // declines to spend a round trip on something the server would refuse anyway.
      const mod = await loadModule(BASE)
      for (const tabs of ['today', [1, 2], null, undefined, { 0: 'today' }]) {
        expect((await mod.saveNavTabs({ getToken: async () => TOKEN, tabs })).ok).toBe(false)
      }
      expect(global.fetch).not.toHaveBeenCalled()
    })
  })
})
