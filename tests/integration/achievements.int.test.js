// new-file: no integration test existed for achievements
// Pins today's /api/achievements replies on real Postgres (OPS-CODEREVIEW-001 C6) so D1/D2/D2b changes are seen.
// Read-only: no 23514/23505/23503 is reachable; the one database error a request can cause (a NUL byte in
// the subject, 22021) pins the generic 500. Trap: this handler has NO empty-subject 401 guard today.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { directSql, callHandler, makeEvent, setTestUserId, testRunId, householdDefault } from './_harness.js'
// After _harness.js, whose vi.mock replaces this module with the stub; imported first it would be the real one.
import { verifyToken } from '@clerk/backend'
import { handler } from '../../lambda/achievements/index.js'

const ORIGINS = ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net']
// Clerk refuses a token whose azp is not in authorizedParties; this models that check on the list the handler passes.
const signedFrom = (azp, sub) => (_token, opts) => (opts.authorizedParties.includes(azp)
  ? (householdDefault(sub), Promise.resolve({ sub, azp }))
  : Promise.reject(new Error(`Invalid JWT Authorized party claim (azp) "${azp}"`)))
const raw = async (event) => {
  const r = await handler(event)
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, raw: r }
}

const RUN = testRunId()
const FRESH = `c6_ach_fresh_${RUN}`
const EARNER = `c6_ach_earner_${RUN}`
const LOCKED_KEYS = ['id', 'slug', 'name', 'description', 'emoji', 'xp_reward', 'trigger_type', 'trigger_value', 'sort_order']
let visible
let secretCount
let plain
let secret
let inactive

beforeAll(async () => {
  visible = await directSql`
    SELECT id, slug, name, sort_order FROM achievements
     WHERE is_active = true AND is_secret = false ORDER BY sort_order ASC, name ASC`
  secretCount = (await directSql`SELECT COUNT(*)::int AS n FROM achievements WHERE is_active AND is_secret`)[0].n
  plain = visible[0]
  secret = (await directSql`SELECT id FROM achievements WHERE is_active AND is_secret ORDER BY sort_order LIMIT 1`)[0]
  inactive = (await directSql`SELECT id FROM achievements WHERE NOT is_active LIMIT 1`)[0]
  await directSql`
    INSERT INTO user_achievements (user_id, achievement_id, earned_at)
    VALUES (${EARNER}, ${plain.id}, now() - interval '2 hours'),
           (${EARNER}, ${secret.id}, now() - interval '1 hour')`
  if (inactive) {
    await directSql`INSERT INTO user_achievements (user_id, achievement_id) VALUES (${EARNER}, ${inactive.id})`
  }
})

afterAll(async () => {
  await directSql`DELETE FROM user_achievements WHERE user_id IN (${FRESH}, ${EARNER})`
})

describe('achievements — normal requests', () => {
  it('OPTIONS answers 204 with an empty body before sign-in', async () => {
    const r = await raw({ ...makeEvent({ method: 'OPTIONS', path: '/api/achievements' }), headers: {} })
    expect(r.raw).toEqual({ statusCode: 204, headers: {}, body: '' })
  })

  it('the seed has visible and secret achievements (anti-vacuity)', () => {
    expect(visible.length).toBeGreaterThan(0)
    expect(secret).toBeTruthy()
  })

  it('a user with nothing earned sees every visible achievement locked, in sort order', async () => {
    setTestUserId(FRESH)
    const { status, body, raw: res } = await callHandler(handler, { method: 'GET', path: '/api/achievements' })
    expect(status).toBe(200)
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(body.earned).toEqual([])
    expect(body.locked.map((a) => a.id)).toEqual(visible.map((a) => a.id))
    expect(Object.keys(body.locked[0])).toEqual(LOCKED_KEYS)
    expect(body).toMatchObject({ total_earned: 0, total_visible: visible.length, secret_locked_count: secretCount })
  })

  it('earned rows (secret included, inactive excluded) come newest first and leave the locked list', async () => {
    setTestUserId(EARNER)
    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/achievements' })
    expect(status).toBe(200)
    expect(body.earned.map((a) => a.id)).toEqual([secret.id, plain.id])
    expect(Object.keys(body.earned[0])).toEqual([
      'id', 'slug', 'name', 'description', 'emoji', 'xp_reward', 'trigger_type', 'trigger_value',
      'is_secret', 'sort_order', 'earned_at', 'trigger_event_id',
    ])
    expect(body.earned[0].is_secret).toBe(true)
    expect(body.locked.map((a) => a.id)).not.toContain(plain.id)
    expect(body).toMatchObject({
      total_earned: 2,
      total_visible: 2 + visible.length - 1,
      secret_locked_count: secretCount - 1,
    })
  })

  it('a non-GET method is 405 after sign-in, malformed body or not', async () => {
    setTestUserId(FRESH)
    const r = await raw({ ...makeEvent({ method: 'POST', path: '/api/achievements' }), body: '{not json' })
    expect(r.status).toBe(405)
    expect(r.body).toEqual({ error: 'Method not allowed' })
  })

  it('a GET carrying a malformed body ignores it', async () => {
    setTestUserId(FRESH)
    const r = await raw({ ...makeEvent({ method: 'GET', path: '/api/achievements' }), body: '{not json' })
    expect(r.status).toBe(200)
  })
})

describe('achievements — sign-in and origin', () => {
  it('a token Clerk rejects is 401 Unauthorized', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.reject(new Error('JWT is expired')))
    const r = await raw(makeEvent({ method: 'GET', path: '/api/achievements' }))
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Unauthorized' })
  })

  it('no Authorization header sends an empty token to Clerk and is 401 when Clerk refuses it', async () => {
    vi.mocked(verifyToken).mockImplementationOnce((token) => (token === '' ? Promise.reject(new Error('no token')) : Promise.resolve({ sub: FRESH })))
    const r = await raw({ ...makeEvent({ method: 'GET', path: '/api/achievements' }), headers: {} })
    expect(r.status).toBe(401)
    expect(vi.mocked(verifyToken).mock.calls.at(-1)[0]).toBe('')
  })

  it('the handler hands Clerk exactly the two production origins', async () => {
    setTestUserId(FRESH)
    await callHandler(handler, { method: 'GET', path: '/api/achievements' })
    expect(vi.mocked(verifyToken).mock.calls.at(-1)[1].authorizedParties).toEqual(ORIGINS)
  })

  it('a token minted for another origin is 401', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom('https://staging.garden.futureishere.net', FRESH))
    const r = await raw(makeEvent({ method: 'GET', path: '/api/achievements' }))
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Unauthorized' })
  })

  it('a token minted for the CloudFront origin is accepted', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom(ORIGINS[1], FRESH))
    const r = await raw(makeEvent({ method: 'GET', path: '/api/achievements' }))
    expect(r.status).toBe(200)
  })

  it('TODAY: a verified token with no subject is served (no empty-subject guard), as a user with nothing earned', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.resolve({}))
    const r = await raw(makeEvent({ method: 'GET', path: '/api/achievements' }))
    expect(r.status).toBe(200)
    expect(r.body.earned).toEqual([])
    expect(r.body.total_visible).toBe(visible.length)
  })
})

describe('achievements — database errors', () => {
  it('an unmapped database error (22021, NUL in the subject) is a generic 500 that leaks nothing', async () => {
    setTestUserId(`c6_ach_nul_${RUN}\u0000`)
    const r = await raw(makeEvent({ method: 'GET', path: '/api/achievements' }))
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'Internal server error' })
  })
})
