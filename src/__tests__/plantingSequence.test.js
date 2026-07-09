// PLANTING-PAGER pure-logic tests — resolvePager (group-bounded, wrap-around, degradation,
// cross-project hrefs, facet multi-membership) + resolveSwipe (thresholds, both edges, axis).
// Pure functions carry the DOM-independent logic so jsdom's inability to deliver real touch
// doesn't block coverage (per crucible / qa-architect).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  setPlantingSequence, getPlantingSequence, __resetPlantingSequence, resolvePager,
  resolveSwipe, SWIPE_MIN_DX, EDGE_IGNORE_PX,
} from '../lib/plantingSequence.js'

const G = {
  items: [
    { projectId: 'proj1', plantingId: 'pl1', name: 'Ancho' },
    { projectId: 'proj1', plantingId: 'pl2', name: 'Jalapeno' },
    { projectId: 'proj2', plantingId: 'pl3', name: 'Serrano' }, // different project (facet group mixes projects)
  ],
  ctxLabel: 'Peppers',
}

beforeEach(() => __resetPlantingSequence())

describe('set/get/reset', () => {
  it('stores a non-empty sequence and reset clears it', () => {
    setPlantingSequence(G)
    expect(getPlantingSequence().items.length).toBe(3)
    __resetPlantingSequence()
    expect(getPlantingSequence()).toBeNull()
  })
  it('coerces empty/invalid sequences to null', () => {
    setPlantingSequence({ items: [], ctxLabel: 'x' })
    expect(getPlantingSequence()).toBeNull()
    setPlantingSequence(null)
    expect(getPlantingSequence()).toBeNull()
  })
})

describe('resolvePager — degradation (no pager, no throw)', () => {
  it('returns null with no sequence', () => {
    expect(resolvePager('pl1')).toBeNull()
  })
  it('returns null when the sequence has a single item', () => {
    setPlantingSequence({ items: [{ projectId: 'p', plantingId: 'only', name: 'One' }], ctxLabel: 'Solo' })
    expect(resolvePager('only')).toBeNull()
  })
  it('returns null when the current planting is not in the sequence (stale / lineage jump)', () => {
    setPlantingSequence(G)
    expect(resolvePager('pl-not-here')).toBeNull()
  })
})

describe('resolvePager — group-bounded wrap-around + cross-project hrefs', () => {
  beforeEach(() => setPlantingSequence(G))

  it('interior: prev/next point at the immediate siblings with correct per-item projectId', () => {
    const p = resolvePager('pl2')
    expect(p.index).toBe(1)
    expect(p.total).toBe(3)
    expect(p.ctxLabel).toBe('Peppers')
    expect(p.prevHref).toBe('/projects/proj1/plantings/pl1')
    expect(p.nextHref).toBe('/projects/proj2/plantings/pl3') // next is in a DIFFERENT project
  })
  it('wraps at the end: next(last) → first', () => {
    const p = resolvePager('pl3')
    expect(p.index).toBe(2)
    expect(p.nextHref).toBe('/projects/proj1/plantings/pl1')
    expect(p.prevHref).toBe('/projects/proj1/plantings/pl2')
  })
  it('wraps at the start: prev(first) → last', () => {
    const p = resolvePager('pl1')
    expect(p.prevHref).toBe('/projects/proj2/plantings/pl3')
    expect(p.nextHref).toBe('/projects/proj1/plantings/pl2')
  })
})

describe('resolvePager — N=2 wrap edge', () => {
  it('next and prev both resolve to the single other item (never self)', () => {
    setPlantingSequence({
      items: [
        { projectId: 'p', plantingId: 'a', name: 'A' },
        { projectId: 'p', plantingId: 'b', name: 'B' },
      ],
      ctxLabel: 'Pair',
    })
    const a = resolvePager('a')
    expect(a.nextHref).toBe('/projects/p/plantings/b')
    expect(a.prevHref).toBe('/projects/p/plantings/b')
  })
})

describe('resolvePager — facet multi-membership yields different sequences by entry group', () => {
  it('same planting reached from group Herbs vs group Shade pages to different siblings', () => {
    setPlantingSequence({ items: [
      { projectId: 'p', plantingId: 'basil', name: 'Basil' },
      { projectId: 'p', plantingId: 'mint', name: 'Mint' },
    ], ctxLabel: 'Herbs' })
    expect(resolvePager('basil').nextHref).toBe('/projects/p/plantings/mint')

    setPlantingSequence({ items: [
      { projectId: 'p', plantingId: 'basil', name: 'Basil' },
      { projectId: 'p', plantingId: 'hosta', name: 'Hosta' },
    ], ctxLabel: 'Shade' })
    expect(resolvePager('basil').nextHref).toBe('/projects/p/plantings/hosta')
  })
})

describe('resolveSwipe — direction, thresholds, both edges', () => {
  const VW = 400
  const mid = 200
  it('drag left past threshold → next; drag right → prev', () => {
    expect(resolveSwipe(-(SWIPE_MIN_DX + 10), 0, mid, VW)).toBe('next')
    expect(resolveSwipe(SWIPE_MIN_DX + 10, 0, mid, VW)).toBe('prev')
  })
  it('below the horizontal threshold → none (49 vs 50)', () => {
    expect(resolveSwipe(-(SWIPE_MIN_DX - 1), 0, mid, VW)).toBe('none')
    expect(resolveSwipe(-SWIPE_MIN_DX, 0, mid, VW)).toBe('next')
  })
  it('not decisively horizontal (steep angle) → none', () => {
    expect(resolveSwipe(-60, -50, mid, VW)).toBe('none') // |dx|60 < |dy|50 * 1.5 = 75
    expect(resolveSwipe(-90, -50, mid, VW)).toBe('next') // 90 >= 75
  })
  it('cedes the LEFT edge zone (startX <= EDGE_IGNORE_PX)', () => {
    expect(resolveSwipe(-80, 0, EDGE_IGNORE_PX, VW)).toBe('none')
    expect(resolveSwipe(-80, 0, EDGE_IGNORE_PX + 1, VW)).toBe('next')
  })
  it('cedes the RIGHT edge zone (startX >= viewportW - EDGE_IGNORE_PX)', () => {
    expect(resolveSwipe(-80, 0, VW - EDGE_IGNORE_PX, VW)).toBe('none')
    expect(resolveSwipe(-80, 0, VW - EDGE_IGNORE_PX - 1, VW)).toBe('next')
  })
  it('skips the right-edge check when viewport width is unknown (0)', () => {
    expect(resolveSwipe(-80, 0, 999, 0)).toBe('next')
  })
})
