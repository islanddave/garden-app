// priorruns.test.js — BUG-TODAYWATER-001, intraday regeneration.
//
// The plan row is upserted on a UNIQUE (user_id, plan_date), so every regeneration destroys the snapshot it
// replaces. Once the plan is regenerated two extra times a day, the question "what did the 02:00 run
// believe, and did that forecast actually arrive?" becomes the main way to tell a good suppression from a
// bad one — and it is unanswerable if the earlier row is gone. items.prior_runs is that record.
//
// This is an audit nicety layered onto the one job that must never fail, so the tests below care as much
// about the failure paths (bad JSON, DB error, missing row) as the happy one: none of them may throw, and
// none may block the write.
import { describe, it, expect, vi } from 'vitest';
import handler from './handler.js';

const { readPriorRuns, PRIOR_RUNS_MAX } = handler;

const USER = 'user_1';
const DATE = '2026-08-03';

// A stub pg whose query() returns whatever rows you hand it.
const pgWith = rows => ({ query: vi.fn(async () => ({ rows })) });

// The real 02:01 hydrology from the incident, used as the fixture so the shape cannot drift from prod.
const NIGHTLY = {
  hydrology: { recent_precip_in: 0, today_precip_in: 0.98, today_pop: 84, tomorrow_precip_in: 0 },
  counts: { water_due: 200, rain_skipped: 13 },
};

describe('BUG-TODAYWATER-001 — prior_runs audit trail', () => {
  it('returns [] on the first generation of the day — nothing to preserve yet', async () => {
    expect(await readPriorRuns(pgWith([]), USER, DATE)).toEqual([]);
  });

  it('captures the hydrology and counts of the run it is about to replace', async () => {
    const pg = pgWith([{ items: NIGHTLY, generated_at: '2026-08-03T06:01:08.325Z' }]);
    const out = await readPriorRuns(pg, USER, DATE);
    expect(out).toHaveLength(1);
    expect(out[0].generated_at).toBe('2026-08-03T06:01:08.325Z');
    // These two are what make a busted forecast diagnosable after the fact.
    expect(out[0].hydrology.today_precip_in).toBe(0.98);
    expect(out[0].hydrology.today_pop).toBe(84);
    expect(out[0].counts.water_due).toBe(200);
  });

  it('accumulates across the day rather than replacing', async () => {
    const withOne = { ...NIGHTLY, prior_runs: [{ generated_at: 't0', hydrology: { today_precip_in: 0.1 }, counts: {} }] };
    const out = await readPriorRuns(pgWith([{ items: withOne, generated_at: 't1' }]), USER, DATE);
    expect(out).toHaveLength(2);
    expect(out[0].generated_at).toBe('t0');   // oldest first
    expect(out[1].generated_at).toBe('t1');
  });

  it('caps the history and keeps the OLDEST — the nightly run is the baseline worth keeping', async () => {
    const many = Array.from({ length: PRIOR_RUNS_MAX + 2 }, (_, i) => ({ generated_at: `t${i}`, hydrology: {}, counts: {} }));
    const out = await readPriorRuns(pgWith([{ items: { ...NIGHTLY, prior_runs: many }, generated_at: 'newest' }]), USER, DATE);
    expect(out).toHaveLength(PRIOR_RUNS_MAX);
    expect(out[0].generated_at).toBe('t0');            // the nightly baseline survives
    expect(out.map(r => r.generated_at)).not.toContain('newest');
  });

  it('never throws when the DB read fails — an audit trail must not be able to block a plan', async () => {
    const pg = { query: vi.fn(async () => { throw new Error('connection reset'); }) };
    await expect(readPriorRuns(pg, USER, DATE)).resolves.toEqual([]);
  });

  it('tolerates a malformed or empty items blob', async () => {
    expect(await readPriorRuns(pgWith([{ items: null, generated_at: 't' }]), USER, DATE))
      .toEqual([{ generated_at: 't', hydrology: null, counts: null }]);
    // prior_runs present but not an array — must not spread a non-iterable.
    const bad = { ...NIGHTLY, prior_runs: 'nonsense' };
    await expect(readPriorRuns(pgWith([{ items: bad, generated_at: 't' }]), USER, DATE)).resolves.toHaveLength(1);
  });

  it('reads only the row it is replacing — scoped by user AND date', async () => {
    const pg = pgWith([]);
    await readPriorRuns(pg, USER, DATE);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toMatch(/from daily_plan/i);
    expect(params).toEqual([USER, DATE]);
  });
});
