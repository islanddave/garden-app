// V5-SEEDQTY-001 — PUT /api/inventory-items/:id/seed-measure.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. The stubs alias @neondatabase/serverless to a tagged template
// that RECORDS the SQL and returns whatever stubState.sqlHandler gives it (lambda/_test-stubs/
// neon-serverless.js) — no statement is ever executed. So every constraint on the three new columns,
// the seeds-only predicate in the WHERE, and the presence-vs-absence behaviour of the stored row are
// out of reach here and are asserted in tests/integration/inventory-items.int.test.js against a real
// Postgres instead. What IS provable here, and is the part that would fail SILENTLY in prod:
//   - the route is reachable (declared before idMatch) and PUT-only;
//   - the presence sentinels are wired to hasOwnProperty and bound to the RIGHT placeholder;
//   - the three columns stay OUT of the wide PUT's SET list and the POST INSERT — the headline
//     data-loss risk, because src/hooks/useInventory.js adjustQuantity round-trips the entire raw
//     list row through that statement with no strip list at all;
//   - validateUpdate names the FIELD rather than letting a CHECK name itself.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { handler, validateUpdate } = await import('./index.js');

// A construct NAMED IN A COMMENT is not that construct — this file's whole "stays out of the wide
// PUT" claim would otherwise be satisfied by the very comment that explains why it stays out.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const USER = 'user_stub_owner';
const ITEM = '2d6df841-b507-4e65-8db0-97c8659df37c';

const measure = (body, { method = 'PUT', id = ITEM } = {}) => ({
  requestContext: { http: { method } },
  rawPath: `/api/inventory-items/${id}/seed-measure`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

// The value bound to ONE named placeholder, not "is this value anywhere in the values array".
// Lifted from put-seed-validate.test.js, and for the reason recorded there: this statement binds
// three separate booleans, so `toContain(false)` is satisfied by any of them and a sentinel pinned
// to a constant survives the mutation. The stub joins its strings with '?', so a placeholder's value
// is indexed by how many '?' precede it.
const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  // One row back, so a request that reaches the SQL reports 200 rather than the 404 an unconfigured
  // stub gives — otherwise "not 400" could not be told apart from "rejected somewhere else".
  stubState.sqlHandler = () => [{
    id: ITEM, seed_count: 185, seed_weight_g: '0.500', seed_count_estimated: false,
  }];
});

describe('V5-SEEDQTY-001 /seed-measure — route shape', () => {
  it('is declared BEFORE the idMatch regex, so it is reachable at all', () => {
    // idMatch's /([^/]+)$/ cannot match the /seed-measure suffix today, but a future loosening of
    // that regex would swallow this route silently: it would 405 (PUT/DELETE only on :id) rather
    // than error, and a count would simply never be written.
    const idMatchIdx = SRC.indexOf('const idMatch = rawPath.match');
    const measureIdx = SRC.indexOf('const seedMeasureMatch = rawPath.match');
    expect(measureIdx).toBeGreaterThan(-1);
    expect(measureIdx, 'seed-measure branch must precede idMatch').toBeLessThan(idMatchIdx);
  });

  it('answers the documented body shape on success', async () => {
    const { status, body } = parse(await handler(measure({ seed_count: 185 })));
    expect(status).toBe(200);
    expect(Object.keys(body).sort())
      .toEqual(['id', 'seed_count', 'seed_count_estimated', 'seed_weight_g']);
  });

  it('is PUT-only — every other verb 405s before any SQL runs', async () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const { status } = parse(await handler(measure({ seed_count: 1 }, { method })));
      expect(status, `${method} was not refused`).toBe(405);
    }
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('404s when the UPDATE matches nothing (foreign household, deleted, or not a seed lot)', async () => {
    stubState.sqlHandler = () => [];
    const { status, body } = parse(await handler(measure({ seed_count: 185 })));
    expect(status).toBe(404);
    expect(body.error).toBe('Not found');
  });

  it('scopes the UPDATE to the household, to live rows, and to seed packets only', async () => {
    await handler(measure({ seed_count: 185 }));
    expect(stubState.sqlCalls).toHaveLength(1);
    const { text } = stubState.sqlCalls[0];
    expect(text).toMatch(/UPDATE public\.inventory_items/);
    expect(text).toMatch(/created_by = ANY\(\?\)/);
    expect(text).toContain('deleted_at IS NULL');
    expect(text).toContain("category = 'seeds'");
    expect(text).toContain('updated_at = NOW()');
    expect(text).toMatch(/RETURNING id, seed_count, seed_weight_g, seed_count_estimated/);
  });
});

describe('V5-SEEDQTY-001 /seed-measure — presence, not truthiness', () => {
  // The contract in one sentence: an ABSENT key leaves the stored value alone, an explicit null
  // CLEARS it, and 0 is a measured fact rather than a synonym for "unset". Each arm below pins BOTH
  // the structural CASE and the boolean actually bound to it — a CASE wired to a constant `true`
  // satisfies the shape assertion while overwriting the column exactly as a bare assignment would.
  const arms = [
    ['seed_count', /seed_count = CASE\s*WHEN /, 185],
    ['seed_weight_g', /seed_weight_g = CASE\s*WHEN /, 0.5],
    ['seed_count_estimated', /seed_count_estimated = CASE\s*WHEN /, true],
  ];

  for (const [col, whenRe, value] of arms) {
    it(`${col}: an absent key re-reads the stored column`, async () => {
      await handler(measure({}));
      const call = stubState.sqlCalls[0];
      expect(call.text).toMatch(new RegExp(`${col} = CASE[\\s\\S]*?ELSE ${col}\\s*END`));
      expect(boundAfter(call, whenRe), `${col} sentinel is not OFF for an empty body`).toBe(false);
    });

    it(`${col}: an explicit value turns the sentinel ON and binds the value`, async () => {
      await handler(measure({ [col]: value }));
      const call = stubState.sqlCalls[0];
      expect(boundAfter(call, whenRe)).toBe(true);
      expect(boundAfter(call, new RegExp(`${col} = CASE\\s*WHEN \\?\\s*THEN `))).toBe(value);
    });

    it(`${col}: an explicit null CLEARS — presence and absence must differ`, async () => {
      await handler(measure({ [col]: null }));
      const call = stubState.sqlCalls[0];
      expect(boundAfter(call, whenRe), `${col}: null was read as absent`).toBe(true);
      expect(boundAfter(call, new RegExp(`${col} = CASE\\s*WHEN \\?\\s*THEN `))).toBeNull();
    });
  }

  it('seed_count 0 is written, not swallowed as falsy', async () => {
    // The value this route most needs to carry: "I counted them, the packet is empty" has to be
    // distinguishable from "nobody has counted". A `if (body.seed_count)` anywhere on this path
    // collapses the two.
    await handler(measure({ seed_count: 0 }));
    const call = stubState.sqlCalls[0];
    expect(boundAfter(call, /seed_count = CASE\s*WHEN /)).toBe(true);
    expect(boundAfter(call, /seed_count = CASE\s*WHEN \?\s*THEN /)).toBe(0);
  });

  it('an empty body still issues the UPDATE and is not a 400', async () => {
    // Unlike /source-plant and /source-kind, which exist to set exactly one column and 400 on a body
    // that never names it. This route carries three independent measurements; a caller sending only
    // the weight is ordinary traffic.
    const { status } = parse(await handler(measure({})));
    expect(status).toBe(200);
    expect(stubState.sqlCalls).toHaveLength(1);
  });
});

describe('V5-SEEDQTY-001 /seed-measure — type guards (the RANGE is the database\'s job)', () => {
  const bad = [
    ['seed_count', '185', 'seed_count must be a whole number of seeds, or null'],
    ['seed_count', 1.5, 'seed_count must be a whole number of seeds, or null'],
    ['seed_weight_g', '0.5', 'seed_weight_g must be a number of grams, or null'],
    // NOT NaN or Infinity: JSON.stringify turns both into `null`, so neither can arrive over the
    // wire and a case written with them would silently become the CLEAR case and pass as a 200.
    // The Number.isFinite arm of the guard is unreachable from HTTP by construction and is kept
    // only for an in-process caller; `typeof !== 'number'` is the half that fires in prod.
    ['seed_weight_g', true, 'seed_weight_g must be a number of grams, or null'],
    ['seed_count_estimated', 'true', 'seed_count_estimated must be true, false or null'],
  ];

  for (const [col, value, message] of bad) {
    it(`${col}: ${JSON.stringify(value)} -> 400 naming the field, before any SQL`, async () => {
      const { status, body } = parse(await handler(measure({ [col]: value })));
      expect(status).toBe(400);
      expect(body.error).toBe(message);
      expect(body.error, 'a schema name leaked into the user-facing string').not.toMatch(/chk_/);
      expect(stubState.sqlCalls, 'must short-circuit before issuing SQL').toHaveLength(0);
    });
  }

  it('NEGATIVES are NOT refused here — the CHECK is what must execute', async () => {
    // The green control for the pair above, and the load-bearing one. A JS `< 0` test would be an
    // easy addition and would mean nothing in this repo ever runs chk_inventory_seed_count_nonneg /
    // chk_inventory_seed_weight_nonneg — leaving an unarmed constraint indistinguishable from an
    // armed one. -1 must reach the database. tests/integration/inventory-items.int.test.js asserts
    // the 23514 that comes back.
    const { status } = parse(await handler(measure({ seed_count: -1, seed_weight_g: -1 })));
    expect(status).toBe(200);
    expect(stubState.sqlCalls).toHaveLength(1);
    expect(boundAfter(stubState.sqlCalls[0], /seed_count = CASE\s*WHEN \?\s*THEN /)).toBe(-1);
  });

  it('maps both nonneg constraints to a sentence rather than their own name', async () => {
    stubState.sqlHandler = () => {
      const e = new Error('violates check constraint');
      e.code = '23514';
      e.constraint = 'chk_inventory_seed_count_nonneg';
      throw e;
    };
    const { status, body } = parse(await handler(measure({ seed_count: -1 })));
    expect(status).toBe(400);
    expect(body.error).toMatch(/cannot be negative/i);
    expect(body.error).not.toMatch(/chk_/);
  });
});

describe('V5-SEEDQTY-001 — the three columns stay OUT of the wide write paths', () => {
  // THE HEADLINE RISK, and the reason this route exists at all. Every assignment in the wide PUT's
  // SET list is unconditional, and src/hooks/useInventory.js adjustQuantity PUTs `{ ...current,
  // [col]: newValue }` — the entire raw list row, no strip list — on every +/- tap on /inventory.
  // Even a hasOwnProperty guard would not save these columns there: updateItem merges
  // `{ ...current, ...payload }` against a list reloaded on mount, so the sentinel would be TRUE
  // carrying a STALE count and the CASE arm would write it back. Absence from the statement is the
  // only guard that holds.
  const COLS = ['seed_count', 'seed_weight_g', 'seed_count_estimated'];

  const putBranch = (() => {
    const start = SRC.indexOf("if (method === 'PUT')");
    return SRC.slice(start, SRC.indexOf("if (method === 'DELETE')", start));
  })();

  it('the wide PUT arm exists and is the statement being scanned', () => {
    expect(putBranch).toContain('UPDATE inventory_items SET');
  });

  for (const col of COLS) {
    it(`the wide PUT never mentions ${col}`, () => {
      expect(putBranch).not.toMatch(new RegExp(`\\b${col}\\b`));
    });
  }

  it('the POST INSERT column list never mentions any of them', async () => {
    // Creation goes through the route too: SaveSeedSheet creates the lot with quantity_on_hand 1
    // and then PUTs the measurement, so the INSERT has no business naming these.
    const insert = SRC.slice(
      SRC.indexOf('INSERT INTO inventory_items ('),
      SRC.indexOf(') RETURNING *', SRC.indexOf('INSERT INTO inventory_items (')),
    );
    expect(insert).toContain('user_id, created_by');
    for (const col of COLS) expect(insert).not.toMatch(new RegExp(`\\b${col}\\b`));
  });
});

describe('V5-SEEDQTY-001 — validateUpdate names the FIELD, not a constraint', () => {
  // BUG-INVUPDATESEEDGUARD-001's shape, already fixed once for source_plant_id: without these,
  // a payload carrying a count alongside a non-seeds category comes back as
  // `400 Constraint violation: chk_inventory_seed_count_seeds_only`.
  it('refuses seed_count with a non-seeds category', () => {
    expect(validateUpdate({ category: 'tools', seed_count: 185 }))
      .toBe('seed_count is only allowed when category is seeds');
  });

  it('refuses seed_weight_g with a non-seeds category', () => {
    expect(validateUpdate({ category: 'tools', seed_weight_g: 0.5 }))
      .toBe('seed_weight_g is only allowed when category is seeds');
  });

  it('is silent when the category IS seeds', () => {
    expect(validateUpdate({ category: 'seeds', variety_id: 'v', seed_count: 185 })).toBeNull();
  });

  it('is silent when the body names no category — this validator never reads the stored row', () => {
    // Body-only, matching every other guard in validateUpdate. A payload that omits `category` says
    // nothing about whether the lot is seeds and must not be second-guessed; that case falls to the
    // CHECK, whose name is mapped to a sentence.
    expect(validateUpdate({ seed_count: 185 })).toBeNull();
    expect(validateUpdate({ seed_weight_g: 0.5 })).toBeNull();
  });
});
