// V5-SEEDMULTIPARENT-001 — `source_plants` on the three responses that READ a lot: the list, the
// detail, and the wide PUT's echo. Driven through the handler.
//
// THE CONTRACT (R1-CONTRACT sections 3 and 4):
//   • every row carries source_plants — an array, [] when the lot has none;
//   • it is null ONLY when the parents read itself failed, and then the response still succeeds:
//     the read settles and logs, it never 500s the packet page or the seed list;
//   • one aggregate per lot, never a join that multiplies list rows;
//   • the wide PUT returns it and IGNORES `source_plants` / `source_plant_ids` in its body;
//   • source_plant_id on the row is untouched.
// The read's own SQL shape is pinned where it is defined (seed-lot-parents.test.js). The POST 201
// and the two parents routes carry it too; their files assert it.
//
// THE STUB EXECUTES NO SQL: these prove which statements are issued, when, what each response is
// built from, and that a failing parents statement is survived — not that the aggregate returns the
// right rows from a real table (the lane report lists that case for an integration test).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { handler, validateUpdate } = await import('./index.js');

const USER = 'user_stub_owner';
const uuid = (n) => `3f9c1e64-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;
const LOT = uuid(100);      // a saved-seed lot with two parents
const PACKET = uuid(101);   // a bought packet: seeds, no parents
const SHOVEL = uuid(102);   // not seeds
const A = uuid(1);
const B = uuid(2);
const FOREIGN = uuid(66);

const get = (path, qs) => ({
  requestContext: { http: { method: 'GET' } }, rawPath: path,
  headers: { authorization: 'Bearer stub-token' }, queryStringParameters: qs,
});
const put = (id, body) => ({
  requestContext: { http: { method: 'PUT' } }, rawPath: `/api/inventory-items/${id}`,
  headers: { authorization: 'Bearer stub-token' }, body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const IS = {
  parents: (t) => /jsonb_agg/.test(t),
  list: (t) => /se\.entered_at AS stage_entered_at/.test(t),
  detail: (t) => /effective_featured_photo_id/.test(t) && /WHERE i\.id = \?/.test(t),
  germination: (t) => /seeds_sown IS NOT NULL/.test(t),
  sownFrom: (t) => /p\.archived_at IS NULL/.test(t),
  update: (t) => /UPDATE inventory_items SET/.test(t),
};
const kindOf = (t) => Object.keys(IS).find((k) => IS[k](t)) ?? 'other';
const kinds = () => stubState.sqlCalls.map((c) => kindOf(c.text));
const find = (k) => stubState.sqlCalls.find((c) => IS[k](c.text));

const parent = (id, name, extra = {}) => ({
  id, name, variety_id: uuid(90), variety_name: name, breeding_system: 'open_pollinated',
  archived: false, deleted: false, ...extra,
});
// An archived parent and a soft-deleted one: both are still elements of the set.
const JAR = [parent(A, 'Alaska Mix', { archived: true }), parent(B, 'Jewel Mix', { deleted: true })];
const ROWS = [
  { id: LOT, name: 'Mixed nasturtium', category: 'seeds', source_plant_id: A },
  { id: PACKET, name: 'True Greek Oregano', category: 'seeds', source_plant_id: null },
  { id: SHOVEL, name: 'Broadfork', category: 'tools', source_plant_id: null },
];
const fail = (message, code) => () => { throw Object.assign(new Error(message), { code }); };

const world = (over = {}) => (text, values) => {
  const k = kindOf(text);
  if (k in over) return typeof over[k] === 'function' ? over[k](values) : over[k];
  return {
    parents: () => [{ inventory_item_id: LOT, source_plants: JAR }],
    list: () => ROWS,
    detail: () => [ROWS.find((r) => r.id === values[values.length - 2]) ?? ROWS[0]],
    germination: () => [],
    sownFrom: () => [],
    update: () => [{ id: LOT, name: 'Mixed nasturtium', category: 'seeds', source_plant_id: A }],
    other: () => [],
  }[k]();
};

let errorLog;
beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = world();
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// A handler call that must finish on its own. If it is still pending after the stub's statements
// have had every chance to interleave, something it awaited was never issued.
const settledOrStuck = (promise) => Promise.race([
  promise,
  new Promise((r) => { setTimeout(() => r('STUCK'), 400); }),
]);

describe('GET /api/inventory-items — every list row carries source_plants', () => {
  const branches = [
    ['unfiltered — the whole inventory drawer', undefined],
    ['?category=seeds — what the seed pages fetch', { category: 'seeds' }],
  ];
  for (const [name, qs] of branches) {
    it(`merges the parents onto their lot, [] onto every other row — ${name}`, async () => {
      const { status, body } = parse(await handler(get('/api/inventory-items', qs)));
      expect(status).toBe(200);
      expect(kinds()).toEqual(['list', 'parents']);
      const by = Object.fromEntries(body.map((r) => [r.id, r]));
      expect(by[LOT].source_plants).toEqual(JAR);
      // A lot with no parents, and a row that cannot have any: an empty array, never null, never absent.
      expect(by[PACKET].source_plants).toEqual([]);
      expect(by[SHOVEL].source_plants).toEqual([]);
      // The cache column rides through from i.* untouched.
      expect(by[LOT].source_plant_id).toBe(A);
      // The parents read asked for the whole household, no lot.
      expect(find('parents').values).toEqual([[USER], null, null]);
    });
  }

  it('does not multiply rows: three rows in, three rows out, however many parents a lot has', async () => {
    const four = [parent(A, 'a'), parent(B, 'b'), parent(uuid(3), 'c'), parent(uuid(4), 'd')];
    stubState.sqlHandler = world({ parents: [{ inventory_item_id: LOT, source_plants: four }] });
    const { body } = parse(await handler(get('/api/inventory-items')));
    expect(body.map((r) => r.id)).toEqual([LOT, PACKET, SHOVEL]);
    expect(body[0].source_plants).toHaveLength(4);
    // …because the list statement itself never names the link table: the parents are their own statement.
    expect(find('list').text).not.toMatch(/seed_lot_parent_planting/);
  });

  it('keeps an archived parent and a soft-deleted parent in the array, flagged', async () => {
    const { body } = parse(await handler(get('/api/inventory-items', { category: 'seeds' })));
    const jar = body.find((r) => r.id === LOT).source_plants;
    expect(jar.map((p) => [p.id, p.archived, p.deleted])).toEqual([[A, true, false], [B, false, true]]);
    expect(Object.keys(jar[0]).sort()).toEqual(
      ['archived', 'breeding_system', 'deleted', 'id', 'name', 'variety_id', 'variety_name']);
  });

  it('asks for no parents at all when the filter cannot include a seed row', async () => {
    // The treatment log's product picker. Only a seeds row can have parents, so every row is [].
    stubState.sqlHandler = world({ list: [ROWS[2]] });
    const { status, body } = parse(await handler(get('/api/inventory-items', { category: 'tools,fertilizer' })));
    expect(status).toBe(200);
    expect(kinds()).toEqual(['list']);
    expect(body[0].source_plants).toEqual([]);
  });

  it('SETTLES: a failed parents read is null on every row and a log line — the list still answers', async () => {
    stubState.sqlHandler = world({ parents: fail('relation "seed_lot_parent_planting" does not exist', '42P01') });
    const { status, body } = parse(await handler(get('/api/inventory-items', { category: 'seeds' })));
    expect(status).toBe(200);
    expect(body.map((r) => r.id)).toEqual([LOT, PACKET, SHOVEL]);
    // null = unknown. [] would say "this jar has no parents", which nobody established.
    for (const r of body) expect(r.source_plants).toBeNull();
    expect(body[0].name).toBe('Mixed nasturtium');
    expect(body[0].source_plant_id).toBe(A);
    const lines = errorLog.mock.calls.map((c) => { try { return JSON.parse(c[0]); } catch { return null; } }).filter(Boolean);
    expect(lines).toEqual([{
      tag: 'inv-source-plants-failed', list: 'seeds', error: 'Error', code: '42P01',
      message: 'relation "seed_lot_parent_planting" does not exist',
    }]);
  });

  it('a failed LIST read still fails the request, exactly as before', async () => {
    stubState.sqlHandler = world({ list: fail('boom') });
    expect(parse(await handler(get('/api/inventory-items'))).status).toBe(500);
  });

  it('issues the parents read BESIDE the list, not after it', async () => {
    // The list is held open until the parents statement has been issued. A handler that awaited
    // the list first would never issue it, and would hang.
    let release;
    const held = new Promise((r) => { release = r; });
    stubState.sqlHandler = world({
      list: () => held,
      parents: () => { release(ROWS); return [{ inventory_item_id: LOT, source_plants: JAR }]; },
    });
    const res = await settledOrStuck(handler(get('/api/inventory-items')));
    expect(res, 'the list was awaited before the parents read was issued').not.toBe('STUCK');
    expect(parse(res).body[0].source_plants).toEqual(JAR);
  });
});

describe('GET /api/inventory-items/:id — the detail carries source_plants', () => {
  it('reads the parents in the same round trip as the germination summary and sown_from', async () => {
    const { status, body } = parse(await handler(get(`/api/inventory-items/${LOT}`)));
    expect(status).toBe(200);
    expect(kinds()).toEqual(['detail', 'germination', 'sownFrom', 'parents']);
    expect(body.source_plants).toEqual(JAR);
    expect(body.source_plant_id).toBe(A);
    // Scoped to this lot and this household.
    expect(find('parents').values).toEqual([[USER], LOT, LOT]);
    // The two reads it sits beside are untouched.
    expect(body.sown_from).toEqual([]);
    expect(body.germination).toMatchObject({ sowings: [], rate: null });
  });

  it('a seeds row with no parents answers []', async () => {
    stubState.sqlHandler = world({ detail: [ROWS[1]], parents: [] });
    const { body } = parse(await handler(get(`/api/inventory-items/${PACKET}`)));
    expect(body.source_plants).toEqual([]);
  });

  it('a non-seeds row answers [] without asking', async () => {
    stubState.sqlHandler = world({ detail: [ROWS[2]] });
    const { status, body } = parse(await handler(get(`/api/inventory-items/${SHOVEL}`)));
    expect(status).toBe(200);
    expect(kinds()).toEqual(['detail']);
    expect(body.source_plants).toEqual([]);
  });

  it('SETTLES: a failed parents read is source_plants: null and the page still loads', async () => {
    stubState.sqlHandler = world({ parents: fail('column p.cultivar_id does not exist', '42703') });
    const { status, body } = parse(await handler(get(`/api/inventory-items/${LOT}`)));
    expect(status).toBe(200);
    expect(body.source_plants).toBeNull();
    // Everything else on the page is intact — including the reads issued beside it.
    expect(body.name).toBe('Mixed nasturtium');
    expect(body.sown_from).toEqual([]);
    expect(body.germination).not.toBeNull();
    const lines = errorLog.mock.calls.map((c) => { try { return JSON.parse(c[0]); } catch { return null; } }).filter(Boolean);
    expect(lines).toEqual([{
      tag: 'inv-source-plants-failed', item: LOT, error: 'Error', code: '42703',
      message: 'column p.cultivar_id does not exist',
    }]);
  });

  it('a failed germination read still fails the request — only the parents (and sown_from) settle', async () => {
    stubState.sqlHandler = world({ germination: fail('boom') });
    expect(parse(await handler(get(`/api/inventory-items/${LOT}`))).status).toBe(500);
  });
});

describe('wide PUT /api/inventory-items/:id — returns source_plants, and cannot write them', () => {
  const edit = (extra = {}) => ({
    name: 'Mixed nasturtium', type: 'consumable', category: 'seeds', unit: 'packet', quantity_on_hand: 2, ...extra,
  });

  it('its 200 carries the set, read from the table', async () => {
    const { status, body } = parse(await handler(put(LOT, edit())));
    expect(status).toBe(200);
    expect(kinds()).toEqual(['update', 'parents']);
    expect(body.source_plants).toEqual(JAR);
    expect(body.name).toBe('Mixed nasturtium');
    expect(find('parents').values).toEqual([[USER], LOT, LOT]);
  });

  it('IGNORES source_plants and source_plant_ids in the body — nothing about them reaches a statement', async () => {
    // What a client that round-trips a list row sends back (source_plants), and what a confused or
    // hostile one might (source_plant_ids, well-formed or not, naming someone else's planting).
    const bodies = [
      edit({ source_plants: [parent(FOREIGN, 'Not mine')], source_plant_ids: [FOREIGN] }),
      edit({ source_plants: null, source_plant_ids: [] }),
      edit({ source_plants: 'garbage', source_plant_ids: 'not-an-array' }),
      edit({ source_plant_ids: Array.from({ length: 40 }, (_, i) => uuid(i + 200)) }),
    ];
    for (const body of bodies) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = world();
      const res = parse(await handler(put(LOT, body)));
      // Not a 400: ignored means ignored, exactly as an unknown key is.
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(200);
      // The write, and the read-only echo. No ownership query, no set-replace, no link INSERT.
      expect(kinds()).toEqual(['update', 'parents']);
      for (const c of stubState.sqlCalls) {
        expect(c.text).not.toMatch(/INSERT INTO public\.seed_lot_parent_planting|UPDATE public\.seed_lot_parent_planting/);
        expect(c.text).not.toMatch(/SET source_plant_id|FOR UPDATE|garden_node p\s+WHERE p\.id/);
        // No id the body named is bound anywhere — not even to a read.
        expect(JSON.stringify(c.values)).not.toContain(FOREIGN);
        expect(JSON.stringify(c.values)).not.toContain(uuid(200));
      }
      // The answer is what the TABLE holds, not what the body claimed.
      expect(res.body.source_plants).toEqual(JAR);
    }
  });

  it('names neither key anywhere in its UPDATE, and validateUpdate does not look at them', () => {
    const decomment = (s) => s.split('\n')
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
      .join('\n');
    const src = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
    const start = src.indexOf('UPDATE inventory_items SET');
    const statement = src.slice(start, src.indexOf('RETURNING *', start));
    expect(statement.length).toBeGreaterThan(500);
    expect(statement).not.toMatch(/source_plant/);
    // Ignored, so never an error either — not even on a category that could not hold a parent.
    expect(validateUpdate({ category: 'tools', source_plant_ids: [A], source_plants: [parent(A, 'x')] })).toBeNull();
    expect(validateUpdate({ category: 'seeds', source_plant_ids: 'nonsense', source_plants: 7 })).toBeNull();
  });

  it('SETTLES: a failed parents read costs the echo, never the save', async () => {
    stubState.sqlHandler = world({ parents: fail('boom', 'XX000') });
    const { status, body } = parse(await handler(put(LOT, edit())));
    expect(status).toBe(200);
    expect(body.name).toBe('Mixed nasturtium');
    expect(body.source_plants).toBeNull();
    expect(errorLog.mock.calls.some((c) => String(c[0]).includes('inv-source-plants-failed'))).toBe(true);
  });

  it('a non-seeds row asks nothing and answers []', async () => {
    stubState.sqlHandler = world({ update: [{ id: SHOVEL, name: 'Broadfork', category: 'tools' }] });
    const { status, body } = parse(await handler(put(SHOVEL, { name: 'Broadfork', type: 'durable', category: 'tools', quantity: 1 })));
    expect(status).toBe(200);
    expect(kinds()).toEqual(['update']);
    expect(body.source_plants).toEqual([]);
  });

  it('still 404s a row that is not there', async () => {
    stubState.sqlHandler = world({ update: [] });
    expect(parse(await handler(put(LOT, edit()))).status).toBe(404);
  });

  it('still fails when the UPDATE fails — the echo beside it changes nothing about that', async () => {
    stubState.sqlHandler = world({ update: fail('boom') });
    expect(parse(await handler(put(LOT, edit()))).status).toBe(500);
  });

  it('issues the echo BESIDE the write: the save is still one round trip long', async () => {
    // put-source-refs.test.js keeps this verb to a single round trip; a second AWAIT here would
    // double the latency of every +/- tap on a seed row. The UPDATE is held open until the parents
    // read has been issued — a handler that awaited the UPDATE first would never issue it.
    let release;
    const held = new Promise((r) => { release = r; });
    stubState.sqlHandler = world({
      update: () => held,
      parents: () => { release([{ id: LOT, name: 'Mixed nasturtium', category: 'seeds' }]); return [{ inventory_item_id: LOT, source_plants: JAR }]; },
    });
    const res = await settledOrStuck(handler(put(LOT, edit())));
    expect(res, 'the UPDATE was awaited before the parents read was issued').not.toBe('STUCK');
    expect(parse(res).status).toBe(200);
    // The write is still the first statement built.
    expect(kinds()).toEqual(['update', 'parents']);
  });
});
