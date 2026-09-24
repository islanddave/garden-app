// tests/integration/inventory-delete-guard.int.test.js
// BUG-INVREFSTRAND-001 (option C) — DELETE /api/inventory-items/:id on real Postgres.
//
// WHY THIS FILE EXISTS. lambda/inventory-items/delete-reference-guard.test.js drives the handler
// against a stub that never parses SQL, so it proves what the handler DOES with the preflight's answer
// and nothing about whether the preflight's SQL asks the right question. That is the half that decides
// Dave's delete: a planting counted or not by one predicate. This file runs the real handler and the
// real driver on rows built to trip each predicate, and reads the item back with directSql — never the
// handler's echo (L-108) — to prove a refusal wrote nothing and an allowed delete really soft-deleted.
//
// THE CONTRACT (lambda/inventory-items/delete-guard.js):
//   · a live planting sown from the item blocks — ARCHIVED ONES INCLUDED — and the 409 sentence says
//     how many and how many of them are archived; a planting archived AND soft-deleted counts in
//     neither number, so it cannot make the sentence say "archived";
//   · a live treatment event that applied the item blocks; a soft-deleted one does not;
//   · a soft-deleted planting does not block;
//   · the item's own photo and its own seed-processing stage rows do not block;
//   · another household's item answers 404, before any count; so does an item that is already
//     deleted, even with a live planting still pointing at it, and its deleted_at is left alone;
//   · the sentence calls a SAVED lot "This seed lot" — decided by the preflight's saved_lot SQL, which
//     must agree with isSavedLot (src/components/seed/seedLots.js) on real rows: one per fact, plus a
//     bought packet. lambda/inventory-items/saved-lot-pairing.test.js pins the two to the same facts;
//     this file is where the SQL half is actually executed.
//
// FIXTURES are this file's own (`int-test-` namespaced users). Teardown unwinds what the global sweep
// cannot reach (seed_lot_stage_log has no step there) and then the RESTRICT/NO ACTION children in FK
// order, as inventory-sown-from.int.test.js and seed-lifecycle.int.test.js do.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'
import { handler } from '../../lambda/inventory-items/index.js'
import { deletePreflight } from '../../lambda/inventory-items/delete-guard.js'
import { isSavedLot } from '../../src/components/seed/seedLots.js'

const RUN = testRunId()
const USER = `user_int_delguard_${RUN}`
const FOREIGN = `user_int_delguard_foreign_${RUN}`

const del = (id, userId = USER) => callHandler(handler, { method: 'DELETE', path: `/api/inventory-items/${id}`, userId })
const deletedAt = async (id) => (await directSql`SELECT deleted_at FROM inventory_items WHERE id = ${id}`)[0].deleted_at

let varietyId
const ids = {}

async function packet(tag, extra = {}) {
  const res = await callHandler(handler, {
    method: 'POST', path: '/api/inventory-items', userId: USER,
    body: {
      name: `int-delguard-${tag}-${RUN}`, type: 'consumable', category: 'seeds', unit: 'packet',
      quantity_on_hand: 1, variety_id: varietyId, ...extra,
    },
  })
  expect(res.status, `POST ${tag} -> ${JSON.stringify(res.body)}`).toBe(201)
  return res.body.id
}

async function planting(tag, item, { archived = false, deleted = false } = {}) {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, created_by, source_inventory_item_id, archived_at, deleted_at)
    VALUES (NULL, ${`int-delguard-${tag}-${RUN}`}, ${USER}, ${item},
            CASE WHEN ${archived}::boolean THEN NOW() END,
            CASE WHEN ${deleted}::boolean THEN NOW() END)
    RETURNING id`
  return rows[0].id
}

beforeAll(async () => {
  setTestUserId(USER)
  const v = await directSql`
    INSERT INTO plant_varieties (name, created_by) VALUES (${`int-delguard-variety-${RUN}`}, ${USER}) RETURNING id`
  varietyId = v[0].id

  // Blocked: one live planting, then one live + one archived.
  ids.sown = await packet('sown')
  await planting('sown-live', ids.sown)
  ids.mixed = await packet('mixed')
  await planting('mixed-live', ids.mixed)
  await planting('mixed-archived', ids.mixed, { archived: true })
  // Blocked: ONLY an archived planting — the ten-packet case measured on prod 2026-09-24.
  ids.archivedOnly = await packet('archived-only')
  await planting('archived-only', ids.archivedOnly, { archived: true })
  // Allowed: the only planting was soft-deleted.
  ids.retracted = await packet('retracted')
  await planting('retracted', ids.retracted, { deleted: true })
  // Allowed: a saved-seed lot with its own stage history and its own photo, nothing sown from it.
  ids.lot = await packet('saved-lot', { seed_process: 'wet', seed_stage: 'fermenting' })
  await directSql`
    INSERT INTO seed_lot_stage_log (inventory_item_id, stage, entered_at, created_by)
    VALUES (${ids.lot}, 'fermenting', NOW(), ${USER})`
  await directSql`
    INSERT INTO photos (inventory_item_id, storage_path, created_by)
    VALUES (${ids.lot}, ${`inventory/${ids.lot}/int-delguard-${RUN}.jpg`}, ${USER})`
  // Blocked: a product a live treatment event applied (the event needs a planting anchor).
  const tool = await callHandler(handler, {
    method: 'POST', path: '/api/inventory-items', userId: USER,
    body: { name: `int-delguard-spray-${RUN}`, type: 'consumable', category: 'pest_control', unit: 'fl oz', quantity_on_hand: 8 },
  })
  expect(tool.status, `POST spray -> ${JSON.stringify(tool.body)}`).toBe(201)
  ids.spray = tool.body.id
  const anchor = await planting('treated', null)
  await directSql`
    INSERT INTO event_log (plant_id, event_type, event_date, created_by, treatment_product_id, treatment_category)
    VALUES (${anchor}, 'pest_treatment', NOW(), ${USER}, ${ids.spray}, 'pest_control')`

  // Pre-promote review M-1 — blocked, but NOT "archived": one live, unarchived planting, plus one that
  // was archived AND then soft-deleted (the plants DELETE soft-deletes archived rows). The deleted one
  // must count in neither number.
  ids.intersect = await packet('intersect')
  await planting('intersect-live', ids.intersect)
  await planting('intersect-archived-deleted', ids.intersect, { archived: true, deleted: true })
  // Pre-promote review M-2a — allowed: the only treatment that applied this product was soft-deleted.
  const retracted = await callHandler(handler, {
    method: 'POST', path: '/api/inventory-items', userId: USER,
    body: { name: `int-delguard-spray-retracted-${RUN}`, type: 'consumable', category: 'pest_control', unit: 'fl oz', quantity_on_hand: 8 },
  })
  expect(retracted.status, `POST retracted spray -> ${JSON.stringify(retracted.body)}`).toBe(201)
  ids.sprayRetracted = retracted.body.id
  const anchorRetracted = await planting('treated-retracted', null)
  await directSql`
    INSERT INTO event_log (plant_id, event_type, event_date, created_by, treatment_product_id, treatment_category, deleted_at)
    VALUES (${anchorRetracted}, 'pest_treatment', NOW(), ${USER}, ${ids.sprayRetracted}, 'pest_control', NOW())`
  // Pre-promote review M-2b — a packet ALREADY soft-deleted while a live planting still points at it (a
  // strand, made here on purpose). The preflight must not match it. deleted_at is a fixed instant, so
  // "unchanged" is an exact comparison.
  ids.alreadyDeleted = await packet('already-deleted')
  await planting('already-deleted-live', ids.alreadyDeleted)
  await directSql`UPDATE inventory_items SET deleted_at = '2026-01-02T03:04:05Z' WHERE id = ${ids.alreadyDeleted}`

  // Saved-lot pairing: one row per isSavedLot fact, plus a bought packet — all through the app's POST,
  // the way the Seeds doors write them. Nothing is sown from these four; they are only read.
  ids.parentPlanting = await planting('lot-parent', null)
  ids.factParent = await packet('fact-parent', { source_plant_id: ids.parentPlanting })
  ids.factKind = await packet('fact-kind', { source_kind: 'farm_stand' })
  ids.factStage = await packet('fact-stage', { seed_process: 'wet', seed_stage: 'fermenting' })
  ids.factNone = await packet('fact-none')
  // Blocked, and called a seed lot: a lot saved from a gift, with a planting sown from it.
  ids.sownLot = await packet('sown-lot', { source_kind: 'gift' })
  await planting('sown-lot', ids.sownLot)
})

afterAll(async () => {
  assertFixtureId(USER, FOREIGN)
  await settle('inventory-delete-guard', [
    // No global sweep step exists for stage rows (NO ACTION into inventory_items).
    () => directSql`DELETE FROM seed_lot_stage_log WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM photos WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM event_log WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM entity WHERE entity_type = 'planting' AND planting_ref_id IN (
                      SELECT id FROM plants WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`,
    // Two RESTRICT FKs run in opposite directions: a planting SOWN FROM an item
    // (plants.source_inventory_item_id) must go before the item, and the planting a lot was SAVED OFF
    // (inventory_items.source_plant_id) after it. So: sown plantings, then items, then the rest.
    () => directSql`DELETE FROM plants WHERE created_by = ${USER} AND source_inventory_item_id IS NOT NULL`,
    () => directSql`DELETE FROM inventory_items WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM plants WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM entity WHERE entity_type = 'cultivar' AND cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`,
  ])
})

describe('DELETE /api/inventory-items/:id — blocks only on something sown or applied from it (real Postgres)', () => {
  it('a live planting sown from the packet → 409 with the sentence, and the packet is still live', async () => {
    setTestUserId(USER)
    const { status, body } = await del(ids.sown)
    expect(status, JSON.stringify(body)).toBe(409)
    expect(body.error).toBe(
      'This packet can\'t be removed: 1 planting was sown from it. To mark it used up, set its Status to "depleted" instead.',
    )
    expect(await deletedAt(ids.sown)).toBeNull()
  })

  it('archived plantings count, and the sentence says how many are archived', async () => {
    setTestUserId(USER)
    const mixed = await del(ids.mixed)
    expect(mixed.status).toBe(409)
    expect(mixed.body.error).toContain('2 plantings were sown from it (1 of them archived)')
    const only = await del(ids.archivedOnly)
    expect(only.status).toBe(409)
    expect(only.body.error).toContain('1 archived planting was sown from it')
    expect(await deletedAt(ids.mixed)).toBeNull()
    expect(await deletedAt(ids.archivedOnly)).toBeNull()
  })

  it('a live treatment event that applied the product → 409 naming the treatment', async () => {
    setTestUserId(USER)
    const { status, body } = await del(ids.spray)
    expect(status, JSON.stringify(body)).toBe(409)
    expect(body.error).toBe(
      'This item can\'t be removed: it was used in 1 logged treatment. To mark it used up, set its Status to "depleted" instead.',
    )
    expect(await deletedAt(ids.spray)).toBeNull()
  })

  it('another household cannot learn anything: 404, and the packet is untouched', async () => {
    setTestUserId(FOREIGN)
    try {
      const { status, body } = await del(ids.sown, FOREIGN)
      expect(status).toBe(404)
      expect(body).toEqual({ error: 'Not found' })
    } finally {
      setTestUserId(USER)
    }
    expect(await deletedAt(ids.sown)).toBeNull()
  })

  it('a soft-deleted planting does not block: 200 and the packet is soft-deleted', async () => {
    setTestUserId(USER)
    const { status, body } = await del(ids.retracted)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(await deletedAt(ids.retracted)).not.toBeNull()
  })

  it('a saved lot with its own stage row and photo deletes (200), and they keep their pointer', async () => {
    setTestUserId(USER)
    const { status, body } = await del(ids.lot)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(await deletedAt(ids.lot)).not.toBeNull()
    // They follow the item: still there, still pointing at it, restorable with it.
    const [s] = await directSql`SELECT count(*)::int AS n FROM seed_lot_stage_log WHERE inventory_item_id = ${ids.lot}`
    const [p] = await directSql`SELECT count(*)::int AS n FROM photos WHERE inventory_item_id = ${ids.lot} AND deleted_at IS NULL`
    expect(s.n).toBe(1)
    expect(p.n).toBe(1)
  })

  // Pre-promote review M-1 / M-2. Each case first reads back the fixture property it depends on, so a
  // fixture that stopped holding it fails here instead of passing for the wrong reason.
  it('a planting archived AND soft-deleted counts nowhere — the sentence names only the live, unarchived one', async () => {
    setTestUserId(USER)
    const [f] = await directSql`
      SELECT count(*) FILTER (WHERE deleted_at IS NULL AND archived_at IS NULL)::int AS live_unarchived,
             count(*) FILTER (WHERE deleted_at IS NOT NULL AND archived_at IS NOT NULL)::int AS archived_deleted
        FROM plants WHERE source_inventory_item_id = ${ids.intersect}`
    expect(f).toEqual({ live_unarchived: 1, archived_deleted: 1 })
    const { status, body } = await del(ids.intersect)
    expect(status, JSON.stringify(body)).toBe(409)
    expect(body.error).toBe(
      'This packet can\'t be removed: 1 planting was sown from it. To mark it used up, set its Status to "depleted" instead.',
    )
    expect(await deletedAt(ids.intersect)).toBeNull()
  })

  it('a soft-deleted treatment does not block: 200 {ok:true}, and the product is soft-deleted', async () => {
    setTestUserId(USER)
    const [f] = await directSql`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE deleted_at IS NULL)::int AS live
        FROM event_log WHERE treatment_product_id = ${ids.sprayRetracted}`
    expect(f).toEqual({ total: 1, live: 0 })
    const { status, body } = await del(ids.sprayRetracted)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(await deletedAt(ids.sprayRetracted)).not.toBeNull()
  })

  it('an item that is already deleted answers 404 even with a live planting on it, and its deleted_at is untouched', async () => {
    setTestUserId(USER)
    const [f] = await directSql`
      SELECT count(*)::int AS n FROM plants WHERE source_inventory_item_id = ${ids.alreadyDeleted} AND deleted_at IS NULL`
    expect(f.n, 'fixture: a live planting must still point at the deleted packet').toBe(1)
    const before = await deletedAt(ids.alreadyDeleted)
    expect(new Date(before).toISOString()).toBe('2026-01-02T03:04:05.000Z')
    const { status, body } = await del(ids.alreadyDeleted)
    expect(status, JSON.stringify(body)).toBe(404)
    expect(body).toEqual({ error: 'Not found' })
    expect(new Date(await deletedAt(ids.alreadyDeleted)).toISOString()).toBe('2026-01-02T03:04:05.000Z')
  })
})

describe('saved lot — the preflight\'s SQL and isSavedLot agree on real rows (one per fact, plus a bought packet)', () => {
  // The REAL preflight statement, on the real driver, against rows the app's own POST wrote; isSavedLot
  // on the same rows read back. The expected answer is asserted too, so two sides that both went
  // false everywhere cannot agree their way to green.
  it.each([
    ['factParent', 'saved off a planting (parent only)', true],
    ['factKind', 'recorded origin (origin kind only)', true],
    ['factStage', 'in process (stage only)', true],
    ['factNone', 'a bought packet (none of the three)', false],
  ])('%s — %s', async (key, _label, expected) => {
    const pf = await deletePreflight(directSql, ids[key], [USER])
    const [row] = await directSql`
      SELECT source_plant_id, source_kind, seed_stage FROM inventory_items WHERE id = ${ids[key]}`
    expect(pf.found).toBe(true)
    expect(pf.savedLot).toBe(isSavedLot(row))
    expect(pf.savedLot).toBe(expected)
  })

  it('a saved lot with a planting sown from it is refused as "This seed lot", and stays live', async () => {
    setTestUserId(USER)
    const { status, body } = await del(ids.sownLot)
    expect(status, JSON.stringify(body)).toBe(409)
    expect(body.error).toBe(
      'This seed lot can\'t be removed: 1 planting was sown from it. To mark it used up, set its Status to "depleted" instead.',
    )
    expect(await deletedAt(ids.sownLot)).toBeNull()
  })
})
