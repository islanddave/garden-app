// spaces-guards.int.test.js — migrations/v5-spaceguard-001 against REAL Postgres (multi-space Phase 1:
// 1.1 C-AUDIT on spaces, 1.2 the coordinate freeze, 1.3b no cascade loss off a Space). Ledger
// V5-SPACEREPOINTGUARD-001 and V4-SPACESOFTDEL-001. CI-run only (integration-test.yml), needs INT_DATABASE_URL.
//
// SELF-SKIPS while the fork lacks stamp 5.1.5-spaceguard-001. The integration branch forks staging, and the
// DDL reaches staging in its own sitting after this file is on dev. Skipping is checked, not assumed: without
// the stamp, one case asserts that none of the guards is installed either (a hand-applied guard with no stamp
// would otherwise hide behind the skip), and with it, one asserts all eight triggers are there and enabled.
//
// What only a real database proves here (rehearse_local.py proves the same SQL on a prod-schema replica;
// this file drives the REAL photos Lambda for the writers):
//   * 1.1: each writer of spaces leaves exactly one audit row, scoped to this file's Space and action, with
//     the actor the code stamps: the user for the soft delete (photoDelete.js sets app.actor_clerk_sub in the
//     same batch), 'system' for auto-promote, the hero PUT, the restore replay and the ON DELETE SET NULL of a
//     hard photo delete. A same-hero PUT writes none and keeps the 1.2 data gate green for this Space.
//   * 1.2: a coordinate change refuses (P0001, spaces_repoint_guard) while weather names the Space, in every
//     shape that reaches it (value to value, to NULL, from NULL, ON CONFLICT DO UPDATE, several rows), and
//     passes when the triple is unchanged or the Space has no weather.
//   * 1.3b: a Space whose only child is one row of any referencing table refuses to delete (P0001,
//     spaces_delete_guard, naming the table) and keeps its child; a childless Space deletes; TRUNCATE of
//     either weather table refuses. The TRUNCATE runs in a transaction that is forced to roll back, so even a
//     missing guard empties nothing. TRUNCATE ... CASCADE and DROP COLUMN are rehearsal-only (they lock
//     tables other files are using).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'

vi.hoisted(() => {
  process.env.S3_PHOTOS_BUCKET = 'garden-photos-int-test'
  process.env.AWS_REGION = 'us-east-1'
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client, cmd) =>
    `https://stub-s3.invalid/${cmd?.input?.Key ?? 'unknown'}?signed=1`),
}))

const { handler } = await import('../../lambda/photos/index.js')

const STAMP = '5.1.5-spaceguard-001'
const GUARD_TRIGGERS = [
  'trg_audit_spaces_upd', 'trg_audit_spaces_del', 'trg_audit_spaces_ins', 'spaces_repoint_guard',
  'spaces_delete_guard', 'spaces_truncate_guard', 'weather_daily_truncate_guard', 'weather_cold_range_truncate_guard',
]

const APPLIED = (await directSql`
  SELECT (to_regclass('public.schema_version') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = ${STAMP})) AS ok`)[0].ok

const installed = async () => (await directSql`
  SELECT g.tgname, g.tgenabled FROM pg_trigger g
   WHERE NOT g.tgisinternal AND g.tgname = ANY(${GUARD_TRIGGERS}::text[])`)

describe('v5-spaceguard-001 presence', () => {
  it.runIf(!APPLIED)(`without ${STAMP} none of the guards is installed (so skipping the cases hides nothing)`, async () => {
    expect(await installed()).toEqual([])
  })
  it.runIf(APPLIED)(`${STAMP} means all eight triggers are installed and enabled`, async () => {
    const rows = await installed()
    expect(rows.map((r) => r.tgname).sort()).toEqual([...GUARD_TRIGGERS].sort())
    expect(rows.every((r) => r.tgenabled === 'O')).toBe(true)
  })
})

const RUN = testRunId()
const USER = `user_int_spaceguard_${RUN}`

const auditIds = async (spaceId, action) => new Set((await directSql`
  SELECT id FROM audit_events WHERE table_name = 'spaces' AND row_id = ${spaceId} AND action = ${action}`)
  .map((r) => r.id))

// The audit rows a step wrote: the set difference by id (rows of one transaction share ts, so never by ts).
async function auditedBy(spaceId, action, step) {
  const seen = await auditIds(spaceId, action)
  await step()
  const rows = await directSql`
    SELECT id, actor_clerk_sub, after_jsonb FROM audit_events
     WHERE table_name = 'spaces' AND row_id = ${spaceId} AND action = ${action}`
  return rows.filter((r) => !seen.has(r.id))
}

async function newSpace(label, { lat = null, lng = null, zip = null } = {}) {
  const rows = await directSql`
    INSERT INTO spaces (name, created_by, weather_lat, weather_lng, postal_code)
    VALUES (${`int-spaceguard-${label}-${RUN}`}, ${USER}, ${lat}, ${lng}, ${zip}) RETURNING id`
  return rows[0].id
}
const addWeather = (spaceId) => directSql`
  INSERT INTO weather_daily (space_id, date, tmax_f, tmin_f, precip_in) VALUES (${spaceId}, '2001-06-01', 80, 60, 0.1)`
const addColdRange = (spaceId) => directSql`
  INSERT INTO weather_cold_range (space_id, night_date, init_time, p10_min_f, leads_read, leads_expected)
  VALUES (${spaceId}, '2001-10-01', '2001-10-01T00:00:00Z', 30, 15, 15)`

// The error a statement raised, as { code, message }; null when it did not raise.
async function errorOf(promise) {
  try { await promise } catch (e) { return { code: e.code, message: e.message } }
  return null
}

// The 1.2 data gate, read from gates.yml so this file tests the gate that ships, scoped to one Space. Read only
// when a case runs, so the file still imports (and self-skips) on a checkout without the migration directory.
const dataGateSql = () => yaml.load(readFileSync(new URL('../../migrations/v5-spaceguard-001/gates.yml', import.meta.url), 'utf8'))
  .post.find((g) => g.name === 'post_space_coordinates_match_newest_audit').sql
const dataGateRedFor = async (spaceId) =>
  (await directSql(`SELECT * FROM (${dataGateSql()}) g(id) WHERE g.id = $1`, [spaceId])).length > 0

describe.skipIf(!APPLIED)('spaces guards and audit (v5-spaceguard-001)', () => {
  const ids = {}
  let savedFlag

  beforeAll(async () => {
    assertFixtureId(RUN)
    savedFlag = process.env.SPACE_PHOTOS_ENABLED
    process.env.SPACE_PHOTOS_ENABLED = 'true'
    setTestUserId(USER)
    ids.hero = await newSpace('hero')
  })

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.SPACE_PHOTOS_ENABLED; else process.env.SPACE_PHOTOS_ENABLED = savedFlag
    const mine = () => directSql`SELECT id FROM spaces WHERE created_by = ${USER}`
    const failed = await settle('spaces-guards.int', [
      () => directSql`UPDATE spaces SET featured_photo_id = NULL WHERE created_by = ${USER}`,
      () => directSql`DELETE FROM photos WHERE created_by = ${USER}`,
      // Children first: spaces_delete_guard refuses a Space any of these still name.
      async () => { for (const { id } of await mine()) await directSql`DELETE FROM weather_daily WHERE space_id = ${id}` },
      async () => { for (const { id } of await mine()) await directSql`DELETE FROM weather_cold_range WHERE space_id = ${id}` },
      async () => { for (const { id } of await mine()) await directSql`DELETE FROM spacetheme WHERE space_id = ${id}` },
      () => directSql`DELETE FROM spaces WHERE created_by = ${USER}`,
    ])
    expect(failed, 'spaces-guards teardown steps failed').toEqual([])
  })

  describe('1.1 every writer of spaces leaves one audit row, with the actor it stamps', () => {
    it('a new Space: one INSERT row carrying the row, actor system', async () => {
      const rows = await directSql`
        SELECT actor_clerk_sub, after_jsonb FROM audit_events
         WHERE table_name = 'spaces' AND row_id = ${ids.hero} AND action = 'INSERT'`
      expect(rows).toHaveLength(1)
      expect(rows[0].actor_clerk_sub).toBe('system')
      expect(rows[0].after_jsonb.name).toBe(`int-spaceguard-hero-${RUN}`)
    })

    it('upload auto-promotes the first space photo (photos/index.js:180): one row, actor system', async () => {
      let res
      const rows = await auditedBy(ids.hero, 'UPDATE', async () => {
        res = await callHandler(handler, {
          method: 'POST', path: '/api/photos', body: { storage_path: `standalone/${RUN}-g1.jpg`, space_id: ids.hero },
        })
      })
      expect(res.status).toBeLessThan(300)
      ids.p1 = res.body.id
      expect(rows).toHaveLength(1)
      expect(rows[0].actor_clerk_sub).toBe('system')
      expect(rows[0].after_jsonb.featured_photo_id).toBe(ids.p1)
    })

    it('a second upload does not displace the hero: no row', async () => {
      let res
      const rows = await auditedBy(ids.hero, 'UPDATE', async () => {
        res = await callHandler(handler, {
          method: 'POST', path: '/api/photos', body: { storage_path: `standalone/${RUN}-g2.jpg`, space_id: ids.hero },
        })
      })
      ids.p2 = res.body.id
      expect(rows).toHaveLength(0)
    })

    it('PUT space-featured (photos/index.js:844): one row, actor system', async () => {
      let res
      const rows = await auditedBy(ids.hero, 'UPDATE', async () => {
        res = await callHandler(handler, {
          method: 'PUT', path: `/api/photos/space-featured/${ids.hero}`, body: { photo_id: ids.p2 },
        })
      })
      expect(res.status).toBe(200)
      expect(rows).toHaveLength(1)
      expect(rows[0].actor_clerk_sub).toBe('system')
      expect(rows[0].after_jsonb.featured_photo_id).toBe(ids.p2)
    })

    it('a same-hero PUT moves only updated_at: no row, and the 1.2 data gate stays green for this Space', async () => {
      let res
      const rows = await auditedBy(ids.hero, 'UPDATE', async () => {
        res = await callHandler(handler, {
          method: 'PUT', path: `/api/photos/space-featured/${ids.hero}`, body: { photo_id: ids.p2 },
        })
      })
      expect(res.status).toBe(200)
      expect(rows).toHaveLength(0)
      expect(await dataGateRedFor(ids.hero)).toBe(false)
    })

    it('deleting the hero photo clears it (photoDelete.js:122): one row, actor = the user', async () => {
      let res
      const rows = await auditedBy(ids.hero, 'UPDATE', async () => {
        res = await callHandler(handler, { method: 'DELETE', path: `/api/photos/${ids.p2}` })
      })
      expect(res.status).toBe(200)
      expect(rows).toHaveLength(1)
      expect(rows[0].actor_clerk_sub).toBe(USER)
      expect(rows[0].after_jsonb.featured_photo_id).toBeNull()
    })

    it('restoring it replays the hero (photoDelete.js:328): one row, actor system', async () => {
      let res
      const rows = await auditedBy(ids.hero, 'UPDATE', async () => {
        res = await callHandler(handler, { method: 'POST', path: `/api/photos/${ids.p2}/restore` })
      })
      expect(res.status).toBe(200)
      expect(rows).toHaveLength(1)
      expect(rows[0].actor_clerk_sub).toBe('system')
      expect(rows[0].after_jsonb.featured_photo_id).toBe(ids.p2)
    })

    it('a hard photo delete nulls the hero through ON DELETE SET NULL: one row, actor system', async () => {
      const rows = await auditedBy(ids.hero, 'UPDATE', () => directSql`DELETE FROM photos WHERE id = ${ids.p2}`)
      expect(rows).toHaveLength(1)
      expect(rows[0].actor_clerk_sub).toBe('system')
      expect(rows[0].after_jsonb.featured_photo_id).toBeNull()
    })

    it('a childless Space deletes, leaving one DELETE row', async () => {
      const id = await newSpace('bare')
      const rows = await auditedBy(id, 'DELETE', () => directSql`DELETE FROM spaces WHERE id = ${id}`)
      expect(rows).toHaveLength(1)
      expect(rows[0].after_jsonb).toBeNull()
    })
  })

  describe('1.2 a Space with weather keeps its coordinates', () => {
    beforeAll(async () => {
      ids.a = await newSpace('repoint-a', { lat: 42.5, lng: -72.6, zip: '01373' })
      await addWeather(ids.a)
      ids.b = await newSpace('repoint-b')
      await addWeather(ids.b)
      ids.c = await newSpace('repoint-c', { lat: 42.5, lng: -72.6, zip: '01373' })
      await addColdRange(ids.c)
      ids.free = await newSpace('repoint-free', { lat: 42.5, lng: -72.6, zip: '01373' })
    })

    const refuses = async (stmt) => {
      const e = await errorOf(stmt)
      expect(e?.code).toBe('P0001')
      expect(e?.message).toMatch(/^spaces_repoint_guard: /)
    }

    it('value to value refuses', () => refuses(directSql`UPDATE spaces SET weather_lat = 43.1 WHERE id = ${ids.a}`))
    it('value to NULL refuses', () => refuses(directSql`UPDATE spaces SET weather_lng = NULL WHERE id = ${ids.a}`))
    it('NULL to value refuses', () => refuses(directSql`UPDATE spaces SET postal_code = '01002' WHERE id = ${ids.b}`))
    it('cold-range history alone refuses', () => refuses(directSql`UPDATE spaces SET weather_lat = 40 WHERE id = ${ids.c}`))
    it('INSERT ... ON CONFLICT DO UPDATE refuses', () => refuses(directSql`
      INSERT INTO spaces (id, name, created_by, weather_lat) VALUES (${ids.a}, 'x', ${USER}, 41)
      ON CONFLICT (id) DO UPDATE SET weather_lat = EXCLUDED.weather_lat`))
    it('a statement over several rows refuses, and changes none', async () => {
      await refuses(directSql`UPDATE spaces SET postal_code = '01001' WHERE id IN (${ids.free}, ${ids.a})`)
      const rows = await directSql`SELECT postal_code FROM spaces WHERE id IN (${ids.free}, ${ids.a})`
      expect(rows.map((r) => r.postal_code)).toEqual(['01373', '01373'])
    })
    it('the same values, and other columns, pass', async () => {
      expect(await errorOf(directSql`
        UPDATE spaces SET weather_lat = weather_lat, postal_code = postal_code, name = name || '' WHERE id = ${ids.a}`)).toBeNull()
    })
    it('a Space with no weather moves, and the move is audited', async () => {
      const rows = await auditedBy(ids.free, 'UPDATE',
        () => directSql`UPDATE spaces SET weather_lat = 44 WHERE id = ${ids.free}`)
      expect(rows).toHaveLength(1)
      expect(Number(rows[0].after_jsonb.weather_lat)).toBe(44)
      expect(await dataGateRedFor(ids.free)).toBe(false)
    })
  })

  describe('1.3b a Space is not deleted out from under anything that names it', () => {
    const onlyChild = (table, add) => async () => {
      const id = await newSpace(`only-${table}`)
      await add(id)
      const e = await errorOf(directSql`DELETE FROM spaces WHERE id = ${id}`)
      expect(e?.code).toBe('P0001')
      expect(e?.message).toMatch(/^spaces_delete_guard: /)
      expect(e?.message).toContain(`public.${table}`)
      expect((await directSql`SELECT count(*)::int AS n FROM spaces WHERE id = ${id}`)[0].n).toBe(1)
      expect((await directSql(`SELECT count(*)::int AS n FROM public.${table} WHERE space_id = $1`, [id]))[0].n).toBe(1)
    }

    it('only child a weather_daily row: refused, both kept', onlyChild('weather_daily', addWeather))
    it('only child a weather_cold_range row: refused, both kept', onlyChild('weather_cold_range', addColdRange))
    it('only child a spacetheme row: refused, both kept',
      onlyChild('spacetheme', (id) => directSql`INSERT INTO spacetheme (space_id) VALUES (${id})`))
    it('only child a photo: refused by the guard before the RESTRICT key', onlyChild('photos', (id) => directSql`
      INSERT INTO photos (storage_path, uploaded_by, created_by, space_id)
      VALUES (${`spaces/${RUN}/only.jpg`}, ${USER}, ${USER}, ${id})`))

    it.each(['weather_daily', 'weather_cold_range'])('TRUNCATE %s refuses (in a transaction forced to roll back)', async (table) => {
      const e = await errorOf(directSql.transaction([
        directSql(`TRUNCATE public.${table}`),
        directSql`SELECT 1 / 0`,
      ]))
      expect(e?.code).toBe('P0001')
      expect(e?.message).toContain(`${table}_truncate_guard: TRUNCATE of public.${table}`)
    })
  })
})
