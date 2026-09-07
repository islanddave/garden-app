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
import {
  KITCHEN_BATCH_EDITABLE_COLUMNS, KITCHEN_BATCH_CLOSE_COLUMNS,
  KITCHEN_PREDICATE_MAX_SPAN_DAYS,
} from './kitchenBatch.js';

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

const JAR_B = '88888888-1111-2222-3333-444444444444';

const OWNED = [{ id: BATCH, closed_at: null, suspended_at: null }];
// THE TWO-USER PAIR ON EVERY OWNERSHIP ASSERTION, extended to the closed states. A single-owner
// fixture cannot fail an ownership bug, and a fixture with no closed_at cannot fail a post-close
// policy bug — every close/reopen assertion below names one of these rather than spreading OWNED.
const OWNED_CLOSED = [{ id: BATCH, closed_at: '2026-09-01T12:00:00Z', suspended_at: null }];
const OWNED_PAUSED = [{ id: BATCH, closed_at: null, suspended_at: '2026-08-20T12:00:00Z' }];
const VIEW_ROW = [{ id: BATCH, user_id: DAVE, label: 'Pepper mash', current_stage_kind: 'started' }];
const CLOSED_VIEW_ROW = [{
  id: BATCH, user_id: DAVE, label: 'Pepper mash', current_stage_kind: 'finished',
  closed_at: '2026-09-01T12:00:00Z', outcome: 'put_up', outcome_note: null,
  suspended_at: null, output_count: '2',
}];
const REOPENED_VIEW_ROW = [{
  id: BATCH, user_id: DAVE, label: 'Pepper mash', current_stage_kind: 'finished',
  closed_at: null, outcome: null, outcome_note: null, suspended_at: null, output_count: '2',
}];

const call = (over = {}) => ({
  rawPath: '/api/kitchen-batches', method: 'GET', rawBody: null, query: {},
  userId: DAVE, householdIds: HOUSEHOLD, ...over,
});

// True when this statement binds the caller's household array. The assertion that matters: a
// predicate that is WRITTEN but not BOUND is exactly what a text assertion cannot tell apart.
const boundHousehold = (c, ids = HOUSEHOLD) => c.values.some(
  (v) => Array.isArray(v) && v.length === ids.length && ids.every((id) => v.includes(id)));

// The COLUMN NAMES of a SET clause, pulled out of a normalized statement. A mock driver cannot prove
// a round-trip, only what a handler SENDS — so "close and reopen cannot drift apart" is assertable
// only as set equality between these two clauses and one shared constant. The markers are passed in
// rather than inferred: close's SET sits inside a CTE and reopen's does not, and a regex loose enough
// to find both would also find one inside the other.
function setColumnsOf(norm, startMarker, endMarker) {
  const at = norm.indexOf(startMarker);
  expect(at, `SET marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const from = at + startMarker.length;
  const clause = norm.slice(from, norm.indexOf(endMarker, from));
  // Anchor guard: a slice that matched nothing would make every set assertion below vacuously equal.
  expect(clause.length, 'empty SET clause').toBeGreaterThan(10);
  return clause.split(',').map((s) => s.trim().split(/\s*=/)[0]).filter((s) => /^[a-z_]+$/.test(s));
}

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
  it('returns the view row plus inputs, stages and outputs, each in its own order', async () => {
    const inputs = [{ id: INPUT }];
    const stages = [{ id: 's1' }];
    const outputs = [{ id: JAR, batch_id: BATCH }];
    const sql = mockSql([OWNED, VIEW_ROW, inputs, stages, outputs]);
    const res = await handleKitchenRoute({ sql, ...call({ rawPath: `/api/kitchen-batches/${BATCH}` }) });
    expect(res.status).toBe(200);
    expect(res.body.inputs).toBe(inputs);
    expect(res.body.stages).toBe(stages);
    expect(res.body.outputs).toBe(outputs);
    expect(res.body.label).toBe('Pepper mash');
  });

  it('orders the stage log by entered_at DESC, id DESC — the tiebreak included', async () => {
    // FULL LITERAL. The id DESC tiebreak is not decoration: two rows written in one statement tie on
    // entered_at AND created_at, which a "topped up + skimmed" double-tap produces, and without it
    // "current" is nondeterministic. That is seed_lot_stage_log's defect.
    // Mutation: delete `, id DESC` from the stage query.
    const sql = mockSql([OWNED, VIEW_ROW, [], [], []]);
    await handleKitchenRoute({ sql, ...call({ rawPath: `/api/kitchen-batches/${BATCH}` }) });
    const stageCall = sql.calls.find((c) => c.norm.includes('FROM kitchen_stage_log'));
    expect(stageCall.norm).toContain('ORDER BY entered_at DESC, id DESC');
    const inputCall = sql.calls.find((c) => c.norm.includes('FROM kitchen_batch_input'));
    expect(inputCall.norm).toContain('ORDER BY added_at DESC, id DESC');
  });

  // "Which jars came from that mash" was unanswerable before this: the view carries output_count, an
  // integer, and preservation_log.batch_id was write-only.
  // Mutation: delete the outputs query from getBatch — `res.body.outputs` goes undefined and the
  // first assertion reds; delete `AND deleted_at IS NULL` and the second reds.
  it('scopes outputs to this batch and to live rows, ordered newest put-up first', async () => {
    const sql = mockSql([OWNED, VIEW_ROW, [], [], [{ id: JAR }]]);
    const res = await handleKitchenRoute({ sql, ...call({ rawPath: `/api/kitchen-batches/${BATCH}` }) });
    expect(res.body.outputs).toEqual([{ id: JAR }]);
    const out = sql.calls.find((c) => c.norm.includes('FROM preservation_log'));
    expect(out.norm).toContain('WHERE batch_id = ? ::uuid AND deleted_at IS NULL');
    expect(out.norm).toContain('ORDER BY preserved_at DESC, id DESC');
    expect(out.values).toContain(BATCH);
  });

  // ⚠ THE SHELF-STABILITY SUPPRESSION, asserted with a POSITIVE control on the SAME statement so the
  // absence is about the projection and not about a mistyped selector. The shipped put-up row renders
  // a warn-coloured "Use soon" / "Past use-by" chip off use_by_target; composed with a recorded
  // outcome on the batch surface that becomes an endorsement this app does not make.
  // Mutation: add `use_by_target` to the outputs projection.
  it('does NOT project use_by_target on the batch surface, while projecting the rest of the jar', () => {
    const at = SRC.indexOf('const outputs = await sql`');
    expect(at, 'the outputs query moved or was renamed').toBeGreaterThan(-1);
    const block = SRC.slice(at, SRC.indexOf('`;', at));
    // The anchor guard: without a length floor a slice that matched nothing would satisfy the
    // not.toMatch below and this test would pass over an empty string.
    expect(block.length).toBeGreaterThan(200);
    expect(block).toMatch(/\bmethod\b/);
    expect(block).toMatch(/\bquantity_value\b/);
    expect(block).toMatch(/\bpreserved_at\b/);
    expect(block).not.toMatch(/\buse_by_target\b/);
    expect(block).not.toMatch(/\buse_by_status\b/);
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
    const sql = mockSql([OWNED, [{ matched_count: 139, inserted_count: 139 }]]);
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
    expect(sql.calls).toHaveLength(2);
  });

  // ON CONFLICT DO NOTHING is safe but SILENT: a retry after a dropped response reports inserted 0
  // while 139 rows are already there, which reads as "nothing added". Reporting matched beside it is
  // what lets the client say the true thing without a second round-trip.
  // Mutation: drop the `matched` key from the commit body.
  it('reports what MATCHED beside what landed, so a re-run does not read as a no-op', async () => {
    const sql = mockSql([OWNED, [{ matched_count: 139, inserted_count: 0 }]]);
    const res = await handleKitchenRoute({ sql, ...post({ from: '2026-08-01', to: '2026-09-04' }) });
    expect(res.body).toEqual({ inserted: 0, matched: 139, predicate: { from: '2026-08-01', to: '2026-09-04' } });
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

  // THE SPAN CAP, BOTH BOUNDS. A single-value test here is vacuous: "366 is rejected" is satisfied by
  // a cap of 1. The pair is what pins the boundary to the number the constant names.
  // Mutation (K7): raise KITCHEN_PREDICATE_MAX_SPAN_DAYS by one — the max+1 arm reds. Lower it by
  // one and the max arm reds.
  it('accepts a window exactly at the cap and refuses the next day, without a query', async () => {
    const atCap = mockSql([OWNED, [{ matched_count: 3, inserted_count: 3 }]]);
    // 2026-01-01 .. 2026-12-31 inclusive is 365; one more day reaches the 366 ceiling exactly.
    const ok = await handleKitchenRoute({ sql: atCap, ...post({ from: '2026-01-01', to: '2027-01-01' }) });
    expect(ok.status).toBe(201);
    expect(atCap.calls).toHaveLength(2);

    const overCap = mockSql([OWNED]);
    const res = await handleKitchenRoute({ sql: overCap, ...post({ from: '2026-01-01', to: '2027-01-02' }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(String(KITCHEN_PREDICATE_MAX_SPAN_DAYS));
    // The point of the cap: the write never reaches Postgres.
    expect(overCap.calls).toHaveLength(1);
  });

  it('refuses the unbounded window that inserts every household harvest in one tap', async () => {
    // MEASURED on live prod 2026-09-04: this exact predicate selects 1,212 rows, and the undo is
    // DELETE per row, 1,212 times.
    const sql = mockSql([OWNED]);
    const res = await handleKitchenRoute({ sql, ...post({ from: '2000-01-01', to: '2099-12-31' }) });
    expect(res.status).toBe(400);
    expect(sql.calls).toHaveLength(1);
  });
});

describe('POST /api/kitchen-batches/:id/inputs — the dry run', () => {
  const post = (body) => call({
    rawPath: `/api/kitchen-batches/${BATCH}/inputs`, method: 'POST',
    rawBody: JSON.stringify(body),
  });
  const WINDOW = { crop_type_slug: 'pepper', from: '2026-08-01', to: '2026-09-04' };

  // ⚠ THE INVARIANT THE WHOLE DRY-RUN SHAPE EXISTS FOR. A preview built on a DIFFERENT route would
  // enumerate a different row set from the one the POST inserts and nothing could catch the drift.
  // Here both arms are ONE statement, so the two texts must be byte-identical and the ONLY bound
  // difference is the preview flag. That is a proof they bind an identical predicate, not an argument.
  // Mutation: give the preview arm its own SELECT — the text equality reds.
  it('binds an IDENTICAL predicate on both arms — same statement, one flag apart', async () => {
    const dry = mockSql([OWNED, [{ matched_count: 139, inserted_count: 0 }]]);
    const wet = mockSql([OWNED, [{ matched_count: 139, inserted_count: 139 }]]);
    await handleKitchenRoute({ sql: dry, ...post({ predicate: WINDOW, preview: true }) });
    await handleKitchenRoute({ sql: wet, ...post({ predicate: WINDOW }) });
    const d = dry.calls[1];
    const w = wet.calls[1];
    expect(d.norm).toBe(w.norm);
    expect(d.norm).toContain('WHERE NOT ? ::boolean');
    const differing = d.values
      .map((v, i) => [v, w.values[i]])
      .filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b));
    expect(differing).toEqual([[true, false]]);
  });

  it('returns the matched count and inserts nothing', async () => {
    const sql = mockSql([OWNED, [{ matched_count: 139, inserted_count: 0 }]]);
    const res = await handleKitchenRoute({ sql, ...post({ predicate: WINDOW, preview: true }) });
    // 200 and not 201: a dry run created nothing, and saying Created would be the lie the arm exists
    // to prevent.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matched: 139, predicate: WINDOW });
    expect(res.body).not.toHaveProperty('inserted');
  });

  it('still commits when preview is explicitly false — the flag is read, not merely present', async () => {
    // Mutation: branch on `has(body,'preview')` instead of `body.preview === true`. This reds.
    const sql = mockSql([OWNED, [{ matched_count: 2, inserted_count: 2 }]]);
    const res = await handleKitchenRoute({ sql, ...post({ predicate: WINDOW, preview: false }) });
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(2);
  });

  it('400s a preview on the explicit form, which has nothing to resolve', async () => {
    const sql = mockSql([OWNED]);
    const res = await handleKitchenRoute({ sql, ...post({
      inputs: [{ input_kind: 'pantry', label: 'Kosher salt' }], preview: true,
    }) });
    expect(res).toEqual({ status: 400, body: { error: 'preview only applies to the predicate form' } });
    expect(sql.calls).toHaveLength(1);
  });

  it('400s a non-boolean preview rather than treating a truthy string as a dry run', async () => {
    // The is_byproduct lesson, one field over: "true" must never read as true, and here the failure
    // direction is a client that believes it dry-ran a write that COMMITTED.
    const sql = mockSql([OWNED]);
    const res = await handleKitchenRoute({ sql, ...post({ predicate: WINDOW, preview: 'true' }) });
    expect(res).toEqual({ status: 400, body: { error: 'preview must be true or false' } });
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

  // WAS "the ONLY route that writes preservation_log", a count of 1 over the whole file. That claim
  // is no longer true and it should not be: linking a jar used to require ENDING the batch, and the
  // outputs routes exist to break that coupling. The invariant that MATTERS is unchanged and is what
  // this now enumerates — every writer of preservation_log.batch_id is server-side, in THIS file, and
  // named. batch_id stays out of PRESERVATION_EDITABLE_COLUMNS, so a stale cached bundle's
  // full-replace PUT still cannot reach it (kitchen-batch-id-guard.test.js holds that half).
  // Mutation: add a preservation_log UPDATE to any other handler in this file — the count reds.
  it('writes preservation_log from exactly three statements, each one named', () => {
    const writes = SRC.match(/(?:UPDATE|INSERT INTO|DELETE FROM)\s+preservation_log\b/g) ?? [];
    expect(writes).toEqual(['UPDATE preservation_log', 'UPDATE preservation_log', 'UPDATE preservation_log']);
    // close links, outputs links, outputs unlinks. No INSERT and no DELETE, ever: this module does
    // not create or destroy a jar, only its batch pointer.
    expect(SRC).toContain('SET batch_id = c.id');
    expect(SRC).toContain('SET batch_id = ${batchId}::uuid');
    expect(SRC).toContain('SET batch_id = NULL');
    // The one READ. A fourth reference that is not one of the three writes or this read means a new
    // surface appeared without a decision about what it projects.
    expect((SRC.match(/FROM preservation_log\b/g) ?? [])).toHaveLength(1);
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

  // ⚠ BUG-JARSTEAL-001 (K2). Without `AND p.batch_id IS NULL`, closing batch B with a jar already
  // linked to batch A RE-POINTS it: 200, linked_count counts it, and A's output_count silently drops
  // with no error and no record. The sibling collision (a jar citing a single harvest) fails LOUDLY
  // via a CHECK; this one had nothing behind it.
  // Mutation (K2): delete the conjunct — this test reds and every other close test stays green.
  it('refuses to steal a jar that already belongs to another batch', async () => {
    const sql = mockSql([OWNED, [{ closed_count: 1, linked_count: 1 }], VIEW_ROW]);
    const res = await handleKitchenRoute({ sql, ...post({
      outcome: 'put_up', output_preservation_log_ids: [JAR, JAR_B],
    }) });
    const stmt = sql.calls[1].norm;
    expect(stmt).toContain('AND p.batch_id IS NULL');
    // The positive control on the same statement: the other three predicates are still there, so
    // the assertion above is about the new conjunct and not about a statement that lost its WHERE.
    expect(stmt).toContain('p.user_id = ANY( ? )');
    expect(stmt).toContain('p.deleted_at IS NULL');
    // A skipped jar is SILENT by design — the client compares the two numbers.
    expect(res.status).toBe(200);
    expect(res.body.linked_output_count).toBe(1);
  });

  // §5.4 — the close is the one consequential transition that could not record the observation that
  // decided it. Written in the SAME statement, gated on `closed`, so a 409'd close writes no row.
  // Mutation: move the stage INSERT out of the CTE into a second await — the one-statement
  // assertion reds; drop `FROM closed c` and the gating assertion reds.
  it('writes a finished stage row carrying cue_observed, in the same statement, gated on closed', async () => {
    const sql = mockSql([OWNED, [{ closed_count: 1, linked_count: 0 }], VIEW_ROW]);
    await handleKitchenRoute({ sql, ...post({
      outcome: 'put_up', cue_observed: 'snapped clean instead of bending',
    }) });
    const stmt = sql.calls[1];
    expect(stmt.norm).toContain('), finished AS ( INSERT INTO kitchen_stage_log');
    expect(stmt.norm).toContain("'finished'::text");
    expect(stmt.norm).toContain('FROM closed c');
    expect(stmt.values).toContain('snapped clean instead of bending');
    expect(stmt.values).toContain(DAVE);
    // ONE statement: the close, the links and the stage row cannot land apart.
    expect(sql.calls.filter((c) => c.norm.includes('INSERT INTO'))).toHaveLength(1);
  });

  it('writes the finished row with a NULL cue when nobody said how they knew', async () => {
    // The transition happened either way. A row omitted here would make "we did not ask" and "they
    // told us" the same absence; a NULL cue records the first without inventing the second.
    const sql = mockSql([OWNED, [{ closed_count: 1, linked_count: 0 }], VIEW_ROW]);
    await handleKitchenRoute({ sql, ...post({ outcome: 'abandoned' }) });
    const stmt = sql.calls[1];
    expect(stmt.norm).toContain('), finished AS ( INSERT INTO kitchen_stage_log');
    expect(stmt.values).toContain(null);
  });

  // ⚠ THE REVERSIBILITY GATE (K4), and it is the whole thing that stops close and reopen drifting.
  // Mutation (K4): add a fourth column to the close UPDATE without adding it to
  // KITCHEN_BATCH_CLOSE_COLUMNS — the close arm reds. Drop outcome_note from reopen's NULL set — the
  // reopen arm reds. Both directions, both statements, one constant.
  it('close writes and reopen NULLs exactly KITCHEN_BATCH_CLOSE_COLUMNS — set equality both ways', async () => {
    const closeSql = mockSql([OWNED, [{ closed_count: 1, linked_count: 0 }], VIEW_ROW]);
    await handleKitchenRoute({ sql: closeSql, ...post({ outcome: 'put_up' }) });
    const closeSet = setColumnsOf(closeSql.calls[1].norm, 'WITH closed AS ( UPDATE kitchen_batch SET ', 'WHERE id =');

    const reopenSql = mockSql([OWNED_CLOSED, [{ id: BATCH }], REOPENED_VIEW_ROW]);
    await handleKitchenRoute({ sql: reopenSql, ...call({
      rawPath: `/api/kitchen-batches/${BATCH}/reopen`, method: 'POST', rawBody: '{}',
    }) });
    const reopenSet = setColumnsOf(reopenSql.calls[1].norm, 'UPDATE kitchen_batch SET ', 'WHERE id =');

    // suspended_at is the one column close writes that is NOT part of the close's record — it is the
    // pause being cleared because chk_kitchen_batch_suspend_exclusive forbids the pair — so it is
    // excluded by name here rather than by silence, and the reopen deliberately does not restore it.
    expect(closeSet.filter((c) => c !== 'suspended_at').sort())
      .toEqual([...KITCHEN_BATCH_CLOSE_COLUMNS].sort());
    expect(closeSet).toContain('suspended_at');
    expect(reopenSet.sort()).toEqual([...KITCHEN_BATCH_CLOSE_COLUMNS].sort());
  });
});

describe('POST /api/kitchen-batches/:id/reopen', () => {
  const reopen = () => call({
    rawPath: `/api/kitchen-batches/${BATCH}/reopen`, method: 'POST', rawBody: '{}',
  });

  it('NULLs the close columns, scoped to the household and to a CLOSED live row', async () => {
    // Mutation (K5): drop `AND user_id = ANY(${householdIds})`. The text still reads plausibly; only
    // the bound parameter proves the predicate is live — a stranger could otherwise reopen a batch
    // the ownership gate had already refused them, if the gate were ever refactored away.
    const sql = mockSql([OWNED_CLOSED, [{ id: BATCH }], REOPENED_VIEW_ROW]);
    const res = await handleKitchenRoute({ sql, ...reopen() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(REOPENED_VIEW_ROW[0]);
    const upd = sql.calls[1];
    expect(upd.norm).toContain('UPDATE kitchen_batch SET closed_at = NULL, outcome = NULL, outcome_note = NULL');
    expect(upd.norm).toContain('AND user_id = ANY( ? ) AND deleted_at IS NULL AND closed_at IS NOT NULL');
    expect(boundHousehold(upd)).toBe(true);
  });

  it('binds the STRANGER household when a stranger asks, so their reopen cannot match', async () => {
    const sql = mockSql([[]]);
    const res = await handleKitchenRoute({ sql, ...call({
      rawPath: `/api/kitchen-batches/${BATCH}/reopen`, method: 'POST', rawBody: '{}',
      householdIds: STRANGER,
    }) });
    expect(res).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(boundHousehold(sql.calls[0], STRANGER)).toBe(true);
    expect(boundHousehold(sql.calls[0], HOUSEHOLD)).toBe(false);
  });

  it('409s a batch that is not closed, and the state gate is IN THE STATEMENT', async () => {
    // The mirror of close's 409. Reporting 200 would tell the user their close was undone when
    // nothing changed.
    const sql = mockSql([OWNED, []]);
    const res = await handleKitchenRoute({ sql, ...reopen() });
    expect(res).toEqual({ status: 409, body: { error: 'This batch is not closed' } });
    // ⚠ THE SECOND HALF, AND IT IS NOT DECORATION. A mock driver returns [] whatever the WHERE says,
    // so the assertion above ALONE is satisfied by a handler carrying no state gate at all — the
    // 409 would then be reporting "not closed" for a row that was closed and merely unmatched. The
    // gate has to live in the statement, because a client-side check races by construction.
    // Mutation: delete `AND closed_at IS NOT NULL` from reopenBatch — this reds.
    expect(sql.calls[1].norm).toContain('AND closed_at IS NOT NULL');
  });

  // ⚠ NO output_count GATE, and its ABSENCE is asserted with a positive control on the same
  // statement so this is about the predicate set and not about a mistyped selector. A "reopen only
  // while nothing is linked" rule reads as safety and is not: output_count falls to 0 when the jars
  // are soft-deleted, so the gate would open through an action with nothing to do with reopening.
  // Mutation: add `AND (SELECT output_count ...) = 0` to the statement — the first arm reds while
  // the controls stay green, which is what makes the absence non-vacuous.
  it('is UNCONDITIONAL — no output_count predicate, on a batch that has outputs', async () => {
    const sql = mockSql([OWNED_CLOSED, [{ id: BATCH }], CLOSED_VIEW_ROW]);
    const res = await handleKitchenRoute({ sql, ...reopen() });
    const upd = sql.calls[1].norm;
    expect(upd).not.toMatch(/output_count|linked_output_count/);
    expect(upd).toContain('closed_at IS NOT NULL');
    expect(upd).toContain('user_id = ANY( ? )');
    expect(res.status).toBe(200);
  });

  // It inverts the CLOSE, not the linking. A jar linked on an OPEN batch through POST /:id/outputs is
  // a standalone assertion, and a reopen that cleared every link would destroy it.
  // Mutation: add an `unlinked` CTE clearing batch_id — this reds.
  it('does not touch the jars it produced', async () => {
    const sql = mockSql([OWNED_CLOSED, [{ id: BATCH }], REOPENED_VIEW_ROW]);
    await handleKitchenRoute({ sql, ...reopen() });
    expect(sql.calls[1].norm).not.toContain('preservation_log');
    expect(sql.calls[1].norm).toContain('UPDATE kitchen_batch SET');
  });

  // ⚠ THE PAUSE IS NOT RESTORED, and that is intended rather than overlooked. close sets
  // suspended_at = NULL because chk_kitchen_batch_suspend_exclusive forbids a suspended closed batch,
  // so paused -> closed -> reopened lands ACTIVE and the batch moves out of the Paused group. This
  // test exists so that transition is a decision on the record, not a surprise in a card.
  it('resumes a paused batch: paused -> closed -> reopened comes back ACTIVE', async () => {
    const closeSql = mockSql([OWNED_PAUSED, [{ closed_count: 1, linked_count: 0 }], CLOSED_VIEW_ROW]);
    const closed = await handleKitchenRoute({ sql: closeSql, ...call({
      rawPath: `/api/kitchen-batches/${BATCH}/close`, method: 'POST',
      rawBody: JSON.stringify({ outcome: 'put_up' }),
    }) });
    expect(closeSql.calls[1].norm).toContain('suspended_at = NULL');
    expect(closed.body.suspended_at).toBeNull();

    const reopenSql = mockSql([OWNED_CLOSED, [{ id: BATCH }], REOPENED_VIEW_ROW]);
    const reopened = await handleKitchenRoute({ sql: reopenSql, ...reopen() });
    expect(reopenSql.calls[1].norm).not.toContain('suspended_at');
    expect(reopened.body.closed_at).toBeNull();
    expect(reopened.body.suspended_at).toBeNull();
  });

  it('refuses every verb but POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const sql = mockSql([OWNED_CLOSED]);
      const res = await handleKitchenRoute({ sql, ...call({
        rawPath: `/api/kitchen-batches/${BATCH}/reopen`, method,
      }) });
      expect(res.status, method).toBe(405);
    }
  });
});

describe('POST /api/kitchen-batches/:id/outputs — link without closing', () => {
  const post = (body) => call({
    rawPath: `/api/kitchen-batches/${BATCH}/outputs`, method: 'POST', rawBody: JSON.stringify(body),
  });

  it('links jars on an OPEN batch, household-scoped, and reports both numbers', async () => {
    // The coupling this breaks: close was the only writer of batch_id, so a partial draw-off from a
    // batch that keeps going — the commonest real event in both processes — was unrepresentable.
    const sql = mockSql([OWNED, [{ id: JAR }]]);
    const res = await handleKitchenRoute({ sql, ...post({ preservation_log_ids: [JAR, JAR_B] }) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: 1, requested: 2 });
    const upd = sql.calls[1];
    expect(upd.norm).toContain('UPDATE preservation_log p SET batch_id = ? ::uuid, updated_at = NOW()');
    expect(upd.norm).toContain('p.user_id = ANY( ? )');
    expect(upd.norm).toContain('p.deleted_at IS NULL');
    expect(boundHousehold(upd)).toBe(true);
  });

  // Mutation (K14, server half): delete `AND p.batch_id IS NULL` from linkOutputs. Without it this
  // route becomes a second door for BUG-JARSTEAL-001 — the one close just had shut.
  it('refuses to steal a jar that already belongs to another batch', async () => {
    const sql = mockSql([OWNED, []]);
    const res = await handleKitchenRoute({ sql, ...post({ preservation_log_ids: [JAR] }) });
    expect(sql.calls[1].norm).toContain('AND p.batch_id IS NULL');
    expect(sql.calls[1].norm).toContain('p.user_id = ANY( ? )');
    expect(res.body).toEqual({ linked: 0, requested: 1 });
  });

  it('dedupes before it counts, so naming one jar twice asks for one link', async () => {
    const sql = mockSql([OWNED, [{ id: JAR }]]);
    const res = await handleKitchenRoute({ sql, ...post({ preservation_log_ids: [JAR, JAR] }) });
    expect(res.body).toEqual({ linked: 1, requested: 1 });
    expect(sql.calls[1].values[1]).toEqual([JAR]);
  });

  it('binds the STRANGER household so a stranger cannot link their way in', async () => {
    const sql = mockSql([[]]);
    const res = await handleKitchenRoute({ sql, ...call({
      rawPath: `/api/kitchen-batches/${BATCH}/outputs`, method: 'POST',
      rawBody: JSON.stringify({ preservation_log_ids: [JAR] }), householdIds: STRANGER,
    }) });
    expect(res.status).toBe(404);
    expect(boundHousehold(sql.calls[0], STRANGER)).toBe(true);
  });

  it.each([
    [{}, 'preservation_log_ids must be an array'],
    [{ preservation_log_ids: [] }, 'preservation_log_ids must be a non-empty array'],
    [{ preservation_log_ids: ['nope'] }, 'preservation_log_ids must all be uuids'],
  ])('400s %j before any write', async (body, error) => {
    const sql = mockSql([OWNED]);
    const res = await handleKitchenRoute({ sql, ...post(body) });
    expect(res).toEqual({ status: 400, body: { error } });
    expect(sql.calls).toHaveLength(1);
  });
});

describe('DELETE /api/kitchen-batches/:id/outputs/:plid — the repair path', () => {
  const del = (plid) => call({
    rawPath: `/api/kitchen-batches/${BATCH}/outputs/${plid}`, method: 'DELETE',
  });

  it('unlinks scoped by batch_id AS WELL AS id, with the household bound', async () => {
    // Mutation: drop `AND p.batch_id = ${batchId}`. A jar linked to ANOTHER batch could then be
    // unlinked through a batch the caller does own — the deleteInput hazard, one table over.
    const sql = mockSql([OWNED_CLOSED, [{ id: JAR }]]);
    const res = await handleKitchenRoute({ sql, ...del(JAR) });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const upd = sql.calls[1];
    expect(upd.norm).toContain('SET batch_id = NULL, updated_at = NOW()');
    expect(upd.norm).toContain('AND p.batch_id = ? ::uuid');
    expect(upd.norm).toContain('p.user_id = ANY( ? )');
    expect(boundHousehold(upd)).toBe(true);
  });

  it('404s a malformed jar id without sending it to Postgres', async () => {
    const sql = mockSql([OWNED]);
    const res = await handleKitchenRoute({ sql, ...del('nope') });
    expect(res.status).toBe(404);
    expect(sql.calls).toHaveLength(1);
  });

  it('404s when nothing matched — idempotent in state, not in status', async () => {
    const sql = mockSql([OWNED, []]);
    expect((await handleKitchenRoute({ sql, ...del(JAR) })).status).toBe(404);
  });
});

// ⚠ THE POST-CLOSE WRITE POLICY, stated per route and EXECUTED. Before this, a closed batch accepted
// every content write and the comment claiming two routes branched on closed_at described a branch
// that did not exist. Each arm below is one cell of the state machine; the `stages` arm is the
// green control that keeps the three refusals from being satisfied by a handler that refuses
// everything.
describe('what a CLOSED batch accepts', () => {
  const on = (over) => call({ rawPath: `/api/kitchen-batches/${BATCH}`, ...over });

  it('ALLOWS a stage — a jar going mouldy three weeks later is a fact about the process', async () => {
    const sql = mockSql([OWNED_CLOSED, [{ id: 's9' }], CLOSED_VIEW_ROW]);
    const res = await handleKitchenRoute({ sql, ...on({
      rawPath: `/api/kitchen-batches/${BATCH}/stages`, method: 'POST',
      rawBody: JSON.stringify({ stage_kind: 'failed', cue_observed: 'mould on the surface' }),
    }) });
    expect(res.status).toBe(201);
  });

  it('REFUSES an input add — 409, naming the door', async () => {
    const sql = mockSql([OWNED_CLOSED]);
    const res = await handleKitchenRoute({ sql, ...on({
      rawPath: `/api/kitchen-batches/${BATCH}/inputs`, method: 'POST',
      rawBody: JSON.stringify({ inputs: [{ input_kind: 'pantry', label: 'Kosher salt' }] }),
    }) });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('reopen');
    expect(sql.calls).toHaveLength(1);
  });

  it('REFUSES an input delete', async () => {
    const sql = mockSql([OWNED_CLOSED]);
    const res = await handleKitchenRoute({ sql, ...on({
      rawPath: `/api/kitchen-batches/${BATCH}/inputs/${INPUT}`, method: 'DELETE',
    }) });
    expect(res.status).toBe(409);
    expect(sql.calls).toHaveLength(1);
  });

  it('REFUSES the merge PUT', async () => {
    const sql = mockSql([OWNED_CLOSED]);
    const res = await handleKitchenRoute({ sql, ...on({
      method: 'PUT', rawBody: JSON.stringify({ notes: 'rewriting history' }),
    }) });
    expect(res.status).toBe(409);
    expect(sql.calls).toHaveLength(1);
  });

  // The fifth cell, and it is deliberately NOT a refusal. Closing as put_up with the wrong jars is
  // the expensive mis-tap and was permanently unfixable; refusing an unlink here would re-create the
  // trap the decoupling removed.
  it('ALLOWS unlinking a jar — the repair path for the expensive mis-tap', async () => {
    const sql = mockSql([OWNED_CLOSED, [{ id: JAR }]]);
    const res = await handleKitchenRoute({ sql, ...on({
      rawPath: `/api/kitchen-batches/${BATCH}/outputs/${JAR}`, method: 'DELETE',
    }) });
    expect(res).toEqual({ status: 200, body: { ok: true } });
  });

  // The OPEN-batch control on all four arms above. Without it, a handler that refused these routes
  // unconditionally would pass every refusal test in this block.
  it('accepts all four on an OPEN batch — the control that makes the refusals mean something', async () => {
    const addSql = mockSql([OWNED, [{ id: 'i1' }]]);
    expect((await handleKitchenRoute({ sql: addSql, ...on({
      rawPath: `/api/kitchen-batches/${BATCH}/inputs`, method: 'POST',
      rawBody: JSON.stringify({ inputs: [{ input_kind: 'pantry', label: 'Kosher salt' }] }),
    }) })).status).toBe(201);

    const delSql = mockSql([OWNED, [{ id: INPUT }]]);
    expect((await handleKitchenRoute({ sql: delSql, ...on({
      rawPath: `/api/kitchen-batches/${BATCH}/inputs/${INPUT}`, method: 'DELETE',
    }) })).status).toBe(200);

    const putSql = mockSql([OWNED, [{ id: BATCH }], VIEW_ROW]);
    expect((await handleKitchenRoute({ sql: putSql, ...on({
      method: 'PUT', rawBody: JSON.stringify({ notes: 'skimmed' }),
    }) })).status).toBe(200);

    const stageSql = mockSql([OWNED, [{ id: 's1' }], VIEW_ROW]);
    expect((await handleKitchenRoute({ sql: stageSql, ...on({
      rawPath: `/api/kitchen-batches/${BATCH}/stages`, method: 'POST',
      rawBody: JSON.stringify({ stage_kind: 'tended' }),
    }) })).status).toBe(201);
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
