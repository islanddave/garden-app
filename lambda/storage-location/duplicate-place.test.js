// Put-Up release 1a — a duplicate place gets an answer, not a 500 (V4: "the shipped place-create
// against the new storage_location UNIQUE (its 23505 answer)").
//
// Release 1b adds UNIQUE (user_id, kind, lower(label)) WHERE deleted_at IS NULL, and this handler is
// the writer deployed when it arms. No database carries that index yet, so the 23505 is SIMULATED
// here: the stub raises it from the INSERT / UPDATE exactly as the driver would surface Postgres'
// unique_violation (err.code '23505'). The lookups the handler then runs were also executed against
// the real index on PG 17 (this commit's message).
//
// Executes the real handler (lambda/storage-location/index.js under the vitest stubs).
import { describe, it, expect, beforeEach } from 'vitest'
import { stubState, resetStubs } from '../_test-stubs/state.js'

const { handler } = await import('./index.js')

const DAVE = 'user_stub_dave'
const PLACE = '7b2e9f10-1c3d-4e5f-8a9b-0c1d2e3f4a5b'
const OTHER = '1f0e9d8c-7b6a-4c5d-9e4f-3a2b1c0d9e8f'
const EXISTING = {
  id: OTHER, user_id: DAVE, label: 'Kitchen Fridge', kind: 'fridge',
  created_at: new Date('2026-09-01T14:00:00.000Z'), deleted_at: null,
}

const post = (body) => ({
  requestContext: { http: { method: 'POST' } }, rawPath: '/api/storage-locations',
  headers: { authorization: 'Bearer stub-token' }, body: JSON.stringify(body),
})
const putReq = (body, id = PLACE) => ({
  requestContext: { http: { method: 'PUT' } }, rawPath: `/api/storage-locations/${id}`,
  headers: { authorization: 'Bearer stub-token' }, body: JSON.stringify(body),
})
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') })
const pgError = (code, message = 'duplicate key value violates unique constraint') =>
  Object.assign(new Error(message), { code, constraint: 'uq_storage_location_user_kind_label' })

// The value bound to ONE named placeholder (the stub joins the template strings with '?').
const boundAfter = (call, re) => {
  const m = call.text.match(re)
  expect(m, `SQL does not match ${re}`).toBeTruthy()
  const end = m.index + m[0].length
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?')
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length]
}
const flat = (t) => t.replace(/\s+/g, ' ')

beforeEach(() => {
  resetStubs()
  stubState.verifyTokenResult = { sub: DAVE }
})

describe('POST — a duplicate create is a find: the existing place comes back', () => {
  const wire = ({ found = [EXISTING], insertError = pgError('23505') } = {}) => {
    stubState.sqlHandler = (text) => {
      if (/INSERT INTO storage_location/.test(text)) throw insertError
      if (/FROM storage_location/.test(text)) return found
      return []
    }
  }

  it('23505 on the insert → 200, the caller\'s live place, flagged existing', async () => {
    wire()
    const res = parse(await handler(post({ label: '  kitchen fridge ', kind: 'fridge' })))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ...JSON.parse(JSON.stringify(EXISTING)), existing: true })
  })

  it('looks up exactly the unique key it collided on: this caller, this kind, the trimmed name in any case, live', async () => {
    wire()
    await handler(post({ label: '  kitchen fridge ', kind: 'fridge' }))
    const find = stubState.sqlCalls.find((c) => /^\s*SELECT/.test(c.text))
    expect(find, 'no lookup after the duplicate').toBeTruthy()
    const sql = flat(find.text)
    expect(sql).toMatch(/FROM storage_location WHERE user_id = \? AND kind = \? AND lower\(label\) = lower\(\?\) AND deleted_at IS NULL/)
    expect(boundAfter(find, /WHERE user_id = /)).toBe(DAVE)
    expect(boundAfter(find, /AND kind = /)).toBe('fridge')
    expect(boundAfter(find, /lower\(label\) = lower\(/)).toBe('kitchen fridge')
    // The insert and the lookup agree on the name: both got the trimmed text.
    const insert = stubState.sqlCalls.find((c) => /INSERT INTO storage_location/.test(c.text))
    expect(insert.values).toEqual([DAVE, 'kitchen fridge', 'fridge'])
  })

  it('a duplicate whose row cannot be found → a coded 409 place_exists in plain words, not a 500', async () => {
    wire({ found: [] })
    const res = parse(await handler(post({ label: 'Kitchen Fridge', kind: 'fridge' })))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('place_exists')
    expect(res.body.message).toBe('You already have a place with that name. Pick it instead, or use a different name.')
    expect(res.body.error).toBe(res.body.message)
  })

  it('every other failure keeps its old answer: a CHECK is a 400, anything unknown a 500', async () => {
    wire({ insertError: pgError('23514', 'violates check constraint') })
    expect(parse(await handler(post({ label: 'Shelf', kind: 'pantry' }))).status).toBe(400)
    wire({ insertError: pgError('XX000', 'internal') })
    expect(parse(await handler(post({ label: 'Shelf', kind: 'pantry' }))).status).toBe(500)
  })

  it('a fresh name still creates: 201, one statement, no lookup', async () => {
    stubState.sqlHandler = () => [{ ...EXISTING, id: PLACE, label: 'Shelf', kind: 'pantry' }]
    const res = parse(await handler(post({ label: 'Shelf', kind: 'pantry' })))
    expect(res.status).toBe(201)
    expect(res.body).not.toHaveProperty('existing')
    expect(stubState.sqlCalls).toHaveLength(1)
  })
})

describe('PUT — a rename or re-kind onto a name the owner already uses is refused, naming the place', () => {
  const wire = ({ clash = [{ id: OTHER }], updateError = pgError('23505') } = {}) => {
    stubState.sqlHandler = (text) => {
      if (/UPDATE storage_location/.test(text)) throw updateError
      if (/FROM storage_location t/.test(text)) return clash
      return []
    }
  }

  it('23505 on the update → 409 place_exists carrying the existing place\'s id', async () => {
    wire()
    const res = parse(await handler(putReq({ label: 'Kitchen Fridge', kind: 'fridge' })))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      code: 'place_exists', existing_id: OTHER,
      message: 'You already have a place with that name. Pick it instead, or use a different name.',
      error: 'You already have a place with that name. Pick it instead, or use a different name.',
    })
  })

  it('finds the clash among the SAME OWNER\'s other live places, under the name and kind the update would write', async () => {
    wire()
    await handler(putReq({ label: 'Kitchen Fridge' }))   // a rename that keeps the kind
    const find = stubState.sqlCalls.find((c) => /FROM storage_location t/.test(c.text))
    const sql = flat(find.text)
    expect(sql).toMatch(/JOIN storage_location o ON o\.user_id = t\.user_id AND o\.id <> t\.id AND o\.deleted_at IS NULL AND o\.kind = COALESCE\(\?, t\.kind\) AND lower\(o\.label\) = lower\(COALESCE\(\?, t\.label\)\)/)
    expect(sql).toMatch(/WHERE t\.id = \? AND t\.user_id = ANY\(\?\) AND t\.deleted_at IS NULL/)
    expect(boundAfter(find, /o\.kind = COALESCE\(/)).toBeNull()
    expect(boundAfter(find, /lower\(COALESCE\(/)).toBe('Kitchen Fridge')
    expect(boundAfter(find, /WHERE t\.id = /)).toBe(PLACE)
    expect(boundAfter(find, /t\.user_id = ANY\(/)).toEqual([DAVE])
  })

  // Put-Up release 1b (05 §6a): the PUT trims as the POST does, in the SET and in the clash lookup.
  // Mutation: bind body.label raw again — both bindings below read ' Kitchen Fridge  '.
  it('a rename is trimmed — in the write and in the clash lookup alike', async () => {
    wire()
    await handler(putReq({ label: ' Kitchen Fridge  ' }))
    const update = stubState.sqlCalls.find((c) => /UPDATE storage_location/.test(c.text))
    expect(boundAfter(update, /label = COALESCE\(/)).toBe('Kitchen Fridge')
    const find = stubState.sqlCalls.find((c) => /FROM storage_location t/.test(c.text))
    expect(boundAfter(find, /lower\(COALESCE\(/)).toBe('Kitchen Fridge')
  })

  it('a clash it cannot locate still answers 409 place_exists (existing_id null), never a 500', async () => {
    wire({ clash: [] })
    const res = parse(await handler(putReq({ label: 'Kitchen Fridge' })))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'place_exists', existing_id: null })
  })

  it('every other failure keeps its old answer, and an ordinary edit is unchanged', async () => {
    wire({ updateError: pgError('23514', 'violates check constraint') })
    expect(parse(await handler(putReq({ kind: 'fridge' }))).status).toBe(400)
    stubState.sqlCalls = []
    stubState.sqlHandler = () => [{ ...EXISTING, id: PLACE, label: 'Garage freezer' }]
    const ok = parse(await handler(putReq({ label: 'Garage freezer' })))
    expect(ok.status).toBe(200)
    expect(stubState.sqlCalls).toHaveLength(1)
    stubState.sqlHandler = () => []
    expect(parse(await handler(putReq({ label: 'Garage freezer' }))).status).toBe(404)
  })
})
