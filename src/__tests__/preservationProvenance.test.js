// V4-PUTUPPROV-001 — provenance vocabulary + validation + column parity.
//
// Lives in the BLOCKING build-and-test suite, not in integration. That is the whole reason
// lambda/preservation/provenance.js is dependency-free: index.js imports neon/clerk/aws, none of
// which are in the root package.json, so it cannot be imported under `npm ci` in CI — the same
// constraint that produced attribution.js. Integration is advisory at the promote gate
// (promote-gate.yml require_integration defaults to false), so provenance rules validated only
// there would effectively be ungated.
import { describe, it, expect } from 'vitest'
import {
  VALID_SOURCE_KINDS, PRESERVATION_EDITABLE_COLUMNS, SOURCE_LABEL_MAX,
  validateProvenance, normalizeSourceLabel,
} from '../../lambda/preservation/provenance.js'
import { PUTUP_SOURCE_OPTIONS } from '../lib/dropdownRegistry.js'

describe('source_kind vocabulary', () => {
  // A LITERAL, not a property check. The vocab lives in three places (this constant, the DB CHECK,
  // and dropdownRegistry) and only two of them can be asserted from a unit test — so assert those
  // two hard. A code-side widening that outruns the migration reds CI here instead of surfacing as
  // an unactionable 23514 in prod.
  it('is exactly the eight agreed values, in frequency order', () => {
    expect(VALID_SOURCE_KINDS).toEqual([
      'own_garden', 'u_pick', 'farm_stand', 'csa', 'store', 'gift', 'foraged', 'other',
    ])
  })

  it('matches the UI pick-list exactly', () => {
    expect(PUTUP_SOURCE_OPTIONS.map(o => o.value)).toEqual(VALID_SOURCE_KINDS)
  })

  // plants.source_type gained plant_swap, and mirroring it here was considered and rejected: a
  // swapped PLANT is a lineage fact, swapped PRODUCE behaves identically to a gift on a freezer
  // inventory. This asserts the decision so it is re-argued rather than drifted into.
  it('deliberately excludes plant_swap', () => {
    expect(VALID_SOURCE_KINDS).not.toContain('plant_swap')
  })

  it('rejects an out-of-vocab kind and names the valid set', () => {
    const err = validateProvenance({ source_kind: 'plant_swap' })
    expect(err).toMatch(/source_kind must be one of/)
    expect(err).toContain('farm_stand')
  })
})

describe("the 'other' escape hatch requires a label", () => {
  // THE MATRIX THAT MATTERS. undefined and null are the cases Postgres three-valued logic hides —
  // the naive CHECK (source_kind <> 'other' OR btrim(source_label) <> '') evaluates FALSE OR NULL
  // = NULL, and a CHECK that evaluates to NULL PASSES. They are also the cases a hand-written test
  // always skips. If this block ever shrinks, the constraint is unenforced again.
  it.each([undefined, null, '', '   ', '\t', '\n'])(
    'rejects source_label %p', (v) => {
      expect(validateProvenance({ source_kind: 'other', source_label: v })).toMatch(/required/)
    })

  it('accepts a real label', () => {
    expect(validateProvenance({ source_kind: 'other', source_label: 'bought frozen' })).toBeNull()
  })
})

describe('source_label', () => {
  it('is optional for every non-other kind (the common legal case)', () => {
    for (const k of VALID_SOURCE_KINDS.filter(k => k !== 'other')) {
      expect(validateProvenance({ source_kind: k })).toBeNull()
    }
  })

  it('is allowed on any non-garden kind — Dave names his vendors', () => {
    expect(validateProvenance({ source_kind: 'u_pick', source_label: 'Clarkdale Fruit Farm' })).toBeNull()
    expect(validateProvenance({ source_kind: 'gift', source_label: 'Warner Farms' })).toBeNull()
  })

  it(`rejects over ${SOURCE_LABEL_MAX} characters`, () => {
    expect(validateProvenance({ source_kind: 'store', source_label: 'x'.repeat(SOURCE_LABEL_MAX + 1) }))
      .toMatch(/characters or fewer/)
    expect(validateProvenance({ source_kind: 'store', source_label: 'x'.repeat(SOURCE_LABEL_MAX) })).toBeNull()
  })

  it('normalizes blank-ish values to null so they cannot fragment the vendor list', () => {
    expect(normalizeSourceLabel('  Warner Farms  ')).toBe('Warner Farms')
    for (const v of [null, undefined, '', '   ', '\t']) expect(normalizeSourceLabel(v)).toBeNull()
  })

  it('rejects a label with no kind — a row that says "from somewhere" but not where', () => {
    expect(validateProvenance({ source_label: 'Warner Farms' })).toMatch(/needs a source_kind/)
  })
})

describe('NULL source_kind means unrecorded, and is legal', () => {
  // D1-b. NULL is never coerced to own_garden. From August to October most put-ups are bought-in,
  // so a default of own_garden would fabricate provenance for exactly the rows this feature exists
  // to record.
  it('accepts an absent source_kind', () => {
    expect(validateProvenance({})).toBeNull()
    expect(validateProvenance({ source_kind: null })).toBeNull()
  })
})

describe('a non-garden source cannot carry a garden link (D2-c)', () => {
  it('rejects plant_id on a non-garden source', () => {
    expect(validateProvenance({ source_kind: 'farm_stand', plant_id: 'pl-1' }))
      .toMatch(/clear the planting/i)
  })

  // The brief named only plant_id. The harvest-triggered prefill sets BOTH, so omitting this leaves
  // a second way to tell the same lie.
  it('rejects harvest_log_id on a non-garden source', () => {
    expect(validateProvenance({ source_kind: 'store', harvest_log_id: 'h-1' }))
      .toMatch(/clear the harvest/i)
  })

  // Both of these must pass, or the rule above could be satisfied by one that just forbids plant_id.
  it('allows plant_id on own_garden, and allows own_garden with no planting', () => {
    expect(validateProvenance({ source_kind: 'own_garden', plant_id: 'pl-1' })).toBeNull()
    expect(validateProvenance({ source_kind: 'own_garden' })).toBeNull()
  })
})

describe('column parity — the guard that catches the NEXT column too', () => {
  it('lists both provenance columns as client-editable', () => {
    expect(PRESERVATION_EDITABLE_COLUMNS).toContain('source_kind')
    expect(PRESERVATION_EDITABLE_COLUMNS).toContain('source_label')
  })

  it('has no duplicates and no server-owned columns', () => {
    expect(new Set(PRESERVATION_EDITABLE_COLUMNS).size).toBe(PRESERVATION_EDITABLE_COLUMNS.length)
    for (const owned of ['id', 'user_id', 'created_at', 'updated_at', 'deleted_at']) {
      expect(PRESERVATION_EDITABLE_COLUMNS).not.toContain(owned)
    }
  })
})
