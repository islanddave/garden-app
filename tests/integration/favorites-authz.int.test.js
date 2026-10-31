// favorites-authz.int.test.js — 0A.5 Phase-1 leak-lock for the favorites Lambda
// (lambda/favorites/index.js). Real handler vs an ephemeral Neon branch (harness stubs
// SecretsManager + Clerk; SQL is REAL). Compensating control for the RLS-off posture (see _authz.js).
//
// AUTH MODEL: PURELY per-user — every branch gates on `user_id = ${userId}` (GET list :72, GET
// single-check :62-66, POST upsert :84-86 with ON CONFLICT (user_id,entity_type,entity_id), DELETE
// :99-102). No household widening: favorites ships household.js only for the SEC-13a gate; bookmarks are
// personal, not shared. No FK on entity_id and no deleted_at column (hard delete), so a custom block, not the
// generic matrix. entity_id is an unvalidated uuid — favoriting an arbitrary/foreign uuid is benign
// (the row stores only the uuid the caller already supplied; reads never JOIN the entity, so nothing
// about it leaks — see the report note, not a finding).
import { describe, it, expect, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { directSql, callHandler, makeEvent, setTestUserId, testRunId } from './_harness.js'
// After _harness.js, whose vi.mock replaces this module with the stub; imported first it would be the real one.
import { verifyToken } from '@clerk/backend'
import { handler as favoritesHandler } from '../../lambda/favorites/index.js'

describe('AUTHZ favorites /api/favorites — per-user scope (user_id) (0A.5)', () => {
  const RUN = testRunId()
  const OWNER = `authz_fav_owner_${RUN}`
  const FOREIGN = `authz_fav_foreign_${RUN}`
  const ENTITY_ID = randomUUID() // no FK on favorites.entity_id — any uuid is a valid bookmark target
  let ownerFavId

  afterAll(async () => {
    await directSql`DELETE FROM favorites WHERE user_id IN (${OWNER}, ${FOREIGN})`
  })

  it('owner-write: POST favorite → 201, row created under OWNER', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(favoritesHandler, {
      method: 'POST', path: '/api/favorites', body: { entity_type: 'project', entity_id: ENTITY_ID },
    })
    expect(status).toBe(201)
    expect(body.favorited).toBe(true)
    ownerFavId = body.id
    const rows = await directSql`SELECT user_id FROM favorites WHERE id = ${ownerFavId}`
    expect(rows[0].user_id).toBe(OWNER)
  })

  it('owner-read: GET list contains own favorite', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(favoritesHandler, { method: 'GET', path: '/api/favorites' })
    expect(status).toBe(200)
    expect(body.map((f) => f.entity_id)).toContain(ENTITY_ID)
  })

  it('owner-read: single-entity check returns favorited:true', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(favoritesHandler, {
      method: 'GET', path: `/api/favorites?entity_type=project&entity_id=${ENTITY_ID}`,
    })
    expect(status).toBe(200)
    expect(body.favorited).toBe(true)
  })

  it('non-owner-read: foreign GET list does NOT leak the owner favorite', async () => {
    setTestUserId(FOREIGN)
    const { status, body } = await callHandler(favoritesHandler, { method: 'GET', path: '/api/favorites' })
    expect(status).toBe(200)
    expect(body.map((f) => f.entity_id)).not.toContain(ENTITY_ID)
  })

  it('non-owner-read: foreign single-entity check on the SAME entity returns favorited:false', async () => {
    setTestUserId(FOREIGN)
    const { status, body } = await callHandler(favoritesHandler, {
      method: 'GET', path: `/api/favorites?entity_type=project&entity_id=${ENTITY_ID}`,
    })
    expect(status).toBe(200)
    expect(body.favorited).toBe(false) // favorited is per-user, never the household's aggregate state
  })

  it('non-owner-write: foreign DELETE of the same entity leaves the owner favorite intact', async () => {
    setTestUserId(FOREIGN)
    const { status } = await callHandler(favoritesHandler, {
      method: 'DELETE', path: `/api/favorites?entity_type=project&entity_id=${ENTITY_ID}`,
    })
    expect(status).toBe(200) // DELETE is unconditionally 200; the user_id predicate makes it a no-op for FOREIGN
    const rows = await directSql`SELECT id FROM favorites WHERE id = ${ownerFavId}`
    expect(rows.length).toBe(1) // ownership-scoped-delete regression guard
  })

  it('owner-write: owner DELETE removes their own favorite', async () => {
    setTestUserId(OWNER)
    const { status } = await callHandler(favoritesHandler, {
      method: 'DELETE', path: `/api/favorites?entity_type=project&entity_id=${ENTITY_ID}`,
    })
    expect(status).toBe(200)
    const rows = await directSql`SELECT id FROM favorites WHERE id = ${ownerFavId}`
    expect(rows.length).toBe(0)
  })
})

describe('favorites — SEC-60: a verified token with no subject', () => {
  it('SEC-60: a POST with no subject is 401 and writes no favorite (it reached the INSERT: 23502, a 500)', async () => {
    const entity = randomUUID()
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.resolve({ azp: 'https://garden.futureishere.net' }))
    const r = await favoritesHandler(makeEvent({ method: 'POST', path: '/api/favorites', body: { entity_type: 'project', entity_id: entity } }))
    expect(r.statusCode).toBe(401)
    expect(JSON.parse(r.body)).toEqual({ error: 'Unauthorized' })
    expect(await directSql`SELECT 1 FROM favorites WHERE entity_id = ${entity}::uuid`).toEqual([])
  })
})
