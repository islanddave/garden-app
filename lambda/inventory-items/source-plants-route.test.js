// V5-SEEDMULTIPARENT-001 — PUT /api/inventory-items/:id/source-plants, driven through the handler.
//
// THE ROUTE. Body { "source_plant_ids": [uuid, ...] }; replaces the lot's set of parent plantings,
// `[]` clears it. 200 { id, source_plant_id, source_plants }. 400 for a missing key, a malformed or
// over-long array, a planting the caller cannot use, or a lot that says it came from a shop. 404 for
// a lot that is absent, foreign, deleted or not seeds. 409 when a concurrent writer collided, or when
// a planting the gate passed stopped being usable before the write ran (Follow-up 1).
//
// WHY THROUGH THE HANDLER. What matters here is ORDER and REACH: which statements are issued for
// which body, what is refused before any SQL, and what each refusal leaves un-issued. A scan of the
// source cannot show any of that.
//
// WHAT THE STUB CANNOT SHOW. It records SQL text and bound values and returns canned rows; it does
// not execute SQL and has no notion of a transaction (its sql.transaction is Promise.all). So "the
// seven statements commit or roll back together" and "a guard written in SQL writes nothing" are NOT
// proven here — seed-lot-parents.test.js pins that the module passes all seven to ONE transaction
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

// Each statement, recognised by something only it says. `owns` and `members` are the gate's two
// arms (before the transaction); `hold` is the share lock on the plantings, inside it.
const IS = {
  owns: (t) => /FROM public\.garden_node p\s+WHERE p\.id = ANY\(\?::uuid\[\]\)\s+AND p\.created_by = ANY/.test(t),
  members: (t) => /SELECT k\.plant_id AS id/.test(t),
  lock: (t) => /FOR UPDATE/.test(t),
  hold: (t) => /FOR SHARE/.test(t),
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
    members: () => [],
    lock: () => [{ id: LOT }],
    hold: () => values[0].map((id) => ({ id })),
    facts: () => [{ id: LOT, source_kind: null, live_parents: 0, ids_usable: true }],
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
    // The set route's signature: the counted array gate, then the seven-statement write. The generic
    // /:id PUT would have issued `UPDATE inventory_items SET name = …`; the legacy route a single-id probe.
    expect(kinds()).toEqual(['owns', 'lock', 'hold', 'facts', 'retire', 'add', 'cache', 'read']);
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
    // Both arms of the gate were asked — B is not the household's (owns), and not already a parent
    // of this lot (members) — and nothing after them.
    expect(kinds()).toEqual(['owns', 'members']);
    expect(find('owns').values).toEqual([[A, B], [USER]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
      msg: 'authz-fk-reject', userId: USER, table: 'seed_lot_parent_planting', column: 'plant_id',
    });
  });

  it('gates the plantings BEFORE it locks or writes anything — the same answer whatever lot was aimed at', async () => {
    // A foreign planting on a lot that does not exist is still the planting's 400, never a 404 that
    // would tell the caller the planting half was fine.
    stubState.sqlHandler = world({ owns: [], lock: [], facts: [] });
    const res = parse(await handler(put({ source_plant_ids: [A] })));
    expect(res.status).toBe(400);
    expect(kinds()).toEqual(['owns', 'members']);
  });
});

describe('PUT /:id/source-plants — the gate\'s second arm: a planting that is ALREADY a parent of this lot', () => {
  // Follow-up 1 (contract amendment). An id is acceptable when it is a live planting the household
  // owns, OR already a live seed_parent of THIS lot. The second arm is what lets a lot that keeps a
  // parent whose planting was later soft-deleted still be edited: without it the unchanged id fails
  // the first arm and the only edit the route accepts is one that drops that parent.
  const D = uuid(4);   // a planting that has since been soft-deleted — the first arm does not return it

  it('accepts an unchanged id whose planting was deleted, so the rest of the set stays editable', async () => {
    // The lot has {A, D}; the edit adds B and keeps D.
    stubState.sqlHandler = world({ owns: [{ id: A }, { id: B }], members: [{ id: D }] });
    const res = parse(await handler(put({ source_plant_ids: [A, D, B] })));
    expect(res.status).toBe(200);
    expect(kinds()).toEqual(['owns', 'members', 'lock', 'hold', 'facts', 'retire', 'add', 'cache', 'read']);
    expect(warn).not.toHaveBeenCalled();
    // The whole set reaches the write — D included.
    expect(boundAfter(find('add'), /CROSS JOIN unnest\(/)).toEqual([A, D, B]);
  });

  it('asks the second arm ONLY about the ids the first did not admit, through the caller\'s own lot', async () => {
    stubState.sqlHandler = world({ owns: [{ id: A }, { id: B }], members: [{ id: D }] });
    await handler(put({ source_plant_ids: [A, D, B] }));
    const m = find('members');
    expect(m.text.replace(/\s+/g, ' ')).toContain(
      "SELECT k.plant_id AS id FROM public.seed_lot_parent_planting k JOIN public.inventory_items i ON i.id = k.inventory_item_id WHERE i.id = ? AND i.created_by = ANY(?) AND i.deleted_at IS NULL AND i.category = 'seeds' AND k.plant_id = ANY(?::uuid[]) AND k.role = 'seed_parent' AND k.deleted_at IS NULL");
    // The route's lot, the household, and only the leftover id — all bound.
    expect(m.values).toEqual([LOT, [USER], [D]]);
  });

  it('never asks it at all when every planting is the household\'s and live — the ordinary edit', async () => {
    await handler(put({ source_plant_ids: [A, B] }));
    expect(kinds()).not.toContain('members');
    // …so the ordinary edit reads no link row before its transaction has the lot.
    const before = stubState.sqlCalls.slice(0, kinds().indexOf('lock'));
    expect(before.filter((c) => /seed_lot_parent_planting/.test(c.text))).toHaveLength(0);
  });

  it('still 400s a NEW id that names a deleted planting — the arm admits members, not the deleted', async () => {
    // D is not the household's live planting (owns) and not a parent of this lot (members).
    stubState.sqlHandler = world({ owns: [{ id: A }], members: [] });
    const res = parse(await handler(put({ source_plant_ids: [A, D] })));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('source_plant_ids does not match plantings you can use');
    expect(kinds()).toEqual(['owns', 'members']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('counts here too: two left over and only one of them a member is a refusal', async () => {
    const E = uuid(5);
    stubState.sqlHandler = world({ owns: [{ id: A }], members: [{ id: D }] });
    const res = parse(await handler(put({ source_plant_ids: [A, D, E] })));
    expect(res.status).toBe(400);
    expect(find('members').values[2]).toEqual([D, E]);
    expect(kinds()).toEqual(['owns', 'members']);
  });

  it('has no members to ask about on a lot id that is not one: the first arm decides alone', async () => {
    stubState.sqlHandler = world({ owns: [] });
    const res = parse(await handler(put({ source_plant_ids: [A] }, 'not-a-uuid')));
    expect(res.status).toBe(400);
    expect(kinds()).toEqual(['owns']);
    for (const c of stubState.sqlCalls) expect(JSON.stringify(c.values)).not.toContain('not-a-uuid');
  });
});

describe('PUT /:id/source-plants — a planting that changed AFTER the gate (T1 defect D-2)', () => {
  // The gate runs before the lot lock. A request that then waits for its lot — behind a planting
  // merge, say — would otherwise act on what the gate saw before the wait. Observed on real Postgres:
  // the lot had {A, L}; a PUT re-sending {A, L} waited behind a merge of L into W, then answered 200
  // having retired W's row and linked the soft-deleted L. The rule is now re-tested by every write
  // statement under the lock; this is what the route answers when that re-test is what failed.
  const W = uuid(7);
  const afterMerge = () => world({
    // Statement 2, read under the locks: L is neither live nor a member any more.
    facts: [{ id: LOT, source_kind: null, live_parents: 2, ids_usable: false }],
    cache: [],                                   // the three guarded writes changed nothing
    read: [{ inventory_item_id: LOT, source_plants: [parent(A, 'Alaska Mix'), parent(W, 'the winner')] }],
  });

  it('answers 409 with a plain sentence, and nothing that could be read as the new state', async () => {
    stubState.sqlHandler = afterMerge();
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'One of those plants changed just now. Reload and try again.' });
    expect(res.body.error).not.toMatch(/source_plant|_id\b|constraint|merge/i);
  });

  it('is not the gate\'s 400: the gate PASSED, and nobody is logged as having tried a foreign planting', async () => {
    stubState.sqlHandler = afterMerge();
    await handler(put({ source_plant_ids: [A, B] }));
    // The gate ran and admitted both ids; the refusal came from inside the transaction.
    expect(kinds()).toEqual(['owns', 'lock', 'hold', 'facts', 'retire', 'add', 'cache', 'read']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('holds the plantings still before deciding: the share lock sits between the lot lock and the facts', async () => {
    await handler(put({ source_plant_ids: [B, A] }));
    const order = kinds();
    expect(order.indexOf('lock')).toBeLessThan(order.indexOf('hold'));
    expect(order.indexOf('hold')).toBeLessThan(order.indexOf('facts'));
    expect(find('hold').values).toEqual([[B, A]]);
  });

  it('409s a deadlock victim (40P01) instead of a 500 — its transaction wrote nothing', async () => {
    stubState.sqlHandler = world({
      retire: () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); },
    });
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'This seed lot was changed at the same moment. Reload and try again.' });
    // Logged by code, so a lock-order regression does not hide behind the 409.
    const lines = warn.mock.calls.map((c) => JSON.parse(c[0]));
    expect(lines).toEqual([{ tag: 'inv-source-plants-retry', item: LOT, code: '40P01' }]);
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

  it('[] CLEARS: no ownership query, the same seven statements, a NULL cache and an empty set', async () => {
    stubState.sqlHandler = world({ cache: [{ id: LOT, source_plant_id: null }], read: [] });
    const res = parse(await handler(put({ source_plant_ids: [] })));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: LOT, source_plant_id: null, source_plants: [] });
    // Clearing needs no planting, so it asks about none — and its share lock names none.
    expect(kinds()).toEqual(['lock', 'hold', 'facts', 'retire', 'add', 'cache', 'read']);
    expect(find('hold').values).toEqual([[]]);
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
    // The LOT's sentence, not the plantings': a unique violation says a link row moved, not that a
    // planting became unusable.
    expect(res.body.error).toBe('This seed lot was changed at the same moment. Reload and try again.');
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
