// logmany-zone.int.test.js — V4-ZONEDECIDE-001. The Log Many "By zone" scope resolver, against a
// real database.
//
// WHY THIS FILE EXISTS. Zone filtering on Log Many is not new — the 2-tier client picker
// (ScopeChecklist.jsx, V4-LOGMANYLOC-001) and the recursive server cascade (lambda/events/index.js
// `WHEN 'space'`) both shipped weeks ago. What never shipped is a single test that runs the SELECT.
// `scopeChecklist.test.jsx` proves the chips RENDER and what `onScopeChange` emits; nothing anywhere
// proved that emitting `{type:'space', location_id:<zone>}` returns the right rows. The predicate
// lives inside a CASE inside a WITH RECURSIVE inside a tagged template — source text cannot evaluate
// it, and it reads through the `garden_node`/`container` views (name AS display_name, project_id AS
// container_id), a hop static analysis cannot follow.
//
// HOW LOAD-BEARING THE RECURSION IS, measured on live prod 2026-08-20 (read-only):
//     zone Pasture, WITH RECURSIVE cascade ..... 135 plantings
//     zone Pasture, exact location_id match .....   0 plantings
// Every Pasture planting sits in a DESCENDANT location (Row A-F, Bag Area, In-Ground, ...); not one
// is filed on the zone row itself. Delete the recursion and the feature does not degrade, it returns
// an empty set for the largest zone in the garden. Same shape for Drive (46) and Stable (29). That
// is the over-application failure mode in its purest form: a filter that silently answers "nothing"
// looks like a working filter over an empty garden.
//
// THE TWO-SIDED RULE, same as logmany-dormant.int.test.js:
//   * picking a zone narrows the batch to that zone's subtree;
//   * a planting OUTSIDE the picked zone stays fully reachable — listed by GET /api/plants, its
//     detail page loads, and a single event can still be logged to it. Bulk is the only filtered
//     path.
// And the invariant that outranks both: NO zone selected means NO filtering. `{type:'all'}` must
// return the superset including plantings with no location at all, which belong to no zone and would
// otherwise be unreachable from every zone arm at once.
//
// FIXTURE TREE (two projects, so project-location fallback and planting-location override are both
// exercised; every planting is `vegetative` so the status predicate is never what is being measured):
//
//   ZONE_A                      pA_zone      (plants.location_id = ZONE_A)
//     +- SUB_A1                 pA_sub1      (plants.location_id = SUB_A1)
//     |    +- LEAF_A1a          pA_leaf      (plants.location_id = LEAF_A1a)   <- depth-2 cascade
//     +- SUB_A2                 pA_sub2      (plants.location_id = SUB_A2)
//   ZONE_B                      pB_zone      (plants.location_id = ZONE_B)
//   ZONE_C  (empty)             -
//   ZONE_D                                                                     <- pruned-branch arm
//     +- SUB_D1 (soft-deleted)  pD_orphan    (plants.location_id = SUB_D1)
//
//   projRoot (location_id NULL) holds pA_zone pA_sub1 pA_leaf pA_sub2 pB_zone pNoLoc pD_orphan
//   projInB  (location_id = ZONE_B) holds pB_fallback (location NULL -> inherits ZONE_B)
//                                    and pA_override  (location SUB_A1 -> planting wins over B)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'

const RUN = testRunId()
const USER = `user_int_zone_${RUN}`

let projRoot, projInB
const LOC = {}    // name -> id
const P = {}      // label -> plant id

const mkLoc = async (key, { level, parent = null, deleted = false }) => {
  const slug = `${key}-${RUN}`
  const rows = await directSql`
    INSERT INTO locations (name, slug, level, parent_id, created_by, deleted_at)
    VALUES (${slug}, ${slug}, ${level}, ${parent}, ${USER}, ${deleted ? new Date().toISOString() : null})
    RETURNING id`
  LOC[key] = rows[0].id
  return rows[0].id
}

const mkPlant = async (label, projectId, locationId) => {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, status, location_id, created_by)
    VALUES (${projectId}, ${label + '-' + RUN}, 'vegetative', ${locationId}, ${USER})
    RETURNING id`
  P[label] = rows[0].id
  return rows[0].id
}

beforeAll(async () => {
  setTestUserId(USER)

  await mkLoc('ZONE_A', { level: 0 })
  await mkLoc('SUB_A1', { level: 1, parent: LOC.ZONE_A })
  await mkLoc('LEAF_A1a', { level: 2, parent: LOC.SUB_A1 })
  await mkLoc('SUB_A2', { level: 1, parent: LOC.ZONE_A })
  await mkLoc('ZONE_B', { level: 0 })
  await mkLoc('ZONE_C', { level: 0 })
  await mkLoc('ZONE_D', { level: 0 })
  // Soft-deleted INTERMEDIATE. Locations delete softly (lambda/locations DELETE sets deleted_at) and
  // nothing reparents the children or nulls the plantings' location_id, so this state is reachable
  // from the Locations page today.
  await mkLoc('SUB_D1', { level: 1, parent: LOC.ZONE_D, deleted: true })

  projRoot = (await insertProject({ name: 'int-zone-root-' + RUN, createdBy: USER })).id
  projInB = (await insertProject({ name: 'int-zone-inb-' + RUN, createdBy: USER })).id
  await directSql`UPDATE plant_projects SET location_id = ${LOC.ZONE_B} WHERE id = ${projInB}`

  await mkPlant('pA_zone', projRoot, LOC.ZONE_A)
  await mkPlant('pA_sub1', projRoot, LOC.SUB_A1)
  await mkPlant('pA_leaf', projRoot, LOC.LEAF_A1a)
  await mkPlant('pA_sub2', projRoot, LOC.SUB_A2)
  await mkPlant('pB_zone', projRoot, LOC.ZONE_B)
  await mkPlant('pNoLoc', projRoot, null)
  await mkPlant('pD_orphan', projRoot, LOC.SUB_D1)
  await mkPlant('pB_fallback', projInB, null)
  await mkPlant('pA_override', projInB, LOC.SUB_A1)
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
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
  // locations LAST: plants.location_id and plant_projects.location_id both FK here.
  await directSql`DELETE FROM locations WHERE created_by = ${USER}`
})

let seq = 0
const preview = async (scope) => {
  setTestUserId(USER)
  const { status, body } = await callHandler(eventsHandler, {
    method: 'POST', path: '/api/events/batch', userId: USER,
    body: { idempotency_key: `zone-${RUN}-${++seq}`, event_type: 'fertilizing', dry_run: true, scope },
  })
  return { status, body, ids: (body?.plantings ?? []).map((p) => p.id) }
}
const byZone = (key) => preview({ type: 'space', location_id: LOC[key] })
const label = (id) => Object.keys(P).find((k) => P[k] === id) ?? id

describe('By zone narrows to the zone SUBTREE (V4-LOGMANYLOC-001 cascade)', () => {
  it('a zone returns its own plantings PLUS every descendant, and nothing from another zone', async () => {
    const { status, ids } = await byZone('ZONE_A')
    expect(status).toBe(200)
    expect(ids.map(label).sort()).toEqual(['pA_leaf', 'pA_override', 'pA_sub1', 'pA_sub2', 'pA_zone'])
  })

  it('the cascade is RECURSIVE, not one level — a depth-2 grandchild is included', async () => {
    // The arm the prod measurement is about. `pA_leaf` hangs off LEAF_A1a, whose parent SUB_A1 is
    // itself a child of ZONE_A. Replacing WITH RECURSIVE by a single `parent_id = ${locationId}`
    // join keeps pA_sub1/pA_sub2 and drops this one; dropping the CTE entirely for an exact
    // `= ${locationId}` leaves only pA_zone. Both mutations fail HERE first.
    const { ids } = await byZone('ZONE_A')
    expect(ids).toContain(P.pA_leaf)
    // ...and the exact-match control: the zone row's own planting is a minority of the answer, which
    // is why an exact-match regression reads as "the filter works, the garden is just empty".
    expect(ids.length).toBeGreaterThan(1)
  })

  it('the walk goes DOWN only — selecting a sub-location does not pull in its parent or siblings', async () => {
    // Tier 2 of the picker. A cascade that walked UP (or joined `st.parent_id = l.id`) would return
    // the whole of ZONE_A here and pass every other arm in this file.
    const { ids } = await byZone('SUB_A1')
    expect(ids.map(label).sort()).toEqual(['pA_leaf', 'pA_override', 'pA_sub1'])
    expect(ids).not.toContain(P.pA_zone)
    expect(ids).not.toContain(P.pA_sub2)
  })

  it('a childless leaf resolves to exactly itself — backward-compatible with pre-cascade behavior', async () => {
    const { ids } = await byZone('LEAF_A1a')
    expect(ids.map(label)).toEqual(['pA_leaf'])
  })
})

describe('which location a planting counts as being in (BUG-SPACEFILTER-001)', () => {
  it("the PLANTING's own location wins over its project's", async () => {
    // pA_override lives in projInB (project location = ZONE_B) but is filed at SUB_A1. It must
    // answer to zone A, not zone B — the reassigned-planting case the original bug was filed for.
    const a = await byZone('ZONE_A')
    const b = await byZone('ZONE_B')
    expect(a.ids).toContain(P.pA_override)
    expect(b.ids).not.toContain(P.pA_override)
  })

  it("a planting with no location of its own falls back to its project's", async () => {
    const { ids } = await byZone('ZONE_B')
    expect(ids.map(label).sort()).toEqual(['pB_fallback', 'pB_zone'])
  })
})

describe('NO zone selected means NO filtering — never an empty set, never a lost planting', () => {
  it('scope "all" returns every live planting, including ones that belong to no zone at all', async () => {
    const { status, ids } = await preview({ type: 'all' })
    expect(status).toBe(200)
    // Every fixture, all nine. `pNoLoc` has neither a planting location nor a project location, so
    // it is in ZERO zone subtrees; if the default scope ever acquired a location predicate it would
    // become permanently unbatchable.
    expect(ids.map(label).sort()).toEqual([
      'pA_leaf', 'pA_override', 'pA_sub1', 'pA_sub2', 'pA_zone',
      'pB_fallback', 'pB_zone', 'pD_orphan', 'pNoLoc',
    ])
  })

  it('the un-zoned planting is in "all" and in NO zone arm', async () => {
    const all = await preview({ type: 'all' })
    expect(all.ids).toContain(P.pNoLoc)
    for (const z of ['ZONE_A', 'ZONE_B', 'ZONE_C', 'ZONE_D', 'SUB_A1', 'LEAF_A1a']) {
      const { ids } = await byZone(z)
      expect(ids, `${z} must not claim the un-zoned planting`).not.toContain(P.pNoLoc)
    }
  })

  it('"all" is a strict superset of the union of every zone', async () => {
    const all = new Set((await preview({ type: 'all' })).ids)
    const union = new Set()
    for (const z of ['ZONE_A', 'ZONE_B', 'ZONE_C', 'ZONE_D']) {
      for (const id of (await byZone(z)).ids) union.add(id)
    }
    for (const id of union) expect(all.has(id), `${label(id)} in a zone but not in all`).toBe(true)
    expect(all.size).toBeGreaterThan(union.size)
  })

  it('scope.type=space with NO location_id is REJECTED, not silently treated as unfiltered', async () => {
    // The protocol-level half of the same invariant: "no zone chosen" must never reach the resolver
    // wearing a space scope. A resolver that coalesced a missing location to "match everything"
    // would log the whole garden from a half-filled form.
    setTestUserId(USER)
    const { status, body } = await callHandler(eventsHandler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: { idempotency_key: `zone-${RUN}-nullloc`, event_type: 'fertilizing', dry_run: true, scope: { type: 'space' } },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/location_id/)
  })
})

describe('an empty zone is empty, and empty is not "everything"', () => {
  it('a real zone with no plantings previews 0 rows', async () => {
    const { status, body, ids } = await byZone('ZONE_C')
    expect(status).toBe(200)
    expect(ids).toEqual([])
    expect(body.count).toBe(0)
  })

  it('the WRITE path refuses an empty scope instead of falling back to all', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(eventsHandler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: {
        idempotency_key: `zone-${RUN}-emptywrite`, event_type: 'fertilizing',
        scope: { type: 'space', location_id: LOC.ZONE_C },
      },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/No plantings matched/)
    const n = await directSql`SELECT count(*)::int AS n FROM event_log WHERE created_by = ${USER}`
    expect(n[0].n).toBe(0)
  })

  it('a soft-deleted intermediate location prunes its branch from the zone — but not from "all"', async () => {
    // Documented consequence of `WHERE l.deleted_at IS NULL` inside the recursion, not an accident.
    // Deleting a sub-location on the Locations page leaves its plantings filed there; they drop out
    // of that zone's bulk scope while staying in "all" (and everywhere else). Pinned so a future
    // edit to the CTE has to decide about this case deliberately.
    const d = await byZone('ZONE_D')
    expect(d.ids).not.toContain(P.pD_orphan)
    const all = await preview({ type: 'all' })
    expect(all.ids).toContain(P.pD_orphan)
  })
})

describe('a planting outside the picked zone stays reachable (the other half of the rule)', () => {
  it('the dry-run and the WRITE agree — only the zone subtree is logged', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(eventsHandler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: {
        idempotency_key: `zone-${RUN}-write`, event_type: 'fertilizing',
        scope: { type: 'space', location_id: LOC.ZONE_A },
      },
    })
    expect(status).toBe(200)
    expect(body.count).toBe(5)
    const rows = await directSql`
      SELECT plant_id FROM event_log
       WHERE metadata->>'batch_id' = ${body.batch_id} AND deleted_at IS NULL`
    expect(rows.map((r) => r.plant_id).map(label).sort())
      .toEqual(['pA_leaf', 'pA_override', 'pA_sub1', 'pA_sub2', 'pA_zone'])
  })

  it('GET /api/plants is unfiltered by zone — an out-of-zone planting is still listed', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(plantsHandler, {
      method: 'GET', path: '/api/plants', userId: USER,
    })
    expect(status).toBe(200)
    const rows = Array.isArray(body) ? body : (body.plants ?? body.plantings ?? [])
    const ids = rows.map((r) => r.id)
    for (const k of ['pB_zone', 'pNoLoc', 'pD_orphan']) {
      expect(ids, `${k} must stay listed`).toContain(P[k])
    }
  })

  it('its detail page still loads — GET /api/plants/:id', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(plantsHandler, {
      method: 'GET', path: `/api/plants/${P.pB_zone}`, userId: USER,
    })
    expect(status).toBe(200)
    expect(body.id).toBe(P.pB_zone)
  })

  it('a SINGLE event can still be logged to an out-of-zone planting', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(eventsHandler, {
      method: 'POST', path: '/api/events', userId: USER,
      body: { plant_id: P.pB_zone, project_id: projRoot, event_type: 'observation', notes: 'out of zone' },
    })
    expect(status).toBeLessThan(300)
    const rows = await directSql`
      SELECT count(*)::int AS n FROM event_log
       WHERE plant_id = ${P.pB_zone} AND event_type = 'observation' AND deleted_at IS NULL`
    expect(rows[0].n).toBe(1)
  })
})
