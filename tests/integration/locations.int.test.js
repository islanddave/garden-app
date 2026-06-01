// locations.int.test.js — integration coverage for the locations Lambda.
// Verified against lambda/locations/index.js at dev HEAD 77a4cf4b — every assertion
// reads the handler code, not the Phase-2 design doc.
//
// Surfaces covered: POST (name-required, slug auto-gen, explicit-slug passthrough,
// parent level derivation, 23505 -> 409), GET list ({locations, locations_with_path}
// object shape — NOT a bare array — household-scoped, soft-delete excluded), GET
// /with-path (bare array), GET /:id (slug-or-uuid resolve, foreign-owner 404,
// non-existent 404, featured_photo_view_url key + storage_path stripped), PUT
// (COALESCE update, foreign-owner 404, featured_photo_id strict-link 400), DELETE
// (soft-delete, idempotent {ok:true}).
//
// Locations are HOUSEHOLD-scoped (created_by = ANY(householdScope(userId))), not
// project-scoped — no plant_projects fixture needed (unlike plants/events).
//
// Skipped this bite (separate follow-up): featured_photo_id happy-path linkage
// (needs photos row with location_id + S3 presign mock); entity-tags co-resident
// route family (separate surface, needs entity_tags fixtures).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/locations/index.js'

const RUN = testRunId()
const USER = `user_int_loc_${RUN}`
const FOREIGN_USER = `user_int_loc_foreign_${RUN}`
let foreignLocId

beforeAll(async () => {
  setTestUserId(USER)
  // Foreign-owned location, inserted directly (bypasses handler) to test household scope.
  const fl = await directSql`
    INSERT INTO locations (name, slug, level, created_by)
    VALUES (${'foreign-loc-' + RUN}, ${'foreign-loc-' + RUN}, ${0}, ${FOREIGN_USER})
    RETURNING id
  `
  foreignLocId = fl[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM locations WHERE created_by IN (${USER}, ${FOREIGN_USER})`
})

describe('POST /api/locations — validation + create', () => {
  it('missing name -> 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/locations', body: {},
    })
    expect(status).toBe(400) // handler: if (!body.name) return resp(400, ...)
    expect(body.error).toMatch(/name is required/i)
  })

  it('valid POST -> 201, slug auto-generated from name, level 0, stored', async () => {
    setTestUserId(USER)
    const name = 'Greenhouse Bench ' + RUN
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/locations', body: { name },
    })
    expect(status).toBe(201)
    expect(body.id).toBeTruthy()
    expect(body.name).toBe(name)
    // slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')
    expect(body.slug).toBe(('greenhouse-bench-' + RUN).toLowerCase())
    expect(body.level).toBe(0)
    expect(body.created_by).toBe(USER)
    const rows = await directSql`SELECT name, slug, created_by FROM locations WHERE id = ${body.id}`
    expect(rows[0].name).toBe(name)
    expect(rows[0].created_by).toBe(USER)
  })

  it('explicit slug passed -> trimmed slug preserved (not regenerated from name)', async () => {
    setTestUserId(USER)
    const slug = 'custom-slug-' + RUN
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/locations',
      body: { name: 'Some Name ' + RUN, slug: '  ' + slug + '  ' },
    })
    expect(status).toBe(201)
    expect(body.slug).toBe(slug) // handler: body.slug?.trim() || <derived>
  })

  it('parent_id (owned) -> child level = parent.level + 1', async () => {
    setTestUserId(USER)
    const parent = await callHandler(handler, {
      method: 'POST', path: '/api/locations', body: { name: 'Parent Zone ' + RUN },
    })
    expect(parent.status).toBe(201)
    expect(parent.body.level).toBe(0)
    const child = await callHandler(handler, {
      method: 'POST', path: '/api/locations',
      body: { name: 'Child Bed ' + RUN, parent_id: parent.body.id },
    })
    expect(child.status).toBe(201)
    expect(child.body.level).toBe(1) // Math.min(parent.level + 1, 3)
    expect(child.body.parent_id).toBe(parent.body.id)
  })

  it('duplicate slug (same household) -> 409 Slug already exists', async () => {
    setTestUserId(USER)
    const slug = 'dup-slug-' + RUN
    const first = await callHandler(handler, {
      method: 'POST', path: '/api/locations',
      body: { name: 'First ' + RUN, slug },
    })
    expect(first.status).toBe(201)
    const dup = await callHandler(handler, {
      method: 'POST', path: '/api/locations',
      body: { name: 'Second ' + RUN, slug },
    })
    expect(dup.status).toBe(409) // handler: if (err.code === '23505') return resp(409, ...)
    expect(dup.body.error).toMatch(/slug already exists/i)
  })
})

describe('GET /api/locations — list', () => {
  it('returns {locations, locations_with_path} OBJECT (not a bare array), household-scoped', async () => {
    setTestUserId(USER)
    await callHandler(handler, {
      method: 'POST', path: '/api/locations', body: { name: 'List Member ' + RUN },
    })
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: '/api/locations',
    })
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(false)
    expect(Array.isArray(body.locations)).toBe(true)
    expect(Array.isArray(body.locations_with_path)).toBe(true)
    const ids = body.locations.map((r) => r.id)
    expect(ids).not.toContain(foreignLocId) // household scope excludes foreign owner
    for (const row of body.locations) {
      expect(row).toHaveProperty('slug')
      expect(row).toHaveProperty('level')
      expect(row).toHaveProperty('parent_id')
    }
  })

  it('soft-deleted rows excluded from list', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/locations', body: { name: 'Soft Del ' + RUN },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    await directSql`UPDATE locations SET deleted_at = NOW() WHERE id = ${id}`
    const { body } = await callHandler(handler, { method: 'GET', path: '/api/locations' })
    const ids = body.locations.map((r) => r.id)
    expect(ids).not.toContain(id)
  })
})

describe('GET /api/locations/with-path — bare array branch', () => {
  it('returns a bare ARRAY (special-cased, not the {locations,...} object)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: '/api/locations/with-path',
    })
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true) // resp(200, pathRows) when rawPath === '/api/locations/with-path'
  })
})

describe('GET /api/locations/:id — single (slug-or-uuid)', () => {
  it('own location by UUID -> 200, featured_photo_view_url key present, storage_path stripped', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/locations', body: { name: 'Single Get ' + RUN },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/locations/${id}`,
    })
    expect(status).toBe(200)
    expect(body.id).toBe(id)
    expect(body).toHaveProperty('featured_photo_view_url') // null (no photo) but key present
    expect(body.featured_photo_view_url).toBeNull()
    expect(body).not.toHaveProperty('featured_photo_storage_path') // explicitly destructured out
  })

  it('own location by SLUG -> 200 (route resolves slug OR uuid)', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/locations', body: { name: 'By Slug ' + RUN },
    })
    const slug = created.body.slug
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/locations/${slug}`,
    })
    expect(status).toBe(200)
    expect(body.slug).toBe(slug)
  })

  it('foreign-owner location -> 404 (household scope filter)', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'GET', path: `/api/locations/${foreignLocId}`,
    })
    expect(status).toBe(404)
  })

  it('non-existent UUID -> 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'GET', path: `/api/locations/00000000-0000-4000-8000-000000000000`,
    })
    expect(status).toBe(404)
  })
})

describe('PUT /api/locations/:id — update', () => {
  it('foreign-owner -> 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'PUT', path: `/api/locations/${foreignLocId}`,
      body: { name: 'hijack-attempt' },
    })
    expect(status).toBe(404)
  })

  it('name update via COALESCE -> 200, name changed, description preserved', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/locations',
      body: { name: 'Before ' + RUN, description: 'preserve-me' },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/locations/${id}`,
      body: { name: 'After ' + RUN },
    })
    expect(status).toBe(200)
    expect(body.id).toBe(id)
    expect(body.name).toBe('After ' + RUN)
    expect(body.description).toBe('preserve-me') // COALESCE: null in body → keep existing
  })

  it('featured_photo_id pointing at a non-linked photo -> 400', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/locations', body: { name: 'Photo Link ' + RUN },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/locations/${id}`,
      body: { featured_photo_id: '00000000-0000-4000-8000-0000000000aa' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/photo linked to this location/i)
  })
})

describe('DELETE /api/locations/:id — soft-delete', () => {
  it('own location DELETE -> 200 {ok:true}; sets deleted_at; GET single then 404', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/locations', body: { name: 'Del Target ' + RUN },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'DELETE', path: `/api/locations/${id}`,
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const rows = await directSql`SELECT deleted_at FROM locations WHERE id = ${id}`
    expect(rows[0].deleted_at).toBeTruthy()
    const get = await callHandler(handler, { method: 'GET', path: `/api/locations/${id}` })
    expect(get.status).toBe(404)
  })

  it('DELETE is idempotent: re-delete / non-existent -> 200 {ok:true} (no RETURNING-gate)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'DELETE', path: `/api/locations/00000000-0000-4000-8000-0000000000bb`,
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
  })
})
