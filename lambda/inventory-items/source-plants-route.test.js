// V5-SEEDMULTIPARENT-001 — PUT /api/inventory-items/:id/source-plants, driven through the handler.
//
// THE ROUTE. Body { "source_plant_ids": [uuid, ...] }; replaces the lot's set of parent plantings,
// `[]` clears it. 200 { id, source_plant_id, source_plants }. 400 for a missing key, a malformed or
// over-long array, a planting the caller cannot use, or a lot that says it came from a shop. 404 for
// a lot that is absent, foreign, deleted or not seeds. 409 when a concurrent writer collided.
//
// WHY THROUGH THE HANDLER. What matters here is ORDER and REACH: which statements are issued for
// which body, what is refused before any SQL, and what each refusal leaves un-issued. A scan of the
// source cannot show any of that.
//
// WHAT THE STUB CANNOT SHOW. It records SQL text and bound values and returns canned rows; it does
// not execute SQL and has no notion of a transaction (its sql.transaction is Promise.all). So "the
// six statements commit or roll back together" and "a guard written in SQL writes nothing" are NOT
// proven here — seed-lot-parents.test.js pins that the module passes all six to ONE transaction
// call, and the lane report lists what a real-database test must prove.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const uuid = (n) => `3f9c1e64-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);

const call = (method, body, id = LOT, suffix = 'source-plants') => ({
  requestContext: { http: { method } },
  rawPath: `/api/inventory-items/${id}/${suffix}`,
  headers: { authorization: 'Bearer stub-token' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const put = (body, id) => call('PUT', body, id);
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

// Each statement, recognised by something only it says.
const IS = {
  owns: (t) => /FROM public\.garden_node p\s+WHERE p\.id = ANY/.test(t),
  lock: (t) => /FOR UPDATE/.test(t),
  facts: (t) => /AS live_parents/.test(t),
  retire: (t) => /UPDATE public\.seed_lot_parent_planting l/.test(t),
  add: (t) => /INSERT INTO public\.seed_lot_parent_planting/.test(t),
  cache: (t) => /UPDATE public\.inventory_items i/.test(t),
  read: (t) => /jsonb_agg/.test(t),
};
const kindOf = (t) => Object.keys(IS).find((k) => IS[k](t)) ?? 'other';
const kinds = () => stubState.sqlCalls.map((c) => kindOf(c.text));
const find = (k) => stubState.sqlCalls.find((c) => IS[k](c.text));

const boundAfter = (c, re) => {
  const m = c.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(c.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return c.values[(c.text.slice(0, end).match(/\?/g) ?? []).length];
};

const parent = (id, name) => ({
  id, name, variety_id: uuid(90), variety_name: name, breeding_system: 'open_pollinated', archived: false, deleted: false,
});
const JAR = [parent(A, 'Alaska Mix'), parent(B, 'Jewel Mix')];

// A lot that exists, with every planting owned, unless `over` says otherwise for one statement.
const world = (over = {}) => (text, values) => {
  const k = kindOf(text);
  if (k in over) return typeof over[k] === 'function' ? over[k](values) : over[k];
  return {
    owns: () => values[0].map((id) => ({ id })),
    lock: () => [{ id: LOT }],
    facts: () => [{ id: LOT, source_kind: null, live_parents: 0 }],
    retire: () => [],
    add: () => [],
    cache: () => [{ id: LOT, source_plant_id: A }],
    read: () => [{ inventory_item_id: LOT, source_plants: JAR }],
    other: () => [],
  }[k]();
};

let warn;
beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = world();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('PUT /:id/source-plants — reaching the route', () => {
  it('is matched ABOVE the generic arms, and is not the legacy /source-plant route', async () => {
    const { status, body } = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(status).toBe(200);
    // The set route's signature: the counted array gate, then the six-statement write. The generic
    // /:id PUT would have issued `UPDATE inventory_items SET name = …`; the legacy route a single-id probe.
    expect(kinds()).toEqual(['owns', 'lock', 'facts', 'retire', 'add', 'cache', 'read']);
    expect(Object.keys(body).sort()).toEqual(['id', 'source_plant_id', 'source_plants']);
  });

  it('declares its match before idMatch, and the legacy regex cannot catch its path', () => {
    const src = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
    const own = src.indexOf('const sourcePlantsMatch = rawPath.match');
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(src.indexOf('const idMatch = rawPath.match'));
    // The two regexes as written in the handler, run against each other's path. `/source-plant$`
    // is anchored, so the plural cannot fall into the singular arm (and vice versa).
    const re = (name) => new RegExp(src.match(new RegExp(`const ${name} = rawPath\\.match\\(/(.*?)/\\);`))[1]);
    const plural = `/api/inventory-items/${LOT}/source-plants`;
    const singular = `/api/inventory-items/${LOT}/source-plant`;
    expect(re('sourcePlantsMatch').test(plural)).toBe(true);
    expect(re('sourcePlantsMatch').test(singular)).toBe(false);
    expect(re('sourcePlantMatch').test(plural)).toBe(false);
    expect(re('sourcePlantMatch').test(singular)).toBe(true);
    expect(re('idMatch').test(plural)).toBe(false);
  });

  it('is PUT-only — every other verb is 405 before any SQL', async () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      const { status } = parse(await handler(call(method, { source_plant_ids: [A] })));
      expect(status, method).toBe(405);
      expect(stubState.sqlCalls, method).toHaveLength(0);
    }
  });
});

describe('PUT /:id/source-plants — what is refused before anything is written', () => {
  it('400s a body that never mentions the key — absence is not "clear"', async () => {
    for (const body of [{}, { source_plant_id: A }, { ids: [A] }]) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      const res = parse(await handler(put(body)));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('source_plant_ids is required (send [] to clear)');
      expect(stubState.sqlCalls).toHaveLength(0);
    }
  });

  it('400s a non-array, a non-uuid element and more than twelve, before any SQL', async () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => uuid(i + 1));
    const cases = [
      [null, 'source_plant_ids must be an array of planting ids'],
      [A, 'source_plant_ids must be an array of planting ids'],
      [[A, 'not-a-uuid'], 'source_plant_ids must contain only planting ids'],
      [[A, 7], 'source_plant_ids must contain only planting ids'],
      [thirteen, 'source_plant_ids can name at most 12 plantings'],
    ];
    for (const [value, message] of cases) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      const res = parse(await handler(put({ source_plant_ids: value })));
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(res.body.error).toBe(message);
      expect(stubState.sqlCalls, 'malformed input reached the database').toHaveLength(0);
    }
  });

  it('400s an array with one planting the household cannot use, having written nothing', async () => {
    // One of two owned: the presence test the single-id gates use would pass this.
    stubState.sqlHandler = world({ owns: [{ id: A }] });
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('source_plant_ids does not match plantings you can use');
    expect(kinds()).toEqual(['owns']);
    expect(find('owns').values).toEqual([[A, B], [USER]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
      msg: 'authz-fk-reject', userId: USER, table: 'seed_lot_parent_planting', column: 'plant_id',
    });
  });

  it('gates the plantings BEFORE it looks at the lot — the same answer whatever lot was aimed at', async () => {
    // A foreign planting on a lot that does not exist is still the planting's 400, never a 404 that
    // would tell the caller the planting half was fine.
    stubState.sqlHandler = world({ owns: [], lock: [], facts: [] });
    const res = parse(await handler(put({ source_plant_ids: [A] })));
    expect(res.status).toBe(400);
    expect(kinds()).toEqual(['owns']);
  });
});

describe('PUT /:id/source-plants — the write', () => {
  it('replaces the set: the deduped, lower-cased ids reach every statement that needs them', async () => {
    const res = parse(await handler(put({ source_plant_ids: [B.toUpperCase(), A, B] })));
    expect(res.status).toBe(200);
    const ids = [B, A];                     // body order, deduped case-insensitively
    expect(find('owns').values[0]).toEqual(ids);
    expect(boundAfter(find('retire'), /NOT \(l\.plant_id = ANY\(/)).toEqual(ids);
    expect(boundAfter(find('add'), /CROSS JOIN unnest\(/)).toEqual(ids);
    // Added by the caller, onto the route's lot, for the caller's household.
    expect(boundAfter(find('add'), /'seed_parent', /)).toBe(USER);
    for (const k of ['lock', 'facts', 'retire', 'add', 'cache']) {
      expect(boundAfter(find(k), /i\.id = /), k).toBe(LOT);
      expect(boundAfter(find(k), /i\.created_by = ANY\(/), k).toEqual([USER]);
    }
    // NOT the legacy write: a lot that already has several parents is replaceable here.
    for (const k of ['retire', 'add', 'cache']) expect(boundAfter(find(k), /AND \(NOT /), k).toBe(false);
  });

  it('answers the lot id, the member cache and the set as the write left it', async () => {
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.body).toEqual({ id: LOT, source_plant_id: A, source_plants: JAR });
    // The read-back is the shared parents read, for this lot.
    expect(find('read').values).toEqual([[USER], LOT, LOT]);
  });

  it('[] CLEARS: no ownership query, the same six statements, a NULL cache and an empty set', async () => {
    stubState.sqlHandler = world({ cache: [{ id: LOT, source_plant_id: null }], read: [] });
    const res = parse(await handler(put({ source_plant_ids: [] })));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: LOT, source_plant_id: null, source_plants: [] });
    // Clearing needs no planting, so it asks about none.
    expect(kinds()).toEqual(['lock', 'facts', 'retire', 'add', 'cache', 'read']);
    expect(boundAfter(find('retire'), /NOT \(l\.plant_id = ANY\(/)).toEqual([]);
  });

  it('404s a lot that is absent, foreign, deleted or not seeds — all four the same way', async () => {
    // Every statement carries the lot predicate, so for any of the four the facts read is empty.
    stubState.sqlHandler = world({ lock: [], facts: [], cache: [], read: [] });
    const res = parse(await handler(put({ source_plant_ids: [A] })));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('404s a malformed lot id without sending it to Postgres', async () => {
    // 22P02 is unmapped and would answer 500.
    const res = parse(await handler(put({ source_plant_ids: [A] }, 'not-a-uuid')));
    expect(res.status).toBe(404);
    expect(kinds()).toEqual(['owns']);
    for (const c of stubState.sqlCalls) expect(c.values).not.toContain('not-a-uuid');
  });

  it('400s a non-empty set on a lot whose stored source_kind is a shop kind', async () => {
    stubState.sqlHandler = world({ facts: [{ id: LOT, source_kind: 'gift', live_parents: 0 }], cache: [], read: [] });
    const res = parse(await handler(put({ source_plant_ids: [A] })));
    expect(res.status).toBe(400);
    // The sentence the database CHECK for this rule has always answered with — a person's words,
    // naming no column, and the same ones the legacy route gave before the write moved.
    expect(res.body.error).toBe(
      'This lot names the plant it was saved from, so it cannot also say it came from a shop, a gift or a farm stand. Clear one of the two.');
    expect(res.body.code).toBeUndefined();
  });

  it('…but lets that same lot be CLEARED', async () => {
    stubState.sqlHandler = world({
      facts: [{ id: LOT, source_kind: 'gift', live_parents: 0 }], cache: [{ id: LOT, source_plant_id: null }], read: [],
    });
    const res = parse(await handler(put({ source_plant_ids: [] })));
    expect(res.status).toBe(200);
  });

  it('409s a concurrent unique violation (23505), and it is not the multi-parent 409', async () => {
    stubState.sqlHandler = world({
      add: () => { throw Object.assign(new Error('duplicate key value'), { code: '23505', constraint: 'uq_slpp_item_plant_role_live' }); },
    });
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.status).toBe(409);
    expect(res.body.code).toBeUndefined();
    expect(res.body.error).toMatch(/Reload and try again/);
  });

  it('a foreign-key failure inside the write is a 400, not a 200', async () => {
    // A planting hard-deleted between the gate and the INSERT. The transaction rolled back.
    stubState.sqlHandler = world({
      add: () => { throw Object.assign(new Error('violates foreign key'), { code: '23503', constraint: 'seed_lot_parent_planting_plant_id_fkey' }); },
    });
    const res = parse(await handler(put({ source_plant_ids: [A] })));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Foreign key violation: seed_lot_parent_planting_plant_id_fkey');
  });
});
