// BUG-SEEDSTAGEDOUBLETAP-001 — POST /:id/seed-stage does not append a repeat of the lot's newest
// entry.
//
// THE DEFECT. Prod lot 69832d29 got two `stored` rows in seed_lot_stage_log 8 s apart: same picked
// day, no note. The CTE was a bare INSERT, and the log has no DELETE route, so each duplicate cost a
// hand delete. The likeliest path is a re-tap after the client stopped waiting (15 s) on a write
// that had already committed.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. The stub records SQL and executes none of it, so nothing here
// shows that a repeat writes no row, that a go-back still writes one, or that the lock serialises two
// requests — those are the BUG-SEEDSTAGEDOUBLETAP-001 cases in
// tests/integration/seed-lifecycle.int.test.js, on a real Postgres. What IS provable here:
//   - the lot lock is the FIRST statement, in the same sql.transaction as the write;
//   - the repeat check reads the NEWEST entry only, by the readers' key;
//   - the predicate's parts, and what the request binds into them;
//   - the INSERT is guarded by it;
//   - what each answer says over HTTP: 201 written, 200 repeat (same body), 404 nothing.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import { etDay } from './seed-stage-date.js';
import { decommentSqlDashSpace as decomment } from '../_test-stubs/handlerSource.js';

const { handler } = await import('./index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const ARM = INDEX_SRC.slice(
  INDEX_SRC.indexOf('const seedStageMatch = rawPath.match'),
  INDEX_SRC.indexOf('const sourcePlantsMatch = rawPath.match'),
);

const USER = 'user_stub_owner';
const ITEM = '2d6df841-b507-4e65-8db0-97c8659df37c';
const stagePost = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: `/api/inventory-items/${ITEM}/seed-stage`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });
const flat = (text) => text.replace(/\s+/g, ' ').trim();
// The stub joins the template on '?', so a placeholder's value is indexed by the '?' before it.
const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};

const ENTRY = {
  id: 'log-1', inventory_item_id: ITEM, stage: 'stored', entered_at: '2026-09-01T16:00:00.000Z', note: null,
};
// The lock answers with the lot; the write answers with whatever the case says.
const answering = (writeRows) => (text) => (/WITH upd AS/.test(text) ? writeRows : [{ id: ITEM }]);

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = answering([{ ...ENTRY, repeated: false }]);
});

describe('the lot is locked before the write, in one transaction', () => {
  it('statement 0 is the lot, FOR UPDATE, behind the same scope as the write', async () => {
    await handler(stagePost({ stage: 'stored', entered_at: '2026-09-01T12:00:00' }));
    expect(stubState.sqlCalls).toHaveLength(2);
    const [lock, write] = stubState.sqlCalls;
    expect(flat(lock.text)).toBe(
      "SELECT i.id FROM public.inventory_items i WHERE i.id = ? AND i.created_by = ANY(?) AND i.deleted_at IS NULL AND i.category = 'seeds' FOR UPDATE",
    );
    expect(lock.values).toEqual([ITEM, [USER]]);
    expect(write.text).toMatch(/^\s*WITH upd AS \(/);
  });

  it('both statements go through ONE sql.transaction, lock first', () => {
    // Two awaited statements would each autocommit, and the lock would be released before the write.
    const tx = ARM.match(/await sql\.transaction\(\[\s*sql`([^`]*)`\s*,\s*sql`([^`]*)`\s*,?\s*\]\)/);
    expect(tx, 'the /seed-stage write is not a two-statement sql.transaction').toBeTruthy();
    expect(tx[1]).toMatch(/FOR UPDATE\s*$/);
    expect(tx[2]).toMatch(/INSERT INTO public\.seed_lot_stage_log/);
    // …and nothing else in the arm appends to the log.
    expect(ARM.match(/INSERT INTO public\.seed_lot_stage_log/g)).toHaveLength(1);
  });
});

describe('the repeat check reads the newest entry only', () => {
  it('`newest` is the lot\'s first entry by the GET arm\'s own key, LIMIT 1', async () => {
    await handler(stagePost({ stage: 'stored', entered_at: '2026-09-01T12:00:00' }));
    const text = flat(stubState.sqlCalls[1].text);
    expect(text).toContain(
      'newest AS ( SELECT l.id, l.inventory_item_id, l.stage, l.entered_at, l.note, l.created_at '
      + 'FROM public.seed_lot_stage_log l JOIN upd ON upd.id = l.inventory_item_id '
      + 'ORDER BY l.created_at DESC, l.entered_at DESC, l.id DESC LIMIT 1 )',
    );
    // The key is the readers' key, byte for byte: the GET arm orders by exactly this.
    expect(flat(ARM)).toContain('ORDER BY l.created_at DESC, l.entered_at DESC, l.id DESC `');
    // The predicate reads `newest` and nothing else: compared against ANY row, a go-back to an
    // older stage and date would be swallowed.
    expect(text).toMatch(/dup AS \( SELECT [^()]* FROM newest n WHERE /);
    expect((text.match(/FROM public\.seed_lot_stage_log/g) ?? [])).toHaveLength(1);
  });
});

describe('the predicate', () => {
  it('same stage, note IS NOT DISTINCT FROM, and an identical entered_at or the 120 s window', async () => {
    await handler(stagePost({ stage: 'stored', entered_at: '2026-09-01T12:00:00', note: '  dry jar  ' }));
    const call = stubState.sqlCalls[1];
    const text = flat(call.text);
    expect(text).toContain(
      'WHERE n.stage = ? AND n.note IS NOT DISTINCT FROM ? AND ( n.entered_at = COALESCE(?::timestamptz, NOW()) '
      + "OR ( ?::boolean AND n.created_at > NOW() - INTERVAL '120 seconds' "
      + 'AND abs(extract(epoch FROM n.entered_at - COALESCE(?::timestamptz, NOW()))) <= 120 ) )',
    );
    expect(boundAfter(call, /WHERE n\.stage = /)).toBe('stored');
    // The note as the INSERT writes it, trimmed — a padded re-send is the same note.
    expect(boundAfter(call, /n\.note IS NOT DISTINCT FROM /)).toBe('dry jar');
    expect(boundAfter(call, /AND \(\s*n\.entered_at = COALESCE\(/)).toBe('2026-09-01T16:00:00.000Z');
    // A picked past day is matched exactly and only exactly: the window is OFF for it.
    expect(boundAfter(call, /OR \(\s*/)).toBe(false);
  });

  it('no note is null on both sides, so two note-less taps match', async () => {
    await handler(stagePost({ stage: 'stored', entered_at: '2026-09-01T12:00:00', note: '   ' }));
    expect(boundAfter(stubState.sqlCalls[1], /n\.note IS NOT DISTINCT FROM /)).toBeNull();
  });

  it('the window is ON when the request is dated by its own instant: today\'s day marker, or no entered_at', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = answering([{ ...ENTRY, repeated: false }]);
      const today = etDay(new Date());
      await handler(stagePost({ stage: 'stored', entered_at: `${today}T12:00:00` }));
      if (etDay(new Date()) !== today) continue;
      expect(boundAfter(stubState.sqlCalls[1], /OR \(\s*/)).toBe(true);
      break;
    }
    resetStubs();
    stubState.verifyTokenResult = { sub: USER };
    stubState.sqlHandler = answering([{ ...ENTRY, repeated: false }]);
    // SaveSeedSheet's intake: absent -> NOW().
    await handler(stagePost({ stage: 'drying', seed_process: 'dry' }));
    const call = stubState.sqlCalls[1];
    expect(boundAfter(call, /OR \(\s*/)).toBe(true);
    expect(boundAfter(call, /AND \(\s*n\.entered_at = COALESCE\(/)).toBeNull();
  });

  it('a full instant that is not now is matched exactly, window OFF', async () => {
    await handler(stagePost({ stage: 'drying', entered_at: '2026-09-01T09:15:00Z' }));
    expect(boundAfter(stubState.sqlCalls[1], /OR \(\s*/)).toBe(false);
  });

  it('the INSERT writes only when the check found nothing', async () => {
    await handler(stagePost({ stage: 'stored', entered_at: '2026-09-01T12:00:00' }));
    const text = flat(stubState.sqlCalls[1].text);
    expect(text).toContain(
      'INSERT INTO public.seed_lot_stage_log (inventory_item_id, stage, entered_at, note, created_by) '
      + 'SELECT upd.id, ?, COALESCE(?::timestamptz, NOW()), ?, ? FROM upd WHERE NOT EXISTS (SELECT 1 FROM dup) '
      + 'RETURNING id, inventory_item_id, stage, entered_at, note )',
    );
    // The answer is the written row or the standing one, never both: the INSERT is empty exactly
    // when `dup` is not.
    expect(text).toMatch(/SELECT ins\.id, [^;]* false AS repeated FROM ins UNION ALL SELECT dup\.id, [^;]* true AS repeated FROM dup$/);
  });
});

describe('what each answer says over HTTP', () => {
  it('a written entry is 201 with the row, and no `repeated` key', async () => {
    const res = parse(await handler(stagePost({ stage: 'stored', entered_at: '2026-09-01T12:00:00' })));
    expect(res).toEqual({ status: 201, body: ENTRY });
  });

  it('a repeat is 200 with the entry that stands, in the same shape', async () => {
    stubState.sqlHandler = answering([{ ...ENTRY, repeated: true }]);
    const res = parse(await handler(stagePost({ stage: 'stored', entered_at: '2026-09-01T12:00:00' })));
    expect(res).toEqual({ status: 200, body: ENTRY });
  });

  it('nothing matched is 404, as before — wrong household, deleted, or not seeds', async () => {
    stubState.sqlHandler = () => [];
    const res = parse(await handler(stagePost({ stage: 'stored', entered_at: '2026-09-01T12:00:00' })));
    expect(res).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(stubState.sqlCalls).toHaveLength(2);
  });
});
