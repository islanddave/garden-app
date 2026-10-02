// Put-Up R2a, lane Df — the door's AS-IS body against the item route (plan contract 9; ΔQA section 1, the
// item twin, rows 1 to 7 and 9; row 8 — the same cell through the door itself — is in PutUpR2Df.door.test.jsx).
//
// The item route is the opposite of the put-up route: a strict allowlist, any other key is a 400. Since R2a
// the door's state also holds a count, a size, Raw, In oil and a texture, so one shared spread would turn
// every As is save into a 400. itemBody is pinned here by EXACT key-set equality, and each body goes through
// the REAL route (lambda/preservation/pantryRoutes.js, which takes `sql` as an argument) with every key read
// back out of the INSERT by column.
//
// THE WIRE TYPE (ruling Df-4): quantity_value is a JSON number; the route refuses a string.
// A PLANTING WHAT (ruling Df-7): plant_id and NO source keys — the row's garden origin is its planting.
// AS BUILT by lane M (amendment C2), not as ΔQA row 5 first wrote it: the list row carries the four columns
// as stored and `where_from` as words; there are no server-built amount words.
//
// MUTATIONS (run, see the lane report): a put-up-only key in itemBody -> row 7; itemBody sends a source for a
// planting What -> row 9 (and pantryRows.test.js:223-227, unedited); a numeric string sent as quantity_value
// -> the wire-type pin; a chip value the route refuses -> the unit loop.
// CI LANE: `npm test` plus the TZ re-run. No DOM.
import { describe, it, expect } from 'vitest'
import { handlePantryRoute } from '../../lambda/preservation/pantryRoutes.js'
import {
  validateItemCreate, ITEM_CREATE_KEYS, projectItem, itemRow, PLANTING_SOURCE_REFUSAL,
} from '../../lambda/preservation/pantryItems.js'
import { VALID_SOURCE_KINDS } from '../../lambda/preservation/provenance.js'
import { itemBody } from '../components/pantry/putSomethingUp.js'
import { ITEM_AMOUNT_UNITS, MORE_ITEM_AMOUNT_UNITS, parseAmount } from '../components/pantry/AmountField.jsx'
import { FIRST_SOURCE_KINDS, MORE_SOURCE_KINDS, whereFromError } from '../components/pantry/WhereFromField.jsx'

const HOUSEHOLD = ['user_dave', 'user_jen']
const DAVE = 'user_dave'
const ITEM = '99999999-aaaa-4bbb-8ccc-000000000001'
const PLACE = '99999999-aaaa-4bbb-8ccc-000000000002'
const PLANT = '99999999-aaaa-4bbb-8ccc-000000000003'
const KEY = '11111111-1111-4222-8333-444444444444'
const NOW = new Date('2026-10-15T16:00:00Z')
const sorted = (xs) => [...xs].sort()

// The queue-backed tagged-template driver of lambda/preservation/pantryRoutes.test.js.
function mockSql(queue = []) {
  const calls = []
  const fn = (strings, ...values) => {
    const text = strings.raw.join(' ? ')
    calls.push({ text, norm: text.replace(/\s+/g, ' ').trim(), values })
    if (!queue.length) return Promise.reject(new Error(`unexpected extra query: ${text.replace(/\s+/g, ' ').slice(0, 90)}`))
    const next = queue.shift()
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  }
  fn.transaction = async (qs) => Promise.all(qs)
  fn.calls = calls
  return fn
}
const call = (sql, path, method, body, query = {}) => handlePantryRoute({
  sql, rawPath: path, method, rawBody: body == null ? null : JSON.stringify(body), query, userId: DAVE, householdIds: HOUSEHOLD, now: NOW,
})

// The item INSERT read BY COLUMN. The column list is the first parenthesis after `INSERT INTO pantry_item`;
// the value list is its `SELECT …` up to RETURNING, split on top-level commas; each expression holding a `?`
// takes the next bound value, counted from the `?`s before the list. storage_location_id is a sub-select, not
// a value, and so has no `?` of its own.
function itemInsertByColumn(sql) {
  const c = sql.calls.find(x => x.norm.includes('INSERT INTO pantry_item ('))
  expect(c, 'no item INSERT reached the driver').toBeTruthy()
  const at = c.norm.indexOf('INSERT INTO pantry_item (')
  const open = c.norm.indexOf('(', at)
  const close = c.norm.indexOf(')', open)
  const cols = c.norm.slice(open + 1, close).split(',').map(s => s.trim())
  const from = c.norm.indexOf('SELECT', close)
  const exprs = []
  let depth = 0; let cur = ''
  for (const ch of c.norm.slice(from + 'SELECT'.length, c.norm.indexOf('RETURNING', from))) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { exprs.push(cur.trim()); cur = '' } else cur += ch
  }
  exprs.push(cur.trim())
  expect(exprs).toHaveLength(cols.length)
  let n = (c.norm.slice(0, from).match(/\?/g) ?? []).length
  const values = {}
  cols.forEach((col, i) => { if (exprs[i].includes('?')) values[col] = c.values[n++] })
  return { cols, values }
}

const itemDb = (over = {}) => ({
  id: ITEM, user_id: DAVE, name: 'Garlic', storage_location_id: PLACE, acquired_at: '2026-10-03', acquired_precision: 'day',
  use_by_target: null, plant_id: null, crop_type_slug: null, notes: null, created_at: '2026-10-03T15:00:00.000Z',
  updated_at: '2026-10-03T15:00:00.000Z', deleted_at: null, used_up_at: null, place_label: 'Pantry shelf', place_kind: 'pantry',
  quantity_value: '2.35', quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco',
  crop_display_name: null, planting_name: null, planting_sown_at: null, planting_succession_order: null, ...over,
})

// Today's ten (the contract the door has always sent), frozen; R2a adds the four.
const TODAYS_TEN = ['idempotency_key', 'name', 'storage_location_id', 'place', 'acquired_at', 'acquired_precision', 'use_by_target', 'notes', 'plant_id', 'crop_type_slug']
const NEW_FOUR = ['quantity_value', 'quantity_unit', 'source_kind', 'source_label']

const planting = { source: 'planting', name: 'Sungold cherry', plant_id: PLANT, crop_type_slug: 'tomato', variety_id: 'v-sungold' }
const cropHit = { source: 'crop', name: '  Garlic ', crop_type_slug: 'garlic' }
const BOUGHT = () => itemBody({
  key: KEY, what: cropHit, place: { key: `id:${PLACE}`, id: PLACE, label: 'Pantry shelf', kind: 'pantry' },
  when: { date: '2026-10-01', precision: 'day' }, discard: { mode: 'date', date: '2026-11-15' }, notes: ' the big bag ',
  amount: { value: '2,345', unit: 'lb' }, source: { kind: 'store', label: ' Costco ' },
})
const FRESH = () => itemBody({
  key: KEY, what: planting, place: { key: 'new:fridge:fridge', id: null, label: 'Fridge', kind: 'fridge' },
  when: { date: '2026-10-01', precision: 'unknown' }, discard: { mode: 'auto', date: '' },
  amount: { value: '12', unit: 'count' }, source: { kind: 'farm_stand', label: 'left from before the hit' },
})

describe('row 1 — the server\'s create keys are today\'s ten plus the four', () => {
  it('ITEM_CREATE_KEYS', () => {
    expect(sorted(ITEM_CREATE_KEYS)).toEqual(sorted([...TODAYS_TEN, ...NEW_FOUR]))
  })
})

describe('rows 2 and 3 — the two fullest bodies itemBody can build', () => {
  it('BOUGHT and FRESH hold exactly the fourteen keys between them', () => {
    expect(sorted(new Set([...Object.keys(BOUGHT()), ...Object.keys(FRESH())]))).toEqual(sorted([...TODAYS_TEN, ...NEW_FOUR]))
  })

  it('BOUGHT: a typed name with its crop, a place, a day, a discard date, notes, an amount and where it is from', () => {
    expect(BOUGHT()).toEqual({
      idempotency_key: KEY, name: 'Garlic', storage_location_id: PLACE, acquired_at: '2026-10-01', acquired_precision: 'day',
      use_by_target: '2026-11-15', crop_type_slug: 'garlic', quantity_value: 2.35, quantity_unit: 'lb',
      source_kind: 'store', source_label: 'Costco', notes: 'the big bag',
    })
  })

  it('FRESH: a planting at a place not made yet, "not sure" for the day, an amount — and NO source keys', () => {
    expect(FRESH()).toEqual({
      idempotency_key: KEY, name: 'Sungold cherry', place: { kind: 'fridge', label: 'Fridge' }, acquired_precision: 'unknown',
      plant_id: PLANT, crop_type_slug: 'tomato', quantity_value: 12, quantity_unit: 'count',
    })
  })

  it('each is a body the route\'s own validator takes', () => {
    expect(validateItemCreate(BOUGHT())).toBeNull()
    expect(validateItemCreate(FRESH())).toBeNull()
  })
})

describe('row 4 — each body through the REAL route: every key that is a column is bound in that column', () => {
  it('BOUGHT: 201, and name, dates, crop, notes, the amount and the source each land in their own column', async () => {
    const body = BOUGHT()
    const sql = mockSql([[{ id: PLACE, label: 'Pantry shelf', kind: 'pantry' }], [itemDb()]])
    const res = await call(sql, '/api/pantry/items', 'POST', body)
    expect(res.status).toBe(201)
    const { cols, values } = itemInsertByColumn(sql)
    for (const k of Object.keys(body).filter(x => x !== 'storage_location_id')) {
      expect(`${k} has a column of that name: ${cols.includes(k)}`).toBe(`${k} has a column of that name: true`)
      expect({ [k]: values[k] }).toEqual({ [k]: body[k] })
    }
    expect(cols).toContain('storage_location_id')                           // bound through the place sub-select
  })

  it('FRESH: 201; the planting and the amount are bound, and BOTH source columns are bound NULL', async () => {
    const body = FRESH()
    const sql = mockSql([[{ id: PLANT, crop_type_slug: 'tomato' }], [itemDb({ plant_id: PLANT, source_kind: null, source_label: null })]])
    const res = await call(sql, '/api/pantry/items', 'POST', body)
    expect(res.status).toBe(201)
    const { values } = itemInsertByColumn(sql)
    expect([values.plant_id, values.crop_type_slug, values.quantity_value, values.quantity_unit]).toEqual([PLANT, 'tomato', 12, 'count'])
    expect([values.source_kind, values.source_label]).toEqual([null, null])
    expect([values.acquired_at, values.acquired_precision]).toEqual([null, 'unknown'])
  })

  it('a body with none of the four binds NULL for all four — the row the door made before R2a', async () => {
    const body = itemBody({ key: KEY, what: { source: 'typed', name: 'Rice' }, place: { id: PLACE, kind: 'pantry', label: 'Pantry shelf' }, when: { date: '2026-10-01', precision: 'day' }, discard: { mode: 'auto' } })
    expect(sorted(Object.keys(body))).toEqual(['acquired_at', 'acquired_precision', 'idempotency_key', 'name', 'storage_location_id'])
    const sql = mockSql([[{ id: PLACE, label: 'Pantry shelf', kind: 'pantry' }], [itemDb()]])
    expect((await call(sql, '/api/pantry/items', 'POST', body)).status).toBe(201)
    const { values } = itemInsertByColumn(sql)
    expect(NEW_FOUR.map(k => values[k])).toEqual([null, null, null, null])
  })
})

describe('row 5 — the four columns are carried by every read the door\'s save can be answered from', () => {
  const namesAll = (text) => NEW_FOUR.every(k => new RegExp(`\\b${k}\\b`).test(text))

  it('the create\'s RETURNING, the replay\'s SELECT, the PATCH\'s RETURNING and the list\'s SELECT each name all four', async () => {
    const created = mockSql([[{ id: PLACE, label: 'Pantry shelf', kind: 'pantry' }], [itemDb()]])
    await call(created, '/api/pantry/items', 'POST', BOUGHT())
    const ins = created.calls.at(-1).norm
    expect(namesAll(ins.slice(ins.indexOf('RETURNING')))).toBe(true)

    const dup = Object.assign(new Error('23505'), { code: '23505', constraint: 'uq_pantry_item_idempotency_key' })
    const replayed = mockSql([[{ id: PLACE, label: 'Pantry shelf', kind: 'pantry' }], dup, [itemDb()]])
    const again = await call(replayed, '/api/pantry/items', 'POST', BOUGHT())
    expect([again.status, again.body.replayed]).toEqual([200, true])
    expect(namesAll(replayed.calls.at(-1).norm)).toBe(true)
    expect([again.body.item.quantity_value, again.body.item.quantity_unit, again.body.item.source_kind, again.body.item.source_label])
      .toEqual([2.35, 'lb', 'store', 'Costco'])

    const patched = mockSql([[itemDb()]])
    expect((await call(patched, `/api/pantry/items/${ITEM}`, 'PATCH', { quantity_value: 1.5, quantity_unit: 'qt' })).status).toBe(200)
    const upd = patched.calls.at(-1).norm
    expect(namesAll(upd.slice(upd.indexOf('RETURNING')))).toBe(true)

    const listed = mockSql([[], [itemDb()]])
    const list = await call(listed, '/api/pantry', 'GET', null, { group: 'place' })
    expect(list.status).toBe(200)
    expect(namesAll(listed.calls.at(-1).norm)).toBe(true)
    expect(list.body.rows[0]).toMatchObject({ quantity_value: 2.35, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco', where_from: 'Costco', stock_mode: 'item', count_left: null })
  })

  it('projectItem and itemRow carry the four as stored; where_from is the planting first, else the source', () => {
    expect(projectItem(itemDb())).toMatchObject({ quantity_value: 2.35, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' })
    const row = itemRow(itemDb(), 'place', NOW)
    expect([row.quantity_value, row.quantity_unit, row.source_kind, row.source_label, row.where_from, row.from_garden]).toEqual([2.35, 'lb', 'store', 'Costco', 'Costco', false])
    const garden = itemRow(itemDb({ plant_id: PLANT, planting_name: 'Sungold cherry', source_kind: null, source_label: null }), 'place', NOW)
    expect([garden.where_from, garden.from_garden, garden.source_kind]).toEqual(['Sungold cherry', true, null])
  })
})

describe('row 6 — every value a chip can send is one the route takes', () => {
  const UNITS = [...ITEM_AMOUNT_UNITS, ...MORE_ITEM_AMOUNT_UNITS]
  const base = (extra) => itemBody({ key: KEY, what: { source: 'typed', name: 'Rice' }, place: { id: PLACE }, when: { date: '2026-10-01', precision: 'day' }, discard: { mode: 'auto' }, ...extra })

  it('the amount chips are these twenty stored units, a bag and a jar among them', () => {
    expect(ITEM_AMOUNT_UNITS.map(u => u.label)).toEqual(['lb', 'oz (weight)', 'count', 'bag', 'jar', 'qt'])
    expect(UNITS.map(u => u.value)).toEqual(['lb', 'oz', 'count', 'bag', 'jar', 'qt', 'pint', 'cup', 'fl oz', 'gal', 'g', 'kg', 'ml', 'l', 'bunch', 'head', 'peck', 'bushel', 'half-bushel', 'flat'])
  })

  it.each(UNITS.map(u => [u.value]))('the unit %s', (unit) => {
    const body = base({ amount: { value: '2', unit } })
    expect([body.quantity_value, body.quantity_unit]).toEqual([2, unit])
    expect(validateItemCreate(body)).toBeNull()
  })

  it('the where-from chips are the server\'s eight kinds, and each is taken', () => {
    const kinds = [...FIRST_SOURCE_KINDS, ...MORE_SOURCE_KINDS]
    expect(sorted(kinds)).toEqual(sorted(VALID_SOURCE_KINDS))
    for (const kind of kinds) {
      const body = base({ source: { kind, label: 'Warner Farms' } })
      expect(body.source_kind).toBe(kind)
      expect(`${kind} sends a name: ${'source_label' in body}`).toBe(`${kind} sends a name: ${kind !== 'own_garden'}`)
      expect(validateItemCreate(body)).toBeNull()
    }
  })

  it('Other with no name is refused by the door before the route would refuse it', () => {
    expect(whereFromError({ kind: 'other', label: '' })).not.toBeNull()
    expect(validateItemCreate(base({ source: { kind: 'other', label: '' } }))).toMatch(/'other' needs a name/)
  })
})

describe('the amount on the wire — a JSON number', () => {
  const amount = (value, unit) => itemBody({ key: KEY, what: { source: 'typed', name: 'Rice' }, place: { id: PLACE }, when: { date: '2026-10-01', precision: 'day' }, discard: { mode: 'auto' }, amount: { value, unit } })

  it('quantity_value is a number — the typed text read by parseAmount — and the route refuses the same digits as a string', () => {
    for (const text of ['2', '0.5', '0,5', '2.345', '12']) {
      const body = amount(text, 'lb')
      expect(typeof body.quantity_value).toBe('number')
      expect(body.quantity_value).toBe(parseAmount(text))
      expect(validateItemCreate(body)).toBeNull()
      expect(validateItemCreate({ ...body, quantity_value: String(body.quantity_value) })).toBe('the amount must be a number')
    }
  })

  it('half an amount, or none: BOTH keys are absent (the door refuses the half in place before a save)', () => {
    for (const [value, unit] of [['', null], ['2', null], ['', 'lb'], ['abc', 'lb'], ['0', 'lb'], [undefined, undefined]]) {
      expect(Object.keys(amount(value, unit)).filter(k => k.startsWith('quantity_'))).toEqual([])
    }
  })
})

describe('row 7 — As is with every put-up option set', () => {
  it('sends today\'s item keys for those answers plus only the new four that were set, and no put-up-only key', () => {
    const body = itemBody({
      key: KEY, what: { source: 'variety', name: 'San Marzano', crop_type_slug: 'tomato', variety_id: 'v-sm' },
      place: { id: PLACE, kind: 'pantry', label: 'Pantry shelf' }, when: { date: '2026-09-01', precision: 'month' },
      discard: { mode: 'none', date: '' }, notes: 'n', amount: { value: '2', unit: 'lb' }, source: { kind: 'gift', label: '' },
      // … and everything a put-up could hold, handed in as the door's state would hold it:
      method: 'hot_sauce', count: 3, size: { value: '1', unit: 'qt' }, isRaw: true, inOil: true, texture: 'bends', storageLocationId: PLACE,
    })
    expect(sorted(Object.keys(body))).toEqual(sorted([
      'idempotency_key', 'name', 'storage_location_id', 'acquired_at', 'acquired_precision', 'crop_type_slug', 'notes',
      'quantity_value', 'quantity_unit', 'source_kind',
    ]))
    for (const k of ['package_count', 'method', 'label', 'preserved_at', 'preserved_at_precision', 'preserved_at_approx', 'variety_id', 'is_raw', 'in_oil', 'texture']) {
      expect(Object.keys(body)).not.toContain(k)
    }
    expect([body.quantity_value, body.quantity_unit]).toEqual([2, 'lb'])      // the amount, never the size × the count
    expect(validateItemCreate(body)).toBeNull()
  })
})

describe('row 9 — a planting What sends no source', () => {
  it('whatever the where-from state held before the hit: plant_id, and neither source key', () => {
    for (const source of [null, { kind: 'own_garden', label: '' }, { kind: 'farm_stand', label: 'Warner Farms' }, { kind: 'other', label: 'a neighbour' }]) {
      const body = itemBody({ key: KEY, what: planting, place: { id: PLACE }, when: { date: '2026-10-01', precision: 'day' }, discard: { mode: 'auto' }, source })
      expect(body.plant_id).toBe(PLANT)
      expect(Object.keys(body).filter(k => k.startsWith('source_'))).toEqual([])
      expect(validateItemCreate(body)).toBeNull()
    }
  })

  it('and the route refuses what the door would have sent had it let a stale choice through', () => {
    expect(validateItemCreate({ ...FRESH(), source_kind: 'farm_stand' })).toBe(PLANTING_SOURCE_REFUSAL)
  })
})
