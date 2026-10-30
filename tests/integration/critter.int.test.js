// new-file: no integration test existed for critter
// Pins today's /api/critters + /api/notifications + /api/app-config replies on real Postgres (OPS-CODEREVIEW-001 C6).
// Every database error is a generic 500; 23514 is unreachable (validators.js mirrors each CHECK), 23505 is
// absorbed by ON CONFLICT, and no request-supplied FK exists. Trap: species-prefs and prefs PATCH 500 on
// malformed JSON while viewed and app-config answer 400.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { directSql, callHandler, makeEvent, setTestUserId, testRunId } from './_harness.js'
// After _harness.js, whose vi.mock replaces this module with the stub; imported first it would be the real one.
import { verifyToken } from '@clerk/backend'
import { handler, __resetTodaySectionsAbsence } from '../../lambda/critter/index.js'

const ORIGINS = ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net']
// Clerk refuses a token whose azp is not in authorizedParties; this models that check on the list the handler passes.
const signedFrom = (azp, sub) => (_token, opts) => (opts.authorizedParties.includes(azp)
  ? Promise.resolve({ sub, azp })
  : Promise.reject(new Error(`Invalid JWT Authorized party claim (azp) "${azp}"`)))
const raw = async (event) => {
  const r = await handler(event)
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, raw: r }
}
const call = (method, path, body) => callHandler(handler, { method, path, body })
const rawBody = (method, path, body) => raw({ ...makeEvent({ method, path }), body })

const RUN = testRunId()
const USER = `c6_critter_${RUN}`
const OTHER = `c6_critter_other_${RUN}`
const PREFS_DEFAULTS = {
  critter_visit: 'in_app_only', quiet_hours_start: '21:00:00', quiet_hours_end: '07:00:00',
  coachmark_seen_at: null, opt_in_prompt_seen_at: null, last_garden_view_at: null,
  garden_group_by: null, garden_sort_order: null, garden_expanded: null, garden_bloom_seen: null,
  garden_helper_rung1_seen: null, today_skipped: null, log_many_all_selected: null, whats_new_last_seen: null,
  more_pins: null, bar_layout: null, created_at: null, updated_at: null,
}
let critterId
const savedAdmins = process.env.ADMIN_CLERK_SUBS

beforeAll(async () => {
  delete process.env.ADMIN_CLERK_SUBS
  __resetTodaySectionsAbsence()
  const [row] = await directSql`
    INSERT INTO critter_state (created_by, species_id, target_kind, target_id, source_event_id, earned_at)
    VALUES (${USER}, 3, 'plant', ${randomUUID()}, ${randomUUID()}, now() - interval '1 hour')
    RETURNING id`
  critterId = row.id
})

afterAll(async () => {
  if (savedAdmins === undefined) delete process.env.ADMIN_CLERK_SUBS
  else process.env.ADMIN_CLERK_SUBS = savedAdmins
  await directSql`DELETE FROM critter_state WHERE created_by IN (${USER}, ${OTHER})`
  await directSql`DELETE FROM critter_species_prefs WHERE created_by IN (${USER}, ${OTHER})`
  await directSql`DELETE FROM user_notification_prefs WHERE created_by IN (${USER}, ${OTHER})`
})

describe('critter — critter routes', () => {
  it('OPTIONS answers 204 with an empty body before sign-in', async () => {
    const r = await raw({ ...makeEvent({ method: 'OPTIONS', path: '/api/critters/active' }), headers: {} })
    expect(r.raw).toEqual({ statusCode: 204, headers: {}, body: '' })
  })

  it('GET active lists the caller\'s unviewed critter with both species counts', async () => {
    setTestUserId(USER)
    const { status, body, raw: res } = await call('GET', '/api/critters/active')
    expect(status).toBe(200)
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(body.critters).toHaveLength(1)
    expect(body.critters[0]).toMatchObject({
      id: critterId, species_id: 3, target_kind: 'plant', viewed_at: null, faded_at: null,
      meta: {}, species_user_count: 1, species_household_count: 1,
    })
  })

  it('GET collection is the per-user stickerbook', async () => {
    setTestUserId(USER)
    const { status, body } = await call('GET', '/api/critters/collection')
    expect(status).toBe(200)
    expect(body.species).toHaveLength(1)
    expect(body.species[0]).toMatchObject({ species_id: 3, count: 1 })
    expect(Object.keys(body.species[0]).sort()).toEqual(['count', 'first_seen_at', 'last_seen_at', 'species_id'])
  })

  it('GET by id: own row 200, another household 404, a non-UUID 400', async () => {
    setTestUserId(USER)
    const own = await call('GET', `/api/critters/${critterId}`)
    expect(own.status).toBe(200)
    expect(own.body.critter.id).toBe(critterId)
    setTestUserId(OTHER)
    const foreign = await call('GET', `/api/critters/${critterId}`)
    expect(foreign.status).toBe(404)
    expect(foreign.body).toEqual({ error: 'not found' })
    const bad = await call('GET', '/api/critters/not-a-uuid')
    expect(bad.status).toBe(400)
    expect(bad.body).toEqual({ error: 'id must be a UUID' })
  })

  it('PATCH viewed: a foreign caller marks nothing; the owner marks the listed id', async () => {
    setTestUserId(OTHER)
    const foreign = await call('PATCH', '/api/critters/viewed', { actually_seen_critter_ids: [critterId] })
    expect(foreign.body).toEqual({ marked_viewed_ids: [] })
    setTestUserId(USER)
    const own = await call('PATCH', '/api/critters/viewed', { actually_seen_critter_ids: [critterId] })
    expect(own.status).toBe(200)
    expect(own.body).toEqual({ marked_viewed_ids: [critterId] })
    const [row] = await directSql`SELECT viewed_at FROM critter_state WHERE id = ${critterId}`
    expect(row.viewed_at).not.toBeNull()
  })

  it('PATCH viewed with no body is the bulk path (nothing left to mark)', async () => {
    setTestUserId(USER)
    const r = await raw(makeEvent({ method: 'PATCH', path: '/api/critters/viewed' }))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ marked_viewed_ids: [] })
  })

  it('PATCH viewed: malformed JSON 400, a non-array id list 400', async () => {
    setTestUserId(USER)
    const bad = await rawBody('PATCH', '/api/critters/viewed', '{not json')
    expect(bad.status).toBe(400)
    expect(bad.body).toEqual({ error: 'malformed JSON body' })
    const notArray = await call('PATCH', '/api/critters/viewed', { actually_seen_critter_ids: 'x' })
    expect(notArray.status).toBe(400)
    expect(notArray.body).toEqual({ error: 'actually_seen_critter_ids must be an array' })
  })

  it('the retired POST /api/critters falls through to 404', async () => {
    setTestUserId(USER)
    const r = await call('POST', '/api/critters', { species_id: 1 })
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'route not found: POST /api/critters' })
  })

  it('PATCH species-prefs upserts one row per species', async () => {
    setTestUserId(USER)
    const first = await call('PATCH', '/api/critters/species-prefs', { species_id: 4, weight: 2 })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ created_by: USER, species_id: 4, weight: 2 })
    const second = await call('PATCH', '/api/critters/species-prefs', { species_id: 4, weight: 0.5 })
    expect(second.body.weight).toBe(0.5)
    const rows = await directSql`SELECT weight FROM critter_species_prefs WHERE created_by = ${USER}`
    expect(rows).toEqual([{ weight: 0.5 }])
  })

  it('PATCH species-prefs: out-of-range weight 400; TODAY malformed JSON is a 500', async () => {
    setTestUserId(USER)
    const range = await call('PATCH', '/api/critters/species-prefs', { species_id: 4, weight: 20 })
    expect(range.status).toBe(400)
    expect(range.body).toEqual({ error: 'weight must be between 0.1 and 10' })
    const bad = await rawBody('PATCH', '/api/critters/species-prefs', '{not json')
    expect(bad.status).toBe(500)
    expect(bad.body).toEqual({ error: 'Internal Server Error' })
  })
})

describe('critter — notification prefs', () => {
  it('GET prefs for a user with no row: stateless defaults, can_edit_bar false, today_sections null', async () => {
    setTestUserId(OTHER)
    const { status, body } = await call('GET', '/api/notifications/prefs')
    expect(status).toBe(200)
    expect(body).toEqual({ ...PREFS_DEFAULTS, can_edit_bar: false, today_sections: null })
    expect(await directSql`SELECT 1 FROM user_notification_prefs WHERE created_by = ${OTHER}`).toEqual([])
  })

  it('PATCH prefs writes the caller\'s row and returns it', async () => {
    setTestUserId(USER)
    const { status, body } = await call('PATCH', '/api/notifications/prefs', {
      critter_visit: 'off', quiet_hours_start: '22:30', whats_new_last_seen: '4.10.0',
    })
    expect(status).toBe(200)
    expect(body).toMatchObject({ critter_visit: 'off', quiet_hours_start: '22:30:00', quiet_hours_end: '07:00:00', whats_new_last_seen: '4.10.0' })
    const [row] = await directSql`SELECT critter_visit FROM user_notification_prefs WHERE created_by = ${USER}`
    expect(row.critter_visit).toBe('off')
  })

  it('whats_new_last_seen only moves forward (4.9.0 does not replace 4.10.0)', async () => {
    setTestUserId(USER)
    const { body } = await call('PATCH', '/api/notifications/prefs', { whats_new_last_seen: '4.9.0' })
    expect(body.whats_new_last_seen).toBe('4.10.0')
  })

  it('PATCH prefs: an invalid value 400; TODAY malformed JSON is a 500', async () => {
    setTestUserId(USER)
    const bad = await call('PATCH', '/api/notifications/prefs', { critter_visit: 'loud' })
    expect(bad.status).toBe(400)
    expect(bad.body).toEqual({ error: 'critter_visit must be off|in_app_only|system' })
    const mal = await rawBody('PATCH', '/api/notifications/prefs', '{not json')
    expect(mal.status).toBe(500)
    expect(mal.body).toEqual({ error: 'Internal Server Error' })
  })

  it('POST garden-view-opened stamps last_garden_view_at', async () => {
    setTestUserId(USER)
    const { status, body } = await call('POST', '/api/notifications/garden-view-opened')
    expect(status).toBe(200)
    expect(Object.keys(body)).toEqual(['last_garden_view_at'])
    const [row] = await directSql`SELECT last_garden_view_at FROM user_notification_prefs WHERE created_by = ${USER}`
    expect(row.last_garden_view_at).not.toBeNull()
  })

  it('POST coachmark-dismissed is a one-shot (the second call keeps the first stamp)', async () => {
    setTestUserId(USER)
    const a = await call('POST', '/api/notifications/coachmark-dismissed')
    const b = await call('POST', '/api/notifications/coachmark-dismissed')
    expect(a.status).toBe(200)
    expect(b.body).toEqual(a.body)
    expect(Object.keys(a.body)).toEqual(['coachmark_seen_at'])
  })

  it('POST opt-in-dismissed returns its stamp', async () => {
    setTestUserId(USER)
    const r = await call('POST', '/api/notifications/opt-in-dismissed')
    expect(r.status).toBe(200)
    expect(r.body.opt_in_prompt_seen_at).toBeTruthy()
  })

  it('GET prefs returns the stored row', async () => {
    setTestUserId(USER)
    const { body } = await call('GET', '/api/notifications/prefs')
    expect(body).toMatchObject({ critter_visit: 'off', whats_new_last_seen: '4.10.0', can_edit_bar: false })
    expect(body.coachmark_seen_at).toBeTruthy()
  })
})

describe('critter — dormant app-config', () => {
  it('GET reports every allowlisted key', async () => {
    setTestUserId(USER)
    const { status, body } = await call('GET', '/api/app-config')
    expect(status).toBe(200)
    expect(Object.keys(body)).toEqual(['nav_tabs'])
  })

  it('PATCH with no admin allowlist is 403 before the body is read', async () => {
    setTestUserId(USER)
    const r = await rawBody('PATCH', '/api/app-config', '{not json')
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ error: 'Admin route not configured' })
  })
})

describe('critter — sign-in and origin', () => {
  it('a token Clerk rejects is 401', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.reject(new Error('JWT is expired')))
    const r = await raw(makeEvent({ method: 'GET', path: '/api/critters/active' }))
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Unauthorized' })
  })

  it('a verified token with no subject is 401 (empty-subject guard)', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.resolve({ sub: '' }))
    const r = await raw(makeEvent({ method: 'POST', path: '/api/notifications/garden-view-opened' }))
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Unauthorized' })
  })

  it('the handler hands Clerk exactly the two production origins', async () => {
    setTestUserId(USER)
    await call('GET', '/api/critters/collection')
    expect(vi.mocked(verifyToken).mock.calls.at(-1)[1].authorizedParties).toEqual(ORIGINS)
  })

  it('a token minted for another origin is 401; the CloudFront origin is accepted', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom('https://evil.example', USER))
    const bad = await raw(makeEvent({ method: 'GET', path: '/api/critters/collection' }))
    expect(bad.status).toBe(401)
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom(ORIGINS[1], USER))
    const ok = await raw(makeEvent({ method: 'GET', path: '/api/critters/collection' }))
    expect(ok.status).toBe(200)
  })
})

describe('critter — database errors', () => {
  it('22007 (an unparseable view-gate header) is a generic 500', async () => {
    setTestUserId(USER)
    const ev = makeEvent({ method: 'PATCH', path: '/api/critters/viewed' })
    const r = await raw({ ...ev, headers: { ...ev.headers, 'x-garden-view-opened-at': 'not-a-date' } })
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'Internal Server Error' })
  })

  it('22021 (NUL in the subject) on the prefs read is a generic 500', async () => {
    setTestUserId(`c6_critter_nul_${RUN}\u0000`)
    const r = await raw(makeEvent({ method: 'GET', path: '/api/notifications/prefs' }))
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'Internal Server Error' })
  })
})

describe('critter — the stickerbook stays per person with GARDEN_HOUSEHOLD_IDS set', () => {
  const DAVE = `c6_critter_dave_${RUN}`
  const JEN = `c6_critter_jen_${RUN}`
  let jenCritter
  let savedIds

  beforeAll(async () => {
    savedIds = process.env.GARDEN_HOUSEHOLD_IDS
    process.env.GARDEN_HOUSEHOLD_IDS = `${DAVE},${JEN}`
    const [row] = await directSql`
      INSERT INTO critter_state (created_by, species_id, target_kind, target_id, source_event_id, earned_at)
      VALUES (${JEN}, 5, 'plant', ${randomUUID()}, ${randomUUID()}, now() - interval '1 hour')
      RETURNING id`
    jenCritter = row.id
  })

  afterAll(async () => {
    if (savedIds === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS
    else process.env.GARDEN_HOUSEHOLD_IDS = savedIds
    await directSql`DELETE FROM critter_state WHERE created_by IN (${DAVE}, ${JEN})`
  })

  it('SEC-13a: Jen\'s critter is not in Dave\'s active list, collection or by-id read, and Dave cannot mark it viewed', async () => {
    setTestUserId(DAVE)
    const active = await call('GET', '/api/critters/active')
    expect(active.status).toBe(200)
    expect(active.body.critters.map((c) => c.id)).not.toContain(jenCritter)
    const collection = await call('GET', '/api/critters/collection')
    expect(collection.status).toBe(200)
    expect(collection.body.species).toEqual([])
    const byId = await call('GET', `/api/critters/${jenCritter}`)
    expect(byId.status).toBe(404)
    const mark = await call('PATCH', '/api/critters/viewed', { actually_seen_critter_ids: [jenCritter] })
    expect(mark.body).toEqual({ marked_viewed_ids: [] })
    const [row] = await directSql`SELECT viewed_at FROM critter_state WHERE id = ${jenCritter}`
    expect(row.viewed_at).toBeNull()
    setTestUserId(JEN)
    const own = await call('GET', '/api/critters/active')
    expect(own.body.critters.map((c) => c.id)).toContain(jenCritter)
  })
})
