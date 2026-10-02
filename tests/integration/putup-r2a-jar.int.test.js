// Put-Up R2a (lane S) — the jar PATCH's where-from pair, the create's photo and planting rules, and the
// line search's two new planting fields, on real Postgres.
//
// The unit lane proves what each route SENDS (lambda/preservation/jarRoutes.test.js, lineSearch.test.js).
// Under its mock no SQL runs, so this file is where:
//   * the PATCH's two new SET lines and the four columns loadJar now reads meet the real table, and the
//     rule the validator applies is shown to be the rule chk_preservation_log_source_plant enforces;
//   * a create that carries photo_id is exercised at all (no smoke block can send one: it needs an
//     uploaded photo), and one that names a planting with a non-garden source is refused;
//   * gn.succession_order and gn.sown_at come back from the planting arm with the values and types the
//     planting chooser's projection (GET /api/plants?view=picker) sends for the same plantings.
//
// DAVE + JEN one household, STRANGER outside. Fixtures are _kitchenF.js's.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, setTestUserId, insertProject } from './_harness.js'
import {
  makeHousehold, useHousehold, call, key, errOf, seedJar, seedPlanting, seedHarvest, CROP,
} from './_kitchenF.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'

const H = makeHousehold('r2a-jar')
const { DAVE, JEN, STRANGER } = H
useHousehold(H, beforeAll, afterAll)

const sourceOf = async (id) => (await directSql`
  SELECT source_kind, source_label, plant_id, harvest_log_id FROM preservation_log WHERE id = ${id}`)[0]
const patch = (userId, id, body) => call(userId, 'PATCH', `/api/preservation/${id}`, body)

describe('PATCH /api/preservation/:id — where it\'s from, against the STORED planting and harvest link', () => {
  let planting

  beforeAll(async () => { planting = await seedPlanting(DAVE, { name: 'r2a jar planting' }) })

  it('a planting-linked jar: a non-garden source → 400 in the validator\'s words, nothing written; the real CHECK refuses the same row', async () => {
    const jar = await seedJar(DAVE, { plantId: planting.plantId, sourceKind: 'own_garden' })
    const before = await sourceOf(jar)
    const res = await patch(DAVE, jar, { source_kind: 'store', source_label: 'Kroger' })
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe('clear the planting before recording a non-garden source')
    expect(await sourceOf(jar)).toEqual(before)
    // The database holds the same rule (chk_preservation_log_source_plant): what the validator refuses
    // could never have been stored, so the two cannot drift into a row that says both.
    const e = await errOf(() => directSql`UPDATE preservation_log SET source_kind = 'store', source_label = 'Kroger' WHERE id = ${jar}`)
    expect(e).toMatchObject({ code: '23514', constraint: 'chk_preservation_log_source_plant' })
    expect(await sourceOf(jar)).toEqual(before)
  })

  it('a planting-linked jar: our garden saves with no name; `null, null` un-chooses', async () => {
    const jar = await seedJar(DAVE, { plantId: planting.plantId })
    const garden = await patch(DAVE, jar, { source_kind: 'own_garden', source_label: 'the back bed' })
    expect(garden.status, JSON.stringify(garden.body)).toBe(200)
    expect(garden.body).toMatchObject({ id: jar, source_kind: 'own_garden', source_label: null, plant_id: planting.plantId })
    expect(await sourceOf(jar)).toMatchObject({ source_kind: 'own_garden', source_label: null })
    const cleared = await patch(DAVE, jar, { source_kind: null, source_label: null })
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
    expect(await sourceOf(jar)).toMatchObject({ source_kind: null, source_label: null, plant_id: planting.plantId })
  })

  it('a harvest-linked jar: a non-garden source → 400 (the validator is the only guard: no CHECK is behind this one)', async () => {
    const harvest = await seedHarvest(DAVE, planting)
    const jar = await seedJar(DAVE)
    await directSql`UPDATE preservation_log SET harvest_log_id = ${harvest} WHERE id = ${jar}`
    const res = await patch(DAVE, jar, { source_kind: 'farm_stand', source_label: null })
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe('clear the harvest link before recording a non-garden source')
    expect(await sourceOf(jar)).toMatchObject({ source_kind: null, source_label: null, harvest_log_id: harvest })
  })

  it('a jar with no planting and no pick: every non-garden kind stores, the name trimmed; garden then clears the name', async () => {
    const jar = await seedJar(DAVE)
    for (const kind of ['u_pick', 'farm_stand', 'csa', 'store', 'gift', 'foraged', 'other']) {
      const res = await patch(DAVE, jar, { source_kind: kind, source_label: `  r2a ${kind}  ` })
      expect(res.status, `${kind}: ${JSON.stringify(res.body)}`).toBe(200)
      expect(res.body).toMatchObject({ source_kind: kind, source_label: `r2a ${kind}` })
      expect(await sourceOf(jar)).toMatchObject({ source_kind: kind, source_label: `r2a ${kind}` })
    }
    const garden = await patch(DAVE, jar, { source_kind: 'own_garden', source_label: null })
    expect(garden.status).toBe(200)
    expect(await sourceOf(jar)).toMatchObject({ source_kind: 'own_garden', source_label: null })
  })

  it('one of the pair alone, Other with no name, and a name with no kind are each a 400 that writes nothing', async () => {
    const jar = await seedJar(DAVE, { sourceKind: 'store', sourceLabel: 'Kroger' })
    for (const [body, words] of [
      [{ source_kind: 'gift' }, /source_kind and source_label are edited together/],
      [{ source_label: 'Aunt May' }, /source_kind and source_label are edited together/],
      [{ source_kind: 'other', source_label: ' ' }, /source_label is required when source_kind is 'other'/],
      [{ source_kind: null, source_label: 'Aunt May' }, /source_label needs a source_kind/],
    ]) {
      const res = await patch(DAVE, jar, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error).toMatch(words)
    }
    expect(await sourceOf(jar)).toMatchObject({ source_kind: 'store', source_label: 'Kroger' })
  })

  it('a household peer may correct it; a stranger gets 404 and the row is untouched', async () => {
    const jar = await seedJar(DAVE)
    const peer = await patch(JEN, jar, { source_kind: 'gift', source_label: 'Aunt May' })
    expect(peer.status, JSON.stringify(peer.body)).toBe(200)
    const out = await patch(STRANGER, jar, { source_kind: 'store', source_label: 'hijack' })
    expect(out.status).toBe(404)
    expect(await sourceOf(jar)).toMatchObject({ source_kind: 'gift', source_label: 'Aunt May' })
  })
})

describe('POST /api/preservation — a photo and a planting on the create (no smoke block can send either)', () => {
  const body = (over = {}) => ({
    idempotency_key: key(), label: `r2a jar create ${H.RUN}`, method: 'whole_freeze',
    preserved_at: '2026-10-01', preserved_at_precision: 'day', preserved_at_approx: false, package_count: 1, ...over,
  })
  const photoOf = async (owner) => {
    const proj = await insertProject({ name: `r2a-jar-photo-${owner}`, createdBy: owner })
    const [ph] = await directSql`
      INSERT INTO photos (project_id, storage_path, uploaded_by, created_by)
      VALUES (${proj.id}, ${`int/r2a-jar/${owner}.jpg`}, ${owner}, ${owner}) RETURNING id`
    return ph.id
  }

  it('photo_id: the household\'s own photo is stored on the row', async () => {
    const photo = await photoOf(DAVE)
    const res = await call(DAVE, 'POST', '/api/preservation', body({ photo_id: photo }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const [row] = await directSql`SELECT photo_id FROM preservation_log WHERE id = ${res.body.id}`
    expect(row.photo_id).toBe(photo)
  })

  it('photo_id: a photo from outside the household → 400, no row written', async () => {
    const theirs = await photoOf(STRANGER)
    const sent = body({ photo_id: theirs })
    const res = await call(DAVE, 'POST', '/api/preservation', sent)
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe('photo_id does not match a photo you can use')
    const rows = await directSql`SELECT id FROM preservation_log WHERE idempotency_key = ${sent.idempotency_key}::uuid`
    expect(rows).toEqual([])
  })

  it('plant_id: our garden is stored with no name; a farm stand on a planting → 400, no row written', async () => {
    const planting = await seedPlanting(DAVE, { name: 'r2a create planting' })
    const ok = await call(DAVE, 'POST', '/api/preservation', body({
      crop_type_slug: CROP, plant_id: planting.plantId, source_kind: 'own_garden', source_label: 'ignored',
    }))
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(await sourceOf(ok.body.id)).toMatchObject({ source_kind: 'own_garden', source_label: null, plant_id: planting.plantId })

    const sent = body({ crop_type_slug: CROP, plant_id: planting.plantId, source_kind: 'farm_stand', source_label: 'Hill farm' })
    const bad = await call(DAVE, 'POST', '/api/preservation', sent)
    expect(bad.status, JSON.stringify(bad.body)).toBe(400)
    expect(bad.body.error).toBe('clear the planting before recording a non-garden source')
    const rows = await directSql`SELECT id FROM preservation_log WHERE idempotency_key = ${sent.idempotency_key}::uuid`
    expect(rows).toEqual([])
  })
})

describe('GET /api/kitchen-batches/line-search — a planting carries its wave and sown date (contract 6)', () => {
  // Two plantings with ONE name: the case the two fields exist for. A third has neither.
  const NAME = `r2a wave ${H.RUN}`
  let first
  let second
  let bare

  beforeAll(async () => {
    const mk = async (sownAt, order) => (await directSql`
      INSERT INTO plants (name, created_by, sown_at, succession_order)
      VALUES (${NAME}, ${DAVE}, ${sownAt}::date, ${order}::int) RETURNING id`)[0].id
    first = await mk('2026-04-01', 1)
    second = await mk('2026-05-15', 2)
    bare = await mk(null, null)
  })

  it('succession_order and sown_at are on each planting and each planting hit, as the planting chooser sends them', async () => {
    const res = await call(DAVE, 'GET', `/api/kitchen-batches/line-search?q=${encodeURIComponent(NAME)}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const byId = Object.fromEntries(res.body.plantings.map((p) => [p.plant_id, p]))
    expect(Object.keys(byId).sort()).toEqual([first, second, bare].sort())

    expect(byId[first].succession_order).toBe(1)
    expect(byId[second].succession_order).toBe(2)
    expect(byId[bare]).toMatchObject({ succession_order: null, sown_at: null })
    // A whole number, not the text of one.
    expect(Number.isInteger(byId[first].succession_order)).toBe(true)
    expect(String(byId[first].sown_at).slice(0, 10)).toBe('2026-04-01')
    expect(String(byId[second].sown_at).slice(0, 10)).toBe('2026-05-15')

    // The same values and types GET /api/plants?view=picker sends for the same plantings: that is the
    // whole contract, and it is what lets the door call plantingWaveLabel unchanged.
    setTestUserId(DAVE)
    const picker = await callHandler(plantsHandler, { method: 'GET', path: '/api/plants?view=picker', userId: DAVE })
    expect(picker.status).toBe(200)
    for (const id of [first, second, bare]) {
      const chosen = picker.body.find((p) => p.id === id)
      expect(chosen, `the chooser does not list ${id}`).toBeTruthy()
      expect({ succession_order: byId[id].succession_order, sown_at: byId[id].sown_at })
        .toEqual({ succession_order: chosen.succession_order, sown_at: chosen.sown_at })
    }

    // rankHits spreads the row: the hits carry the two keys too, and every key the arm had before.
    const hits = res.body.hits.filter((h) => h.kind === 'planting')
    expect(hits.map((h) => h.plant_id).sort()).toEqual([first, second, bare].sort())
    for (const h of hits) {
      expect(h).toMatchObject({ succession_order: byId[h.plant_id].succession_order, sown_at: byId[h.plant_id].sown_at })
      for (const k of ['plant_id', 'label', 'crop_type_slug', 'variety_id', 'variety_name', 'status', 'ended', 'recent_at', 'recent_picks', 'key', 'tier', 'group']) {
        expect(h, k).toHaveProperty(k)
      }
    }
  })

  it('a stranger\'s search finds none of them', async () => {
    const res = await call(STRANGER, 'GET', `/api/kitchen-batches/line-search?q=${encodeURIComponent(NAME)}`)
    expect(res.status).toBe(200)
    expect(res.body.plantings).toEqual([])
  })
})
