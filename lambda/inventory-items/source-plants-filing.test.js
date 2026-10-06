// V5-SEEDMULTIPARENT-001 (release 2a) — `filing` on PUT /api/inventory-items/:id/source-plants:
// re-filing a lot in the SAME transaction that changes its parent set. Driven through the handler.
//
// WHY IT RIDES THE SET ROUTE AT ALL. A jar that gains a second variety has to move to the mix of the
// two (the parent rules refuse the set otherwise — blend_required). Done as two requests, the first
// to land would be refused or would leave the jar mis-filed if the second failed. So the caller
// sends both, and they commit or roll back together:
//   { source_plant_ids, filing: { variety_id, expect_variety_id, name? } }
//   200 = release 1's { id, source_plant_id, source_plants } plus, ONLY because `filing` was sent,
//         filing: { variety_id, variety_name, variety_rank, name, changed, previous: { variety_id, name } }.
//
// ONE RULE, ONE STATEMENT, TWO DOORS. The body rule, the judge and the UPDATE are
// seed-lot-filing.js's — the ones PUT /:id/filing places (seed-lot-filing.test.js). This file shows
// the set route places THOSE, not copies, and what it answers for each verdict.
//
// THE STUB EXECUTES NO SQL. "A refused re-file refuses the whole edit" is, in Postgres, the held
// verdict stopping four writes; here it is the stub handing back an empty cache RETURNING. What is
// proved is that the filing's judge runs before the first write and narrows the same verdict every
// write reads, and what the route says for each outcome. The lane report names the real-database
// cases: a refused filing leaves the set untouched, and a refused set leaves the filing untouched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const uuid = (n) => `3f9c1e64-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);
const ALASKA = uuid(101);
const JEWEL = uuid(102);
const MIX = uuid(103);
const OTHER = uuid(104);
const MIX_KEY = `${ALASKA},${JEWEL}`;

const req = (method, suffix, body, id = LOT) => ({
  requestContext: { http: { method } },
  rawPath: `/api/inventory-items/${id}/${suffix}`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const put = (body, id) => req('PUT', 'source-plants', body, id);
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

// `file` before `cache`, `filed` before `read`... each by something only it says.
const IS = {
  rules: (t) => /AS rules_hold/.test(t),
  judge: (t) => /AS previous_variety_id/.test(t),
  pfacts: (t) => /AS lot_found/.test(t),
  mix: (t) => /AND fv\.blend_key = \?\s*$/.test(t),
  owns: (t) => /FROM public\.garden_node p\s+WHERE p\.id = ANY\(\?::uuid\[\]\)\s+AND p\.created_by = ANY/.test(t),
  members: (t) => /SELECT k\.plant_id AS id/.test(t),
  lock: (t) => /FOR UPDATE/.test(t),
  hold: (t) => /FOR SHARE/.test(t),
  facts: (t) => /AS live_parents/.test(t),
  retire: (t) => /UPDATE public\.seed_lot_parent_planting l/.test(t),
  add: (t) => /INSERT INTO public\.seed_lot_parent_planting/.test(t),
  file: (t) => /SET variety_id = /.test(t),
  cache: (t) => /UPDATE public\.inventory_items i/.test(t),
  filed: (t) => /pv\.variety_rank, i\.name/.test(t),
  read: (t) => /jsonb_agg/.test(t),
};
const kindOf = (t) => Object.keys(IS).find((k) => IS[k](t)) ?? 'other';
const kinds = () => stubState.sqlCalls.map((c) => kindOf(c.text));
const find = (k) => stubState.sqlCalls.find((c) => kindOf(c.text) === k);
const WRITES = ['retire', 'add', 'cache', 'file'];

const parent = (id, name, variety) => ({
  id, name, variety_id: variety, variety_name: name, breeding_system: 'open_pollinated',
  variety_rank: 'cultivar', crop_slug: 'nasturtium', archived: false, deleted: false,
});
const JAR = [parent(A, 'Alaska Mix', ALASKA), parent(B, 'Jewel Mix', JEWEL)];
const JUDGED = { verdict: 'write', previous_variety_id: ALASKA, previous_name: 'Nasturtium 2026', go: 'go' };
const FILED = { id: LOT, variety_id: MIX, variety_name: 'Alaska Mix + Jewel Mix', variety_rank: 'blend', name: 'Nasturtium 2026' };

// A lot filed under Alaska with A as its parent; the edit adds B (a Jewel) and re-files to the mix.
const world = (over = {}) => (text, values) => {
  const k = kindOf(text);
  if (k in over) return typeof over[k] === 'function' ? over[k](values) : over[k];
  return {
    owns: () => values[0].map((id) => ({ id })),
    members: () => [],
    pfacts: () => [
      { id: A, cultivar_id: ALASKA, crop_slug: 'nasturtium', blend_key: null, member: true, lot_found: true, lot_variety_id: ALASKA },
      { id: B, cultivar_id: JEWEL, crop_slug: 'nasturtium', blend_key: null, member: false, lot_found: true, lot_variety_id: ALASKA },
    ].filter((r) => values[0].includes(r.id)),
    mix: () => [{ id: MIX }],
    lock: () => [{ id: LOT }],
    hold: () => values[0].map((id) => ({ id })),
    facts: () => [{ id: LOT, source_kind: null, source_plant_id: A, live_parents: 1, ids_usable: true, set_as_expected: true, go: 'go' }],
    rules: () => [{ rules_hold: true, go: 'go' }],
    judge: () => [JUDGED],
    retire: () => [],
    add: () => [],
    cache: () => [{ id: LOT, source_plant_id: A }],
    file: () => [{ id: LOT }],
    read: () => [{ inventory_item_id: LOT, source_plants: JAR }],
    filed: () => [FILED],
    other: () => [],
  }[k]();
};
const given = (over) => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = world(over);
};
const FILING = { variety_id: MIX, expect_variety_id: ALASKA };
const LOT_CHANGED = 'This seed lot was changed at the same moment. Reload and try again.';

beforeEach(() => {
  given();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('filing inside the set route — the write', () => {
  it('adds the parent AND re-files the lot, and answers both', async () => {
    const res = parse(await handler(put({ source_plant_ids: [A, B], filing: FILING })));
    expect(res.status).toBe(200);
    // Release 1's three keys, then `filing` — exactly the contract's shape.
    expect(res.body).toEqual({
      id: LOT, source_plant_id: A, source_plants: JAR,
      filing: {
        variety_id: MIX, variety_name: 'Alaska Mix + Jewel Mix', variety_rank: 'blend', name: 'Nasturtium 2026',
        changed: true, previous: { variety_id: ALASKA, name: 'Nasturtium 2026' },
      },
    });
  });

  it('places the filing\'s statements in the set\'s own list: judged before the first write, written after the cache', async () => {
    await handler(put({ source_plant_ids: [A, B], filing: FILING }));
    // Before the transaction: the gate, the rules' read, and — the set spans two varieties — the mix
    // check against the variety THIS request files the lot under. Then eleven statements.
    expect(kinds()).toEqual([
      'owns', 'pfacts', 'mix',
      'lock', 'hold', 'facts', 'rules', 'judge', 'retire', 'add', 'cache', 'file', 'read', 'filed',
    ]);
    expect(find('mix').values).toEqual([MIX, [USER], MIX_KEY]);
  });

  it('answers NO `filing` key when none was sent — release 1\'s reply, key for key', async () => {
    given({ mix: [{ id: ALASKA }] });
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['id', 'source_plant_id', 'source_plants']);
    for (const k of ['judge', 'file', 'filed']) expect(kinds(), k).not.toContain(k);
  });

  it('null is ABSENT, like the route\'s other optional keys', async () => {
    given({ mix: [{ id: ALASKA }] });
    const res = parse(await handler(put({ source_plant_ids: [A, B], filing: null })));
    expect(res.status).toBe(200);
    expect(res.body.filing).toBeUndefined();
    expect(kinds()).not.toContain('judge');
  });

  it('the UPDATE it places IS the filing route\'s, statement for statement', async () => {
    await handler(put({ source_plant_ids: [A, B], filing: { ...FILING, name: 'Nasturtium mix 2026' } }));
    const inSetRoute = { file: find('file'), filed: find('filed'), judge: find('judge') };
    given();
    const alone = parse(await handler(req('PUT', 'filing', { ...FILING, name: 'Nasturtium mix 2026' })));
    expect(alone.status).toBe(200);
    // Same text, same bindings: there is one UPDATE and one read-back, placed twice.
    expect(find('file').text).toBe(inSetRoute.file.text);
    expect(find('file').values).toEqual(inSetRoute.file.values);
    expect(find('file').values).toEqual([MIX, 'Nasturtium mix 2026', LOT, [USER], MIX]);
    expect(find('filed').text).toBe(inSetRoute.filed.text);
    expect(find('filed').values).toEqual(inSetRoute.filed.values);
    // The judge is the same statement too; only two bindings differ, and they are the point: here
    // it starts the verdict and reads the stored parents, there it narrows one and reads the new set.
    expect(find('judge').text).toBe(inSetRoute.judge.text);
    expect(find('judge').values).toEqual([true, MIX, ALASKA, [USER], false, [], false, MIX, LOT, [USER]]);
    expect(inSetRoute.judge.values).toEqual([false, MIX, ALASKA, [USER], true, [A, B], true, MIX, LOT, [USER]]);
    // …and the two routes answer the filing the same way.
    given();
    const viaSet = parse(await handler(put({ source_plant_ids: [A, B], filing: { ...FILING, name: 'Nasturtium mix 2026' } })));
    const { id: _id, ...filingAlone } = alone.body;
    expect(viaSet.body.filing).toEqual(filingAlone);
  });

  it('every write reads ONE held verdict, and the filing\'s judge can only narrow it', async () => {
    await handler(put({ source_plant_ids: [A, B], filing: FILING }));
    const GO = "current_setting('app.seed_lot_go', true) = 'go'";
    for (const k of WRITES) expect(find(k).text.split(GO), k).toHaveLength(2);
    const order = kinds();
    for (const judge of ['facts', 'rules', 'judge']) {
      expect(order.indexOf(judge), judge).toBeGreaterThan(order.indexOf('hold'));
      expect(order.indexOf(judge), judge).toBeLessThan(order.indexOf('retire'));
    }
    // `alone` bound false on both judges that follow the facts.
    for (const k of ['rules', 'judge']) {
      const c = find(k);
      const at = c.text.indexOf('AND (') + 'AND ('.length;
      expect(c.values[(c.text.slice(0, at).match(/\?/g) ?? []).length], k).toBe(false);
    }
  });

  it('a one-planting set can be re-filed too: no rules judge, the filing\'s three statements', async () => {
    const res = parse(await handler(put({ source_plant_ids: [A], filing: FILING })));
    expect(res.status).toBe(200);
    expect(kinds()).toEqual(['owns', 'lock', 'hold', 'facts', 'judge', 'retire', 'add', 'cache', 'file', 'read', 'filed']);
    expect(res.body.filing.changed).toBe(true);
  });

  it('clearing the parents while re-filing: the crop is judged against NO parents, not the stored ones', async () => {
    given({ cache: [{ id: LOT, source_plant_id: null }], read: [] });
    const res = parse(await handler(put({ source_plant_ids: [], filing: FILING })));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source_plant_id: null, source_plants: [] });
    // "of this write" true with an empty set — the stored-parents arm is switched off.
    expect(find('judge').values.slice(4, 7)).toEqual([true, [], true]);
  });

  it('already filed there: the set is written, the filing is not, and changed says so', async () => {
    given({ judge: [{ verdict: 'same', previous_variety_id: MIX, previous_name: 'Nasturtium 2026', go: 'go' }], file: [] });
    const res = parse(await handler(put({ source_plant_ids: [A, B], filing: { variety_id: MIX, expect_variety_id: MIX } })));
    expect(res.status).toBe(200);
    expect(res.body.source_plants).toEqual(JAR);
    expect(res.body.filing).toMatchObject({ variety_id: MIX, changed: false, previous: { variety_id: MIX, name: 'Nasturtium 2026' } });
  });

  it('rides beside an expectation and a cache hint', async () => {
    given({ cache: [{ id: LOT, source_plant_id: B }] });
    const res = parse(await handler(put({
      source_plant_ids: [A, B], expected_source_plant_ids: [A], source_plant_id: B, filing: FILING,
    })));
    expect(res.status).toBe(200);
    expect(res.body.source_plant_id).toBe(B);
    expect(res.body.filing.changed).toBe(true);
  });
});

describe('filing inside the set route — what is refused', () => {
  const refusedBy = (verdict, judged = {}) => given({
    judge: [{ ...JUDGED, verdict, go: 'stop', ...judged }],
    cache: [], file: [],                                    // nothing written: the verdict was stop
    read: [{ inventory_item_id: LOT, source_plants: [JAR[0]] }],
  });

  it('400s a malformed filing before any SQL — the filing route\'s own messages', async () => {
    const cases = [
      ['x', 'variety_id and expect_variety_id are required'],
      [[FILING], 'variety_id and expect_variety_id are required'],
      [{}, 'variety_id must be the id of the variety to file this seed under'],
      [{ variety_id: MIX }, 'expect_variety_id must be the id of the variety this seed is filed under now'],
      [{ variety_id: MIX, expect_variety_id: 'nope' }, 'expect_variety_id must be the id of the variety this seed is filed under now'],
      [{ ...FILING, name: '' }, 'name must not be blank when it is sent'],
    ];
    for (const [filing, message] of cases) {
      given();
      // eslint-disable-next-line no-await-in-loop
      const res = parse(await handler(put({ source_plant_ids: [A, B], filing })));
      expect(res.status, JSON.stringify(filing)).toBe(400);
      expect(res.body).toEqual({ error: message });
      expect(stubState.sqlCalls, JSON.stringify(filing)).toHaveLength(0);
    }
  });

  it('409 lot_changed when someone else re-filed it — the SET and the FILING as they stand, nothing written', async () => {
    refusedBy('changed', { previous_variety_id: OTHER, previous_name: 'Renamed jar' });
    const res = parse(await handler(put({ source_plant_ids: [A, B], filing: FILING })));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: LOT_CHANGED, code: 'lot_changed',
      source_plant_id: A, source_plants: [JAR[0]],
      variety_id: OTHER, name: 'Renamed jar',
    });
  });

  it('400 variety_unusable, and 400 filing_crop_mismatch — the edit is refused with the filing', async () => {
    refusedBy('unusable');
    let res = parse(await handler(put({ source_plant_ids: [A, B], filing: FILING })));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'That variety is not available any more. Pick another one.', code: 'variety_unusable' });
    refusedBy('crop');
    res = parse(await handler(put({ source_plant_ids: [A, B], filing: FILING })));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'That variety is a different crop from the plants this seed came from.', code: 'filing_crop_mismatch',
    });
    // Neither is a success in any part.
    expect(res.body.source_plants).toBeUndefined();
    expect(res.body.filing).toBeUndefined();
  });

  it('a stale SET is reported first, and still carries the filing as stored', async () => {
    given({
      facts: [{ id: LOT, source_kind: null, source_plant_id: A, live_parents: 1, ids_usable: true, set_as_expected: false, go: 'stop' }],
      judge: [{ ...JUDGED, verdict: 'unusable', go: 'stop' }],
      cache: [], file: [], read: [{ inventory_item_id: LOT, source_plants: [JAR[0]] }],
    });
    const res = parse(await handler(put({ source_plant_ids: [A, B], expected_source_plant_ids: [B], filing: FILING })));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: LOT_CHANGED, code: 'lot_changed', source_plant_id: A, source_plants: [JAR[0]],
      variety_id: ALASKA, name: 'Nasturtium 2026',
    });
  });

  it('the set\'s own refusals outrank the filing\'s: an unusable planting, then the rules, then the re-file', async () => {
    const stop = { judge: [{ ...JUDGED, verdict: 'unusable', go: 'stop' }], cache: [], file: [], read: [] };
    given({ ...stop, facts: [{ id: LOT, source_kind: null, source_plant_id: A, live_parents: 1, ids_usable: false, set_as_expected: true }] });
    expect(parse(await handler(put({ source_plant_ids: [A, B], filing: FILING }))).body.code).toBe('parents_changed');
    given({ ...stop, rules: [{ rules_hold: false, go: 'stop' }] });
    expect(parse(await handler(put({ source_plant_ids: [A, B], filing: FILING }))).body.code).toBe('parents_changed');
    given(stop);
    expect(parse(await handler(put({ source_plant_ids: [A, B], filing: FILING }))).body.code).toBe('variety_unusable');
  });

  it('a filing cannot buy a way round the ownership gate or the rules\' fast path', async () => {
    given({ owns: [{ id: A }] });
    let res = parse(await handler(put({ source_plant_ids: [A, B], filing: FILING })));
    expect(res.body).toEqual({ error: 'source_plant_ids does not match plantings you can use' });
    expect(kinds()).not.toContain('judge');
    // Filed under something that is NOT the mix of the two varieties: blend_required, nothing locked.
    given({ mix: [] });
    res = parse(await handler(put({ source_plant_ids: [A, B], filing: { variety_id: OTHER, expect_variety_id: ALASKA } })));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Seed from more than one variety is filed under a mix of those varieties.',
      code: 'blend_required', component_variety_ids: [ALASKA, JEWEL],
    });
    expect(find('mix').values[0]).toBe(OTHER);
    expect(kinds()).not.toContain('lock');
  });

  it('a lot that is not the caller\'s is a 404 with a filing as without one', async () => {
    given({ pfacts: [], lock: [], facts: [], judge: [], cache: [], file: [], read: [], filed: [] });
    // (pfacts answers no row with lot_found, so the rules do not judge a lot they cannot see.)
    stubState.sqlHandler = world({
      pfacts: (values) => values[0].map((id) => ({ id, cultivar_id: ALASKA, crop_slug: 'nasturtium', blend_key: null, member: false, lot_found: false, lot_variety_id: null })),
      lock: [], facts: [], judge: [], cache: [], file: [], read: [], filed: [],
    });
    const res = parse(await handler(put({ source_plant_ids: [A, B], filing: FILING })));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('the LEGACY route ignores a filing key entirely: it never places the filing\'s statements', async () => {
    stubState.sqlHandler = (text, values) => (
      /FROM public\.garden_node p\s+WHERE p\.id = \?/.test(text) ? [{ id: values[0] }] : world()(text, values));
    const res = parse(await handler(req('PATCH', 'source-plant', { source_plant_id: A, filing: FILING })));
    expect(res.status).toBe(200);
    expect(res.body.filing).toBeUndefined();
    for (const k of ['judge', 'file', 'filed']) expect(kinds(), k).not.toContain(k);
    for (const c of stubState.sqlCalls) expect(JSON.stringify(c.values)).not.toContain(MIX);
  });
});
