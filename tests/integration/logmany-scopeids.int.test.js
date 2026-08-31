// logmany-scopeids.int.test.js — V4-LOGMANYUXREFRESH-001 S4 / BD-073, against a real database.
//
// WHY THIS FILE EXISTS. S4 shipped `scope.type:'ids'`, the named→resolved count assertion, the 409
// that refuses the batch, and the COALESCE location the picker filters on. Its own lane report names
// the gap: `lambda/events/index.js` cannot be imported without a DB, so every one of those claims was
// proven from SOURCE TEXT (`lambda/events/logmany-scopeids.test.js`, 34 assertions). Source text
// cannot evaluate a predicate. The ids arm lives inside a CASE inside a WHERE that reads through the
// `garden_node`/`container` views, and the 409 is a comparison between a client-supplied list and
// whatever that predicate actually returns — the one thing a regex cannot check is whether those two
// sets agree. This file runs the SELECT.
//
// THE GUARD THAT MATTERS MOST is the count assertion, because its failure mode is SILENT. A user
// picks eight plantings, six resolve, six events are written, the card reads "✓ 6 plantings watered"
// and nothing anywhere says eight were asked for. Under-writing in silence is what BD-073 was filed
// about. So the arms below do not merely observe that a count differs — each one proves the request
// FAILS, with the status, the code, the two counts, the named ids, and a read-back proving the
// database holds nothing at all from that attempt.
//
// FIVE INDEPENDENT WAYS an id can fail to resolve, each asserted separately rather than as one
// "unresolvable" case: soft-deleted, archived, dormant-by-status, another household's, and a
// syntactically-valid uuid naming no row. They are separate WHERE terms in the resolver, so
// neutering any ONE of them must still leave this file red — a single case would let four
// regressions through.
//
// FIXTURES ARE CHOSEN OFF THE HAPPY PATH, deliberately (S4 lost two mutations to convenient
// fixtures). Specifically:
//   * `pLocOwn` carries BOTH a planting location and a project location, and they DIFFER — a fixture
//     where they matched would pass a REVERSED COALESCE.
//   * the picked set is a strict SUBSET of the eligible pool, so an ids arm that resolved to `true`
//     (behaving like scope 'all') fails rather than coincidentally agreeing.
//   * the uuid used for the case round-trip is asserted to CONTAIN A HEX LETTER before it is
//     upper-cased. S4's first pass had an all-digit uuid constant, which made `toUpperCase()` a no-op
//     and the case assertion unfailable.
//
// FIXTURE MAP (every planting `vegetative` unless noted; owner USER unless noted):
//
//   ZONE_L, ZONE_P             two distinct level-0 locations
//   projPlain (location NULL)  projZoned (location = ZONE_P)  projForeign (owner OTHER)
//
//   picked / eligible ─────────────────────────────────────────────────────────────────────
//   pLocOwn      projZoned  loc=ZONE_L  cultivar=cvCropped   COALESCE arm 1 (planting wins)
//   pLocProj     projZoned  loc=NULL    cultivar=cvCropped   COALESCE arm 2 (project fallback)
//   pLocNone     projPlain  loc=NULL    cultivar=cvCropped   COALESCE → NULL
//   pNoCultivar  projPlain  loc=NULL    cultivar=NULL        Ungrouped, mechanism A
//   pNullSlug    projPlain  loc=NULL    cultivar=cvNullSlug  Ungrouped, mechanism B
//   pBareBoth    NO PROJECT loc=NULL    cultivar=NULL        both LEFT JOINs miss at once
//
//   eligible but NOT picked ───────────────────────────────────────────────────────────────
//   pUnpicked    projPlain                                   proves the list NARROWS
//
//   cannot resolve — one per mechanism ────────────────────────────────────────────────────
//   pDeleted     deleted_at set          pArchived   archived_at set
//   pDormant     status='dormant'        pForeign    owner OTHER, no project
//   pForeignProj owner OTHER via projForeign         (+ GHOST_ID: a uuid naming no row)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'

const RUN = testRunId()
const USER = `user_int_scopeids_${RUN}`
const OTHER = `user_int_scopeids_other_${RUN}`

// A well-formed uuid that names no row. Hex letters throughout, for the same reason the fixture
// check below exists.
const GHOST_ID = 'deadbeef-face-4bad-8cab-feedfacecafe'

const CROP = `int-test-scopeids-crop-${Date.now()}`

let projPlain, projZoned, projForeign
let cvCropped, cvNullSlug
const LOC = {}
const P = {}

const mkLoc = async (key) => {
  const slug = `${key}-${RUN}`
  const rows = await directSql`
    INSERT INTO locations (name, slug, level, created_by)
    VALUES (${slug}, ${slug}, 0, ${USER}) RETURNING id`
  LOC[key] = rows[0].id
  return rows[0].id
}

const mkPlant = async (label, { project = null, location = null, cultivar = null,
                                owner = USER, status = 'vegetative' } = {}) => {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, status, location_id, variety_id, created_by)
    VALUES (${project}::uuid, ${label + '-' + RUN}, ${status}, ${location}::uuid, ${cultivar}::uuid, ${owner})
    RETURNING id`
  P[label] = rows[0].id
  return rows[0].id
}

beforeAll(async () => {
  setTestUserId(USER)

  await mkLoc('ZONE_L')
  await mkLoc('ZONE_P')

  await directSql`
    INSERT INTO crop_types (slug, display_name, default_unit)
    VALUES (${CROP}, 'Scope Ids Crop', 'count')`
  cvCropped = (await directSql`
    INSERT INTO plant_varieties (name, created_by, crop_type_slug)
    VALUES (${'scopeids-cv-' + RUN}, ${USER}, ${CROP}) RETURNING id`)[0].id
  // Mechanism B: a real cultivar that resolves to NO crop type. Distinct from "no cultivar at all"
  // because it exercises the pv LEFT JOIN succeeding and still yielding a null slug — prod carries
  // both shapes (3 with no cultivar_id, 3 resolving to no slug).
  cvNullSlug = (await directSql`
    INSERT INTO plant_varieties (name, created_by, crop_type_slug)
    VALUES (${'scopeids-cv-nullslug-' + RUN}, ${USER}, NULL) RETURNING id`)[0].id

  projPlain = (await insertProject({ name: 'int-scopeids-plain-' + RUN, createdBy: USER })).id
  projZoned = (await insertProject({ name: 'int-scopeids-zoned-' + RUN, createdBy: USER })).id
  projForeign = (await insertProject({ name: 'int-scopeids-foreign-' + RUN, createdBy: OTHER })).id
  await directSql`UPDATE plant_projects SET location_id = ${LOC.ZONE_P} WHERE id = ${projZoned}`

  await mkPlant('pLocOwn', { project: projZoned, location: LOC.ZONE_L, cultivar: cvCropped })
  await mkPlant('pLocProj', { project: projZoned, cultivar: cvCropped })
  await mkPlant('pLocNone', { project: projPlain, cultivar: cvCropped })
  await mkPlant('pNoCultivar', { project: projPlain })
  await mkPlant('pNullSlug', { project: projPlain, cultivar: cvNullSlug })
  await mkPlant('pBareBoth')
  await mkPlant('pUnpicked', { project: projPlain, cultivar: cvCropped })

  await mkPlant('pDeleted', { project: projPlain })
  await mkPlant('pArchived', { project: projPlain })
  await mkPlant('pDormant', { project: projPlain, status: 'dormant' })
  await mkPlant('pForeign', { owner: OTHER })
  await mkPlant('pForeignProj', { project: projForeign, owner: OTHER })

  // Applied AFTER creation: these are states a live planting transitions INTO between the moment the
  // picker rendered it and the moment the user taps Log, which is the whole reason the assertion is
  // named→resolved rather than a validation.
  await directSql`UPDATE plants SET deleted_at = NOW() WHERE id = ${P.pDeleted}`
  await directSql`UPDATE plants SET archived_at = NOW() WHERE id = ${P.pArchived}`
})

afterAll(async () => {
  for (const u of [USER, OTHER]) {
    await directSql`DELETE FROM xp_events WHERE user_id = ${u}`
    await directSql`DELETE FROM user_achievements WHERE user_id = ${u}`
    await directSql`DELETE FROM user_stats WHERE user_id = ${u}`
    await directSql`DELETE FROM app_events WHERE user_clerk_sub = ${u}`
    await directSql`DELETE FROM event_batches WHERE created_by = ${u}`
    await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${u})`
    await directSql`DELETE FROM entity_memory WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${u})`
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${u})`
    await directSql`DELETE FROM event_log WHERE created_by = ${u}`
    await directSql`DELETE FROM plants WHERE created_by = ${u}`
    await directSql`DELETE FROM plant_projects WHERE created_by = ${u}`
  }
  // `entity` FKs plant_varieties via cultivar_ref_id, and a cultivar entity row is minted for every
  // variety — so this must precede the varieties delete or it is an FK violation that aborts the
  // rest of this teardown, not a no-op. Same rule the planting-entity delete above follows.
  await directSql`DELETE FROM entity WHERE cultivar_ref_id IN (
    SELECT id FROM plant_varieties WHERE created_by = ${USER})`
  await directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`
  await directSql`DELETE FROM crop_types WHERE slug = ${CROP}`
  // locations LAST: plants.location_id and plant_projects.location_id both FK here.
  await directSql`DELETE FROM locations WHERE created_by = ${USER}`
})

let seq = 0
const post = (over = {}) => {
  setTestUserId(USER)
  return callHandler(eventsHandler, {
    method: 'POST', path: '/api/events/batch', userId: USER,
    body: {
      idempotency_key: `scopeids-${RUN}-${++seq}`,
      event_type: 'watering',
      ...over,
    },
  })
}
const byIds = (ids, over = {}) => post({ scope: { type: 'ids', plant_ids: ids }, ...over })
const label = (id) => Object.keys(P).find((k) => P[k] === id) ?? id
const labels = (ids) => ids.map(label).sort()

// The picked set: project-bearing and project-less, crop-typed and crop-type-less, located and not.
// A strict SUBSET of what `{type:'all'}` returns for this user — `pUnpicked` is the witness.
const PICKED = () => [P.pLocOwn, P.pLocProj, P.pLocNone, P.pNoCultivar, P.pNullSlug, P.pBareBoth]

const rowsOfBatch = (batchId) => directSql`
  SELECT plant_id, project_id, location_id FROM event_log
   WHERE metadata->>'batch_id' = ${batchId} AND deleted_at IS NULL`

// The "nothing was written" instrument. An EXACT set of event_log ids, not a count and not a
// created_at window: the first draft of this file bounded on `created_at > NOW() - INTERVAL '2
// seconds'` and the arms failed against a correct implementation, because the preceding tests in
// this file finish in well under two seconds and their rows fell inside the window. A time bound
// here measures how fast vitest is. `deleted_at` is deliberately NOT filtered — a write followed by
// a soft delete would otherwise read as no write at all.
const eventIds = async () => new Set(
  (await directSql`SELECT id FROM event_log WHERE created_by = ${USER}`).map((r) => r.id))

describe('the ids scope writes one event per PICKED planting, and only those', () => {
  it('the fixture is discriminating (instrument check, before anything is measured)', async () => {
    // A fixture that cannot fail a mutation is worse than no test. Four properties this file's
    // conclusions actually rest on, asserted rather than assumed:
    expect(LOC.ZONE_L).not.toBe(LOC.ZONE_P)              // else a reversed COALESCE passes
    expect(P.pLocOwn).toMatch(/[a-f]/)                   // else toUpperCase() below is a no-op
    // Postgres' uuid_out is canonically LOWER-case. Stated here because it is why the count
    // assertion carries TWO lower-casings — normalizeScopeIds' (load-bearing, the client side) and
    // `String(r.plant_id).toLowerCase()` in resolvedIdSet (defence in depth, unreachable while this
    // holds). MEASURED: neutering the second one alone leaves this file green, and no test can
    // honestly claim otherwise without a database that returns upper-case uuids.
    expect(P.pLocOwn).toBe(P.pLocOwn.toLowerCase())
    const all = await post({ scope: { type: 'all' }, dry_run: true })
    const eligible = all.body.plantings.map((p) => p.id)
    expect(eligible).toContain(P.pUnpicked)              // else "narrows" is unobservable
    for (const id of PICKED()) expect(eligible).toContain(id)
    expect(eligible.length).toBeGreaterThan(PICKED().length)
  })

  it('N picked ids write exactly N event_log rows, naming exactly those plantings', async () => {
    const { status, body } = await byIds(PICKED())
    expect(status).toBe(200)
    expect(body.count).toBe(PICKED().length)
    const rows = await rowsOfBatch(body.batch_id)
    // Row COUNT and row IDENTITY, separately. The count alone would pass a resolver that returned
    // six of the wrong plantings, which is the failure mode of binding the raw client array or of
    // matching on the wrong column.
    expect(rows).toHaveLength(PICKED().length)
    expect(labels(rows.map((r) => r.plant_id))).toEqual(labels(PICKED()))
    // …and the number the user reads equals the number that exists.
    expect(body.count).toBe(rows.length)
  })

  it('an eligible planting that was NOT picked gets nothing — the list NARROWS', async () => {
    // The arm that fails if `WHEN 'ids'` ever resolves to `true`: every other assertion in this file
    // would still pass, because everything picked would still be written.
    const { body } = await byIds(PICKED())
    const rows = await rowsOfBatch(body.batch_id)
    expect(rows.map((r) => r.plant_id)).not.toContain(P.pUnpicked)
    const n = await directSql`
      SELECT count(*)::int AS n FROM event_log WHERE plant_id = ${P.pUnpicked} AND deleted_at IS NULL`
    expect(n[0].n).toBe(0)
  })

  it('the dry run and the write resolve the SAME set', async () => {
    const dry = await byIds(PICKED(), { dry_run: true })
    expect(dry.status).toBe(200)
    expect(dry.body.count).toBe(PICKED().length)
    // No divergence, so the two additive S4 keys must be ABSENT — not present-and-empty. A client
    // that keys off their presence would otherwise render a warning for a clean batch.
    expect(dry.body).not.toHaveProperty('requested_count')
    expect(dry.body).not.toHaveProperty('unresolved_plant_ids')
    const wet = await byIds(PICKED())
    const rows = await rowsOfBatch(wet.body.batch_id)
    expect(labels(dry.body.plantings.map((p) => p.id))).toEqual(labels(rows.map((r) => r.plant_id)))
  })

  it('a client echoing UPPER-CASE uuids is not accused of naming missing plantings', async () => {
    // Postgres hands back canonical lower-case; the client may echo whatever case it was given.
    // Without normalizeScopeIds' lower-casing this is a 409 on a perfectly good batch — the count
    // assertion turned against the user. Non-vacuous only because pLocOwn contains a hex letter,
    // asserted above.
    const upper = PICKED().map((id) => id.toUpperCase())
    expect(upper).not.toEqual(PICKED())
    const { status, body } = await byIds(upper)
    expect(status).toBe(200)
    const rows = await rowsOfBatch(body.batch_id)
    expect(labels(rows.map((r) => r.plant_id))).toEqual(labels(PICKED()))
  })

  it('a repeated id is one planting, not two events', async () => {
    const { status, body } = await byIds([P.pLocOwn, P.pLocOwn, P.pLocProj])
    expect(status).toBe(200)
    expect(body.count).toBe(2)
    const rows = await rowsOfBatch(body.batch_id)
    expect(rows).toHaveLength(2)
  })

  it('a repeated id does not inflate the number the REFUSAL quotes back', async () => {
    // Where de-duplication is actually observable end to end. On a clean batch a duplicate is
    // invisible — `p.id = ANY(...)` returns one row per planting either way — so the arm above
    // passes with or without it. It only shows up in `requested_count` and in the sentence the user
    // reads: without the dedup, picking two plantings (one sent twice) and losing one produces
    // "1 of 3 picked plantings", and there is no third planting. MEASURED, not assumed: this file
    // was green against a non-deduping normalizeScopeIds until this case was added.
    const { status, body } = await byIds([P.pLocOwn, P.pLocOwn, P.pArchived])
    expect(status).toBe(409)
    expect(body.requested_count).toBe(2)
    expect(body.resolved_count).toBe(1)
    expect(body.error).toMatch(/^1 of 2 picked plantings/)
    expect(body.unresolved_plant_ids).toEqual([P.pArchived])
  })
})

describe('THE COUNT ASSERTION — an unresolvable pick fails LOUDLY, never quietly under-writes', () => {
  // One case per exclusion mechanism. Each is a separate WHERE term in the resolver, so any single
  // neutered term must still leave this describe block red.
  const cases = [
    ['soft-deleted', () => P.pDeleted],
    ['archived', () => P.pArchived],
    ['dormant by status', () => P.pDormant],
    ["another household's, project-less", () => P.pForeign],
    ["another household's, via their project", () => P.pForeignProj],
    ['a uuid naming no row at all', () => GHOST_ID],
  ]

  for (const [name, idOf] of cases) {
    it(`refuses the whole batch when a pick is ${name}`, async () => {
      const bad = idOf()
      const picked = [...PICKED(), bad]
      const { status, body } = await byIds(picked)

      expect(status).toBe(409)
      expect(body.code).toBe('SCOPE_IDS_UNRESOLVED')
      expect(body.requested_count).toBe(picked.length)
      expect(body.resolved_count).toBe(PICKED().length)
      expect(body.unresolved_plant_ids).toEqual([bad])
      // The sentence the user reads must name both numbers and say nothing happened, because the
      // count on the success card would otherwise have been the only number on screen.
      expect(body.error).toMatch(/1 of 7 picked plantings/)
      expect(body.error).toMatch(/nothing was logged/)
    })
  }

  it('NOTHING is written — not the events, not the batch row, not the care caches', async () => {
    // The assertion the ticket is about. "It returned 409" is not the claim; "the database is
    // untouched" is. Counted across the whole user, not scoped to a batch id, because a partial
    // write would have a batch id this test does not know.
    const before = await eventIds()
    const memBefore = await directSql`
      SELECT plant_id, last_event_at FROM entity_memory
       WHERE plant_id = ANY(${PICKED()}) ORDER BY plant_id`
    const key = `scopeids-${RUN}-refuse`
    setTestUserId(USER)
    const { status } = await callHandler(eventsHandler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: {
        idempotency_key: key, event_type: 'watering',
        scope: { type: 'ids', plant_ids: [...PICKED(), P.pArchived] },
      },
    })
    expect(status).toBe(409)

    // Not "the count is the same" — the SAME ROWS. A partial write scoped to the resolvable subset
    // would carry a batch id this test does not know, so a batch-scoped read could not see it.
    const after = await eventIds()
    expect(after.size).toBe(before.size)
    for (const id of after) expect(before.has(id), `event_log row ${id} appeared`).toBe(true)

    const batch = await directSql`SELECT id FROM event_batches WHERE idempotency_key = ${key}`
    expect(batch).toHaveLength(0)
    // The care caches are the third thing the transaction touches, and the one that would survive a
    // half-rolled-back attempt. Byte-compared, because `last_event_at` moving is exactly what a
    // partial run looks like from here.
    const memAfter = await directSql`
      SELECT plant_id, last_event_at FROM entity_memory
       WHERE plant_id = ANY(${PICKED()}) ORDER BY plant_id`
    expect(memAfter).toEqual(memBefore)
  })

  it('a planting that goes stale BETWEEN the preview and the commit is caught', async () => {
    // The race the whole design exists for, run for real rather than reasoned about. The picker
    // previews a live planting, the other household member archives it, the user taps Log. The
    // complement model could not express this at all: it sent 236 exclusions, so the server would
    // simply have resolved one planting fewer and reported success.
    const fresh = await mkPlant('pRace', { project: projPlain, cultivar: cvCropped })
    const picked = [P.pLocOwn, fresh]

    const dry = await byIds(picked, { dry_run: true })
    expect(dry.status).toBe(200)
    expect(dry.body.count).toBe(2)
    expect(dry.body.plantings.map((p) => p.id)).toContain(fresh)

    await directSql`UPDATE plants SET archived_at = NOW() WHERE id = ${fresh}`

    const before = await eventIds()
    const wet = await byIds(picked)
    expect(wet.status).toBe(409)
    expect(wet.body.unresolved_plant_ids).toEqual([fresh])
    expect(wet.body.resolved_count).toBe(1)
    // and the survivor was NOT logged on its own — refusal, not partial success.
    const after = await eventIds()
    expect(after.size).toBe(before.size)
  })

  it('every named id gone is still the SPECIFIC 409, not the generic "no plantings matched"', async () => {
    // Ordering, against a real resolver: with plantIds empty, the generic 400 sits one line below
    // and would otherwise win. "No plantings matched the scope" for a list the user can see on
    // screen reads as "your garden is empty", which is a different and wrong diagnosis.
    const { status, body } = await byIds([P.pArchived, P.pDeleted])
    expect(status).toBe(409)
    expect(body.code).toBe('SCOPE_IDS_UNRESOLVED')
    expect(body.resolved_count).toBe(0)
    expect(body.error).not.toMatch(/No plantings matched/)
  })

  it('the DRY RUN reports the divergence instead of failing on it', async () => {
    // A preview must preview: 409-ing here would blank the picker at the moment the user needs to
    // see which of their picks survived.
    const { status, body } = await byIds([...PICKED(), P.pArchived], { dry_run: true })
    expect(status).toBe(200)
    expect(body.count).toBe(PICKED().length)
    expect(body.requested_count).toBe(PICKED().length + 1)
    expect(body.unresolved_plant_ids).toEqual([P.pArchived])
    expect(body.plantings.map((p) => p.id)).not.toContain(P.pArchived)
  })

  it('the refusal is per-request — a corrected re-pick goes straight through', async () => {
    // The 409 must not be sticky. Nothing was written, so nothing needs undoing, and the retry is
    // an ordinary batch.
    const bad = await byIds([...PICKED(), P.pDormant])
    expect(bad.status).toBe(409)
    const good = await byIds(PICKED())
    expect(good.status).toBe(200)
    expect(good.body.count).toBe(PICKED().length)
  })
})

describe('COALESCE(p.location_id, pp.location_id) — the fallback ORDER, on real rows', () => {
  const locOf = async (id) => {
    const { body } = await byIds(PICKED(), { dry_run: true })
    return body.plantings.find((p) => p.id === id)
  }

  it("the PLANTING's own location wins over its project's", async () => {
    // pLocOwn sits in projZoned (ZONE_P) but is filed at ZONE_L. A reversed COALESCE returns ZONE_P
    // here and passes every other arm in this file — which is why the fixture sets BOTH.
    const row = await locOf(P.pLocOwn)
    expect(row.location_id).toBe(LOC.ZONE_L)
    expect(row.location_id).not.toBe(LOC.ZONE_P)
  })

  it("a planting with no location of its own falls back to its project's", async () => {
    const row = await locOf(P.pLocProj)
    expect(row.location_id).toBe(LOC.ZONE_P)
  })

  it('neither location present arrives as an EXPLICIT null, never an absent key', async () => {
    const row = await locOf(P.pLocNone)
    expect(row).toHaveProperty('location_id')
    expect(row.location_id).toBeNull()
  })

  it('the preview agrees with what the SPACE scope resolves — one expression, two callers', async () => {
    // S4's stated reason for copying the expression rather than choosing one: the client filters the
    // picker on this value, so if the two disagreed, "filter to a zone" and "scope to that zone"
    // would return different sets on the same screen. Only a real resolver can compare them.
    const inL = await post({ scope: { type: 'space', location_id: LOC.ZONE_L }, dry_run: true })
    const inP = await post({ scope: { type: 'space', location_id: LOC.ZONE_P }, dry_run: true })
    expect(inL.body.plantings.map((p) => p.id)).toContain(P.pLocOwn)
    expect(inP.body.plantings.map((p) => p.id)).not.toContain(P.pLocOwn)
    expect(inP.body.plantings.map((p) => p.id)).toContain(P.pLocProj)

    // …and stated as the general rule rather than two coincidences: for every planting the space
    // scope returns for a zone, the ids preview reports that same zone as its location.
    const preview = (await byIds(PICKED(), { dry_run: true })).body.plantings
    for (const [zone, res] of [[LOC.ZONE_L, inL], [LOC.ZONE_P, inP]]) {
      for (const p of res.body.plantings) {
        const mine = preview.find((r) => r.id === p.id)
        if (mine) expect(mine.location_id, `${label(p.id)} in zone ${zone}`).toBe(zone)
      }
    }
  })
})

describe('crop-type-less plantings survive the ids scope (the Ungrouped three)', () => {
  it('a planting with NO cultivar is previewed with an explicit null slug and is WRITTEN', async () => {
    const dry = await byIds(PICKED(), { dry_run: true })
    const row = dry.body.plantings.find((p) => p.id === P.pNoCultivar)
    expect(row).toBeDefined()
    expect(row).toHaveProperty('crop_type_slug')
    expect(row.crop_type_slug).toBeNull()

    const wet = await byIds(PICKED())
    const rows = await rowsOfBatch(wet.body.batch_id)
    expect(rows.map((r) => r.plant_id)).toContain(P.pNoCultivar)
  })

  it('a cultivar that resolves to NO crop type is the same story — the other mechanism', async () => {
    const dry = await byIds(PICKED(), { dry_run: true })
    expect(dry.body.plantings.find((p) => p.id === P.pNullSlug).crop_type_slug).toBeNull()
    const wet = await byIds(PICKED())
    expect((await rowsOfBatch(wet.body.batch_id)).map((r) => r.plant_id)).toContain(P.pNullSlug)
  })

  it('the control: a crop-typed planting DOES name its slug', async () => {
    // Without this, every assertion above would pass against a projection that dropped
    // crop_type_slug entirely and returned null for everyone.
    const dry = await byIds(PICKED(), { dry_run: true })
    expect(dry.body.plantings.find((p) => p.id === P.pLocOwn).crop_type_slug).toBe(CROP)
  })

  it('a planting that is BOTH project-less and crop-type-less clears both LEFT JOINs at once', async () => {
    // The double miss: `container` finds nothing AND `plant_varieties` finds nothing on the same
    // row. Either join turning INNER deletes it from the batch silently — the
    // BUG-LOGMANYPROJECTLESS-001 class, twice over.
    const wet = await byIds(PICKED())
    expect(wet.status).toBe(200)
    const rows = await rowsOfBatch(wet.body.batch_id)
    const mine = rows.find((r) => r.plant_id === P.pBareBoth)
    expect(mine, 'the project-less, crop-type-less planting must be written').toBeDefined()
    expect(mine.project_id).toBeNull()
    // …and the count assertion agrees, which is the point: dropping it would have been a 409, not a
    // silent five-of-six.
    expect(wet.body.count).toBe(PICKED().length)
  })

  it('every picked planting reaches the preview with BOTH S4 keys present', async () => {
    const { body } = await byIds(PICKED(), { dry_run: true })
    expect(body.plantings).toHaveLength(PICKED().length)
    for (const row of body.plantings) {
      expect(row, `${label(row.id)} crop_type_slug`).toHaveProperty('crop_type_slug')
      expect(row, `${label(row.id)} location_id`).toHaveProperty('location_id')
    }
  })
})

describe('the ids scope cannot be turned into a client-supplied plant list', () => {
  it('exclude_plant_ids alongside an id scope is refused at the route, not reconciled', async () => {
    const before = await eventIds()
    const { status, body } = await post({
      scope: { type: 'ids', plant_ids: PICKED() },
      exclude_plant_ids: [P.pLocOwn],
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/exclude_plant_ids cannot be combined/)
    const after = await eventIds()
    expect(after.size).toBe(before.size)
  })

  it('an empty id list is a 400, never a silent no-op', async () => {
    const { status, body } = await byIds([])
    expect(status).toBe(400)
    expect(body.error).toMatch(/non-empty array/)
  })
})
