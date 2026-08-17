// V4-RANKCLEAR-001 — client preference keys must not survive a sign-out onto a shared device.
//
// Two halves, both load-bearing:
//   1. clearClientPrefs() removes the enumerated keys AND the per-crop prefix family, and removes
//      NOTHING else. The negative half is the real assertion — a localStorage.clear() would pass
//      every positive case here and take drafts, mode and lens state with it.
//   2. The helper is actually WIRED to AuthContext.signOut(), before the Clerk call. A helper
//      nobody invokes is the failure mode this ticket exists to avoid.
import React, { useEffect } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

const { clerkSignOutSpy } = vi.hoisted(() => ({ clerkSignOutSpy: vi.fn(() => Promise.resolve()) }))

vi.mock('@clerk/react', () => ({
  useUser: () => ({ user: { id: 'user-1', fullName: 'Dave', emailAddresses: [] }, isSignedIn: true, isLoaded: true }),
  useClerk: () => ({ signOut: clerkSignOutSpy, client: { signIn: {} } }),
}))
vi.mock('../lib/dataCache.js', () => ({ invalidateAll: vi.fn() }))
vi.mock('../hooks/useCacheLifecycle.js', () => ({ useCacheLifecycle: () => {} }))

import { clearClientPrefs, CLIENT_PREF_KEYS, CLIENT_PREF_KEY_PREFIXES } from '../lib/clientPrefs.js'
import { AuthProvider, useAuth } from '../context/AuthContext.jsx'

// Everything the app is known to park in localStorage that must SURVIVE — the negative control.
const KEEP = {
  'garden.lens': 'crop',
  'mode': 'field',
  'eventNew.draft': '{"note":"half-typed"}',
  'logmany.stickyType': 'water',
  'whatsnew.seen': '4.13.0',
}

beforeEach(() => {
  localStorage.clear()
  clerkSignOutSpy.mockClear()
  clerkSignOutSpy.mockResolvedValue(undefined)
})

function seedAll() {
  for (const k of CLIENT_PREF_KEYS) localStorage.setItem(k, 'x')
  localStorage.setItem('lastHarvestUnit:tomato', 'lb')
  localStorage.setItem('lastHarvestUnit:okra', 'count')
  for (const [k, v] of Object.entries(KEEP)) localStorage.setItem(k, v)
}

describe('clearClientPrefs — removes exactly the enumerated keys', () => {
  it('clears every enumerated key and every per-crop harvest-unit key', () => {
    seedAll()
    clearClientPrefs()
    for (const k of CLIENT_PREF_KEYS) expect(localStorage.getItem(k)).toBeNull()
    expect(localStorage.getItem('lastHarvestUnit:tomato')).toBeNull()
    expect(localStorage.getItem('lastHarvestUnit:okra')).toBeNull()
  })

  it('leaves unrelated state untouched — this is what makes it not a blanket clear', () => {
    seedAll()
    clearClientPrefs()
    for (const [k, v] of Object.entries(KEEP)) expect(localStorage.getItem(k)).toBe(v)
    expect(localStorage.length).toBe(Object.keys(KEEP).length)
  })

  it('removes the WHOLE prefix family — Storage.key() re-indexes as entries are deleted', () => {
    // Walking forward while deleting skips every other match; six keys catches that off-by-one.
    for (const slug of ['a', 'b', 'c', 'd', 'e', 'f']) localStorage.setItem(`lastHarvestUnit:${slug}`, 'lb')
    localStorage.setItem('mode', 'desk')
    clearClientPrefs()
    expect(localStorage.length).toBe(1)
    expect(localStorage.getItem('mode')).toBe('desk')
  })

  it('is a no-op on an empty store and safe to call twice', () => {
    expect(() => { clearClientPrefs(); clearClientPrefs() }).not.toThrow()
    expect(localStorage.length).toBe(0)
  })

  it('swallows a throwing localStorage — sign-out must never fail on a storage quirk', () => {
    // Replace the GLOBAL, not Storage.prototype: setup.ts swaps in a plain-object storage shim on
    // Node versions where jsdom's Storage is missing, and a prototype spy silently misses it —
    // the test would pass vacuously on exactly the runtime it is meant to cover.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const throwing = {
      length: 1,
      key() { throw new Error('denied') },
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') },
      removeItem() { throw new Error('denied') },
      clear() { throw new Error('denied') },
    }
    Object.defineProperty(globalThis, 'localStorage', { value: throwing, writable: true, configurable: true })
    try {
      expect(() => clearClientPrefs()).not.toThrow()
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
    }
  })

  it('the enumerated list is exactly the five keys plus the two prefixes', () => {
    // Pins the SCOPE, not the behaviour: widening this set is a deliberate decision, not a drive-by.
    // Widened by V4-USERPREFS-001 (2026-08-17), deliberately: the three keys added there are
    // per-device CACHES of per-user server state, read synchronously to seed first render. That
    // read is the window in which the second person to sign in sees the first person's answer, so
    // they belong here for the same reason the original three did.
    expect(CLIENT_PREF_KEYS).toEqual([
      'croprank.v1', 'logone.lastPlant', 'lastHarvestUnit',
      'quicklog.defaultAllSelected', 'garden.releasesSeenVersion',
    ])
    expect(CLIENT_PREF_KEY_PREFIXES).toEqual(['lastHarvestUnit:', 'today-skipped:'])
  })

  // V4-USERPREFS-001 — behavioural, not just enumerative. The list above could be right while the
  // prefix walk silently missed the new entry (it snapshots keys before removing, and a second
  // prefix is the first time that loop handles more than one).
  it('actually clears the V4-USERPREFS-001 caches, including EVERY dated skip key', () => {
    localStorage.setItem('quicklog.defaultAllSelected', '0')
    localStorage.setItem('garden.releasesSeenVersion', '4.31.0')
    localStorage.setItem('today-skipped:2026-08-17', '["a"]')
    localStorage.setItem('today-skipped:2026-08-16', '["b"]')
    localStorage.setItem('unrelated.key', 'keep me')
    clearClientPrefs()
    expect(localStorage.getItem('quicklog.defaultAllSelected')).toBeNull()
    expect(localStorage.getItem('garden.releasesSeenVersion')).toBeNull()
    expect(localStorage.getItem('today-skipped:2026-08-17')).toBeNull()
    expect(localStorage.getItem('today-skipped:2026-08-16')).toBeNull()
    // The blast-radius half: a blanket localStorage.clear() would pass every line above.
    expect(localStorage.getItem('unrelated.key')).toBe('keep me')
  })
})

describe('AuthContext.signOut — the wiring', () => {
  function SignOutProbe({ fire }) {
    const { signOut } = useAuth()
    useEffect(() => { if (fire) fire.current = signOut }, [fire, signOut])
    return null
  }

  it('clears the prefs and still signs out of Clerk', async () => {
    seedAll()
    const fire = { current: null }
    render(<AuthProvider><SignOutProbe fire={fire} /></AuthProvider>)
    await act(async () => { await fire.current() })

    expect(clerkSignOutSpy).toHaveBeenCalledTimes(1)
    for (const k of CLIENT_PREF_KEYS) expect(localStorage.getItem(k)).toBeNull()
    expect(localStorage.getItem('lastHarvestUnit:tomato')).toBeNull()
    for (const [k, v] of Object.entries(KEEP)) expect(localStorage.getItem(k)).toBe(v)
  })

  it('clears BEFORE the Clerk call, so a signOut that navigates away cannot skip it', async () => {
    seedAll()
    let prefsGoneAtClerkCall = null
    clerkSignOutSpy.mockImplementation(() => {
      prefsGoneAtClerkCall = localStorage.getItem('croprank.v1') === null
      return Promise.resolve()
    })
    const fire = { current: null }
    render(<AuthProvider><SignOutProbe fire={fire} /></AuthProvider>)
    await act(async () => { await fire.current() })

    expect(prefsGoneAtClerkCall).toBe(true)
  })
})
