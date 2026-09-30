// kitchen-draw.int.test.js — V5-FERMENTPATH-001 (06-ferment-path §5.2 "kitchen-draw", boss-technical F1/F2/F3,
// contract-F.md §2.2 / §2.4 / §2.6 / §3). Lane L4.
//
// The unit lane runs a mock driver and proves no DB behaviour (kitchenRoutes.test.js:1-12). Everything here
// is the REAL preservation handler against the ephemeral 1b+F fork, and every assertion reads the rows back
// with directSql — the stock (remaining_count / remaining_amount / consumed_at / delta_at), the ledger
// (pantry_use) and the lines — never the handler's echo alone.
//
// Two layers:
//   * SCHEMA (runs today, on the fork the workflow migrates): the pantry_use constraints that make "reverse
//     once" and "same jar" true in the database, the grams CHECK, the Postgres semantics F1 exists for (the
//     mutation arm, executed), and the _cleanup.js sweep order.
//   * ROUTES (skipped per route until it lands — see _kitchenF.js): draws, replays, the concurrent draw,
//     F2's used-up/removed refusals and un-consume rule, line take-out/restore, batch removal (F1) and
//     Undo that put-up (F1 + the DS-I4 refusal predicate), the use route, and line search scope.
// DAVE and JEN share a household; STRANGER is outside it and gets 404/400 on every arm that names DAVE's rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql } from './_harness.js'
import { STEP_SQL } from './_cleanup.js'
import {
  makeHousehold, useHousehold, routeProbeReport, landed, call, key, errOf,
  seedBatch, seedJar, seedLine, seedPlace, readJar, usesOf, linesOf, readBatchRow,
} from './_kitchenF.js'

const H = makeHousehold('draw')
const { DAVE, JEN, STRANGER } = H
useHousehold(H, beforeAll, afterAll)

routeProbeReport(it, expect, 'kitchen-draw', [
  'keyedLines', 'draws', 'lineRestore', 'lineSearch', 'putUp', 'putUpUndo', 'batchDeleteF1', 'pantryUses',
])

const inputsPath = (b) => `/api/kitchen-batches/${b}/inputs`
const linePath = (b, l) => `/api/kitchen-batches/${b}/inputs/${l}`

/** POST one keyed line; the line id is read back by its key, never taken from the response. */
async function postLine(user, batchId, line) {
  const k = line.idempotency_key ?? key()
  const res = await call(user, 'POST', inputsPath(batchId), { inputs: [{ ...line, idempotency_key: k }] })
  const [row] = await directSql`SELECT id FROM kitchen_batch_input WHERE idempotency_key = ${k}::uuid`
  return { res, lineId: row?.id ?? null, key: k }
}
const drawCounted = (user, batchId, jarId, n = 1, extra = {}) =>
  postLine(user, batchId, { input_kind: 'put_up', preservation_log_id: jarId, count_drawn: n, ...extra })
const drawGrams = (user, batchId, jarId, g, extra = {}) =>
  postLine(user, batchId, { input_kind: 'put_up', preservation_log_id: jarId, qty: g, qty_unit: 'g', ...extra })
const useTap = (user, body) => call(user, 'POST', '/api/pantry/uses', { idempotency_key: key(), ...body })

async function listedIn(user, path, jarId) {
  const r = await call(user, 'GET', path)
  expect(r.status).toBe(200)
  const recs = r.body.groups ? r.body.groups.flatMap((g) => g.records) : r.body.items
  return recs.some((x) => x.id === jarId)
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SCHEMA — runs on the 1b+F fork today.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('pantry_use — the ledger constraints the routes lean on (F, schema)', () => {
  let batchId, jarA, jarB, lineA, fwd
  beforeAll(async () => {
    batchId = (await seedBatch(DAVE)).id
    jarA = await seedJar(DAVE, { count: 4 })
    jarB = await seedJar(DAVE, { count: 4 })
    lineA = await seedLine(DAVE, batchId, { kind: 'put_up', jarId: jarA })
    ;[{ id: fwd }] = await directSql`
      INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id)
      VALUES (${DAVE}, ${jarA}, 1, 'batch', ${lineA}) RETURNING id`
  })

  const insUse = (o) => directSql`
    INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id,
                            reverses_use_id, idempotency_key)
    VALUES (${DAVE}, ${o.jar}, ${o.n}, ${o.fate ?? null}, ${o.line ?? null}, ${o.rev ?? null}, ${o.key ?? null})
    RETURNING id`

  it.each([
    ['count 0', () => ({ jar: jarA, n: 0 }), '23514', 'chk_pantry_use_count_nonzero'],
    ['negative without reverses_use_id', () => ({ jar: jarA, n: -1 }), '23514', 'chk_pantry_use_negative_is_reversal'],
    ['positive naming a reversal target', () => ({ jar: jarA, n: 1, fate: 'batch', line: lineA, rev: fwd }), '23514', 'chk_pantry_use_negative_is_reversal'],
    ["fate 'batch' with no line", () => ({ jar: jarA, n: 1, fate: 'batch' }), '23514', 'chk_pantry_use_batch_line'],
    ['a line with fate NULL (eaten)', () => ({ jar: jarA, n: 1, line: lineA }), '23514', 'chk_pantry_use_batch_line'],
    ['an unknown fate', () => ({ jar: jarA, n: 1, fate: 'composted' }), '23514', 'chk_pantry_use_fate'],
    ["a use naming a line whose jar is another jar", () => ({ jar: jarB, n: 1, fate: 'batch', line: lineA }), '23503', 'pantry_use_line_same_jar_fkey'],
    ['a reversal on another jar than its forward use', () => ({ jar: jarB, n: -1, fate: 'batch', line: lineA, rev: fwd }), '23503', null],
  ])('refuses %s', async (_name, mk, code, constraint) => {
    const e = await errOf(() => insUse(mk()))
    expect(e, 'the insert must be refused').not.toBeNull()
    expect(e.code).toBe(code)
    if (constraint) expect(e.message + (e.constraint ?? '')).toContain(constraint)
  })

  it('reverse once: a second reversal of the same forward use is a 23505 on uq_pantry_use_reverses_use_id', async () => {
    const first = await insUse({ jar: jarA, n: -1, fate: 'batch', line: lineA, rev: fwd })
    expect(first).toHaveLength(1)
    const e = await errOf(() => insUse({ jar: jarA, n: -1, fate: 'batch', line: lineA, rev: fwd }))
    expect(e?.code).toBe('23505')
    expect(e.message + (e.constraint ?? '')).toContain('uq_pantry_use_reverses_use_id')
    const rows = await usesOf(jarA)
    expect(rows.filter((r) => r.reverses_use_id === fwd)).toHaveLength(1)
  })

  it('an idempotency key is used once, globally (uq_pantry_use_idempotency_key)', async () => {
    const k = key()
    await insUse({ jar: jarB, n: 1, key: k })
    const e = await errOf(() => insUse({ jar: jarA, n: 1, key: k }))
    expect(e?.code).toBe('23505')
    expect(e.message + (e.constraint ?? '')).toContain('uq_pantry_use_idempotency_key')
  })

  it('remaining_amount can never go below 0 (chk_preservation_log_remaining_amount)', async () => {
    const bag = await seedJar(DAVE, { weighed: true, remainingAmount: 10 })
    const e = await errOf(() => directSql`UPDATE preservation_log SET remaining_amount = remaining_amount - 11 WHERE id = ${bag}`)
    expect(e?.code).toBe('23514')
    expect(e.message + (e.constraint ?? '')).toContain('chk_preservation_log_remaining_amount')
    expect((await readJar(bag)).remaining_amount).toBe('10')
  })
})

// F1, executed. boss-technical: "Postgres does not apply two updates to the same row within one statement."
// This pins the premise on the real engine (the mutation arm the route test below must turn red), so the
// aggregation rule is not an argument from the docs.
describe('F1 premise — one statement never updates the same jar twice (schema)', () => {
  let jar, uses
  beforeAll(async () => {
    const b = (await seedBatch(DAVE)).id
    jar = await seedJar(DAVE, { count: 5, remaining: 3 })
    const l1 = await seedLine(DAVE, b, { kind: 'put_up', jarId: jar })
    const l2 = await seedLine(DAVE, b, { kind: 'put_up', jarId: jar })
    uses = await directSql`
      INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id)
      VALUES (${DAVE}, ${jar}, 1, 'batch', ${l1}), (${DAVE}, ${jar}, 1, 'batch', ${l2}) RETURNING id`
  })

  it('MUTANT (un-aggregated UPDATE … FROM the lines): two reversals of one jar restore +1, not +2', async () => {
    const ids = uses.map((u) => u.id)
    const [r] = await directSql`
      UPDATE preservation_log p SET remaining_count = p.remaining_count + u.count_used
      FROM pantry_use u WHERE u.preservation_log_id = p.id AND u.id = ANY(${ids}::uuid[])
      RETURNING p.remaining_count`
    expect(r.remaining_count, 'this is the silent divergence F1 forbids').toBe(4)
    await directSql`UPDATE preservation_log SET remaining_count = 3 WHERE id = ${jar}`
  })

  it('F1 (aggregate per jar first, ONE UPDATE per jar): the same two reversals restore +2', async () => {
    const ids = uses.map((u) => u.id)
    const [r] = await directSql`
      WITH agg AS (
        SELECT preservation_log_id, sum(count_used)::int AS n FROM pantry_use
        WHERE id = ANY(${ids}::uuid[]) GROUP BY preservation_log_id)
      UPDATE preservation_log p SET remaining_count = p.remaining_count + agg.n
      FROM agg WHERE agg.preservation_log_id = p.id
      RETURNING p.remaining_count`
    expect(r.remaining_count).toBe(5)
  })
})

// 06 §5.2 _cleanup.js STEPS: "Proven by a run that creates a draw and then sweeps to 0 rows." The whole
// namespace is swept INSIDE one transaction that then aborts on purpose, so rows of files running in
// parallel are never actually removed: the last statement divides by zero when this file's rows are all
// gone (22012 = proof), and casts text to int when any survived (22P02 = leak). A wrong step order
// surfaces as the 23503 of the step that ran too early.
describe('_cleanup.js — the kitchen/pantry STEPS sweep a real draw to 0 rows, in FK order (schema)', () => {
  let ids
  beforeAll(async () => {
    const b = await seedBatch(DAVE)
    const [put] = await directSql`
      INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, created_by)
      VALUES (${b.id}, 'put_up', now(), 'exact', ${DAVE}) RETURNING id`
    const [noted] = await directSql`
      INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, created_by, note)
      VALUES (${b.id}, 'noted', now(), 'exact', ${DAVE}, 'kf note') RETURNING id`
    await directSql`
      INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, created_by, voids_id)
      VALUES (${b.id}, 'void', now(), 'exact', ${DAVE}, ${noted.id})`
    const drawn = await seedJar(DAVE, { count: 3 })
    const [made] = await directSql`
      INSERT INTO preservation_log (user_id, crop_type_slug, preserved_at, method, quantity_value, quantity_unit,
                                    package_count, batch_id, put_up_stage_id)
      SELECT ${DAVE}, crop_type_slug, now()::date, 'ferment', 1, 'jar', 1, ${b.id}, ${put.id}
      FROM preservation_log WHERE id = ${drawn} RETURNING id`
    const [line] = await directSql`
      INSERT INTO kitchen_batch_input (batch_id, input_kind, label, preservation_log_id, put_up_stage_id,
                                       output_id, created_by)
      VALUES (${b.id}, 'put_up', 'kf sitting draw', ${drawn}, ${put.id}, ${made.id}, ${DAVE}) RETURNING id`
    const [f] = await directSql`
      INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id)
      VALUES (${DAVE}, ${drawn}, 1, 'batch', ${line.id}) RETURNING id`
    await directSql`
      INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id, reverses_use_id)
      VALUES (${DAVE}, ${drawn}, -1, 'batch', ${line.id}, ${f.id})`
    ids = { batch: b.id, jars: [drawn, made.id], line: line.id }
  })

  const KITCHEN_STEPS = ['pantry_use (reversing)', 'pantry_use', 'kitchen_batch_input', 'preservation_source',
    'preservation_log', 'kitchen_stage_log', 'kitchen_batch']
  const stmt = (name) => {
    const hit = STEP_SQL.find(([t]) => t === name)
    if (!hit) throw new Error(`no _cleanup.js step named ${name}`)
    return hit[1]
  }
  // Both CASE arms depend on t.n, so the planner cannot constant-fold either error away (or into the other).
  const residueCheck = (b) => directSql`
    SELECT CASE WHEN t.n = 0 THEN 1 / t.n ELSE (t.n::text || ' rows survived')::int END
    FROM (SELECT ((SELECT count(*) FROM kitchen_batch WHERE id = ${b.batch})
                + (SELECT count(*) FROM kitchen_stage_log WHERE batch_id = ${b.batch})
                + (SELECT count(*) FROM kitchen_batch_input WHERE id = ${b.line})
                + (SELECT count(*) FROM preservation_log WHERE id = ANY(${b.jars}::uuid[]))
                + (SELECT count(*) FROM pantry_use WHERE preservation_log_id = ANY(${b.jars}::uuid[])))::int AS n) t`

  // The steps match the WHOLE namespace, and other files write kitchen rows in parallel. Under READ COMMITTED each
  // DELETE sees rows committed since the one before, so a sibling's line committed between the kitchen_batch_input
  // step and the kitchen_batch step 23503'd this proof (integration 36659135098 on d956f04; 36655506153 on 1fb6434,
  // same test code, was green). SHARE blocks sibling writes to the family until this transaction rolls back (ms);
  // parent-first so a writer that already holds a parent is waited for before we hold any child.
  const freezeFamily = () => [
    directSql`SET LOCAL lock_timeout = '15s'`,
    directSql`LOCK TABLE kitchen_batch, kitchen_stage_log, preservation_log, preservation_source,
                         kitchen_batch_input, pantry_use IN SHARE MODE`,
  ]

  it('the steps, in _cleanup.js order, remove every row of a draw + reversal + sitting + void (then roll back)', async () => {
    const order = STEP_SQL.map(([t]) => t).filter((t) => KITCHEN_STEPS.includes(t))
    expect(order, 'STEPS must carry the kitchen family in FK order').toEqual(KITCHEN_STEPS)
    const e = await errOf(() => directSql.transaction([...freezeFamily(), ...order.map((t) => directSql(stmt(t))), residueCheck(ids)]))
    expect(e?.code, `22012 = swept clean; 22P02 = rows survived; anything else = a step failed: ${e?.message}`).toBe('22012')
    const [{ n }] = await directSql`SELECT count(*)::int AS n FROM kitchen_batch WHERE id = ${ids.batch}`
    expect(n, 'the proof transaction rolled back — nothing was really deleted').toBe(1)
  })

  it('negative control: kitchen_batch swept BEFORE preservation_log is refused (the order is load-bearing)', async () => {
    const wrong = ['pantry_use (reversing)', 'pantry_use', 'kitchen_batch_input', 'kitchen_stage_log', 'kitchen_batch']
    const e = await errOf(() => directSql.transaction([...wrong.map((t) => directSql(stmt(t))), residueCheck(ids)]))
    expect(e?.code).toBe('23503')
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ROUTES — each describe runs once its route is on the branch.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!landed('keyedLines', 'draws'))('counted draw — line + use + decrement in one statement (§2.2)', () => {
  it('DAVE draws 1 from his jar: 201; line, one forward use (fate batch, key NULL), remaining 3→2, delta_at stamped', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 3 })
    const { res, lineId } = await drawCounted(DAVE, b, jar, 1)
    expect(res.status).toBe(201)
    expect(res.body.inserted).toBe(1)
    expect(lineId).toBeTruthy()
    const j = await readJar(jar)
    expect(j.remaining_count).toBe(2)
    expect(j.delta_at).not.toBeNull()
    const uses = await usesOf(jar)
    expect(uses).toHaveLength(1)
    expect(uses[0]).toMatchObject({ count_used: 1, fate: 'batch', kitchen_batch_input_id: lineId, idempotency_key: null, reverses_use_id: null })
    const [line] = (await linesOf(b)).filter((l) => l.id === lineId)
    expect(line.input_kind).toBe('put_up')
    expect(line.label, 'label is always stored; the server stamps it from the jar when absent').toBeTruthy()
  })

  it('count_drawn defaults to 1 when absent', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 3 })
    const { res } = await postLine(DAVE, b, { input_kind: 'put_up', preservation_log_id: jar })
    expect(res.status).toBe(201)
    expect((await readJar(jar)).remaining_count).toBe(2)
  })

  it('JEN (same household) draws DAVE\'s jar into her batch: 201', async () => {
    const b = (await seedBatch(JEN)).id
    const jar = await seedJar(DAVE, { count: 2 })
    const { res } = await drawCounted(JEN, b, jar, 1)
    expect(res.status).toBe(201)
    expect((await readJar(jar)).remaining_count).toBe(1)
  })

  it('STRANGER: DAVE\'s batch → 404; DAVE\'s jar into the stranger\'s own batch → 400; nothing written', async () => {
    const daveBatch = (await seedBatch(DAVE)).id
    const strBatch = (await seedBatch(STRANGER)).id
    const jar = await seedJar(DAVE, { count: 2 })
    const a = await drawCounted(STRANGER, daveBatch, jar, 1)
    expect(a.res.status).toBe(404)
    const b = await drawCounted(STRANGER, strBatch, jar, 1)
    expect(b.res.status).toBe(400)
    expect(a.lineId).toBeNull()
    expect(b.lineId).toBeNull()
    expect((await readJar(jar)).remaining_count).toBeNull()
    expect(await usesOf(jar)).toHaveLength(0)
  })

  it('over-draw: count_drawn 2 on a jar with 1 left → 409 only_n_left {n:1}, and NOTHING lands (CHECK aborts the statement)', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 3, remaining: 1 })
    const { res, lineId } = await drawCounted(DAVE, b, jar, 2)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('only_n_left')
    expect(res.body.n).toBe(1)
    expect(lineId, 'a line never lands without its draw').toBeNull()
    expect(await usesOf(jar)).toHaveLength(0)
    const j = await readJar(jar)
    expect(j.remaining_count).toBe(1)
    expect(j.delta_at).toBeNull()
  })

  it('two concurrent draws on remaining 1 → exactly one 201; the other is refused; one line, one use, remaining 0', async () => {
    const b1 = (await seedBatch(DAVE)).id
    const b2 = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 2, remaining: 1 })
    // Same caller on both: the harness's auth stub is process-global (see _kitchenF.js call()).
    const [x, y] = await Promise.all([drawCounted(DAVE, b1, jar, 1), drawCounted(DAVE, b2, jar, 1)])
    const statuses = [x.res.status, y.res.status].sort()
    expect(statuses).toEqual([201, 409])
    const loser = x.res.status === 409 ? x.res : y.res
    // §5.2 names only_n_left (the CHECK lost the race). If the loser's statement began after the winner
    // committed, F2's used-up refusal answers first — also a correct refusal of the same over-draw.
    expect(['only_n_left', 'jar_used_up']).toContain(loser.body.code)
    expect((await readJar(jar)).remaining_count).toBe(0)
    expect(await usesOf(jar)).toHaveLength(1)
    const lines = await directSql`SELECT id FROM kitchen_batch_input WHERE preservation_log_id = ${jar}`
    expect(lines).toHaveLength(1)
  })

  it('two lines naming one jar in ONE POST → 400, nothing written (API-I3 / F1 "a multi-line POST refuses a repeated jar")', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 5 })
    const res = await call(DAVE, 'POST', inputsPath(b), { inputs: [
      { input_kind: 'put_up', preservation_log_id: jar, count_drawn: 1, idempotency_key: key() },
      { input_kind: 'put_up', preservation_log_id: jar, count_drawn: 1, idempotency_key: key() },
    ] })
    expect(res.status).toBe(400)
    expect(await linesOf(b)).toHaveLength(0)
    expect((await readJar(jar)).remaining_count).toBeNull()
  })

  it('keyed and un-keyed rows mixed in one POST → 400', async () => {
    const b = (await seedBatch(DAVE)).id
    const res = await call(DAVE, 'POST', inputsPath(b), { inputs: [
      { input_kind: 'other', label: 'carrot', idempotency_key: key() },
      { input_kind: 'other', label: 'onion' },
    ] })
    expect(res.status).toBe(400)
    expect(await linesOf(b)).toHaveLength(0)
  })
})

describe.skipIf(!landed('keyedLines', 'draws'))('idempotency — same key twice (§2 common, F3)', () => {
  it('replay: second POST → 200 {replayed:true}; ONE line, ONE use, ONE decrement', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 4 })
    const k = key()
    const first = await drawCounted(DAVE, b, jar, 1, { idempotency_key: k })
    const second = await drawCounted(DAVE, b, jar, 1, { idempotency_key: k })
    expect(first.res.status).toBe(201)
    expect(second.res.status).toBe(200)
    expect(second.res.body.replayed).toBe(true)
    expect(await linesOf(b)).toHaveLength(1)
    expect(await usesOf(jar)).toHaveLength(1)
    expect((await readJar(jar)).remaining_count).toBe(3)
  })

  it('the same key sent into ANOTHER batch → 409 key_conflict, nothing written there', async () => {
    const b1 = (await seedBatch(DAVE)).id
    const b2 = (await seedBatch(DAVE)).id
    const k = key()
    const first = await postLine(DAVE, b1, { input_kind: 'other', label: 'carrot', qty: 100, qty_unit: 'g', idempotency_key: k })
    expect(first.res.status).toBe(201)
    const res = await call(DAVE, 'POST', inputsPath(b2), { inputs: [{ input_kind: 'other', label: 'carrot', idempotency_key: k }] })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('key_conflict')
    expect(await linesOf(b2)).toHaveLength(0)
  })

  it('a malformed key → 400', async () => {
    const b = (await seedBatch(DAVE)).id
    const res = await call(DAVE, 'POST', inputsPath(b), { inputs: [{ input_kind: 'other', label: 'x', idempotency_key: 'not-a-uuid' }] })
    expect(res.status).toBe(400)
  })
})

describe.skipIf(!landed('keyedLines', 'draws'))('weighed draw — grams move, count only at 0 g (§1.4, DS-B1)', () => {
  it('8 g from a 100 g bag: remaining_amount 92 from the COALESCE; count untouched; NO delta_at; no pantry_use', async () => {
    const b = (await seedBatch(DAVE)).id
    const bag = await seedJar(DAVE, { weighed: true })
    const { res } = await drawGrams(DAVE, b, bag, 8)
    expect(res.status).toBe(201)
    const j = await readJar(bag)
    expect(Number(j.remaining_amount)).toBe(92)
    expect(j.remaining_count).toBeNull()
    expect(j.delta_at, 'a gram-only draw does not stamp delta_at (DS-B1)').toBeNull()
    expect(await usesOf(bag), 'a weighed draw writes no ledger row').toHaveLength(0)
  })

  it('0.5 oz from a 1 lb bag converts through the one mass table (453.592 − 14.17475)', async () => {
    const b = (await seedBatch(DAVE)).id
    const bag = await seedJar(DAVE, { weighed: true, qty: 1, unit: 'lb' })
    const { res } = await postLine(DAVE, b, { input_kind: 'put_up', preservation_log_id: bag, qty: 0.5, qty_unit: 'oz' })
    expect(res.status).toBe(201)
    expect(Number((await readJar(bag)).remaining_amount)).toBeCloseTo(453.592 - 14.17475, 3)
  })

  it('count_drawn on a weighed jar → 400; a non-mass unit → 400; no qty → 400; nothing written', async () => {
    const b = (await seedBatch(DAVE)).id
    const bag = await seedJar(DAVE, { weighed: true })
    for (const extra of [{ count_drawn: 1, qty: 5, qty_unit: 'g' }, { qty: 5, qty_unit: 'ml' }, { qty: 5, qty_unit: 'count' }, {}]) {
      const { res } = await postLine(DAVE, b, { input_kind: 'put_up', preservation_log_id: bag, ...extra })
      expect(res.status, JSON.stringify(extra)).toBe(400)
    }
    expect(await linesOf(b)).toHaveLength(0)
    expect((await readJar(bag)).remaining_amount).toBeNull()
  })

  it('over-draw 150 g of 100 → 409 only_g_left {g:100}; nothing written', async () => {
    const b = (await seedBatch(DAVE)).id
    const bag = await seedJar(DAVE, { weighed: true })
    const { res, lineId } = await drawGrams(DAVE, b, bag, 150)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('only_g_left')
    expect(Number(res.body.g)).toBe(100)
    expect(lineId).toBeNull()
    expect((await readJar(bag)).remaining_amount).toBeNull()
  })

  it('a draw to 0 g sets remaining_count 0, consumed_at and delta_at, and the bag leaves use-soon and whats-put-up', async () => {
    const b = (await seedBatch(DAVE)).id
    const bag = await seedJar(DAVE, { weighed: true, useByInDays: 2 })
    expect(await listedIn(DAVE, '/api/preservation/whats-put-up?group=crop', bag), 'listed before (non-vacuous)').toBe(true)
    expect(await listedIn(DAVE, '/api/preservation/use-soon', bag), 'listed before (non-vacuous)').toBe(true)
    const { res } = await drawGrams(DAVE, b, bag, 100)
    expect(res.status).toBe(201)
    const j = await readJar(bag)
    expect(Number(j.remaining_amount)).toBe(0)
    expect(j.remaining_count).toBe(0)
    expect(j.consumed_at).not.toBeNull()
    expect(j.delta_at).not.toBeNull()
    expect(await listedIn(DAVE, '/api/preservation/whats-put-up?group=crop', bag)).toBe(false)
    expect(await listedIn(DAVE, '/api/preservation/use-soon', bag)).toBe(false)
  })
})

describe.skipIf(!landed('draws'))('F2 — used-up and removed jars refuse a draw (§2.2)', () => {
  it.each([
    ['remaining_count 0', { count: 2, remaining: 0 }, 'jar_used_up'],
    ['consumed_at set (count still 2)', { count: 2, remaining: 2, consumed: true }, 'jar_used_up'],
    ['soft-deleted', { count: 2, deleted: true }, 'jar_removed'],
  ])('%s → 409 %s, nothing written', async (_n, jarOpts, code) => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, jarOpts)
    const before = await readJar(jar)
    const { res, lineId } = await drawCounted(DAVE, b, jar, 1)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(code)
    expect(lineId).toBeNull()
    expect(await readJar(jar)).toEqual(before)
    expect(await usesOf(jar)).toHaveLength(0)
  })
})

describe.skipIf(!landed('draws', 'lineRestore'))('take out / restore — reverse once, re-draw once (§2.2, §3.11)', () => {
  it('DELETE twice → one reversal (−1, reverses the forward use); second answers {ok, already:true}', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 3 })
    const { lineId } = await drawCounted(DAVE, b, jar, 2)
    expect((await readJar(jar)).remaining_count).toBe(1)
    const d1 = await call(DAVE, 'DELETE', linePath(b, lineId))
    expect(d1.status).toBe(200)
    expect(d1.body.ok).toBe(true)
    expect(d1.body.input?.id, 'the removed line comes back for the client-held row').toBe(lineId)
    const d2 = await call(DAVE, 'DELETE', linePath(b, lineId))
    expect(d2.status).toBe(200)
    expect(d2.body.already).toBe(true)
    const uses = await usesOf(jar)
    expect(uses).toHaveLength(2)
    const [fwd, rev] = uses
    expect(rev).toMatchObject({ count_used: -2, reverses_use_id: fwd.id, kitchen_batch_input_id: lineId, fate: 'batch', idempotency_key: null })
    const j = await readJar(jar)
    expect(j.remaining_count).toBe(3)
    const [line] = await directSql`SELECT deleted_at, edited_at FROM kitchen_batch_input WHERE id = ${lineId}`
    expect(line.deleted_at).not.toBeNull()
    expect(line.edited_at, 'soft delete does not stamp edited_at').toBeNull()
  })

  it('the taken-out line is not returned by getBatch (the struck-through row is client-held)', async () => {
    const b = (await seedBatch(DAVE)).id
    const { lineId } = await postLine(DAVE, b, { input_kind: 'other', label: 'carrot', qty: 150, qty_unit: 'g' })
    await call(DAVE, 'DELETE', linePath(b, lineId))
    const g = await call(DAVE, 'GET', `/api/kitchen-batches/${b}`)
    expect(g.status).toBe(200)
    expect(g.body.inputs.map((l) => l.id)).not.toContain(lineId)
  })

  it('restore twice → one new forward use; second answers already:true; count back to the drawn state', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 3 })
    const { lineId } = await drawCounted(DAVE, b, jar, 1)
    await call(DAVE, 'DELETE', linePath(b, lineId))
    const r1 = await call(DAVE, 'POST', `${linePath(b, lineId)}/restore`)
    expect(r1.status).toBe(200)
    expect(r1.body.input?.id).toBe(lineId)
    const r2 = await call(DAVE, 'POST', `${linePath(b, lineId)}/restore`)
    expect(r2.status).toBe(200)
    expect(r2.body.already).toBe(true)
    const uses = await usesOf(jar)
    expect(uses.map((u) => u.count_used)).toEqual([1, -1, 1])
    expect(uses[2].reverses_use_id).toBeNull()
    expect((await readJar(jar)).remaining_count).toBe(2)
  })

  it('restore after the jar was used up → 409 jar_used_up; the line stays out, no use written, jar unchanged', async () => {
    const b = (await seedBatch(DAVE)).id
    // COUNTED (3 containers): one container in a mass unit is a weighed jar (§1.4), where count_drawn is refused.
    const jar = await seedJar(DAVE, { count: 3 })
    const { res, lineId } = await drawCounted(DAVE, b, jar, 1)
    expect(res.status, 'precondition: the draw landed').toBe(201)
    expect((await call(DAVE, 'DELETE', linePath(b, lineId))).status, 'precondition: taken out').toBe(200)
    expect((await readJar(jar)).remaining_count).toBe(3)
    // Used up in between (another phone's Used up), so the re-draw has nothing to take.
    await directSql`UPDATE preservation_log SET remaining_count = 0, consumed_at = now() WHERE id = ${jar}`
    const before = await readJar(jar)
    const usesBefore = await usesOf(jar)
    const r = await call(DAVE, 'POST', `${linePath(b, lineId)}/restore`)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('jar_used_up')
    const [line] = await directSql`SELECT deleted_at FROM kitchen_batch_input WHERE id = ${lineId}`
    expect(line.deleted_at).not.toBeNull()
    expect(await usesOf(jar)).toEqual(usesBefore)
    expect(await readJar(jar)).toEqual(before)
  })

  it('restore onto a soft-deleted jar → 409 jar_removed; nothing written', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 2 })
    const { lineId } = await drawCounted(DAVE, b, jar, 1)
    await call(DAVE, 'DELETE', linePath(b, lineId))
    await directSql`UPDATE preservation_log SET deleted_at = now() WHERE id = ${jar}`
    const r = await call(DAVE, 'POST', `${linePath(b, lineId)}/restore`)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('jar_removed')
    expect((await usesOf(jar)).map((u) => u.count_used)).toEqual([1, -1])
  })

  it('weighed: take out restores the grams and un-consumes a bag the draw emptied (F2 rule, no tap)', async () => {
    const b = (await seedBatch(DAVE)).id
    const bag = await seedJar(DAVE, { weighed: true })
    const { lineId } = await drawGrams(DAVE, b, bag, 100)
    expect((await readJar(bag)).remaining_count).toBe(0)
    const d = await call(DAVE, 'DELETE', linePath(b, lineId))
    expect(d.status).toBe(200)
    const j = await readJar(bag)
    expect(Number(j.remaining_amount)).toBe(100)
    expect(j.remaining_count).toBe(1)
    expect(j.consumed_at).toBeNull()
  })

  it('STRANGER: DELETE and restore on DAVE\'s line → 404, the line and the jar untouched', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 2 })
    const { lineId } = await drawCounted(DAVE, b, jar, 1)
    expect((await call(STRANGER, 'DELETE', linePath(b, lineId))).status).toBe(404)
    expect((await call(STRANGER, 'POST', `${linePath(b, lineId)}/restore`)).status).toBe(404)
    const [line] = await directSql`SELECT deleted_at FROM kitchen_batch_input WHERE id = ${lineId}`
    expect(line.deleted_at).toBeNull()
    expect((await readJar(jar)).remaining_count).toBe(1)
  })
})

describe.skipIf(!landed('draws', 'lineRestore', 'pantryUses'))('F2 un-consume rule — a bag a TAP used up stays used up (§2.2)', () => {
  it('line draws 40 g, a use tap empties the rest (remaining_amount 0), then the line comes out: +40 g, still used up', async () => {
    const b = (await seedBatch(DAVE)).id
    const bag = await seedJar(DAVE, { weighed: true })
    const { lineId } = await drawGrams(DAVE, b, bag, 40)
    const tap = await useTap(DAVE, { preservation_log_id: bag, all_remaining: true })
    expect(tap.status).toBe(201)
    let j = await readJar(bag)
    expect(j.remaining_count).toBe(0)
    expect(Number(j.remaining_amount), 'F2: the use route zeroes the grams of a weighed jar it empties').toBe(0)
    expect(j.consumed_at).not.toBeNull()
    await call(DAVE, 'DELETE', linePath(b, lineId))
    j = await readJar(bag)
    expect(Number(j.remaining_amount)).toBe(40)
    expect(j.remaining_count).toBe(0)
    expect(j.consumed_at).not.toBeNull()
  })
})

describe.skipIf(!landed('pantryUses'))('POST /api/pantry/uses — the minimal use route (§2.6)', () => {
  it('count_used 1 → 201 {use, jar}; replay → 200 replayed; one use, one decrement', async () => {
    const jar = await seedJar(DAVE, { count: 3 })
    const k = key()
    const a = await call(DAVE, 'POST', '/api/pantry/uses', { idempotency_key: k, preservation_log_id: jar, count_used: 1 })
    expect(a.status).toBe(201)
    expect(a.body.jar).toMatchObject({ id: jar, remaining_count: 2 })
    const r = await call(DAVE, 'POST', '/api/pantry/uses', { idempotency_key: k, preservation_log_id: jar, count_used: 1 })
    expect(r.status).toBe(200)
    expect(r.body.replayed).toBe(true)
    const uses = await usesOf(jar)
    expect(uses).toHaveLength(1)
    expect(uses[0]).toMatchObject({ count_used: 1, fate: null, kitchen_batch_input_id: null, idempotency_key: k })
    const j = await readJar(jar)
    expect(j.remaining_count).toBe(2)
    expect(j.delta_at).not.toBeNull()
  })

  it('all_remaining → 0 and consumed_at; a further tap → 409 only_n_left {n:0}', async () => {
    const jar = await seedJar(DAVE, { count: 3, remaining: 2 })
    expect((await useTap(DAVE, { preservation_log_id: jar, all_remaining: true })).status).toBe(201)
    const j = await readJar(jar)
    expect(j.remaining_count).toBe(0)
    expect(j.consumed_at).not.toBeNull()
    const again = await useTap(DAVE, { preservation_log_id: jar, all_remaining: true })
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ code: 'only_n_left', n: 0 })
  })

  it('over-use 3 of 2 → 409 only_n_left {n:2}; a non-null fate → 400; STRANGER → 404; nothing written', async () => {
    const jar = await seedJar(DAVE, { count: 2 })
    const over = await useTap(DAVE, { preservation_log_id: jar, count_used: 3 })
    expect(over.status).toBe(409)
    expect(over.body).toMatchObject({ code: 'only_n_left', n: 2 })
    expect((await useTap(DAVE, { preservation_log_id: jar, count_used: 1, fate: 'discarded' })).status).toBe(400)
    expect((await useTap(STRANGER, { preservation_log_id: jar, count_used: 1 })).status).toBe(404)
    expect(await usesOf(jar)).toHaveLength(0)
    expect((await readJar(jar)).remaining_count).toBeNull()
  })

  it('JEN taps DAVE\'s jar (household): 201', async () => {
    const jar = await seedJar(DAVE, { count: 2 })
    expect((await useTap(JEN, { preservation_log_id: jar, count_used: 1 })).status).toBe(201)
  })
})

describe.skipIf(!landed('lineSearch'))('GET /api/kitchen-batches/line-search — household, live stock only (§2.2)', () => {
  it('lists DAVE\'s and JEN\'s live jars; never a used-up, consumed, removed or STRANGER jar', async () => {
    const tag = `kfsearch${Date.now().toString(36)}`
    const mk = (owner, o) => seedJar(owner, { notes: tag, ...o })
    const live = await mk(DAVE, { count: 2 })
    const jens = await mk(JEN, { count: 2 })
    const usedUp = await mk(DAVE, { count: 2, remaining: 0 })
    const consumed = await mk(DAVE, { count: 2, remaining: 1, consumed: true })
    const removed = await mk(DAVE, { count: 2, deleted: true })
    const foreign = await mk(STRANGER, { count: 2 })
    // line search matches on label/crop; the jars share a crop, so search by the crop's display text.
    const [{ display_name: q }] = await directSql`SELECT COALESCE(display_name, slug) AS display_name FROM crop_types WHERE slug = (SELECT crop_type_slug FROM preservation_log WHERE id = ${live})`
    const r = await call(DAVE, 'GET', `/api/kitchen-batches/line-search?q=${encodeURIComponent(q)}`)
    expect(r.status, 'line-search must not be captured as a batch id').toBe(200)
    const ids = r.body.put_ups.map((p) => p.preservation_log_id)
    expect(ids).toContain(live)
    expect(ids).toContain(jens)
    for (const x of [usedUp, consumed, removed, foreign]) expect(ids).not.toContain(x)
    const hit = r.body.put_ups.find((p) => p.preservation_log_id === live)
    expect(hit.stock_mode).toBe('counted')
  })
})

describe.skipIf(!landed('draws', 'batchDeleteF1'))('batch removal — F1: aggregate per jar, reverse only the unreversed (§2.1, §3.12)', () => {
  it('two lines in one batch drawing one counted jar: removal restores +2 (one UPDATE), two reversal rows', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 5 })
    await drawCounted(DAVE, b, jar, 1)
    await drawCounted(DAVE, b, jar, 1)
    expect((await readJar(jar)).remaining_count).toBe(3)
    const d = await call(DAVE, 'DELETE', `/api/kitchen-batches/${b}`)
    expect(d.status).toBe(200)
    expect((await readJar(jar)).remaining_count, 'MUTATION ARM: an un-aggregated UPDATE … FROM lines gives 4 here').toBe(5)
    const uses = await usesOf(jar)
    expect(uses.filter((u) => u.count_used < 0)).toHaveLength(2)
    expect((await readBatchRow(b)).deleted_at).not.toBeNull()
    const live = await directSql`SELECT id FROM kitchen_batch_input WHERE batch_id = ${b} AND deleted_at IS NULL`
    expect(live).toHaveLength(0)
  })

  it('a line already taken out is skipped: no double reversal', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 5 })
    const one = await drawCounted(DAVE, b, jar, 1)
    await drawCounted(DAVE, b, jar, 2)
    await call(DAVE, 'DELETE', linePath(b, one.lineId))
    expect((await readJar(jar)).remaining_count).toBe(3)
    expect((await call(DAVE, 'DELETE', `/api/kitchen-batches/${b}`)).status).toBe(200)
    expect((await readJar(jar)).remaining_count).toBe(5)
    const uses = await usesOf(jar)
    expect(uses.reduce((s, u) => s + u.count_used, 0), 'the ledger nets to 0').toBe(0)
    expect(uses.filter((u) => u.count_used < 0)).toHaveLength(2)
  })

  it('two lines drawing one weighed bag (8 g + 5 g): removal restores 13 g', async () => {
    const b = (await seedBatch(DAVE)).id
    const bag = await seedJar(DAVE, { weighed: true })
    await drawGrams(DAVE, b, bag, 8)
    await drawGrams(DAVE, b, bag, 5)
    expect(Number((await readJar(bag)).remaining_amount)).toBe(87)
    expect((await call(DAVE, 'DELETE', `/api/kitchen-batches/${b}`)).status).toBe(200)
    expect(Number((await readJar(bag)).remaining_amount)).toBe(100)
  })

  it('refused while the batch has live jars → 409 has_jars; nothing moves', async () => {
    const b = (await seedBatch(DAVE)).id
    const drawn = await seedJar(DAVE, { count: 3 })
    await drawCounted(DAVE, b, drawn, 1)
    const out = await seedJar(DAVE, { count: 1 })
    await directSql`UPDATE preservation_log SET batch_id = ${b} WHERE id = ${out}`
    const d = await call(DAVE, 'DELETE', `/api/kitchen-batches/${b}`)
    expect(d.status).toBe(409)
    expect(d.body.code).toBe('has_jars')
    expect((await readBatchRow(b)).deleted_at).toBeNull()
    expect((await readJar(drawn)).remaining_count).toBe(2)
  })

  it('STRANGER → 404, batch live', async () => {
    const b = (await seedBatch(DAVE)).id
    expect((await call(STRANGER, 'DELETE', `/api/kitchen-batches/${b}`)).status).toBe(404)
    expect((await readBatchRow(b)).deleted_at).toBeNull()
  })
})

// ── Put it up + Undo (1b §2.4, F1, DS-I4, QA-I9, HS-I3) ─────────────────────────────────────────────
function putUpBody(placeId, { sitting = [], finish = false, rows } = {}) {
  return {
    idempotency_key: key(),
    when: { date: new Date().toISOString().slice(0, 10), precision: 'day' },
    method: 'ferment',
    rows: rows ?? [{ count: 1, container_label: 'pint', size_value: 450, size_unit: 'g', place: { id: placeId } }],
    sitting_lines: sitting.map((l) => ({ idempotency_key: key(), ...l })),
    made_g: 450,
    finish,
  }
}
async function putUp(user, batchId, body) {
  const res = await call(user, 'POST', `/api/kitchen-batches/${batchId}/put-up`, body)
  const [stage] = await directSql`SELECT id FROM kitchen_stage_log WHERE idempotency_key = ${body.idempotency_key}::uuid`
  const jars = stage ? await directSql`SELECT id FROM preservation_log WHERE put_up_stage_id = ${stage.id} AND deleted_at IS NULL` : []
  return { res, stageId: stage?.id ?? null, jarIds: jars.map((j) => j.id) }
}
const undo = (user, b, s) => call(user, 'POST', `/api/kitchen-batches/${b}/put-up/${s}/undo`)

describe.skipIf(!landed('putUp', 'putUpUndo', 'draws'))('Undo that put-up — F1 aggregation and the DS-I4 refusal (§2.4)', () => {
  let place
  beforeAll(async () => { place = await seedPlace(DAVE) })

  it('two sitting lines drawing one weighed bag (8 g at the sitting + 5 g added after) → Undo restores 13 g', async () => {
    const b = (await seedBatch(DAVE)).id
    const bag = await seedJar(DAVE, { weighed: true })
    const p = await putUp(DAVE, b, putUpBody(place, { sitting: [{ input_kind: 'put_up', preservation_log_id: bag, qty: 8, qty_unit: 'g' }] }))
    expect(p.res.status).toBe(201)
    const add = await postLine(DAVE, b, { input_kind: 'put_up', preservation_log_id: bag, qty: 5, qty_unit: 'g', put_up_stage_id: p.stageId })
    expect(add.res.status).toBe(201)
    expect(Number((await readJar(bag)).remaining_amount)).toBe(87)
    const u = await undo(DAVE, b, p.stageId)
    expect(u.status).toBe(200)
    expect(Number((await readJar(bag)).remaining_amount), 'MUTATION ARM: un-aggregated gives 92 or 95').toBe(100)
    const [made] = await directSql`SELECT deleted_at FROM preservation_log WHERE id = ${p.jarIds[0]}`
    expect(made.deleted_at, 'the sitting\'s jars are soft-deleted').not.toBeNull()
    const liveSitting = await directSql`SELECT id FROM kitchen_batch_input WHERE put_up_stage_id = ${p.stageId} AND deleted_at IS NULL`
    expect(liveSitting).toHaveLength(0)
    const voids = await directSql`SELECT id FROM kitchen_stage_log WHERE voids_id = ${p.stageId}`
    expect(voids).toHaveLength(1)
  })

  it('two sitting lines drawing one counted jar → Undo restores +2 with two reversal rows', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 5 })
    const p = await putUp(DAVE, b, putUpBody(place, { sitting: [{ input_kind: 'put_up', preservation_log_id: jar, count_drawn: 1 }] }))
    expect(p.res.status).toBe(201)
    await postLine(DAVE, b, { input_kind: 'put_up', preservation_log_id: jar, count_drawn: 1, put_up_stage_id: p.stageId })
    expect((await readJar(jar)).remaining_count).toBe(3)
    expect((await undo(DAVE, b, p.stageId)).status).toBe(200)
    expect((await readJar(jar)).remaining_count).toBe(5)
    expect((await usesOf(jar)).filter((x) => x.count_used < 0)).toHaveLength(2)
  })

  it('succeeds when only the sitting\'s own lines draw OTHER jars, reversing them in the same statement (QA-I9)', async () => {
    const b = (await seedBatch(DAVE)).id
    const reaper = await seedJar(DAVE, { weighed: true })
    const p = await putUp(DAVE, b, putUpBody(place, { sitting: [{ input_kind: 'put_up', preservation_log_id: reaper, qty: 8, qty_unit: 'g' }] }))
    const u = await undo(DAVE, b, p.stageId)
    expect(u.status).toBe(200)
    expect(Number((await readJar(reaper)).remaining_amount)).toBe(100)
  })

  it('refused (a): an unreversed use of the sitting\'s jar that is not from its own lines → 409 put_up_in_use {jar_ids}', async () => {
    const b = (await seedBatch(DAVE)).id
    const p = await putUp(DAVE, b, putUpBody(place, { rows: [{ count: 3, container_label: 'pint', size_value: 450, size_unit: 'g', place: { id: place } }] }))
    const made = p.jarIds[0]
    await directSql`
      INSERT INTO pantry_use (created_by, preservation_log_id, count_used) VALUES (${DAVE}, ${made}, 1)`
    await directSql`UPDATE preservation_log SET remaining_count = 2 WHERE id = ${made}`
    const u = await undo(DAVE, b, p.stageId)
    expect(u.status).toBe(409)
    expect(u.body.code).toBe('put_up_in_use')
    expect(u.body.jar_ids).toContain(made)
    expect((await readJar(made)).deleted_at).toBeNull()
    expect(await directSql`SELECT id FROM kitchen_stage_log WHERE voids_id = ${p.stageId}`).toHaveLength(0)
  })

  it('refused (b, DS-I4): a live line anywhere draws the sitting\'s jar (a gram draw writes no use) → 409', async () => {
    const b = (await seedBatch(DAVE)).id
    const p = await putUp(DAVE, b, putUpBody(place))
    const made = p.jarIds[0]
    const other = (await seedBatch(JEN)).id
    const d = await drawGrams(JEN, other, made, 10)
    expect(d.res.status).toBe(201)
    const u = await undo(DAVE, b, p.stageId)
    expect(u.status).toBe(409)
    expect(u.body.code).toBe('put_up_in_use')
    expect(u.body.jar_ids).toContain(made)
  })

  it('a second Undo → 200 replay (23505 on uq_ksl_voids_id), one void row, stock moved once', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 4 })
    const p = await putUp(DAVE, b, putUpBody(place, { sitting: [{ input_kind: 'put_up', preservation_log_id: jar, count_drawn: 1 }] }))
    expect((await undo(DAVE, b, p.stageId)).status).toBe(200)
    expect((await undo(DAVE, b, p.stageId)).status).toBe(200)
    expect(await directSql`SELECT id FROM kitchen_stage_log WHERE voids_id = ${p.stageId}`).toHaveLength(1)
    expect((await readJar(jar)).remaining_count).toBe(4)
  })

  it('STRANGER → 404, nothing voided', async () => {
    const b = (await seedBatch(DAVE)).id
    const p = await putUp(DAVE, b, putUpBody(place))
    expect((await undo(STRANGER, b, p.stageId)).status).toBe(404)
    expect(await directSql`SELECT id FROM kitchen_stage_log WHERE voids_id = ${p.stageId}`).toHaveLength(0)
  })
})

// "Draw and use in one statement" (§5.4): a fault planted on THIS jar only (a CHECK naming its id, so the
// files running in parallel are untouched) makes the pantry_use insert fail. If line, use and decrement are
// one statement, nothing lands. Mutation arm: split the draw into two statements → the line survives.
describe.skipIf(!landed('keyedLines', 'draws'))('fault injection — the draw is one statement (§5.4)', () => {
  it('a failing pantry_use insert leaves no line and no decrement', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 3 })
    const name = `kf_fault_${jar.replace(/-/g, '').slice(0, 20)}`
    await directSql(`ALTER TABLE pantry_use ADD CONSTRAINT ${name} CHECK (preservation_log_id <> '${jar}'::uuid) NOT VALID`)
    try {
      const { res, lineId } = await drawCounted(DAVE, b, jar, 1)
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(lineId).toBeNull()
      expect((await readJar(jar)).remaining_count).toBeNull()
    } finally {
      await directSql(`ALTER TABLE pantry_use DROP CONSTRAINT IF EXISTS ${name}`)
    }
  })
})
