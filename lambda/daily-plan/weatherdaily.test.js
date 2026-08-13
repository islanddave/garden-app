// weatherdaily.test.js — V4-WATERMATH-001 F1 (W-F2A-WX), the weather_daily substrate.
//
// These tests EXECUTE the writer and the reader and inspect the SQL that actually reached the driver.
// That is deliberate and it is the difference that matters here. This Lambda's suite leans heavily on
// source-text assertions (openmeteo-indices, wxcoverloc, archived-exclusion, nightly-timeout) because
// index.js pulls AWS/neon at module load and cannot be imported — but the three claims F1 has to make
// are all claims about REACHABILITY and RUNTIME BEHAVIOUR, and source text cannot establish any of them:
//
//   1. "flag OFF issues zero weather_daily reads" is a statement about which code paths run, not about
//      where a call is written. A grep showing the call inside an `if` proves the `if` exists; it does
//      not prove the condition is what the deploy evaluates. So the flag tests below COUNT THE QUERIES
//      run() genuinely sends.
//   2. "the write is non-fatal" is a statement about what happens when a throw escapes. Only a pg stub
//      that actually throws can show the run surviving it.
//   3. "a --today replay cannot write fiction" is a date comparison against real inputs.
//
// The named failure class is BUG-SEEDEDGATE-001 AT TABLE GRANULARITY: one bad query blanked the entire
// nightly plan for both users. weather_daily does not exist in any database yet, so until the migration
// lands EVERY statement against it fails — and the whole design is that the read is unreachable and the
// write is caught. These tests are what hold that.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import handler from './handler.js';

const { run, writeWeatherDaily, readWeatherDaily, weatherWindowStart, WEATHER_DAILY_WINDOW_DAYS } = handler;

const SPACE = 'sp-1';
const USER = 'user_1';
const TODAY = '2026-08-12';
const YESTERDAY = '2026-08-11';
const DAY_BEFORE = '2026-08-10';

// VERBATIM live Open-Meteo values for this Space's coordinates (42.5087,-72.6471), read from the real
// endpoint on 2026-08-12 with the exact URL lambda/daily-plan/index.js now sends. Using the real
// numbers rather than round ones keeps the fixture from drifting into a shape the API never produces —
// note in particular that et0 differs between the two days in the THIRD decimal (0.186 vs 0.193), which
// is precisely the resolution round2 would have destroyed.
const SETTLED = [
  { date: DAY_BEFORE, et0_in: 0.186, tmax_f: 82.3, tmin_f: 58.0, precip_in: 0 },
  { date: YESTERDAY, et0_in: 0.193, tmax_f: 81.1, tmin_f: 64.7, precip_in: 0 },
];

const hydrology = (over = {}) => ({
  forecast_lows: [null, null, null], forecast_dates: [null, null, null],
  recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
  tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0,
  settled_days: SETTLED.map((d) => ({ ...d })), ...over,
});

// A pg stub that records EVERY statement it is handed, so a query can be counted rather than inferred.
function recordingPg({ throwOnWeatherDaily = false, weatherRows = [] } = {}) {
  const calls = [];
  const pg = {
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/weather_daily/.test(sql)) {
        if (throwOnWeatherDaily) throw new Error('relation "weather_daily" does not exist');
        if (/^\s*select/i.test(sql)) return { rows: weatherRows };
        return { rows: [] };
      }
      if (/from plants/.test(sql)) return { rows: PLANTINGS };
      if (/from spaces/.test(sql)) {
        return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
      }
      return { rows: [] };
    }),
    calls,
  };
  return pg;
}

const wd = (pg) => pg.calls.filter((c) => /weather_daily/.test(c.sql));
const wdSelects = (pg) => wd(pg).filter((c) => /^\s*select/i.test(c.sql));
const wdInserts = (pg) => wd(pg).filter((c) => /^\s*insert\s+into\s+weather_daily/i.test(c.sql));
const planWrites = (pg) => pg.calls.filter((c) => /insert into daily_plan/.test(c.sql));

const PLANTINGS = [{
  id: 'p1', name: 'Pepper p1', project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: 'pepper', genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: 'pepper', covered: false,
  frost_covered_resolved: false, assignee_user_id: USER, db_cadence: null,
  last_water: '2026-08-01', last_fert: '2026-08-01', substrate_start: '2026-05-01', transplant_at: null,
}];

async function drive(opts = {}) {
  const pg = opts.pg || recordingPg(opts.pgOpts);
  const res = await run({
    pg, today: opts.today || TODAY, dryRun: opts.dryRun ?? false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 60, highToday: 82, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => hydrology(opts.hydrology),
    fetchStation: async () => null,
    publishAlert: vi.fn(async () => ({ messageId: 'm1' })),
    etHour: 2, event: {},
  });
  return { res, pg };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('writeWeatherDaily — what reaches the database', () => {
  // The writer emits a structured observability line per call (design Part 4 asks for rows/day and
  // null-rate to be visible in CloudWatch before F2 reads any of it). Silence it here so the suite
  // output stays readable; the log's CONTENT is asserted in the non-fatal block below.
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });

  it('writes one row per COMPLETED day and nothing for today', async () => {
    const pg = recordingPg();
    expect(await writeWeatherDaily(pg, SPACE, TODAY, hydrology(), {})).toBe(2);
    const dates = wdInserts(pg).map((c) => c.params[1]);
    expect(dates).toEqual([DAY_BEFORE, YESTERDAY]);
    expect(dates).not.toContain(TODAY);
  });

  it('carries the real values through, ET0 at full three-decimal resolution', async () => {
    const pg = recordingPg();
    await writeWeatherDaily(pg, SPACE, TODAY, hydrology(), {});
    const [, dateP, et0, tmax, tmin] = wdInserts(pg)[1].params;
    expect(dateP).toBe(YESTERDAY);
    // 0.193, not 0.19 — the demand term is a RATIO of this to a monthly reference, so a value
    // quantised to two decimals carries several percent of error into every verdict downstream.
    expect(et0).toBe(0.193);
    expect(tmax).toBe(81.1);
    expect(tmin).toBe(64.7);
  });

  it('labels D-1 gauge_merged when the on-site station covered it', async () => {
    const pg = recordingPg();
    await writeWeatherDaily(pg, SPACE, TODAY,
      hydrology({ yesterday_precip_actual_in: 2.22 }), { yesterday_actual_source: 'station' });
    const yest = wdInserts(pg).find((c) => c.params[1] === YESTERDAY);
    // 2.22 is the real WS-2902 reading from 2026-08-03 that Open-Meteo hindcast as 4.63 —
    // BUG-RAINACTUAL-001. The gauge value must win AND must be labelled as the gauge.
    expect(yest.params[5]).toBe(2.22);
    expect(yest.params[6]).toBe('gauge_merged');
  });

  it('labels D-1 openmeteo_live when the station did NOT cover it — an actual that is really a forecast is the whole defect', async () => {
    const pg = recordingPg();
    await writeWeatherDaily(pg, SPACE, TODAY,
      hydrology({ yesterday_precip_actual_in: 4.63 }), { yesterday_actual_source: 'forecast' });
    const yest = wdInserts(pg).find((c) => c.params[1] === YESTERDAY);
    expect(yest.params[6]).toBe('openmeteo_live');
  });

  it('never labels D-2 as gauge_merged, even when the station covered D-1', async () => {
    // The gauge merge only ever establishes yesterday. D-2's number can only be the model's, and
    // mislabelling it would defeat the downgrade guard the upsert depends on.
    const pg = recordingPg();
    await writeWeatherDaily(pg, SPACE, TODAY,
      hydrology({ yesterday_precip_actual_in: 2.22 }), { yesterday_actual_source: 'station' });
    const dayBefore = wdInserts(pg).find((c) => c.params[1] === DAY_BEFORE);
    expect(dayBefore.params[6]).toBe('openmeteo_live');
  });

  it('writes a NULL source when the value itself is absent — absence is not a provenance', async () => {
    const pg = recordingPg();
    await writeWeatherDaily(pg, SPACE, TODAY, hydrology({
      yesterday_precip_actual_in: null,
      settled_days: [{ date: YESTERDAY, et0_in: null, tmax_f: null, tmin_f: null, precip_in: null }],
    }), {});
    const [, , et0, , , precip, precipSrc, et0Src] = wdInserts(pg)[0].params;
    expect(et0).toBeNull();
    expect(precip).toBeNull();
    expect(precipSrc).toBeNull();
    expect(et0Src).toBeNull();
  });

  it('refuses to write a day at or after the plan date — the --today replay guard', async () => {
    // scripts/rerun-daily-plan.sh --today overrides the PLAN DATE, but the fetchers still call
    // Open-Meteo relative to NOW. A past replay therefore holds THIS WEEK's weather wearing a past
    // date's label. Without this guard one `--live --today 2026-07-01` stamps August ET0 onto July
    // rows, and nothing about the result looks wrong: the values are plausible and precip_source
    // says 'openmeteo_live', which is true and useless.
    const pg = recordingPg();
    expect(await writeWeatherDaily(pg, SPACE, '2026-07-01', hydrology(), {})).toBe(0);
    expect(wdInserts(pg)).toHaveLength(0);
  });

  it('writes only the days strictly before the plan date when the window straddles it', async () => {
    const pg = recordingPg();
    // today = the day BEFORE the last settled entry, so 2026-08-11 is now "today" and must be dropped.
    expect(await writeWeatherDaily(pg, SPACE, YESTERDAY, hydrology(), {})).toBe(1);
    expect(wdInserts(pg).map((c) => c.params[1])).toEqual([DAY_BEFORE]);
  });

  it('is NON-FATAL: a missing relation returns 0 and never rejects', async () => {
    const pg = recordingPg({ throwOnWeatherDaily: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(writeWeatherDaily(pg, SPACE, TODAY, hydrology(), {})).resolves.toBe(0);
  });

  it('no-ops on absent, empty or malformed settled_days rather than throwing', async () => {
    const pg = recordingPg();
    expect(await writeWeatherDaily(pg, SPACE, TODAY, null, {})).toBe(0);
    expect(await writeWeatherDaily(pg, SPACE, TODAY, hydrology({ settled_days: [] }), {})).toBe(0);
    expect(await writeWeatherDaily(pg, SPACE, TODAY, hydrology({ settled_days: 'nonsense' }), {})).toBe(0);
    expect(await writeWeatherDaily(pg, SPACE, TODAY, hydrology({ settled_days: [null, { date: 'x' }] }), {})).toBe(0);
    expect(await writeWeatherDaily(pg, SPACE, 'not-a-date', hydrology(), {})).toBe(0);
    expect(wdInserts(pg)).toHaveLength(0);
  });

  it('binds every parameter with an explicit cast — Neon cannot type a NULL bind', async () => {
    // Without the casts the driver answers "could not determine data type of parameter", and inside
    // a catch this broad that presents as the substrate silently never populating.
    const pg = recordingPg();
    await writeWeatherDaily(pg, SPACE, TODAY, hydrology(), {});
    const sql = wdInserts(pg)[0].sql;
    expect(sql).toMatch(/\$1::uuid/);
    expect(sql).toMatch(/\$2::date/);
    for (const n of [3, 4, 5, 6]) expect(sql).toMatch(new RegExp(`\\$${n}::numeric`));
    for (const n of [7, 8]) expect(sql).toMatch(new RegExp(`\\$${n}::text`));
  });

  it('the emitted upsert refuses to downgrade a gauge reading to a model one', async () => {
    // Asserted on the SQL the driver actually received, not on the source file. The nightly run
    // rewrites D-2 as well as D-1, and by then the AmbientWeather buckets behind D-2's gauge figure
    // are gone — so without these arms every night would overwrite yesterday's measured rain with an
    // estimate, and precip_source would faithfully record the replacement while looking healthy.
    const pg = recordingPg();
    await writeWeatherDaily(pg, SPACE, TODAY, hydrology(), {});
    const sql = wdInserts(pg)[0].sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
    expect(sql).toMatch(/on conflict \(space_id, "date"\) do update set/i);
    expect(sql).toMatch(/precip_in = case when weather_daily\.precip_source = 'gauge_merged'/i);
    expect(sql).toMatch(/precip_source = case when weather_daily\.precip_source = 'gauge_merged'/i);
    // COALESCE on every field: a later pass carrying nulls must not erase what an earlier one set.
    for (const col of ['et0_in', 'tmax_f', 'tmin_f', 'et0_source']) {
      expect(sql).toMatch(new RegExp(`${col} = coalesce\\(excluded\\.${col}`, 'i'));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('readWeatherDaily — flag-gated, and fail-open when it does run', () => {
  it('returns the rows for one space over one date window', async () => {
    const rows = [{ date: YESTERDAY, et0_in: 0.193, precip_in: 0 }];
    const pg = recordingPg({ weatherRows: rows });
    expect(await readWeatherDaily(pg, SPACE, DAY_BEFORE, YESTERDAY)).toEqual(rows);
    const c = wdSelects(pg)[0];
    expect(c.params).toEqual([SPACE, DAY_BEFORE, YESTERDAY]);
    expect(c.sql).toMatch(/space_id = \$1::uuid/);
    expect(c.sql).toMatch(/"date" >= \$2::date and "date" <= \$3::date/);
  });

  it('fails open to an EMPTY SERIES, never a throw — a missing row means demand 1.0, not an outage', async () => {
    const pg = recordingPg({ throwOnWeatherDaily: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(readWeatherDaily(pg, SPACE, DAY_BEFORE, YESTERDAY)).resolves.toEqual([]);
  });

  it('the fold window is 30 days, matching the ledger anchor lookback', () => {
    expect(WEATHER_DAILY_WINDOW_DAYS).toBe(30);
    expect(weatherWindowStart(TODAY)).toBe('2026-07-13');
    expect(weatherWindowStart('2026-03-11')).toBe('2026-02-09');   // crosses a month boundary
    expect(weatherWindowStart('2026-01-15')).toBe('2025-12-16');   // crosses a year boundary
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE HEADLINE PROOF. Every assertion here counts statements that run() genuinely issued.
describe('CARE_WATER_LEDGER_ENABLED — flag OFF issues ZERO weather_daily reads', () => {
  it('flag OFF, dry run: not one statement mentions weather_daily', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive({ dryRun: true });
    expect(wd(pg)).toHaveLength(0);
  });

  it('flag OFF, LIVE: the writer runs, and the number of READS is exactly zero', async () => {
    // This is the shape that matters. The write is intentionally NOT flag-gated — the substrate has
    // to accumulate before F2 can consume it — so weather_daily statements DO appear on a live run.
    // What must not appear, at all, is a SELECT: that is the ungated-read-of-a-missing-relation that
    // blanked the nightly plan in BUG-SEEDEDGATE-001.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive();
    expect(wdInserts(pg).length).toBeGreaterThan(0);
    expect(wdSelects(pg)).toHaveLength(0);
    expect(wd(pg).length).toBe(wdInserts(pg).length);
  });

  it('flag ON, LIVE: exactly one read per space appears, over the 30-day window', async () => {
    vi.stubEnv('CARE_WATER_LEDGER_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive();
    expect(wdSelects(pg)).toHaveLength(1);
    expect(wdSelects(pg)[0].params).toEqual([SPACE, weatherWindowStart(TODAY), YESTERDAY]);
  });

  it('only the exact string "true" arms it — a truthy-looking value must stay OFF', async () => {
    // The flag is the gate on a read against a relation that may not exist. Loose coercion here
    // ('1', 'yes', 'TRUE') is how a config typo becomes an outage, so the check is ===.
    for (const v of ['1', 'yes', 'TRUE', 'True', '', 'false']) {
      vi.stubEnv('CARE_WATER_LEDGER_ENABLED', v);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { pg } = await drive();
      expect(wdSelects(pg), `flag value ${JSON.stringify(v)} must not arm the read`).toHaveLength(0);
    }
  });

  it('a DRY run never writes, even with the flag ON', async () => {
    // The wrapper contract: scripts/rerun-daily-plan.sh --diff must be zero-write. The read may
    // happen (it is harmless and the diff wants it); the write may not.
    vi.stubEnv('CARE_WATER_LEDGER_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive({ dryRun: true });
    expect(wdInserts(pg)).toHaveLength(0);
    expect(wdSelects(pg)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the substrate can never take down the nightly plan', () => {
  it('a completely broken weather_daily still produces plans and still writes daily_plan', async () => {
    // The migration-lands-late scenario, played out end to end: every statement against the new
    // relation throws, on both the read and the write path, on a LIVE run with the flag armed.
    vi.stubEnv('CARE_WATER_LEDGER_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pg = recordingPg({ throwOnWeatherDaily: true });
    const { res } = await drive({ pg });
    expect(res.rows).toBeGreaterThan(0);
    expect(planWrites(pg).length).toBeGreaterThan(0);
    // and it was loud about it rather than silent
    const msgs = warn.mock.calls.map(([l]) => { try { return JSON.parse(l).msg; } catch { return null; } });
    expect(msgs).toContain('weather_daily write failed — plan unaffected');
    expect(msgs).toContain('weather_daily read failed — ledger degrades to demand 1.0');
  });

  it('the stored plan payload is byte-identical with the flag OFF, whatever weather_daily holds', async () => {
    // F1's original pin was "flag ON == flag OFF" because generatePlan had no weatherDaily parameter
    // yet. F2 consumed the seam, so flag ON now legitimately CHANGES the plan (that is the feature —
    // its deltas are pinned by ledger-engine.test.js + the committed ledger goldens). What must hold
    // forever is the OFF half: with the flag off, neither weather_daily contents nor their absence
    // may move a byte of the stored payload.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const off = await drive();
    const offWithRows = await drive({ pgOpts: { weatherRows: [{ date: YESTERDAY, et0_in: 0.193 }] } });
    const items = (pg) => planWrites(pg).map((c) => {
      const o = JSON.parse(c.params[2]);
      delete o.generated_at;
      return o;
    });
    expect(items(offWithRows.pg)).toEqual(items(off.pg));
  });

  it('flag ON, the ledger key appears on due water items — F2 is armed, not decorative', async () => {
    // The falsifiability half of the rewritten pin above: flag ON with an empty event window makes
    // the fixture planting hard-due through the ledger path, and every due item carries the additive
    // `ledger` payload key (d / due_at / wi_eff / confidence / drivers) with INTEGER calendar keys
    // beside it — the (e->>'overdue_by')::int contract at dashboard handlers.js:433.
    vi.stubEnv('CARE_WATER_LEDGER_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive();
    const due = planWrites(pg).flatMap((c) => JSON.parse(c.params[2]).water_due || []);
    expect(due.length).toBeGreaterThan(0);
    for (const w of due) {
      expect(w.ledger).toBeTruthy();
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(w.ledger.confidence);
      expect(Number.isInteger(w.overdue_by)).toBe(true);
      expect(Number.isInteger(w.days_since)).toBe(true);
      expect(Number.isInteger(w.interval)).toBe(true);
    }
  });
});
