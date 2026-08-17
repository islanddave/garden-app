// V4-HARVTRAYVIEWPORT-001 — the collapsed-tray selector and the geometry bound.
//
// These are the assertions jsdom CAN carry. It has no layout engine, so nothing here proves a
// pixel height or that a soft keyboard shrank anything; the height bound is pinned as the STYLE
// CONTRACT the browser resolves (a dvh-relative max-height + a contained scrollport), which is the
// same instrument-of-last-resort noViewportInsetArithmetic.static.test.js uses for its invariant.
// The pixel claims need Dave's device pass — see the lane report.
import { describe, it, expect } from 'vitest'
import {
  selectTrayChips,
  harvestTrayScrollport,
  HARVEST_TRAY_COLLAPSED_MAX,
  HARVEST_TRAY_MAX_HEIGHT,
} from '../lib/harvestTray.js'

const chips = n => Array.from({ length: n }, (_, i) => ({
  plant_id: `p${i + 1}`, project_id: 'proj-1', name: `Planting ${i + 1}`,
}))
const ids = list => list.map(c => c.plant_id)

describe('selectTrayChips (V4-HARVTRAYVIEWPORT-001)', () => {
  it('is identity — same array reference — when the list already fits the cap', () => {
    const all = chips(HARVEST_TRAY_COLLAPSED_MAX)
    expect(selectTrayChips({ chips: all })).toBe(all)
    expect(selectTrayChips({ chips: chips(1) })).toHaveLength(1)
  })

  it('is identity when expanded, however long the list', () => {
    const all = chips(14)
    expect(selectTrayChips({ chips: all, expanded: true })).toBe(all)
  })

  it('caps at HARVEST_TRAY_COLLAPSED_MAX and keeps the top of the readiness rank', () => {
    const shown = selectTrayChips({ chips: chips(14) })
    expect(shown).toHaveLength(HARVEST_TRAY_COLLAPSED_MAX)
    expect(ids(shown)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
  })

  it('FILTERS, never sorts — a low-ranked current chip keeps its rank position', () => {
    const shown = selectTrayChips({ chips: chips(14), currentPlantId: 'p12' })
    // p12 is kept, but it lands after p1..p5 — the tray order is the readiness rank, and chips
    // must not jump under the thumb as they are tapped.
    expect(ids(shown)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p12'])
  })

  it('never hides a queued chip, wherever it ranks', () => {
    const shown = selectTrayChips({ chips: chips(14), queuedPlantIds: ['p9', 'p14'] })
    expect(ids(shown)).toEqual(['p1', 'p2', 'p3', 'p4', 'p9', 'p14'])
  })

  it('does not truncate user state even when current + queued alone exceed the cap', () => {
    const shown = selectTrayChips({
      chips: chips(14),
      currentPlantId: 'p13',
      queuedPlantIds: ['p2', 'p4', 'p6', 'p8', 'p10', 'p12'],
    })
    expect(ids(shown)).toEqual(['p2', 'p4', 'p6', 'p8', 'p10', 'p12', 'p13'])
  })

  it('fills the free slots with not-yet-logged candidates before already-logged ones', () => {
    const shown = selectTrayChips({ chips: chips(14), donePlantIds: ['p1', 'p2', 'p3'] })
    expect(ids(shown)).toEqual(['p4', 'p5', 'p6', 'p7', 'p8', 'p9'])
  })

  it('still surfaces done chips when there is nothing else to show', () => {
    const shown = selectTrayChips({ chips: chips(8), donePlantIds: ['p1', 'p2', 'p3', 'p4', 'p5'] })
    // 3 not-done fill first, then the 3 highest-ranked done ones — in rank order either way.
    expect(ids(shown)).toEqual(['p1', 'p2', 'p3', 'p6', 'p7', 'p8'])
  })

  it('accepts a Set or an array for queued/done, and survives empty input', () => {
    const bySet = selectTrayChips({ chips: chips(14), queuedPlantIds: new Set(['p11']) })
    const byArray = selectTrayChips({ chips: chips(14), queuedPlantIds: ['p11'] })
    expect(ids(bySet)).toEqual(ids(byArray))
    expect(selectTrayChips()).toEqual([])
    expect(selectTrayChips({ chips: [] })).toEqual([])
  })

  it('honours an explicit max', () => {
    expect(selectTrayChips({ chips: chips(14), max: 3 })).toHaveLength(3)
  })
})

describe('harvest tray height bound (V4-HARVTRAYVIEWPORT-001)', () => {
  it('bounds the tray against the LAYOUT viewport in CSS, so it shrinks with the keyboard', () => {
    // dvh is the whole mechanism: index.html ships interactive-widget=resizes-content, so the
    // keyboard shrinks the layout viewport and this re-resolves with no JS and nothing to thrash.
    // Losing the dvh term would silently restore the defect on the only geometry that matters.
    expect(HARVEST_TRAY_MAX_HEIGHT).toMatch(/dvh/)
    expect(harvestTrayScrollport.maxHeight).toBe(HARVEST_TRAY_MAX_HEIGHT)
  })

  it('carries a px floor so a short landscape viewport still shows two chip rows', () => {
    // 2 * 48px touch rows + one 8px gap.
    expect(HARVEST_TRAY_MAX_HEIGHT).toContain('104px')
    expect(HARVEST_TRAY_MAX_HEIGHT.startsWith('max(')).toBe(true)
  })

  it('is a CONTAINED scrollport — an end-of-tray flick must not chain into the page', () => {
    expect(harvestTrayScrollport.overflowY).toBe('auto')
    expect(harvestTrayScrollport.overscrollBehavior).toBe('contain')
  })

  it('reads no viewport in JS — the bound is pure CSS (V4-KBVIEWPORT-001 invariant)', () => {
    expect(JSON.stringify(harvestTrayScrollport)).not.toMatch(/visualViewport|innerHeight/)
  })
})
