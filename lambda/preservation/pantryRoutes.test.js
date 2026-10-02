// Put-Up release 2 (B′) — the Pantry's routes, EXECUTED against a mock driver (the fermentRoutes.test.js
// idiom): GET /api/pantry (the one row shape, grouping, sort, filters, discard classification), the pantry
// item create / PATCH / DELETE, the widened use route (Went bad / Gave it away), the use undo, Remove on a
// put-up, and a batch line that names a pantry item. What each proves is what the handler SENDS and how it
// answers — household arrays bound, keys, replays, refusals; that the SQL runs is the integration lane's
// (tests/integration/pantry-*.int.test.js).
import { describe, it, expect } from 'vitest';
import {
  parsePantryRoute, handlePantryRoute, removeJar, ITEM_CONSTRAINT_MESSAGES,
} from './pantryRoutes.js';
import {
  validateItemCreate, validateItemPatch, acquiredOf, jarRow, itemRow, sortPantryRows, discardOf, matchesQuery,
  loadPantryItems, amountOf, sourceOf, projectItem, ITEM_CREATE_KEYS, ITEM_PATCH_KEYS, ITEM_SOURCE_WORDS,
  ITEM_AMOUNT_MAX, PLANTING_SOURCE_REFUSAL,
} from './pantryItems.js';
import { KITCHEN_UNITS } from './kitchenBatch.js';
import { JAR_UNITS } from './jarRules.js';
import { VALID_SOURCE_KINDS } from './provenance.js';
import { PUTUP_SOURCE_LABELS } from '../../src/lib/dropdownRegistry.js';
import { handlePantryUses, validateUse } from './pantryUses.js';
import { handleKitchenRoute } from './kitchenRoutes.js';
import { lineError } from './kitchenLines.js';
import { validatePutUp } from './putUp.js';

const HOUSEHOLD = ['user_dave', 'user_jen'];
const STRANGER = ['user_stranger'];
const DAVE = 'user_dave';
const JEN = 'user_jen';
const ITEM = '99999999-aaaa-4bbb-8ccc-000000000001';
const PLACE = '99999999-aaaa-4bbb-8ccc-000000000002';
const PLANT = '99999999-aaaa-4bbb-8ccc-000000000003';
const JAR = '99999999-aaaa-4bbb-8ccc-000000000004';
const USE = '99999999-aaaa-4bbb-8ccc-000000000005';
const BATCH = '99999999-aaaa-4bbb-8ccc-000000000006';
const K1 = '11111111-1111-4222-8333-444444444444';
const K2 = '22222222-1111-4222-8333-444444444444';
const GUC = "SELECT set_config('app.actor_clerk_sub', ? , true)";
// A fixed instant: 2026-10-15 noon ET.
const NOW = new Date('2026-10-15T16:00:00Z');

function mockSql(queue = []) {
  const calls = [];
  const fn = (strings, ...values) => {
    const text = strings.raw.join(' ? ');
    calls.push({ text, norm: text.replace(/\s+/g, ' ').trim(), values });
    if (!queue.length) return Promise.reject(new Error(`unexpected extra query: ${text.replace(/\s+/g, ' ').slice(0, 90)}`));
    const next = queue.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  fn.batches = [];
  fn.transaction = async (qs) => {
    fn.batches.push(calls.slice(calls.length - qs.length));
    return Promise.all(qs);
  };
  fn.calls = calls;
  return fn;
}
const err = (code, constraint) => Object.assign(new Error(code), { code, constraint });
const call = (sql, path, method, body, { householdIds = HOUSEHOLD, query = {}, userId = DAVE } = {}) => handlePantryRoute({
  sql, rawPath: path, method, rawBody: body == null ? null : JSON.stringify(body), query, userId, householdIds, now: NOW,
});
const after = (c, needle) => {
  const at = c.norm.indexOf(needle);
  expect(at, `SQL lacks ${needle}`).toBeGreaterThan(-1);
  return c.values[(c.norm.slice(0, at + needle.length).match(/\?/g) ?? []).length];
};

// ── rows as the two list reads return them ───────────────────────────────────────────────────────
const jarDb = (over = {}) => ({
  id: JAR, user_id: DAVE, label: 'Megatron hot sauce', method: 'hot_sauce', method_other_text: null,
  crop_type_slug: 'pepper', plant_id: PLANT, batch_id: BATCH, package_count: 4, remaining_count: 3,
  remaining_amount: null, quantity_value: '32', quantity_unit: 'fl oz', preserved_at: '2026-10-08',
  preserved_at_precision: 'day', use_by_target: '2027-04-08', use_by_basis: 'table', storage_location_id: PLACE,
  source_kind: null, source_label: null, notes: null, updated_at: '2026-10-08T20:00:00.000Z', place_label: 'Kitchen fridge',
  place_kind: 'fridge', crop_display_name: 'Pepper', variety_name: 'Megatron', planting_name: 'Megatron jalapeño',
  planting_sown_at: null, planting_succession_order: null, from_garden: true, ...over,
});
const bagDb = (over = {}) => jarDb({
  id: '99999999-aaaa-4bbb-8ccc-0000000000b0', label: 'Roasted Anaheims', method: 'roast_freeze', crop_type_slug: 'pepper',
  plant_id: null, batch_id: null, package_count: 1, remaining_count: null, remaining_amount: '312.5',
  quantity_value: '1', quantity_unit: 'lb', preserved_at: '2026-09-01', preserved_at_precision: 'month',
  use_by_target: '2027-09-01', use_by_basis: 'table', storage_location_id: '99999999-aaaa-4bbb-8ccc-0000000000f0',
  source_kind: 'farm_stand', source_label: 'Harris farm stand', place_label: 'Deep freezer', place_kind: 'deep_freezer', variety_name: null,
  planting_name: null, from_garden: false, ...over,
});
const itemDb = (over = {}) => ({
  id: ITEM, user_id: JEN, name: 'Arborio rice', storage_location_id: '99999999-aaaa-4bbb-8ccc-0000000000e0',
  acquired_at: '2026-10-03', acquired_precision: 'day', use_by_target: null, plant_id: null, crop_type_slug: null,
  notes: 'the big bag', updated_at: '2026-10-03T15:00:00.000Z', place_label: 'Pantry shelf', place_kind: 'pantry',
  quantity_value: null, quantity_unit: null, source_kind: null, source_label: null,
  crop_display_name: null, planting_name: null, planting_sown_at: null, planting_succession_order: null, ...over,
});

// ── routing ──────────────────────────────────────────────────────────────────────────────────────
describe('routing', () => {
  it('claims its own paths only; /api/pantry/uses stays F\'s literal', () => {
    expect(parsePantryRoute('/api/pantry')).toEqual({ route: 'list' });
    expect(parsePantryRoute('/api/pantry/items')).toEqual({ route: 'items' });
    expect(parsePantryRoute(`/api/pantry/items/${ITEM}`)).toEqual({ route: 'item', id: ITEM });
    expect(parsePantryRoute(`/api/pantry/uses/${USE}/undo`)).toEqual({ route: 'undo', id: USE });
    expect(parsePantryRoute('/api/pantry/uses')).toBeNull();
    expect(parsePantryRoute('/api/pantry/elsewhere')).toBeNull();
    expect(parsePantryRoute('/api/preservation')).toBeNull();
  });

  it('answers 405 for a verb it does not serve, touching nothing', async () => {
    const sql = mockSql();
    expect((await call(sql, '/api/pantry', 'POST', {})).status).toBe(405);
    expect((await call(sql, '/api/pantry/items', 'GET')).status).toBe(405);
    expect((await call(sql, `/api/pantry/items/${ITEM}`, 'GET')).status).toBe(405);
    expect((await call(sql, `/api/pantry/uses/${USE}/undo`, 'GET')).status).toBe(405);
    expect(sql.calls).toHaveLength(0);
  });

  it('returns null for a path that is not its own', async () => {
    expect(await handlePantryRoute({ sql: null, rawPath: '/api/pantry/uses', method: 'POST' })).toBeNull();
    expect(await handlePantryRoute({ sql: null, rawPath: '/api/kitchen-batches', method: 'GET' })).toBeNull();
  });
});

// ── GET /api/pantry ──────────────────────────────────────────────────────────────────────────────
describe('GET /api/pantry', () => {
  it('reads put-ups and items household-scoped, live and with something left; the exact rows for a counted jar, a weighed bag and a bought item', async () => {
    const sql = mockSql([[jarDb(), bagDb()], [itemDb()]]);
    const res = await call(sql, '/api/pantry', 'GET');
    expect(res.status).toBe(200);
    const [jars, items] = sql.calls;
    expect(jars.values).toContainEqual(HOUSEHOLD);
    expect(items.values).toContainEqual(HOUSEHOLD);
    expect(jars.norm).toContain('AND p.deleted_at IS NULL AND COALESCE(p.remaining_count, p.package_count) > 0 AND p.consumed_at IS NULL');
    expect(jars.norm).toContain("OR EXISTS (SELECT 1 FROM preservation_source ps WHERE ps.preservation_log_id = p.id AND ps.source_kind = 'own_garden' AND ps.deleted_at IS NULL)) AS from_garden");
    expect(items.norm).toContain('AND i.deleted_at IS NULL AND i.used_up_at IS NULL');
    // group=place (default): Deep freezer, Kitchen fridge, Pantry shelf.
    expect(res.body.rows).toEqual([
      {
        stock_kind: 'put_up', stock_id: '99999999-aaaa-4bbb-8ccc-0000000000b0', name: 'Roasted Anaheims',
        group_key: '99999999-aaaa-4bbb-8ccc-0000000000f0', group_label: 'Deep freezer',
        place: { id: '99999999-aaaa-4bbb-8ccc-0000000000f0', label: 'Deep freezer', kind: 'deep_freezer' },
        where_from: 'Harris farm stand', from_garden: false, plant_id: null, crop_type_slug: 'pepper', batch_id: null,
        stock_mode: 'weighed', count_left: null, count_made: null, grams_left: 312.5, method: 'roast_freeze',
        quantity_value: 1, quantity_unit: 'lb', source_kind: 'farm_stand', source_label: 'Harris farm stand',
        discard: { date: '2027-09-01', basis: 'table', status: 'ok' },
        acquired_at: '2026-09-01', acquired_precision: 'month', notes: null, created_by: DAVE,
        updated_at: '2026-10-08T20:00:00.000Z',
      },
      {
        stock_kind: 'put_up', stock_id: JAR, name: 'Megatron hot sauce', group_key: PLACE, group_label: 'Kitchen fridge',
        place: { id: PLACE, label: 'Kitchen fridge', kind: 'fridge' },
        where_from: 'Megatron jalapeño', from_garden: true, plant_id: PLANT, crop_type_slug: 'pepper', batch_id: BATCH,
        stock_mode: 'counted', count_left: 3, count_made: 4, grams_left: null, method: 'hot_sauce',
        quantity_value: 32, quantity_unit: 'fl oz', source_kind: null, source_label: null,
        discard: { date: '2027-04-08', basis: 'table', status: 'ok' },
        acquired_at: '2026-10-08', acquired_precision: 'day', notes: null, created_by: DAVE,
        updated_at: '2026-10-08T20:00:00.000Z',
      },
      {
        stock_kind: 'pantry_item', stock_id: ITEM, name: 'Arborio rice',
        group_key: '99999999-aaaa-4bbb-8ccc-0000000000e0', group_label: 'Pantry shelf',
        place: { id: '99999999-aaaa-4bbb-8ccc-0000000000e0', label: 'Pantry shelf', kind: 'pantry' },
        where_from: null, from_garden: false, plant_id: null, crop_type_slug: null, batch_id: null,
        stock_mode: 'item', count_left: null, count_made: null, grams_left: null, method: null,
        quantity_value: null, quantity_unit: null, source_kind: null, source_label: null,
        discard: { date: null, basis: null, status: null },
        acquired_at: '2026-10-03', acquired_precision: 'day', notes: 'the big bag', created_by: JEN,
        updated_at: '2026-10-03T15:00:00.000Z',
      },
    ]);
  });

  it('a STRANGER gets the stranger\'s own (empty) household, bound on both reads', async () => {
    const sql = mockSql([[], []]);
    const res = await call(sql, '/api/pantry', 'GET', null, { householdIds: STRANGER });
    expect(res).toEqual({ status: 200, body: { rows: [] } });
    expect(sql.calls[0].values).toContainEqual(STRANGER);
    expect(sql.calls[1].values).toContainEqual(STRANGER);
  });

  it('group=kind groups by crop, the crop-less last as "Other things"; sorted by group then name', async () => {
    const sql = mockSql([[jarDb(), bagDb({ label: 'Anaheim strips' })], [itemDb(), itemDb({ id: 'i2', name: 'Onions', crop_type_slug: 'onion', crop_display_name: 'Onion' })]]);
    const res = await call(sql, '/api/pantry', 'GET', null, { query: { group: 'kind' } });
    expect(res.body.rows.map((r) => [r.group_label, r.name])).toEqual([
      ['Onion', 'Onions'], ['Pepper', 'Anaheim strips'], ['Pepper', 'Megatron hot sauce'], ['Other things', 'Arborio rice'],
    ]);
    expect(res.body.rows.at(-1).group_key).toBe('other');
  });

  it('an unknown group falls back to place; a place-less row sorts last as "No place"', async () => {
    const sql = mockSql([[jarDb({ storage_location_id: null, place_label: null, place_kind: null })], [itemDb()]]);
    const res = await call(sql, '/api/pantry', 'GET', null, { query: { group: 'nonsense' } });
    expect(res.body.rows.map((r) => [r.group_key, r.group_label])).toEqual([
      ['99999999-aaaa-4bbb-8ccc-0000000000e0', 'Pantry shelf'], ['no_place', 'No place'],
    ]);
    expect(res.body.rows[1].place).toBeNull();
  });

  it('q is a name match only (case-insensitive); place_id is bound to both reads; a malformed place_id → 400', async () => {
    let sql = mockSql([[jarDb(), bagDb()], [itemDb()]]);
    let res = await call(sql, '/api/pantry', 'GET', null, { query: { q: '  ANAHEIM ', place_id: PLACE } });
    expect(res.body.rows.map((r) => r.name)).toEqual(['Roasted Anaheims']);
    expect(sql.calls[0].values).toContain(PLACE);
    expect(sql.calls[1].values).toContain(PLACE);
    // where_from / notes never match: the page search is name only (V4 §2.5)
    sql = mockSql([[bagDb()], [itemDb()]]);
    res = await call(sql, '/api/pantry', 'GET', null, { query: { q: 'harris' } });
    expect(res.body.rows).toEqual([]);
    sql = mockSql();
    res = await call(sql, '/api/pantry', 'GET', null, { query: { place_id: 'fridge' } });
    expect(res.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('discard-by is classified from the STORED date: ok / soon / past, basis as stored (a legacy NULL basis stays NULL)', () => {
    expect(discardOf('2026-10-14', 'table', '2026-04-14', NOW)).toEqual({ date: '2026-10-14', basis: 'table', status: 'past' });
    expect(discardOf('2026-10-15', 'typed', '2026-04-15', NOW).status).toBe('soon');   // on the day: not past yet
    expect(discardOf('2026-11-01', 'house', '2026-01-01', NOW).status).toBe('soon');
    expect(discardOf('2027-10-01', 'recipe', '2026-10-01', NOW).status).toBe('ok');
    expect(discardOf(null, 'none', '2026-10-01', NOW)).toEqual({ date: null, basis: 'none', status: null });
    expect(discardOf('2027-01-01', null, '2026-10-01', NOW)).toEqual({ date: '2027-01-01', basis: null, status: 'ok' });
  });

  it('an item\'s discard-by is typed only: its date reads basis typed; no date is no basis and no status', () => {
    const typed = itemRow(itemDb({ use_by_target: '2026-10-10' }), 'place', NOW);
    expect(typed.discard).toEqual({ date: '2026-10-10', basis: 'typed', status: 'past' });
    const soonNoStart = itemRow(itemDb({ use_by_target: '2026-11-30', acquired_at: null, acquired_precision: 'unknown' }), 'place', NOW);
    expect(soonNoStart.discard).toEqual({ date: '2026-11-30', basis: 'typed', status: 'ok' });
    expect(itemRow(itemDb(), 'place', NOW).discard).toEqual({ date: null, basis: null, status: null });
  });

  it('a jar with no label is named by its variety, planting, crop, a named Other — "Put-up" only when bare', () => {
    const r = (o) => jarRow(jarDb({ label: null, ...o }), 'place', NOW).name;
    expect(r({})).toBe('Megatron');
    expect(r({ variety_name: null })).toBe('Megatron jalapeño');
    expect(r({ variety_name: null, planting_name: null })).toBe('Pepper');
    expect(r({ variety_name: null, planting_name: null, crop_display_name: null, method_other_text: 'Drinking vinegar' })).toBe('Drinking vinegar');
    expect(r({ variety_name: null, planting_name: null, crop_display_name: null })).toBe('Put-up');
  });

  it('a "Fresh, as picked" item is from the garden and names its planting as where it came from', () => {
    const row = itemRow(itemDb({ plant_id: PLANT, planting_name: 'Walla Walla', crop_type_slug: 'onion' }), 'place', NOW);
    expect(row).toMatchObject({ from_garden: true, where_from: 'Walla Walla', plant_id: PLANT, stock_mode: 'item' });
  });

  it('a weighed bag never drawn reads its grams through the quantity (COALESCE); a counted jar never used reads its count', () => {
    expect(jarRow(bagDb({ remaining_amount: null, quantity_value: '2', quantity_unit: 'kg' }), 'place', NOW).grams_left).toBe(2000);
    expect(jarRow(jarDb({ remaining_count: null }), 'place', NOW)).toMatchObject({ count_left: 4, count_made: 4 });
  });

  it('sortPantryRows is total: put-ups before items at a name tie, then id', () => {
    const rows = [
      { group_key: 'g', group_label: 'A', name: 'x', stock_kind: 'pantry_item', stock_id: '2' },
      { group_key: 'g', group_label: 'A', name: 'x', stock_kind: 'put_up', stock_id: '3' },
      { group_key: 'g', group_label: 'A', name: 'x', stock_kind: 'put_up', stock_id: '1' },
    ];
    expect(sortPantryRows(rows).map((r) => r.stock_id)).toEqual(['1', '3', '2']);
    expect(matchesQuery({ name: 'Rice' }, '')).toBe(true);
  });
});

// ── POST /api/pantry/items ───────────────────────────────────────────────────────────────────────
describe('POST /api/pantry/items', () => {
  const body = (over = {}) => ({ idempotency_key: K1, name: '  Arborio rice ', storage_location_id: PLACE, ...over });
  const placeRow = [{ id: PLACE, label: 'Pantry shelf', kind: 'pantry' }];
  const inserted = (over = {}) => [{ ...itemDb({ user_id: DAVE, storage_location_id: PLACE, acquired_at: null, acquired_precision: null, notes: null }), used_up_at: null, created_at: 'c', deleted_at: null, ...over }];

  it.each([
    [{ idempotency_key: 'x' }, /idempotency_key must be a uuid/],
    [{ name: ' ' }, /name what it is/],
    [{ name: 'x'.repeat(121) }, /at most 120/],
    [{ storage_location_id: null }, /say where it lives/],
    [{ place: { kind: 'fridge', label: 'F' } }, /say where it lives/],
    [{ storage_location_id: null, place: { kind: 'garage', label: 'G' } }, /place.kind must be one of/],
    [{ storage_location_id: null, place: { kind: 'fridge', label: ' ' } }, /needs a name/],
    [{ acquired_at: '2026-13-40' }, /acquired_at must be a date/],
    [{ acquired_at: '2026-10-01', acquired_precision: 'unknown' }, /send no acquired_at/],
    [{ acquired_precision: 'month' }, /needs an acquired_at/],
    [{ acquired_precision: 'fortnight' }, /acquired_precision must be one of/],
    [{ use_by_target: 'soon' }, /use_by_target must be a date/],
    [{ plant_id: 'p' }, /plant_id must be a uuid/],
    [{ notes: 5 }, /notes must be text/],
    [{ user_id: 'someone' }, /unknown field/],
    [{ used_up_at: 'now' }, /unknown field/],
  ])('%o → 400, nothing read', async (over, want) => {
    expect(validateItemCreate(body(over))).toMatch(want);
    const sql = mockSql();
    expect((await call(sql, '/api/pantry/items', 'POST', body(over))).status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('a known place: household-loaded, then ONE insert; the name trimmed, the day\'s precision defaulted, the key bound → 201 {item}', async () => {
    const sql = mockSql([placeRow, inserted({ place_label: 'Pantry shelf', place_kind: 'pantry' })]);
    const res = await call(sql, '/api/pantry/items', 'POST', body({ acquired_at: '2026-10-03', notes: ' big bag ' }));
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ id: ITEM, name: 'Arborio rice', place: { id: PLACE, label: 'Pantry shelf', kind: 'pantry' } });
    expect(res.body.item).not.toHaveProperty('idempotency_key');
    expect(sql.calls[0].values).toContainEqual(HOUSEHOLD);
    const ins = sql.calls[1];
    expect(ins.values).toContain('Arborio rice');
    expect(ins.values).toContain('2026-10-03');
    expect(ins.values).toContain('day');
    expect(ins.values).toContain('big bag');
    expect(ins.values).toContain(K1);
    expect(ins.values).toContain(DAVE);   // user_id is the caller, never the body
    // never ON CONFLICT on the item itself (V4 §5.2); the only ON CONFLICT is the place find-or-create's
    expect(ins.norm.slice(ins.norm.indexOf('INSERT INTO pantry_item'))).not.toContain('ON CONFLICT');
    expect(ins.norm).toContain('ON CONFLICT (user_id, kind, lower(label)) WHERE deleted_at IS NULL DO UPDATE SET label = storage_location.label');
  });

  it('a new place {kind, label} is found or made in the SAME statement; no loader read', async () => {
    const sql = mockSql([inserted()]);
    const res = await call(sql, '/api/pantry/items', 'POST', body({ storage_location_id: undefined, place: { kind: 'cold_storage', label: ' Cellar ' } }));
    expect(res.status).toBe(201);
    expect(sql.calls).toHaveLength(1);
    expect(after(sql.calls[0], 'AND sl.kind =')).toBe('cold_storage');
    expect(sql.calls[0].values).toContain('Cellar');
    expect(sql.calls[0].values).toContainEqual(HOUSEHOLD);
  });

  it('a place outside the household → 400, nothing written', async () => {
    const sql = mockSql([[]]);
    const res = await call(sql, '/api/pantry/items', 'POST', body(), { householdIds: STRANGER });
    expect(res).toEqual({ status: 400, body: { error: 'storage_location_id does not match a place you can use' } });
    expect(sql.calls[0].values).toContainEqual(STRANGER);
    expect(sql.calls).toHaveLength(1);
  });

  it('a planting hit sets plant_id and its crop; a foreign planting → 400; a contradicting crop → 400', async () => {
    let sql = mockSql([placeRow, [{ id: PLANT, display_name: 'Walla Walla', crop_type_slug: 'onion' }], inserted({ plant_id: PLANT, crop_type_slug: 'onion' })]);
    let res = await call(sql, '/api/pantry/items', 'POST', body({ plant_id: PLANT }));
    expect(res.status).toBe(201);
    expect(sql.calls[1].values).toContainEqual(HOUSEHOLD);
    expect(sql.calls[2].values).toContain(PLANT);
    expect(sql.calls[2].values).toContain('onion');
    sql = mockSql([placeRow, []]);
    res = await call(sql, '/api/pantry/items', 'POST', body({ plant_id: PLANT }));
    expect(res.body.error).toMatch(/planting you can use/);
    sql = mockSql([placeRow, [{ id: PLANT, crop_type_slug: 'onion' }]]);
    res = await call(sql, '/api/pantry/items', 'POST', body({ plant_id: PLANT, crop_type_slug: 'garlic' }));
    expect(res.body.error).toMatch(/different crop/);
  });

  it('replay: 23505 on uq_pantry_item_idempotency_key → 200 {item, replayed}; a key outside the household → 409 key_conflict', async () => {
    let sql = mockSql([placeRow, err('23505', 'uq_pantry_item_idempotency_key'), inserted()]);
    let res = await call(sql, '/api/pantry/items', 'POST', body());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replayed: true, item: { id: ITEM } });
    expect(sql.calls[2].values).toContainEqual(HOUSEHOLD);
    expect(sql.calls[2].values).toContain(K1);
    sql = mockSql([placeRow, err('23505', 'uq_pantry_item_idempotency_key'), []]);
    res = await call(sql, '/api/pantry/items', 'POST', body());
    expect(res).toEqual({ status: 409, body: { error: 'That key is already in use.', code: 'key_conflict' } });
  });

  it('the CHECKs and the crop FK answer in words; anything else is thrown', async () => {
    let sql = mockSql([placeRow, err('23503', 'pantry_item_crop_type_slug_fkey')]);
    expect(await call(sql, '/api/pantry/items', 'POST', body({ crop_type_slug: 'kale2' })))
      .toEqual({ status: 400, body: { error: 'That crop is not one this app knows.' } });
    sql = mockSql([placeRow, err('23505', 'pantry_item_pkey')]);
    await expect(call(sql, '/api/pantry/items', 'POST', body())).rejects.toThrow();
  });
});

// ── PATCH / DELETE /api/pantry/items/:id ────────────────────────────────────────────────────────────
describe('PATCH /api/pantry/items/:id', () => {
  const path = `/api/pantry/items/${ITEM}`;
  const row = (over = {}) => [{ ...itemDb(), used_up_at: null, created_at: 'c', deleted_at: null, ...over }];
  const flag = (c, col) => after(c, `${col} = CASE WHEN`);

  it.each([
    [{}, /nothing to update/],
    [{ plant_id: PLANT }, /cannot be changed here/],
    [{ name: ' ' }, /name what it is/],
    [{ storage_location_id: null }, /always lives somewhere/],
    [{ acquired_at: '2026-10-01' }, /edited together/],
    [{ acquired_at: null, acquired_precision: 'day' }, /needs an acquired_at/],
    [{ used_up_at: '2026-10-01' }, /"now" or null/],
    [{ use_by_target: 'next week' }, /must be a date/],
  ])('%o → 400', async (b, want) => {
    expect(validateItemPatch(b)).toMatch(want);
    const sql = mockSql();
    expect((await call(sql, path, 'PATCH', b)).status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('presence-sentinel: only the sent keys change; household bound; 200 {item}', async () => {
    const sql = mockSql([row({ name: 'Carnaroli' })]);
    const res = await call(sql, path, 'PATCH', { name: ' Carnaroli ' }, { userId: JEN });
    expect(res).toMatchObject({ status: 200, body: { item: { name: 'Carnaroli' } } });
    const c = sql.calls[0];
    expect(flag(c, 'name')).toBe(true);
    expect(flag(c, 'storage_location_id')).toBe(false);
    expect(flag(c, 'acquired_at')).toBe(false);
    expect(flag(c, 'use_by_target')).toBe(false);
    expect(flag(c, 'notes')).toBe(false);
    expect(c.values).toContain('Carnaroli');
    expect(c.values).toContainEqual(HOUSEHOLD);
    expect(c.norm).toContain('AND deleted_at IS NULL');
  });

  it('Used it up stamps (keeping an earlier stamp); its Undo (null) clears', async () => {
    let sql = mockSql([row({ used_up_at: '2026-10-15T16:00:00Z' })]);
    await call(sql, path, 'PATCH', { used_up_at: 'now' });
    expect(sql.calls[0].norm).toContain('WHEN ? ::boolean THEN COALESCE(used_up_at, now()) ELSE NULL END');
    expect(after(sql.calls[0], 'used_up_at = CASE WHEN NOT')).toBe(true);
    expect(after(sql.calls[0], 'THEN used_up_at WHEN')).toBe(true);
    sql = mockSql([row()]);
    await call(sql, path, 'PATCH', { used_up_at: null });
    expect(after(sql.calls[0], 'THEN used_up_at WHEN')).toBe(false);
  });

  it('Move = storage_location_id, household-loaded first; a foreign place → 400, nothing written', async () => {
    let sql = mockSql([[{ id: PLACE, label: 'Cellar', kind: 'cold_storage' }], row({ storage_location_id: PLACE, place_label: 'Cellar', place_kind: 'cold_storage' })]);
    let res = await call(sql, path, 'PATCH', { storage_location_id: PLACE });
    expect(res.body.item.place).toEqual({ id: PLACE, label: 'Cellar', kind: 'cold_storage' });
    expect(sql.calls[0].values).toContainEqual(HOUSEHOLD);
    sql = mockSql([[]]);
    res = await call(sql, path, 'PATCH', { storage_location_id: PLACE });
    expect(res.status).toBe(400);
    expect(sql.calls).toHaveLength(1);
  });

  it('the date pair travels together and "unknown" stores no day', async () => {
    const sql = mockSql([row()]);
    await call(sql, path, 'PATCH', { acquired_at: null, acquired_precision: 'unknown' });
    expect(after(sql.calls[0], 'acquired_precision = CASE WHEN ? ::boolean THEN')).toBe('unknown');
  });

  it('not found, a stranger\'s, a removed one, or a malformed id → 404', async () => {
    let sql = mockSql([[]]);
    expect((await call(sql, path, 'PATCH', { notes: 'x' }, { householdIds: STRANGER })).status).toBe(404);
    expect(sql.calls[0].values).toContainEqual(STRANGER);
    sql = mockSql();
    expect((await call(sql, '/api/pantry/items/rice', 'PATCH', { notes: 'x' })).status).toBe(404);
    expect(sql.calls).toHaveLength(0);
  });

  it('DELETE is a soft delete (200 {ok}); a second one, or a stranger\'s, is 404', async () => {
    let sql = mockSql([[{ id: ITEM }]]);
    expect(await call(sql, path, 'DELETE')).toEqual({ status: 200, body: { ok: true } });
    expect(sql.calls[0].norm).toContain('UPDATE pantry_item SET deleted_at = now() WHERE id = ? ::uuid AND user_id = ANY( ? ) AND deleted_at IS NULL');
    expect(sql.calls[0].norm).not.toContain('DELETE FROM');
    sql = mockSql([[]]);
    expect((await call(sql, path, 'DELETE', null, { householdIds: STRANGER })).status).toBe(404);
  });
});

// ── POST /api/pantry/uses — B′'s fates ─────────────────────────────────────────────────────────────
describe('POST /api/pantry/uses — Went bad and Gave it away (the fate widening)', () => {
  const use = (b, householdIds = HOUSEHOLD) => handlePantryUses({
    sql: mockSql([[], [{ left_n: 3, use: { id: 'u1', fate: b.fate ?? null }, jar: { id: JAR, remaining_count: 0 } }]]),
    rawPath: '/api/pantry/uses', method: 'POST', rawBody: JSON.stringify(b), userId: DAVE, householdIds,
  });

  it('Went bad = all that is left, fate discarded, bound on the use row', async () => {
    const sql = mockSql([[], [{ left_n: 3, use: { id: 'u1', fate: 'discarded' }, jar: { id: JAR, remaining_count: 0 } }]]);
    const res = await handlePantryUses({
      sql, rawPath: '/api/pantry/uses', method: 'POST', userId: DAVE, householdIds: HOUSEHOLD,
      rawBody: JSON.stringify({ idempotency_key: K1, preservation_log_id: JAR, all_remaining: true, fate: 'discarded' }),
    });
    expect(res.status).toBe(201);
    const s = sql.batches[0][1];
    expect(s.norm).toContain('INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, idempotency_key)');
    expect(after(s, 'jar.id, jar.used,')).toBe('discarded');
  });

  it('Gave it away = a count (or all of it), fate given_away', async () => {
    expect((await use({ idempotency_key: K1, preservation_log_id: JAR, count_used: 2, fate: 'given_away' })).status).toBe(201);
    expect((await use({ idempotency_key: K1, preservation_log_id: JAR, all_remaining: true, fate: 'given_away' })).status).toBe(201);
  });

  // Put-Up UX pass R1: Went bad may be a count as well as all that is left. This row was a 400 ("Went bad is
  // all that is left") until then; it is accepted now, and what reaches the statement is the count.
  it("{ count_used: 1, fate: 'discarded' } → accepted (201): a count, not all that is left, fate discarded", async () => {
    const full = { idempotency_key: K1, preservation_log_id: JAR, count_used: 1, fate: 'discarded' };
    expect(validateUse(full)).toBeNull();
    expect((await use(full)).status).toBe(201);
    const sql = mockSql([[], [{ left_n: 3, use: { id: 'u1', fate: 'discarded' }, jar: { id: JAR, remaining_count: 2 } }]]);
    await handlePantryUses({
      sql, rawPath: '/api/pantry/uses', method: 'POST', userId: DAVE, householdIds: HOUSEHOLD, rawBody: JSON.stringify(full),
    });
    const s = sql.batches[0][1];
    expect(after(s, 'SELECT pre.id, CASE WHEN')).toBe(false);
    expect(after(s, 'THEN pre.left_n ELSE')).toBe(1);
    expect(after(s, 'jar.id, jar.used,')).toBe('discarded');
  });

  it.each([
    [{ count_used: 1, fate: 'batch' }, /fate must be one of/],
    [{ count_used: 1, fate: 'eaten' }, /fate must be one of/],
  ])('%o → 400', async (b, want) => {
    const full = { idempotency_key: K1, preservation_log_id: JAR, ...b };
    expect(validateUse(full)).toMatch(want);
    expect((await use(full)).status).toBe(400);
  });

  it('eaten (no fate) is unchanged: NULL bound', async () => {
    const sql = mockSql([[], [{ left_n: 3, use: { id: 'u1' }, jar: { id: JAR } }]]);
    await handlePantryUses({
      sql, rawPath: '/api/pantry/uses', method: 'POST', userId: DAVE, householdIds: HOUSEHOLD,
      rawBody: JSON.stringify({ idempotency_key: K1, preservation_log_id: JAR, count_used: 1 }),
    });
    expect(after(sql.batches[0][1], 'jar.id, jar.used,')).toBeNull();
  });
});

// ── POST /api/pantry/uses — Went bad as a count (Put-Up UX pass R1) ──────────────────────────────────
// One rule left validateUse (a discard had to be all that is left); nothing else moved. What still refuses,
// what a part binds, and that a part answers the way every other count does: over what is left, a stranger,
// a replay. MUTATION: put the refusal back in pantryUses.js → the accept cases here and above go red.
describe('POST /api/pantry/uses — Went bad as a count (Put-Up UX pass R1)', () => {
  const body = (over = {}) => ({ idempotency_key: K1, preservation_log_id: JAR, fate: 'discarded', ...over });
  const post = (sql, b, householdIds = HOUSEHOLD) => handlePantryUses({
    sql, rawPath: '/api/pantry/uses', method: 'POST', rawBody: JSON.stringify(b), userId: DAVE, householdIds,
  });

  it.each([
    [{ count_used: 1, all_remaining: true }, /one of them/],   // both keys
    [{}, /one of them/],                                       // neither
    [{ all_remaining: false }, /one of them/],                 // neither, said out loud
    [{ count_used: 0 }, /1 or more/],
    [{ count_used: 1.5 }, /1 or more/],
    [{ count_used: -1 }, /1 or more/],
    [{ count_used: 1, fate: 'batch' }, /fate must be one of/],
  ])('still refused with fate discarded: %o → 400, nothing sent', async (over, want) => {
    expect(validateUse(body(over))).toMatch(want);
    const sql = mockSql();
    expect((await post(sql, body(over))).status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it.each([[1], [2], [3]])('a count of %i is accepted, as all that is left still is', (n) => {
    expect(validateUse(body({ count_used: n }))).toBeNull();
    expect(validateUse(body({ all_remaining: true }))).toBeNull();
  });

  it('a part binds the count sent and the fate; the statement is the one an eaten count sends, to the letter', async () => {
    const answer = { left_n: 4, use: { id: 'u1', count_used: 2, fate: 'discarded' }, jar: { id: JAR, remaining_count: 2, consumed_at: null } };
    const part = mockSql([[], [answer]]);
    expect(await post(part, body({ count_used: 2 }))).toEqual({ status: 201, body: { use: answer.use, jar: answer.jar } });
    const eaten = mockSql([[], [answer]]);
    await post(eaten, { idempotency_key: K1, preservation_log_id: JAR, count_used: 2 });
    const [g, s] = part.batches[0];
    const e = eaten.batches[0][1];
    expect(g.norm).toBe(GUC);
    expect(g.values).toEqual([DAVE]);
    expect(s.text).toBe(e.text);
    expect(after(s, 'SELECT pre.id, CASE WHEN')).toBe(false);   // not all that is left
    expect(after(s, 'THEN pre.left_n ELSE')).toBe(2);           // the count, as sent
    expect(after(s, 'jar.id, jar.used,')).toBe('discarded');
    // The fate is the ONE bound value that differs between the two taps.
    expect(s.values).toHaveLength(e.values.length);
    const differ = s.values.map((v, i) => [v, e.values[i]]).filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b));
    expect(differ).toEqual([['discarded', null]]);
  });

  it('more than is left → 409 only_n_left with what the jar has; no use comes back', async () => {
    const sql = mockSql([[], [{ left_n: 2, use: null, jar: null }]]);
    expect(await post(sql, body({ count_used: 3 })))
      .toEqual({ status: 409, body: { error: 'Only 2 left in that one.', code: 'only_n_left', n: 2 } });
    // The refusal is the statement's own: the count is judged in the UPDATE's WHERE, on the row it locks.
    expect(sql.batches[0][1].norm).toContain('AND w.n >= 1 AND COALESCE(p.remaining_count, p.package_count) >= w.n');
  });

  it('a stranger → 404 not_found, their own household bound', async () => {
    const sql = mockSql([[], [{ left_n: null, use: null, jar: null }]]);
    expect(await post(sql, body({ count_used: 1 }), STRANGER))
      .toEqual({ status: 404, body: { error: 'Not found', code: 'not_found' } });
    expect(sql.batches[0][1].values).toContainEqual(STRANGER);
    expect(sql.batches[0][1].values).not.toContainEqual(HOUSEHOLD);
  });

  it('a replay moves nothing twice: the key already recorded → 200 replayed, read back household-scoped', async () => {
    const first = { use: { id: 'u1', count_used: 1, fate: 'discarded' }, jar: { id: JAR, remaining_count: 3 } };
    let sql = mockSql([[], [{ prior_n: 1, left_n: 3, use: null, jar: null }], [first]]);
    expect(await post(sql, body({ count_used: 1 }))).toEqual({ status: 200, body: { replayed: true, ...first } });
    // ONE write statement was sent, and in it nothing moves when the key is already recorded.
    expect(sql.batches).toHaveLength(1);
    expect(sql.batches[0][1].norm).toContain('FROM pre WHERE NOT EXISTS (SELECT 1 FROM prior)');
    expect(sql.calls).toHaveLength(3);
    expect(sql.calls[2].norm).toMatch(/^SELECT row_to_json\(u\) AS use,/);
    expect(sql.calls[2].norm).not.toMatch(/\b(UPDATE|INSERT)\b/);
    expect(sql.calls[2].values).toEqual([K1, HOUSEHOLD]);
    // Two phones at once: the unique key refuses the second insert, and the answer is the same replay.
    sql = mockSql([[], err('23505', 'uq_pantry_use_idempotency_key'), [first]]);
    expect(await post(sql, body({ count_used: 1 }))).toEqual({ status: 200, body: { replayed: true, ...first } });
  });
});

// ── POST /api/pantry/uses/:id/undo ───────────────────────────────────────────────────────────────
describe('POST /api/pantry/uses/:id/undo', () => {
  const path = `/api/pantry/uses/${USE}/undo`;
  const fwd = (over = {}) => ({ id: USE, preservation_log_id: JAR, count_used: 1, fate: null, kitchen_batch_input_id: null, reverses_use_id: null, ...over });
  const result = (over = {}) => [{ prior: null, fwd: fwd(), done_n: 0, use: { id: 'r1', count_used: -1, reverses_use_id: USE }, jar: { id: JAR, remaining_count: 3, consumed_at: null, remaining_amount: null }, ...over }];
  const undo = (sql, b = { idempotency_key: K2 }, opts) => call(sql, path, 'POST', b, opts);

  it('ONE statement in the actor transaction: the reversing row + the increment, delta_at stamped, consumed cleared → 200 {use, jar}', async () => {
    const sql = mockSql([[], result()]);
    const res = await undo(sql, undefined, { userId: JEN });
    expect(res).toEqual({ status: 200, body: { use: { id: 'r1', count_used: -1, reverses_use_id: USE }, jar: { id: JAR, remaining_count: 3, consumed_at: null, remaining_amount: null } } });
    const [g, s] = sql.batches[0];
    expect(g.norm).toBe(GUC);
    expect(g.values).toEqual([JEN]);   // Jen undoing Dave's use records Jen (V4 §5.3)
    expect(s.norm).toContain('remaining_count = COALESCE(p.remaining_count, p.package_count) + ok.count_used, delta_at = now(), consumed_at = NULL');
    expect(s.norm).toContain('INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, reverses_use_id, idempotency_key) SELECT ? ::text, jar.id, -jar.n, jar.fate, jar.use_id, ? ::uuid FROM jar');
    expect(s.norm).toContain('AND fwd.count_used > 0 AND fwd.reverses_use_id IS NULL AND fwd.kitchen_batch_input_id IS NULL');
    expect(s.norm).toContain('WHERE u.id = ? ::uuid AND p.user_id = ANY( ? )');
    expect(s.values).toContainEqual(HOUSEHOLD);
    expect(s.values).toContain(K2);
    expect(s.norm).not.toContain('ON CONFLICT');
  });

  it('a weighed bag the use took to 0 g gets its grams back as its weight less its live weighed draws', async () => {
    const sql = mockSql([[], result()]);
    await undo(sql);
    const s = sql.batches[0][1].norm;
    expect(s).toContain('remaining_amount = CASE WHEN p.package_count = 1 AND p.quantity_unit = ANY( ? ::text[]) AND p.remaining_amount = 0 THEN GREATEST(');
    expect(s).toContain("WHERE i.preservation_log_id = p.id AND i.input_kind = 'put_up' AND i.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM pantry_use lu WHERE lu.kitchen_batch_input_id = i.id)");
  });

  it('a batch-linked use is refused here: 409 use_is_batch_line, nothing moved', async () => {
    const sql = mockSql([[], result({ fwd: fwd({ fate: 'batch', kitchen_batch_input_id: 'line-1' }), use: null, jar: null })]);
    expect(await undo(sql)).toEqual({ status: 409, body: { code: 'use_is_batch_line', error: 'That went into a batch — take the line out there to put it back.' } });
  });

  it('undo twice: the same key → replay 200; another key → 409 already_undone', async () => {
    let sql = mockSql([[], result({ prior: { id: 'r1', reverses_use_id: USE }, use: null, jar: null }), [{ use: { id: 'r1' }, jar: { id: JAR } }]]);
    let res = await undo(sql);
    expect(res).toEqual({ status: 200, body: { replayed: true, use: { id: 'r1' }, jar: { id: JAR } } });
    expect(sql.calls[2].norm).toContain('WHERE u.idempotency_key = ? ::uuid AND u.reverses_use_id = ? ::uuid AND p.user_id = ANY( ? )');
    expect(sql.calls[2].values).toContainEqual(HOUSEHOLD);
    sql = mockSql([[], result({ done_n: 1, use: null, jar: null })]);
    res = await undo(sql, { idempotency_key: K1 });
    expect(res).toEqual({ status: 409, body: { code: 'already_undone', error: 'That was already undone.' } });
  });

  it('two phones at once: 23505 on uq_pantry_use_reverses_use_id → already_undone; on the key → replay; a key used elsewhere → key_conflict', async () => {
    let sql = mockSql([[], err('23505', 'uq_pantry_use_reverses_use_id')]);
    expect((await undo(sql)).body.code).toBe('already_undone');
    sql = mockSql([[], err('23505', 'uq_pantry_use_idempotency_key'), [{ use: { id: 'r1' }, jar: { id: JAR } }]]);
    expect((await undo(sql)).body.replayed).toBe(true);
    sql = mockSql([[], result({ prior: { id: 'x', reverses_use_id: null }, use: null, jar: null }), []]);
    expect(await undo(sql)).toEqual({ status: 409, body: { error: 'That key is already in use.', code: 'key_conflict' } });
  });

  it('a reversal cannot itself be undone; a removed jar → 409; a lowered count → 409 count_changed', async () => {
    let sql = mockSql([[], result({ fwd: fwd({ count_used: -1, reverses_use_id: 'u0' }), use: null, jar: null })]);
    expect((await undo(sql)).body.code).toBe('use_is_reversal');
    sql = mockSql([[], result({ use: null, jar: null })]);
    expect((await undo(sql)).body.code).toBe('jar_removed');
    sql = mockSql([[], err('23514', 'chk_preservation_log_remaining_within_package')]);
    expect((await undo(sql)).body.code).toBe('count_changed');
  });

  it('a stranger\'s use (or none) → 404, household bound; a malformed id → 404 unread; a bad key → 400', async () => {
    let sql = mockSql([[], result({ fwd: null, use: null, jar: null })]);
    expect((await undo(sql, undefined, { householdIds: STRANGER })).status).toBe(404);
    expect(sql.batches[0][1].values).toContainEqual(STRANGER);
    sql = mockSql();
    expect((await call(sql, '/api/pantry/uses/u1/undo', 'POST', { idempotency_key: K1 })).status).toBe(404);
    expect((await undo(sql, { idempotency_key: 'k' })).status).toBe(400);
    expect((await undo(sql, { idempotency_key: K1, count_used: 1 })).status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });
});

// ── DELETE /api/preservation/:id — Remove on a put-up ─────────────────────────────────────────────
describe('removeJar (DELETE /api/preservation/:id)', () => {
  const rm = (sql, householdIds = HOUSEHOLD) => removeJar(sql, JAR, DAVE, householdIds);

  it('an unused jar with no live lines: ONE statement in the actor transaction → 200 {ok}', async () => {
    const sql = mockSql([[], [{ found: 1, used_n: 0, line_n: 0, batch_label: null, removed: 1 }]]);
    expect(await rm(sql)).toEqual({ status: 200, body: { ok: true } });
    const [g, s] = sql.batches[0];
    expect(g.norm).toBe(GUC);
    expect(s.norm).toContain('UPDATE preservation_log p SET deleted_at = now() FROM jar WHERE p.id = jar.id AND (SELECT n FROM used) <= 0 AND NOT EXISTS (SELECT 1 FROM lines)');
    expect(s.norm).toContain('AND u.kitchen_batch_input_id IS NULL');
    expect(s.norm).toContain('WHERE i.preservation_log_id = ? ::uuid AND i.deleted_at IS NULL');
    expect(s.values).toContainEqual(HOUSEHOLD);
  });

  it('a jar that was used → 409 jar_was_used with the path; one a batch drew from → 409 jar_in_batch', async () => {
    let sql = mockSql([[], [{ found: 1, used_n: 1, line_n: 0, batch_label: null, removed: 0 }]]);
    expect(await rm(sql)).toEqual({ status: 409, body: { code: 'jar_was_used', n: 1, error: '1 was used — mark the rest Went bad, or undo that use.' } });
    sql = mockSql([[], [{ found: 1, used_n: 0, line_n: 1, batch_label: 'Petri Dish', removed: 0 }]]);
    expect(await rm(sql)).toEqual({ status: 409, body: { code: 'jar_in_batch', lines: 1, error: 'Some of it went into “Petri Dish” — take that line out first.' } });
  });

  it('a stranger\'s, a removed or a missing jar → 404; a malformed id → 404 unread', async () => {
    let sql = mockSql([[], [{ found: 0, used_n: 0, line_n: 0, batch_label: null, removed: 0 }]]);
    expect((await rm(sql, STRANGER)).status).toBe(404);
    expect(sql.batches[0][1].values).toContainEqual(STRANGER);
    sql = mockSql();
    expect((await removeJar(sql, 'whats-put-up', DAVE, HOUSEHOLD)).status).toBe(404);
    expect(sql.calls).toHaveLength(0);
  });
});

// ── a batch line that names a pantry item (POST /api/kitchen-batches/:id/inputs, keyed) ────────────
describe('a pantry line on the keyed line POST', () => {
  const OPEN = [{ id: BATCH, closed_at: null, suspended_at: null, started_at: '2026-09-28T14:00:00Z' }];
  const post = (inputs, householdIds = HOUSEHOLD) => ({
    rawPath: `/api/kitchen-batches/${BATCH}/inputs`, method: 'POST', rawBody: JSON.stringify({ inputs }), query: {},
    userId: DAVE, householdIds,
  });
  const item = (over = {}) => ({ id: ITEM, name: 'Morton pickling salt', plant_id: null, crop_type_slug: null, used_up_at: null, deleted_at: null, ...over });

  it('household-loaded; the item\'s name stamped as the label; pantry_item_id bound; no stock moves', async () => {
    const sql = mockSql([OPEN, [], [item()], [], [{ inserted: 1, jars_moved: 0, uses_written: 0 }], [{ id: 'l1', pantry_item_id: ITEM }]]);
    const res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'pantry', idempotency_key: K1, pantry_item_id: ITEM, qty: 30, qty_unit: 'g' }]) });
    expect(res.status).toBe(201);
    const loader = sql.calls[2];
    expect(loader.norm).toContain('FROM pantry_item i WHERE i.id = ANY( ? ::uuid[]) AND i.user_id = ANY( ? )');
    expect(loader.values).toContainEqual(HOUSEHOLD);
    const s = sql.batches[0][1];
    expect(s.norm).toContain('created_by, pantry_item_id ) SELECT');
    expect(s.values).toContainEqual([ITEM]);             // the pantry_item_id array
    expect(s.values).toContainEqual(['Morton pickling salt']);
    expect(s.values).toContainEqual([null]);             // draw_count: a pantry line draws nothing
    expect(s.values).toContainEqual([false]);            // draw_weighed
    expect(s.values).toContainEqual(['pantry']);
  });

  it('a "Fresh, as picked" item brings its planting and crop, server-set', async () => {
    const sql = mockSql([OPEN, [], [item({ name: 'Walla Walla', plant_id: PLANT, crop_type_slug: 'onion' })], [], [{ inserted: 1 }], []]);
    await handleKitchenRoute({ sql, ...post([{ input_kind: 'pantry', idempotency_key: K1, pantry_item_id: ITEM }]) });
    const s = sql.batches[0][1];
    expect(s.values).toContainEqual([PLANT]);
    expect(s.values).toContainEqual(['onion']);
  });

  it('a foreign item → 400; a removed one → 409 item_removed; nothing written', async () => {
    let sql = mockSql([OPEN, [], []]);
    let res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'pantry', idempotency_key: K1, pantry_item_id: ITEM }]) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pantry item does not match/);
    sql = mockSql([OPEN, [], [item({ deleted_at: '2026-10-01' })]]);
    res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'pantry', idempotency_key: K1, pantry_item_id: ITEM }]) });
    expect(res).toMatchObject({ status: 409, body: { code: 'item_removed' } });
    expect(sql.batches).toHaveLength(0);
  });

  it('the pairing rule both ways, and a salt line may be a pantry item', () => {
    const l = (o) => ({ idempotency_key: K1, ...o });
    expect(lineError(l({ input_kind: 'pantry' }), { pantry: true })).toMatch(/names its item/);
    expect(lineError(l({ input_kind: 'other', label: 'x', pantry_item_id: ITEM }), { pantry: true })).toMatch(/only a pantry line carries/);
    expect(lineError(l({ input_kind: 'pantry', pantry_item_id: 'rice' }), { pantry: true })).toMatch(/must be a uuid/);
    expect(lineError(l({ input_kind: 'pantry', pantry_item_id: ITEM, count_drawn: 1 }), { pantry: true })).toMatch(/only on a draw/);
    expect(lineError(l({ input_kind: 'pantry', pantry_item_id: ITEM, role: 'salt', qty: 20, qty_unit: 'g' }), { pantry: true })).toBeNull();
  });

  it('a put-up sitting still refuses a pantry line (its INSERT binds no pantry_item_id)', () => {
    const sitting = {
      idempotency_key: K1, when: { date: '2026-10-08', precision: 'day' }, method: 'hot_sauce', finish: true,
      rows: [{ count: 1, added_lines: [{ input_kind: 'pantry', pantry_item_id: ITEM, label: 'vinegar' }] }],
    };
    expect(validatePutUp(sitting)).toMatch(/a bought item goes in What went in, not on a bottling/);
    // The refusal is putUp.js's own: How it was made (unkeyed lines) takes a pantry line (B′ release 3).
    expect(lineError({ input_kind: 'pantry', pantry_item_id: ITEM }, { keyed: false })).toBeNull();
  });
});

// ── R2a (V5-PUTUPLOGRETIRE-001, contract 5) — an item's amount and where-from ────────────────────────
// The create, the replay row, the PATCH and the list row carry quantity_value (a JSON number or null),
// quantity_unit, source_kind and source_label AS STORED. Six hand-written column lists and two projections
// each have a test below that names them, because an allowlist catches a misspelt key and nothing else
// catches a key that is allowed and never written, or never returned.
const FOUR = ['quantity_value', 'quantity_unit', 'source_kind', 'source_label'];
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i;
const splitTop = (s) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
// The create INSERT read BY COLUMN: the column list is the first parenthesis after INSERT INTO pantry_item,
// the values are the SELECT's top-level expressions up to RETURNING, and each expression holding a `?`
// takes the next bound value. storage_location_id is a sub-select and binds nothing.
function insertByColumn(c) {
  const head = 'INSERT INTO pantry_item (';
  const open = c.norm.indexOf(head) + head.length;
  expect(open, 'the statement has the item INSERT').toBeGreaterThan(head.length - 1);
  const close = c.norm.indexOf(')', open);
  const columns = c.norm.slice(open, close).split(',').map((s) => s.trim());
  const selAt = c.norm.indexOf('SELECT', close);
  const retAt = c.norm.indexOf('RETURNING', selAt);
  const exprs = splitTop(c.norm.slice(selAt + 'SELECT'.length, retAt));
  expect(exprs).toHaveLength(columns.length);
  let n = (c.norm.slice(0, selAt).match(/\?/g) ?? []).length;
  const binds = {};
  columns.forEach((col, i) => {
    if (exprs[i].includes('?')) { binds[col] = c.values[n]; n += 1; } else binds[col] = exprs[i];
  });
  const returning = c.norm.slice(retAt + 'RETURNING'.length, c.norm.indexOf(')', retAt)).split(',').map((s) => s.trim());
  return { columns, binds, returning };
}
// A RETURNING or SELECT list, as the names it carries (an `i.` or `p.` alias dropped).
const listed = (norm, from, to) => norm.slice(norm.indexOf(from) + from.length, norm.indexOf(to, norm.indexOf(from)))
  .split(',').map((s) => s.trim().replace(/^[a-z]+\./, ''));

describe('R2a — the item allowlists', () => {
  it('ITEM_CREATE_KEYS is the ten it had plus the four; ITEM_PATCH_KEYS the seven it had plus the four', () => {
    expect([...ITEM_CREATE_KEYS].sort()).toEqual([
      'acquired_at', 'acquired_precision', 'crop_type_slug', 'idempotency_key', 'name', 'notes', 'place', 'plant_id',
      'quantity_unit', 'quantity_value', 'source_kind', 'source_label', 'storage_location_id', 'use_by_target',
    ]);
    expect([...ITEM_PATCH_KEYS].sort()).toEqual([
      'acquired_at', 'acquired_precision', 'name', 'notes', 'quantity_unit', 'quantity_value', 'source_kind',
      'source_label', 'storage_location_id', 'use_by_target', 'used_up_at',
    ]);
  });

  it.each(FOUR)('the create takes %s: a body carrying it is not an unknown field', (key) => {
    expect(ITEM_CREATE_KEYS).toContain(key);
    const body = { idempotency_key: K1, name: 'Rice', storage_location_id: PLACE, quantity_value: 2, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' };
    expect(validateItemCreate(body)).toBeNull();
  });

  it.each(FOUR)('the PATCH takes %s: a body carrying it can be changed here', (key) => {
    expect(ITEM_PATCH_KEYS).toContain(key);
    expect(validateItemPatch({ quantity_value: 2, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' })).toBeNull();
  });

  it('plant_id is still not a PATCH key: a planting is never changed here', () => {
    expect(ITEM_PATCH_KEYS).not.toContain('plant_id');
    expect(validateItemPatch({ plant_id: PLANT })).toMatch(/cannot be changed here: plant_id/);
  });
});

describe('R2a — POST /api/pantry/items with an amount and where-from', () => {
  const placeRow = [{ id: PLACE, label: 'Pantry shelf', kind: 'pantry' }];
  const plantRow = [{ id: PLANT, display_name: 'Walla Walla', crop_type_slug: 'onion' }];
  const stored = (over = {}) => [{
    ...itemDb({ user_id: DAVE, storage_location_id: PLACE, acquired_at: null, acquired_precision: null, notes: null }),
    used_up_at: null, created_at: 'c', deleted_at: null, ...over,
  }];
  // Every option an as-is save can hold. BOUGHT: a typed name at a known place. FRESH: a planting at a new place.
  const BOUGHT = {
    idempotency_key: K1, name: '  Arborio rice ', storage_location_id: PLACE, acquired_at: '2026-10-03',
    acquired_precision: 'day', use_by_target: '2027-03-01', notes: ' the big bag ', crop_type_slug: 'rice',
    quantity_value: 2.5, quantity_unit: 'lb', source_kind: 'store', source_label: ' Costco ',
  };
  const FRESH = {
    idempotency_key: K2, name: 'Walla Walla, fresh', place: { kind: 'cold_storage', label: 'Cellar' },
    acquired_precision: 'unknown', plant_id: PLANT, quantity_value: 6, quantity_unit: 'count', source_kind: 'own_garden',
  };

  it('the two fixtures between them send every create key, and both pass the validator', () => {
    expect([...new Set([...Object.keys(BOUGHT), ...Object.keys(FRESH)])].sort()).toEqual([...ITEM_CREATE_KEYS].sort());
    expect(validateItemCreate(BOUGHT)).toBeNull();
    expect(validateItemCreate(FRESH)).toBeNull();
  });

  it('a bought item: every body key that is a column is in the INSERT, bound to what was sent', async () => {
    const sql = mockSql([placeRow, stored()]);
    expect((await call(sql, '/api/pantry/items', 'POST', BOUGHT)).status).toBe(201);
    const { columns, binds } = insertByColumn(sql.calls[1]);
    expect(columns).toEqual(expect.arrayContaining(FOUR));
    expect(binds).toMatchObject({
      user_id: DAVE, name: 'Arborio rice', acquired_at: '2026-10-03', acquired_precision: 'day', use_by_target: '2027-03-01',
      plant_id: null, crop_type_slug: 'rice', notes: 'the big bag', idempotency_key: K1,
      quantity_value: 2.5, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco',
    });
    expect(binds.storage_location_id).toBe('(SELECT id FROM place LIMIT 1)');
  });

  it('a fresh-as-picked item: the planting with our garden beside it, and no name stored for the garden', async () => {
    const sql = mockSql([plantRow, stored({ plant_id: PLANT })]);
    expect((await call(sql, '/api/pantry/items', 'POST', FRESH)).status).toBe(201);
    const { binds } = insertByColumn(sql.calls[1]);
    expect(binds).toMatchObject({
      plant_id: PLANT, crop_type_slug: 'onion', quantity_value: 6, quantity_unit: 'count',
      source_kind: 'own_garden', source_label: null,
    });
  });

  it("today's ten keys: all four bound NULL", async () => {
    const old = { idempotency_key: K1, name: 'Rice', storage_location_id: PLACE, acquired_at: '2026-10-03', acquired_precision: 'day', use_by_target: null, notes: 'x', plant_id: null, crop_type_slug: null };
    const sql = mockSql([placeRow, stored()]);
    expect((await call(sql, '/api/pantry/items', 'POST', old)).status).toBe(201);
    const { binds } = insertByColumn(sql.calls[1]);
    expect(FOUR.map((k) => binds[k])).toEqual([null, null, null, null]);
  });

  it('the create RETURNING names the four, and the item answered carries them as stored', async () => {
    const sql = mockSql([placeRow, stored({ quantity_value: '2.50', quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' })]);
    const res = await call(sql, '/api/pantry/items', 'POST', BOUGHT);
    expect(insertByColumn(sql.calls[1]).returning).toEqual(expect.arrayContaining(FOUR));
    expect(res.body.item).toMatchObject({ quantity_value: 2.5, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' });
  });

  it('the amount answered is a number, not a string (the driver hands numeric back as text)', () => {
    const item = projectItem(itemDb({ quantity_value: '2.00', quantity_unit: 'lb' }));
    expect(item.quantity_value).toBe(2);
    expect(typeof item.quantity_value).toBe('number');
    expect(projectItem(itemDb()).quantity_value).toBeNull();
    const row = itemRow(itemDb({ quantity_value: '0.50', quantity_unit: 'qt' }), 'place', NOW);
    expect(row.quantity_value).toBe(0.5);
    expect(typeof jarRow(jarDb(), 'place', NOW).quantity_value).toBe('number');
  });

  it('projectItem carries each of the four as stored, and null for a row without them', () => {
    const item = projectItem(itemDb({ quantity_value: '12', quantity_unit: 'count', source_kind: 'gift', source_label: 'Aunt May' }));
    expect(FOUR.map((k) => item[k])).toEqual([12, 'count', 'gift', 'Aunt May']);
    expect(FOUR.map((k) => projectItem(itemDb())[k])).toEqual([null, null, null, null]);
  });

  it('the replay SELECT names the four, and the replayed item carries them', async () => {
    const sql = mockSql([placeRow, err('23505', 'uq_pantry_item_idempotency_key'), stored({ quantity_value: '2.50', quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' })]);
    const res = await call(sql, '/api/pantry/items', 'POST', BOUGHT);
    expect(res.status).toBe(200);
    expect(listed(sql.calls[2].norm, 'SELECT ', ' FROM pantry_item i')).toEqual(expect.arrayContaining(FOUR));
    expect(res.body).toMatchObject({ replayed: true, item: { quantity_value: 2.5, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' } });
  });

  it.each([
    ['an amount needs its unit, and a unit its amount', { quantity_value: 2 }, /needs its unit/],
    ['an amount needs its unit, and a unit its amount (the unit alone)', { quantity_unit: 'lb' }, /needs its unit/],
    ['0 is not an amount', { quantity_value: 0, quantity_unit: 'lb' }, /above 0/],
    ['a negative is not an amount', { quantity_value: -1, quantity_unit: 'lb' }, /above 0/],
    ['0.004 rounds to nothing', { quantity_value: 0.004, quantity_unit: 'lb' }, /above 0/],
    ['an amount typed as text', { quantity_value: '2', quantity_unit: 'lb' }, /must be a number/],
    ['more than the column holds', { quantity_value: 100000000, quantity_unit: 'lb' }, /at most 99999999\.99/],
    ['a unit outside the 25 is refused (a plural)', { quantity_value: 2, quantity_unit: 'lbs' }, /quantity_unit must be one of/],
    ['a unit outside the 25 is refused (quart)', { quantity_value: 2, quantity_unit: 'quart' }, /quantity_unit must be one of/],
    ['a name with no source', { source_label: 'Costco' }, /needs a source/],
    ['a kind outside the eight', { source_kind: 'swap' }, /source_kind must be one of/],
    ['Other needs a name', { source_kind: 'other' }, /needs a name/],
    ['Other needs a name (a blank one)', { source_kind: 'other', source_label: '   ' }, /needs a name/],
    ['121 characters refused', { source_kind: 'store', source_label: 'x'.repeat(121) }, /at most 120/],
    ['a name that is not text', { source_kind: 'store', source_label: 5 }, /must be text/],
  ])('%s → 400, nothing read', async (_what, over, want) => {
    const body = { idempotency_key: K1, name: 'Rice', storage_location_id: PLACE, ...over };
    expect(validateItemCreate(body)).toMatch(want);
    const sql = mockSql();
    expect((await call(sql, '/api/pantry/items', 'POST', body)).status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('a planting item cannot have a non-garden source (create): refused in words, nothing read', async () => {
    const body = { idempotency_key: K1, name: 'Onions', storage_location_id: PLACE, plant_id: PLANT, source_kind: 'store' };
    expect(validateItemCreate(body)).toBe(PLANTING_SOURCE_REFUSAL);
    const sql = mockSql();
    expect(await call(sql, '/api/pantry/items', 'POST', body)).toEqual({ status: 400, body: { error: PLANTING_SOURCE_REFUSAL } });
    expect(sql.calls).toHaveLength(0);
    // our garden beside a planting is the door's own body, and is taken
    expect(validateItemCreate({ ...body, source_kind: 'own_garden' })).toBeNull();
  });

  it('the amount is rounded to two places on its decimal text, and the rounded number is what is bound', () => {
    expect(amountOf({ quantity_value: 0.005, quantity_unit: 'lb' })).toEqual({ quantity_value: 0.01, quantity_unit: 'lb' });
    expect(amountOf({ quantity_value: 2.345, quantity_unit: 'lb' })).toEqual({ quantity_value: 2.35, quantity_unit: 'lb' });
    expect(amountOf({ quantity_value: 1.005, quantity_unit: 'qt' })).toEqual({ quantity_value: 1.01, quantity_unit: 'qt' });
    expect(amountOf({ quantity_value: ITEM_AMOUNT_MAX, quantity_unit: 'g' })).toEqual({ quantity_value: 99999999.99, quantity_unit: 'g' });
    expect(amountOf({ quantity_value: 99999999.995, quantity_unit: 'g' }).error).toMatch(/at most/);
    expect(amountOf({ quantity_value: 1e-7, quantity_unit: 'g' }).error).toMatch(/above 0/);
    expect(amountOf({ quantity_value: 1e21, quantity_unit: 'g' }).error).toMatch(/at most/);
    expect(amountOf({})).toEqual({ quantity_value: null, quantity_unit: null });
  });

  it('every one of the 25 kitchen units is taken; none of the jar route\'s ten plurals is', () => {
    expect(KITCHEN_UNITS).toHaveLength(25);
    for (const unit of KITCHEN_UNITS) expect(amountOf({ quantity_value: 1, quantity_unit: unit }).error, unit).toBeUndefined();
    const plurals = JAR_UNITS.filter((u) => !KITCHEN_UNITS.includes(u));
    expect(plurals).toHaveLength(10);
    for (const unit of plurals) expect(amountOf({ quantity_value: 1, quantity_unit: unit }).error, unit).toMatch(/must be one of/);
  });

  it('every one of the eight source kinds is taken; a blank name is stored as none; our garden stores no name', () => {
    expect(VALID_SOURCE_KINDS).toHaveLength(8);
    for (const kind of VALID_SOURCE_KINDS) {
      expect(sourceOf({ source_kind: kind, source_label: 'A name' }).error, kind).toBeUndefined();
    }
    expect(sourceOf({ source_kind: 'store', source_label: '   ' })).toEqual({ source_kind: 'store', source_label: null });
    expect(sourceOf({ source_kind: 'store' })).toEqual({ source_kind: 'store', source_label: null });
    expect(sourceOf({ source_kind: 'farm_stand', source_label: ' Harris ' })).toEqual({ source_kind: 'farm_stand', source_label: 'Harris' });
    expect(sourceOf({ source_kind: 'own_garden', source_label: 'Old vendor' })).toEqual({ source_kind: 'own_garden', source_label: null });
    expect(sourceOf({})).toEqual({ source_kind: null, source_label: null });
  });
});

describe('R2a — PATCH /api/pantry/items/:id with an amount and where-from', () => {
  const path = `/api/pantry/items/${ITEM}`;
  const row = (over = {}) => [{ ...itemDb(), used_up_at: null, created_at: 'c', deleted_at: null, ...over }];
  const flag = (c, col) => after(c, `${col} = CASE WHEN`);
  const bound = (c, col) => after(c, `${col} = CASE WHEN ? ::boolean THEN`);

  it.each([
    ['the amount pair is edited together (the value alone)', { quantity_value: 2 }, /quantity_value and quantity_unit are edited together/],
    ['the amount pair is edited together (the unit alone)', { quantity_unit: 'lb' }, /quantity_value and quantity_unit are edited together/],
    ['a value with a null unit', { quantity_value: 2, quantity_unit: null }, /needs its unit/],
    ['0 is not an amount', { quantity_value: 0, quantity_unit: 'lb' }, /above 0/],
    ['a plural unit', { quantity_value: 2, quantity_unit: 'lbs' }, /quantity_unit must be one of/],
    ['the source pair is edited together (the kind alone)', { source_kind: 'store' }, /source_kind and source_label are edited together/],
    ['the source pair is edited together (the name alone)', { source_label: 'Costco' }, /source_kind and source_label are edited together/],
    ['a name with no source', { source_kind: null, source_label: 'Costco' }, /needs a source/],
    ['Other needs a name', { source_kind: 'other', source_label: null }, /needs a name/],
    ['a kind outside the eight', { source_kind: 'swap', source_label: null }, /source_kind must be one of/],
    ['121 characters refused', { source_kind: 'store', source_label: 'x'.repeat(121) }, /at most 120/],
  ])('%s → 400, nothing sent', async (_what, b, want) => {
    expect(validateItemPatch(b)).toMatch(want);
    const sql = mockSql();
    expect((await call(sql, path, 'PATCH', b)).status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('PATCH {the amount pair} → 200 and both bound; the source is left alone', async () => {
    const sql = mockSql([row({ quantity_value: '1.50', quantity_unit: 'qt' })]);
    const res = await call(sql, path, 'PATCH', { quantity_value: 1.5, quantity_unit: 'qt' });
    expect(res).toMatchObject({ status: 200, body: { item: { quantity_value: 1.5, quantity_unit: 'qt' } } });
    const c = sql.calls[0];
    expect(flag(c, 'quantity_value')).toBe(true);
    expect(bound(c, 'quantity_value')).toBe(1.5);
    expect(flag(c, 'quantity_unit')).toBe(true);
    expect(bound(c, 'quantity_unit')).toBe('qt');
    expect(flag(c, 'source_kind')).toBe(false);
    expect(flag(c, 'source_label')).toBe(false);
    expect(flag(c, 'name')).toBe(false);
  });

  it('PATCH {the source pair} → 200 and both bound, the name trimmed; the amount is left alone', async () => {
    const sql = mockSql([row({ source_kind: 'farm_stand', source_label: 'Harris' })]);
    const res = await call(sql, path, 'PATCH', { source_kind: 'farm_stand', source_label: ' Harris ' });
    expect(res).toMatchObject({ status: 200, body: { item: { source_kind: 'farm_stand', source_label: 'Harris' } } });
    const c = sql.calls[0];
    expect(flag(c, 'source_kind')).toBe(true);
    expect(bound(c, 'source_kind')).toBe('farm_stand');
    expect(flag(c, 'source_label')).toBe(true);
    expect(bound(c, 'source_label')).toBe('Harris');
    expect(flag(c, 'quantity_value')).toBe(false);
    expect(flag(c, 'quantity_unit')).toBe(false);
  });

  it('null, null clears the amount; null, null un-chooses the source', async () => {
    let sql = mockSql([row()]);
    await call(sql, path, 'PATCH', { quantity_value: null, quantity_unit: null });
    expect(flag(sql.calls[0], 'quantity_value')).toBe(true);
    expect(bound(sql.calls[0], 'quantity_value')).toBeNull();
    expect(bound(sql.calls[0], 'quantity_unit')).toBeNull();
    sql = mockSql([row()]);
    await call(sql, path, 'PATCH', { source_kind: null, source_label: null });
    expect(flag(sql.calls[0], 'source_kind')).toBe(true);
    expect(bound(sql.calls[0], 'source_kind')).toBeNull();
    expect(bound(sql.calls[0], 'source_label')).toBeNull();
  });

  it('garden clears the name: our garden is bound with a NULL name whatever name was sent', async () => {
    const sql = mockSql([row({ source_kind: 'own_garden' })]);
    await call(sql, path, 'PATCH', { source_kind: 'own_garden', source_label: 'Old vendor' });
    expect(bound(sql.calls[0], 'source_kind')).toBe('own_garden');
    expect(bound(sql.calls[0], 'source_label')).toBeNull();
  });

  it('an edit that names neither pair leaves all four as they are', async () => {
    const sql = mockSql([row({ name: 'Carnaroli' })]);
    await call(sql, path, 'PATCH', { name: 'Carnaroli' });
    expect(FOUR.map((k) => flag(sql.calls[0], k))).toEqual([false, false, false, false]);
  });

  it('the PATCH RETURNING names the four', async () => {
    const sql = mockSql([row()]);
    await call(sql, path, 'PATCH', { notes: 'x' });
    expect(listed(sql.calls[0].norm, 'RETURNING ', ' )')).toEqual(expect.arrayContaining(FOUR));
  });

  it('a planting item cannot have a non-garden source (PATCH): the database decides, and the answer is in words', async () => {
    const sql = mockSql([err('23514', 'chk_pantry_item_source_plant')]);
    expect(await call(sql, path, 'PATCH', { source_kind: 'store', source_label: null }))
      .toEqual({ status: 400, body: { error: PLANTING_SOURCE_REFUSAL } });
    // the UPDATE was sent: the stored planting is not in the body, so no validator can decide this
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].norm).toContain('UPDATE pantry_item SET');
  });
});

describe('R2a — every CHECK the item migration adds answers in words', () => {
  // The nine names of migrations/v5-pantryitemamount-001/0a-additive-ddl.sql (pantryitemamount-columns.test.js
  // reads them out of the file and runs each through the route).
  const NINE = [
    'chk_pantry_item_quantity_pairing', 'chk_pantry_item_quantity_value', 'chk_pantry_item_quantity_unit',
    'chk_pantry_item_source_kind', 'chk_pantry_item_source_label_nonblank', 'chk_pantry_item_source_label_len',
    'chk_pantry_item_source_label_kind', 'chk_pantry_item_source_other', 'chk_pantry_item_source_plant',
  ];
  const placeRow = [{ id: PLACE, label: 'Pantry shelf', kind: 'pantry' }];

  it.each(NINE)('a 23514 on %s answers 400 in words, on the create and on the PATCH', async (name) => {
    const words = ITEM_CONSTRAINT_MESSAGES[name];
    expect(typeof words, `${name} has words`).toBe('string');
    expect(words).not.toMatch(/chk_|constraint/i);
    let sql = mockSql([placeRow, err('23514', name)]);
    expect(await call(sql, '/api/pantry/items', 'POST', { idempotency_key: K1, name: 'Rice', storage_location_id: PLACE }))
      .toEqual({ status: 400, body: { error: words } });
    sql = mockSql([err('23514', name)]);
    expect(await call(sql, `/api/pantry/items/${ITEM}`, 'PATCH', { notes: 'x' })).toEqual({ status: 400, body: { error: words } });
  });

  it('a CHECK with no words is still thrown, never answered as a 400', async () => {
    const sql = mockSql([err('23514', 'chk_pantry_item_not_a_real_one')]);
    await expect(call(sql, `/api/pantry/items/${ITEM}`, 'PATCH', { notes: 'x' })).rejects.toThrow();
  });

  it('no sentence the item route can answer holds a banned word', () => {
    const body = (over) => ({ idempotency_key: K1, name: 'Rice', storage_location_id: PLACE, ...over });
    const said = [
      ...Object.values(ITEM_CONSTRAINT_MESSAGES),
      ...Object.values(ITEM_SOURCE_WORDS),
      PLANTING_SOURCE_REFUSAL,
      validateItemCreate(body({ quantity_value: 2 })),
      validateItemCreate(body({ quantity_value: 0, quantity_unit: 'lb' })),
      validateItemCreate(body({ quantity_value: '2', quantity_unit: 'lb' })),
      validateItemCreate(body({ quantity_value: 100000000, quantity_unit: 'lb' })),
      validateItemCreate(body({ quantity_value: 2, quantity_unit: 'lbs' })),
      validateItemCreate(body({ source_label: 'Costco' })),
      validateItemCreate(body({ source_kind: 'swap' })),
      validateItemCreate(body({ source_kind: 'other' })),
      validateItemCreate(body({ source_kind: 'store', source_label: 'x'.repeat(121) })),
      validateItemCreate(body({ source_kind: 'store', source_label: 5 })),
      validateItemCreate(body({ plant_id: PLANT, source_kind: 'store' })),
      validateItemPatch({ quantity_value: 2 }),
      validateItemPatch({ source_kind: 'store' }),
    ];
    expect(said.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
    for (const s of said) expect(s, s).not.toMatch(BANNED);
    // the sweep can fail: a sentence carrying one of the words is caught
    expect('That is the default unit.').toMatch(BANNED);
  });
});

describe('R2a — GET /api/pantry carries the four as stored on both row kinds', () => {
  it('the items arm names the four; the put-ups arm names source_kind beside the three it had', async () => {
    const sql = mockSql([[jarDb()], [itemDb()]]);
    await call(sql, '/api/pantry', 'GET');
    const [jars, items] = sql.calls;
    for (const k of FOUR) expect(items.norm, k).toContain(`i.${k}`);
    for (const k of FOUR) expect(jars.norm, k).toMatch(new RegExp(String.raw`SELECT[^;]*?\bp\.${k}\b[^;]*?FROM preservation_log p`));
    expect(listed(jars.norm, 'SELECT ', ' s.label AS place_label')).toContain('source_kind');
  });

  it('an item row and a put-up row hold the same four keys, as stored', async () => {
    const sql = mockSql([[bagDb()], [itemDb({ quantity_value: '2.00', quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' })]]);
    const { body } = await call(sql, '/api/pantry', 'GET');
    const item = body.rows.find((r) => r.stock_kind === 'pantry_item');
    const jar = body.rows.find((r) => r.stock_kind === 'put_up');
    expect(FOUR.map((k) => item[k])).toEqual([2, 'lb', 'store', 'Costco']);
    expect(FOUR.map((k) => jar[k])).toEqual([1, 'lb', 'farm_stand', 'Harris farm stand']);
    for (const k of FOUR) { expect(item).toHaveProperty(k); expect(jar).toHaveProperty(k); }
  });

  it.each(['g', 'kg', 'oz', 'lb'])('the amount is as logged, never left: an item of 2 %s has no count and no grams', (unit) => {
    const row = itemRow(itemDb({ quantity_value: '2.00', quantity_unit: unit }), 'place', NOW);
    expect(row).toMatchObject({ stock_mode: 'item', count_left: null, count_made: null, grams_left: null, quantity_value: 2, quantity_unit: unit });
  });

  it('where_from: the planting first; no planting → the stored source, the typed name, else the kind\'s own word', () => {
    const wf = (over) => itemRow(itemDb(over), 'place', NOW).where_from;
    expect(wf({ plant_id: PLANT, planting_name: 'Walla Walla', source_kind: 'own_garden' })).toBe('Walla Walla');
    expect(wf({ source_kind: 'store', source_label: 'Costco' })).toBe('Costco');
    expect(wf({ source_kind: 'farm_stand' })).toBe('Farm stand');
    expect(wf({ source_kind: 'gift', source_label: '  ' })).toBe('Gift');
    expect(wf({ source_kind: 'other', source_label: 'The neighbour' })).toBe('The neighbour');
    expect(wf({ source_kind: 'own_garden' })).toBe('My garden');
    expect(wf({})).toBeNull();
  });

  it('where_from never prints an old vendor beside our garden', () => {
    expect(itemRow(itemDb({ source_kind: 'own_garden', source_label: 'Old vendor' }), 'place', NOW).where_from).toBe('My garden');
  });

  it('from_garden is a planting OR our garden named as the source', () => {
    const fg = (over) => itemRow(itemDb(over), 'place', NOW).from_garden;
    expect(fg({ plant_id: PLANT })).toBe(true);
    expect(fg({ source_kind: 'own_garden' })).toBe(true);
    expect(fg({ source_kind: 'store', source_label: 'Costco' })).toBe(false);
    expect(fg({})).toBe(false);
  });

  it('the kind words are the door\'s chip words to the letter; Other has no word of its own', () => {
    for (const kind of VALID_SOURCE_KINDS.filter((k) => k !== 'other')) {
      expect(ITEM_SOURCE_WORDS[kind], kind).toBe(PUTUP_SOURCE_LABELS[kind]);
    }
    expect(Object.keys(ITEM_SOURCE_WORDS).sort()).toEqual(VALID_SOURCE_KINDS.filter((k) => k !== 'other').sort());
  });
});

// ── the pure rules ───────────────────────────────────────────────────────────────────────────────
describe('pantryItems — the pure rules', () => {
  it('acquiredOf: a day defaults to precision day; unknown has no day; a coarse word needs a day', () => {
    expect(acquiredOf({ acquired_at: '2026-10-03' })).toEqual({ acquired_at: '2026-10-03', acquired_precision: 'day' });
    expect(acquiredOf({ acquired_at: '2026-09-01', acquired_precision: 'month' })).toEqual({ acquired_at: '2026-09-01', acquired_precision: 'month' });
    expect(acquiredOf({ acquired_precision: 'unknown' })).toEqual({ acquired_at: null, acquired_precision: 'unknown' });
    expect(acquiredOf({})).toEqual({ acquired_at: null, acquired_precision: null });
  });

  it('loadPantryItems reads nothing for no (or only malformed) ids, and binds the household', async () => {
    let sql = mockSql();
    expect(await loadPantryItems(sql, ['x', null], HOUSEHOLD)).toEqual([]);
    expect(sql.calls).toHaveLength(0);
    sql = mockSql([[]]);
    await loadPantryItems(sql, [ITEM, ITEM], STRANGER);
    expect(sql.calls[0].values).toContainEqual([ITEM]);
    expect(sql.calls[0].values).toContainEqual(STRANGER);
  });
});
