// storage-location.int.test.js — integration coverage for the storage-location Lambda.
// Runs the REAL handler (lambda/storage-location/index.js) against an ephemeral Neon branch
// with SecretsManager + Clerk stubbed by the harness. Every assertion mirrors index.js, verified
// against the live staging schema (storage_location: user_id text NN, label text NN, kind CHECK).
//
// Surfaces: POST (label-required, kind-enum, create returns 201 + RETURNING *), GET list (BARE
// array, user-scoped, soft-delete excluded), PUT (COALESCE update, foreign-owner 404, kind-enum
// 400), DELETE (RETURNING-gated soft-delete, NOT idempotent -> 404).
//
// BUG-DELNOOPOK-001 (2026-08-13) changed the DELETE contract. It was "idempotent {ok:true}" — an
// unconditional 200 that made not-found, already-deleted and NOT-OWNED indistinguishable, and that
// forced storage-location-authz.int.test.js to pin the DELETE's ownership property by reading row
// state instead of status. It now RETURNING-gates and 404s, matching the PUT above it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/storage-location/index.js'

const RUN = testRunId()
const USER = `user_int_stor_${RUN}`
const FOREIGN_USER = `user_int_stor_foreign_${RUN}`
let foreignId

beforeAll(async () => {
  setTestUserId(USER)
  const fl = await directSql`
    INSERT INTO storage_location (user_id, label, kind)
    VALUES (${FOREIGN_USER}, ${'foreign-freezer-' + RUN}, ${'deep_freezer'})
    RETURNING id
  `
  foreignId = fl[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM storage_location WHERE user_id IN (${USER}, ${FOREIGN_USER})`
})

describe('POST /api/storage-locations — validation + create', () => {
  it('missing label -> 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { kind: 'pantry' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/label is required/i)
  })

  it('invalid kind -> 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'x-' + RUN, kind: 'igloo' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/kind must be one of/i)
  })

  it('valid POST -> 201, scoped to user_id, stored (write->read-back)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Garage Freezer ' + RUN, kind: 'deep_freezer' },
    })
    expect(status).toBe(201)
    expect(body.id).toBeTruthy()
    expect(body.label).toBe('Garage Freezer ' + RUN)
    expect(body.kind).toBe('deep_freezer')
    expect(body.user_id).toBe(USER)
    const rows = await directSql`SELECT label, kind, user_id FROM storage_location WHERE id = ${body.id}`
    expect(rows[0].user_id).toBe(USER)
    expect(rows[0].kind).toBe('deep_freezer')
  })
})

describe('GET /api/storage-locations — list (bare array, user-scoped)', () => {
  it('returns a BARE ARRAY, foreign owner excluded, soft-deletes excluded', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Pantry ' + RUN, kind: 'pantry' },
    })
    const del = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Gone ' + RUN, kind: 'fridge' },
    })
    await directSql`UPDATE storage_location SET deleted_at = NOW() WHERE id = ${del.body.id}`
    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/storage-locations' })
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const ids = body.map((r) => r.id)
    expect(ids).toContain(created.body.id)
    expect(ids).not.toContain(foreignId)
    expect(ids).not.toContain(del.body.id)
  })
})

describe('PUT /api/storage-locations/:id — update', () => {
  it('foreign-owner -> 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'PUT', path: `/api/storage-locations/${foreignId}`, body: { label: 'hijack' },
    })
    expect(status).toBe(404)
  })

  it('COALESCE update -> 200, label changed, kind preserved', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Before ' + RUN, kind: 'cold_storage' },
    })
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/storage-locations/${created.body.id}`, body: { label: 'After ' + RUN },
    })
    expect(status).toBe(200)
    expect(body.label).toBe('After ' + RUN)
    expect(body.kind).toBe('cold_storage') // COALESCE: null kind in body -> keep existing
  })

  it('invalid kind in PUT -> 400', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Kind Edit ' + RUN, kind: 'fridge' },
    })
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/storage-locations/${created.body.id}`, body: { kind: 'wormhole' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/kind must be one of/i)
  })
})

describe('DELETE /api/storage-locations/:id — soft-delete (idempotent)', () => {
  it('own DELETE -> 200 {ok:true}; deleted_at set; excluded from list', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Del ' + RUN, kind: 'other' },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, { method: 'DELETE', path: `/api/storage-locations/${id}` })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const rows = await directSql`SELECT deleted_at FROM storage_location WHERE id = ${id}`
    expect(rows[0].deleted_at).toBeTruthy()
  })

  // BUG-DELNOOPOK-001 REVERSED this test's intent. It asserted 200 {ok:true} on a non-existent id
  // and called it idempotence; it was the absence of a RETURNING-gate. Still mirrors locations —
  // both routes moved to 404 in the same change. Do not restore the old assertion.
  it('DELETE non-existent -> 404 (NOT idempotent, mirrors locations)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'DELETE', path: `/api/storage-locations/00000000-0000-4000-8000-0000000000dd`,
    })
    expect(status).toBe(404)
    expect(body.error).toBe('Not found')
  })

  // The foreign-owner arm, which the old contract could not express at all: with the gate in
  // place, a not-owned DELETE is the same 404 as an unknown id — deliberately collapsed so the
  // status never reveals that the row exists. storage-location-authz.int.test.js:39 additionally
  // reads the row back; both claims matter, and neither replaces the other.
  it("DELETE another user's storage_location -> 404, row untouched", async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'DELETE', path: `/api/storage-locations/${foreignId}`,
    })
    expect(status, `foreign DELETE → ${JSON.stringify(body)}`).toBe(404)
    expect(body.error).toBe('Not found')
    const rows = await directSql`SELECT deleted_at FROM storage_location WHERE id = ${foreignId}`
    expect(rows[0].deleted_at).toBeNull()
  })
})
