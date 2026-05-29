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

  describe('CRITTER_VISIT_VALUES', () => {
    it('exports the canonical allowed values', async () => {
      const mod = await loadModule('https://staging.example.com')
      expect(mod.CRITTER_VISIT_VALUES).toEqual(['off', 'in_app_only', 'system'])
    })
  })
})
