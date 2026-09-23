// tests/integration/plants-archived-container.int.test.js
// OPS-CACHEARCHIVEINTTEST-001 — BUG-PLANTSLISTARCHIVEDCONTAINER-001 on real Postgres.
//
// WHAT THIS CLOSES. lambda/plants/archived-container.test.js scores the statements the plants handler
// SENDS against a hand-written model of Postgres: it strips every ::cast, knows no triggers and reads
// `container` / `garden_node` as plain tables. Before this file the only real-Postgres runs of the
// changed code were the companion UPDATE's zero-row paths (plants.int.test.js unarchives a
// project-less planting; restore-surface.int.test.js restores one whose container is live). Nothing
// in CI ran GET ?view=grid or ?view=picker at all, and nothing ran an unarchive or a restore that
// actually clears an archived container — the one write lambda/plants makes to `container`
// (preship-qa I3, preship-regression finding 2, mainsync6-20260923).
//
// THE CONTRACT, as the lane shipped it (lambda/plants/index.js):
//   1. ?view=grid (Garden) and ?view=picker (every planting chooser) do not return a live planting
//      whose OWN container is archived — `AND pp.archived_at IS NULL`, a top-level WHERE clause.
//      A live planting in a live container, and a project-less one, are still returned.
//   2. PATCH /api/plants/:id/archive {archived:false} and POST /api/plants/:id/restore send
//      unarchiveContainerOfLivePlanting in the SAME transaction, after the planting's own UPDATE: the
//      planting's own container comes back when the planting is now live. Nothing else is written.
//
// "UNTOUCHED" IS READ FROM xmin, NOT ONLY FROM THE VALUES. An UPDATE that sets archived_at = NULL on a
// container whose archived_at is already NULL changes no column a SELECT of the values can see, but it
// is still a write: Postgres stores a new row version (a new xmin), fires the container's triggers and
// takes a row lock. That is exactly the write `pp.archived_at IS NOT NULL` exists to prevent (preship-qa
// M1: dropping that term survives all 4538 unit tests), so the containers that must not be written are
// compared on xmin as well as on their full row.
//
// FIXTURES are this file's own (one household, `int-test-` namespaced), so nothing another file does can
// hold a container archived or bring one back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'
import { handler } from '../../lambda/plants/index.js'

const RUN = testRunId()
const USER = `user_int_plantsarch_${RUN}`

const call = (method, path, body) => callHandler(handler, { method, path, body, userId: USER })
const listIds = async (view) => {
  const res = await call('GET', `/api/plants?view=${view}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  expect(Array.isArray(res.body), `?view=${view} did not answer an array`).toBe(true)
  return res.body.map((r) => r.id)
}

async function container(tag, { archived = false } = {}) {
  const { id } = await insertProject({ name: `int-plantsarch-${tag}-${RUN}`, createdBy: USER })
  if (archived) await directSql`UPDATE plant_projects SET archived_at = NOW() WHERE id = ${id}`
  return id
}
async function planting(tag, containerId, { archived = false, deleted = false } = {}) {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, created_by, archived_at, deleted_at)
    VALUES (${containerId}, ${`int-plantsarch-${tag}-${RUN}`}, ${USER},
            CASE WHEN ${archived}::boolean THEN NOW() END,
            CASE WHEN ${deleted}::boolean THEN NOW() END)
    RETURNING id`
  return rows[0].id
}
// The whole container row as Postgres stores it, plus the id of the transaction that wrote this
// version of it. Read from the base table; `container` is a view over it.
const containerRow = async (id) => (await directSql`
  SELECT pp.xmin::text AS xmin, to_jsonb(pp) AS row FROM plant_projects pp WHERE pp.id = ${id}`)[0]
const plantingRow = async (id) => (await directSql`
  SELECT deleted_at, archived_at, project_id FROM plants WHERE id = ${id}`)[0]

// Containers
let cLive, cArchived, cTrap, cRestore, cBystander, cLiveHost
// Plantings
let pLive, pNone, pInArchived, pTrap, pRestore, pInLiveHost

beforeAll(async () => {
  setTestUserId(USER)
  cLive = await container('live')
  cArchived = await container('archived', { archived: true })
  cTrap = await container('trap', { archived: true })
  cRestore = await container('restore', { archived: true })
  // Archived, holding an archived planting of its own: the shape of prod's three (Lithops, Loofah
  // Sponge, Spinach). Nothing this file does is about it, so every write below must leave it alone.
  cBystander = await container('bystander', { archived: true })
  cLiveHost = await container('livehost')

  pLive = await planting('live', cLive)
  pNone = await planting('none', null)
  pInArchived = await planting('in-archived', cArchived)
  pTrap = await planting('trap', cTrap, { archived: true })
  pRestore = await planting('restore', cRestore, { deleted: true })
  await planting('bystander', cBystander, { archived: true })
  pInLiveHost = await planting('in-live-host', cLiveHost, { archived: true })
})

afterAll(async () => {
  assertFixtureId(USER)
  await settle('plants-archived-container', [
    // The plants_entity_ins trigger creates an entity row per planting, and entity is ON DELETE
    // RESTRICT against plants, so it goes first. No event or cache row is created by this file.
    () => directSql`DELETE FROM entity WHERE entity_type = 'planting' AND planting_ref_id IN (
                      SELECT id FROM plants WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM plants WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM entity_memory WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`,
  ])
})

describe('GET /api/plants?view=grid and ?view=picker — a planting in an ARCHIVED container is not listed', () => {
  it('PRECONDITION: the hidden planting is itself live; only its container is archived, and not deleted', async () => {
    // Its own test, so a failure reads as "the fixture never got built" rather than as an accusation
    // against the list: the absence asserted below can only come from the container's archived_at.
    const p = await plantingRow(pInArchived)
    expect(p.deleted_at).toBeNull()
    expect(p.archived_at).toBeNull()
    expect(p.project_id).toBe(cArchived)
    const c = (await containerRow(cArchived)).row
    expect(c.archived_at, 'the container is not archived').not.toBeNull()
    expect(c.deleted_at, 'the container is deleted — that is the other axis').toBeNull()
  })

  for (const view of ['grid', 'picker']) {
    it(`?view=${view}: the live planting and the project-less one are listed; the one in the archived container is not`, async () => {
      const ids = await listIds(view)
      // Presence first: a list that went dead would satisfy the absence for nothing.
      expect(ids, 'a live planting in a live container is missing').toContain(pLive)
      expect(ids, 'a project-less planting is missing — the container join is no longer LEFT, or the clause is not NULL-safe').toContain(pNone)
      expect(ids, 'a live planting in an ARCHIVED container is listed').not.toContain(pInArchived)
    })
  }
})

describe('PATCH /api/plants/:id/archive {archived:false} — the planting comes back, and so does its archived container', () => {
  let bystanderBefore

  beforeAll(async () => { bystanderBefore = await containerRow(cBystander) })

  it('PRECONDITION: the planting and its container are both archived, and neither is listed', async () => {
    expect((await plantingRow(pTrap)).archived_at).not.toBeNull()
    expect((await containerRow(cTrap)).row.archived_at).not.toBeNull()
    expect(await listIds('grid')).not.toContain(pTrap)
  })

  it('answers 200 with the unarchived planting, and its container\'s archived_at IS NULL afterwards', async () => {
    const res = await call('PATCH', `/api/plants/${pTrap}/archive`, { archived: false })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.id).toBe(pTrap)
    expect(res.body.archived_at).toBeNull()
    // The read-back, not the echo: the response is the planting UPDATE's RETURNING and says nothing
    // about the container.
    expect((await plantingRow(pTrap)).archived_at).toBeNull()
    expect((await containerRow(cTrap)).row.archived_at,
      'the container is still archived, so the planting is still hidden').toBeNull()
  })

  it('a different archived container is untouched — same row, same row version', async () => {
    const after = await containerRow(cBystander)
    expect(after.row.archived_at, 'another archived container was unarchived').not.toBeNull()
    expect(after.row).toEqual(bystanderBefore.row)
    expect(after.xmin, 'another container was written').toBe(bystanderBefore.xmin)
  })

  it('the planting is back on the Garden grid', async () => {
    expect(await listIds('grid')).toContain(pTrap)
  })

  it('a planting in a LIVE container brings nothing back — its container is not written at all', async () => {
    // preship-qa M1 on Postgres. The container statement also requires `pp.archived_at IS NOT NULL`;
    // without that term it rewrites the LIVE container on every unarchive of one of its plantings.
    // The values would read the same (NULL -> NULL); the row version would not.
    const before = await containerRow(cLiveHost)
    expect(before.row.archived_at).toBeNull()
    const res = await call('PATCH', `/api/plants/${pInLiveHost}/archive`, { archived: false })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((await plantingRow(pInLiveHost)).archived_at).toBeNull()
    const after = await containerRow(cLiveHost)
    expect(after.row).toEqual(before.row)
    expect(after.xmin, 'the live container was written by an unarchive that had nothing to bring back').toBe(before.xmin)
  })
})

describe('POST /api/plants/:id/restore — a soft-deleted planting in an archived container', () => {
  let bystanderBefore

  beforeAll(async () => { bystanderBefore = await containerRow(cBystander) })

  it('PRECONDITION: the planting is soft-deleted (not archived) and its container is archived, not deleted', async () => {
    const p = await plantingRow(pRestore)
    expect(p.deleted_at).not.toBeNull()
    expect(p.archived_at).toBeNull()
    const c = (await containerRow(cRestore)).row
    expect(c.archived_at).not.toBeNull()
    expect(c.deleted_at).toBeNull()
  })

  it('answers 200, the planting is live again and its container\'s archived_at IS NULL', async () => {
    const res = await call('POST', `/api/plants/${pRestore}/restore`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.id).toBe(pRestore)
    expect(res.body.deleted_at).toBeNull()
    expect(res.body.already_restored, 'the restore took the idempotent arm, so nothing was written').toBeUndefined()
    expect((await plantingRow(pRestore)).deleted_at).toBeNull()
    expect((await containerRow(cRestore)).row.archived_at,
      'the container is still archived, so the restored planting is still hidden').toBeNull()
  })

  it('a different archived container is untouched — same row, same row version', async () => {
    const after = await containerRow(cBystander)
    expect(after.row).toEqual(bystanderBefore.row)
    expect(after.xmin, 'another container was written').toBe(bystanderBefore.xmin)
  })

  it('the restored planting is on the Garden grid', async () => {
    expect(await listIds('grid')).toContain(pRestore)
  })
})
