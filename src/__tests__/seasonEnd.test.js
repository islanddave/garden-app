/**
 * src/__tests__/seasonEnd.test.js — the End of season page's rule, both ways.
 *
 * The list rule is the whole safety story of a surface that ENDS plantings in bulk: a slug the frost
 * alert would cautiously call tender, a covered parent location, or a perennial slipping into the
 * default list is a planting ended by mistake. So every exclusion has a case, and every case names the
 * mutation of src/lib/seasonEnd.js that turns it red (each was applied, observed red, and reverted).
 */
import { describe, it, expect } from 'vitest'
import {
  bandForSlug, indexLocations, isUnderRoof, classifyPlanting, buildSeasonList, groupSelectAction,
  applyGroupSelect, confirmSummary, countsByLocation, plantingsPhrase, endBody, restoreBody, canRestore,
  runPool, progressLine, endResultLine, undoResultLine, lastLoggedLabel, GROUP_FINISHED, GROUP_STILL_GROWING,
  WRITE_CONCURRENCY,
} from '../lib/seasonEnd.js'

// A small location tree: an open bed, a covered building with an uncovered shelf inside it, a heated
// house, and an open zone under a covered roof two levels up.
const LOCS = [
  { id: 'bed', name: 'Bag Area', parent_id: 'pasture', covered: false, heated: false },
  { id: 'pasture', name: 'Pasture', parent_id: null, covered: false, heated: false },
  { id: 'stable', name: 'Stable', parent_id: null, covered: true, heated: false },
  { id: 'rack', name: 'Indoor Rack', parent_id: 'stable', covered: false, heated: false },
  { id: 'house', name: 'House', parent_id: null, covered: true, heated: true },
  { id: 'porch', name: 'Porch', parent_id: null, covered: false, heated: true },
  { id: 'shelf', name: 'Shelf 1', parent_id: 'rack', covered: false, heated: false },
  { id: 'trough', name: 'Trough', parent_id: 'drive', covered: false, heated: false },
  { id: 'drive', name: 'Drive', parent_id: null, covered: false, heated: false },
]
const BY_ID = indexLocations(LOCS)

let n = 0
const planting = (slug, over = {}, lifecycle = null) => ({
  id: `p${++n}`, name: `${slug ?? 'none'} ${n}`, kind: 'planting', status: 'fruiting', location_id: 'bed',
  variety_ref: slug === undefined ? null : { name: String(slug), crop_type_slug: slug, default_lifecycle: lifecycle },
  last_logged_at: '2026-09-26T16:00:00.000Z', ...over,
})
const classify = (row) => classifyPlanting(row, BY_ID)

describe('the band is read DIRECTLY from the band map', () => {
  it('knows the five bands and nothing else — an unmapped slug has no band', () => {
    expect(bandForSlug('tomato')).toBe('tender')
    expect(bandForSlug(' Basil ')).toBe('chill_sensitive')
    expect(bandForSlug('lemon_verbena')).toBe('tropical')
    expect(bandForSlug('rosemary')).toBeNull()
    expect(bandForSlug('mystery_crop')).toBeNull()
    expect(bandForSlug(null)).toBeNull()
    // KILLING MUTATION: `FROST_BAND_BY_SLUG[s]` without hasOwn. RESULT: RED — 'constructor' is banded.
    expect(bandForSlug('constructor')).toBeNull()
  })
})

describe('FINISHED — listed, group-selectable', () => {
  it('tender and chill_sensitive crops outdoors are in, whatever their live status', () => {
    for (const status of ['fruiting', 'harvested', 'vegetative', 'flowering', null]) {
      expect(classify(planting('tomato', { status })), String(status)).toBe(GROUP_FINISHED)
    }
    expect(classify(planting('basil'))).toBe(GROUP_FINISHED)
    expect(classify(planting('pepper', { location_id: 'trough' }))).toBe(GROUP_FINISHED)
  })

  // KILLING MUTATION: FINISHED_BANDS gains 'tropical' (the CLASS_BY_BAND fold). RESULT: RED.
  it('a tropical crop is out, even outdoors', () => {
    expect(classify(planting('lemon_verbena'))).toBeNull()
    expect(classify(planting('ginger'))).toBeNull()
  })

  // KILLING MUTATION: fall back to 'tender' for an unmapped slug (the alert's UNKNOWN_BAND).
  // RESULT: RED on all four.
  it('an uncertain, unknown or missing crop is out — never the alert\'s cautious "counts as tender"', () => {
    expect(classify(planting('rosemary'))).toBeNull()
    expect(classify(planting('sedum'))).toBeNull()
    expect(classify(planting('mystery_crop'))).toBeNull()
    expect(classify(planting(undefined))).toBeNull()
  })

  it('a hardy perennial is out of BOTH groups (it goes dormant, it is not ended)', () => {
    expect(classify(planting('strawberry', {}, 'perennial'))).toBeNull()
    expect(classify(planting('chives', {}, 'perennial'))).toBeNull()
    expect(classify(planting('peach', {}, 'perennial'))).toBeNull()
  })

  // KILLING MUTATION: drop a status from CLOSED_STATUSES. RESULT: RED on that status.
  it('dormant, ended and failed plantings are out', () => {
    for (const status of ['dormant', 'ended', 'failed']) {
      expect(classify(planting('tomato', { status })), status).toBeNull()
    }
  })

  // KILLING MUTATION: drop the kind / archived_at / deleted_at checks in isLivePlanting. RESULT: RED.
  it('archived, deleted and non-planting rows are out', () => {
    expect(classify(planting('tomato', { archived_at: '2026-09-01T00:00:00Z' }))).toBeNull()
    expect(classify(planting('tomato', { deleted_at: '2026-09-01T00:00:00Z' }))).toBeNull()
    expect(classify(planting('tomato', { kind: 'surface' }))).toBeNull()
    expect(classify(planting('tomato', { kind: undefined }))).toBeNull()
  })

  // KILLING MUTATIONS: read only the planting's own location (drop the walk up parent_id); drop the
  // `covered` arm; drop the `heated` arm. RESULT: RED on the parent/grandparent case, the covered
  // cases, and the heated-uncovered porch respectively.
  it('anything under a covered or heated location — its own, its parent\'s or higher — is out', () => {
    expect(classify(planting('tomato', { location_id: 'stable' }))).toBeNull()
    expect(classify(planting('tomato', { location_id: 'house' }))).toBeNull()
    expect(classify(planting('tomato', { location_id: 'porch' }))).toBeNull()
    expect(classify(planting('tomato', { location_id: 'rack' }))).toBeNull()   // covered PARENT
    expect(classify(planting('tomato', { location_id: 'shelf' }))).toBeNull()  // covered GRANDPARENT
  })

  it('an unlocated planting, or one under a deleted location, reads as open sky (the roof rule\'s answer)', () => {
    expect(classify(planting('tomato', { location_id: null }))).toBe(GROUP_FINISHED)
    // GET /api/locations carries live locations only, so a deleted parent ends the walk — as the SQL join does.
    const orphanTree = indexLocations([{ id: 'x', name: 'X', parent_id: 'gone', covered: false, heated: false }])
    expect(isUnderRoof('x', orphanTree)).toBe(false)
  })

  // KILLING MUTATION: delete the visited-set guard. RESULT: the test never finishes.
  it('a parent cycle ends the walk instead of hanging', () => {
    const loop = indexLocations([
      { id: 'a', name: 'A', parent_id: 'b', covered: false, heated: false },
      { id: 'b', name: 'B', parent_id: 'a', covered: false, heated: false },
    ])
    expect(isUnderRoof('a', loop)).toBe(false)
  })

  it('only a strict true counts as a roof', () => {
    const odd = indexLocations([{ id: 'o', name: 'O', parent_id: null, covered: 'true', heated: 1 }])
    expect(isUnderRoof('o', odd)).toBe(false)
  })
})

describe('STILL GROWING THROUGH FROST — light-frost crops whatever their lifecycle; hardy crops that are annual or biennial', () => {
  it('lists hardy annuals and biennials and light-frost annuals, outdoors', () => {
    expect(classify(planting('lettuce', {}, 'annual'))).toBe(GROUP_STILL_GROWING)
    expect(classify(planting('kale', {}, 'biennial'))).toBe(GROUP_STILL_GROWING)
    expect(classify(planting('marigold', {}, 'annual'))).toBe(GROUP_STILL_GROWING)
  })

  // Petunias were listed nowhere: banded light_frost_tolerant, but their crop is not an annual or
  // biennial, so the old rule (every still-growing band gated on lifecycle) dropped them.
  // KILLING MUTATION: LIFECYCLE_GATED_BANDS gains 'light_frost_tolerant' (the old rule). RESULT: RED.
  it('lists a light-frost crop whatever its crop lifecycle — petunia included', () => {
    for (const lifecycle of ['tender_perennial', 'perennial', null, 'annual', 'biennial']) {
      expect(classify(planting('petunia', {}, lifecycle)), String(lifecycle)).toBe(GROUP_STILL_GROWING)
    }
    for (const slug of ['marigold', 'sunflower', 'borage', 'chamomile']) {
      expect(classify(planting(slug, {}, 'perennial')), slug).toBe(GROUP_STILL_GROWING)
    }
    const noLifecycle = planting('petunia')
    delete noLifecycle.variety_ref.default_lifecycle
    expect(classify(noLifecycle)).toBe(GROUP_STILL_GROWING)
    expect(buildSeasonList([planting('petunia', { id: 'pt', location_id: 'trough' }, 'tender_perennial')], LOCS))
      .toMatchObject({ finished: [], stillGrowing: [{ id: 'pt', kind: GROUP_STILL_GROWING, band: 'light_frost_tolerant', locationName: 'Trough' }] })
  })

  // KILLING MUTATIONS: SHORT_LIFECYCLES gains 'perennial'; LIFECYCLE_GATED_BANDS emptied (no lifecycle
  // gate at all); the gate reads grown_as. RESULT: RED.
  it('gates a HARDY crop on the CROP\'s default_lifecycle, not the variety\'s grown_as, and never lists a hardy perennial', () => {
    const grownAsAnnual = planting('chives', {}, 'perennial')
    grownAsAnnual.variety_ref.grown_as = 'annual'
    expect(classify(grownAsAnnual)).toBeNull()
    const grownAsPerennial = planting('lettuce', {}, 'annual')
    grownAsPerennial.variety_ref.grown_as = 'perennial'
    expect(classify(grownAsPerennial)).toBe(GROUP_STILL_GROWING)
    expect(classify(planting('lettuce', {}, null))).toBeNull()
    expect(classify(planting('kale', {}, 'tender_perennial'))).toBeNull()
    expect(classify(planting('sage', {}, 'perennial'))).toBeNull()
  })

  // KILLING MUTATION: classify a light-frost band before the live / status / roof checks. RESULT: RED.
  it('is subject to the same roof and status rules', () => {
    expect(classify(planting('kale', { location_id: 'rack' }, 'biennial'))).toBeNull()
    expect(classify(planting('kale', { status: 'dormant' }, 'biennial'))).toBeNull()
    expect(classify(planting('petunia', { location_id: 'rack' }, 'tender_perennial'))).toBeNull()
    expect(classify(planting('petunia', { location_id: 'porch' }, 'tender_perennial'))).toBeNull()
    expect(classify(planting('petunia', { status: 'ended' }, 'tender_perennial'))).toBeNull()
    expect(classify(planting('petunia', { archived_at: '2026-09-01T00:00:00Z' }, 'tender_perennial'))).toBeNull()
  })
})

describe('buildSeasonList', () => {
  it('groups finished rows by their own location, both alphabetical; still-growing is one flat list', () => {
    const rows = [
      planting('tomato', { id: 't1', name: 'Sungold', location_id: 'trough' }),
      planting('pepper', { id: 'p1', name: 'Aji 10', location_id: 'bed' }),
      planting('pepper', { id: 'p2', name: 'Aji 9', location_id: 'bed' }),
      planting('kale', { id: 'k1', name: 'Lacinato', location_id: 'trough' }, 'biennial'),
      planting('lettuce', { id: 'l1', name: 'Buttercrunch', location_id: 'bed' }, 'annual'),
      planting('tomato', { id: 'in', name: 'Indoor', location_id: 'house' }),
    ]
    const { finished, stillGrowing } = buildSeasonList(rows, LOCS)
    expect(finished.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ['Bag Area', ['p2', 'p1']], ['Trough', ['t1']],
    ])
    expect(stillGrowing.map((r) => r.id)).toEqual(['l1', 'k1'])
    expect(stillGrowing[0]).toMatchObject({ kind: GROUP_STILL_GROWING, band: 'hardy', locationName: 'Bag Area' })
  })

  it('never hands a planting id to the photo model', () => {
    const [g] = buildSeasonList([planting('tomato', {
      id: 'plant-1', featured_photo_id: 'photo-9', featured_photo_view_url: 'https://x/full', featured_photo_thumb_url: 'https://x/thumb',
    })], LOCS).finished
    expect(g.rows[0].photo).toEqual({ id: 'photo-9', featured_photo_view_url: 'https://x/full', featured_photo_thumb_url: 'https://x/thumb', plant_id: 'plant-1' })
  })
})

describe('group select — that group\'s rows only, nothing pre-ticked', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  // KILLING MUTATION: `every` -> `some` in groupSelectAction. RESULT: RED (one tick flips it to Clear).
  it('"Select N" until all N are ticked, then "Clear N"', () => {
    expect(groupSelectAction(rows, new Set())).toMatchObject({ verb: 'Select', count: 3, clears: false })
    expect(groupSelectAction(rows, new Set(['a']))).toMatchObject({ verb: 'Select', count: 3 })
    expect(groupSelectAction(rows, new Set(['a', 'b', 'c']))).toMatchObject({ verb: 'Clear', count: 3, clears: true })
  })

  it('selecting or clearing a group never touches another group\'s ticks', () => {
    const other = new Set(['z'])
    const selected = applyGroupSelect(other, groupSelectAction(rows, other))
    expect([...selected].sort()).toEqual(['a', 'b', 'c', 'z'])
    const cleared = applyGroupSelect(selected, groupSelectAction(rows, selected))
    expect([...cleared]).toEqual(['z'])
  })
})

describe('the confirm', () => {
  const item = (id, locationName, kind = GROUP_FINISHED, name = id) => ({ id, name, locationName, kind })
  it('counts by location, most first, and names every still-growing tick', () => {
    const s = confirmSummary([
      item('a', 'Trough'), item('b', 'Bag Area'), item('c', 'Bag Area'),
      item('k', 'Bag Area', GROUP_STILL_GROWING, 'Lacinato'),
    ])
    expect(s).toEqual({
      title: 'End 4 plantings?', button: 'End 4 plantings',
      counts: 'Bag Area: 3 · Trough: 1', stillGrowingNames: ['Lacinato'],
    })
    expect(confirmSummary([item('a', 'Deck')])).toMatchObject({ title: 'End 1 planting?', button: 'End 1 planting', stillGrowingNames: [] })
    expect(countsByLocation([item('a', 'B'), item('b', 'A')]).map((c) => c.label)).toEqual(['A', 'B'])
    expect(plantingsPhrase(1)).toBe('1 planting')
  })
})

describe('the two bodies — a status and nothing else', () => {
  // KILLING MUTATION: add an archive flag or a loss reason to endBody. RESULT: RED.
  it('end sends { status: "ended" }; undo sends the row\'s own prior status', () => {
    expect(endBody()).toEqual({ status: 'ended' })
    expect(restoreBody('harvested')).toEqual({ status: 'harvested' })
    expect(Object.keys(endBody())).toEqual(['status'])
  })

  it('a row with no prior status cannot be put back (COALESCE would keep it ended)', () => {
    expect(canRestore('fruiting')).toBe(true)
    expect(canRestore(null)).toBe(false)
    expect(canRestore('')).toBe(false)
  })
})

describe('runPool', () => {
  // KILLING MUTATION: start every item at once (lanes = items.length). RESULT: RED (peak 7).
  it('keeps at most WRITE_CONCURRENCY in flight, keeps input order, and never rejects', async () => {
    expect(WRITE_CONCURRENCY).toBeGreaterThanOrEqual(3)
    expect(WRITE_CONCURRENCY).toBeLessThanOrEqual(4)
    let live = 0
    let peak = 0
    const progress = []
    const results = await runPool([1, 2, 3, 4, 5, 6, 7], async (x) => {
      live++; peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 1))
      live--
      if (x === 4) throw new Error('nope')
      return x * 10
    }, { onProgress: (done, total) => progress.push(`${done}/${total}`) })
    expect(peak).toBe(WRITE_CONCURRENCY)
    expect(results.map((r) => (r.ok ? r.value : 'x'))).toEqual([10, 20, 30, 'x', 50, 60, 70])
    expect(progress.at(-1)).toBe('7/7')
    expect(progress).toHaveLength(7)
    expect(await runPool([], async () => 1)).toEqual([])
  })
})

describe('copy', () => {
  it('progress, results and partial undo say exactly what happened', () => {
    expect(progressLine('Ending', 2, 7)).toBe('Ending 3 of 7…')
    expect(progressLine('Ending', 7, 7)).toBe('Ending 7 of 7…')
    expect(endResultLine(7, 0)).toBe('Ended 7 plantings.')
    expect(endResultLine(5, 2)).toBe('Ended 5. 2 didn\'t save.')
    expect(endResultLine(0, 3)).toBe('Couldn\'t end these. Check your signal and try again.')
    expect(undoResultLine(5, 7)).toBe('Put back 5 of 7. 2 are still ended.')
    expect(undoResultLine(1, 2)).toBe('Put back 1 of 2. 1 is still ended.')
    expect(undoResultLine(7, 7)).toBe('Put back 7 plantings.')
  })

  // An ended row has left the list, so a partial undo names what is still ended — up to five, and only
  // when it has a name for every one of them.
  it('a partial undo names up to five rows still ended', () => {
    expect(undoResultLine(1, 2, ['Aji Amarillo'])).toBe('Put back 1 of 2. 1 is still ended: Aji Amarillo.')
    expect(undoResultLine(73, 75, ['Plant 01', 'Plant 02'])).toBe('Put back 73 of 75. 2 are still ended: Plant 01, Plant 02.')
    expect(undoResultLine(0, 5, ['a', 'b', 'c', 'd', 'e'])).toBe('Put back 0 of 5. 5 are still ended: a, b, c, d, e.')
    expect(undoResultLine(1, 7, ['a', 'b', 'c', 'd', 'e', 'f'])).toBe('Put back 1 of 7. 6 are still ended.')
    expect(undoResultLine(5, 7, ['a'])).toBe('Put back 5 of 7. 2 are still ended.')
    expect(undoResultLine(2, 2, ['a'])).toBe('Put back 2 plantings.')
  })

  it('"Last logged" is the LOCAL day, and drops the year only for this year', () => {
    const now = new Date('2026-09-29T12:00:00')
    // 01:30 UTC on the 27th is the evening of the 26th in Massachusetts (the suite runs in America/New_York).
    expect(lastLoggedLabel('2026-09-27T01:30:00.000Z', now)).toBe('Last logged Sep 26')
    expect(lastLoggedLabel('2025-10-02T16:00:00.000Z', now)).toBe('Last logged Oct 2, 2025')
    expect(lastLoggedLabel(null, now)).toBe('Nothing logged yet')
    expect(lastLoggedLabel('not a date', now)).toBe('Nothing logged yet')
  })
})
