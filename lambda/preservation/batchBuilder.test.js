// V5-BATCHBUILDER-001 (Put-Up B′ release 3) — the batch builder's rules and routes, EXECUTED against a mock
// driver (the kitchenRoutes.test.js pattern: what each route SENDS — text and bound values — is asserted;
// the integration lane, batchbuilder-*.int.test.js, proves what the database does with it).
//
// DAVE and JEN share a household; STRANGER is outside it. Every ownership assertion names two of them.
import { describe, it, expect } from 'vitest';
import { handleKitchenRoute } from './kitchenRoutes.js';
import {
  validateFromJars, jarStageDate, nextTimeLines, madeCountError, planFromJarsStages, closeWhenOf, usedVia, dayInstant,
} from './batchBuilder.js';
import { rankHits, matchTier, resolvedCropOf } from './lineSearch.js';
import { lineError } from './kitchenLines.js';

const HOUSEHOLD = ['user_dave', 'user_jen'];
const STRANGER = ['user_stranger'];
const DAVE = 'user_dave';
const JEN = 'user_jen';
const K = '11111111-1111-4222-8333-444444444444';
const K2 = '22222222-1111-4222-8333-444444444444';
const JAR = 'cccccccc-1111-2222-3333-444444444444';
const JAR_B = 'cccccccc-2222-2222-3333-444444444444';
const DRAWN = 'cccccccc-3333-2222-3333-444444444444';
const PLANT = 'dddddddd-1111-2222-3333-444444444444';
const ITEM = 'eeeeeeee-1111-2222-3333-444444444444';
const BATCH = 'aaaaaaaa-1111-2222-3333-444444444444';

function mockSql(queue = []) {
  const calls = [];
  const fn = (strings, ...values) => {
    const text = strings.raw.join(' ? ');
    calls.push({ text, norm: text.replace(/\s+/g, ' ').trim(), values });
    if (!queue.length) return Promise.reject(new Error(`unexpected extra query: ${text.replace(/\s+/g, ' ').slice(0, 90)}`));
    const next = queue.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  fn.batches = [];
  fn.transaction = async (qs) => { fn.batches.push(calls.slice(calls.length - qs.length)); return Promise.all(qs); };
  fn.calls = calls;
  return fn;
}
const err = (code, constraint) => Object.assign(new Error(code), { code, constraint });
const route = (path, method, body, { householdIds = HOUSEHOLD, userId = DAVE, query = {} } = {}) => ({
  rawPath: path, method, rawBody: body == null ? null : JSON.stringify(body), query, userId, householdIds,
});
const bound = (c, ids) => c.values.some((v) => Array.isArray(v) && v.length === ids.length && ids.every((x) => v.includes(x)));
const FROM = '/api/kitchen-batches/from-jars';
const body = (over = {}) => ({
  idempotency_key: K, label: 'Megatron plain', started: { date: '2026-09-01', precision: 'day' }, jar_ids: [JAR], ...over,
});
const jarRow = (over = {}) => ({
  id: JAR, batch_id: null, harvest_log_id: null, deleted_at: null, preserved_at: '2026-09-08',
  preserved_at_precision: 'day', preserved_at_approx: false, package_count: 2, remaining_count: 2, quantity_unit: 'fl oz',
  notes: 'Oct 8 · Next time: more carrot\nlabel says 6 months', ...over,
});
// getBatch's four reads after the write: the view row, the lines, the stages, the jars.
const DETAIL = [[{ id: BATCH, label: 'Megatron plain', shu_est_basis: null }], [], [], []];

// ── the pure rules ────────────────────────────────────────────────────────────────────────────────
describe('validateFromJars (V4 §5.1 from-jars body)', () => {
  it('accepts the minimal body', () => expect(validateFromJars(body())).toBeNull());
  it.each([
    [{ idempotency_key: 'x' }, /idempotency_key must be a uuid/],
    [{ label: ' ' }, /label is required/],
    [{ label: 'x'.repeat(121) }, /at most 120/],
    [{ started: null }, /started must be/],
    [{ started: { date: null, precision: 'day' } }, /started.date is required/],
    [{ started: { date: '2026-09-01', precision: 'unknown' } }, /carries no date/],
    [{ started: { date: 'soon', precision: 'day' } }, /must be a date/],
    [{ started: { date: '2026-09-01', precision: 'after' } }, /started.precision must be one of/],
    [{ kind: 'brew' }, /kind must be one of/],
    [{ kind_other: 'vinegar' }, /kind_other only applies/],
    [{ jar_ids: [] }, /non-empty array/],
    [{ jar_ids: ['nope'] }, /must all be uuids/],
    [{ inputs: [{ input_kind: 'put_up', preservation_log_id: JAR }] }, /came from this batch cannot also have gone into it/],
    [{ inputs: [{ input_kind: 'other', label: 'x', put_up_stage_id: BATCH }] }, /send no put_up_stage_id/],
    [{ inputs: [{ input_kind: 'other', label: 'x', idempotency_key: K }] }, /its own idempotency_key/],
    [{ inputs: [{ input_kind: 'put_up', preservation_log_id: DRAWN }, { input_kind: 'put_up', preservation_log_id: DRAWN }] }, /named twice/],
    [{ made_count: 0 }, /made_count must be a whole number/],
    [{ made_count: 3, jar_ids: [JAR, JAR_B] }, /exactly one jar/],
    [{ next_time: 5 }, /next_time must be text/],
    [{ surprise: 1 }, /unknown field/],
    [{ user_id: 'user_jen' }, /unknown field/],
  ])('%o → refused', (over, want) => expect(validateFromJars(body(over))).toMatch(want));
});

describe('the jars\' date as stage rows (V4 §3.6: one vocabulary, two words differ by table)', () => {
  it.each([
    [{ preserved_at: '2026-09-08', preserved_at_precision: 'day' }, { entered_at: '2026-09-08T16:00:00.000Z', entered_precision: 'day' }],
    [{ preserved_at: '2026-09-01', preserved_at_precision: 'month' }, { entered_at: '2026-09-01T16:00:00.000Z', entered_precision: 'month' }],
    [{ preserved_at: '2026-09-01', preserved_at_precision: 'after' }, { entered_at: null, entered_precision: 'unknown' }],
    [{ preserved_at: '2026-09-01', preserved_at_precision: 'unknown' }, { entered_at: null, entered_precision: 'unknown' }],
    [{ preserved_at: '2026-09-01', preserved_at_precision: null, preserved_at_approx: false }, { entered_at: '2026-09-01T16:00:00.000Z', entered_precision: 'day' }],
    [{ preserved_at: '2026-09-01', preserved_at_precision: null, preserved_at_approx: true }, { entered_at: null, entered_precision: 'unknown' }],
  ])('%o', (jar, want) => expect(jarStageDate(jar)).toEqual(want));

  it('stage plan: started (the sheet), put_up and finished (the jars), one noted per Next time line', () => {
    let n = 0;
    const rows = planFromJarsStages({
      startedAt: '2026-09-01T16:00:00.000Z', startPrecision: 'day',
      jarDate: { entered_at: '2026-09-08T16:00:00.000Z', entered_precision: 'day' }, notes: ['a', 'b'], newId: () => `id${++n}`,
    });
    expect(rows.map((r) => [r.kind, r.at, r.precision, r.note])).toEqual([
      ['started', '2026-09-01T16:00:00.000Z', 'day', null],
      ['put_up', '2026-09-08T16:00:00.000Z', 'day', null],
      ['finished', '2026-09-08T16:00:00.000Z', 'day', null],
      ['noted', null, 'exact', 'a'], ['noted', null, 'exact', 'b'],
    ]);
  });

  it('a bare day is 16:00Z (the same calendar day in ET all year)', () => {
    expect(dayInstant('2026-01-15')).toBe('2026-01-15T16:00:00.000Z');
    expect(dayInstant('2026-01-15T05:00:00.000Z')).toBe('2026-01-15T05:00:00.000Z');
  });
});

describe('Next time… lines and made_count', () => {
  it('reads every notes line that says next time, as written, once', () => {
    expect(nextTimeLines('Oct 8 · Next time: more carrot\nfine\nnext time less salt\nOct 8 · Next time: more carrot')).toEqual([
      'Oct 8 · Next time: more carrot', 'next time less salt',
    ]);
    expect(nextTimeLines(null)).toEqual([]);
  });
  it('raises only: a lower count is refused, a weighed bag has none', () => {
    expect(madeCountError({ package_count: 2, quantity_unit: 'fl oz' }, 6)).toBeNull();
    expect(madeCountError({ package_count: 2, quantity_unit: 'fl oz' }, 2)).toBeNull();
    expect(madeCountError({ package_count: 4, quantity_unit: 'jar' }, 3)).toMatchObject({ status: 409, code: 'made_count_lower' });
    expect(madeCountError({ package_count: 1, quantity_unit: 'g' }, 3)).toMatchObject({ status: 400, code: 'jar_weighed' });
  });
  it('used via', () => {
    expect([usedVia(true, false), usedVia(false, true), usedVia(true, true), usedVia(false, false)]).toEqual(['garden', 'jar', 'both', null]);
  });
});

describe('the close sheet\'s When (A make with nothing kept)', () => {
  it('absent → null (the shipped now()); a date → its instant; Not sure → no date', () => {
    expect(closeWhenOf({ outcome: 'consumed' })).toBeNull();
    expect(closeWhenOf({ when: { date: '2026-10-09', precision: 'day' } })).toEqual({ at: '2026-10-09T16:00:00.000Z', precision: 'day' });
    expect(closeWhenOf({ when: { date: null, precision: 'unknown' } })).toEqual({ at: null, precision: 'unknown' });
    expect(closeWhenOf({ when: { date: null, precision: 'day' } }).error).toMatch(/when.date is required/);
  });

  it('POST /:id/close binds the When on the finished row; a malformed When is a 400 before any write', async () => {
    const sql = mockSql([[{ id: BATCH, closed_at: null }], [], [{ closed_count: 1, linked_count: 0 }], [{ id: BATCH }]]);
    const res = await handleKitchenRoute({ sql, ...route(`/api/kitchen-batches/${BATCH}/close`, 'POST', { outcome: 'given_away', when: { date: '2026-10-09', precision: 'day' } }) });
    expect(res.status).toBe(200);
    const w = sql.calls.find((c) => c.norm.includes("'finished'::text"));
    expect(w.norm).toContain('INSERT INTO kitchen_stage_log (batch_id, stage_kind, cue_observed, entered_at, entered_precision, created_by)');
    expect(w.values).toContain('2026-10-09T16:00:00.000Z');
    expect(w.values).toContain('day');
    const bad = mockSql([[{ id: BATCH, closed_at: null }]]);
    expect((await handleKitchenRoute({ sql: bad, ...route(`/api/kitchen-batches/${BATCH}/close`, 'POST', { outcome: 'consumed', when: { precision: 'day' } }) })).status).toBe(400);
    expect(bad.calls).toHaveLength(1);
  });

  it('with no When the finished row keeps the shipped now() and no precision', async () => {
    const sql = mockSql([[{ id: BATCH, closed_at: null }], [], [{ closed_count: 1, linked_count: 0 }], [{ id: BATCH }]]);
    await handleKitchenRoute({ sql, ...route(`/api/kitchen-batches/${BATCH}/close`, 'POST', { outcome: 'consumed' }) });
    const w = sql.calls.find((c) => c.norm.includes("'finished'::text"));
    expect(w.norm).toContain('CASE WHEN ? ::boolean THEN ? ::timestamptz ELSE now() END');
    const at = w.values.indexOf(false);
    expect(w.values.slice(at, at + 3)).toEqual([false, null, null]);
  });
});

// ── POST /api/kitchen-batches/from-jars ──────────────────────────────────────────────────────────
describe('POST /api/kitchen-batches/from-jars', () => {
  it('is a literal matched before any :id — no batch ownership gate runs; only POST', async () => {
    const sql = mockSql();
    expect((await handleKitchenRoute({ sql, ...route(FROM, 'GET') })).status).toBe(405);
    expect(sql.calls).toHaveLength(0);
  });

  it('ONE statement in the actor transaction: lock → closed keyed batch → stages → lines → draws → link', async () => {
    const sql = mockSql([[], [jarRow()], [], [{ created: 1, linked_count: 1 }], ...DETAIL]);
    const res = await handleKitchenRoute({ sql, ...route(FROM, 'POST', body({ next_time: 'less salt' })) });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(BATCH);
    expect(sql.batches).toHaveLength(1);
    const [guc, w] = sql.batches[0];
    expect(guc.norm).toContain("set_config('app.actor_clerk_sub'");
    const s = w.norm;
    for (const cte of ['WITH locked AS (', 'FOR UPDATE ), b AS ( INSERT INTO kitchen_batch', '), st AS ( INSERT INTO kitchen_stage_log',
      '), ins AS ( INSERT INTO kitchen_batch_input', '), moved AS ( UPDATE preservation_log', '), uses AS ( INSERT INTO pantry_use',
      '), linked AS ( UPDATE preservation_log p SET batch_id = b.id']) expect(s).toContain(cte);
    // All or nothing: the batch exists only when EVERY chosen jar was locked, and everything hangs off it.
    expect(s).toContain('WHERE (SELECT count(*) FROM locked) = ? ::int');
    expect(s).toContain("? ::uuid, now(), 'put_up'::text");
    // Jars existed before this batch: linked by batch_id only — never put_up_stage_id (Undo would delete them).
    const linked = s.slice(s.indexOf('linked AS ('));
    expect(linked.slice(0, linked.indexOf('RETURNING'))).not.toContain('put_up_stage_id');
    // And never their where-from.
    for (const col of ['source_kind', 'source_label', 'plant_id =', 'crop_type_slug =', 'variety_id']) {
      expect(linked.slice(0, linked.indexOf('RETURNING'))).not.toContain(col);
    }
    expect(bound(w, HOUSEHOLD)).toBe(true);
    // The stage rows, and the jar's Next time line copied in beside the typed one.
    expect(w.values).toContainEqual(['started', 'put_up', 'finished', 'noted', 'noted']);
    expect(w.values).toContainEqual([null, null, null, 'Oct 8 · Next time: more carrot', 'less salt']);
    expect(w.values).toContainEqual(['2026-09-01T16:00:00.000Z', '2026-09-08T16:00:00.000Z', '2026-09-08T16:00:00.000Z', null, null]);
    expect(w.values).toContain(K);
    expect(w.values).toContain(DAVE);
  });

  it('JEN writes it as JEN (user_id is the caller, never the body)', async () => {
    const sql = mockSql([[], [jarRow()], [], [{ created: 1 }], ...DETAIL]);
    const res = await handleKitchenRoute({ sql, ...route(FROM, 'POST', body(), { userId: JEN }) });
    expect(res.status).toBe(201);
    expect(sql.batches[0][1].values).toContain(JEN);
    expect(sql.batches[0][1].values).not.toContain(DAVE);
  });

  it('STRANGER: a jar outside the household is the same 400 as a malformed one, and nothing is written', async () => {
    const sql = mockSql([[], []]);
    const res = await handleKitchenRoute({ sql, ...route(FROM, 'POST', body(), { householdIds: STRANGER, userId: 'user_stranger' }) });
    expect(res).toEqual({ status: 400, body: { error: 'jar_ids must name put-ups you can use', code: 'jar_not_found' } });
    expect(bound(sql.calls[1], STRANGER)).toBe(true);
    expect(sql.batches).toHaveLength(0);
  });

  it('a removed jar reads as not found', async () => {
    const sql = mockSql([[], [jarRow({ deleted_at: '2026-09-20T00:00:00Z' })]]);
    expect((await handleKitchenRoute({ sql, ...route(FROM, 'POST', body()) })).body.code).toBe('jar_not_found');
  });

  it.each([
    [{ batch_id: BATCH }, 409, 'jar_has_batch'],
    [{ harvest_log_id: BATCH }, 409, 'jar_from_harvest'],
  ])('refused: %o → %i %s', async (over, status, code) => {
    const sql = mockSql([[], [jarRow(over)]]);
    const res = await handleKitchenRoute({ sql, ...route(FROM, 'POST', body()) });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(sql.batches).toHaveLength(0);
  });

  it('made_count raises package_count and pins what was left; lower → 409, weighed → 400', async () => {
    let sql = mockSql([[], [jarRow()], [], [{ created: 1 }], ...DETAIL]);
    expect((await handleKitchenRoute({ sql, ...route(FROM, 'POST', body({ made_count: 6 })) })).status).toBe(201);
    const s = sql.batches[0][1].norm;
    expect(s).toContain('package_count = CASE WHEN p.id = ? ::uuid AND ? ::int IS NOT NULL THEN GREATEST(p.package_count, ? ::int)');
    expect(s).toContain('remaining_count = CASE WHEN p.id = ? ::uuid AND ? ::int IS NOT NULL THEN COALESCE(p.remaining_count, p.package_count)');
    expect(sql.batches[0][1].values).toContain(6);
    sql = mockSql([[], [jarRow({ package_count: 8 })]]);
    expect((await handleKitchenRoute({ sql, ...route(FROM, 'POST', body({ made_count: 6 })) })).body.code).toBe('made_count_lower');
    sql = mockSql([[], [jarRow({ package_count: 1, quantity_unit: 'g' })]]);
    expect((await handleKitchenRoute({ sql, ...route(FROM, 'POST', body({ made_count: 6 })) })).status).toBe(400);
  });

  it('replay: the key already names a household batch → 200 replayed, before any jar check', async () => {
    const sql = mockSql([[{ id: BATCH }], ...DETAIL]);
    const res = await handleKitchenRoute({ sql, ...route(FROM, 'POST', body()) });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(bound(sql.calls[0], HOUSEHOLD)).toBe(true);
    expect(sql.calls[0].norm).toContain('WHERE idempotency_key = ? ::uuid AND user_id = ANY( ? ) AND deleted_at IS NULL');
  });

  it('a 23505 on the batch key: ours → replay; someone else\'s → 409 key_conflict', async () => {
    let sql = mockSql([[], [jarRow()], [], err('23505', 'uq_kitchen_batch_idempotency_key'), [{ id: BATCH }], ...DETAIL]);
    expect((await handleKitchenRoute({ sql, ...route(FROM, 'POST', body()) })).body.replayed).toBe(true);
    sql = mockSql([[], [jarRow()], [], err('23505', 'uq_kitchen_batch_idempotency_key'), []]);
    expect((await handleKitchenRoute({ sql, ...route(FROM, 'POST', body()) })).body.code).toBe('key_conflict');
  });

  it('a jar linked by someone else between the read and the lock → 409 jar_has_batch (nothing written)', async () => {
    const sql = mockSql([[], [jarRow()], [], [{ created: 0, linked_count: 0 }]]);
    const res = await handleKitchenRoute({ sql, ...route(FROM, 'POST', body()) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('jar_has_batch');
  });

  it('lines go through the shared line loaders (household-bound); a draw over what is left → 409 only_n_left', async () => {
    const draw = { input_kind: 'put_up', preservation_log_id: DRAWN, count_drawn: 5 };
    const jarDrawn = { id: DRAWN, deleted_at: null, package_count: 3, remaining_count: 3, consumed_at: null, quantity_unit: 'lb', label: 'Carrots' };
    const sql = mockSql([[], [jarRow()], [jarDrawn], [], err('23514', 'chk_preservation_log_remaining_count'), [{ id: DRAWN, left_n: 3 }]]);
    const res = await handleKitchenRoute({ sql, ...route(FROM, 'POST', body({ inputs: [draw] })) });
    expect(res).toMatchObject({ status: 409, body: { code: 'only_n_left', n: 3 } });
    expect(bound(sql.calls[2], HOUSEHOLD)).toBe(true);
  });

  it('a pantry line in What went in is loaded household-scoped and written with its pantry_item_id', async () => {
    const line = { input_kind: 'pantry', pantry_item_id: ITEM };
    const sql = mockSql([[], [jarRow()], [{ id: ITEM, name: 'Onions', crop_type_slug: 'onion', plant_id: null }], [], [{ created: 1 }], ...DETAIL]);
    expect((await handleKitchenRoute({ sql, ...route(FROM, 'POST', body({ inputs: [line] })) })).status).toBe(201);
    const load = sql.calls[2];
    // The loader is pantryItems.js's (the pantry-server lane): it returns removed items too, and
    // prepareLines refuses one with 409 item_removed.
    expect(load.norm).toContain('FROM pantry_item i WHERE i.id = ANY( ? ::uuid[]) AND i.user_id = ANY( ? )');
    expect(bound(load, HOUSEHOLD)).toBe(true);
    const w = sql.batches[0][1];
    expect(w.values).toContainEqual([ITEM]);
    expect(w.values).toContainEqual(['Onions']);
    expect(w.values).toContainEqual(['onion']);
  });
});

// ── pantry lines on the keyed line POST (V4 §5.1 row 3 POST /:id/inputs) ─────────────────────────
describe('POST /:id/inputs — a pantry line', () => {
  const P = `/api/kitchen-batches/${BATCH}/inputs`;
  it('rules: a pantry line names its item; only a pantry line carries one', () => {
    expect(lineError({ input_kind: 'pantry', idempotency_key: K })).toMatch(/names its item/);
    expect(lineError({ input_kind: 'other', label: 'x', pantry_item_id: ITEM, idempotency_key: K })).toMatch(/only a pantry line/);
    expect(lineError({ input_kind: 'pantry', pantry_item_id: 'nope', idempotency_key: K })).toMatch(/must be a uuid/);
    expect(lineError({ input_kind: 'pantry', pantry_item_id: ITEM, idempotency_key: K })).toBeNull();
  });

  it('a foreign (STRANGER-owned) item is a 400 and nothing is written', async () => {
    const sql = mockSql([[{ id: BATCH, closed_at: null }], [], []]);
    const res = await handleKitchenRoute({ sql, ...route(P, 'POST', { inputs: [{ input_kind: 'pantry', pantry_item_id: ITEM, idempotency_key: K2 }] }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match one you can use/);
    expect(sql.batches).toHaveLength(0);
  });

  it('the INSERT binds pantry_item_id beside every other line column', async () => {
    const sql = mockSql([[{ id: BATCH, closed_at: null }], [], [{ id: ITEM, name: 'Onions', crop_type_slug: null, plant_id: PLANT }],
      [], [{ inserted: 1 }], [{ id: 'l1', pantry_item_id: ITEM }]]);
    const res = await handleKitchenRoute({ sql, ...route(P, 'POST', { inputs: [{ input_kind: 'pantry', pantry_item_id: ITEM, idempotency_key: K2 }] }) });
    expect(res.status).toBe(201);
    const w = sql.batches[0][1];
    expect(w.norm).toContain('created_by, pantry_item_id )');
    expect(w.values).toContainEqual([ITEM]);
    // readLines reads it back, and a "Fresh, as picked" item counts as from the garden.
    const read = sql.calls[sql.calls.length - 1].norm;
    expect(read).toContain("OR (i.input_kind = 'pantry' AND COALESCE(i.plant_id, pit.plant_id) IS NOT NULL)");
    expect(read).toContain('LEFT JOIN pantry_item pit ON pit.id = i.pantry_item_id');
  });

  it('a bottling refuses a pantry line (its INSERT carries no pantry_item_id)', async () => {
    const { validatePutUp } = await import('./putUp.js');
    const e = validatePutUp({
      idempotency_key: K, when: { date: '2026-09-01', precision: 'day' }, method: 'hot_sauce', finish: true,
      rows: [{ count: 1, place: { kind: 'fridge', label: 'Fridge' }, added_lines: [{ input_kind: 'pantry', pantry_item_id: ITEM }] }],
    });
    expect(e).toMatch(/a bought item goes in What went in/);
  });
});

// ── GET /api/kitchen-batches?plant_id= ───────────────────────────────────────────────────────────
describe('GET /api/kitchen-batches?plant_id= — the planting read', () => {
  const Q = (plant_id, householdIds = HOUSEHOLD) => route('/api/kitchen-batches', 'GET', null, { householdIds, query: { plant_id } });

  it('a malformed id is 404 without a query; a foreign planting (STRANGER) is 404 after the scoped gate', async () => {
    let sql = mockSql();
    expect((await handleKitchenRoute({ sql, ...Q('nope') })).status).toBe(404);
    expect(sql.calls).toHaveLength(0);
    sql = mockSql([[]]);
    expect((await handleKitchenRoute({ sql, ...Q(PLANT, STRANGER) })).status).toBe(404);
    expect(bound(sql.calls[0], STRANGER)).toBe(true);
    expect(sql.calls).toHaveLength(1);
  });

  it('lists batches that used it directly or through stock, and what is kept fresh — household-bound, a list', async () => {
    const sql = mockSql([
      [{ id: PLANT }],
      [{ id: BATCH, label: 'Megatron mash', used_direct: true, used_indirect: false, single_planting: true, output_ids: [JAR],
        next_time: [{ id: 's1', note: 'more carrot', entered_at: '2026-09-09T00:00:00Z' }] }],
      [{ id: ITEM, name: 'Jalapeños', place_label: 'Fridge', notes: 'Next time: pick earlier', used_up_at: null }],
    ]);
    const res = await handleKitchenRoute({ sql, ...Q(PLANT) });
    expect(res.status).toBe(200);
    expect(res.body.batches[0]).toMatchObject({ id: BATCH, used_via: 'garden', single_planting: true, output_ids: [JAR] });
    expect(res.body.batches[0]).not.toHaveProperty('used_direct');
    expect(res.body.kept_fresh[0].next_time).toEqual(['Next time: pick earlier']);
    for (const c of sql.calls) expect(bound(c, HOUSEHOLD), c.norm.slice(0, 60)).toBe(true);
    const s = sql.calls[1].norm;
    expect(s).toContain("i.input_kind IN ('garden', 'harvest')");
    expect(s).toContain("JOIN preservation_log jar ON jar.id = i.preservation_log_id WHERE jar.plant_id = ? ::uuid AND i.deleted_at IS NULL AND i.input_kind = 'put_up'");
    expect(s).toContain("JOIN pantry_item it ON it.id = i.pantry_item_id WHERE it.plant_id = ? ::uuid AND i.deleted_at IS NULL AND i.input_kind = 'pantry'");
    expect(s).toContain('AND NOT EXISTS (SELECT 1 FROM kitchen_stage_log x WHERE x.voids_id = n.id)');
    expect(s).toContain('WHERE v.user_id = ANY( ? ) AND v.deleted_at IS NULL');
    expect(s).not.toMatch(/\bsum\(|\bavg\(|percent/i);
  });

  it('without plant_id the list route is unchanged', async () => {
    const sql = mockSql([[]]);
    const res = await handleKitchenRoute({ sql, ...route('/api/kitchen-batches', 'GET', null, { query: { state: 'all' } }) });
    expect(res.body).toEqual({ state: 'all', batches: [] });
  });
});

// ── the name search ranking (V4 §2.5a) ───────────────────────────────────────────────────────────
describe('line search ranking — exact, starts-with, contains; live, ended, what we have, crops/varieties; ties most recent', () => {
  it('matchTier', () => {
    expect(matchTier('pepper', ['Pepper'])).toBe('exact');
    expect(matchTier('pep', ['Pepper mash'])).toBe('starts');
    expect(matchTier('mash', ['Pepper mash'])).toBe('contains');
    expect(matchTier('zz', ['Pepper'])).toBeNull();
    expect(matchTier('megatron', ['Row 3', 'Megatron'])).toBe('exact');
  });

  it('orders one list by tier, then group, then recency', () => {
    const hits = rankHits('jal', {
      plantings: [
        { plant_id: 'p-old', label: 'Jalapeño old', ended: true, recent_at: '2025-05-01' },
        { plant_id: 'p-live', label: 'Jalapeño', ended: false, recent_at: '2026-05-01' },
        { plant_id: 'p-contains', label: 'Big jalapeño', ended: false, recent_at: '2026-06-01' },
      ],
      put_ups: [
        { preservation_log_id: 'j-new', label: 'Jalapeño bag', recent_at: '2026-09-01' },
        { preservation_log_id: 'j-old', label: 'Jalapeño bag', recent_at: '2025-09-01' },
      ],
      pantry_items: [{ pantry_item_id: 'i1', label: 'Jalapeños (store)', recent_at: '2026-09-20' }],
      crops: [{ crop_type_slug: 'jal', label: 'Jal' }],
      varieties: [{ variety_id: 'v1', label: 'Jalafuego' }],
    });
    expect(hits.map((h) => h.key)).toEqual([
      'crop:jal',                                   // exact beats every starts-with
      'planting:p-live', 'planting:p-old',          // starts: live, then ended
      'pantry:i1', 'jar:j-new', 'jar:j-old',        // then what we have, newest first
      'variety:v1',                                 // then crops and varieties
      'planting:p-contains',                        // contains, last
    ]);
    expect(hits[0]).toMatchObject({ kind: 'crop', tier: 'exact', group: 'catalog' });
  });

  it('a planting matches through its variety name too; a row matching no name is dropped', () => {
    const hits = rankHits('megatron', { plantings: [{ plant_id: 'p', label: 'Row 3', variety_name: 'Megatron' }], crops: [{ crop_type_slug: 'x', label: 'Pepper' }] });
    expect(hits.map((h) => [h.key, h.tier])).toEqual([['planting:p', 'exact']]);
  });

  it('resolved crop: an exact whole-name variety match to ONE crop, else none', () => {
    expect(resolvedCropOf('Megatron', [{ label: 'Megatron', crop_type_slug: 'pepper' }, { label: 'Megatronic', crop_type_slug: 'tomato' }])).toBe('pepper');
    expect(resolvedCropOf('Sunrise', [{ label: 'Sunrise', crop_type_slug: 'pepper' }, { label: 'sunrise', crop_type_slug: 'tomato' }])).toBeNull();
    expect(resolvedCropOf('onion', [])).toBeNull();
  });

  it('the route asks five arms, each household-scoped where the household owns it, and ranks them', async () => {
    const sql = mockSql([
      [{ plant_id: PLANT, label: 'Megatron', ended: false, recent_at: '2026-05-01', recent_picks: [] }],
      [], [{ pantry_item_id: ITEM, label: 'Megatron salsa', recent_at: '2026-09-01' }], [],
      [{ variety_id: 'v1', label: 'Megatron', crop_type_slug: 'pepper' }],
    ]);
    const res = await handleKitchenRoute({ sql, ...route('/api/kitchen-batches/line-search', 'GET', null, { householdIds: STRANGER, query: { q: 'Megatron' } }) });
    expect(res.body.hits.map((h) => h.key)).toEqual(['planting:' + PLANT, 'variety:v1', 'pantry:' + ITEM]);
    expect(res.body.resolved_crop).toBe('pepper');
    for (const i of [0, 1, 2, 4]) expect(bound(sql.calls[i], STRANGER), `arm ${i}`).toBe(true);
    expect(sql.calls[2].norm).toContain('AND pit.deleted_at IS NULL AND pit.used_up_at IS NULL');
    expect(sql.calls[3].norm).toContain('FROM crop_types ct');
  });
});
