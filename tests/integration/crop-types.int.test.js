// crop-types.int.test.js — integration coverage for V4-CROPTYPE-001 (POST /api/varieties/crop-types).
// Runs the REAL varieties handler against an ephemeral Neon branch; SecretsManager + Clerk stubbed
// by the harness, SQL is real. The point of doing this against real Postgres rather than a mock:
// the route's correctness lives in constraints this suite actually exercises — the slug PRIMARY KEY,
// crop_types_default_lifecycle_check, and the soft-delete restore path.
//
// Why the route exists: the vocabulary was read-only from the app, so a plant with no matching crop
// type could only be saved with crop_type_slug = NULL — which drops it out of every type-grouped
// view. Dave hit this adding Mahogany Splendor (Hibiscus acetosella).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/varieties/index.js'

const RUN = testRunId()
const USER = `user_int_crop_${RUN}`
// Slugs this run may create — every one is cleaned up in afterAll.
const MINE = []

function track(slug) { if (slug) MINE.push(slug); return slug }

beforeAll(async () => {
  setTestUserId(USER)
})

afterAll(async () => {
  if (MINE.length) {
    // The handler mirrors each new crop type into the tag vocabulary (facet 'type', owner 'system')
    // and links it to the cultivar via entity_tag. Both outlive the crop_types row, so the fixture
    // has to clear them or every run leaves a system-owned tag + a dangling link behind.
    // entity_tag.tag_id -> tag(id) is ON DELETE RESTRICT: links first, then tags.
    await directSql`DELETE FROM public.entity_tag WHERE tag_id IN (SELECT id FROM public.tag WHERE slug = ANY(${MINE}))`
    await directSql`DELETE FROM public.tag WHERE slug = ANY(${MINE})`
    await directSql`DELETE FROM crop_types WHERE slug = ANY(${MINE})`
  }
  await directSql`DELETE FROM crop_types WHERE created_by = ${USER}`
  await directSql`DELETE FROM rate_limit_buckets WHERE actor_clerk_sub = ${USER}`
})

describe('POST /api/varieties/crop-types — create', () => {
  it('creates a genuinely new crop type and derives the slug server-side', async () => {
    const name = `Hibiscus ${RUN}`
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types',
      body: { display_name: name, category: 'ornamental', default_lifecycle: 'tender_perennial' },
    })
    expect(res.status).toBe(201)
    track(res.body.slug)
    expect(res.body.slug).toBe(name.toLowerCase().replace(/[^a-z0-9]+/g, '_'))

    const [row] = await directSql`SELECT * FROM crop_types WHERE slug = ${res.body.slug}`
    expect(row.display_name).toBe(name)
    expect(row.category).toBe('ornamental')
    expect(row.default_lifecycle).toBe('tender_perennial')
    expect(row.created_by).toBe(USER) // provenance is the authenticated sub, not 'system'
    expect(row.deleted_at).toBeNull()
  })

  it('ignores a caller-supplied slug — the slug is a PRIMARY KEY and an FK target', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types',
      body: { display_name: `Amaranth ${RUN}`, slug: 'pepper' },
    })
    expect(res.status).toBe(201)
    track(res.body.slug)
    expect(res.body.slug).not.toBe('pepper')
    expect(res.body.slug).toContain('amaranth')
  })

  it('the new type is immediately visible to GET (what the picker re-reads)', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types',
      body: { display_name: `Luffa ${RUN}` },
    })
    track(res.body.slug)
    const list = await callHandler(handler, { method: 'GET', path: '/api/varieties/crop-types' })
    expect(list.status).toBe(200)
    expect(list.body.some(c => c.slug === res.body.slug)).toBe(true)
  })

  it('a variety can then actually be typed to it (the FK that was the whole point)', async () => {
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types',
      body: { display_name: `Cranberry Hibiscus ${RUN}`, category: 'ornamental' },
    })
    track(created.body.slug)

    const variety = await callHandler(handler, {
      method: 'POST', path: '/api/varieties',
      body: { name: `Mahogany Splendor ${RUN}`, crop_type_slug: created.body.slug },
    })
    expect(variety.status).toBe(201)
    expect(variety.body.crop_type_slug).toBe(created.body.slug)

    // Read back from the DB: a NULL here is exactly the disappearing-plant bug.
    const [row] = await directSql`SELECT crop_type_slug FROM cultivar WHERE id = ${variety.body.id}`
    expect(row.crop_type_slug).toBe(created.body.slug)

    // A trigger auto-registers an `entity` row per cultivar (FK ON DELETE RESTRICT), so it must be
    // cleared before the cultivar can be hard-deleted — same pattern as preservation.int.test.js.
    await directSql`DELETE FROM entity WHERE cultivar_ref_id = ${variety.body.id}`
    // BUG-ENTITYTAGORPHAN-001: the crop-type mirror above links this cultivar into the tag
    // vocabulary via entity_tag, and plant_varieties now carries a BEFORE DELETE guard that raises
    // 23503 rather than orphan an association. So the link goes before its parent — the same
    // child-first discipline the entity row above already needed. This is not incidental to the
    // test: it means every cultivar created through the API carries a tag, which is why 412 of 424
    // prod cultivars are tagged and why this guard had to exist.
    await directSql`DELETE FROM public.entity_tag WHERE entity_type = 'cultivar' AND entity_id = ${variety.body.id}`
    await directSql`DELETE FROM cultivar WHERE id = ${variety.body.id}`
  })
})

describe('POST /api/varieties/crop-types — steer instead of duplicate', () => {
  it('409s an exact repeat and returns the existing row', async () => {
    const name = `Tomatillo ${RUN}`
    const first = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types', body: { display_name: name },
    })
    track(first.body.slug)

    const second = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types', body: { display_name: name },
    })
    expect(second.status).toBe(409)
    expect(second.body.reason).toBe('exists')
    expect(second.body.existing.slug).toBe(first.body.slug)

    const rows = await directSql`SELECT slug FROM crop_types WHERE slug = ${first.body.slug}`
    expect(rows).toHaveLength(1)
  })

  it('409s a synonym of a CODE-COUPLED slug rather than minting a facet-less duplicate', async () => {
    // 'pepper' is seeded vocabulary; a second pepper type would derive no heat/scoville facet.
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types', body: { display_name: 'Chili' },
    })
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('coupled_synonym')
    expect(res.body.existing.slug).toBe('pepper')
    const rows = await directSql`SELECT slug FROM crop_types WHERE slug = 'chili'`
    expect(rows).toHaveLength(0) // nothing was created
  })

  it('restores a soft-deleted type instead of failing on the PRIMARY KEY', async () => {
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types', body: { display_name: `Salsify ${RUN}` },
    })
    const slug = track(created.body.slug)
    await directSql`UPDATE crop_types SET deleted_at = now() WHERE slug = ${slug}`

    const again = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types', body: { display_name: `Salsify ${RUN}` },
    })
    expect(again.status).toBe(200)
    expect(again.body.restored).toBe(true)

    const [row] = await directSql`SELECT deleted_at FROM crop_types WHERE slug = ${slug}`
    expect(row.deleted_at).toBeNull()
  })
})

describe('POST /api/varieties/crop-types — validation', () => {
  it('400s a missing or blank display_name', async () => {
    for (const body of [{}, { display_name: '   ' }]) {
      const res = await callHandler(handler, { method: 'POST', path: '/api/varieties/crop-types', body })
      expect(res.status).toBe(400)
    }
  })

  it('400s a name that slugifies to nothing, rather than inserting an empty PK', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types', body: { display_name: '!!!' },
    })
    expect(res.status).toBe(400)
    const rows = await directSql`SELECT slug FROM crop_types WHERE slug = ''`
    expect(rows).toHaveLength(0)
  })

  it('400s a lifecycle outside the DB CHECK vocabulary (not a 23514 leak)', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types',
      body: { display_name: `Evergreenish ${RUN}`, default_lifecycle: 'evergreen' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/default_lifecycle/)
  })

  it('400s a category outside the in-use set — category has no DB CHECK to catch it', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types',
      body: { display_name: `Viney ${RUN}`, category: 'vine' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/category/)
  })

  it('405s an unsupported method on the vocab route', async () => {
    const res = await callHandler(handler, { method: 'DELETE', path: '/api/varieties/crop-types' })
    expect(res.status).toBe(405)
  })
})
