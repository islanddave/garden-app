// The today-logged guard as one list sees it (useTodayLogged over needsCareStore) — the contract the pre-promote pass on
// BUG-TODAYV2DOUBLELOG-001 asked for (review-dbl-recut-prepromote-regression.md IMPORTANT-1, IMPORTANT-2):
//   · a claim (taken, POST not answered) lives in the page's memory, never in the tab's store — a reload must not keep it;
//   · it becomes a log, in the store, only when its POST answers;
//   · a mount leaves out what OTHER mounts hold (claimed or logged) and never its own rows;
//   · a release, or an Undo's un-write, reaches a list that is already mounted;
//   · a mount's own run does not rebuild its rows per POST.
// Two renderHook mounts of the same key stand for the page that was left and the Back remount. No jest-dom (L-182).
import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTodayLogged } from '../components/today/v2/useTodayLogged.js'
import { loggedKey, readLogged, removeLogged, claimedKeys, claimKeys, confirmKeys, releaseKeys, runStart, runEnd, runGoing, runTake, subscribeLogged, __resetTodayLogged } from '../components/today/v2/needsCareStore.js'

const KEY = loggedKey('u', '2026-09-24')
const K = ['p1:water_due', 'p2:water_due', 'p3:water_due']
const mount = () => renderHook(() => useTodayLogged(KEY))
const held = (h) => [...h.result.current.held].sort()

beforeEach(() => { sessionStorage.clear(); __resetTodayLogged() })

describe('useTodayLogged', () => {
  it('a claim is in memory only; it reaches the tab\'s store when its POST answers, and leaves both when it fails', () => {
    const a = mount()
    act(() => a.result.current.claim.onClaim(K))
    expect([...claimedKeys(KEY)].sort()).toEqual(K)
    expect(sessionStorage.getItem(KEY)).toBeNull()
    act(() => a.result.current.claim.onLogged([K[0]]))
    expect([...readLogged(KEY)]).toEqual([K[0]])
    expect([...claimedKeys(KEY)].sort()).toEqual([K[1], K[2]])
    act(() => a.result.current.claim.onRelease([K[1]]))
    expect([...claimedKeys(KEY)]).toEqual([K[2]])
    expect([...readLogged(KEY)]).toEqual([K[0]])
  })

  it('a mount leaves out what another mount holds, claimed or logged — and never its own', () => {
    const a = mount()
    const b = mount()
    act(() => a.result.current.claim.onClaim(K))
    expect(held(a)).toEqual([])
    expect(held(b)).toEqual(K)
    act(() => a.result.current.claim.onLogged([K[0]]))
    b.rerender()
    expect(held(a)).toEqual([])
    expect(held(b)).toEqual(K)
    // A later mount (the next Back): the same.
    expect(held(mount())).toEqual(K)
  })

  it('a release reaches a list already mounted, and so does an Undo\'s un-write — no remount', () => {
    const a = mount()
    const b = mount()
    act(() => a.result.current.claim.onClaim(K))
    act(() => a.result.current.claim.onLogged([K[0]]))
    act(() => a.result.current.claim.onRelease([K[1]]))
    expect(held(b)).toEqual([K[0], K[2]])
    act(() => removeLogged(KEY, [K[0]]))
    expect(held(b)).toEqual([K[2]])
  })

  it('a key another mount released and this mount takes is this mount\'s own from then on', () => {
    const a = mount()
    const b = mount()
    act(() => a.result.current.claim.onClaim([K[0]]))
    act(() => a.result.current.claim.onRelease([K[0]]))
    act(() => b.result.current.claim.onClaim([K[0]]))
    expect(held(b)).toEqual([])
    act(() => b.result.current.claim.onLogged([K[0]]))
    b.rerender()
    expect(held(b)).toEqual([])
    expect(held(mount())).toEqual([K[0]])
  })

  it('held keeps its identity through a mount\'s own run', () => {
    const a = mount()
    const before = a.result.current.held
    act(() => a.result.current.claim.onClaim(K))
    act(() => a.result.current.claim.onLogged([K[0]]))
    act(() => a.result.current.claim.onRelease([K[1]]))
    a.rerender()
    expect(a.result.current.held).toBe(before)
  })
})

describe('needsCareStore: what raises the signal a mounted list redraws on', () => {
  it('a claim, a release, an un-write, a run starting and a run ending each do; a landing does not (its own list already redraws on it)', () => {
    let n = 0
    const off = subscribeLogged(() => { n++ })
    claimKeys(KEY, K); expect(n).toBe(1)
    confirmKeys(KEY, [K[0]]); expect(n).toBe(1)
    releaseKeys(KEY, [K[1]]); expect(n).toBe(2)
    removeLogged(KEY, [K[0]]); expect(n).toBe(3)
    runStart('r1'); expect(n).toBe(4)
    expect(runGoing('r1')).toBe(true)
    expect(runTake('r1')).toBeNull() // a going run has no result to take
    runEnd('r1', { res: 'landed' }); expect(n).toBe(5)
    expect(runGoing('r1')).toBe(false)
    expect(runTake('r1').res).toBe('landed')
    expect(runTake('r1')).toBeNull() // taken once
    off()
    claimKeys(KEY, [K[1]]); expect(n).toBe(5)
  })
})

