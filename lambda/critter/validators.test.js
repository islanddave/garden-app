import { describe, it, expect } from 'vitest'
import {
  validatePrefsPatchBody, validateSpeciesPrefsPatchBody,
  validateMarkViewedPatchBody, MAX_MARK_VIEWED_BATCH, UUID_RE,
  GARDEN_EXPANDED_MAX,
} from './validators.js'

const VALID_UUID = '11111111-2222-3333-4444-555555555555'
const OTHER_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('UUID_RE', () => {
  it('matches valid UUIDs', () => {
    expect(UUID_RE.test(VALID_UUID)).toBe(true)
    expect(UUID_RE.test(OTHER_UUID)).toBe(true)
  })
  it('rejects invalid UUIDs', () => {
    expect(UUID_RE.test('not-a-uuid')).toBe(false)
    expect(UUID_RE.test('')).toBe(false)
    expect(UUID_RE.test('11111111-2222-3333-4444-5555555555')).toBe(false)
  })
})

describe('validatePrefsPatchBody', () => {
  it('accepts each updatable field individually', () => {
    expect(validatePrefsPatchBody({ critter_visit: 'off' })).toBeNull()
    expect(validatePrefsPatchBody({ critter_visit: 'in_app_only' })).toBeNull()
    expect(validatePrefsPatchBody({ critter_visit: 'system' })).toBeNull()
    expect(validatePrefsPatchBody({ quiet_hours_start: '22:30' })).toBeNull()
    expect(validatePrefsPatchBody({ quiet_hours_end: '06:00' })).toBeNull()
  })
  it('rejects invalid critter_visit value', () => {
    expect(validatePrefsPatchBody({ critter_visit: 'maybe' })?.status).toBe(400)
  })
  it('rejects bad time format', () => {
    expect(validatePrefsPatchBody({ quiet_hours_start: '25:00' })?.status).toBe(400)
    expect(validatePrefsPatchBody({ quiet_hours_start: '9pm' })?.status).toBe(400)
  })
  it('rejects empty body', () => {
    expect(validatePrefsPatchBody({})?.status).toBe(400)
  })
  it('accepts each valid garden_group_by value', () => {
    for (const v of ['none', 'type', 'lifecycle', 'heat', 'determinacy', 'day_length', 'allium_type', 'basil_use', 'location', 'group', 'freeform', 'status']) {
      expect(validatePrefsPatchBody({ garden_group_by: v })).toBeNull()
    }
  })
  it('rejects an invalid garden_group_by value', () => {
    expect(validatePrefsPatchBody({ garden_group_by: 'bogus' })?.status).toBe(400)
  })
  it('accepts each valid garden_sort_order value', () => {
    expect(validatePrefsPatchBody({ garden_sort_order: 'alpha' })).toBeNull()
    expect(validatePrefsPatchBody({ garden_sort_order: 'recency' })).toBeNull()
  })
  it('rejects an invalid garden_sort_order value', () => {
    expect(validatePrefsPatchBody({ garden_sort_order: 'sideways' })?.status).toBe(400)
  })
  it('accepts a garden_expanded array of id strings (incl. empty)', () => {
    expect(validatePrefsPatchBody({ garden_expanded: [] })).toBeNull()
    expect(validatePrefsPatchBody({ garden_expanded: ['a', 'b', 'c'] })).toBeNull()
  })
  it('rejects garden_expanded that is not an array of strings', () => {
    expect(validatePrefsPatchBody({ garden_expanded: 'nope' })?.status).toBe(400)
    expect(validatePrefsPatchBody({ garden_expanded: [1, 2] })?.status).toBe(400)
  })
  it('rejects an oversized garden_expanded', () => {
    expect(validatePrefsPatchBody({ garden_expanded: Array(2001).fill('x') })?.status).toBe(400)
  })
  it('accepts a garden_bloom_seen array of id strings', () => {
    expect(validatePrefsPatchBody({ garden_bloom_seen: [] })).toBeNull()
    expect(validatePrefsPatchBody({ garden_bloom_seen: ['robin', 'honeybee'] })).toBeNull()
  })
  it('rejects garden_bloom_seen that is not an array of strings', () => {
    expect(validatePrefsPatchBody({ garden_bloom_seen: 'nope' })?.status).toBe(400)
    expect(validatePrefsPatchBody({ garden_bloom_seen: [1] })?.status).toBe(400)
  })
  it('accepts a boolean garden_helper_rung1_seen', () => {
    expect(validatePrefsPatchBody({ garden_helper_rung1_seen: true })).toBeNull()
    expect(validatePrefsPatchBody({ garden_helper_rung1_seen: false })).toBeNull()
  })
  it('rejects a non-boolean garden_helper_rung1_seen', () => {
    expect(validatePrefsPatchBody({ garden_helper_rung1_seen: 'yes' })?.status).toBe(400)
    expect(validatePrefsPatchBody({ garden_helper_rung1_seen: 1 })?.status).toBe(400)
  })
})

describe('validateSpeciesPrefsPatchBody (D-INV-1 Option A)', () => {
  it('accepts love (2.0) and meh (0.5)', () => {
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: 2.0 })).toBeNull()
    expect(validateSpeciesPrefsPatchBody({ species_id: 5, weight: 0.5 })).toBeNull()
    expect(validateSpeciesPrefsPatchBody({ species_id: 8, weight: 1.0 })).toBeNull()
  })
  it('rejects species_id outside pool range', () => {
    expect(validateSpeciesPrefsPatchBody({ species_id: 0, weight: 1 })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 300, weight: 1 })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 255, weight: 1 })?.status).toBe(400)
  })
  it('rejects bad weights', () => {
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: 0 })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: -1 })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: 100 })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: NaN })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: 'two' })?.status).toBe(400)
  })
})

describe('validateMarkViewedPatchBody (Session 3.5 §3.26)', () => {
  it('accepts null/undefined body (bulk-fallback path)', () => {
    expect(validateMarkViewedPatchBody(null)).toBeNull()
    expect(validateMarkViewedPatchBody(undefined)).toBeNull()
  })
  it('accepts empty object (no actually_seen_critter_ids key → bulk fallback)', () => {
    expect(validateMarkViewedPatchBody({})).toBeNull()
  })
  it('accepts empty array (still bulk fallback at handler — validator allows)', () => {
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: [] })).toBeNull()
  })
  it('accepts single valid UUID', () => {
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: [VALID_UUID] })).toBeNull()
  })
  it('accepts multiple valid UUIDs', () => {
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: [VALID_UUID, OTHER_UUID] })).toBeNull()
  })
  it('rejects non-object body', () => {
    expect(validateMarkViewedPatchBody('string')?.status).toBe(400)
    expect(validateMarkViewedPatchBody(42)?.status).toBe(400)
  })
  it('rejects top-level array (not a plain object)', () => {
    expect(validateMarkViewedPatchBody([])?.status).toBe(400)
    expect(validateMarkViewedPatchBody([VALID_UUID])?.status).toBe(400)
  })
  it('rejects non-array actually_seen_critter_ids', () => {
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: VALID_UUID })?.status).toBe(400)
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: { 0: VALID_UUID } })?.status).toBe(400)
  })
  it('rejects non-UUID items', () => {
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: ['not-a-uuid'] })?.status).toBe(400)
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: [VALID_UUID, 'bad'] })?.status).toBe(400)
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: [123] })?.status).toBe(400)
  })
  it('rejects oversize batch (> MAX_MARK_VIEWED_BATCH)', () => {
    const big = new Array(MAX_MARK_VIEWED_BATCH + 1).fill(VALID_UUID)
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: big })?.status).toBe(400)
  })
  it('accepts batch at MAX_MARK_VIEWED_BATCH', () => {
    const right_at_max = new Array(MAX_MARK_VIEWED_BATCH).fill(VALID_UUID)
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: right_at_max })).toBeNull()
  })
  it('MAX_MARK_VIEWED_BATCH constant is exported and reasonable (≥50, ≤1000)', () => {
    expect(Number.isInteger(MAX_MARK_VIEWED_BATCH)).toBe(true)
    expect(MAX_MARK_VIEWED_BATCH).toBeGreaterThanOrEqual(50)
    expect(MAX_MARK_VIEWED_BATCH).toBeLessThanOrEqual(1000)
  })
})

// V4-USERPREFS-001 — the three per-device UI states that became per-user server state
// (V4-TODAYLOC-002, V4-LOGMANY-001, V4-WHATSNEW-002). today_skipped gets the most attention
// because it is the only non-scalar and the only one with a matching DB CHECK: this validator is
// what turns a malformed write into an actionable 400 instead of a constraint-violation 500.
describe('validatePrefsPatchBody — V4-USERPREFS-001 fields', () => {
  const ok = (body) => expect(validatePrefsPatchBody(body)).toBeNull()
  const bad = (body) => expect(validatePrefsPatchBody(body)?.status).toBe(400)

  it('accepts a well-formed today_skipped', () => {
    ok({ today_skipped: { date: '2026-08-17', keys: ['plant:abc', 'plant:def'] } })
    ok({ today_skipped: { date: '2026-08-17', keys: [] } })
  })

  it('rejects today_skipped that is not an object — an array satisfies typeof but not the contract', () => {
    bad({ today_skipped: ['plant:abc'] })
    bad({ today_skipped: 'plant:abc' })
    bad({ today_skipped: 42 })
  })

  it('rejects a missing or malformed date', () => {
    bad({ today_skipped: { keys: [] } })
    bad({ today_skipped: { date: '17-08-2026', keys: [] } })
    bad({ today_skipped: { date: '2026-8-7', keys: [] } })
    bad({ today_skipped: { date: 20260817, keys: [] } })
  })

  it('rejects a missing or non-string keys array', () => {
    bad({ today_skipped: { date: '2026-08-17' } })
    bad({ today_skipped: { date: '2026-08-17', keys: 'plant:abc' } })
    bad({ today_skipped: { date: '2026-08-17', keys: [1, 2] } })
  })

  it('rejects an oversize keys array', () => {
    bad({ today_skipped: { date: '2026-08-17', keys: new Array(GARDEN_EXPANDED_MAX + 1).fill('k') } })
    ok({ today_skipped: { date: '2026-08-17', keys: new Array(GARDEN_EXPANDED_MAX).fill('k') } })
  })

  it('log_many_all_selected must be boolean — and false is a REAL value, not an absence', () => {
    ok({ log_many_all_selected: true })
    // The whole point of nullable-no-default: `false` is a choice and must survive validation.
    ok({ log_many_all_selected: false })
    bad({ log_many_all_selected: 'true' })
    bad({ log_many_all_selected: 1 })
  })

  it('whats_new_last_seen accepts any short string — NOT semver-validated on purpose', () => {
    ok({ whats_new_last_seen: '4.31.0' })
    // A future scheme must not be rejected here; the client treats unparseable as "show the dot".
    ok({ whats_new_last_seen: '2026.08-rc1' })
    bad({ whats_new_last_seen: 'x'.repeat(33) })
    bad({ whats_new_last_seen: 4.31 })
  })

  it('each new field ALONE satisfies the has-updatable check', () => {
    // Regression guard: the field must be added to HAS_UPDATABLE, not just validated. Omitting it
    // there yields "no updatable fields present" on a body that is otherwise perfectly valid —
    // a 400 that names the wrong problem and is very hard to read from the client side.
    ok({ today_skipped: { date: '2026-08-17', keys: [] } })
    ok({ log_many_all_selected: true })
    ok({ whats_new_last_seen: '4.31.0' })
  })

  it('still rejects an empty body', () => {
    bad({})
  })
})
