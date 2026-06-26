// notificationPrefsClient tests — MVP-Critter Session 4 Phase A.
// Mirrors src/__tests__/critterClient.test.js patterns.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
