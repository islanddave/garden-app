// V5-PHRECORD-001 — kitchen_stage_log.ph_reading / ph_read_at, validated and EXECUTED.
//
// WHAT THIS FILE IS ABOUT. The app may RECORD a measured pH, PROMPT someone to measure, and LINK to
// how. It may never derive, score, colour, gate on, or compare a reading to a threshold. Every
// assertion below is on one side of that line: the shape of the record, the verbatim survival of the
// value, and the ABSENCE of any judgement about it. The source-level guard that keeps a threshold out
// of this lane's code lives in src/__tests__/PutUpPhReading.test.jsx and sweeps this file's subjects.
//
// FULL LITERALS, both bounds, every separator. `toContain` on a fragment is how this repo shipped an
// assertion that passes on a value ten days wrong; nothing here uses it on a partial message.
//
// TWO BOUNDS ON EVERY RANGE. A single accepted value proves a range exists, not where it is.
//
// WHAT THIS STILL CANNOT DO. The mock is not Postgres: it cannot prove a ::numeric cast preserves the
// scale of the literal, only that the handler SENDS the literal rather than a coerced Number. The
// migration is unapplied by design (applying is a separate deliberate act), so there is no database
// to integration-test against.
//
// LANE: the root `npm test` run (vitest run --coverage), which is blocking.
import { describe, it, expect } from 'vitest';
import { handleKitchenRoute } from './kitchenRoutes.js';
import {
  validateStage, kitchenErrorMessage, KITCHEN_PH_SCALE_MIN, KITCHEN_PH_SCALE_MAX,
} from './kitchenBatch.js';

const HOUSEHOLD = ['user_dave', 'user_jen'];
const DAVE = 'user_dave';
const BATCH = 'aaaaaaaa-1111-2222-3333-444444444444';
const READ_AT = '2026-09-04T13:20:00.000Z';

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
const STAGE_ROW = [{ id: 'stage-1', batch_id: BATCH, stage_kind: 'tended', ph_reading: '4.60', ph_read_at: READ_AT }];
const VIEW_ROW = [{ id: BATCH, user_id: DAVE, label: 'Pepper mash', last_ph_reading: '4.60', last_ph_read_at: READ_AT }];

const stageCall = (body) => ({
  rawPath: `/api/kitchen-batches/${BATCH}/stages`, method: 'POST',
  rawBody: JSON.stringify(body), query: {}, userId: DAVE, householdIds: HOUSEHOLD,
});

// The minimum valid stage, so every pH assertion below is about the pH and not about some other
// missing field. `tended` is the stage kind a check-in appends: going to measure something is
// tending it, and the log is append-only, so a corrected reading is the NEXT row, never an edit.
const BARE = { stage_kind: 'tended' };

describe('validateStage — a reading and its instant are one fact in two halves', () => {
  // chk_ksl_ph_pairing, mirrored. The instant a reading was TAKEN is not the instant the row was
  // WRITTEN: a cook measures at the counter and logs from the sofa. Defaulting one from the other
  // would stamp a time onto a measurement nobody took then, so there is no default anywhere in this
  // path and the pair is required together.
  //
  // BOTH DIRECTIONS. A one-way check would let the half that matters through.
  it('refuses a reading with no time, and a time with no reading', () => {
    expect(validateStage({ ...BARE, ph_reading: '4.60' }))
      .toBe('a pH reading and the time it was read must both be set, or both be empty');
    expect(validateStage({ ...BARE, ph_read_at: READ_AT }))
      .toBe('a pH reading and the time it was read must both be set, or both be empty');
  });

  it('accepts the pair, and accepts a stage that carries no reading at all', () => {
    // The second half is the CONTROL for every "must be refused" assertion in this file: it proves
    // the new rule rejects on the pH and not on something incidental to the fixture.
    expect(validateStage({ ...BARE, ph_reading: '4.60', ph_read_at: READ_AT })).toBeNull();
    expect(validateStage(BARE)).toBeNull();
    expect(validateStage({ ...BARE, cue_observed: 'bubbling stopped', note: 'skimmed' })).toBeNull();
  });

  it('refuses a time that is not a timestamp, rather than letting a 22007 become a 500', () => {
    expect(validateStage({ ...BARE, ph_reading: '4.60', ph_read_at: 'last tuesday' }))
      .toBe('ph_read_at has to be a timestamp');
  });
});

describe('validateStage — the pH SCALE, which is not a safety band', () => {
  // ⚠ 0 to 14 is the pH scale's definitional range. It is symmetric, it prefers no reading to any
  // other, and it excludes nothing a meter or a strip can produce; its only job is catching a
  // fat-finger before it is stored. It is NOT a food-safety threshold and this suite would be a
  // different file if it were — see the no-threshold guard in src/__tests__/PutUpPhReading.test.jsx.
  it('names the scale exactly, so a later narrowing toward a safety band is a visible edit', () => {
    expect(KITCHEN_PH_SCALE_MIN).toBe(0);
    expect(KITCHEN_PH_SCALE_MAX).toBe(14);
  });

  // BOTH BOUNDS ACCEPTED and BOTH BOUNDS' NEIGHBOURS REFUSED. A single value inside the range would
  // pass against a range of any width, including one narrowed to a safety band.
  it.each([['0'], ['0.1'], ['3.05'], ['7'], ['9.9'], ['14']])('accepts %s, on or inside the scale', (v) => {
    expect(validateStage({ ...BARE, ph_reading: v, ph_read_at: READ_AT })).toBeNull();
  });

  it.each([['-0.1'], ['14.1'], ['46'], ['-1']])('refuses %s, off the scale', (v) => {
    expect(validateStage({ ...BARE, ph_reading: v, ph_read_at: READ_AT }))
      .toBe('a pH reading has to be on the pH scale — 0 to 14');
  });

  it.each([['four point six'], [''], ['   '], ['4.6.1'], [{}]])('refuses %s, which is not a number', (v) => {
    expect(validateStage({ ...BARE, ph_reading: v, ph_read_at: READ_AT }))
      .toBe('a pH reading has to be a number');
  });
});

describe('POST /stages — the reading reaches the column VERBATIM', () => {
  // THE ASSERTION THIS FILE EXISTS FOR. Number('4.60') is 4.6, and the trailing digit the meter
  // displayed is gone forever. The handler must bind the STRING the client sent, uncoerced, so the
  // ::numeric cast receives a literal whose scale Postgres preserves.
  // Mutation: bind `Number(body.ph_reading)` instead — the typeof assertion reds.
  it('binds the string the client sent, not a Number', async () => {
    const sql = mockSql([OWNED, STAGE_ROW, VIEW_ROW]);
    const res = await handleKitchenRoute({
      ...stageCall({ stage_kind: 'tended', ph_reading: '4.60', ph_read_at: READ_AT }), sql,
    });
    expect(res.status).toBe(201);
    const insert = sql.calls.find((c) => c.norm.includes('INSERT INTO kitchen_stage_log'));
    expect(insert.values).toContain('4.60');
    expect(typeof insert.values[insert.values.indexOf('4.60')]).toBe('string');
    expect(insert.values).not.toContain(4.6);
  });

  it('names both columns in the INSERT list and in the RETURNING projection', async () => {
    const sql = mockSql([OWNED, STAGE_ROW, VIEW_ROW]);
    await handleKitchenRoute({
      ...stageCall({ stage_kind: 'tended', ph_reading: '3.20', ph_read_at: READ_AT }), sql,
    });
    const insert = sql.calls.find((c) => c.norm.includes('INSERT INTO kitchen_stage_log'));
    expect(insert.norm).toContain(
      'batch_id, stage_kind, label, amount, amount_unit, cue_observed, '
      + 'entered_at, ph_reading, ph_read_at, storage_location_id, photo_id, note, created_by');
    expect(insert.norm).toContain(
      'RETURNING id, batch_id, stage_kind, label, amount, amount_unit, cue_observed, entered_at, '
      + 'ph_reading, ph_read_at, storage_location_id, photo_id, note, created_by, created_at');
  });

  // NO COALESCE ON ph_read_at, and the clause is asserted as a full literal because that is the only
  // form that can tell "absent" from "defaulted". entered_at directly beside it DOES coalesce to
  // now(), legitimately — "when did you log this" has an obvious answer and "when did you measure"
  // does not. Mutation: wrap ph_read_at in COALESCE(..., now()) — this literal reds.
  it('does not default the read-time from now(), the way entered_at legitimately does', async () => {
    const sql = mockSql([OWNED, STAGE_ROW, VIEW_ROW]);
    await handleKitchenRoute({
      ...stageCall({ stage_kind: 'tended', ph_reading: '4.60', ph_read_at: READ_AT }), sql,
    });
    const insert = sql.calls.find((c) => c.norm.includes('INSERT INTO kitchen_stage_log'));
    expect(insert.norm).toContain('COALESCE( ? ::timestamptz, now()), ? ::numeric, ? ::timestamptz,');
    expect(insert.values).toContain(READ_AT);
  });

  it('refuses an unpaired reading before it reaches the database', async () => {
    const sql = mockSql([OWNED]);
    const res = await handleKitchenRoute({ ...stageCall({ stage_kind: 'tended', ph_reading: '4.60' }), sql });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'a pH reading and the time it was read must both be set, or both be empty' });
    // The ownership load is the ONLY statement issued: nothing was written.
    expect(sql.calls).toHaveLength(1);
  });
});

describe('GET /:id — the reading history is a list of dated rows, never a summary', () => {
  it('projects both columns on every stage row', async () => {
    const sql = mockSql([OWNED, VIEW_ROW, [], STAGE_ROW]);
    const res = await handleKitchenRoute({
      rawPath: `/api/kitchen-batches/${BATCH}`, method: 'GET', rawBody: null, query: {},
      userId: DAVE, householdIds: HOUSEHOLD, sql,
    });
    expect(res.status).toBe(200);
    const stages = sql.calls.find((c) => c.norm.includes('FROM kitchen_stage_log'));
    expect(stages.norm).toContain(
      'SELECT id, batch_id, stage_kind, label, amount, amount_unit, cue_observed, entered_at, '
      + 'ph_reading, ph_read_at, storage_location_id, photo_id, note, created_by, created_at');
  });

  // ⚠ NO AGGREGATE OVER READINGS, EVER — the ruling, expressed against what the route SENDS. A batch
  // that never acidified produces an unbroken run of "checked" rows, so a count, a streak, an
  // average or a min/max over them turns absent failure signs into apparent success. Each reading is
  // a dated line and the client renders it as one.
  // Mutation: add `count(*) FILTER (WHERE ph_reading IS NOT NULL)` to the stage projection.
  it('computes nothing over them — no count, min, max, avg or streak', async () => {
    const sql = mockSql([OWNED, VIEW_ROW, [], STAGE_ROW]);
    await handleKitchenRoute({
      rawPath: `/api/kitchen-batches/${BATCH}`, method: 'GET', rawBody: null, query: {},
      userId: DAVE, householdIds: HOUSEHOLD, sql,
    });
    const stages = sql.calls.find((c) => c.norm.includes('FROM kitchen_stage_log'));
    expect(stages.norm).not.toMatch(/count\s*\(|min\s*\(|max\s*\(|avg\s*\(|sum\s*\(|bool_and|bool_or/i);
  });
});

describe('kitchenErrorMessage — the two new CHECKs, given words', () => {
  // A raw 23514 reads as `Constraint violation: chk_ksl_ph_scale`, which is not something a cook at a
  // counter can act on. Both messages describe the SHAPE of the record and neither says anything
  // about what a reading means.
  it.each([
    ['chk_ksl_ph_pairing', 'a pH reading needs the time it was read, and a time needs a reading'],
    ['chk_ksl_ph_scale', 'that is not a reading on the pH scale'],
  ])('%s', (constraint, message) => {
    expect(kitchenErrorMessage({ code: '23514', constraint })).toBe(message);
  });

  it('still returns null for a code that is not ours, leaving the existing map alone', () => {
    expect(kitchenErrorMessage({ code: '23505', constraint: 'chk_ksl_ph_scale' })).toBeNull();
    expect(kitchenErrorMessage({ code: '23514', constraint: 'chk_something_else' })).toBeNull();
  });
});
