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
import { VALID_SOURCE_KINDS } from './provenance.js'

const HOUSEHOLD = ['user_dave', 'user_jen']
const STRANGER = ['user_stranger']
const DAVE = 'user_dave'
const JAR = '99999999-1111-2222-3333-444444444444'
const PLACE = 'ffffffff-1111-2222-3333-444444444444'
const PLANT = 'dddddddd-1111-2222-3333-444444444444'
const PICK = 'eeeeeeee-1111-2222-3333-444444444444'
// The Put-Up words rule (brief-common-r2 "Words"): none of these on a surface a person reads.
const BANNED = ['safe', 'shelf life', 'shelf-stable', 'keeps', 'good', 'ready', 'done', 'expired', 'table', 'default', 'basis']

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

// Put-Up UX pass R1. Until then a clear asked the engine only, so a fridge jar from a "Fridge · 7 days"
// recipe came back with the general six months. The order is pinned here, rung by rung: moved (no date),
// then the recipe when its place kind is the jar's, then the engine, then none. MUTATIONS: skip the recipe
// in the clearing path → "clear at a matching place gives the recipe date" reds; ask the recipe before the
// moved check → "a moved jar, cleared, has no date" reds.
describe('clearing a typed date resolves by the whole ladder: moved, then the recipe, then the engine', () => {
  const next = (over) => ({ method: 'hot_sauce', is_raw: null, in_oil: null, texture: null, ...over })
  const typed = (over = {}) => stored({ use_by_basis: 'typed', use_by_target: '2026-12-25', ...over })
  // A recipe's "how long, and where" line, as patchJar's read hands it over.
  const FRIDGE_7 = { keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge' }
  const clear = (jar, recipe, n = next({})) => correctionUseBy(jar, n, { clearing: true, recipe })
  const RECIPE_DATE = { use_by_target: '2026-10-15', use_by_basis: 'recipe' }   // put up 2026-10-08, + 7 days
  const ENGINE_DATE = { use_by_target: '2027-04-08', use_by_basis: 'table' }    // hot sauce, fridge: 6 months
  const NO_DATE = { use_by_target: null, use_by_basis: 'none' }

  it('clear at a matching place gives the recipe date', () => {
    expect(clear(typed(), FRIDGE_7)).toEqual(RECIPE_DATE)
    expect(clear(typed(), { ...FRIDGE_7, keeps_n: 2, keeps_unit: 'week' })).toEqual({ use_by_target: '2026-10-22', use_by_basis: 'recipe' })
    expect(clear(typed(), { ...FRIDGE_7, keeps_n: 3, keeps_unit: 'month' })).toEqual({ use_by_target: '2027-01-08', use_by_basis: 'recipe' })
  })

  it('clear where the recipe names another kind of place falls to the engine', () => {
    expect(clear(typed(), { ...FRIDGE_7, keeps_storage_kind: 'deep_freezer' })).toEqual(ENGINE_DATE)
    // The jar on a pantry shelf: the fridge recipe says nothing about it, and the engine's shelf figure is 12 months.
    expect(clear(typed({ storage_kind: 'pantry' }), FRIDGE_7)).toEqual({ use_by_target: '2027-10-08', use_by_basis: 'table' })
    expect(clear(typed({ storage_kind: null }), FRIDGE_7)).toEqual(ENGINE_DATE)   // no recorded place: the engine's default
  })

  it('clear with no recipe (a jar with no batch, a batch with none, a removed one) is the engine, as before', () => {
    expect(clear(typed(), null)).toEqual(ENGINE_DATE)
    expect(correctionUseBy(typed(), next({}), { clearing: true })).toEqual(ENGINE_DATE)
    // A recipe that has no "how long, and where" line decides nothing.
    expect(clear(typed(), { keeps_n: null, keeps_unit: null, keeps_storage_kind: null })).toEqual(ENGINE_DATE)
  })

  it('clear where the recipe matches and the engine has no figure for the method gives the recipe date', () => {
    const pesto = typed({ method: 'pesto' })
    expect(clear(pesto, null, next({ method: 'pesto' }))).toEqual(NO_DATE)   // the engine alone: pesto has no fridge figure
    expect(clear(pesto, FRIDGE_7, next({ method: 'pesto' }))).toEqual(RECIPE_DATE)
  })

  it('clear where neither rung answers is no date', () => {
    expect(clear(typed({ method: 'pesto' }), { ...FRIDGE_7, keeps_storage_kind: 'pantry' }, next({ method: 'pesto' }))).toEqual(NO_DATE)
  })

  it('a moved jar, cleared, has no date', () => {
    const moved = typed({ storage_moved_at: '2026-11-01T00:00:00Z' })
    // The recipe would answer for these very facts (same place kind, a known day); the move outranks it.
    expect(clear(typed(), FRIDGE_7)).toEqual(RECIPE_DATE)
    expect(clear(moved, FRIDGE_7)).toEqual(NO_DATE)
    expect(clear(moved, null)).toEqual(NO_DATE)
  })

  it('clear on a put-up date that is "not sure" has no recipe date, and no engine date either', () => {
    expect(clear(typed({ preserved_at_precision: 'unknown' }), FRIDGE_7)).toEqual(NO_DATE)
  })

  it('clear on a jar the recipe already dated gives the same recipe date', () => {
    const dated = stored({ use_by_basis: 'recipe', use_by_target: '2026-10-15' })
    expect(clear(dated, FRIDGE_7)).toEqual(RECIPE_DATE)
    expect(clear(dated, null)).toEqual(ENGINE_DATE)   // its recipe since removed: the engine
  })

  it('clear on a general or a house date resolves by the same ladder (the stored basis is not read)', () => {
    expect(clear(stored(), FRIDGE_7)).toEqual(RECIPE_DATE)
    const candy = stored({ method: 'candy', use_by_basis: 'house', use_by_target: '2026-11-08' })
    expect(clear(candy, null, next({ method: 'candy' }))).toEqual({ use_by_target: '2026-11-08', use_by_basis: 'house' })
    expect(clear(candy, FRIDGE_7, next({ method: 'candy' }))).toEqual(RECIPE_DATE)
  })

  it('a Raw jar in a fridge on a recipe batch: clear gives the recipe date, as Put it up gives it at create', () => {
    const raw = typed({ is_raw: true })
    expect(clear(raw, null, next({ is_raw: true }))).toEqual(NO_DATE)   // the engine alone: Raw outside a freezer
    expect(clear(raw, FRIDGE_7, next({ is_raw: true }))).toEqual(RECIPE_DATE)
  })

  it('a correction that is not a clear never consults the recipe', () => {
    expect(correctionUseBy(stored({ use_by_basis: 'recipe', use_by_target: '2026-10-15' }), next({ is_raw: true }), { recipe: FRIDGE_7 })).toBeNull()
    expect(correctionUseBy(stored(), next({ method: 'ferment_mash' }), { recipe: FRIDGE_7 })).toEqual(ENGINE_DATE)
    expect(correctionUseBy(typed(), next({ is_raw: true }), { recipe: FRIDGE_7 })).toBeNull()
  })

  it('the recipe counts from the stored calendar day when the driver hands the date over as a Date', () => {
    // The neon driver parses a DATE column into a Date at local midnight; dayOf reads it back with the local getters.
    expect(clear(typed({ preserved_at: new Date(2026, 9, 8) }), FRIDGE_7)).toEqual(RECIPE_DATE)
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
    [{ method_other_text: ' ' }, /cannot be blank/],
    [{ method_other_text: 'x'.repeat(121) }, /at most 120/],
    [{ package_count: 0 }, /package_count must be >= 1/],
    [{ discard_by: 'someday' }, /discard_by must be/],
    [{ quantity_value: 2 }, /edited together/],
    [{ quantity_value: 2, quantity_unit: 'gallons' }, /quantity_unit must be one of/],
    [{ ph_read_at: '2026-10-08T10:00:00Z' }, /travels with ph_reading/],
    [{ ph_reading: '15' }, /pH scale/],
    [{ notes: 'a', notes_append: 'b' }, /not both/],
    [{ label: ' ' }, /cannot be blank/],
    [{ is_raw: 'yes' }, /true or false/],
    // R2a: where it's from is a PAIR, always both, judged by provenance.js's rules.
    [{ source_kind: 'store' }, /source_kind and source_label are edited together/],
    [{ source_label: 'Kroger' }, /source_kind and source_label are edited together/],
    [{ source_kind: 'swap', source_label: null }, /source_kind must be one of/],
    [{ source_kind: 'other', source_label: null }, /source_label is required when source_kind is 'other'/],
    [{ source_kind: 'other', source_label: '  ' }, /source_label is required when source_kind is 'other'/],
    [{ source_kind: null, source_label: 'Kroger' }, /source_label needs a source_kind/],
    [{ source_kind: 'store', source_label: 'x'.repeat(121) }, /120 characters or fewer/],
  ])('%o → 400', (body, want) => expect(validateJarPatch(body)).toMatch(want))

  it.each([
    [{ discard_by: '2027-01-15' }], [{ discard_by: 'none' }], [{ discard_by: 'clear' }],
    [{ quantity_value: 2.5, quantity_unit: 'qt' }], [{ quantity_value: null, quantity_unit: null }],
    [{ ph_reading: '3.70' }], [{ label: null }], [{ method: 'other', method_other_text: 'Drinking vinegar' }],
    [{ method_other_text: 'Drinking vinegar' }], [{ package_count: 3, quantity_value: 7.5, quantity_unit: 'qt' }],
    // R2a: the pair. `null, null` un-chooses; a kind with no name is fine for every kind but Other.
    [{ source_kind: 'store', source_label: 'Kroger' }], [{ source_kind: 'own_garden', source_label: null }],
    [{ source_kind: null, source_label: null }], [{ source_kind: 'gift', source_label: null }],
    [{ source_kind: 'other', source_label: 'Aunt May' }], [{ source_kind: 'store', source_label: 'x'.repeat(120) }],
  ])('%o is accepted', (body) => expect(validateJarPatch(body)).toBeNull())

  // The pair's own check is handed the pair ALONE. A body's plant_id is not a PATCH key (refused above),
  // so the planting rule can only ever be judged against the stored row: patchJar's job, below.
  it('a planting sent in the body is an unknown key, never an input to the where-from rule', () => {
    expect(validateJarPatch({ source_kind: 'store', source_label: 'Kroger', plant_id: PLACE }))
      .toMatch(/cannot be edited here: plant_id/)
    expect(validateJarPatch({ source_kind: 'store', source_label: 'Kroger', harvest_log_id: PLACE }))
      .toMatch(/cannot be edited here: harvest_log_id/)
  })

  it('every where-from kind the server knows is accepted with a name', () => {
    for (const kind of VALID_SOURCE_KINDS) {
      expect(validateJarPatch({ source_kind: kind, source_label: 'somewhere' }), kind).toBeNull()
    }
  })

  // Server sentences are user copy: a cached bundle prints them as they are (R2 brief, "Words").
  it('the pair\'s own sentence has none of the banned words', () => {
    const words = validateJarPatch({ source_kind: 'store' })
    for (const w of BANNED) expect(words.toLowerCase(), w).not.toMatch(new RegExp(`\\b${w}\\b`))
  })
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

// Put-Up R2a (contract 4, amendment C1): where it's from, corrected in Edit. The pair is judged against the
// STORED planting and harvest link (a PATCH body carries neither), by provenance.js's rules. MUTATIONS:
// judge against the body's planting instead of the stored one → "a planting-linked jar" reds (the write
// goes out); write body.source_label as sent → "our garden writes no name" reds; drop the pair from the
// guard → "a non-garden source is GUARDED" reds.
describe('PATCH — where it\'s from (R2a): the pair, judged against the STORED planting and harvest link', () => {
  const KIND = 'source_kind       = CASE WHEN ? ::boolean THEN'
  const LABEL = 'source_label      = CASE WHEN ? ::boolean THEN'
  const sent = (w) => [after(w, 'source_kind       = CASE WHEN'), after(w, KIND), after(w, LABEL)]

  it('the jar read carries the planting, the harvest link and the stored pair', async () => {
    const sql = mockSql([[stored()], [], [stored()]])
    await patch(sql, { source_kind: 'store', source_label: 'Kroger' })
    expect(sql.calls[0].norm).toContain('p.plant_id, p.harvest_log_id, p.source_kind, p.source_label,')
  })

  it('a planting-linked jar + a non-garden source → 400 in the validator\'s words, nothing written', async () => {
    const sql = mockSql([[stored({ plant_id: PLANT })]])
    const res = await patch(sql, { source_kind: 'store', source_label: 'Kroger' })
    expect(res).toEqual({ status: 400, body: { error: 'clear the planting before recording a non-garden source' } })
    expect(sql.calls).toHaveLength(1)
    expect(sql.batches).toHaveLength(0)
  })

  it('a harvest-linked jar + a non-garden source → 400 in the validator\'s words, nothing written', async () => {
    const sql = mockSql([[stored({ harvest_log_id: PICK })]])
    const res = await patch(sql, { source_kind: 'farm_stand', source_label: null })
    expect(res).toEqual({ status: 400, body: { error: 'clear the harvest link before recording a non-garden source' } })
    expect(sql.batches).toHaveLength(0)
  })

  it.each(VALID_SOURCE_KINDS.filter((k) => k !== 'own_garden'))('%s is refused on a planting-linked jar', async (kind) => {
    const sql = mockSql([[stored({ plant_id: PLANT })]])
    expect((await patch(sql, { source_kind: kind, source_label: 'somewhere' })).status).toBe(400)
    expect(sql.batches).toHaveLength(0)
  })

  it('our garden on a planting-linked jar saves, and writes no name whatever was sent or stored', async () => {
    const linked = stored({ plant_id: PLANT, harvest_log_id: PICK, source_kind: 'own_garden', source_label: null })
    let sql = mockSql([[linked], [], [linked]])
    expect((await patch(sql, { source_kind: 'own_garden', source_label: null })).status).toBe(200)
    expect(sent(sql.batches[0][1])).toEqual([true, 'own_garden', null])
    // Garden clears a stored name (the create's rule, index.js): a row that had a vendor and is corrected
    // to the garden must not go on naming the vendor.
    const bought = stored({ source_kind: 'store', source_label: 'Kroger' })
    sql = mockSql([[bought], [], [bought]])
    expect((await patch(sql, { source_kind: 'own_garden', source_label: 'Kroger' })).status).toBe(200)
    expect(sent(sql.batches[0][1])).toEqual([true, 'own_garden', null])
  })

  it('`null, null` un-chooses on any jar, planting-linked included: both columns are written NULL', async () => {
    for (const jar of [stored({ source_kind: 'store', source_label: 'Kroger' }), stored({ plant_id: PLANT, source_kind: 'own_garden' })]) {
      const sql = mockSql([[jar], [], [jar]])
      expect((await patch(sql, { source_kind: null, source_label: null })).status).toBe(200)
      expect(sent(sql.batches[0][1])).toEqual([true, null, null])
    }
  })

  it('a non-garden source on a jar with no planting and no pick saves: the kind as sent, the name trimmed', async () => {
    const sql = mockSql([[stored()], [], [{ ...stored(), source_kind: 'store', source_label: 'Kroger' }]])
    const res = await patch(sql, { source_kind: 'store', source_label: '  Kroger ' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ source_kind: 'store', source_label: 'Kroger' })
    expect(sent(sql.batches[0][1])).toEqual([true, 'store', 'Kroger'])
    // A kind with no name (every kind but Other allows it) writes a NULL name, never a blank one.
    const sql2 = mockSql([[stored()], [], [stored()]])
    await patch(sql2, { source_kind: 'gift', source_label: '   ' })
    expect(sent(sql2.batches[0][1])).toEqual([true, 'gift', null])
  })

  it('a non-garden source is GUARDED on the xmin it read; our garden and un-choosing are not', async () => {
    let sql = mockSql([[stored()], [], [stored()]])
    await patch(sql, { source_kind: 'store', source_label: 'Kroger' })
    expect(after(sql.batches[0][1], 'AND (NOT')).toBe(true)
    expect(after(sql.batches[0][1], 'xmin =')).toBe('4242')
    for (const body of [{ source_kind: 'own_garden', source_label: null }, { source_kind: null, source_label: null }]) {
      sql = mockSql([[stored()], [], [stored()]])
      await patch(sql, body)
      expect(after(sql.batches[0][1], 'AND (NOT'), JSON.stringify(body)).toBe(false)
    }
  })

  it('a non-garden source whose jar changed after the read → 409 client_stale', async () => {
    const sql = mockSql([[stored()], [], []])
    const res = await patch(sql, { source_kind: 'store', source_label: 'Kroger' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('client_stale')
  })

  it('a PATCH that does not send the pair leaves both columns as they are, and moves no date', async () => {
    const sql = mockSql([[stored({ source_kind: 'store', source_label: 'Kroger' })], [], [stored()]])
    await patch(sql, { label: 'x' })
    const w = sql.batches[0][1]
    expect(after(w, 'source_kind       = CASE WHEN')).toBe(false)
    expect(after(w, 'source_label      = CASE WHEN')).toBe(false)
    // And the pair alone moves no date: where it came from is not something the date rule reads.
    const sql2 = mockSql([[stored()], [], [stored()]])
    await patch(sql2, { source_kind: 'store', source_label: 'Kroger' })
    expect(after(sql2.batches[0][1], 'use_by_target     = CASE WHEN')).toBe(false)
    expect(sql2.calls).toHaveLength(3)   // the jar, the actor, the write: no recipe read
  })

  it('the pair rides with other edits in ONE write', async () => {
    const sql = mockSql([[stored()], [], [stored()]])
    await patch(sql, { label: 'x', source_kind: 'u_pick', source_label: 'Hill farm', notes: 'n' })
    expect(sql.batches).toHaveLength(1)
    expect(sent(sql.batches[0][1])).toEqual([true, 'u_pick', 'Hill farm'])
    expect(after(sql.batches[0][1], 'label             = CASE WHEN ? ::boolean THEN')).toBe('x')
  })
})

// Put-Up UX pass R1: a clear is the one PATCH that reads the recipe the jar's batch follows. Queue order
// below: the jar, the recipe line, then the transaction (the actor, the write).
describe('PATCH — discard_by "clear" reads the batch\'s recipe, and no other write does', () => {
  const typedJar = stored({ use_by_basis: 'typed', use_by_target: '2026-12-25' })
  const FRIDGE_7 = { keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge' }
  const bound = (w) => [
    after(w, 'use_by_target     = CASE WHEN ? ::boolean THEN'), after(w, 'use_by_basis      = CASE WHEN ? ::boolean THEN'),
  ]

  it('the read goes jar → its batch → the batch\'s recipe, the household bound at every hop and every hop live', async () => {
    const sql = mockSql([[typedJar], [FRIDGE_7], [], [{ ...typedJar, use_by_target: '2026-10-15', use_by_basis: 'recipe' }]])
    const res = await patch(sql, { discard_by: 'clear' })
    expect(res.status).toBe(200)
    expect(sql.calls).toHaveLength(4)
    expect(sql.calls[1].norm).toBe('SELECT rc.keeps_n, rc.keeps_unit, rc.keeps_storage_kind FROM preservation_log p '
      + 'JOIN v_kitchen_batch_current b ON b.id = p.batch_id JOIN recipe rc ON rc.id = b.recipe_id '
      + 'WHERE p.id = ? ::uuid AND p.user_id = ANY( ? ) AND p.deleted_at IS NULL '
      + 'AND b.user_id = ANY( ? ) AND b.deleted_at IS NULL AND rc.user_id = ANY( ? ) AND rc.deleted_at IS NULL')
    expect(sql.calls[1].values).toEqual([JAR, HOUSEHOLD, HOUSEHOLD, HOUSEHOLD])
    // Bare relation names: the schema audit's relation extractor reads FROM / JOIN <name>.
    expect(sql.calls[1].norm).not.toMatch(/public\./)
  })

  it('the write is GUARDED on the xmin it read, in the actor transaction, and binds the recipe date and basis', async () => {
    const sql = mockSql([[typedJar], [FRIDGE_7], [], [typedJar]])
    await patch(sql, { discard_by: 'clear' })
    expect(sql.batches).toHaveLength(1)
    const [g, w] = sql.batches[0]
    expect(g.norm).toBe("SELECT set_config('app.actor_clerk_sub', ? , true)")
    expect(after(w, 'AND (NOT')).toBe(true)
    expect(after(w, 'xmin =')).toBe('4242')
    expect(after(w, 'use_by_target     = CASE WHEN')).toBe(true)
    expect(bound(w)).toEqual(['2026-10-15', 'recipe'])
  })

  it('no recipe row (no batch, no recipe, a removed one, another household\'s): the engine\'s date and basis', async () => {
    const sql = mockSql([[typedJar], [], [], [typedJar]])
    expect((await patch(sql, { discard_by: 'clear' })).status).toBe(200)
    expect(bound(sql.batches[0][1])).toEqual(['2027-04-08', 'table'])
  })

  it('a moved jar: the recipe is read and the rule still binds no date', async () => {
    const sql = mockSql([[{ ...typedJar, storage_moved_at: '2026-11-01T00:00:00Z' }], [FRIDGE_7], [], [typedJar]])
    await patch(sql, { discard_by: 'clear' })
    expect(bound(sql.batches[0][1])).toEqual([null, 'none'])
    expect(after(sql.batches[0][1], 'use_by_target     = CASE WHEN')).toBe(true)
  })

  it('clear sent with a method correction in ONE PATCH: the method is written and the date resolves by the ladder', async () => {
    // With the recipe: its date (the recipe rung does not read the method).
    let sql = mockSql([[typedJar], [FRIDGE_7], [], [typedJar]])
    await patch(sql, { discard_by: 'clear', method: 'quick_pickle' })
    expect(after(sql.batches[0][1], 'method            = CASE WHEN ? ::boolean THEN')).toBe('quick_pickle')
    expect(bound(sql.batches[0][1])).toEqual(['2026-10-15', 'recipe'])
    // Without one: the engine, on the CORRECTED method (a quick pickle in a fridge is 2 months, not hot sauce's 6).
    sql = mockSql([[typedJar], [], [], [typedJar]])
    await patch(sql, { discard_by: 'clear', method: 'quick_pickle' })
    expect(after(sql.batches[0][1], 'method            = CASE WHEN ? ::boolean THEN')).toBe('quick_pickle')
    expect(bound(sql.batches[0][1])).toEqual(['2026-12-08', 'table'])
  })

  it('the jar changed between the read and the write → 409 client_stale', async () => {
    const sql = mockSql([[typedJar], [FRIDGE_7], [], []])
    const res = await patch(sql, { discard_by: 'clear' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('client_stale')
  })

  it('a stranger → 404 after the one jar read: no recipe read, nothing written', async () => {
    const sql = mockSql([[]])
    const res = await patch(sql, { discard_by: 'clear' }, STRANGER)
    expect(res).toEqual({ status: 404, body: { error: 'Not found', code: 'not_found' } })
    expect(sql.calls).toHaveLength(1)
    expect(sql.calls[0].values[1]).toEqual(STRANGER)
    expect(sql.batches).toHaveLength(0)
  })

  it.each([
    [{ discard_by: '2027-01-15' }], [{ discard_by: 'none' }], [{ is_raw: true }], [{ method: 'ferment_mash' }], [{ label: 'x' }],
  ])('%o reads no recipe: the jar, the actor, the write, and nothing else', async (body) => {
    const sql = mockSql([[stored()], [], [stored()]])
    expect((await patch(sql, body)).status).toBe(200)
    expect(sql.calls).toHaveLength(3)
    expect(sql.calls.some((c) => /\brecipe\b/.test(c.norm))).toBe(false)
  })

  it('a Move reads no recipe either', async () => {
    const sql = mockSql([[stored()], [], [stored()]])
    expect((await move(sql, { place: { kind: 'deep_freezer', label: 'Chest Freezer 1' } })).status).toBe(200)
    expect(sql.calls).toHaveLength(3)
    expect(sql.calls.some((c) => /\brecipe\b/.test(c.norm))).toBe(false)
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

// ── integrator follow-up to A3 ────────────────────────────────────────────────────────────────────
describe('A3: method_other_text on its own, and the size + count in ONE PATCH', () => {
  it('the route matcher captures [^/]+ and still claims only a uuid', () => {
    expect(parseJarRoute(`/api/preservation/${JAR}/move`)).toEqual({ id: JAR, sub: 'move' })
    expect(parseJarRoute('/api/preservation/p/move')).toBeNull()
  })

  it('method_other_text alone on an Other jar writes it; on a non-Other jar → 400', async () => {
    const other = stored({ method: 'other', method_other_text: 'old' })
    const sql = mockSql([[other], [], [other]])
    const res = await patch(sql, { method_other_text: 'Drinking vinegar' })
    expect(res.status).toBe(200)
    expect(after(sql.batches[0][1], 'method_other_text = CASE WHEN ? ::boolean THEN')).toBe('Drinking vinegar')
    const sql2 = mockSql([[stored()]])
    expect((await patch(sql2, { method_other_text: 'x' })).status).toBe(400)
  })

  it('a count change moves remaining_count by the delta, decided in the WHERE; stamps delta_at', async () => {
    const sql = mockSql([[stored({ package_count: 3, remaining_count: 2 })], [], [stored()]])
    await patch(sql, { package_count: 4, quantity_value: 10, quantity_unit: 'qt' })
    const w = sql.batches[0][1]
    expect(w.norm).toContain('remaining_count = CASE WHEN ? ::int IS NOT NULL AND package_count <> ? ::int THEN COALESCE(remaining_count, package_count) + ( ? ::int - package_count) ELSE remaining_count END')
    expect(w.norm).toContain('delta_at = CASE WHEN ? ::int IS NOT NULL AND package_count <> ? ::int THEN now() ELSE delta_at END')
    expect(w.norm).toContain('AND ( ? ::int IS NULL OR COALESCE(remaining_count, package_count) + ( ? ::int - package_count) BETWEEN 0 AND ? ::int)')
    expect(after(w, 'package_count = COALESCE(')).toBe(4)
  })

  it('the refusal: lowering below what is used → 409 count_below_used, the legacy PUT\'s words', async () => {
    const sql = mockSql([[stored({ package_count: 3, remaining_count: 1 })], [], []])
    const res = await patch(sql, { package_count: 1 })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('count_below_used')
  })

  it('a count the rule allows but the row changed under → 409 client_stale', async () => {
    const sql = mockSql([[stored({ package_count: 3, remaining_count: 3 })], [], []])
    const res = await patch(sql, { package_count: 2 })
    expect(res.body.code).toBe('client_stale')
  })
})
