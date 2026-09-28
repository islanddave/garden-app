// BUG-TODAYBACKRESORT-001 — the Today visit layout ('today-visit:…', components/today/visitLayout.js) is
// the first family clearClientPrefs removes from sessionStorage rather than localStorage. Same two halves
// as clientPrefs.test.jsx, which pins the localStorage lists exactly and is left as it was:
//   1. clearClientPrefs() removes every visit key and NOTHING else from sessionStorage, and a throwing
//      store on either side never keeps the other from being cleared.
//   2. It is reached through AuthContext.signOut(), before the Clerk call.
import React, { useEffect } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

const { clerkSignOutSpy } = vi.hoisted(() => ({ clerkSignOutSpy: vi.fn(() => Promise.resolve()) }))

vi.mock('@clerk/react', () => ({
  useUser: () => ({ user: { id: 'user-1', fullName: 'Dave', emailAddresses: [] }, isSignedIn: true, isLoaded: true }),
  useClerk: () => ({ signOut: clerkSignOutSpy, client: { signIn: {} } }),
}))
vi.mock('../lib/dataCache.js', () => ({ invalidateAll: vi.fn() }))
vi.mock('../hooks/useCacheLifecycle.js', () => ({ useCacheLifecycle: () => {} }))

import { clearClientPrefs, CLIENT_PREF_KEYS, CLIENT_PREF_KEY_PREFIXES, CLIENT_SESSION_KEY_PREFIXES } from '../lib/clientPrefs.js'
import { VISIT_PREFIX, visitLayoutKey, writeVisitLayout, readVisitLayout } from '../components/today/visitLayout.js'
import { AuthProvider, useAuth } from '../context/AuthContext.jsx'

const LAYOUT = { mode: 'location', enriched: true, order: ['locD', 'locB'], open: ['locD'] }
// Six visit keys — two users, two days, two lists — so a forward walk that deletes as it goes (and so
// skips every other match) leaves some behind. Plus what must SURVIVE in sessionStorage.
const VISITS = [
  visitLayoutKey('sub-dave', '2026-09-28'), visitLayoutKey('sub-dave', '2026-09-28', 'jen'),
  visitLayoutKey('sub-dave', '2026-09-27'), visitLayoutKey('jen', '2026-09-28'),
  visitLayoutKey('jen', '2026-09-28', 'sub-dave'), visitLayoutKey('jen', '2026-09-27'),
]
const KEEP_SESSION = { 'garden.pageScroll.v1': '{"k":1}', 'today-visit': 'no colon, not the family', 'x.today-visit:y': 'not a prefix' }

function seedSession() {
  for (const k of VISITS) sessionStorage.setItem(k, JSON.stringify({ v: 1, ...LAYOUT }))
  for (const [k, v] of Object.entries(KEEP_SESSION)) sessionStorage.setItem(k, v)
}

function withThrowing(name, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name)
  const throwing = {
    length: 1,
    key() { throw new Error('denied') },
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
    removeItem() { throw new Error('denied') },
    clear() { throw new Error('denied') },
  }
  Object.defineProperty(globalThis, name, { value: throwing, writable: true, configurable: true })
  try { fn() } finally { if (original) Object.defineProperty(globalThis, name, original) }
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  clerkSignOutSpy.mockClear(); clerkSignOutSpy.mockResolvedValue(undefined)
})

describe('clearClientPrefs — the sessionStorage visit layout', () => {
  it('removes every visit key, of every user, day and list, and nothing else in sessionStorage', () => {
    seedSession()
    expect(VISITS.every(k => k.startsWith(VISIT_PREFIX))).toBe(true)
    clearClientPrefs()
    for (const k of VISITS) expect(sessionStorage.getItem(k)).toBeNull()
    for (const [k, v] of Object.entries(KEEP_SESSION)) expect(sessionStorage.getItem(k)).toBe(v)
    expect(sessionStorage.length).toBe(Object.keys(KEEP_SESSION).length)
  })

  it('leaves localStorage as it was: a visit-shaped key there is not this family', () => {
    localStorage.setItem(VISITS[0], 'x')
    localStorage.setItem('garden.lens', 'crop')
    clearClientPrefs()
    expect(localStorage.getItem(VISITS[0])).toBe('x')
    expect(localStorage.getItem('garden.lens')).toBe('crop')
  })

  it('a throwing sessionStorage does not throw, and localStorage prefs are still cleared', () => {
    for (const k of CLIENT_PREF_KEYS) localStorage.setItem(k, 'x')
    localStorage.setItem('today-skipped:2026-09-28', '["a"]')
    withThrowing('sessionStorage', () => expect(() => clearClientPrefs()).not.toThrow())
    for (const k of CLIENT_PREF_KEYS) expect(localStorage.getItem(k)).toBeNull()
    expect(localStorage.getItem('today-skipped:2026-09-28')).toBeNull()
  })

  it('a throwing localStorage does not keep the visit keys from being cleared', () => {
    seedSession()
    withThrowing('localStorage', () => expect(() => clearClientPrefs()).not.toThrow())
    for (const k of VISITS) expect(sessionStorage.getItem(k)).toBeNull()
  })

  // Widened by V5-TODAYREDESIGN-001 S2 (2026-09-28): the redesigned Today's two tab-scoped families
  // (plan-v2 §2.1 Layer 2), listed ahead of the slices that write them — clientPrefs.test.jsx's V2 census
  // reds a family written anywhere under today/v2 or the V2 hooks without an entry.
  it('the session list is exactly the visit family — visitLayout\'s own prefix, and in no localStorage list', () => {
    expect(CLIENT_SESSION_KEY_PREFIXES).toEqual(['today-visit:', 'today-filters:', 'today-logged:'])
    expect(CLIENT_SESSION_KEY_PREFIXES).toContain(VISIT_PREFIX)
    expect(CLIENT_PREF_KEY_PREFIXES.includes(VISIT_PREFIX)).toBe(false)
    expect(CLIENT_PREF_KEYS.includes(VISIT_PREFIX)).toBe(false)
  })

  // Read off the SOURCE, like clientPrefs.test.jsx's census: a second family added to visitLayout.js
  // without an entry in CLIENT_SESSION_KEY_PREFIXES fails here. Non-vacuous: it finds the one there is.
  it('every today-…: family visitLayout.js writes is in the session prefix list', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/today/visitLayout.js'), 'utf8')
    const families = [...new Set([...src.matchAll(/'(today-[a-z-]+:)'/g)].map(m => m[1]))]
    expect(families).toEqual(['today-visit:'])
    for (const f of families) expect(CLIENT_SESSION_KEY_PREFIXES).toContain(f)
  })

  it('what visitLayout writes is what clearClientPrefs removes (behavioural, through the store itself)', () => {
    writeVisitLayout(visitLayoutKey('sub-dave', '2026-09-28'), LAYOUT)
    writeVisitLayout(visitLayoutKey('sub-dave', '2026-09-28', 'jen'), LAYOUT)
    expect(readVisitLayout(visitLayoutKey('sub-dave', '2026-09-28'))).toEqual(LAYOUT)
    clearClientPrefs()
    expect(readVisitLayout(visitLayoutKey('sub-dave', '2026-09-28'))).toBeNull()
    expect(readVisitLayout(visitLayoutKey('sub-dave', '2026-09-28', 'jen'))).toBeNull()
  })
})

describe('visitLayout — the store on its own', () => {
  it('no user or no plan date: no key, nothing read, nothing written', () => {
    expect(visitLayoutKey(null, '2026-09-28')).toBeNull()
    expect(visitLayoutKey('sub-dave', undefined)).toBeNull()
    writeVisitLayout(null, LAYOUT)
    expect(readVisitLayout(null)).toBeNull()
    expect(sessionStorage.length).toBe(0)
  })

  it('writing prunes every other plan day, and only visit keys', () => {
    sessionStorage.setItem('garden.pageScroll.v1', 'keep')
    writeVisitLayout(visitLayoutKey('sub-dave', '2026-09-27'), LAYOUT)
    writeVisitLayout(visitLayoutKey('jen', '2026-09-27', 'x'), LAYOUT)
    writeVisitLayout(visitLayoutKey('sub-dave', '2026-09-28', 'jen'), LAYOUT)
    writeVisitLayout(visitLayoutKey('sub-dave', '2026-09-28'), LAYOUT)
    expect(Object.keys(sessionStorage).filter(k => k.startsWith(VISIT_PREFIX)).sort()).toEqual([
      visitLayoutKey('sub-dave', '2026-09-28'), visitLayoutKey('sub-dave', '2026-09-28', 'jen'),
    ].sort())
    expect(sessionStorage.getItem('garden.pageScroll.v1')).toBe('keep')
  })

  it('a null layout removes the entry; anything unreadable reads as nothing held', () => {
    const k = visitLayoutKey('sub-dave', '2026-09-28')
    writeVisitLayout(k, LAYOUT)
    writeVisitLayout(k, null)
    expect(sessionStorage.getItem(k)).toBeNull()
    for (const bad of ['{', '[]', '{"v":2,"mode":"location","enriched":true,"order":[],"open":[]}',
      '{"v":1,"mode":"spot","enriched":true,"order":[],"open":[]}', '{"v":1,"mode":"type","order":[],"open":[]}']) {
      sessionStorage.setItem(k, bad)
      expect(readVisitLayout(k)).toBeNull()
    }
  })

  it('a throwing sessionStorage reads as nothing held and writes nothing, without throwing', () => {
    withThrowing('sessionStorage', () => {
      expect(readVisitLayout(visitLayoutKey('sub-dave', '2026-09-28'))).toBeNull()
      expect(() => writeVisitLayout(visitLayoutKey('sub-dave', '2026-09-28'), LAYOUT)).not.toThrow()
    })
  })
})

describe('AuthContext.signOut — clears the visit layout too', () => {
  function SignOutProbe({ fire }) {
    const { signOut } = useAuth()
    useEffect(() => { if (fire) fire.current = signOut }, [fire, signOut])
    return null
  }

  it('before the Clerk call, so a signOut that navigates away cannot skip it', async () => {
    seedSession()
    let goneAtClerkCall = null
    clerkSignOutSpy.mockImplementation(() => {
      goneAtClerkCall = VISITS.every(k => sessionStorage.getItem(k) === null)
      return Promise.resolve()
    })
    const fire = { current: null }
    render(<AuthProvider><SignOutProbe fire={fire} /></AuthProvider>)
    await act(async () => { await fire.current() })
    expect(clerkSignOutSpy).toHaveBeenCalledTimes(1)
    expect(goneAtClerkCall).toBe(true)
    for (const [k, v] of Object.entries(KEEP_SESSION)) expect(sessionStorage.getItem(k)).toBe(v)
  })
})
