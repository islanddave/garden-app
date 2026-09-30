// V4-RANKCLEAR-001 — client preference keys must not survive a sign-out onto a shared device.
//
// Two halves, both load-bearing:
//   1. clearClientPrefs() removes the enumerated keys AND the per-crop prefix family, and removes
//      NOTHING else. The negative half is the real assertion — a localStorage.clear() would pass
//      every positive case here and take drafts, mode and lens state with it.
//   2. The helper is actually WIRED to AuthContext.signOut(), before the Clerk call. A helper
//      nobody invokes is the failure mode this ticket exists to avoid.
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

  it('the enumerated list is exactly these keys and prefixes', () => {
    // Pins the SCOPE, not the behaviour: widening this set is a deliberate decision, not a drive-by.
    // Widened by V4-USERPREFS-001 (2026-08-17), deliberately: the three keys added there are
    // per-device CACHES of per-user server state, read synchronously to seed first render. That
    // read is the window in which the second person to sign in sees the first person's answer, so
    // they belong here for the same reason the original three did.
    // Widened again by V4-HANDEDNESSCONTROLS-001 (2026-08-25): same shape, higher stakes — the
    // inherited value decides which side a destructive control sits on, not merely a sort order.
    // Widened by BUG-TODAYSKIPNOUNDO-001 (2026-09-24): 'today-unskipped:', the skip set's companion,
    // shipped without an entry here and the release review caught it.
    // Widened again by V5-NAVCUSTOM-001 (2026-09-24), deliberately and in the same shape: the three
    // nav.* keys are launch caches of the per-person bar and pins (D4), read before prefs land.
    // Widened by V5-TODAYREDESIGN-001 S2 (2026-09-28): 'garden.todayV2' (the per-device preview switch — a
    // person's choice on a shared phone) and the redesigned Today's two localStorage families,
    // 'today-sections:' (the remembered open/closed mirror) and 'today-seen:' (chill first-seen, S5).
    // Widened by V5-TODAYREDESIGN-001 integration 2 (2026-09-29): 'garden.today.showOthers', the household view
    // switch both Today pages read — a person's choice on a shared phone, like 'garden.todayV2'.
    expect(CLIENT_PREF_KEYS).toEqual([
      'croprank.v1', 'logone.lastPlant', 'lastHarvestUnit',
      'quicklog.defaultAllSelected', 'garden.releasesSeenVersion', 'ui.handedness',
      'nav.barLayout.v1', 'nav.morePins.v1', 'nav.morePins.pending.v1',
      'garden.todayV2', 'garden.today.showOthers',
    ])
    expect(CLIENT_PREF_KEY_PREFIXES).toEqual(['lastHarvestUnit:', 'today-skipped:', 'today-unskipped:', 'today-sections:', 'today-seen:'])
  })

  // BUG-TODAYSKIPNOUNDO-001 — the Undo veto set, cleared like the skip set it vetoes. Left behind,
  // the next person on the phone has their own server skips of those rows ignored the same day.
  it('clears EVERY dated un-skip key too', () => {
    localStorage.setItem('today-unskipped:2026-09-24', '["p1:water_due"]')
    localStorage.setItem('today-unskipped:2026-09-23', '["p2:water_due"]')
    localStorage.setItem('today-skipped:2026-09-24', '["p3:water_due"]')
    localStorage.setItem('unrelated.key', 'keep me')
    clearClientPrefs()
    expect(localStorage.getItem('today-unskipped:2026-09-24')).toBeNull()
    expect(localStorage.getItem('today-unskipped:2026-09-23')).toBeNull()
    expect(localStorage.getItem('today-skipped:2026-09-24')).toBeNull()
    expect(localStorage.getItem('unrelated.key')).toBe('keep me')
  })

  // The census that would have caught the miss above: every dated 'today-…:' storage family the Today
  // care list writes must be scrubbed at sign-out. Read off the SOURCE so a new family added without
  // an entry here fails the suite — of every file that holds the care list's state: CareNeeded, and
  // the careStore / useCareActions its skip store and write paths were lifted into
  // (V5-TODAYREDESIGN-001 S1). Non-vacuous: careStore writes two families today.
  it('every today-…: storage family CareNeeded writes is in the prefix list', () => {
    const src = ['CareNeeded.jsx', 'careStore.js', 'useCareActions.js']
      .map(f => readFileSync(resolve(process.cwd(), 'src/components/today', f), 'utf8')).join('\n')
    const families = [...new Set([...src.matchAll(/'(today-[a-z-]+:)'/g)].map(m => m[1]))]
    expect(families.sort()).toEqual(['today-skipped:', 'today-unskipped:'])
    for (const f of families) expect(CLIENT_PREF_KEY_PREFIXES).toContain(f)
  })

  // V5-TODAYREDESIGN-001 S2 — the same census over the REDESIGNED Today: every file under today/v2, the V2
  // hooks and the flag module, read as a directory walk so a file a later slice adds is covered without
  // editing this test. A family may sit in either store's list (the session families are walked from
  // sessionStorage), but it must sit in one. Non-vacuous: useTodaySections.js writes 'today-sections:'.
  it('every today-…: storage family the redesigned Today writes is cleared at sign-out', async () => {
    const { CLIENT_SESSION_KEY_PREFIXES } = await import('../lib/clientPrefs.js')
    const { readdirSync } = await import('node:fs')
    const v2dir = resolve(process.cwd(), 'src/components/today/v2')
    const files = [
      ...readdirSync(v2dir).map(f => resolve(v2dir, f)),
      ...['src/hooks/useTodaySections.js', 'src/hooks/useTodayVisit.js', 'src/lib/todayV2Flag.js', 'src/pages/TodayV2.jsx']
        .map(f => resolve(process.cwd(), f)),
    ]
    const src = files.map(f => readFileSync(f, 'utf8')).join('\n')
    const families = [...new Set([...src.matchAll(/'(today-[a-z-]+:)'/g)].map(m => m[1]))]
    expect(families).toContain('today-sections:')
    for (const f of families) expect([...CLIENT_PREF_KEY_PREFIXES, ...CLIENT_SESSION_KEY_PREFIXES]).toContain(f)
    expect(src).toContain("'garden.todayV2'")
    expect(CLIENT_PREF_KEYS).toContain('garden.todayV2')
  })

  // V5-TODAYREDESIGN-001 integration 2 — the household view switch is scrubbed at sign-out, so the next person on a
  // shared phone starts with it OFF (V1's pill and the redesigned Today read the same switch). Read through
  // householdView's own constant and reader, so a renamed key that survived sign-out would red here.
  it('clears the household view switch, by householdView\'s own key', async () => {
    const { SHOW_OTHERS_KEY, readShowOthers, writeShowOthers } = await import('../lib/householdView.js')
    expect(CLIENT_PREF_KEYS).toContain(SHOW_OTHERS_KEY)
    writeShowOthers(true)
    localStorage.setItem('mode', 'field')
    expect(readShowOthers()).toBe(true)
    clearClientPrefs()
    expect(localStorage.getItem(SHOW_OTHERS_KEY)).toBeNull()
    expect(readShowOthers()).toBe(false)
    expect(localStorage.getItem('mode')).toBe('field')
  })

  // The list above holds literals (an import would close an AuthContext cycle), so this is what
  // stops NavPrefsContext renaming a key and leaving the new one to survive sign-out.
  // KILLING MUTATION: rename a key in NavPrefsContext (e.g. nav.barLayout.v2) without listing it.
  // RESULT: RED.
  it('every NavPrefsContext launch cache is cleared at sign-out', async () => {
    const nav = await import('../context/NavPrefsContext.jsx')
    for (const key of [nav.BAR_LAYOUT_CACHE_KEY, nav.MORE_PINS_CACHE_KEY, nav.MORE_PINS_PENDING_KEY]) {
      expect(typeof key).toBe('string')
      expect(CLIENT_PREF_KEYS).toContain(key)
    }
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

  // Put-Up 1a (V4 §6.5): "the sign-out funnel clears the sub's drafts" — this person's only.
  it("clears the signed-in person's Put-Up sheet drafts before the Clerk call, and nobody else's", async () => {
    const MINE = ['garden:putup-draft:v1:user-1:start:new', 'garden:putup-draft:v1:user-1:checkin:kb-9']
    const THEIRS = 'garden:putup-draft:v1:user-2:start:new'
    for (const k of [...MINE, THEIRS]) localStorage.setItem(k, '{"v":1}')
    let draftsGoneAtClerkCall = null
    clerkSignOutSpy.mockImplementation(() => {
      draftsGoneAtClerkCall = MINE.every((k) => localStorage.getItem(k) === null)
      return Promise.resolve()
    })
    const fire = { current: null }
    render(<AuthProvider><SignOutProbe fire={fire} /></AuthProvider>)
    await act(async () => { await fire.current() })

    expect(draftsGoneAtClerkCall).toBe(true)
    for (const k of MINE) expect(localStorage.getItem(k)).toBeNull()
    expect(localStorage.getItem(THEIRS)).toBe('{"v":1}')
  })
})
