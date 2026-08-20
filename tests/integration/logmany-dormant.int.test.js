// logmany-dormant.int.test.js — BUG-DORMANTLISTS-001 + BUG-LOGMANYSTATUS-001, against a real
// database. (Filename kept from round one: the fix is the same predicate, widened.)
//
// Round one, Dave 2026-08-20 from his phone: "I STILL see cavendish strawberries, christmas cactus
// there even though they are utterly dormant and not in need of water." Verified against live prod
// the same day: all 5 dormant plantings resolved into Log Many's "all" scope, which the UI labels
// "all active plantings". That fix excluded `dormant` alone and left `ended`/`failed` in as a
// product call.
//
// Round two (BUG-LOGMANYSTATUS-001) measured that call and reversed it. Live prod, same day:
// Strawberries — marked `ended` on 2026-06-25 — had since collected 31 further batch events across
// 23 separate watering runs, the last on 08-19; Emerald Green took a bulk watering on 08-19, the
// day after Dave marked it `failed`. 32 care events on plantings he had already closed out. The
// offsetting workflow round one argued for (a deliberate cleanup batch on an ended bed) has zero
// instances: the other two ended plantings have taken no events at all since they ended.
//
// THE RULE, in his words, is two-sided and the SECOND side is the dangerous one:
//   * a closed-out planting falls off routine-care lists — Log Many included;
//   * it STILL shows in the Harvests tab, and still has a reachable plantings page so he can log to
//     it or reactivate it.
// An over-broad filter that also hid it from Harvests or from /api/plants would be a WORSE bug than
// the one being fixed, because it makes a plant he owns unreachable — and widening from one status
// to three tripled the surface that claim has to hold over, which is why the reachability arms
// below now run for `ended` and `failed` too. `ended` is the sharpest case: Dave's Red Raspberries
// carries 24 harvests and is `ended`, so an over-broad filter would empty a season off his
// Harvests tab.
//
// WHY INTEGRATION. The unit-side guards (lambda/events/logmany-dormant.test.js for this SELECT,
// lambda/live-planting-predicate-sync.test.js for the fleet-wide vocabulary) prove by source that
// the predicate is present, in the scope SELECT, and neither narrower nor wider than the LIVE
// triple. They cannot prove the claim that matters: that a real closed-out row does not come back
// from a real query, while the same row still comes back from three other real queries. `status`
// lives on the base `plants` table and is read through the `garden_node` view (name AS
// display_name, project_id AS container_id) — a view hop that source text cannot evaluate.
// Counting rows after a real POST is the only honest proof.
//
// NOT-WIDER is asserted, not assumed: a `rooting` planting is seeded alongside and must STAY in the
// batch. `rooting` is the one status the fleet's two vocabularies disagree about — the dashboard's
// nag surfaces exclude it, every surface that logs or plans care keeps it — so it is the control
// that a lazy "just use the dashboard's list" widening would break, and the only one that would.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'
import { handler as harvestsHandler } from '../../lambda/harvests/index.js'

const RUN = testRunId()
const USER = `user_int_dorm_${RUN}`

let projectId
let activeId     // status='vegetative' — the control that must stay in Log Many
let rootingId    // status='rooting'    — the BLAST-RADIUS control (see the not-wider test)
const EXCLUDED = [   // each must LEAVE Log Many and STAY reachable everywhere else
  { label: 'dormant', status: 'dormant', name: 'dorm-christmas-cactus', id: null, harvestId: null },
  { label: 'ended', status: 'ended', name: 'dorm-ended-strawberries', id: null, harvestId: null },
  { label: 'failed', status: 'failed', name: 'dorm-failed-pepper', id: null, harvestId: null },
]

const mkPlant = async (name, status) =>
  (await directSql`
    INSERT INTO plants (project_id, name, status, created_by)
    VALUES (${projectId}, ${name + '-' + RUN}, ${status}, ${USER}) RETURNING id`)[0].id

beforeAll(async () => {
  setTestUserId(USER)
  projectId = (await insertProject({ name: 'int-dorm-' + RUN, createdBy: USER })).id
  activeId = await mkPlant('dorm-control-active', 'vegetative')
  // `rooting`, not `harvested`: `harvested` is inside the batch under BOTH the LIVE triple and the
  // dashboard's wider CARE list, so a control built on it cannot fail — the first cut of this file
  // used one and the widen-the-predicate mutation stayed green. Round one used `ended` for the same
  // job; round one's fix is what put `ended` on the excluded side, so the control moves to the one
  // status the two live vocabularies still disagree about.
  rootingId = await mkPlant('dorm-control-rooting', 'rooting')
  for (const p of EXCLUDED) {
    p.id = await mkPlant(p.name, p.status)
    // A real harvest hanging off each closed-out planting. Dave's Wild Wineberry (dormant) and Red
    // Raspberries (ended, 24 harvests) are exactly this shape: closed out now, with a season of
    // harvests behind them that the Harvests tab must keep showing.
    const ev = await directSql`
      INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public, logged_by, created_by)
      VALUES (${projectId}, ${p.id}, 'harvest', '2026-07-14T15:00:00Z'::timestamptz, true, ${USER}, ${USER})
      RETURNING id`
    p.harvestId = ev[0].id
    // harvest_log has NO plant_id — attribution to a planting is carried by event_log.plant_id and
    // reached through the garden_node join in lambda/harvests/index.js.
    await directSql`
      INSERT INTO harvest_log (event_id, project_id, quantity, unit, created_by)
      VALUES (${p.harvestId}, ${projectId}, 3::numeric, 'cup', ${USER})`
  }
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

describe('Log Many drops closed-out plantings (dormant, ended, failed)', () => {
  it('the dry-run preview omits all three and keeps the two live ones', async () => {
    const { status, body } = await postBatch({ dry_run: true })
    expect(status).toBe(200)
    const ids = body.plantings.map((p) => p.id)
    for (const p of EXCLUDED) expect(ids, `${p.label} must not be in the preview`).not.toContain(p.id)
    expect(ids).toContain(activeId)
    // Not just "5 became 2" — the count must agree with the list it came from, or a preview could
    // show the right rows and submit a different set.
    expect(body.count).toBe(ids.length)
    expect(body.count).toBe(2)
  })

  it('the WRITE path skips them too — dry-run and submit cannot diverge', async () => {
    const { status, body } = await postBatch()
    expect(status).toBe(200)
    expect(body.count).toBe(2)
    const rows = await directSql`
      SELECT plant_id FROM event_log
       WHERE metadata->>'batch_id' = ${body.batch_id} AND deleted_at IS NULL`
    const logged = rows.map((r) => r.plant_id)
    for (const p of EXCLUDED) expect(logged, `${p.label} must not be logged`).not.toContain(p.id)
    expect(logged).toContain(activeId)
    expect(logged).toContain(rootingId)
    expect(logged).toHaveLength(2)
  })

  it('excludes the LIVE triple ONLY — a `rooting` cutting is still batch-loggable', async () => {
    // The blast-radius pin. Widening to the ('dormant','ended','failed','rooting') list that
    // dashboard/handlers.js and findings/index.js use passes every other test in this file and
    // fails only this one. A cutting striking roots in medium is the least drought-tolerant state
    // in the vocabulary — it has no root system to buffer a missed watering — and live prod's one
    // rooting row took 14 waterings in 90 days, 4 of them through this batch path. Dropping it out
    // of bulk watering would be the mirror image of the bug this file is about.
    const { body } = await postBatch({ dry_run: true })
    expect(body.plantings.map((p) => p.id)).toContain(rootingId)
  })

  it('the exclusion is by planting status, not by project — siblings under the same project split', async () => {
    // Scope by plant_id, never project_id: all five fixtures share ONE project, so a project-level
    // exclusion would take the whole set to zero and a project-level pass would take it to five.
    const { body } = await postBatch({ dry_run: true })
    expect(body.count).toBe(2)
    const all = await directSql`
      SELECT count(*)::int AS n FROM plants
       WHERE project_id = ${projectId} AND deleted_at IS NULL`
    expect(all[0].n).toBe(5)
  })
})

describe('reachability is NOT filtered (the other half of the rule)', () => {
  for (const p of EXCLUDED) {
    it(`the Harvests tab still shows a harvest logged on the ${p.label} planting`, async () => {
      setTestUserId(USER)
      const { status, body } = await callHandler(harvestsHandler, {
        method: 'GET', path: '/api/harvests?timeframe=all&include=entries', userId: USER,
      })
      expect(status).toBe(200)
      const mine = body.entries.filter((e) => e.plant_id === p.id)
      expect(mine).toHaveLength(1)
      expect(mine[0].event_id ?? mine[0].id).toBe(p.harvestId)
    })

    it(`the per-planting harvest list (PlantingDetail) still resolves for the ${p.label} planting`, async () => {
      const { status, body } = await callHandler(harvestsHandler, {
        method: 'GET', path: `/api/harvests?timeframe=all&include=entries&plant=${p.id}`, userId: USER,
      })
      expect(status).toBe(200)
      expect(body.entries.map((e) => e.plant_id)).toEqual([p.id])
    })

    it(`its plantings page still loads — GET /api/plants/:id returns it, still marked ${p.label}`, async () => {
      const { status, body } = await callHandler(plantsHandler, {
        method: 'GET', path: `/api/plants/${p.id}`, userId: USER,
      })
      expect(status).toBe(200)
      expect(body.id).toBe(p.id)
      // The status must survive the round trip: this is what the Garden grid's Lifecycle grouping
      // reads to file it under Dormant/Ended/Failed, and what the reactivate affordance flips.
      expect(body.status).toBe(p.status)
    })

    it(`it is still findable in the plantings list, so the ${p.label} lifecycle group is non-empty`, async () => {
      const { status, body } = await callHandler(plantsHandler, {
        method: 'GET', path: '/api/plants', userId: USER,
      })
      expect(status).toBe(200)
      const rows = Array.isArray(body) ? body : (body.plants ?? body.plantings ?? [])
      const row = rows.find((x) => x.id === p.id)
      expect(row).toBeTruthy()
      expect(row.status).toBe(p.status)
    })

    it(`a SINGLE event can still be logged to the ${p.label} planting — "log to it" is explicitly allowed`, async () => {
      // Only the bulk resolver is filtered. The single-event path takes a plant_id from the client
      // and must keep accepting a closed-out one, or the plantings page loses its log button — and
      // for `ended`/`failed` that button is how a final cleanup or post-mortem note gets recorded,
      // which is the workflow the bulk exclusion deliberately does not serve.
      const { status } = await callHandler(eventsHandler, {
        method: 'POST', path: '/api/events', userId: USER,
        body: { plant_id: p.id, project_id: projectId, event_type: 'observation', notes: `still ${p.label}` },
      })
      expect(status).toBeLessThan(300)
      const rows = await directSql`
        SELECT count(*)::int AS n FROM event_log
         WHERE plant_id = ${p.id} AND event_type = 'observation' AND deleted_at IS NULL`
      expect(rows[0].n).toBe(1)
    })
  }
})
