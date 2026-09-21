// tests/integration/variety-facts-edit.int.test.js
// V5-VARIETYFACTSEDIT-001 — the varieties PUT edits origin, breeding and heat source, against a
// real Postgres.
//
// lambda/varieties/facts-edit.test.js drives the PUT through mock SQL, which proves which statements
// are issued with which binds and never that Postgres accepts them. This file closes the rest:
//   1. the five CASE/COALESCE arms write through the auto-updatable public.cultivar view;
//   2. clear NULLs each of them, and blank origin text lands as NULL, never as '';
//   3. the handler's pairing preflight agrees with the LIVE CHECKs in both directions — every body it
//      refuses by name is one the CHECK would have refused as a raw 23514, and it lets through what
//      the CHECK allows (a source alone; open_pollinated on a cultivar-rank row). A preflight looser
//      than the CHECK leaks a constraint name to the user; a stricter one refuses a legal edit;
//   4. GET /api/varieties/:id returns the five, which is what VarietyEditor seeds its form from.
// Read-backs go through directSql, never the handler's echo.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId, setTestUserId, callHandler } from './_harness.js'
import { handler } from '../../lambda/varieties/index.js'

const RUN = testRunId()
const USER = `user_int_facts_${RUN}`
const FOREIGN = `user_int_facts_foreign_${RUN}`

let varietyId, rankedId, foreignId

const put = (id, body) => callHandler(handler, { method: 'PUT', path: `/api/varieties/${id}`, body })
const facts = async (id) => (await directSql`
  SELECT origin_country, origin_region, breeding_system, breeding_source, scoville_source, variety_rank
    FROM plant_varieties WHERE id = ${id}`)[0]

beforeAll(async () => {
  setTestUserId(USER)
  // The ledger case: a pepper whose heat figure is a best guess, so the card reads "est.".
  const v = await directSql`
    INSERT INTO plant_varieties (name, created_by, scoville_min, scoville_max, scoville_source)
    VALUES (${'facts-var-' + RUN}, ${USER}, 100000, 350000, 'inference')
    RETURNING id`
  varietyId = v[0].id
  const r = await directSql`
    INSERT INTO plant_varieties (name, created_by, variety_rank)
    VALUES (${'facts-var-ranked-' + RUN}, ${USER}, 'cultivar')
    RETURNING id`
  rankedId = r[0].id
  const f = await directSql`
    INSERT INTO plant_varieties (name, created_by)
    VALUES (${'facts-var-foreign-' + RUN}, ${FOREIGN})
    RETURNING id`
  foreignId = f[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM public.entity_tag WHERE entity_id IN (
    SELECT id FROM plant_varieties WHERE created_by IN (${USER}, ${FOREIGN}))`
  await directSql`DELETE FROM entity WHERE cultivar_ref_id IN (
    SELECT id FROM plant_varieties WHERE created_by IN (${USER}, ${FOREIGN}))`
  await directSql`DELETE FROM plant_varieties WHERE created_by IN (${USER}, ${FOREIGN})`
})

// The tests below run in file order and each starts from the state the previous one left, so the
// sequence reads as one editing session on one cultivar.
describe('V5-VARIETYFACTSEDIT-001 — PUT /api/varieties/:id writes the five columns', () => {
  it('sets all five through the view, trimming origin text, and replaces the best-guess heat source', async () => {
    setTestUserId(USER)
    const { status, body } = await put(varietyId, {
      origin_country: '  Italy ', origin_region: 'Liguria', scoville_source: 'packet_label',
      breeding_system: 'landrace', breeding_source: 'reference_work',
    })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(await facts(varietyId)).toEqual({
      origin_country: 'Italy', origin_region: 'Liguria', breeding_system: 'landrace',
      breeding_source: 'reference_work', scoville_source: 'packet_label', variety_rank: null,
    })
    // The echo the client replaces its list row with (RETURNING) carries them too.
    expect(body).toMatchObject({
      origin_country: 'Italy', origin_region: 'Liguria', breeding_system: 'landrace',
      breeding_source: 'reference_work', scoville_source: 'packet_label',
    })
  })

  it('GET /api/varieties/:id returns all five — the read the editor seeds from', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, { method: 'GET', path: `/api/varieties/${varietyId}` })
    expect(status).toBe(200)
    expect(body).toMatchObject({
      origin_country: 'Italy', origin_region: 'Liguria', breeding_system: 'landrace',
      breeding_source: 'reference_work', scoville_source: 'packet_label',
    })
  })

  it('an unknown value is refused by name and writes nothing', async () => {
    setTestUserId(USER)
    const before = await facts(varietyId)
    const { status, body } = await put(varietyId, { scoville_source: 'estimate' })
    expect(status).toBe(400)
    expect(body.error).toMatch(/^scoville_source must be one of: /)
    expect(await facts(varietyId)).toEqual(before)
  })

  it('clear NULLs each of the five, and blank origin text lands as NULL rather than \'\'', async () => {
    setTestUserId(USER)
    const { status, body } = await put(varietyId, {
      origin_country: '   ',
      clear: ['origin_region', 'scoville_source', 'breeding_system', 'breeding_source'],
    })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(await facts(varietyId)).toEqual({
      origin_country: null, origin_region: null, breeding_system: null,
      breeding_source: null, scoville_source: null, variety_rank: null,
    })
  })
})

describe('V5-VARIETYFACTSEDIT-001 — the pairing preflight agrees with the live CHECKs', () => {
  it('breeding with no source: a 400 naming breeding_source, where the CHECK would have said 23514', async () => {
    setTestUserId(USER)
    const { status, body } = await put(varietyId, { breeding_system: 'f1' })
    expect(status).toBe(400)
    expect(body.error).toBe('breeding_source is required when breeding_system is set')
    expect((await facts(varietyId)).breeding_system).toBeNull()
    await expect(directSql`UPDATE plant_varieties SET breeding_system = 'f1' WHERE id = ${varietyId}`)
      .rejects.toThrow(/chk_plant_varieties_breeding_sourced/)
  })

  it('a source alone is allowed, as the CHECK allows it', async () => {
    setTestUserId(USER)
    const { status, body } = await put(varietyId, { breeding_source: 'grower_record' })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(await facts(varietyId)).toMatchObject({ breeding_system: null, breeding_source: 'grower_record' })
  })

  it('breeding set on a row that already carries its source is allowed', async () => {
    setTestUserId(USER)
    const { status, body } = await put(varietyId, { breeding_system: 'unknown' })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(await facts(varietyId)).toMatchObject({ breeding_system: 'unknown', breeding_source: 'grower_record' })
  })

  it('clearing the source under a breeding call is refused by name, and the row is untouched', async () => {
    setTestUserId(USER)
    const { status, body } = await put(varietyId, { clear: ['breeding_source'] })
    expect(status).toBe(400)
    expect(body.error).toMatch(/^breeding_source is required/)
    expect(await facts(varietyId)).toMatchObject({ breeding_system: 'unknown', breeding_source: 'grower_record' })
    await expect(directSql`UPDATE plant_varieties SET breeding_source = NULL WHERE id = ${varietyId}`)
      .rejects.toThrow(/chk_plant_varieties_breeding_sourced/)
  })

  it('open_pollinated on a row not recorded as a cultivar: a 400 naming breeding_system, where the CHECK would have said 23514', async () => {
    setTestUserId(USER)
    const { status, body } = await put(varietyId, { breeding_system: 'open_pollinated' })
    expect(status).toBe(400)
    expect(body.error).toMatch(/^breeding_system open_pollinated can only be recorded on a single named cultivar/)
    expect((await facts(varietyId)).breeding_system).toBe('unknown')
    await expect(directSql`UPDATE plant_varieties SET breeding_system = 'open_pollinated' WHERE id = ${varietyId}`)
      .rejects.toThrow(/chk_plant_varieties_op_requires_cultivar/)
  })

  it('open_pollinated on a cultivar-rank row is written', async () => {
    setTestUserId(USER)
    const { status, body } = await put(rankedId, { breeding_system: 'open_pollinated', breeding_source: 'packet_label' })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(await facts(rankedId)).toMatchObject({
      breeding_system: 'open_pollinated', breeding_source: 'packet_label', variety_rank: 'cultivar',
    })
  })

  it("someone else's row answers the generic 404 and is untouched", async () => {
    setTestUserId(USER)
    const { status, body } = await put(foreignId, { breeding_system: 'f1', breeding_source: 'breeder' })
    expect(status).toBe(404)
    expect(body.error).toBe('Not found or not owner')
    expect(await facts(foreignId)).toMatchObject({ breeding_system: null, breeding_source: null })
  })
})
