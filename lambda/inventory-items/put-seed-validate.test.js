// BUG-INVSEEDPUT400-001 — PUT /api/inventory-items/:id rejected every seed packet.
//
// WHY THIS FILE EXISTS. Nothing executed validateUpdate. `git grep validateUpdate` found the
// definition and its one call site and no test at all, which is how a guard that rejects the entire
// `category='seeds'` half of the table survived: the static-source guards in this directory assert
// route ORDER and SQL SHAPE, and neither of those notices a validator returning the wrong answer.
// These cases run the handler.
//
// THE DEFECT. validateUpdate read the RAW request body with no merge against the stored row, so
// `category === 'seeds' && variety_id == null` was true for any payload that named the category and
// left the variety alone — which is every payload InventoryDetail sends. buildChanges() emits
// name/category/status/notes/source/source_url/purchase_date/unit_cost/location_text/
// quantity_purchased plus the consumable-or-durable set, and has never emitted variety_id: the form
// neither renders the variety nor can change it.
//
// The guard mirrors chk_inventory_seed_requires_variety, so it is not deletable — a seeds row with a
// null variety violates the CHECK. It is now PRESENCE-based: it fires when a client actually sends a
// null variety for a seeds row, and stays silent when the client is not touching the column.
//
// The second half is the one that would have been easy to miss. `variety_id` was a BARE assignment
// in the PUT's SET list (`= ${body.variety_id ?? null}`), so relaxing the validator alone would have
// converted a wrong 400 into silent data loss — every edit from a form that does not round-trip the
// variety would have NULLed the cultivar link. The 400 was masking that. Both halves are pinned
// below; either one reverted alone reds this file.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { handler, validateUpdate } = await import('./index.js');

const USER = 'user_stub_owner';
const ITEM = '2d6df841-b507-4e65-8db0-97c8659df37c';
const VARIETY = 'd58b5155-0c23-4365-bfad-30549b8ca069';

// The EXACT shape InventoryDetail.buildChanges() produces for a consumable seed packet — the whole
// point of this file is that this payload is what the real client sends, so an invented one that
// happened to carry variety_id would prove nothing. Fields, order and null-vs-absent all mirror
// src/pages/InventoryDetail.jsx buildChanges(); src/__tests__/InventoryDetail.seedPut.test.jsx pins
// that they stay in step.
const buildChangesPayload = () => ({
  name: 'Green Flesh Honeydew',
  category: 'seeds',
  status: 'active',
  notes: 'Saved from 2026',
  source: 'Gardens at Mathews',
  source_url: null,
  purchase_date: null,
  unit_cost: null,
  location_text: null,
  quantity_purchased: null,
  quantity_on_hand: 1,
  unit: 'packet',
  reorder_threshold: null,
  reorder_quantity: null,
  quantity: null,
  condition: null,
  brand: null,
  model: null,
});

// The value bound to ONE named placeholder, not "is this value anywhere in the list".
// `expect(values).toContain(false)` looked like it proved the presence guard was off, and did not:
// the same UPDATE binds hasFeatured, hasSeedProcess and hasSeedStage, so a `false` from any of them
// satisfied it and a hasVariety pinned to `true` survived the mutation. The stub builds its text as
// `strings.join('?')`, so the value for a placeholder is indexed by how many '?' precede it.
const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};

const put = (body, id = ITEM) => ({
  requestContext: { http: { method: 'PUT' } },
  rawPath: `/api/inventory-items/${id}`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  // One row back from the UPDATE, so a request that reaches the SQL reports 200 rather than the
  // 404 an unconfigured stub would give — otherwise "not 400" could not be distinguished from
  // "rejected somewhere else".
  stubState.sqlHandler = () => [{ id: ITEM, category: 'seeds', variety_id: VARIETY }];
});

describe('BUG-INVSEEDPUT400-001 — editing a seed packet through the wide PUT', () => {
  it("accepts the payload InventoryDetail actually sends, and does not 400 on the absent variety", async () => {
    const { status, body } = parse(await handler(put(buildChangesPayload())));
    expect(body.error).toBeUndefined();
    expect(status).toBe(200);
  });

  it('reaches the UPDATE — a rejection short-circuits before any SQL runs', async () => {
    await handler(put(buildChangesPayload()));
    // Count first: a `for`/`find` over an empty array asserts nothing at all.
    expect(stubState.sqlCalls).toHaveLength(1);
    expect(stubState.sqlCalls[0].text).toMatch(/UPDATE inventory_items/);
  });

  it('leaves variety_id UNTOUCHED when the client does not mention it', async () => {
    await handler(put(buildChangesPayload()));
    expect(stubState.sqlCalls).toHaveLength(1);
    const call = stubState.sqlCalls[0];
    // The presence guard, structurally: an ELSE arm that re-reads the stored column. A bare
    // `variety_id = ${...}` writes null here and destroys the cultivar link on every edit.
    expect(call.text).toMatch(/variety_id\s*=\s*CASE[\s\S]*?ELSE variety_id\s*END/);
    // And the guard is actually OFF for THIS payload — a CASE wired to a constant true passes the
    // shape assertion above while nulling the column exactly as before.
    expect(boundAfter(call, /variety_id\s*=\s*CASE\s*WHEN /)).toBe(false);
  });

  it('still refuses an EXPLICIT null variety on a seeds row — the CHECK is real', async () => {
    // chk_inventory_seed_requires_variety: category <> 'seeds' OR variety_id IS NOT NULL.
    // A client that deliberately sends variety_id: null must get a named field back, not a 23514
    // round trip.
    const { status, body } = parse(await handler(put({ ...buildChangesPayload(), variety_id: null })));
    expect(status).toBe(400);
    expect(body.error).toBe('variety_id is required for seeds');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('writes the variety through when the client DOES send one', async () => {
    const { status } = parse(await handler(put({ ...buildChangesPayload(), variety_id: VARIETY })));
    expect(status).toBe(200);
    expect(stubState.sqlCalls).toHaveLength(1);
    const call = stubState.sqlCalls[0];
    expect(boundAfter(call, /variety_id\s*=\s*CASE\s*WHEN /)).toBe(true);
    expect(boundAfter(call, /variety_id\s*=\s*CASE\s*WHEN \?\s*THEN /)).toBe(VARIETY);
  });

  describe('validateUpdate directly — the unit that had no test', () => {
    it('is silent on an absent variety_id for seeds', () => {
      expect(validateUpdate(buildChangesPayload())).toBeNull();
    });

    it('reports the field on an explicit null variety_id for seeds', () => {
      expect(validateUpdate({ category: 'seeds', variety_id: null }))
        .toBe('variety_id is required for seeds');
    });

    it('is silent on an absent variety_id for a non-seed category', () => {
      expect(validateUpdate({ category: 'tools' })).toBeNull();
    });

    it('still rejects a variety_id sent with a non-seed category', () => {
      expect(validateUpdate({ category: 'tools', variety_id: VARIETY }))
        .toBe('variety_id is only allowed when category is seeds');
    });
  });
});

describe('BUG-INVSEEDPUT400-001 — the client half stays in step', () => {
  // The handler fix is only load-bearing while buildChanges() keeps NOT sending variety_id. If a
  // later edit starts sending it, this file's premise is stale and the reader should be told here
  // rather than discovering it from a green suite that no longer tests what it claims.
  const DETAIL = readFileSync(
    resolve(__dirname, '../../src/pages/InventoryDetail.jsx'), 'utf8',
  );

  it('buildChanges() sends category and not variety_id', () => {
    const fn = DETAIL.slice(
      DETAIL.indexOf('function buildChanges()'),
      DETAIL.indexOf('function parseNum('),
    );
    // Bound the slice: an unmatched index yields -1 and slices the whole file, which would make
    // every assertion below read the entire page instead of one function.
    //
    // Ceiling raised 2500 -> 3400 on 2026-09-04 (V5-SOURCEPICKER-001), because buildChanges grew to
    // 2778 when it started sending source_id / acquired_from_source_id. Raised rather than removed,
    // and the headroom is deliberate rather than generous: InventoryDetail.jsx is ~40k characters,
    // so anything that slices the whole page lands two orders of magnitude past this and is still
    // caught. A bound that tracked the function exactly would red on every honest edit to it and
    // would teach the next reader to raise it without looking — which is how a runaway-slice guard
    // stops being one.
    //
    // Raised again 3400 -> 4200 on 2026-09-04 (BUG-SEEDYEARNOOP-001), on the same reasoning the
    // previous raise gives: buildChanges grew to 3585 when it started sending year_harvested for
    // seed rows. This is a RUNAWAY-SLICE guard, not a complexity budget — the failure it exists to
    // catch is an unmatched indexOf slicing all ~40k characters of the page, which still lands an
    // order of magnitude past 4200. Tightening it to hug the function would red on every honest
    // edit and teach the next reader to raise it without looking.
    expect(fn.length).toBeGreaterThan(200);
    expect(fn.length).toBeLessThan(4200);
    expect(fn).toMatch(/category:\s*form\.category/);
    expect(fn).not.toMatch(/\bvariety_id\b/);
  });
});
