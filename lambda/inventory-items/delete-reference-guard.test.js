// BUG-INVREFSTRAND-001 (option C) — the pre-delete reference check, driven through the REAL handler.
//
// WHY THIS FILE IS NOT A SOURCE SCAN. What is pinned here is a CONTROL-FLOW DECISION — whether the
// soft-delete UPDATE runs at all — and reading `if (blocking.length)` off the source proves only that
// the characters are present. vitest.config.ts aliases the Lambda's AWS/Clerk/Neon deps to
// lambda/_test-stubs/, so the handler is imported and executed; every assertion below is an observed
// response and an observed SQL call log.
//
// THE FIXTURE ROWS CARRY WHAT THE ITEM REALLY HAS, not only what the preflight asks for. A CaptureFlow
// item arrives with `photos: 1`; a saved-seed lot with `seed_lot_stage_log: 3`. The handler reads only
// the counts of BLOCKING_RELATIONS, so putting photos or stage rows back into the blocking set makes it
// read those numbers — and the two POSITIVE CONTROLS below go red. That is the mutation this file exists
// to catch: it is exactly the Sept-8 guard that made every saved lot undeletable and failed Snap's Undo.
//
// No database runs here (lambda/_test-stubs mock SQL). What the SQL does on real rows is proven by
// tests/integration/inventory-delete-guard.int.test.js and by the read-only prod check in the lane
// report; this file proves what the handler DOES with the answer.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import { blockingMessage, BLOCKING_RELATIONS, FOLLOWING_RELATIONS, DEPLETED_STATUS_LABEL } from './delete-guard.js';
import { INVENTORY_STATUSES } from '../../src/lib/inventoryEnums.js';

const { handler } = await import('./index.js');
const __dirname = dirname(fileURLToPath(import.meta.url));

const USER = 'user_stub_owner';
const ITEM = '1e3630a0-e182-42a4-bff7-0be9038e8ce3';

const del = (qs) => ({
  requestContext: { http: { method: 'DELETE' } },
  rawPath: `/api/inventory-items/${ITEM}`,
  headers: { authorization: 'Bearer stub-token' },
  queryStringParameters: qs,
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const isPreflight = (c) => /FROM public\.inventory_items i\s+WHERE i\.id = \?/.test(c.text);
const isSoftDelete = (c) => /UPDATE inventory_items\s*SET deleted_at = NOW\(\)/.test(c.text);

// What the database knows about the item: every relation that can point at it, blocking or not. The
// preflight's answer is this row (Postgres returns the columns the SELECT names; the stub returns them
// all, so a handler that starts reading a follower's count finds a real number there).
const itemRow = (over = {}) => ({
  category: 'seeds', plants: 0, plants_archived: 0, event_log: 0, photos: 0, seed_lot_stage_log: 0,
  ...over,
});

const routeSql = (row) => (text) => {
  if (/FROM public\.inventory_items i\s+WHERE i\.id = \?/.test(text)) return row ? [row] : [];
  if (/UPDATE inventory_items/.test(text)) return [{ id: ITEM }];
  return [];
};

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = routeSql(itemRow());
});

describe('DELETE /inventory-items/:id — POSITIVE CONTROLS: what belongs to the item does not block', () => {
  it('Snap\'s inventory Undo: an item with its captured photo and nothing sown from it deletes (200), and the UPDATE really runs', async () => {
    // CaptureFlow attaches the photo BEFORE offering Undo, so photos=1 on every Undo. Snap no longer
    // offers the Seeds category, hence a non-seed item.
    stubState.sqlHandler = routeSql(itemRow({ category: 'fertilizer', photos: 1 }));
    const { status, body } = parse(await handler(del()));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    // Both halves: a 200 alone would also come from a route that answered without writing anything.
    expect(stubState.sqlCalls.filter(isPreflight)).toHaveLength(1);
    expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(1);
  });

  it('a saved-seed lot with its processing history deletes (200) — stage rows are born with every lot and nothing can remove them', async () => {
    stubState.sqlHandler = routeSql(itemRow({ seed_lot_stage_log: 3, photos: 1 }));
    const { status, body } = parse(await handler(del()));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(1);
  });

  it('a planting that was itself soft-deleted does not block: the preflight counts live plantings only', async () => {
    // A retracted planting is invisible to everyone; the SQL's deleted_at filter is what keeps it out of
    // `plants`, so the row here says 0 and the delete goes ahead.
    await handler(del());
    const t = stubState.sqlCalls.find(isPreflight).text;
    expect(t).toMatch(/FROM public\.plants p\s+WHERE p\.source_inventory_item_id = i\.id\s+AND p\.deleted_at IS NULL\)::int AS plants\b/);
    expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(1);
  });
});

describe('DELETE /inventory-items/:id — refuses over something grown or applied from it', () => {
  it('a packet with a live planting sown from it → 409 with the sentence, and does NOT write', async () => {
    stubState.sqlHandler = routeSql(itemRow({ plants: 1, photos: 1, seed_lot_stage_log: 2 }));
    const { status, body } = parse(await handler(del()));
    expect(status).toBe(409);
    // THE LOAD-BEARING ASSERTION: a 409 that still ran the UPDATE strands the planting AND says nothing
    // happened.
    expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(0);
    expect(body.error).toBe(
      'This packet can\'t be removed: 1 planting was sown from it. To mark it used up, set its Status to "depleted" instead.',
    );
    // Only the blocking relation is named — the photo and the stage rows the item also has are not.
    expect(body.blocking).toEqual([{ table: 'plants', column: 'source_inventory_item_id', count: 1 }]);
  });

  it('an ARCHIVED planting still blocks, and the sentence says it is archived', async () => {
    stubState.sqlHandler = routeSql(itemRow({ plants: 1, plants_archived: 1 }));
    const { status, body } = parse(await handler(del()));
    expect(status).toBe(409);
    expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(0);
    expect(body.error).toBe(
      'This packet can\'t be removed: 1 archived planting was sown from it. To mark it used up, set its Status to "depleted" instead.',
    );
  });

  it('the preflight counts archived plantings in the blocking total — no archived_at filter on it', async () => {
    await handler(del());
    const t = stubState.sqlCalls.find(isPreflight).text;
    // The blocking count's subquery ends right after its deleted_at filter: an archived_at test there
    // would quietly let an archived planting's packet be deleted, which is the one thing Dave decided.
    const count = t.match(/\(SELECT count\(\*\) FROM public\.plants p[\s\S]*?\)::int AS plants\b/)[0];
    expect(count).not.toMatch(/archived_at/);
    expect(t).toMatch(/AND p\.archived_at IS NOT NULL\)::int AS plants_archived\b/);
  });

  it('a live treatment event that applied it → 409 naming the treatments', async () => {
    stubState.sqlHandler = routeSql(itemRow({ category: 'pest_control', event_log: 2 }));
    const { status, body } = parse(await handler(del()));
    expect(status).toBe(409);
    expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(0);
    expect(body.error).toBe(
      'This item can\'t be removed: it was used in 2 logged treatments. To mark it used up, set its Status to "depleted" instead.',
    );
    expect(body.blocking).toEqual([{ table: 'event_log', column: 'treatment_product_id', count: 2 }]);
  });

  it('?force=true does NOT override: option C has no escape hatch', async () => {
    for (const v of ['true', '1', 'yes', '']) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = routeSql(itemRow({ plants: 1 }));
      const { status } = parse(await handler(del({ force: v })));
      expect(status, `force=${v || '(empty)'} must not override`).toBe(409);
      expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(0);
    }
  });
});

describe('DELETE /inventory-items/:id — the preflight itself', () => {
  it('answers 404 before 409, leaking no reference counts for an item the caller cannot see', async () => {
    stubState.sqlHandler = routeSql(null);
    const { status, body } = parse(await handler(del()));
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Not found' });
    expect(stubState.sqlCalls.filter(isSoftDelete)).toHaveLength(0);
  });

  it('binds the item id and scopes ownership to the household, rather than interpolating', async () => {
    await handler(del());
    const call = stubState.sqlCalls.find(isPreflight);
    expect(call.values.filter((v) => v === ITEM)).toHaveLength(1);
    expect(call.values.some((v) => Array.isArray(v) && v.includes(USER))).toBe(true);
    expect(call.text).not.toContain(ITEM);
    expect(call.text).toMatch(/AND i\.created_by = ANY\(\?\)\s+AND i\.deleted_at IS NULL/);
  });

  it('reads exactly the blocking relations — never the item\'s own photos or stage rows', async () => {
    await handler(del());
    const t = stubState.sqlCalls.find(isPreflight).text;
    for (const rel of BLOCKING_RELATIONS) {
      expect(t).toMatch(new RegExp(`FROM public\\.${rel.table} \\w+\\s+WHERE \\w+\\.${rel.column} = i\\.id\\s+AND \\w+\\.deleted_at IS NULL`));
    }
    for (const rel of FOLLOWING_RELATIONS) {
      expect(t, `${rel.table} is the item's own and must not be counted`).not.toMatch(new RegExp(`\\b${rel.table}\\b`));
    }
  });

  it('a delete that loses a race after a clean preflight still answers 404, not 200', async () => {
    stubState.sqlHandler = (text) => (/FROM public\.inventory_items i\s+WHERE i\.id = \?/.test(text) ? [itemRow()] : []);
    const { status } = parse(await handler(del()));
    expect(status).toBe(404);
  });
});

describe('blockingMessage — the sentence Dave reads', () => {
  const plants = (count, archived = 0) => ({ table: 'plants', count, archived });
  const treat = (count) => ({ table: 'event_log', count });
  const tail = ' To mark it used up, set its Status to "depleted" instead.';

  it.each([
    [[plants(1)], 'seeds', 'This packet can\'t be removed: 1 planting was sown from it.'],
    [[plants(2)], 'seeds', 'This packet can\'t be removed: 2 plantings were sown from it.'],
    [[plants(1, 1)], 'seeds', 'This packet can\'t be removed: 1 archived planting was sown from it.'],
    [[plants(3, 3)], 'seeds', 'This packet can\'t be removed: 3 archived plantings were sown from it.'],
    [[plants(2, 1)], 'seeds', 'This packet can\'t be removed: 2 plantings were sown from it (1 of them archived).'],
    [[treat(1)], 'fertilizer', 'This item can\'t be removed: it was used in 1 logged treatment.'],
    [[plants(1), treat(2)], 'seeds', 'This packet can\'t be removed: 1 planting was sown from it and it was used in 2 logged treatments.'],
  ])('%j (%s)', (blocking, category, head) => {
    expect(blockingMessage(blocking, category)).toBe(head + tail);
  });

  it('never tells him to detach anything, and carries no table or column names', () => {
    const all = [[plants(1)], [plants(2, 1)], [treat(3)], [plants(1), treat(1)]]
      .map((b) => blockingMessage(b, 'seeds')).join('\n');
    expect(all).not.toMatch(/detach|unlink|clear/i);
    expect(all).not.toMatch(/source_inventory_item_id|treatment_product_id|event_log|plants\b/);
  });

  it('names the label the Status control actually shows for `depleted`', () => {
    // InventoryDetail renders INVENTORY_STATUSES through EnumSelect, whose label for a string entry is
    // the string itself and for an object entry is its `label`. Change either and this reds, rather than
    // the refusal pointing Dave at a word the control no longer shows.
    const entry = INVENTORY_STATUSES.find((o) => (o && typeof o === 'object' ? (o.value ?? o.v) : o) === 'depleted');
    expect(entry, 'depleted is no longer a status value').toBeDefined();
    const shown = entry && typeof entry === 'object' ? (entry.label ?? String(entry.value ?? entry.v)) : String(entry);
    expect(DEPLETED_STATUS_LABEL).toBe(shown);
    expect(blockingMessage([plants(1)], 'seeds')).toContain(`"${shown}"`);
  });

  it('the Lambda still accepts the status it tells him to set', () => {
    // A sentence recommending a value the PUT would 400 on is a dead end of its own.
    const src = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
    const statuses = src.match(/const VALID_STATUSES = \[([^\]]*)\]/)[1];
    expect(statuses).toMatch(/'depleted'/);
  });
});
