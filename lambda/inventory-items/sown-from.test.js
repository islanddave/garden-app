// V5-SEEDSTAB-001 slice 3 (design section 9) — sown_from on the seed detail GET.
//
// GET /api/inventory-items/:id, on a seeds row, now carries `sown_from`: every planting sown from the
// packet (plants.source_inventory_item_id = the item), as the four fields a link needs. Three claims,
// each held by its own block below:
//
//   1. THE WIRE. The handler runs (the _test-stubs harness, as post-source-plant.test.js does): a seed
//      row answers sown_from = the planting rows, in the order the SQL returned them; a non-seed row
//      answers sown_from = null and issues no garden_node read at all; and germination is BYTE-IDENTICAL
//      to what it was before this change for the same rows — its query text included.
//   2. THE PREDICATE IS THE PLANTS LAMBDA'S, NOT A NEW ONE. The Archive-Hiding Rule (claude-ops
//      project-rules gardening.md) says archived rows are filtered in SQL at the route, and the brief
//      says reuse the exact predicate the plants default views use. So this file reads
//      lambda/plants/index.js, lifts the WHERE its ?view=grid and ?view=picker branches share (the
//      household ownership arms, the container-deleted gate, deleted_at, and both archive clauses —
//      BUG-PLANTSLISTARCHIVEDCONTAINER-001's container half included) and requires sown_from to carry
//      it verbatim, alias for alias. A clause added there and not here reds this file.
//   3. THE BINDINGS. The item id binds the source_inventory_item_id test and the household ids bind
//      BOTH ownership arms — a scoped-looking query bound to the wrong value is still a leak.
//
// WHAT THIS FILE CANNOT PROVE: that Postgres accepts the statement. The stub never parses SQL
// (memory: the Lambda unit suite proves no DB behaviour), and BUG-SEEDDETAIL500-001 was exactly a
// green-suite 500. That proof is the real-Postgres run in the lane report and the integration test in
// tests/integration/inventory-items.int.test.js; the column contract is garden-node-columns.test.js.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));

const USER = 'user_stub_owner';
const PARTNER = 'user_stub_partner';
const ITEM = '6a0f4c2e-3b1d-4e5f-8a9b-0c1d2e3f4a5b';

const get = (id = ITEM) => ({
  requestContext: { http: { method: 'GET' } },
  rawPath: `/api/inventory-items/${id}`,
  headers: { authorization: 'Bearer stub-token' },
});
const parse = (res) => ({ status: res.statusCode, text: res.body, body: JSON.parse(res.body || '{}') });

// What the stub hands back, keyed off the SQL text — one stub serves every statement.
const SEED_ROW = {
  id: ITEM, name: 'Gong Bao (Kung Pao) seeds', category: 'seeds', type: 'consumable',
  featured_photo_id: null, effective_featured_photo_id: null, featured_is_explicit: false,
  featured_photo_storage_path: null, variety_name: 'Gong Bao (Kung Pao)', breeding_system: 'f1',
};
const GERM_ROWS = [
  { id: 'pl-2', name: 'Gong Bao — back bed', sown_at: '2026-06-03', seeds_sown: 20, seeds_germinated: 14 },
  { id: 'pl-1', name: 'Gong Bao — pot 4', sown_at: '2026-04-20', seeds_sown: 10, seeds_germinated: null },
];
const SOWN_ROWS = [
  { id: 'pl-2', name: 'Gong Bao — back bed', sown_at: '2026-06-03', status: 'harvested' },
  { id: 'pl-1', name: 'Gong Bao — pot 4', sown_at: '2026-04-20', status: 'vegetative' },
];
let detailRow;
const isGermination = (t) => t.includes('p.seeds_sown IS NOT NULL');
const isSownFrom = (t) => t.includes('FROM public.garden_node') && t.includes('p.archived_at IS NULL');

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  detailRow = SEED_ROW;
  stubState.sqlHandler = (text) => {
    if (isGermination(text)) return GERM_ROWS;
    if (isSownFrom(text)) return SOWN_ROWS;
    if (text.includes('FROM inventory_items i') && text.includes('WHERE i.id = ?')) return [detailRow];
    return [];
  };
});

// ── 1. THE WIRE ─────────────────────────────────────────────────────────────────────────────────
describe('GET /api/inventory-items/:id — sown_from (V5-SEEDSTAB-001 slice 3)', () => {
  it('a seed row answers sown_from = the plantings the read returned, in its order, and nothing else', async () => {
    const { status, body } = parse(await handler(get()));
    expect(status).toBe(200);
    expect(body.sown_from).toEqual(SOWN_ROWS);
    // The four fields a link needs, and only those — no photo, no counts, no container.
    expect(Object.keys(body.sown_from[0]).sort()).toEqual(['id', 'name', 'sown_at', 'status']);
  });

  it('an empty read is an empty array — the page shows nothing — never null on a seed row', async () => {
    stubState.sqlHandler = (text) => (isGermination(text) || isSownFrom(text) ? [] : text.includes('WHERE i.id = ?') ? [detailRow] : []);
    const { body } = parse(await handler(get()));
    expect(body.sown_from).toEqual([]);
  });

  it('a NON-seed row answers sown_from = null and never reads garden_node (same rule as germination)', async () => {
    detailRow = { ...SEED_ROW, category: 'tools', type: 'durable', name: 'Hori hori knife' };
    const { status, body } = parse(await handler(get()));
    expect(status).toBe(200);
    expect(body.sown_from).toBeNull();
    expect(body.germination).toBeNull();
    expect(stubState.sqlCalls.filter((c) => c.text.includes('garden_node'))).toHaveLength(0);
  });

  it('germination is BYTE-IDENTICAL: same statement text, same object, same serialisation', async () => {
    const { text } = parse(await handler(get()));
    const germ = stubState.sqlCalls.find((c) => isGermination(c.text));
    // The statement as it stood before sown_from existed (lambda/inventory-items/index.js at
    // 32141128db33b5ce4334ad74bde9c42fa47a02fe), whitespace-normalised: moving it into a Promise.all
    // re-indented it and must have changed nothing else.
    const squash = (s) => s.replace(/\s+/g, ' ').trim();
    expect(squash(germ.text)).toBe(squash(`
      SELECT p.id, p.display_name AS name, p.sown_at, p.seeds_sown, p.seeds_germinated
        FROM public.garden_node p
       WHERE p.source_inventory_item_id = ?
         AND p.deleted_at IS NULL
         AND p.seeds_sown IS NOT NULL
       ORDER BY p.sown_at DESC NULLS LAST, p.id
    `));
    expect(germ.values).toEqual([ITEM]);
    // The serialised block, byte for byte, as the pre-change handler built it from these rows.
    const before = JSON.stringify({ sowings: GERM_ROWS, seeds_sown: 30, seeds_germinated: 14, rate: 46.7 });
    expect(text).toContain(`"germination":${before}`);
  });

  it('the two garden_node reads go out together, not one after the other', async () => {
    let inFlight = 0;
    let peak = 0;
    stubState.sqlHandler = async (text) => {
      if (!(isGermination(text) || isSownFrom(text))) return text.includes('WHERE i.id = ?') ? [detailRow] : [];
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return isGermination(text) ? GERM_ROWS : SOWN_ROWS;
    };
    const { body } = parse(await handler(get()));
    expect(body.sown_from).toEqual(SOWN_ROWS);
    expect(peak).toBe(2);
  });
});

// ── 2. THE PREDICATE IS THE PLANTS LAMBDA'S ─────────────────────────────────────────────────────────
// Comments out, whitespace squashed, every template interpolation reduced to its expression, and the
// plants Lambda's `gp` alias read as this handler's `p`.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');
const templates = (file) => [...decomment(readFileSync(resolve(__dirname, file), 'utf8'))
  .matchAll(/sql`([^`]*)`/g)].map((m) => m[1]);
const norm = (s) => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

const PLANTS = templates('../plants/index.js');
// The two default views that hide archived plantings AND plantings in an archived container: Garden's
// grid and the planting chooser. Found by what they are, not by position.
const DEFAULT_VIEWS = PLANTS.filter((t) => /FROM public\.garden_node gp\b/.test(t)
  && /\bgp\.archived_at IS NULL\b/.test(t) && /\bpp\.archived_at IS NULL\b/.test(t));
const whereOf = (t) => norm(t).match(/WHERE (\(\(pp\.created_by[\s\S]*?AND pp\.archived_at IS NULL)/)?.[1] ?? null;
const PLANTS_WHERE = DEFAULT_VIEWS.map((t) => whereOf(t).replace(/\bgp\./g, 'p.'));

const SOWN_FROM_SQL = norm(templates('index.js').find((t) => /FROM public\.garden_node p\b/.test(t)
  && /\bp\.archived_at IS NULL\b/.test(t)) ?? '');

describe('sown_from uses the plants default views\' WHERE, verbatim (Archive-Hiding Rule)', () => {
  it('finds both plants default views and the sown_from read, so the comparison is not vacuous', () => {
    expect(DEFAULT_VIEWS).toHaveLength(2);
    expect(PLANTS_WHERE.every(Boolean)).toBe(true);
    expect(PLANTS_WHERE[0]).toBe(PLANTS_WHERE[1]);
    expect(PLANTS_WHERE[0]).toMatch(/p\.archived_at IS NULL AND pp\.archived_at IS NULL$/);
    expect(SOWN_FROM_SQL).toMatch(/^SELECT p\.id, p\.display_name AS name, p\.sown_at, p\.status FROM public\.garden_node p/);
  });

  it('carries that WHERE whole: ownership arms, container-deleted gate, deleted_at, and BOTH archive clauses', () => {
    expect(SOWN_FROM_SQL).toContain(`WHERE p.source_inventory_item_id = \${itemId} AND ${PLANTS_WHERE[0]}`);
    // The join the container clauses read, spelled as the plants Lambda spells it.
    expect(SOWN_FROM_SQL).toContain('LEFT JOIN public.container pp ON pp.id = p.container_id');
  });

  it('filters archived rows IN SQL — the page never receives one to drop', () => {
    expect(SOWN_FROM_SQL).toMatch(/\bp\.archived_at IS NULL\b/);
    expect(SOWN_FROM_SQL).toMatch(/\bpp\.archived_at IS NULL\b/);
    expect(SOWN_FROM_SQL).toMatch(/\bp\.deleted_at IS NULL\b/);
    // Archived and deleted stay separate axes (gardening.md): never one predicate standing for both.
    expect(SOWN_FROM_SQL).not.toMatch(/COALESCE\(\s*p\.archived_at/);
  });
});

// ── 3. THE BINDINGS ─────────────────────────────────────────────────────────────────────────────────
describe('sown_from binds the item to the source test and the household to BOTH ownership arms', () => {
  const saved = process.env.GARDEN_HOUSEHOLD_IDS;
  afterEach(() => {
    if (saved === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS;
    else process.env.GARDEN_HOUSEHOLD_IDS = saved;
  });

  it('binds by position: item id first, then the household list into each arm', async () => {
    process.env.GARDEN_HOUSEHOLD_IDS = `${USER},${PARTNER}`;
    await handler(get());
    const call = stubState.sqlCalls.find((c) => isSownFrom(c.text));
    expect(call, 'the sown_from read never ran').toBeTruthy();
    // The stub joins the template's strings with '?', so the Nth '?' is the Nth value.
    const before = (marker) => (call.text.slice(0, call.text.indexOf(marker)).match(/\?/g) ?? []).length;
    expect(call.values[before('p.source_inventory_item_id = ?')]).toBe(ITEM);
    expect(call.values[before('pp.created_by = ANY(?)')]).toEqual([USER, PARTNER]);
    expect(call.values[before('p.created_by = ANY(?)')]).toEqual([USER, PARTNER]);
    expect(call.values).toHaveLength(3);
  });

  it('a solo user binds just themselves', async () => {
    delete process.env.GARDEN_HOUSEHOLD_IDS;
    await handler(get());
    const call = stubState.sqlCalls.find((c) => isSownFrom(c.text));
    expect(call.values).toEqual([ITEM, [USER], [USER]]);
  });
});
