// batchbuilder-archive.int.test.js — V5-BATCHBUILDER-001, BUG-ARCHIVESOFTDELBATCH-001 (Put-Up B′ release 3).
//
// THE BUG. kitchen_batch_input.harvest_log_id is ON DELETE RESTRICT and a foreign key does not read deleted_at:
// a pick line under a soft-deleted batch, or a soft-deleted pick line, passes both archive routines' kitchen
// guards and then pins its harvest_log row, so the archive dies on a bare 23503.
// THE FIX (migrations/v5-batchbuilder-001/README.md, option (c)): no writer leaves a dead pick link (take-out,
// batch removal and — from release 3 — Undo that put-up hard-delete pick lines), and 0a sweeps the ones left
// from before F. Here, on the real train fork:
//   1. both dead shapes, seeded by hand as a pre-F batch removal left them, turn an archive into a 23503;
//   2. the sweep block FROM 0a (read from the file; scoped to this file's own batches so files running in
//      parallel keep their fixtures) removes exactly them, and both archives then succeed;
//   3. the standing gate's SQL (read from gates.yml) finds none of this file's rows afterwards;
//   4. Undo that put-up hard-deletes a pick added at that sitting, so the planting archives afterwards.
// DAVE and JEN share a household; STRANGER cannot undo DAVE's sitting (404).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { directSql } from './_harness.js'
import { makeHousehold, useHousehold, call, key, errOf, seedBatch, seedPlanting, seedHarvest } from './_kitchenF.js'

const H = makeHousehold('bbarch')
const { DAVE, JEN, STRANGER } = H
useHousehold(H, beforeAll, afterAll)

const MIG = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations/v5-batchbuilder-001')
const ZERO_A = readFileSync(resolve(MIG, '0a-additive-ddl.sql'), 'utf8')
const GATES = readFileSync(resolve(MIG, 'gates.yml'), 'utf8')

// The sweep block, verbatim, with ONE added conjunct scoping it to the given batches (asserted to apply once).
function scopedSweep(batchIds) {
  const block = ZERO_A.slice(ZERO_A.indexOf('-- BEGIN dead-pick-sweep'), ZERO_A.indexOf('-- END dead-pick-sweep'))
  const anchor = 'WHERE i.harvest_log_id IS NOT NULL'
  expect(block.split(anchor)).toHaveLength(2)
  const ids = batchIds.map((b) => `'${b}'::uuid`).join(', ')
  return block.replace(anchor, `${anchor} AND i.batch_id IN (${ids})`)
}
// The standing gate's SQL, verbatim, restricted to the given batches.
function gateRows(batchIds) {
  const at = GATES.indexOf('- name: post_no_dead_pick_link')
  const sqlAt = GATES.indexOf('sql: |', at) + 'sql: |'.length
  const sql = GATES.slice(sqlAt, GATES.indexOf('expect:', sqlAt)).split('\n').map((l) => l.replace(/^ {6}/, '')).join('\n')
  return directSql(`SELECT * FROM (${sql}) g WHERE g.batch_id = ANY($1::uuid[])`, [batchIds])
}
const archive = (plantId) => errOf(() => directSql`SELECT * FROM archive_plant_events(${plantId}::uuid, 'int-test')`)

describe('BUG-ARCHIVESOFTDELBATCH-001 — the two dead shapes, then the 0a sweep', () => {
  let removedBatch, liveBatch, pA, pB, hA, hB
  beforeAll(async () => {
    const stamp = await directSql`SELECT 1 FROM schema_version WHERE version = '5.0.0-batchbuilder-001'`
    expect(stamp, 'the train step applied v5-batchbuilder-001 to this fork').toHaveLength(1)
    pA = await seedPlanting(DAVE, { name: 'bb-arch-a' })
    pB = await seedPlanting(DAVE, { name: 'bb-arch-b' })
    hA = await seedHarvest(DAVE, pA)
    hB = await seedHarvest(DAVE, pB)
    removedBatch = (await seedBatch(DAVE, { label: 'bb removed before F' })).id
    liveBatch = (await seedBatch(DAVE, { label: 'bb live' })).id
    // Shape 1: the pre-F soft DELETE — the batch removed, its pick line left behind.
    await directSql`
      INSERT INTO kitchen_batch_input (batch_id, input_kind, harvest_log_id, plant_id, created_by)
      VALUES (${removedBatch}, 'harvest', ${hA}, ${pA.plantId}, ${DAVE})`
    await directSql`UPDATE kitchen_batch SET deleted_at = now() WHERE id = ${removedBatch}`
    // Shape 2: a soft-deleted pick line in a live batch (the Undo-that-put-up path before release 3).
    await directSql`
      INSERT INTO kitchen_batch_input (batch_id, input_kind, harvest_log_id, plant_id, created_by, deleted_at)
      VALUES (${liveBatch}, 'harvest', ${hB}, ${pB.plantId}, ${DAVE}, now())`
  })

  it('before the sweep: each archive dies on the bare foreign key (23503), and the gate sees both', async () => {
    for (const p of [pA, pB]) {
      const e = await archive(p.plantId)
      expect(e, 'the archive must be refused while the dead link pins the pick').not.toBeNull()
      expect(e.code).toBe('23503')
    }
    expect(await gateRows([removedBatch, liveBatch])).toHaveLength(2)
  })

  it('the sweep from 0a removes exactly the dead pick links — the live batch keeps its live lines', async () => {
    const keep = await directSql`
      INSERT INTO kitchen_batch_input (batch_id, input_kind, label, created_by)
      VALUES (${liveBatch}, 'other', 'bb salt', ${DAVE}) RETURNING id`
    await directSql(scopedSweep([removedBatch, liveBatch]))
    const left = await directSql`SELECT id, harvest_log_id FROM kitchen_batch_input WHERE batch_id IN (${removedBatch}, ${liveBatch})`
    expect(left.map((r) => r.id)).toEqual([keep[0].id])
    expect(await gateRows([removedBatch, liveBatch])).toHaveLength(0)
    // Idempotent: a second run removes nothing.
    await directSql(scopedSweep([removedBatch, liveBatch]))
    expect(await directSql`SELECT id FROM kitchen_batch_input WHERE batch_id IN (${removedBatch}, ${liveBatch})`).toHaveLength(1)
  })

  it('after the sweep both plantings archive, and the picks are kept in harvest_log_archive', async () => {
    for (const p of [pA, pB]) expect((await archive(p.plantId)), 'archive succeeds').toBeNull()
    const kept = await directSql`SELECT count(*)::int AS n FROM harvest_log_archive WHERE id IN (${hA}, ${hB})`
    expect(kept[0].n).toBe(2)
  })
})

describe('Undo that put-up hard-deletes a pick added at that sitting (release 3), so the planting archives', () => {
  it('DAVE puts up with a pick added at the end; STRANGER cannot undo it; JEN undoes it; the archive succeeds', async () => {
    const b = (await seedBatch(DAVE, { label: 'bb undo pick' })).id
    const p = await seedPlanting(DAVE, { name: 'bb-undo' })
    const hv = await seedHarvest(DAVE, p)
    const k = key()
    const put = await call(DAVE, 'POST', `/api/kitchen-batches/${b}/put-up`, {
      idempotency_key: k, when: { date: new Date().toISOString(), precision: 'exact' }, method: 'hot_sauce', finish: false,
      rows: [{ count: 1, place: { kind: 'fridge', label: `bb fridge ${H.RUN}` }, name: 'bb sauce' }],
      sitting_lines: [{ input_kind: 'harvest', harvest_log_id: hv }],
    })
    expect(put.status, JSON.stringify(put.body)).toBe(201)
    const stageId = put.body.stage.id
    expect(await directSql`SELECT id FROM kitchen_batch_input WHERE harvest_log_id = ${hv}`).toHaveLength(1)

    const s = await call(STRANGER, 'POST', `/api/kitchen-batches/${b}/put-up/${stageId}/undo`, {})
    expect(s.status).toBe(404)
    const u = await call(JEN, 'POST', `/api/kitchen-batches/${b}/put-up/${stageId}/undo`, {})
    expect(u.status, JSON.stringify(u.body)).toBe(200)
    expect(await directSql`SELECT id FROM kitchen_batch_input WHERE harvest_log_id = ${hv}`, 'no row, live or soft-deleted').toHaveLength(0)
    expect(await archive(p.plantId)).toBeNull()
  })
})
