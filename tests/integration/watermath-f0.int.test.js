// watermath-f0.int.test.js — V4-WATERMATH-001 F0 capture layer, against a real database.
//
// Runs the REAL events handler (lambda/events/index.js) on an ephemeral Neon branch. These
// assertions are integration and not source-text on purpose: every claim here is database-shaped
// and unfalsifiable from the source alone.
//
//   1. ZERO REWARD for moisture_check. Verified against live Neon 2026-08-12, `event_log` has
//      exactly two non-internal triggers — prevent_ownership_transfer and set_updated_at — and
//      NEITHER touches xp_events, user_stats or achievements. The only trigger in the reward path
//      is trg_user_stats_level on user_stats, whose entire body is
//      `NEW.level := public.xp_level(NEW.xp)`. So the grant is application code, the exclusion is
//      application code, and the only honest proof is counting rows after a real POST.
//      The subtle half: total_events and the streak are RECOMPUTED as count(*) over event_log on
//      every logging action. A test that only checked "this POST granted nothing" would pass even
//      if the next event silently absorbed the moisture_check. So the watering that follows is
//      part of the assertion, not a separate concern.
//
//   2. BATCH METADATA MERGE. The batch INSERT used to hardcode
//      jsonb_build_object('batch_id', …, 'batch_v', 1) and carry no user metadata at all. Batch is
//      ~80% of events historically, so the amount chips would have captured ~0% of real watering.
//      What lands in the jsonb column for each row is the only thing worth asserting.
//
//   3. quantity_numeric stays HARVEST-ONLY. The water amount is a category in metadata precisely
//      because that column is structurally harvest-only; a test that lets a depth leak into it
//      would be the first step to the collision this design avoided.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler } from '../../lambda/events/index.js'

const RUN = testRunId()
const USER = `user_int_wf0_${RUN}`

let projectId
let batchProjectId
let plantA
let plantB
let plantC

const today = () => new Date().toISOString()

beforeAll(async () => {
  setTestUserId(USER)
  projectId = (await insertProject({ name: 'int-wf0-' + RUN, createdBy: USER })).id
  batchProjectId = (await insertProject({ name: 'int-wf0-batch-' + RUN, createdBy: USER })).id
  const mk = async (n, proj) =>
    (await directSql`INSERT INTO plants (project_id, name, created_by)
       VALUES (${proj}, ${n + '-' + RUN}, ${USER}) RETURNING id`)[0].id
  plantA = await mk('wf0-A', batchProjectId)
  plantB = await mk('wf0-B', batchProjectId)
  plantC = await mk('wf0-C', batchProjectId)
})

afterAll(async () => {
  await directSql`DELETE FROM xp_events WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_achievements WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_stats WHERE user_id = ${USER}`
  await directSql`DELETE FROM app_events WHERE user_clerk_sub = ${USER}`
  await directSql`DELETE FROM event_batches WHERE created_by = ${USER}`
  // entity_memory.plant_id FK is ON DELETE RESTRICT — clear plant-keyed rows BEFORE plants.
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

const postEvent = (body) =>
  callHandler(handler, { method: 'POST', path: '/api/events', body, userId: USER })

const statsRow = async () =>
  (await directSql`SELECT total_events, current_streak, longest_streak, xp
                     FROM user_stats WHERE user_id = ${USER}`)[0] ?? null

const xpRows = async () =>
  directSql`SELECT amount, reason, source_id FROM xp_events WHERE user_id = ${USER}`

const eventRow = async (id) =>
  (await directSql`SELECT event_type, metadata, quantity_numeric, quantity
                     FROM event_log WHERE id = ${id}`)[0]

describe('moisture_check grants ZERO xp / streak / total_events', () => {
  let moistureId

  it('creates the event — it is a first-class type, not a rejected one', async () => {
    const res = await postEvent({
      project_id: projectId, event_type: 'moisture_check', event_date: today(),
      notes: 'still damp',
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    moistureId = res.body.id
    expect(res.body.event_type).toBe('moisture_check')
  })

  it('writes NO xp_events row at all', async () => {
    // Mutation: drop `AND ${eventTypeIsRewarded}::boolean` from the flat_grant WHERE and this
    // finds one 'event_logged' row worth 10 XP.
    const rows = await xpRows()
    expect(rows).toHaveLength(0)
  })

  it('reports zero XP gained and no level movement to the client', async () => {
    const res = await postEvent({
      project_id: projectId, event_type: 'moisture_check', event_date: today(),
    })
    expect(res.status).toBe(201)
    expect(res.body.xp_gained).toBe(0)
    expect(res.body.newly_earned_achievements).toEqual([])
    expect(res.body.leveled_up).toBe(false)
  })

  it('leaves user_stats.total_events and the streak at zero', async () => {
    // The recompute half. Two moisture_check rows exist in event_log at this point; if the
    // count(*) in Step 3a did not filter NON_REWARD_EVENT_TYPES, total_events would read 2 and a
    // streak of 1 would already be running.
    const s = await statsRow()
    expect(s).toBeTruthy()
    expect(s.total_events).toBe(0)
    expect(s.current_streak).toBe(0)
    expect(Number(s.xp)).toBe(0)
  })

  it('still does not count once a REAL event lands — the recompute cannot absorb it later', async () => {
    // The trap this test exists for. total_events is recomputed over the user's whole history on
    // every logging action, so a filter present only in the grant would let the next watering
    // silently sweep both moisture_checks into the total.
    const res = await postEvent({
      project_id: projectId, event_type: 'watering', event_date: today(),
    })
    expect(res.status).toBe(201)
    const s = await statsRow()
    expect(s.total_events).toBe(1)          // the watering ONLY — not 3
    expect(s.current_streak).toBe(1)
    const granted = (await xpRows()).filter((r) => r.reason === 'event_logged')
    expect(granted).toHaveLength(1)          // one grant, for the watering
    expect(Number(granted[0].amount)).toBe(10)
    expect(granted[0].source_id).not.toBe(moistureId)
  })

  it('is rejected by the batch route — no bulk-farming path exists', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: {
        idempotency_key: `idem-${RUN}-moist`, event_type: 'moisture_check',
        scope: { type: 'project', project_id: batchProjectId },
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/event_type must be one of/)
  })
})

describe('watering amount capture — single POST', () => {
  it('stores water_depth and its provenance in metadata', async () => {
    const res = await postEvent({
      project_id: projectId, event_type: 'watering', event_date: today(),
      metadata: { water_depth: 'deep', water_depth_source: 'user' },
    })
    expect(res.status).toBe(201)
    const row = await eventRow(res.body.id)
    expect(row.metadata.water_depth).toBe('deep')
    expect(row.metadata.water_depth_source).toBe('user')
  })

  it('leaves quantity_numeric NULL — that column is structurally harvest-only', async () => {
    // Mutation: bind the depth into quantity_numeric and this goes red. A dimensionless class code
    // in a numeric column would collide with real gallons the moment amounts are ever recorded.
    const res = await postEvent({
      project_id: projectId, event_type: 'watering', event_date: today(),
      metadata: { water_depth: 'light', water_depth_source: 'default' },
    })
    const row = await eventRow(res.body.id)
    expect(row.quantity_numeric).toBeNull()
  })

  it('a harvest still populates quantity_numeric — the invariant is preserved, not removed', async () => {
    const res = await postEvent({
      project_id: projectId, event_type: 'harvest', event_date: today(),
      harvest: { quantity: 7, unit: 'count' },
    })
    expect(res.status).toBe(201)
    const row = await eventRow(res.body.id)
    expect(Number(row.quantity_numeric)).toBe(7)
    await directSql`DELETE FROM harvest_log WHERE event_id = ${res.body.id}`
  })

  it('rejects an out-of-vocabulary depth at the edge', async () => {
    const res = await postEvent({
      project_id: projectId, event_type: 'watering', event_date: today(),
      metadata: { water_depth: 'monsoon' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/water_depth must be one of/)
  })
})

describe('watering amount capture — batch path (the ~80% path)', () => {
  let batchId

  it('applies ONE batch-level chip to every row, alongside the batch identity keys', async () => {
    // Before this change the batch INSERT hardcoded its metadata: this assertion could not have
    // passed at all, and the chips would have captured nothing on the high-volume path.
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: {
        idempotency_key: `idem-${RUN}-b1`, event_type: 'watering', event_date: today(),
        scope: { type: 'project', project_id: batchProjectId },
        metadata: { water_depth: 'deep', water_depth_source: 'user' },
      },
    })
    expect([200, 201]).toContain(res.status)
    batchId = res.body.batch_id
    expect(res.body.count).toBe(3)

    const rows = await directSql`
      SELECT plant_id, metadata FROM event_log
       WHERE metadata->>'batch_id' = ${batchId} AND deleted_at IS NULL`
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.metadata.water_depth, r.plant_id).toBe('deep')
      expect(r.metadata.water_depth_source).toBe('user')
      expect(r.metadata.batch_id).toBe(batchId)
      expect(r.metadata.batch_v).toBe(1)
    }
  })

  it('honours a per-row override for exactly that row', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: {
        idempotency_key: `idem-${RUN}-b2`, event_type: 'watering', event_date: today(),
        scope: { type: 'project', project_id: batchProjectId },
        metadata: { water_depth: 'normal', water_depth_source: 'default' },
        plant_metadata: { [plantB]: { water_depth: 'light', water_depth_source: 'user' } },
      },
    })
    expect([200, 201]).toContain(res.status)
    const rows = await directSql`
      SELECT plant_id, metadata FROM event_log
       WHERE metadata->>'batch_id' = ${res.body.batch_id} AND deleted_at IS NULL`
    const byPlant = Object.fromEntries(rows.map((r) => [r.plant_id, r.metadata]))
    expect(byPlant[plantB].water_depth).toBe('light')
    expect(byPlant[plantB].water_depth_source).toBe('user')
    // The override must not leak — one tap on one row cannot rewrite the burst.
    expect(byPlant[plantA].water_depth).toBe('normal')
    expect(byPlant[plantC].water_depth).toBe('normal')
    // and every row still carries the batch identity the undo cascade keys on
    for (const m of Object.values(byPlant)) expect(m.batch_id).toBe(res.body.batch_id)
  })

  it('a client-supplied batch_id is OVERRIDDEN by the server, never honoured', async () => {
    // metadata->>'batch_id' drives the undo cascade, the side-effect re-hit lookup and the batch
    // feed. A forgeable batch_id could attach rows to — or detach them from — another batch.
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: {
        idempotency_key: `idem-${RUN}-b3`, event_type: 'watering', event_date: today(),
        scope: { type: 'project', project_id: batchProjectId },
        metadata: { batch_id: 'ffffffff-9999-4999-8999-ffffffffffff', batch_v: 99 },
      },
    })
    expect([200, 201]).toContain(res.status)
    const forged = await directSql`
      SELECT id FROM event_log WHERE metadata->>'batch_id' = 'ffffffff-9999-4999-8999-ffffffffffff'`
    expect(forged).toHaveLength(0)
    const real = await directSql`
      SELECT metadata FROM event_log WHERE metadata->>'batch_id' = ${res.body.batch_id}`
    expect(real).toHaveLength(3)
    for (const r of real) expect(r.metadata.batch_v).toBe(1)
  })

  it('a batch with NO metadata still writes exactly the two batch identity keys', async () => {
    // The regression floor: the old behaviour, unchanged, for every caller that sends nothing.
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: {
        idempotency_key: `idem-${RUN}-b4`, event_type: 'watering', event_date: today(),
        scope: { type: 'project', project_id: batchProjectId },
      },
    })
    expect([200, 201]).toContain(res.status)
    const rows = await directSql`
      SELECT metadata FROM event_log WHERE metadata->>'batch_id' = ${res.body.batch_id}`
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(Object.keys(r.metadata).sort()).toEqual(['batch_id', 'batch_v'])
    }
  })

  it('rejects an out-of-vocabulary depth on a per-row override', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: {
        idempotency_key: `idem-${RUN}-b5`, event_type: 'watering', event_date: today(),
        scope: { type: 'project', project_id: batchProjectId },
        plant_metadata: { [plantA]: { water_depth: 'monsoon' } },
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/water_depth must be one of/)
  })

  it('the batch undo still finds every row it wrote (batch_id survived the merge)', async () => {
    const del = await callHandler(handler, {
      method: 'DELETE', path: `/api/events/batch/${batchId}`, userId: USER,
    })
    expect(del.status).toBe(200)
    const alive = await directSql`
      SELECT id FROM event_log
       WHERE metadata->>'batch_id' = ${batchId} AND deleted_at IS NULL`
    expect(alive).toHaveLength(0)
  })
})
