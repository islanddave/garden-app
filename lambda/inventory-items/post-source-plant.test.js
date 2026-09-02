// BUG-SEEDPOSTDROPSPARENT-001 — POST /api/inventory-items dropped source_plant_id on the floor.
//
// THE DEFECT. The column was named in NEITHER the INSERT column list NOR its VALUES, so a client
// that sent a parent plant got 201 Created and `RETURNING *` echoed `source_plant_id: null`. That is
// worse than the 400 it should have been: a rejection carries a retry signal, a 201 says the write
// landed. Same silent-drop shape as BUG-INVMETADROP-001, on the "save seed from this plant" path.
//
// WHY THESE RUN THE HANDLER rather than scanning its source, unlike most files in this directory:
// the assertion that matters is positional. A column name present in the list proves nothing if its
// binding sits in the wrong slot — that is a data-corruption bug, not a missing-feature bug, and no
// regex over the source can see it. `bindingFor()` below reads the column list and the bound values
// as the two halves of one contract and checks they line up.
//
// The gate is the /source-plant route's, copied. sow-routes.test.js executes THAT copy against the
// real source; these cases execute this one through the handler. Both must pass — a fix applied to
// one gate and not the other reds exactly one of the two files, which is the point.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const VARIETY = 'd58b5155-0c23-4365-bfad-30549b8ca069';
const OWNED_PLANT = '3f9c1e64-1a2b-4c3d-8e4f-5a6b7c8d9e01';
const FOREIGN_PLANT = '3f9c1e64-1a2b-4c3d-8e4f-5a6b7c8d9e02';

const post = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: '/api/inventory-items',
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

// The minimum a seeds row can legally be created with. variety_id is not optional garnish:
// chk_inventory_seed_requires_variety (live, verified) is `category <> 'seeds' OR variety_id IS NOT
// NULL`, and validateCreate mirrors it — a seed packet without one never reaches the INSERT.
const seedPacket = (extra = {}) => ({
  name: 'Green Flesh Honeydew',
  type: 'consumable',
  category: 'seeds',
  unit: 'packet',
  quantity_on_hand: 1,
  variety_id: VARIETY,
  ...extra,
});

// The value bound to a NAMED column of the INSERT, resolved by position rather than by searching
// the values array. The stub builds text as `strings.join('?')`, so the Nth '?' carries the Nth
// value; the parenthesised column list holds no placeholders, so column index === value index.
// This is what makes a column/values misalignment visible: `toContain(OWNED_PLANT)` would pass just
// as happily with the id bound into the `condition` slot.
const bindingFor = (call, column) => {
  const cols = call.text.slice(
    call.text.indexOf('INSERT INTO inventory_items (') + 'INSERT INTO inventory_items ('.length,
    call.text.indexOf(') VALUES ('),
  );
  // Bound the slice — an unmatched marker yields -1 and would silently read from the wrong offset.
  expect(cols.length, 'column list must be found and non-trivial').toBeGreaterThan(100);
  const names = cols.split(',').map((s) => s.trim()).filter(Boolean);
  const idx = names.indexOf(column);
  expect(idx, `${column} must appear in the INSERT column list`).toBeGreaterThan(-1);
  // The two lists must be the same length or index alignment is meaningless.
  const placeholders = (call.text.slice(call.text.indexOf(') VALUES (')).match(/\?/g) ?? []).length;
  expect(placeholders, 'one binding per column').toBe(names.length);
  return call.values[idx];
};

let warn;

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  // The ownership probe answers "owned" for OWNED_PLANT and nothing for anything else; the INSERT
  // answers with a created row. Keyed off the SQL text because both statements go through one stub.
  stubState.sqlHandler = (text, values) => {
    if (text.includes('FROM public.garden_node')) {
      return values[0] === OWNED_PLANT ? [{ id: OWNED_PLANT }] : [];
    }
    return [{ id: 'new-item', source_plant_id: values[values.length - 1] ?? null }];
  };
  // warnRejectedFk writes to console.warn; spied so the refusal is asserted rather than just noisy.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('BUG-SEEDPOSTDROPSPARENT-001 — creating a seed lot with a parent plant', () => {
  it('names source_plant_id in the INSERT and binds the id to that column', async () => {
    // The headline. Before the fix this returned 201 with the field absent from the statement
    // entirely, which is indistinguishable from success at every layer the client can see.
    const { status } = parse(await handler(post(seedPacket({ source_plant_id: OWNED_PLANT }))));
    expect(status).toBe(201);
    const insert = stubState.sqlCalls.find((c) => c.text.includes('INSERT INTO inventory_items'));
    expect(insert, 'the INSERT must have run').toBeTruthy();
    expect(bindingFor(insert, 'source_plant_id')).toBe(OWNED_PLANT);
  });

  it('writes NULL when the client never mentions the key — absence is not an error on a create', async () => {
    // Deliberately unlike the PATCH route, which 400s an unmentioned key. That route exists only to
    // set this column; POST creates every category of inventory and almost nothing has a parent.
    const { status } = parse(await handler(post(seedPacket())));
    expect(status).toBe(201);
    expect(stubState.sqlCalls).toHaveLength(1);
    expect(bindingFor(stubState.sqlCalls[0], 'source_plant_id')).toBeNull();
    // …and no ownership query was issued for a null. The gate must not cost a round trip on the
    // overwhelmingly common path.
    expect(stubState.sqlCalls[0].text).toContain('INSERT INTO inventory_items');
  });

  it('REFUSES a plant the household does not own — 400, and the row is never created', async () => {
    // The arm that matters: an ungated create is a cross-household FK write plus a read leak
    // through every surface that later joins the parent for its name.
    const { status, body } = parse(await handler(post(seedPacket({ source_plant_id: FOREIGN_PLANT }))));
    expect(status).toBe(400);
    expect(body.error).toBe('source_plant_id does not match a planting you can use');
    // No existence oracle — the caller must not learn whether the row exists.
    expect(body.error).not.toMatch(/not found|exists/i);
    // Exactly one statement ran: the ownership probe. The INSERT did not.
    expect(stubState.sqlCalls).toHaveLength(1);
    expect(stubState.sqlCalls[0].text).toContain('FROM public.garden_node');
    // Server-side observability for the refusal.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('authz-fk-reject');
    expect(String(warn.mock.calls[0][0])).toContain('source_plant_id');
  });

  it('probes garden_node with the id and the household bound as parameters, live rows only', async () => {
    await handler(post(seedPacket({ source_plant_id: OWNED_PLANT })));
    const probe = stubState.sqlCalls[0];
    const t = probe.text.replace(/\s+/g, ' ');
    expect(t).toMatch(/FROM public\.garden_node/i);
    expect(t).toMatch(/created_by = ANY\(\?\)/);
    expect(t).toMatch(/deleted_at IS NULL/i);
    // Order as well as presence: id first, household second, both bound, never interpolated.
    expect(probe.values).toEqual([OWNED_PLANT, [USER]]);
  });

  it('refuses a malformed id WITHOUT touching the database', async () => {
    // 22P02 would fall through the handler catch as an opaque 500 — a worse contract than 400 and a
    // weak side channel (500 = "not even a uuid", 400 = "valid uuid, but not yours").
    const { status } = parse(await handler(post(seedPacket({ source_plant_id: 'not-a-uuid' }))));
    expect(status).toBe(400);
    expect(stubState.sqlCalls, 'must short-circuit before issuing SQL').toHaveLength(0);
  });

  it('the gate runs BEFORE the INSERT, not after it', async () => {
    // Ordering is the whole guarantee. A gate that fires after the write refuses a row that already
    // exists, and the 400 then lies about what happened.
    await handler(post(seedPacket({ source_plant_id: OWNED_PLANT })));
    expect(stubState.sqlCalls).toHaveLength(2);
    expect(stubState.sqlCalls[0].text).toContain('FROM public.garden_node');
    expect(stubState.sqlCalls[1].text).toContain('INSERT INTO inventory_items');
  });

  it('rejects a parent plant on a non-seed row before any SQL runs', async () => {
    // The /source-plant route's UPDATE carries `category = 'seeds'`, so without this the create path
    // is the one hole the edit path closes: a shovel born with a parent no route could ever attach.
    const { status, body } = parse(await handler(post({
      name: 'Broadfork', type: 'durable', category: 'tools', quantity: 1,
      source_plant_id: OWNED_PLANT,
    })));
    expect(status).toBe(400);
    expect(body.error).toBe('source_plant_id is only allowed when category is seeds');
    expect(stubState.sqlCalls).toHaveLength(0);
  });
});
