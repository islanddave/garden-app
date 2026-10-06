// V5-SEEDMULTIPARENT-001 (release 2a) — the PARENT RULES at the two doors that can add a parent:
// POST /api/inventory-items (a lot born with several) and PUT /api/inventory-items/:id/source-plants
// (the set route). Driven through the handler.
//
// WHAT IS ASSERTED HERE, for each rule and each door:
//   • the 400, its `code`, and the detail a client needs (plant_id, component_variety_ids);
//   • that it is refused BEFORE anything is locked or written — no lot INSERT, no lot lock;
//   • that it comes AFTER the ownership gate, so a planting the caller cannot use is never described;
//   • that a removal-only request, and a one-planting request, are never put to the rules at all;
//   • that the same rules, failing INSIDE the transaction, answer 409 parents_changed.
// The cells themselves — every combination of variety, crop and membership — are the pure function's,
// in seed-lot-rules.test.js. This file varies the stub's ANSWER to the rules' read; it does not
// re-derive the rule.
//
// THE STUB EXECUTES NO SQL. Its `pfacts` arm is the rules' read answered by hand, so "the read
// reports B as already a parent" is something this file SAYS, not something it shows the statement
// doing. That the statement reports it, and that the judge inside the transaction reaches the same
// verdict under its locks, are the integration lane's (the lane report lists each case).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const uuid = (n) => `3f9c1e64-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);
const C = uuid(3);
// Varieties, numbered so uuid order is ALASKA < JEWEL < MIX < CARMEN.
const ALASKA = uuid(101);
const JEWEL = uuid(102);
const MIX = uuid(103);
const CARMEN = uuid(104);
const MIX_KEY = `${ALASKA},${JEWEL}`;

const req = (method, path, body) => ({
  requestContext: { http: { method } }, rawPath: path,
  headers: { authorization: 'Bearer stub-token' }, body: JSON.stringify(body),
});
const put = (body, id = LOT) => req('PUT', `/api/inventory-items/${id}/source-plants`, body);
const post = (body) => req('POST', '/api/inventory-items', {
  name: 'Mixed nasturtium', type: 'consumable', category: 'seeds', unit: 'packet', quantity_on_hand: 1,
  variety_id: ALASKA, ...body,
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const IS = {
  rules: (t) => /AS rules_hold/.test(t),
  pfacts: (t) => /AS lot_found/.test(t),
  mix: (t) => /AND fv\.blend_key = \?\s*$/.test(t),
  owns: (t) => /FROM public\.garden_node p\s+WHERE p\.id = ANY\(\?::uuid\[\]\)\s+AND p\.created_by = ANY/.test(t),
  members: (t) => /SELECT k\.plant_id AS id/.test(t),
  lot: (t) => /INSERT INTO inventory_items \(/.test(t),
  lock: (t) => /FOR UPDATE/.test(t),
  hold: (t) => /FOR SHARE/.test(t),
  facts: (t) => /AS live_parents/.test(t),
  retire: (t) => /UPDATE public\.seed_lot_parent_planting l/.test(t),
  link: (t) => /INSERT INTO public\.seed_lot_parent_planting/.test(t),
  assert: (t) => /AS every_parent_linked/.test(t),
  cache: (t) => /UPDATE public\.inventory_items i/.test(t),
  read: (t) => /jsonb_agg/.test(t),
};
const kindOf = (t) => Object.keys(IS).find((k) => IS[k](t)) ?? 'other';
const kinds = () => stubState.sqlCalls.map((c) => kindOf(c.text));
const find = (k) => stubState.sqlCalls.find((c) => kindOf(c.text) === k);
// Everything that locks or writes. A refusal by the rules must leave every one of these un-issued.
const TOUCHES = ['lot', 'lock', 'hold', 'facts', 'rules', 'retire', 'link', 'assert', 'cache'];
const touched = () => kinds().filter((k) => TOUCHES.includes(k));

// One row of the rules' read. `lot` is whether the caller's live seed lot was found (always false on
// a create) and what it is filed under.
const fact = (id, cultivar_id, crop_slug, extra = {}) => ({
  id, cultivar_id, crop_slug, blend_key: null, member: false, lot_found: true, lot_variety_id: ALASKA, ...extra,
});
const onCreate = (rows) => rows.map((r) => ({ ...r, lot_found: false, lot_variety_id: null }));

const world = (over = {}) => (text, values) => {
  const k = kindOf(text);
  if (k in over) return typeof over[k] === 'function' ? over[k](values) : over[k];
  return {
    owns: () => values[0].map((id) => ({ id })),
    members: () => [],
    pfacts: () => values[0].map((id) => fact(id, ALASKA, 'nasturtium')),
    mix: () => [],
    lot: () => [{ id: values[0], name: 'Mixed nasturtium', category: 'seeds' }],
    lock: () => [{ id: LOT }],
    hold: () => values[0].map((id) => ({ id })),
    facts: () => [{ id: LOT, source_kind: null, source_plant_id: A, live_parents: 1, ids_usable: true, set_as_expected: true, go: 'go' }],
    rules: () => [{ rules_hold: true, go: 'go' }],
    retire: () => [],
    link: () => [],
    assert: () => [{ every_parent_linked: 1 }],
    cache: () => [{ id: LOT, source_plant_id: A }],
    read: () => [{ inventory_item_id: LOT, source_plants: [] }],
    other: () => [],
  }[k]();
};
const given = (over) => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = world(over);
};

let warn;
beforeEach(() => {
  given();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// Each door, as a function of the plantings named, so every rule below is asserted at both.
const DOORS = [
  ['PUT /:id/source-plants', (ids, extra = {}) => handler(put({ source_plant_ids: ids, ...extra })), (rows) => rows, 200],
  ['POST /api/inventory-items', (ids, extra = {}) => handler(post({ source_plant_ids: ids, ...extra })), onCreate, 201],
];

for (const [door, send, shape, okStatus] of DOORS) {
  describe(`parent rules — ${door}`, () => {
    it('passes a set of two plantings of ONE variety, having read their varieties once', async () => {
      given({ pfacts: shape([fact(A, ALASKA, 'nasturtium'), fact(B, ALASKA, 'nasturtium')]) });
      const res = parse(await send([A, B]));
      expect(res.status).toBe(okStatus);
      expect(kinds().filter((k) => k === 'pfacts')).toHaveLength(1);
      // One variety: nothing to ask about a mix.
      expect(kinds()).not.toContain('mix');
      // The read is of exactly the plantings named, for the caller's household.
      expect(find('pfacts').values[0]).toEqual([A, B]);
      expect(find('pfacts').values.slice(-1)).toEqual([[USER]]);
    });

    it('parent_without_variety: 400 with the planting\'s id, and nothing locked or written', async () => {
      given({ pfacts: shape([fact(A, ALASKA, 'nasturtium'), fact(B, null, null)]) });
      const res = parse(await send([A, B]));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'One of those plants has no variety yet. Give it a variety first, then add it.',
        code: 'parent_without_variety', plant_id: B,
      });
      expect(touched()).toEqual([]);
      // Worded for the person: no field name, no id in the sentence.
      expect(res.body.error).not.toMatch(/_id\b|variety_id|cultivar|uuid/i);
    });

    it('mixed_crop_parents: 400, and nothing locked or written', async () => {
      given({ pfacts: shape([fact(A, ALASKA, 'nasturtium'), fact(B, CARMEN, 'pepper')]) });
      const res = parse(await send([A, B]));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Seed in one lot has to come from one crop, and those plants are not all the same crop.',
        code: 'mixed_crop_parents',
      });
      expect(touched()).toEqual([]);
      expect(kinds()).not.toContain('mix');
    });

    it('NULL crop is ONE value of its own: two crop-less varieties are one crop, a crop-less one beside a crop is two', async () => {
      // crop-less + crop-less: passes the crop rule (and so goes on to be asked for its mix).
      given({ pfacts: shape([fact(A, ALASKA, null), fact(B, JEWEL, null)]) });
      expect(parse(await send([A, B])).body.code).toBe('blend_required');
      // crop-less + nasturtium: two crops.
      given({ pfacts: shape([fact(A, ALASKA, null), fact(B, JEWEL, 'nasturtium')]) });
      expect(parse(await send([A, B])).body.code).toBe('mixed_crop_parents');
      // one crop-less variety on both plantings: nothing to refuse.
      given({ pfacts: shape([fact(A, ALASKA, null), fact(B, ALASKA, null)]) });
      expect(parse(await send([A, B])).status).toBe(okStatus);
    });

    it('blend_required: a set spanning two varieties, not filed under their mix — 400 with the varieties, nothing written', async () => {
      given({ pfacts: shape([fact(A, JEWEL, 'nasturtium'), fact(B, ALASKA, 'nasturtium')]), mix: [] });
      const res = parse(await send([A, B]));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Seed from more than one variety is filed under a mix of those varieties.',
        code: 'blend_required', component_variety_ids: [ALASKA, JEWEL],
      });
      expect(touched()).toEqual([]);
      // What was asked: is the variety the lot will be filed under a LIVE mix of the HOUSEHOLD,
      // keyed on exactly these two.
      const asked = find('mix');
      expect(asked.text.replace(/\s+/g, ' ')).toContain(
        'WHERE fv.id = ?::uuid AND fv.deleted_at IS NULL AND fv.created_by = ANY(?) AND fv.blend_key = ?');
      expect(asked.values).toEqual([ALASKA, [USER], MIX_KEY]);
    });

    it('…and goes through when the lot IS filed under that mix', async () => {
      given({ pfacts: shape([fact(A, JEWEL, 'nasturtium'), fact(B, ALASKA, 'nasturtium')]), mix: [{ id: MIX }] });
      const res = parse(await send([A, B]));
      expect(res.status).toBe(okStatus);
      expect(kinds().filter((k) => k === 'mix')).toHaveLength(1);
    });

    it('FLATTENS a parent whose variety is an app-made mix: the key asked for is of the leaves', async () => {
      // A's variety is the mix of Alaska and Jewel (it was grown from last year's mixed jar);
      // B is a Carmen of the same crop, for the sake of the cell.
      given({
        pfacts: shape([fact(A, MIX, 'nasturtium', { blend_key: MIX_KEY }), fact(B, CARMEN, 'nasturtium')]),
        mix: [],
      });
      const res = parse(await send([A, B]));
      expect(res.body.code).toBe('blend_required');
      // The components are the varieties AS STORED — the mix itself and Carmen — which is what the
      // client hands the blend route; the key that was looked for is the three leaves.
      expect(res.body.component_variety_ids).toEqual([MIX, CARMEN].sort());
      expect(find('mix').values[2]).toBe(`${ALASKA},${JEWEL},${CARMEN}`);
    });

    it('comes AFTER the ownership gate: a planting the caller cannot use is that gate\'s 400, and is never read here', async () => {
      given({ owns: [{ id: A }], pfacts: shape([fact(A, ALASKA, 'nasturtium'), fact(B, null, null)]) });
      const res = parse(await send([A, B]));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'source_plant_ids does not match plantings you can use' });
      expect(res.body.code).toBeUndefined();
      expect(kinds()).not.toContain('pfacts');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('a ONE-planting request is never put to the rules: no read, whatever that planting is', async () => {
      // A planting with no variety at all is still a legal sole parent — release 1's behaviour, and
      // what the staging smoke's first parent is.
      given({ pfacts: shape([fact(A, null, null)]) });
      const res = parse(await send([A]));
      expect(res.status).toBe(okStatus);
      expect(kinds()).not.toContain('pfacts');
      expect(kinds()).not.toContain('mix');
    });

    it('re-tested INSIDE the transaction: rules that stopped holding under the lock answer 409 parents_changed', async () => {
      // The fast path passed. Between it and the lock a parent's variety was cleared (or the lot was
      // re-filed). The judge says so; nothing is written; the answer is the one a planting that
      // stopped being usable gets — the same news about the same plants.
      given({
        rules: [{ rules_hold: false, go: 'stop' }],
        cache: [],                                                       // set route: the writes refused
        assert: () => { throw Object.assign(new Error('division by zero'), { code: '22012' }); },   // create: the lot is taken back
      });
      const res = parse(await send([A, B]));
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'One of those plants changed just now. Reload and try again.', code: 'parents_changed',
      });
      // The judge ran after the share lock on the plantings and before the link INSERT.
      const order = kinds();
      expect(order.indexOf('hold')).toBeGreaterThan(-1);
      expect(order.indexOf('hold')).toBeLessThan(order.indexOf('rules'));
      expect(order.indexOf('rules')).toBeLessThan(order.indexOf('link'));
    });
  });
}

describe('parent rules — PUT /:id/source-plants only: what depends on the lot', () => {
  it('a REMOVAL-ONLY request is never refused, though every rule is broken by what is left', async () => {
    // The lot had {A, B, C}. A has lost its variety and B is now a pepper. Taking C out must work:
    // it is how a drifted jar gets repaired. Both remaining plantings are already parents.
    given({ pfacts: [fact(A, null, null, { member: true }), fact(B, CARMEN, 'pepper', { member: true })] });
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.status).toBe(200);
    expect(kinds()).not.toContain('mix');
    expect(kinds()).toContain('retire');
  });

  it('a member whose variety was cleared later does not stop ANOTHER planting being added', async () => {
    given({ pfacts: [fact(A, null, null, { member: true }), fact(B, ALASKA, 'nasturtium')] });
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.status).toBe(200);
  });

  it('…but the planting being ADDED still needs a variety of its own', async () => {
    given({ pfacts: [fact(A, ALASKA, 'nasturtium', { member: true }), fact(B, null, null)] });
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'parent_without_variety', plant_id: B });
  });

  it('asks membership of THIS lot, through the caller\'s household', async () => {
    await handler(put({ source_plant_ids: [A, B] }));
    expect(find('pfacts').values).toEqual([[A, B], LOT, [USER], [USER]]);
  });

  it('blend_required reads the STORED variety when the request does not re-file the lot', async () => {
    given({
      pfacts: [fact(A, ALASKA, 'nasturtium', { lot_variety_id: JEWEL }), fact(B, JEWEL, 'nasturtium', { lot_variety_id: JEWEL })],
      mix: [],
    });
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.body.code).toBe('blend_required');
    expect(find('mix').values[0]).toBe(JEWEL);
  });

  it('…and the variety the request files it under when it does: `filing.variety_id`', async () => {
    given({
      pfacts: [fact(A, ALASKA, 'nasturtium'), fact(B, JEWEL, 'nasturtium')],
      mix: [{ id: MIX }],
    });
    await handler(put({ source_plant_ids: [A, B], filing: { variety_id: MIX, expect_variety_id: ALASKA } }));
    expect(find('mix').values).toEqual([MIX, [USER], MIX_KEY]);
    // …and the judge inside the transaction is handed the same target.
    const judge = find('rules');
    const at = judge.text.indexOf('fv.id = COALESCE(') + 'fv.id = COALESCE('.length;
    expect(judge.values[(judge.text.slice(0, at).match(/\?/g) ?? []).length]).toBe(MIX);
  });

  it('a lot that is not the caller\'s live seed lot is not judged: the write answers 404, not a rule', async () => {
    // Absent, foreign, deleted, not seeds — one answer, and no rule in front of it to tell them apart.
    given({
      pfacts: [fact(A, null, null, { lot_found: false, lot_variety_id: null }), fact(B, CARMEN, 'pepper', { lot_found: false, lot_variety_id: null })],
      lock: [], facts: [], cache: [], read: [],
    });
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(kinds()).not.toContain('mix');
  });

  it('a malformed lot id is a 404 before the rules read anything', async () => {
    const res = parse(await handler(put({ source_plant_ids: [A, B] }, 'not-a-uuid')));
    expect(res.status).toBe(404);
    expect(kinds()).toEqual(['owns']);
    for (const c of stubState.sqlCalls) expect(JSON.stringify(c.values)).not.toContain('not-a-uuid');
  });

  it('the LEGACY single-parent route never reaches the rules — one id or none', async () => {
    const patch = (body) => req('PATCH', `/api/inventory-items/${LOT}/source-plant`, body);
    stubState.sqlHandler = (text, values) => (
      /FROM public\.garden_node p\s+WHERE p\.id = \?/.test(text) ? [{ id: values[0] }] : world()(text, values));
    for (const body of [{ source_plant_id: A }, { source_plant_id: null }]) {
      stubState.sqlCalls.length = 0;
      // eslint-disable-next-line no-await-in-loop
      const res = parse(await handler(patch(body)));
      expect(res.status).toBe(200);
      expect(kinds()).not.toContain('pfacts');
      expect(kinds()).not.toContain('rules');
      expect(kinds()).not.toContain('mix');
    }
  });

  it('a three-planting edit that adds one is judged on the whole resulting set', async () => {
    // {A, B} are parents; C, a pepper, is being added to a nasturtium jar.
    given({
      pfacts: [fact(A, ALASKA, 'nasturtium', { member: true }), fact(B, ALASKA, 'nasturtium', { member: true }), fact(C, CARMEN, 'pepper')],
    });
    const res = parse(await handler(put({ source_plant_ids: [A, B, C] })));
    expect(res.body.code).toBe('mixed_crop_parents');
    expect(touched()).toEqual([]);
  });
});

describe('parent rules — POST only: what a create decides differently', () => {
  it('judges the variety the BODY names: a mixed set whose variety_id is the mix is created', async () => {
    given({
      pfacts: onCreate([fact(A, ALASKA, 'nasturtium'), fact(B, JEWEL, 'nasturtium')]),
      mix: [{ id: MIX }],
    });
    const res = parse(await handler(post({ source_plant_ids: [A, B], variety_id: MIX })));
    expect(res.status).toBe(201);
    expect(find('mix').values).toEqual([MIX, [USER], MIX_KEY]);
  });

  it('has no lot to ask about: every planting is being added, and NULL is bound where the lot would be', async () => {
    given({ pfacts: onCreate([fact(A, ALASKA, 'nasturtium'), fact(B, ALASKA, 'nasturtium')]) });
    await handler(post({ source_plant_ids: [A, B] }));
    expect(find('pfacts').values).toEqual([[A, B], null, [USER], [USER]]);
  });

  it('a refused create leaves no lot: the rules run before the INSERT is ever built into a transaction', async () => {
    given({ pfacts: onCreate([fact(A, ALASKA, 'nasturtium'), fact(B, JEWEL, 'nasturtium')]), mix: [] });
    const res = parse(await handler(post({ source_plant_ids: [A, B] })));
    expect(res.status).toBe(400);
    expect(res.body.id).toBeUndefined();
    expect(kinds()).toEqual(['owns', 'pfacts', 'mix']);
  });

  it('the single key beside the set changes nothing about the rules: they judge the set', async () => {
    given({ pfacts: onCreate([fact(A, ALASKA, 'nasturtium'), fact(B, null, null)]) });
    const res = parse(await handler(post({ source_plant_ids: [A, B], source_plant_id: A })));
    expect(res.body).toMatchObject({ code: 'parent_without_variety', plant_id: B });
  });

  it('a create with no parents, or the legacy single key, reads nothing for the rules', async () => {
    for (const body of [{}, { source_plant_ids: [] }, { source_plant_id: A }]) {
      given({ other: (values) => [{ id: values[0] }] });
      stubState.sqlHandler = (text, values) => (
        /FROM public\.garden_node p\s+WHERE p\.id = \?/.test(text) ? [{ id: values[0] }] : world()(text, values));
      // eslint-disable-next-line no-await-in-loop
      const res = parse(await handler(post(body)));
      expect(res.status, JSON.stringify(body)).toBe(201);
      expect(kinds()).not.toContain('pfacts');
      expect(kinds()).not.toContain('mix');
    }
  });
});
