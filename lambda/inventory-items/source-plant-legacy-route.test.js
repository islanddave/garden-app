// V5-SEEDMULTIPARENT-001 — the LEGACY route, PATCH /api/inventory-items/:id/source-plant, after the
// table. Body unchanged: { source_plant_id: uuid | null }.
//
// WHAT CHANGED, AND WHY IT IS THE RISKIEST ROUTE IN THE RELEASE. Every client in the field calls
// this one. It used to assign inventory_items.source_plant_id and nothing else. A lot's parents are
// now link rows with that column as their member cache, so:
//   • on a lot with NO parent or ONE, it must write BOTH (a column set with no row, or a row left
//     live beside a cleared column, is the drift the cache rule forbids) — the set route's write
//     with one id or none;
//   • on a lot with TWO OR MORE, it must write NOTHING and say so. Its caller cannot see the set —
//     a stale bundle, a second household device that has not reloaded — so "replace the set" would
//     erase recorded parents on a 200, and so would "clear". 409 `multi_parent_lot`, for an id and
//     for null alike.
//
// THROUGH THE HANDLER, for the same reason as source-plants-route.test.js, and with the same limit:
// the stub executes no SQL. The refusal on a multi-parent lot is a predicate INSIDE the three write
// statements; what is observable here is that the predicate is bound ON for this route (and OFF for
// the set route), and what the handler answers when the statements report they wrote nothing.
// "Both representations are unchanged after the 409" needs a real database; the lane report says so.
//
// The single-id ownership gate is executed against the real source in sow-routes.test.js and is not
// repeated here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler, SEED_CONSTRAINT_MESSAGES } = await import('./index.js');

const USER = 'user_stub_owner';
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const uuid = (n) => `3f9c1e64-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);
const C = uuid(3);

const patch = (body, id = LOT) => ({
  requestContext: { http: { method: 'PATCH' } },
  rawPath: `/api/inventory-items/${id}/source-plant`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const IS = {
  probe: (t) => /FROM public\.garden_node p\s+WHERE p\.id = \?/.test(t),
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
const WRITES = ['retire', 'add', 'cache'];

const boundAfter = (c, re) => {
  const m = c.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(c.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return c.values[(c.text.slice(0, end).match(/\?/g) ?? []).length];
};

const parent = (id, name) => ({
  id, name, variety_id: uuid(90), variety_name: name, breeding_system: null, archived: false, deleted: false,
});

// A seeds lot with ONE parent (A), every planting owned, unless `over` replaces a statement's rows.
const world = (over = {}) => (text, values) => {
  const k = kindOf(text);
  if (k in over) return over[k];
  return {
    probe: () => [{ id: values[0] }],
    lock: () => [{ id: LOT }],
    facts: () => [{ id: LOT, source_kind: null, live_parents: 1 }],
    retire: () => [],
    add: () => [],
    cache: () => [{ id: LOT, source_plant_id: B }],
    read: () => [{ inventory_item_id: LOT, source_plants: [parent(B, 'Jewel Mix')] }],
    other: () => [],
  }[k]();
};

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = world();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('legacy PATCH /:id/source-plant — a lot with no parent or one: column AND row, together', () => {
  it('setting a parent is the set-replace write with a set of exactly that one id', async () => {
    const res = parse(await handler(patch({ source_plant_id: B })));
    expect(res.status).toBe(200);
    // The single-id gate first (unchanged), then the same six statements the set route issues.
    expect(kinds()).toEqual(['probe', 'lock', 'facts', 'retire', 'add', 'cache', 'read']);
    // The row: the lot's other live parents are retired and this one is added…
    expect(boundAfter(find('retire'), /NOT \(l\.plant_id = ANY\(/)).toEqual([B]);
    expect(boundAfter(find('add'), /CROSS JOIN unnest\(/)).toEqual([B]);
    expect(boundAfter(find('add'), /'seed_parent', /)).toBe(USER);
    // …and the column: recomputed from the rows by the cache statement, never assigned from the body.
    expect(find('cache').text).toMatch(/SET source_plant_id = CASE\s+WHEN EXISTS/);
    expect(find('cache').values).not.toContain(B);
    // No statement writes the column on its own any more.
    expect(stubState.sqlCalls.filter((c) => /SET source_plant_id = \?/.test(c.text))).toHaveLength(0);
  });

  it('answers a SUPERSET of what it returned before — id and source_plant_id are still there', async () => {
    const res = parse(await handler(patch({ source_plant_id: B })));
    // Old clients read exactly these two; source_plants is the addition.
    expect(res.body).toEqual({ id: LOT, source_plant_id: B, source_plants: [parent(B, 'Jewel Mix')] });
  });

  it('clearing (null) is the same write with an EMPTY set, and asks about no planting', async () => {
    stubState.sqlHandler = world({ cache: [{ id: LOT, source_plant_id: null }], read: [] });
    const res = parse(await handler(patch({ source_plant_id: null })));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: LOT, source_plant_id: null, source_plants: [] });
    expect(kinds()).toEqual(['lock', 'facts', 'retire', 'add', 'cache', 'read']);
    // Empty set: every live row is "not in it", so the one parent the lot had is retired with the column.
    expect(boundAfter(find('retire'), /NOT \(l\.plant_id = ANY\(/)).toEqual([]);
    expect(boundAfter(find('add'), /CROSS JOIN unnest\(/)).toEqual([]);
  });

  it('lower-cases the id into the set, so one planting cannot be linked twice under two spellings', async () => {
    await handler(patch({ source_plant_id: B.toUpperCase() }));
    // The gate is asked with what the client sent; the set is the canonical form.
    expect(find('probe').values[0]).toBe(B.toUpperCase());
    expect(boundAfter(find('add'), /CROSS JOIN unnest\(/)).toEqual([B]);
  });

  it('binds the multi-parent guard ON in all three write statements', async () => {
    // THE DIFFERENCE between this route and the set route, and the whole of the 409's enforcement:
    // each write statement only runs while the lot has at most one live parent. If any one of the
    // three carried it OFF, that statement would run on a multi-parent lot while the others refused.
    await handler(patch({ source_plant_id: B }));
    for (const k of WRITES) {
      expect(find(k).text.replace(/\s+/g, ' '), k).toContain(
        "AND (NOT ?::boolean OR ( SELECT count(*) FROM public.seed_lot_parent_planting n WHERE n.inventory_item_id = i.id AND n.role = 'seed_parent' AND n.deleted_at IS NULL) <= 1)");
      expect(boundAfter(find(k), /AND \(NOT /), k).toBe(true);
    }
    // …and for a clear as well: null is refused on a multi-parent lot exactly as an id is.
    resetStubs();
    stubState.verifyTokenResult = { sub: USER };
    stubState.sqlHandler = world();
    await handler(patch({ source_plant_id: null }));
    for (const k of WRITES) expect(boundAfter(find(k), /AND \(NOT /), `${k} on a clear`).toBe(true);
  });

  it('the count is tested INSIDE the transaction, not by a read made before it', async () => {
    // Nothing between the gate and the batch: no SELECT of the lot or its links precedes the lock.
    // A count read up front could be invalidated by a concurrent PUT /source-plants before the write.
    await handler(patch({ source_plant_id: B }));
    const before = stubState.sqlCalls.slice(0, kinds().indexOf('lock'));
    expect(before.map((c) => kindOf(c.text))).toEqual(['probe']);
    expect(before.filter((c) => /seed_lot_parent_planting|inventory_items/.test(c.text))).toHaveLength(0);
  });
});

describe('legacy PATCH /:id/source-plant — a lot with two or more parents: 409, for an id AND for null', () => {
  const JAR = [parent(A, 'Alaska Mix'), parent(B, 'Jewel Mix')];
  // What the statements report on such a lot: two live parents, and the guarded writes changed
  // nothing (the cache statement's RETURNING is empty). The read-back shows the set as it stands.
  const pooled = () => world({
    facts: [{ id: LOT, source_kind: null, live_parents: 2 }],
    cache: [],
    read: [{ inventory_item_id: LOT, source_plants: JAR }],
  });

  for (const [what, body] of [['an id', { source_plant_id: C }], ['null', { source_plant_id: null }]]) {
    it(`refuses ${what} with the contract's body, and reports no write`, async () => {
      stubState.sqlHandler = pooled();
      const res = parse(await handler(patch(body)));
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'This seed came from more than one plant. Reload the app to change which.',
        code: 'multi_parent_lot',
        source_plant_ids: [A, B],
      });
      // Not a success shape in any part: an old client that only checks for these keys must not
      // read the refusal as the new state.
      expect(res.body.id).toBeUndefined();
      expect(res.body.source_plant_id).toBeUndefined();
    });
  }

  it('says it in a sentence the old client can show as is — no field names, no codes in the text', async () => {
    stubState.sqlHandler = pooled();
    const { body } = parse(await handler(patch({ source_plant_id: C })));
    expect(body.error).not.toMatch(/source_plant|_id\b|409|constraint/i);
    expect(body.error).toMatch(/Reload/);
  });

  it('a lot with exactly ONE parent is not refused', async () => {
    stubState.sqlHandler = world({ facts: [{ id: LOT, source_kind: null, live_parents: 1 }] });
    expect(parse(await handler(patch({ source_plant_id: B }))).status).toBe(200);
  });
});

describe('legacy PATCH /:id/source-plant — everything else it answered before, it still answers', () => {
  it('400s a body that never mentions the key, before any SQL', async () => {
    const res = parse(await handler(patch({})));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('source_plant_id is required (send null to clear)');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('400s a planting the household cannot use, with its ORIGINAL wording, and writes nothing', async () => {
    stubState.sqlHandler = world({ probe: [] });
    const res = parse(await handler(patch({ source_plant_id: C })));
    expect(res.status).toBe(400);
    // Singular, unchanged — old clients render this string.
    expect(res.body.error).toBe('source_plant_id does not match a planting you can use');
    expect(kinds()).toEqual(['probe']);
  });

  it('404s a lot that is absent, foreign, deleted or not seeds', async () => {
    stubState.sqlHandler = world({ lock: [], facts: [], cache: [], read: [] });
    const res = parse(await handler(patch({ source_plant_id: B })));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('404s a malformed lot id instead of sending it to Postgres', async () => {
    const res = parse(await handler(patch({ source_plant_id: null }, 'not-a-uuid')));
    expect(res.status).toBe(404);
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('400s a set on a lot that says it came from a shop — in the SAME words the CHECK gave it', async () => {
    // Before, this request reached chk_inventory_seed_source_plant and the catch block answered
    // with that constraint's sentence. The refusal is now the write's own guard (nothing reaches
    // the CHECK), so the handler must say the same thing itself or an old client's message changes.
    stubState.sqlHandler = world({ facts: [{ id: LOT, source_kind: 'store', live_parents: 0 }], cache: [], read: [] });
    const res = parse(await handler(patch({ source_plant_id: B })));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(SEED_CONSTRAINT_MESSAGES.chk_inventory_seed_source_plant);
    expect(res.body.error).not.toMatch(/source_kind|source_plant/);
  });

  it('is still PATCH-only', async () => {
    const res = await handler({ ...patch({ source_plant_id: B }), requestContext: { http: { method: 'PUT' } } });
    expect(res.statusCode).toBe(405);
    expect(stubState.sqlCalls).toHaveLength(0);
  });
});
