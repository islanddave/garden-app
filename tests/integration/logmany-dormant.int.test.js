// logmany-dormant.int.test.js — BUG-DORMANTLISTS-001, against a real database.
//
// Dave, 2026-08-20, from his phone: "I STILL see cavendish strawberries, christmas cactus there
// even though they are utterly dormant and not in need of water." Verified against live prod the
// same day: all 5 dormant plantings (Asparagus, Cavendish Strawberry, Christmas Cactus, Garlic,
// Wild Wineberry) resolved into Log Many's "all" scope, which the UI labels "all active plantings".
//
// THE RULE, in his words, is two-sided and the SECOND side is the dangerous one:
//   * a dormant planting falls off routine-care lists — Log Many included;
//   * it STILL shows in the Harvests tab, and still has a reachable plantings page so he can log to
//     it or reactivate it.
// An over-broad filter that also hid it from Harvests or from /api/plants would be a WORSE bug than
// the one being fixed, because it makes a plant he owns unreachable. So the reachability arms below
// are not padding: they are the half of the spec that constrains the fix, and each one goes red if
// the exclusion leaks out of the batch resolver into a read path.
//
// WHY INTEGRATION. The unit-side guard (lambda/events/logmany-dormant.test.js) proves by source
// that the predicate is present, in the scope SELECT, and dormant-only. It cannot prove the claim
// that matters: that a real dormant row does not come back from a real query, while the same row
// still comes back from three other real queries. `status` lives on the base `plants` table and is
// read through the `garden_node` view (name AS display_name, project_id AS container_id) — a view
// hop that source text cannot evaluate. Counting rows after a real POST is the only honest proof.
//
// DORMANT-ONLY is asserted, not assumed: `harvested` is seeded alongside and must STAY in the
// batch. Log Many is a logging surface, not a care recommendation, and widening the predicate to
// the ('failed','ended','dormant') triple the care queries use would silently drop the
// deliberately-unmanaged legacy perennials (all `ended`) out of a bulk path Dave still uses.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'
import { handler as harvestsHandler } from '../../lambda/harvests/index.js'

const RUN = testRunId()
const USER = `user_int_dorm_${RUN}`

let projectId
let dormantId   // status='dormant'      — must LEAVE Log Many, must STAY everywhere else
let activeId    // status='vegetative'   — the control that must stay in Log Many
let endedId     // status='ended'        — the BLAST-RADIUS control (see the dormant-only test)
let dormantHarvestEventId

const mkPlant = async (name, status) =>
  (await directSql`
    INSERT INTO plants (project_id, name, status, created_by)
    VALUES (${projectId}, ${name + '-' + RUN}, ${status}, ${USER}) RETURNING id`)[0].id

beforeAll(async () => {
  setTestUserId(USER)
  projectId = (await insertProject({ name: 'int-dorm-' + RUN, createdBy: USER })).id
  dormantId = await mkPlant('dorm-christmas-cactus', 'dormant')
  activeId = await mkPlant('dorm-control-active', 'vegetative')
  // `ended`, not `harvested`: the care queries exclude ('failed','ended','dormant'), so `harvested`
  // is inside the batch either way and a control built on it cannot fail — the first cut of this
  // file used one and the widen-the-predicate mutation stayed green.
  endedId = await mkPlant('dorm-control-ended', 'ended')

  // A real harvest hanging off the DORMANT planting. Dave's Wild Wineberry / Cavendish Strawberry
  // are exactly this shape: dormant now, with a season of harvests behind them that the Harvests
  // tab must keep showing.
  const ev = await directSql`
    INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public, logged_by, created_by)
    VALUES (${projectId}, ${dormantId}, 'harvest', '2026-07-14T15:00:00Z'::timestamptz, true, ${USER}, ${USER})
    RETURNING id`
  dormantHarvestEventId = ev[0].id
  // harvest_log has NO plant_id — attribution to a planting is carried by event_log.plant_id and
  // reached through the garden_node join in lambda/harvests/index.js.
  await directSql`
    INSERT INTO harvest_log (event_id, project_id, quantity, unit, created_by)
    VALUES (${dormantHarvestEventId}, ${projectId}, 3::numeric, 'cup', ${USER})`
})

afterAll(async () => {
  await directSql`DELETE FROM xp_events WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_achievements WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_stats WHERE user_id = ${USER}`
  await directSql`DELETE FROM app_events WHERE user_clerk_sub = ${USER}`
  await directSql`DELETE FROM event_batches WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM harvest_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

let seq = 0
const postBatch = (over = {}) =>
  callHandler(eventsHandler, {
    method: 'POST', path: '/api/events/batch', userId: USER,
    body: {
      idempotency_key: `dorm-${RUN}-${++seq}`,
      event_type: 'fertilizing',
      scope: { type: 'project', project_id: projectId },
      ...over,
    },
  })

describe('BUG-DORMANTLISTS-001 — Log Many drops dormant plantings', () => {
  it('the dry-run preview omits the dormant planting and keeps the others', async () => {
    const { status, body } = await postBatch({ dry_run: true })
    expect(status).toBe(200)
    const ids = body.plantings.map((p) => p.id)
    expect(ids).not.toContain(dormantId)
    expect(ids).toContain(activeId)
    // Not just "3 became 2" — the count must agree with the list it came from, or a preview could
    // show the right rows and submit a different set.
    expect(body.count).toBe(ids.length)
    expect(body.count).toBe(2)
  })

  it('the WRITE path skips it too — dry-run and submit cannot diverge', async () => {
    const { status, body } = await postBatch()
    expect(status).toBe(200)
    expect(body.count).toBe(2)
    const rows = await directSql`
      SELECT plant_id FROM event_log
       WHERE metadata->>'batch_id' = ${body.batch_id} AND deleted_at IS NULL`
    const logged = rows.map((r) => r.plant_id)
    expect(logged).not.toContain(dormantId)
    expect(logged).toContain(activeId)
    expect(logged).toContain(endedId)
    expect(logged).toHaveLength(2)
  })

  it('excludes DORMANT ONLY — an `ended` planting is still batch-loggable', async () => {
    // The blast-radius pin. Widening to the ('failed','ended','dormant') triple the care queries
    // use passes every other test in this file and fails only this one. That is not a claim that
    // ended-in-Log-Many is ideal — it is a claim that this fix changed exactly ONE status. Dave's
    // deliberately-unmanaged legacy perennials (raspberry, peach, blackberry, blueberry, wineberry)
    // all carry `ended`, so widening would quietly pull them out of a bulk LOGGING path while the
    // reported defect was only ever about routine CARE. Changing that is a separate decision with
    // his name on it, and this test is where it has to be made explicitly.
    const { body } = await postBatch({ dry_run: true })
    expect(body.plantings.map((p) => p.id)).toContain(endedId)
  })

  it('the exclusion is by planting status, not by project — siblings under the same project split', async () => {
    // Scope by plant_id, never project_id: all three fixtures share ONE project, so a project-level
    // exclusion would take the whole set to zero and a project-level pass would take it to three.
    const { body } = await postBatch({ dry_run: true })
    expect(body.count).toBe(2)
    const all = await directSql`
      SELECT count(*)::int AS n FROM plants
       WHERE project_id = ${projectId} AND deleted_at IS NULL`
    expect(all[0].n).toBe(3)
  })
})

describe('BUG-DORMANTLISTS-001 — reachability is NOT filtered (the other half of the rule)', () => {
  it('the Harvests tab still shows a harvest logged on the dormant planting', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(harvestsHandler, {
      method: 'GET', path: '/api/harvests?timeframe=all&include=entries', userId: USER,
    })
    expect(status).toBe(200)
    const mine = body.entries.filter((e) => e.plant_id === dormantId)
    expect(mine).toHaveLength(1)
    expect(mine[0].event_id ?? mine[0].id).toBe(dormantHarvestEventId)
  })

  it('the per-planting harvest list (PlantingDetail) still resolves for a dormant planting', async () => {
    const { status, body } = await callHandler(harvestsHandler, {
      method: 'GET', path: `/api/harvests?timeframe=all&include=entries&plant=${dormantId}`, userId: USER,
    })
    expect(status).toBe(200)
    expect(body.entries.map((e) => e.plant_id)).toEqual([dormantId])
  })

  it('its plantings page still loads — GET /api/plants/:id returns it, still marked dormant', async () => {
    const { status, body } = await callHandler(plantsHandler, {
      method: 'GET', path: `/api/plants/${dormantId}`, userId: USER,
    })
    expect(status).toBe(200)
    expect(body.id).toBe(dormantId)
    // The status must survive the round trip: this is what the Garden grid's Lifecycle grouping
    // reads to file it under "Dormant", and what the reactivate affordance flips.
    expect(body.status).toBe('dormant')
  })

  it('it is still findable in the plantings list, so the Dormant lifecycle group is non-empty', async () => {
    const { status, body } = await callHandler(plantsHandler, {
      method: 'GET', path: '/api/plants', userId: USER,
    })
    expect(status).toBe(200)
    const rows = Array.isArray(body) ? body : (body.plants ?? body.plantings ?? [])
    const row = rows.find((p) => p.id === dormantId)
    expect(row).toBeTruthy()
    expect(row.status).toBe('dormant')
  })

  it('a SINGLE event can still be logged to it — "log to it" is explicitly allowed', async () => {
    // Only the bulk resolver is filtered. The single-event path takes a plant_id from the client
    // and must keep accepting a dormant one, or the plantings page loses its log button.
    const { status } = await callHandler(eventsHandler, {
      method: 'POST', path: '/api/events', userId: USER,
      body: { plant_id: dormantId, project_id: projectId, event_type: 'observation', notes: 'still asleep' },
    })
    expect(status).toBeLessThan(300)
    const rows = await directSql`
      SELECT count(*)::int AS n FROM event_log
       WHERE plant_id = ${dormantId} AND event_type = 'observation' AND deleted_at IS NULL`
    expect(rows[0].n).toBe(1)
  })
})
