// tests/integration/anchor-pair.int.test.js
// BUG-EVENTPROJPLANTPAIR-001 — the event anchor pair, against real Postgres.
//
// THE INVARIANT: when event_log.plant_id is non-NULL, event_log.project_id MUST equal that
// planting's project (garden_node.container_id / plants.project_id — the view maps one to the
// other). 43 rows on prod violated it, 39 of them live.
//
// WHY THIS FILE EXISTS HERE AND NOT AS A UNIT TEST. The behavioural half of that ticket originally
// lived in lambda/events/anchor-pair.test.js, which imported the real handler and mocked
// @neondatabase/serverless. That file passed locally and FAILED IN CI on dev 32993a3:
//
//   Error: Failed to resolve import "@neondatabase/serverless" from "lambda/events/index.js"
//
// @neondatabase/serverless, @clerk/backend and @aws-sdk/client-secrets-manager are in NO
// package.json in this repo. `npm ci` therefore cannot install them, and vitest.config.ts says so
// out loud (it excludes tests/integration/** "so `npm test` doesn't try to resolve
// @neondatabase/serverless"). The unit file resolved them only because a worktree node_modules had
// been cloned from a sibling lane that carried them — a local green that CI could never reproduce.
// So the repo-wide rule "no lambda unit test imports a handler" was NOT stale; it was correct.
//
// The integration workflow, by contrast, installs those three packages explicitly
// (integration-test.yml "Install handler deps at root") precisely so the real handler can run. This
// layer is where a handler-driving test belongs, and it is strictly stronger than the unit version
// it replaces: the unit test asserted the VALUE BOUND to a parameter, this asserts the ROW POSTGRES
// ACTUALLY HOLDS. lambda/events/anchor-pair.test.js keeps the pure-function and source-scan halves,
// which need no handler import.
//
// THE DATABASE NOW HOLDS THE INVARIANT TOO (BUG-PLANTPROJECTFKDRIFT-001). Prod has carried
//   event_log_plant_project_fk  FOREIGN KEY (plant_id, project_id) REFERENCES plants(id, project_id)
//                               ON UPDATE CASCADE ON DELETE RESTRICT   (MATCH SIMPLE)
// since 2026-08-21. migrations/v5-plantprojectfkdrift-001 brings it to staging, which this suite
// forks. Two rules for this file follow from that, and both are deliberate:
//   * NOTHING HERE WRITES A PAIR THAT DISAGREES. The constraint refuses it (23503), so a fixture that
//     needs one cannot be built on prod and, after the migration, cannot be built on the fork either.
//     The one broken shape still writable is an event with NO project on a planting that has one:
//     MATCH SIMPLE checks a row only when both columns are set.
//   * THE FILE PASSES WITH THE CONSTRAINT AND WITHOUT IT. It has to reach dev BEFORE staging is
//     migrated — the version it replaces wrote the refused row in a beforeAll — so the block that
//     proves the database refuses the pair detects the constraint and is skipped where it is absent.
//
// TEARDOWN ORDER (BUG-EVTANCHORDEL-001), copied from reanchor-carecache.int.test.js:
// harvest_log -> event_log -> entity -> entity_memory -> plants -> plant_projects.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler } from '../../lambda/events/index.js'

// Does the database this suite forked carry the constraint, and does it say the migration ran?
// Read once, before any describe is collected, the way season-stats.int.test.js reads its views.
const HAS_PAIR_FK = (await directSql`
  SELECT EXISTS (SELECT 1
                   FROM pg_constraint c
                   JOIN pg_class t ON t.oid = c.conrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'event_log' AND c.contype = 'f'
                    AND c.conname = 'event_log_plant_project_fk') AS ok`)[0].ok
const HAS_PAIR_FK_STAMP = (await directSql`
  SELECT (to_regclass('public.schema_version') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.schema_version
                 WHERE version = '5.0.0-plantprojectfkdrift-001')) AS ok`)[0].ok

const RUN = testRunId()
const USER = `user_int_anchorpair_${RUN}`
const OUTSIDER = `user_int_anchorpair_outsider_${RUN}`

const DAY = 24 * 3600 * 1000
const T1 = new Date(Date.now() - 20 * DAY).toISOString()
const ms = (v) => (v == null ? null : new Date(v).getTime())

const post = (body) => callHandler(handler, { method: 'POST', path: '/api/events', body, userId: USER })
const put = (id, body) => callHandler(handler, { method: 'PUT', path: `/api/events/${id}`, body, userId: USER })

async function newProject(tag, createdBy = USER) {
  return (await insertProject({ name: `int-anchorpair-${tag}-${RUN}`, createdBy })).id
}
// project defaults to NULL on purpose: a project-LESS planting is a supported state
// (BUG-CAPTUREFLOW400-001, Dave decision S1) and 5 of them are live on prod today.
async function newPlanting({ project = null, tag }) {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${project}, ${`int-anchorpair-${tag}-${RUN}`}, ${USER}) RETURNING id`
  return rows[0].id
}
const eventRow = async (id) =>
  (await directSql`SELECT id, project_id, plant_id, event_type FROM event_log WHERE id = ${id}`)[0] ?? null
const plantCache = async (id) =>
  (await directSql`SELECT last_event_at, last_watered_at, last_harvested_at FROM entity_memory WHERE plant_id = ${id}`)[0] ?? null
const projectCache = async (id) =>
  (await directSql`SELECT last_event_at, last_watered_at, last_harvested_at FROM entity_memory WHERE project_id = ${id}`)[0] ?? null

// The Clerk stub resolves the actor from module state, NOT from callHandler's userId (that only
// writes the Authorization header). Without this every request runs as the harness default and the
// ownership gate answers 400 on fixtures this file owns.
beforeAll(() => { setTestUserId(USER) })

afterAll(async () => {
  await directSql`DELETE FROM xp_events WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_achievements WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_stats WHERE user_id = ${USER}`
  await directSql`DELETE FROM app_events WHERE user_clerk_sub = ${USER}`
  await directSql`DELETE FROM harvest_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (
                    SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (
                    SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE project_id IN (
                    SELECT id FROM plant_projects WHERE created_by IN (${USER}, ${OUTSIDER}))`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by IN (${USER}, ${OUTSIDER})`
})

describe('POST /api/events — a request naming a disagreeing project cannot write one', () => {
  let projTrue, projClaimed, plant

  beforeAll(async () => {
    projTrue = await newProject('post-true')
    projClaimed = await newProject('post-claimed')
    plant = await newPlanting({ project: projTrue, tag: 'post' })
  })

  it('writes the PLANTING\'s project, not the body\'s', async () => {
    const res = await post({ event_type: 'watering', event_date: T1, plant_id: plant, project_id: projClaimed })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const row = await eventRow(res.body.id ?? res.body.eventId)
    expect(row.project_id, 'the claimed project reached the row — the pair disagrees with itself').toBe(projTrue)
    expect(row.plant_id).toBe(plant)
  })

  it('still refuses a project_id the caller does not own, rather than silently discarding it', async () => {
    // The derivation must not become an accidental authz bypass: the ownership gate runs on what
    // was SENT, and only then is the effective value derived.
    const foreign = await newProject('post-foreign', OUTSIDER)
    const res = await post({ event_type: 'watering', event_date: T1, plant_id: plant, project_id: foreign })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid project_id')
  })
})

describe('PUT /api/events/:id — the derivation REPAIRS a stored pair that lost its project, and the cache follows', () => {
  // THE ONE BROKEN SHAPE THE DATABASE STILL ALLOWS: an event with NO project on a planting that HAS
  // one. event_log_plant_project_fk is MATCH SIMPLE, so a NULL in either column is not checked and
  // this row is writable on prod today. The derivation still has to repair it on the next edit.
  //
  // RETIRED 2026-10-09 (BUG-PLANTPROJECTFKDRIFT-001), AND WHY. This block used to build the
  // "39 live rows" shape — an event carrying a DIFFERENT project from its planting's — with
  //     UPDATE event_log SET project_id = <a second project> WHERE id = <the event>
  // and assert three things about the next edit. That statement is a 23503 wherever the constraint
  // exists: prod since 2026-08-21, and this suite's fork once staging is migrated. No writer and no
  // direct SQL can produce the row, so there is nothing left for an edit to repair:
  //   · "an edit re-derives project_id from the planting" — KEPT, re-seated on the NULL shape;
  //   · "the container the event LEFT is vacated" — RETIRED. It needs a stale non-NULL project to
  //     leave. The vacate arm itself is still run by the last describe in this file, where an event
  //     really does leave a project (for a project-less planting);
  //   · "the container the event ARRIVED at carries it" — KEPT, and now proves something: the
  //     fixture empties that container's cache first, so the value can only have come from the PUT.
  //     (Before, the POST in the fixture had already written it.)
  // That the database refuses the old fixture is asserted in the describe after this one.
  let projTrue, plant, id

  beforeAll(async () => {
    projTrue = await newProject('put-true')
    plant = await newPlanting({ project: projTrue, tag: 'put' })
    const res = await post({ event_type: 'watering', event_date: T1, plant_id: plant, project_id: projTrue })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    id = res.body.id ?? res.body.eventId
    // MANUFACTURE THE GAP with direct SQL, because no writer mints it: the event loses its project,
    // and the container forgets the event, as if the write had never reached the project's cache
    // row. Both statements are legal with the constraint in place — a NULL project is not checked.
    await directSql`UPDATE event_log SET project_id = NULL WHERE id = ${id}`
    await directSql`
      UPDATE entity_memory SET last_event_at = NULL, last_watered_at = NULL
       WHERE project_id = ${projTrue}`
  })

  it('PRECONDITION: the event has no project, its planting has one, and the container does not carry it', async () => {
    const row = await eventRow(id)
    expect(row.plant_id).toBe(plant)
    expect(row.project_id).toBeNull()
    expect((await directSql`SELECT project_id FROM plants WHERE id = ${plant}`)[0].project_id).toBe(projTrue)
    expect((await projectCache(projTrue))?.last_event_at ?? null).toBeNull()
  })

  it('an edit that touches only the notes re-derives project_id from the planting', async () => {
    const res = await put(id, { event_type: 'watering', notes: 'just editing the note' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((await eventRow(id)).project_id).toBe(projTrue)
  })

  it('the container the event ARRIVED at carries it — the derivation counts as an anchor move', async () => {
    // The whole reason projectChanged is computed from the DERIVED value and not from the request:
    // this move was never asked for by the body, and the cache still has to follow it.
    const arrived = await projectCache(projTrue)
    expect(ms(arrived?.last_event_at), 'the container does not know about the event it now holds').toBe(ms(T1))
    expect(ms(arrived?.last_watered_at)).toBe(ms(T1))
  })
})

// ── migrations/v5-plantprojectfkdrift-001 — THE DATABASE REFUSES THE PAIR ITSELF ─────────────────
//
// DETECTED, NOT HARDCODED, and that is the opposite call from the schema pins in
// evt-anchor-delete.int.test.js on purpose. Those could be hardcoded because their migration was on
// staging before the file landed. This file must land FIRST (see the header), so a hardcoded pin
// would be red on every push between "this file is on dev" and "staging is migrated".
// What keeps the detection from being a guard that cannot fail: the STAMP. Once a database says the
// migration ran, the first case below requires the constraint, so dropping it from staging without
// rolling the migration back reds here. The definition itself is held by the migration's standing
// gates (post_foreign_key_is_prods), which compare it with prod's character for character.
describe('the database itself refuses a disagreeing pair (migrations/v5-plantprojectfkdrift-001)', () => {
  it.runIf(HAS_PAIR_FK_STAMP)('the 5.0.0-plantprojectfkdrift-001 stamp means event_log_plant_project_fk is there', () => {
    expect(HAS_PAIR_FK, 'the fork says the migration ran but event_log has no event_log_plant_project_fk').toBe(true)
  })

  describe.skipIf(!HAS_PAIR_FK)('with event_log_plant_project_fk on the fork', () => {
    let projTrue, projOther, plant, id

    beforeAll(async () => {
      projTrue = await newProject('fk-true')
      projOther = await newProject('fk-other')
      plant = await newPlanting({ project: projTrue, tag: 'fk' })
      const res = await post({ event_type: 'watering', event_date: T1, plant_id: plant, project_id: projTrue })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      id = res.body.id ?? res.body.eventId
    })

    it('it is the rule prod has: ON UPDATE CASCADE, ON DELETE RESTRICT, MATCH SIMPLE, onto plants', async () => {
      const rows = await directSql`
        SELECT c.confupdtype, c.confdeltype, c.confmatchtype, f.relname AS target
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_class f ON f.oid = c.confrelid
         WHERE n.nspname = 'public' AND t.relname = 'event_log'
           AND c.conname = 'event_log_plant_project_fk'`
      expect(rows).toHaveLength(1)
      expect(`${rows[0].confupdtype}${rows[0].confdeltype}${rows[0].confmatchtype} ${rows[0].target}`).toBe('crs plants')
    })

    it('the retired fixture — another project written straight onto the event — is refused 23503, by name', async () => {
      // The exact statement this file used to run in a beforeAll. NOT VALID or validated makes no
      // difference: either way a write is checked.
      let code = null
      let said = ''
      try {
        await directSql`UPDATE event_log SET project_id = ${projOther} WHERE id = ${id}`
      } catch (e) {
        code = e.code ?? e.sourceError?.code ?? String(e.message)
        said = `${e.message} ${e.constraint ?? ''} ${e.sourceError?.constraint ?? ''}`
      }
      expect(code, 'the write was accepted: the fork does not enforce the pair').toBe('23503')
      expect(said).toMatch(/event_log_plant_project_fk/)
    })

    it('the refused write left the pair as it was', async () => {
      const row = await eventRow(id)
      expect(row.plant_id).toBe(plant)
      expect(row.project_id).toBe(projTrue)
    })

    it('NO project on that same event is still accepted — MATCH SIMPLE, the shape the repair block relies on', async () => {
      await directSql`UPDATE event_log SET project_id = NULL WHERE id = ${id}`
      expect((await eventRow(id)).project_id).toBeNull()
      await directSql`UPDATE event_log SET project_id = ${projTrue} WHERE id = ${id}`
    })
  })
})

// ── BUG-EMPROJGUARD-001, PUT ARM — the regression 9492601 opened ───────────────────────────────
//
// The POST's project-keyed upsert has carried `WHERE ${projectId}::uuid IS NOT NULL` since
// BUG-EMPROJGUARD-001 (index.js ~:3017): entity_memory_exactly_one_parent is a VALIDATED CHECK
// requiring exactly one of plant_id/project_id/location_id, so an unguarded NULL project_id
// inserts a ZERO-parent row and raises 23514.
//
// The PUT's re-anchor sibling had no such guard, and did not need one while newProjectId was
// `body.project_id ?? oldProjectId` — a value that could never be NULL for a row that reached that
// line. BUG-EVENTPROJPLANTPAIR-001 made it derive from the planting instead, and a project-less
// planting derives to NULL. That re-opened the exact hole BUG-EMPROJGUARD-001 closed on the other
// route, in the arm that runs on EVERY re-anchor.
//
// WHAT THE FAILURE LOOKS LIKE, measured before the fix: the 23514 aborts the whole cache
// transaction and the handler maps it to `400 Constraint violation:
// entity_memory_exactly_one_parent`. Not a 500 — which is WORSE, because the caller is told the
// edit was rejected while the event_log UPDATE has ALREADY committed (separate statement, HTTP
// driver auto-commit). The event moves, the cache does not, and nothing reconciles them.
//
// REACHABLE ON LIVE PROD DATA, not just in a fixture: 5 project-less plantings and 3 live events
// that carry a project_id while their planting has none (measured against prod 2026-08-20).
describe('re-anchoring onto a PROJECT-LESS planting must not break the write', () => {
  let project, plantIn, plantFree, id

  beforeAll(async () => {
    project = await newProject('free-src')
    plantIn = await newPlanting({ project, tag: 'free-in' })
    plantFree = await newPlanting({ tag: 'free-out' })   // no container, deliberately
    const res = await post({ event_type: 'watering', event_date: T1, plant_id: plantIn, project_id: project })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    id = res.body.id ?? res.body.eventId
  })

  it('PRECONDITION: the planting really has no project, and the event really has one', async () => {
    expect((await directSql`SELECT project_id FROM plants WHERE id = ${plantFree}`)[0].project_id).toBeNull()
    expect((await eventRow(id)).project_id).toBe(project)
  })

  it('the move answers 200 — an unguarded NULL project bind aborts the cache transaction', async () => {
    const res = await put(id, { event_type: 'watering', plant_id: plantFree })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it('the event now agrees with its planting: no project at all', async () => {
    const row = await eventRow(id)
    expect(row.plant_id).toBe(plantFree)
    expect(row.project_id).toBeNull()
  })

  it('no zero-parent cache row was created', async () => {
    const orphans = await directSql`
      SELECT id FROM entity_memory
       WHERE plant_id IS NULL AND project_id IS NULL AND location_id IS NULL`
    expect(orphans).toEqual([])
  })

  it('the vacated container AND the vacated planting both walk back, and the destination carries it', async () => {
    // entity_memory is keyed plant-FIRST: asserting only the project arm checks the wrong row.
    expect((await projectCache(project)).last_event_at,
      'the container kept an event that moved off it').toBeNull()
    expect((await plantCache(plantIn)).last_event_at,
      'the vacated planting kept an event that moved off it').toBeNull()
    expect(ms((await plantCache(plantFree)).last_event_at)).toBe(ms(T1))
    expect(ms((await plantCache(plantFree)).last_watered_at)).toBe(ms(T1))
  })
})
