// tags-authz.int.test.js — 0A.5 Phase-1 leak-lock for the tags Lambda (lambda/tags/index.js, serves
// /api/tags + /api/entity-tags). The entity-tags attach path needs CUSTOM arms (the generic matrix
// can't express its { direct, projected } read, its create-not-update write, or its 404-vs-403 axis
// fork). The /api/tags CRUD sub-surface DOES fit the generic matrix (bonus coverage, same Lambda).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { directSql, callHandler, makeEvent, testRunId, setTestUserId, insertProject, householdDefault } from './_harness.js'
// After _harness.js, whose vi.mock replaces this module with the stub; imported first it would be the real one.
import { verifyToken } from '@clerk/backend'
import { describeAuthzMatrix } from './_authz.js'
import { handler as tagsHandler } from '../../lambda/tags/index.js'

// Staging (which CI branches its ephemeral test DB from) may lag prod on the v4-tagsub migration — the
// tag/entity_tag tables can be ABSENT there. Detect at collection and skip cleanly if so; the lock
// self-activates once staging is reconciled (apply migrations/v4-tagsub to br-polished-art-am12o4ue).
const HAS_TAGS = (await directSql`SELECT to_regclass('public.tag') IS NOT NULL AS ok`)[0].ok

// ── entity-tags — custom: attach household predicate (BUG-TAGENTOWN-001, v3.74) + tag-owner gate ──
describe.skipIf(!HAS_TAGS)('AUTHZ entity-tags /api/entity-tags — attach household + tag-owner predicates + deleted_at (0A.5)', () => {
  const RUN = testRunId()
  const OWNER = `authz_et_owner_${RUN}`
  const FOREIGN = `authz_et_foreign_${RUN}`
  let projectId, ownerTagId, foreignTagId, ownerLinkId
  // I24: a `system` (derived) tag is visible to EVERY caller by the tag-visibility predicate alone, so
  // it is the tag that proves the single read is gated on the ENTITY. Attached to OWNER's project
  // (`direct`) and to the cultivar of OWNER's planting (`projected`).
  let sysTagId, cultivarId, plantingId, goneplantingId

  beforeAll(async () => {
    projectId = (await insertProject({ name: 'authz-et-' + OWNER, createdBy: OWNER })).id
    const ot = await directSql`
      INSERT INTO public.tag (facet, label, slug, owner_id, created_by, visibility)
      VALUES ('group', ${'authz-owner-tag-' + RUN}, ${'authz-owner-tag-' + RUN}, ${OWNER}, ${OWNER}, 'shared') RETURNING id`
    ownerTagId = ot[0].id
    const ft = await directSql`
      INSERT INTO public.tag (facet, label, slug, owner_id, created_by, visibility)
      VALUES ('group', ${'authz-foreign-tag-' + RUN}, ${'authz-foreign-tag-' + RUN}, ${FOREIGN}, ${FOREIGN}, 'shared') RETURNING id`
    foreignTagId = ft[0].id
    const st = await directSql`
      INSERT INTO public.tag (facet, label, slug, source, owner_id, created_by, visibility)
      VALUES ('type', ${'authz-sys-tag-' + RUN}, ${'authz-sys-tag-' + RUN}, 'derived', 'system', ${OWNER}, 'shared') RETURNING id`
    sysTagId = st[0].id
    const cv = await directSql`
      INSERT INTO plant_varieties (name, created_by) VALUES (${'authz-et-cv-' + RUN}, ${OWNER}) RETURNING id`
    cultivarId = cv[0].id
    const pl = await directSql`
      INSERT INTO plants (project_id, name, created_by, variety_id)
      VALUES (${projectId}, ${'authz-et-plant-' + RUN}, ${OWNER}, ${cultivarId}) RETURNING id`
    plantingId = pl[0].id
    const gp = await directSql`
      INSERT INTO plants (project_id, name, created_by, variety_id)
      VALUES (${projectId}, ${'authz-et-plant-gone-' + RUN}, ${OWNER}, ${cultivarId}) RETURNING id`
    goneplantingId = gp[0].id
    await directSql`
      INSERT INTO public.entity_tag (tag_id, entity_type, entity_id, created_by)
      VALUES (${sysTagId}, 'project', ${projectId}, ${OWNER}), (${sysTagId}, 'cultivar', ${cultivarId}, ${OWNER})`
  })

  afterAll(async () => {
    // entity_tag.tag_id -> tag(id) is ON DELETE RESTRICT (regardless of deleted_at): clear links first.
    await directSql`DELETE FROM public.entity_tag WHERE created_by IN (${OWNER}, ${FOREIGN})`
    await directSql`DELETE FROM public.tag        WHERE owner_id  IN (${OWNER}, ${FOREIGN})`
    await directSql`DELETE FROM public.tag        WHERE owner_id = 'system' AND created_by = ${OWNER}`
    await directSql`DELETE FROM entity WHERE entity_type = 'planting' AND planting_ref_id IN (${plantingId}, ${goneplantingId})`
    await directSql`DELETE FROM plants            WHERE created_by = ${OWNER}`
    await directSql`DELETE FROM entity WHERE cultivar_ref_id = ${cultivarId}`
    await directSql`DELETE FROM plant_varieties   WHERE created_by = ${OWNER}`
    await directSql`DELETE FROM plant_projects    WHERE created_by = ${OWNER}`
  })

  it('owner-write: attach own tag -> own project = 201, link created', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(tagsHandler, {
      method: 'POST', path: '/api/entity-tags',
      body: { tag_id: ownerTagId, entity_type: 'project', entity_id: projectId },
    })
    expect([200, 201]).toContain(status)
    expect(body.id).toBeTruthy()
    ownerLinkId = body.id
    const rows = await directSql`SELECT created_by FROM public.entity_tag WHERE id = ${ownerLinkId} AND deleted_at IS NULL`
    expect(rows[0].created_by).toBe(OWNER)
  })

  it('owner-read: GET entity-tags for own project -> 200, direct contains the tag', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(tagsHandler, {
      method: 'GET', path: `/api/entity-tags?entity_type=project&entity_id=${projectId}`,
    })
    expect(status).toBe(200)
    expect(body.direct.map((t) => t.id)).toContain(ownerTagId)
    expect(body.direct.map((t) => t.id)).toContain(sysTagId) // positive control for the next test
  })

  // I24: before the entity gate, FOREIGN's `direct` carried the system tag (visibility arm
  // `t.owner_id = 'system'`), so asserting only "ownerTagId absent" was vacuous. Now: empty.
  it('non-owner-read: foreign GET -> 200 with EMPTY direct and projected (I24)', async () => {
    setTestUserId(FOREIGN)
    const { status, body } = await callHandler(tagsHandler, {
      method: 'GET', path: `/api/entity-tags?entity_type=project&entity_id=${projectId}`,
    })
    expect(status).toBe(200)
    expect(body.direct.map((t) => t.id)).not.toContain(ownerTagId)
    expect(body).toEqual({ direct: [], projected: [] })
  })

  it('I24 planting: OWNER sees the projected cultivar tag; FOREIGN gets empty arrays', async () => {
    setTestUserId(OWNER)
    const own = await callHandler(tagsHandler, {
      method: 'GET', path: `/api/entity-tags?entity_type=plant&entity_id=${plantingId}`,
    })
    expect(own.status).toBe(200)
    expect(own.body.projected.map((t) => t.id)).toContain(sysTagId)

    setTestUserId(FOREIGN)
    const foreign = await callHandler(tagsHandler, {
      method: 'GET', path: `/api/entity-tags?entity_type=plant&entity_id=${plantingId}`,
    })
    expect(foreign.status).toBe(200)
    expect(foreign.body).toEqual({ direct: [], projected: [] })
  })

  it('I24 planting: a soft-deleted own planting returns empty arrays', async () => {
    await directSql`UPDATE plants SET deleted_at = NOW() WHERE id = ${goneplantingId}`
    setTestUserId(OWNER)
    const { status, body } = await callHandler(tagsHandler, {
      method: 'GET', path: `/api/entity-tags?entity_type=plant&entity_id=${goneplantingId}`,
    })
    expect(status).toBe(200)
    expect(body).toEqual({ direct: [], projected: [] })
  })

  it('I24: malformed entity_id -> the same 200-empty body; unknown entity_type -> 400', async () => {
    setTestUserId(OWNER)
    const bad = await callHandler(tagsHandler, {
      method: 'GET', path: '/api/entity-tags?entity_type=plant&entity_id=not-a-uuid',
    })
    expect(bad.status).toBe(200)
    expect(bad.body).toEqual({ direct: [], projected: [] })
    const et = await callHandler(tagsHandler, {
      method: 'GET', path: `/api/entity-tags?entity_type=garden&entity_id=${projectId}`,
    })
    expect(et.status).toBe(400)
    expect(et.body.error).toMatch(/entity_type must be one of/)
  })

  it('non-owner-write ENTITY axis (BUG-TAGENTOWN-001): foreign tag -> OWNER project = 404, no link', async () => {
    setTestUserId(FOREIGN)
    const { status, body } = await callHandler(tagsHandler, {
      method: 'POST', path: '/api/entity-tags',
      body: { tag_id: foreignTagId, entity_type: 'project', entity_id: projectId },
    })
    expect(status).toBe(404) // entityExists household predicate
    expect(body.error).toMatch(/not found/i)
    const rows = await directSql`SELECT 1 FROM public.entity_tag WHERE tag_id = ${foreignTagId} AND entity_id = ${projectId} AND deleted_at IS NULL`
    expect(rows.length).toBe(0) // ownership-stealing regression guard
  })

  it('non-owner-write TAG axis: foreign uses OWNER tag -> 403 (tag-owner gate before entityExists)', async () => {
    setTestUserId(FOREIGN)
    const { status } = await callHandler(tagsHandler, {
      method: 'POST', path: '/api/entity-tags',
      body: { tag_id: ownerTagId, entity_type: 'project', entity_id: projectId },
    })
    expect(status).toBe(403)
  })

  it('detach gate: foreign DELETE /api/entity-tags/:id (owner link) -> 404, link still live', async () => {
    setTestUserId(FOREIGN)
    const { status } = await callHandler(tagsHandler, { method: 'DELETE', path: `/api/entity-tags/${ownerLinkId}` })
    expect(status).toBe(404) // detach WHERE t.owner_id = userId AND t.source='user'
    const rows = await directSql`SELECT deleted_at FROM public.entity_tag WHERE id = ${ownerLinkId}`
    expect(rows[0].deleted_at).toBeNull()
  })

  it('deleted_at: soft-deleted link excluded from owner reads', async () => {
    await directSql`UPDATE public.entity_tag SET deleted_at = NOW() WHERE id = ${ownerLinkId}`
    setTestUserId(OWNER)
    const { status, body } = await callHandler(tagsHandler, {
      method: 'GET', path: `/api/entity-tags?entity_type=project&entity_id=${projectId}`,
    })
    expect(status).toBe(200)
    expect(body.direct.map((t) => t.id)).not.toContain(ownerTagId)
  })
})

// ── SEC-21: tags hands Clerk exactly the two production origins; a staging-origin token is refused ─────────────
describe.skipIf(!HAS_TAGS)('tags — SEC-21 token origins', () => {
  const RUN = testRunId()
  const STAGED = `sec21_tags_staged_${RUN}`
  const ADMITTED = `sec21_tags_prod_${RUN}`
  const ORIGINS = ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net']
  // Clerk refuses a token whose azp is not in authorizedParties; this models that check on the list the handler passes.
  const signedFrom = (azp, sub) => (_token, opts) => (opts.authorizedParties.includes(azp)
    ? (householdDefault(sub), Promise.resolve({ sub, azp }))
    : Promise.reject(new Error(`Invalid JWT Authorized party claim (azp) "${azp}"`)))

  afterAll(async () => {
    await directSql`DELETE FROM public.tag WHERE owner_id IN (${STAGED}, ${ADMITTED})`
    await directSql`DELETE FROM rate_limit_buckets WHERE actor_clerk_sub IN (${STAGED}, ${ADMITTED})`
  })

  it('SEC-21: a token minted for the staging origin is 401, and the create reaches neither the limiter nor the table', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom('https://staging.garden.futureishere.net', STAGED))
    const r = await tagsHandler(makeEvent({ method: 'POST', path: '/api/tags', body: { facet: 'group', label: `sec21-staged-${RUN}` } }))
    expect(r.statusCode).toBe(401)
    expect(JSON.parse(r.body)).toEqual({ error: 'Unauthorized' })
    expect(await directSql`SELECT 1 FROM rate_limit_buckets WHERE actor_clerk_sub = ${STAGED}`).toEqual([])
    expect(await directSql`SELECT 1 FROM public.tag WHERE owner_id = ${STAGED}`).toEqual([])
  })

  it.each(ORIGINS)('SEC-21: a token minted for %s is admitted', async (azp) => {
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom(azp, ADMITTED))
    const r = await tagsHandler(makeEvent({ method: 'GET', path: '/api/tags' }))
    expect(r.statusCode).toBe(200)
  })

  it('SEC-21: the handler hands Clerk exactly the two production origins', async () => {
    setTestUserId(ADMITTED)
    await callHandler(tagsHandler, { method: 'GET', path: '/api/tags' })
    expect(vi.mocked(verifyToken).mock.calls.at(-1)[1].authorizedParties).toEqual(ORIGINS)
  })
})

// ── /api/tags CRUD — generic matrix (bonus; same Lambda, free ownership coverage) ─────────────
if (HAS_TAGS) describeAuthzMatrix({
  name: 'tags /api/tags/:id',
  handler: tagsHandler,
  seedResource: async (owner) => {
    const r = await directSql`
      INSERT INTO public.tag (facet, label, slug, owner_id, created_by, visibility)
      VALUES ('group', ${'authz-tag-' + owner}, ${'authz-tag-' + owner}, ${owner}, ${owner}, 'shared') RETURNING id`
    return r[0].id
  },
  read: () => ({ method: 'GET', path: `/api/tags` }), // scoped-list branch: array
  write: (id) => ({ method: 'PATCH', path: `/api/tags/${id}`, body: { label: 'authz-mutated' } }),
  softDelete: async (id) => { await directSql`UPDATE public.tag SET deleted_at = NOW() WHERE id = ${id}` },
  readBack: async (id) => {
    const r = await directSql`SELECT label FROM public.tag WHERE id = ${id}`
    return r[0] ?? null
  },
  cleanup: async (ctx) => {
    await directSql`DELETE FROM public.entity_tag WHERE created_by = ${ctx.__owner}`
    await directSql`DELETE FROM public.tag        WHERE owner_id  = ${ctx.__owner}`
  },
})
