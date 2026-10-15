// tests/integration/archive-hide-002.int.test.js — BUG-ARCHIVEHIDE-002 and audit I36 on real Postgres.
//
// The static guards (lambda/*/archive-hide-002.test.js, lambda/harvests/archive-hide.test.js,
// lambda/events/archive-hide-l1.test.js) pin the SQL text. They cannot show that a statement still
// RUNS, that it still RETURNS the live rows beside the hidden ones, or that a carve-out holds on real
// rows. That matters most for the dashboard reads: handleSearch and handleDashboard fold a failed
// section into [] or a tile fallback with HTTP 200, so a broken statement there reads as "nothing to
// show". Every exclusion below therefore sits beside a positive control, and the dashboard builders
// are called directly so an error throws here instead of being swallowed.
//
// Archiving a container does NOT cascade to its plantings (lambda/projects' archive PATCH writes the
// container's own column only), so a LIVE planting in an archived container is the fixture shape for
// the container-axis fixes (I10, I17, I21).
//
// FIXTURES are this file's own `int-test-` namespaced users; teardown hard-deletes them (the test-data
// carve-out) and the global sweep catches anything a failed beforeAll leaves behind.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'
import { handler as harvestsHandler } from '../../lambda/harvests/index.js'
import { handler as projectsHandler } from '../../lambda/projects/index.js'
import { handler as inventoryHandler } from '../../lambda/inventory-items/index.js'
import { queryRecentEvents, searchEvents, searchPhotos } from '../../lambda/dashboard/handlers.js'

const RUN = testRunId()
const USER = `user_int_ah2_${RUN}`
const MATE = `user_int_ah2_mate_${RUN}`
const STRANGER = `user_int_ah2_stranger_${RUN}`
const WORD = `ah2${RUN.slice('int-test-'.length).replace(/[^a-z0-9]/gi, '')}`
const SLUG = `int-ah2-pub-${RUN}`
const ENV_KEY = 'GARDEN_HOUSEHOLD_IDS'

let savedEnv
let varietyId, packetId
// containers
let cLive, cArch, cArchDel
// plantings
let pLive, pNone, pArchPl, pInArch, pInArchDel, pSownArch, pSownDel, pSownLive
// events
let eLive, eArchPl, eInArch, eArchPlPrivate
// harvests
let hLive, hInArch, hInArchDel
// photos
let phLive, phArchPl, phArchPlEvent
// project types
let tMine, tMate, tStranger

const call = (handler, method, path, body) => callHandler(handler, { method, path, body, userId: USER })

async function planting(tag, container, { archived = false, item = null, sown = null, up = null, sownAt = null } = {}) {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, created_by, archived_at, source_inventory_item_id,
                        seeds_sown, seeds_germinated, sown_at)
    VALUES (${container}, ${`int-ah2-${tag}-${RUN}`}, ${USER},
            CASE WHEN ${archived}::boolean THEN NOW() END, ${item}, ${sown}, ${up}, ${sownAt})
    RETURNING id`
  return rows[0].id
}
async function event(container, plant, { type = 'observation', isPublic = true, date = '2026-08-10T16:00:00Z' } = {}) {
  const rows = await directSql`
    INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public, notes, logged_by, created_by)
    VALUES (${container}, ${plant}, ${type}, ${date}::timestamptz, ${isPublic}, ${`${WORD} note`}, ${USER}, ${USER})
    RETURNING id`
  return rows[0].id
}
async function pick(container, plant, grams) {
  const id = await event(container, plant, { type: 'harvest' })
  await directSql`
    INSERT INTO harvest_log (event_id, project_id, quantity, unit, weight_grams, weight_estimated, weight_basis, created_by)
    VALUES (${id}, ${container}, 1, 'count', ${grams}::numeric, false, 'measured', ${USER})`
  return id
}
async function photo({ plant = null, eventId = null }) {
  const rows = await directSql`
    INSERT INTO photos (plant_id, event_id, storage_path, caption, created_by)
    VALUES (${plant}, ${eventId}, ${`int/ah2/${RUN}/${Math.random().toString(36).slice(2)}.jpg`},
            ${`${WORD} caption`}, ${USER})
    RETURNING id`
  return rows[0].id
}
async function projectType(createdBy, tag) {
  const rows = await directSql`
    INSERT INTO project_types (name, category, description, icon, created_by)
    VALUES (${`int-ah2-type-${tag}-${RUN}`}, 'garden', NULL, '🌱', ${createdBy}) RETURNING id`
  return rows[0].id
}

beforeAll(async () => {
  savedEnv = process.env[ENV_KEY]
  process.env[ENV_KEY] = `${USER},${MATE}`
  setTestUserId(USER)

  cLive = (await insertProject({ name: `int-ah2-live-${RUN}`, slug: SLUG, createdBy: USER })).id
  cArch = (await insertProject({ name: `int-ah2-arch-${RUN}`, createdBy: USER })).id
  cArchDel = (await insertProject({ name: `int-ah2-archdel-${RUN}`, createdBy: USER })).id
  await directSql`UPDATE plant_projects SET is_public = true WHERE id = ${cLive}`

  pLive = await planting('live', cLive)
  pNone = await planting('none', null)
  pArchPl = await planting('archived', cLive, { archived: true })
  pInArch = await planting('in-arch', cArch)
  pInArchDel = await planting('in-archdel', cArchDel)

  eLive = await event(cLive, pLive)
  eArchPl = await event(cLive, pArchPl)
  eArchPlPrivate = await event(cLive, pArchPl, { isPublic: false })
  eInArch = await event(cArch, pInArch)

  hLive = await pick(cLive, pLive, 100)
  hInArch = await pick(cArch, pInArch, 1000)
  hInArchDel = await pick(cArchDel, pInArchDel, 10000)

  phLive = await photo({ plant: pLive })
  phArchPl = await photo({ plant: pArchPl })
  phArchPlEvent = await photo({ eventId: eArchPl })

  tMine = await projectType(USER, 'mine')
  tMate = await projectType(MATE, 'mate')
  tStranger = await projectType(STRANGER, 'stranger')

  const v = await directSql`
    INSERT INTO plant_varieties (name, created_by) VALUES (${`int-ah2-variety-${RUN}`}, ${USER}) RETURNING id`
  varietyId = v[0].id
  const res = await call(inventoryHandler, 'POST', '/api/inventory-items', {
    name: `int-ah2-packet-${RUN}`, type: 'consumable', category: 'seeds', unit: 'packet',
    quantity_on_hand: 1, variety_id: varietyId,
  })
  expect(res.status, `POST packet -> ${JSON.stringify(res.body)}`).toBe(201)
  packetId = res.body.id
  pSownLive = await planting('sown-live', cLive, { item: packetId, sown: 10, up: 6, sownAt: '2026-05-01' })
  pSownArch = await planting('sown-arch', cLive, { archived: true, item: packetId, sown: 10, up: 4, sownAt: '2026-04-01' })
  pSownDel = await planting('sown-del', cArchDel, { item: packetId, sown: 100, up: 100, sownAt: '2026-03-01' })

  // Archive the two containers LAST, once their rows exist, then soft-delete one of them: a container
  // archived and later deleted keeps its archived_at (lambda/projects' DELETE sets deleted_at only).
  await directSql`UPDATE plant_projects SET archived_at = NOW() WHERE id IN (${cArch}, ${cArchDel})`
  await directSql`UPDATE plant_projects SET deleted_at = NOW() WHERE id = ${cArchDel}`
})

afterAll(async () => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv
  assertFixtureId(USER, MATE, STRANGER)
  await settle('archive-hide-002', [
    () => directSql`DELETE FROM photos WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM harvest_log WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM event_log WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM entity WHERE entity_type = 'planting' AND planting_ref_id IN (
                      SELECT id FROM plants WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM plants WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM entity_memory WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM project_types WHERE created_by IN (${USER}, ${MATE}, ${STRANGER})`,
    () => directSql`DELETE FROM inventory_items WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM entity WHERE entity_type = 'cultivar' AND cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`,
  ])
})

describe('PRECONDITION — the fixture shapes', () => {
  it('the plantings in archived containers are themselves live (no cascade), and one container is archived then deleted', async () => {
    const rows = await directSql`
      SELECT p.id, p.archived_at IS NOT NULL AS archived, p.deleted_at IS NOT NULL AS deleted,
             pp.archived_at IS NOT NULL AS c_archived, pp.deleted_at IS NOT NULL AS c_deleted
        FROM plants p JOIN plant_projects pp ON pp.id = p.project_id
       WHERE p.id IN (${pInArch}, ${pInArchDel})`
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(by[pInArch]).toMatchObject({ archived: false, deleted: false, c_archived: true, c_deleted: false })
    expect(by[pInArchDel]).toMatchObject({ archived: false, deleted: false, c_archived: true, c_deleted: true })
  })
})

describe('I10 — GET /api/events', () => {
  it('the bare list keeps a live event and drops events in an archived container and on an archived planting', async () => {
    const { status, body } = await call(eventsHandler, 'GET', '/api/events?limit=200')
    expect(status, JSON.stringify(body)).toBe(200)
    const ids = body.map((e) => e.id)
    expect(ids).toContain(eLive)
    expect(ids, 'an event in an ARCHIVED container is listed').not.toContain(eInArch)
    expect(ids).not.toContain(eArchPl)
  })
  it('the archived container\'s own event log (?project_id=) still shows its events', async () => {
    const { status, body } = await call(eventsHandler, 'GET', `/api/events?project_id=${cArch}&limit=200`)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body.map((e) => e.id)).toContain(eInArch)
  })
})

describe('I17 — GET /api/plants', () => {
  it('the default list keeps live and project-less plantings and drops one in an archived container', async () => {
    const { status, body } = await call(plantsHandler, 'GET', '/api/plants')
    expect(status, JSON.stringify(body)).toBe(200)
    const ids = body.map((p) => p.id)
    expect(ids).toContain(pLive)
    expect(ids, 'a project-less planting is missing: the clause is not NULL-safe').toContain(pNone)
    expect(ids, 'a planting in an ARCHIVED container is listed').not.toContain(pInArch)
    expect(ids).not.toContain(pArchPl)
  })
  it('the archived container\'s own planting list (?project_id=) still shows its planting', async () => {
    const { status, body } = await call(plantsHandler, 'GET', `/api/plants?project_id=${cArch}`)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body.map((p) => p.id)).toContain(pInArch)
  })
})

describe('I21 / I20 — GET /api/harvests', () => {
  it('entries keep the live pick and the deleted container\'s pick, and drop the archived container\'s', async () => {
    const { status, body } = await call(harvestsHandler, 'GET', '/api/harvests?timeframe=all&include=entries')
    expect(status, JSON.stringify(body)).toBe(200)
    const ids = body.entries.map((e) => e.event_id)
    expect(ids).toContain(hLive)
    expect(ids, 'I20 carve-out broken: a pick in an archived-then-deleted container vanished').toContain(hInArchDel)
    expect(ids, 'a pick in an ARCHIVED container is listed').not.toContain(hInArch)
  })
  it('the weight total is the live pick plus the deleted container\'s pick, never the archived container\'s', async () => {
    const { status, body } = await call(harvestsHandler, 'GET', '/api/harvests?timeframe=all&include=aggregates')
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body.aggregates.weight.grams).toBe(100 + 10000)
    expect(body.aggregates.weight.measured).toBe(2)
  })
  it('?plant= (the planting\'s own harvest list) still shows a pick in an archived container', async () => {
    const { status, body } = await call(harvestsHandler, 'GET', `/api/harvests?timeframe=all&include=entries&plant=${pInArch}`)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body.entries.map((e) => e.event_id)).toEqual([hInArch])
  })
})

describe('I30 / I31 / I32 — dashboard reads (called directly, so an SQL error throws)', () => {
  it('recent events keep the live event and drop the archived planting\'s', async () => {
    const ids = (await queryRecentEvents(directSql, USER)).map((r) => r.id)
    expect(ids).toContain(eLive)
    expect(ids, 'an event on an ARCHIVED planting is on the dashboard feed').not.toContain(eArchPl)
    expect(ids).not.toContain(eInArch)
  })
  it('header event search keeps the live event and drops the archived planting\'s', async () => {
    const ids = (await searchEvents(directSql, USER, `%${WORD}%`)).map((r) => r.id)
    expect(ids).toContain(eLive)
    expect(ids, 'an event on an ARCHIVED planting is in search').not.toContain(eArchPl)
  })
  it('header photo search keeps the live photo and drops both archived-planting photos', async () => {
    const ids = (await searchPhotos(directSql, USER, `%${WORD}%`)).map((r) => r.id)
    expect(ids).toContain(phLive)
    expect(ids, 'a photo ON an archived planting is in search').not.toContain(phArchPl)
    expect(ids, 'a photo on an EVENT of an archived planting is in search').not.toContain(phArchPlEvent)
  })
})

describe('I37 — the public timeline', () => {
  it('lists the live planting\'s public event and not the archived planting\'s', async () => {
    const { status, body } = await call(projectsHandler, 'GET', `/api/projects/public/${SLUG}`)
    expect(status, JSON.stringify(body)).toBe(200)
    const ids = body.events.map((e) => e.id)
    expect(ids).toContain(eLive)
    expect(ids, 'a public event of an ARCHIVED planting is on the share page').not.toContain(eArchPl)
    expect(ids).not.toContain(eArchPlPrivate)
  })
})

describe('I36 — GET /api/projects/types is household-only', () => {
  it('lists built-in types, my type and my household mate\'s, not a stranger\'s, and no created_by', async () => {
    const { status, body } = await call(projectsHandler, 'GET', '/api/projects/types')
    expect(status, JSON.stringify(body)).toBe(200)
    const by = Object.fromEntries(body.map((t) => [t.id, t]))
    expect(by[tMine]).toMatchObject({ is_own: true, is_system: false })
    expect(by[tMate]).toMatchObject({ is_own: false, is_system: false })
    expect(by[tStranger], 'a stranger\'s custom type is listed').toBeUndefined()
    expect(body.some((t) => t.is_system === true), 'no built-in type came back').toBe(true)
    for (const t of body) expect(t).not.toHaveProperty('created_by')
  })
  it('POST answers without created_by', async () => {
    const { status, body } = await call(projectsHandler, 'POST', '/api/projects/types', { name: `int-ah2-type-post-${RUN}` })
    expect(status, JSON.stringify(body)).toBe(201)
    expect(body).toMatchObject({ is_own: true, is_system: false })
    expect(body).not.toHaveProperty('created_by')
  })
})

describe('I13 — the packet\'s germination record (Dave 2026-10-15: archived sowings keep counting)', () => {
  it('counts the live and the ARCHIVED sowing, and drops the sowing in a deleted container', async () => {
    const { status, body } = await call(inventoryHandler, 'GET', `/api/inventory-items/${packetId}`)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body.germination.sowings.map((s) => s.id)).toEqual([pSownLive, pSownArch])
    expect(body.germination).toMatchObject({ seeds_sown: 20, seeds_germinated: 10, rate: 50 })
  })
})
