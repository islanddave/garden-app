// Put-Up R2a, lane Df — the door's put-up body against the create route (plan contract 9; QA 3.2 as amended by
// D2: the pinned key list is less photo_id, plus texture).
//
// WHY THIS IS NOT A validateCreate TEST. The Lambda's validateCreate has no list of allowed keys and the
// route reads named keys only, so a misspelt key (`source_lable`, `is_Raw`) validates clean, answers 201 and
// stores nothing. So: (1) the door's keys are pinned by EXACT equality against DOOR_KEYS, and (2) every body
// goes through the REAL create handler (lambda/preservation/index.js under the vitest stubs) and each key is
// read back out of the INSERT, in its own column. A key with no column fails "has a column of that name".
//
// THE FORM'S KEYS are a frozen literal (src/pages/PutUp.jsx PutUpForm at R2a), held to a living server
// constant, and — while the form still exists — checked against the form's own text. That last assertion
// leaves with the form in R2b; the literal was then proved against the code once.
//
// THE WIRE TYPE (ruling Df-4): quantity_value is a JSON number, === Number(totalOfEach(size, count)); when
// there is no total BOTH keys are absent. The ANSWER's type is not pinned here: the create answers the
// driver's numeric as text.
//
// MUTATIONS (run, see the lane report): totalOfEach(count, size) -> "0.5 pint × 3 sends 1.5 pint"; a chip
// value the server refuses -> the unit loop; misspell source_label -> the key-set equality AND "has a column
// of that name"; a stale non-garden choice let through on a planting -> "a planting sends own_garden"; a
// numeric string sent -> the wire-type pin; a stale texture sent after a method change -> both fixtures.
// CI LANE: `npm test` plus the TZ re-run. No DOM.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stubState, resetStubs } from '../../lambda/_test-stubs/state.js'
import { validateCreate, normalizeJarUnit, VALID_METHODS } from '../../lambda/preservation/jarRules.js'
import { PRESERVATION_EDITABLE_COLUMNS, VALID_SOURCE_KINDS } from '../../lambda/preservation/provenance.js'
import {
  jarBody, doorError, methodChoices, sizeTotal, sizeTotalError, sizeEcho, PUT_UP_TOTAL_MAX, SIZE_TOTAL_TOO_BIG_TEXT,
  WHERE_REQUIRED_TEXT,
} from '../components/pantry/putSomethingUp.js'
import { SIZE_UNITS, MORE_SIZE_UNITS } from '../components/pantry/AmountField.jsx'
import { FIRST_SOURCE_KINDS, MORE_SOURCE_KINDS, whereFromError } from '../components/pantry/WhereFromField.jsx'
import { totalOfEach } from '../components/putup/jarWords.js'
import { TEXTURE_CHIPS, TEXTURE_METHODS, RAW_METHODS, ALL_PUT_UP_METHODS } from '../components/putup/putItUp.js'
import { JAR_CREATE_COLUMNS } from './helpers/pantryFake.js'

const { handler } = await import('../../lambda/preservation/index.js')

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const USER = 'user_stub_dave'
const PLACE = '5b1c2b4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const PLANT = '6a1c2b4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const VARIETY = '8d1c2b4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const KEY = '7c1c2b4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const TODAY = { date: '2026-10-01', precision: 'day' }
const sorted = (xs) => [...xs].sort()

// The 17 keys the "Log a put-up" form sends (PutUpForm's body, src/pages/PutUp.jsx, at R2a).
const FORM_KEYS = [
  'preserved_at', 'preserved_at_approx', 'method', 'quantity_value', 'quantity_unit', 'package_count', 'source_kind',
  'crop_type_slug', 'variety_id', 'plant_id', 'harvest_log_id', 'method_other_text', 'storage_location_id', 'notes',
  'source_label', 'use_by_target', 'photo_id',
]
// What the door deliberately does not send: the harvest link and Other's own words (V4: not rebuilt), and a
// photo (Dave: wait).
const DROPPED = ['harvest_log_id', 'method_other_text', 'photo_id']
// The door's put-up keys, EXACTLY: the form's less the three drops, plus the door's own six. Lane S's static
// smoke pin compares the `s10` body against this literal.
const DOOR_KEYS = [
  'idempotency_key', 'label', 'method', 'preserved_at', 'preserved_at_precision', 'preserved_at_approx', 'package_count',
  'storage_location_id', 'crop_type_slug', 'variety_id', 'plant_id', 'source_kind', 'source_label', 'use_by_target',
  'quantity_value', 'quantity_unit', 'texture', 'is_raw', 'in_oil', 'notes',
]

const planting = { source: 'planting', name: 'Megatron jalapeño', plant_id: PLANT, crop_type_slug: 'pepper', variety_id: VARIETY }
const varietyHit = { source: 'variety', name: 'San Marzano', crop_type_slug: 'tomato', variety_id: VARIETY }
const typed = { source: 'typed', name: 'Garlic' }

// Every option the door's state can hold, handed to jarBody at once — the stale ones included: a texture
// left from an earlier Dehydrate choice, Raw left from an earlier Hot sauce choice, a where-from chosen
// before the name became a planting. jarBody decides what a method and a What may send.
const EVERYTHING = { isRaw: true, inOil: true, texture: 'bends', size: { value: '0.5', unit: 'pint' }, notes: '  from the big batch  ' }
const PLANTING_BODY = () => jarBody({
  key: KEY, what: planting, storageLocationId: PLACE, method: 'hot_sauce', when: TODAY, count: 3,
  discard: { mode: 'date', date: '2027-03-01' }, source: { kind: 'farm_stand', label: 'Warner Farms' }, ...EVERYTHING,
})
const TYPED_BODY = () => jarBody({
  key: KEY, what: varietyHit, storageLocationId: PLACE, method: 'dehydrate', when: { date: '2026-09-01', precision: 'month' }, count: 3,
  discard: { mode: 'none', date: '' }, source: { kind: 'farm_stand', label: '  Warner Farms ' }, ...EVERYTHING,
})

const post = (body) => ({
  requestContext: { http: { method: 'POST' } }, rawPath: '/api/preservation',
  headers: { authorization: 'Bearer stub-token' }, body: JSON.stringify(body),
})
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') })
// The INSERT the handler sent, read BY COLUMN: the Nth name of its column list against the Nth bound value
// (the stub joins the template's strings with '?').
function insertByColumn() {
  const call = stubState.sqlCalls.find((c) => /INSERT INTO preservation_log/.test(c.text))
  expect(call, 'no INSERT reached the driver').toBeTruthy()
  const cols = call.text.slice(call.text.indexOf('(') + 1, call.text.indexOf(') VALUES')).split(',').map((c) => c.trim())
  return { cols, values: Object.fromEntries(cols.map((c, i) => [c, call.values[i]])) }
}
// The server's own transforms between a body key and its column (lambda/preservation/index.js, the POST block).
const stored = (body, k) => {
  if (k === 'quantity_unit') return normalizeJarUnit(body[k])
  if (k === 'source_label') return body.source_kind === 'own_garden' ? null : String(body[k]).trim()
  if (k === 'use_by_target') return body[k] == null ? null : String(body[k]).slice(0, 10)
  if (k === 'label') return String(body[k]).trim()
  return body[k]
}

beforeEach(() => {
  resetStubs()
  stubState.verifyTokenResult = { sub: USER }
  stubState.sqlHandler = (text) => {
    if (/FROM storage_location/.test(text)) return [{ id: PLACE, kind: 'fridge' }]
    if (/FROM garden_node/.test(text)) return [{ id: PLANT, crop_type_slug: 'pepper', variety_id: VARIETY }]
    if (/INSERT INTO preservation_log/.test(text)) return [{ id: 'new-jar' }]
    return []
  }
})

describe('the form\'s keys — a frozen literal, held to the server and (while it exists) to the form', () => {
  it('are every creatable column the server names, less the two a create never sets', () => {
    expect(sorted(FORM_KEYS)).toEqual(sorted(PRESERVATION_EDITABLE_COLUMNS.filter(c => c !== 'remaining_count' && c !== 'consumed_at')))
  })

  // R2b deletes this one with the form.
  it('are the keys PutUpForm builds, read from its own text between `const body = {` and its POST', () => {
    const src = readFileSync(resolve(REPO, 'src/pages/PutUp.jsx'), 'utf8')
    const form = src.slice(src.indexOf('function PutUpForm('))
    const from = form.indexOf('const body = {')
    const to = form.indexOf("fetch('/api/preservation', { method: 'POST'", from)
    expect(from, 'PutUpForm no longer declares `const body = {`').toBeGreaterThan(-1)
    expect(to, 'PutUpForm no longer posts /api/preservation after its body').toBeGreaterThan(from)
    const span = form.slice(from, to).replace(/\/\/.*$/gm, '')               // its comments name keys in prose
    const literal = span.slice(0, span.indexOf('\n    }\n'))
    const keys = new Set([
      ...[...literal.matchAll(/^\s{6}([a-z_]+)(?::|,)/gm)].map(m => m[1]),
      ...[...span.matchAll(/\bbody\.([a-z_]+) = /g)].map(m => m[1]),
    ])
    expect(sorted(keys)).toEqual(sorted(FORM_KEYS))
  })
})

describe('the door\'s keys — exactly these twenty', () => {
  it('DOOR_KEYS is the form\'s keys less the three drops, plus the door\'s own six', () => {
    expect(DOOR_KEYS).toHaveLength(20)
    expect(sorted(DOOR_KEYS)).toEqual(sorted([
      ...FORM_KEYS.filter(k => !DROPPED.includes(k)),
      'idempotency_key', 'label', 'preserved_at_precision', 'is_raw', 'in_oil', 'texture',
    ]))
  })

  it('the two fullest bodies jarBody can build hold all twenty between them, and nothing else', () => {
    expect(sorted(new Set([...Object.keys(PLANTING_BODY()), ...Object.keys(TYPED_BODY())]))).toEqual(sorted(DOOR_KEYS))
  })

  it('each is a body the server\'s own validator takes', () => {
    expect(validateCreate(PLANTING_BODY())).toBeNull()
    expect(validateCreate(TYPED_BODY())).toBeNull()
  })

  it('a stale texture, a stale Raw and a stale where-from are not sent: each fixture holds only what its method and What allow', () => {
    expect(PLANTING_BODY()).toEqual({
      idempotency_key: KEY, label: 'Megatron jalapeño', method: 'hot_sauce', preserved_at: '2026-10-01', preserved_at_precision: 'day',
      preserved_at_approx: false, package_count: 3, storage_location_id: PLACE, crop_type_slug: 'pepper', variety_id: VARIETY,
      plant_id: PLANT, source_kind: 'own_garden', quantity_value: 1.5, quantity_unit: 'pint', use_by_target: '2027-03-01',
      is_raw: true, in_oil: true, notes: 'from the big batch',
    })
    expect(TYPED_BODY()).toEqual({
      idempotency_key: KEY, label: 'San Marzano', method: 'dehydrate', preserved_at: '2026-09-01', preserved_at_precision: 'month',
      preserved_at_approx: true, package_count: 3, storage_location_id: PLACE, crop_type_slug: 'tomato', variety_id: VARIETY,
      source_kind: 'farm_stand', source_label: 'Warner Farms', quantity_value: 1.5, quantity_unit: 'pint', use_by_target: null,
      in_oil: true, texture: 'bends', notes: 'from the big batch',
    })
  })

  it('every door key is a column the create writes (the fake\'s list, which a sibling test reads from the INSERT)', () => {
    for (const k of DOOR_KEYS) expect(`${k}: ${JAR_CREATE_COLUMNS.includes(k)}`).toBe(`${k}: true`)
  })
})

describe('each body through the REAL create handler — every key lands in its own INSERT column', () => {
  it.each([['PLANTING', PLANTING_BODY], ['TYPED', TYPED_BODY]])('%s: 201, and each key is bound in the column of its own name', async (_n, build) => {
    const body = build()
    const res = parse(await handler(post(body)))
    expect(res.status).toBe(201)
    const { cols, values } = insertByColumn()
    for (const k of Object.keys(body)) {
      expect(`${k} has a column of that name: ${cols.includes(k)}`).toBe(`${k} has a column of that name: true`)
      expect({ [k]: values[k] }).toEqual({ [k]: stored(body, k) })
    }
  })

  it('a planting sends own_garden, and no name is stored beside it', async () => {
    await handler(post(PLANTING_BODY()))
    const { values } = insertByColumn()
    expect([values.plant_id, values.source_kind, values.source_label]).toEqual([PLANT, 'own_garden', null])
  })

  it('the dropped keys are in no body, and their columns are stored empty', async () => {
    for (const b of [PLANTING_BODY(), TYPED_BODY()]) for (const k of DROPPED) expect(Object.keys(b)).not.toContain(k)
    await handler(post(TYPED_BODY()))
    const { values } = insertByColumn()
    expect([values.harvest_log_id, values.method_other_text, values.photo_id]).toEqual([null, null, null])
  })

  it('Other with a name: no method_other_text key, the server takes it, and the name is the label', async () => {
    const body = jarBody({ key: KEY, what: { source: 'typed', name: ' Drinking vinegar ' }, storageLocationId: PLACE, method: 'other', when: TODAY })
    expect(Object.keys(body)).not.toContain('method_other_text')
    expect(validateCreate(body)).toBeNull()
    expect(parse(await handler(post(body))).status).toBe(201)
    const { values } = insertByColumn()
    expect([values.method, values.method_other_text, values.label]).toEqual(['other', null, 'Drinking vinegar'])
  })

  it('a planting alone attributes: a planting hit with no crop passes the validator and the handler', async () => {
    const body = jarBody({ key: KEY, what: { source: 'planting', name: 'Mystery squash', plant_id: PLANT }, storageLocationId: PLACE, method: 'whole_freeze', when: TODAY })
    expect(Object.keys(body)).not.toContain('crop_type_slug')
    expect(validateCreate(body)).toBeNull()
    expect(parse(await handler(post(body))).status).toBe(201)
  })
})

describe('what the door never builds', () => {
  it('no place: doorError stops the save before a body exists', () => {
    expect(doorError({ what: typed, place: null, method: 'whole_freeze' })).toEqual({ error: WHERE_REQUIRED_TEXT, field: 'where' })
  })

  it('"Bought already preserved" is not a door method: the door offers every server method but that one', () => {
    const offered = methodChoices({ placeKind: null, what: typed })
    expect(sorted([...offered.chips, ...offered.more])).toEqual(sorted(VALID_METHODS.filter(m => m !== 'purchased_preserved')))
    expect(sorted(ALL_PUT_UP_METHODS)).toEqual(sorted(VALID_METHODS.filter(m => m !== 'purchased_preserved')))
  })
})

describe('every value a chip can send is one the server takes', () => {
  const UNITS = [...SIZE_UNITS, ...MORE_SIZE_UNITS]
  it('the size chips are these sixteen stored singulars — no bare "oz" label, no bag, no jar, no plural', () => {
    expect(SIZE_UNITS.map(u => u.label)).toEqual(['cup', 'pint', 'qt', 'fl oz', 'lb', 'oz (weight)'])
    expect(UNITS.map(u => u.value)).toEqual(['cup', 'pint', 'qt', 'fl oz', 'lb', 'oz', 'gal', 'g', 'kg', 'ml', 'l', 'count', 'peck', 'bushel', 'half-bushel', 'flat'])
  })

  it.each(UNITS.map(u => [u.value]))('the unit %s: the validator takes it, and it is stored as sent', (unit) => {
    const body = jarBody({ key: KEY, what: typed, storageLocationId: PLACE, method: 'whole_freeze', when: TODAY, count: 2, size: { value: '1', unit } })
    expect(body.quantity_unit).toBe(unit)
    expect(validateCreate(body)).toBeNull()
    expect(normalizeJarUnit(unit)).toBe(unit)
  })

  it('the where-from chips are the server\'s eight kinds', () => {
    expect(sorted([...FIRST_SOURCE_KINDS, ...MORE_SOURCE_KINDS])).toEqual(sorted(VALID_SOURCE_KINDS))
  })

  it.each([...FIRST_SOURCE_KINDS, ...MORE_SOURCE_KINDS].map(k => [k]))('the source %s, with a name typed: the validator takes it', (kind) => {
    const body = jarBody({ key: KEY, what: typed, storageLocationId: PLACE, method: 'whole_freeze', when: TODAY, source: { kind, label: 'Warner Farms' } })
    expect(body.source_kind).toBe(kind)
    expect(Object.keys(body).includes('source_label')).toBe(kind !== 'own_garden')     // the garden has no name to send
    expect(validateCreate(body)).toBeNull()
  })

  it('a kind with no name sends the kind alone; Other with no name is refused by the door before the server would refuse it', () => {
    const store = jarBody({ key: KEY, what: typed, storageLocationId: PLACE, method: 'whole_freeze', when: TODAY, source: { kind: 'store', label: '  ' } })
    expect([store.source_kind, Object.keys(store).includes('source_label')]).toEqual(['store', false])
    expect(validateCreate(store)).toBeNull()
    expect(whereFromError({ kind: 'other', label: ' ' })).not.toBeNull()
    const other = jarBody({ key: KEY, what: typed, storageLocationId: PLACE, method: 'whole_freeze', when: TODAY, source: { kind: 'other', label: '' } })
    expect(validateCreate(other)).toMatch(/source_label is required/)
  })

  it.each(TEXTURE_CHIPS.map(c => [c.value]))('the texture %s on a dried method: sent, and the validator takes it', (texture) => {
    for (const method of TEXTURE_METHODS) {
      const body = jarBody({ key: KEY, what: typed, storageLocationId: PLACE, method, when: TODAY, texture })
      expect(body.texture).toBe(texture)
      expect(validateCreate(body)).toBeNull()
    }
  })

  it('a texture on any other method, and Raw on a method that does not allow it, are never sent', () => {
    for (const method of ALL_PUT_UP_METHODS) {
      const body = jarBody({ key: KEY, what: typed, storageLocationId: PLACE, method, when: TODAY, isRaw: true, inOil: true, texture: 'still_soft' })
      expect(`${method} texture: ${'texture' in body}`).toBe(`${method} texture: ${TEXTURE_METHODS.has(method)}`)
      expect(`${method} is_raw: ${'is_raw' in body}`).toBe(`${method} is_raw: ${RAW_METHODS.has(method)}`)
      expect(validateCreate(body)).toBeNull()
    }
  })
})

describe('a planting sends own_garden (the put-up route)', () => {
  it('whatever the where-from state held: own_garden, and no source_label', () => {
    for (const source of [null, { kind: 'farm_stand', label: 'Warner Farms' }, { kind: 'other', label: 'a neighbour' }, { kind: null, label: 'left over' }]) {
      const body = jarBody({ key: KEY, what: planting, storageLocationId: PLACE, method: 'whole_freeze', when: TODAY, source })
      expect(body.source_kind).toBe('own_garden')
      expect(Object.keys(body)).not.toContain('source_label')
      expect(validateCreate(body)).toBeNull()
    }
  })

  it('and the server refuses what the door would have sent had it let the stale choice through', () => {
    expect(validateCreate({ ...PLANTING_BODY(), source_kind: 'farm_stand', source_label: 'Warner Farms' })).toMatch(/clear the planting/)
  })
})

describe('the size on the wire — the TOTAL, a JSON number', () => {
  const sized = (value, unit, count) => jarBody({ key: KEY, what: typed, storageLocationId: PLACE, method: 'whole_freeze', when: TODAY, count, size: { value, unit } })

  it('0.5 pint × 3 sends 1.5 pint', () => {
    const body = sized('0.5', 'pint', 3)
    expect([body.quantity_value, body.quantity_unit, body.package_count]).toEqual([1.5, 'pint', 3])
  })

  it('quantity_value is a number, exactly Number(totalOfEach(size, count)); package_count an integer; preserved_at_approx a boolean', () => {
    for (const [value, count] of [['0.5', 3], ['0.83', 3], ['1', 1], ['2.25', 4], ['12', 7]]) {
      const body = sized(value, 'qt', count)
      expect(typeof body.quantity_value).toBe('number')
      expect(body.quantity_value).toBe(Number(totalOfEach(value, count)))
      expect(Number.isInteger(body.package_count)).toBe(true)
      expect(body.preserved_at_approx).toBe(false)
    }
    expect(sized('0.83', 'qt', 3).quantity_value).toBe(2.49)                 // decimal arithmetic, never 2.4899999999999998
    expect(jarBody({ key: KEY, what: typed, storageLocationId: PLACE, method: 'whole_freeze', when: { date: '2026-09-01', precision: 'month' } }).preserved_at_approx).toBe(true)
  })

  it('a comma is a decimal mark: "0,5" is read before the total is worked out', () => {
    expect(totalOfEach('0,5', 3)).toBeNull()                                 // the frozen helper has no comma arm …
    expect(sized('0,5', 'pint', 3).quantity_value).toBe(1.5)                 // … so the door reads the text first
  })

  it('no total: BOTH keys are absent — never a 0, never one key alone', () => {
    for (const [value, unit] of [['', null], ['', 'qt'], ['1', null], ['abc', 'qt'], ['0', 'qt'], ['-1', 'qt'], [undefined, undefined]]) {
      const body = sized(value, unit, 3)
      expect(Object.keys(body).filter(k => k.startsWith('quantity_'))).toEqual([])
      expect(sizeTotal({ value, unit }, 3)).toBeNull()
    }
    expect(Object.keys(jarBody({ key: KEY, what: typed, storageLocationId: PLACE, method: 'whole_freeze', when: TODAY, size: null }))).not.toContain('quantity_value')
  })

  it('a total past the column is refused in place, before any request (the create has no upper bound)', () => {
    expect(PUT_UP_TOTAL_MAX).toBe(99999999.99)
    expect(sizeTotalError({ value: '99999999.99', unit: 'g' }, 1)).toBeNull()
    expect(sizeTotalError({ value: '50000000', unit: 'g' }, 2)).toBe(SIZE_TOTAL_TOO_BIG_TEXT)
    expect(sizeTotalError({ value: '', unit: null }, 2)).toBeNull()
  })

  it('the echo says both numbers, only with more than one container', () => {
    expect(sizeEcho({ value: '1', unit: 'qt' }, 3)).toBe('3 × 1 qt = 3 qt in all')
    expect(sizeEcho({ value: '0,83', unit: 'qt' }, 3)).toBe('3 × 0.83 qt = 2.49 qt in all')
    expect(sizeEcho({ value: '8', unit: 'oz' }, 2)).toBe('2 × 8 oz = 16 oz in all')
    expect(sizeEcho({ value: '1', unit: 'qt' }, 1)).toBeNull()
    expect(sizeEcho({ value: '1', unit: null }, 3)).toBeNull()
  })
})

describe('a call passing none of the new arguments returns the body it always did, byte for byte', () => {
  it('a typed name', () => {
    expect(JSON.stringify(jarBody({ key: KEY, what: typed, storageLocationId: PLACE, method: 'whole_freeze', when: TODAY, count: 2, discard: { mode: 'auto', date: '' }, notes: ' n ' })))
      .toBe(`{"idempotency_key":"${KEY}","label":"Garlic","method":"whole_freeze","preserved_at":"2026-10-01","preserved_at_precision":"day","preserved_at_approx":false,"package_count":2,"storage_location_id":"${PLACE}","notes":"n"}`)
  })

  it('a planting, Raw and In oil, a typed date', () => {
    expect(JSON.stringify(jarBody({ key: KEY, what: planting, storageLocationId: PLACE, method: 'hot_sauce', when: TODAY, discard: { mode: 'date', date: '2027-03-01' }, isRaw: true, inOil: true })))
      .toBe(`{"idempotency_key":"${KEY}","label":"Megatron jalapeño","method":"hot_sauce","preserved_at":"2026-10-01","preserved_at_precision":"day","preserved_at_approx":false,"package_count":1,"storage_location_id":"${PLACE}","crop_type_slug":"pepper","variety_id":"${VARIETY}","plant_id":"${PLANT}","source_kind":"own_garden","use_by_target":"2027-03-01","is_raw":true,"in_oil":true}`)
  })
})
