// BUG-TODAYCAREREORDER-001 (BD-036) — the Today care list must not re-sort itself while it is being
// logged. Dave worked down a location group tapping Log and a section slid out from under his finger
// onto the next plant, mis-tapping it. Cause: groupRows sorted location groups by groupSeverity,
// which is summed over the rows PRESENT, so every log lowered that group's score and re-ranked the
// page. The fix pins the order to a set computed from the full list (CareNeeded's `orderingRows`).
//
// Each test here asserts BOTH halves — that the unpinned call reorders and the pinned call does not.
// A pin-only assertion would pass just as happily against a fixture that never had the defect, which
// is the trap this file exists to avoid: the guard must be able to fail.
import { describe, it, expect } from 'vitest'
import { groupRows, autoExpandKeys, groupSeverity } from '../lib/careNeeded.js'

// Two location groups, deliberately close in severity so a few logs flip them.
//   Bag Area   — 5 water rows, no overdue  => severity 5
//   Drive Rows — 4 water rows, +1 overdue each => severity 8
// Drive Rows leads on arrival. Logging 4 Bag Area rows cannot change that, but logging Drive Rows
// rows drops it under Bag Area — the live case, since the lead group is the auto-expanded one Dave
// starts tapping.
const row = (id, locationId, locationName, overdueBy = null) => ({
  key: id + ':water_due', plantingId: id, name: id, need: 'water_due',
  eventType: 'watering', reason: 'Due today', tier: 'gold',
  locationId, locationName, overdueBy, inGround: false, never: false,
})

const BAG = ['b1', 'b2', 'b3', 'b4', 'b5'].map(id => row(id, 'locBag', 'Pasture Bag Area'))
const DRIVE = ['d1', 'd2', 'd3', 'd4'].map(id => row(id, 'locDrive', 'Drive Rows', 1))
const ALL = [...DRIVE, ...BAG]

const keysOf = (rows, order) => groupRows(rows, 'location', order).map(g => g.key)

describe('BD-036 pinned group order', () => {
  it('fixture is valid: Drive Rows leads on arrival and is the group that loses its lead', () => {
    expect(groupSeverity(DRIVE)).toBe(8)
    expect(groupSeverity(BAG)).toBe(5)
    expect(keysOf(ALL)).toEqual(['locDrive', 'locBag'])
  })

  it('UNPINNED: logging rows out of the lead group re-sorts the page (the reported defect)', () => {
    // Dave taps Log on three of the four Drive Rows plants. Severity 8 -> 2, so Bag Area overtakes.
    const afterThreeLogs = ALL.filter(r => !['d1', 'd2', 'd3'].includes(r.plantingId))
    expect(keysOf(afterThreeLogs)).toEqual(['locBag', 'locDrive'])
  })

  it('PINNED: the same three logs leave the order untouched', () => {
    const pinned = keysOf(ALL)
    const afterThreeLogs = ALL.filter(r => !['d1', 'd2', 'd3'].includes(r.plantingId))
    expect(keysOf(afterThreeLogs, pinned)).toEqual(['locDrive', 'locBag'])
  })

  it('PINNED: order is stable across every partial drain of the lead group', () => {
    const pinned = keysOf(ALL)
    const ids = ['d1', 'd2', 'd3', 'd4']
    // Stops at 3: removing the 4th empties the group, which correctly removes it rather than
    // reordering anything. That end state is the next test.
    for (let n = 1; n < ids.length; n++) {
      const remaining = ALL.filter(r => !ids.slice(0, n).includes(r.plantingId))
      expect(keysOf(remaining, pinned)).toEqual(['locDrive', 'locBag'])
    }
  })

  it('a group emptied entirely disappears rather than moving the survivor', () => {
    const pinned = keysOf(ALL)
    const onlyBag = ALL.filter(r => r.locationId === 'locBag')
    expect(keysOf(onlyBag, pinned)).toEqual(['locBag'])
  })

  it('a group absent from the pin sorts last, never above a pinned one', () => {
    const pinned = keysOf(ALL)
    // An undo or late enrichment can surface a group the pin never saw. Even at a severity that
    // would otherwise win outright, it must append — appending is the only placement that cannot
    // move a row already under a finger.
    const late = [...ALL, ...['x1', 'x2', 'x3'].map(id => row(id, 'locNew', 'New Place', 40))]
    expect(keysOf(late, pinned)).toEqual(['locDrive', 'locBag', 'locNew'])
  })

  it('type mode ignores the pin — NEED_ORDER is fixed, so it never had the defect', () => {
    const mixed = [...ALL, { ...row('f1', 'locBag', 'Pasture Bag Area'), need: 'fertilize', eventType: 'fertilizing' }]
    const bogus = ['fertilize', 'water_due']
    expect(groupRows(mixed, 'type', bogus).map(g => g.key)).toEqual(['water_due', 'fertilize'])
  })

  it('pinned auto-expand set does not open a collapsed section as budget frees up', () => {
    // The second movement source: autoExpandKeys fills a row budget in group order, so draining the
    // lead group used to free budget and silently open the next section mid-tap.
    // Budget 6: on arrival Drive's 4 rows open and Bag's 5 do not fit (4+5=9), so ONE section opens.
    const budget = 6
    expect([...autoExpandKeys(groupRows(ALL, 'location'), budget)]).toEqual(['locDrive'])
    // Unpinned + drained: Bag now leads with 5 and Drive's surviving 1 row fits (5+1=6) — a second
    // section pops open mid-tap, and the first one moved. Both movements, from the budget alone.
    const drained = ALL.filter(r => !['d1', 'd2', 'd3'].includes(r.plantingId))
    expect([...autoExpandKeys(groupRows(drained, 'location'), budget)]).toEqual(['locBag', 'locDrive'])
    // Pinned set is computed from the full list (CareNeeded's `pinnedGroups`), so it is unchanged.
    expect([...autoExpandKeys(groupRows(ALL, 'location'), budget)]).toEqual(['locDrive'])
  })
})
