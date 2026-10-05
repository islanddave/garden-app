// V5-SEEDMULTIPARENT-001 — POST /api/inventory-items with `source_plant_ids`, the SET of parent
// plantings, driven through the handler.
//
// THE RULES (R1-CONTRACT section 4):
//   • optional; deduped; a non-array, a non-uuid element or more than twelve is a 400;
//   • PRESENT (even []) = it is the set. `source_plant_id` beside it may only choose the cache: it
//     must be a member (400 otherwise). Without it the cache is the first id named;
//   • a non-empty set needs category = 'seeds' and refuses a non-own_garden source_kind;
//   • ownership is ONE counted query — every id, or none of the write;
//   • the lot (id minted here), its link rows and the read-back are ONE transaction;
//   • 201 = the row as before + source_plants.
// The legacy single key on its own is post-source-plant.test.js, which this release changed in one
// way only: that create now also writes its one link row.
//
// THROUGH THE HANDLER, like that file, because the assertion that matters is positional —
// `bindingFor` reads the INSERT's column list and its bound values as two halves of one contract.
//
// WHAT THE STUB CANNOT SHOW: that lot and links commit or roll back together. Its sql.transaction is
// Promise.all and it executes no SQL. The handler's source is pinned to pass all three statements to
// ONE sql.transaction([...]) call (the last describe), and the lane report lists the real-database
// test: a two-parent create whose link INSERT fails must leave no lot behind.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { handler, validateCreate } = await import('./index.js');

const USER = 'user_stub_owner';
const VARIETY = 'd58b5155-0c23-4365-bfad-30549b8ca069';
const uuid = (n) => `3f9c1e64-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);
const C = uuid(3);

const post = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: '/api/inventory-items',
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const seedLot = (extra = {}) => ({
  name: 'Mixed nasturtium', type: 'consumable', category: 'seeds', unit: 'packet',
  quantity_on_hand: 1, variety_id: VARIETY, ...extra,
});

const IS = {
  owns: (t) => /FROM public\.garden_node p\s+WHERE p\.id = ANY/.test(t),
  probe: (t) => /FROM public\.garden_node p\s+WHERE p\.id = \?/.test(t),
  lot: (t) => /INSERT INTO inventory_items \(/.test(t),
  link: (t) => /INSERT INTO public\.seed_lot_parent_planting/.test(t),
  read: (t) => /jsonb_agg/.test(t),
};
const kindOf = (t) => Object.keys(IS).find((k) => IS[k](t)) ?? 'other';
const kinds = () => stubState.sqlCalls.map((c) => kindOf(c.text));
const find = (k) => stubState.sqlCalls.find((c) => IS[k](c.text));

// The value bound to a NAMED column of the lot INSERT, by position (post-source-plant.test.js).
const bindingFor = (c, column) => {
  const cols = c.text.slice(
    c.text.indexOf('INSERT INTO inventory_items (') + 'INSERT INTO inventory_items ('.length,
    c.text.indexOf(') VALUES ('),
  );
  expect(cols.length, 'column list must be found and non-trivial').toBeGreaterThan(100);
  const names = cols.split(',').map((s) => s.trim()).filter(Boolean);
  const idx = names.indexOf(column);
  expect(idx, `${column} must appear in the INSERT column list`).toBeGreaterThan(-1);
  const placeholders = (c.text.slice(c.text.indexOf(') VALUES (')).match(/\?/g) ?? []).length;
  expect(placeholders, 'one binding per column').toBe(names.length);
  return c.values[idx];
};
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

// Every planting owned; the lot INSERT echoes a row; the read-back returns JAR.
const world = (over = {}) => (text, values) => {
  const k = kindOf(text);
  if (k in over) return typeof over[k] === 'function' ? over[k](values) : over[k];
  return {
    owns: () => values[0].map((id) => ({ id })),
    probe: () => [{ id: values[0] }],
    lot: () => [{ id: values[0], name: 'Mixed nasturtium', category: 'seeds', source_plant_id: null }],
    link: () => [],
    read: () => [{ inventory_item_id: values[1], source_plants: JAR }],
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

describe('POST with source_plant_ids — a lot born with several parents', () => {
  it('writes the lot, one link row per planting, and reads the set back', async () => {
    const res = parse(await handler(post(seedLot({ source_plant_ids: [A, B] }))));
    expect(res.status).toBe(201);
    // One counted gate, then lot + links + read-back.
    expect(kinds()).toEqual(['owns', 'lot', 'link', 'read']);
    expect(find('owns').values).toEqual([[A, B], [USER]]);

    // The link INSERT: these plantings, as seed parents, added by the caller…
    const link = find('link');
    expect(boundAfter(link, /CROSS JOIN unnest\(/)).toEqual([A, B]);
    expect(link.text).toMatch(/SELECT i\.id, u\.plant_id, 'seed_parent', \?::text/);
    expect(boundAfter(link, /'seed_parent', /)).toBe(USER);
    // …onto THE lot this request created: the id is minted in the handler and bound to both.
    const lotId = bindingFor(find('lot'), 'id');
    expect(lotId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(boundAfter(link, /WHERE i\.id = /)).toBe(lotId);
    expect(find('read').values).toEqual([[USER], lotId, lotId]);
    // Not the legacy write: no multi-parent guard on a create.
    expect(boundAfter(link, /AND \(NOT /)).toBe(false);
  });

  it('answers the row as before PLUS source_plants, as the read-back returned it', async () => {
    const res = parse(await handler(post(seedLot({ source_plant_ids: [A, B] }))));
    expect(res.body.name).toBe('Mixed nasturtium');
    expect(res.body.category).toBe('seeds');
    expect(res.body.source_plants).toEqual(JAR);
  });

  it('mints a fresh lot id per request', async () => {
    await handler(post(seedLot({ source_plant_ids: [A] })));
    const first = bindingFor(find('lot'), 'id');
    resetStubs();
    stubState.verifyTokenResult = { sub: USER };
    stubState.sqlHandler = world();
    await handler(post(seedLot({ source_plant_ids: [A] })));
    expect(bindingFor(find('lot'), 'id')).not.toBe(first);
  });

  it('caches the FIRST id named when the body sends no source_plant_id', async () => {
    await handler(post(seedLot({ source_plant_ids: [B, A] })));
    expect(bindingFor(find('lot'), 'source_plant_id')).toBe(B);
  });

  it('caches source_plant_id when it is sent — and it must be a MEMBER of the set', async () => {
    await handler(post(seedLot({ source_plant_ids: [A, B], source_plant_id: B })));
    expect(bindingFor(find('lot'), 'source_plant_id')).toBe(B);
    // The set is still the array's: the single key adds nothing to it and removes nothing from it.
    expect(boundAfter(find('link'), /CROSS JOIN unnest\(/)).toEqual([A, B]);
    // Only the counted gate ran — the single-id probe is the legacy path's.
    expect(kinds()).toEqual(['owns', 'lot', 'link', 'read']);
  });

  it('400s a source_plant_id that is not in the set — including against an EMPTY set', async () => {
    for (const ids of [[A, B], []]) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = world();
      const res = parse(await handler(post(seedLot({ source_plant_ids: ids, source_plant_id: C }))));
      expect(res.status, JSON.stringify(ids)).toBe(400);
      expect(res.body.error).toBe('source_plant_id must be one of source_plant_ids');
      expect(stubState.sqlCalls, 'a contradictory body reached the database').toHaveLength(0);
    }
  });

  it('dedupes case-insensitively: one planting named twice is one link row', async () => {
    await handler(post(seedLot({ source_plant_ids: [A, A.toUpperCase(), B] })));
    expect(find('owns').values[0]).toEqual([A, B]);
    expect(boundAfter(find('link'), /CROSS JOIN unnest\(/)).toEqual([A, B]);
  });
});

describe('POST with source_plant_ids — the empty set, and absence', () => {
  it('[] is the empty set: one INSERT, a NULL cache, no link table, source_plants: []', async () => {
    const res = parse(await handler(post(seedLot({ source_plant_ids: [] }))));
    expect(res.status).toBe(201);
    expect(kinds()).toEqual(['lot']);
    expect(bindingFor(find('lot'), 'source_plant_id')).toBeNull();
    expect(res.body.source_plants).toEqual([]);
  });

  it('null is ABSENT on a create, exactly as it is for source_plant_id', async () => {
    const res = parse(await handler(post(seedLot({ source_plant_ids: null }))));
    expect(res.status).toBe(201);
    expect(kinds()).toEqual(['lot']);
  });

  it('…so null beside a source_plant_id leaves the legacy single-key path in charge', async () => {
    const res = parse(await handler(post(seedLot({ source_plant_ids: null, source_plant_id: A }))));
    expect(res.status).toBe(201);
    expect(kinds()).toEqual(['probe', 'lot', 'link', 'read']);
    expect(boundAfter(find('link'), /CROSS JOIN unnest\(/)).toEqual([A]);
  });

  it('[] is as legal on a shovel as leaving the key out', async () => {
    const res = parse(await handler(post({ name: 'Broadfork', type: 'durable', category: 'tools', quantity: 1, source_plant_ids: [] })));
    expect(res.status).toBe(201);
    expect(kinds()).toEqual(['lot']);
    expect(res.body.source_plants).toEqual([]);
  });
});

describe('POST with source_plant_ids — what is refused, and what it leaves unwritten', () => {
  it('400s a non-array, a non-uuid element and more than twelve, before any SQL', async () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => uuid(i + 1));
    const cases = [
      [A, 'source_plant_ids must be an array of planting ids'],
      [{ ids: [A] }, 'source_plant_ids must be an array of planting ids'],
      [[A, 'not-a-uuid'], 'source_plant_ids must contain only planting ids'],
      [[null], 'source_plant_ids must contain only planting ids'],
      [thirteen, 'source_plant_ids can name at most 12 plantings'],
    ];
    for (const [value, message] of cases) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      const res = parse(await handler(post(seedLot({ source_plant_ids: value }))));
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(res.body.error).toBe(message);
      expect(stubState.sqlCalls, 'malformed input reached the database').toHaveLength(0);
    }
  });

  it('400s a non-empty set on a non-seeds row, before any SQL', async () => {
    const tool = { name: 'Broadfork', type: 'durable', category: 'tools', quantity: 1, source_plant_ids: [A] };
    expect(validateCreate(tool)).toBe('source_plant_ids is only allowed when category is seeds');
    const res = parse(await handler(post(tool)));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('source_plant_ids is only allowed when category is seeds');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('400s one planting the household cannot use — the lot is never created', async () => {
    stubState.sqlHandler = world({ owns: [{ id: A }] });   // one of two
    const res = parse(await handler(post(seedLot({ source_plant_ids: [A, B] }))));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('source_plant_ids does not match plantings you can use');
    expect(kinds()).toEqual(['owns']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('authz-fk-reject');
  });

  it('400s a shop source_kind beside a set, in the same words the single key gets', async () => {
    const res = parse(await handler(post(seedLot({ source_plant_ids: [A], source_kind: 'gift' }))));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('source_kind must be own_garden when a source plant is set');
    expect(kinds().filter((k) => k === 'lot' || k === 'link')).toHaveLength(0);
  });

  it('…and accepts own_garden beside one, and any kind beside an EMPTY set', async () => {
    expect(parse(await handler(post(seedLot({ source_plant_ids: [A], source_kind: 'own_garden' })))).status).toBe(201);
    resetStubs();
    stubState.verifyTokenResult = { sub: USER };
    stubState.sqlHandler = world();
    expect(parse(await handler(post(seedLot({ source_plant_ids: [], source_kind: 'gift' })))).status).toBe(201);
  });

  it('a failure inside the write answers an error, never a 201', async () => {
    stubState.sqlHandler = world({
      link: () => { throw Object.assign(new Error('violates foreign key'), { code: '23503', constraint: 'seed_lot_parent_planting_plant_id_fkey' }); },
    });
    const res = parse(await handler(post(seedLot({ source_plant_ids: [A, B] }))));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Foreign key violation: seed_lot_parent_planting_plant_id_fkey');
    expect(res.body.id).toBeUndefined();
  });
});

describe('POST with source_plant_ids — one transaction (source shape; the stub has no transactions)', () => {
  const decomment = (s) => s.split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
    .join('\n');
  const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8')).replace(/\s+/g, ' ');
  const POST_ARM = SRC.slice(SRC.lastIndexOf("if (method === 'POST') {"));

  it('passes the lot INSERT, the link INSERT and the read-back to ONE sql.transaction([...])', () => {
    expect(POST_ARM).toMatch(
      /await sql\.transaction\(\[ insertLot, insertSeedParentLinks\(sql, \{ lotId, ids: parentIds, householdIds, userId \}\), readSourcePlants\(sql, householdIds, lotId\), \]\);/);
    // The lot statement is BUILT, not awaited, where it is written — an awaited statement has
    // already committed by the time the link INSERT runs.
    expect(POST_ARM).toMatch(/const insertLot = sql` INSERT INTO inventory_items \(/);
    expect(POST_ARM).not.toMatch(/await sql` INSERT INTO inventory_items/);
    // Exactly two ways it is ever run: alone when there are no parents, or as element 0 of the batch.
    expect(POST_ARM.match(/\binsertLot\b/g)).toHaveLength(3);
    expect(POST_ARM).toMatch(/if \(!parentIds\.length\) \{ const rows = await insertLot; return resp\(201, \{ \.\.\.rows\[0\], source_plants: \[\] \}\); \}/);
  });

  it('mints the id in the handler and binds the cache, not the body key, to the column', () => {
    expect(POST_ARM).toMatch(/const lotId = randomUUID\(\);/);
    expect(SRC).toMatch(/import \{ randomUUID \} from 'node:crypto';/);
    expect(POST_ARM).toMatch(/const cachePlantId = sourcePlantId \?\? parentIds\[0\] \?\? null;/);
    expect(POST_ARM).toMatch(/\$\{body\.seed_stage \?\? null\}, \$\{cachePlantId\}, \$\{sourceKind\},/);
  });
});
