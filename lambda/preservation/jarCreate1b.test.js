// Put-Up release 1b — POST /api/preservation's additions (V4 API table, row "POST /api/preservation"):
// idempotency_key, label, container_label, precision, is_raw, in_oil, texture, the pH pair, and the
// discard-by basis from the engine (typed from key PRESENCE). Also the relaxed gate that goes with the
// relaxed CHECKs: a label attributes a jar and names an Other, and a jar may be logged with no size.
//
// Executes the real handler (lambda/preservation/index.js under the vitest stubs). The mock driver runs
// no SQL, so this proves what the handler SENDS and how it answers — the CHECKs themselves are proven on
// PG 17 by the 1b migration's rehearsal and by the integration lane.
import { describe, it, expect, beforeEach } from 'vitest'
import { stubState, resetStubs } from '../_test-stubs/state.js'
import { validateCreate, validateLegacyPut, normalizeJarUnit, jarErrorMessage } from './jarRules.js'

const { handler } = await import('./index.js')

const USER = 'user_stub_dave'
const PLACE = '5b1c2b4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const KEY = '7c1c2b4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

const post = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: '/api/preservation',
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
})
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') })
const base = (over = {}) => ({
  label: 'Megatron plain', method: 'hot_sauce', preserved_at: '2026-10-08',
  quantity_value: 16, quantity_unit: 'fl oz', package_count: 2, storage_location_id: PLACE, ...over,
})

// The value bound to the Nth column of the INSERT's column list (the stub joins strings with '?').
const insertValues = () => {
  const call = stubState.sqlCalls.find((c) => /INSERT INTO preservation_log/.test(c.text))
  expect(call, 'no INSERT reached the driver').toBeTruthy()
  const cols = call.text.slice(call.text.indexOf('(') + 1, call.text.indexOf(') VALUES'))
    .split(',').map((c) => c.trim())
  return Object.fromEntries(cols.map((c, i) => [c, call.values[i]]))
}

beforeEach(() => {
  resetStubs()
  stubState.verifyTokenResult = { sub: USER }
  stubState.sqlHandler = (text) => {
    if (/FROM storage_location/.test(text)) return [{ id: PLACE, kind: 'fridge' }]
    if (/INSERT INTO preservation_log/.test(text)) return [{ id: 'new-jar' }]
    return []
  }
})

describe('the relaxed create gate (validateCreate, 1b)', () => {
  it.each([
    ['a label alone attributes a jar', { method: 'hot_sauce', preserved_at: '2026-10-08', label: 'Megatron plain' }, null],
    ['no crop, variety, planting or label is still refused, in 1a\'s words', { method: 'hot_sauce', preserved_at: '2026-10-08' },
      /at least one of crop_type_slug, variety_id or plant_id/],
    ['a blank label does not attribute', { method: 'hot_sauce', preserved_at: '2026-10-08', label: '  ' },
      /at least one of crop_type_slug, variety_id or plant_id/],
    ['an Other named by its label needs no method_other_text', { method: 'other', preserved_at: '2026-10-08', label: 'Drinking vinegar' }, null],
    ['an unnamed Other is still refused, in 1a\'s words', { method: 'other', preserved_at: '2026-10-08', crop_type_slug: 'pepper' },
      /method_other_text is required/],
    ['a jar may be logged with no size', { method: 'hot_sauce', preserved_at: '2026-10-08', label: 'x' }, null],
    ['a size needs its unit', { method: 'hot_sauce', preserved_at: '2026-10-08', label: 'x', quantity_value: 2 }, /quantity_unit is required/],
    ['a unit needs an amount', { method: 'hot_sauce', preserved_at: '2026-10-08', label: 'x', quantity_unit: 'g' }, /go together/],
    ['0 is not a size, in 1a\'s words', { method: 'hot_sauce', preserved_at: '2026-10-08', label: 'x', quantity_value: 0, quantity_unit: 'g' },
      /quantity_value must be > 0/],
    ['a unit outside the union', { method: 'hot_sauce', preserved_at: '2026-10-08', label: 'x', quantity_value: 2, quantity_unit: 'gallons' },
      /quantity_unit must be one of/],
    ['texture only on a dried food', { ...base(), texture: 'snaps' }, /texture only applies/],
    ['texture on dehydrate', { ...base({ method: 'dehydrate' }), texture: 'bends' }, null],
    ['an unknown texture', { ...base({ method: 'dehydrate' }), texture: 'crunchy' }, /texture must be one of/],
    ['is_raw must be a boolean', { ...base(), is_raw: 'yes' }, /is_raw must be true or false/],
    ['a precision outside the vocabulary', { ...base(), preserved_at_precision: 'fortnight' }, /preserved_at_precision must be one of/],
    ['a pH off the scale', { ...base(), ph_reading: '15' }, /pH scale/],
    ['a pH reading with no time is fine (the jar\'s date is used)', { ...base(), ph_reading: '3.7' }, null],
    ['a malformed key', { ...base(), idempotency_key: 'not-a-uuid' }, /idempotency_key must be a uuid/],
    ['a label over 120 characters', { ...base(), label: 'x'.repeat(121) }, /at most 120/],
    ['a non-date use_by_target', { ...base(), use_by_target: 'next spring' }, /use_by_target must be a YYYY-MM-DD date/],
  ])('%s', (_label, body, want) => {
    const err = validateCreate(body)
    if (want == null) expect(err).toBeNull()
    else expect(err).toMatch(want)
  })
})

describe('POST /api/preservation — what 1b writes', () => {
  it('an absent use_by_target: the engine\'s date AND its basis, from the place\'s kind and the 1b facts', async () => {
    const res = parse(await handler(post(base())))
    expect(res.status).toBe(201)
    const v = insertValues()
    expect(v.use_by_target).toBe('2027-04-08')         // hot_sauce, fridge: 6 months
    expect(v.use_by_basis).toBe('table')
    expect(v.label).toBe('Megatron plain')
  })

  it('Raw in the fridge: the engine answers no date, basis none', async () => {
    await handler(post(base({ is_raw: true })))
    const v = insertValues()
    expect(v.use_by_target).toBeNull()
    expect(v.use_by_basis).toBe('none')
    expect(v.is_raw).toBe(true)
  })

  it('a PRESENT use_by_target is his date — basis typed — and an explicit null is his "no date"', async () => {
    await handler(post(base({ use_by_target: '2026-12-01' })))
    expect(insertValues()).toMatchObject({ use_by_target: '2026-12-01', use_by_basis: 'typed' })
    stubState.sqlCalls = []
    await handler(post(base({ use_by_target: null })))
    expect(insertValues()).toMatchObject({ use_by_target: null, use_by_basis: 'typed' })
  })

  it('a Walk "Not sure" date (precision unknown) gets no engine date', async () => {
    await handler(post(base({ preserved_at_precision: 'unknown' })))
    expect(insertValues()).toMatchObject({ use_by_target: null, use_by_basis: 'none', preserved_at_precision: 'unknown' })
  })

  it('a plural unit is stored singular; the pH time defaults to the jar\'s own date', async () => {
    await handler(post(base({ quantity_value: 2, quantity_unit: 'quarts', ph_reading: '3.70' })))
    const v = insertValues()
    expect(v.quantity_unit).toBe('qt')
    expect(v.ph_reading).toBe('3.70')                  // the string, never a Number round-trip
    expect(v.ph_read_at).toBe('2026-10-08')
  })

  it('a replay: a 23505 on uq_preservation_log_idempotency_key re-reads by key, owner-scoped → 200 replayed', async () => {
    stubState.sqlHandler = (text, values) => {
      if (/FROM storage_location/.test(text)) return [{ id: PLACE, kind: 'fridge' }]
      if (/INSERT INTO preservation_log/.test(text)) {
        throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_preservation_log_idempotency_key' })
      }
      if (/WHERE idempotency_key = /.test(text)) {
        expect(values).toContain(KEY)
        expect(values.some((v) => Array.isArray(v) && v.includes(USER))).toBe(true)
        return [{ id: 'first-jar' }]
      }
      return []
    }
    const res = parse(await handler(post(base({ idempotency_key: KEY }))))
    expect(res).toEqual({ status: 200, body: { id: 'first-jar', replayed: true } })
  })

  it('a key held outside the household → 409, no payload', async () => {
    stubState.sqlHandler = (text) => {
      if (/FROM storage_location/.test(text)) return [{ id: PLACE, kind: 'fridge' }]
      if (/INSERT INTO preservation_log/.test(text)) {
        throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_preservation_log_idempotency_key' })
      }
      return []
    }
    const res = parse(await handler(post(base({ idempotency_key: KEY }))))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'That key is already in use.', code: 'key_conflict' })  // contract-F §2 common
  })

  it('a 23505 on any OTHER constraint is not a replay', async () => {
    stubState.sqlHandler = (text) => {
      if (/FROM storage_location/.test(text)) return [{ id: PLACE, kind: 'fridge' }]
      if (/INSERT INTO preservation_log/.test(text)) {
        throw Object.assign(new Error('dup'), { code: '23505', constraint: 'preservation_log_pkey' })
      }
      return []
    }
    const res = parse(await handler(post(base({ idempotency_key: KEY }))))
    expect(res.status).toBe(500)
    expect(stubState.sqlCalls.some((c) => /WHERE idempotency_key = /.test(c.text))).toBe(false)
  })
})

describe('the legacy PUT gate and the words for 1b\'s CHECKs', () => {
  it('validateLegacyPut requires no key at all: an absent key is unchanged', () => {
    expect(validateLegacyPut({})).toBeNull()
    expect(validateLegacyPut({ remaining_count: 1 })).toBeNull()
    expect(validateLegacyPut({ crop_type_slug: null, variety_id: null, plant_id: null })).toBeNull()
  })
  it('validateLegacyPut still shape-checks what IS sent', () => {
    expect(validateLegacyPut({ method: 'sunbake' })).toMatch(/method must be one of/)
    expect(validateLegacyPut({ package_count: 0 })).toMatch(/package_count/)
    expect(validateLegacyPut({ remaining_count: -1 })).toMatch(/remaining_count/)
    expect(validateLegacyPut({ quantity_value: 2 })).toMatch(/quantity_unit is required/)
    expect(validateLegacyPut({ quantity_value: 0 })).toBeNull()   // 0 keeps the stored pair
  })
  it('normalizeJarUnit folds the ten plurals and nothing else', () => {
    expect(['lbs', 'cups', 'pints', 'quarts', 'bushels', 'half-bushels', 'pecks', 'flats', 'jars', 'bags'].map(normalizeJarUnit))
      .toEqual(['lb', 'cup', 'pint', 'qt', 'bushel', 'half-bushel', 'peck', 'flat', 'jar', 'bag'])
    expect(normalizeJarUnit('fl oz')).toBe('fl oz')
    expect(normalizeJarUnit('  ')).toBeNull()
  })
  it('jarErrorMessage words the attribution CHECK a label-only echo can still reach, and nothing foreign', () => {
    expect(jarErrorMessage({ code: '23514', constraint: 'chk_preservation_log_attribution' })).toMatch(/crop, a variety, a planting or a name/)
    expect(jarErrorMessage({ code: '23514', constraint: 'chk_kbi_kind' })).toBeNull()
    expect(jarErrorMessage({ code: '23505', constraint: 'chk_preservation_log_attribution' })).toBeNull()
  })
})
