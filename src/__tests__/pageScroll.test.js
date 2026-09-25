// BUG-DETAILPAGESCARRYSCROLL-001 — the app-level page-scroll manager's decisions, table-tested.
//
// src/lib/pageScroll.js is pure: decidePageScroll (the table in its header), driverStep (one frame of the
// restore driver) and the store. Every row here is a navigation Dave makes; the real-Chrome half — the
// clamp, the anchoring carry, a real traversal — is gate:page-scroll (scripts/layout-gate/page-scroll.mjs).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  decidePageScroll, startDriver, driverStep, pageScrollKey, readPageScroll, filePageScroll, flushPageScroll,
  __resetPageScrollStore, __pageScrollEntries,
  PAGE_SCROLL_STORE_KEY, PAGE_SCROLL_MAX_ENTRIES, RESTORE_HOLD_MS, RESTORE_BUDGET_MS, RESTORE_DT_CAP_MS,
} from '../lib/pageScroll.js'

// A navigation, spelled the way the manager sees it. K = the page entry, P = its path.
const at = (key, path) => ({ key, path })
const LIST = at('kList', '/locations')
const decide = (over) => decidePageScroll({ enabled: true, first: false, claimed: false, ...over })

describe('decidePageScroll — the page entry did not change (row 0: nothing moves)', () => {
  // Each of these commits the page tree at the SAME entry: the page stays mounted and must not move.
  it.each([
    ['header Search opens over the page (a PUSH carrying the background)', 'PUSH'],
    ['a Search peek or an in-overlay swap (PUSH/REPLACE with the same background)', 'REPLACE'],
    ['a stamped replace-close (the new entry continues the page\'s)', 'REPLACE'],
    ['+LOG: a sheet row REPLACE-opens the overlay into the Back marker\'s slot', 'REPLACE'],
    ['LogMany\'s "." with a background', 'REPLACE'],
  ])('%s', (_what, navType) => {
    expect(decide({ prev: LIST, next: LIST, navType, record: 1645 })).toEqual({ row: '0', action: 'NONE' })
  })

  it('a marker pop or a walk-back close (POP, delta 0) with the page where it was: nothing', () => {
    expect(decide({ prev: LIST, next: LIST, navType: 'POP', y: 1645, snapshot: 1645 })).toEqual({ row: '0', action: 'NONE' })
    // Sub-tolerance noise is "where it was" (RESTORE_TOLERANCE_PX).
    expect(decide({ prev: LIST, next: LIST, navType: 'POP', y: 1648, snapshot: 1645 }).action).toBe('NONE')
  })

  it('row 0b: the page rendered shorter under the sheet and is clamped after the close → the snapshot is re-applied', () => {
    expect(decide({ prev: LIST, next: LIST, navType: 'POP', y: 56, snapshot: 1645 })).toEqual({ row: '0b', action: 'RESTORE', y: 1645 })
  })

  it('row 0b applies only where the POP LANDS uncovered: a Forward into the overlay\'s entry, or a peek\'s Back inside it, moves nothing', () => {
    expect(decide({ prev: LIST, next: LIST, navType: 'POP', y: 56, snapshot: 1645, covered: true })).toEqual({ row: '0', action: 'NONE' })
  })

  it('row 0b needs a snapshot: none recorded (or a restore already armed, which the wiring passes as none) → nothing', () => {
    expect(decide({ prev: LIST, next: LIST, navType: 'POP', y: 56 })).toEqual({ row: '0', action: 'NONE' })
  })

  it('row 0b never fires on a PUSH or REPLACE onto the same entry, however far the page moved', () => {
    expect(decide({ prev: LIST, next: LIST, navType: 'REPLACE', y: 56, snapshot: 1645 })).toEqual({ row: '0', action: 'NONE' })
  })
})

describe('decidePageScroll — the first commit of a document (row 1)', () => {
  // Launch, a reload, the service worker's post-update reload, an Android tab restore: react-router's
  // initial action is POP.
  it('an app-owned page with a mirror record → restored (a reload keeps the place; today it lands on the loading shell)', () => {
    expect(decide({ first: true, prev: null, next: LIST, navType: 'POP', record: 1645 })).toEqual({ row: '1', action: 'RESTORE', y: 1645 })
  })
  it('no record (a fresh launch, a first visit) → nothing: a new document already starts at the top', () => {
    expect(decide({ first: true, prev: null, next: LIST, navType: 'POP' })).toEqual({ row: '1', action: 'NONE' })
    expect(decide({ first: true, prev: null, next: LIST, navType: 'POP', record: 0 })).toEqual({ row: '1', action: 'NONE' })
  })
  it('the keyless first entry (\'default\') is decided like any other; the store key carries the path, so it cannot read another page', () => {
    const d = at('default', '/log/harvest')
    expect(decide({ first: true, prev: null, next: d, navType: 'POP', record: 300 })).toEqual({ row: '1', action: 'RESTORE', y: 300 })
    expect(pageScrollKey('/log/harvest', 'default')).not.toBe(pageScrollKey('/capture', 'default'))
    expect(pageScrollKey('/capture', null)).toBe('/capture|default')
  })
  it('row 1b: the page claimed its own restore (a useScrollRestore page or Garden with a spot) → nothing', () => {
    expect(decide({ first: true, prev: null, next: LIST, navType: 'POP', record: 1645, claimed: true })).toEqual({ row: '1b', action: 'NONE' })
  })
})

describe('decidePageScroll — a different page by PUSH or REPLACE opens at its top (row 2)', () => {
  const ZONE = at('kZone', '/locations/loc-bag-area')
  it.each([
    ['a list row, a planting\'s Event log row, a Zones row (PUSH)', 'PUSH'],
    ['a More-sheet row (REPLACE into the Back marker\'s slot)', 'REPLACE'],
    ['the planting pager (REPLACE onto another planting\'s path)', 'REPLACE'],
    ['a Search result (a plain PUSH out of the overlay)', 'PUSH'],
    ['a post-save redirect (REPLACE)', 'REPLACE'],
  ])('%s', (_what, navType) => {
    expect(decide({ prev: LIST, next: ZONE, navType })).toEqual({ row: '2', action: 'TOP' })
  })
  it('whoever owns the arriving page: a claim or a record changes nothing on a push', () => {
    expect(decide({ prev: LIST, next: ZONE, navType: 'PUSH', claimed: true, record: 900 })).toEqual({ row: '2', action: 'TOP' })
  })
  it('the planting pager: /plantings/a → /plantings/b is a different page', () => {
    expect(decide({ prev: at('k1', '/plantings/a'), next: at('k2', '/plantings/b'), navType: 'REPLACE' })).toEqual({ row: '2', action: 'TOP' })
  })
})

describe('decidePageScroll — the same page under a new entry keeps its place (row 3)', () => {
  // react-router mints a new key for every write; the pathname says it is still the same page.
  it.each([
    ['a Seeds view switch / its default-view settle (setParams replace)', 'REPLACE'],
    ['HarvestLog\'s mode switch', 'REPLACE'],
    ['Garden\'s ?add / ?edit strips and the editor close', 'REPLACE'],
    ['Dashboard\'s post-log state clear', 'REPLACE'],
    ['PutUp opening a batch (a same-path PUSH)', 'PUSH'],
    ['re-tapping the tab you are on (a <Link> to the current URL is a REPLACE)', 'REPLACE'],
    ['an unstamped replace-close (an overlay closed by an older bundle)', 'REPLACE'],
  ])('%s', (_what, navType) => {
    expect(decide({ prev: at('k1', '/seeds'), next: at('k2', '/seeds'), navType, record: 999 })).toEqual({ row: '3', action: 'KEEP' })
  })
})

describe('decidePageScroll — POP onto a different page (rows 4 and 5)', () => {
  const EVENT = at('kEvent', '/events/ev-45')
  const PLANTING = at('kPlanting', '/plantings/pl-ristra')
  it('row 4: Back to an app-owned page with a filed offset → restored (the Event log at 4658)', () => {
    expect(decide({ prev: EVENT, next: PLANTING, navType: 'POP', record: 4658 })).toEqual({ row: '4', action: 'RESTORE', y: 4658 })
  })
  it('row 4: no filed offset → ONE zero, because \'manual\' leaves a POP with no defined offset', () => {
    expect(decide({ prev: EVENT, next: PLANTING, navType: 'POP' })).toEqual({ row: '4', action: 'TOP' })
    expect(decide({ prev: EVENT, next: PLANTING, navType: 'POP', record: 0 })).toEqual({ row: '4', action: 'TOP' })
  })
  it('row 5: Back to a page that claimed its own restore → one zero in the commit, and the page restores itself', () => {
    expect(decide({ prev: EVENT, next: at('kSaved', '/seeds'), navType: 'POP', claimed: true, record: 3000 })).toEqual({ row: '5', action: 'TOP' })
  })
  it('Search → a result → Back: the page entry is the re-opened overlay\'s background, restored under the sheet', () => {
    expect(decide({ prev: EVENT, next: LIST, navType: 'POP', record: 2988, covered: true })).toEqual({ row: '4', action: 'RESTORE', y: 2988 })
  })
  it('an entry still in \'auto\' (written by the bundle before this one) gets no zero: the browser restores it natively, as today', () => {
    expect(decide({ prev: EVENT, next: PLANTING, navType: 'POP', entryMode: 'auto' })).toEqual({ row: '4', action: 'NONE' })
    expect(decide({ prev: EVENT, next: at('kSaved', '/seeds'), navType: 'POP', claimed: true, entryMode: 'auto' })).toEqual({ row: '5', action: 'NONE' })
    // ... but a filed offset is still restored (the entry was visited under this bundle).
    expect(decide({ prev: EVENT, next: PLANTING, navType: 'POP', record: 800, entryMode: 'auto' })).toEqual({ row: '4', action: 'RESTORE', y: 800 })
  })
})

describe('decidePageScroll — POP onto the same page under another entry (rows 6 and 7)', () => {
  it('row 6: PutUp batch → Back to the list entry → its filed offset', () => {
    expect(decide({ prev: at('kBatch', '/put-up'), next: at('kList', '/put-up'), navType: 'POP', record: 1200 })).toEqual({ row: '6', action: 'RESTORE', y: 1200 })
  })
  it('row 6 with no record leaves the page where it is (it never left the page)', () => {
    expect(decide({ prev: at('kBatch', '/put-up'), next: at('kList', '/put-up'), navType: 'POP' })).toEqual({ row: '6', action: 'NONE' })
  })
  it('row 7: claimed → nothing', () => {
    expect(decide({ prev: at('k2', '/seeds'), next: at('k1', '/seeds'), navType: 'POP', claimed: true, record: 1200 })).toEqual({ row: '7', action: 'NONE' })
  })
})

describe('decidePageScroll — the flag', () => {
  it('SCROLL_MANAGER_ENABLED off: nothing, on every row', () => {
    for (const over of [
      { first: true, prev: null, next: LIST, navType: 'POP', record: 900 },
      { prev: LIST, next: at('k2', '/about'), navType: 'PUSH' },
      { prev: at('k2', '/about'), next: LIST, navType: 'POP', record: 900 },
      { prev: LIST, next: LIST, navType: 'POP', y: 0, snapshot: 900 },
    ]) expect(decidePageScroll({ ...over, enabled: false, claimed: false })).toEqual({ row: 'off', action: 'NONE' })
  })
})

// ─── the driver ───────────────────────────────────────────────────────────────────────────────────
// Run frames against a model page: `page(t)` answers { y-after-clamp for a target, height } at time t.
function run(target, frames, { dt = 16, ready = () => true } = {}) {
  let s = startDriver(target, 0)
  const out = []
  let y = 0
  for (let i = 1; i <= frames.length; i++) {
    const now = i * dt
    const f = frames[i - 1]
    y = f.y !== undefined ? f.y : y
    const r = driverStep(s, { now, y, height: f.h, ready: ready(now) })
    s = r.state
    out.push(r)
    if (r.outcome !== 'RETRY') break
  }
  return { s, out, last: out[out.length - 1] }
}
const frames = (n, f) => Array.from({ length: n }, (_, i) => (typeof f === 'function' ? f(i) : f))

describe('driverStep — when a restore is DONE', () => {
  it('DONE once the target has held RESTORE_HOLD_MS with no height change', () => {
    const { last, out } = run(1645, frames(200, { y: 1645, h: 2481 }))
    expect(last.outcome).toBe('DONE')
    // Held from the first frame at the target: done after about a second, not a frame sooner.
    expect(out.length * 16).toBeGreaterThanOrEqual(RESTORE_HOLD_MS)
    expect(out.length * 16).toBeLessThan(RESTORE_HOLD_MS + 50)
  })

  it('a height change resets the hold: a two-stage page (header, then the Event log) is held from its LAST stage', () => {
    // Stage 1: max 2070, clamped short of 4658 → RETRY + scroll. Stage 2 lands at frame 190 and holds.
    const f = frames(400, (i) => (i < 190 ? { y: 2070, h: 2906 } : { y: 4658, h: 5758 }))
    const { out, last } = run(4658, f)
    expect(out.slice(0, 189).every((r) => r.outcome === 'RETRY' && r.scroll)).toBe(true)
    expect(last.outcome).toBe('DONE')
    expect(out.length).toBeGreaterThan(190 + Math.floor(RESTORE_HOLD_MS / 16) - 1)
  })

  it('at the target, a later height change (a photo row landing) restarts the hold rather than ending early', () => {
    const f = frames(300, (i) => ({ y: 900, h: i < 40 ? 2000 : 2400 }))
    const { out } = run(900, f)
    const doneAt = out.findIndex((r) => r.outcome === 'DONE')
    expect(doneAt * 16).toBeGreaterThanOrEqual(40 * 16 + RESTORE_HOLD_MS - 16)
  })

  it('never asks for a scroll while at the target (within RESTORE_TOLERANCE_PX), and always while short of it', () => {
    const r1 = driverStep(startDriver(900, 0), { now: 16, y: 897, height: 3000 })
    const r2 = driverStep(startDriver(900, 0), { now: 16, y: 56, height: 892 })
    expect(r1.scroll).toBe(false)
    expect(r2.scroll).toBe(true)
  })
})

describe('driverStep — the budget is VISIBLE time', () => {
  it('EXHAUSTED after RESTORE_BUDGET_MS of frames that never reach the target (the content is genuinely gone)', () => {
    const { last, out } = run(5000, frames(2000, { y: 700, h: 1536 }))
    expect(last.outcome).toBe('EXHAUSTED')
    expect(out.length * 16).toBeGreaterThanOrEqual(RESTORE_BUDGET_MS)
    expect(out.length * 16).toBeLessThan(RESTORE_BUDGET_MS + 32)
  })

  it('outlasts slow content: the Zones list landing after 5 s of latency is still restored (the 4 s prototype lost it: 56)', () => {
    const f = frames(800, (i) => (i * 16 < 5000 ? { y: 56, h: 892 } : { y: 1645, h: 2481 }))
    expect(run(1645, f).last.outcome).toBe('DONE')
  })

  it('a frozen or hidden gap does not consume the budget: one frame after a 30 s gap counts RESTORE_DT_CAP_MS', () => {
    let s = startDriver(1645, 0)
    s = driverStep(s, { now: 16, y: 56, height: 892 }).state
    const r = driverStep(s, { now: 30016, y: 56, height: 892 })
    expect(r.outcome).toBe('RETRY')
    expect(r.state.visibleMs).toBe(16 + RESTORE_DT_CAP_MS)
  })

  it('before the user is resolved (Protected\'s skeleton) no time counts at all — neither the budget nor the hold', () => {
    // 20 s behind the skeleton at the target's clamp, then the page lands and holds.
    const f = frames(3000, (i) => (i * 16 < 20000 ? { y: 1645, h: 1700 } : { y: 1645, h: 2481 }))
    const { out, last } = run(1645, f, { ready: (now) => now >= 20000 })
    expect(last.outcome).toBe('DONE')
    expect(out.length * 16).toBeGreaterThan(20000)
  })

  it('a non-finite reading stops the driver (EXHAUSTED) instead of looping on garbage', () => {
    expect(driverStep(startDriver(900, 0), { now: 16, y: NaN, height: 3000 }).outcome).toBe('EXHAUSTED')
    expect(driverStep(startDriver(NaN, 0), { now: 16, y: 0, height: 3000 }).outcome).toBe('EXHAUSTED')
  })
})

describe('the store', () => {
  beforeEach(() => { __resetPageScrollStore() })

  it('files and reads by path|entry; an offset of 0 is never MINTED but does overwrite an existing record', () => {
    filePageScroll('/locations|k1', 0)
    expect(readPageScroll('/locations|k1')).toBeUndefined()
    filePageScroll('/locations|k1', 1645)
    expect(readPageScroll('/locations|k1')).toBe(1645)
    filePageScroll('/locations|k1', 0)
    expect(readPageScroll('/locations|k1')).toBe(0)
  })

  it('rejects a non-finite or negative offset', () => {
    filePageScroll('/a|k', NaN)
    filePageScroll('/a|k', -5)
    expect(readPageScroll('/a|k')).toBeUndefined()
  })

  it(`caps at PAGE_SCROLL_MAX_ENTRIES (${PAGE_SCROLL_MAX_ENTRIES}), evicting the least recently WRITTEN`, () => {
    for (let i = 0; i < PAGE_SCROLL_MAX_ENTRIES; i++) filePageScroll(`/p|k${i}`, 100 + i)
    filePageScroll('/p|k0', 999)                  // re-written: now the newest
    filePageScroll('/p|kNew', 5)                  // one over the cap
    expect(__pageScrollEntries()).toHaveLength(PAGE_SCROLL_MAX_ENTRIES)
    expect(readPageScroll('/p|k0')).toBe(999)
    expect(readPageScroll('/p|k1')).toBeUndefined()   // the oldest write went
    expect(readPageScroll('/p|kNew')).toBe(5)
  })

  it('the cap covers 25+ entries of back stack comfortably (rimpact IMPORTANT-8 asked for >= 50)', () => {
    expect(PAGE_SCROLL_MAX_ENTRIES).toBeGreaterThanOrEqual(50)
  })

  it('mirrors to its OWN sessionStorage key, never useScrollRestore\'s', () => {
    expect(PAGE_SCROLL_STORE_KEY).toBe('garden.pageScroll.v1')
    filePageScroll('/locations|k1', 1645)
    flushPageScroll()
    expect(JSON.parse(sessionStorage.getItem('garden.pageScroll.v1'))).toEqual({ '/locations|k1': 1645 })
    expect(sessionStorage.getItem('garden.scrollRestore.v1')).toBeNull()
  })

  it('a new document reads the mirror (a reload, a tab restore)', () => {
    // The module is empty (a new document); the tab's sessionStorage kept the last flush.
    sessionStorage.setItem(PAGE_SCROLL_STORE_KEY, JSON.stringify({ '/locations|k1': 1645, '/about|k2': 52 }))
    expect(readPageScroll('/locations|k1')).toBe(1645)
    expect(readPageScroll('/about|k2')).toBe(52)
  })

  it('a corrupt or hostile mirror yields an empty or partial store, never a throw or a garbage offset', () => {
    sessionStorage.setItem(PAGE_SCROLL_STORE_KEY, '{not json')
    expect(readPageScroll('/a|k')).toBeUndefined()
    __resetPageScrollStore()
    sessionStorage.setItem(PAGE_SCROLL_STORE_KEY, JSON.stringify({ '/a|k': 'lots', '/b|k': -3, '/c|k': 400, '/d|k': null }))
    expect(__pageScrollEntries()).toEqual([['/c|k', 400]])
    __resetPageScrollStore()
    sessionStorage.setItem(PAGE_SCROLL_STORE_KEY, JSON.stringify([1, 2, 3]))
    expect(__pageScrollEntries()).toEqual([])
  })

  it('the reset seam clears both halves (setup.ts runs it before every test)', () => {
    filePageScroll('/a|k', 300)
    flushPageScroll()
    __resetPageScrollStore()
    expect(sessionStorage.getItem(PAGE_SCROLL_STORE_KEY)).toBeNull()
    expect(readPageScroll('/a|k')).toBeUndefined()
  })
})
