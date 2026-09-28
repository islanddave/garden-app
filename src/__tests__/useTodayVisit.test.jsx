// V5-TODAYREDESIGN-001 S2 — the visit, Layer 2 (plan-v2 §2.1, §2.2), stored through visitLayout.js (S1b's
// store) as a kind 'v2' record under list 'v2'. A visit starts at the ready point on a mount that is not a
// page-scroll-manager return, and again on a new plan day; a POP return restores the stored record exactly.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { scroll } = vi.hoisted(() => ({ scroll: { returned: false } }))
vi.mock('../hooks/usePageScrollManager.js', () => ({ usePageScrollReturnAtMount: () => scroll.returned }))

import { useTodayVisit, effectiveOpen } from '../hooks/useTodayVisit.js'
import { readVisitRecord, readVisitLayout, visitLayoutKey, writeVisitRecord, V2_LIST } from '../components/today/visitLayout.js'

const D1 = '2026-09-24'
const D2 = '2026-09-25'
const key = (d = D1) => visitLayoutKey('u', d, V2_LIST)
const snap = (sections = ['care', 'resting'], layer1 = { care: false, resting: true }) => () => ({ order: { sections }, layer1, overlay: {}, triggers: {} })

beforeEach(() => { sessionStorage.clear(); scroll.returned = false })

describe('useTodayVisit', () => {
  it('holds nothing before the ready point, then starts a visit from the page\'s snapshot and stores it', () => {
    const { result, rerender } = renderHook(({ ready }) => useTodayVisit({ userId: 'u', planDate: D1, ready, start: snap() }), { initialProps: { ready: false } })
    expect(result.current.record).toBeNull()
    expect(result.current.isOpen('resting')).toBe(false)
    rerender({ ready: true })
    const r = result.current.record
    expect(r.order.sections).toEqual(['care', 'resting'])
    expect(result.current.isOpen('resting')).toBe(true)
    expect(result.current.isOpen('care')).toBe(false)
    expect(readVisitRecord(key())).toEqual(r)
    expect(key()).toBe('today-visit:u:2026-09-24:v2')
  })

  it('a fresh visit (not a return) ignores a stored record and replaces it', () => {
    writeVisitRecord(key(), { id: 'old', order: { sections: ['care'] }, layer1: { care: true }, overlay: {}, triggers: {} })
    const start = vi.fn(snap(['care'], { care: false }))
    const { result } = renderHook(() => useTodayVisit({ userId: 'u', planDate: D1, ready: true, start }))
    expect(start).toHaveBeenCalled()
    expect(result.current.record.id).not.toBe('old')
    expect(result.current.isOpen('care')).toBe(false)
    expect(readVisitRecord(key()).id).toBe(result.current.record.id)
  })

  it('a POP return restores the stored record exactly, in the first render, without a new snapshot', () => {
    const stored = { id: 'held', order: { sections: ['care', 'resting'] }, layer1: { care: true, resting: false }, overlay: { resting: 'open' }, triggers: {}, spots: { open: ['Bag Area'] } }
    writeVisitRecord(key(), stored)
    scroll.returned = true
    const start = vi.fn(snap())
    const { result } = renderHook(() => useTodayVisit({ userId: 'u', planDate: D1, ready: true, start }))
    expect(start).not.toHaveBeenCalled()
    expect(result.current.record).toEqual({ ...stored, v: 1, kind: 'v2' })
    expect(result.current.isOpen('care')).toBe(true)
    expect(result.current.isOpen('resting')).toBe(true)
  })

  it('a return with nothing stored is a fresh visit', () => {
    scroll.returned = true
    const start = vi.fn(snap())
    const { result } = renderHook(() => useTodayVisit({ userId: 'u', planDate: D1, ready: true, start }))
    expect(start).toHaveBeenCalled()
    expect(result.current.record).not.toBeNull()
  })

  it('a new plan day while mounted starts a new visit and prunes the old day', () => {
    const { result, rerender } = renderHook(({ planDate, start }) => useTodayVisit({ userId: 'u', planDate, ready: true, start }),
      { initialProps: { planDate: D1, start: snap(['care'], { care: true }) } })
    const first = result.current.record.id
    act(() => result.current.overlayAll(['care'], 'closed'))
    rerender({ planDate: D2, start: snap(['resting'], { resting: false }) })
    expect(result.current.record.id).not.toBe(first)
    expect(result.current.record.order.sections).toEqual(['resting'])
    expect(result.current.record.overlay).toEqual({})
    expect(readVisitRecord(key(D2))).not.toBeNull()
    expect(sessionStorage.getItem(key(D1))).toBeNull()
  })

  it('an explicit tap sets the section for the visit and spends any overlay on it', () => {
    const { result } = renderHook(() => useTodayVisit({ userId: 'u', planDate: D1, ready: true, start: snap() }))
    act(() => result.current.overlayAll(['care', 'resting'], 'open'))
    expect(result.current.isOpen('care')).toBe(true)
    act(() => result.current.tap('care', false))
    expect(result.current.isOpen('care')).toBe(false)
    expect(result.current.record.overlay).toEqual({ resting: 'open' })
    expect(readVisitRecord(key()).layer1.care).toBe(false)
  })

  it('Expand all / Collapse all are overlays: visit-only, over Layer 1', () => {
    const { result } = renderHook(() => useTodayVisit({ userId: 'u', planDate: D1, ready: true, start: snap() }))
    act(() => result.current.overlayAll(['care', 'resting'], 'closed'))
    expect(result.current.isOpen('resting')).toBe(false)
    expect(result.current.record.layer1).toEqual({ care: false, resting: true })
    act(() => result.current.overlayAll(['care', 'resting'], 'open'))
    expect(result.current.isOpen('care')).toBe(true)
  })

  it('no user or no plan day: the visit still works, and nothing is stored', () => {
    const { result } = renderHook(() => useTodayVisit({ userId: null, planDate: null, ready: true, start: snap(['care'], { care: true }) }))
    expect(result.current.isOpen('care')).toBe(true)
    expect(sessionStorage.length).toBe(0)
  })

  it('V1\'s reader never takes a V2 record, and a section outside the snapshot is closed', () => {
    const { result } = renderHook(() => useTodayVisit({ userId: 'u', planDate: D1, ready: true, start: snap() }))
    expect(readVisitLayout(key())).toBeNull()
    expect(result.current.isOpen('protect')).toBe(false)
    expect(effectiveOpen(null, 'care')).toBe(false)
    expect(effectiveOpen({ layer1: { care: true }, overlay: { care: 'closed' } }, 'care')).toBe(false)
  })
})
