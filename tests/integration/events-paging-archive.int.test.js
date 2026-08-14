// events-paging-archive.int.test.js — the three behavioural claims the static guards CANNOT prove.
//
// ⚠️ WRITTEN-BUT-UNRUN as of the lane-events-20260813 branch. Integration tests need a real
// ephemeral Neon branch (see tests/integration/_globalSetup.js) which the parallel build fleet does
// not have; every assertion below was reasoned against the handler source, none was observed green.
// The CI integration job is what turns these from claims into evidence.
//
// WHY A SEPARATE FILE rather than appended to events.int.test.js: this branch was built alongside
// nine sibling lanes and a new file cannot merge-conflict. Fold it in later if that is preferred.
//
// The three claims, and why source-text assertions are insufficient for each:
//
//   1. OFFSET PAGING (BUG-PROJEVENTTRUNC-001). A static guard sees `LIMIT ${limit} OFFSET ${offset}`
//      in the SQL. It cannot see whether page 2 is actually DISJOINT from page 1 — which is a
//      property of the ORDER BY being total, not of the OFFSET being present. That is the exact
//      failure the id tiebreaker exists to prevent, and it is invisible without real rows.
//
//   2. ARCHIVED-PLANTING EXCLUSION (V4-ARCHIVEHIDE-001 L1). The NOT EXISTS reads correctly. Whether
//      it excludes the right rows — and, just as important, whether it leaves the plant-scoped
//      route ALONE so an archived planting keeps its own log — is a data question.
//
//   3. planting_name (V4-EVENTDETAILRICH-001). Whether the LEFT JOIN yields NULL rather than
//      omitting the row for an event with no planting anchor is a join-semantics question.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler } from '../../lambda/events/index.js'

const RUN = testRunId()
const USER = `user_int_evtpage_${RUN}`

let projectId
let livePlantingId
let archivedPlantingId
let archivedEventIds = []
let bareEventId          // an event with no planting anchor at all

// Enough rows to page with a small limit. The route clamps limit at 200 but honours anything below.
const PAGE = 3
const TOTAL = 7

beforeAll(async () => {
  setTestUserId(USER)
  projectId = (await insertProject({ name: 'int-evtpage-' + RUN, createdBy: USER })).id

  const lp = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${projectId}, ${'live-' + RUN}, ${USER}) RETURNING id`
  livePlantingId = lp[0].id

  // ARCHIVED, not deleted. The two axes are orthogonal and this fixture is the proof: deleted_at
  // stays NULL so a failure here cannot be explained away as the soft-delete filter doing the work.
  const ap = await directSql`
    INSERT INTO plants (project_id, name, created_by, archived_at)
    VALUES (${projectId}, ${'archived-' + RUN}, ${USER}, NOW()) RETURNING id, archived_at, deleted_at`
  archivedPlantingId = ap[0].id
  expect(ap[0].archived_at).toBeTruthy()
  expect(ap[0].deleted_at).toBeNull()

  // TOTAL events on the LIVE planting, each a distinct second so ordering is unambiguous, plus a
  // deliberate pair sharing an event_date to exercise the ORDER BY tiebreaker across a page seam.
  for (let i = 0; i < TOTAL; i++) {
    await directSql`
      INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public, logged_by, created_by)
      VALUES (${projectId}, ${livePlantingId}, 'observation',
              ${new Date(Date.UTC(2026, 4, 10, 12, 0, i)).toISOString()}, true, ${USER}, ${USER})`
  }
  // Two events sharing BOTH event_date and created_at bucket — without e.id in the ORDER BY these
  // are the rows that can swap between page fetches.
  await directSql`
    INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public, logged_by, created_by)
    SELECT ${projectId}, ${livePlantingId}, 'observation',
           ${new Date(Date.UTC(2026, 4, 9, 12, 0, 0)).toISOString()}, true, ${USER}, ${USER}
    FROM generate_series(1, 2)`

  const ae = await directSql`
    INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public, logged_by, created_by)
    SELECT ${projectId}, ${archivedPlantingId}, 'observation',
           ${new Date(Date.UTC(2026, 4, 11, 12, 0, 0)).toISOString()}, true, ${USER}, ${USER}
    FROM generate_series(1, 3)
    RETURNING id`
  archivedEventIds = ae.map((r) => r.id)

  const be = await directSql`
    INSERT INTO event_log (project_id, event_type, event_date, is_public, logged_by, created_by)
    VALUES (${projectId}, 'observation', ${new Date(Date.UTC(2026, 4, 12, 12, 0, 0)).toISOString()},
            true, ${USER}, ${USER}) RETURNING id`
  bareEventId = be[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM xp_events WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_achievements WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_stats WHERE user_id = ${USER}`
  await directSql`DELETE FROM app_events WHERE user_clerk_sub = ${USER}`
  await directSql`DELETE FROM entity_memory WHERE project_id = ${projectId}`
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

const list = (query) => callHandler(handler, { method: 'GET', path: `/api/events?${query}`, userId: USER })

describe('GET /api/events — the offset contract (BUG-PROJEVENTTRUNC-001)', () => {
  it('omitting offset still returns a BARE ARRAY — every pre-existing caller is untouched', async () => {
    setTestUserId(USER)
    const { status, body } = await list(`project_id=${projectId}&limit=${PAGE}`)
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(PAGE)
  })

  it('offset=0 opts into the envelope on the FIRST page (presence, not value)', async () => {
    setTestUserId(USER)
    const { status, body } = await list(`project_id=${projectId}&limit=${PAGE}&offset=0`)
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(false)
    expect(Object.keys(body).sort()).toEqual(['events', 'has_more', 'limit', 'offset'])
    expect(body.limit).toBe(PAGE)
    expect(body.offset).toBe(0)
    expect(body.has_more).toBe(true)
    expect(body.events).toHaveLength(PAGE)
  })

  // THE CLAIM STATIC TESTS CANNOT MAKE. Walking every page must yield each event exactly once.
  // A non-total ORDER BY passes every source-text guard and fails right here.
  it('walking the pages yields every event exactly once — no duplicates, no holes', async () => {
    setTestUserId(USER)
    const seen = []
    let offset = 0
    let guard = 0
    for (;;) {
      const { body } = await list(`project_id=${projectId}&limit=${PAGE}&offset=${offset}`)
      seen.push(...body.events.map((e) => e.id))
      if (!body.has_more || ++guard > 20) break
      offset += body.events.length
    }
    // The 9 live-planting events + the unanchored one. The 3 archived-planting events are excluded
    // by L1 below, which is why this number is not 13.
    expect(seen).toHaveLength(TOTAL + 2 + 1)
    expect(new Set(seen).size).toBe(seen.length)
    for (const id of archivedEventIds) expect(seen).not.toContain(id)
  })

  it('has_more goes false on the page that completes the history', async () => {
    setTestUserId(USER)
    const { body } = await list(`project_id=${projectId}&limit=200&offset=0`)
    expect(body.has_more).toBe(false)
  })

  it('an offset past the end is an empty page, not an error', async () => {
    setTestUserId(USER)
    const { status, body } = await list(`project_id=${projectId}&limit=${PAGE}&offset=9999`)
    expect(status).toBe(200)
    expect(body.events).toEqual([])
    expect(body.has_more).toBe(false)
  })

  it('a garbage offset floors at 0 rather than 500-ing', async () => {
    setTestUserId(USER)
    const { status, body } = await list(`project_id=${projectId}&limit=${PAGE}&offset=-5`)
    expect(status).toBe(200)
    expect(body.offset).toBe(0)
    const junk = await list(`project_id=${projectId}&limit=${PAGE}&offset=abc`)
    expect(junk.status).toBe(200)
    expect(junk.body.offset).toBe(0)
  })
})

describe('GET /api/events — archived plantings (V4-ARCHIVEHIDE-001 L1)', () => {
  it('the project-scoped list EXCLUDES events on an archived planting', async () => {
    setTestUserId(USER)
    const { body } = await list(`project_id=${projectId}&limit=200&offset=0`)
    const ids = body.events.map((e) => e.id)
    for (const id of archivedEventIds) expect(ids).not.toContain(id)
  })

  it('the bare (unscoped) list excludes them too', async () => {
    setTestUserId(USER)
    const { body } = await callHandler(handler, { method: 'GET', path: '/api/events', userId: USER })
    const ids = body.map((e) => e.id)
    for (const id of archivedEventIds) expect(ids).not.toContain(id)
  })

  it('the feed excludes them', async () => {
    setTestUserId(USER)
    const { body } = await callHandler(handler, {
      method: 'GET', path: '/api/events/feed?limit=100', userId: USER })
    const ids = body.events.map((e) => e.id)
    for (const id of archivedEventIds) expect(ids).not.toContain(id)
  })

  // THE OTHER HALF, and the one a well-meaning follow-up lane is most likely to break: an archived
  // planting must keep its OWN log, because that page is where the Unarchive affordance lives.
  it('the plant-scoped list still returns an ARCHIVED planting its own events', async () => {
    setTestUserId(USER)
    const scoped = await list(`project_id=${projectId}&plant_id=${archivedPlantingId}&limit=200`)
    expect(scoped.status).toBe(200)
    expect(scoped.body.map((e) => e.id).sort()).toEqual([...archivedEventIds].sort())

    const plantOnly = await list(`plant_id=${archivedPlantingId}&limit=200`)
    expect(plantOnly.status).toBe(200)
    expect(plantOnly.body.map((e) => e.id).sort()).toEqual([...archivedEventIds].sort())
  })

  // Archive and soft-delete are different axes with different recovery surfaces. Unarchiving must
  // put the events straight back; if a lane ever folds the two predicates together, this fails.
  it('unarchiving restores the events to the default surfaces', async () => {
    setTestUserId(USER)
    await directSql`UPDATE plants SET archived_at = NULL WHERE id = ${archivedPlantingId}`
    try {
      const { body } = await list(`project_id=${projectId}&limit=200&offset=0`)
      const ids = body.events.map((e) => e.id)
      for (const id of archivedEventIds) expect(ids).toContain(id)
    } finally {
      await directSql`UPDATE plants SET archived_at = NOW() WHERE id = ${archivedPlantingId}`
    }
  })

  it('an event with NO planting anchor is never collateral of the NOT EXISTS', async () => {
    setTestUserId(USER)
    const { body } = await list(`project_id=${projectId}&limit=200&offset=0`)
    expect(body.events.map((e) => e.id)).toContain(bareEventId)
  })
})

describe('GET /api/events/:id — planting_name (V4-EVENTDETAILRICH-001)', () => {
  it('returns the planting display name for an event with a planting anchor', async () => {
    setTestUserId(USER)
    const anchored = await directSql`
      SELECT id FROM event_log WHERE plant_id = ${livePlantingId} LIMIT 1`
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/events/${anchored[0].id}`, userId: USER })
    expect(status).toBe(200)
    expect(body.planting_name).toBe('live-' + RUN)
  })

  it('returns planting_name NULL — not a missing key, not a 404 — when there is no anchor', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/events/${bareEventId}`, userId: USER })
    expect(status).toBe(200)
    expect(body).toHaveProperty('planting_name')
    expect(body.planting_name).toBeNull()
  })

  it('an ARCHIVED planting still names itself on the event detail (archiving hides, it does not erase)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/events/${archivedEventIds[0]}`, userId: USER })
    expect(status).toBe(200)
    expect(body.planting_name).toBe('archived-' + RUN)
  })

  it('the ownership columns are still stripped (the widening did not leak them)', async () => {
    setTestUserId(USER)
    const { body } = await callHandler(handler, {
      method: 'GET', path: `/api/events/${bareEventId}`, userId: USER })
    expect(body).not.toHaveProperty('project_owner_id')
    expect(body).not.toHaveProperty('plant_owner_id')
  })
})
