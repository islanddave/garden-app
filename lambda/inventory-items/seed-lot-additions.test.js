// V5-SEEDLOTADDITION-001 (release 3) — seed-lot-additions.js and the two routes that place it:
//   POST /api/inventory-items/:id/seed-additions      one more picking into a lot that exists
//   GET  /api/inventory-items/seed-lots-open?plant_id= the lots a planting's seed could go into
//
// WHAT THIS FILE CAN AND CANNOT PROVE. The stub records SQL and executes none of it, so nothing here
// shows that a refused addition writes nothing, that the nine count cells come out as the table says,
// or that the open-lots filter offers the right lots — those are tests/integration/
// seed-lot-additions.int.test.js and seed-lots-open.int.test.js, on a real Postgres. What IS provable
// here, and would fail silently in production:
//   - the request rule, value by value (a refusal here is the only thing between a bad number and a
//     CHECK's sentence);
//   - the transaction's statement list for each optional shape, in order — results are read back by
//     POSITION, so a statement added or moved misreads every result after it;
//   - what each outcome says over HTTP, and that a rolled-back transaction answers 409, not 500;
//   - that the set route's own transaction (replaceSourcePlants) is the size it was;
//   - that no statement of this module names something the schema audit would read as a relation.
//
// Static imports only: no vi.doMock, no vi.resetModules, no dynamic import of the module under test.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import { handler, SEED_CONSTRAINT_MESSAGES } from './index.js';
import {
  normalizeAddition, readExpectedMeasure, addSeedToLot, openLotsOf,
  MAX_ADD_SEED_COUNT, MAX_ADD_SEED_WEIGHT_G,
  LOT_USED_UP, ADDITION_KEY_CONFLICT, OWN_SOURCE_LOT, AMOUNT_TOO_LARGE, VARIETY_MISMATCH_NO_PARENTS, TOO_MANY_PARENTS,
} from './seed-lot-additions.js';
import { replaceSourcePlants } from './seed-lot-parents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');
const ADD_SRC = decomment(readFileSync(resolve(__dirname, 'seed-lot-additions.js'), 'utf8'));
const INDEX_SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const USER = 'user_stub_owner';
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const uuid = (n) => `3f9c1e64-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;
const KEY = uuid(900);
const PLANT = uuid(1);
const OTHER = uuid(2);
const MIX = uuid(50);
const FILED = uuid(51);
const ADDITION = uuid(700);
const LOT_CHANGED = 'This seed lot was changed at the same moment. Reload and try again.';
const PLANTS_CHANGED = 'One of those plants changed just now. Reload and try again.';

// A day far enough back that the 48-hour rule can never be what refuses a case that is about
// something else, whenever this suite runs.
const body = (extra = {}) => ({
  addition_key: KEY, plant_id: PLANT, expected_source_plant_ids: [PLANT], picked_on: '2026-09-01', ...extra,
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The request rule
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('normalizeAddition — the body of POST /:id/seed-additions', () => {
  it('a body with the four required keys and no amount is a request: ids lower-cased, the plant in the rule set', () => {
    const out = normalizeAddition(body({ addition_key: KEY.toUpperCase(), plant_id: PLANT.toUpperCase(), expected_source_plant_ids: [OTHER.toUpperCase()] }));
    expect(out).toEqual({
      additionKey: KEY, plantId: PLANT, expected: [OTHER], ruleIds: [OTHER, PLANT], pickedOn: '2026-09-01',
      addCount: null, addEstimated: null, addWeight: null, filing: null,
    });
    // Already in the set: the rule set is the set, not the set with a second copy.
    expect(normalizeAddition(body()).ruleIds).toEqual([PLANT]);
    // An empty set is a lot with no plant on record, and is valid.
    expect(normalizeAddition(body({ expected_source_plant_ids: [] }))).toMatchObject({ expected: [], ruleIds: [PLANT] });
  });

  it('add_seed_count: a whole number from 1 to a million, with its basis — everything else is refused', () => {
    const COUNT = `add_seed_count must be a whole number of seeds from 1 to ${MAX_ADD_SEED_COUNT}`;
    for (const bad of [-1, 0, 2.5, '3', 1e10, MAX_ADD_SEED_COUNT + 1, true, [3], {}]) {
      expect(normalizeAddition(body({ add_seed_count: bad, add_estimated: false })), JSON.stringify(bad)).toEqual({ error: COUNT });
    }
    expect(MAX_ADD_SEED_COUNT).toBe(1000000);
    expect(normalizeAddition(body({ add_seed_count: 1, add_estimated: false }))).toMatchObject({ addCount: 1, addEstimated: false });
    expect(normalizeAddition(body({ add_seed_count: 1000000, add_estimated: true }))).toMatchObject({ addCount: 1000000, addEstimated: true });
    // A count with no basis, and a basis that is not a boolean: the pairing CHECK's two halves.
    const BASIS = 'add_estimated must say whether add_seed_count was counted (false) or estimated (true)';
    expect(normalizeAddition(body({ add_seed_count: 30 }))).toEqual({ error: BASIS });
    expect(normalizeAddition(body({ add_seed_count: 30, add_estimated: null }))).toEqual({ error: BASIS });
    expect(normalizeAddition(body({ add_seed_count: 30, add_estimated: 'true' }))).toEqual({ error: BASIS });
    // A basis with no count.
    expect(normalizeAddition(body({ add_estimated: true }))).toEqual({ error: 'add_estimated is only allowed with add_seed_count' });
    expect(normalizeAddition(body({ add_seed_count: null, add_estimated: false }))).toEqual({ error: 'add_estimated is only allowed with add_seed_count' });
    // null is "not sent", for both.
    expect(normalizeAddition(body({ add_seed_count: null, add_estimated: null }))).toMatchObject({ addCount: null, addEstimated: null });
  });

  it('add_seed_weight_g: rounded to three places FIRST, and only then held to (0, 100000]', () => {
    const WEIGHT = `add_seed_weight_g must be more than 0 and at most ${MAX_ADD_SEED_WEIGHT_G} grams`;
    expect(MAX_ADD_SEED_WEIGHT_G).toBe(100000);
    // 0.0004 is more than nothing and rounds to nothing: tested raw it would reach the column as
    // 0.000 and trip chk_sla_seed_weight_positive.
    for (const bad of [0, 0.0004, -1, 100000.001, 1e12]) {
      expect(normalizeAddition(body({ add_seed_weight_g: bad })), String(bad)).toEqual({ error: WEIGHT });
    }
    for (const bad of ['1.5', NaN, Infinity, true, [1]]) {
      expect(normalizeAddition(body({ add_seed_weight_g: bad })), String(bad)).toEqual({ error: 'add_seed_weight_g must be a number of grams' });
    }
    expect(normalizeAddition(body({ add_seed_weight_g: 100000 })).addWeight).toBe(100000);
    expect(normalizeAddition(body({ add_seed_weight_g: 0.0005 })).addWeight).toBe(0.001);
    expect(normalizeAddition(body({ add_seed_weight_g: 12.3456 })).addWeight).toBe(12.346);
    expect(normalizeAddition(body({ add_seed_weight_g: 0.005 })).addWeight).toBe(0.005);
    // Independent of the count: a weight alone is a request.
    expect(normalizeAddition(body({ add_seed_weight_g: 2.5 }))).toMatchObject({ addCount: null, addEstimated: null, addWeight: 2.5 });
  });

  it('picked_on: a real calendar day, any day in the past, and at most 48 hours ahead', () => {
    const DATE = 'picked_on must be a date, YYYY-MM-DD';
    for (const bad of [undefined, null, '', '2026-9-1', '09/01/2026', '2026-09-01T12:00:00', '2026-02-30', '2026-13-01', 20260901]) {
      expect(normalizeAddition(body({ picked_on: bad })), String(bad)).toEqual({ error: DATE });
    }
    // 2026-06-15 resolves to noon in New York, 16:00 UTC. 49 hours before that it is refused, 47 it is not.
    const noon = Date.parse('2026-06-15T16:00:00Z');
    const at = (hoursBefore) => new Date(noon - hoursBefore * 60 * 60 * 1000);
    expect(normalizeAddition(body({ picked_on: '2026-06-15' }), at(49))).toEqual({ error: 'picked_on cannot be in the future' });
    expect(normalizeAddition(body({ picked_on: '2026-06-15' }), at(47)).pickedOn).toBe('2026-06-15');
    // Today, and years ago.
    expect(normalizeAddition(body({ picked_on: '2026-06-15' }), new Date(noon)).pickedOn).toBe('2026-06-15');
    expect(normalizeAddition(body({ picked_on: '2019-10-03' }), new Date(noon)).pickedOn).toBe('2019-10-03');
  });

  it('addition_key and plant_id are uuids, and both are required', () => {
    const KEY_ERR = 'addition_key must be a uuid the client made for this addition';
    const PLANT_ERR = 'plant_id must be the id of the planting this seed was picked from';
    for (const bad of [undefined, null, '', 'not-a-uuid', 12, `${KEY}x`]) {
      expect(normalizeAddition(body({ addition_key: bad })), String(bad)).toEqual({ error: KEY_ERR });
      expect(normalizeAddition(body({ plant_id: bad })), String(bad)).toEqual({ error: PLANT_ERR });
    }
    for (const notABody of [null, undefined, 'x', 3, []]) expect(normalizeAddition(notABody).error).toEqual(expect.any(String));
  });

  it('expected_source_plant_ids: required, an array of uuids, at most twelve — [] is a set', () => {
    const REQUIRED = 'expected_source_plant_ids is required (send [] for a lot with no plant on record)';
    const { expected_source_plant_ids: _dropped, ...without } = body();
    expect(normalizeAddition(without)).toEqual({ error: REQUIRED });
    expect(normalizeAddition(body({ expected_source_plant_ids: null }))).toEqual({ error: REQUIRED });
    expect(normalizeAddition(body({ expected_source_plant_ids: [] })).expected).toEqual([]);
    expect(normalizeAddition(body({ expected_source_plant_ids: PLANT }))).toEqual({ error: 'expected_source_plant_ids must be an array of planting ids' });
    expect(normalizeAddition(body({ expected_source_plant_ids: [PLANT, 'x'] }))).toEqual({ error: 'expected_source_plant_ids must contain only planting ids' });
    const thirteen = Array.from({ length: 13 }, (_, i) => uuid(100 + i));
    expect(normalizeAddition(body({ expected_source_plant_ids: thirteen }))).toEqual({ error: 'expected_source_plant_ids can name at most 12 plantings' });
    expect(normalizeAddition(body({ expected_source_plant_ids: thirteen.slice(0, 12) })).expected).toHaveLength(12);
  });

  it('filing is the filing route\'s own rule, and absent is absent', () => {
    expect(normalizeAddition(body()).filing).toBeNull();
    expect(normalizeAddition(body({ filing: null })).filing).toBeNull();
    expect(normalizeAddition(body({ filing: { variety_id: MIX } }))).toEqual({ error: 'expect_variety_id must be the id of the variety this seed is filed under now' });
    expect(normalizeAddition(body({ filing: { variety_id: MIX, expect_variety_id: FILED, name: '  Two-plant mix  ' } })).filing)
      .toEqual({ varietyId: MIX, expectVarietyId: FILED, name: 'Two-plant mix' });
  });

  it('never reads a top-level name, type or category — an older Lambda would take a body with one for a create', () => {
    const read = [];
    const watched = new Proxy(body({ name: 'A lot', type: 'consumable', category: 'seeds', add_seed_count: 5, add_estimated: false }), {
      get(target, key) { read.push(key); return target[key]; },
    });
    const out = normalizeAddition(watched);
    expect(out.error).toBeUndefined();
    for (const key of ['name', 'type', 'category']) {
      expect(read, `normalizeAddition read "${key}"`).not.toContain(key);
      expect(out).not.toHaveProperty(key);
    }
    // And the route hands the write nothing but what the normaliser returned.
    expect(INDEX_SRC.replace(/\s+/g, ' ')).toContain('addSeedToLot(sql, { lotId: itemId, householdIds, userId, ...addition })');
  });

  it('is read by VALUE here and never by hasOwnProperty in index.js, which a client test scrapes', () => {
    const arm = INDEX_SRC.slice(INDEX_SRC.indexOf('const seedAdditionsMatch = rawPath.match'), INDEX_SRC.indexOf('const filingMatch = rawPath.match'));
    expect(arm.length).toBeGreaterThan(200);
    expect(arm).not.toMatch(/hasOwnProperty/);
    expect(arm).not.toMatch(/\bbody\./);
    expect(ADD_SRC).not.toMatch(/hasOwnProperty/);
  });
});

describe('readExpectedMeasure — the three compare-and-set keys of /seed-measure', () => {
  it('an absent key compares nothing; a present key, null included, is compared', () => {
    expect(readExpectedMeasure({})).toEqual({
      any: false, hasCount: false, count: null, hasBasis: false, basis: null, hasWeight: false, weight: null,
    });
    expect(readExpectedMeasure({ seed_count: 5 }).any).toBe(false);
    expect(readExpectedMeasure({ expected_seed_count: null })).toMatchObject({ any: true, hasCount: true, count: null, hasBasis: false, hasWeight: false });
    expect(readExpectedMeasure({ expected_seed_count: 0, expected_seed_count_estimated: false, expected_seed_weight_g: 0 }))
      .toEqual({ any: true, hasCount: true, count: 0, hasBasis: true, basis: false, hasWeight: true, weight: 0 });
    expect(readExpectedMeasure({ expected_seed_weight_g: 12.35 })).toMatchObject({ any: true, hasWeight: true, weight: 12.35, hasCount: false });
    for (const notABody of [null, undefined, 'x', []]) expect(readExpectedMeasure(notABody).any).toBe(false);
  });

  it('a wrong type is refused in the route\'s own "<key> must be" form — a numeric string for the weight included', () => {
    for (const bad of ['185', 1.5, true, {}]) {
      expect(readExpectedMeasure({ expected_seed_count: bad })).toEqual({ error: 'expected_seed_count must be a whole number of seeds, or null' });
    }
    for (const bad of ['true', 0, 1]) {
      expect(readExpectedMeasure({ expected_seed_count_estimated: bad })).toEqual({ error: 'expected_seed_count_estimated must be true, false or null' });
    }
    for (const bad of ['12.350', NaN, Infinity, false]) {
      expect(readExpectedMeasure({ expected_seed_weight_g: bad })).toEqual({ error: 'expected_seed_weight_g must be a number of grams, or null' });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The transaction's shape (a recording driver: every statement runs eagerly, as the stub's does)
// ───────────────────────────────────────────────────────────────────────────────────────────────────
function recorder(answer = () => []) {
  const sql = (strings, ...values) => {
    const call = { text: strings.join('?'), values };
    sql.calls.push(call);
    return Promise.resolve().then(() => answer(call.text, values));
  };
  sql.calls = [];
  sql.batches = [];
  sql.transaction = async (queries) => { sql.batches.push(queries.length); return Promise.all(queries); };
  return sql;
}
// judgeAddition, and only it: the filing judge also ends `AS verdict`, and applyAddition READS the
// plant-new setting, but only the judge SETS it.
const IS_JUDGE = /set_config\('app\.seed_lot_plant_new'/;
const NAMES = [
  [/FOR UPDATE\s*$/, 'lock'],
  [/FOR SHARE\s*$/, 'hold'],
  [IS_JUDGE, 'judge'],
  [/rules_hold/, 'rules'],
  [/v\.verdict, v\.previous_variety_id/, 'filing-judge'],
  [/INSERT INTO public\.seed_lot_parent_planting/, 'link'],
  [/SET variety_id = \?::uuid/, 'file'],
  [/WITH pre AS/, 'apply'],
  [/jsonb_agg\(jsonb_build_object/, 'parents'],
  [/pv\.display_name AS variety_name, pv\.variety_rank, i\.name/, 'filed'],
];
const nameOf = (text) => (NAMES.find(([re]) => re.test(text)) ?? [null, `UNNAMED: ${text.trim().slice(0, 60)}`])[1];
const args = (extra = {}) => ({
  lotId: LOT, householdIds: [USER], userId: USER, additionKey: KEY, plantId: PLANT, expected: [PLANT],
  pickedOn: '2026-09-01', addCount: 30, addEstimated: false, addWeight: null, filing: null, ...extra,
});
const go = (extra = {}) => (text) => {
  if (IS_JUDGE.test(text)) return [{ id: LOT, name: 'Lot', verdict: 'go', plant_member: true, ...extra }];
  if (/WITH pre AS/.test(text)) return [{ id: LOT, name: 'Lot', seed_count: 130, addition_id: ADDITION, count_applied: true, weight_applied: false }];
  if (/rules_hold/.test(text)) return [{ rules_hold: true }];
  if (/v\.verdict, v\.previous_variety_id/.test(text)) return [{ verdict: 'write', previous_variety_id: FILED, previous_name: 'Lot' }];
  if (/SET variety_id = \?::uuid/.test(text)) return [{ id: LOT }];
  if (/pv\.display_name AS variety_name, pv\.variety_rank, i\.name/.test(text)) return [{ id: LOT, variety_id: MIX, variety_name: 'A + B mix', variety_rank: 'blend', name: 'Lot' }];
  return [];
};

describe('addSeedToLot — the statement list, in order, for each optional shape', () => {
  it('one plant already in the set, no filing: six statements, one transaction', async () => {
    const sql = recorder(go());
    const out = await addSeedToLot(sql, args());
    expect(sql.batches).toEqual([6]);
    expect(sql.calls.map((c) => nameOf(c.text))).toEqual(['lock', 'hold', 'judge', 'link', 'apply', 'parents']);
    expect(out.outcome).toBe('ok');
    expect(out.addition).toEqual({ id: ADDITION, replayed: false, plant_was_added: false, count_applied: true, weight_applied: false });
    expect(out).not.toHaveProperty('filing');
  });

  it('a set of two with the plant: the parent rules are judged after the facts and before the first write', async () => {
    const sql = recorder(go({ plant_member: false }));
    const out = await addSeedToLot(sql, args({ expected: [OTHER] }));
    expect(sql.batches).toEqual([7]);
    expect(sql.calls.map((c) => nameOf(c.text))).toEqual(['lock', 'hold', 'judge', 'rules', 'link', 'apply', 'parents']);
    expect(out.addition.plant_was_added).toBe(true);
    // The rules are asked about the caller's set WITH the plant, the link INSERT about the plant alone.
    const rules = sql.calls.find((c) => nameOf(c.text) === 'rules');
    expect(rules.values).toContainEqual([OTHER, PLANT]);
    const link = sql.calls.find((c) => nameOf(c.text) === 'link');
    expect(link.values).toContainEqual([PLANT]);
    expect(link.values).not.toContainEqual([OTHER, PLANT]);
  });

  it('with a filing: its judge after the rules, its write after the link and BEFORE the apply, its read last', async () => {
    const sql = recorder(go({ plant_member: false }));
    const out = await addSeedToLot(sql, args({
      expected: [OTHER], filing: { varietyId: MIX, expectVarietyId: FILED, name: null },
    }));
    expect(sql.batches).toEqual([10]);
    expect(sql.calls.map((c) => nameOf(c.text)))
      .toEqual(['lock', 'hold', 'judge', 'rules', 'filing-judge', 'link', 'file', 'apply', 'parents', 'filed']);
    expect(out.outcome).toBe('ok');
    expect(out.filing).toEqual({
      variety_id: MIX, variety_name: 'A + B mix', variety_rank: 'blend', name: 'Lot', changed: true,
      previous: { variety_id: FILED, name: 'Lot' },
    });
    // The rules judge the set against the variety the lot is ABOUT to be filed under.
    expect(sql.calls.find((c) => nameOf(c.text) === 'rules').values).toContain(MIX);
  });

  it('a filing on a lot the plant is alone in: nine statements (no rules for a set of one)', async () => {
    const sql = recorder(go());
    await addSeedToLot(sql, args({ filing: { varietyId: MIX, expectVarietyId: FILED, name: 'Renamed' } }));
    expect(sql.batches).toEqual([9]);
    expect(sql.calls.map((c) => nameOf(c.text)))
      .toEqual(['lock', 'hold', 'judge', 'filing-judge', 'link', 'file', 'apply', 'parents', 'filed']);
  });

  it('binds what the caller sent to the judge and to the apply — the key, the day, the amounts, the caller', async () => {
    const sql = recorder(go());
    await addSeedToLot(sql, args({ addCount: 30, addEstimated: true, addWeight: 1.25, expected: [PLANT, OTHER] }));
    const judge = sql.calls.find((c) => nameOf(c.text) === 'judge');
    expect(judge.values).toContain(KEY);
    expect(judge.values).toContainEqual([PLANT, OTHER]);
    expect(judge.values).toContain(30);
    expect(judge.values).toContain(1.25);
    const apply = sql.calls.find((c) => nameOf(c.text) === 'apply');
    for (const v of [KEY, '2026-09-01', 30, true, 1.25, USER, PLANT, LOT]) expect(apply.values, String(v)).toContain(v);
    // The lot lock is the set route's own first statement, word for word.
    const flat = (t) => t.replace(/\s+/g, ' ').trim();
    expect(flat(sql.calls[0].text)).toBe(
      "SELECT i.id FROM public.inventory_items i WHERE i.id = ? AND i.created_by = ANY(?) AND i.deleted_at IS NULL AND i.category = 'seeds' FOR UPDATE",
    );
    expect(flat(sql.calls[1].text)).toBe('SELECT p.id FROM public.garden_node p WHERE p.id = ANY(?::uuid[]) ORDER BY p.id FOR SHARE');
    expect(sql.calls[1].values).toEqual([[PLANT]]);
  });

  it('no statement in the transaction retires a row: it is insert-only', () => {
    const fn = ADD_SRC.slice(ADD_SRC.indexOf('export async function addSeedToLot'), ADD_SRC.indexOf('export function readOpenLots'));
    expect(fn).toMatch(/sql\.transaction\(\[/);
    expect(fn).not.toMatch(/deleted_at = now\(\)/i);
    expect(ADD_SRC).not.toMatch(/SET deleted_at/i);
    expect(ADD_SRC).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(fn).not.toMatch(/replaceSourcePlants/);
  });
});

describe('replaceSourcePlants — the set route\'s own transaction is the size it was', () => {
  const facts = () => (text) => (/AS set_as_expected/.test(text) ? [{ id: LOT, ids_usable: true, set_as_expected: true, live_parents: 1 }]
    : /RETURNING i\.id, i\.source_plant_id/.test(text) ? [{ id: LOT, source_plant_id: PLANT }] : []);

  it('seven statements for both of its callers when nothing optional is asked', async () => {
    // PUT /:id/source-plants, as index.js calls it for a one-planting body, and the legacy PATCH.
    const set = recorder(facts());
    await replaceSourcePlants(set, { lotId: LOT, ids: [PLANT], householdIds: [USER], userId: USER, expected: null, cacheHint: null, rules: true, filing: null });
    expect(set.batches).toEqual([7]);
    const legacy = recorder(facts());
    await replaceSourcePlants(legacy, { lotId: LOT, ids: [PLANT], householdIds: [USER], userId: USER, legacy: true });
    expect(legacy.batches).toEqual([7]);
    // And with everything optional: the rules, and the re-file's three.
    const full = recorder(facts());
    await replaceSourcePlants(full, {
      lotId: LOT, ids: [PLANT, OTHER], householdIds: [USER], userId: USER, expected: [PLANT], cacheHint: PLANT, rules: true,
      filing: { varietyId: MIX, expectVarietyId: FILED, name: null },
    });
    expect(full.batches).toEqual([11]);
  });

  it('index.js still calls it from exactly two places, and the additions route is not one of them', () => {
    expect(INDEX_SRC.match(/replaceSourcePlants\(/g)).toHaveLength(2);
    expect(ADD_SRC).not.toMatch(/replaceSourcePlants/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The routes, through the handler
// ───────────────────────────────────────────────────────────────────────────────────────────────────
const post = (payload, { method = 'POST', id = LOT } = {}) => ({
  requestContext: { http: { method } },
  rawPath: `/api/inventory-items/${id}/seed-additions`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(payload),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });
const isKeyRead = (t) => /FROM public\.seed_lot_addition a\s+WHERE a\.addition_key = \?::uuid\s*$/.test(t);
// The ownership gate's statement, whole — the parent rules' judge has the same three lines inside it.
const isOwns = (t) => /^\s*SELECT p\.id\s+FROM public\.garden_node p\s+WHERE p\.id = ANY\(\?::uuid\[\]\)\s+AND p\.created_by = ANY\(\?\)\s+AND p\.deleted_at IS NULL\s*$/.test(t);
const isRulesRead = (t) => /AS lot_found/.test(t);
const LOT_ROW = {
  id: LOT, name: 'Lot', variety_id: FILED, source_plant_id: PLANT, seed_count: 100, seed_count_estimated: false,
  seed_weight_g: '12.345', seed_parent_plant_count: 2, quantity_on_hand: '1.000', updated_at: '2026-10-07T12:00:00.000Z',
};
// The handler's own driver stub, answered per statement. `verdict` is what the judge says.
const answer = ({ verdict = 'go', recorded = false, owned = true, judge = {}, apply = {}, rules = true, filing = 'write', throws = null } = {}) => (text) => {
  if (isKeyRead(text)) return recorded ? [{ id: ADDITION }] : [];
  if (isOwns(text)) return owned ? [{ id: PLANT }] : [];
  if (isRulesRead(text)) return [];
  if (IS_JUDGE.test(text)) return [{ ...LOT_ROW, verdict, plant_member: true, ...judge }];
  if (/rules_hold/.test(text)) return [{ rules_hold: rules }];
  if (/v\.verdict, v\.previous_variety_id/.test(text)) return [{ verdict: filing, previous_variety_id: FILED, previous_name: 'Lot' }];
  if (/WITH pre AS/.test(text)) {
    if (throws) throw Object.assign(new Error('the batch rolled back'), throws);
    return verdict === 'go' ? [{ ...LOT_ROW, seed_count: 130, addition_id: ADDITION, count_applied: true, weight_applied: false, ...apply }] : [{}];
  }
  if (/jsonb_agg\(jsonb_build_object/.test(text)) return [{ inventory_item_id: LOT, source_plants: [{ id: PLANT, name: 'Plant' }] }];
  return [];
};
const send = async (payload, options, how) => {
  stubState.sqlHandler = answer(how);
  const warned = [];
  const orig = console.warn;
  console.warn = (m) => warned.push(m);
  try { return { ...parse(await handler(post(payload, options))), warned }; } finally { console.warn = orig; }
};

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
});

describe('POST /:id/seed-additions — route shape and the fast path', () => {
  it('is POST-only, and a body that fails its rule or a lot id that is not one costs no SQL', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      expect((await send(body(), { method })).status, method).toBe(405);
    }
    expect((await send(body({ picked_on: 'yesterday' }))).status).toBe(400);
    const notALot = await send(body(), { id: 'seed-lots-open' });
    expect(notALot).toMatchObject({ status: 404, body: { error: 'Not found' } });
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('asks "is this key recorded" FIRST; when it is not: the ownership gate, then the write', async () => {
    const r = await send(body({ add_seed_count: 30, add_estimated: false }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const order = stubState.sqlCalls.map((c) => (isKeyRead(c.text) ? 'key' : isOwns(c.text) ? 'owns' : isRulesRead(c.text) ? 'rules-read' : nameOf(c.text)));
    // One plant already in the set: the parent rules have nothing to read (fewer than two plantings).
    expect(order).toEqual(['key', 'owns', 'lock', 'hold', 'judge', 'link', 'apply', 'parents']);
    expect(stubState.sqlCalls[0].values).toEqual([KEY]);
    expect(stubState.sqlCalls[1].values).toEqual([[PLANT], [USER]]);
  });

  it('a set of two is also put to the parent rules before the lot is locked', async () => {
    await send(body({ expected_source_plant_ids: [OTHER] }));
    const order = stubState.sqlCalls.map((c) => (isKeyRead(c.text) ? 'key' : isOwns(c.text) ? 'owns' : isRulesRead(c.text) ? 'rules-read' : nameOf(c.text)));
    expect(order.slice(0, 4)).toEqual(['key', 'owns', 'rules-read', 'lock']);
    expect(stubState.sqlCalls[2].values).toContainEqual([OTHER, PLANT]);
  });

  it('a key that IS recorded skips the gate and the rules and goes straight to the transaction — a replay must not be refused by them', async () => {
    const r = await send(body({ expected_source_plant_ids: [OTHER] }), undefined, { recorded: true, verdict: 'replay', owned: false, judge: { addition_id: ADDITION, count_applied: true, weight_applied: false, plant_was_added: true } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const order = stubState.sqlCalls.map((c) => (isKeyRead(c.text) ? 'key' : isOwns(c.text) ? 'owns' : isRulesRead(c.text) ? 'rules-read' : nameOf(c.text)));
    expect(order).not.toContain('owns');
    expect(order).not.toContain('rules-read');
    expect(order.slice(0, 2)).toEqual(['key', 'lock']);
    expect(r.warned).toHaveLength(0);
  });

  it('a planting the caller cannot use is one generic 400 before any lock, and is logged', async () => {
    const r = await send(body(), undefined, { owned: false });
    expect(r).toMatchObject({ status: 400, body: { error: 'plant_id does not match a planting you can use' } });
    expect(Object.keys(r.body)).toEqual(['error']);
    expect(stubState.sqlCalls.map((c) => (isKeyRead(c.text) ? 'key' : isOwns(c.text) ? 'owns' : 'OTHER'))).toEqual(['key', 'owns']);
    expect(JSON.parse(r.warned[0])).toMatchObject({ msg: 'authz-fk-reject', table: 'seed_lot_parent_planting', column: 'plant_id' });
  });
});

describe('POST /:id/seed-additions — what each outcome says', () => {
  const LOT_KEYS = ['id', 'name', 'variety_id', 'source_plant_id', 'seed_count', 'seed_count_estimated', 'seed_weight_g',
    'seed_parent_plant_count', 'quantity_on_hand', 'updated_at'];

  it('200, first time: the lot as the write left it, its plants, and what happened to this picking', async () => {
    const r = await send(body({ add_seed_count: 30, add_estimated: false }), undefined, { judge: { plant_member: false } });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([...LOT_KEYS, 'source_plants', 'addition'].sort());
    expect(r.body).toMatchObject({ id: LOT, seed_count: 130, seed_weight_g: '12.345', source_plants: [{ id: PLANT, name: 'Plant' }] });
    expect(r.body.addition).toEqual({ id: ADDITION, replayed: false, plant_was_added: true, count_applied: true, weight_applied: false });
  });

  it('200, replay: the lot AS IT STANDS (from the judge, not the apply), replayed true, and never a filing key', async () => {
    const r = await send(
      body({ filing: { variety_id: MIX, expect_variety_id: FILED } }), undefined,
      { recorded: true, verdict: 'replay', filing: 'changed', rules: false, judge: { addition_id: ADDITION, count_applied: false, weight_applied: true, plant_was_added: false, seed_count: 777 } },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([...LOT_KEYS, 'source_plants', 'addition'].sort());
    expect(r.body.seed_count).toBe(777);
    expect(r.body.addition).toEqual({ id: ADDITION, replayed: true, plant_was_added: false, count_applied: false, weight_applied: true });
    expect(r.body).not.toHaveProperty('filing');
  });

  it('200 with a filing carries `filing`, as the set route answers one', async () => {
    stubState.sqlHandler = (text) => (/pv\.display_name AS variety_name, pv\.variety_rank, i\.name/.test(text)
      ? [{ id: LOT, variety_id: MIX, variety_name: 'A + B mix', variety_rank: 'blend', name: 'Renamed' }]
      : /SET variety_id = \?::uuid/.test(text) ? [{ id: LOT }] : answer()(text));
    const r = parse(await handler(post(body({ filing: { variety_id: MIX, expect_variety_id: FILED, name: 'Renamed' } }))));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.filing).toEqual({
      variety_id: MIX, variety_name: 'A + B mix', variety_rank: 'blend', name: 'Renamed', changed: true,
      previous: { variety_id: FILED, name: 'Lot' },
    });
  });

  it('the judge\'s refusals: status, sentence and code, each exactly', async () => {
    const cases = [
      ['key_conflict', 409, { error: ADDITION_KEY_CONFLICT, code: 'addition_key_conflict' }],
      ['used_up', 409, { error: LOT_USED_UP, code: 'lot_used_up' }],
      ['source_kind', 400, { error: SEED_CONSTRAINT_MESSAGES.chk_inventory_seed_source_plant }],
      ['plants_changed', 409, { error: PLANTS_CHANGED, code: 'parents_changed' }],
      ['own_source_lot', 400, { error: OWN_SOURCE_LOT, code: 'own_source_lot' }],
      ['no_parent_variety', 400, { error: VARIETY_MISMATCH_NO_PARENTS, code: 'variety_mismatch_no_parents' }],
      ['too_many_parents', 400, { error: TOO_MANY_PARENTS, code: 'too_many_parents' }],
      ['amount_too_large', 400, { error: AMOUNT_TOO_LARGE, code: 'amount_too_large' }],
    ];
    for (const [verdict, status, expected] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const r = await send(body(), undefined, { verdict });
      expect(r.status, verdict).toBe(status);
      expect(r.body, verdict).toEqual(expected);
    }
    // The sentences, as the contract fixes them (the client prints its own; the fixture pins these).
    expect(LOT_USED_UP).toBe('This seed lot is used up or no longer active. Nothing was added.');
    expect(ADDITION_KEY_CONFLICT).toBe('That addition is already recorded against another seed lot.');
    expect(OWN_SOURCE_LOT).toBe('This plant was grown from this seed lot.');
    expect(AMOUNT_TOO_LARGE).toBe('That would make the seed count too large.');
    expect(VARIETY_MISMATCH_NO_PARENTS).toBe('This seed lot has no plant on record and is filed under a different variety.');
    expect(TOO_MANY_PARENTS).toBe('source_plant_ids can name at most 12 plantings');
  });

  it('409 lot_changed from the judge hands back what the lot holds now — the set and the measure, no id', async () => {
    const r = await send(body(), undefined, { verdict: 'lot_changed' });
    expect(r.status).toBe(409);
    expect(Object.keys(r.body).sort()).toEqual([
      'code', 'error', 'name', 'quantity_on_hand', 'seed_count', 'seed_count_estimated', 'seed_parent_plant_count',
      'seed_weight_g', 'source_plant_id', 'source_plants', 'variety_id',
    ]);
    expect(r.body).toMatchObject({ error: LOT_CHANGED, code: 'lot_changed', seed_count: 100, source_plants: [{ id: PLANT, name: 'Plant' }] });
  });

  it('a judge after the first may only take "go" away: the rules, then the filing', async () => {
    const two = body({ expected_source_plant_ids: [OTHER] });
    expect(await send(two, undefined, { rules: false })).toMatchObject({ status: 409, body: { error: PLANTS_CHANGED, code: 'parents_changed' } });
    const filing = { filing: { variety_id: MIX, expect_variety_id: FILED } };
    const stale = await send(body(filing), undefined, { filing: 'changed' });
    expect(stale.status).toBe(409);
    // As the filing route answers it: the stored variety and name, and no plants.
    expect(stale.body).toEqual({ error: LOT_CHANGED, code: 'lot_changed', variety_id: FILED, name: 'Lot' });
    expect(await send(body(filing), undefined, { filing: 'unusable' })).toMatchObject({ status: 400, body: { code: 'variety_unusable' } });
    expect(await send(body(filing), undefined, { filing: 'crop' })).toMatchObject({ status: 400, body: { code: 'filing_crop_mismatch' } });
    // The first judge's verdict wins over both: a used-up lot is not described by its rules.
    expect((await send({ ...two, ...filing }, undefined, { verdict: 'used_up', rules: false, filing: 'changed' })).body.code).toBe('lot_used_up');
  });

  it('a lot that is not the caller\'s live seed lot is 404, whatever else is true of the request', async () => {
    stubState.sqlHandler = (text) => (IS_JUDGE.test(text) ? [] : answer()(text));
    expect(parse(await handler(post(body())))).toEqual({ status: 404, body: { error: 'Not found' } });
  });

  it('a rolled-back transaction is 409 lot_changed with NO lot fields — 23505, 40P01 and 22012 alike — and is logged', async () => {
    for (const code of ['23505', '40P01', '22012']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await send(body(), undefined, { throws: { code } });
      expect(r.status, code).toBe(409);
      expect(r.body, code).toEqual({ error: LOT_CHANGED, code: 'lot_changed' });
      expect(JSON.parse(r.warned[0])).toEqual({ tag: 'inv-seed-addition-retry', item: LOT, code });
    }
  });

  it('any other thrown code is rethrown: a CHECK reads its sentence, anything else is the handler\'s 500', async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      for (const name of ['chk_sla_seed_count_positive', 'chk_sla_count_basis_pairing', 'chk_sla_seed_weight_positive',
        'chk_sla_count_applied_needs_count', 'chk_sla_weight_applied_needs_weight']) {
        // eslint-disable-next-line no-await-in-loop
        const r = await send(body(), undefined, { throws: { code: '23514', constraint: name } });
        expect(r.status, name).toBe(400);
        expect(r.body.error, name).toBe(SEED_CONSTRAINT_MESSAGES[name]);
        expect(r.body.error, name).not.toMatch(/chk_|Constraint violation/);
      }
      // One sentence for the five, and it says nothing was changed.
      expect(new Set(Object.entries(SEED_CONSTRAINT_MESSAGES).filter(([k]) => k.startsWith('chk_sla_')).map(([, v]) => v)).size).toBe(1);
      expect(SEED_CONSTRAINT_MESSAGES.chk_sla_seed_weight_positive).toMatch(/Nothing was changed/);
      expect((await send(body(), undefined, { throws: { code: '42703' } })).status).toBe(500);
      // At the module: not swallowed.
      const sql = recorder(() => { throw Object.assign(new Error('boom'), { code: '42703' }); });
      await expect(addSeedToLot(sql, args())).rejects.toMatchObject({ code: '42703' });
      for (const code of ['23505', '40P01', '22012']) {
        const failing = recorder((text) => { if (/WITH pre AS/.test(text)) throw Object.assign(new Error('x'), { code }); return []; });
        const warn = console.warn;
        console.warn = () => {};
        // eslint-disable-next-line no-await-in-loop
        try { expect(await addSeedToLot(failing, args())).toEqual({ outcome: 'conflict' }); } finally { console.warn = warn; }
      }
    } finally { console.error = quiet; }
  });

  it('"go" with nothing written is never a 200', async () => {
    const r = await send(body(), undefined, { apply: { id: null, addition_id: null } });
    expect(r).toMatchObject({ status: 409, body: { error: LOT_CHANGED, code: 'lot_changed' } });
  });
});

describe('GET /seed-lots-open', () => {
  const get = (query, method = 'GET') => ({
    requestContext: { http: { method } },
    rawPath: '/api/inventory-items/seed-lots-open',
    headers: { authorization: 'Bearer stub-token' },
    ...(query ? { queryStringParameters: query } : {}),
  });
  const isOpen = (t) => /AS plant_crop_slug, o\.\*/.test(t);
  const ROW_KEYS = ['id', 'name', 'variety_id', 'variety_name', 'variety_rank', 'crop_slug', 'seed_stage', 'seed_process',
    'stage_entered_at', 'created_at', 'updated_at', 'seed_count', 'seed_count_estimated', 'seed_weight_g',
    'seed_parent_plant_count', 'quantity_on_hand', 'status', 'source_plant_id', 'is_member', 'same_variety', 'source_plants'];
  const lot = (id, extra = {}) => ({
    plant_id: PLANT, plant_crop_slug: 'tomato', id, name: `Lot ${id.slice(-2)}`, variety_id: FILED, variety_name: 'Brandywine',
    variety_rank: 'cultivar', crop_slug: 'tomato', seed_stage: 'drying', seed_process: 'wet', stage_entered_at: '2026-09-20T16:00:00.000Z',
    created_at: '2026-09-20T16:00:00.000Z', updated_at: '2026-09-21T16:00:00.000Z', seed_count: 40, seed_count_estimated: true,
    seed_weight_g: null, seed_parent_plant_count: null, quantity_on_hand: '1.000', status: 'active', source_plant_id: OTHER,
    is_member: false, same_variety: true, ...extra,
  });

  it('is GET-only, needs a uuid plant_id, and asks nothing of the database until it has one', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(parse(await handler(get({ plant_id: PLANT }, method))).status, method).toBe(405);
    for (const query of [undefined, {}, { plant_id: '' }, { plant_id: 'tomato' }, { crop_slug: 'tomato' }]) {
      const r = parse(await handler(get(query)));
      expect(r, JSON.stringify(query)).toEqual({ status: 400, body: { error: 'plant_id must be the id of a planting' } });
    }
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('no row back = not a planting the household can use: one generic 400 that names no lot', async () => {
    stubState.sqlHandler = () => [];
    const r = parse(await handler(get({ plant_id: PLANT })));
    expect(r).toEqual({ status: 400, body: { error: 'plant_id does not match a planting you can use' } });
    // Two statements, side by side: the lots and the household's parents.
    expect(stubState.sqlCalls).toHaveLength(2);
    expect(stubState.sqlCalls.filter((c) => isOpen(c.text))).toHaveLength(1);
    expect(stubState.sqlCalls.find((c) => isOpen(c.text)).values).toEqual([PLANT, [USER], [USER], [USER]]);
  });

  it('a planting with no lot open to it (or no variety) is a 200 with an empty list', async () => {
    stubState.sqlHandler = (text) => (isOpen(text) ? [{ plant_id: PLANT, plant_crop_slug: null, id: null }] : []);
    expect(parse(await handler(get({ plant_id: PLANT.toUpperCase() })))).toEqual({
      status: 200, body: { plant_id: PLANT, crop_slug: null, open_lots: [] },
    });
  });

  it('each row carries exactly the contract\'s keys, in the statement\'s order, with its own plants or []', async () => {
    const A = uuid(801);
    const B = uuid(802);
    stubState.sqlHandler = (text) => (isOpen(text)
      ? [lot(A, { is_member: true }), lot(B, { same_variety: false })]
      : [{ inventory_item_id: A, source_plants: [{ id: PLANT, name: 'Plant' }] }]);
    const r = parse(await handler(get({ plant_id: PLANT })));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['plant_id', 'crop_slug', 'open_lots']);
    expect(r.body).toMatchObject({ plant_id: PLANT, crop_slug: 'tomato' });
    expect(r.body.open_lots.map((l) => l.id)).toEqual([A, B]);
    for (const row of r.body.open_lots) expect(Object.keys(row)).toEqual(ROW_KEYS);
    expect(r.body.open_lots[0]).toMatchObject({ is_member: true, same_variety: true, source_plants: [{ id: PLANT, name: 'Plant' }] });
    expect(r.body.open_lots[1]).toMatchObject({ is_member: false, same_variety: false, source_plants: [] });
    // The planting's own two columns never ride on a lot row.
    expect(r.body.open_lots[0]).not.toHaveProperty('plant_id');
    expect(r.body.open_lots[0]).not.toHaveProperty('plant_crop_slug');
    expect(openLotsOf([], [])).toBeNull();
  });

  it('a failed parents read fails the request — "unknown" must not reach the sheet as "none"', async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      stubState.sqlHandler = (text) => { if (isOpen(text)) return [lot(uuid(801))]; throw new Error('parents read failed'); };
      expect(parse(await handler(get({ plant_id: PLANT }))).status).toBe(500);
    } finally { console.error = quiet; }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The SQL text: what the schema audit will read, and the filter's fixed points
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('seed-lot-additions.js — its SQL, as the schema audit reads it', () => {
  const TEMPLATES = [...ADD_SRC.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1]);
  // scripts/dev-main-schema-audit.py parse_sql_relations, restated: the word after FROM or JOIN is a
  // relation unless it is a CTE of that statement or one of the table functions the audit knows.
  const relationsOf = (tmpl) => {
    const scrubbed = tmpl.replace(/\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi, ' ');
    const ctes = new Set([...scrubbed.matchAll(/(?:\bWITH\s+(?:RECURSIVE\s+)?|,)\s*([a-z_][a-z0-9_]*)\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/gi)].map((m) => m[1].toLowerCase()));
    const NOT_A_RELATION = new Set(['select', 'lateral', 'unnest', 'generate_series', 'jsonb_array_elements', 'jsonb_array_elements_text', 'json_array_elements', 'values', 'rows']);
    return [...scrubbed.matchAll(/\b(?:FROM|JOIN)\s+(?:public\.)?([a-z_][a-z0-9_]*)(?!\s*\.)/gi)]
      .map((m) => m[1].toLowerCase()).filter((r) => !ctes.has(r) && !NOT_A_RELATION.has(r));
  };

  it('names six relations and nothing the audit would mistake for a seventh', () => {
    expect(TEMPLATES.length).toBe(5);
    expect([...new Set(TEMPLATES.flatMap(relationsOf))].sort()).toEqual([
      'cultivar', 'garden_node', 'inventory_items', 'seed_lot_addition', 'seed_lot_parent_planting', 'seed_lot_stage_log',
    ]);
    // Every relation is schema-qualified.
    for (const t of TEMPLATES) expect(t.replace(/\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi, ' ')).not.toMatch(/\b(?:FROM|JOIN)\s+(?!public\.|pre\b|upd\b|ins\b|\(|LATERAL\b)[a-z_]/i);
  });

  it('both year terms open a parenthesis straight after FROM, in New York', () => {
    const open = TEMPLATES.find((t) => /AS plant_crop_slug/.test(t)).replace(/\s+/g, ' ');
    expect(open).toContain(
      "EXTRACT(YEAR FROM (i.created_at AT TIME ZONE 'America/New_York')) = EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/New_York'))",
    );
    expect(open.match(/EXTRACT\(/g)).toHaveLength(2);
    for (const t of TEMPLATES) expect(t).not.toMatch(/\bFROM\s+now\b/i);
  });

  it('the open-lots filter: active, something in it, home-saved, never fermenting, drying or this year, never its own source lot', () => {
    const open = TEMPLATES.find((t) => /AS plant_crop_slug/.test(t)).replace(/\s+/g, ' ');
    for (const conjunct of [
      'i.created_by = ANY(${householdIds}) AND i.deleted_at IS NULL AND i.category = \'seeds\'',
      "AND i.status = 'active' AND i.quantity_on_hand > 0",
      "AND (i.source_kind IS NULL OR i.source_kind = 'own_garden')",
      "AND (i.source_plant_id IS NOT NULL OR i.seed_stage IS NOT NULL OR i.source_kind = 'own_garden')",
      "AND i.seed_stage IS DISTINCT FROM 'fermenting'",
      "AND (i.seed_stage = 'drying' OR EXTRACT(",
      'AND i.id IS DISTINCT FROM pl.source_inventory_item_id',
      'AND pl.crop_slug IS NOT NULL',
      'AND CASE WHEN k.parents = 0 THEN i.variety_id = pl.cultivar_id WHEN k.named = 0 THEN lv.crop_slug = pl.crop_slug ELSE k.crops = 1 AND k.crop = pl.crop_slug END',
    ]) expect(open, conjunct).toContain(conjunct);
    // The planting asked about is the household's and live.
    expect(open).toContain('WHERE p.id = ${plantId}::uuid AND p.created_by = ANY(${householdIds}) AND p.deleted_at IS NULL ) pl');
    // NULL is a crop of its own among the parents' varieties, as the parent rules count it.
    expect(open).toContain("(count(DISTINCT COALESCE(pv.crop_type_slug, '')) FILTER (WHERE p.cultivar_id IS NOT NULL))::int AS crops");
    expect(open).toContain('(i.variety_id = pl.cultivar_id OR k.shares_variety) AS same_variety');
    expect(open).toMatch(/ORDER BY o\.is_member DESC NULLS LAST, o\.same_variety DESC NULLS LAST, o\.created_at DESC, o\.id DESC\s*$/);
  });

  it('the judge reads its verdicts in the contract\'s order, and only "go" sets go', () => {
    const judge = TEMPLATES.find((t) => /AS verdict/.test(t)).replace(/\s+/g, ' ');
    const verdicts = judge.slice(judge.indexOf('WHEN g.key_found'), judge.indexOf('END AS verdict'));
    const order = [...verdicts.matchAll(/THEN '([a-z_]+)'/g)].map((m) => m[1]);
    expect(order).toEqual([
      'replay', 'key_conflict', 'used_up', 'lot_changed', 'source_kind', 'plants_changed', 'own_source_lot',
      'no_parent_variety', 'too_many_parents', 'amount_too_large',
    ]);
    expect(judge).toContain("ELSE 'go' END AS verdict");
    expect(judge).toContain("set_config('app.seed_lot_go', CASE WHEN f.verdict = 'go' THEN 'go' ELSE 'stop' END, true) AS go");
    expect(judge).toContain("set_config('app.seed_lot_plant_new', CASE WHEN f.plant_member THEN 'false' ELSE 'true' END, true) AS plant_new");
    expect(judge).toContain("WHEN g.quantity_on_hand <= 0 OR g.status <> 'active' THEN 'used_up'");
    expect(judge).toContain('COALESCE(g.seed_count::bigint + ${addCount}::int > 2147483647, FALSE)');
    expect(judge).toContain('COALESCE(g.seed_weight_g + ${addWeight}::numeric >= 10000000, FALSE)');
  });

  it('applyAddition is all-or-nothing in the statement itself, and every write in it waits on the held verdict', () => {
    const apply = TEMPLATES.find((t) => /WITH pre AS/.test(t)).replace(/\s+/g, ' ');
    expect(apply).toContain("AND current_setting('app.seed_lot_go', true) = 'go' ), upd AS (");
    expect(apply).toContain('FROM pre WHERE i.id = pre.id RETURNING');
    expect(apply).toContain('FROM upd JOIN pre ON pre.id = upd.id RETURNING id, count_applied, weight_applied )');
    expect(apply).toContain(
      "1 / (CASE WHEN current_setting('app.seed_lot_go', true) IS DISTINCT FROM 'go' OR (SELECT count(*) FROM ins) = 1 THEN 1 ELSE 0 END) AS all_or_nothing",
    );
    // The count cells: uncounted stays uncounted; a blank picking makes a counted lot an estimate.
    expect(apply).toContain('seed_count = CASE WHEN pre.c0 IS NOT NULL AND ${addCount}::int IS NOT NULL THEN pre.c0 + ${addCount}::int ELSE pre.c0 END');
    expect(apply).toContain(
      'seed_count_estimated = CASE WHEN pre.c0 IS NULL THEN i.seed_count_estimated WHEN ${addCount}::int IS NULL THEN TRUE ELSE (i.seed_count_estimated OR ${addEstimated}::boolean) END',
    );
    expect(apply).toContain('seed_weight_g = CASE WHEN pre.w0 IS NOT NULL AND ${addWeight}::numeric IS NOT NULL THEN pre.w0 + ${addWeight}::numeric ELSE pre.w0 END');
  });
});
