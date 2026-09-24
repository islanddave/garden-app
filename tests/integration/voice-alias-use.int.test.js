// tests/integration/voice-alias-use.int.test.js
// BUG-VOICEALIASHITCOUNT-001 — the taught-name use counter (PATCH /api/varieties/voice-aliases) and the
// teach upsert that keeps its tally, against a real Postgres.
//
// lambda/varieties/voice-alias-use.test.js drives both through mock SQL: it proves which statements are
// issued with which binds, never what Postgres does with them. The lane that wrote them proved the SQL by
// EXPLAIN on the live schema, which plans a statement and executes nothing. This file is the first real
// write:
//   1. one use: hit_count 0 -> 1 and last_used_at stamped by the database, read back through the route's
//      own GET (the list the voice page loads);
//   2. a phrase repeated in one request is one use;
//   3. re-teaching a phrase to the SAME variety keeps its tally and its last use (the upsert's CASE), and
//      to a DIFFERENT variety starts it again at 0;
//   4. a use sent for the variety the phrase USED to mean counts nothing (the variety must match);
//   5. another person's alias is never counted, whatever the body says (user_id = the verified caller);
//   6. a malformed body is refused before anything is written, including one bad entry among good ones.
// Read-backs go through directSql, never the handler's echo. The tests run in file order and each starts
// from the state the previous one left, so the sequence reads as one person's alias over a season.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId, setTestUserId, callHandler } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'
import { handler } from '../../lambda/varieties/index.js'

const RUN = testRunId()
const USER = `user_int_voicealias_${RUN}`
const OTHER = `user_int_voicealias_other_${RUN}`
const PATH = '/api/varieties/voice-aliases'
// Dave's own number-bearing alias (prod, 2026-09-24): "cucumber one" means Suyo Long.
const KEY = 'cucumberone'

let suyoId, stupiceId

const teach = (user, body) => { setTestUserId(user); return callHandler(handler, { method: 'POST', path: PATH, body }) }
const use = (user, body) => { setTestUserId(user); return callHandler(handler, { method: 'PATCH', path: PATH, body }) }
const list = (user) => { setTestUserId(user); return callHandler(handler, { method: 'GET', path: PATH }) }
// last_used_at as text: exact to the microsecond, so "kept" means the same instant, not the same millisecond.
const alias = async (user) => (await directSql`
  SELECT variety_id, heard_text, hit_count, last_used_at::text AS last_used_at
    FROM voice_alias WHERE user_id = ${user} AND heard_key = ${KEY}`)[0] ?? null
const everyAlias = () => directSql`
  SELECT user_id, heard_key, variety_id, heard_text, hit_count, last_used_at::text AS last_used_at
    FROM voice_alias WHERE user_id IN (${USER}, ${OTHER}) ORDER BY user_id, heard_key`

beforeAll(async () => {
  const [s] = await directSql`
    INSERT INTO plant_varieties (name, created_by) VALUES (${'voicealias-suyo-' + RUN}, ${USER}) RETURNING id`
  suyoId = s.id
  const [t] = await directSql`
    INSERT INTO plant_varieties (name, created_by) VALUES (${'voicealias-stupice-' + RUN}, ${USER}) RETURNING id`
  stupiceId = t.id
})

afterAll(async () => {
  assertFixtureId(USER, OTHER)
  await settle('voice-alias-use', [
    // voice_alias.variety_id is ON DELETE CASCADE, so the variety delete below would take these rows too.
    // Deleted first, by owner, so that nothing here leans on that.
    () => directSql`DELETE FROM voice_alias WHERE user_id IN (${USER}, ${OTHER})`,
    () => directSql`DELETE FROM entity_tag WHERE entity_id IN (SELECT id FROM plant_varieties WHERE created_by = ${USER})`,
    // plant_varieties_entity_ins makes an entity row per cultivar, ON DELETE RESTRICT into plant_varieties.
    () => directSql`DELETE FROM entity WHERE entity_type = 'cultivar' AND cultivar_ref_id IN (
                      SELECT id FROM plant_varieties WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`,
  ])
})

describe('BUG-VOICEALIASHITCOUNT-001 — PATCH /api/varieties/voice-aliases counts a use', () => {
  it('teach, then one use: the GET reads hit_count 1 and a last_used_at, where the teach left 0 and none', async () => {
    const taught = await teach(USER, { heard_key: KEY, heard_text: 'cucumber one', variety_id: suyoId })
    expect(taught.status, JSON.stringify(taught.body)).toBe(200)
    expect(await alias(USER)).toEqual({ variety_id: suyoId, heard_text: 'cucumber one', hit_count: 0, last_used_at: null })

    const r = await use(USER, { used: [{ heard_key: KEY, variety_id: suyoId }] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({ counted: 1 })
    expect((await alias(USER)).hit_count).toBe(1)
    // Stamped by the UPDATE's own now(), so the check reads the database clock, never the runner's.
    const [{ fresh }] = await directSql`
      SELECT last_used_at > now() - interval '10 minutes' AND last_used_at <= now() AS fresh
        FROM voice_alias WHERE user_id = ${USER} AND heard_key = ${KEY}`
    expect(fresh).toBe(true)

    const got = await list(USER)
    expect(got.status, JSON.stringify(got.body)).toBe(200)
    expect(got.body.aliases).toHaveLength(1)
    expect(got.body.aliases[0]).toMatchObject({ heard_key: KEY, variety_id: suyoId, hit_count: 1 })
    expect(got.body.aliases[0].last_used_at).toEqual(expect.any(String))
  })

  it('the same phrase twice in one request is one use', async () => {
    const r = await use(USER, { used: [{ heard_key: KEY, variety_id: suyoId }, { heard_key: KEY, variety_id: suyoId }] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({ counted: 1 })
    expect((await alias(USER)).hit_count).toBe(2)
  })

  it('re-teaching the phrase to the SAME variety keeps its tally and its last use', async () => {
    const before = await alias(USER)
    expect(before).toMatchObject({ variety_id: suyoId, hit_count: 2 })
    expect(before.last_used_at).not.toBeNull()
    // The voice page re-teaches a phrase it already knows whenever a learned alias offers several
    // plantings and one is tapped; Chrome may deliver the digit form this time.
    const r = await teach(USER, { heard_key: KEY, heard_text: 'cucumber 1', variety_id: suyoId })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ heard_key: KEY, variety_id: suyoId, hit_count: 2 })
    // The transcript is rewritten; the tally and the instant of the last use are not.
    expect(await alias(USER)).toEqual({ ...before, heard_text: 'cucumber 1' })
  })

  it('re-teaching it to a DIFFERENT variety starts a new tally: 0 uses, no last use, still one row', async () => {
    const r = await teach(USER, { heard_key: KEY, heard_text: 'cucumber one', variety_id: stupiceId })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ heard_key: KEY, variety_id: stupiceId, hit_count: 0, last_used_at: null })
    expect(await alias(USER)).toEqual({ variety_id: stupiceId, heard_text: 'cucumber one', hit_count: 0, last_used_at: null })
    const [{ n }] = await directSql`SELECT count(*)::int AS n FROM voice_alias WHERE user_id = ${USER} AND heard_key = ${KEY}`
    expect(n).toBe(1)
  })

  it('a use sent for the variety the phrase USED to mean counts nothing; the meaning it has now does', async () => {
    // A page that loaded its list before the re-teach still sends Suyo Long for the phrase.
    const stale = await use(USER, { used: [{ heard_key: KEY, variety_id: suyoId }] })
    expect(stale.status, JSON.stringify(stale.body)).toBe(200)
    expect(stale.body).toEqual({ counted: 0 })
    expect(await alias(USER)).toEqual({ variety_id: stupiceId, heard_text: 'cucumber one', hit_count: 0, last_used_at: null })

    const live = await use(USER, { used: [{ heard_key: KEY, variety_id: stupiceId }] })
    expect(live.status, JSON.stringify(live.body)).toBe(200)
    expect(live.body).toEqual({ counted: 1 })
    expect((await alias(USER)).hit_count).toBe(1)
  })

  it("another person's alias is never counted, whatever the body says, and each GET lists only its caller's", async () => {
    // OTHER teaches the very phrase, for the very variety, that USER's use below names. The only thing that
    // tells OTHER's row from a match is its user_id.
    const t = await teach(OTHER, { heard_key: KEY, heard_text: 'cucumber one', variety_id: suyoId })
    expect(t.status, JSON.stringify(t.body)).toBe(200)
    const theirs = await alias(OTHER)
    expect(theirs).toEqual({ variety_id: suyoId, heard_text: 'cucumber one', hit_count: 0, last_used_at: null })
    const mine = await alias(USER)

    const r = await use(USER, { user_id: OTHER, used: [{ heard_key: KEY, variety_id: suyoId, user_id: OTHER }] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({ counted: 0 })
    expect(await alias(OTHER)).toEqual(theirs)
    expect(await alias(USER)).toEqual(mine)

    const theirList = await list(OTHER)
    expect(theirList.body.aliases.map((a) => [a.heard_key, a.variety_id, a.hit_count])).toEqual([[KEY, suyoId, 0]])
    const myList = await list(USER)
    expect(myList.body.aliases.map((a) => [a.heard_key, a.variety_id, a.hit_count])).toEqual([[KEY, stupiceId, 1]])
  })
})

describe('BUG-VOICEALIASHITCOUNT-001 — a malformed count is refused before anything is written', () => {
  // Every non-empty body below carries an entry that WOULD count if it got through (USER's phrase, for the
  // variety it means now), so "no row changed" is a real claim and not the absence of a match. The empty
  // list can match nothing either way; its 400 is the assertion.
  const good = () => ({ heard_key: KEY, variety_id: stupiceId })

  it.each([
    ['an empty list', () => ({ used: [] }), /^used must list 1-20/],
    ['21 entries', () => ({ used: Array.from({ length: 21 }, good) }), /^used must list 1-20/],
    ['a key that is not normalised, beside a good one', () => ({ used: [good(), { heard_key: 'Cucumber One', variety_id: stupiceId }] }), /^heard_key must be a normalised/],
    ['a key under 4 characters, beside a good one', () => ({ used: [good(), { heard_key: 'cuc', variety_id: stupiceId }] }), /^heard_key must be a normalised/],
    ['a variety that is not a uuid, beside a good one', () => ({ used: [good(), { heard_key: KEY, variety_id: 'suyo-long' }] }), /^variety_id must be a uuid/],
  ])('%s: 400, and no row changes', async (_what, body, error) => {
    const before = await everyAlias()
    expect(before.find((a) => a.user_id === USER)).toMatchObject({ variety_id: stupiceId, hit_count: 1 })
    const r = await use(USER, body())
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.error).toMatch(error)
    expect(await everyAlias()).toEqual(before)
  })
})
