// V5-TODAYREDESIGN-001 S2 — Layer 1, the remembered open/closed state (plan-v2 §2.1, §13 MF1 + Simplify 4).
// The mirror is localStorage 'today-sections:<user>' = {v:1, s:{…}, dirty:[…]}; the server column is S7's.
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { FROM_CACHE } from '../lib/api.js'
import {
  useTodaySections, sectionsKey, readMirror, writeMirror, serverSections, resolveSection, withEntry, validEntry, SECTIONS_PREFIX,
} from '../hooks/useTodaySections.js'

const D = '2026-09-24'
const mirrorOf = (s, dirty = []) => JSON.stringify({ v: 1, s, dirty })
beforeEach(() => localStorage.clear())

describe('the mirror and the read precedence', () => {
  it('keys the mirror by user, and no user means no mirror', () => {
    expect(sectionsKey('user_a')).toBe('today-sections:user_a')
    expect(sectionsKey(null)).toBeNull()
    expect(SECTIONS_PREFIX).toBe('today-sections:')
  })

  it('a dirty mirror entry beats the server, the server beats a clean mirror entry, the mirror beats nothing', () => {
    const server = { care: { open: true, at: D }, harvest: { open: true, at: D } }
    const mirror = { s: { care: { open: false, at: D }, harvest: { open: false, at: D }, resting: { open: true, at: D } }, dirty: ['care'] }
    expect(resolveSection('care', mirror, server)).toEqual({ open: false, at: D })     // dirty mirror wins
    expect(resolveSection('harvest', mirror, server)).toEqual({ open: true, at: D })   // server beats clean mirror
    expect(resolveSection('resting', mirror, server)).toEqual({ open: true, at: D })   // mirror beats nothing
    expect(resolveSection('putup', mirror, server)).toBeNull()                          // default: closed
  })

  it('ignores a server body the service worker served from its cache', () => {
    const prefs = { today_sections: { v: 1, care: { open: true, at: D } } }
    expect(serverSections(prefs)).toEqual({ care: { open: true, at: D } })
    Object.defineProperty(prefs, FROM_CACHE, { value: true, enumerable: false })
    expect(serverSections(prefs)).toBeNull()
  })

  it('a version other than 1 reads as nothing, on either side', () => {
    expect(serverSections({ today_sections: { v: 2, care: { open: true, at: D } } })).toBeNull()
    localStorage.setItem('today-sections:u', JSON.stringify({ v: 2, s: { care: { open: true, at: D } }, dirty: [] }))
    expect(readMirror('today-sections:u')).toBeNull()
  })

  it('drops malformed entries and dirty keys that name no entry', () => {
    localStorage.setItem('today-sections:u', JSON.stringify({ v: 1, s: { care: { open: 'yes', at: D }, resting: { open: true, at: '24 Sep' }, harvest: { open: true, at: D } }, dirty: ['care', 'harvest', 7] }))
    expect(readMirror('today-sections:u')).toEqual({ s: { harvest: { open: true, at: D } }, dirty: ['harvest'] })
    expect(readMirror('today-sections:missing')).toBeNull()
    localStorage.setItem('today-sections:bad', '{not json')
    expect(readMirror('today-sections:bad')).toBeNull()
  })

  it('an entry carries open + a plan day, and an optional ack (MF1)', () => {
    expect(validEntry({ open: false, at: D, ack: { t: 'chill' } })).toBe(true)
    expect(validEntry({ open: false, at: D, ack: 'chill' })).toBe(false)
    expect(validEntry({ open: true })).toBe(false)
    expect(withEntry(null, 'care', { open: true, at: D })).toEqual({ s: { care: { open: true, at: D } }, dirty: ['care'] })
  })

  it('writeMirror stores exactly {v, s, dirty}', () => {
    writeMirror('today-sections:u', { s: { care: { open: true, at: D } }, dirty: ['care'] })
    expect(JSON.parse(localStorage.getItem('today-sections:u'))).toEqual({ v: 1, s: { care: { open: true, at: D } }, dirty: ['care'] })
  })
})

describe('useTodaySections', () => {
  it('reads this user\'s mirror, and re-reads when the user changes (never the last person\'s)', () => {
    localStorage.setItem('today-sections:a', mirrorOf({ care: { open: true, at: D } }))
    const { result, rerender } = renderHook(({ userId }) => useTodaySections({ userId, prefs: null }), { initialProps: { userId: 'a' } })
    expect(result.current.mirrorExists).toBe(true)
    expect(result.current.resolve('care')).toEqual({ open: true, at: D })
    rerender({ userId: 'b' })
    expect(result.current.mirrorExists).toBe(false)
    expect(result.current.resolve('care')).toBeNull()
  })

  it('a tap lands in the mirror first, marked dirty, and then beats the server', () => {
    const prefs = { today_sections: { v: 1, care: { open: true, at: D } } }
    const { result } = renderHook(() => useTodaySections({ userId: 'u', prefs }))
    expect(result.current.resolve('care')).toEqual({ open: true, at: D })
    act(() => result.current.remember('care', { open: false, at: D }))
    expect(JSON.parse(localStorage.getItem('today-sections:u'))).toEqual({ v: 1, s: { care: { open: false, at: D } }, dirty: ['care'] })
    expect(result.current.resolve('care')).toEqual({ open: false, at: D })
    expect(result.current.pending).toEqual({ care: { open: false, at: D } })
  })

  it('markSent (S7\'s seam) clears exactly the confirmed keys, after which the server answer counts again', () => {
    const prefs = { today_sections: { v: 1, care: { open: true, at: D } } }
    const { result } = renderHook(() => useTodaySections({ userId: 'u', prefs }))
    act(() => { result.current.remember('care', { open: false, at: D }) })
    act(() => { result.current.remember('resting', { open: true, at: D }) })
    act(() => result.current.markSent(['care']))
    expect(JSON.parse(localStorage.getItem('today-sections:u')).dirty).toEqual(['resting'])
    expect(result.current.resolve('care')).toEqual({ open: true, at: D })
  })

  it('a tap re-reads storage first, so another tab\'s tap on this device survives', () => {
    const { result } = renderHook(() => useTodaySections({ userId: 'u', prefs: null }))
    localStorage.setItem('today-sections:u', mirrorOf({ harvest: { open: true, at: D } }, ['harvest']))
    act(() => result.current.remember('care', { open: true, at: D }))
    expect(Object.keys(JSON.parse(localStorage.getItem('today-sections:u')).s).sort()).toEqual(['care', 'harvest'])
  })

  it('refuses a malformed entry, and with no user keeps the tap in memory only', () => {
    const { result } = renderHook(() => useTodaySections({ userId: null, prefs: null }))
    act(() => result.current.remember('care', { open: 'x', at: D }))
    expect(result.current.mirrorExists).toBe(false)
    act(() => result.current.remember('care', { open: true, at: D }))
    expect(result.current.resolve('care')).toEqual({ open: true, at: D })
    expect(localStorage.length).toBe(0)
  })
})
