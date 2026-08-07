// tests/integration/reanchor-carecache.int.test.js
// V4-EVENTEDITFIELDS-001 Slice 3 (re-anchor) — the BEHAVIOURAL half of the care-cache guarantee.
//
// WHAT THE STATIC TESTS ALREADY PROVE, AND WHAT THEY DO NOT.
// lambda/events/edit-fields.test.js:246 ("the OLD-anchor arms assign from surv and NEVER through
// GREATEST") reads index.js as TEXT. It proves the re-anchor SQL is SHAPED so that a decrease is
// expressible. It cannot prove a decrease HAPPENS: it never executes the statement, never binds a
// parameter, never meets a row, and stays green against surv subqueries whose predicates are wrong,
// whose UPDATE matches zero rows, or that run before the event_log UPDATE has committed the new
// anchor. Falsifiable statement of the gap this file closes:
//
//   "Against real Postgres, after an event is re-anchored from A to B, A's entity_memory recency
//    values are STRICTLY LOWER than they were before the move (or NULL), and B's are at least as
//    high as the moved event."
//
// Nothing in this repository could make that sentence false before this file. Every assertion that
// reads the EVENT row passes whether or not the recompute ran — the event moves correctly either
// way, nothing 500s, nothing logs, and the vacated anchor silently keeps claiming a watering it no
// longer has, forever, because every forward upsert is GREATEST().
//
// CALIBRATION — BUG-CARECACHEUNDO-001 is the same family, one route over: event undo recomputed
// only last_watered_at, so undoing a harvest / fertilizing / pruning / observation left that column
// and last_event_at permanently ahead of the log. migrations/v4-carecacheundo-001 repaired the data
// (applied to prod 2026-08-07 14:47Z), and the proof it walked BACKWARDS ONLY was that the
// complementary "behind" population was UNCHANGED at 15 rows. The detector in staleForward() below
// is that migration's post gate `post_no_cache_ahead_of_event_log`, verbatim, scoped to this file's
// fixtures. Verified against live prod the same day: 0 ahead, 15 behind, 338 rows total.
//
// PER-ARM WRITER PARITY is asserted behaviourally here, not only as text: the plant-keyed writer
// maps event_type IN ('harvest','first_harvest') (index.js:1499, :1519) and the project-keyed one
// maps = 'harvest' (index.js:1450, :1472). A first_harvest therefore sets a PLANTING's
// last_harvested_at and must leave a CONTAINER's NULL. edit-fields.test.js:267 asserts the two SQL
// strings differ; this asserts the consequence — a unified filter would give a container a
// last_harvested_at that no forward write in this codebase could ever have produced.
//
// FIXTURE ISOLATION IS LOAD-BEARING, not tidiness. A vacated container recomputes from ALL of its
// surviving events, so a sibling describe's event parked on the same container silently holds the
// recompute up at the value the test is trying to watch it fall from — and the test then passes for
// the wrong reason, or fails blaming the handler. Every describe therefore builds its own
// containers and plantings, exactly as the PUT/harvest describe in events.int.test.js:75 does.
//
// TEARDOWN ORDER (BUG-EVTANCHORDEL-001). event_log.plant_id is ON DELETE RESTRICT since
// v4-evtanchordel-001, and event_log_has_anchor requires plant_id OR project_id, so the only safe
// order is: harvest_log -> event_log -> entity -> entity_memory -> plants -> plant_projects.
// Deleting plantings first fails 23503 post-migration, and pre-migration the FK's own SET NULL
// cascade produced a row violating the anchor CHECK and died 23514 naming nothing useful.
// entity_memory.plant_id is itself ON DELETE RESTRICT, and the plants_entity_ins trigger creates an
// `entity` row for every planting — both must go before the planting.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler } from '../../lambda/events/index.js'

const RUN = testRunId()
const USER = `user_int_reanchor_${RUN}`

const DAY = 24 * 3600 * 1000
const T1 = new Date(Date.now() - 20 * DAY).toISOString()  // the SURVIVOR — where a vacated cache must land
const T2 = new Date(Date.now() - 10 * DAY).toISOString()  // the MOVED event — where the cache starts
const ms = (v) => (v == null ? null : new Date(v).getTime())

const RECENCY = ['last_event_at', 'last_watered_at', 'last_fertilized_at',
                 'last_pruned_at', 'last_observed_at', 'last_harvested_at']

const post = (body) => callHandler(handler, { method: 'POST', path: '/api/events', body, userId: USER })
const put = (id, body) => callHandler(handler, { method: 'PUT', path: `/api/events/${id}`, body, userId: USER })

async function newEvent(body) {
  const res = await post(body)
  expect(res.status, `POST failed: ${JSON.stringify(res.body)}`).toBe(201)
  return res.body.id ?? res.body.eventId
}
async function newProject(tag) {
  return (await insertProject({ name: `int-reanchor-${tag}-${RUN}`, createdBy: USER })).id
}
async function newPlanting({ project = null, tag }) {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${project}, ${`int-reanchor-${tag}-${RUN}`}, ${USER}) RETURNING id`
  return rows[0].id
}

// Column lists are written out per helper rather than interpolated from a shared constant: the neon
// HTTP driver's tagged template parameterises EVERY ${} slot, so a spliced identifier list would be
// bound as a single text literal and the query would fail. There is no .unsafe() escape hatch here.
const plantCache = async (id) =>
  (await directSql`
    SELECT id, plant_id, project_id, location_id, next_water_at,
           last_event_at, last_watered_at, last_fertilized_at,
           last_pruned_at, last_observed_at, last_harvested_at,
           -- BUG-LASTISSUEPLANT-001 added this column the same day this file was written, and
           -- neither helper picked it up. GAP 4 asserts on it, so without this its precondition
           -- read undefined and the block could never distinguish the defect from the repair.
           last_issue_at
      FROM entity_memory WHERE plant_id = ${id}`)[0] ?? null
const projectCache = async (id) =>
  (await directSql`
    SELECT id, plant_id, project_id, location_id, next_water_at,
           last_event_at, last_watered_at, last_fertilized_at,
           last_pruned_at, last_observed_at, last_harvested_at,
           -- BUG-LASTISSUEPLANT-001 added this column the same day this file was written, and
           -- neither helper picked it up. GAP 4 asserts on it, so without this its precondition
           -- read undefined and the block could never distinguish the defect from the repair.
           last_issue_at
      FROM entity_memory WHERE project_id = ${id}`)[0] ?? null

// THE CANONICAL STALE-FORWARD DETECTOR.
// Lifted from migrations/v4-carecacheundo-001/gates.yml `post_no_cache_ahead_of_event_log`, scoped
// to this run's fixtures via created_by. A row is an offender when ANY cached recency value is
// STRICTLY AHEAD of the surviving event log — including the cached-non-NULL / truth-NULL case,
// which is precisely the shape produced by re-anchoring a planting's ONLY event and which a
// GREATEST-based writer can neither create nor repair. The per-arm harvest filter split is baked
// into the CASE, so the detector cannot be satisfied by a recompute that unifies the two arms.
async function staleForward() {
  return directSql`
    WITH truth AS (
      SELECT em.id, em.plant_id, em.project_id,
             em.last_event_at, em.last_watered_at, em.last_fertilized_at,
             em.last_pruned_at, em.last_observed_at, em.last_harvested_at,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_any,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type IN ('watering','rain')
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_water,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type = 'fertilizing'
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_fert,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type = 'pruning'
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_prune,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type = 'observation'
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_obs,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.event_type IN ('harvest','first_harvest')
                           ELSE e.event_type = 'harvest' END)
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_harv
        FROM public.entity_memory em
       WHERE em.plant_id IN (SELECT id FROM public.plants WHERE created_by = ${USER})
          OR em.project_id IN (SELECT id FROM public.plant_projects WHERE created_by = ${USER})
    )
    SELECT id, plant_id, project_id FROM truth
     WHERE (last_event_at      IS NOT NULL AND (t_any   IS NULL OR last_event_at      > t_any))
        OR (last_watered_at    IS NOT NULL AND (t_water IS NULL OR last_watered_at    > t_water))
        OR (last_fertilized_at IS NOT NULL AND (t_fert  IS NULL OR last_fertilized_at > t_fert))
        OR (last_pruned_at     IS NOT NULL AND (t_prune IS NULL OR last_pruned_at     > t_prune))
        OR (last_observed_at   IS NOT NULL AND (t_obs   IS NULL OR last_observed_at   > t_obs))
        OR (last_harvested_at  IS NOT NULL AND (t_harv  IS NULL OR last_harvested_at  > t_harv))`
}

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
                    SELECT id FROM plant_projects WHERE created_by = ${USER})`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

describe('re-anchor between PLANTINGS: the vacated planting walks BACKWARDS', () => {
  let projectId, plantA, plantB, movedId

  beforeAll(async () => {
    projectId = await newProject('p1')
    // Sibling plantings under ONE container. plant_projects hold multiple sibling plantings, so
    // "watered the wrong tomato" is a plant-only move with projectChanged = false — the realistic
    // mis-log, and the case that isolates the plant-keyed arms.
    plantA = await newPlanting({ project: projectId, tag: 'p1-A' })
    plantB = await newPlanting({ project: projectId, tag: 'p1-B' })
    await newEvent({ project_id: projectId, plant_id: plantA, event_type: 'watering', event_date: T1 })
    movedId = await newEvent({ project_id: projectId, plant_id: plantA, event_type: 'watering', event_date: T2 })
  })

  it('PRECONDITION: plantA is cached at T2, plantB has no cache row at all', async () => {
    // Its own test so a failure reads as "the fixture never got built" rather than as a false
    // accusation against the recompute.
    const a = await plantCache(plantA)
    expect(ms(a.last_watered_at)).toBe(ms(T2))
    expect(ms(a.last_event_at)).toBe(ms(T2))
    expect(await plantCache(plantB)).toBeNull()
  })

  it('after the move plantA reads T1 — STRICTLY LOWER than before. This is the whole ticket', async () => {
    // MUTATION PROOF: rewrite the old-plant arm (index.js:1501) as
    //   last_watered_at = GREATEST(em.last_watered_at, surv.mw)
    // and every other assertion in this repository still passes while this one fails. The event row
    // is correct either way; only a read of the ABANDONED anchor can tell the difference.
    const res = await put(movedId, { event_type: 'watering', event_date: T2, plant_id: plantB })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.plant_id).toBe(plantB)

    const a = await plantCache(plantA)
    expect(ms(a.last_watered_at), 'plantA still claims the watering it no longer has').toBe(ms(T1))
    expect(ms(a.last_event_at)).toBe(ms(T1))
    expect(ms(a.last_watered_at)).toBeLessThan(ms(T2))
  })

  it('plantB gained a cache row it never had — an upsert, not a bare UPDATE', async () => {
    // A bare UPDATE matches zero rows on a destination that has never carried an event, and reports
    // nothing. The planting would silently have no care memory at all.
    const b = await plantCache(plantB)
    expect(b, 'no row was inserted for the destination planting').not.toBeNull()
    expect(ms(b.last_watered_at)).toBe(ms(T2))
    expect(ms(b.last_event_at)).toBe(ms(T2))
  })

  it('the CONTAINER cache is untouched — the event never left this project', async () => {
    // projectChanged is false, so no project arm may run. Asserting the negative stops a future
    // "just recompute everything, it is easier to reason about" refactor from quietly widening the
    // blast radius of a plant-only edit.
    const p = await projectCache(projectId)
    expect(ms(p.last_watered_at)).toBe(ms(T2))
    expect(ms(p.last_event_at)).toBe(ms(T2))
  })

  it('moving it BACK restores both caches — the operation is reversible in both directions', async () => {
    // The handler comment (index.js:1414) justifies the uniform recompute by direction-independence.
    // A recompute correct in one direction only passes every assertion above and fails here.
    const res = await put(movedId, { event_type: 'watering', event_date: T2, plant_id: plantA })
    expect(res.status).toBe(200)
    expect(ms((await plantCache(plantA)).last_watered_at)).toBe(ms(T2))
    expect((await plantCache(plantB)).last_watered_at, 'plantB must now walk backwards to NULL').toBeNull()
  })
})

describe('re-anchor: vacating a planting of its ONLY event drives the cache to NULL', () => {
  // The sharpest assertion in the file. GREATEST(COALESCE(x, v), v) is total — it cannot return
  // NULL — so a cache that reaches NULL here is positive proof the value came from surv rather than
  // from a forward upsert. It is also exactly the shape BUG-CARECACHEUNDO-001 left on prod
  // ("Pineapple Tomato": last_harvested_at cached at 2026-08-04 with no surviving harvest at all).
  let projectId, plantC, plantD, soloId

  beforeAll(async () => {
    projectId = await newProject('p2')
    plantC = await newPlanting({ project: projectId, tag: 'p2-C' })
    plantD = await newPlanting({ project: projectId, tag: 'p2-D' })
    soloId = await newEvent({ project_id: projectId, plant_id: plantC, event_type: 'watering', event_date: T2 })
  })

  it('PRECONDITION: plantC is cached at T2 from its one and only event', async () => {
    expect(ms((await plantCache(plantC)).last_watered_at)).toBe(ms(T2))
  })

  it('every recency column on plantC goes to NULL — a state unreachable through GREATEST', async () => {
    const res = await put(soloId, { event_type: 'watering', event_date: T2, plant_id: plantD })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const c = await plantCache(plantC)
    expect(c, 'the row must be RECOMPUTED, not deleted').not.toBeNull()
    for (const col of RECENCY) expect(c[col], `${col} survived the vacate`).toBeNull()
  })

  it('the emptied row still satisfies entity_memory_exactly_one_parent', async () => {
    // A recompute that "tidied up" by nulling the anchor alongside the values would produce a
    // zero-parent row, abort the transaction, and surface as an opaque 500 AFTER the event had
    // already moved — the event_log UPDATE commits before sql.transaction(reanchor) runs.
    const c = await plantCache(plantC)
    expect([c.plant_id, c.project_id, c.location_id].filter((x) => x != null)).toEqual([plantC])
  })

  it('plantD received the event', async () => {
    expect(ms((await plantCache(plantD)).last_watered_at)).toBe(ms(T2))
  })
})

describe('re-anchor between CONTAINERS: the vacated project walks back, next_water_at included', () => {
  // Project-only events (plant_id null) so plantChanged stays false and the project arms are the
  // only thing under test. The destination has never carried an event, so its row must be INSERTed.
  let projectSrc, projectDst, movedId

  beforeAll(async () => {
    projectSrc = await newProject('p3-src')
    projectDst = await newProject('p3-dst')
    await newEvent({ project_id: projectSrc, event_type: 'watering', event_date: T1 })
    movedId = await newEvent({ project_id: projectSrc, event_type: 'watering', event_date: T2 })
  })

  it('PRECONDITION: the source is cached at T2 with next_water_at four days out', async () => {
    // 4 days is COALESCE(watering_interval_days, <location_type CASE>) with both NULL on a fresh
    // row — the same default the recompute uses (index.js:1456), so the two are comparable.
    const p = await projectCache(projectSrc)
    expect(ms(p.last_watered_at)).toBe(ms(T2))
    expect(ms(p.next_water_at)).toBe(ms(T2) + 4 * DAY)
    expect(await projectCache(projectDst)).toBeNull()
  })

  it('the source drops to T1 and its next_water_at is RE-DERIVED from T1, not left at T2+4d', async () => {
    // next_water_at is the one cached value a user sees as a due date. Left forward, the container
    // silently vanishes from "needs water" for ten days and nothing anywhere reports it.
    const res = await put(movedId, { event_type: 'watering', event_date: T2, project_id: projectDst })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.project_id).toBe(projectDst)

    const p = await projectCache(projectSrc)
    expect(ms(p.last_watered_at)).toBe(ms(T1))
    expect(ms(p.last_event_at)).toBe(ms(T1))
    expect(ms(p.next_water_at), 'the due date still points at the departed watering').toBe(ms(T1) + 4 * DAY)
  })

  it('the destination got a brand-new cache row at T2', async () => {
    const p = await projectCache(projectDst)
    expect(p, 'the destination has no cache row — the upsert degenerated to an UPDATE').not.toBeNull()
    expect(ms(p.last_watered_at)).toBe(ms(T2))
    expect(ms(p.last_event_at)).toBe(ms(T2))
  })
})

describe('per-arm writer parity survives a re-anchor: first_harvest is a PLANTING milestone only', () => {
  // first_harvest carries no quantity and writes no harvest_log row (validators.js:197), so it
  // exercises the harvest columns without dragging the weight resolver in.
  let projectSrc, projectDst, plantE, fhId

  beforeAll(async () => {
    projectSrc = await newProject('p4-src')
    projectDst = await newProject('p4-dst')
    plantE = await newPlanting({ project: projectSrc, tag: 'p4-E' })
    fhId = await newEvent({ project_id: projectSrc, plant_id: plantE, event_type: 'first_harvest', event_date: T1 })
  })

  it('PRECONDITION: the planting records the milestone, the container does not', async () => {
    expect(ms((await plantCache(plantE)).last_harvested_at)).toBe(ms(T1))
    expect((await projectCache(projectSrc)).last_harvested_at,
      'the project-keyed forward writer maps harvest only').toBeNull()
  })

  it('re-anchoring it to another container leaves BOTH containers last_harvested_at NULL', async () => {
    const res = await put(fhId, { event_type: 'first_harvest', event_date: T1, project_id: projectDst })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((await projectCache(projectSrc)).last_harvested_at,
      'the vacated container invented a harvest it never had').toBeNull()
    expect((await projectCache(projectDst)).last_harvested_at,
      'the destination claims a harvest its own forward writer would never record').toBeNull()
  })

  it('the vacated container is emptied on every OTHER recency column too', async () => {
    const p = await projectCache(projectSrc)
    for (const col of RECENCY) expect(p[col], `${col} survived the vacate`).toBeNull()
  })

  it('the planting keeps the milestone — plant_id did not change, so no plant arm ran', async () => {
    expect(ms((await plantCache(plantE)).last_harvested_at)).toBe(ms(T1))
  })
})

describe('the invariant, over everything this file touched', () => {
  it('no cached recency value is ahead of the surviving event log (canonical detector)', async () => {
    // The same query that gates migrations/v4-carecacheundo-001. Each describe above asserts one
    // cell; this asserts the property across every fixture at once, and it is what catches a
    // regression in an arm nobody thought to write a case for.
    const offenders = await staleForward()
    expect(offenders.map((r) => r.plant_id ?? r.project_id)).toEqual([])
  })
})

// ── KNOWN GAPS — RED TODAY, DELIBERATELY SKIPPED ────────────────────────────────────────────────
//
// These are complete and runnable and they FAIL against dev HEAD. They are skipped so that landing
// this file does not red the fail-closed `integration-tests` promote gate for defects it did not
// introduce. Un-skip each in the commit that fixes it. Do NOT "fix" them by weakening the
// assertion — each was derived exactly the way the passing cases above were.
//
// SHARED ROOT CAUSE: index.js:1432 gates the entire recompute on `projectChanged || plantChanged`.
// Anchor movement is only ONE of the three ways this PUT invalidates the cache. The other two —
// event_date moving backwards (index.js:1222) and event_type changing (index.js:1221) — run no
// recompute at all, and every forward upsert is GREATEST(), so the drift is permanent and accretes
// one cell per edit. That is BUG-CARECACHEUNDO-001's mechanism arriving through a different door,
// in a route that shipped AFTER the repair.
describe.skip('GAP 1 — editing an event_date BACKWARDS leaves the cache forward', () => {
  let projectId, id
  beforeAll(async () => {
    projectId = await newProject('gap1')
    id = await newEvent({ project_id: projectId, event_type: 'watering', event_date: T2 })
  })
  it('moving the only watering back to T1 must lower last_watered_at', async () => {
    const res = await put(id, { event_type: 'watering', event_date: T1 })
    expect(res.status).toBe(200)
    const p = await projectCache(projectId)
    expect(ms(p.last_watered_at)).toBe(ms(T1))          // reads T2 today
    expect(ms(p.next_water_at)).toBe(ms(T1) + 4 * DAY)  // reads T2+4d today
  })
})

// GAP 4 (BUG-LASTISSUEPLANT-001 session, 2026-08-07): the SAME gate, reached through the flag.
// v4.2.0 shipped the ability to UNFLAG an event from EventDetail (clearFields.js:resolveFlagPair).
// Unflagging changes neither anchor, so `projectChanged || plantChanged` is false and no recompute
// runs — last_issue_at keeps pointing at an event that is no longer flagged, permanently, because
// its forward writer is GREATEST(). This is the fourth door into the same room, and it is the one
// that most directly undercuts adding last_issue_at to the six recompute arms: the arms are now
// correct, but the most likely way a user invalidates the column reaches none of them.
// Un-skip in the commit that widens the gate at index.js:1445.
describe.skip('GAP 4 — unflagging an event leaves last_issue_at pointing at it', () => {
  let projectId, id
  beforeAll(async () => {
    projectId = await newProject('gap4')
    id = await newEvent({ project_id: projectId, event_type: 'observation', event_date: T2,
      flagged_as_issue: true, severity: 2 })   // validators.js:107 — severity is 1|2|3, not a word
  })
  it('the container has no flagged event left, so last_issue_at must go NULL', async () => {
    const p0 = await projectCache(projectId)
    expect(ms(p0.last_issue_at)).toBe(ms(T2))    // the forward writer set it — this passes today

    const res = await put(id, { event_type: 'observation', event_date: T2, flagged_as_issue: false })
    expect(res.status).toBe(200)
    const p = await projectCache(projectId)
    expect(p.last_issue_at).toBeNull()           // reads T2 today
  })
})

describe.skip('GAP 2 — retyping an event AWAY from watering leaves last_watered_at set', () => {
  let projectId, id
  beforeAll(async () => {
    projectId = await newProject('gap2')
    id = await newEvent({ project_id: projectId, event_type: 'watering', event_date: T2 })
  })
  it('the container has no watering left, so last_watered_at must go NULL', async () => {
    const res = await put(id, { event_type: 'observation', event_date: T2 })
    expect(res.status).toBe(200)
    const p = await projectCache(projectId)
    expect(p.last_watered_at).toBeNull()         // reads T2 today
    expect(ms(p.last_observed_at)).toBe(ms(T2))  // reads NULL today
  })
})

describe.skip('GAP 3 — next_water_at is gated on the POST-edit event_type', () => {
  // index.js:1455 binds ${movedType} = body.event_type, i.e. what the event BECOMES. Re-anchor a
  // watering AND retype it in one save and the CASE takes the NOT IN ('watering','rain') arm, so
  // the vacated container keeps a next_water_at derived from a watering that is now neither its
  // event nor a watering. last_watered_at correctly walks backwards in the same statement, leaving
  // the pair mutually inconsistent — which is the tell, and is why this is a distinct defect from
  // GAP 2 rather than the same one seen twice.
  let projectSrc, projectDst, id
  beforeAll(async () => {
    projectSrc = await newProject('gap3-src')
    projectDst = await newProject('gap3-dst')
    await newEvent({ project_id: projectSrc, event_type: 'watering', event_date: T1 })
    id = await newEvent({ project_id: projectSrc, event_type: 'watering', event_date: T2 })
  })
  it('a simultaneous re-anchor + retype must still re-derive the vacated due date', async () => {
    const res = await put(id, { event_type: 'observation', event_date: T2, project_id: projectDst })
    expect(res.status).toBe(200)
    const p = await projectCache(projectSrc)
    expect(ms(p.last_watered_at)).toBe(ms(T1))          // passes today
    expect(ms(p.next_water_at)).toBe(ms(T1) + 4 * DAY)  // reads T2+4d today
  })
})
