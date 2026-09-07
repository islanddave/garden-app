// V5-PHOTOFILTERPARITY-001 (BD0901-01) — the Photos page's filter/sort DECISIONS, unit-tested.
//
// These live in src/lib rather than in the page because `src/pages/**` is outside vitest's
// coverage.include, so a predicate written inside PhotoLibrary.jsx is unmeasured by construction
// (scrollRestore.js records the same split for the same reason). The page-level wiring — that the
// chips render, compose and clear — is covered separately in PhotoLibrary.filterParity.test.jsx.
//
// EVERY FILTER ASSERTION CARRIES A NEGATIVE, and at least one negative shares a field with the row
// that survives. A filter test whose fixture is all-tomato is green against a predicate that always
// returns true, one that ignores its argument, and one that reads the wrong column.
import { describe, it, expect } from 'vitest'
import {
  cropIndex, cropOfPhoto, filterByCrop, sortPhotos, activeFilterPills, prettySlug,
  PHOTO_SORT_NEWEST, PHOTO_SORT_OLDEST, DEFAULT_PHOTO_SORT, PHOTO_FILTER_MODES,
} from '../lib/photoFilters.js'

const PLANTS = [
  { id: 'pl-t1', variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'pl-t2', variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'pl-p1', variety_ref: { crop_type_slug: 'pepper' } },
  // A live planting with NO cultivar joined — variety_ref is null on the wire whenever
  // cultivar_id is unset (the picker projection's `CASE WHEN pv.id IS NOT NULL`). It must index to
  // nothing rather than to `undefined` sitting in the map as a key.
  { id: 'pl-none', variety_ref: null },
]

const IDX = cropIndex(PLANTS)

const photo = (id, over = {}) => ({
  id, created_at: '2026-09-01T12:00:00Z', plant_id: null, event_id: null, project_id: null, ...over,
})

describe('cropIndex / cropOfPhoto — the plant_id join', () => {
  it('maps a planting to its crop, and a cultivar-less planting to nothing', () => {
    expect(IDX.get('pl-t1')).toBe('tomato')
    expect(IDX.get('pl-p1')).toBe('pepper')
    expect(IDX.has('pl-none'), 'a planting with no cultivar must not enter the index').toBe(false)
  })

  it('returns null for a photo that names no planting — the honest exclusion, not a default crop', () => {
    // THE CASE THE FEATURE IS BOUNDED BY. A photo attached only to an event, a zone, a project or an
    // inventory item carries no plant_id. Answering "tomato" for it — or answering with the first
    // crop in the index — would invent a subject the row does not claim.
    expect(cropOfPhoto(photo('a', { event_id: 'ev-1' }), IDX)).toBeNull()
    expect(cropOfPhoto(photo('b', { project_id: 'proj-1' }), IDX)).toBeNull()
    // A plant_id that no longer resolves (archived out of the picker projection) is also null, not
    // a crash and not a stale label.
    expect(cropOfPhoto(photo('c', { plant_id: 'pl-gone' }), IDX)).toBeNull()
    expect(cropOfPhoto(photo('d', { plant_id: 'pl-t1' }), IDX)).toBe('tomato')
  })

  it('survives a missing index rather than throwing on a page that has not joined yet', () => {
    expect(cropOfPhoto(photo('e', { plant_id: 'pl-t1' }), null)).toBeNull()
    expect(cropIndex(undefined).size).toBe(0)
  })
})

describe('filterByCrop — multi-select OR over the joined crop', () => {
  // The negatives share project_id with the survivors, so a predicate keyed on the wrong column
  // (project, which is the ONLY other groupable field on a photo row) reds on both directions.
  const TOM_A = photo('tom-a', { plant_id: 'pl-t1', project_id: 'proj-1' })
  const TOM_B = photo('tom-b', { plant_id: 'pl-t2', project_id: 'proj-2' })
  const PEP_A = photo('pep-a', { plant_id: 'pl-p1', project_id: 'proj-1' })
  const EVENT_ONLY = photo('ev-only', { event_id: 'ev-1', project_id: 'proj-1' })
  const ALL = [TOM_A, TOM_B, PEP_A, EVENT_ONLY]
  const ids = (list) => list.map((p) => p.id)

  it('keeps every photo when nothing is selected — and hands back the SAME array', () => {
    // Identity, not just equality: an unfiltered page must not churn the memo below it.
    expect(filterByCrop(ALL, new Set(), IDX)).toBe(ALL)
    expect(filterByCrop(ALL, null, IDX)).toBe(ALL)
  })

  it('narrows to the chosen crop across projects, and drops the same-project other crop', () => {
    const out = ids(filterByCrop(ALL, new Set(['tomato']), IDX))
    expect(out, 'a tomato in a different project must survive').toContain('tom-b')
    expect(out).toContain('tom-a')
    expect(out, 'a pepper sharing tom-a\'s project must not survive a tomato filter').not.toContain('pep-a')
    expect(out, 'a photo with no planting cannot match any crop chip').not.toContain('ev-only')
  })

  it('is OR across chips, not a mode switch', () => {
    const out = ids(filterByCrop(ALL, new Set(['tomato', 'pepper']), IDX))
    expect(out).toEqual(expect.arrayContaining(['tom-a', 'tom-b', 'pep-a']))
    expect(out, 'OR across chips is still a narrowing — the plantingless photo stays out')
      .not.toContain('ev-only')
  })

  it('a chip that matches nothing yields nothing rather than falling back to everything', () => {
    // The fail-OPEN mistake: a predicate that treats an unmatched slug as "no filter" would return
    // the full list here and look like it worked.
    expect(filterByCrop(ALL, new Set(['kohlrabi']), IDX)).toEqual([])
  })
})

describe('sortPhotos', () => {
  // DELIBERATELY OUT OF ORDER on the way in. The server returns created_at DESC, so a fixture that
  // arrived pre-sorted would let a no-op sort pass the 'newest' case.
  const ROWS = [
    photo('mid', { created_at: '2026-09-02T10:00:00Z' }),
    photo('new', { created_at: '2026-09-03T10:00:00Z' }),
    photo('old', { created_at: '2026-09-01T10:00:00Z' }),
  ]
  const ids = (list) => list.map((p) => p.id)

  it('orders newest first by default, and oldest first on request', () => {
    expect(ids(sortPhotos(ROWS, PHOTO_SORT_NEWEST))).toEqual(['new', 'mid', 'old'])
    expect(ids(sortPhotos(ROWS, PHOTO_SORT_OLDEST))).toEqual(['old', 'mid', 'new'])
    expect(DEFAULT_PHOTO_SORT).toBe(PHOTO_SORT_NEWEST)
    // An unknown/absent order is newest, not "whatever arrived" — a page restoring a corrupt value
    // must land on the shipped order rather than on the wire's.
    expect(ids(sortPhotos(ROWS, 'sideways'))).toEqual(['new', 'mid', 'old'])
  })

  it('does not mutate its argument', () => {
    const before = ids(ROWS)
    sortPhotos(ROWS, PHOTO_SORT_OLDEST)
    expect(ids(ROWS), 'the caller\'s array is the page\'s state — sorting must copy').toEqual(before)
  })

  it('sorts a photo with no timestamp LAST in BOTH directions', () => {
    // Both directions, because "last" is the whole claim: a naive comparator puts the unknown at the
    // head of one of the two orders, which is the top of a list someone is scanning.
    const withNull = [...ROWS, photo('undated', { created_at: null })]
    expect(ids(sortPhotos(withNull, PHOTO_SORT_NEWEST)).at(-1)).toBe('undated')
    expect(ids(sortPhotos(withNull, PHOTO_SORT_OLDEST)).at(-1)).toBe('undated')
  })

  it('breaks ties on id so the order is total and stable', () => {
    const tied = [
      photo('b', { created_at: '2026-09-02T10:00:00Z' }),
      photo('a', { created_at: '2026-09-02T10:00:00Z' }),
    ]
    expect(ids(sortPhotos(tied, PHOTO_SORT_NEWEST))).toEqual(['a', 'b'])
    expect(ids(sortPhotos(tied, PHOTO_SORT_OLDEST))).toEqual(['a', 'b'])
  })
})

describe('activeFilterPills — the breadcrumb', () => {
  const labels = new Map([['tomato', 'Tomato']])

  it('is empty at the untouched default, so the bar never renders over an unfiltered page', () => {
    expect(activeFilterPills({ mode: 'all', cropSel: new Set() })).toEqual([])
    expect(activeFilterPills()).toEqual([])
  })

  it('names every active axis, with the mode label taken from the chip row\'s own table', () => {
    const pills = activeFilterPills({
      mode: 'untagged',
      cropSel: new Set(['tomato']),
      cropLabelBySlug: labels,
      locationId: 'loc-1',
      locationLabel: 'Pasture › Bed A',
      projectId: 'proj-1',
      projectLabel: 'Spring 2026',
    })
    expect(pills.map((p) => p.kind)).toEqual(['mode', 'crop', 'zone', 'project'])
    expect(pills.map((p) => p.label))
      .toEqual(['Untagged', 'Tomato', 'Pasture › Bed A', 'Spring 2026'])
    // The label a chip shows and the label its pill shows come from ONE table.
    expect(pills[0].label).toBe(PHOTO_FILTER_MODES.find((m) => m.value === 'untagged').label)
    // Facets are the four that carry a hue, so a mixed row is distinguishable by more than order.
    expect(pills.map((p) => p.facet)).toEqual(['freeform', 'type', 'location', 'group'])
  })

  it('never emits a blank pill for a value whose row has gone missing', () => {
    // A pill with no text is a control nobody can aim at — and a zone that has been deleted is
    // exactly when the user most needs to be able to remove the filter.
    const pills = activeFilterPills({ locationId: 'loc-gone', locationLabel: '' })
    expect(pills).toHaveLength(1)
    expect(pills[0].label).toBe('loc-gone')
  })

  it('falls back to a prettified slug when the crop vocabulary has no row', () => {
    // useCropTypes resolves to an empty list on any failure; this is its documented degrade path.
    const pills = activeFilterPills({ cropSel: new Set(['summer_squash']), cropLabelBySlug: new Map() })
    expect(pills[0].label).toBe('Summer Squash')
    expect(prettySlug('winter-squash')).toBe('Winter Squash')
  })
})
