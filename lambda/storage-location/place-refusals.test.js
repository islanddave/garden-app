// Put-Up R2a (contracts 1 and 2) — the two refusals a place answers: a re-kind while it holds put-ups
// whose dates were worked out from its kind, and a delete while anything is stored in it.
//
// Executes the real handler (lambda/storage-location/index.js under the vitest stubs). The stub runs no
// SQL, so each rule is proved from both sides it has here:
//   * what the handler SENDS: one statement, and the clause of it that IS the rule, with its bindings;
//   * what the handler ANSWERS for each thing that statement can say back (written, refused with n,
//     no such place).
// What Postgres does with the statement is tests/integration/storage-location.int.test.js's, case for case.
//
// MUTATIONS (each reds the test named after it):
//   remove the re-kind guard ........................ "one table-dated jar: PUT { kind } → 409"
//   refuse whenever kind is PRESENT ................. "PUT { label, kind: the stored kind } → 200"
//   count typed dates / undated jars / skip NULL .... the three "what counts" rows
//   count a removed, consumed or empty jar .......... "live by the Pantry's own predicate"
//   scope the count to the caller ................... "Jen's dated jar in Dave's place blocks Dave"
//   write the label, then refuse the kind ........... "a refused PUT { label, kind } leaves the label"
//   decide from a SELECT, then UPDATE ............... "the first statement issued is the UPDATE"
//   drop n, code or message; plural words for 1 ..... the body rows
//   409 for an unknown or foreign id ................ "unknown id → 404; a stranger's → 404"
//   no delete guard / put-ups only / dated only ..... the DELETE rows
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stubState, resetStubs } from '../_test-stubs/state.js'

const { handler, placeHasDatedJars, placeInUse } = await import('./index.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const DAVE = 'user_stub_dave'
const JEN = 'user_stub_jen'
const PLACE = '7b2e9f10-1c3d-4e5f-8a9b-0c1d2e3f4a5b'
// The place as the PUT has always answered it: these six columns and nothing else.
const ROW = {
  id: PLACE, user_id: DAVE, label: 'Chest freezer', kind: 'deep_freezer',
  created_at: '2026-09-01T14:00:00.000Z', deleted_at: null,
}
// What the PUT's one statement says back.
const written = (over = {}, n = 0) => [{ ...ROW, ...over, old_kind: ROW.kind, refused: false, n }]
const refused = (n) => [{ ...ROW, old_kind: ROW.kind, refused: true, n }]

const BANNED = ['safe', 'shelf life', 'shelf-stable', 'keeps', 'good', 'ready', 'done', 'expired', 'table', 'default', 'basis']
const RE_KIND_MANY = (n) => `${n} put-ups in this place have dates worked out from the kind of place it is now. Set those dates by hand, or move them somewhere else, then change the kind.`
const RE_KIND_ONE = '1 put-up in this place has a date worked out from the kind of place it is now. Set its date by hand, or move it somewhere else, then change the kind.'
const IN_USE_MANY = (n) => `${n} things are stored in this place. Move them first, then delete it.`
const IN_USE_ONE = '1 thing is stored in this place. Move it first, then delete it.'

const req = (method, body, id = PLACE) => ({
  requestContext: { http: { method } }, rawPath: `/api/storage-locations/${id}`,
  headers: { authorization: 'Bearer stub-token' }, body: body == null ? null : JSON.stringify(body),
})
const put = (body, id) => handler(req('PUT', body, id))
const del = (id) => handler(req('DELETE', null, id))
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') })
const flat = (t) => t.replace(/\s+/g, ' ').trim()
// The n-th value bound after a clause (the stub joins the template strings with '?').
const boundAfter = (call, needle, nth = 0) => {
  const text = flat(call.text)
  const at = text.indexOf(needle)
  expect(at, `the statement lacks: ${needle}`).toBeGreaterThan(-1)
  const before = (flat(call.text).slice(0, at + needle.length).match(/\?/g) ?? []).length
  // flat() collapses whitespace only, so the count of '?' before the clause is the raw text's too.
  return call.values[before + nth]
}
// One CTE's body, by name: from `<name> AS (` to the `)` that closes it.
const cte = (call, name) => {
  const text = flat(call.text)
  const start = text.indexOf(`${name} AS (`)
  expect(start, `no CTE named ${name}`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = start + name.length + 4; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    if (text[i] === ')') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
  }
  throw new Error(`CTE ${name} never closes`)
}

let logged
beforeEach(() => {
  resetStubs()
  stubState.verifyTokenResult = { sub: DAVE }
  process.env.GARDEN_HOUSEHOLD_IDS = `${DAVE},${JEN}`
  logged = []
  vi.spyOn(console, 'log').mockImplementation((line) => { logged.push(line) })
})
afterEach(() => {
  delete process.env.GARDEN_HOUSEHOLD_IDS
  vi.restoreAllMocks()
})
const logLines = () => logged.map((l) => JSON.parse(l))

describe('the two server sentences (a cached older bundle prints them as they are)', () => {
  it('re-kind: the exact body, the same sentence in error and message, n carried', () => {
    expect(placeHasDatedJars(4)).toEqual({ error: RE_KIND_MANY(4), message: RE_KIND_MANY(4), code: 'place_has_dated_jars', n: 4 })
    expect(Object.keys(placeHasDatedJars(4)).sort()).toEqual(['code', 'error', 'message', 'n'])
  })

  it('re-kind: one put-up reads in the singular', () => {
    expect(placeHasDatedJars(1)).toEqual({ error: RE_KIND_ONE, message: RE_KIND_ONE, code: 'place_has_dated_jars', n: 1 })
  })

  it('delete: the exact body, the same sentence in error and message, n carried', () => {
    expect(placeInUse(3)).toEqual({ error: IN_USE_MANY(3), message: IN_USE_MANY(3), code: 'place_in_use', n: 3 })
    expect(Object.keys(placeInUse(3)).sort()).toEqual(['code', 'error', 'message', 'n'])
  })

  it('delete: one thing reads in the singular', () => {
    expect(placeInUse(1)).toEqual({ error: IN_USE_ONE, message: IN_USE_ONE, code: 'place_in_use', n: 1 })
  })

  it('neither server sentence contains a banned word, in the singular or the plural', () => {
    const sentences = [placeHasDatedJars(1), placeHasDatedJars(4), placeInUse(1), placeInUse(3)].flatMap((b) => [b.error, b.message])
    expect(sentences).toHaveLength(8)
    for (const s of sentences) {
      for (const w of BANNED) expect(s.toLowerCase(), `"${w}" in: ${s}`).not.toMatch(new RegExp(`\\b${w}\\b`))
    }
  })
})

describe('PUT — a re-kind is refused while the place holds put-ups dated for its kind', () => {
  const GUARD = 'AND (?::text IS NULL OR kind = ?::text OR (SELECT n FROM dated) = 0)'
  // The clause the guard opens with, in the write: what follows it is the kind as sent (or null).
  const KIND_SENT = 'AND user_id = ANY(?) AND ('

  it('one table-dated jar: PUT { kind } → 409 place_has_dated_jars, n: 1', async () => {
    stubState.sqlHandler = () => refused(1)
    const res = parse(await put({ kind: 'fridge' }))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: RE_KIND_ONE, message: RE_KIND_ONE, code: 'place_has_dated_jars', n: 1 })
    // The refusal is the UPDATE's own WHERE: without this clause every re-kind is written.
    const [call] = stubState.sqlCalls
    expect(cte(call, 'written')).toContain(GUARD)
    expect([boundAfter(call, KIND_SENT, 0), boundAfter(call, 'OR kind = ', 0)]).toEqual(['fridge', 'fridge'])
  })

  it('four of them → 409 with n: 4 and the plural sentence', async () => {
    stubState.sqlHandler = () => refused(4)
    const res = parse(await put({ kind: 'fridge' }))
    expect(res.body).toEqual({ error: RE_KIND_MANY(4), message: RE_KIND_MANY(4), code: 'place_has_dated_jars', n: 4 })
  })

  it('PUT { label, kind: the stored kind } → 200, label saved (the old form\'s body: a rename is never a re-kind)', async () => {
    // The place holds four dated put-ups; the save sends its own kind back, as the shipped editor does.
    stubState.sqlHandler = () => written({ label: 'Garage freezer' }, 4)
    const res = parse(await put({ label: 'Garage freezer', kind: 'deep_freezer' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ...ROW, label: 'Garage freezer' })
    // "Differs", not "present": the sent kind is compared with the STORED kind, inside the write.
    const [call] = stubState.sqlCalls
    expect(cte(call, 'written')).toContain('OR kind = ?::text')
    expect(boundAfter(call, 'OR kind = ', 0)).toBe('deep_freezer')
  })

  it('PUT { label } alone (the Places sheet\'s rename) → 200: no kind sent, nothing to refuse', async () => {
    stubState.sqlHandler = () => written({ label: 'Garage freezer' }, 4)
    const res = parse(await put({ label: 'Garage freezer' }))
    expect(res.status).toBe(200)
    const [call] = stubState.sqlCalls
    expect(cte(call, 'written')).toContain('AND (?::text IS NULL OR')
    expect(boundAfter(call, KIND_SENT, 0)).toBeNull()
    expect(boundAfter(call, 'kind = COALESCE(', 0)).toBeNull()
  })

  it('a different kind at an empty place → 200, the new kind written', async () => {
    stubState.sqlHandler = () => written({ kind: 'fridge_freezer' }, 0)
    const res = parse(await put({ kind: 'fridge_freezer' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ...ROW, kind: 'fridge_freezer' })
    expect(cte(stubState.sqlCalls[0], 'written')).toContain('OR (SELECT n FROM dated) = 0)')
  })

  describe('what counts (the `dated` count)', () => {
    const dated = async () => {
      stubState.sqlHandler = () => refused(1)
      await put({ kind: 'fridge' })
      return cte(stubState.sqlCalls[0], 'dated')
    }

    it('only typed dates → 200: the count is of dates worked out from a general figure, the house figure or a recipe', async () => {
      const text = await dated()
      expect(text).toContain("p.use_by_basis IN ('table', 'house', 'recipe')")
      expect(text).not.toMatch(/'typed'|'none'/)
    })

    it('a dated row with no basis blocks: an unrecorded basis counts', async () => {
      expect(await dated()).toContain("AND (p.use_by_basis IS NULL OR p.use_by_basis IN ('table', 'house', 'recipe'))")
    })

    it('undated jars → 200: a put-up with no stored date never counts', async () => {
      expect(await dated()).toContain('AND p.use_by_target IS NOT NULL')
    })

    it('live by the Pantry\'s own predicate: a removed jar, a consumed one and one with nothing left never count', async () => {
      const text = await dated()
      const LIVE = 'AND p.deleted_at IS NULL AND COALESCE(p.remaining_count, p.package_count) > 0 AND p.consumed_at IS NULL'
      expect(text).toContain(LIVE)
      // And it IS the Pantry's: the same three tests, in the list every Pantry row comes from.
      const pantry = flat(readFileSync(resolve(__dirname, '../preservation/pantryRoutes.js'), 'utf8'))
      expect(pantry).toContain(`WHERE p.user_id = ANY(\${householdIds}) ${LIVE}`)
    })

    it('counts put-ups AT this place, as one whole number', async () => {
      const text = await dated()
      expect(text).toContain('SELECT count(*)::int AS n FROM preservation_log p WHERE p.storage_location_id = ?')
      expect(boundAfter(stubState.sqlCalls[0], 'WHERE p.storage_location_id = ', 0)).toBe(PLACE)
    })

    it('Jen\'s dated jar in Dave\'s place blocks Dave: the count is the household\'s, not the caller\'s', async () => {
      await dated()
      expect(boundAfter(stubState.sqlCalls[0], 'AND p.user_id = ANY(', 0)).toEqual([DAVE, JEN])
    })
  })

  it('a refused PUT { label, kind } leaves the label as it was: the name and the kind are one write, behind one guard', async () => {
    stubState.sqlHandler = () => refused(2)
    const res = parse(await put({ label: 'Renamed', kind: 'fridge' }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('place_has_dated_jars')
    // Nothing else was issued: no earlier write of the name, no later one.
    expect(stubState.sqlCalls).toHaveLength(1)
    const text = flat(stubState.sqlCalls[0].text)
    expect(text.match(/UPDATE storage_location/g)).toHaveLength(1)
    const write = cte(stubState.sqlCalls[0], 'written')
    expect(write).toContain('SET label = COALESCE(?, label), kind = COALESCE(?, kind) WHERE')
    expect(write).toContain(GUARD)
    expect(write.indexOf('label = COALESCE(')).toBeLessThan(write.indexOf(GUARD))
  })

  it('the first statement issued is the UPDATE, and it carries the guard: no read decides before the write', async () => {
    for (const answer of [written({ kind: 'fridge' }), refused(1), []]) {
      stubState.sqlCalls = []
      stubState.sqlHandler = () => answer
      await put({ kind: 'fridge' })
      expect(stubState.sqlCalls).toHaveLength(1)
      expect(flat(stubState.sqlCalls[0].text)).toContain('UPDATE storage_location')
      expect(cte(stubState.sqlCalls[0], 'written')).toContain(GUARD)
    }
  })

  it('unknown id → 404; a stranger\'s → 404: never a 409 for a place that is not the household\'s', async () => {
    stubState.sqlHandler = () => []
    const res = parse(await put({ kind: 'fridge' }, '00000000-0000-4000-8000-0000000000dd'))
    expect(res).toEqual({ status: 404, body: { error: 'Not found' } })
    // Both the place read and the write are scoped to the household's live places.
    const [call] = stubState.sqlCalls
    for (const name of ['target', 'written']) {
      expect(cte(call, name)).toContain('WHERE id = ? AND deleted_at IS NULL AND user_id = ANY(?)')
    }
    expect(boundAfter(call, 'WHERE id = ? AND deleted_at IS NULL AND user_id = ANY(', 0)).toEqual([DAVE, JEN])
  })

  it('refused with nothing dated (the place went under the statement) → 404, not a sentence about 0 put-ups', async () => {
    stubState.sqlHandler = () => refused(0)
    expect(parse(await put({ kind: 'fridge' }))).toEqual({ status: 404, body: { error: 'Not found' } })
    expect(logged).toHaveLength(0)
  })

  it('the 200 answers the place alone: the six columns, none of the statement\'s own', async () => {
    stubState.sqlHandler = () => written({ label: 'Garage freezer' }, 3)
    const res = parse(await put({ label: 'Garage freezer' }))
    expect(Object.keys(res.body).sort()).toEqual(['created_at', 'deleted_at', 'id', 'kind', 'label', 'user_id'])
  })

  it('bare relation names: the schema audit reads FROM / JOIN <name>', async () => {
    stubState.sqlHandler = () => written()
    await put({ label: 'x' })
    expect(stubState.sqlCalls[0].text).not.toMatch(/public\./)
  })
})

describe('DELETE — refused while anything is stored in the place', () => {
  const gone = (n = 0) => [{ id: PLACE, old_kind: 'deep_freezer', refused: false, n }]
  const held = (n) => [{ id: PLACE, old_kind: 'deep_freezer', refused: true, n }]

  it('one live put-up: DELETE → 409 place_in_use, n: 1, and the soft-delete is behind the count', async () => {
    stubState.sqlHandler = () => held(1)
    const res = parse(await del())
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: IN_USE_ONE, message: IN_USE_ONE, code: 'place_in_use', n: 1 })
    // `deleted_at` stays null because the write that sets it carries the guard, in the one statement.
    expect(stubState.sqlCalls).toHaveLength(1)
    const write = cte(stubState.sqlCalls[0], 'gone')
    expect(write).toContain('UPDATE storage_location SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL AND user_id = ANY(?) AND (SELECT n FROM held) = 0 RETURNING id')
  })

  it('a place holding only a pantry item is refused: the count reads pantry items too', async () => {
    stubState.sqlHandler = () => held(1)
    expect(parse(await del()).status).toBe(409)
    expect(cte(stubState.sqlCalls[0], 'held')).toContain(
      'FROM pantry_item pit WHERE pit.storage_location_id = ? AND pit.user_id = ANY(?) AND pit.deleted_at IS NULL AND pit.used_up_at IS NULL')
  })

  it('a used-up item, a removed item, a consumed jar and a removed jar never count (the Pantry\'s own liveness)', async () => {
    stubState.sqlHandler = () => gone()
    await del()
    const text = cte(stubState.sqlCalls[0], 'held')
    expect(text).toContain('FROM preservation_log p WHERE p.storage_location_id = ? AND p.user_id = ANY(?) AND p.deleted_at IS NULL AND COALESCE(p.remaining_count, p.package_count) > 0 AND p.consumed_at IS NULL)')
    expect(text).toContain('AND pit.deleted_at IS NULL AND pit.used_up_at IS NULL)')
    const pantry = flat(readFileSync(resolve(__dirname, '../preservation/pantryRoutes.js'), 'utf8'))
    expect(pantry).toContain('WHERE i.user_id = ANY(${householdIds}) AND i.deleted_at IS NULL AND i.used_up_at IS NULL')
  })

  it('an undated or typed jar still blocks a delete: the count asks nothing about dates', async () => {
    stubState.sqlHandler = () => held(1)
    await del()
    expect(cte(stubState.sqlCalls[0], 'held')).not.toMatch(/use_by_target|use_by_basis/)
  })

  it('two jars and one item: n is 3 (the two counts are added), with the plural sentence', async () => {
    stubState.sqlHandler = () => held(3)
    const res = parse(await del())
    expect(res.body).toEqual({ error: IN_USE_MANY(3), message: IN_USE_MANY(3), code: 'place_in_use', n: 3 })
    expect(cte(stubState.sqlCalls[0], 'held')).toMatch(/AND p\.consumed_at IS NULL\) \+ \(SELECT count\(\*\) FROM pantry_item pit/)
    expect(cte(stubState.sqlCalls[0], 'held')).toMatch(/\)::int AS n \)$/)
  })

  it('a peer\'s jar blocks: both counts are the household\'s, at this place', async () => {
    stubState.sqlHandler = () => held(1)
    await del()
    const [call] = stubState.sqlCalls
    expect(boundAfter(call, 'WHERE p.storage_location_id = ', 0)).toBe(PLACE)
    expect(boundAfter(call, 'AND p.user_id = ANY(', 0)).toEqual([DAVE, JEN])
    expect(boundAfter(call, 'WHERE pit.storage_location_id = ', 0)).toBe(PLACE)
    expect(boundAfter(call, 'AND pit.user_id = ANY(', 0)).toEqual([DAVE, JEN])
  })

  it('an empty place deletes as before: 200 { ok: true }, one statement', async () => {
    stubState.sqlHandler = () => gone()
    expect(parse(await del())).toEqual({ status: 200, body: { ok: true } })
    expect(stubState.sqlCalls).toHaveLength(1)
  })

  it('unknown, already deleted or not the household\'s → 404, never a 409', async () => {
    stubState.sqlHandler = () => []
    expect(parse(await del('00000000-0000-4000-8000-0000000000dd'))).toEqual({ status: 404, body: { error: 'Not found' } })
    const [call] = stubState.sqlCalls
    expect(cte(call, 'target')).toContain('WHERE id = ? AND deleted_at IS NULL AND user_id = ANY(?)')
    expect(boundAfter(call, 'WHERE id = ? AND deleted_at IS NULL AND user_id = ANY(', 0)).toEqual([DAVE, JEN])
  })

  it('refused with nothing stored (the place went under the statement) → 404', async () => {
    stubState.sqlHandler = () => held(0)
    expect(parse(await del())).toEqual({ status: 404, body: { error: 'Not found' } })
    expect(logged).toHaveLength(0)
  })
})

describe('one structured log line per place write and per refusal', () => {
  it('a rename or re-kind that saves: place id, old and new kind, the dated count', async () => {
    stubState.sqlHandler = () => written({ kind: 'fridge_freezer' }, 0)
    await put({ kind: 'fridge_freezer' })
    expect(logLines()).toEqual([
      { event: 'storage_location_write', op: 'update', place_id: PLACE, old_kind: 'deep_freezer', new_kind: 'fridge_freezer', n: 0 },
    ])
  })

  it('a refused re-kind: the kind it has, the kind that was asked for, and n', async () => {
    stubState.sqlHandler = () => refused(4)
    await put({ label: 'x', kind: 'fridge' })
    expect(logLines()).toEqual([
      { event: 'storage_location_refused', op: 'rekind', code: 'place_has_dated_jars', place_id: PLACE, old_kind: 'deep_freezer', new_kind: 'fridge', n: 4 },
    ])
  })

  it('a delete and a refused delete', async () => {
    stubState.sqlHandler = () => [{ id: PLACE, old_kind: 'deep_freezer', refused: false, n: 0 }]
    await del()
    stubState.sqlHandler = () => [{ id: PLACE, old_kind: 'deep_freezer', refused: true, n: 3 }]
    await del()
    expect(logLines()).toEqual([
      { event: 'storage_location_write', op: 'delete', place_id: PLACE, old_kind: 'deep_freezer', new_kind: null, n: 0 },
      { event: 'storage_location_refused', op: 'delete', code: 'place_in_use', place_id: PLACE, old_kind: 'deep_freezer', new_kind: null, n: 3 },
    ])
  })

  it('a create', async () => {
    stubState.sqlHandler = () => [{ ...ROW, kind: 'pantry', label: 'Shelf' }]
    await handler({
      requestContext: { http: { method: 'POST' } }, rawPath: '/api/storage-locations',
      headers: { authorization: 'Bearer stub-token' }, body: JSON.stringify({ label: 'Shelf', kind: 'pantry' }),
    })
    expect(logLines()).toEqual([
      { event: 'storage_location_write', op: 'create', place_id: PLACE, old_kind: null, new_kind: 'pantry', n: 0 },
    ])
  })

  it('nothing is logged for a place that is not there, and a log line never carries the place\'s name', async () => {
    stubState.sqlHandler = () => []
    await put({ label: 'Secret shelf', kind: 'fridge' })
    await del()
    expect(logged).toHaveLength(0)
    stubState.sqlHandler = () => written({ label: 'Secret shelf' })
    await put({ label: 'Secret shelf' })
    expect(logged).toHaveLength(1)
    expect(logged[0]).not.toContain('Secret shelf')
  })
})
