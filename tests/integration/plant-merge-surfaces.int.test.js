// plant-merge-surfaces.int.test.js — the planting merge's Put-Up train §6a surfaces on a real engine
// (review-F-prepromote-early I3).
//
// merge.js repoints ready_impression and watch_exclusion onto the winner after a conflict-prune DELETE,
// because both carry a per-day UNIQUE key that includes plant_id (uq_ready_impression_day on
// (user_id, plant_id, shown_on, region), uq_watch_exclusion_day on (user_id, plant_id, evaluated_on,
// reason)). A loser row is dropped when the winner already holds its key (the `w` arm) or when another
// loser of a lower id does (the `o` arm); everything else moves. The unit suite cannot see any of this —
// its SQL never runs — and the only real-DB merge case (kitchen-ferment, RIA-I3) seeds no telemetry rows,
// so the collision path had never executed. Prod holds 112 and 8,142 rows on these tables. A predicate
// that under-prunes is a 23505 inside the cutover, which rolls back the whole merge (mergeCore answers
// 409 "Merge collided with existing rows"); one that over-prunes silently deletes rows that did not
// collide. Each group below is built so either failure changes what the test sees: a winner-key
// collision, a two-loser collision, and three near-misses that differ from a colliding row in exactly
// one key column (region|reason, user, day).
//
// preservation_source has no such key and is a plain repoint; it is here because it also moved in the
// train and had also never run, including a retracted (soft-deleted) source, which moves too.
//
// One merge group per surface, so a broken predicate on one table reds that table's case alone.
import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import { handler } from '../../lambda/plants/index.js'

const RUN = testRunId()
const DAVE = `mrg-dave-${RUN}`
// Only ever a user_id VALUE on a telemetry row: the key's user column is text with no FK, and the merge
// moves rows by plant_id whoever they belong to.
const OTHER = `mrg-other-${RUN}`
const D1 = '2026-09-01'
const D2 = '2026-09-02'
const D3 = '2026-09-03'

afterAll(async () => {
  const ids = assertFixtureId(DAVE, OTHER)
  // FK order. ready_impression / watch_exclusion reference plants with NO ACTION and _cleanup.js's global
  // sweep has no step for either, so this is the only thing that removes them.
  await settle(`plant-merge-surfaces teardown ${RUN}`, [
    () => directSql`DELETE FROM ready_impression WHERE user_id = ANY(${ids}) OR plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM watch_exclusion WHERE user_id = ANY(${ids}) OR plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM preservation_source WHERE user_id = ANY(${ids}) OR preservation_log_id IN (SELECT id FROM preservation_log WHERE user_id = ANY(${ids}))`,
    () => directSql`DELETE FROM preservation_log WHERE user_id = ANY(${ids})`,
    () => directSql`DELETE FROM merge_event WHERE merged_by = ANY(${ids}) OR winner_plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids})) OR project_id IN (SELECT id FROM plant_projects WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM event_log WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids})) OR project_id IN (SELECT id FROM plant_projects WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM entity WHERE planting_ref_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM plants WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM plant_projects WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM audit_events WHERE actor_clerk_sub = ANY(${ids})`,
  ])
})

/** A container with a winner and three sibling losers, all DAVE's and all alike on every guarded column. */
async function seedGroup(tag) {
  const proj = await insertProject({ name: `mrg-${tag}-${RUN}`, createdBy: DAVE })
  const ids = []
  for (const who of ['w', 'l1', 'l2', 'l3']) {
    // eslint-disable-next-line no-await-in-loop
    const [p] = await directSql`
      INSERT INTO plants (project_id, name, created_by)
      VALUES (${proj.id}, ${`mrg-${tag}-${who}-${RUN}`}, ${DAVE}) RETURNING id`
    ids.push(p.id)
  }
  const [W, L1, L2, L3] = ids
  return { W, L1, L2, L3 }
}

async function merge(winner, losers) {
  setTestUserId(DAVE)
  return callHandler(handler, {
    method: 'POST', path: `/api/plants/${winner}/merge`,
    body: { loser_ids: losers, op_id: randomUUID() }, userId: DAVE,
  })
}

async function snapshotRepoints(mergeEventId, table) {
  const [m] = await directSql`SELECT snapshot FROM merge_event WHERE id = ${mergeEventId}`
  const snap = typeof m.snapshot === 'string' ? JSON.parse(m.snapshot) : m.snapshot
  return snap.repoints
    .filter((r) => r.table === table)
    .map((r) => ({ id: String(r.row_id), old: r.old_value }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
}

describe('planting merge — the §6a telemetry and source surfaces on a real engine (I3)', () => {
  it('ready_impression: drops a loser row on the winner\'s key and the higher-id of two losers\' rows, moves the rest', async () => {
    const { W, L1, L2, L3 } = await seedGroup('ri')
    // Inserted one at a time, in this order: `o.id < l.id` picks the survivor of a loser-loser collision
    // by identity order, and the assertion below needs to know which that is.
    const ri = async (user, plant, day, region) => (await directSql`
      INSERT INTO ready_impression (user_id, plant_id, shown_on, slot, region, source, model_version)
      VALUES (${user}, ${plant}, ${day}::date, 0, ${region}, 'recent', 'int-test') RETURNING id`)[0].id
    const winner = await ri(DAVE, W, D1, 'tray')
    const onWinnerKey = await ri(DAVE, L1, D1, 'tray')        // collides with the winner's row
    const onWinnerKey2 = await ri(DAVE, L3, D1, 'tray')       // so does this one, whichever loser is lower
    const pairLow = await ri(DAVE, L1, D2, 'tray')            // two losers, one key, no winner row:
    const pairHigh = await ri(DAVE, L2, D2, 'tray')           //   the lower id survives
    const otherRegion = await ri(DAVE, L1, D1, 'tray_tail')   // near-misses: one key column differs
    const otherUser = await ri(OTHER, L2, D1, 'tray')
    const otherDay = await ri(DAVE, L3, D3, 'tray')
    expect(BigInt(pairLow) < BigInt(pairHigh)).toBe(true)
    const group = [W, L1, L2, L3]
    // Not vacuous: moved as-is, these rows break the key twice over — two (user, day, region) groups
    // hold more than one row across the siblings.
    const [pre] = await directSql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM ready_impression WHERE plant_id = ANY(${group})
         GROUP BY user_id, shown_on, region HAVING count(*) > 1) g`
    expect(pre.n).toBe(2)

    const r = await merge(W, [L1, L2, L3])
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    const rows = await directSql`
      SELECT id, plant_id FROM ready_impression WHERE plant_id = ANY(${group}) ORDER BY id`
    expect(rows.map((x) => String(x.id)))
      .toEqual([winner, pairLow, otherRegion, otherUser, otherDay].map(String))
    expect(rows.every((x) => x.plant_id === W)).toBe(true)
    const [gone] = await directSql`
      SELECT count(*)::int AS n FROM ready_impression WHERE id = ANY(${[onWinnerKey, onWinnerKey2, pairHigh]})`
    expect(gone.n).toBe(0)
    // Restore can put every loser row back, the pruned ones included: the snapshot is taken before the
    // cutover and records each with the planting it came from.
    expect(await snapshotRepoints(r.body.merge_event_id, 'ready_impression')).toEqual([
      { id: String(onWinnerKey), old: L1 }, { id: String(onWinnerKey2), old: L3 },
      { id: String(pairLow), old: L1 }, { id: String(pairHigh), old: L2 },
      { id: String(otherRegion), old: L1 }, { id: String(otherUser), old: L2 },
      { id: String(otherDay), old: L3 },
    ])
  })

  it('watch_exclusion: drops a loser row on the winner\'s key and the higher-id of two losers\' rows, moves the rest', async () => {
    const { W, L1, L2, L3 } = await seedGroup('we')
    const we = async (user, plant, day, reason) => (await directSql`
      INSERT INTO watch_exclusion (user_id, plant_id, evaluated_on, reason, model_version)
      VALUES (${user}, ${plant}, ${day}::date, ${reason}, 'int-test') RETURNING id`)[0].id
    const winner = await we(DAVE, W, D1, 'no_today')
    const onWinnerKey = await we(DAVE, L1, D1, 'no_today')
    const onWinnerKey2 = await we(DAVE, L3, D1, 'no_today')
    const pairLow = await we(DAVE, L1, D2, 'no_anchor')
    const pairHigh = await we(DAVE, L2, D2, 'no_anchor')
    const otherReason = await we(DAVE, L1, D1, 'dismissed')
    const otherUser = await we(OTHER, L2, D1, 'no_today')
    const otherDay = await we(DAVE, L3, D3, 'no_today')
    expect(BigInt(pairLow) < BigInt(pairHigh)).toBe(true)
    const group = [W, L1, L2, L3]
    const [pre] = await directSql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM watch_exclusion WHERE plant_id = ANY(${group})
         GROUP BY user_id, evaluated_on, reason HAVING count(*) > 1) g`
    expect(pre.n).toBe(2)

    const r = await merge(W, [L1, L2, L3])
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    const rows = await directSql`
      SELECT id, plant_id FROM watch_exclusion WHERE plant_id = ANY(${group}) ORDER BY id`
    expect(rows.map((x) => String(x.id)))
      .toEqual([winner, pairLow, otherReason, otherUser, otherDay].map(String))
    expect(rows.every((x) => x.plant_id === W)).toBe(true)
    const [gone] = await directSql`
      SELECT count(*)::int AS n FROM watch_exclusion WHERE id = ANY(${[onWinnerKey, onWinnerKey2, pairHigh]})`
    expect(gone.n).toBe(0)
    expect(await snapshotRepoints(r.body.merge_event_id, 'watch_exclusion')).toEqual([
      { id: String(onWinnerKey), old: L1 }, { id: String(onWinnerKey2), old: L3 },
      { id: String(pairLow), old: L1 }, { id: String(pairHigh), old: L2 },
      { id: String(otherReason), old: L1 }, { id: String(otherUser), old: L2 },
      { id: String(otherDay), old: L3 },
    ])
  })

  it('preservation_source: every source row on a loser moves to the winner, a retracted one too, none dropped', async () => {
    const { W, L1, L2 } = await seedGroup('ps')
    const [crop] = await directSql`SELECT slug FROM crop_types ORDER BY slug LIMIT 1`
    // A put-up with no planting of its own (the parent's source columns stay NULL, so no parent CHECK
    // is in play) and three own-garden sources on two losers.
    const [jar] = await directSql`
      INSERT INTO preservation_log (user_id, crop_type_slug, preserved_at, method, quantity_value, quantity_unit, package_count)
      VALUES (${DAVE}, ${crop.slug}, (now() - interval '10 days')::date, 'whole_freeze', 2, 'lb', 3) RETURNING id`
    const src = async (plant, ordinal, retracted = false) => (await directSql`
      INSERT INTO preservation_source (preservation_log_id, user_id, ordinal, source_kind, display_label,
                                       provenance_grade, crop_type_slug, plant_id, deleted_at)
      VALUES (${jar.id}, ${DAVE}, ${ordinal}, 'own_garden', ${`mrg source ${ordinal}`}, 'planting',
              ${crop.slug}, ${plant}, ${retracted ? new Date().toISOString() : null}::timestamptz)
      RETURNING id`)[0].id
    const a = await src(L1, 0)
    const b = await src(L2, 1)
    const retracted = await src(L1, 2, true)

    const r = await merge(W, [L1, L2])
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    const rows = await directSql`
      SELECT id, plant_id, deleted_at FROM preservation_source WHERE preservation_log_id = ${jar.id} ORDER BY ordinal`
    expect(rows.map((x) => x.id)).toEqual([a, b, retracted])
    expect(rows.every((x) => x.plant_id === W)).toBe(true)
    expect(rows.map((x) => x.deleted_at != null)).toEqual([false, false, true])
    expect(await snapshotRepoints(r.body.merge_event_id, 'preservation_source'))
      .toEqual([{ id: a, old: L1 }, { id: b, old: L2 }, { id: retracted, old: L1 }]
        .sort((x, y) => x.id.localeCompare(y.id, 'en', { numeric: true })))
  })
})
