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
//   • 201 = the row as before + source_plants;
//   • (Follow-up 1) that gate is not the last word: inside the transaction the plantings are
//     share-locked, the link INSERT re-tests ownership for the whole array, and a statement that
//     RAISES undoes the lot when the links did not go in. 409 for that, and for a deadlock victim.
// The legacy single key on its own is post-source-plant.test.js, which this release changed in one
// way only: that create now also writes its one link row.
//
// THROUGH THE HANDLER, like that file, because the assertion that matters is positional —
// `bindingFor` reads the INSERT's column list and its bound values as two halves of one contract.
//
// WHAT THE STUB CANNOT SHOW: that lot and links commit or roll back together. Its sql.transaction is
// Promise.all and it executes no SQL. The handler's source is pinned to pass all five statements to
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

// Release 2a adds three kinds: `pfacts` (the parent rules' read of each planting's variety, before
// the transaction, for a set of two or more), `mix` (is the body's variety the mix of the set's
// varieties — only when the set spans two) and `rules` (the judge inside the transaction: it sets
// the verdict the link INSERT reads, and on a one-parent create only opens it). `rules` is tested
// before `owns`, which its text also satisfies.
const IS = {
  rules: (t) => /AS rules_hold/.test(t),
  pfacts: (t) => /AS lot_found/.test(t),
  mix: (t) => /AND fv\.blend_key = \?\s*$/.test(t),
  owns: (t) => /FROM public\.garden_node p\s+WHERE p\.id = ANY\(\?::uuid\[\]\)\s+AND p\.created_by = ANY/.test(t),
  members: (t) => /SELECT k\.plant_id AS id/.test(t),
  probe: (t) => /FROM public\.garden_node p\s+WHERE p\.id = \?/.test(t),
  lot: (t) => /INSERT INTO inventory_items \(/.test(t),
  hold: (t) => /FOR SHARE/.test(t),
  link: (t) => /INSERT INTO public\.seed_lot_parent_planting/.test(t),
  assert: (t) => /AS every_parent_linked/.test(t),
  read: (t) => /jsonb_agg/.test(t),
};
const kindOf = (t) => Object.keys(IS).find((k) => IS[k](t)) ?? 'other';
const kinds = () => stubState.sqlCalls.map((c) => kindOf(c.text));
const find = (k) => stubState.sqlCalls.find((c) => kindOf(c.text) === k);

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
  id, name, variety_id: uuid(90), variety_name: name, breeding_system: 'open_pollinated',
  variety_rank: 'cultivar', crop_slug: 'nasturtium', archived: false, deleted: false,
});
const JAR = [parent(A, 'Alaska Mix'), parent(B, 'Jewel Mix')];

// Every planting owned; the lot INSERT echoes a row; the read-back returns JAR.
//
// `pfacts` ANSWERS the parent rules' read, on purpose (QA seat, Q1). Every planting asked about is
// a planting of ONE variety, so a two-parent create passes the rules for a stated reason. Left to
// the `other` arm the read would come back empty; the rules read an id with no row as "added, no
// variety", and every two-parent test below would stop at a 400. There is no lot yet on a create,
// so no planting is a member and no lot is found. `rules` is the judge inside the transaction.
// parent-rules-route.test.js is where those two answers are varied.
const world = (over = {}) => (text, values) => {
  const k = kindOf(text);
  if (k in over) return typeof over[k] === 'function' ? over[k](values) : over[k];
  return {
    owns: () => values[0].map((id) => ({ id })),
    members: () => [],
    pfacts: () => values[0].map((id) => ({
      id, cultivar_id: uuid(90), crop_slug: 'nasturtium', blend_key: null, member: false, lot_found: false, lot_variety_id: null,
    })),
    mix: () => [],
    probe: () => [{ id: values[0] }],
    lot: () => [{ id: values[0], name: 'Mixed nasturtium', category: 'seeds', source_plant_id: null }],
    hold: () => values[0].map((id) => ({ id })),
    rules: () => [{ rules_hold: true, go: 'go' }],
    link: () => [],
    assert: () => [{ every_parent_linked: 1 }],
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
    // One counted gate, then the transaction: lot, share lock on the plantings, links, the
    // all-linked assertion, read-back.
    // RESTATED for release 2a: a set of TWO is also put to the parent rules — read once before the
    // transaction (pfacts), and judged again inside it (rules), under the share lock and ahead of
    // the link INSERT, which writes only on that judge's verdict.
    expect(kinds()).toEqual(['owns', 'pfacts', 'lot', 'hold', 'rules', 'link', 'assert', 'read']);
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
    // (RESTATED for release 2a: two parents, so the rules' read and judge are in the list.)
    expect(kinds()).toEqual(['owns', 'pfacts', 'lot', 'hold', 'rules', 'link', 'assert', 'read']);
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
    // RESTATED for release 2a: ONE parent, so the rules read nothing before the transaction; the
    // judge inside it is the statement that opens the verdict the link INSERT reads.
    expect(kinds()).toEqual(['probe', 'lot', 'hold', 'rules', 'link', 'assert', 'read']);
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
    // The first arm only. A create has no second: a lot that does not exist yet has no members, so
    // there is nothing an unowned planting could already be a parent OF.
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

describe('POST with source_plant_ids — a planting that changed AFTER the gate (Follow-up 1)', () => {
  // The gate reads before the transaction. A planting soft-deleted, or merged into another, in the
  // instant between would otherwise be linked anyway — and for a merge that loses the lot from the
  // surviving planting's page. On a create there is no "write nothing and answer from the
  // read-back": the lot INSERT has already run. So the link INSERT inserts all of the array or none
  // of it, and a statement that RAISES when none went in rolls the lot back with it.
  const boundAll = (c, re) => {
    const out = [];
    for (const m of c.text.matchAll(re)) {
      const end = m.index + m[0].length;
      out.push(c.values[(c.text.slice(0, end).match(/\?/g) ?? []).length]);
    }
    return out;
  };

  it('share-locks the plantings, then re-tests ownership in the link INSERT itself', async () => {
    await handler(post(seedLot({ source_plant_ids: [B, A] })));
    expect(find('hold').text.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT p.id FROM public.garden_node p WHERE p.id = ANY(?::uuid[]) ORDER BY p.id FOR SHARE');
    expect(find('hold').values).toEqual([[B, A]]);
    const link = find('link');
    expect(link.text.replace(/\s+/g, ' ')).toContain(
      'AND (SELECT count(*) FROM unnest(?::uuid[]) AS q(plant_id) WHERE EXISTS ( SELECT 1 FROM public.garden_node p WHERE p.id = q.plant_id AND p.created_by = ANY(?) AND p.deleted_at IS NULL)');
    // The whole array on both sides of the count: one unusable planting inserts NO link.
    expect(boundAfter(link, /AND \(SELECT count\(\*\)\s+FROM unnest\(/)).toEqual([B, A]);
    expect(boundAfter(link, /\)\) = cardinality\(/)).toEqual([B, A]);
    expect(boundAfter(link, /p\.created_by = ANY\(/)).toEqual([USER]);
  });

  it('asserts every planting was linked, for THIS lot and THIS array, before the read-back', async () => {
    await handler(post(seedLot({ source_plant_ids: [A, B] })));
    const lotId = bindingFor(find('lot'), 'id');
    const a = find('assert');
    expect(a.text.replace(/\s+/g, ' ')).toContain('SELECT 1 / (CASE WHEN ( SELECT count(*) FROM public.seed_lot_parent_planting l');
    expect(a.values).toEqual([lotId, [USER], [A, B]]);
    // Nothing in the batch disagrees about which lot or which plantings.
    expect(boundAll(find('link'), /unnest\(|cardinality\(/g).every((v) => JSON.stringify(v) === JSON.stringify([A, B]))).toBe(true);
  });

  it('409s, with a plain sentence and no lot, when that assertion raises (22012)', async () => {
    // What Postgres does when the guarded INSERT wrote nothing: the divisor is 0.
    stubState.sqlHandler = world({
      assert: () => { throw Object.assign(new Error('division by zero'), { code: '22012' }); },
    });
    const res = parse(await handler(post(seedLot({ source_plant_ids: [A, B] }))));
    expect(res.status).toBe(409);
    // RESTATED for release 2a (R2-19): the sentence and status are release 1's to the byte — shipped
    // clients print the sentence — and a `code` stands beside it. Exactly these two keys.
    expect(res.body).toEqual({
      error: 'One of those plants changed just now. Reload and try again.', code: 'parents_changed',
    });
    // Not a created lot in any part — an old client must not prepend this to its list.
    expect(res.body.id).toBeUndefined();
    expect(res.body.source_plants).toBeUndefined();
    // The gate passed, so nobody is logged as having tried a foreign planting; the retry is logged.
    const lines = warn.mock.calls.map((c) => JSON.parse(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tag: 'inv-source-plants-retry', code: '22012', create: true });
  });

  it('…and the legacy single-key create is the same transaction, so it answers the same way', async () => {
    stubState.sqlHandler = world({
      assert: () => { throw Object.assign(new Error('division by zero'), { code: '22012' }); },
    });
    const res = parse(await handler(post(seedLot({ source_plant_id: A }))));
    expect(kinds()).toEqual(['probe', 'lot', 'hold', 'rules', 'link', 'assert', 'read']);
    expect(res.status).toBe(409);
    // RESTATED for release 2a (R2-19): same sentence, same status, and its code beside it.
    expect(res.body).toEqual({
      error: 'One of those plants changed just now. Reload and try again.', code: 'parents_changed',
    });
  });

  it('409s a deadlock victim (40P01) instead of a 500 — the create rolled back whole', async () => {
    for (const at of ['hold', 'rules', 'link']) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = world({
        [at]: () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); },
      });
      // eslint-disable-next-line no-await-in-loop
      const res = parse(await handler(post(seedLot({ source_plant_ids: [A, B] }))));
      expect(res.status, at).toBe(409);
      // RESTATED for release 2a (R2-19): the code beside the unchanged sentence.
      expect(res.body, at).toEqual({
        error: 'One of those plants changed just now. Reload and try again.', code: 'parents_changed',
      });
    }
  });

  it('maps ONLY those two codes: every other failure still reaches the handler-wide catch', async () => {
    // A division by zero is this transaction's own signal; a CHECK or a foreign key is not, and
    // turning those into "try again" would send the person round in a circle.
    const cases = [
      ['23503', 'seed_lot_parent_planting_plant_id_fkey', 400, 'Foreign key violation: seed_lot_parent_planting_plant_id_fkey'],
      ['23514', 'chk_inventory_metadata_size', 400, 'Constraint violation: chk_inventory_metadata_size'],
      ['42P01', undefined, 500, 'Internal server error'],
    ];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [code, constraint, status, error] of cases) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = world({ link: () => { throw Object.assign(new Error('boom'), { code, constraint }); } });
      // eslint-disable-next-line no-await-in-loop
      const res = parse(await handler(post(seedLot({ source_plant_ids: [A, B] }))));
      expect(res.status, code).toBe(status);
      expect(res.body.error, code).toBe(error);
    }
  });

  it('a create with NO parents takes none of this: one INSERT, no lock, no assertion', async () => {
    const res = parse(await handler(post(seedLot())));
    expect(res.status).toBe(201);
    expect(kinds()).toEqual(['lot']);
  });

  it('a ONE-parent create only OPENS the verdict: its judge names no table, and no column this release adds', async () => {
    // Release 2a. What every shipped client sends when it saves seed from a plant. The link INSERT
    // now writes only when a statement earlier in its transaction said go, so this create needs
    // such a statement — and it must not make the commonest saved-seed write depend on the new
    // blend_key column, or on anything else. The rules cannot apply to one planting.
    await handler(post(seedLot({ source_plant_id: A })));
    const judge = find('rules');
    expect(judge.text.replace(/\s+/g, ' ').trim()).toBe(
      "SELECT TRUE AS rules_hold, set_config('app.seed_lot_go', CASE WHEN ?::boolean OR current_setting('app.seed_lot_go', true) = 'go' THEN 'go' ELSE 'stop' END, true) AS go");
    // `alone`: nothing judged before it, so this is the statement allowed to say go.
    expect(judge.values).toEqual([true]);
    expect(judge.text).not.toMatch(/\bFROM\b|\bJOIN\b|blend_key/);
    // …and it is that verdict the link INSERT reads.
    expect(find('link').text).toContain("current_setting('app.seed_lot_go', true) = 'go'");
    // Nothing was read for the rules before the transaction either.
    expect(kinds()).not.toContain('pfacts');
    expect(kinds()).not.toContain('mix');
  });

  it('a TWO-parent create judges the rules against the lot row it just wrote', async () => {
    await handler(post(seedLot({ source_plant_ids: [A, B] })));
    const lotId = bindingFor(find('lot'), 'id');
    const judge = find('rules');
    // The full judge: the lot (created by statement 0 of this same transaction), these plantings.
    expect(boundAfter(judge, /WHERE i\.id = /)).toBe(lotId);
    expect(boundAfter(judge, /AND \(/)).toBe(true);                     // alone
    // No variety is bound: the judge reads the lot row's own variety_id, which is the body's.
    expect(boundAfter(judge, /fv\.id = COALESCE\(/)).toBeNull();
    expect(judge.text.replace(/\s+/g, ' ')).toContain('fv.id = COALESCE(?::uuid, i.variety_id)');
    // After the share lock, before the link INSERT.
    const order = kinds();
    expect(order.indexOf('hold')).toBeLessThan(order.indexOf('rules'));
    expect(order.indexOf('rules')).toBeLessThan(order.indexOf('link'));
  });

  it('409s when that judge said stop: the link INSERT wrote nothing, so the assertion took the lot back', async () => {
    // The stub cannot make the INSERT obey the verdict (it executes no SQL). What it can show is
    // the route's half: a judge that refused is followed by the assertion raising, and that is
    // answered exactly as a planting that stopped being usable is — one 409, one code.
    stubState.sqlHandler = world({
      rules: [{ rules_hold: false, go: 'stop' }],
      assert: () => { throw Object.assign(new Error('division by zero'), { code: '22012' }); },
    });
    const res = parse(await handler(post(seedLot({ source_plant_ids: [A, B] }))));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'One of those plants changed just now. Reload and try again.', code: 'parents_changed',
    });
    expect(res.body.id).toBeUndefined();
  });
});

describe('POST with source_plant_ids — one transaction (source shape; the stub has no transactions)', () => {
  const decomment = (s) => s.split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
    .join('\n');
  const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8')).replace(/\s+/g, ' ');
  const POST_ARM = SRC.slice(SRC.lastIndexOf("if (method === 'POST') {"));

  it('passes the lot INSERT, the share lock, the link INSERT, the assertion and the read-back to ONE sql.transaction([...])', () => {
    // In this order. The lock comes before the link INSERT because that statement's ownership test
    // must read plantings that can no longer change; the assertion comes after it because it is
    // what undoes the lot when the INSERT declined; the read-back is last and is what the 201 carries.
    // RESTATED for release 2a: SIX statements. judgeParentRules sits between the share lock (its
    // planting reads must not move) and the link INSERT (which reads the verdict it sets). `alone`:
    // nothing was judged before it in this transaction, so it is the statement that may say go.
    expect(POST_ARM).toMatch(
      /\[lotRows, , , , , parentRows\] = await sql\.transaction\(\[ insertLot, lockPlantings\(sql, parentIds\), judgeParentRules\(sql, \{ lotId, ids: parentIds, householdIds, alone: true \}\), insertSeedParentLinks\(sql, \{ lotId, ids: parentIds, householdIds, userId \}\), assertEveryParentLinked\(sql, \{ lotId, ids: parentIds, householdIds \}\), readSourcePlants\(sql, householdIds, lotId\), \]\);/);
    // Only the two codes that mean "rolled back whole, try again" are answered here; the rest rethrow.
    // (RESTATED: the 409 body is the sentence with its code — built in one place, parentsChangedBody.)
    expect(POST_ARM).toMatch(
      /catch \(err\) \{ if \(err\?\.code === '22012' \|\| err\?\.code === '40P01'\) \{ console\.warn\([^;]*\); return resp\(409, parentsChangedBody\(\)\); \} throw err; \}/);
    expect(SRC).toMatch(/const parentsChangedBody = \(\) => \(\{ error: PLANTS_CHANGED, code: 'parents_changed' \}\);/);
    expect(SRC).toMatch(/const PLANTS_CHANGED = 'One of those plants changed just now\. Reload and try again\.';/);
    // The lot statement is BUILT, not awaited, where it is written — an awaited statement has
    // already committed by the time the link INSERT runs.
    expect(POST_ARM).toMatch(/const insertLot = sql` INSERT INTO inventory_items \(/);
    expect(POST_ARM).not.toMatch(/await sql` INSERT INTO inventory_items/);
    // Exactly two ways it is ever run: alone when there are no parents, or as element 0 of the batch.
    expect(POST_ARM.match(/\binsertLot\b/g)).toHaveLength(3);
    expect(POST_ARM).toMatch(/if \(!parentIds\.length\) \{ const rows = await insertLot; return resp\(201, \{ \.\.\.rows\[0\], source_plants: \[\] \}\); \}/);
  });

  it('never names the plant count: PUT /:id/seed-measure is its only writer (release 2a)', () => {
    // A second writer here is the one that would drop the value on a Lambda that predates the
    // column and answer 201 (data-schema seat S8). Pinned the way put-year-harvested.test.js pins
    // lot_number out of the wide PUT. Comments are stripped, so the note beside the INSERT that
    // explains the omission does not satisfy or break this.
    expect(POST_ARM).not.toMatch(/seed_parent_plant_count/);
    // The 201 does carry the filed variety's rank, read in the INSERT's own RETURNING.
    expect(POST_ARM).toMatch(
      /\) RETURNING \*, \(SELECT pv\.variety_rank FROM public\.cultivar pv WHERE pv\.id = inventory_items\.variety_id\) AS variety_rank `;/);
  });

  it('mints the id in the handler and binds the cache, not the body key, to the column', () => {
    expect(POST_ARM).toMatch(/const lotId = randomUUID\(\);/);
    expect(SRC).toMatch(/import \{ randomUUID \} from 'node:crypto';/);
    expect(POST_ARM).toMatch(/const cachePlantId = sourcePlantId \?\? parentIds\[0\] \?\? null;/);
    expect(POST_ARM).toMatch(/\$\{body\.seed_stage \?\? null\}, \$\{cachePlantId\}, \$\{sourceKind\},/);
  });
});
