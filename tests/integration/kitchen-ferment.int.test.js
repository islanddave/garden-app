// kitchen-ferment.int.test.js — V5-FERMENTPATH-001 (06-ferment-path §5.2 "kitchen-ferment", §5.3 golden table
// through the real routes, §5.4 rows owned by L4; contract-F.md §1.2-§1.3 triggers, §2.1-§2.5). Lane L4.
//
// SCHEMA layer (runs today on the 1b+F fork): the two identity triggers refuse every frozen column by name
// and leave plant_id / deleted_at mutable; plant_id's SET NULL still works on a planting hard delete; the
// kbi and ksl statement-level audit triggers write one row with the actor; the accepted gap (a hard-deleted
// line leaves no audit row); and the premise behind "harvest lines stay a hard delete" (a soft-deleted pick
// line still blocks archiving its planting). Where a §5.4 mutation arm is a schema edit, it is EXECUTED in a
// transaction that is then aborted on purpose (a final 1/<n> the planner cannot fold), so the red it
// produces is observed on the real engine and nothing is left behind.
//
// ROUTE layer (skipped per route until it lands; _kitchenF.js): no_salt vs a salt line, the closed-batch
// policy per route, stage PATCH (allowlist per kind, voided = note-only, loaders, edited_at, audit), the
// ph_read_at bounds, batch removal all-or-nothing and its harvest-line hard delete, planting merge, the F3
// getBatch shape incl. from_garden, and SHU through GET/POST shu-estimate on the §5.3 golden cases.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql } from './_harness.js'
import {
  makeHousehold, useHousehold, routeProbeReport, landed, call, key, errOf, PEPPER,
  seedBatch, seedJar, seedLine, seedPlace, seedPlanting, seedHarvest, closeBatchDirect,
  readJar, usesOf, linesOf, readBatchRow,
} from './_kitchenF.js'

const H = makeHousehold('ferm')
const { DAVE, JEN, STRANGER } = H
useHousehold(H, beforeAll, afterAll)

routeProbeReport(it, expect, 'kitchen-ferment', [
  'keyedLines', 'draws', 'linePatch', 'lineRestore', 'mergePutF', 'stagePostF', 'stagePatch', 'putUp',
  'batchDeleteF1', 'getBatchF3', 'shuEstimate', 'closedPolicyF', 'jarPatch', 'mergeKbi',
])

const bpath = (b, tail = '') => `/api/kitchen-batches/${b}${tail}`

/** POST keyed lines in one request; returns the response and the ids in the order sent (read back by key). */
async function addLines(user, batchId, lines) {
  const keyed = lines.map((l) => ({ idempotency_key: key(), ...l }))
  const res = await call(user, 'POST', bpath(batchId, '/inputs'), { inputs: keyed })
  const ids = []
  for (const l of keyed) {
    // eslint-disable-next-line no-await-in-loop
    const [r] = await directSql`SELECT id FROM kitchen_batch_input WHERE idempotency_key = ${l.idempotency_key}::uuid`
    ids.push(r?.id ?? null)
  }
  return { res, ids }
}
const typed = (label, g, o = {}) => ({ input_kind: 'purchased', label, qty: g, qty_unit: 'g', ...o })
const plain = (label, qty, unit = 'g', o = {}) => ({ input_kind: 'other', label, qty, qty_unit: unit, ...o })
const water = (ml) => ({ input_kind: 'other', label: 'Water', role: 'water', qty: ml, qty_unit: 'ml' })
const salt = (g, pct, base, baseG, method = 'dry', from = 'lines') => ({
  input_kind: 'other', label: 'Salt', role: 'salt', qty: g, qty_unit: 'g',
  salt_pct: pct, salt_base: base, base_g: baseG, salt_method: method, base_from: from,
})

/** Run statements in one transaction and abort it on purpose; returns the SQLSTATE the abort produced. */
async function inRolledBack(stmts, probe) {
  const e = await errOf(() => directSql.transaction([...stmts, probe]))
  return e
}
/** 22012 when n = 0, 22P02 otherwise — never constant-folded, both arms read n. */
const abortWith = (countSql) => directSql(
  `SELECT CASE WHEN t.n = 0 THEN 1 / t.n ELSE (t.n::text || ' rows')::int END FROM (SELECT (${countSql})::int AS n) t`)

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SCHEMA — runs on the 1b+F fork today.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('identity triggers — each frozen column refused by name; plant_id and deleted_at mutable (§1.2, §1.3)', () => {
  let batchId, stageId, lineId, harvestLineId, planting, planting2
  beforeAll(async () => {
    const b = await seedBatch(DAVE)
    batchId = b.id
    stageId = b.startedStageId
    const jar = await seedJar(DAVE)
    lineId = await seedLine(DAVE, batchId, { kind: 'put_up', jarId: jar })
    planting = await seedPlanting(DAVE, { name: 'kf-ident-a' })
    planting2 = await seedPlanting(DAVE, { name: 'kf-ident-b' })
    const hv = await seedHarvest(DAVE, planting)
    ;[{ id: harvestLineId }] = await directSql`
      INSERT INTO kitchen_batch_input (batch_id, input_kind, harvest_log_id, plant_id, created_by)
      VALUES (${batchId}, 'harvest', ${hv}, ${planting.plantId}, ${DAVE}) RETURNING id`
  })

  // The BEFORE ROW trigger fires before CHECK and FK evaluation, so any type-valid new value exercises it.
  it.each([
    ['batch_id', 'batch_id = gen_random_uuid()', 'line'],
    ['created_by', "created_by = created_by || 'x'", 'line'],
    ['input_kind', "input_kind = 'other'", 'line'],
    ['preservation_log_id', 'preservation_log_id = gen_random_uuid()', 'line'],
    ['harvest_log_id', 'harvest_log_id = gen_random_uuid()', 'harvest'],
    ['put_up_stage_id', 'put_up_stage_id = gen_random_uuid()', 'line'],
    ['output_id', 'output_id = gen_random_uuid()', 'line'],
  ])('kitchen_batch_input.%s cannot change (P0001)', async (col, set, which) => {
    const id = which === 'harvest' ? harvestLineId : lineId
    const e = await errOf(() => directSql(`UPDATE kitchen_batch_input SET ${set} WHERE id = $1`, [id]))
    expect(e?.code).toBe('P0001')
    expect(e.message).toContain(`kitchen_batch_input.${col} cannot change`)
  })

  it.each([
    ['batch_id', 'batch_id = gen_random_uuid()'],
    ['stage_kind', "stage_kind = 'noted'"],
    ['voids_id', 'voids_id = gen_random_uuid()'],
    ['created_by', "created_by = created_by || 'x'"],
  ])('kitchen_stage_log.%s cannot change (P0001)', async (col, set) => {
    const e = await errOf(() => directSql(`UPDATE kitchen_stage_log SET ${set} WHERE id = $1`, [stageId]))
    expect(e?.code).toBe('P0001')
    expect(e.message).toContain(`kitchen_stage_log.${col} cannot change`)
  })

  it('plant_id and deleted_at stay mutable (merge repoint; soft delete)', async () => {
    await directSql`UPDATE kitchen_batch_input SET plant_id = ${planting2.plantId} WHERE id = ${harvestLineId}`
    await directSql`UPDATE kitchen_batch_input SET deleted_at = now() WHERE id = ${lineId}`
    await directSql`UPDATE kitchen_batch_input SET deleted_at = NULL WHERE id = ${lineId}`
    const [r] = await directSql`SELECT plant_id FROM kitchen_batch_input WHERE id = ${harvestLineId}`
    expect(r.plant_id).toBe(planting2.plantId)
  })

  it('MUTATION ARM (executed, rolled back): with created_by dropped from each function, the change goes through', async () => {
    const kbiFn = `CREATE OR REPLACE FUNCTION public.prevent_kbi_identity_change() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$`
    const kslFn = `CREATE OR REPLACE FUNCTION public.prevent_ksl_identity_change() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$`
    const e = await inRolledBack([
      directSql(kbiFn), directSql(kslFn),
      directSql(`UPDATE kitchen_batch_input SET created_by = created_by || 'x' WHERE id = $1`, [lineId]),
      directSql(`UPDATE kitchen_stage_log SET created_by = created_by || 'x' WHERE id = $1`, [stageId]),
    ], abortWith('SELECT count(*) FROM kitchen_batch WHERE false'))
    expect(e?.code, 'both UPDATEs succeeded under the mutant, then the probe aborted (22012)').toBe('22012')
    const again = await errOf(() => directSql(`UPDATE kitchen_batch_input SET created_by = created_by || 'x' WHERE id = $1`, [lineId]))
    expect(again?.code, 'the real function is back after the rollback').toBe('P0001')
  })
})

describe('plant_id SET NULL — a planting hard delete is not blocked by the identity trigger (§3.7)', () => {
  it('deleting the planting nulls the line\'s plant_id and succeeds', async () => {
    const b = (await seedBatch(DAVE)).id
    const p = await seedPlanting(DAVE, { name: 'kf-setnull' })
    const [l] = await directSql`
      INSERT INTO kitchen_batch_input (batch_id, input_kind, label, plant_id, created_by)
      VALUES (${b}, 'garden', 'kf garden line', ${p.plantId}, ${DAVE}) RETURNING id`
    await directSql`DELETE FROM entity WHERE planting_ref_id = ${p.plantId}`
    const e = await errOf(() => directSql`DELETE FROM plants WHERE id = ${p.plantId}`)
    expect(e, e?.message).toBeNull()
    const [r] = await directSql`SELECT plant_id FROM kitchen_batch_input WHERE id = ${l.id}`
    expect(r.plant_id).toBeNull()
  })
})

describe('audit — kbi and ksl statement triggers write one row with the actor (§1.2, §1.3, DS-B2)', () => {
  const withActor = (actor, stmt) => directSql.transaction([
    directSql`SELECT set_config('app.actor_clerk_sub', ${actor}, true)`, stmt])
  const auditRows = (id) => directSql`
    SELECT action, actor_clerk_sub, table_name FROM audit_events WHERE row_id::text = ${id} ORDER BY ts, id`

  it('a stage note edit: exactly one UPDATE row, actor DAVE (audit_stmt_update_no_soft_delete)', async () => {
    const b = await seedBatch(DAVE)
    await withActor(DAVE, directSql`UPDATE kitchen_stage_log SET note = 'kf edited' WHERE id = ${b.startedStageId}`)
    const rows = await auditRows(b.startedStageId)
    expect(rows).toEqual([{ action: 'UPDATE', actor_clerk_sub: DAVE, table_name: 'kitchen_stage_log' }])
  })

  it('an unwatched ksl column (created_at) writes no row', async () => {
    const b = await seedBatch(DAVE)
    await withActor(DAVE, directSql`UPDATE kitchen_stage_log SET created_at = created_at - interval '1 second' WHERE id = ${b.startedStageId}`)
    expect(await auditRows(b.startedStageId)).toHaveLength(0)
  })

  it('acts is watched (the §5.4 "drop acts" arm would leave this at 0)', async () => {
    const b = (await seedBatch(DAVE)).id
    const [s] = await directSql`
      INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, created_by)
      VALUES (${b}, 'tended', now(), 'exact', ${DAVE}) RETURNING id`
    await withActor(JEN, directSql`UPDATE kitchen_stage_log SET acts = ARRAY['skimmed'] WHERE id = ${s.id}`)
    expect((await auditRows(s.id)).map((r) => r.actor_clerk_sub)).toEqual([JEN])
  })

  it('MUTATION ARM (executed, rolled back): audit_stmt_update attached to ksl raises inside and writes 0 rows', async () => {
    const b = await seedBatch(DAVE)
    const e = await inRolledBack([
      directSql('DROP TRIGGER trg_audit_kitchen_stage_log_upd ON public.kitchen_stage_log'),
      directSql(`CREATE TRIGGER trg_audit_kitchen_stage_log_upd AFTER UPDATE ON public.kitchen_stage_log
                 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
                 FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update('note')`),
      directSql`SELECT set_config('app.actor_clerk_sub', ${DAVE}, true)`,
      directSql`UPDATE kitchen_stage_log SET note = 'kf mutant' WHERE id = ${b.startedStageId}`,
    ], abortWith(`SELECT count(*) FROM audit_events WHERE row_id::text = '${b.startedStageId}'`))
    expect(e?.code, '22012 = zero audit rows under the mutant (the WARNING swallowed the 42703)').toBe('22012')
  })

  it('a kbi soft delete and a qty edit are audited (deleted_at and qty are watched)', async () => {
    const b = (await seedBatch(DAVE)).id
    const l = await seedLine(DAVE, b, { label: 'kf carrot', qty: 100, unit: 'g' })
    await withActor(DAVE, directSql`UPDATE kitchen_batch_input SET qty = 120 WHERE id = ${l}`)
    await withActor(DAVE, directSql`UPDATE kitchen_batch_input SET deleted_at = now() WHERE id = ${l}`)
    const rows = await auditRows(l)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.actor_clerk_sub === DAVE)).toBe(true)
  })

  it('accepted gap: a hard-deleted line leaves 0 audit rows (statement audit has no DELETE arm)', async () => {
    const b = (await seedBatch(DAVE)).id
    const l = await seedLine(DAVE, b, { label: 'kf gone' })
    await withActor(DAVE, directSql`DELETE FROM kitchen_batch_input WHERE id = ${l}`)
    expect(await auditRows(l)).toHaveLength(0)
  })
})

describe('harvest lines stay a hard delete — the premise (§3.12, RIA-I6)', () => {
  it('a SOFT-deleted pick line still blocks archiving its planting (the §5.4 "soft-delete it" arm)', async () => {
    const b = (await seedBatch(DAVE)).id
    const p = await seedPlanting(DAVE, { name: 'kf-archblock' })
    const hv = await seedHarvest(DAVE, p)
    const [l] = await directSql`
      INSERT INTO kitchen_batch_input (batch_id, input_kind, harvest_log_id, plant_id, created_by, deleted_at)
      VALUES (${b}, 'harvest', ${hv}, ${p.plantId}, ${DAVE}, now()) RETURNING id`
    const e = await errOf(() => directSql`SELECT * FROM archive_plant_events(${p.plantId}::uuid, 'int-test')`)
    expect(e, 'archiving must fail while any kbi row names the pick').not.toBeNull()
    await directSql`DELETE FROM kitchen_batch_input WHERE id = ${l.id}`
    const ok = await errOf(() => directSql`SELECT * FROM archive_plant_events(${p.plantId}::uuid, 'int-test')`)
    expect(ok, ok?.message).toBeNull()
  })

  it('shipped harvest-line DELETE through the route: 200, row gone, 0 audit rows', async () => {
    const b = (await seedBatch(DAVE)).id
    const p = await seedPlanting(DAVE, { name: 'kf-hvdel' })
    const hv = await seedHarvest(DAVE, p)
    const [l] = await directSql`
      INSERT INTO kitchen_batch_input (batch_id, input_kind, harvest_log_id, created_by)
      VALUES (${b}, 'harvest', ${hv}, ${DAVE}) RETURNING id`
    const r = await call(DAVE, 'DELETE', bpath(b, `/inputs/${l.id}`))
    expect(r.status).toBe(200)
    expect(await directSql`SELECT id FROM kitchen_batch_input WHERE id = ${l.id}`).toHaveLength(0)
    expect(await directSql`SELECT id FROM audit_events WHERE row_id::text = ${l.id}`).toHaveLength(0)
    expect((await call(STRANGER, 'DELETE', bpath(b, `/inputs/${l.id}`))).status).toBe(404)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!landed('mergePutF', 'keyedLines', 'lineRestore'))('no_salt vs a live salt line — both ways (§2.1, §3.2)', () => {
  it('PUT no_salt:true with a live salt line → 409 has_salt_line "Take the salt line out first."; no_salt stays NULL', async () => {
    const b = (await seedBatch(DAVE)).id
    await addLines(DAVE, b, [plain('cabbage', 1000), salt(20, 2, 'produce', 1000)])
    const r = await call(DAVE, 'PUT', bpath(b), { no_salt: true })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('has_salt_line')
    expect(r.body.error).toBe('Take the salt line out first.')
    expect((await readBatchRow(b)).no_salt).toBeNull()
  })

  it('no salt line → 200, no_salt true; adding a salt line clears it in the same statement', async () => {
    const b = (await seedBatch(DAVE)).id
    const r = await call(DAVE, 'PUT', bpath(b), { no_salt: true })
    expect(r.status).toBe(200)
    expect(r.body.no_salt).toBe(true)
    await addLines(DAVE, b, [salt(5, 2, 'produce', 250)])
    expect((await readBatchRow(b)).no_salt, 'MUTATION ARM "skip the clear" leaves true here').toBeNull()
  })

  it('a taken-out salt line restored after no_salt was set clears no_salt (a salt line wins)', async () => {
    const b = (await seedBatch(DAVE)).id
    const { ids: [sl] } = await addLines(DAVE, b, [salt(5, 2, 'produce', 250)])
    await call(DAVE, 'DELETE', bpath(b, `/inputs/${sl}`))
    expect((await call(DAVE, 'PUT', bpath(b), { no_salt: true })).status).toBe(200)
    const r = await call(DAVE, 'POST', bpath(b, `/inputs/${sl}/restore`))
    expect(r.status).toBe(200)
    expect((await readBatchRow(b)).no_salt).toBeNull()
  })

  it('no_salt false/null clears; STRANGER → 404', async () => {
    const b = (await seedBatch(DAVE)).id
    await call(DAVE, 'PUT', bpath(b), { no_salt: true })
    expect((await call(DAVE, 'PUT', bpath(b), { no_salt: false })).status).toBe(200)
    expect((await readBatchRow(b)).no_salt).toBeNull()
    expect((await call(STRANGER, 'PUT', bpath(b), { no_salt: true })).status).toBe(404)
  })
})

describe.skipIf(!landed('mergePutF'))('merge PUT — F fields; typed SHU only (§2.1)', () => {
  it('vessel + recipe_ref + typed SHU round-trip; basis written as typed', async () => {
    const b = (await seedBatch(DAVE)).id
    const r = await call(DAVE, 'PUT', bpath(b), {
      vessel_label: 'Quart jar', vessel_size: 1, vessel_unit: 'qt', vessel_count: 2,
      recipe_ref: 'https://example.org/sauce', shu_est_low: 950, shu_est_high: 3000,
    })
    expect(r.status).toBe(200)
    const row = await readBatchRow(b)
    expect(row).toMatchObject({ vessel_label: 'Quart jar', vessel_unit: 'qt', vessel_count: 2, recipe_ref: 'https://example.org/sauce', shu_est_low: 950, shu_est_high: 3000, shu_est_basis: 'typed' })
    expect(Number(row.vessel_size)).toBe(1)
  })

  it("basis 'computed' in a PUT body → 400 (computed is written only by /shu-estimate/save)", async () => {
    const b = (await seedBatch(DAVE)).id
    const r = await call(DAVE, 'PUT', bpath(b), { shu_est_low: 1, shu_est_high: 2, shu_est_basis: 'computed' })
    expect(r.status).toBe(400)
    expect((await readBatchRow(b)).shu_est_basis).toBeNull()
  })
})

describe.skipIf(!landed('closedPolicyF', 'keyedLines', 'linePatch', 'lineRestore', 'stagePatch', 'mergePutF', 'putUp', 'jarPatch'))(
  'closed batch — content writes accepted, a new sitting refused with the door (§3.13)', () => {
    let b, line, place
    beforeAll(async () => {
      b = (await seedBatch(DAVE)).id
      place = await seedPlace(DAVE)
      await closeBatchDirect(b, DAVE)
    })
    it('line POST → 201', async () => {
      const { res, ids } = await addLines(DAVE, b, [plain('carrot', 150)])
      expect(res.status).toBe(201)
      line = ids[0]
    })
    it('line PATCH → 200 and edited_at stamped', async () => {
      const r = await call(DAVE, 'PATCH', bpath(b, `/inputs/${line}`), { note: 'after bottling' })
      expect(r.status).toBe(200)
      const [l] = await directSql`SELECT note, edited_at FROM kitchen_batch_input WHERE id = ${line}`
      expect(l.note).toBe('after bottling')
      expect(l.edited_at).not.toBeNull()
    })
    it('line DELETE → 200, restore → 200', async () => {
      expect((await call(DAVE, 'DELETE', bpath(b, `/inputs/${line}`))).status).toBe(200)
      expect((await call(DAVE, 'POST', bpath(b, `/inputs/${line}/restore`))).status).toBe(200)
    })
    it('stage POST → 201 (as today)', async () => {
      expect((await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'noted', note: 'kf closed note' })).status).toBe(201)
    })
    it('stage PATCH on the finished row\'s note → 200', async () => {
      const [f] = await directSql`SELECT id FROM kitchen_stage_log WHERE batch_id = ${b} AND stage_kind = 'finished'`
      expect((await call(DAVE, 'PATCH', bpath(b, `/stages/${f.id}`), { note: 'tasted great' })).status).toBe(200)
    })
    it('merge PUT (label, typed SHU) → 200', async () => {
      expect((await call(DAVE, 'PUT', bpath(b), { label: 'kf renamed after close', shu_est_low: 10, shu_est_high: 20 })).status).toBe(200)
    })
    it('a jar of the closed batch: PATCH → 200', async () => {
      const jar = await seedJar(DAVE, { count: 1 })
      await directSql`UPDATE preservation_log SET batch_id = ${b} WHERE id = ${jar}`
      expect((await call(DAVE, 'PATCH', `/api/preservation/${jar}`, { notes: 'kf closed jar note' })).status).toBe(200)
    })
    it('a new put-up sitting → 409 batch_closed, with the door words and reopen:true; nothing written', async () => {
      const k = key()
      const r = await call(DAVE, 'POST', bpath(b, '/put-up'), {
        idempotency_key: k, when: { date: new Date().toISOString().slice(0, 10), precision: 'day' }, method: 'ferment',
        rows: [{ count: 1, container_label: 'pint', size_value: 450, size_unit: 'g', place: { id: place } }], finish: true,
      })
      expect(r.status).toBe(409)
      expect(r.body).toMatchObject({ code: 'batch_closed', reopen: true, error: 'This batch is finished. Reopen it to bottle more →' })
      expect(await directSql`SELECT id FROM kitchen_stage_log WHERE idempotency_key = ${k}::uuid`).toHaveLength(0)
    })
  })

describe.skipIf(!landed('stagePostF', 'stagePatch'))('stages — acts, ph_read_at bounds, PATCH allowlist per kind (§2.3)', () => {
  let place, foreignPlace, foreignPhoto
  beforeAll(async () => {
    place = await seedPlace(DAVE)
    foreignPlace = await seedPlace(STRANGER)
    const sp = await seedPlanting(STRANGER, { name: 'kf-photo' })
    ;[{ id: foreignPhoto }] = await directSql`
      INSERT INTO photos (project_id, storage_path, created_by)
      VALUES (${sp.projectId}, ${`kf/${STRANGER}.jpg`}, ${STRANGER}) RETURNING id`
  })
  const future = () => new Date(Date.now() + 10 * 60e3).toISOString()
  const beforeStart = () => new Date(Date.now() - 30 * 864e5).toISOString()

  it('tended acts are de-duplicated; one audit row per PATCH with the actor', async () => {
    const b = (await seedBatch(DAVE)).id
    const r = await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'tended', acts: ['skimmed', 'skimmed', 'topped_up'], amount: 250, amount_unit: 'ml' })
    expect(r.status).toBe(201)
    const [s] = await directSql`SELECT id, acts FROM kitchen_stage_log WHERE id = ${r.body.stage.id}`
    expect([...s.acts].sort()).toEqual(['skimmed', 'topped_up'])
    const p = await call(DAVE, 'PATCH', bpath(b, `/stages/${s.id}`), { note: 'film on top' })
    expect(p.status).toBe(200)
    const aud = await directSql`SELECT actor_clerk_sub FROM audit_events WHERE row_id::text = ${s.id}`
    expect(aud.map((a) => a.actor_clerk_sub)).toEqual([DAVE])
    const [e] = await directSql`SELECT edited_at FROM kitchen_stage_log WHERE id = ${s.id}`
    expect(e.edited_at).not.toBeNull()
  })

  it('acts on a non-tended row → 400', async () => {
    const b = (await seedBatch(DAVE)).id
    expect((await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'noted', acts: ['skimmed'] })).status).toBe(400)
  })

  it.each([
    ['in the future (> now + 5 min)', future],
    ['before the batch start', beforeStart],
  ])('ph_read_at %s → 400 on POST and on PATCH (MUTATION ARM: drop the upper bound)', async (_n, when) => {
    const b = (await seedBatch(DAVE, { startedDaysAgo: 3 })).id
    const post = await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'tended', ph_reading: '3.9', ph_read_at: when() })
    expect(post.status).toBe(400)
    const ok = await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'tended', ph_reading: '3.9', ph_read_at: new Date().toISOString() })
    expect(ok.status).toBe(201)
    const patch = await call(DAVE, 'PATCH', bpath(b, `/stages/${ok.body.stage.id}`), { ph_reading: '3.8', ph_read_at: when() })
    expect(patch.status).toBe(400)
    const [s] = await directSql`SELECT ph_reading FROM kitchen_stage_log WHERE id = ${ok.body.stage.id}`
    expect(String(s.ph_reading)).toBe('3.9')
  })

  it('PATCH loaders: a foreign place → 400, a foreign photo → 400; an owned place → 200', async () => {
    const b = (await seedBatch(DAVE)).id
    const mv = await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'moved', storage_location_id: place })
    expect(mv.status).toBe(201)
    const id = mv.body.stage.id
    expect((await call(DAVE, 'PATCH', bpath(b, `/stages/${id}`), { storage_location_id: foreignPlace })).status).toBe(400)
    expect((await call(DAVE, 'PATCH', bpath(b, `/stages/${id}`), { photo_id: foreignPhoto })).status).toBe(400)
    expect((await call(DAVE, 'PATCH', bpath(b, `/stages/${id}`), { storage_location_id: place })).status).toBe(200)
  })

  it('allowlist: entered_at on started → 400; a voided row takes a note but not an amount; stage_kind → 400', async () => {
    const b = await seedBatch(DAVE)
    expect((await call(DAVE, 'PATCH', bpath(b.id, `/stages/${b.startedStageId}`), { entered_at: new Date().toISOString(), entered_precision: 'exact' })).status).toBe(400)
    expect((await call(DAVE, 'PATCH', bpath(b.id, `/stages/${b.startedStageId}`), { stage_kind: 'noted' })).status).toBe(400)
    const t = await call(DAVE, 'POST', bpath(b.id, '/stages'), { stage_kind: 'tended', note: 'kf to void' })
    const v = await call(DAVE, 'POST', bpath(b.id, '/stages'), { stage_kind: 'void', voids_id: t.body.stage.id })
    expect(v.status).toBe(201)
    const vid = v.body.stage.id
    expect((await call(DAVE, 'PATCH', bpath(b.id, `/stages/${vid}`), { amount: 5, amount_unit: 'g' })).status).toBe(400)
    expect((await call(DAVE, 'PATCH', bpath(b.id, `/stages/${vid}`), { note: 'typo' })).status).toBe(200)
    const again = await call(DAVE, 'POST', bpath(b.id, '/stages'), { stage_kind: 'void', voids_id: t.body.stage.id })
    expect(again.status, 'a second void of the same row is a replay').toBe(200)
  })

  it('started: "About ___ in it" is the started row\'s amount; STRANGER PATCH → 404', async () => {
    const b = await seedBatch(DAVE)
    expect((await call(DAVE, 'PATCH', bpath(b.id, `/stages/${b.startedStageId}`), { amount: 448, amount_unit: 'g' })).status).toBe(200)
    expect((await call(STRANGER, 'PATCH', bpath(b.id, `/stages/${b.startedStageId}`), { note: 'x' })).status).toBe(404)
    const [s] = await directSql`SELECT amount, amount_unit FROM kitchen_stage_log WHERE id = ${b.startedStageId}`
    expect([Number(s.amount), s.amount_unit]).toEqual([448, 'g'])
  })
})

describe.skipIf(!landed('linePatch', 'keyedLines', 'draws'))('line PATCH — allowlist and the weighed-draw delta (§2.2)', () => {
  it('Petri card: salt grams edited 15.7 → 13.5 keeps salt_pct 3.5 as aimed', async () => {
    const b = (await seedBatch(DAVE)).id
    const { ids: [sl] } = await addLines(DAVE, b, [salt(15.68, 3.5, 'all', 448, 'brine')])
    const [before] = await directSql`SELECT qty FROM kitchen_batch_input WHERE id = ${sl}`
    expect(String(before.qty), 'golden: salt 15.68 stored').toBe('15.68')
    const r = await call(DAVE, 'PATCH', bpath(b, `/inputs/${sl}`), { qty: 13.5, qty_unit: 'g' })
    expect(r.status).toBe(200)
    const [l] = await directSql`SELECT qty, salt_pct, base_g FROM kitchen_batch_input WHERE id = ${sl}`
    expect([Number(l.qty), Number(l.salt_pct), Number(l.base_g)]).toEqual([13.5, 3.5, 448])
  })

  it.each([['input_kind', 'other'], ['preservation_log_id', '00000000-0000-4000-8000-000000000000'], ['count_drawn', 2], ['plant_id', null]])(
    'a %s in the body → 400 "take it out and add it again"', async (k, v) => {
      const b = (await seedBatch(DAVE)).id
      const { ids: [l] } = await addLines(DAVE, b, [plain('carrot', 150)])
      const r = await call(DAVE, 'PATCH', bpath(b, `/inputs/${l}`), { [k]: v })
      expect(r.status).toBe(400)
      expect(r.body.error).toMatch(/take it out and add it again/i)
    })

  it('role NULL → water allowed; → salt refused', async () => {
    const b = (await seedBatch(DAVE)).id
    const { ids: [l] } = await addLines(DAVE, b, [plain('brine water', 250, 'ml')])
    expect((await call(DAVE, 'PATCH', bpath(b, `/inputs/${l}`), { role: 'water' })).status).toBe(200)
    expect((await call(DAVE, 'PATCH', bpath(b, `/inputs/${l}`), { role: 'salt' })).status).toBe(400)
  })

  it('weighed draw 8 g → 12 g moves the bag −4 g; → 200 g is refused 409 only_g_left; → ml is 400', async () => {
    const b = (await seedBatch(DAVE)).id
    const bag = await seedJar(DAVE, { weighed: true })
    const { ids: [l] } = await addLines(DAVE, b, [{ input_kind: 'put_up', preservation_log_id: bag, qty: 8, qty_unit: 'g' }])
    expect((await call(DAVE, 'PATCH', bpath(b, `/inputs/${l}`), { qty: 12, qty_unit: 'g' })).status).toBe(200)
    expect(Number((await readJar(bag)).remaining_amount)).toBe(88)
    const over = await call(DAVE, 'PATCH', bpath(b, `/inputs/${l}`), { qty: 200, qty_unit: 'g' })
    expect(over.status).toBe(409)
    expect(over.body.code).toBe('only_g_left')
    expect((await call(DAVE, 'PATCH', bpath(b, `/inputs/${l}`), { qty: 12, qty_unit: 'ml' })).status).toBe(400)
    expect(Number((await readJar(bag)).remaining_amount)).toBe(88)
  })

  it('a counted draw\'s qty is free: no stock moves', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 3, qty: 1, unit: 'bag' })
    const { ids: [l] } = await addLines(DAVE, b, [{ input_kind: 'put_up', preservation_log_id: jar, count_drawn: 1, qty: 150, qty_unit: 'g' }])
    expect((await call(DAVE, 'PATCH', bpath(b, `/inputs/${l}`), { qty: 160, qty_unit: 'g' })).status).toBe(200)
    expect((await readJar(jar)).remaining_count).toBe(2)
  })

  it('a taken-out line → 404', async () => {
    const b = (await seedBatch(DAVE)).id
    const { ids: [l] } = await addLines(DAVE, b, [plain('carrot', 150)])
    await directSql`UPDATE kitchen_batch_input SET deleted_at = now() WHERE id = ${l}`
    expect((await call(DAVE, 'PATCH', bpath(b, `/inputs/${l}`), { note: 'x' })).status).toBe(404)
  })
})

describe.skipIf(!landed('batchDeleteF1', 'keyedLines', 'draws'))('batch removal — all or nothing; pick lines hard-deleted (§3.12, QA-I8, RIA-I6)', () => {
  it('a planted failure on the 2nd jar\'s reversal aborts EVERYTHING: no line out, no use, batch live, jar 1 unchanged', async () => {
    const b = (await seedBatch(DAVE)).id
    const j1 = await seedJar(DAVE, { count: 4 })
    const j2 = await seedJar(DAVE, { count: 4 })
    await addLines(DAVE, b, [
      { input_kind: 'put_up', preservation_log_id: j1, count_drawn: 1 },
      { input_kind: 'put_up', preservation_log_id: j2, count_drawn: 1 },
    ])
    const name = `kf_fault_${j2.replace(/-/g, '').slice(0, 20)}`
    await directSql(`ALTER TABLE pantry_use ADD CONSTRAINT ${name} CHECK (NOT (preservation_log_id = '${j2}'::uuid AND count_used < 0)) NOT VALID`)
    try {
      const r = await call(DAVE, 'DELETE', bpath(b))
      expect(r.status).toBeGreaterThanOrEqual(400)
    } finally {
      await directSql(`ALTER TABLE pantry_use DROP CONSTRAINT IF EXISTS ${name}`)
    }
    expect((await readBatchRow(b)).deleted_at).toBeNull()
    expect(await directSql`SELECT id FROM kitchen_batch_input WHERE batch_id = ${b} AND deleted_at IS NOT NULL`).toHaveLength(0)
    expect((await usesOf(j1)).map((u) => u.count_used)).toEqual([1])
    expect((await readJar(j1)).remaining_count).toBe(3)
    expect((await readJar(j2)).remaining_count).toBe(3)
  })

  it('removing a batch hard-deletes its pick line, so archiving that planting afterwards succeeds (RIA-I6)', async () => {
    const b = (await seedBatch(DAVE)).id
    const p = await seedPlanting(DAVE, { name: 'kf-rmarch' })
    const hv = await seedHarvest(DAVE, p)
    const { res } = await addLines(DAVE, b, [{ input_kind: 'harvest', harvest_log_id: hv }])
    expect(res.status).toBe(201)
    const [line] = await directSql`SELECT plant_id, label FROM kitchen_batch_input WHERE batch_id = ${b} AND harvest_log_id = ${hv}`
    expect(line.plant_id, 'plant_id copied server-side from the pick\'s planting').toBe(p.plantId)
    expect((await call(DAVE, 'DELETE', bpath(b))).status).toBe(200)
    expect(await directSql`SELECT id FROM kitchen_batch_input WHERE harvest_log_id = ${hv}`).toHaveLength(0)
    const e = await errOf(() => directSql`SELECT * FROM archive_plant_events(${p.plantId}::uuid, 'int-test')`)
    expect(e, e?.message).toBeNull()
  })

  it('the same pick twice → 409 already_in "That pick is already in this batch."', async () => {
    const b = (await seedBatch(DAVE)).id
    const p = await seedPlanting(DAVE, { name: 'kf-already' })
    const hv = await seedHarvest(DAVE, p)
    expect((await addLines(DAVE, b, [{ input_kind: 'harvest', harvest_log_id: hv }])).res.status).toBe(201)
    const r = await addLines(DAVE, b, [{ input_kind: 'harvest', harvest_log_id: hv }])
    expect(r.res.status).toBe(409)
    expect(r.res.body).toMatchObject({ code: 'already_in', error: 'That pick is already in this batch.' })
  })
})

describe.skipIf(!landed('getBatchF3', 'keyedLines', 'draws', 'lineRestore'))('GET /:id — the F3 shape (§2.1, §2.7)', () => {
  it('live lines only, ordinal order, from_garden on 4 branches (+ typed false), count_drawn, garden_names; stages incl. void; outputs stock_mode', async () => {
    const b = (await seedBatch(DAVE)).id
    const p = await seedPlanting(DAVE, { name: 'kf-shape' })
    const hv = await seedHarvest(DAVE, p)
    const ownJar = await seedJar(DAVE, { count: 3, sourceKind: 'own_garden' })
    const boughtJar = await seedJar(DAVE, { count: 3, sourceKind: 'purchased' })
    const multiJar = await seedJar(DAVE, { count: 3, sourceKind: 'purchased' })
    // The 4th from_garden branch: a bought jar whose preservation_source rows include own_garden.
    await directSql`
      INSERT INTO preservation_source (preservation_log_id, user_id, source_kind, display_label, provenance_grade, crop_type_slug)
      SELECT ${multiJar}, ${DAVE}, 'own_garden', 'kf garden share', 'crop', crop_type_slug
      FROM preservation_log WHERE id = ${multiJar}`
    const { ids } = await addLines(DAVE, b, [
      { input_kind: 'garden', plant_id: p.plantId, label: 'kf planting line', qty: 412, qty_unit: 'g', ordinal: 2 },
      { input_kind: 'harvest', harvest_log_id: hv, ordinal: 1 },
      { input_kind: 'put_up', preservation_log_id: ownJar, count_drawn: 2, ordinal: 3 },
      { input_kind: 'put_up', preservation_log_id: boughtJar, count_drawn: 1, ordinal: 4 },
      { input_kind: 'put_up', preservation_log_id: multiJar, count_drawn: 1, ordinal: 5 },
      typed('store onion', 20, { ordinal: 6 }),
      typed('kf removed', 5, { ordinal: 7 }),
    ])
    await call(DAVE, 'DELETE', bpath(b, `/inputs/${ids[6]}`))
    const bag = await seedJar(DAVE, { weighed: true })
    await directSql`UPDATE preservation_log SET batch_id = ${b} WHERE id = ${bag}`
    const g = await call(DAVE, 'GET', bpath(b))
    expect(g.status).toBe(200)
    const got = g.body.inputs.map((l) => l.id)
    expect(got).toEqual([ids[1], ids[0], ids[2], ids[3], ids[4], ids[5]])
    const by = Object.fromEntries(g.body.inputs.map((l) => [l.id, l]))
    expect(by[ids[0]].from_garden).toBe(true)
    expect(by[ids[1]].from_garden).toBe(true)
    expect(by[ids[2]].from_garden).toBe(true)
    expect(by[ids[3]].from_garden).toBe(false)
    expect(by[ids[5]].from_garden).toBe(false)
    expect(by[ids[2]].count_drawn).toBe(2)
    expect(by[ids[5]].count_drawn ?? null).toBeNull()
    expect(g.body.inputs.every((l) => !('idempotency_key' in l))).toBe(true)
    expect(Array.isArray(g.body.garden_names)).toBe(true)
    expect(g.body.garden_names.length).toBeGreaterThan(0)
    const out = g.body.outputs.find((o) => o.id === bag)
    expect(out.stock_mode).toBe('weighed')
    expect('use_by_status' in out || 'use_by_target' in out, 'standing ruling: use-by stays OFF this projection').toBe(false)
    expect(g.body).toHaveProperty('vessel_label')
    expect(g.body).toHaveProperty('recipe_ref')
    expect((await call(STRANGER, 'GET', bpath(b))).status).toBe(404)
    expect((await call(JEN, 'GET', bpath(b))).status).toBe(200)
  })
})

describe.skipIf(!landed('mergeKbi', 'getBatchF3'))('planting merge repoints live AND taken-out garden lines (RIA-I3)', () => {
  it('both lines point at the winner after POST /api/plants/:winner/merge', async () => {
    const { handler: plantsHandler } = await import('../../lambda/plants/index.js')
    const { callHandler } = await import('./_harness.js')
    const proj = await seedPlanting(DAVE, { name: 'kf-merge-w' })
    const [{ id: loser }] = await directSql`
      INSERT INTO plants (project_id, name, created_by) VALUES (${proj.projectId}, ${`kf-merge-l-${DAVE}`}, ${DAVE}) RETURNING id`
    const b = (await seedBatch(DAVE)).id
    const [{ id: live }] = await directSql`
      INSERT INTO kitchen_batch_input (batch_id, input_kind, label, plant_id, qty, qty_unit, created_by)
      VALUES (${b}, 'garden', 'kf live', ${loser}, 100, 'g', ${DAVE}) RETURNING id`
    const [{ id: out }] = await directSql`
      INSERT INTO kitchen_batch_input (batch_id, input_kind, label, plant_id, created_by, deleted_at)
      VALUES (${b}, 'garden', 'kf out', ${loser}, ${DAVE}, now()) RETURNING id`
    const r = await callHandler(plantsHandler, { method: 'POST', path: `/api/plants/${proj.plantId}/merge`, body: { loser_ids: [loser], op_id: key() }, userId: DAVE })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const rows = await directSql`SELECT id, plant_id FROM kitchen_batch_input WHERE id IN (${live}, ${out})`
    expect(rows.every((x) => x.plant_id === proj.plantId)).toBe(true)
  })
})

// ── §5.3 golden table, through the real routes ─────────────────────────────────────────────────────
const shu = (user, b, q = 'scope=batch') => call(user, 'GET', bpath(b, `/shu-estimate?${q}`))
const half = (x) => Math.floor(Number(x) + 0.5)
function putUpBody(place, { made, mash = undefined, finish = false, rows } = {}) {
  return {
    idempotency_key: key(), when: { date: new Date().toISOString().slice(0, 10), precision: 'day' }, method: 'ferment',
    rows: rows ?? [{ count: 1, container_label: 'bottle', size_value: made, size_unit: 'g', place: { id: place } }],
    made_g: made, ...(mash === undefined ? {} : { mash_in_g: mash }), finish,
  }
}
async function putUp(user, b, body) {
  const res = await call(user, 'POST', bpath(b, '/put-up'), body)
  const [s] = await directSql`SELECT id FROM kitchen_stage_log WHERE idempotency_key = ${body.idempotency_key}::uuid`
  const jars = s ? await directSql`SELECT id FROM preservation_log WHERE put_up_stage_id = ${s.id} ORDER BY created_at, id` : []
  return { res, stageId: s?.id, jarIds: jars.map((j) => j.id) }
}

describe.skipIf(!landed('shuEstimate', 'keyedLines'))('§5.3 golden — SHU in the jar now (batch scope)', () => {
  it('Petri: jalapeño 170 g @ 2,500-8,000, garlic 8, onion 20, water 250 ml → base 448; 948.7→949 / 3035.7→3036; save stores computed', async () => {
    const b = (await seedBatch(DAVE)).id
    await addLines(DAVE, b, [
      typed('jalapeño', 170, { form: 'fresh', shu_rating_low: 2500, shu_rating_high: 8000 }),
      plain('garlic', 8), plain('onion', 20), water(250), salt(15.68, 3.5, 'all', 448, 'brine'),
    ])
    const r = await shu(DAVE, b)
    expect(r.status).toBe(200)
    expect(r.body.refusal).toBeUndefined()
    expect(Number(r.body.denominator_g)).toBeCloseTo(448, 6)
    expect(half(r.body.low)).toBe(949)
    expect(half(r.body.high)).toBe(3036)
    expect(r.body.breakdown.map((x) => x.label)).toEqual(['jalapeño'])
    const s = await call(DAVE, 'POST', bpath(b, '/shu-estimate/save'), { scope: 'batch' })
    expect(s.status).toBe(200)
    expect(s.body).toMatchObject({ shu_est_low: 949, shu_est_high: 3036, shu_est_basis: 'computed' })
    const row = await readBatchRow(b)
    expect([row.shu_est_low, row.shu_est_high, row.shu_est_basis]).toEqual([949, 3036, 'computed'])
  })

  it('a stored computed figure is not recomputed silently: a later line → getBatch flags shu_est_stale, row unchanged', async () => {
    const b = (await seedBatch(DAVE)).id
    await addLines(DAVE, b, [typed('jalapeño', 170, { form: 'fresh', shu_rating_low: 2500, shu_rating_high: 8000 }), plain('onion', 30)])
    await call(DAVE, 'POST', bpath(b, '/shu-estimate/save'), { scope: 'batch' })
    const saved = await readBatchRow(b)
    await addLines(DAVE, b, [plain('carrot', 200)])
    const row = await readBatchRow(b)
    expect([row.shu_est_low, row.shu_est_high]).toEqual([saved.shu_est_low, saved.shu_est_high])
    if (landed('getBatchF3')) expect((await call(DAVE, 'GET', bpath(b))).body.shu_est_stale).toBe(true)
  })

  it('Kimchi: gochugaru 40 g dried with no rating → refusal naming it (never 0); save → 409 shu_cannot_compute', async () => {
    const b = (await seedBatch(DAVE)).id
    const { ids } = await addLines(DAVE, b, [
      plain('napa cabbage', 1500), plain('radish', 300), typed('gochugaru', 40, { form: 'dried' }),
      plain('garlic', 20), plain('ginger', 10), plain('fish sauce', 30, 'ml'),
      salt(200, 10, 'water', 2000, 'rinsed', 'scale'), salt(18.7, 1, 'produce', 1870, 'dry'),
    ])
    const r = await shu(DAVE, b)
    expect(r.status).toBe(200)
    expect(r.body.refusal).toBe('cannot_work_it_out')
    expect(r.body.missing).toEqual([expect.objectContaining({ line_id: ids[2], label: 'gochugaru', why: 'no_rating' })])
    expect(r.body.low, 'never 0 from absence').toBeUndefined()
    const s = await call(DAVE, 'POST', bpath(b, '/shu-estimate/save'), { scope: 'batch' })
    expect(s.status).toBe(409)
    expect(s.body).toMatchObject({ code: 'shu_cannot_compute', refusal: 'cannot_work_it_out' })
    expect((await readBatchRow(b)).shu_est_basis).toBeNull()
  })

  it('Kimchi with a typed (fresh-pepper) rating 1,000-2,000 on the dried line: ×7/×10 over 1,870 g (soak water in no denominator)', async () => {
    const b = (await seedBatch(DAVE)).id
    await addLines(DAVE, b, [
      plain('napa cabbage', 1500), plain('radish', 300),
      typed('gochugaru', 40, { form: 'dried', shu_rating_low: 1000, shu_rating_high: 2000 }),
      plain('garlic', 20), plain('ginger', 10), plain('fish sauce', 30, 'ml'),
      salt(200, 10, 'water', 2000, 'rinsed', 'scale'),
    ])
    const r = await shu(DAVE, b)
    expect(Number(r.body.denominator_g)).toBeCloseTo(1870, 6)
    expect(half(r.body.low)).toBe(150)
    expect(half(r.body.high)).toBe(428)
    const g = r.body.breakdown.find((x) => x.label === 'gochugaru')
    expect([g.factor_low, g.factor_high]).toEqual([7, 10])
  })

  it('no heat lines → refusal no_heat_lines (kraut: cabbage 1,000 g + 20.0 g salt)', async () => {
    const b = (await seedBatch(DAVE)).id
    await addLines(DAVE, b, [plain('cabbage', 1000), salt(20, 2, 'produce', 1000)])
    const r = await shu(DAVE, b)
    expect(r.body.refusal).toBe('no_heat_lines')
  })

  it('a typed "chili" line with no rating counts as a heat line → refusal, not no_heat_lines', async () => {
    const b = (await seedBatch(DAVE)).id
    await addLines(DAVE, b, [plain('dried thai chili', 10), plain('cabbage', 500)])
    expect((await shu(DAVE, b)).body.refusal).toBe('cannot_work_it_out')
  })

  it('Units: reaper 0.5 oz = 14.17 g counted; vinegar 30 ml "no weight"; "About 2 cups" ignored', async () => {
    const b = await seedBatch(DAVE)
    await addLines(DAVE, b.id, [
      { input_kind: 'purchased', label: 'reaper', qty: 0.5, qty_unit: 'oz', form: 'fresh', shu_rating_low: 1000000, shu_rating_high: 2000000 },
      plain('vinegar', 30, 'ml'), plain('carrot', 100),
    ])
    await directSql`UPDATE kitchen_stage_log SET amount = 2, amount_unit = 'cup' WHERE id = ${b.startedStageId}`
    const r = await shu(DAVE, b.id)
    const reaper = r.body.breakdown.find((x) => x.label === 'reaper')
    expect(Number(reaper.grams)).toBeCloseTo(14.17475, 4)
    expect(Number(r.body.denominator_g)).toBeCloseTo(114.17475, 4)
  })

  it('"About 500 g in it" (started row, g) is the denominator when set in a mass unit', async () => {
    const b = await seedBatch(DAVE)
    await addLines(DAVE, b.id, [typed('jalapeño', 100, { form: 'fresh', shu_rating_low: 1000, shu_rating_high: 2000 }), plain('carrot', 100)])
    await directSql`UPDATE kitchen_stage_log SET amount = 500, amount_unit = 'g' WHERE id = ${b.startedStageId}`
    const r = await shu(DAVE, b.id)
    expect(Number(r.body.denominator_g)).toBeCloseTo(500, 6)
    expect(half(r.body.low)).toBe(200)
  })

  it('STRANGER → 404', async () => {
    const b = (await seedBatch(DAVE)).id
    expect((await shu(STRANGER, b)).status).toBe(404)
  })
})

describe.skipIf(!landed('shuEstimate', 'keyedLines', 'putUp', 'stagePatch'))('§5.3 golden — sittings and rows', () => {
  let place
  beforeAll(async () => { place = await seedPlace(DAVE) })

  it('Petri bottled: one sitting, Made 256 g → 1660.2→1660 / 5312.5→5313; row with no additions = the sitting', async () => {
    const b = (await seedBatch(DAVE)).id
    await addLines(DAVE, b, [
      typed('jalapeño', 170, { form: 'fresh', shu_rating_low: 2500, shu_rating_high: 8000 }),
      plain('garlic', 8), plain('onion', 20), water(250),
    ])
    const p = await putUp(DAVE, b, putUpBody(place, { made: 256 }))
    expect(p.res.status).toBe(201)
    const s = await shu(DAVE, b, `scope=sitting&id=${p.stageId}`)
    expect(half(s.body.low)).toBe(1660)
    expect(half(s.body.high)).toBe(5313)
    const j = await shu(DAVE, b, `scope=jar&id=${p.jarIds[0]}`)
    expect([half(j.body.low), half(j.body.high)]).toEqual([1660, 5313])
  })

  it('Settlers: Ristra 150 g @ 24,200-34,800, sugar 2 g, salt 4.5 g, Made 227 → 15,991 / 22,996', async () => {
    const b = (await seedBatch(DAVE)).id
    const { ids } = await addLines(DAVE, b, [
      typed('Ristra cayenne', 150, { form: 'fresh', shu_rating_low: 24200, shu_rating_high: 34800 }),
      plain('sugar', 2), salt(4.5, 3, 'produce', 152, 'dry'),
    ])
    const [sl] = await directSql`SELECT qty, base_g FROM kitchen_batch_input WHERE id = ${ids[2]}`
    expect(Number(sl.qty) / Number(sl.base_g) * 100, 'card 4.5 g of 152 g → 2.96 %, shown "3.0%"').toBeCloseTo(2.96, 2)
    const p = await putUp(DAVE, b, putUpBody(place, { made: 227 }))
    const s = await shu(DAVE, b, `scope=sitting&id=${p.stageId}`)
    expect([half(s.body.low), half(s.body.high)]).toEqual([15991, 22996])
    const save = await call(DAVE, 'POST', bpath(b, '/shu-estimate/save'), { scope: 'jar', id: p.jarIds[0] })
    expect(save.status).toBe(200)
    const [jr] = await directSql`SELECT shu_est_low, shu_est_high, shu_est_basis FROM preservation_log WHERE id = ${p.jarIds[0]}`
    expect(jr).toEqual({ shu_est_low: 15991, shu_est_high: 22996, shu_est_basis: 'computed' })
  })

  it('Multi-sitting: mash_in 100 / 50, Made 100 each → the batch splits 2/3 : 1/3 (MUTATION ARM: divide by one sitting)', async () => {
    const b = (await seedBatch(DAVE)).id
    await addLines(DAVE, b, [typed('Ristra cayenne', 150, { form: 'fresh', shu_rating_low: 24200, shu_rating_high: 34800 })])
    const a = await putUp(DAVE, b, putUpBody(place, { made: 100, mash: 100 }))
    const c = await putUp(DAVE, b, putUpBody(place, { made: 100, mash: 50 }))
    expect([a.res.status, c.res.status]).toEqual([201, 201])
    const sa = await shu(DAVE, b, `scope=sitting&id=${a.stageId}`)
    const sc = await shu(DAVE, b, `scope=sitting&id=${c.stageId}`)
    expect([half(sa.body.low), half(sa.body.high)]).toEqual([24200, 34800])
    expect([half(sc.body.low), half(sc.body.high)]).toEqual([12100, 17400])
  })

  it('Multi-sitting with one mash_in_g missing → refusal mash_in_missing', async () => {
    const b = (await seedBatch(DAVE)).id
    await addLines(DAVE, b, [typed('Ristra cayenne', 150, { form: 'fresh', shu_rating_low: 24200, shu_rating_high: 34800 })])
    const a = await putUp(DAVE, b, putUpBody(place, { made: 100, mash: 100 }))
    await putUp(DAVE, b, putUpBody(place, { made: 100 }))
    expect((await shu(DAVE, b, `scope=sitting&id=${a.stageId}`)).body.refusal).toBe('mash_in_missing')
  })

  it('Appendix C: base 800 → 20.0 g salt; no weight: onion, garlic; reaper bag about 92 g left; carrot bag −1; row 2 in fl oz → row_net_unknown', async () => {
    const b = (await seedBatch(DAVE)).id
    const reaperBag = await seedJar(DAVE, { weighed: true, crop: PEPPER })
    const carrots = await seedJar(DAVE, { count: 3, qty: 3, unit: 'bag' })
    const { res } = await addLines(DAVE, b, [
      typed('megatron', 412, { form: 'fresh', shu_rating_low: 2500, shu_rating_high: 8000 }),
      typed('serrano', 230, { form: 'fresh', shu_rating_low: 10000, shu_rating_high: 23000 }),
      { input_kind: 'put_up', preservation_log_id: reaperBag, qty: 8, qty_unit: 'g', form: 'frozen', shu_rating_low: 1400000, shu_rating_high: 2200000 },
      { input_kind: 'put_up', preservation_log_id: carrots, count_drawn: 1, qty: 150, qty_unit: 'g' },
      { input_kind: 'purchased', label: 'onion' },
      plain('garlic', 4, 'count'),
      salt(20, 2.5, 'produce', 800, 'dry'),
    ])
    expect(res.status).toBe(201)
    expect(Number((await readJar(reaperBag)).remaining_amount)).toBe(92)
    expect((await readJar(carrots)).remaining_count).toBe(2)
    const now = await shu(DAVE, b)
    expect(Number(now.body.denominator_g)).toBeCloseTo(800, 6)
    expect(now.body.not_counted.map((x) => x.label ?? x)).toEqual(expect.arrayContaining(['onion', 'garlic']))
    const p = await putUp(DAVE, b, putUpBody(place, { made: 910, rows: [
      { count: 1, container_label: 'bottle', size_value: 910, size_unit: 'g', place: { id: place } },
      { count: 2, container_label: 'woozy', size_value: 8, size_unit: 'fl oz', place: { id: place },
        added_lines: [{ idempotency_key: key(), input_kind: 'put_up', preservation_log_id: reaperBag, qty: 5, qty_unit: 'g', form: 'frozen', shu_rating_low: 1400000, shu_rating_high: 2200000 },
          { idempotency_key: key(), input_kind: 'purchased', label: 'vinegar', qty: 72, qty_unit: 'g' }] },
    ] }))
    expect(p.res.status).toBe(201)
    const sit = await shu(DAVE, b, `scope=sitting&id=${p.stageId}`)
    const row1 = await shu(DAVE, b, `scope=jar&id=${p.jarIds[0]}`)
    expect([half(row1.body.low), half(row1.body.high)]).toEqual([half(sit.body.low), half(sit.body.high)])
    const row2 = await shu(DAVE, b, `scope=jar&id=${p.jarIds[1]}`)
    expect(row2.body.refusal).toBe('row_net_unknown')
    expect(Number((await readJar(reaperBag)).remaining_amount)).toBe(87)
  })
})
