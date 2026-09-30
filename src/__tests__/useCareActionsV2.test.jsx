// V5-TODAYREDESIGN-001 S4 — useCareActions' V2 options (plan-v2 §6.7 as cut by §13 Simplify 1 + SF12).
// S1 left `runBulk(etype, keys, opts)` reading no option; S4 builds them. What is pinned here:
//   · opts ABSENT = the V1 run, unchanged: one POST at a time, the toast raised, bed-wait applied list-wide;
//   · `concurrency` caps the POSTs in flight (4) and every row posts exactly once, keepalive;
//   · `excludeInFlight` leaves a key already being written out of the run, and reports it (the one-tap +
//     bulk double log, BUG-BULKDOUBLELOGINFLIGHT-001, closed for V2);
//   · `bodyEventType` posts that type (Moist on a water row);
//   · the caller's keys are used as given — V2 decides bed-wait per group (D7), not list-wide;
//   · failures stay on the list and are named; `undoMany` deletes exactly the successes, ≤ 4 in flight,
//     and never un-fades a row whose delete it cannot confirm.
// No jest-dom (L-182).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: vi.fn(async () => null),
  saveTodaySkipped: vi.fn(async () => null),
}))

import { useCareActions } from '../components/today/useCareActions.js'
import { buildCareNeeded } from '../lib/careNeeded.js'
import { todayLocalISO } from '../components/today/careStore.js'

const water = (id, extra = {}) => ({ id, name: 'Plant ' + id, crop: 'kale', interval: 2, days_since: 4, overdue_by: 2, in_ground: false, project: 'P', project_id: 'proj', ...extra })
const plan = (n, extra = {}) => ({ water_due: Array.from({ length: n }, (_, i) => water('p' + i, typeof extra === 'function' ? extra(i) : extra)) })

// A controllable /api/events: every POST waits for release(); tracks the peak in flight.
function server({ failAt = new Set(), deleteFail = new Set(), noId = new Set() } = {}) {
  const s = { posts: [], deletes: [], inFlight: 0, peak: 0, delInFlight: 0, delPeak: 0, waiters: [] }
  s.fetch = vi.fn(async (path, init) => {
    if (init && init.method === 'DELETE') {
      s.deletes.push(path); s.delInFlight++; s.delPeak = Math.max(s.delPeak, s.delInFlight)
      await new Promise(r => setTimeout(r, 0))
      s.delInFlight--
      const id = path.split('/').pop()
      if (deleteFail.has(id)) { const e = new Error('boom'); e.status = 500; throw e }
      return { ok: true }
    }
    const body = JSON.parse(init.body)
    const idx = s.posts.length
    s.posts.push({ body, init })
    s.inFlight++; s.peak = Math.max(s.peak, s.inFlight)
    await new Promise(r => setTimeout(r, 0))
    s.inFlight--
    if (failAt.has(idx)) throw new Error('offline')
    return noId.has(idx) ? {} : { id: 'ev-' + body.plant_id + '-' + body.event_type }
  })
  return s
}

function mount(p, { bedWait = false, fetch, toast } = {}) {
  const t = toast || { show: vi.fn(), showUndo: vi.fn() }
  const allRows = buildCareNeeded(p)
  const hook = renderHook(() => useCareActions({ allRows, bedWait, planDate: todayLocalISO(), fetch, getToken: async () => 't', toast: t, announce: vi.fn() }))
  return { hook, toast: t, allRows }
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

describe('runBulk without opts is the V1 run (S1 behaviour, unchanged)', () => {
  it('one POST at a time, a toast, and bed-wait applied list-wide', async () => {
    const s = server()
    const p = { water_due: [water('a'), water('b'), water('bed', { in_ground: true })] }
    const { hook, toast } = mount(p, { bedWait: true, fetch: s.fetch })
    const keys = new Set(hook.result.current.rows.map(r => r.key))
    await act(async () => { await hook.result.current.runBulk('watering', keys) })
    expect(s.peak).toBe(1)
    expect(s.posts.map(x => x.body.plant_id)).toEqual(['a', 'b'])
    expect(toast.showUndo).toHaveBeenCalledTimes(1)
    expect(s.posts.every(x => x.init.keepalive === undefined)).toBe(true)
  })
})

describe('runBulk with V2 opts', () => {
  it('concurrency 4: never more than 4 POSTs in flight, every row once, keepalive, no toast', async () => {
    const s = server()
    const { hook, toast } = mount(plan(10), { fetch: s.fetch })
    const keys = new Set(hook.result.current.rows.map(r => r.key))
    let res
    await act(async () => { res = await hook.result.current.runBulk('watering', keys, { concurrency: 4, excludeInFlight: true }) })
    expect(s.peak).toBe(4)
    expect(s.posts.length).toBe(10)
    expect(new Set(s.posts.map(x => x.body.plant_id)).size).toBe(10)
    expect(s.posts.every(x => x.init.keepalive === true)).toBe(true)
    expect(res.created.length).toBe(10)
    expect(res.created.every(c => c.on === todayLocalISO())).toBe(true)
    expect(hook.result.current.rows.length).toBe(0)
    expect(toast.showUndo).not.toHaveBeenCalled()
    expect(toast.show).not.toHaveBeenCalled()
  })

  it('concurrency 1 is sequential', async () => {
    const s = server()
    const { hook } = mount(plan(5), { fetch: s.fetch })
    await act(async () => { await hook.result.current.runBulk('watering', new Set(hook.result.current.rows.map(r => r.key)), { concurrency: 1 }) })
    expect(s.peak).toBe(1)
    expect(s.posts.length).toBe(5)
  })

  it('excludeInFlight: a one-tap Water still in flight is left out of a Water all, and logged ONCE', async () => {
    let release
    const s = server()
    const gate = new Promise(r => { release = r })
    const slow = vi.fn(async (path, init) => {
      const body = JSON.parse(init.body)
      if (body.plant_id === 'p0') { await gate; s.posts.push({ body, init }); return { id: 'single' } }
      return s.fetch(path, init)
    })
    const { hook } = mount(plan(3), { fetch: slow })
    const row0 = hook.result.current.rows[0]
    let single
    act(() => { single = hook.result.current.logRow(row0) })
    let res
    await act(async () => { res = await hook.result.current.runBulk('watering', new Set(hook.result.current.rows.map(r => r.key)), { concurrency: 4, excludeInFlight: true }) })
    expect(res.excluded).toEqual([row0.key])
    expect(res.created.map(c => c.key)).toEqual(expect.arrayContaining(['p1:water_due', 'p2:water_due']))
    await act(async () => { release(); await single })
    const p0posts = s.posts.filter(x => x.body.plant_id === 'p0')
    expect(p0posts.length).toBe(1)
  })

  it('excludeInFlight: two V2 runs over the same keys log each row once', async () => {
    const s = server()
    const { hook } = mount(plan(6), { fetch: s.fetch })
    const keys = new Set(hook.result.current.rows.map(r => r.key))
    let a, b
    await act(async () => {
      const pa = hook.result.current.runBulk('watering', keys, { concurrency: 4, excludeInFlight: true })
      const pb = hook.result.current.runBulk('watering', keys, { concurrency: 4, excludeInFlight: true })
      ;[a, b] = await Promise.all([pa, pb])
    })
    expect(s.posts.length).toBe(6)
    expect(a.created.length + b.created.length).toBe(6)
    expect(b.excluded.length).toBe(6)
  })

  it('bodyEventType posts that type for the named rows (Moist on a water row)', async () => {
    const s = server()
    const { hook } = mount(plan(2), { fetch: s.fetch })
    const k = hook.result.current.rows[0].key
    await act(async () => { await hook.result.current.runBulk('watering', new Set([k]), { concurrency: 4, excludeInFlight: true, bodyEventType: 'moisture_check' }) })
    expect(s.posts.map(x => x.body.event_type)).toEqual(['moisture_check'])
    expect(hook.result.current.rows.map(r => r.key)).toEqual(['p1:water_due'])
  })

  it('uses the caller\'s keys as given: a bed named by a covered group is logged even while bed-wait is on', async () => {
    const s = server()
    const p = { water_due: [water('bed', { in_ground: true }), water('pot')] }
    const { hook } = mount(p, { bedWait: true, fetch: s.fetch })
    await act(async () => { await hook.result.current.runBulk('watering', new Set(['bed:water_due']), { concurrency: 4 }) })
    expect(s.posts.map(x => x.body.plant_id)).toEqual(['bed'])
  })

  it('never posts a key that is not on the list or of another type', async () => {
    const s = server()
    const p = { water_due: [water('a')], fertilize: [{ id: 'f', name: 'F', item: 'Tone', apply: 'top-dress', project_id: 'proj' }] }
    const { hook } = mount(p, { fetch: s.fetch })
    await act(async () => { await hook.result.current.runBulk('watering', new Set(['a:water_due', 'f:fertilize', 'ghost:water_due']), { concurrency: 4 }) })
    expect(s.posts.map(x => x.body.plant_id)).toEqual(['a'])
  })

  it('failures injected at positions 1 / 48 / 95 stay on the list, named; undo deletes exactly the successes', async () => {
    const s = server({ failAt: new Set([0, 47, 94]) })
    const { hook } = mount(plan(97), { fetch: s.fetch })
    const keys = new Set(hook.result.current.rows.map(r => r.key))
    let res
    await act(async () => { res = await hook.result.current.runBulk('watering', keys, { concurrency: 4, excludeInFlight: true }) })
    expect(res.failed.length).toBe(3)
    expect(res.created.length).toBe(94)
    expect(hook.result.current.rows.map(r => r.key).sort()).toEqual([...res.failed].sort())
    let u
    await act(async () => { u = await hook.result.current.undoMany(res.created) })
    expect(u.undone.length).toBe(94)
    expect(s.deletes.length).toBe(94)
    expect(new Set(s.deletes).size).toBe(94)
    expect(s.delPeak).toBeLessThanOrEqual(4)
    expect(hook.result.current.rows.length).toBe(97)
  })

  // Review 4162.1 IMPORTANT-A: the caller persists the claim (the today-logged store), so it must hear it BEFORE any
  // POST — every target, the not-yet-sent included — and hear each failure released, and nothing else.
  it('onClaim hears every target once, before the first POST; onRelease hears exactly the failed keys', async () => {
    const s = server({ failAt: new Set([1, 5]) })
    const { hook } = mount(plan(7), { fetch: s.fetch })
    const events = []
    const keys = new Set(hook.result.current.rows.map(r => r.key))
    let res
    await act(async () => {
      res = await hook.result.current.runBulk('watering', keys, {
        concurrency: 4, excludeInFlight: true,
        onClaim: (ks) => events.push(['claim', [...ks].sort(), s.posts.length]),
        onRelease: (ks) => events.push(['release', ks]),
      })
    })
    expect(events[0]).toEqual(['claim', [...keys].sort(), 0])
    expect(events.filter(e => e[0] === 'claim').length).toBe(1)
    expect(events.filter(e => e[0] === 'release').map(e => e[1]).flat().sort()).toEqual([...res.failed].sort())
    expect(res.failed.length).toBe(2)
  })

  it('a run with nothing to post claims nothing', async () => {
    const s = server()
    const { hook } = mount(plan(2), { fetch: s.fetch })
    const onClaim = vi.fn()
    await act(async () => { await hook.result.current.runBulk('fertilizing', new Set(hook.result.current.rows.map(r => r.key)), { concurrency: 4, onClaim }) })
    expect(onClaim).not.toHaveBeenCalled()
  })

  it('undoMany: a failed delete keeps its row hidden; a 404 is gone; an id-less write is never re-surfaced', async () => {
    const s = server({ noId: new Set([2]) })
    const { hook } = mount(plan(3), { fetch: s.fetch })
    let res
    await act(async () => { res = await hook.result.current.runBulk('watering', new Set(hook.result.current.rows.map(r => r.key)), { concurrency: 1 }) })
    const del = vi.fn(async (path) => {
      if (path.endsWith('p0-watering')) { const e = new Error('gone'); e.status = 404; throw e }
      if (path.endsWith('p1-watering')) { const e = new Error('down'); e.status = 503; throw e }
      return { ok: true }
    })
    let u
    await act(async () => {
      const f = s.fetch
      s.fetch.mockImplementation(async (path, init) => (init && init.method === 'DELETE' ? del(path) : f(path, init)))
      u = await hook.result.current.undoMany(res.created)
    })
    expect(u.undone.map(c => c.key)).toEqual(['p0:water_due'])
    expect(u.failed.map(c => c.key).sort()).toEqual(['p1:water_due', 'p2:water_due'])
    expect(hook.result.current.rows.map(r => r.key)).toEqual(['p0:water_due'])
  })
})
