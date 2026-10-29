// new-file: no sample-event test existed for xp-reconcile (EventBridge-only, no HTTP entry)
// Pins today's reply and statements for the daily EventBridge event (OPS-CODEREVIEW-001 C6), so a D1/D2 refactor
// that touches this handler is noticed. The stub never evaluates SQL: drift rows are scripted, and the
// statements are asserted by text. Trap: DRY_RUN defaults to TRUE when unset; only the literal "false"
// (any case) applies the heal.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const SCHEDULED = {
  version: '0', id: 'c6-sample', 'detail-type': 'Scheduled Event', source: 'aws.events',
  account: '000000000000', time: '2026-10-29T04:00:00Z', region: 'us-east-1',
  resources: ['arn:aws:events:us-east-1:000000000000:rule/garden-xp-reconcile-daily'], detail: {},
};
const DRIFT = [
  { user_id: 'u-a', user_stats_xp: 105, xp_events_sum: 100, drift: 5 },
  { user_id: 'u-b', user_stats_xp: 7, xp_events_sum: 10, drift: -3 },
];
const isDriftRead = (t) => /FROM user_stats us\s+LEFT JOIN xp_events/.test(t);
const isHeal = (t) => /UPDATE user_stats us/.test(t);
const logged = (spy) => spy.mock.calls.map((c) => JSON.parse(c[0]));

let logSpy;
let errSpy;
beforeEach(() => {
  resetStubs();
  delete process.env.DRY_RUN;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.DRY_RUN;
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe('xp-reconcile — daily EventBridge event', () => {
  it('no drift: one read, no write, the no-drift reply', async () => {
    const out = await handler(SCHEDULED);
    expect(out).toEqual({ ok: true, dry_run: true, users_with_drift: 0, total_abs_drift: 0 });
    expect(stubState.sqlCalls).toHaveLength(1);
    expect(isDriftRead(stubState.sqlCalls[0].text)).toBe(true);
    expect(stubState.sqlCalls[0].connectionString).toBe('postgres://stub/db');
    expect(logged(logSpy).map((l) => l.event)).toEqual(['xp_reconcile_start', 'xp_reconcile_no_drift']);
    expect(logged(logSpy)[0]).toMatchObject({ dry_run: true, source: 'aws.events' });
  });

  it('drift with DRY_RUN unset: reports absolute drift and writes nothing', async () => {
    stubState.sqlHandler = (t) => (isDriftRead(t) ? DRIFT : []);
    const out = await handler(SCHEDULED);
    expect(out).toEqual({ ok: true, dry_run: true, users_with_drift: 2, total_abs_drift: 8 });
    expect(stubState.sqlCalls.some((c) => isHeal(c.text))).toBe(false);
    const lines = logged(logSpy);
    expect(lines.map((l) => l.event)).toEqual(['xp_reconcile_start', 'xp_reconcile_drift_detected', 'xp_reconcile_dry_run_complete']);
    expect(lines[1].sample).toEqual(DRIFT);
  });

  it('DRY_RUN=true behaves as unset (any value but "false" is a dry run)', async () => {
    process.env.DRY_RUN = 'true';
    stubState.sqlHandler = (t) => (isDriftRead(t) ? DRIFT : []);
    const out = await handler(SCHEDULED);
    expect(out.dry_run).toBe(true);
    expect(stubState.sqlCalls.some((c) => isHeal(c.text))).toBe(false);
  });

  it('DRY_RUN=FALSE (any case) heals: one UPDATE that leaves level to the trigger', async () => {
    process.env.DRY_RUN = 'FALSE';
    stubState.sqlHandler = (t) => {
      if (isDriftRead(t)) return DRIFT;
      if (isHeal(t)) return [{ user_id: 'u-a', xp: 100, level: 4 }, { user_id: 'u-b', xp: 10, level: 1 }];
      return [];
    };
    const out = await handler(SCHEDULED);
    expect(out).toEqual({ ok: true, dry_run: false, rows_updated: 2, total_abs_drift: 8 });
    const heals = stubState.sqlCalls.filter((c) => isHeal(c.text));
    expect(heals).toHaveLength(1);
    const setList = heals[0].text.split(/\bSET\b/)[1].split(/\bWHERE\b/)[0];
    expect(setList).toMatch(/xp = COALESCE/);
    expect(setList).not.toMatch(/\blevel\b/);
    expect(heals[0].text).toMatch(/RETURNING user_id, xp, level/);
    expect(logged(logSpy).at(-1)).toMatchObject({ event: 'xp_reconcile_applied', rows_updated: 2, total_abs_drift: 8 });
  });

  it('a manual invoke with no event logs source "manual"', async () => {
    await handler(undefined);
    expect(logged(logSpy)[0]).toMatchObject({ event: 'xp_reconcile_start', source: 'manual' });
  });

  it('a database error is logged and rethrown, so the invocation fails', async () => {
    stubState.sqlHandler = () => { throw Object.assign(new Error('boom'), { code: '57P01' }); };
    await expect(handler(SCHEDULED)).rejects.toThrow('boom');
    expect(JSON.parse(errSpy.mock.calls[0][0])).toEqual({ event: 'xp_reconcile_error', message: 'boom' });
  });
});
