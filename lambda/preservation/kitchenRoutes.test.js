// V5-INFLIGHTBATCH-001 — the /api/kitchen-batches handlers, EXECUTED.
//
// WHY THIS FILE CAN DO WHAT include-consumed.test.js CANNOT. kitchenRoutes.js imports only
// dependency-free siblings and takes `sql` as an argument, so vitest can import and RUN it. These are
// not text assertions about spelling: each route is invoked against a mock driver and the statement it
// issued — its text AND its bound parameters — is asserted. That is the difference between proving a
// household predicate is written and proving it is BOUND.
//
// WHAT IT STILL CANNOT DO. The mock is not Postgres. It cannot prove ON CONFLICT dedupes, that a CTE
// orders as intended, or that a ::cast resolves — those need a real database, and the kitchen_* tables
// do not exist in one yet (contract §1). Every claim below is about what the handler SENDS.
//
// TWO USERS ON EVERY OWNERSHIP ASSERTION. HOUSEHOLD is Dave and Jen; STRANGER is neither. A
// single-owner fixture cannot fail an ownership bug, because the one id it has is the one id that
// matches.
//
// LANE: the root `npm test` run (vitest run --coverage), which is blocking.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleKitchenRoute } from './kitchenRoutes.js';
import { KITCHEN_BATCH_EDITABLE_COLUMNS } from './kitchenBatch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — the same decomment guard the sibling contract
// files carry. Without it this file's own header, which explains why nothing SELECTs from
// kitchen_batch, would itself satisfy the assertion that nothing does.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'kitchenRoutes.js'), 'utf8'));

const HOUSEHOLD = ['user_dave', 'user_jen'];
const STRANGER = ['user_stranger'];
const DAVE = 'user_dave';
const BATCH = 'aaaaaaaa-1111-2222-3333-444444444444';
const INPUT = 'bbbbbbbb-1111-2222-3333-444444444444';
const HARVEST_A = 'cccccccc-1111-2222-3333-444444444444';
const HARVEST_B = 'dddddddd-1111-2222-3333-444444444444';
const PHOTO = 'eeeeeeee-1111-2222-3333-444444444444';
const SHELF = 'ffffffff-1111-2222-3333-444444444444';
const JAR = '99999999-1111-2222-3333-444444444444';

// Records what each route SENDS. `norm` collapses whitespace so a full-literal assertion is about the
// clause and not about how the template happens to be indented.
function mockSql(queue = []) {
  const calls = [];
  const fn = (strings, ...values) => {
    const text = strings.raw.join(' ? ');
    calls.push({ text, norm: text.replace(/\s+/g, ' ').trim(), values });
    if (!queue.length) {
      return Promise.reject(new Error(`unexpected extra query: ${text.replace(/\s+/g, ' ').slice(0, 90)}`));
    }
    return Promise.resolve(queue.shift());
  };
  fn.calls = calls;
  return fn;
}

const OWNED = [{ id: BATCH, closed_at: null, suspended_at: null }];
const VIEW_ROW = [{ id: BATCH, user_id: DAVE, label: 'Pepper mash', current_stage_kind: 'started' }];

const call = (over = {}) => ({
  rawPath: '/api/kitchen-batches', method: 'GET', rawBody: null, query: {},
  userId: DAVE, householdIds: HOUSEHOLD, ...over,
});

// True when this statement binds the caller's household array. The assertion that matters: a
// predicate that is WRITTEN but not BOUND is exactly what a text assertion cannot tell apart.
const boundHousehold = (c, ids = HOUSEHOLD) => c.values.some(
  (v) => Array.isArray(v) && v.length === ids.length && ids.every((id) => v.includes(id)));

describe('the matcher does not annex the preservation routes', () => {
  // This Lambda serves BOTH path families. A matcher that claimed /api/preservation would take over
  // four shipped routes, and every other test in this file would still pass.
  // Mutation: make parseKitchenRoute return { kind: 'collection' } unconditionally.
  it.each([
    '/api/preservation', '/api/preservation/whats-put-up', '/api/preservation/use-soon',
    '/api/preservation/aaaaaaaa-1111-2222-3333-444444444444',
  ])('returns null for %s, and issues no SQL', async (rawPath) => {
    const sql = mockSql();
    expect(await handleKitchenRoute({ sql, ...call({ rawPath }) })).toBeNull();
    expect(sql.calls).toEqual([]);
  });
});

describe('GET /api/kitchen-batches', () => {
  it('reads the VIEW, scoped to the household, with deleted_at stated', async () => {
    const sql = mockSql([VIEW_ROW]);
    const res = await handleKitchenRoute({ sql, ...call() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'going', batches: VIEW_ROW });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].norm).toContain('FROM v_kitchen_batch_current');
    expect(sql.calls[0].norm).toContain('deleted_at IS NULL');
    // Mutation: drop `AND user_id = ANY(${householdIds})`. The text still reads plausibly; only the
    // bound parameter proves the predicate is live.
    expect(boundHousehold(sql.calls[0])).toBe(true);
  });

  it('orders unknown starts LAST, as a full literal including the second key', async () => {
    // 'started_at DESC NULLS LAST, first_recorded_at DESC'.includes('started_at DESC') is true, so a
    // substring assertion passes on a clause that has lost NULLS LAST — the exact ruling from
    // SavedSeeds.jsx:594-613. Mutation: delete ` NULLS LAST`.
    const sql = mockSql([[]]);
    await handleKitchenRoute({ sql, ...call() });
    expect(sql.calls[0].norm)
      .toContain('ORDER BY started_at DESC NULLS LAST, first_recorded_at DESC');
  });

  it('defaults to going, and going INCLUDES suspended batches', async () => {
    // going = closed_at IS NULL. A `suspended_at IS NULL` conjunct would hide the frozen candy parent
    // that resumes over months — a batch that is very much still the cook's to finish.
    const sql = mockSql([[]]);
    await handleKitchenRoute({ sql, ...call() });
    expect(sql.calls[0].values.slice(1, 4)).toEqual([false, true, false]);
    expect(sql.calls[0].norm).not.toContain('suspended_at IS NULL');
  });

  it('binds state=closed and state=all as distinct flag sets', async () => {
    const closed = mockSql([[]]);
    const rc = await handleKitchenRoute({ sql: closed, ...call({ query: { state: 'closed' } }) });
    expect(rc.body.state).toBe('closed');
    expect(closed.calls[0].values.slice(1, 4)).toEqual([false, false, true]);

    const all = mockSql([[]]);
    const ra = await handleKitchenRoute({ sql: all, ...call({ query: { state: 'all' } }) });
    expect(ra.body.state).toBe('all');
    expect(all.calls[0].values.slice(1, 4)).toEqual([true, false, false]);
  });

  it('binds the STRANGER household when a stranger asks, so their query cannot match', async () => {
    const sql = mockSql([[]]);
    await handleKitchenRoute({ sql, ...call({ householdIds: STRANGER }) });
    expect(boundHousehold(sql.calls[0], STRANGER)).toBe(true);
    expect(boundHousehold(sql.calls[0], HOUSEHOLD)).toBe(false);
  });

  it('refuses a verb it does not serve', async () => {
    const sql = mockSql();
    expect((await handleKitchenRoute({ sql, ...call({ method: 'DELETE' }) })).status).toBe(405);
  });
});

describe('GET /api/kitchen-batches/:id', () => {
  it('returns the view row plus inputs and stages, each in its own order', async () => {
    const inputs = [{ id: INPUT }];
    const stages = [{ id: 's1' }];
    const sql = mockSql([OWNED, VIEW_ROW, inputs, stages]);
    const res = await handleKitchenRoute({ sql, ...call({ rawPath: `/api/kitchen-batches/${BATCH}` }) });
    expect(res.status).toBe(200);
    expect(res.body.inputs).toBe(inputs);
    expect(res.body.stages).toBe(stages);
    expect(res.body.label).toBe('Pepper mash');
  });

  it('orders the stage log by entered_at DESC, id DESC — the tiebreak included', async () => {
    // FULL LITERAL. The id DESC tiebreak is not decoration: two rows written in one statement tie on
    // entered_at AND created_at, which a "topped up + skimmed" double-tap produces, and without it
    // "current" is nondeterministic. That is seed_lot_stage_log's defect.
    // Mutation: delete `, id DESC` from the stage query.
    const sql = mockSql([OWNED, VIEW_ROW, [], []]);
    await handleKitchenRoute({ sql, ...call({ rawPath: `/api/kitchen-batches/${BATCH}` }) });
    const stageCall = sql.calls.find((c) => c.norm.includes('FROM kitchen_stage_log'));
    expect(stageCall.norm).toContain('ORDER BY entered_at DESC, id DESC');
    const inputCall = sql.calls.find((c) => c.norm.includes('FROM kitchen_batch_input'));
    expect(inputCall.norm).toContain('ORDER BY added_at DESC, id DESC');
  });

  it('404s for a batch outside the household, with no existence oracle', async () => {
    // The ownership probe comes back empty for the stranger. Mutation: drop the loadOwnedBatch call
    // and read straight through — the detail read would then serve another household's batch.
    const sql = mockSql([[]]);
    const res = await handleKitchenRoute({
      sql, ...call({ rawPath: `/api/kitchen-batches/${BATCH}`, householdIds: STRANGER }),
    });
    expect(res).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(sql.calls).toHaveLength(1);
    expect(boundHousehold(sql.calls[0], STRANGER)).toBe(true);
  });

  it('404s a malformed id without sending it to Postgres', async () => {
    // A 22P02 falling through to an opaque 500 is both a worse contract and a weak "is this even a
    // uuid" side channel. Mutation: delete the KITCHEN_UUID_RE test in loadOwnedBatch.
    const sql = mockSql();
    const res = await handleKitchenRoute({ sql, ...call({ rawPath: '/api/kitchen-batches/not-a-uuid' }) });
    expect(res.status).toBe(404);
    expect(sql.calls).toEqual([]);
  });
});

describe('POST /api/kitchen-batches', () => {
  it('writes the batch and its started stage row in ONE statement', async () => {
    // Two statements over the neon HTTP driver are two transactions, and a batch whose opening stage
    // row failed has a NULL current stage forever — the view has no other source for it.
    // Mutation: split the CTE into two awaited sql`` calls; the length assertion below reds.
    const sql = mockSql([[{ id: BATCH }], VIEW_ROW]);
    const res = await handleKitchenRoute({ sql, ...call({
      method: 'POST', rawBody: JSON.stringify({ label: 'Pepper mash' }),
    }) });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(VIEW_ROW[0]);
    const writes = sql.calls.filter((c) => c.norm.includes('INSERT INTO'));
    expect(writes).toHaveLength(1);
    expect(writes[0].norm).toContain('INSERT INTO kitchen_batch (');
    expect(writes[0].norm).toContain('INSERT INTO kitchen_stage_log (');
    expect(writes[0].norm).toContain("'started'::text");
  });

  it('accepts a label and nothing else, and binds the caller as the owner', async () => {
    const sql = mockSql([[{ id: BATCH }], VIEW_ROW]);
    await handleKitchenRoute({ sql, ...call({
      method: 'POST', rawBody: JSON.stringify({ label: 'Something in the kitchen' }),
    }) });
    expect(sql.calls[0].values[0]).toBe(DAVE);
    expect(sql.calls[0].values[1]).toBe('Something in the kitchen');
  });

  it('stamps the opening stage at the recorded start when there is one', async () => {
    // COALESCE(started_at, now()): a back-dated start IS when this stage began, and first_recorded_at
    // on the batch still carries the honest floor.
    const sql = mockSql([[{ id: BATCH }], VIEW_ROW]);
    await handleKitchenRoute({ sql, ...call({
      method: 'POST',
      rawBody: JSON.stringify({ label: 'Mash', started_at: '2026-08-20T14:00:00Z', start_precision: 'day' }),
    }) });
    expect(sql.calls[0].norm).toContain('COALESCE( ? ::timestamptz, now())');
  });

  it('400s an invalid body before it touches the database', async () => {
    const sql = mockSql();
    const res = await handleKitchenRoute({ sql, ...call({ method: 'POST', rawBody: '{}' }) });
    expect(res).toEqual({ status: 400, body: { error: 'label is required' } });
    expect(sql.calls).toEqual([]);
  });

  it('gates a photo start-anchor, which has no database FK at all', async () => {
    // start_anchor_id is a polymorphic uuid with NO REFERENCES clause, so nothing enforces even
    // existence. Ungated it stores another household's photo id — the storage_location_id class,
    // pre-empted before anything dereferences it. Mutation: delete the gateStartAnchor call in
    // createBatch.
    const sql = mockSql([[]]);
    const res = await handleKitchenRoute({ sql, ...call({
      method: 'POST',
      rawBody: JSON.stringify({ label: 'Mash', start_anchor_kind: 'photo', start_anchor_id: PHOTO }),
    }) });
    expect(res).toEqual({
      status: 400, body: { error: 'start_anchor_id does not match a photo you can use' },
    });
    expect(sql.calls[0].norm).toContain('FROM photos');
    expect(boundHousehold(sql.calls[0])).toBe(true);
  });

  it('gates a harvest start-anchor through the same household predicate', async () => {
    const sql = mockSql([[]]);
    const res = await handleKitchenRoute({ sql, ...call({
      method: 'POST',
      rawBody: JSON.stringify({ label: 'Mash', start_anchor_kind: 'harvest', start_anchor_id: HARVEST_A }),
    }) });
    expect(res.body.error).toBe('start_anchor_id does not match a harvest you can log against');
    expect(sql.calls[0].norm).toContain('FROM harvest_log h');
    expect(boundHousehold(sql.calls[0])).toBe(true);
  });

  it('rejects a cover photo the caller does not own — with the household bound', async () => {
    // photos.created_by is the owner column; the FK enforces existence and says nothing about
    // ownership, and cover_photo_id IS a read surface (it comes straight back on the view row).
    const sql = mockSql([[]]);
    const res = await handleKitchenRoute({ sql, ...call({
      method: 'POST', rawBody: JSON.stringify({ label: 'Mash', cover_photo_id: PHOTO }),
    }) });
    expect(res).toEqual({
      status: 400, body: { error: 'cover_photo_id does not match a photo you can use' },
    });
    expect(sql.calls[0].norm).toContain('FROM photos');
    expect(boundHousehold(sql.calls[0])).toBe(true);
  });
});

describe('PUT /api/kitchen-batches/:id — the merge', () => {
  const put = (body) => call({
    rawPath: `/api/kitchen-batches/${BATCH}`, method: 'PUT', rawBody: JSON.stringify(body),
  });

  it('binds one presence flag and one value per editable column, in order', async () => {
    // THE MERGE CONTRACT, PROVEN. Absent must mean "unchanged" and explicit null must mean "clear";
    // COALESCE collapses them, and a plain body-or-null replace lets a stale service-worker bundle
    // erase a field it has never heard of. Mutation: change any CASE arm to `COALESCE(...)` — the
    // parameter count drops and this reds.
    const sql = mockSql([OWNED, [{ id: BATCH }], VIEW_ROW]);
    await handleKitchenRoute({ sql, ...put({ notes: 'skimmed', brine_note: null }) });
    const upd = sql.calls.find((c) => c.norm.startsWith('UPDATE kitchen_batch SET'));
    expect(upd.values).toHaveLength(KITCHEN_BATCH_EDITABLE_COLUMNS.length * 2 + 2);
    KITCHEN_BATCH_EDITABLE_COLUMNS.forEach((col, i) => {
      const expected = col === 'notes' || col === 'brine_note';
      expect(upd.values[i * 2], `${col} presence flag`).toBe(expected);
    });
    expect(upd.values[KITCHEN_BATCH_EDITABLE_COLUMNS.indexOf('notes') * 2 + 1]).toBe('skimmed');
    expect(upd.values[KITCHEN_BATCH_EDITABLE_COLUMNS.indexOf('brine_note') * 2 + 1]).toBeNull();
  });

  it('leaves every unmentioned column ELSE itself', async () => {
    const sql = mockSql([OWNED, [{ id: BATCH }], VIEW_ROW]);
    await handleKitchenRoute({ sql, ...put({ notes: 'skimmed' }) });
    const upd = sql.calls.find((c) => c.norm.startsWith('UPDATE kitchen_batch SET'));
    for (const col of KITCHEN_BATCH_EDITABLE_COLUMNS) {
      expect(upd.norm, col).toContain(`ELSE ${col} END`);
    }
  });

  it('casts every placeholder in every CASE arm', async () => {
    // ::casts are load-bearing, not cosmetic. A bare placeholder inside a CASE gives Postgres no type
    // context and the neon driver sends untyped params — "could not determine data type of parameter"
    // and the whole PUT 500s. That shipped once on the source_label CASE and only the real-Postgres
    // integration suite caught it. Mutation: delete `::text` after any value placeholder.
    const sql = mockSql([OWNED, [{ id: BATCH }], VIEW_ROW]);
    await handleKitchenRoute({ sql, ...put({ notes: 'x' }) });
    const upd = sql.calls.find((c) => c.norm.startsWith('UPDATE kitchen_batch SET'));
    const arms = upd.norm.slice(0, upd.norm.indexOf('WHERE id ='));
    const uncast = [...arms.matchAll(/\? (?!::)/g)];
    expect(uncast).toEqual([]);
    expect((arms.match(/::boolean THEN/g) ?? []).length).toBe(KITCHEN_BATCH_EDITABLE_COLUMNS.length);
  });

  it('never sets updated_at by hand — the table carries the trigger', async () => {
    // kitchen_batch has set_updated_at, which the preservation family lacks. A hand-set updated_at
    // would be a second writer for a value that already has one.
    const sql = mockSql([OWNED, [{ id: BATCH }], VIEW_ROW]);
    await handleKitchenRoute({ sql, ...put({ notes: 'x' }) });
    const upd = sql.calls.find((c) => c.norm.startsWith('UPDATE kitchen_batch SET'));
    expect(upd.norm).not.toContain('updated_at');
  });

  it('scopes the write to the household and to a live row', async () => {
    const sql = mockSql([OWNED, [{ id: BATCH }], VIEW_ROW]);
    await handleKitchenRoute({ sql, ...put({ notes: 'x' }) });
    const upd = sql.calls.find((c) => c.norm.startsWith('UPDATE kitchen_batch SET'));
    expect(upd.norm).toContain('AND user_id = ANY( ? ) AND deleted_at IS NULL');
    expect(boundHousehold(upd)).toBe(true);
  });

  it('gates a start-anchor on the EDIT path too, not only on create', async () => {
    // The asymmetry index.js's AUTHZ (0A.5) note names: a PUT that can set an FK needs the same gate
    // as the POST, or the edit path reopens what the create path closes.
    // Mutation: delete the gateStartAnchor call in updateBatch.
    const sql = mockSql([OWNED, []]);
    const res = await handleKitchenRoute({ sql, ...put({
      start_anchor_kind: 'photo', start_anchor_id: PHOTO,
    }) });
    expect(res.body.error).toBe('start_anchor_id does not match a photo you can use');
    expect(sql.calls[1].norm).toContain('FROM photos');
    expect(boundHousehold(sql.calls[1])).toBe(true);
  });

  it('400s a body carrying a server-owned column, before any write', async () => {
    const sql = mockSql([OWNED]);
    const res = await handleKitchenRoute({ sql, ...put({ closed_at: '2026-09-01T00:00:00Z' }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('closed_at');
    expect(sql.calls).toHaveLength(1);
  });

  it('404s when the scoped UPDATE matches nothing', async () => {
    const sql = mockSql([OWNED, []]);
    expect((await handleKitchenRoute({ sql, ...put({ notes: 'x' }) })).status).toBe(404);
  });
});

describe('DELETE /api/kitchen-batches/:id', () => {
  it('soft-deletes, scoped to the household', async () => {
    const sql = mockSql([OWNED, [{ id: BATCH }]]);
    const res = await handleKitchenRoute({ sql, ...call({
      rawPath: `/api/kitchen-batches/${BATCH}`, method: 'DELETE',
    }) });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const del = sql.calls[1];
    expect(del.norm).toContain('UPDATE kitchen_batch SET deleted_at = NOW()');
    expect(del.norm).not.toContain('DELETE FROM kitchen_batch');
    expect(boundHousehold(del)).toBe(true);
  });
});

describe('POST /api/kitchen-batches/:id/stages', () => {
  const post = (body) => call({
    rawPath: `/api/kitchen-batches/${BATCH}/stages`, method: 'POST', rawBody: JSON.stringify(body),
  });

  it('appends a stage and returns the refreshed view row beside it', async () => {
    const stage = [{ id: 's1', stage_kind: 'tended' }];
    const sql = mockSql([OWNED, stage, VIEW_ROW]);
    const res = await handleKitchenRoute({ sql, ...post({ stage_kind: 'tended', note: 'still bubbling' }) });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ stage: stage[0], batch: VIEW_ROW[0] });
    expect(sql.calls[1].norm).toContain('INSERT INTO kitchen_stage_log (');
    expect(sql.calls[1].values.at(-1)).toBe(DAVE);
  });

  it('appends a tended row to a batch whose last stage was finished', async () => {
    // Order is NOT monotonic — three of six documented candy recoveries re-enter the sequence. A
    // handler that refused this would encode candying as impossible.
    const sql = mockSql([[{ id: BATCH, closed_at: null, suspended_at: null }], [{ id: 's2' }], VIEW_ROW]);
    const res = await handleKitchenRoute({ sql, ...post({ stage_kind: 'tended', label: 'syrup rung 2', amount: 150, amount_unit: 'g' }) });
    expect(res.status).toBe(201);
  });

  it('appends to a CLOSED batch — a jar going mouldy later is a fact about the process', async () => {
    const sql = mockSql([[{ id: BATCH, closed_at: '2026-09-01T00:00:00Z', suspended_at: null }],
      [{ id: 's3' }], VIEW_ROW]);
    expect((await handleKitchenRoute({ sql, ...post({ stage_kind: 'failed' }) })).status).toBe(201);
  });

  it('offers no PUT and no DELETE on a stage — the absence IS the design', async () => {
    // The off-log repair path is what produced the seed-lot divergence this schema refuses to copy.
    // Mutation: add a PUT arm to the `stages` branch of handleKitchenRoute.
    for (const method of ['PUT', 'DELETE', 'GET']) {
      const sql = mockSql([OWNED]);
      const res = await handleKitchenRoute({ sql, ...call({
        rawPath: `/api/kitchen-batches/${BATCH}/stages`, method,
      }) });
      expect(res.status, method).toBe(405);
    }
  });

  it('rejects a storage location outside the household, with the household bound', async () => {
    // The FK enforces existence, not ownership — and current_storage_location_id comes straight back
    // through the view, so this is a read-surface leak, not merely a bad FK.
    const sql = mockSql([OWNED, []]);
    const res = await handleKitchenRoute({ sql, ...post({ stage_kind: 'moved', storage_location_id: SHELF }) });
    expect(res.body.error).toBe('storage_location_id does not match a storage location you can use');
    expect(sql.calls[1].norm).toContain('FROM storage_location');
    expect(boundHousehold(sql.calls[1])).toBe(true);
  });

  it("400s a 'moved' stage with nowhere to have moved to, before any write", async () => {
    const sql = mockSql([OWNED]);
    const res = await handleKitchenRoute({ sql, ...post({ stage_kind: 'moved' }) });
    expect(res.status).toBe(400);
    expect(sql.calls).toHaveLength(1);
  });
});

describe('POST /api/kitchen-batches/:id/inputs — explicit', () => {
  const post = (body) => call({
    rawPath: `/api/kitchen-batches/${BATCH}/inputs`, method: 'POST', rawBody: JSON.stringify(body),
  });

  it('inserts over unnest and reports what ACTUALLY landed, not what was asked for', async () => {
    // uq_kbi_batch_harvest makes a re-added pick a no-op. Returning the requested count would report
    // 2 for a re-run that inserted nothing. Mutation: return `rows.length` for `inserted`.
    const sql = mockSql([OWNED, [{ id: HARVEST_A }, { id: HARVEST_B }], [{ id: 'i1' }]]);
    const res = await handleKitchenRoute({ sql, ...post({
      inputs: [
        { input_kind: 'harvest', harvest_log_id: HARVEST_A },
        { input_kind: 'harvest', harvest_log_id: HARVEST_B },
      ],
    }) });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ inserted: 1, requested: 2 });
    const ins = sql.calls.at(-1);
    expect(ins.norm).toContain('INSERT INTO kitchen_batch_input (');
    expect(ins.norm).toContain('ON CONFLICT DO NOTHING');
    expect(ins.norm).toContain('FROM unnest(');
  });

  it('binds one array per column, all the same length', async () => {
    const sql = mockSql([OWNED, [{ id: HARVEST_A }], []]);
    await handleKitchenRoute({ sql, ...post({
      inputs: [
        { input_kind: 'harvest', harvest_log_id: HARVEST_A, is_byproduct: true },
        { input_kind: 'pantry', label: 'Kosher salt', qty: 3, qty_unit: 'tbsp' },
      ],
    }) });
    const arrays = sql.calls.at(-1).values.filter(Array.isArray);
    expect(arrays).toHaveLength(7);
    for (const a of arrays) expect(a).toHaveLength(2);
    expect(arrays[0]).toEqual(['harvest', 'pantry']);
    expect(arrays[1]).toEqual([HARVEST_A, null]);
    expect(arrays[5]).toEqual([true, false]);
  });

  it('refuses a harvest from another household — count comparison, no oracle', async () => {
    // Naming WHICH id was rejected is an existence oracle for another household's harvests.
    const sql = mockSql([OWNED, [{ id: HARVEST_A }]]);
    const res = await handleKitchenRoute({ sql, ...post({
      inputs: [
        { input_kind: 'harvest', harvest_log_id: HARVEST_A },
        { input_kind: 'harvest', harvest_log_id: HARVEST_B },
      ],
    }) });
    expect(res).toEqual({
      status: 400,
      body: { error: 'one of those harvests does not match a harvest you can log against' },
    });
    expect(res.body.error).not.toContain(HARVEST_B);
    const gate = sql.calls[1];
    expect(gate.norm).toContain('FROM harvest_log h');
    expect(gate.norm).toContain('h.created_by = ANY( ? )');
    expect(boundHousehold(gate)).toBe(true);
  });

  it('skips the harvest gate entirely when no input is a harvest', async () => {
    // Mutation: call loadOwnedHarvestLogs unconditionally. A pantry-only add would then issue a
    // pointless query and, with an empty id list, could return [] and reject every salt.
    const sql = mockSql([OWNED, [{ id: 'i1' }]]);
    const res = await handleKitchenRoute({ sql, ...post({
      inputs: [{ input_kind: 'pantry', label: 'Kosher salt' }],
    }) });
    expect(res.body).toEqual({ inserted: 1, requested: 1 });
    expect(sql.calls).toHaveLength(2);
  });
});

describe('POST /api/kitchen-batches/:id/inputs — predicate bulk add', () => {
  const post = (predicate) => call({
    rawPath: `/api/kitchen-batches/${BATCH}/inputs`, method: 'POST',
    rawBody: JSON.stringify({ predicate }),
  });

  it('resolves the window inside ONE INSERT..SELECT, household-scoped', async () => {
    // The measured fan-in for one five-week pepper mash is 139 harvest_log rows across 30 plantings.
    // A read-then-write would leave a gap in which a harvest could be logged, archived or re-owned.
    const sql = mockSql([OWNED, Array.from({ length: 139 }, (_, i) => ({ id: i }))]);
    const res = await handleKitchenRoute({ sql, ...post({
      crop_type_slug: 'pepper', from: '2026-08-01', to: '2026-09-04',
    }) });
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(139);
    const ins = sql.calls[1];
    expect(ins.norm).toContain('INSERT INTO kitchen_batch_input (batch_id, input_kind, harvest_log_id, created_by)');
    expect(ins.norm).toContain('FROM harvest_log h');
    expect(ins.norm).toContain('h.created_by = ANY( ? )');
    expect(ins.norm).toContain('h.deleted_at IS NULL');
    expect(ins.norm).toContain('ON CONFLICT DO NOTHING');
    expect(boundHousehold(ins)).toBe(true);
  });

  it('compares the window as ET calendar days, both bounds inclusive', async () => {
    // harvest_log has no date column — a harvest hangs off an event, and event_date is a timestamptz.
    // Comparing it raw against a date would put the boundary at UTC midnight, which is 20:00 ET: the
    // same class as BUG-USEBYDAYBOUNDARY-001, mirrored. Mutation: drop the AT TIME ZONE shift.
    const sql = mockSql([OWNED, []]);
    await handleKitchenRoute({ sql, ...post({ from: '2026-08-01', to: '2026-09-04' }) });
    const ins = sql.calls[1];
    expect(ins.norm).toContain('(e.event_date AT TIME ZONE ? ::text)::date >= ? ::date');
    expect(ins.norm).toContain('(e.event_date AT TIME ZONE ? ::text)::date <= ? ::date');
    expect(ins.values).toContain('America/New_York');
    expect(ins.values).toContain('2026-08-01');
    expect(ins.values).toContain('2026-09-04');
  });

  it('passes an absent selector as NULL so the arm is a no-op, not a no-match', async () => {
    // `${x}::uuid IS NULL OR col = ${x}::uuid` — the cast is what stops the neon driver's untyped
    // param from failing to resolve. Mutation: drop the `IS NULL OR` arm; an unfiltered window would
    // then match nothing at all instead of everything in it.
    const sql = mockSql([OWNED, []]);
    await handleKitchenRoute({ sql, ...post({ from: '2026-08-01', to: '2026-09-04' }) });
    const ins = sql.calls[1];
    expect(ins.norm).toContain('( ? ::uuid IS NULL OR e.plant_id = ? ::uuid)');
    expect(ins.norm).toContain('( ? ::uuid IS NULL OR gn.cultivar_id = ? ::uuid)');
    expect(ins.norm).toContain('( ? ::text IS NULL OR cv.crop_type_slug = ? ::text)');
    expect(ins.values.filter((v) => v === null)).toHaveLength(6);
  });

  it('400s a malformed window before it touches the database', async () => {
    const sql = mockSql([OWNED]);
    const res = await handleKitchenRoute({ sql, ...post({ from: '2026-09-04', to: '2026-08-01' }) });
    expect(res.status).toBe(400);
    expect(sql.calls).toHaveLength(1);
  });
});

describe('DELETE /api/kitchen-batches/:id/inputs/:inputId', () => {
  it('deletes scoped by batch_id as well as id, after the batch gate', async () => {
    // Mutation: drop `AND batch_id = ${batchId}`. An input id belonging to ANOTHER household's batch
    // could then be deleted through a batch the caller does own.
    const sql = mockSql([OWNED, [{ id: INPUT }]]);
    const res = await handleKitchenRoute({ sql, ...call({
      rawPath: `/api/kitchen-batches/${BATCH}/inputs/${INPUT}`, method: 'DELETE',
    }) });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(sql.calls[0].norm).toContain('FROM v_kitchen_batch_current');
    expect(boundHousehold(sql.calls[0])).toBe(true);
    expect(sql.calls[1].norm)
      .toBe('DELETE FROM kitchen_batch_input WHERE id = ? ::uuid AND batch_id = ? ::uuid RETURNING id');
  });

  it('404s a malformed input id without sending it to Postgres', async () => {
    const sql = mockSql([OWNED]);
    const res = await handleKitchenRoute({ sql, ...call({
      rawPath: `/api/kitchen-batches/${BATCH}/inputs/nope`, method: 'DELETE',
    }) });
    expect(res.status).toBe(404);
    expect(sql.calls).toHaveLength(1);
  });
});

describe('POST /api/kitchen-batches/:id/close', () => {
  const post = (body) => call({
    rawPath: `/api/kitchen-batches/${BATCH}/close`, method: 'POST', rawBody: JSON.stringify(body),
  });

  it('closes and links the outputs in ONE statement, with linked GATED on closed', async () => {
    // ORDER IS THE WHOLE POINT. `linked` reads `closed`'s output, so a batch that is already closed,
    // soft-deleted or not the caller's produces an empty `closed` and the preservation_log update
    // touches nothing. Written the other way round, a FAILED close would still have relabelled the
    // jars. Mutation: swap the two CTEs, or replace `FROM closed c` with the batch id.
    const sql = mockSql([OWNED, [{ closed_count: 1, linked_count: 2 }], VIEW_ROW]);
    const res = await handleKitchenRoute({ sql, ...post({
      outcome: 'put_up', output_preservation_log_ids: [JAR],
    }) });
    expect(res.status).toBe(200);
    expect(res.body.linked_output_count).toBe(2);
    const stmt = sql.calls[1].norm;
    expect(stmt.indexOf('WITH closed AS (')).toBeLessThan(stmt.indexOf('), linked AS ('));
    expect(stmt).toContain('UPDATE preservation_log p SET batch_id = c.id, updated_at = NOW() FROM closed c');
    expect(stmt).toContain('suspended_at = NULL');
    expect(stmt).toContain('AND closed_at IS NULL');
  });

  it('is the ONLY route in this module that writes preservation_log', async () => {
    // batch_id is deliberately absent from PRESERVATION_EDITABLE_COLUMNS. A second writer here would
    // be a second way to set it and would reopen exactly what that omission closes.
    // Mutation: add a preservation_log UPDATE to any other handler.
    expect((SRC.match(/preservation_log/g) ?? [])).toHaveLength(1);
  });

  it('scopes BOTH arms to the household — the batch and the jars', async () => {
    const sql = mockSql([OWNED, [{ closed_count: 1, linked_count: 1 }], VIEW_ROW]);
    await handleKitchenRoute({ sql, ...post({ outcome: 'put_up', output_preservation_log_ids: [JAR] }) });
    const stmt = sql.calls[1];
    expect((stmt.norm.match(/user_id = ANY\( \? \)/g) ?? [])).toHaveLength(2);
    expect(stmt.norm).toContain('p.deleted_at IS NULL');
  });

  it('409s a batch that was already closed rather than reporting a success', async () => {
    // closed_count 0 means the scoped UPDATE matched nothing. Reporting 200 here would tell the user
    // their outcome was recorded when the stored one is still whatever it was.
    const sql = mockSql([OWNED, [{ closed_count: 0, linked_count: 0 }]]);
    const res = await handleKitchenRoute({ sql, ...post({ outcome: 'abandoned' }) });
    expect(res).toEqual({ status: 409, body: { error: 'This batch is already closed' } });
  });

  it('accepts a close with no outputs at all', async () => {
    // discarded_spoiled and abandoned produce nothing, and abandoning must be CHEAP or mouldy batches
    // stay open forever and poison the Going-now list.
    const sql = mockSql([OWNED, [{ closed_count: 1, linked_count: 0 }], VIEW_ROW]);
    const res = await handleKitchenRoute({ sql, ...post({ outcome: 'abandoned' }) });
    expect(res.status).toBe(200);
    expect(res.body.linked_output_count).toBe(0);
  });

  it('400s an unknown outcome before any write', async () => {
    const sql = mockSql([OWNED]);
    const res = await handleKitchenRoute({ sql, ...post({ outcome: 'finished' }) });
    expect(res.status).toBe(400);
    expect(sql.calls).toHaveLength(1);
  });
});

describe('the view is the only read surface', () => {
  it('never SELECTs from kitchen_batch directly', async () => {
    // What makes "no current-stage cache" survivable is ONE derivation. The one existing instance of
    // cache-beside-log — inventory_items.seed_stage — has three cache writers and one log writer, all
    // 3 live staged lots diverged, and the shipped stage_entered_at LATERAL returns NULL on 100% of
    // them. Mutation: change readBatch or loadOwnedBatch to read the base table.
    expect(SRC).not.toMatch(/FROM\s+kitchen_batch\b/);
    expect(SRC).toMatch(/FROM v_kitchen_batch_current/);
  });

  it('touches the base table only through INSERT and UPDATE', () => {
    const writes = SRC.match(/(?:INSERT INTO|UPDATE)\s+kitchen_batch\b/g) ?? [];
    expect(writes.length).toBeGreaterThanOrEqual(3);
  });

  it('states deleted_at IS NULL in every list predicate', () => {
    // Soft-Delete-Only, the family rule. The view already filters it; stating it again is what the
    // Phase 3 audit reads and what survives someone rewriting the view.
    const viewReads = SRC.match(/FROM v_kitchen_batch_current[\s\S]*?`/g) ?? [];
    expect(viewReads.length).toBeGreaterThanOrEqual(3);
    for (const r of viewReads) expect(r).toContain('deleted_at IS NULL');
  });
});
