// BUG-INVUPDATESEEDGUARD-001 — moving a saved-seed lot out of Seeds answered with a constraint name.
//
// THE DEFECT. v4.94.0 added `source_plant_id` / `source_kind` seeds-only guards to validateCreate and
// to NEITHER arm of validateUpdate (the diff hunk header is literally
// `@@ -105,6 +121,12 @@ export function validateCreate`). The wide PUT assigns `category`
// unconditionally and Category is a user-editable <select> on /inventory/:id, so changing a
// saved-seed lot's category away from `seeds` reached the database and came back as
// `400 Constraint violation: chk_inventory_source_plant_seeds_only`. Nothing was corrupted — the
// write is rejected, not mangled — so this is legibility, not integrity. It was unreachable when
// v4.94.0 shipped (live prod: 0 rows carrying either column) and became reachable with the first lot
// saved through the new sheet.
//
// TWO MECHANISMS, AND THEY ARE NOT REDUNDANT — the reason both exist is the reason this file has two
// describe blocks. The validator is body-only by design and can only see what the client
// round-tripped:
//   • with the list loaded, updateItem's {...listRow, ...changes} merge puts source_plant_id in the
//     body, the validator fires, and nothing reaches SQL;
//   • on a DEEP LINK the list is empty, the merge contributes nothing, and the body is
//     buildChanges() alone — which names `category` and has never named `source_plant_id`. The
//     validator cannot fire on that path. The constraint does.
// So the catch-block mapping is what actually closes it, and the validator is the fast path that
// answers before a round trip. Neutralise either and the other still covers its own path, which is
// what makes both testable — see src/components/planting/SaveSeedSheet.jsx's note on why a redundant
// guard is an untestable one.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { handler, validateUpdate, SEED_CONSTRAINT_MESSAGES } = await import('./index.js');

const USER = 'user_stub_owner';
const ITEM = '2d6df841-b507-4e65-8db0-97c8659df37c';
const PLANT = '7c1f2b90-3a44-4d21-9f88-1b5e0c7a2d31';

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
  stubState.sqlHandler = () => [{ id: ITEM, category: 'seeds' }];
});

describe('validateUpdate — the fast path, when the body carries the provenance', () => {
  it('refuses source_plant_id on a non-seeds category, naming the field', () => {
    const err = validateUpdate({ category: 'tools', source_plant_id: PLANT });
    expect(err).toMatch(/source_plant_id/);
    expect(err).toMatch(/seeds/);
  });

  it('refuses source_kind on a non-seeds category, naming the field', () => {
    const err = validateUpdate({ category: 'tools', source_kind: 'store' });
    expect(err).toMatch(/source_kind/);
  });

  it('allows both while the category stays seeds', () => {
    expect(validateUpdate({ category: 'seeds', source_plant_id: PLANT, source_kind: 'own_garden' }))
      .toBeNull();
  });

  it('stays SILENT when the body does not name the category at all', () => {
    // Body-only by design, matching the variety_id guard beside it. A payload that omits `category`
    // says nothing about whether the lot is seeds, and this validator never reads the stored row —
    // so second-guessing here would reject legitimate narrow writes against a seeds lot.
    expect(validateUpdate({ source_plant_id: PLANT })).toBeNull();
    expect(validateUpdate({ source_kind: 'own_garden' })).toBeNull();
  });

  it('stays silent on an explicit null — clearing provenance is how you MOVE the lot', () => {
    // The message tells the user to clear "Saved from" first. If a null tripped the same guard that
    // advice would be a dead end.
    expect(validateUpdate({ category: 'tools', source_plant_id: null, source_kind: null }))
      .toBeNull();
  });

  it('short-circuits before any SQL runs', async () => {
    const { status, body } = parse(await handler(put({ category: 'tools', source_plant_id: PLANT })));
    expect(status).toBe(400);
    expect(body.error).toMatch(/source_plant_id/);
    expect(stubState.sqlCalls, 'a rejected payload reached the database').toHaveLength(0);
  });
});

describe('the catch-block mapping — the deep-link path the validator cannot see', () => {
  // The payload a deep-linked edit actually sends: buildChanges() alone, no merge, so the body names
  // `category` and never `source_plant_id`. This is the case the validator provably misses, which is
  // why it is spelled out rather than reusing the block above.
  const deepLinkBody = { name: 'Green Flesh Honeydew', category: 'tools', status: 'active', type: 'consumable', unit: 'packet', quantity_on_hand: 3 };

  const raise = (constraint) => () => {
    const err = new Error('new row violates check constraint');
    err.code = '23514';
    err.constraint = constraint;
    throw err;
  };

  it('answers a seeds-only violation with a sentence, not a constraint name', async () => {
    stubState.sqlHandler = raise('chk_inventory_source_plant_seeds_only');
    const { status, body } = parse(await handler(put(deepLinkBody)));
    expect(status).toBe(400);
    expect(body.error).toBe(SEED_CONSTRAINT_MESSAGES.chk_inventory_source_plant_seeds_only);
    expect(body.error, 'the schema name leaked into the user-facing string').not.toMatch(/chk_/);
    // The advice has to name a control the user can actually find on the page.
    expect(body.error).toMatch(/Saved from/);
  });

  it('maps every constraint in the table without leaking its name', async () => {
    for (const [constraint, message] of Object.entries(SEED_CONSTRAINT_MESSAGES)) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = raise(constraint);
      const { status, body } = parse(await handler(put(deepLinkBody)));
      expect(status, `${constraint} did not 400`).toBe(400);
      expect(body.error, `${constraint} was not mapped`).toBe(message);
      expect(body.error, `${constraint} leaked its name`).not.toMatch(/chk_/);
    }
  });

  it('leaves every OTHER constraint on the generic arm', async () => {
    // The mapping must not swallow constraints it has no sentence for — a wrong-but-friendly message
    // is worse than an opaque accurate one.
    stubState.sqlHandler = raise('chk_inventory_metadata_size');
    const { body } = parse(await handler(put(deepLinkBody)));
    expect(body.error).toBe('Constraint violation: chk_inventory_metadata_size');
  });
});

describe('the mapping keys are real constraint names', () => {
  // THE VACUITY GUARD, and the reason this block is not just belt-and-braces. Every assertion above
  // raises a constraint name that this same file supplies, so all of them stay green against a table
  // keyed on names that do not exist in the database — a typo, or a constraint renamed by a later
  // migration, and the mapping silently stops matching while the suite still passes. The names are
  // therefore checked against the DDL that creates them.
  const MIGRATIONS = resolve(__dirname, '../../migrations');

  const ddlText = () => readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(resolve(MIGRATIONS, d.name))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(resolve(MIGRATIONS, d.name, f), 'utf8')))
    .join('\n');

  it('every key appears as an ADD CONSTRAINT in migrations/', () => {
    const sql = ddlText();
    expect(sql.length, 'read no migration SQL at all — path wrong?').toBeGreaterThan(1000);
    for (const name of Object.keys(SEED_CONSTRAINT_MESSAGES)) {
      // chk_inventory_seed_requires_variety predates the migrations directory's seed work and is
      // asserted by tests/integration/seed-lifecycle.int.test.js against the live schema instead.
      if (name === 'chk_inventory_seed_requires_variety') continue;
      expect(sql, `${name} is not created by any migration — renamed or never existed`)
        .toMatch(new RegExp(`ADD CONSTRAINT\\s+${name}\\b`));
    }
  });

  it('chk_inventory_seed_source_plant is the MUTUAL-EXCLUSION rule its message describes', () => {
    // Written because the pre-promote report paraphrased this constraint as "requires source_kind
    // non-NULL", and a message drafted from that summary told the user to SUPPLY the field they
    // actually need to CLEAR. The expression is the authority, not the summary.
    const sql = ddlText();
    const m = sql.match(/ADD CONSTRAINT\s+chk_inventory_seed_source_plant\s+CHECK\s*\(([^;]*?)\)\s*;/s);
    expect(m, 'constraint expression not found').toBeTruthy();
    const expr = m[1].replace(/\s+/g, ' ');
    expect(expr).toMatch(/source_kind IS NULL/);
    expect(expr).toMatch(/source_kind = 'own_garden'/);
    expect(expr).toMatch(/source_plant_id IS NULL/);
    // The message must tell the user to clear one of the two, never to provide both.
    expect(SEED_CONSTRAINT_MESSAGES.chk_inventory_seed_source_plant).toMatch(/Clear one/i);
  });
});
