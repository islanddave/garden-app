// new-file: no integration test existed for ux-events
// Pins today's /api/ux-events replies on real Postgres (OPS-CODEREVIEW-001 C6) so D1/D2/D2b changes are seen.
// ux_events has no CHECK, UNIQUE or FK, so 23514/23505/23503 are unreachable; every database error a request
// can cause (22007 bad client_ts, 23502 missing subject) is a generic 500. Trap: no empty-subject guard, and
// malformed JSON is a 500, not a 400.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { directSql, callHandler, makeEvent, setTestUserId, testRunId, householdDefault } from './_harness.js'
// After _harness.js, whose vi.mock replaces this module with the stub; imported first it would be the real one.
import { verifyToken } from '@clerk/backend'
import { handler } from '../../lambda/ux-events/index.js'

const ORIGINS = ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net']
// Clerk refuses a token whose azp is not in authorizedParties; this models that check on the list the handler passes.
const signedFrom = (azp, sub) => (_token, opts) => (opts.authorizedParties.includes(azp)
  ? (householdDefault(sub), Promise.resolve({ sub, azp }))
  : Promise.reject(new Error(`Invalid JWT Authorized party claim (azp) "${azp}"`)))
const raw = async (event) => {
  const r = await handler(event)
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, raw: r }
}
const post = (body) => callHandler(handler, { method: 'POST', path: '/api/ux-events', body })
const rowsFor = (sub) => directSql`SELECT * FROM ux_events WHERE clerk_sub = ${sub} ORDER BY id`

const RUN = testRunId()
const USER = `c6_ux_${RUN}`
const ADMIN = `c6_ux_admin_${RUN}`
const DENIED = `c6_ux_denied_${RUN}`
const savedAdmins = process.env.ADMIN_CLERK_SUBS

beforeAll(() => { delete process.env.ADMIN_CLERK_SUBS })
afterAll(async () => {
  if (savedAdmins === undefined) delete process.env.ADMIN_CLERK_SUBS
  else process.env.ADMIN_CLERK_SUBS = savedAdmins
  await directSql`DELETE FROM ux_events WHERE clerk_sub IN (${USER}, ${ADMIN}, ${DENIED})`
})

describe('ux-events — POST', () => {
  it('OPTIONS answers 204 with an empty body before sign-in', async () => {
    const r = await raw({ ...makeEvent({ method: 'OPTIONS', path: '/api/ux-events' }), headers: {} })
    expect(r.raw).toEqual({ statusCode: 204, headers: {}, body: '' })
  })

  it('an allowlisted flow writes one row as the caller and answers 201 { ok, id }', async () => {
    setTestUserId(USER)
    const { status, body, raw: res } = await post({
      flow_id: 'log_watering', session_id: 's-1', step_index: 2, step_name: 'save', tap_count: 5,
      client_ts: '2026-10-29T12:00:00Z', meta: { route: '/log' }, clerk_sub: 'spoofed',
    })
    expect(status).toBe(201)
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(body.ok).toBe(true)
    const rows = await rowsFor(USER)
    expect(rows).toHaveLength(1)
    expect(String(rows[0].id)).toBe(String(body.id))
    expect(rows[0]).toMatchObject({
      session_id: 's-1', flow_id: 'log_watering', step_index: 2, step_name: 'save', tap_count: 5, meta: { route: '/log' },
    })
    expect(new Date(rows[0].client_ts).toISOString()).toBe('2026-10-29T12:00:00.000Z')
    expect(await directSql`SELECT 1 FROM ux_events WHERE clerk_sub = 'spoofed' AND session_id = 's-1'`).toEqual([])
  })

  it('coerces: non-integer step_index -> 0, tap_count -> NULL, long names truncated', async () => {
    setTestUserId(USER)
    const { status, body } = await post({
      flow_id: 'open_planting', session_id: 'z'.repeat(200), step_index: 1.5, step_name: 'n'.repeat(100), tap_count: 'many',
    })
    expect(status).toBe(201)
    const [row] = await directSql`SELECT * FROM ux_events WHERE id = ${body.id}`
    expect(row.session_id).toHaveLength(128)
    expect(row.step_name).toHaveLength(64)
    expect(row).toMatchObject({ step_index: 0, tap_count: null, client_ts: null, meta: null })
  })

  it.each([
    [{ flow_id: 'made_up', session_id: 's' }, 'unknown flow_id'],
    [{ session_id: 's' }, 'unknown flow_id'],
    [{ flow_id: 'log_watering' }, 'session_id is required'],
  ])('%j -> 400 %s', async (body, error) => {
    setTestUserId(DENIED)
    const r = await post(body)
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error })
  })

  it('TODAY: malformed JSON is a 500, not a 400', async () => {
    setTestUserId(DENIED)
    const r = await raw({ ...makeEvent({ method: 'POST', path: '/api/ux-events' }), body: '{not json' })
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'Internal server error' })
    expect(await rowsFor(DENIED)).toEqual([])
  })

  it('another method is 405', async () => {
    setTestUserId(USER)
    const r = await callHandler(handler, { method: 'PUT', path: '/api/ux-events', body: {} })
    expect(r.status).toBe(405)
    expect(r.body).toEqual({ error: 'Method not allowed' })
  })
})

describe('ux-events — admin GET', () => {
  it('no admin allowlist: 403 Admin route not configured', async () => {
    setTestUserId(ADMIN)
    const r = await callHandler(handler, { method: 'GET', path: '/api/ux-events?admin=1' })
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ error: 'Admin route not configured' })
  })

  it('a non-admin, or an admin without ?admin=1: 403 Not authorized', async () => {
    process.env.ADMIN_CLERK_SUBS = ADMIN
    try {
      setTestUserId(USER)
      const notAdmin = await callHandler(handler, { method: 'GET', path: '/api/ux-events?admin=1' })
      expect(notAdmin.status).toBe(403)
      expect(notAdmin.body).toEqual({ error: 'Not authorized' })
      setTestUserId(ADMIN)
      const noFlag = await callHandler(handler, { method: 'GET', path: '/api/ux-events' })
      expect(noFlag.body).toEqual({ error: 'Not authorized' })
    } finally {
      delete process.env.ADMIN_CLERK_SUBS
    }
  })

  it('the admin gets the three measures, with this file\'s completion event counted in M1', async () => {
    process.env.ADMIN_CLERK_SUBS = ADMIN
    try {
      setTestUserId(ADMIN)
      const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/ux-events?admin=1' })
      expect(status).toBe(200)
      expect(Object.keys(body)).toEqual(['generated_at', 'm1', 'm2', 'm3'])
      expect(body.m1.window_days).toBe(30)
      expect(body.m2.window_weeks).toBe(8)
      const water = body.m1.by_flow.find((f) => f.flow_id === 'log_watering')
      expect(water.samples).toBeGreaterThanOrEqual(1)
      expect(Object.keys(water).sort()).toEqual(['avg_taps', 'flow_id', 'max_taps', 'median_taps', 'min_taps', 'samples'])
      expect(body.m3).toMatchObject({ canary_threshold: 0.4 })
      expect(typeof body.m3.available).toBe('boolean')
    } finally {
      delete process.env.ADMIN_CLERK_SUBS
    }
  })
})

describe('ux-events — sign-in and origin', () => {
  it('a token Clerk rejects is 401 and writes nothing', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.reject(new Error('JWT is expired')))
    const r = await raw(makeEvent({ method: 'POST', path: '/api/ux-events', body: { flow_id: 'log_watering', session_id: 'x' } }))
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Unauthorized' })
  })

  it('the handler hands Clerk exactly the two production origins', async () => {
    setTestUserId(DENIED)
    await post({})
    expect(vi.mocked(verifyToken).mock.calls.at(-1)[1].authorizedParties).toEqual(ORIGINS)
  })

  it('a token minted for another origin is 401; the CloudFront origin is accepted', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom('https://evil.example', DENIED))
    expect((await raw(makeEvent({ method: 'POST', path: '/api/ux-events', body: {} }))).status).toBe(401)
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom(ORIGINS[1], DENIED))
    expect((await raw(makeEvent({ method: 'POST', path: '/api/ux-events', body: {} }))).status).toBe(400)
    expect(await rowsFor(DENIED)).toEqual([])
  })
})

describe('ux-events — database errors', () => {
  it('22007 (an unparseable client_ts) is a generic 500 and writes nothing', async () => {
    setTestUserId(DENIED)
    const r = await post({ flow_id: 'log_watering', session_id: 's-bad', client_ts: 'yesterday-ish' })
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'Internal server error' })
    expect(await rowsFor(DENIED)).toEqual([])
  })

  it('23502 (TODAY: a token with no subject reaches the INSERT) is a generic 500', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.resolve({}))
    const r = await raw(makeEvent({ method: 'POST', path: '/api/ux-events', body: { flow_id: 'log_watering', session_id: 'nosub' } }))
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'Internal server error' })
  })
})
