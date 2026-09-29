// Put-Up release 1b — PATCH /api/preservation/:id and POST /api/preservation/:id/move, EXECUTED against
// a mock driver (the kitchenRoutes.test.js idiom). What this proves: the date rules each route applies
// (the pure correctionUseBy / moveUseBy, then what the handler binds), the household predicate bound on
// every read, the optimistic xmin guard exactly where the write depends on what was read, and the audit
// grouping (set_config first in the same sql.transaction). What it cannot: that the SQL runs — that is
// the integration lane's, on a real Postgres with 1b applied.
import { describe, it, expect } from 'vitest'
import {
  handleJarRoute, parseJarRoute, validateJarPatch, validateMove, correctionUseBy, moveUseBy,
} from './jarRoutes.js'

const HOUSEHOLD = ['user_dave', 'user_jen']
const STRANGER = ['user_stranger']
const DAVE = 'user_dave'
const JAR = '99999999-1111-2222-3333-444444444444'
const PLACE = 'ffffffff-1111-2222-3333-444444444444'

function mockSql(queue = []) {
  const calls = []
  const fn = (strings, ...values) => {
    const text = strings.raw.join(' ? ')
    const call = { text, norm: text.replace(/\s+/g, ' ').trim(), values }
    calls.push(call)
    // A tagged call is lazy until awaited or batched, like the real driver.
    return { call, then: (ok, err) => run(call).then(ok, err) }
  }
  const run = (call) => {
    if (!queue.length) return Promise.reject(new Error(`unexpected extra query: ${call.norm.slice(0, 90)}`))
    return Promise.resolve(queue.shift())
  }
  fn.transaction = async (qs) => {
    fn.batches.push(qs.map((q) => q.call))
    const out = []
    for (const q of qs) out.push(await run(q.call))
    return out
  }
  fn.batches = []
  fn.calls = calls
  return fn
}

// A jar as loadJar reads it.
const stored = (over = {}) => ({
  id: JAR, method: 'hot_sauce', method_other_text: null, label: 'Megatron plain', is_raw: null, in_oil: null,
  texture: null, storage_location_id: PLACE, storage_kind: 'fridge', preserved_at: '2026-10-08',
  preserved_at_precision: 'day', use_by_target: '2027-04-08', use_by_basis: 'table', storage_moved_at: null,
  row_version: '4242', ...over,
})

const patch = (sql, body, householdIds = HOUSEHOLD) => handleJarRoute({
  sql, rawPath: `/api/preservation/${JAR}`, method: 'PATCH', rawBody: JSON.stringify(body), userId: DAVE, householdIds,
})
const move = (sql, body, householdIds = HOUSEHOLD) => handleJarRoute({
  sql, rawPath: `/api/preservation/${JAR}/move`, method: 'POST', rawBody: JSON.stringify(body), userId: DAVE, householdIds,
})

// The value bound right after a clause (the mock joins the template strings with ' ? ').
// Whitespace-collapsed, so a needle is about the clause and not the template's indentation.
const after = (call, needle) => {
  const n = needle.replace(/\s+/g, ' ')
  const at = call.norm.indexOf(n)
  expect(at, `SQL lacks ${n}`).toBeGreaterThan(-1)
  return call.values[(call.norm.slice(0, at + n.length).match(/\?/g) ?? []).length]
}

describe('routing', () => {
  it('claims only a uuid id, and /move under it', () => {
    expect(parseJarRoute(`/api/preservation/${JAR}`)).toEqual({ id: JAR, sub: null })
    expect(parseJarRoute(`/api/preservation/${JAR}/move`)).toEqual({ id: JAR, sub: 'move' })
    expect(parseJarRoute('/api/preservation/whats-put-up')).toBeNull()
    expect(parseJarRoute('/api/preservation/use-soon')).toBeNull()
    expect(parseJarRoute(`/api/preservation/${JAR}/sources`)).toBeNull()
    expect(parseJarRoute('/api/preservation')).toBeNull()
  })

  it.each(['GET', 'PUT', 'DELETE'])('%s on /:id falls through to index.js (null), touching nothing', async (m) => {
    const sql = mockSql()
    expect(await handleJarRoute({ sql, rawPath: `/api/preservation/${JAR}`, method: m, rawBody: '{}', userId: DAVE, householdIds: HOUSEHOLD })).toBeNull()
    expect(sql.calls).toHaveLength(0)
  })
})

describe('the correction rule (V4 "What changes a date after it is written")', () => {
  const next = (over) => ({ method: 'hot_sauce', is_raw: null, in_oil: null, texture: null, ...over })

  it('a table date re-derives from the stored anchor at the same place', () => {
    expect(correctionUseBy(stored(), next({ method: 'ferment_mash' }))).toEqual({ use_by_target: '2027-04-08', use_by_basis: 'table' })
    expect(correctionUseBy(stored(), next({ is_raw: true }))).toEqual({ use_by_target: null, use_by_basis: 'none' })
  })
  it('a "none" date re-derives too (a correction can give a date back)', () => {
    const s = stored({ method: 'dehydrate', texture: 'bends', storage_kind: 'pantry', use_by_target: null, use_by_basis: 'none' })
    expect(correctionUseBy(s, next({ method: 'dehydrate', texture: 'snaps' }))).toEqual({ use_by_target: '2027-02-08', use_by_basis: 'table' })
  })
  it('a moved jar nulls instead of re-deriving', () => {
    expect(correctionUseBy(stored({ storage_moved_at: '2026-11-01T00:00:00Z' }), next({ method: 'ferment_mash' })))
      .toEqual({ use_by_target: null, use_by_basis: 'none' })
  })
  it.each(['typed', 'recipe', null])('a %s date survives a correction', (basis) => {
    expect(correctionUseBy(stored({ use_by_basis: basis }), next({ is_raw: true }))).toBeNull()
  })
  it('"clear" on a typed date resolves from the anchor', () => {
    expect(correctionUseBy(stored({ use_by_basis: 'typed', use_by_target: '2026-12-25' }), next({}), { clearing: true }))
      .toEqual({ use_by_target: '2027-04-08', use_by_basis: 'table' })
  })
  it('an unknown put-up date re-derives to no date', () => {
    expect(correctionUseBy(stored({ preserved_at_precision: 'unknown' }), next({ method: 'ferment_mash' })))
      .toEqual({ use_by_target: null, use_by_basis: 'none' })
  })
})

describe('the move rule', () => {
  it('a change of kind nulls a table date and stamps the move', () => {
    expect(moveUseBy(stored(), 'deep_freezer', '2026-11-01')).toEqual({ kindChanged: true, useBy: { use_by_target: null, use_by_basis: 'none' } })
  })
  it('recipe and none null too; typed and a NULL (pre-backfill) basis survive', () => {
    expect(moveUseBy(stored({ use_by_basis: 'recipe' }), 'pantry', '2026-11-01').useBy).toEqual({ use_by_target: null, use_by_basis: 'none' })
    expect(moveUseBy(stored({ use_by_basis: 'typed' }), 'pantry', '2026-11-01')).toEqual({ kindChanged: true, useBy: null })
    expect(moveUseBy(stored({ use_by_basis: null }), 'pantry', '2026-11-01')).toEqual({ kindChanged: true, useBy: null })
  })
  it('candy (house) re-derives from the MOVE date with the destination leg', () => {
    const candy = stored({ method: 'candy', storage_kind: 'deep_freezer', use_by_basis: 'house' })
    expect(moveUseBy(candy, 'pantry', '2026-11-01').useBy).toEqual({ use_by_target: '2026-12-01', use_by_basis: 'house' })
  })
  it('a move within one kind changes no date and is not a change of kind', () => {
    expect(moveUseBy(stored(), 'fridge', '2026-11-01')).toEqual({ kindChanged: false, useBy: null })
  })
  it('no recorded place → any place is a change of kind', () => {
    expect(moveUseBy(stored({ storage_kind: null }), 'fridge', '2026-11-01').kindChanged).toBe(true)
  })
})

describe('PATCH — validation', () => {
  it.each([
    [{ storage_location_id: PLACE }, /cannot be edited here: storage_location_id/],
    [{ remaining_count: 1 }, /cannot be edited here: remaining_count/],
    [{}, /nothing to update/],
    [{ method_other_text: 'x' }, /travels with method/],
    [{ discard_by: 'someday' }, /discard_by must be/],
    [{ quantity_value: 2 }, /edited together/],
    [{ quantity_value: 2, quantity_unit: 'gallons' }, /quantity_unit must be one of/],
    [{ ph_read_at: '2026-10-08T10:00:00Z' }, /travels with ph_reading/],
    [{ ph_reading: '15' }, /pH scale/],
    [{ notes: 'a', notes_append: 'b' }, /not both/],
    [{ label: ' ' }, /cannot be blank/],
    [{ is_raw: 'yes' }, /true or false/],
  ])('%o → 400', (body, want) => expect(validateJarPatch(body)).toMatch(want))

  it.each([
    [{ discard_by: '2027-01-15' }], [{ discard_by: 'none' }], [{ discard_by: 'clear' }],
    [{ quantity_value: 2.5, quantity_unit: 'qt' }], [{ quantity_value: null, quantity_unit: null }],
    [{ ph_reading: '3.70' }], [{ label: null }], [{ method: 'other', method_other_text: 'Drinking vinegar' }],
  ])('%o is accepted', (body) => expect(validateJarPatch(body)).toBeNull())
})

describe('PATCH — what it sends', () => {
  it('reads the jar household-scoped; a stranger gets 404 and nothing is written', async () => {
    const sql = mockSql([[]])
    const res = await patch(sql, { label: 'x' }, STRANGER)
    expect(res).toEqual({ status: 404, body: { error: 'Not found', code: 'not_found' } })
    expect(sql.calls[0].norm).toMatch(/WHERE p\.id = \? ::uuid AND p\.user_id = ANY\( \? \) AND p\.deleted_at IS NULL/)
    expect(sql.calls[0].values[1]).toEqual(STRANGER)
    expect(sql.batches).toHaveLength(0)
  })

  it('the write and the actor GUC share one transaction, the GUC first', async () => {
    const sql = mockSql([[stored()], [], [{ ...stored(), label: 'x' }]])
    await patch(sql, { label: 'x' })
    expect(sql.batches).toHaveLength(1)
    expect(sql.batches[0][0].norm).toBe("SELECT set_config('app.actor_clerk_sub', ? , true)")
    expect(sql.batches[0][0].values).toEqual([DAVE])
    expect(sql.batches[0][1].norm).toMatch(/^UPDATE preservation_log SET/)
  })

  it('a name-only edit is UNGUARDED (a concurrent Mark used cannot fail it) and moves no date', async () => {
    const sql = mockSql([[stored()], [], [{ ...stored(), label: 'x' }]])
    const res = await patch(sql, { label: 'x' })
    expect(res.status).toBe(200)
    const w = sql.batches[0][1]
    expect(after(w, 'AND (NOT')).toBe(false)
    expect(after(w, 'use_by_target     = CASE WHEN')).toBe(false)
    expect(after(w, 'method            = CASE WHEN')).toBe(false)
    expect(after(w, 'texture           = CASE WHEN')).toBe(false)
  })

  it('a correction is GUARDED on the xmin it read, and binds the re-derived date and basis', async () => {
    const sql = mockSql([[stored()], [], [{ ...stored(), is_raw: true }]])
    await patch(sql, { is_raw: true })
    const w = sql.batches[0][1]
    expect(after(w, 'AND (NOT')).toBe(true)
    expect(after(w, 'xmin =')).toBe('4242')
    expect(after(w, 'use_by_target     = CASE WHEN')).toBe(true)
    expect(after(w, 'use_by_target     = CASE WHEN ? ::boolean THEN')).toBeNull()
    expect(after(w, 'use_by_basis      = CASE WHEN ? ::boolean THEN')).toBe('none')
  })

  it('a guarded write that matches no row → 409 client_stale (the jar changed after the read)', async () => {
    const sql = mockSql([[stored()], [], []])
    const res = await patch(sql, { method: 'ferment_mash' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('client_stale')
  })

  it('discard_by: a date and "none" are typed; the date binds as sent', async () => {
    let sql = mockSql([[stored()], [], [stored()]])
    await patch(sql, { discard_by: '2027-01-15' })
    expect(after(sql.batches[0][1], 'use_by_target     = CASE WHEN ? ::boolean THEN')).toBe('2027-01-15')
    expect(after(sql.batches[0][1], 'use_by_basis      = CASE WHEN ? ::boolean THEN')).toBe('typed')
    sql = mockSql([[stored()], [], [stored()]])
    await patch(sql, { discard_by: 'none' })
    expect(after(sql.batches[0][1], 'use_by_target     = CASE WHEN ? ::boolean THEN')).toBeNull()
    expect(after(sql.batches[0][1], 'use_by_basis      = CASE WHEN ? ::boolean THEN')).toBe('typed')
  })

  it('a method corrected away from dried clears the texture it no longer has; a texture SENT with it is refused', async () => {
    const dried = stored({ method: 'dehydrate', texture: 'snaps', storage_kind: 'pantry' })
    const sql = mockSql([[dried], [], [dried]])
    await patch(sql, { method: 'powder' })
    expect(after(sql.batches[0][1], 'texture           = CASE WHEN')).toBe(false) // powder keeps texture
    const sql2 = mockSql([[dried], [], [dried]])
    await patch(sql2, { method: 'hot_sauce' })
    expect(after(sql2.batches[0][1], 'texture           = CASE WHEN')).toBe(true)
    expect(after(sql2.batches[0][1], 'texture           = CASE WHEN ? ::boolean THEN')).toBeNull()
    const sql3 = mockSql([[dried]])
    expect((await patch(sql3, { method: 'hot_sauce', texture: 'bends' })).status).toBe(400)
  })

  it('notes_append appends on its own line; the quantity pair normalises a plural unit', async () => {
    const sql = mockSql([[stored()], [], [stored()]])
    await patch(sql, { notes_append: '  added 2 more  ' })
    expect(sql.batches[0][1].text).toMatch(/concat_ws\(E'\\\\n', NULLIF\(btrim\(notes\), ''\),/)
    expect(sql.batches[0][1].values).toContain('added 2 more')
    const sql2 = mockSql([[stored()], [], [stored()]])
    await patch(sql2, { quantity_value: 2.5, quantity_unit: 'quarts' })
    expect(after(sql2.batches[0][1], "quantity_unit     = CASE WHEN ? ::boolean THEN")).toBe('qt')
  })
})

describe('Move — what it sends', () => {
  it('validation', () => {
    expect(validateMove({})).toMatch(/place must be/)
    expect(validateMove({ place: { kind: 'garage', label: 'x' } })).toMatch(/place\.kind must be one of/)
    expect(validateMove({ place: { kind: 'fridge', label: '  ' } })).toMatch(/needs a name/)
    expect(validateMove({ place: { id: 'nope' } })).toMatch(/uuid/)
    expect(validateMove({ place: { id: PLACE }, when: '2026-13-01' })).toMatch(/when must be/)
    expect(validateMove({ place: { kind: 'fridge', label: 'Fridge' }, when: { date: '2026-11-01' } })).toBeNull()
  })

  it('a foreign place id → 400, nothing written', async () => {
    const sql = mockSql([[stored()], []])
    const res = await move(sql, { place: { id: PLACE } })
    expect(res.status).toBe(400)
    expect(sql.calls[1].norm).toMatch(/AND user_id = ANY\( \? \) AND deleted_at IS NULL/)
    expect(sql.batches).toHaveLength(0)
  })

  it('a new place: found household-first by trimmed, case-folded name, else created — in the SAME statement', async () => {
    const sql = mockSql([[stored()], [], [{ ...stored(), storage_location_id: 'new' }]])
    const res = await move(sql, { place: { kind: 'deep_freezer', label: '  Chest Freezer 2 ' }, when: '2026-11-01' })
    expect(res.status).toBe(200)
    const w = sql.batches[0][1]
    expect(w.norm).toMatch(/lower\(btrim\(label\)\) = lower\( \? ::text\)/)
    expect(w.norm).toMatch(/ON CONFLICT \(user_id, kind, lower\(label\)\) WHERE deleted_at IS NULL DO UPDATE SET label = storage_location\.label/)
    expect(w.values).toContain('Chest Freezer 2')
    expect(w.norm.indexOf('INSERT INTO storage_location')).toBeLessThan(w.norm.indexOf('UPDATE preservation_log SET'))
  })

  it('fridge → deep freezer: kind changed, the table date nulls, the move is stamped with its When, guarded on xmin', async () => {
    const sql = mockSql([[stored()], [], [stored()]])
    await move(sql, { place: { kind: 'deep_freezer', label: 'Chest Freezer 1' }, when: '2026-11-01' })
    const w = sql.batches[0][1]
    expect(after(w, 'storage_moved_at    = CASE WHEN')).toBe(true)
    expect(after(w, 'COALESCE(')).toBe('2026-11-01')
    expect(after(w, 'use_by_basis        = CASE WHEN ? ::boolean THEN')).toBe('none')
    expect(after(w, 'xmin =')).toBe('4242')
  })

  it('a stale read (xmin moved) → 409 client_stale, and the place insert is gated on the same xmin', async () => {
    const sql = mockSql([[stored()], [], []])
    const res = await move(sql, { place: { kind: 'deep_freezer', label: 'Chest Freezer 1' } })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('client_stale')
    const w = sql.batches[0][1].norm
    const made = w.slice(w.indexOf('INSERT INTO storage_location'), w.indexOf('ON CONFLICT'))
    expect(made).toMatch(/j\.xmin = \? ::text::xid/)
  })
})
