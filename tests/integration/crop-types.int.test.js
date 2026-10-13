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
import { assertFixtureId, settle } from './_cleanup.js'
import { makeHousehold, teardownHousehold, call, key, seedBatch, seedJar, seedPlace } from './_kitchenF.js'
import { handler } from '../../lambda/varieties/index.js'
import {
  FOOD_CLASS_REFUSAL, GATE_REQUIRED_REFUSAL, RETIRED_MESSAGE, RETIRED_CODE, NOT_CONFIGURED_CODE,
} from '../../lambda/varieties/crop-type-admin.js'
import { RETIRED_CROP_REFUSAL } from '../../lambda/preservation/pantryRoutes.js'

const RUN = testRunId()
const USER = `user_int_crop_${RUN}`
// Slugs this run may create — every one is cleaned up in afterAll.
const MINE = []

function track(slug) { if (slug) MINE.push(slug); return slug }

// V4-CROPTYPERETIRE-001 — the admin gate reads process.env.ADMIN_CLERK_SUBS per request, and the
// integration job sets none, so a case that needs an admin names one for its own duration.
async function withAdmins(value, fn) {
  const saved = process.env.ADMIN_CLERK_SUBS
  if (value == null) delete process.env.ADMIN_CLERK_SUBS; else process.env.ADMIN_CLERK_SUBS = value
  try { return await fn() } finally {
    if (saved === undefined) delete process.env.ADMIN_CLERK_SUBS; else process.env.ADMIN_CLERK_SUBS = saved
  }
}

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

  // V4-CROPTYPERETIRE-001: typing a retired type's name brings it back only for an admin. Anyone
  // else is told, in words, and the type stays retired (the next case).
  it('restores a soft-deleted type for an admin instead of failing on the PRIMARY KEY', async () => {
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types', body: { display_name: `Salsify ${RUN}` },
    })
    const slug = track(created.body.slug)
    await directSql`UPDATE crop_types SET deleted_at = now() WHERE slug = ${slug}`

    const again = await withAdmins(USER, () => callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types', body: { display_name: `Salsify ${RUN}` },
    }))
    expect(again.status).toBe(200)
    expect(again.body.restored).toBe(true)

    const [row] = await directSql`SELECT deleted_at FROM crop_types WHERE slug = ${slug}`
    expect(row.deleted_at).toBeNull()
  })

  it.each([
    ['no admin is configured', null],
    ['somebody else is the admin', `user_int_crop_other_${RUN}`],
  ])('a non-admin typing a retired type\'s name is refused in words and the type stays retired (%s)', async (_name, admins) => {
    const name = `Scorzonera ${admins == null ? 'a' : 'b'} ${RUN}`
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types', body: { display_name: name },
    })
    const slug = track(created.body.slug)
    await directSql`UPDATE crop_types SET deleted_at = now() WHERE slug = ${slug}`

    const again = await withAdmins(admins, () => callHandler(handler, {
      method: 'POST', path: '/api/varieties/crop-types', body: { display_name: name },
    }))
    expect(again.status).toBe(403)
    expect(again.body).toEqual({ error: RETIRED_MESSAGE, code: RETIRED_CODE })
    expect(again.body.code).toBe('crop_type_retired')

    const [row] = await directSql`SELECT deleted_at FROM crop_types WHERE slug = ${slug}`
    expect(row.deleted_at).not.toBeNull()
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

// ── V4-CROPTYPERETIRE-001 — retire and restore, on real Postgres ─────────────────────────────────
// The unit stub accepts any SQL, so the admin listing, the guarded UPDATE, the restore and the two
// pantry refusals are executed HERE or nowhere before the staging smoke. USER is the admin for this
// block (the gate reads the env per request); the dependent rows belong to a household of their own
// so the kitchen teardown can remove them before this file's afterAll removes the crop types.
describe('V4-CROPTYPERETIRE-001 — retire and restore', () => {
  const H = makeHousehold('ctr')
  const { DAVE, JEN } = H
  let savedAdmins
  let savedIds

  beforeAll(() => {
    savedAdmins = process.env.ADMIN_CLERK_SUBS
    savedIds = process.env.GARDEN_HOUSEHOLD_IDS
    process.env.ADMIN_CLERK_SUBS = `user_int_crop_other_${RUN}, ${USER}`
    process.env.GARDEN_HOUSEHOLD_IDS = `${DAVE},${JEN}`
  })
  afterAll(async () => {
    if (savedAdmins === undefined) delete process.env.ADMIN_CLERK_SUBS; else process.env.ADMIN_CLERK_SUBS = savedAdmins
    if (savedIds === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS; else process.env.GARDEN_HOUSEHOLD_IDS = savedIds
    const ids = assertFixtureId(DAVE, JEN, H.STRANGER)
    // Lines and items first: they name places and jars the household teardown removes.
    await settle(`crop-type retire teardown ${H.RUN}`, [
      () => directSql`DELETE FROM kitchen_batch_input WHERE created_by = ANY(${ids})`,
      () => directSql`DELETE FROM pantry_item WHERE user_id = ANY(${ids})`,
    ])
    await teardownHousehold(H)
    setTestUserId(USER)
  })

  // The varieties handler as the admin. `call` (the preservation handler) switches the stubbed sub,
  // so every varieties request sets it back first.
  const admin = (method, path, body) => { setTestUserId(USER); return callHandler(handler, { method, path, body }) }
  const retire = (slug) => admin('POST', '/api/varieties/crop-types/retire', { slug })
  const restore = (slug) => admin('POST', '/api/varieties/crop-types', { restore_slug: slug })
  const listed = async (slug) => (await admin('GET', '/api/varieties/crop-types/admin')).body.types.find((t) => t.slug === slug)
  const isPublic = async (slug) => (await admin('GET', '/api/varieties/crop-types')).body.some((c) => c.slug === slug)
  const rowOf = async (slug) => (await directSql`SELECT deleted_at, updated_at FROM crop_types WHERE slug = ${slug}`)[0]
  const ZERO = { varieties: 0, put_ups: 0, pantry_items: 0, batches: 0, put_up_sources: 0 }

  // A crop type made by hand (the route under test is never its own fixture, and the inline create
  // is rate limited). created_by USER, so the file's afterAll removes it.
  let seq = 0
  async function mintType(tag, { category = null } = {}) {
    seq += 1
    const slug = `ctr-${tag}-${seq}-${RUN}`
    await directSql`
      INSERT INTO crop_types (slug, display_name, default_unit, category, created_by)
      VALUES (${slug}, ${`Ctr ${tag} ${seq} ${RUN}`}, 'count', ${category}, ${USER})`
    return track(slug)
  }
  // A live type of this run's own for rows that must name SOME crop. Not _kitchenF's CROP: that is
  // whatever slug sorts first on the branch, which other files running beside this one also use.
  let holderSlug
  const holder = async () => { holderSlug ??= await mintType('holder'); return holderSlug }

  // One row naming `slug` in each dependent table, by table key. `deleted` makes it a soft-deleted row.
  const DEPENDENT = {
    varieties: async (slug, deleted) => { await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug, deleted_at)
      VALUES (${`ctr variety ${slug}`}, ${DAVE}, ${slug}, ${deleted ? new Date().toISOString() : null}::timestamptz)` },
    put_ups: async (slug, deleted) => { await seedJar(DAVE, { crop: slug, deleted }) },
    pantry_items: async (slug, deleted) => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      const r = await call(DAVE, 'POST', '/api/pantry/items', { idempotency_key: key(), name: `ctr item ${slug}`, storage_location_id: place, crop_type_slug: slug })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      if (deleted) expect((await call(DAVE, 'DELETE', `/api/pantry/items/${r.body.item.id}`)).status).toBe(200)
    },
    batches: async (slug, deleted) => {
      const b = await seedBatch(DAVE, { label: `ctr batch ${slug}` })
      // Two ingredients of one batch: the batch counts once.
      for (const label of ['ctr line a', 'ctr line b']) {
        // eslint-disable-next-line no-await-in-loop
        await directSql`
          INSERT INTO kitchen_batch_input (batch_id, input_kind, label, crop_type_slug, created_by, deleted_at)
          VALUES (${b.id}, 'other', ${label}, ${slug}, ${DAVE}, ${deleted ? new Date().toISOString() : null}::timestamptz)`
      }
    },
    put_up_sources: async (slug, deleted) => {
      const jar = await seedJar(DAVE, { crop: await holder() })
      await directSql`
        INSERT INTO preservation_source (preservation_log_id, user_id, source_kind, display_label, provenance_grade, crop_type_slug, deleted_at)
        VALUES (${jar}, ${DAVE}, 'own_garden', 'ctr source', 'crop', ${slug}, ${deleted ? new Date().toISOString() : null}::timestamptz)`
    },
  }
  const WORDS = { varieties: 'variety', put_ups: 'put-up', pantry_items: 'pantry item', batches: 'batch', put_up_sources: 'put-up source' }

  it('the admin listing: every type, its counts, whether it can be retired and why not', async () => {
    const slug = await mintType('list')
    const res = await admin('GET', '/api/varieties/crop-types/admin')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.types)).toBe(true)
    // Every row of the table, retired ones included. (No count against the table: other files add
    // and remove crop types beside this one.)
    expect(res.body.types.length).toBeGreaterThan(1)
    for (const t of res.body.types) {
      expect(Object.keys(t).sort()).toEqual(['can_retire', 'category', 'counts', 'display_name', 'retired', 'retired_at', 'slug', 'why_not'])
      expect(Object.keys(t.counts).sort()).toEqual(Object.keys(ZERO).sort())
      for (const v of Object.values(t.counts)) expect(Number.isInteger(v)).toBe(true)
      expect(t.can_retire).toBe(!t.retired && t.why_not == null)
    }
    const mine = res.body.types.find((t) => t.slug === slug)
    expect(mine).toEqual({
      slug, display_name: `Ctr list ${seq} ${RUN}`, category: null, retired: false, retired_at: null,
      counts: ZERO, can_retire: true, why_not: null,
    })
    // One row in every dependent table at once: each count is its own table's, and the sentence
    // names all five in the module's order.
    for (const k of Object.keys(DEPENDENT)) {
      // eslint-disable-next-line no-await-in-loop
      await DEPENDENT[k](slug, false)
    }
    expect(await listed(slug)).toMatchObject({
      counts: { varieties: 1, put_ups: 1, pantry_items: 1, batches: 1, put_up_sources: 1 },
      can_retire: false,
      why_not: 'Still used by 1 variety, 1 put-up, 1 pantry item, 1 batch and 1 put-up source.',
    })
  })

  it('retire, read back, bring back by slug, read back', async () => {
    const slug = await mintType('walk')
    const before = await rowOf(slug)

    const out = await retire(slug)
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body).toMatchObject({ slug, retired: true, can_retire: false })
    const gone = await rowOf(slug)
    expect(gone.deleted_at).not.toBeNull()
    expect(gone.updated_at).not.toEqual(before.updated_at)   // set by hand: the table has no trigger
    expect(await listed(slug)).toMatchObject({ retired: true, can_retire: false, why_not: null })
    expect((await listed(slug)).retired_at).not.toBeNull()
    expect(await isPublic(slug)).toBe(false)

    const twice = await retire(slug)
    expect(twice.status).toBe(409)
    expect(twice.body.code).toBe('already_retired')

    const back = await restore(slug)
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(back.body).toMatchObject({ slug, restored: true, display_name: `Ctr walk ${seq} ${RUN}` })
    expect((await rowOf(slug)).deleted_at).toBeNull()
    expect(await listed(slug)).toMatchObject({ retired: false, retired_at: null, can_retire: true })
    expect(await isPublic(slug)).toBe(true)

    const again = await restore(slug)
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('not_retired')
    expect((await restore(`ctr-no-such-${RUN}`)).status).toBe(404)
    expect((await retire(`ctr-no-such-${RUN}`)).status).toBe(404)
  })

  it.each(Object.keys(DEPENDENT))('one %s row holds the type in place: 409 in words, the type stays live', async (k) => {
    const slug = await mintType(`used-${k.replace(/_/g, '')}`)
    await DEPENDENT[k](slug, false)
    expect((await listed(slug)).counts).toEqual({ ...ZERO, [k]: 1 })
    const out = await retire(slug)
    expect(out.status, JSON.stringify(out.body)).toBe(409)
    expect(out.body.code).toBe('in_use')
    expect(out.body.error).toBe(`Still used by 1 ${WORDS[k]}.`)
    expect((await rowOf(slug)).deleted_at).toBeNull()
    expect(await isPublic(slug)).toBe(true)
  })

  // The ruling behind F4: a deleted row can be un-deleted (variety restore, reviveBlend, the
  // batch-input un-delete), so it holds the type in place exactly like a live one.
  it.each(Object.keys(DEPENDENT))('a soft-deleted %s row holds the type in place too', async (k) => {
    const slug = await mintType(`dead-${k.replace(/_/g, '')}`)
    await DEPENDENT[k](slug, true)
    expect((await listed(slug)).counts).toEqual({ ...ZERO, [k]: 1 })
    const out = await retire(slug)
    expect(out.status, JSON.stringify(out.body)).toBe(409)
    expect(out.body).toMatchObject({ code: 'in_use', error: `Still used by 1 ${WORDS[k]}.` })
    expect((await rowOf(slug)).deleted_at).toBeNull()
  })

  it('a food class is refused by category, with nothing using it', async () => {
    const slug = await mintType('food', { category: 'non_plant_food' })
    expect(await listed(slug)).toMatchObject({ can_retire: false, why_not: FOOD_CLASS_REFUSAL, counts: ZERO })
    const out = await retire(slug)
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ code: 'food_class', error: FOOD_CLASS_REFUSAL })
    expect((await rowOf(slug)).deleted_at).toBeNull()
  })

  it('a type a standing database gate needs live is refused, whatever uses it', async () => {
    // aloe: migrations/v4-croptypealoe-001/gates.yml post_aloe_crop_type_exists.
    const before = await rowOf('aloe')
    expect(before, 'the branch has no aloe crop type: the gate itself would be red').toBeDefined()
    expect(before.deleted_at).toBeNull()
    expect(await listed('aloe')).toMatchObject({ retired: false, can_retire: false, why_not: GATE_REQUIRED_REFUSAL })
    const out = await retire('aloe')
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ code: 'gate_required', error: "The garden's own checks need this crop type." })
    expect((await rowOf('aloe')).deleted_at).toBeNull()
  })

  it('the gate: a non-admin is refused on all three routes, and with no admin configured the reply says so', async () => {
    const live = await mintType('gate')
    const dead = await mintType('gate')
    await directSql`UPDATE crop_types SET deleted_at = now() WHERE slug = ${dead}`
    for (const [admins, body] of [
      [`user_int_crop_other_${RUN}`, { error: 'Admin only' }],
      [null, { error: 'Admin only', code: NOT_CONFIGURED_CODE }],
      ['', { error: 'Admin only', code: NOT_CONFIGURED_CODE }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await withAdmins(admins, async () => {
        expect(await admin('GET', '/api/varieties/crop-types/admin')).toMatchObject({ status: 403, body })
        expect(await retire(live)).toMatchObject({ status: 403, body })
        expect(await restore(dead)).toMatchObject({ status: 403, body })
      })
    }
    expect((await rowOf(live)).deleted_at).toBeNull()
    expect((await rowOf(dead)).deleted_at).not.toBeNull()
  })

  it('a retired type gains no pantry item: create is refused in words and makes no place, PATCH is refused and the row keeps its crop', async () => {
    const slug = await mintType('pantry')
    const place = await seedPlace(DAVE, { kind: 'pantry' })
    const other = await holder()
    const kept = await call(DAVE, 'POST', '/api/pantry/items', { idempotency_key: key(), name: `ctr kept ${RUN}`, storage_location_id: place, crop_type_slug: other })
    expect(kept.status, JSON.stringify(kept.body)).toBe(201)
    expect((await retire(slug)).status).toBe(200)

    const count = async () => (await directSql`SELECT count(*)::int AS n FROM pantry_item WHERE user_id = ${DAVE} AND crop_type_slug = ${slug}`)[0].n
    const atPlace = await call(DAVE, 'POST', '/api/pantry/items', { idempotency_key: key(), name: `ctr refused ${RUN}`, storage_location_id: place, crop_type_slug: slug })
    expect(atPlace.status, JSON.stringify(atPlace.body)).toBe(400)
    expect(atPlace.body.error).toBe(RETIRED_CROP_REFUSAL)
    expect(await count()).toBe(0)

    // Naming a NEW place: the refusal must not leave that place behind, empty.
    const label = `ctr new shelf ${RUN}`
    const newPlace = await call(DAVE, 'POST', '/api/pantry/items', { idempotency_key: key(), name: `ctr refused 2 ${RUN}`, place: { kind: 'pantry', label }, crop_type_slug: slug })
    expect(newPlace.status, JSON.stringify(newPlace.body)).toBe(400)
    expect(newPlace.body.error).toBe(RETIRED_CROP_REFUSAL)
    expect(await count()).toBe(0)
    expect(await directSql`SELECT id FROM storage_location WHERE user_id = ${DAVE} AND label = ${label}`).toHaveLength(0)

    const patched = await call(DAVE, 'PATCH', `/api/pantry/items/${kept.body.item.id}`, { crop_type_slug: slug })
    expect(patched.status, JSON.stringify(patched.body)).toBe(400)
    expect(patched.body.error).toBe(RETIRED_CROP_REFUSAL)
    expect((await directSql`SELECT crop_type_slug FROM pantry_item WHERE id = ${kept.body.item.id}`)[0].crop_type_slug).toBe(other)

    // Brought back, the same create goes through, new place and all.
    expect((await restore(slug)).status).toBe(200)
    const after = await call(DAVE, 'POST', '/api/pantry/items', { idempotency_key: key(), name: `ctr allowed ${RUN}`, place: { kind: 'pantry', label }, crop_type_slug: slug })
    expect(after.status, JSON.stringify(after.body)).toBe(201)
    expect(after.body.item.crop_type_slug).toBe(slug)
  })

  it('the put-up line search offers a live type and omits it once retired', async () => {
    const slug = await mintType('search')
    const q = encodeURIComponent(`Ctr search ${seq} ${RUN}`)
    const crops = async () => (await call(DAVE, 'GET', `/api/kitchen-batches/line-search?q=${q}`)).body.crops.map((c) => c.crop_type_slug)
    expect(await crops()).toEqual([slug])
    expect((await retire(slug)).status).toBe(200)
    expect(await crops()).toEqual([])
    expect((await restore(slug)).status).toBe(200)
    expect(await crops()).toEqual([slug])
  })
})
