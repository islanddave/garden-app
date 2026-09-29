// tests/integration/source-edit.int.test.js
// V5-SOURCECONTACT-001 — GET + PATCH /api/varieties/sources/:id and the two new link columns,
// against a real Postgres.
//
// lambda/varieties/source-routes.test.js drives the routes through mock SQL, which proves which
// statements are issued with which binds and never that Postgres accepts them. This file closes the
// rest:
//   1. the PATCH's eight CASE arms write through (only the keys sent move) and GET reads them back;
//   2. chk_source_instagram_url / chk_source_facebook_url refuse a scheme-less link at the DB, and the
//      handler refuses the same input as a plain 400 before it gets there;
//   3. an edit that changes ONLY instagram_url leaves an audit_events row naming the caller — the
//      proof that 0a re-armed trg_audit_source_upd with the new column AND that the PATCH binds
//      app.actor_clerk_sub before its UPDATE. Before the re-arm this statement logged nothing;
//   4. the rename collision is steered (409) against a real match_key, and a non-member cannot edit a
//      row someone else created (403).
//
// REQUIRES v5-sourcecontact-001 ON STAGING. CI's integration branch forks staging and applies no
// migrations, so this file reds (42703 on instagram_url) until 0a has been applied there. That is
// the intended signal, not a flake: apply to staging before the dev push.
//
// Read-backs go through directSql, never the handler's echo. GARDEN_HOUSEHOLD_IDS is unset in the
// integration run, so USER is a non-member: the owner-only arm of canEditSource is what runs here.
//
// CLEANUP: public.source is not in _cleanup.js's sweep, so afterAll removes this run's rows itself.
// The hard DELETE fires trg_audit_source_del, and every direct write below binds the actor to an
// int-test id first, so each audit row this file causes is one the shared sweeper
// (audit_events.actor_clerk_sub LIKE '%int-test-%') also recognises.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId, setTestUserId, callHandler } from './_harness.js'
import { handler } from '../../lambda/varieties/index.js'

const RUN = testRunId()
const USER = `user_int_srcedit_${RUN}`
const FOREIGN = `user_int_srcedit_foreign_${RUN}`

let mineId, otherMineId, foreignId

const path = (id) => `/api/varieties/sources/${id}`
const patch = (id, body) => callHandler(handler, { method: 'PATCH', path: path(id), body })
const readBack = async (id) => (await directSql`
  SELECT name, kind, locality, address, website_url, instagram_url, facebook_url, notes, deleted_at
    FROM public.source WHERE id = ${id}`)[0]
// A direct write with the actor bound, so its audit row (if any) is attributable and sweepable.
const asActor = (actor, stmt) => directSql.transaction([
  directSql`SELECT set_config('app.actor_clerk_sub', ${actor}, true)`,
  stmt,
])

beforeAll(async () => {
  setTestUserId(USER)
  const a = await callHandler(handler, {
    method: 'POST', path: '/api/varieties/sources',
    body: { name: `Srcedit Stand ${RUN}`, locality: 'Hatfield, MA' },
  })
  expect(a.status).toBe(201)
  mineId = a.body.id
  const b = await callHandler(handler, {
    method: 'POST', path: '/api/varieties/sources',
    body: { name: `Srcedit Other ${RUN}` },
  })
  expect(b.status).toBe(201)
  otherMineId = b.body.id
  const f = await directSql`
    INSERT INTO public.source (name, created_by)
    VALUES (${`Srcedit Foreign ${RUN}`}, ${FOREIGN})
    RETURNING id`
  foreignId = f[0].id
})

afterAll(async () => {
  await asActor(USER, directSql`DELETE FROM public.source WHERE created_by IN (${USER}, ${FOREIGN})`)
  await directSql`DELETE FROM public.audit_events WHERE actor_clerk_sub IN (${USER}, ${FOREIGN})`
  await directSql`DELETE FROM public.rate_limit_buckets WHERE actor_clerk_sub IN (${USER}, ${FOREIGN})`
})

describe('V5-SOURCECONTACT-001 — the columns exist as the migration declares', () => {
  it('instagram_url and facebook_url are nullable text on public.source', async () => {
    const cols = await directSql`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'source'
         AND column_name IN ('instagram_url', 'facebook_url')
       ORDER BY column_name`
    expect(cols).toEqual([
      { column_name: 'facebook_url', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'instagram_url', data_type: 'text', is_nullable: 'YES' },
    ])
  })
})

describe('PATCH /api/varieties/sources/:id — round trip', () => {
  it('writes only the keys sent, and GET returns them', async () => {
    setTestUserId(USER)
    const { status } = await patch(mineId, {
      instagram_url: 'https://www.instagram.com/srcedit',
      address: '  12 River Rd  ',
    })
    expect(status).toBe(200)
    const row = await readBack(mineId)
    expect(row.instagram_url).toBe('https://www.instagram.com/srcedit')
    expect(row.address).toBe('12 River Rd')
    // Untouched by a PATCH that did not name it.
    expect(row.locality).toBe('Hatfield, MA')
    expect(row.name).toBe(`Srcedit Stand ${RUN}`)

    const got = await callHandler(handler, { method: 'GET', path: path(mineId) })
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ id: mineId, instagram_url: 'https://www.instagram.com/srcedit', address: '12 River Rd' })
    expect(got.body.created_by).toBeUndefined()
  })

  it('a blank field clears to NULL, never to an empty string', async () => {
    setTestUserId(USER)
    expect((await patch(mineId, { facebook_url: 'https://www.facebook.com/srcedit' })).status).toBe(200)
    expect((await readBack(mineId)).facebook_url).toBe('https://www.facebook.com/srcedit')
    expect((await patch(mineId, { facebook_url: '' })).status).toBe(200)
    expect((await readBack(mineId)).facebook_url).toBeNull()
  })

  it('the GET list carries both link columns', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/varieties/sources' })
    expect(status).toBe(200)
    const mine = body.find((s) => s.id === mineId)
    expect(mine).toBeTruthy()
    expect(Object.keys(mine)).toEqual(expect.arrayContaining(['instagram_url', 'facebook_url']))
  })
})

describe('the scheme CHECKs — DB and handler agree', () => {
  for (const col of ['instagram_url', 'facebook_url']) {
    it(`${col}: the DB refuses a scheme-less link with chk_source_${col}`, async () => {
      const bad = 'www.example.com/srcedit'
      const stmt = col === 'instagram_url'
        ? directSql`UPDATE public.source SET instagram_url = ${bad} WHERE id = ${mineId}`
        : directSql`UPDATE public.source SET facebook_url = ${bad} WHERE id = ${mineId}`
      await expect(asActor(USER, stmt)).rejects.toThrow(new RegExp(`chk_source_${col}`))
    })

    it(`${col}: the handler refuses the same input as a plain 400 first`, async () => {
      setTestUserId(USER)
      const before = await readBack(mineId)
      const { status, body } = await patch(mineId, { [col]: 'www.example.com/srcedit' })
      expect(status).toBe(400)
      expect(body.error).toMatch(new RegExp(`${col} must start with http`))
      expect((await readBack(mineId))[col]).toBe(before[col])
    })
  }
})

describe('the audit log sees an instagram_url-only edit', () => {
  it('writes an UPDATE row naming the caller, with the old and new link', async () => {
    setTestUserId(USER)
    const newUrl = `https://www.instagram.com/srcedit_${Date.now()}`
    const before = (await readBack(mineId)).instagram_url
    expect((await patch(mineId, { instagram_url: newUrl })).status).toBe(200)

    const rows = await directSql`
      SELECT action, actor_clerk_sub,
             before_jsonb->>'instagram_url' AS before_ig,
             after_jsonb->>'instagram_url'  AS after_ig
        FROM public.audit_events
       WHERE table_name = 'source'
         AND row_id = ${mineId}
         AND after_jsonb->>'instagram_url' = ${newUrl}`
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('UPDATE')
    // The caller, not 'system': the set_config ran first, inside the same transaction.
    expect(rows[0].actor_clerk_sub).toBe(USER)
    expect(rows[0].before_ig).toBe(before)
    expect(rows[0].after_ig).toBe(newUrl)
  })
})

describe('rename, authz and absence', () => {
  it('a rename that folds onto another live source is a 409 naming it, and writes nothing', async () => {
    setTestUserId(USER)
    const { status, body } = await patch(otherMineId, { name: `srcedit-stand ${RUN}`.toUpperCase() })
    expect(status).toBe(409)
    expect(body.reason).toBe('exists')
    expect(body.existing.id).toBe(mineId)
    expect((await readBack(otherMineId)).name).toBe(`Srcedit Other ${RUN}`)
  })

  it('a non-member cannot edit a source someone else created (403), and nothing moves', async () => {
    setTestUserId(USER)
    const { status } = await patch(foreignId, { notes: 'not mine' })
    expect(status).toBe(403)
    expect((await readBack(foreignId)).notes).toBeNull()
  })

  it('a soft-deleted source is 404 to both GET and PATCH', async () => {
    setTestUserId(USER)
    await asActor(USER, directSql`UPDATE public.source SET deleted_at = now() WHERE id = ${otherMineId}`)
    expect((await callHandler(handler, { method: 'GET', path: path(otherMineId) })).status).toBe(404)
    expect((await patch(otherMineId, { notes: 'x' })).status).toBe(404)
    expect((await readBack(otherMineId)).notes).toBeNull()
  })

  it('DELETE is refused with 405', async () => {
    setTestUserId(USER)
    expect((await callHandler(handler, { method: 'DELETE', path: path(mineId) })).status).toBe(405)
    expect((await readBack(mineId)).deleted_at).toBeNull()
  })
})
