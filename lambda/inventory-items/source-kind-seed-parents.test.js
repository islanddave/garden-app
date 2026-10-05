// V5-SEEDMULTIPARENT-001 — PATCH /api/inventory-items/:id/source-kind and a lot's parent plantings.
//
// THE RULE WAS ALREADY THERE: a lot cannot say it came from a shop, a gift or a farm stand AND from
// one of my plants. The route enforced it by reading inventory_items.source_plant_id and refusing a
// non-own_garden kind while that column was set.
//
// WHAT CHANGED. "From one of my plants" is now a set of link rows with that column as their member
// cache. While the cache rule holds the column alone still answers the question — which is exactly
// why reading only the column was a hole and not merely an omission: the one state in which the two
// disagree (live seed_parent rows, NULL column — what a write that reached only one of them leaves)
// is the state in which nothing else refuses. chk_inventory_seed_source_plant cannot see it; a CHECK
// reads one row of one table. So the route now tests BOTH representations.
//
// Through the handler; the stub executes no SQL, so that a lot WITH link rows is refused by a real
// database is on the lane report's integration list.
import { describe, it, expect, beforeEach } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler, SEED_CONSTRAINT_MESSAGES } = await import('./index.js');

const USER = 'user_stub_owner';
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const PLANT = '7c1f2b90-3a44-4d21-9f88-1b5e0c7a2d31';

const patch = (body) => ({
  requestContext: { http: { method: 'PATCH' } },
  rawPath: `/api/inventory-items/${LOT}/source-kind`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const isPreRead = (t) => /AS has_seed_parents/.test(t);
const isUpdate = (t) => /SET source_kind = \?/.test(t);
const preRead = () => stubState.sqlCalls.find((c) => isPreRead(c.text));
const updates = () => stubState.sqlCalls.filter((c) => isUpdate(c.text));

// The stored lot, as the pre-read reports it; the UPDATE echoes the kind it was given.
const lot = (stored) => (text, values) => {
  if (isPreRead(text)) return stored == null ? [] : [stored];
  if (isUpdate(text)) return [{ id: LOT, source_kind: values[0] }];
  return [];
};

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
});

const REFUSAL = 'source_kind must be own_garden while a source plant is set (clear the source plant first)';

describe('PATCH /:id/source-kind — a non-garden kind is refused while the lot has ANY parent', () => {
  it('refuses when the lot has live seed_parent link rows, even with a NULL column', async () => {
    // THE NEW ARM. Before this the route read the column only, saw NULL, and wrote "gift" onto a
    // lot that records two garden parents.
    stubState.sqlHandler = lot({ source_plant_id: null, has_seed_parents: true });
    const res = parse(await handler(patch({ source_kind: 'gift' })));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(REFUSAL);
    expect(updates(), 'the kind was written anyway').toHaveLength(0);
  });

  it('still refuses on the column alone', async () => {
    stubState.sqlHandler = lot({ source_plant_id: PLANT, has_seed_parents: false });
    const res = parse(await handler(patch({ source_kind: 'store' })));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(REFUSAL);
    expect(updates()).toHaveLength(0);
  });

  it('refuses for every non-garden kind', async () => {
    for (const kind of ['u_pick', 'farm_stand', 'csa', 'store', 'gift', 'foraged', 'other']) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = lot({ source_plant_id: null, has_seed_parents: true });
      expect(parse(await handler(patch({ source_kind: kind }))).status, kind).toBe(400);
      expect(updates(), kind).toHaveLength(0);
    }
  });

  it('writes the kind when the lot has neither a column nor a link row', async () => {
    stubState.sqlHandler = lot({ source_plant_id: null, has_seed_parents: false });
    const res = parse(await handler(patch({ source_kind: 'gift' })));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: LOT, source_kind: 'gift' });
    expect(updates()).toHaveLength(1);
  });

  it('only a strict TRUE from the database refuses — a missing flag is not a parent', async () => {
    // The driver parses a Postgres boolean to a JS boolean. Anything else (a row shape from before
    // the flag existed) must not be read as "has parents" and lock every lot out of this route.
    stubState.sqlHandler = lot({ source_plant_id: null });
    expect(parse(await handler(patch({ source_kind: 'gift' }))).status).toBe(200);
  });
});

describe('PATCH /:id/source-kind — the test it makes', () => {
  it('asks about live seed_parent rows through the lot the household owns', async () => {
    stubState.sqlHandler = lot({ source_plant_id: null, has_seed_parents: false });
    await handler(patch({ source_kind: 'gift' }));
    const t = preRead().text.replace(/\s+/g, ' ');
    expect(t).toContain("EXISTS (SELECT 1 FROM public.seed_lot_parent_planting l WHERE l.inventory_item_id = i.id AND l.role = 'seed_parent' AND l.deleted_at IS NULL) AS has_seed_parents");
    expect(t).toContain('FROM public.inventory_items i WHERE i.id = ? AND i.created_by = ANY(?) AND i.deleted_at IS NULL');
    expect(preRead().values).toEqual([LOT, [USER]]);
    // Still selects the column: both representations, one statement.
    expect(t).toMatch(/SELECT i\.source_plant_id,/);
  });

  it('own_garden and null need no test at all — one statement, as before', async () => {
    for (const kind of ['own_garden', null]) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = lot({ source_plant_id: PLANT, has_seed_parents: true });
      const res = parse(await handler(patch({ source_kind: kind })));
      expect(res.status, String(kind)).toBe(200);
      expect(stubState.sqlCalls, String(kind)).toHaveLength(1);
      expect(preRead()).toBeUndefined();
    }
  });

  it('an absent lot is not answered here: it falls through to the UPDATE, which 404s', async () => {
    // No existence oracle: a foreign lot with parents and a foreign lot without answer alike.
    stubState.sqlHandler = (text) => (isPreRead(text) ? [] : []);
    const res = parse(await handler(patch({ source_kind: 'gift' })));
    expect(res.status).toBe(404);
    expect(updates()).toHaveLength(1);
  });

  it('a parents write that lands between the test and the UPDATE is caught by the CHECK, in a sentence', async () => {
    // The pre-read is a read before a write. What closes the window is the member cache: the
    // concurrent parents write left source_plant_id non-NULL, so this UPDATE violates
    // chk_inventory_seed_source_plant — and the catch block answers that by name.
    stubState.sqlHandler = (text) => {
      if (isPreRead(text)) return [{ source_plant_id: null, has_seed_parents: false }];
      throw Object.assign(new Error('violates check constraint'), { code: '23514', constraint: 'chk_inventory_seed_source_plant' });
    };
    const res = parse(await handler(patch({ source_kind: 'gift' })));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(SEED_CONSTRAINT_MESSAGES.chk_inventory_seed_source_plant);
  });
});
