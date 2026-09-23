// tests/integration/variety-facts-edit.int.test.js
// V5-VARIETYFACTSEDIT-001 — the varieties PUT edits origin, breeding and heat source, against a
// real Postgres.
//
// lambda/varieties/facts-edit.test.js drives the PUT through mock SQL, which proves which statements
// are issued with which binds and never that Postgres accepts them. This file closes the rest:
//   1. the five CASE/COALESCE arms write through the auto-updatable public.cultivar view;
//   2. clear NULLs each of them, and blank origin text lands as NULL, never as '';
//   3. the handler's pairing preflight agrees with the LIVE CHECKs in both directions — every body it
//      refuses in plain English is one the CHECK would have refused as a raw 23514, and it lets
//      through what the CHECK allows (a source alone; open_pollinated on a cultivar-rank row). A
//      preflight looser than the CHECK leaks a constraint name to the user; a stricter one refuses a
//      legal edit. Open-pollinated on a row with NO recorded rank is Dave's rule (2026-09-21): the
//      same UPDATE records the variety as a single named cultivar. Since v5-oprankchecknull-001
//      (2026-09-23) the CHECK is NULL-safe and refuses Open-pollinated on an unranked row, so the
//      fill is what lets that write through at all; the rank is still read back, because a refusal
//      and a fill that wrote the wrong rank must look different;
//   4. GET /api/varieties/:id returns the five, which is what VarietyEditor seeds its form from;
//   5. the fill is permanent, and fires when Open-pollinated and its source arrive in ONE body; every
//      other breeding call is written on every recorded rank; and the driver reports a CHECK refusal
//      with the constraint name the handler's catch maps to a sentence (the race path).
// Read-backs go through directSql, never the handler's echo. No case here leaves a row holding
// open_pollinated on a NULL rank: an OP write on an unranked row goes through the PUT, which fills it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId, setTestUserId, callHandler } from './_harness.js'
import { handler } from '../../lambda/varieties/index.js'

const RUN = testRunId()
const USER = `user_int_facts_${RUN}`
const FOREIGN = `user_int_facts_foreign_${RUN}`

let varietyId, rankedId, marketId, foreignId, unrankedId

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
  const m = await directSql`
    INSERT INTO plant_varieties (name, created_by, variety_rank)
    VALUES (${'facts-var-market-' + RUN}, ${USER}, 'market_class')
    RETURNING id`
  marketId = m[0].id
  const f = await directSql`
    INSERT INTO plant_varieties (name, created_by)
    VALUES (${'facts-var-foreign-' + RUN}, ${FOREIGN})
    RETURNING id`
  foreignId = f[0].id
  const u = await directSql`
    INSERT INTO plant_varieties (name, created_by)
    VALUES (${'facts-var-unranked-' + RUN}, ${USER})
    RETURNING id`
  unrankedId = u[0].id
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

  it('a PUT that names no breeding column — every edit that existed before — leaves the five and the rank untouched', async () => {
    setTestUserId(USER)
    const before = await facts(varietyId)
    const { status, body } = await put(varietyId, { care_notes: `int non-breeding edit ${RUN}` })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(await facts(varietyId)).toEqual(before)
    expect(before.variety_rank).toBeNull()
    expect(body).toHaveProperty('breeding_system', 'landrace')
    expect(body).toHaveProperty('breeding_source', 'reference_work')
    expect(body).toHaveProperty('scoville_source', 'packet_label')
    expect((await directSql`SELECT care_notes FROM plant_varieties WHERE id = ${varietyId}`)[0].care_notes)
      .toBe(`int non-breeding edit ${RUN}`)
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
  it('breeding with no source: a plain-English 400, where the CHECK would have said 23514', async () => {
    setTestUserId(USER)
    const { status, body } = await put(varietyId, { breeding_system: 'f1' })
    expect(status).toBe(400)
    expect(body.error).toBe('"Breeding info from" is required when Breeding is set.')
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

  it('clearing the source under a breeding call is refused, and the row is untouched', async () => {
    setTestUserId(USER)
    const { status, body } = await put(varietyId, { clear: ['breeding_source'] })
    expect(status).toBe(400)
    expect(body.error).toMatch(/^"Breeding info from" is required/)
    expect(await facts(varietyId)).toMatchObject({ breeding_system: 'unknown', breeding_source: 'grower_record' })
    await expect(directSql`UPDATE plant_varieties SET breeding_source = NULL WHERE id = ${varietyId}`)
      .rejects.toThrow(/chk_plant_varieties_breeding_sourced/)
  })

  it('open_pollinated on a market-class row: a plain-English 400, where the CHECK would have said 23514', async () => {
    setTestUserId(USER)
    const { status, body } = await put(marketId, { breeding_system: 'open_pollinated', breeding_source: 'packet_label' })
    expect(status).toBe(400)
    expect(body.error).toBe(
      'Open-pollinated applies only to a single named variety, and this entry is recorded as a market class (a group of similar varieties).',
    )
    expect(await facts(marketId)).toMatchObject({ breeding_system: null, breeding_source: null, variety_rank: 'market_class' })
    await expect(directSql`
      UPDATE plant_varieties SET breeding_system = 'open_pollinated', breeding_source = 'packet_label' WHERE id = ${marketId}`)
      .rejects.toThrow(/chk_plant_varieties_op_requires_cultivar/)
  })

  it('open_pollinated on a row with no recorded rank is written, and the same UPDATE records it as a single named cultivar', async () => {
    setTestUserId(USER)
    // The raw-UPDATE counterpart, as in the market-class case: since v5-oprankchecknull-001 the CHECK
    // is NULL-safe, so writing Open-pollinated on an unranked row WITHOUT the fill is refused by the
    // database (BUG-OPRANKCHECKNULL-001; before it this raw write succeeded and left the rank blank).
    // The handler's fill is what lets the edit through, and the read-back below proves it wrote it.
    expect(await facts(varietyId)).toMatchObject({ breeding_system: 'unknown', variety_rank: null })
    await expect(directSql`
      UPDATE plant_varieties SET breeding_system = 'open_pollinated' WHERE id = ${varietyId}`)
      .rejects.toThrow(/chk_plant_varieties_op_requires_cultivar/)
    expect(await facts(varietyId)).toMatchObject({ breeding_system: 'unknown', variety_rank: null })
    const { status, body } = await put(varietyId, { breeding_system: 'open_pollinated' })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(await facts(varietyId)).toMatchObject({
      breeding_system: 'open_pollinated', breeding_source: 'grower_record', variety_rank: 'cultivar',
    })
  })

  // Dave's rule (2026-09-21): the fill is permanent. The row the case above filled is moved off
  // Open-pollinated three ways and then cleared; the rank reads back 'cultivar' after every step.
  it('the fill is permanent: switching Breeding away from Open-pollinated, or clearing it, leaves the rank cultivar', async () => {
    setTestUserId(USER)
    expect(await facts(varietyId)).toMatchObject({ breeding_system: 'open_pollinated', variety_rank: 'cultivar' })
    for (const edit of [
      { breeding_system: 'f1' }, { breeding_system: 'landrace' }, { breeding_system: 'unknown' },
      { clear: ['breeding_system'] },
    ]) {
      const { status, body } = await put(varietyId, edit)
      expect(status, `${JSON.stringify(edit)} -> ${JSON.stringify(body)}`).toBe(200)
      expect(await facts(varietyId), JSON.stringify(edit)).toMatchObject({
        breeding_system: edit.breeding_system ?? null, breeding_source: 'grower_record', variety_rank: 'cultivar',
      })
    }
  })

  it('open_pollinated and its source in ONE body on an unranked row: both are written, and the rank recorded', async () => {
    setTestUserId(USER)
    expect(await facts(unrankedId)).toEqual({
      origin_country: null, origin_region: null, breeding_system: null,
      breeding_source: null, scoville_source: null, variety_rank: null,
    })
    const { status, body } = await put(unrankedId, { breeding_system: 'open_pollinated', breeding_source: 'packet_label' })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(await facts(unrankedId)).toMatchObject({
      breeding_system: 'open_pollinated', breeding_source: 'packet_label', variety_rank: 'cultivar',
    })
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

  // The CHECK couples only open_pollinated to the rank, so the preflight must let every other call
  // through on every recorded rank, and the database must take it. One fresh row per rank.
  it.each(['market_class', 'blend', 'species', 'placeholder'])(
    'f1, landrace and unknown are each written on a %s row, and the rank is left alone',
    async (rank) => {
      setTestUserId(USER)
      const [{ id }] = await directSql`
        INSERT INTO plant_varieties (name, created_by, variety_rank)
        VALUES (${`facts-var-cell-${rank}-${RUN}`}, ${USER}, ${rank})
        RETURNING id`
      for (const system of ['f1', 'landrace', 'unknown']) {
        const { status, body } = await put(id, { breeding_system: system, breeding_source: 'breeder' })
        expect(status, `${system} on ${rank}: ${JSON.stringify(body)}`).toBe(200)
        expect(await facts(id), `${system} on ${rank}`).toMatchObject({
          breeding_system: system, breeding_source: 'breeder', variety_rank: rank,
        })
      }
    },
  )

  // The race path's premise. The handler's catch turns a 23514 into a sentence by err.constraint, and
  // the unit tests throw that shape by hand. This proves the real driver, through the same
  // sql.transaction call the PUT makes, reports both coupling CHECKs under that name. Both writes are
  // refused, so neither row changes.
  it('a CHECK refusal inside a transaction carries code 23514 and the constraint name', async () => {
    await expect(directSql.transaction([directSql`
      UPDATE plant_varieties SET breeding_system = 'open_pollinated', breeding_source = 'packet_label' WHERE id = ${marketId}`]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chk_plant_varieties_op_requires_cultivar' })
    await expect(directSql.transaction([directSql`
      UPDATE plant_varieties SET breeding_system = 'f1' WHERE id = ${foreignId}`]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chk_plant_varieties_breeding_sourced' })
  })

  // ...and the catch itself, end to end. A patch that passes every validator but not a CHECK the
  // preflight does not model (a Scoville minimum above the stored maximum) reaches the real catch, which
  // still names an unmapped constraint the way it always has. That exact text is only possible when
  // the driver hands the handler err.constraint, the field CONSTRAINT_MESSAGES is keyed by.
  it('an unmapped CHECK refusal still answers "Constraint violation: <name>", through the real catch', async () => {
    setTestUserId(USER)
    const [{ id }] = await directSql`
      INSERT INTO plant_varieties (name, created_by, scoville_min, scoville_max)
      VALUES (${'facts-var-heat-' + RUN}, ${USER}, 100, 200)
      RETURNING id`
    const { status, body } = await put(id, { scoville_min: 500 })
    expect(status).toBe(400)
    expect(body.error).toBe('Constraint violation: chk_plant_varieties_scoville')
    expect((await directSql`SELECT scoville_min FROM plant_varieties WHERE id = ${id}`)[0].scoville_min).toBe(100)
  })
})
