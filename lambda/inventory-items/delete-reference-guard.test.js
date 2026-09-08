// BUG-INVREFSTRAND-001 — the pre-delete reference check, driven through the REAL handler.
//
// WHY THIS FILE IS NOT A SOURCE SCAN. Most guards in this directory are static-source (L-072)
// because the thing being pinned is the shape of one SQL statement. What is being pinned here is a
// CONTROL-FLOW DECISION — whether the UPDATE runs at all — and reading `if (blocking.length)` off
// the source proves only that the characters are present. vitest.config.ts aliases the Lambda's
// AWS/Clerk/Neon deps to lambda/_test-stubs/, so the handler can be imported and executed; every
// assertion below is an observed response and an observed SQL call log.
//
// THE POSITIVE CONTROL IS THE POINT OF THE FILE. "delete is refused" goes vacuous the instant
// something unrelated starts refusing deletes for its own reasons — a 404, an auth change, a thrown
// preflight. `deletes an item with NO references` is the control that keeps the four refusal tests
// meaningful: it asserts the UPDATE genuinely reached SQL and the route answered 200. Neutralise the
// guard into an unconditional refusal and that test reds, which is exactly what it is for.
import { describe, it, expect, beforeEach } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const ITEM = '5ea890a3-b0f0-44ae-ae36-cd1cbfb15ded';

const del = (qs) => ({
  requestContext: { http: { method: 'DELETE' } },
  rawPath: `/api/inventory-items/${ITEM}`,
  headers: { authorization: 'Bearer stub-token' },
  queryStringParameters: qs,
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const isPreflight = (c) => /SELECT\s*\(SELECT count\(\*\) FROM inventory_items/.test(c.text);
const isSoftDelete = (c) => /UPDATE inventory_items\s*SET deleted_at = NOW\(\)/.test(c.text);

// The preflight's four counts, defaulting to a clean item. `owned` is separate so the 404 arm can
// be driven without touching the reference numbers.
const preflight = (over = {}) => ({
  owned: 1, plants: 0, photos: 0, seed_lot_stage_log: 0, event_log: 0, ...over,
});

const routeSql = (counts) => (text) => {
  if (/SELECT\s*\(SELECT count\(\*\) FROM inventory_items/.test(text)) return [counts];
  if (/UPDATE inventory_items/.test(text)) return [{ id: ITEM }];
  return [];
};

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = routeSql(preflight());
});

describe('DELETE /inventory-items/:id — POSITIVE CONTROL', () => {
  it('deletes an item with NO references, and the soft-delete UPDATE really runs', async () => {
    const { status, body } = parse(await handler(del()));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    // Both halves asserted. A 200 alone would also be produced by a route that answered without
    // writing anything, which is the failure this control exists to distinguish from a real delete.
    expect(stubState.sqlCalls.filter(isPreflight)).toHaveLength(1);
    expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(1);
  });
});

describe('DELETE /inventory-items/:id — refuses over live references', () => {
  // One case per FK. They are not redundant: the preflight reads four independent counts and a
  // wiring mistake reaches exactly one of them, so a single combined case would pass while three
  // relations went unchecked.
  const cases = [
    ['plants',             'plants',             'source_inventory_item_id', /1 planting\b/],
    ['photos',             'photos',             'inventory_item_id',        /2 photos\b/],
    ['seed_lot_stage_log', 'seed_lot_stage_log', 'inventory_item_id',        /3 seed stage entries\b/],
    ['event_log',          'event_log',          'treatment_product_id',     /4 treatment events\b/],
  ];
  const counts = { plants: 1, photos: 2, seed_lot_stage_log: 3, event_log: 4 };

  for (const [key, table, column, msgRe] of cases) {
    it(`409s when ${table}.${column} still points at it, and does NOT write`, async () => {
      stubState.sqlHandler = routeSql(preflight({ [key]: counts[key] }));
      const { status, body } = parse(await handler(del()));
      expect(status).toBe(409);
      // THE LOAD-BEARING ASSERTION. A 409 that still ran the UPDATE would be strictly worse than no
      // guard: it strands the references AND tells the caller nothing happened.
      expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(0);
      expect(body.error).toMatch(msgRe);
      expect(body.blocking).toEqual([{ table, column, count: counts[key] }]);
    });
  }

  it('names every blocking relation when more than one holds the item', async () => {
    stubState.sqlHandler = routeSql(preflight({ plants: 2, seed_lot_stage_log: 1 }));
    const { status, body } = parse(await handler(del()));
    expect(status).toBe(409);
    expect(body.blocking.map((b) => b.table)).toEqual(['plants', 'seed_lot_stage_log']);
    expect(body.error).toMatch(/2 plantings and 1 seed stage entry/);
  });
});

describe('DELETE /inventory-items/:id — the preflight itself', () => {
  it('binds the item id and scopes ownership to the household, rather than interpolating', async () => {
    await handler(del());
    const call = stubState.sqlCalls.find(isPreflight);
    // Five bindings: the ownership pair, then one id per reference count.
    expect(call.values.filter((v) => v === ITEM)).toHaveLength(5);
    expect(call.values.some((v) => Array.isArray(v) && v.includes(USER))).toBe(true);
    expect(call.text).not.toContain(ITEM);
  });

  it('counts LIVE referrers only — a soft-deleted planting must not block forever', async () => {
    await handler(del());
    const t = stubState.sqlCalls.find(isPreflight).text;
    expect(t).toMatch(/FROM public\.plants\s*WHERE source_inventory_item_id = \?\s*AND deleted_at IS NULL/);
    expect(t).toMatch(/FROM public\.photos\s*WHERE inventory_item_id = \?\s*AND deleted_at IS NULL/);
    expect(t).toMatch(/FROM public\.event_log\s*WHERE treatment_product_id = \?\s*AND deleted_at IS NULL/);
    // seed_lot_stage_log has no deleted_at column — asserted as an absence so adding the predicate
    // there (which would 42703 in prod) fails here first.
    expect(t).toMatch(/FROM public\.seed_lot_stage_log\s*WHERE inventory_item_id = \?\)/);
  });

  it('answers 404 before 409, leaking no reference counts for an item the caller cannot see', async () => {
    stubState.sqlHandler = routeSql(preflight({ owned: 0, plants: 7 }));
    const { status, body } = parse(await handler(del()));
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Not found' });
    expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(0);
  });
});

describe('DELETE /inventory-items/:id — ?force=true', () => {
  it('proceeds over references, and leaves a log line so the strand is not silent', async () => {
    stubState.sqlHandler = routeSql(preflight({ seed_lot_stage_log: 2 }));
    const warned = [];
    const orig = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      const { status, body } = parse(await handler(del({ force: 'true' })));
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(1);
    } finally {
      console.warn = orig;
    }
    expect(warned.join('\n')).toMatch(/forced over live references/);
    expect(warned.join('\n')).toContain(ITEM);
  });

  it('is not satisfied by a truthy-looking value — only the exact string opens it', async () => {
    // `force=1`, `force=yes` and a bare `?force` all arrive as strings that a truthiness test would
    // accept. The override has to be typed out in full or the refusal stands.
    for (const v of ['1', 'yes', '', 'TRUE']) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = routeSql(preflight({ plants: 1 }));
      const { status } = parse(await handler(del({ force: v })));
      expect(status, `force=${v!== '' ? v : '(empty)'} must not override`).toBe(409);
    }
  });
});
