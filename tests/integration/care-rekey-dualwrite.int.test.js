// care-rekey-dualwrite.int.test.js — proves Care re-key Step B (care-rekey-001) plant-keyed
// dual-write in the events Lambda. Every event carrying a plant_id ALSO upserts a plant-keyed
// entity_memory row (ADDITIVE — the project-keyed row is still written), keyed per-planting,
// columns matching 0b-backfill.sql (recency-only, no next_water_at). Project-level events
// (plant_id NULL) write NO plant row (self-guard). Single undo recomputes the plant row.
//
// Runs the REAL events handler (lambda/events/index.js at Step-B HEAD) against an ephemeral Neon
// branch WITH the care-rekey-001 0a DDL applied (entity_memory.plant_id + partial unique index +
// 3-way exactly-one-parent CHECK). Reads are still project-keyed at this step — this suite asserts
// the WRITE side only (single-event path: sites 2 + 4 in the design's §1.3 map).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/events/index.js'

const RUN = testRunId()
const USER = `user_int_rekeydw_${RUN}`
let projectId, plantA, plantB, plantC
let projectBatch, plantD, plantE, batchId

const emByPlant = async (pid) => await directSql`SELECT * FROM entity_memory WHERE plant_id = ${pid}`
const dayOf = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : null)
const postEvent = (body) => callHandler(handler, { method: 'POST', path: '/api/events', body, userId: USER })

beforeAll(async () => {
  setTestUserId(USER)
  const proj = await directSql`
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'int-rkdw-' + RUN}, ${'int-rkdw-' + RUN}, ${USER}) RETURNING id`
  projectId = proj[0].id
  const mk = async (n) =>
    (await directSql`INSERT INTO plants (project_id, name, created_by)
       VALUES (${projectId}, ${n + '-' + RUN}, ${USER}) RETURNING id`)[0].id
  plantA = await mk('rkdw-A')
  plantB = await mk('rkdw-B')
  plantC = await mk('rkdw-C')
  // Isolated project for the batch (scope=project) path so scope resolves ONLY D + E.
  projectBatch = (await directSql`
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'int-rkdwb-' + RUN}, ${'int-rkdwb-' + RUN}, ${USER}) RETURNING id`)[0].id
  const mkb = async (n) =>
    (await directSql`INSERT INTO plants (project_id, name, created_by)
       VALUES (${projectBatch}, ${n + '-' + RUN}, ${USER}) RETURNING id`)[0].id
  plantD = await mkb('rkdw-D')
  plantE = await mkb('rkdw-E')
})

afterAll(async () => {
  // entity_memory.plant_id FK is ON DELETE RESTRICT — clear plant-keyed rows BEFORE plants.
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

describe('care re-key Step B — plant-keyed dual-write (events Lambda)', () => {
  it('single watering dual-writes a plant-keyed row AND keeps the project row', async () => {
    const res = await postEvent({ project_id: projectId, plant_id: plantA, event_type: 'watering', event_date: '2026-07-20' })
    expect([200, 201]).toContain(res.status)
    const a = await emByPlant(plantA)
    expect(a).toHaveLength(1)
    expect(dayOf(a[0].last_watered_at)).toBe('2026-07-20')
    expect(a[0].next_water_at).toBeNull()   // recency-only cache (§8.1)
    expect(a[0].project_id).toBeNull()      // 3-way exclusivity
    expect(a[0].location_id).toBeNull()
    const proj = await directSql`SELECT * FROM entity_memory WHERE project_id = ${projectId}`
    expect(proj).toHaveLength(1)            // project-keyed row STILL written (dual-write)
    expect(dayOf(proj[0].last_watered_at)).toBe('2026-07-20')
    expect(await emByPlant(plantB)).toHaveLength(0)  // sibling untouched
  })

  it('per-type: fertilizing updates last_fertilized_at only, leaves last_watered_at intact', async () => {
    const res = await postEvent({ project_id: projectId, plant_id: plantA, event_type: 'fertilizing', event_date: '2026-07-18' })
    expect([200, 201]).toContain(res.status)
    const a = (await emByPlant(plantA))[0]
    expect(dayOf(a.last_fertilized_at)).toBe('2026-07-18')
    expect(dayOf(a.last_watered_at)).toBe('2026-07-20')   // GREATEST leaves the newer watering
  })

  it('independence: watering a sibling gives it its OWN cadence, does not touch the first', async () => {
    await postEvent({ project_id: projectId, plant_id: plantB, event_type: 'watering', event_date: '2026-07-10' })
    const a = (await emByPlant(plantA))[0]
    const b = (await emByPlant(plantB))[0]
    expect(dayOf(b.last_watered_at)).toBe('2026-07-10')
    expect(dayOf(a.last_watered_at)).toBe('2026-07-20')   // A unchanged by B's watering
    expect(new Date(a.last_watered_at).getTime()).toBeGreaterThan(new Date(b.last_watered_at).getTime())
  })

  it('no plant-keyed row ever carries a project/location parent (3-way exclusivity)', async () => {
    const bad = await directSql`
      SELECT count(*)::int AS n FROM entity_memory
      WHERE plant_id IN (${plantA}, ${plantB}, ${plantC})
        AND (project_id IS NOT NULL OR location_id IS NOT NULL)`
    expect(bad[0].n).toBe(0)
  })

  it('project-level event (plant_id NULL) writes NO plant-keyed row (self-guard)', async () => {
    const before = (await directSql`SELECT count(*)::int AS n FROM entity_memory WHERE plant_id IS NOT NULL`)[0].n
    const res = await postEvent({ project_id: projectId, event_type: 'observation', event_date: '2026-07-19' })
    expect([200, 201]).toContain(res.status)
    const after = (await directSql`SELECT count(*)::int AS n FROM entity_memory WHERE plant_id IS NOT NULL`)[0].n
    expect(after).toBe(before)
  })

  it('single undo recomputes the plant-keyed last_watered_at from surviving events', async () => {
    const res = await postEvent({ project_id: projectId, plant_id: plantC, event_type: 'watering', event_date: '2026-07-15' })
    expect([200, 201]).toContain(res.status)
    expect(dayOf((await emByPlant(plantC))[0].last_watered_at)).toBe('2026-07-15')
    const evId = res.body?.id ?? (await directSql`
      SELECT id FROM event_log WHERE plant_id = ${plantC} AND event_type='watering' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`)[0].id
    const del = await callHandler(handler, { method: 'DELETE', path: `/api/events/${evId}`, userId: USER })
    expect(del.status).toBe(200)
    const c = (await emByPlant(plantC))[0]
    expect(c.last_watered_at).toBeNull()   // no surviving waterings → recomputed to NULL
  })
})

describe('care re-key Step B — plant-keyed dual-write (batch / Log Many path)', () => {
  const recentDay = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10)

  it('batch watering dual-writes a plant-keyed row for every planting in scope', async () => {
    const eventDate = recentDay()
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: {
        idempotency_key: `idem-${RUN}-batch1`, event_type: 'watering', event_date: eventDate,
        scope: { type: 'project', project_id: projectBatch },
      },
    })
    expect([200, 201]).toContain(res.status)
    batchId = res.body?.batch_id
    expect(batchId).toBeTruthy()
    for (const p of [plantD, plantE]) {
      const row = await emByPlant(p)
      expect(row).toHaveLength(1)                      // each planting fanned out its OWN row
      expect(dayOf(row[0].last_watered_at)).toBe(eventDate)
      expect(row[0].project_id).toBeNull()
      expect(row[0].next_water_at).toBeNull()
    }
  })

  it('batch undo recomputes each plant-keyed last_watered_at from surviving events', async () => {
    const del = await callHandler(handler, { method: 'DELETE', path: `/api/events/batch/${batchId}`, userId: USER })
    expect(del.status).toBe(200)
    expect((await emByPlant(plantD))[0].last_watered_at).toBeNull()  // only event was the undone batch watering
    expect((await emByPlant(plantE))[0].last_watered_at).toBeNull()
  })
})
