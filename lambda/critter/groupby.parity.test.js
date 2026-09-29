// Client <-> Lambda parity for garden_group_by. BUG-GARDENGROUPBYRESET-001.
//
// WHY TWO COPIES, and why they drifted. The client refuses a value before spending a round trip
// (saveGardenGroupBy) and the Lambda refuses it at WRITE time (validatePrefsPatchBody); neither side can
// import the other. Nothing compared them, and nothing compared either to what Garden's group-by control
// actually OFFERS: Type ('crop_type') was missing from both, and the three bean facets from the Lambda's. A
// choice either side refuses never reaches the server, so every Garden mount re-adopted the older server
// value and regrouped the list under the user's thumb — Dave's "every return flips it to Lifecycle".
//
// IF THIS FAILS, a list diverged or Garden grew an option. Add the value to BOTH lists in one release: a value
// the client sends but the Lambda refuses is a save that 400s every time, and a value the control offers but
// either list refuses is a grouping that is silently forgotten.
import { describe, it, expect } from 'vitest'
import { GARDEN_GROUP_BY_VALUES as SERVER, validatePrefsPatchBody } from './validators.js'
import { GARDEN_GROUP_BY_VALUES as CLIENT } from '../../src/lib/notificationPrefsClient.js'
import { buildGardenFacetOptions, GARDEN_TAG_FACETS } from '../../src/lib/gardenGroupBy.js'

describe('garden_group_by — the client and the Lambda accept the same values', () => {
  it('the two allow-lists are the same set', () => {
    expect([...SERVER].sort()).toEqual([...CLIENT].sort())
  })
  it('neither list repeats a value (a duplicate can hide a missing one from a length check)', () => {
    expect(new Set(CLIENT).size).toBe(CLIENT.length)
    expect(SERVER.size).toBeGreaterThanOrEqual(CLIENT.length)
  })
})

describe('every value Garden\'s group-by control can offer is in both lists', () => {
  // The widest control there can be: every tag facet present on some planting, in BOTH flag states — the
  // options the page builds itself (buildGardenFacetOptions is what Garden.jsx renders), not a copy of them.
  const everyFacet = { p1: { direct: GARDEN_TAG_FACETS.map(facet => ({ facet })), projected: [] } }
  const offered = [...new Set([true, false].flatMap(hidden => buildGardenFacetOptions(everyFacet, hidden).map(o => o.value)))]

  it('the enumeration reaches the structural options and every tag facet (anti-vacuity)', () => {
    expect(offered).toEqual(expect.arrayContaining(['crop_type', 'location', 'status', 'none', 'type', ...GARDEN_TAG_FACETS]))
  })
  it('the client will send each one', () => {
    expect(offered.filter(v => !CLIENT.includes(v))).toEqual([])
  })
  it('the Lambda will store each one', () => {
    expect(offered.filter(v => !SERVER.has(v))).toEqual([])
    for (const v of offered) expect(validatePrefsPatchBody({ garden_group_by: v }), v).toBeNull()
  })
})
