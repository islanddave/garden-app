// V5-SEEDMULTIPARENT-001 (release 2a) — two guards on the wide PUT /api/inventory-items/:id, both
// about `variety_id`, both judged on the STORED row. Driven through the handler.
//
// 1. A LOT WITH A PARENT KEEPS ITS STORED VARIETY (still 200).
//    Every caller of this verb round-trips a row it read earlier, so `variety_id` is present in the
//    body and carries whatever the lot was filed under when that row was read. Release 2 introduces
//    re-filing (PUT /:id/filing): a lot moved to a mix, then saved from a page that loaded before the
//    move, would be filed straight back — on a 200. A client-side strip cannot fix a bundle that is
//    already installed (regression seat R2-11), so the server stops assigning the column when the
//    stored row names a parent plant. A bought packet has no parent and is assigned as before.
//
// 2. A ROW THAT NAMES A VARIETY STAYS IN SEEDS (400 with a sentence).
//    Nothing in the schema says so. Until now the body-only validator said it by accident: every
//    client echoed variety_id, and validateUpdate refuses that key on a non-seeds category. A client
//    that stops echoing it would sail through and leave a tool row holding a variety — which every
//    later +/- tap on that row then trips over (R2-10).
//
// THE STUB EXECUTES NO SQL, and both guards are SQL: a CASE condition on a stored column, and a
// conjunct in the UPDATE's WHERE. So the stub is told what the statement "did" (a row, or none) and
// what is proved is the statement's text and bindings and what the route answers for each. That the
// CASE really keeps the stored variety of a parented row, and that the WHERE really holds back a
// non-seeds write, are real-database cases in the lane report (one each, plus the plain packet that
// must still be editable).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler, validateUpdate } = await import('./index.js');

const USER = 'user_stub_owner';
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const uuid = (n) => `3f9c1e64-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;
const PARENT = uuid(1);
const STALE = uuid(101);    // what the caller's stale row says the lot is filed under
const MIX = uuid(103);      // what it is actually filed under now

const put = (body, id = LOT) => ({
  requestContext: { http: { method: 'PUT' } },
  rawPath: `/api/inventory-items/${id}`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const IS = {
  update: (t) => /UPDATE inventory_items SET/.test(t),
  parents: (t) => /jsonb_agg/.test(t),
  held: (t) => /SELECT 1 FROM inventory_items/.test(t) && /variety_id IS NOT NULL/.test(t),
};
const kindOf = (t) => Object.keys(IS).find((k) => IS[k](t)) ?? 'other';
const kinds = () => stubState.sqlCalls.map((c) => kindOf(c.text));
const find = (k) => stubState.sqlCalls.find((c) => kindOf(c.text) === k);
// The statement as Postgres reads it: the wide PUT carries long `--` comments between its clauses,
// and the stub records them with the rest of the text.
const sqlOf = (call) => call.text.split('\n')
  .map((l) => l.replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n').replace(/\s+/g, ' ');
const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};

// What the edit form sends for a seed row (InventoryDetail's buildChanges), and for a tool.
const seedEdit = (extra = {}) => ({
  name: 'Nasturtium 2026', type: 'consumable', category: 'seeds', status: 'active', unit: 'packet', quantity_on_hand: 1, ...extra,
});
const toolEdit = (extra = {}) => ({ name: 'Broadfork', type: 'durable', category: 'tools', status: 'active', quantity: 1, ...extra });

const world = (over = {}) => (text, values) => {
  const k = kindOf(text);
  if (k in over) return typeof over[k] === 'function' ? over[k](values) : over[k];
  return {
    // A saved lot with one parent, filed under the mix.
    update: () => [{ id: LOT, name: 'Nasturtium 2026', category: 'seeds', variety_id: MIX, source_plant_id: PARENT, variety_rank: 'blend' }],
    parents: () => [],
    held: () => [],
    other: () => [],
  }[k]();
};
const given = (over) => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = world(over);
};

beforeEach(() => {
  given();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('wide PUT — a lot with a parent keeps the variety it is filed under', () => {
  it('assigns variety_id ONLY when the key was sent AND the stored row names no parent plant', async () => {
    await handler(put(seedEdit({ variety_id: STALE })));
    const update = find('update');
    expect(sqlOf(update)).toContain(
      'variety_id = CASE WHEN ?::boolean AND source_plant_id IS NULL THEN ? ELSE variety_id END,');
    // Both halves of the condition, and they are different KINDS of thing: the first is about the
    // BODY (bound), the second about the ROW AS STORED (a bare column — no binding can stand in for
    // it, and nothing in this statement assigns that column, so it is the value before this write).
    expect(boundAfter(update, /variety_id = CASE\s+WHEN /)).toBe(true);
    expect(boundAfter(update, /AND source_plant_id IS NULL THEN /)).toBe(STALE);
    expect(update.text).not.toMatch(/source_plant_id\s*=(?!=)/);
  });

  it('answers 200 with the STORED variety when a stale row tries to file a parented lot back', async () => {
    // The caller's row says STALE; the lot was re-filed to MIX since. The statement kept MIX (the
    // stub answers as Postgres would for a row whose source_plant_id is set), and the route reports
    // what the row holds — it does not echo the body, and it is not an error.
    const res = parse(await handler(put(seedEdit({ variety_id: STALE, source_plant_id: PARENT }))));
    expect(res.status).toBe(200);
    expect(res.body.variety_id).toBe(MIX);
    expect(res.body.variety_rank).toBe('blend');
    expect(res.body.name).toBe('Nasturtium 2026');
  });

  it('a PLAIN PACKET — no parent — is still editable: the same statement, the body\'s variety bound to it', async () => {
    given({ update: [{ id: LOT, name: 'True Greek Oregano', category: 'seeds', variety_id: STALE, source_plant_id: null, variety_rank: 'cultivar' }] });
    const res = parse(await handler(put(seedEdit({ name: 'True Greek Oregano', variety_id: STALE }))));
    expect(res.status).toBe(200);
    expect(res.body.variety_id).toBe(STALE);
    expect(boundAfter(find('update'), /AND source_plant_id IS NULL THEN /)).toBe(STALE);
  });

  it('leaves the variety alone, as before, when the key is not sent at all', async () => {
    const res = parse(await handler(put(seedEdit())));
    expect(res.status).toBe(200);
    expect(boundAfter(find('update'), /variety_id = CASE\s+WHEN /)).toBe(false);
    expect(boundAfter(find('update'), /AND source_plant_id IS NULL THEN /)).toBeNull();
  });

  it('PUT /:id/filing is therefore the only way to re-file a saved lot: no other key here reaches the column', async () => {
    await handler(put(seedEdit({ variety_id: STALE, filing: { variety_id: STALE, expect_variety_id: MIX } })));
    const update = find('update');
    expect(update.text.match(/\bvariety_id\s*=\s*CASE\b/g)).toHaveLength(1);
    // STALE is bound exactly once — to that guarded arm.
    expect(update.values.filter((v) => v === STALE)).toHaveLength(1);
    expect(kinds()).toEqual(['update', 'parents']);
  });

  it('still cannot write a lot\'s parents or its plant count', async () => {
    await handler(put(seedEdit({ source_plant_ids: [PARENT], source_plant_id: PARENT, seed_parent_plant_count: 6 })));
    const update = find('update');
    expect(update.text).not.toMatch(/seed_parent_plant_count/);
    expect(JSON.stringify(update.values)).not.toContain(PARENT);
    expect(update.values).not.toContain(6);
  });
});

describe('wide PUT — a row that names a variety stays in Seeds', () => {
  const SENTENCE = 'This item is filed under a seed variety, so it has to stay in Seeds.';
  // The guard's one binding: the placeholder that opens `(… OR variety_id IS NULL)`.
  const GUARD = /AND \((?=\?::boolean OR variety_id IS NULL\))/;

  it('carries the rule in the UPDATE\'s own WHERE, judged on the stored row', async () => {
    await handler(put(seedEdit()));
    const update = find('update');
    expect(sqlOf(update)).toContain(
      'WHERE id = ? AND created_by = ANY(?) AND deleted_at IS NULL AND (?::boolean OR variety_id IS NULL) RETURNING *');
    // A seeds body: the guard is satisfied by the body alone.
    expect(boundAfter(update, GUARD)).toBe(true);
  });

  it('binds FALSE for every body that is not exactly seeds — another category, null, or none', async () => {
    for (const body of [toolEdit(), toolEdit({ category: 'other' }), { ...seedEdit(), category: null }, (({ category, ...rest }) => rest)(seedEdit())]) {
      given({ update: [{ id: LOT, category: body.category ?? null }] });
      // eslint-disable-next-line no-await-in-loop
      await handler(put(body));
      expect(boundAfter(find('update'), GUARD), JSON.stringify(body.category)).toBe(false);
    }
  });

  it('400s, with a sentence, a body that leaves Seeds while the stored row names a variety', async () => {
    // The UPDATE matched nothing (its WHERE held the row back) and the row IS there, holding a variety.
    given({ update: [], held: [{ '?column?': 1 }] });
    const res = parse(await handler(put({ ...seedEdit(), category: 'tools' })));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: SENTENCE });
    // A sentence for the person: no constraint, no column.
    expect(res.body.error).not.toMatch(/chk_|variety_id|category\b|constraint/i);
    // Exactly the write and the one read that tells the two reasons apart. No parents echo: the
    // body is not a seeds row.
    expect(kinds()).toEqual(['update', 'held']);
  });

  it('that read is scoped exactly as the UPDATE is — the caller\'s live row — so nothing leaks through the 400', async () => {
    given({ update: [], held: [{ '?column?': 1 }] });
    await handler(put({ ...seedEdit(), category: 'tools' }));
    const held = find('held');
    expect(held.text.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT 1 FROM inventory_items WHERE id = ? AND created_by = ANY(?) AND deleted_at IS NULL AND variety_id IS NOT NULL');
    expect(held.values).toEqual([LOT, [USER]]);
    expect(held.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('404s, as before, when there is simply no such row', async () => {
    // Absent, foreign or deleted: the read finds nothing either, and the answer is the old one.
    given({ update: [], held: [] });
    const res = parse(await handler(put(toolEdit())));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(kinds()).toEqual(['update', 'held']);
  });

  it('a SEEDS body that matches nothing is a plain 404 with no extra read — the guard could not have been why', async () => {
    given({ update: [] });
    const res = parse(await handler(put(seedEdit())));
    expect(res.status).toBe(404);
    expect(kinds()).toEqual(['update', 'parents']);
    expect(kinds()).not.toContain('held');
  });

  it('the write that SUCCEEDS is still one round trip: a tool edit issues one statement', async () => {
    // The +/- tap on /inventory, the highest-frequency write in the app. The extra read exists only
    // on the path where nothing matched.
    given({ update: [{ id: LOT, name: 'Broadfork', category: 'tools', variety_id: null }] });
    const res = parse(await handler(put(toolEdit())));
    expect(res.status).toBe(200);
    expect(kinds()).toEqual(['update']);
  });

  it('a malformed id is not sent to that read', async () => {
    given({ update: [] });
    const res = parse(await handler(put(toolEdit(), 'not-a-uuid')));
    expect(res.status).toBe(404);
    expect(kinds()).toEqual(['update']);
  });

  it('holds on the STORED variety whatever the body says about it — an explicit null does not buy the move', async () => {
    // Deliberately strict (R2A-CONTRACT: "refused ... while the stored row has a variety_id"). The
    // body-only validator lets `variety_id: null` beside a non-seeds category through, as it always
    // has; the stored-row guard is what answers it now.
    expect(validateUpdate({ ...seedEdit(), category: 'tools', variety_id: null })).toBeNull();
    given({ update: [], held: [{ '?column?': 1 }] });
    const res = parse(await handler(put({ ...seedEdit(), category: 'tools', variety_id: null })));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: SENTENCE });
  });

  it('the fast path is unchanged: a body that ECHOES the variety with a non-seeds category never reaches SQL', async () => {
    const res = parse(await handler(put({ ...seedEdit(), category: 'tools', variety_id: STALE })));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'variety_id is only allowed when category is seeds' });
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('a parented lot moved out of Seeds is still answered by its own CHECK\'s sentence when that fires first', async () => {
    // chk_inventory_source_plant_seeds_only raises from the UPDATE itself; the catch block maps it.
    given({ update: () => { throw Object.assign(new Error('check'), { code: '23514', constraint: 'chk_inventory_source_plant_seeds_only' }); } });
    const res = parse(await handler(put({ ...seedEdit(), category: 'tools' })));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Saved from/);
  });
});

describe('wide PUT — its 200 carries the filed variety\'s rank', () => {
  it('reads it in RETURNING, off the row as the statement left it', async () => {
    const res = parse(await handler(put(seedEdit())));
    expect(sqlOf(find('update'))).toMatch(
      /RETURNING \*, \(SELECT pv\.variety_rank FROM public\.cultivar pv WHERE pv\.id = inventory_items\.variety_id\) AS variety_rank\s*$/);
    expect(res.body.variety_rank).toBe('blend');
    // Not a second statement and not a join that could drop the row: the save is one UPDATE.
    expect(kinds().filter((k) => k === 'update')).toHaveLength(1);
  });
});
