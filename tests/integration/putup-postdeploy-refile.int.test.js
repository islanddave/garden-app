// putup-postdeploy-refile.int.test.js — scripts/putup-postdeploy-refile.mjs (the Put-Up 1b post-deploy pesto re-file)
// run as the sitting will run it, as its own process, against real Neon: this workflow's ephemeral fork with 1b + F
// applied. Unlike the local PG 17 replica proof, nothing is emulated here — the preservation Lambda's own
// @neondatabase/serverless copy talks to Neon's HTTP endpoint and the real handler takes the PATCH.
//
// Fixtures stand in for the two prod basil pestos (passata, put up 2026-08-19, table date 2027-08-19) in a deep
// freezer, where pesto's figure (12) equals passata's; a fridge-freezer one of Jen's, where it does not (4), so the
// date moves and the audit trigger fires with Jen as the actor; and a tomato passata, which must be refused.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { directSql, testRunId } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUN = testRunId()
const DAVE = `refile-dave-${RUN}`
const JEN = `refile-jen-${RUN}`
let J1, J2, J3

function refile(...args) {
  const env = { ...process.env, PUTUP_REFILE_DATABASE_URL: process.env.INT_DATABASE_URL }
  delete env.GARDEN_HOUSEHOLD_IDS
  const r = spawnSync(process.execPath, ['scripts/putup-postdeploy-refile.mjs', ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 90000,
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const state = async () => directSql`
  SELECT id, method, use_by_target::text AS use_by_target, use_by_basis, xmin::text AS xmin
  FROM preservation_log WHERE id IN (${J1}, ${J2}, ${J3}) ORDER BY id`
const auditsSince = (t0) => directSql`
  SELECT row_id, action, actor_clerk_sub, before_jsonb->>'use_by_target' AS before_date,
         after_jsonb->>'use_by_target' AS after_date, after_jsonb->>'method' AS after_method
  FROM audit_events WHERE table_name = 'preservation_log' AND row_id IN (${J1}, ${J2}, ${J3}) AND ts >= ${t0}::timestamptz
  ORDER BY ts`

beforeAll(async () => {
  const [{ slug: crop }] = await directSql`
    SELECT slug FROM crop_types WHERE slug !~* '(basil|pesto)' AND display_name !~* '(basil|pesto)' ORDER BY slug LIMIT 1`
  const [{ id: freezer }] = await directSql`
    INSERT INTO storage_location (user_id, label, kind) VALUES (${DAVE}, ${`refile freezer ${RUN}`}, 'deep_freezer') RETURNING id`
  const [{ id: kitchen }] = await directSql`
    INSERT INTO storage_location (user_id, label, kind) VALUES (${JEN}, ${`refile kitchen ${RUN}`}, 'fridge_freezer') RETURNING id`
  const jar = async (owner, place, notes) => (await directSql`
    INSERT INTO preservation_log (user_id, crop_type_slug, preserved_at, method, quantity_value, quantity_unit,
                                  package_count, remaining_count, storage_location_id, use_by_target, use_by_basis, notes)
    VALUES (${owner}, ${crop}, '2026-08-19', 'passata', 1, 'cups', 1, 1, ${place}, '2027-08-19', 'table', ${notes})
    RETURNING id`)[0].id
  J1 = await jar(DAVE, freezer, 'basil pesto')
  J2 = await jar(JEN, kitchen, 'Pesto')
  J3 = await jar(DAVE, freezer, 'tomato sauce')
})

afterAll(async () => {
  const ids = assertFixtureId(DAVE, JEN)
  await settle(`putup-postdeploy-refile teardown ${RUN}`, [
    () => directSql`DELETE FROM audit_events WHERE table_name = 'preservation_log' AND (actor_clerk_sub = ANY(${ids}) OR row_id IN (SELECT id FROM preservation_log WHERE user_id = ANY(${ids})))`,
    () => directSql`DELETE FROM preservation_log WHERE user_id = ANY(${ids})`,
    () => directSql`DELETE FROM storage_location WHERE user_id = ANY(${ids})`,
  ])
})

describe('scripts/putup-postdeploy-refile.mjs on real Neon', () => {
  it('a dry run prints the plan and writes nothing', async () => {
    const before = await state()
    const r = refile('--jar', J1, '--jar', J2)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/DRY RUN · target /)
    expect(r.out).toMatch(/after {3}: method pesto · use by 2027-08-19 · basis table {3}\[never moved: .*pesto in a deep_freezer: 12 months\]/)
    expect(r.out).toMatch(/after {3}: method pesto · use by 2026-12-19 · basis table {3}\[never moved: .*pesto in a fridge_freezer: 4 months\]/)
    expect(r.out).not.toContain(process.env.INT_DATABASE_URL)
    expect(await state()).toEqual(before)
  }, 120000)

  it('a tomato passata in the set refuses the whole run, even with --i-mean-it', async () => {
    const before = await state()
    const r = refile('--jar', J1, '--jar', J3, '--i-mean-it')
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/REFUSED : nothing on the jar says basil or pesto/)
    expect(await state()).toEqual(before)
  }, 120000)

  it('--i-mean-it re-files through the handler: dates by the correction rule, the audit row as the owner; again is a no-op', async () => {
    const [{ t0 }] = await directSql`SELECT now()::text AS t0`
    const r = refile('--jar', J1, '--jar', J2, '--i-mean-it')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(new RegExp(`PATCH /api/preservation/${J1} \\{"method":"pesto"\\} as ${DAVE} -> 200`))
    expect(r.out).toMatch(new RegExp(`PATCH /api/preservation/${J2} \\{"method":"pesto"\\} as ${JEN} -> 200`))
    const after = await state()
    const byId = Object.fromEntries(after.map((x) => [x.id, x]))
    expect(byId[J1]).toMatchObject({ method: 'pesto', use_by_target: '2027-08-19', use_by_basis: 'table' })
    expect(byId[J2]).toMatchObject({ method: 'pesto', use_by_target: '2026-12-19', use_by_basis: 'table' })
    expect(byId[J3]).toMatchObject({ method: 'passata', use_by_target: '2027-08-19', use_by_basis: 'table' })
    // Only the fridge-freezer jar moved a watched column; its audit row carries Jen, set by the handler's GUC.
    expect(await auditsSince(t0)).toEqual([
      { row_id: J2, action: 'UPDATE', actor_clerk_sub: JEN, before_date: '2027-08-19', after_date: '2026-12-19', after_method: 'pesto' },
    ])

    const again = refile('--jar', J1, '--jar', J2, '--i-mean-it')
    expect(again.code, again.out).toBe(0)
    expect(again.out).toMatch(/Nothing to do: every target is already pesto/)
    expect(await state()).toEqual(after)
  }, 180000)
})
