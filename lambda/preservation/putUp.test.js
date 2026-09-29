// Put-Up release 1b — Put it up, Undo that put-up, the 1b stage kinds, and the batch create's key.
// The pure plan (putUp.js) is executed directly; the routes (kitchenRoutes.js) against a mock driver
// that records what each statement SENDS. Neither can prove the SQL runs — the integration lane does,
// on a real Postgres with v5-putupmake-001 applied.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleKitchenRoute } from './kitchenRoutes.js';
import { parseKitchenRoute, validateStage, validateBatchCreate } from './kitchenBatch.js';
import { validatePutUp, planPutUp, putUpColumns, putUpInUse, BATCH_CLOSED } from './putUp.js';

const HOUSEHOLD = ['user_dave', 'user_jen'];
const DAVE = 'user_dave';
const BATCH = 'aaaaaaaa-1111-2222-3333-444444444444';
const STAGE = 'bbbbbbbb-1111-2222-3333-444444444444';
const KEY = 'cccccccc-1111-2222-3333-444444444444';
const PLACE = 'dddddddd-1111-2222-3333-444444444444';
const TENDED = 'eeeeeeee-1111-2222-3333-444444444444';

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
const OPEN = [{ id: BATCH, closed_at: null, suspended_at: null }];
const CLOSED = [{ id: BATCH, closed_at: '2026-10-01T00:00:00Z', suspended_at: null }];
const VIEW = [{ id: BATCH, label: 'Megatron mash' }];
const route = (path, method, body) => ({
  rawPath: path, method, rawBody: body == null ? null : JSON.stringify(body), query: {}, userId: DAVE, householdIds: HOUSEHOLD,
});
const dup = (constraint) => Object.assign(new Error('dup'), { code: '23505', constraint });

// Dave's Appendix C sitting, 1b's half (no draws): two rows of 8 oz woozies in the fridge.
const sitting = (over = {}) => ({
  idempotency_key: KEY, when: { date: '2026-10-08T14:30:00.000Z', precision: 'exact' }, method: 'hot_sauce', finish: true,
  rows: [
    { count: 2, container_label: '8 oz woozy', size_value: 8, size_unit: 'fl oz', place: { kind: 'fridge', label: ' Fridge ' }, name: 'Megatron plain', ph: '3.70' },
    { count: 2, container_label: '8 oz woozy', size_value: 8, size_unit: 'fl oz', place: { kind: 'fridge', label: 'fridge' }, name: 'Megatron reaper',
      added_lines: [{ label: 'vinegar', qty: 72, qty_unit: 'g' }] },
  ],
  sitting_lines: [{ label: 'reserved brine', qty: 100, qty_unit: 'ml' }],
  made_g: 910, next_time: 'more carrot', ...over,
});

describe('routing (1b shapes)', () => {
  it('put-up and put-up/:stageId/undo, and no other four-segment shape', () => {
    expect(parseKitchenRoute(`/api/kitchen-batches/${BATCH}/put-up`)).toEqual({ kind: 'put_up', id: BATCH });
    expect(parseKitchenRoute(`/api/kitchen-batches/${BATCH}/put-up/${STAGE}/undo`))
      .toEqual({ kind: 'put_up_undo', id: BATCH, stageId: STAGE });
    expect(parseKitchenRoute(`/api/kitchen-batches/${BATCH}/put-up/${STAGE}`)).toBeNull();
    expect(parseKitchenRoute(`/api/kitchen-batches/${BATCH}/put-up/${STAGE}/redo`)).toBeNull();
    expect(parseKitchenRoute(`/api/kitchen-batches/${BATCH}/inputs/${STAGE}/undo`)).toBeNull();
  });
});

describe('validatePutUp', () => {
  it('accepts the sitting', () => expect(validatePutUp(sitting())).toBeNull());
  it.each([
    [{ idempotency_key: 'x' }, /idempotency_key must be a uuid/],
    [{ when: { precision: 'day' } }, /needs a when\.date/],
    [{ when: { precision: 'unknown', date: '2026-10-08' } }, /no when\.date/],
    [{ when: { date: '2026-10-08', precision: 'fortnight' } }, /when\.precision must be one of/],
    [{ method: 'sunbake' }, /method must be one of/],
    [{ finish: 'yes' }, /finish must be true or false/],
    [{ rows: [] }, /non-empty/],
    [{ rows: [{ count: 0 }] }, /count must be a whole number/],
    [{ rows: [{ count: 1, size_value: 8 }] }, /size_unit is required/],
    [{ rows: [{ count: 1, place: { kind: 'garage', label: 'x' } }] }, /place\.kind must be one of/],
    [{ rows: [{ count: 1, place: { kind: 'fridge', label: ' ' } }] }, /needs a name/],
    [{ rows: [{ count: 1, texture: 'snaps' }] }, /texture only applies to a dried food/],
    [{ rows: [{ count: 1, ph: '15' }] }, /pH scale/],
    [{ rows: [{ count: 1, discard_by: 'soon' }] }, /discard_by must be/],
    [{ rows: [{ count: 1, added_lines: [{ qty: 5, qty_unit: 'g' }] }] }, /name what went in/],
    [{ rows: [{ count: 1, added_lines: [{ label: 'x', input_kind: 'pantry' }] }] }, /input_kind must be one of/],
    [{ rows: [{ count: 1, added_lines: [{ label: 'x', input_kind: 'put_up' }] }] }, /a draw names its jar/],
    [{ rows: [{ count: 1, added_lines: [{ label: 'x', output_id: KEY, put_up_stage_id: KEY }] }] }, /belongs to this bottling/],
    [{ rows: [{ count: 1, added_lines: [{ label: 'salt', role: 'salt', qty: 5, qty_unit: 'g', salt_pct: 2, salt_base: 'produce', base_g: 250 }] }] }, /salt facts go on a line in What went in/],
    [{ rows: [{ count: 1, shu_est_low: 900, shu_est_high: 800 }] }, /at least shu_est_low/],
    [{ rows: [{ count: 1, cooked: 'yes' }] }, /cooked must be true or false/],
    [{ mash_in_g: 0 }, /mash_in_g must be greater than 0/],
    [{ made_g: 0 }, /made_g must be greater than 0/],
  ])('%o → 400', (over, want) => expect(validatePutUp(sitting(over))).toMatch(want));
});

describe('planPutUp — what one sitting writes', () => {
  let n = 0;
  const ctx = { batchLabel: 'Megatron mash', notSureDay: '2026-09-20', placeKinds: { [PLACE]: 'deep_freezer' }, newId: () => `id-${++n}` };

  it('jars carry TOTAL contents (count × size), their name, and the engine date + basis for their place', () => {
    const p = planPutUp(sitting(), ctx);
    expect(p.jars).toHaveLength(2);
    expect(p.jars[0]).toMatchObject({
      label: 'Megatron plain', container_label: '8 oz woozy', quantity_value: 16, quantity_unit: 'fl oz', package_count: 2,
      use_by_target: '2027-04-08', use_by_basis: 'table', ph_reading: '3.70',
    });
    // The jar's day is the ET calendar day of the sitting's instant (14:30Z = 10:30 ET, Oct 8).
    expect(p.jar_day).toBe('2026-10-08');
    expect(p.approx).toBe(false);
    // pH at bottling defaults its time to the sitting's.
    expect(p.jars[0].ph_read_at).toBe('2026-10-08T14:30:00.000Z');
  });

  it('a row with no name takes the batch label (which also names an Other)', () => {
    const p = planPutUp(sitting({ method: 'other', rows: [{ count: 1 }] }), ctx);
    expect(p.jars[0].label).toBe('Megatron mash');
  });

  it('the places to find or create are deduped on kind + trimmed, case-folded name', () => {
    const p = planPutUp(sitting(), ctx);
    expect(p.new_places).toEqual([{ kind: 'fridge', label: 'Fridge' }]);
    expect(p.jars.map((j) => [j.place_kind, j.place_label])).toEqual([['fridge', 'Fridge'], ['fridge', 'fridge']]);
  });

  it('a {id} place uses its loaded kind for the engine', () => {
    const p = planPutUp(sitting({ rows: [{ count: 1, place: { id: PLACE } }] }), ctx);
    expect(p.jars[0]).toMatchObject({ place_id: PLACE, place_kind: null, use_by_target: '2027-04-08', use_by_basis: 'table' });
  });

  it('discard_by: a date and "none" are typed; Raw in the fridge is the engine\'s none', () => {
    const p = planPutUp(sitting({ rows: [
      { count: 1, discard_by: '2026-12-01' }, { count: 1, discard_by: 'none' }, { count: 1, is_raw: true, place: { kind: 'fridge', label: 'Fridge' } },
    ] }), ctx);
    expect(p.jars.map((j) => [j.use_by_target, j.use_by_basis])).toEqual([
      ['2026-12-01', 'typed'], [null, 'typed'], [null, 'none'],
    ]);
  });

  it('"Not sure": the stage row is undated (unknown); each jar gets the earliest date, approx, precision after', () => {
    const p = planPutUp(sitting({ when: { precision: 'unknown' } }), ctx);
    expect(p.stage).toMatchObject({ entered_at: null, entered_precision: 'unknown' });
    expect(p).toMatchObject({ jar_day: '2026-09-20', jar_precision: 'after', approx: true });
    // Derived dates start from the stored start (the earliest the estimate allows).
    expect(p.jars[0].use_by_target).toBe('2027-03-20');
  });

  it('a bare day is stored at 16:00Z — that same calendar day in ET, never the evening before', () => {
    const p = planPutUp(sitting({ when: { date: '2026-10-08', precision: 'day' } }), ctx);
    expect(p.stage.entered_at).toBe('2026-10-08T16:00:00.000Z');
    expect(p.jar_day).toBe('2026-10-08');
  });

  it('an estimate chip (month) marks the jars approximate', () => {
    expect(planPutUp(sitting({ when: { date: '2026-09-01', precision: 'month' } }), ctx).approx).toBe(true);
  });

  it('lines: sitting lines have no jar; a row\'s line names that row\'s jar; ordinals follow the order written', () => {
    const p = planPutUp(sitting(), ctx);
    expect(p.lines.map((l) => [l.label, l.output_id === null ? 'sitting' : l.output_id === p.jars[1].id ? 'row 2' : '?', l.ordinal]))
      .toEqual([['reserved brine', 'sitting', 0], ['vinegar', 'row 2', 1]]);
    expect(p.lines.every((l) => l.input_kind === 'other')).toBe(true);
  });

  it('putUpColumns binds each column array in step with the others', () => {
    const c = putUpColumns(planPutUp(sitting(), ctx));
    const lens = [...Object.values(c.jar), ...Object.values(c.line)].map((a) => a.length);
    expect(new Set(Object.values(c.jar).map((a) => a.length))).toEqual(new Set([2]));
    expect(new Set(Object.values(c.line).map((a) => a.length))).toEqual(new Set([2]));
    // 20 jar columns (16 from 1b + F's shu_est_low/high/basis and cooked) + the 27 F line columns.
    expect(lens.length).toBe(47);
  });
});

describe('POST /:id/put-up — what it sends', () => {
  const post = (body) => route(`/api/kitchen-batches/${BATCH}/put-up`, 'POST', body);
  const META = [{ label: 'Megatron mash', not_sure_day: '2026-09-20' }];
  const OK = [{ stage_count: 1, jar_count: 2, line_count: 2 }];
  // readSitting: stage, jars, inputs, then readBatch.
  const READ = [[{ id: 'st' }], [{ id: 'j1', storage_label: 'Fridge', storage_kind: 'fridge' }], [], VIEW];

  it('ONE statement in the actor transaction: gate → keyed put_up row → places → jars → lines → draws → noted → finished', async () => {
    const sql = mockSql([OPEN, META, [], [], OK, ...READ]);
    const res = await handleKitchenRoute({ sql, ...post(sitting()) });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['stage', 'jars', 'inputs', 'batch']);
    const w = sql.calls[4].norm;
    const order = ['WITH gate AS ( UPDATE kitchen_batch SET', '), stage AS ( INSERT INTO kitchen_stage_log', '), made AS ( INSERT INTO storage_location',
      '), jars AS (', 'INSERT INTO preservation_log', '), lines AS ( INSERT INTO kitchen_batch_input', '), draws AS (',
      '), moved AS (', '), uses AS ( INSERT INTO pantry_use', '), noted AS (', '), finished AS ('];
    const at = order.map((o) => w.indexOf(o));
    expect(at.every((i) => i > -1), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Every write hangs off the gate — a closed or removed batch writes nothing.
    expect(w).toContain('AND deleted_at IS NULL AND closed_at IS NULL RETURNING id');
    expect(w).toContain('FROM gate g RETURNING id, batch_id');
    // The key is on the put_up row, with NO ON CONFLICT on it.
    expect(sql.calls[4].values).toContain(KEY);
    expect(w.slice(0, w.indexOf('), places_in AS'))).not.toContain('ON CONFLICT');
  });

  it('the place is found household-first on the trimmed name, else created under the caller', async () => {
    const sql = mockSql([OPEN, META, [], [], OK, ...READ]);
    await handleKitchenRoute({ sql, ...post(sitting()) });
    const w = sql.calls[4].norm;
    expect(w).toContain('lower(btrim(sl.label)) = lower(pi.label) AND sl.user_id = ANY( ? ) AND sl.deleted_at IS NULL');
    expect(w).toContain('ON CONFLICT (user_id, kind, lower(label)) WHERE deleted_at IS NULL DO UPDATE SET label = storage_location.label');
    const kinds = sql.calls[4].values.find((v) => Array.isArray(v) && v.includes('fridge') && v.length === 1);
    expect(kinds).toEqual(['fridge']);
  });

  it('finishing closes the batch as put_up and writes the finished row; a later sitting does neither', async () => {
    let sql = mockSql([OPEN, META, [], [], OK, ...READ]);
    await handleKitchenRoute({ sql, ...post(sitting({ finish: true })) });
    expect(sql.calls[4].values.filter((v) => v === true).length).toBeGreaterThanOrEqual(4);
    sql = mockSql([OPEN, META, [], [], OK, ...READ]);
    await handleKitchenRoute({ sql, ...post(sitting({ finish: false })) });
    const w = sql.calls[4];
    expect(w.norm).toContain("closed_at = CASE WHEN ? ::boolean THEN now() ELSE closed_at END");
    expect(w.values[0]).toBe(false); // finish, the gate's first binding
  });

  it('a closed batch → 409 batch_closed with the door, before any write', async () => {
    const sql = mockSql([CLOSED, []]);
    const res = await handleKitchenRoute({ sql, ...post(sitting()) });
    expect(res).toEqual({ status: 409, body: BATCH_CLOSED });
    expect(res.body.reopen).toBe(true);
    expect(sql.calls).toHaveLength(2);   // the gate, and the replay lookup — never a write
    expect(sql.calls[1].norm).toContain('WHERE s.idempotency_key = ? ::uuid AND b.user_id = ANY( ? )');
  });

  it('a retry of the sitting that FINISHED the batch replays — its own answer, not the door', async () => {
    const sql = mockSql([CLOSED, [{ id: STAGE, batch_id: BATCH }], ...READ]);
    const res = await handleKitchenRoute({ sql, ...post(sitting()) });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
  });

  it('a batch that closed between the gate read and the statement → 409 batch_closed (stage_count 0)', async () => {
    const sql = mockSql([OPEN, META, [], [], [{ stage_count: 0, jar_count: 0, line_count: 0 }]]);
    expect((await handleKitchenRoute({ sql, ...post(sitting()) })).body.code).toBe('batch_closed');
  });

  it('a foreign place id → 400, nothing written', async () => {
    const sql = mockSql([OPEN, []]);
    const res = await handleKitchenRoute({ sql, ...post(sitting({ rows: [{ count: 1, place: { id: PLACE } }] })) });
    expect(res.status).toBe(400);
    expect(sql.calls[1].values).toContainEqual(HOUSEHOLD);
    expect(sql.calls).toHaveLength(2);
  });

  it('"Not sure" with no dated event anywhere → 400 asking for a rough time', async () => {
    const sql = mockSql([OPEN, [{ label: 'x', not_sure_day: null }]]);
    const res = await handleKitchenRoute({ sql, ...post(sitting({ when: { precision: 'unknown' } })) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rough time/);
  });

  it('a replay: 23505 on uq_ksl_idempotency_key re-reads the sitting by key, household-scoped → 200 replayed', async () => {
    const sql = mockSql([OPEN, META, [], [], dup('uq_ksl_idempotency_key'), [{ id: STAGE, batch_id: BATCH }], ...READ]);
    const res = await handleKitchenRoute({ sql, ...post(sitting()) });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(sql.calls[5].norm).toContain('JOIN v_kitchen_batch_current b ON b.id = s.batch_id WHERE s.idempotency_key = ? ::uuid AND b.user_id = ANY( ? )');
  });

  it('a key used on ANOTHER batch, or outside the household → 409 key_conflict', async () => {
    let sql = mockSql([OPEN, META, [], [], dup('uq_ksl_idempotency_key'), [{ id: STAGE, batch_id: 'other-batch' }]]);
    expect((await handleKitchenRoute({ sql, ...post(sitting()) })).body.code).toBe('key_conflict');
    sql = mockSql([OPEN, META, [], [], dup('uq_ksl_idempotency_key'), []]);
    expect((await handleKitchenRoute({ sql, ...post(sitting()) })).body.code).toBe('key_conflict');
  });

  it('any other 23505 is not a replay', async () => {
    const sql = mockSql([OPEN, META, [], [], dup('uq_kbi_idempotency_key')]);
    await expect(handleKitchenRoute({ sql, ...post(sitting()) })).rejects.toThrow('dup');
  });
});

describe('POST /:id/put-up/:stageId/undo — what it sends', () => {
  const undo = () => route(`/api/kitchen-batches/${BATCH}/put-up/${STAGE}/undo`, 'POST', {});
  const DONE = [{ found_count: 1, used_jar_ids: null, voided_count: 2, jars_removed: 2, lines_removed: 1, reopened_count: 1 }];

  it('ONE statement in the actor transaction; voids, jar and line removal and the reopen all gated on the void', async () => {
    const sql = mockSql([CLOSED, [], DONE, VIEW]);
    const res = await handleKitchenRoute({ sql, ...undo() });
    expect(res).toEqual({ status: 200, body: { ok: true, reopened: true, batch: VIEW[0] } });
    expect(sql.batches).toHaveLength(1);
    expect(sql.batches[0][0].norm).toBe("SELECT set_config('app.actor_clerk_sub', ? , true)");
    const w = sql.calls[2].norm;
    for (const cte of ['gone_jars AS', 'gone_lines AS', 'reopened AS']) {
      const body = w.slice(w.indexOf(cte), w.indexOf(')', w.indexOf('EXISTS (SELECT 1 FROM voids v', w.indexOf(cte))));
      expect(body, cte).toContain('EXISTS (SELECT 1 FROM voids v WHERE v.voids_id = ? ::uuid');
    }
  });

  it('refused while a jar of the sitting was used: fewer left than made, or marked used up', async () => {
    const sql = mockSql([OPEN, [], [{ found_count: 1, used_jar_ids: ['j1'], voided_count: 0, jars_removed: 0, lines_removed: 0, reopened_count: 0 }]]);
    const res = await handleKitchenRoute({ sql, ...undo() });
    expect(res).toEqual({ status: 409, body: putUpInUse(['j1']) });
    const w = sql.calls[2].norm;
    expect(w).toContain('WHERE COALESCE(j.remaining_count, j.package_count) < j.package_count OR j.consumed_at IS NOT NULL');
    // The voids read `go`, and `go` is empty while `used` is not — nothing is written.
    expect(w).toContain('go AS ( SELECT t.id FROM target t WHERE NOT EXISTS (SELECT 1 FROM used) )');
  });

  it('reopens ONLY if this sitting closed it (its finished row) and no lifecycle row came after', async () => {
    const sql = mockSql([CLOSED, [], DONE, VIEW]);
    await handleKitchenRoute({ sql, ...undo() });
    const w = sql.calls[2];
    expect(w.norm).toContain('JOIN target t ON f.created_at = t.created_at');
    expect(w.norm).toContain('JOIN target t ON l.created_at > t.created_at');
    expect(w.values).toContainEqual(['put_up', 'finished', 'failed', 'reopened', 'paused', 'resumed']);
    const re = w.norm.slice(w.norm.indexOf('reopened AS ('));
    expect(re).toContain('AND EXISTS (SELECT 1 FROM fin) AND NOT EXISTS (SELECT 1 FROM later)');
  });

  it('a second Undo is a 23505 on uq_ksl_voids_id → 200 replayed', async () => {
    const sql = mockSql([CLOSED, [], dup('uq_ksl_voids_id'), VIEW]);
    const res = await handleKitchenRoute({ sql, ...undo() });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, replayed: true, reopened: false });
  });

  it('an id that is not this batch\'s put_up row → 404', async () => {
    const sql = mockSql([OPEN, [], [{ found_count: 0 }]]);
    expect((await handleKitchenRoute({ sql, ...undo() })).status).toBe(404);
    expect(sql.calls[2].norm).toContain("WHERE s.id = ? ::uuid AND s.batch_id = ? ::uuid AND s.stage_kind = 'put_up'");
  });
});

describe('POST /:id/stages — the 1b kinds', () => {
  const post = (body) => route(`/api/kitchen-batches/${BATCH}/stages`, 'POST', body);

  it('validation: a void carries only voids_id; a note needs its text; now-rows take no date', () => {
    expect(validateStage({ stage_kind: 'void', voids_id: TENDED })).toBeNull();
    expect(validateStage({ stage_kind: 'void', voids_id: TENDED, note: 'x' })).toMatch(/only the row it undoes/);
    expect(validateStage({ stage_kind: 'void' })).toMatch(/voids_id must be/);
    expect(validateStage({ stage_kind: 'tended', voids_id: TENDED })).toMatch(/only goes with stage_kind 'void'/);
    expect(validateStage({ stage_kind: 'noted' })).toMatch(/needs the note/);
    expect(validateStage({ stage_kind: 'paused', entered_at: '2026-10-01T00:00:00Z' })).toMatch(/stamped when it is written/);
    expect(validateStage({ stage_kind: 'put_up' })).toMatch(/stage_kind must be one of/);
    expect(validateStage({ stage_kind: 'tended', entered_precision: 'unknown', entered_at: '2026-10-01T00:00:00Z' })).toMatch(/no date/);
    expect(validateStage({ stage_kind: 'moved', storage_location_id: PLACE, entered_precision: 'month' })).toMatch(/needs an entered_at/);
    expect(validateStage({ stage_kind: 'tended', entered_precision: 'season', entered_at: '2026-07-01T16:00:00Z' })).toBeNull();
  });

  it('void: INSERT…SELECT of a tended/moved/noted row of THIS batch — nothing else can be voided here', async () => {
    const sql = mockSql([OPEN, [{ id: 'v1', stage_kind: 'void', voids_id: TENDED }], VIEW]);
    const res = await handleKitchenRoute({ sql, ...post({ stage_kind: 'void', voids_id: TENDED }) });
    expect(res.status).toBe(201);
    const w = sql.calls[1];
    expect(w.norm).toContain('WHERE t.id = ? ::uuid AND t.batch_id = ? ::uuid AND t.stage_kind = ANY( ? ::text[])');
    expect(w.values).toContainEqual(['tended', 'moved', 'noted']);
  });

  it('void of a put_up / finished / foreign row matches nothing → 400', async () => {
    const sql = mockSql([OPEN, []]);
    expect((await handleKitchenRoute({ sql, ...post({ stage_kind: 'void', voids_id: TENDED }) })).status).toBe(400);
  });

  it('a second void of the same row is a 23505 on uq_ksl_voids_id → 200 replayed', async () => {
    const sql = mockSql([OPEN, dup('uq_ksl_voids_id'), [{ id: 'v1' }], VIEW]);
    const res = await handleKitchenRoute({ sql, ...post({ stage_kind: 'void', voids_id: TENDED }) });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
  });

  it.each([
    ['paused', "WHEN 'paused' THEN closed_at IS NULL AND suspended_at IS NULL"],
    ['resumed', "WHEN 'resumed' THEN suspended_at IS NOT NULL"],
    ['reopened', 'ELSE closed_at IS NOT NULL END'],
  ])('%s moves the batch column and writes the row in ONE statement, state-gated', async (kind, gate) => {
    const sql = mockSql([OPEN, [{ id: 's1', stage_kind: kind }], VIEW]);
    const res = await handleKitchenRoute({ sql, ...post({ stage_kind: kind }) });
    expect(res.status).toBe(201);
    const w = sql.calls[1].norm;
    expect(w).toMatch(/^WITH b AS \( UPDATE kitchen_batch SET/);
    expect(w).toContain(gate);
    expect(w).toContain('INSERT INTO kitchen_stage_log (batch_id, stage_kind, note, entered_at, entered_precision, created_by) SELECT b.id');
  });

  it('a pause of a paused (or closed) batch writes nothing → 409', async () => {
    const sql = mockSql([OPEN, []]);
    const res = await handleKitchenRoute({ sql, ...post({ stage_kind: 'paused' }) });
    expect(res.status).toBe(409);
  });

  it('entered_precision: the row carries exactly the date and word it was given; none → the legacy stamp', async () => {
    let sql = mockSql([OPEN, [{ id: 's1' }], VIEW]);
    await handleKitchenRoute({ sql, ...post({ stage_kind: 'tended', entered_at: '2026-07-01T16:00:00Z', entered_precision: 'season' }) });
    let w = sql.calls[1];
    expect(w.norm).toContain("CASE ? ::text WHEN 'now' THEN now() WHEN 'value' THEN ? ::timestamptz ELSE COALESCE( ? ::timestamptz, now()) END, ? ::text,");
    expect(w.values).toContain('value');
    expect(w.values).toContain('season');
    sql = mockSql([OPEN, [{ id: 's1' }], VIEW]);
    await handleKitchenRoute({ sql, ...post({ stage_kind: 'tended' }) });
    w = sql.calls[1];
    expect(w.values).toContain('legacy');
    sql = mockSql([OPEN, [{ id: 's1' }], VIEW]);
    await handleKitchenRoute({ sql, ...post({ stage_kind: 'noted', note: 'next time more carrot' }) });
    expect(sql.calls[1].values).toEqual(expect.arrayContaining(['now', 'exact', 'next time more carrot']));
  });
});

describe('POST /api/kitchen-batches — 1b', () => {
  const create = (body) => route('/api/kitchen-batches', 'POST', body);

  it('validation: the key is a uuid; a recipe cannot be named before release 4', () => {
    expect(validateBatchCreate({ label: 'x', idempotency_key: 'nope' })).toMatch(/idempotency_key must be a uuid/);
    expect(validateBatchCreate({ label: 'x', recipe_id: KEY })).toMatch(/later release/);
    expect(validateBatchCreate({ label: 'x', started_at: '2026-07-01T16:00:00Z', start_precision: 'season' })).toBeNull();
  });

  it('writes the key on the batch; "Not sure" writes an UNDATED started row (no now() on a retrospective entry)', async () => {
    const sql = mockSql([[{ id: BATCH }], VIEW]);
    await handleKitchenRoute({ sql, ...create({ label: 'Petri Dish', start_precision: 'unknown', idempotency_key: KEY }) });
    const w = sql.calls[0];
    expect(w.values).toContain(KEY);
    expect(w.norm).toContain('CASE WHEN ? ::text IS NULL THEN COALESCE( ? ::timestamptz, now()) ELSE ? ::timestamptz END');
  });

  it('a replay: 23505 on uq_kitchen_batch_idempotency_key re-reads the batch by key through the view → 200', async () => {
    const sql = mockSql([dup('uq_kitchen_batch_idempotency_key'), VIEW]);
    const res = await handleKitchenRoute({ sql, ...create({ label: 'Petri Dish', idempotency_key: KEY }) });
    expect(res).toEqual({ status: 200, body: { ...VIEW[0], replayed: true } });
    expect(sql.calls[1].norm).toContain('FROM v_kitchen_batch_current WHERE idempotency_key = ? ::uuid AND user_id = ANY( ? )');
  });

  it('a key held outside the household → 409 key_conflict', async () => {
    const sql = mockSql([dup('uq_kitchen_batch_idempotency_key'), []]);
    expect((await handleKitchenRoute({ sql, ...create({ label: 'x', idempotency_key: KEY }) })).body.code).toBe('key_conflict');
  });
});

describe('POST /:id/reopen — 1b writes its row', () => {
  it('the reopened row rides the same statement, gated on the reopen', async () => {
    const sql = mockSql([CLOSED, [{ id: BATCH }], VIEW]);
    await handleKitchenRoute({ sql, ...route(`/api/kitchen-batches/${BATCH}/reopen`, 'POST', {}) });
    expect(sql.calls[1].norm).toContain("INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, created_by) SELECT b.id, 'reopened'::text");
  });
});

// ── Boss condition F1, held structurally ─────────────────────────────────────────────────────────
// Postgres applies only ONE of several updates a single statement makes to the same row (UPDATE…FROM
// or a data-modifying CTE per line), so a reversal that joins lines to jars un-aggregated restores +8 g
// instead of +13 g when two lines drew one bag — silently. 1b's statements update each jar at most once
// by construction (Undo soft-deletes `p.id IN (SELECT id FROM sitting_jars)`; no 1b line draws a jar).
// Release F adds the draw reversals; this guard makes the F1 shape the only one that passes: in every
// SQL template of the kitchen routes, at most ONE `UPDATE preservation_log`, and any such UPDATE whose
// FROM reads the line or use tables must read them through a `GROUP BY preservation_log_id`.
function f1Violations(src) {
  const out = [];
  for (const m of src.matchAll(/sql`([\s\S]*?)`/g)) {
    const t = m[1];
    const updates = [...t.matchAll(/UPDATE\s+preservation_log\b/g)];
    if (updates.length > 1) out.push(`two UPDATEs of preservation_log in one statement: ${t.slice(0, 60)}`);
    for (const u of updates) {
      const rest = t.slice(u.index);
      const end = rest.search(/\bRETURNING\b|\)\s*,\s*\w+\s+AS\s*\(|$/);
      const upd = rest.slice(0, end < 0 ? undefined : end);
      const from = upd.match(/\bFROM\b([\s\S]*?)\bWHERE\b/);
      if (from && /\b(kitchen_batch_input|pantry_use)\b/.test(from[1]) && !/GROUP BY\s+[\w.]*preservation_log_id/.test(from[1])) {
        out.push(`un-aggregated reversal: ${upd.replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
  }
  return out;
}

describe('boss condition F1 — one UPDATE per jar per statement', () => {
  // Release F: every module that moves stock — the kitchen routes, the line routes and the use route.
  const FILES = ['kitchenRoutes.js', 'lineRoutes.js', 'pantryUses.js'];
  const read = (f) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), f), 'utf8');

  it.each(FILES)('%s holds it', (f) => {
    const src = read(f);
    expect(src).toMatch(/UPDATE preservation_log/); // not vacuous: there are preservation_log writes to judge
    expect(f1Violations(src)).toEqual([]);
  });

  // Every reversal / re-draw moves its jars through an aggregate keyed on the jar — the one shape F1
  // allows. Counted per module so a new movement cannot arrive un-aggregated.
  it.each([['kitchenRoutes.js', 3], ['lineRoutes.js', 4]])('%s aggregates every stock movement per jar (%i)', (f, n) => {
    const src = read(f);
    expect((src.match(/GROUP BY x\.preservation_log_id\) a/g) ?? []).length).toBe(n);
    expect((src.match(/UPDATE preservation_log p SET\s+(?:deleted_at|remaining_)/g) ?? []).length).toBe(n);
  });

  it('the checker reds on the two shapes F1 forbids, and passes the aggregated one', () => {
    const unaggregated = 'const x = sql`UPDATE preservation_log p SET remaining_count = p.remaining_count + u.count_used FROM pantry_use u WHERE u.preservation_log_id = p.id RETURNING p.id`;';
    const twice = 'const y = sql`WITH a AS (UPDATE preservation_log SET x = 1 RETURNING id), b AS (UPDATE preservation_log SET y = 2 RETURNING id) SELECT 1`;';
    const aggregated = 'const z = sql`UPDATE preservation_log p SET remaining_count = p.remaining_count + d.n FROM (SELECT u.preservation_log_id, sum(u.count_used) AS n FROM pantry_use u GROUP BY u.preservation_log_id) d WHERE d.preservation_log_id = p.id RETURNING p.id`;';
    expect(f1Violations(unaggregated)).toHaveLength(1);
    expect(f1Violations(twice)).toHaveLength(1);
    expect(f1Violations(aggregated)).toEqual([]);
  });
});
