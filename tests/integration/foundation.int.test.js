// foundation.int.test.js — proves the CI mechanism BEFORE any handler/mock layer:
//   (1) the ephemeral Neon branch is reachable via the real @neondatabase/serverless driver,
//   (2) the branch inherited the staging schema (key tables exist),
//   (3) directSql can write + read back a row.
// If this is GREEN, the Neon-ephemeral foundation (OQ-1) works. Handler+mock tests are layered on top.
import { describe, it, expect, afterAll } from 'vitest'
import { directSql, testRunId } from './_harness.js'

const RUN = testRunId()
const USER = `user_foundation_${RUN}`

afterAll(async () => {
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

describe('integration foundation — Neon ephemeral branch + real driver', () => {
  it('driver connects and runs a trivial query', async () => {
    const rows = await directSql`SELECT 1 AS ok`
    expect(rows[0].ok).toBe(1)
  })

  it('branch inherited the staging schema (core tables present)', async () => {
    const rows = await directSql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(${['plant_projects', 'event_log', 'plants', 'locations', 'inventory_items']})
    `
    const names = rows.map((r) => r.table_name).sort()
    expect(names).toEqual(['event_log', 'inventory_items', 'locations', 'plant_projects', 'plants'])
  })

  it('write + read-back round-trip via the real driver', async () => {
    const ins = await directSql`
      INSERT INTO plant_projects (name, slug, created_by)
      VALUES (${'foundation-' + RUN}, ${'foundation-' + RUN}, ${USER}) RETURNING id, name
    `
    expect(ins[0].id).toBeTruthy()
    const back = await directSql`SELECT name FROM plant_projects WHERE id = ${ins[0].id}`
    expect(back[0].name).toBe('foundation-' + RUN)
  })
})
