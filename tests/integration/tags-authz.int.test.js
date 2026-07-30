// tags-authz.int.test.js — 0A.5 Phase-1 leak-lock for the tags Lambda (lambda/tags/index.js, serves
// /api/tags + /api/entity-tags). The entity-tags attach path needs CUSTOM arms (the generic matrix
// can't express its { direct, projected } read, its create-not-update write, or its 404-vs-403 axis
// fork). The /api/tags CRUD sub-surface DOES fit the generic matrix (bonus coverage, same Lambda).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { describeAuthzMatrix } from './_authz.js'
import { handler as tagsHandler } from '../../lambda/tags/index.js'

// Staging (which CI branches its ephemeral test DB from) may lag prod on the v4-tagsub migration — the
// tag/entity_tag tables can be ABSENT there. Detect at collection and skip cleanly if so; the lock
// self-activates once staging is reconciled (apply migrations/v4-tagsub to br-damp-frog-amdfxwrr).
const HAS_TAGS = (await directSql`SELECT to_regclass('public.tag') IS NOT NULL AS ok`)[0].ok

// ── entity-tags — custom: attach household predicate (BUG-TAGENTOWN-001, v3.74) + tag-owner gate ──
describe.skipIf(!HAS_TAGS)('AUTHZ entity-tags /api/entity-tags — attach household + tag-owner predicates + deleted_at (0A.5)', () => {
  const RUN = testRunId()
  const OWNER = `authz_et_owner_${RUN}`
  const FOREIGN = `authz_et_foreign_${RUN}`
  let projectId, ownerTagId, foreignTagId, ownerLinkId

  beforeAll(async () => {
    const p = await directSql`
      INSERT INTO plant_projects (name, slug, created_by)
      VALUES (${'authz-et-' + OWNER}, ${'authz-et-' + OWNER}, ${OWNER}) RETURNING id`
    projectId = p[0].id
    const ot = await directSql`
      INSERT INTO public.tag (facet, label, slug, owner_id, created_by, visibility)
      VALUES ('group', ${'authz-owner-tag-' + RUN}, ${'authz-owner-tag-' + RUN}, ${OWNER}, ${OWNER}, 'shared') RETURNING id`
    ownerTagId = ot[0].id
    const ft = await directSql`
      INSERT INTO public.tag (facet, label, slug, owner_id, created_by, visibility)
      VALUES ('group', ${'authz-foreign-tag-' + RUN}, ${'authz-foreign-tag-' + RUN}, ${FOREIGN}, ${FOREIGN}, 'shared') RETURNING id`
    foreignTagId = ft[0].id
  })

  afterAll(async () => {
    // entity_tag.tag_id -> tag(id) is ON DELETE RESTRICT (regardless of deleted_at): clear links first.
    await directSql`DELETE FROM public.entity_tag WHERE created_by IN (${OWNER}, ${FOREIGN})`
    await directSql`DELETE FROM public.tag        WHERE owner_id  IN (${OWNER}, ${FOREIGN})`
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
  })

  it('non-owner-read: foreign GET -> 200 but owner tag NOT leaked', async () => {
    setTestUserId(FOREIGN)
    const { status, body } = await callHandler(tagsHandler, {
      method: 'GET', path: `/api/entity-tags?entity_type=project&entity_id=${projectId}`,
    })
    expect(status).toBe(200)
    expect(body.direct.map((t) => t.id)).not.toContain(ownerTagId)
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
