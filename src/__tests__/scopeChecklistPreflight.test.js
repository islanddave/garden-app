// Lane D / Phase D (slice 2) — pre-flight gate (plan §5 Phase D "strengthened gate").
// Hard-aborts the build if the picker/checklist dependencies regress:
//   (1) the canonical named exports the bulk-log pickers import still exist, and
//   (2) LogMany's public season helpers survive the ScopeChecklist extraction, and
//   (3) the HS-2 server-side plant_id filter the scope path depends on is still present
//       (the exhaustive coverage lives in lambda/events/hs2-plant-filter.test.js; this is
//       the slice's own cross-referencing tripwire so the dependency can't silently vanish).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  EVENT_TYPES,
  EVENT_TYPE_META,
  BATCH_EVENT_TYPES,
  buildSecondaryGroups,
} from '../lib/eventTypes.js'
import {
  primaryValuesForSeason,
  secondaryGroupsExcluding,
  coldProtectionSeason,
} from '../pages/LogMany.jsx'

describe('slice-2 pre-flight — canonical eventTypes named exports', () => {
  it('EVENT_TYPES is a non-empty array', () => {
    expect(Array.isArray(EVENT_TYPES)).toBe(true)
    expect(EVENT_TYPES.length).toBeGreaterThan(0)
  })
  it('EVENT_TYPE_META is a keyed object', () => {
    expect(EVENT_TYPE_META && typeof EVENT_TYPE_META).toBe('object')
    expect(EVENT_TYPE_META.watering?.label).toBeTruthy()
  })
  it('BATCH_EVENT_TYPES is a non-empty array', () => {
    expect(Array.isArray(BATCH_EVENT_TYPES)).toBe(true)
    expect(BATCH_EVENT_TYPES.length).toBeGreaterThan(0)
  })
  it('buildSecondaryGroups is a function returning grouped entries', () => {
    expect(typeof buildSecondaryGroups).toBe('function')
    expect(Array.isArray(buildSecondaryGroups(['watering']))).toBe(true)
  })
})

describe('slice-2 pre-flight — LogMany public helpers survive the extraction', () => {
  it('exports primaryValuesForSeason / secondaryGroupsExcluding / coldProtectionSeason', () => {
    expect(typeof primaryValuesForSeason).toBe('function')
    expect(typeof secondaryGroupsExcluding).toBe('function')
    expect(typeof coldProtectionSeason).toBe('function')
    expect(Array.isArray(primaryValuesForSeason(true))).toBe(true)
  })
})

describe('slice-2 pre-flight — HS-2 server plant_id filter present (scope dependency)', () => {
  const SRC = readFileSync(resolve(process.cwd(), 'lambda/events/index.js'), 'utf8')
  it('events Lambda still reads plant_id from the query string', () => {
    expect(SRC).toMatch(/queryStringParameters\?\.plant_id/)
  })
  it('events Lambda still filters by e.plant_id server-side', () => {
    expect(SRC).toMatch(/AND e\.plant_id = \$\{plantId\}/)
  })
})
