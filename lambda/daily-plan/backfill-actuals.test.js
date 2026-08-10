// backfill-actuals.test.js — BUG-TODAYWATER-001: record what ACTUALLY fell.
//
// Nothing recorded observed day-D rain: recent_precip_in is the D-2+D-1 SUM, so a busted today-forecast was
// undetectable BY CONSTRUCTION. The backfill writes hy.yesterday_precip_actual_in (from the past-days array
// fetchPrecip already reads) onto YESTERDAY's plan row as items.today_precip_actual_in. Properties under
// test, each mutation-checked (a test that survives its mutation is vacuous):
//   P1 scope   — same user_id + PREVIOUS plan_date only (mutants: drop the user clause; write today's date)
//   P2 parity  — the CURRENT day's upserted items are unchanged by the feature (mutant: key on today's row)
//   P3 fail-open — a backfill error can never break plan generation (mutant: rethrow)
//   P4 no-data-no-claim — null/absent actual is NOT recorded as 0 (mutant: coerce null -> 0)
//   P5 dry-inert — dryRun writes nothing at all
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import handler from './handler.js';

// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const { run, backfillYesterdayActual, prevPlanDate } = handler;

const USER = 'user_1';
const TODAY = '2026-08-03';
const YDAY = '2026-08-02';
const HY = (y) => ({
  recent_precip_in: 0.5, today_precip_in: 0.2, today_pop: 30,
  upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0,
  ...(y === undefined ? {} : { yesterday_precip_actual_in: y }),
});

afterEach(() => vi.restoreAllMocks());

describe('prevPlanDate — calendar-label math (UTC, matching engine.daysBetween)', () => {
  it('handles day, month, year, and February boundaries', () => {
    expect(prevPlanDate('2026-08-03')).toBe('2026-08-02');
    expect(prevPlanDate('2026-08-01')).toBe('2026-07-31');
    expect(prevPlanDate('2026-01-01')).toBe('2025-12-31');
    expect(prevPlanDate('2026-03-01')).toBe('2026-02-28'); // 2026 is not a leap year
  });
});

describe('backfillYesterdayActual — unit properties', () => {
  const pgCapture = () => ({ query: vi.fn(async () => ({ rows: [] })) });

  it('P1 writes the actual onto (user_id, PREVIOUS plan_date) via jsonb_set', async () => {
    const pg = pgCapture();
    await expect(backfillYesterdayActual(pg, USER, TODAY, HY(0.73))).resolves.toBe(true);
    expect(pg.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toMatch(/update daily_plan/i);
    expect(sql).toMatch(/jsonb_set/);
    expect(sql).toMatch(/today_precip_actual_in/);
    expect(sql).toMatch(/user_id\s*=\s*\$1/);
    expect(sql).toMatch(/plan_date\s*=\s*\$2/);
    // coalesce guards a NULL items row: jsonb_set(NULL, ...) returns NULL and would DESTROY the row's items.
    expect(sql).toMatch(/coalesce\(items/);
    expect(params).toEqual([USER, YDAY, '0.73', '"forecast"']);
  });

  it('P4 an observed DRY day (0) is real data and IS written', async () => {
    const pg = pgCapture();
    await expect(backfillYesterdayActual(pg, USER, TODAY, HY(0))).resolves.toBe(true);
    expect(pg.query.mock.calls[0][1]).toEqual([USER, YDAY, '0', '"forecast"']);
  });

  // ── BUG-RAINACTUAL-001 H3 — the value is worthless without its source ──
  it('P6 the source label is persisted beside the value, in the SAME statement', async () => {
    const pg = pgCapture();
    await expect(backfillYesterdayActual(pg, USER, TODAY, HY(2.22), { yesterday_actual_source: 'station' })).resolves.toBe(true);
    expect(pg.query).toHaveBeenCalledTimes(1);            // one atomic update, not two
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toMatch(/today_precip_actual_source/);
    expect(params).toEqual([USER, YDAY, '2.22', '"station"']);
  });

  it('P6 an unknown/absent provenance defaults to the honest label, never to "station"', async () => {
    for (const prov of [undefined, null, {}, { recent_source: 'station' }]) {
      const pg = pgCapture();
      await backfillYesterdayActual(pg, USER, TODAY, HY(0.73), prov);
      expect(pg.query.mock.calls[0][1][3]).toBe('"forecast"');
    }
  });

  it('P4 null / absent / non-numeric actual -> NO write (absence of data is not "no rain")', async () => {
    for (const hy of [null, undefined, {}, HY(null), HY(NaN), HY('0.5'), HY(Infinity)]) {
      const pg = pgCapture();
      await expect(backfillYesterdayActual(pg, USER, TODAY, hy)).resolves.toBe(false);
      expect(pg.query).not.toHaveBeenCalled();
    }
  });

  it('rejects a malformed plan date without querying', async () => {
    for (const today of ['2026-8-3', '20260803', null, undefined, 'today']) {
      const pg = pgCapture();
      await expect(backfillYesterdayActual(pg, USER, today, HY(1))).resolves.toBe(false);
      expect(pg.query).not.toHaveBeenCalled();
    }
  });

  it('P3 never throws when the DB write fails — warns and returns false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pg = { query: vi.fn(async () => { throw new Error('connection reset'); }) };
    await expect(backfillYesterdayActual(pg, USER, TODAY, HY(0.73))).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe('run() — backfill wired in, current-day plan untouched', () => {
  const PLANT_ROW = {
    id: 'pl1', name: 'Row Pepper', project_id: 'pj', status: 'vegetative', container_type: null,
    container_size: null, rain_exposed: null, variety: null, genus: null, project: 'Proj',
    project_status: 'active', workspace_id: 'sp1', covered: false, assignee_user_id: USER,
    db_cadence: null, last_water: null, last_fert: null, substrate_start: null, transplant_at: null,
  };
  // Default coords are deliberately OUTSIDE station.COORD_TOL of the configured WS-2902, so the pre-existing
  // fixtures keep their no-station-bound behaviour; `atStation` opts a test into a bound gauge.
  function mkPg({ failBackfill = false, atStation = false } = {}) {
    const q = vi.fn(async (sql) => {
      if (/^\s*update daily_plan/i.test(sql)) { if (failBackfill) throw new Error('backfill boom'); return { rows: [] }; }
      if (sql.includes('select items, generated_at')) return { rows: [] };
      if (sql.includes('from spaces')) return { rows: [{ id: 'sp1', postal_code: null, ...(atStation ? { weather_lat: 42.5089, weather_lng: -72.6466 } : { weather_lat: 42.5, weather_lng: -72.6 }) }] };
      if (sql.includes('from plants')) return { rows: [PLANT_ROW] };
      return { rows: [] };
    });
    return { query: q };
  }
  const runArgs = (pg, { dryRun = false, hy = HY(0.73) } = {}) => ({
    pg, today: TODAY, dryRun,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => null,
    fetchPrecip: async () => hy,
    fetchStation: async () => null,
  });
  const callsOf = (pg, re) => pg.query.mock.calls.filter(([sql]) => re.test(sql));

  it('P1/P2 live run: one upsert for TODAY with NO actuals key, one update for YESTERDAY with the value', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pg = mkPg();
    const res = await run(runArgs(pg));
    expect(res.rows).toBe(1);
    const inserts = callsOf(pg, /insert into daily_plan/i);
    expect(inserts).toHaveLength(1);
    const [, insParams] = inserts[0];
    expect(insParams[0]).toBe(USER);
    expect(insParams[1]).toBe(TODAY);
    const items = JSON.parse(insParams[2]);
    // P2 byte-parity of the current-day plan: the feature adds NOTHING to today's items — not the backfill
    // key, and not the raw fetch field (engine copies named hydrology keys only).
    expect(insParams[2]).not.toContain('today_precip_actual_in');
    expect(insParams[2]).not.toContain('yesterday_precip_actual_in');
    expect(items.hydrology.recent_precip_in).toBe(0.5);   // hydrology itself still stored
    const updates = callsOf(pg, /update daily_plan/i);
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([USER, YDAY, '0.73', '"forecast"']);  // no station bound in this fixture
  });

  // BUG-RAINACTUAL-001 H3 end-to-end through run(): a bound station makes the backfilled "actual" the
  // GAUGE's D-1 bucket (2.22), labelled 'station' — not Open-Meteo's hindcast for the same day (4.63).
  it('H3 a bound station drives the backfilled actual and its label', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // deriveStation is anchored to Date.now(); pin it so station freshness is deterministic (15:30 ET 08-04).
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-04T19:30:00Z'));
    const at = (day, hh, dailyrainin) => ({ dateutc: Date.parse(`${day}T${hh}:00:00-04:00`), dailyrainin, tempf: 70 });
    const pg = mkPg({ atStation: true });
    await run({
      ...runArgs(pg, { hy: { ...HY(4.63), today_precip_in: 0.4 } }),
      today: '2026-08-04',
      fetchStation: async () => ({ mac: 'F8:B3:B7:82:1F:0D', records: [
        at('2026-08-04', '15', 0.10), at('2026-08-03', '23', 2.22), at('2026-08-02', '18', 0.05), at('2026-08-01', '18', 0.0),
      ] }),
    });
    const updates = callsOf(pg, /update daily_plan/i);
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([USER, '2026-08-03', '2.22', '"station"']);
  });

  it('P3 a failing backfill write leaves the run + upsert intact', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pg = mkPg({ failBackfill: true });
    const res = await run(runArgs(pg));
    expect(res.rows).toBe(1);                                      // plan generation unbroken
    expect(callsOf(pg, /insert into daily_plan/i)).toHaveLength(1); // today's plan landed
    expect(warn).toHaveBeenCalled();
  });

  it('P5 dry run writes neither the plan nor the backfill — and carries the diffable plan shape', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pg = mkPg();
    const res = await run(runArgs(pg, { dryRun: true }));
    expect(callsOf(pg, /insert into daily_plan/i)).toHaveLength(0);
    expect(callsOf(pg, /update daily_plan/i)).toHaveLength(0);
    // A0.3-DRY-PLANS contract: rerun-daily-plan.sh --diff reads user_id, plan.counts, plan.tasks, hydrology.
    expect(res.plans).toHaveLength(1);
    expect(res.plans[0].user_id).toBe(USER);
    expect(res.plans[0].plan.counts).toBeTruthy();
    expect(res.plans[0].plan.tasks).toBeTruthy();
    expect(res.plans[0].hydrology.recent_precip_in).toBe(0.5);
  });

  it('P4 hydrology without the actuals field (or null hydrology) -> no backfill write', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const hy of [HY(undefined), null]) {
      const pg = mkPg();
      await run(runArgs(pg, { hy }));
      expect(callsOf(pg, /update daily_plan/i)).toHaveLength(0);
      expect(callsOf(pg, /insert into daily_plan/i)).toHaveLength(1); // plan itself unaffected
    }
  });
});

describe('index.js wiring (static source guard — index.js pulls AWS/neon at module load, cannot be imported)', () => {
  const SRC = decomment(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'index.js'), 'utf8'));
  it('fetchPrecip emits yesterday_precip_actual_in from the D-1 slot, null-guarded (never coerced to 0)', () => {
    expect(SRC).toMatch(/yesterday_precip_actual_in:\s*Number\.isFinite\(ps\[1\]\)\s*\?\s*round2\(ps\[1\]\)\s*:\s*null/);
  });
});
