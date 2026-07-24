// care-rekey-backfill.int.test.js — proves the care re-key backfill reconstruction
// (migrations/care-rekey-001/0b-backfill.sql) is PER-PLANT correct against a real Neon branch.
//
// Scope note: this asserts the backfill's reconstruction SELECT — the Critical "fan-out
// correctness" risk (design V100 §5): two plantings in one former project must get INDEPENDENT
// cadences, and project-only events (plant_id NULL) must NOT attribute to any planting. It does
// NOT apply the Phase-A schema DDL, because the integration suite shares ONE ephemeral branch and
// no test mutates schema (a shared-branch ALTER would race other files' DML). The live DDL is
// proven separately when 0a is applied to a prod-cloned branch (Phase E), per the migration README.
//
// The SELECT below is byte-for-byte the reconstruction core of 0b-backfill.sql (sans the
// INSERT ... ON CONFLICT wrapper, which needs the plant_id column 0a adds), scoped to the
// test's own plantings so it never scans the shared branch's other data.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId } from './_harness.js'

const RUN = testRunId()
const USER = `user_int_rekey_${RUN}`
let projectId
let plantA
let plantB

beforeAll(async () => {
  const proj = await directSql`
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'int-rekey-' + RUN}, ${'int-rekey-' + RUN}, ${USER}) RETURNING id`
  projectId = proj[0].id

  const a = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${projectId}, ${'rekey-A-' + RUN}, ${USER}) RETURNING id`
  plantA = a[0].id
  const b = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${projectId}, ${'rekey-B-' + RUN}, ${USER}) RETURNING id`
  plantB = b[0].id

  // Planting A: watered 2d ago (most recent) + 10d ago, fertilized 5d ago.
  // Planting B: watered 10d ago only. Both carry project_id (event_log.project_id is still
  // NOT NULL pre-0a) AND plant_id — exactly today's reality; the backfill keys on plant_id.
  await directSql`
    INSERT INTO event_log (project_id, plant_id, event_type, event_date, logged_by, created_by) VALUES
      (${projectId}, ${plantA}, 'watering',    NOW() - INTERVAL '2 days',  ${USER}, ${USER}),
      (${projectId}, ${plantA}, 'watering',    NOW() - INTERVAL '10 days', ${USER}, ${USER}),
      (${projectId}, ${plantA}, 'fertilizing', NOW() - INTERVAL '5 days',  ${USER}, ${USER}),
      (${projectId}, ${plantB}, 'watering',    NOW() - INTERVAL '10 days', ${USER}, ${USER})`

  // Project-only event (plant_id NULL): a watering "now". If the reconstruction leaked
  // project events into a plant row it would make A/B look watered ~0 days ago. It must NOT.
  await directSql`
    INSERT INTO event_log (project_id, plant_id, event_type, event_date, logged_by, created_by)
    VALUES (${projectId}, NULL, 'watering', NOW(), ${USER}, ${USER})`
})

afterAll(async () => {
  // entity registry FK (planting_ref_id) is ON DELETE RESTRICT, and a plants-insert trigger
  // (plants_entity_ins) auto-creates a 'planting' entity row per planting — clear those before
  // hard-deleting the plantings (test-teardown carve-out; mirrors plants.int.test.js afterAll).
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

async function reconstruct() {
  // 0b-backfill.sql reconstruction core, scoped to this test's plantings.
  const rows = await directSql`
    SELECT p.id AS plant_id,
      MAX(e.event_date) AS last_event_at,
      MAX(e.event_date) FILTER (WHERE e.event_type IN ('watering','rain'))     AS last_watered_at,
      MAX(e.event_date) FILTER (WHERE e.event_type = 'fertilizing')            AS last_fertilized_at,
      MAX(e.event_date) FILTER (WHERE e.event_type IN ('harvest','first_harvest')) AS last_harvested_at,
      ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(e.event_date)
        FILTER (WHERE e.event_type IN ('watering','rain')))) / 86400)::int      AS watered_days_ago
    FROM plants p
    JOIN event_log e ON e.plant_id = p.id AND e.deleted_at IS NULL
    WHERE p.deleted_at IS NULL AND p.archived_at IS NULL
      AND p.id IN (${plantA}, ${plantB})
    GROUP BY p.id`
  const byId = {}
  for (const r of rows) byId[r.plant_id] = r
  return byId
}

describe('care re-key backfill reconstruction (0b)', () => {
  it('reconstructs exactly one row per planting (fan-out, not one project row)', async () => {
    const r = await reconstruct()
    expect(Object.keys(r)).toHaveLength(2)
    expect(r[plantA]).toBeDefined()
    expect(r[plantB]).toBeDefined()
  })

  it('gives the two plantings INDEPENDENT water cadences', async () => {
    const r = await reconstruct()
    // A watered 2d ago, B watered 10d ago — must differ, A more recent.
    expect(r[plantA].watered_days_ago).toBeGreaterThanOrEqual(1)
    expect(r[plantA].watered_days_ago).toBeLessThanOrEqual(3)
    expect(r[plantB].watered_days_ago).toBeGreaterThanOrEqual(9)
    expect(r[plantB].watered_days_ago).toBeLessThanOrEqual(11)
    expect(new Date(r[plantA].last_watered_at).getTime())
      .toBeGreaterThan(new Date(r[plantB].last_watered_at).getTime())
  })

  it('does NOT leak project-only events into a plant row', async () => {
    const r = await reconstruct()
    // The project-only watering is NOW(). If it leaked, A/B would read ~0 days ago.
    expect(r[plantA].watered_days_ago).toBeGreaterThanOrEqual(1)
    expect(r[plantB].watered_days_ago).toBeGreaterThanOrEqual(9)
  })

  it('reconstructs per-type columns (fertilized) and leaves harvest null when absent', async () => {
    const r = await reconstruct()
    const fertDaysAgo = Math.round(
      (Date.now() - new Date(r[plantA].last_fertilized_at).getTime()) / 86400000)
    expect(fertDaysAgo).toBeGreaterThanOrEqual(4)
    expect(fertDaysAgo).toBeLessThanOrEqual(6)
    expect(r[plantA].last_harvested_at).toBeNull() // no harvest events seeded
    expect(r[plantB].last_fertilized_at).toBeNull() // B never fertilized
  })

  it("last_event_at is the planting's most-recent event (A: the 2d-ago watering)", async () => {
    const r = await reconstruct()
    expect(new Date(r[plantA].last_event_at).getTime())
      .toEqual(new Date(r[plantA].last_watered_at).getTime())
  })
})
