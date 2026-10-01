// Release F — the ferment routes, EXECUTED against a mock driver (the kitchenRoutes.test.js idiom):
// the keyed line POST and its draws, the line PATCH / take-out / restore, the stage PATCH and the
// check-in's acts and pH bounds, the merge PUT's F fields and "No salt", getBatch's F3 shape, the heat
// estimate routes, Remove this batch and Undo that put-up with boss F1's per-jar aggregation, the use
// route and the line search. What each proves is what the handler SENDS and how it answers; that the
// SQL runs and does what it claims is L4's integration lane (kitchen-draw / kitchen-ferment) and this
// lane's own tests/integration/ferment-lambda.int.test.js.
import { describe, it, expect } from 'vitest';
import { handleKitchenRoute } from './kitchenRoutes.js';
import { handlePantryUses, validateUse } from './pantryUses.js';
import { suggestedForm, likePattern } from './lineSearch.js';
import {
  lineError, linesError, inputsForm, drawPlan, linePatchError, stagePatchError, phReadAtError, TAKE_IT_OUT,
} from './kitchenLines.js';
import { etDay } from './useBy.js';

const HOUSEHOLD = ['user_dave', 'user_jen'];
const STRANGER = ['user_stranger'];
const DAVE = 'user_dave';
const BATCH = 'aaaaaaaa-1111-2222-3333-444444444444';
const LINE = 'bbbbbbbb-1111-2222-3333-444444444444';
const JAR = 'cccccccc-1111-2222-3333-444444444444';
const JAR_B = 'cccccccc-2222-2222-3333-444444444444';
const PLANT = 'dddddddd-1111-2222-3333-444444444444';
const PICK = 'eeeeeeee-1111-2222-3333-444444444444';
const STAGE = 'ffffffff-1111-2222-3333-444444444444';
const K1 = '11111111-1111-4222-8333-444444444444';
const K2 = '22222222-1111-4222-8333-444444444444';

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
  fn.transaction = async (qs) => {
    fn.batches.push(calls.slice(calls.length - qs.length));
    return Promise.all(qs);
  };
  fn.calls = calls;
  return fn;
}
const OPEN = [{ id: BATCH, closed_at: null, suspended_at: null, started_at: '2026-09-28T14:00:00Z' }];
const CLOSED = [{ id: BATCH, closed_at: '2026-10-01T00:00:00Z', suspended_at: null, started_at: '2026-09-28T14:00:00Z' }];
const VIEW = [{ id: BATCH, label: 'Petri Dish', shu_est_basis: null }];
const route = (path, method, body, householdIds = HOUSEHOLD, query = {}) => ({
  rawPath: path, method, rawBody: body == null ? null : JSON.stringify(body), query, userId: DAVE, householdIds,
});
const B = `/api/kitchen-batches/${BATCH}`;
const err = (code, constraint) => Object.assign(new Error(code), { code, constraint });
const GUC = "SELECT set_config('app.actor_clerk_sub', ? , true)";
const findCall = (sql, needle) => sql.calls.find((c) => c.norm.includes(needle));
const after = (call, needle) => {
  const at = call.norm.indexOf(needle);
  expect(at, `SQL lacks ${needle}`).toBeGreaterThan(-1);
  return call.values[(call.norm.slice(0, at + needle.length).match(/\?/g) ?? []).length];
};

// ── the pure line rules ───────────────────────────────────────────────────────────────────────────
describe('kitchenLines — the line body rules (contract-F §2.2)', () => {
  const ok = (over) => ({ input_kind: 'other', idempotency_key: K1, label: 'onion', ...over });
  it.each([
    // B′ release 3 amends this arm: 'pantry' is now a line kind, and it must name its item.
    [{ input_kind: 'pantry' }, /a pantry line names its item/],
    [{ idempotency_key: 'x' }, /idempotency_key must be a uuid/],
    [{ input_kind: 'garden', label: null }, /names its planting/],
    [{ input_kind: 'harvest', label: null }, /names its pick/],
    [{ harvest_log_id: PICK }, /only a pick line carries/],
    [{ input_kind: 'put_up' }, /a draw names its jar/],
    [{ label: ' ' }, /name what went in/],
    [{ input_kind: 'garden', plant_id: PLANT, label: ' ' }, /label cannot be blank/],
    [{ qty: 5 }, /must both be set/],
    [{ qty: 5, qty_unit: 'quarts' }, /qty_unit must be one of/],
    [{ form: 'pickled' }, /form must be one of/],
    [{ role: 'water', form: 'fresh' }, /no form/],
    [{ role: 'salt', shu_rating_low: 5 }, /no heat rating/],
    [{ shu_rating_high: 500 }, /needs its low end/],
    [{ shu_rating_low: 800, shu_rating_high: 500 }, /at least shu_rating_low/],
    [{ salt_pct: 3 }, /only on a salt line/],
    [{ role: 'salt', qty: 5, qty_unit: 'g', salt_pct: 3 }, /go together/],
    [{ role: 'salt', qty: 5, qty_unit: 'oz', salt_pct: 3, salt_base: 'produce', base_g: 200 }, /weighed in g/],
    [{ role: 'salt', qty: 5, qty_unit: 'g', salt_pct: 101, salt_base: 'produce', base_g: 200 }, /at most 100/],
    [{ role: 'salt', qty: 5, qty_unit: 'g', salt_pct: 3, salt_base: 'peppers', base_g: 200 }, /salt_base must be one of/],
    [{ salt_method: 'dry' }, /only on a salt line/],
    [{ role: 'salt', base_from: 'scale' }, /needs the base weight/],
    [{ role: 'salt', qty: 200, qty_unit: 'g', salt_pct: 10, salt_base: 'produce', base_g: 2000, salt_method: 'rinsed', base_from: 'scale' }, /soak water/],
    [{ count_drawn: 1 }, /only on a draw/],
    [{ output_id: STAGE }, /needs its put_up_stage_id/],
    [{ brand: 'x'.repeat(121) }, /at most 120/],
    [{ surprise: 1 }, /unknown field/],
  ])('%o → 400', (over, want) => expect(lineError(ok(over))).toMatch(want));

  it.each([
    [{}], [{ input_kind: 'garden', plant_id: PLANT, label: null }], [{ input_kind: 'harvest', harvest_log_id: PICK }],
    [{ input_kind: 'put_up', preservation_log_id: JAR, count_drawn: 2 }],
    [{ role: 'water', qty: 250, qty_unit: 'ml', label: 'Water' }],
    [{ role: 'salt', qty: 15.68, qty_unit: 'g', salt_pct: 3.5, salt_base: 'all', base_g: 448, salt_method: 'brine', base_from: 'lines' }],
    [{ role: 'salt', qty: 200, qty_unit: 'g', salt_pct: 10, salt_base: 'water', base_g: 2000, salt_method: 'rinsed', base_from: 'scale' }],
    [{ form: 'dried', shu_rating_low: 4000, shu_rating_high: 8000, brand: 'Taekyung' }],
  ])('%o is a good line', (over) => expect(lineError(ok(over))).toBeNull());

  it('one draw per jar per request, and every key its own', () => {
    const d = (k) => ({ input_kind: 'put_up', idempotency_key: k, preservation_log_id: JAR });
    expect(linesError([d(K1), d(K2)])).toMatch(/named twice/);
    expect(linesError([ok({}), ok({})])).toMatch(/its own idempotency_key/);
  });

  it('keyed / shipped / mixed forms', () => {
    expect(inputsForm([{ idempotency_key: K1 }, { idempotency_key: K2 }])).toBe('keyed');
    expect(inputsForm([{ label: 'x' }])).toBe('shipped');
    expect(inputsForm([{ idempotency_key: K1 }, { label: 'x' }])).toBe('mixed');
  });

  it('draw plans: stock mode from the jar; used-up and removed jars are refused (F2)', () => {
    const counted = { package_count: 4, quantity_value: 600, quantity_unit: 'g', remaining_count: 3 };
    const weighed = { package_count: 1, quantity_value: 100, quantity_unit: 'g', remaining_count: 1 };
    expect(drawPlan({}, counted)).toEqual({ weighed: false, count: 1 });
    expect(drawPlan({ count_drawn: 2 }, counted)).toEqual({ weighed: false, count: 2 });
    expect(drawPlan({ qty: 8, qty_unit: 'g' }, weighed)).toEqual({ weighed: true, count: null });
    expect(drawPlan({ count_drawn: 1, qty: 8, qty_unit: 'g' }, weighed).status).toBe(400);
    expect(drawPlan({ qty: 1, qty_unit: 'count' }, weighed).status).toBe(400);
    expect(drawPlan({}, { ...counted, remaining_count: 0 }).code).toBe('jar_used_up');
    expect(drawPlan({}, { ...counted, consumed_at: '2026-10-01' }).code).toBe('jar_used_up');
    expect(drawPlan({}, { ...counted, deleted_at: '2026-10-01' }).code).toBe('jar_removed');
  });

  it('line PATCH allowlist: identity is "take it out and add it again"; role only NULL↔water', () => {
    const stored = { input_kind: 'put_up', role: null, qty: 8, qty_unit: 'g', weighed: true };
    expect(linePatchError({ preservation_log_id: JAR }, stored)).toBe(TAKE_IT_OUT);
    expect(linePatchError({ count_drawn: 2 }, stored)).toBe(TAKE_IT_OUT);
    expect(linePatchError({ role: 'salt' }, { ...stored, input_kind: 'other' })).toBe(TAKE_IT_OUT);
    expect(linePatchError({ role: 'water' }, { input_kind: 'other', role: null })).toBeNull();
    expect(linePatchError({ role: null }, { input_kind: 'other', role: 'water' })).toBeNull();
    expect(linePatchError({ qty: 2, qty_unit: 'count' }, stored)).toMatch(/stays in g/);
    expect(linePatchError({ qty: 0.5, qty_unit: 'oz' }, stored)).toBeNull();
    expect(linePatchError({ qty: 2, qty_unit: 'count' }, { ...stored, weighed: false })).toBeNull();
    expect(linePatchError({ qty: 2 }, stored)).toMatch(/edited together/);
  });

  it('stage PATCH allowlist per kind; void and voided rows are note-only; dates stay on started/put_up', () => {
    expect(stagePatchError({ entered_at: '2026-10-01T00:00:00Z', entered_precision: 'day' }, { stage_kind: 'put_up' })).toMatch(/cannot be changed/);
    expect(stagePatchError({ amount: 5, amount_unit: 'g' }, { stage_kind: 'tended', voided: true })).toMatch(/cannot be changed/);
    expect(stagePatchError({ note: 'x' }, { stage_kind: 'tended', voided: true })).toBeNull();
    expect(stagePatchError({ label: 'x' }, { stage_kind: 'void' })).toMatch(/cannot be changed/);
    expect(stagePatchError({ amount: 910 }, { stage_kind: 'put_up' })).toBeNull();
    expect(stagePatchError({ mash_in_g: 100 }, { stage_kind: 'tended' })).toMatch(/cannot be changed/);
    expect(stagePatchError({ acts: ['burped'] }, { stage_kind: 'tended' })).toMatch(/acts must be among/);
    expect(stagePatchError({ storage_location_id: null }, { stage_kind: 'moved' })).toMatch(/somewhere to have moved/);
    expect(stagePatchError({ ph_reading: '3.7' }, { stage_kind: 'tended' })).toMatch(/needs the time/);
  });

  it('ph_read_at bounds: not past now + 5 min, not before the start day (ET)', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    const ctx = { nowMs: now, startDay: '2026-09-28', etDayOf: etDay };
    expect(phReadAtError('2026-10-05T12:04:00Z', ctx)).toBeNull();
    expect(phReadAtError('2026-10-05T12:06:00Z', ctx)).toMatch(/future/);
    expect(phReadAtError('2026-09-28T13:00:00Z', ctx)).toBeNull();
    expect(phReadAtError('2026-09-28T02:00:00Z', ctx)).toMatch(/before the batch started/);   // 22:00 ET the 27th
    expect(phReadAtError('nope', ctx)).toMatch(/timestamp/);
  });
});

// ── the keyed line POST ───────────────────────────────────────────────────────────────────────────
describe('POST /:id/inputs — the keyed form', () => {
  const post = (inputs, h = HOUSEHOLD) => route(`${B}/inputs`, 'POST', { inputs }, h);
  const jarRow = (over) => ({ id: JAR, deleted_at: null, package_count: 4, remaining_count: 4, consumed_at: null,
    remaining_amount: null, quantity_value: 600, quantity_unit: 'g', label: 'Carrots', method: 'blanch_freeze', crop_type_slug: 'carrot', ...over });

  it('ONE statement in the actor transaction: lines → draws → ONE movement per jar (F1) → pantry_use → no_salt', async () => {
    const sql = mockSql([OPEN, [], [jarRow()], [], [{ inserted: 1 }], [{ id: 'l1' }]]);
    const res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'put_up', idempotency_key: K1, preservation_log_id: JAR, qty: 150, qty_unit: 'g' }]) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ inserted: 1, requested: 1 });
    const w = sql.batches[0];
    expect(w[0].norm).toBe(GUC);
    const s = w[1].norm;
    for (const cte of ['WITH ins AS ( INSERT INTO kitchen_batch_input', '), draws AS (', '), moved AS ( UPDATE preservation_log p SET',
      '), uses AS ( INSERT INTO pantry_use', '), salted AS ( UPDATE kitchen_batch SET no_salt = NULL']) expect(s).toContain(cte);
    expect(s).toContain('FROM (SELECT x.preservation_log_id, sum(x.n) AS n, sum(x.g) AS g FROM draws x GROUP BY x.preservation_log_id) a');
    expect(s).not.toContain('ON CONFLICT');   // boss F3
    // a counted draw: count 1 bound, weighed false; the jar label stamped when the body had none
    expect(w[1].values).toContainEqual([1]);
    expect(w[1].values).toContainEqual([false]);
    expect(w[1].values).toContainEqual(['Carrots']);
  });

  it('a counted draw moves remaining_count and stamps delta_at; a weighed draw moves grams and stamps only at 0 g (F2)', async () => {
    const sql = mockSql([OPEN, [], [jarRow({ package_count: 1, quantity_value: 100 })], [], [{ inserted: 1 }], []]);
    await handleKitchenRoute({ sql, ...post([{ input_kind: 'put_up', idempotency_key: K1, preservation_log_id: JAR, qty: 8, qty_unit: 'g', form: 'frozen' }]) });
    const s = sql.batches[0][1];
    expect(s.values).toContainEqual([null]);   // draw_count
    expect(s.values).toContainEqual([true]);   // draw_weighed
    expect(s.norm).toContain('remaining_count = CASE WHEN a.n IS NOT NULL THEN COALESCE(p.remaining_count, p.package_count) - a.n WHEN a.g IS NOT NULL AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0 THEN 0');
    expect(s.norm).toContain('delta_at = CASE WHEN a.n IS NOT NULL OR (a.g IS NOT NULL AND');
  });

  it('F2: a used-up or removed jar is refused before the statement', async () => {
    let sql = mockSql([OPEN, [], [jarRow({ remaining_count: 0 })]]);
    let res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'put_up', idempotency_key: K1, preservation_log_id: JAR }]) });
    expect(res).toMatchObject({ status: 409, body: { code: 'jar_used_up' } });
    sql = mockSql([OPEN, [], [jarRow({ deleted_at: '2026-10-01' })]]);
    res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'put_up', idempotency_key: K1, preservation_log_id: JAR }]) });
    expect(res).toMatchObject({ status: 409, body: { code: 'jar_removed' } });
    expect(sql.batches).toHaveLength(0);
  });

  it('a foreign jar, planting or pick → 400, household bound, nothing written', async () => {
    let sql = mockSql([[]]);
    let res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'put_up', idempotency_key: K1, preservation_log_id: JAR }], STRANGER) });
    expect(res.status).toBe(404);   // the batch gate itself refuses the stranger
    expect(sql.calls[0].values).toContainEqual(STRANGER);
    sql = mockSql([OPEN, [], [], []]);
    res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'garden', idempotency_key: K1, plant_id: PLANT }]) });
    expect(res.status).toBe(400);
    expect(sql.calls[2].values).toContainEqual(HOUSEHOLD);
    sql = mockSql([OPEN, [], []]);
    res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'harvest', idempotency_key: K1, harvest_log_id: PICK }]) });
    expect(res.status).toBe(400);
    expect(sql.batches).toHaveLength(0);
  });

  it('a pick line copies its planting server-side and takes the planting name as its label', async () => {
    const sql = mockSql([OPEN, [], [{ id: PICK, plant_id: PLANT, display_name: 'Megatron' }], [], [{ inserted: 1 }], []]);
    await handleKitchenRoute({ sql, ...post([{ input_kind: 'harvest', idempotency_key: K1, harvest_log_id: PICK, qty: 412, qty_unit: 'g' }]) });
    const s = sql.batches[0][1];
    expect(s.values).toContainEqual([PLANT]);
    expect(s.values).toContainEqual(['Megatron']);
  });

  it('the draw CHECKs map by name: remaining_count → 409 only_n_left {n}; remaining_amount → 409 only_g_left {g}', async () => {
    let sql = mockSql([OPEN, [], [jarRow()], [], err('23514', 'chk_preservation_log_remaining_count'), [{ id: JAR, left_n: 1, left_g: 150 }]]);
    let res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'put_up', idempotency_key: K1, preservation_log_id: JAR, count_drawn: 2 }]) });
    expect(res).toEqual({ status: 409, body: { code: 'only_n_left', n: 1, error: 'Only 1 left in that one.' } });
    sql = mockSql([OPEN, [], [jarRow({ package_count: 1 })], [], err('23514', 'chk_preservation_log_remaining_amount'), [{ id: JAR, left_n: 1, left_g: '91.6' }]]);
    res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'put_up', idempotency_key: K1, preservation_log_id: JAR, qty: 200, qty_unit: 'g' }]) });
    expect(res).toEqual({ status: 409, body: { code: 'only_g_left', g: 92, error: 'Only about 92 g left in that one.' } });
  });

  it('23505 on uq_kbi_idempotency_key: every key in this batch → 200 replayed; otherwise 409 key_conflict', async () => {
    let sql = mockSql([OPEN, [], [], err('23505', 'uq_kbi_idempotency_key'), [{ id: 'l1', batch_id: BATCH }], [{ id: 'l1' }]]);
    let res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'other', idempotency_key: K1, label: 'onion' }]) });
    expect(res).toEqual({ status: 200, body: { replayed: true, inputs: [{ id: 'l1' }] } });
    sql = mockSql([OPEN, [], [], err('23505', 'uq_kbi_idempotency_key'), [{ id: 'l1', batch_id: 'another' }]]);
    res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'other', idempotency_key: K1, label: 'onion' }]) });
    expect(res.body.code).toBe('key_conflict');
  });

  it('a retry whose keys are already written replays BEFORE any jar check (the jar it used up cannot refuse it)', async () => {
    const sql = mockSql([OPEN, [{ id: 'l1', batch_id: BATCH }], [{ id: 'l1' }]]);
    const res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'put_up', idempotency_key: K1, preservation_log_id: JAR }]) });
    expect(res).toEqual({ status: 200, body: { replayed: true, inputs: [{ id: 'l1' }] } });
    expect(sql.calls[1].norm).toContain('WHERE i.idempotency_key = ANY( ? ::uuid[]) AND b.user_id = ANY( ? )');
    expect(sql.batches).toHaveLength(0);
  });

  it('23505 on uq_kbi_batch_harvest → 409 already_in', async () => {
    const sql = mockSql([OPEN, [], [{ id: PICK, plant_id: PLANT, display_name: 'Megatron' }], [], err('23505', 'uq_kbi_batch_harvest')]);
    const res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'harvest', idempotency_key: K1, harvest_log_id: PICK }]) });
    expect(res).toMatchObject({ status: 409, body: { code: 'already_in', error: 'That pick is already in this batch.' } });
  });

  it('mixing keyed and un-keyed rows → 400; an un-keyed list still takes the shipped path', async () => {
    let sql = mockSql([OPEN]);
    let res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'other', idempotency_key: K1, label: 'a' }, { input_kind: 'other', label: 'b' }]) });
    expect(res.status).toBe(400);
    sql = mockSql([OPEN, [{ id: 'i1' }]]);
    res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'other', label: 'b' }]) });
    expect(res.status).toBe(201);
    expect(sql.calls[1].norm).toContain('ON CONFLICT DO NOTHING');   // the shipped form keeps it
  });

  it('accepted on a CLOSED batch (06 §3.13)', async () => {
    const sql = mockSql([CLOSED, [], [], [{ inserted: 1 }], []]);
    const res = await handleKitchenRoute({ sql, ...post([{ input_kind: 'other', idempotency_key: K1, label: 'vinegar' }]) });
    expect(res.status).toBe(201);
  });
});

// ── PATCH / take-out / restore ────────────────────────────────────────────────────────────────────
describe('a line after it went in', () => {
  const stored = (over) => ({ id: LINE, input_kind: 'put_up', harvest_log_id: null, preservation_log_id: JAR, label: 'reaper',
    qty: '8', qty_unit: 'g', role: null, deleted_at: null, weighed: true, ...over });

  it('PATCH a weighed draw: guarded on the qty it read; the same statement moves the jar by the change in grams', async () => {
    const sql = mockSql([OPEN, [stored()], [], [{ updated: 1 }], [{ id: LINE }]]);
    const res = await handleKitchenRoute({ sql, ...route(`${B}/inputs/${LINE}`, 'PATCH', { qty: 13, qty_unit: 'g' }) });
    expect(res.status).toBe(200);
    const s = sql.batches[0][1];
    expect(sql.batches[0][0].norm).toBe(GUC);
    expect(s.norm).toContain('edited_at = now()');
    expect(s.norm).toContain('AND (NOT ? ::boolean OR (qty IS NOT DISTINCT FROM ? ::numeric AND qty_unit IS NOT DISTINCT FROM ? ::text))');
    expect(after(s, 'AND (NOT')).toBe(true);
    expect(s.norm).toContain('FROM (SELECT x.preservation_log_id, sum(x.g) AS g FROM delta x GROUP BY x.preservation_log_id) a');
  });

  it('PATCH a counted draw\'s qty moves no stock; a taken-out line is 404; identity is refused', async () => {
    let sql = mockSql([OPEN, [stored({ weighed: false })], [], [{ updated: 1 }], [{ id: LINE }]]);
    await handleKitchenRoute({ sql, ...route(`${B}/inputs/${LINE}`, 'PATCH', { qty: 3, qty_unit: 'count' }) });
    expect(after(sql.batches[0][1], 'AND (NOT')).toBe(false);
    sql = mockSql([OPEN, [stored({ deleted_at: '2026-10-01' })]]);
    expect((await handleKitchenRoute({ sql, ...route(`${B}/inputs/${LINE}`, 'PATCH', { note: 'x' }) })).status).toBe(404);
    sql = mockSql([OPEN, [stored()]]);
    const r = await handleKitchenRoute({ sql, ...route(`${B}/inputs/${LINE}`, 'PATCH', { preservation_log_id: JAR_B }) });
    expect(r).toEqual({ status: 400, body: { error: TAKE_IT_OUT } });
  });

  it('take-out: soft, the reversal from the same UPDATE\'s RETURNING, aggregated per jar (F1)', async () => {
    const sql = mockSql([OPEN, [stored({ weighed: false })], [], [{ removed: 1, reversed: 1 }], [{ id: LINE }]]);
    const res = await handleKitchenRoute({ sql, ...route(`${B}/inputs/${LINE}`, 'DELETE') });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const s = sql.batches[0][1].norm;
    expect(s).toContain('WITH gone AS ( UPDATE kitchen_batch_input SET deleted_at = now() WHERE id = ? ::uuid AND batch_id = ? ::uuid AND deleted_at IS NULL AND harvest_log_id IS NULL RETURNING');
    expect(s).toContain('INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id, reverses_use_id) SELECT ? ::text, f.preservation_log_id, -f.count_used');
    expect(s).toContain('AND NOT EXISTS (SELECT 1 FROM pantry_use r WHERE r.reverses_use_id = u.id)');
    expect(s).toContain('GROUP BY x.preservation_log_id) a');
    // F2: grams back un-consume only a bag at 0 g that no use-route tap consumed
    expect(s).toContain('AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL) THEN p.package_count');
  });

  it('a second take-out matches nothing → 200 already, no second reversal', async () => {
    const sql = mockSql([OPEN, [stored({ deleted_at: '2026-10-01' })], [], [{ removed: 0, reversed: 0 }]]);
    const res = await handleKitchenRoute({ sql, ...route(`${B}/inputs/${LINE}`, 'DELETE') });
    expect(res).toEqual({ status: 200, body: { ok: true, already: true } });
  });

  it('restore: re-draws from the RETURNING; a used-up jar is refused first; a retry is already', async () => {
    const jar = { id: JAR, deleted_at: null, package_count: 1, remaining_count: 1, consumed_at: null, quantity_unit: 'g', quantity_value: 100 };
    let sql = mockSql([OPEN, [stored({ deleted_at: '2026-10-01' })], [jar], [], [{ restored: 1 }], [{ id: LINE }]]);
    let res = await handleKitchenRoute({ sql, ...route(`${B}/inputs/${LINE}/restore`, 'POST') });
    expect(res.status).toBe(200);
    const s = sql.batches[0][1].norm;
    expect(s).toContain('WITH back AS ( UPDATE kitchen_batch_input SET deleted_at = NULL WHERE id = ? ::uuid AND batch_id = ? ::uuid AND deleted_at IS NOT NULL');
    expect(s).toContain('salted AS ( UPDATE kitchen_batch SET no_salt = NULL');
    sql = mockSql([OPEN, [stored({ deleted_at: '2026-10-01' })], [{ ...jar, consumed_at: '2026-10-02' }]]);
    res = await handleKitchenRoute({ sql, ...route(`${B}/inputs/${LINE}/restore`, 'POST') });
    expect(res.body.code).toBe('jar_used_up');
    sql = mockSql([OPEN, [stored()]]);
    res = await handleKitchenRoute({ sql, ...route(`${B}/inputs/${LINE}/restore`, 'POST') });
    expect(res).toEqual({ status: 200, body: { ok: true, already: true } });
  });
});

// ── stages ────────────────────────────────────────────────────────────────────────────────────────
describe('stages (F)', () => {
  it('a check-in carries acts, de-duplicated', async () => {
    const sql = mockSql([OPEN, [{ id: 's1' }], VIEW]);
    await handleKitchenRoute({ sql, ...route(`${B}/stages`, 'POST', { stage_kind: 'tended', acts: ['skimmed', 'skimmed', 'topped_up'] }) });
    expect(sql.calls[1].values.at(-1)).toEqual(['skimmed', 'topped_up']);
  });

  it('acts on anything but a check-in → 400; a pH read before the start → 400', async () => {
    let sql = mockSql([OPEN]);
    expect((await handleKitchenRoute({ sql, ...route(`${B}/stages`, 'POST', { stage_kind: 'noted', note: 'x', acts: ['skimmed'] }) })).status).toBe(400);
    sql = mockSql([OPEN]);
    const r = await handleKitchenRoute({ sql, ...route(`${B}/stages`, 'POST', { stage_kind: 'tended', ph_reading: '3.9', ph_read_at: '2026-09-01T12:00:00Z' }) });
    expect(r.body.error).toMatch(/before the batch started/);
  });

  it('PATCH: presence-sentinel, scoped WHERE id AND batch_id, stamps edited_at, in the actor transaction', async () => {
    const sql = mockSql([OPEN, [{ id: STAGE, stage_kind: 'put_up', voided: false }], [], [{ id: STAGE }]]);
    const res = await handleKitchenRoute({ sql, ...route(`${B}/stages/${STAGE}`, 'PATCH', { amount: 910, mash_in_g: 800 }) });
    expect(res.status).toBe(200);
    const s = sql.batches[0][1];
    expect(sql.batches[0][0].norm).toBe(GUC);
    expect(s.norm).toContain('edited_at = now() WHERE id = ? ::uuid AND batch_id = ? ::uuid');
    expect(after(s, 'amount_unit = CASE WHEN ? ::boolean THEN')).toBe('g');   // Made is grams
    expect(after(s, 'mash_in_g = CASE WHEN')).toBe(true);
    expect(after(s, 'note = CASE WHEN')).toBe(false);
  });

  it('PATCH refuses a foreign place, a date on a put_up row, and an unknown row', async () => {
    let sql = mockSql([OPEN, [{ id: STAGE, stage_kind: 'moved', voided: false }], []]);
    expect((await handleKitchenRoute({ sql, ...route(`${B}/stages/${STAGE}`, 'PATCH', { storage_location_id: JAR }) })).status).toBe(400);
    sql = mockSql([OPEN, [{ id: STAGE, stage_kind: 'put_up', voided: false }]]);
    expect((await handleKitchenRoute({ sql, ...route(`${B}/stages/${STAGE}`, 'PATCH', { entered_at: '2026-10-01T00:00:00Z', entered_precision: 'day' }) })).status).toBe(400);
    sql = mockSql([OPEN, []]);
    expect((await handleKitchenRoute({ sql, ...route(`${B}/stages/${STAGE}`, 'PATCH', { note: 'x' }) })).status).toBe(404);
  });
});

// ── the batch ─────────────────────────────────────────────────────────────────────────────────────
describe('the merge PUT (F fields) and "No salt"', () => {
  it('no_salt: true is guarded by NOT EXISTS (live salt line) in the WHERE; 0 rows → 409 has_salt_line', async () => {
    const sql = mockSql([OPEN, []]);
    const res = await handleKitchenRoute({ sql, ...route(B, 'PUT', { no_salt: true }) });
    expect(res).toEqual({ status: 409, body: { error: 'Take the salt line out first.', code: 'has_salt_line' } });
    expect(sql.calls[1].norm).toContain("AND ( ? ::boolean IS NOT TRUE OR NOT EXISTS (SELECT 1 FROM kitchen_batch_input i WHERE i.batch_id = ? ::uuid AND i.role = 'salt' AND i.deleted_at IS NULL))");
    expect(after(sql.calls[1], "AND (")).toBe(true);
  });

  it('a typed heat estimate writes basis typed; clearing it clears the basis', async () => {
    const sql = mockSql([OPEN, [{ id: BATCH }], VIEW]);
    await handleKitchenRoute({ sql, ...route(B, 'PUT', { shu_est_low: 950, shu_est_high: 3000 }) });
    expect(sql.calls[1].norm).toContain("THEN CASE WHEN ? ::integer IS NULL THEN NULL ELSE 'typed' END ELSE shu_est_basis END");
    const sql2 = mockSql([OPEN]);
    expect((await handleKitchenRoute({ sql: sql2, ...route(B, 'PUT', { shu_est_low: 950, shu_est_high: 3000, shu_est_basis: 'computed' }) })).status).toBe(400);
  });
});

describe('getBatch — the F3 shape', () => {
  it('live lines through readLines, garden_names from from_garden lines, and no stale key on a typed estimate', async () => {
    const lines = [
      { id: 'l1', label: 'Megatron', from_garden: true, _rating_low: 2500 },
      { id: 'l2', label: 'onion', from_garden: false },
      { id: 'l3', label: 'Megatron', from_garden: true },
    ];
    const sql = mockSql([OPEN, [{ ...VIEW[0], shu_est_basis: 'typed' }], lines, [], []]);
    const res = await handleKitchenRoute({ sql, ...route(B, 'GET') });
    expect(res.body.garden_names).toEqual(['Megatron']);
    expect(res.body.inputs[0]).not.toHaveProperty('_rating_low');
    expect(res.body).not.toHaveProperty('shu_est_stale');
    expect(findCall(sql, 'FROM kitchen_batch_input i').norm).toContain('AS from_garden');
    expect(findCall(sql, 'FROM kitchen_batch_input i').norm).toContain('AS count_drawn');
  });

  it('a COMPUTED estimate that no longer matches the lines is flagged shu_est_stale: true', async () => {
    const lines = [
      { id: 'l1', label: 'jalapeño', qty: 170, qty_unit: 'g', role: null, _rating_low: 2500, _rating_high: 8000 },
      { id: 'l2', label: 'Water', qty: 250, qty_unit: 'ml', role: 'water' },
    ];
    const view = { ...VIEW[0], shu_est_basis: 'computed', shu_est_low: 900, shu_est_high: 3036 };
    let sql = mockSql([OPEN, [view], lines, [], [], []]);
    let res = await handleKitchenRoute({ sql, ...route(B, 'GET') });
    expect(res.body.shu_est_stale).toBe(true);
    sql = mockSql([OPEN, [{ ...view, shu_est_low: halfUpCheck(170 * 2500 / 420), shu_est_high: halfUpCheck(170 * 8000 / 420) }], lines, [], [], []]);
    res = await handleKitchenRoute({ sql, ...route(B, 'GET') });
    expect(res.body).not.toHaveProperty('shu_est_stale');
  });
});
function halfUpCheck(x) { return Math.floor(x + 0.5); }

describe('shu-estimate', () => {
  const lines = [{ id: 'l1', label: 'jalapeño', qty: 170, qty_unit: 'g', role: null, _rating_low: 2500, _rating_high: 8000 },
    { id: 'l2', label: 'garlic', qty: 8, qty_unit: 'g', role: null }, { id: 'l3', label: 'onion', qty: 20, qty_unit: 'g', role: null },
    { id: 'l4', label: 'Water', qty: 250, qty_unit: 'ml', role: 'water' }];
  it('GET writes nothing and answers the Petri figure', async () => {
    const sql = mockSql([OPEN, lines, [], []]);
    const res = await handleKitchenRoute({ sql, ...route(`${B}/shu-estimate`, 'GET', null, HOUSEHOLD, { scope: 'batch' }) });
    expect(res.body).toMatchObject({ low: 949, high: 3036 });
    expect(sql.calls.some((c) => /^(UPDATE|INSERT)/.test(c.norm))).toBe(false);
  });
  it('save RECOMPUTES and writes computed; a refusal → 409 shu_cannot_compute with the refusal', async () => {
    let sql = mockSql([OPEN, lines, [], [], [{ shu_est_low: 949, shu_est_high: 3036, shu_est_basis: 'computed' }]]);
    let res = await handleKitchenRoute({ sql, ...route(`${B}/shu-estimate/save`, 'POST', { scope: 'batch' }) });
    expect(res.body.shu_est_basis).toBe('computed');
    expect(sql.calls.at(-1).values.slice(0, 2)).toEqual([949, 3036]);
    sql = mockSql([OPEN, [lines[1]], [], []]);
    res = await handleKitchenRoute({ sql, ...route(`${B}/shu-estimate/save`, 'POST', { scope: 'batch' }) });
    expect(res).toMatchObject({ status: 409, body: { code: 'shu_cannot_compute', refusal: 'no_heat_lines' } });
  });
});

describe('Remove this batch — F1', () => {
  it('reverses the lines\' unreversed draws in the same statement, one aggregated movement per jar', async () => {
    const sql = mockSql([OPEN, [], [{ deleted_count: 1, live_jar_count: 0 }]]);
    await handleKitchenRoute({ sql, ...route(B, 'DELETE') });
    const s = sql.batches[0][1].norm;
    expect(s).toContain('RETURNING i.id, i.preservation_log_id, i.qty, i.qty_unit');
    expect(s).toContain('FROM pantry_use u JOIN lines_out l ON l.id = u.kitchen_batch_input_id');
    expect(s).toContain(') x GROUP BY x.preservation_log_id) a WHERE p.id = a.preservation_log_id');
  });
});

describe('Undo that put-up — the widened refusal and the one jar UPDATE', () => {
  it('refused when a use not from the sitting\'s own lines, or ANY live line, touches a sitting jar', async () => {
    const sql = mockSql([OPEN, [], [{ found_count: 1, own_jar_count: 1, used_jar_ids: [JAR] }]]);
    const res = await handleKitchenRoute({ sql, ...route(`${B}/put-up/${STAGE}/undo`, 'POST', {}) });
    expect(res.body.code).toBe('put_up_in_use');
    const s = sql.batches[0][1].norm;
    expect(s).toContain('OR u.kitchen_batch_input_id NOT IN (SELECT k.id FROM kitchen_batch_input k WHERE k.put_up_stage_id = ? ::uuid)');
    expect(s).toContain('SELECT k.preservation_log_id FROM kitchen_batch_input k WHERE k.deleted_at IS NULL AND k.preservation_log_id IN (SELECT id FROM sitting_jars)');
  });
  it('removes the jars and gives back the lines\' draws in ONE UPDATE of preservation_log (F1)', async () => {
    const sql = mockSql([OPEN, [], [{ found_count: 1, own_jar_count: 1, used_jar_ids: null, reopened_count: 0 }], VIEW]);
    await handleKitchenRoute({ sql, ...route(`${B}/put-up/${STAGE}/undo`, 'POST', {}) });
    const s = sql.batches[0][1].norm;
    expect((s.match(/UPDATE preservation_log/g) ?? [])).toHaveLength(1);
    expect(s).toContain('bool_or(x.remove) AS remove, sum(x.n) AS n, sum(x.g) AS g');
  });
});

// ── POST /api/pantry/uses ─────────────────────────────────────────────────────────────────────────
describe('POST /api/pantry/uses', () => {
  const use = (body, householdIds = HOUSEHOLD) => handlePantryUses({
    sql: null, rawPath: '/api/pantry/uses', method: 'POST', rawBody: JSON.stringify(body), userId: DAVE, householdIds,
  });
  const call = (sql, body, householdIds = HOUSEHOLD) => handlePantryUses({
    sql, rawPath: '/api/pantry/uses', method: 'POST', rawBody: JSON.stringify(body), userId: DAVE, householdIds,
  });

  it('is only its own path', async () => {
    expect(await handlePantryUses({ sql: null, rawPath: '/api/pantry', method: 'POST' })).toBeNull();
    expect(await handlePantryUses({ sql: null, rawPath: '/api/preservation/uses', method: 'POST' })).toBeNull();
  });

  it.each([
    [{ preservation_log_id: JAR, count_used: 1 }, /idempotency_key/],
    [{ idempotency_key: K1, preservation_log_id: JAR }, /one of them/],
    [{ idempotency_key: K1, preservation_log_id: JAR, count_used: 1, all_remaining: true }, /one of them/],
    [{ idempotency_key: K1, preservation_log_id: JAR, count_used: 0 }, /1 or more/],
    // B′ amends F's "only eaten": discarded is admitted — a count, or all that is left (the accepted row
    // under this table); 'batch' stays the line routes' own.
    [{ idempotency_key: K1, preservation_log_id: JAR, count_used: 1, fate: 'batch' }, /eaten/],
  ])('%o → 400', async (body, want) => {
    expect(validateUse(body)).toMatch(want);
    expect((await use(body)).status).toBe(400);
  });

  // Put-Up UX pass R1: this row sat in the table above as a 400 (/Went bad/) until Went bad could be a count.
  it("{ count_used: 1, fate: 'discarded' } → accepted (201): the count and the fate are what the statement binds", async () => {
    const body = { idempotency_key: K1, preservation_log_id: JAR, count_used: 1, fate: 'discarded' };
    expect(validateUse(body)).toBeNull();
    const sql = mockSql([[], [{ left_n: 3, use: { id: 'u1', count_used: 1, fate: 'discarded' }, jar: { id: JAR, remaining_count: 2 } }]]);
    const res = await call(sql, body);
    expect(res).toEqual({ status: 201, body: { use: { id: 'u1', count_used: 1, fate: 'discarded' }, jar: { id: JAR, remaining_count: 2 } } });
    const s = sql.batches[0][1];
    expect(after(s, 'SELECT pre.id, CASE WHEN')).toBe(false);
    expect(after(s, 'THEN pre.left_n ELSE')).toBe(1);
    expect(after(s, 'jar.id, jar.used,')).toBe('discarded');
  });

  it('ONE statement in the actor transaction: lock, the guarded decrement, the use from its RETURNING', async () => {
    const sql = mockSql([[], [{ left_n: 3, use: { id: 'u1', count_used: 1 }, jar: { id: JAR, remaining_count: 2 } }]]);
    const res = await call(sql, { idempotency_key: K1, preservation_log_id: JAR, count_used: 1 });
    expect(res).toEqual({ status: 201, body: { use: { id: 'u1', count_used: 1 }, jar: { id: JAR, remaining_count: 2 } } });
    const s = sql.batches[0][1].norm;
    expect(sql.batches[0][0].norm).toBe(GUC);
    expect(s).toContain('AND p.user_id = ANY( ? ) AND p.deleted_at IS NULL FOR UPDATE');
    expect(s).toContain('AND w.n >= 1 AND COALESCE(p.remaining_count, p.package_count) >= w.n');
    expect(s).toContain('delta_at = now()');
    // F2: a weighed jar reaching 0 left also reads 0 g
    expect(s).toContain('remaining_amount = CASE WHEN p.package_count = 1 AND p.quantity_unit = ANY( ? ::text[]) AND COALESCE(p.remaining_count, p.package_count) - w.n = 0 THEN 0');
    // B′: the use row carries the tap's fate (NULL = eaten) — the only change to F's statement.
    expect(s).toContain('INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, idempotency_key) SELECT ? ::text, jar.id, jar.used, ? ::text, ? ::uuid FROM jar');
    expect(sql.batches[0][1].values).toContainEqual(HOUSEHOLD);
  });

  it('not enough left → 409 only_n_left {n}; all_remaining on none left → only_n_left {n:0}; not found → 404', async () => {
    let sql = mockSql([[], [{ left_n: 1, use: null, jar: null }]]);
    expect(await call(sql, { idempotency_key: K1, preservation_log_id: JAR, count_used: 2 }))
      .toEqual({ status: 409, body: { error: 'Only 1 left in that one.', code: 'only_n_left', n: 1 } });
    sql = mockSql([[], [{ left_n: 0, use: null, jar: null }]]);
    expect((await call(sql, { idempotency_key: K1, preservation_log_id: JAR, all_remaining: true })).body.n).toBe(0);
    sql = mockSql([[], [{ left_n: null, use: null, jar: null }]]);
    expect((await call(sql, { idempotency_key: K1, preservation_log_id: JAR, count_used: 1 }, STRANGER)).status).toBe(404);
  });

  it('a retry of a tap already recorded replays BEFORE the count is judged (a retried Used up meets 0 left)', async () => {
    const sql = mockSql([[], [{ prior_n: 1, left_n: 0, use: null, jar: null }], [{ use: { id: 'u1' }, jar: { id: JAR } }]]);
    const res = await call(sql, { idempotency_key: K1, preservation_log_id: JAR, all_remaining: true });
    expect(res).toEqual({ status: 200, body: { replayed: true, use: { id: 'u1' }, jar: { id: JAR } } });
    const s = sql.batches[0][1].norm;
    expect(s).toContain('SELECT u.id FROM pantry_use u WHERE u.idempotency_key = ? ::uuid ), pre AS (');
    expect(s).toContain('FROM pre WHERE NOT EXISTS (SELECT 1 FROM prior)');
  });

  it('a replay (23505 on uq_pantry_use_idempotency_key) re-reads by key, household-scoped; a foreign key → 409', async () => {
    let sql = mockSql([[], err('23505', 'uq_pantry_use_idempotency_key'), [{ use: { id: 'u1' }, jar: { id: JAR } }]]);
    expect(await call(sql, { idempotency_key: K1, preservation_log_id: JAR, count_used: 1 }))
      .toEqual({ status: 200, body: { replayed: true, use: { id: 'u1' }, jar: { id: JAR } } });
    expect(sql.calls[2].values).toContainEqual(HOUSEHOLD);
    sql = mockSql([[], err('23505', 'uq_pantry_use_idempotency_key'), []]);
    expect((await call(sql, { idempotency_key: K1, preservation_log_id: JAR, count_used: 1 })).body.code).toBe('key_conflict');
  });
});

// ── the line search ───────────────────────────────────────────────────────────────────────────────
describe('GET /api/kitchen-batches/line-search', () => {
  it('is a literal matched before any :id — no ownership gate reads "line-search" as a batch', async () => {
    // B′ release 3 amends this: five arms now (plantings, put-ups, pantry items, crops, varieties), and the
    // body gains the ranked `hits` and `resolved_crop` beside F's two unchanged keys.
    const sql = mockSql([[], [], [], [], []]);
    const res = await handleKitchenRoute({ sql, ...route('/api/kitchen-batches/line-search', 'GET', null, HOUSEHOLD, { q: 'reaper' }) });
    expect(res).toEqual({ status: 200, body: { plantings: [], put_ups: [], pantry_items: [], crops: [], varieties: [], hits: [], resolved_crop: null } });
    expect(sql.calls[0].norm).toContain('FROM garden_node gn');
    expect(sql.calls[0].norm).not.toContain('v_kitchen_batch_current');
  });

  it('household-scoped on both arms; used-up and removed jars are not offered (F2)', async () => {
    const sql = mockSql([[], [{ preservation_log_id: JAR, method: 'dehydrate', storage_kind: 'pantry', stock_mode: 'weighed' }], [], [], []]);
    const res = await handleKitchenRoute({ sql, ...route('/api/kitchen-batches/line-search', 'GET', null, STRANGER, { q: 'rea' }) });
    expect(sql.calls[0].values).toContainEqual(STRANGER);
    expect(sql.calls[1].values).toContainEqual(STRANGER);
    expect(sql.calls[1].norm).toContain('AND p.deleted_at IS NULL AND (p.remaining_count IS NULL OR p.remaining_count > 0) AND p.consumed_at IS NULL');
    expect(res.body.put_ups[0]).toEqual({ preservation_log_id: JAR, method: 'dehydrate', stock_mode: 'weighed', suggested_form: 'dried' });
  });

  it('an empty query → 400; LIKE metacharacters are literal', async () => {
    expect((await handleKitchenRoute({ sql: mockSql(), ...route('/api/kitchen-batches/line-search', 'GET', null, HOUSEHOLD, { q: ' ' }) })).status).toBe(400);
    expect(likePattern('50%_x')).toBe('%50\\%\\_x%');
  });

  it('suggested form (06 §2.6.6): from the method, then the place only for other/purchased', () => {
    expect(suggestedForm('powder')).toBe('dried');
    expect(suggestedForm('roast_freeze')).toBe('cooked');
    expect(suggestedForm('whole_freeze')).toBe('frozen');
    expect(suggestedForm('blanch_freeze')).toBe('frozen');
    expect(suggestedForm('purchased_preserved', 'deep_freezer')).toBe('frozen');
    expect(suggestedForm('other', 'fridge')).toBeNull();
    expect(suggestedForm('hot_sauce', 'deep_freezer')).toBeNull();
  });
});
