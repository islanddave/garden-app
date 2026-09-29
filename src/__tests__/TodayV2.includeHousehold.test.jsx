// V5-TODAYREDESIGN-001 S6 — "V2 always requests include=household" (plan-v2 §2.9, brief S6), through the REAL
// useDailyPlan: the plan read asks for the household on every load, whatever this device's household-view switch
// says. SF6 decides what is SHOWN, never what is asked: the server self-authorises and answers [] with no other
// member, so V2 has no toggle-driven reload (V1's BUG-TODAYHOUSEHOLDRELOADDROP-001 does not apply). A V2 that wired
// the switch into the request — as V1 does — goes red here.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { prefsState, auth } = vi.hoisted(() => ({
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'u0' }, profile: { id: 'u0' } },
}))
const api = vi.hoisted(() => {
  const calls = []
  const fetch = async (path) => {
    calls.push(path)
    if (String(path).startsWith('/api/daily-plan')) return { has_plan: false, plan: null, plan_date: '2026-09-24', generated_at: null, household_plans: [] }
    return null
  }
  return { calls, value: { getToken: async () => 't', fetch } }
})
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({ ...(await orig()), fetchNotificationPrefs: vi.fn(async () => null), saveTodaySkipped: vi.fn(async () => null) }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api.value }))
vi.mock('../hooks/useCachedFetch.js', () => ({ useCachedFetch: () => ({ data: null, loading: false, error: null }) }))

import TodayV2 from '../pages/TodayV2.jsx'

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) })
let n = 0

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); api.calls.length = 0; n++; auth.user = { id: 'u' + n }; auth.profile = { id: 'u' + n } })
afterEach(() => cleanup())

describe('V2 always asks for the household', () => {
  for (const [label, value] of [['switch unset', null], ['switch off ("0")', '0'], ['switch on ("1")', '1']]) {
    it(`${label}: the plan read is /api/daily-plan?include=household`, async () => {
      if (value != null) localStorage.setItem('garden.today.showOthers', value)
      render(<MemoryRouter><TodayV2 /></MemoryRouter>)
      await settle()
      const reads = api.calls.filter((p) => String(p).startsWith('/api/daily-plan'))
      expect(reads.length).toBeGreaterThan(0)
      for (const p of reads) expect(p).toBe('/api/daily-plan?include=household')
    })
  }
})
