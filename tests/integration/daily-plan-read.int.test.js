// new-file: no integration test existed for daily-plan-read
// Pins today's /api/daily-plan and /api/daily-plan/cue-impressions replies on real Postgres (OPS-CODEREVIEW-001 C6).
// The plan read maps every database error to a generic 500; the cue beacon answers 202 whatever happens (23505
// is absorbed by ON CONFLICT, other errors by its catch). 23514/23503 are unreachable: the beacon's
// vocabularies mirror its CHECKs and nothing takes a request-supplied FK.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { directSql, callHandler, makeEvent, setTestUserId, testRunId, insertProject, householdDefault } from './_harness.js'
// After _harness.js, whose vi.mock replaces this module with the stub; imported first it would be the real one.
import { verifyToken } from '@clerk/backend'
import { handler } from '../../lambda/daily-plan-read/index.js'

const ORIGINS = ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net']
// Clerk refuses a token whose azp is not in authorizedParties; this models that check on the list the handler passes.
const signedFrom = (azp, sub) => (_token, opts) => (opts.authorizedParties.includes(azp)
  ? (householdDefault(sub), Promise.resolve({ sub, azp }))
  : Promise.reject(new Error(`Invalid JWT Authorized party claim (azp) "${azp}"`)))
const raw = async (event) => {
  const r = await handler(event)
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, raw: r }
}
const get = (path = '/api/daily-plan') => callHandler(handler, { method: 'GET', path })
const cue = (body) => callHandler(handler, { method: 'POST', path: '/api/daily-plan/cue-impressions', body })
const cueRows = (u) => directSql`SELECT * FROM weather_cue_impression WHERE user_id = ${u}`
const insertPlan = (u, items, deleted = false) => directSql`
  INSERT INTO daily_plan (user_id, plan_date, items, generated_at, deleted_at)
  VALUES (${u}, (now() AT TIME ZONE 'America/New_York')::date, ${JSON.stringify(items)}::jsonb,
          now() - interval '5 minutes', ${deleted ? new Date().toISOString() : null}::timestamptz)
  RETURNING generated_at`

const RUN = testRunId()
const NOPLAN = `c6_dpr_noplan_${RUN}`
const PLANNER = `c6_dpr_planner_${RUN}`
const STALE = `c6_dpr_stale_${RUN}`
const DELETED = `c6_dpr_deleted_${RUN}`
const MATE = `c6_dpr_mate_${RUN}`
const CUER = `c6_dpr_cuer_${RUN}`
const ALL = [NOPLAN, PLANNER, STALE, DELETED, MATE, CUER]
let today
let wateredId
let dryId
let plannerPlan
const savedHousehold = process.env.GARDEN_HOUSEHOLD_IDS

beforeAll(async () => {
  delete process.env.GARDEN_HOUSEHOLD_IDS
  today = (await directSql`SELECT to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS d`)[0].d
  const project = await insertProject({ name: `c6-dpr-${RUN}`, createdBy: PLANNER })
  const plants = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${project.id}, ${'c6-dpr-watered-' + RUN}, ${PLANNER}), (${project.id}, ${'c6-dpr-dry-' + RUN}, ${PLANNER})
    RETURNING id, name`
  wateredId = plants.find((p) => p.name.includes('watered')).id
  dryId = plants.find((p) => p.name.includes('dry')).id
  await directSql`
    INSERT INTO event_log (plant_id, project_id, event_type, event_date, logged_by, created_by)
    VALUES (${wateredId}, ${project.id}, 'watering', now(), ${PLANNER}, ${PLANNER})`
  plannerPlan = { schema_version: 1, water_due: [{ id: wateredId, name: 'watered' }, { id: dryId, name: 'dry' }] }
  await insertPlan(PLANNER, plannerPlan)
  await insertPlan(STALE, { schema_version: 2, water_due: [] })
  await insertPlan(DELETED, { schema_version: 1, water_due: [] }, true)
  await insertPlan(MATE, { schema_version: 1, fertilize: [] })
})

afterAll(async () => {
  if (savedHousehold === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS
  else process.env.GARDEN_HOUSEHOLD_IDS = savedHousehold
  await directSql`DELETE FROM daily_plan WHERE user_id = ANY(${ALL})`
  await directSql`DELETE FROM weather_cue_impression WHERE user_id = ANY(${ALL})`
})

describe('daily-plan-read — plan read', () => {
  it('OPTIONS answers 204 with an empty body before sign-in', async () => {
    const r = await raw({ ...makeEvent({ method: 'OPTIONS', path: '/api/daily-plan' }), headers: {} })
    expect(r.raw).toEqual({ statusCode: 204, headers: {}, body: '' })
  })

  it('no plan today: the empty envelope with today\'s ET date', async () => {
    setTestUserId(NOPLAN)
    const { status, body, raw: res } = await get()
    expect(status).toBe(200)
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(body).toEqual({
      schema_version: 1, plan_date: today, generated_at: null, has_plan: false, schema_stale: false, plan: null, cold_range: null,
    })
  })

  it('a stored plan is served with each item checked off from today\'s events', async () => {
    setTestUserId(PLANNER)
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.has_plan).toBe(true)
    expect(body.schema_stale).toBe(false)
    expect(body.generated_at).toBeTruthy()
    expect(body.plan.water_due).toEqual([
      { id: wateredId, name: 'watered', done: true },
      { id: dryId, name: 'dry', done: false },
    ])
    expect(body).not.toHaveProperty('household_plans')
  })

  it('a plan stored at another schema_version is refused and flagged', async () => {
    setTestUserId(STALE)
    const { body } = await get()
    expect(body).toMatchObject({ has_plan: false, schema_stale: true, plan: null })
    expect(body.generated_at).toBeTruthy()
  })

  it('a soft-deleted plan is not served', async () => {
    setTestUserId(DELETED)
    const { body } = await get()
    expect(body).toMatchObject({ has_plan: false, schema_stale: false, plan: null, generated_at: null })
  })

  it('?include=household adds the other members\' plans only when opted in', async () => {
    process.env.GARDEN_HOUSEHOLD_IDS = `${PLANNER},${MATE}`
    try {
      setTestUserId(PLANNER)
      const { body } = await get('/api/daily-plan?include=household')
      expect(body.household_plans).toHaveLength(1)
      expect(body.household_plans[0]).toMatchObject({ user_id: MATE, plan: { schema_version: 1, fertilize: [] } })
      expect(body.household_plans[0].generated_at).toBeTruthy()
    } finally {
      delete process.env.GARDEN_HOUSEHOLD_IDS
    }
  })

  it('a non-GET or another path is 405; a malformed body on GET is ignored', async () => {
    setTestUserId(NOPLAN)
    const post = await raw({ ...makeEvent({ method: 'POST', path: '/api/daily-plan' }), body: '{not json' })
    expect(post.status).toBe(405)
    expect(post.body).toEqual({ error: 'Method not allowed' })
    const other = await get('/api/daily-plan/other')
    expect(other.status).toBe(405)
    const withBody = await raw({ ...makeEvent({ method: 'GET', path: '/api/daily-plan' }), body: '{not json' })
    expect(withBody.status).toBe(200)
  })
})

describe('daily-plan-read — cue-impression beacon', () => {
  it('a valid cue is written once per user, cue and ET day; the repeat still answers accepted 1', async () => {
    setTestUserId(CUER)
    const first = await cue({ cue: 'rain', form: 'check' })
    expect(first.status).toBe(202)
    expect(first.body).toEqual({ accepted: 1 })
    const again = await cue({ cue: 'rain', form: 'imperative' })
    expect(again.body).toEqual({ accepted: 1 })
    const rows = await cueRows(CUER)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ cue: 'rain', form: 'check', model_version: 'wxcue-v3', plan_generated_at: null })
    const [d] = await directSql`SELECT to_char(shown_on, 'YYYY-MM-DD') AS d FROM weather_cue_impression WHERE id = ${rows[0].id}`
    expect(d.d).toBe(today)
  })

  it('an unknown cue, a malformed body and no body all answer 202 accepted 0 and write nothing', async () => {
    setTestUserId(NOPLAN)
    expect((await cue({ cue: 'hail', form: 'check' })).body).toEqual({ accepted: 0 })
    const mal = await raw({ ...makeEvent({ method: 'POST', path: '/api/daily-plan/cue-impressions' }), body: '{not json' })
    expect(mal.status).toBe(202)
    expect(mal.body).toEqual({ accepted: 0 })
    const none = await raw(makeEvent({ method: 'POST', path: '/api/daily-plan/cue-impressions' }))
    expect(none.body).toEqual({ accepted: 0 })
    expect(await cueRows(NOPLAN)).toEqual([])
  })

  it('a non-POST on the beacon path is 405', async () => {
    setTestUserId(NOPLAN)
    const r = await get('/api/daily-plan/cue-impressions')
    expect(r.status).toBe(405)
    expect(r.body).toEqual({ error: 'Method not allowed' })
  })
})

describe('daily-plan-read — sign-in and origin', () => {
  it('a token Clerk rejects is 401', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.reject(new Error('JWT is expired')))
    const r = await raw(makeEvent({ method: 'GET', path: '/api/daily-plan' }))
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Unauthorized' })
  })

  it('a verified token with no subject is 401 (empty-subject guard), beacon included', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.resolve({}))
    const r = await raw(makeEvent({ method: 'POST', path: '/api/daily-plan/cue-impressions', body: { cue: 'rain', form: 'check' } }))
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Unauthorized' })
  })

  it('the handler hands Clerk exactly the two production origins', async () => {
    setTestUserId(NOPLAN)
    await get()
    expect(vi.mocked(verifyToken).mock.calls.at(-1)[1].authorizedParties).toEqual(ORIGINS)
  })

  it('a token minted for another origin is 401; the CloudFront origin is accepted', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom('https://evil.example', NOPLAN))
    expect((await raw(makeEvent({ method: 'GET', path: '/api/daily-plan' }))).status).toBe(401)
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom(ORIGINS[1], NOPLAN))
    expect((await raw(makeEvent({ method: 'GET', path: '/api/daily-plan' }))).status).toBe(200)
  })
})

describe('daily-plan-read — database errors', () => {
  it('SEC-13a: a NUL in the subject can never be a household member: 403 before the plan read (it was 22021, a 500)', async () => {
    setTestUserId(`c6_dpr_nul_${RUN}\u0000`)
    const r = await get()
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ error: 'Forbidden' })
  })

  it('22021 (NUL in model_version) on the beacon is swallowed: 202 accepted 0, nothing written', async () => {
    setTestUserId(CUER)
    const r = await cue({ cue: 'heat', form: 'check', model_version: 'v\u0000x' })
    expect(r.status).toBe(202)
    expect(r.body).toEqual({ accepted: 0 })
    expect((await cueRows(CUER)).map((x) => x.cue)).toEqual(['rain'])
  })
})
