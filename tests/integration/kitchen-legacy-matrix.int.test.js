// kitchen-legacy-matrix.int.test.js — V5-FERMENTPATH-001, the non-vacuous N−1 matrix (06-ferment-path §5.2
// "kitchen-legacy-matrix", RIA-I1, QA-I10; §1.3 item 6's quartet; contract-F.md §2.6). Lane L4.
//
// THE QUESTION: when F's Lambda and schema are live, does every call the SHIPPED (1a) bundle makes still get
// the answer it expects — on the four new states F creates? Rows = the shipped call sites, sent exactly as
// the 1a client sends them (the legacy PUT body is buildFullPayload's nineteen keys, built from the row the
// GET returned). Columns = (a) a jar with delta_at set (drawn), (b) a weighed jar with remaining_amount set,
// (c) a batch with a 'produce' salt line, (d) a soft-deleted line. Each cell asserts its named outcome AND
// the rows written, read back with directSql.
//
//   PutUp.jsx:739    DELETE /api/preservation/:id           (undo the last save)
//   PutUp.jsx:1020   GET whats-put-up?group=crop
//   PutUp.jsx:1560   POST /api/preservation                  (1a body)
//   PutUp.jsx:2436   GET whats-put-up?group=<storage|planting>
//   PutUp.jsx:2583   PUT /api/preservation/:id              (buildFullPayload: Mark used, Used up, RowEditor)
//   PutUp.jsx:2601   DELETE /api/preservation/:id           (row remove)
//   PutUp.jsx:342/379/401  GET /api/kitchen-batches?state= and /:id  (BatchInputsField:180 reads /:id too)
//   JarPicker.jsx:78 GET whats-put-up?group=crop
//   PutUpFromPlanting.jsx:74  GET whats-put-up?plant_id=&include_consumed=1
//   PutUpUseSoonBand.jsx:64   GET use-soon
//   BatchInputsField "Take it out" (1a)  DELETE /api/kitchen-batches/:id/inputs/:lineId
//
// THE NOTE RULE (1b §5.4, contract-F §2.6; integrator ruling 2026-09-29): the legacy PUT no longer writes
// notes, place, discard-by or method. A CHANGED value is 409 client_stale from any bundle; an unchanged echo
// is a 200 content no-op. The F bundle edits a note (and the size and count) through PATCH /api/preservation/:id.
//
// Cells whose outcome is the SAME before and after F run today (the states are seeded by SQL on the F fork),
// so they pin the N−1 contract against the current Lambda now. Cells whose outcome F changes are gated on
// the route that changes it (_kitchenF.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql } from './_harness.js'
import {
  makeHousehold, useHousehold, routeProbeReport, landed, call, key,
  seedBatch, seedJar, seedLine, seedPlace, seedPlanting, readJar, usesOf,
} from './_kitchenF.js'
import { describeRefusal, CLIENT_STALE_TEXT } from '../../src/lib/putUpErrors.js'

const H = makeHousehold('legacy')
const { DAVE, JEN, STRANGER } = H
useHousehold(H, beforeAll, afterAll)

routeProbeReport(it, expect, 'kitchen-legacy-matrix', [
  'legacyDeltaRef', 'pantryUses', 'draws', 'keyedLines', 'lineRestore', 'getBatchF3', 'jarPatch',
])

// PutUp.jsx:2531 buildFullPayload, verbatim in shape. The F bundle drops remaining_count and consumed_at (§1.3.3).
const PAYLOAD_KEYS = ['crop_type_slug', 'variety_id', 'plant_id', 'harvest_log_id', 'preserved_at', 'preserved_at_approx',
  'method', 'method_other_text', 'quantity_value', 'quantity_unit', 'package_count', 'storage_location_id',
  'use_by_target', 'remaining_count', 'consumed_at', 'notes', 'photo_id', 'source_kind', 'source_label']
async function fullPayload(user, jarId, bundle, overrides = {}) {
  const g = await call(user, 'GET', `/api/preservation/${jarId}`)
  expect(g.status, 'the GET the client builds its PUT from').toBe(200)
  const rec = g.body
  const out = {}
  for (const k of PAYLOAD_KEYS) out[k] = rec[k] ?? null
  out.method = rec.method
  out.quantity_value = rec.quantity_value
  out.quantity_unit = rec.quantity_unit
  out.package_count = rec.package_count ?? 1
  Object.assign(out, overrides)
  if (bundle === 'F') { delete out.remaining_count; delete out.consumed_at }
  return out
}
const put = async (user, jarId, bundle, overrides) =>
  call(user, 'PUT', `/api/preservation/${jarId}`, await fullPayload(user, jarId, bundle, overrides))

async function snap(jarId) {
  const [r] = await directSql`
    SELECT package_count, remaining_count, remaining_amount, consumed_at, delta_at, deleted_at, notes, updated_at
    FROM preservation_log WHERE id = ${jarId}`
  return r
}
// Everything a PUT could change except updated_at, which every matched PUT stamps (an echo is a content no-op).
async function content(jarId) {
  const [r] = await directSql`
    SELECT crop_type_slug, variety_id, plant_id, harvest_log_id, preserved_at, preserved_at_approx, method,
           method_other_text, quantity_value, quantity_unit, package_count, storage_location_id, use_by_target,
           remaining_count, remaining_amount, consumed_at, delta_at, notes, photo_id, source_kind, source_label, deleted_at
    FROM preservation_log WHERE id = ${jarId}`
  return r
}
// The 1b/F legacy-PUT refusal, as the server sends it and as the shipped client words it (putUpErrors.js):
// the refresh door, never an automatic reload.
function expectClientStale(r) {
  expect(r.status).toBe(409)
  expect(r.body).toMatchObject({ code: 'client_stale', error: 'This jar just changed. Refresh and try again.' })
  expect(describeRefusal({ body: r.body })).toEqual({ code: 'client_stale', text: CLIENT_STALE_TEXT, refresh: true })
}
const patchJar = (user, jarId, body) => call(user, 'PATCH', `/api/preservation/${jarId}`, body)
const recordsOf = (body) => (body.groups ? body.groups.flatMap((g) => g.records) : body.items ?? [])

// ── the states ────────────────────────────────────────────────────────────────────────────────────
let place, planting
const S = {}
beforeAll(async () => {
  place = await seedPlace(DAVE)
  planting = await seedPlanting(DAVE, { name: 'kf-legacy' })
  // (a) drawn: delta_at set, as a counted draw leaves it (remaining 4 of 5), with its line + forward use.
  S.batchA = (await seedBatch(DAVE)).id
  S.a = await seedJar(DAVE, { count: 5, remaining: 4, deltaAt: true, useByInDays: 2, plantId: planting.plantId })
  S.aLine = await seedLine(DAVE, S.batchA, { kind: 'put_up', jarId: S.a })
  await directSql`
    INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id)
    VALUES (${DAVE}, ${S.a}, 1, 'batch', ${S.aLine})`
  // (b) weighed, 92 g left of 100 (a gram draw stamps no delta_at).
  S.b = await seedJar(DAVE, { weighed: true, remainingAmount: 92, useByInDays: 2, plantId: planting.plantId })
  // (c) a batch whose salt line is based on 'produce' (the F-widened value 1a never wrote).
  S.batchC = (await seedBatch(DAVE)).id
  await directSql`
    INSERT INTO kitchen_batch_input (batch_id, input_kind, label, qty, qty_unit, created_by)
    VALUES (${S.batchC}, 'other', 'cabbage', 1000, 'g', ${DAVE})`
  ;[{ id: S.cSalt }] = await directSql`
    INSERT INTO kitchen_batch_input (batch_id, input_kind, label, role, qty, qty_unit, salt_pct, salt_base, base_g, salt_method, base_from, created_by)
    VALUES (${S.batchC}, 'other', 'Salt', 'salt', 20, 'g', 2, 'produce', 1000, 'dry', 'lines', ${DAVE}) RETURNING id`
  // (d) a soft-deleted line on an open batch.
  S.batchD = (await seedBatch(DAVE)).id
  S.dLive = await seedLine(DAVE, S.batchD, { label: 'kf live carrot', qty: 150, unit: 'g' })
  ;[{ id: S.dOut }] = await directSql`
    INSERT INTO kitchen_batch_input (batch_id, input_kind, label, qty, qty_unit, created_by, deleted_at)
    VALUES (${S.batchD}, 'other', 'kf taken out', 10, 'g', ${DAVE}, now()) RETURNING id`
  // control: undrawn counted jar.
  S.u = await seedJar(DAVE, { count: 3, useByInDays: 2 })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// READS — shipped keys unchanged on every new state (runs today); F's additive keys gated.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('reads the 1a bundle makes, on states (a) drawn and (b) weighed — 200, listed, shipped keys intact', () => {
  const READS = [
    ['PutUp.jsx:1020 / JarPicker.jsx:78', () => '/api/preservation/whats-put-up?group=crop'],
    ['PutUp.jsx:2436 (storage)', () => '/api/preservation/whats-put-up?group=storage'],
    ['PutUp.jsx:2436 (planting)', () => '/api/preservation/whats-put-up?group=planting'],
    ['PutUpFromPlanting.jsx:74', () => `/api/preservation/whats-put-up?plant_id=${planting.plantId}&include_consumed=1`],
    ['PutUpUseSoonBand.jsx:64', () => '/api/preservation/use-soon'],
  ]
  it.each(READS)('%s — DAVE and JEN 200 with (a) and (b) listed; STRANGER sees neither', async (_site, path) => {
    for (const user of [DAVE, JEN]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call(user, 'GET', path())
      expect(r.status).toBe(200)
      const recs = recordsOf(r.body)
      for (const id of [S.a, S.b]) {
        const rec = recs.find((x) => x.id === id)
        expect(rec, `${id} listed`).toBeTruthy()
        for (const k of ['id', 'method', 'package_count', 'remaining_count', 'preserved_at', 'use_by_target']) expect(rec).toHaveProperty(k)
      }
    }
    const s = await call(STRANGER, 'GET', path())
    expect(recordsOf(s.body).some((x) => x.id === S.a || x.id === S.b)).toBe(false)
  })

  it.skipIf(!landed('draws'))('F additive keys: (b) carries remaining_amount 92 and stock_mode weighed; (a) stock_mode counted', async () => {
    const r = await call(DAVE, 'GET', '/api/preservation/whats-put-up?group=crop')
    const recs = recordsOf(r.body)
    expect(recs.find((x) => x.id === S.b)).toMatchObject({ stock_mode: 'weighed' })
    expect(Number(recs.find((x) => x.id === S.b).remaining_amount)).toBe(92)
    expect(recs.find((x) => x.id === S.a)).toMatchObject({ stock_mode: 'counted' })
    const u = await call(DAVE, 'GET', '/api/preservation/use-soon')
    expect(recordsOf(u.body).find((x) => x.id === S.b)).toMatchObject({ stock_mode: 'weighed' })
  })

  it('GET /api/kitchen-batches?state=going and /:id on (c) produce-salt and (d) soft-deleted-line batches → 200', async () => {
    const list = await call(DAVE, 'GET', '/api/kitchen-batches?state=going')
    expect(list.status).toBe(200)
    for (const b of [S.batchA, S.batchC, S.batchD]) expect(list.body.batches.map((x) => x.id)).toContain(b)
    const c = await call(DAVE, 'GET', `/api/kitchen-batches/${S.batchC}`)
    expect(c.status).toBe(200)
    expect(c.body.inputs.map((l) => l.id)).toContain(S.cSalt)
    const d = await call(DAVE, 'GET', `/api/kitchen-batches/${S.batchD}`)
    expect(d.status).toBe(200)
    expect(d.body.inputs.map((l) => l.id)).toContain(S.dLive)
  })

  it.skipIf(!landed('getBatchF3'))('(c) the salt line reads back with salt_base produce; (d) the taken-out line is NOT returned', async () => {
    const c = await call(DAVE, 'GET', `/api/kitchen-batches/${S.batchC}`)
    expect(c.body.inputs.find((l) => l.id === S.cSalt)).toMatchObject({ salt_base: 'produce', salt_method: 'dry', base_from: 'lines' })
    const d = await call(DAVE, 'GET', `/api/kitchen-batches/${S.batchD}`)
    expect(d.body.inputs.map((l) => l.id)).not.toContain(S.dOut)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WRITES — the legacy PUT (PutUp.jsx:2583) and the §1.3 quartet
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('legacy PUT on states that F does not change (runs today)', () => {
  it('quartet (d): a 1a-bundle PUT on an UNDRAWN jar (Mark used) → 200 as today; remaining 3 → 2', async () => {
    const jar = await seedJar(DAVE, { count: 3 })
    const r = await put(DAVE, jar, '1a', { remaining_count: 2 })
    expect(r.status).toBe(200)
    expect((await snap(jar)).remaining_count).toBe(2)
  })

  it('(b) a 1a Mark used on the weighed bag → 200; remaining_amount is never touched by the legacy PUT', async () => {
    const bag = await seedJar(DAVE, { weighed: true, remainingAmount: 92 })
    const r = await put(DAVE, bag, '1a', { remaining_count: 0 })
    expect(r.status).toBe(200)
    const s = await snap(bag)
    expect(s.remaining_count).toBe(0)
    expect(Number(s.remaining_amount)).toBe(92)
  })

  // 1b §5.4 (contract-F §2.6): the legacy PUT no longer WRITES notes (nor place, discard-by, method); a present
  // value that DIFFERS is a tab older than the row. delta_at is unset here, so the notes rule alone refuses it.
  it('(b) a 1a RowEditor CHANGED note on the weighed bag → 409 client_stale with the refresh words; nothing written', async () => {
    const bag = await seedJar(DAVE, { weighed: true, remainingAmount: 92, notes: 'kf stored note' })
    const before = await snap(bag)
    const r = await put(JEN, bag, '1a', { notes: 'kf legacy note' })
    expectClientStale(r)
    expect(await snap(bag), 'a refused UPDATE writes nothing, updated_at included').toEqual(before)
  })

  it('an UNCHANGED-note echo (1a bundle, undrawn jar) → 200, a content no-op', async () => {
    const jar = await seedJar(DAVE, { count: 3, notes: 'kf same note', useByInDays: 30 })
    const before = await content(jar)
    const r = await put(DAVE, jar, '1a', {})
    expect(r.status).toBe(200)
    expect(await content(jar)).toEqual(before)
  })

  it('STRANGER PUT/DELETE → 404, row unchanged', async () => {
    const jar = await seedJar(DAVE, { count: 3 })
    const before = await snap(jar)
    const body = await fullPayload(DAVE, jar, '1a', { remaining_count: 1 })
    expect((await call(STRANGER, 'PUT', `/api/preservation/${jar}`, body)).status).toBe(404)
    expect((await call(STRANGER, 'DELETE', `/api/preservation/${jar}`)).status).toBe(404)
    expect(await snap(jar)).toEqual(before)
  })
})

describe.skipIf(!landed('legacyDeltaRef', 'jarPatch'))('legacy PUT on (a) a drawn jar — the F refusal (§1.3.4, §2.6)', () => {
  it('quartet (c): a 1a-bundle PUT carrying remaining_count on a jar with delta_at → 409 client_stale; nothing written', async () => {
    const jar = await seedJar(DAVE, { count: 5, remaining: 4, deltaAt: true })
    const before = await snap(jar)
    const r = await put(DAVE, jar, '1a', { remaining_count: 3 })
    expect(r.status).toBe(409)
    expect(r.body.code, 'MUTATION ARM: drop the refusal predicate → 200 and remaining 3').toBe('client_stale')
    expect(await snap(jar)).toEqual(before)
  })

  it('an UNTOUCHED 1a echo (nothing changed, but it carries remaining_count) on the drawn jar → 409 client_stale', async () => {
    // The delta_at predicate alone: every value equals the stored one, so no 1b echo rule can refuse it.
    const jar = await seedJar(DAVE, { count: 5, remaining: 4, deltaAt: true, notes: 'kf drawn' })
    const before = await snap(jar)
    expectClientStale(await put(DAVE, jar, '1a', {}))
    expect(await snap(jar)).toEqual(before)
  })

  it('a CHANGED note through the PUT from an F-shaped body (no remaining_count) → 409 client_stale too', async () => {
    const jar = await seedJar(DAVE, { count: 5, remaining: 4, deltaAt: true, notes: 'kf drawn' })
    const before = await snap(jar)
    expectClientStale(await put(DAVE, jar, 'F', { notes: 'kf F note through the PUT' }))
    expect(await snap(jar)).toEqual(before)
  })

  it('an F-shaped untouched echo through the PUT on the drawn jar → 200 no-op (MUTATION ARM: re-add remaining_count → 409)', async () => {
    const jar = await seedJar(DAVE, { count: 5, remaining: 4, deltaAt: true, notes: 'kf drawn' })
    const before = await content(jar)
    const r = await put(DAVE, jar, 'F', {})
    expect(r.status).toBe(200)
    expect(await content(jar)).toEqual(before)
  })

  it('quartet (b): the F bundle edits the note through PATCH /api/preservation/:id → 200, read back; count and delta_at unchanged', async () => {
    const jar = await seedJar(DAVE, { count: 5, remaining: 4, deltaAt: true, notes: 'kf drawn' })
    const before = await snap(jar)
    const r = await patchJar(DAVE, jar, { notes: 'kf F note' })
    expect(r.status).toBe(200)
    expect(r.body.notes).toBe('kf F note')
    const s = await snap(jar)
    expect(s.notes).toBe('kf F note')
    expect([s.package_count, s.remaining_count, s.consumed_at]).toEqual([before.package_count, 4, null])
    expect(s.delta_at?.valueOf()).toBe(before.delta_at?.valueOf())
    expect((await patchJar(STRANGER, jar, { notes: 'x' })).status).toBe(404)
  })
})

describe.skipIf(!landed('draws', 'keyedLines', 'pantryUses', 'legacyDeltaRef', 'jarPatch'))('§1.3 item 6 quartet end to end (draw → F Mark used → F note edit → 1a PUT)', () => {
  it('(a) draw 1 from J, then F-bundle Mark used on J → 201, remaining −1 each; (b) F note edit (PATCH) → 200; (c) 1a PUT → 409', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 4 })
    const d = await call(DAVE, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'put_up', preservation_log_id: jar, count_drawn: 1, idempotency_key: key() }] })
    expect(d.status).toBe(201)
    expect((await snap(jar)).remaining_count).toBe(3)
    const mark = await call(DAVE, 'POST', '/api/pantry/uses', { idempotency_key: key(), preservation_log_id: jar, count_used: 1 })
    expect(mark.status).toBe(201)
    expect((await snap(jar)).remaining_count).toBe(2)
    const edit = await patchJar(DAVE, jar, { notes: 'kf quartet' })
    expect(edit.status).toBe(200)
    expect(await snap(jar)).toMatchObject({ remaining_count: 2, notes: 'kf quartet' })
    const stale = await put(DAVE, jar, '1a', { remaining_count: 1 })
    expectClientStale(stale)
    expect((await snap(jar)).remaining_count).toBe(2)
    expect((await usesOf(jar)).map((u) => [u.count_used, u.fate])).toEqual([[1, 'batch'], [1, null]])
  })
})

// B′ AMENDS (a) (V4 §2.5 "Remove": refused on a jar with uses or live lines, with the reason and a path).
// Through F the drawn jar soft-deleted with its line and use left pointing at it; from B′ the shipped
// row remove (:2601) on it answers 409 jar_in_batch and nothing moves. (b), an undrawn bag, is unchanged.
describe('DELETE /api/preservation/:id (PutUp.jsx:739, :2601) on (a) → 409 jar_in_batch (B′), on (b) → 200 soft delete; lines and uses untouched', () => {
  it('(a) the drawn jar', async () => {
    const b = (await seedBatch(DAVE)).id
    const jar = await seedJar(DAVE, { count: 3, remaining: 2, deltaAt: true })
    const line = await seedLine(DAVE, b, { kind: 'put_up', jarId: jar })
    await directSql`INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id) VALUES (${DAVE}, ${jar}, 1, 'batch', ${line})`
    const r = await call(DAVE, 'DELETE', `/api/preservation/${jar}`)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('jar_in_batch')
    expect((await snap(jar)).deleted_at).toBeNull()
    const [l] = await directSql`SELECT deleted_at FROM kitchen_batch_input WHERE id = ${line}`
    expect(l.deleted_at).toBeNull()
    expect(await usesOf(jar)).toHaveLength(1)
  })
  it('(b) the weighed bag', async () => {
    const bag = await seedJar(DAVE, { weighed: true, remainingAmount: 92 })
    expect((await call(JEN, 'DELETE', `/api/preservation/${bag}`)).status).toBe(200)
    expect((await snap(bag)).deleted_at).not.toBeNull()
  })
})

describe('POST /api/preservation (PutUp.jsx:1560) with the 1a body', () => {
  const body = (o) => ({
    crop_type_slug: null, method: 'whole_freeze', quantity_value: 100, quantity_unit: 'g', package_count: 1,
    preserved_at: new Date().toISOString().slice(0, 10), preserved_at_approx: false, source_kind: 'own_garden',
    storage_location_id: place, notes: `kf-legacy-post-${H.RUN}`, ...o,
  })
  it('a weighed row (1 × 100 g) → 201 today', async () => {
    const [{ crop_type_slug: crop }] = await directSql`SELECT crop_type_slug FROM preservation_log WHERE id = ${S.u}`
    const r = await call(DAVE, 'POST', '/api/preservation', body({ crop_type_slug: crop }))
    expect(r.status).toBe(201)
    S.posted = r.body.id
  })
  it.skipIf(!landed('draws'))('F seeds remaining_amount = quantity in g for a weighed row, even from a 1a body', async () => {
    expect(Number((await snap(S.posted)).remaining_amount)).toBe(100)
  })
})

describe.skipIf(!landed('lineRestore', 'draws'))('1a BatchInputsField "Take it out" (DELETE …/inputs/:lineId)', () => {
  it('on a put_up draw line (state a) → 200; soft delete + one reversal; jar back to 5', async () => {
    const r = await call(DAVE, 'DELETE', `/api/kitchen-batches/${S.batchA}/inputs/${S.aLine}`)
    expect(r.status).toBe(200)
    const [l] = await directSql`SELECT deleted_at FROM kitchen_batch_input WHERE id = ${S.aLine}`
    expect(l.deleted_at).not.toBeNull()
    expect((await usesOf(S.a)).map((u) => u.count_used)).toEqual([1, -1])
    expect((await readJar(S.a)).remaining_count).toBe(5)
  })
  it('on the already-soft-deleted line (state d) → 200 {ok, already:true}; nothing moves', async () => {
    const r = await call(DAVE, 'DELETE', `/api/kitchen-batches/${S.batchD}/inputs/${S.dOut}`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, already: true })
  })
  it('on the produce salt line (state c) → 200, soft-deleted (not hard)', async () => {
    const r = await call(DAVE, 'DELETE', `/api/kitchen-batches/${S.batchC}/inputs/${S.cSalt}`)
    expect(r.status).toBe(200)
    const [l] = await directSql`SELECT deleted_at FROM kitchen_batch_input WHERE id = ${S.cSalt}`
    expect(l.deleted_at).not.toBeNull()
  })
})
