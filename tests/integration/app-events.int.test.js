// new-file: no integration test existed for app-events
// Pins today's /api/app-events replies on real Postgres (OPS-CODEREVIEW-001 C6) so D1/D2/D2b changes are seen.
// The 23514 reply echoes the constraint name (D2b replaces that); 23505/23503 are unreachable (uuid PK, no FK).
// A token with no subject is 401 before the limiter and the household gate (SEC-60).
import { describe, it, expect, afterAll, vi } from 'vitest'
import { directSql, callHandler, makeEvent, setTestUserId, testRunId, householdDefault } from './_harness.js'
// After _harness.js, whose vi.mock replaces this module with the stub; imported first it would be the real one.
import { verifyToken } from '@clerk/backend'
import { handler } from '../../lambda/app-events/index.js'

const ORIGINS = ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net']
// Clerk refuses a token whose azp is not in authorizedParties; this models that check on the list the handler passes.
const signedFrom = (azp, sub) => (_token, opts) => (opts.authorizedParties.includes(azp)
  ? (householdDefault(sub), Promise.resolve({ sub, azp }))
  : Promise.reject(new Error(`Invalid JWT Authorized party claim (azp) "${azp}"`)))
const raw = async (event) => {
  const r = await handler(event)
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, raw: r }
}
const post = (body) => callHandler(handler, { method: 'POST', path: '/api/app-events', body })
const rowsFor = (sub) => directSql`SELECT * FROM app_events WHERE user_clerk_sub = ${sub} ORDER BY created_at`

const RUN = testRunId()
const USER = `c6_appev_${RUN}`
const LIMITED = `c6_appev_limited_${RUN}`
const DENIED = `c6_appev_denied_${RUN}`
const PARALLEL = `c6_appev_parallel_${RUN}`
// 256 characters, still carrying the fixture namespace so the global sweep reaches its rate-limit row.
const LONG_SUB = `c6_appev_long_${RUN}_`.padEnd(256, 'x')

afterAll(async () => {
  await directSql`DELETE FROM app_events WHERE user_clerk_sub IN (${USER}, ${LIMITED}, ${DENIED}, ${LONG_SUB}, ${PARALLEL})`
  await directSql`DELETE FROM rate_limit_buckets WHERE actor_clerk_sub IN (${USER}, ${LIMITED}, ${DENIED}, ${LONG_SUB}, ${PARALLEL})`
})

describe('app-events — normal requests', () => {
  it('OPTIONS answers 204 with an empty body before sign-in', async () => {
    const r = await raw({ ...makeEvent({ method: 'OPTIONS', path: '/api/app-events' }), headers: {} })
    expect(r.raw).toEqual({ statusCode: 204, headers: {}, body: '' })
  })

  it('POST writes one row as the caller and answers 201 { id, created_at }', async () => {
    setTestUserId(USER)
    const { status, body, raw: res } = await post({
      event_name: 'reward_seen', event_source: 'today', session_id: 's-1', metadata: { xp: 10 },
    })
    expect(status).toBe(201)
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(Object.keys(body).sort()).toEqual(['created_at', 'id'])
    const rows = await rowsFor(USER)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: body.id, event_name: 'reward_seen', event_source: 'today', session_id: 's-1', metadata: { xp: 10 },
    })
  })

  it('optional fields land as NULL', async () => {
    setTestUserId(USER)
    const { status, body } = await post({ event_name: 'bare' })
    expect(status).toBe(201)
    const [row] = await directSql`SELECT event_source, session_id, metadata FROM app_events WHERE id = ${body.id}`
    expect(row).toEqual({ event_source: null, session_id: null, metadata: null })
  })

  it('each accepted POST counts one against the hourly bucket', async () => {
    const [b] = await directSql`
      SELECT count FROM rate_limit_buckets
       WHERE actor_clerk_sub = ${USER} AND bucket_key = 'app_events.write' AND window_start = date_trunc('hour', now())`
    expect(b.count).toBe(2)
  })

  it('a non-POST method is 405 after sign-in', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/app-events' })
    expect(status).toBe(405)
    expect(body).toEqual({ error: 'Method not allowed — POST only' })
  })

  it('the 1001st POST in an hour is 429 and writes nothing', async () => {
    await directSql`
      INSERT INTO rate_limit_buckets (actor_clerk_sub, bucket_key, window_start, count)
      VALUES (${LIMITED}, 'app_events.write', date_trunc('hour', now()), 1000)`
    setTestUserId(LIMITED)
    const { status, body } = await post({ event_name: 'over' })
    expect(status).toBe(429)
    expect(body).toEqual({ error: 'Rate limit exceeded — 1000/hour for app_events.write' })
    expect(await rowsFor(LIMITED)).toEqual([])
  })

  // SEC-13b S1: the upsert is one statement, so parallel requests cannot push the count past the limit.
  // The next hour is seeded too, so a clock turn mid-case still starts from 995.
  it('SEC-13b: ten parallel POSTs at 995/1000 -> exactly five 201s, five 429s, count 1000', async () => {
    await directSql`
      INSERT INTO rate_limit_buckets (actor_clerk_sub, bucket_key, window_start, count)
      VALUES (${PARALLEL}, 'app_events.write', date_trunc('hour', now()), 995),
             (${PARALLEL}, 'app_events.write', date_trunc('hour', now()) + interval '1 hour', 995)`
    setTestUserId(PARALLEL)
    const results = await Promise.all(Array.from({ length: 10 }, () => post({ event_name: 'parallel' })))
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429, 429, 429, 429, 429])
    const counts = await directSql`
      SELECT count FROM rate_limit_buckets WHERE actor_clerk_sub = ${PARALLEL} AND bucket_key = 'app_events.write'`
    expect(counts.map((c) => c.count)).toContain(1000)
    expect(Math.max(...counts.map((c) => c.count))).toBe(1000)
    expect(await rowsFor(PARALLEL)).toHaveLength(5)
  })
})

describe('app-events — malformed and invalid bodies', () => {
  it.each([
    [{}, 'event_name is required'],
    [{ event_name: 7 }, 'event_name is required'],
    [{ event_name: 'x'.repeat(65) }, 'event_name must be 1-64 characters'],
    [{ event_name: 'ok', event_source: 5 }, 'event_source must be a string'],
    [{ event_name: 'ok', session_id: {} }, 'session_id must be a string'],
    [{ event_name: 'ok', metadata: [1] }, 'metadata must be a JSON object'],
    [{ event_name: 'ok', metadata: 'str' }, 'metadata must be a JSON object'],
    [{ event_name: 'ok', metadata: { blob: 'y'.repeat(8200) } }, 'metadata exceeds 8KB limit (8211 bytes)'],
  ])('%j -> 400 %s', async (body, error) => {
    setTestUserId(DENIED)
    const r = await post(body)
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error })
  })

  it('a JSON null body -> 400 body required', async () => {
    setTestUserId(DENIED)
    const r = await raw({ ...makeEvent({ method: 'POST', path: '/api/app-events' }), body: 'null' })
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'body required' })
  })

  it('no body at all is read as {} -> 400 event_name is required', async () => {
    setTestUserId(DENIED)
    const r = await raw(makeEvent({ method: 'POST', path: '/api/app-events' }))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'event_name is required' })
  })

  it('TODAY: malformed JSON is a 500, not a 400', async () => {
    setTestUserId(DENIED)
    const r = await raw({ ...makeEvent({ method: 'POST', path: '/api/app-events' }), body: '{not json' })
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'Internal server error' })
  })

  it('no refused body wrote a row or touched the bucket', async () => {
    expect(await rowsFor(DENIED)).toEqual([])
    expect(await directSql`SELECT 1 FROM rate_limit_buckets WHERE actor_clerk_sub = ${DENIED}`).toEqual([])
  })
})

describe('app-events — sign-in and origin', () => {
  it('a token Clerk rejects is 401 and writes nothing', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.reject(new Error('JWT is expired')))
    const r = await raw(makeEvent({ method: 'POST', path: '/api/app-events', body: { event_name: 'x' } }))
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Unauthorized' })
  })

  it('the handler hands Clerk exactly the two production origins', async () => {
    setTestUserId(DENIED)
    await post({})
    expect(vi.mocked(verifyToken).mock.calls.at(-1)[1].authorizedParties).toEqual(ORIGINS)
  })

  it('a token minted for another origin is 401', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom('https://evil.example', DENIED))
    const r = await raw(makeEvent({ method: 'POST', path: '/api/app-events', body: { event_name: 'x' } }))
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Unauthorized' })
    expect(await rowsFor(DENIED)).toEqual([])
  })

  it('a token minted for the CloudFront origin is accepted', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom(ORIGINS[1], DENIED))
    const r = await raw(makeEvent({ method: 'POST', path: '/api/app-events', body: {} }))
    expect(r.status).toBe(400)
  })
})

describe('app-events — database errors (the replies D2b changes)', () => {
  it('23514: a subject over 255 chars -> 400 naming the CHECK constraint', async () => {
    setTestUserId(LONG_SUB)
    const r = await post({ event_name: 'long' })
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'Constraint violation: chk_app_events_user_clerk_sub_len' })
    expect(await rowsFor(LONG_SUB)).toEqual([])
  })

  it('SEC-60: a token with no subject -> 401 (it was the limiter\'s 429), and no row of any kind is written', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.resolve({}))
    const r = await raw(makeEvent({ method: 'POST', path: '/api/app-events', body: { event_name: 'nosub' } }))
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Unauthorized' })
    expect(await directSql`SELECT 1 FROM app_events WHERE event_name = 'nosub' AND (user_clerk_sub IS NULL OR user_clerk_sub = '')`).toEqual([])
    expect(await directSql`SELECT 1 FROM rate_limit_buckets WHERE actor_clerk_sub IS NULL OR actor_clerk_sub = ''`).toEqual([])
  })

  it('an unmapped error (22021, NUL in event_name) is a generic 500', async () => {
    setTestUserId(USER)
    const r = await post({ event_name: 'nul\u0000name' })
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'Internal server error' })
  })
})
