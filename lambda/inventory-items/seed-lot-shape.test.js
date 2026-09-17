// The two seed-lot defects that live in this handler, both driven through the real handler rather
// than read off its source.
//
// BUG-SEEDPROCFORCED-001 — /seeds/saved could only start a lot in `fermenting`, and the /seed-stage
// POST writes a PERMANENT seed_lot_stage_log row, so a dry-cleaned lot could only be recorded by
// asserting a ferment that never happened. The route now carries the lot's PROCESS alongside the
// stage that opens it, under the same presence guard the PUT arm uses, in the same CTE.
//
// BUG-SEEDELAPSEDUPDATED-001 — the list returned nothing about WHEN a lot entered its stage, so the
// page led with elapsed(updated_at); set_updated_at fires on every row write, so any unrelated edit
// reset the displayed duration to "today". The list now derives stage_entered_at from the lot's
// newest stage-log ENTRY (by when it was made) for its CURRENT stage.
//
// L-081: no new relation and no contract edit. seed_lot_stage_log was already in this directory's
// Phase-4 set (the /seed-stage GET and POST name it) and every column read below is already
// contracted in seed-stage-columns.test.js; seed_process is already in select-columns.test.js.
import { describe, it, expect, beforeEach } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const ITEM = '2d6df841-b507-4e65-8db0-97c8659df37c';

const stagePost = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: `/api/inventory-items/${ITEM}/seed-stage`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const listGet = (qs) => ({
  requestContext: { http: { method: 'GET' } },
  rawPath: '/api/inventory-items',
  headers: { authorization: 'Bearer stub-token' },
  queryStringParameters: qs,
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

// The value bound to ONE named placeholder. `expect(values).toContain(false)` is not the same
// assertion and is weaker than it looks — any other boolean binding in the same statement satisfies
// it, which let a presence flag pinned to `true` survive mutation on the sibling PUT contract. The
// stub builds text as `strings.join('?')`, so a placeholder's value is indexed by the '?' before it.
const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = () => [{ id: 'log-1', inventory_item_id: ITEM, stage: 'drying' }];
});

describe('BUG-SEEDPROCFORCED-001 — POST /:id/seed-stage carries the process', () => {
  it('accepts drying as an ENTRY stage, with the dry process, in one statement', async () => {
    const { status } = parse(await handler(stagePost({
      stage: 'drying', entered_at: '2026-09-01T12:00:00', seed_process: 'dry',
    })));
    expect(status).toBe(201);
    // One statement, not two: the CTE is what stops a stage-log entry and the lot's seed_stage
    // separating. Counting first — indexing [0] of an empty array asserts nothing.
    expect(stubState.sqlCalls).toHaveLength(1);
    const call = stubState.sqlCalls[0];
    expect(call.text).toMatch(/WITH upd AS \(\s*UPDATE public\.inventory_items/);
    expect(call.text).toMatch(/seed_process\s*=\s*CASE[\s\S]*?ELSE seed_process\s*END/);
    expect(boundAfter(call, /SET seed_stage = /)).toBe('drying');
    expect(boundAfter(call, /seed_process\s*=\s*CASE\s*WHEN /)).toBe(true);
    expect(boundAfter(call, /seed_process\s*=\s*CASE\s*WHEN \?\s*THEN /)).toBe('dry');
  });

  it('leaves an existing process ALONE when the key is absent — a plain advance', async () => {
    await handler(stagePost({ stage: 'stored', entered_at: '2026-09-01T12:00:00' }));
    expect(stubState.sqlCalls).toHaveLength(1);
    const call = stubState.sqlCalls[0];
    // The ELSE arm re-reads the stored column, and the guard is genuinely OFF for this body — a
    // CASE wired to a constant true would satisfy the shape assertion and still clear the process.
    expect(call.text).toMatch(/ELSE seed_process\s*END/);
    expect(boundAfter(call, /seed_process\s*=\s*CASE\s*WHEN /)).toBe(false);
  });

  it('rejects a process outside the live CHECK vocabulary, before any SQL runs', async () => {
    // inventory_items_seed_process_check on prod, widened by V4-SEEDFRESHPROCESS-001:
    // seed_process IS NULL OR ANY (ARRAY['wet','dry','fresh']).
    //
    // 'fermented' is still the right probe and is deliberately NOT changed to a real value: it is a
    // plausible-looking word that is NOT in the vocabulary, which is exactly what this guard is for.
    // Note it is close enough to 'fermenting' — a real STAGE — to catch a future edit that confuses
    // the two lists, and that confusion is the original BUG-SEEDPROCFORCED-001 shape.
    const { status, body } = parse(await handler(stagePost({ stage: 'drying', seed_process: 'fermented' })));
    expect(status).toBe(400);
    expect(body.error).toBe('seed_process must be one of wet, dry, fresh');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('still rejects a stage outside the live CHECK vocabulary', async () => {
    const { status } = parse(await handler(stagePost({ stage: 'curing', seed_process: 'dry' })));
    expect(status).toBe(400);
    expect(stubState.sqlCalls).toHaveLength(0);
  });
});

describe('BUG-SEEDELAPSEDUPDATED-001 — the list reports when the stage was entered', () => {
  // Both branches, because the endpoint answers on both and /seeds/saved uses the FILTERED one.
  // A fix applied to only the branch a test happened to exercise is the failure this pins.
  const branches = [
    ['filtered (?category=seeds) — what /seeds/saved fetches', { category: 'seeds' }],
    ['unfiltered — the whole inventory drawer', undefined],
  ];

  it('exercises both list branches', () => {
    expect(branches).toHaveLength(2);
  });

  for (const [name, qs] of branches) {
    it(`derives stage_entered_at from the stage log — ${name}`, async () => {
      stubState.sqlHandler = () => [];
      const { status } = parse(await handler(listGet(qs)));
      expect(status).toBe(200);
      expect(stubState.sqlCalls).toHaveLength(1);
      const { text } = stubState.sqlCalls[0];
      expect(text).toMatch(/se\.entered_at AS stage_entered_at/);
      expect(text).toMatch(/FROM public\.seed_lot_stage_log sl/);
      // Scoped to the CURRENT stage, not merely the latest entry: after an advance, the previous
      // stage's row is newer-than-nothing and would otherwise date the wrong stage.
      expect(text).toMatch(/sl\.stage = i\.seed_stage/);
      // NEWEST ENTRY WINS (Dave 2026-09-17): the full key, tiebreaks included — see the describe below.
      expect(text).toContain('ORDER BY sl.created_at DESC, sl.entered_at DESC, sl.id DESC');
      expect(text).not.toMatch(/ORDER BY sl\.entered_at DESC/);
      // NOT a fallback to updated_at. COALESCEing the two would restore the exact defect while
      // every assertion above still passed.
      expect(text).not.toMatch(/COALESCE\([^)]*updated_at/);
    });
  }
});

describe('Newest entry wins (Dave 2026-09-17) — one order key for the history, the badge and the card', () => {
  // THE RULE. A lot's current entry is the one MADE most recently, not the one carrying the latest
  // date: "Stored, Sep 1" entered after "Stored, Sep 7" is the correction, and the Change stage sheet
  // promises "that is the date the list counts from". Three readers decide it and must never
  // disagree:
  //   • GET /:id/seed-stage — its row order is what SeedStageHistory badges (first row with the stage)
  //     and tests for headship (row 0);
  //   • the list's stage_entered_at LATERAL, in BOTH branches — the card's elapsed time.
  // So all three must carry the SAME key, tiebreaks included: created_at, then entered_at, then id.
  //
  // SHAPE, NOT BEHAVIOUR. The stub records SQL text and executes nothing, so this proves which key
  // each statement names. That the key picks the right row in Postgres is asserted by
  // tests/integration/seed-lifecycle.int.test.js ("newest entry wins") against a real database.
  const KEY = ['created_at DESC', 'entered_at DESC', 'id DESC'];

  // The ORDER BY on the log's alias, and nothing else. The regex can only match a clause built from
  // `<alias>.<column> DIR` items, so the outer list `ORDER BY i.created_at DESC` cannot satisfy it.
  const orderOn = (text, alias) => {
    const re = new RegExp(`ORDER BY (${alias}\\.\\w+ (?:ASC|DESC)(?:, ${alias}\\.\\w+ (?:ASC|DESC))*)`, 'g');
    const found = [...text.matchAll(re)].map(m => m[1]);
    expect(found, `exactly one ORDER BY on ${alias}. in this statement`).toHaveLength(1);
    return found[0].split(', ').map(s => s.slice(alias.length + 1));
  };

  const historyGet = () => ({
    requestContext: { http: { method: 'GET' } },
    rawPath: `/api/inventory-items/${ITEM}/seed-stage`,
    headers: { authorization: 'Bearer stub-token' },
  });

  it('the history GET orders by when each entry was made', async () => {
    stubState.sqlHandler = () => [];
    const { status } = parse(await handler(historyGet()));
    expect(status).toBe(200);
    expect(stubState.sqlCalls).toHaveLength(1);
    const { text } = stubState.sqlCalls[0];
    // Anchor: this is the log read, scoped through the parent.
    expect(text).toMatch(/FROM public\.seed_lot_stage_log l\s+JOIN public\.inventory_items i/);
    expect(orderOn(text, 'l')).toEqual(KEY);
  });

  it('both list branches date the card from the same key as the history', async () => {
    stubState.sqlHandler = () => [];
    await handler(historyGet());
    const history = orderOn(stubState.sqlCalls[0].text, 'l');
    for (const qs of [{ category: 'seeds' }, undefined]) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = () => [];
      await handler(listGet(qs));
      expect(stubState.sqlCalls).toHaveLength(1);
      const { text } = stubState.sqlCalls[0];
      expect(text).toMatch(/se\.entered_at AS stage_entered_at/);
      expect(orderOn(text, 'sl')).toEqual(history);
    }
  });
});
