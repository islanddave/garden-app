// seed-saved-rewards.int.test.js — V5-SEEDMULTIPARENT-001 release 2a on a real Postgres: a seed_saved
// event's rewards are keyed on the JAR, not on the event.
//
// WHY THIS FILE EXISTS. Release 2's client writes one seed_saved event per parent planting of a saved
// lot. The flat XP grant was keyed on the event id and a critter was rolled per event, so a jar with
// four parents would have paid four times. lambda/events now reads, for a seed_saved event whose
// metadata.seed_lot_id names a live household lot that the planting is a live seed_parent of, two
// lot-keyed predicates (seedLotRewards.js) and binds the LOT id as the grant's source_id.
//
// Its unit suite mocks SQL (lane-E-report.log, "NOT PROVEN HERE"), and BOTH new statements fail
// SILENTLY by design — rewards are derived, and nothing may fail an event write that has committed:
//   · the read (three EXISTS arms, one of them a join from xp_events.source_id to event_log.id) is
//     inside a try that answers null, i.e. "event-keyed, as before";
//   · the edited grant is inside a try that drops the XP — for EVERY event type.
// So a statement Postgres rejected would look like a working system that pays per event, or one that
// pays nothing. The first case here is therefore an ordinary watering event still earning its 10.
//
// WHAT IS ASSERTED. The flat grant, as xp_events rows read back (user, 'event_logged', source_id) and
// as the response's xp_gained. A FRESH USER PER CASE: the grant is capped per person per day and
// keyed per person per source, so cases must not share a person. xp_gained also carries achievement
// XP, which is uncapped and which a fresh user earns at once; flat() takes that part off, using the
// response's own newly_earned_achievements, so the number compared is the flat grant alone.
// MEASURED 2026-10-06, so nobody writes `xp_gained` toBe(10) here: a fresh user's watering event
// answers xp_gained 45 (flat 10 + first_log 25 + first_water 10), and four parents of one jar posted in
// turn answer [35, 15, 0, 0] (flat [10, 0, 0, 0]; first_log 25 on the first, double_shift 15 on the
// second). Achievements count EVENTS, and a jar saved from four plants is four events: that part of
// the reward is not keyed on the jar, by this release or before it.
//
// THE CRITTER is asserted as a CALL to awardCritterServer (spied, with the real function behind it),
// never as a critter_state row count: the award is a roll, and most rolls write nothing.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import { seedVarietyFixture, seedMixTeardown, twoSessions } from './_seedLotKit.js'

vi.mock('../../lambda/events/critterAward.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, awardCritterServer: vi.fn(real.awardCritterServer) }
})

const { handler: eventsHandler } = await import('../../lambda/events/index.js')
const { handler: invHandler } = await import('../../lambda/inventory-items/index.js')
const { awardCritterServer } = await import('../../lambda/events/critterAward.js')

const RUN = testRunId()
const BASE = `ssr-base-${RUN}`
const users = [BASE]

// The read names the link table; without it every case is the silent fallback, which would PASS the
// control and fail everything else for a reason no assertion names.
const HAS_TABLE = (await directSql`
  SELECT to_regclass('public.seed_lot_parent_planting') IS NOT NULL AS ok`)[0].ok

describe('seed_saved rewards — the link table is on this branch', () => {
  it('seed_lot_parent_planting exists (apply migrations/v5-seedmultiparent-001/0a-additive-ddl.sql before the code that reads it)', () => {
    expect(HAS_TABLE, 'public.seed_lot_parent_planting is missing on the database this suite forks').toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures and readers
// ───────────────────────────────────────────────────────────────────────────────────────────────────
let fx
let seq = 0
let savedHousehold

const fresh = (tag) => {
  const id = `ssr-${tag}-${RUN}`
  users.push(id)
  return id
}

// One person, one container, `parents` plantings of one variety, and a saved lot that names them all.
async function jar(tag, { parents = 4 } = {}) {
  const user = fresh(tag)
  const proj = await insertProject({ name: `ssr-${tag}-${RUN}`, createdBy: user })
  const plants = []
  for (let i = 0; i < parents; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    plants.push(await planting(user, proj.id, `${tag}-${i}`))
  }
  const lot = await newLot(user, plants)
  return { user, proj: proj.id, plants, lot }
}
async function planting(user, projectId, tag) {
  const [p] = await directSql`
    INSERT INTO plants (project_id, name, created_by, variety_id)
    VALUES (${projectId}, ${`ssr-${tag}-${RUN}-${seq++}`}, ${user}, ${fx.v.a1}) RETURNING id`
  return p.id
}
async function newLot(user, plantIds) {
  setTestUserId(user)
  const r = await callHandler(invHandler, {
    method: 'POST', path: '/api/inventory-items',
    body: {
      name: `ssr-lot-${RUN}-${seq++}`, type: 'consumable', category: 'seeds', unit: 'packet',
      quantity_on_hand: 1, variety_id: fx.v.a1, source_plant_ids: plantIds,
    },
  })
  expect(r.status, `POST lot -> ${JSON.stringify(r.body)}`).toBe(201)
  return r.body.id
}

function log(g, plantId, { type = 'seed_saved', metadata, as = g.user } = {}) {
  setTestUserId(as)
  return callHandler(eventsHandler, {
    method: 'POST', path: '/api/events', userId: as,
    body: {
      project_id: g.proj, plant_id: plantId, event_type: type, event_date: new Date().toISOString(),
      ...(metadata === undefined ? {} : { metadata }),
    },
  })
}
const saved = (g, plantId, lotId = g.lot, as = g.user) => log(g, plantId, { metadata: { seed_lot_id: lotId }, as })

// The flat grant alone: xp_gained less whatever achievements this very response says it earned.
const flat = (r) => {
  expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(201)
  const fromAchievements = (r.body.newly_earned_achievements ?? []).reduce((s, a) => s + (a.xp_reward ?? 0), 0)
  return r.body.xp_gained - fromAchievements
}
const grants = (user) => directSql`
  SELECT source_id, amount FROM xp_events
   WHERE user_id = ${user} AND reason = 'event_logged' ORDER BY created_at, id`
const rolledFor = (eventId) => awardCritterServer.mock.calls.filter(([arg]) => arg?.eventId === eventId).length

const { onOwnConnection, closeAll } = twoSessions()

beforeAll(async () => {
  if (!HAS_TABLE) return
  savedHousehold = process.env.GARDEN_HOUSEHOLD_IDS
  delete process.env.GARDEN_HOUSEHOLD_IDS
  fx = await seedVarietyFixture({ run: RUN, user: BASE, tag: 'ssr' })
}, 60000)

afterAll(async () => {
  closeAll()
  if (savedHousehold === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS
  else process.env.GARDEN_HOUSEHOLD_IDS = savedHousehold
  if (!HAS_TABLE) return
  const ids = assertFixtureId(...users)
  await settle(`seed-saved-rewards teardown ${RUN}`, [
    () => directSql`DELETE FROM user_achievements WHERE user_id = ANY(${ids})`,
    () => directSql`DELETE FROM app_events WHERE user_clerk_sub = ANY(${ids})`,
    ...seedMixTeardown(ids, fx?.crops),
    () => directSql`DELETE FROM plant_projects WHERE created_by = ANY(${ids})`,
  ])
}, 60000)

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE)('the grant statement still runs for every event', () => {
  it('CONTROL: an ordinary watering event earns its flat 10, keyed on its own event id, and rolls for a critter', async () => {
    const g = await jar('control', { parents: 1 })
    const r = await log(g, g.plants[0], { type: 'watering' })
    expect(flat(r)).toBe(10)
    expect(r.body.daily_xp_remaining).toBe(290)
    expect(await grants(g.user)).toEqual([{ source_id: r.body.id, amount: 10 }])
    expect(rolledFor(r.body.id)).toBe(1)
  })
})

describe.skipIf(!HAS_TABLE)('one jar, several parents', () => {
  it('four parents posted IN TURN: flat XP [10, 0, 0, 0]; one grant keyed on the LOT and none on any event id; four event rows; one critter roll, for the first', async () => {
    const g = await jar('turn')
    const responses = []
    for (const p of g.plants) {
      // eslint-disable-next-line no-await-in-loop
      responses.push(await saved(g, p))
    }
    expect(responses.map(flat)).toEqual([10, 0, 0, 0])
    expect(responses.map((r) => r.body.daily_xp_remaining)).toEqual([290, 290, 290, 290])
    const eventIds = responses.map((r) => r.body.id)
    const rows = await grants(g.user)
    expect(rows).toEqual([{ source_id: g.lot, amount: 10 }])
    expect(rows.filter((x) => eventIds.includes(x.source_id))).toEqual([])
    expect(await directSql`
      SELECT count(*)::int AS n FROM event_log
       WHERE id = ANY(${eventIds}::uuid[]) AND event_type = 'seed_saved' AND deleted_at IS NULL
         AND metadata->>'seed_lot_id' = ${g.lot}`).toEqual([{ n: 4 }])
    expect(eventIds.map(rolledFor)).toEqual([1, 0, 0, 0])
  })

  it('the same four AT ONCE: at most one grant — the flat XP sums to 10 and one row is keyed on the lot — and at most one critter roll', async () => {
    const g = await jar('once')
    setTestUserId(g.user)
    const responses = await Promise.all(g.plants.map((p) => onOwnConnection(() => saved(g, p))))
    expect(responses.map(flat).sort((a, b) => a - b)).toEqual([0, 0, 0, 10])
    expect(await grants(g.user)).toEqual([{ source_id: g.lot, amount: 10 }])
    // Each POST inserts its event before it asks whether another exists, so four at once can each see
    // one of the others and roll nothing at all. The guarantee is "at most one"; release 2 posts in turn.
    const rolls = responses.reduce((s, r) => s + rolledFor(r.body.id), 0)
    expect(rolls).toBeLessThanOrEqual(1)
    expect((await directSql`
      SELECT count(*)::int AS n FROM critter_state
       WHERE source_event_id = ANY(${responses.map((r) => r.body.id)}::uuid[])`)[0].n).toBeLessThanOrEqual(1)
  })

  it('the lot id in CAPITALS is the same jar, whichever event carries it: first event in capitals, second in lower case, third in capitals — 10, 0, 0, one grant, one roll', async () => {
    // The capitals go on the FIRST event on purpose. Both "has another event of this jar been logged"
    // and "was this jar already paid" read OTHER rows' metadata as text; a comparison that lower-cased
    // only the incoming id would still match a lower-case earlier row and miss an upper-case one.
    const g = await jar('caps', { parents: 3 })
    const first = await saved(g, g.plants[0], g.lot.toUpperCase())
    expect(flat(first)).toBe(10)
    const second = await saved(g, g.plants[1])
    expect(flat(second)).toBe(0)
    const third = await saved(g, g.plants[2], g.lot.toUpperCase())
    expect(flat(third)).toBe(0)
    expect(await grants(g.user)).toEqual([{ source_id: g.lot, amount: 10 }])
    expect([first, second, third].map((r) => rolledFor(r.body.id))).toEqual([1, 0, 0])
    expect((await directSql`SELECT metadata->>'seed_lot_id' AS id FROM event_log WHERE id = ${first.body.id}`)[0].id)
      .toBe(g.lot.toUpperCase())
  })

  it('other rows of event_log whose metadata is not an object (a jsonb string, an array, null) do not break the read: the jar is still lot-keyed', async () => {
    const g = await jar('shapes', { parents: 2 })
    await directSql`
      INSERT INTO event_log (event_type, created_by, plant_id, metadata)
      VALUES ('seed_saved', ${g.user}, ${g.plants[0]}, '"just text"'::jsonb),
             ('seed_saved', ${g.user}, ${g.plants[0]}, '[1, 2]'::jsonb),
             ('seed_saved', ${g.user}, ${g.plants[0]}, NULL)`
    const r = await saved(g, g.plants[0])
    expect(flat(r)).toBe(10)
    expect(await grants(g.user)).toEqual([{ source_id: g.lot, amount: 10 }])
  })

  it('a second HOUSEHOLD MEMBER saving from the same jar earns their own 10 once, then 0: two grants keyed on the lot, one per person; no roll for the member', async () => {
    const g = await jar('member')
    const mate = fresh('member-mate')
    process.env.GARDEN_HOUSEHOLD_IDS = `${g.user},${mate}`
    try {
      expect(flat(await saved(g, g.plants[0]))).toBe(10)
      const first = await saved(g, g.plants[1], g.lot, mate)
      expect(flat(first)).toBe(10)
      const again = await saved(g, g.plants[2], g.lot, mate)
      expect(flat(again)).toBe(0)
      expect(flat(await saved(g, g.plants[3]))).toBe(0)
      expect(await grants(g.user)).toEqual([{ source_id: g.lot, amount: 10 }])
      expect(await grants(mate)).toEqual([{ source_id: g.lot, amount: 10 }])
      expect(rolledFor(first.body.id)).toBe(0)
      expect(rolledFor(again.body.id)).toBe(0)
    } finally {
      delete process.env.GARDEN_HOUSEHOLD_IDS
    }
  })
})

describe.skipIf(!HAS_TABLE)('a jar that was paid before this release — on its EVENT id', () => {
  // The pre-release state, made exactly: an event that carries the lot id, and a grant whose
  // source_id is that EVENT. Posted through the route, then the grant's key is put back to the event.
  async function paidTheOldWay(g, plantId, as = g.user, lotId = g.lot) {
    const r = await saved(g, plantId, lotId, as)
    expect(flat(r)).toBe(10)
    const moved = await directSql`
      UPDATE xp_events SET source_id = ${r.body.id}
       WHERE user_id = ${as} AND reason = 'event_logged' AND source_id = ${g.lot} RETURNING id`
    expect(moved).toHaveLength(1)
    return r.body.id
  }

  it('a second parent pays nothing, and no grant keyed on the lot appears', async () => {
    const g = await jar('old', { parents: 3 })
    const oldEvent = await paidTheOldWay(g, g.plants[0])
    const r = await saved(g, g.plants[1])
    expect(flat(r)).toBe(0)
    expect(await grants(g.user)).toEqual([{ source_id: oldEvent, amount: 10 }])
    expect(rolledFor(r.body.id)).toBe(0)
  })

  it('...whatever case the old event spelled the lot id in', async () => {
    const g = await jar('old-caps', { parents: 2 })
    const oldEvent = await paidTheOldWay(g, g.plants[0], g.user, g.lot.toUpperCase())
    expect(flat(await saved(g, g.plants[1]))).toBe(0)
    expect(await grants(g.user)).toEqual([{ source_id: oldEvent, amount: 10 }])
  })

  it('...even after that first event is soft-deleted: the grant it earned is still the jar\'s', async () => {
    const g = await jar('old-deleted', { parents: 3 })
    const oldEvent = await paidTheOldWay(g, g.plants[0])
    await directSql`UPDATE event_log SET deleted_at = now() WHERE id = ${oldEvent}`
    const r = await saved(g, g.plants[1])
    expect(flat(r)).toBe(0)
    expect(await grants(g.user)).toEqual([{ source_id: oldEvent, amount: 10 }])
    expect(rolledFor(r.body.id)).toBe(0)
  })

  it('...and when the old grant belongs to the OTHER household member, this person earns their 10 once (the skip is per person)', async () => {
    const g = await jar('old-mate', { parents: 3 })
    const mate = fresh('old-mate-mate')
    process.env.GARDEN_HOUSEHOLD_IDS = `${g.user},${mate}`
    try {
      const oldEvent = await paidTheOldWay(g, g.plants[0], mate)
      const mine = await saved(g, g.plants[1])
      expect(flat(mine)).toBe(10)
      expect(flat(await saved(g, g.plants[2]))).toBe(0)
      expect(await grants(g.user)).toEqual([{ source_id: g.lot, amount: 10 }])
      expect(await grants(mate)).toEqual([{ source_id: oldEvent, amount: 10 }])
    } finally {
      delete process.env.GARDEN_HOUSEHOLD_IDS
    }
  })
})

describe.skipIf(!HAS_TABLE)('remove, then save again', () => {
  it('deleting the event leaves the grant; saving the same planting again pays 0 and does not roll', async () => {
    const g = await jar('readd', { parents: 2 })
    const first = await saved(g, g.plants[0])
    expect(flat(first)).toBe(10)
    expect(rolledFor(first.body.id)).toBe(1)
    setTestUserId(g.user)
    const del = await callHandler(eventsHandler, { method: 'DELETE', path: `/api/events/${first.body.id}`, userId: g.user })
    expect([200, 204], JSON.stringify(del.body)).toContain(del.status)
    expect((await directSql`SELECT deleted_at FROM event_log WHERE id = ${first.body.id}`)[0].deleted_at).not.toBeNull()
    expect(await grants(g.user)).toEqual([{ source_id: g.lot, amount: 10 }])

    const again = await saved(g, g.plants[0])
    expect(flat(again)).toBe(0)
    expect(await grants(g.user)).toEqual([{ source_id: g.lot, amount: 10 }])
    // A soft-deleted event still counts as "this jar has had its roll".
    expect(rolledFor(again.body.id)).toBe(0)
  })
})

describe.skipIf(!HAS_TABLE)('at the daily cap', () => {
  it('a capped person earns 0 and NO row is written — so the jar is still unpaid, and its next parent earns the 10 once the cap has room', async () => {
    const g = await jar('cap', { parents: 3 })
    const [seeded] = await directSql`
      INSERT INTO xp_events (user_id, amount, reason, source_id)
      VALUES (${g.user}, 300, 'event_logged', ${randomUUID()}::uuid) RETURNING id`
    const capped = await saved(g, g.plants[0])
    expect(flat(capped)).toBe(0)
    expect(capped.body.daily_xp_remaining).toBe(0)
    expect((await grants(g.user)).filter((x) => x.source_id === g.lot)).toEqual([])
    // Tomorrow, in effect: the seeded allowance is gone. The cap wrote no row, so nothing says the jar
    // was paid, and it pays on the next parent. Accepted: a jar is paid at most once, not exactly once.
    await directSql`DELETE FROM xp_events WHERE id = ${seeded.id}`
    expect(flat(await saved(g, g.plants[1]))).toBe(10)
    expect(flat(await saved(g, g.plants[2]))).toBe(0)
    expect(await grants(g.user)).toEqual([{ source_id: g.lot, amount: 10 }])
  })
})

describe.skipIf(!HAS_TABLE)('every other case is exactly the event-keyed behaviour', () => {
  it('no seed_lot_id, one that is not a uuid, another household\'s lot, a soft-deleted lot, a planting that is not a parent, a planting whose link was retired: each is a 201 that earns 10 on its OWN event id and rolls', async () => {
    const g = await jar('refusals', { parents: 3 })
    const stranger = await jar('refusals-stranger', { parents: 1 })
    const deleted = await newLot(g.user, [g.plants[0]])
    await directSql`UPDATE inventory_items SET deleted_at = now() WHERE id = ${deleted}`
    const outsider = await planting(g.user, g.proj, 'refusals-outsider')
    // Retire g.plants[2]'s link through the route that does it.
    setTestUserId(g.user)
    const retire = await callHandler(invHandler, {
      method: 'PUT', path: `/api/inventory-items/${g.lot}/source-plants`, body: { source_plant_ids: [g.plants[0], g.plants[1]] },
    })
    expect(retire.status, JSON.stringify(retire.body)).toBe(200)

    const cases = [
      ['no metadata at all', g.plants[0], undefined],
      ['metadata without the key', g.plants[0], { note: 'x' }],
      ['an id that is not a uuid', g.plants[0], { seed_lot_id: 'not-a-uuid' }],
      ['a number', g.plants[0], { seed_lot_id: 7 }],
      ['another household\'s lot', g.plants[0], { seed_lot_id: stranger.lot }],
      ['a lot no row has', g.plants[0], { seed_lot_id: randomUUID() }],
      ['a soft-deleted lot', g.plants[0], { seed_lot_id: deleted }],
      ['a planting that was never a parent', outsider, { seed_lot_id: g.lot }],
      ['a planting whose link was retired', g.plants[2], { seed_lot_id: g.lot }],
    ]
    const eventIds = []
    for (const [what, plantId, metadata] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const r = await log(g, plantId, { metadata })
      expect(flat(r), what).toBe(10)
      expect(rolledFor(r.body.id), what).toBe(1)
      eventIds.push(r.body.id)
    }
    const rows = await grants(g.user)
    expect(rows.map((x) => x.source_id).sort()).toEqual([...eventIds].sort())
    expect(rows.every((x) => x.amount === 10)).toBe(true)
    // ORDER DEPENDENCE, as built and accepted (lane E, premise note 4). Two of those events carried
    // this jar's id and were paid on their own event ids, so the per-person skip now reads the jar as
    // already paid: a real parent's save afterwards earns 0 and adds no row.
    expect(flat(await saved(g, g.plants[1]))).toBe(0)
    expect((await grants(g.user)).map((x) => x.source_id)).not.toContain(g.lot)
  })
})
