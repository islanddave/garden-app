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

// VERBATIM live Open-Meteo values for this Space's coordinates ([site lat],[site lon]), read from the real
// endpoint on 2026-08-12 with the exact URL lambda/daily-plan/index.js now sends. Using the real
// numbers rather than round ones keeps the fixture from drifting into a shape the API never produces —
// note in particular that et0 differs between the two days in the THIRD decimal (0.186 vs 0.193), which
// is precisely the resolution round2 would have destroyed.
//
// The five V5-WXBACKFILLVARS-001 keys are equally verbatim, but from the ARCHIVE endpoint, read at
// the same coordinates on 2026-09-07: the forecast call carries past_days=2, so its own August
// values are no longer retrievable and inventing plausible-looking ones is exactly what the
// paragraph above warns against. Durations are SECONDS, not hours. The two surfaces disagree about
// rain on these days — the archive gives 0.024"/0.004" where the forecast pass gave 0 — which is why
// precip_hours: 5 sits next to precip_in: 0 below. That is real, and it is the same
// forecast-vs-archive gap the conflict policy's rank order exists to arbitrate.
const SETTLED = [
  { date: DAY_BEFORE, et0_in: 0.186, tmax_f: 82.3, tmin_f: 58.0, precip_in: 0,
    daylight_s: 50811.38, sunshine_s: 45182.15, solar_mj_m2: 24.0, wind_max_mph: 6.9, precip_hours: 5 },
  { date: YESTERDAY, et0_in: 0.193, tmax_f: 81.1, tmin_f: 64.7, precip_in: 0,
    daylight_s: 50666.91, sunshine_s: 49966.09, solar_mj_m2: 23.77, wind_max_mph: 10.3, precip_hours: 1 },
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
// V5-LEGACYEXCEPTIONCARE-001 added a THIRD reader of this table (droughtSignal.readDroughtSeries),
// deliberately UNGATED — see the scope note below. The two readers are told apart by their select
// lists: the water-ledger fold needs et0_in, the drought counter reads date + precip_in and nothing
// else. Discriminating here rather than loosening the counts is what keeps every ledger-gating claim
// in this file as strict as it was; a mis-gated ledger read still reds.
const ledgerSelects = (pg) => wdSelects(pg).filter((c) => /et0_in/.test(c.sql));
const droughtSelects = (pg) => wdSelects(pg).filter((c) => !/et0_in/.test(c.sql));
const planWrites = (pg) => pg.calls.filter((c) => /insert into daily_plan/.test(c.sql));

// ── BUG-WXWRITEOVERWRITE-001 — reading the conflict policy back out of the emitted statement ──────
// Strip SQL comments BEFORE collapsing whitespace: `--` runs to end of line, so the other order
// swallows the rest of the statement.
const normalizeSql = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

// The exact shape every guarded column must take. Anything that is not this — a bare COALESCE, a
// reordered rank array, a guard reading one provenance column on the stored side and another on the
// incoming side — either fails to match (and trips the anti-vacuity count below) or throws.
//
// TWO OUTRANKED BRANCHES ARE LEGAL, and exactly two (V5-WXBACKFILLVARS-001):
//   `then weather_daily.<col>`                          STRICT — keep what the better source wrote,
//                                                       NULL included. The six original columns.
//   `then coalesce(weather_daily.<col>, excluded.<col>)` FILL — a weaker source may fill a hole but
//                                                       never overwrite a value. The five V5 columns,
//                                                       which were NULL by construction until the
//                                                       migration that added them, so under STRICT
//                                                       the ERA5 backfill could never populate a row
//                                                       the nightly writer had already touched.
// Which column takes which branch is NOT left to the regex: the enumerated assertion below pins the
// exact partition, so a column silently moving between the two fails.
const CONFLICT_ARM = new RegExp(
  '(\\w+) = case when coalesce\\(array_position\\(array\\[([^\\]]*)\\], coalesce\\(weather_daily\\.(\\w+), \'\'\\)\\), 0\\)'
  + ' > coalesce\\(array_position\\(array\\[([^\\]]*)\\], coalesce\\(excluded\\.(\\w+), \'\'\\)\\), 0\\)'
  + ' then (weather_daily\\.\\1|coalesce\\(weather_daily\\.\\1, excluded\\.\\1\\))'
  + ' else coalesce\\(excluded\\.\\1, weather_daily\\.\\1\\) end', 'g');

function parseConflictSet(sql) {
  const set = normalizeSql(sql).split(/on conflict \(space_id, "date"\) do update set /i)[1];
  if (!set) throw new Error('no ON CONFLICT (space_id, "date") DO UPDATE SET in the emitted statement');
  const out = {};
  for (const [, col, orderStored, storedSrc, orderIncoming, incomingSrc, thenBranch] of set.matchAll(CONFLICT_ARM)) {
    if (storedSrc !== incomingSrc) throw new Error(`${col}: guard reads weather_daily.${storedSrc} but excluded.${incomingSrc}`);
    if (orderStored !== orderIncoming) throw new Error(`${col}: the two rank arrays differ`);
    out[col] = {
      guard: storedSrc,
      order: orderStored.split(',').map((s) => s.trim().replace(/^'|'$/g, '')),
      // 'strict' | 'fill' — read off the branch, never assumed from the column name.
      outranked: thenBranch.startsWith('coalesce(') ? 'fill' : 'strict',
    };
  }
  // ANTI-VACUITY. Every top-level assignment must be one this parser understood, plus updated_at. An
  // arm the regex silently skipped is a column this test cannot see — which is precisely how one
  // slips back to last-writer-wins with the suite still green.
  const assigned = (set.match(/(?:^|, )(\w+) = /g) || []).map((s) => s.replace(/[,\s=]/g, ''));
  const unparsed = assigned.filter((c) => c !== 'updated_at' && !(c in out));
  if (unparsed.length) throw new Error(`unrecognised conflict arm(s), not rank-guarded: ${unparsed.join(', ')}`);
  return out;
}

// Evaluate the parsed arms against a stored row and an incoming row. `array_position` is 1-based and
// yields NULL when absent, which the SQL coalesces to 0 — indexOf + 1 is the same function.
function applyConflictSet(sql, stored, incoming) {
  const merged = { ...stored };
  for (const [col, { guard, order, outranked }] of Object.entries(parseConflictSet(sql))) {
    const rank = (v) => order.indexOf(v == null ? '' : v) + 1;
    merged[col] = rank(stored[guard]) > rank(incoming[guard])
      // The outranked branch, whichever of the two this column's arm actually carries — read from
      // the emitted text, not chosen here. `?? ` is COALESCE for the fill form.
      ? (outranked === 'fill' ? (stored[col] ?? incoming[col]) : stored[col])
      : (incoming[col] ?? stored[col]);
  }
  return merged;
}

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
    // rainLog SUPPRESSED BY DEFAULT (V4-RAINAUTOLOG-001, 2026-08-28). etHour 2 is the nightly slot,
    // which is ALSO the rain-logger's window, so without this every assertion in this file about
    // "how many weather_daily statements were issued" would be silently counting a second, unrelated
    // reader. Suppressing it here keeps each existing claim measuring exactly the water-ledger path
    // it was written to measure. The rain reader has its own coverage — see the block at the bottom
    // of this file, which drives run() with it ARMED and proves it is genuinely wired in.
    etHour: 2, event: { rainLog: false, ...(opts.event || {}) },
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

  it('carries the five V5 quantities through, in the order the column list declares', async () => {
    const pg = recordingPg();
    await writeWeatherDaily(pg, SPACE, TODAY, hydrology(), {});
    const p = wdInserts(pg)[1].params;
    expect(p[1]).toBe(YESTERDAY);
    // $9..$13, appended after the eight that were already there. Asserted POSITIONALLY on purpose:
    // the column list and the bind array are two separate literals in handler.js and nothing else in
    // this suite would notice them drifting apart — five numerics of similar magnitude swap silently.
    expect(p.slice(8)).toEqual([50666.91, 49966.09, 23.77, 10.3, 1]);
    // And the seconds are seconds. 49966.09 s is 13.9 h; a writer that "helpfully" divided would put
    // 13.88 here and nothing downstream could tell which unit it was looking at.
    expect(p[9]).toBeGreaterThan(1000);
  });

  it('binds NULL, never 0, for a V5 quantity the endpoint omitted', async () => {
    // A settled day from before the append — or from a response missing the field — has no such key
    // at all. `?? null` must carry that through as SQL NULL: 0 sunshine seconds is a real overcast
    // day, so a coerced 0 would be indistinguishable from a measurement on every row.
    const pg = recordingPg();
    await writeWeatherDaily(pg, SPACE, TODAY, hydrology({
      settled_days: [{ date: YESTERDAY, et0_in: 0.193, tmax_f: 81.1, tmin_f: 64.7, precip_in: 0 }],
    }), {});
    expect(wdInserts(pg)[0].params.slice(8)).toEqual([null, null, null, null, null]);
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
    for (const n of [3, 4, 5, 6, 9, 10, 11, 12, 13]) expect(sql).toMatch(new RegExp(`\\$${n}::numeric`));
    for (const n of [7, 8]) expect(sql).toMatch(new RegExp(`\\$${n}::text`));
    // Every placeholder in the statement is cast — counted, so an APPENDED column that forgot its
    // cast cannot hide behind the enumeration above. $9..$13 are V5-WXBACKFILLVARS-001, and they are
    // the ones most exposed to this: five columns that are NULL on almost every write until the
    // backfill runs, and a NULL bind with no cast is the exact "could not determine data type of
    // parameter" failure this test is named for.
    const placeholders = new Set(sql.match(/\$\d+/g));
    const cast = new Set((sql.match(/\$\d+::\w+/g) || []).map((s) => s.split('::')[0]));
    expect([...placeholders].filter((p) => !cast.has(p))).toEqual([]);
  });

  it('the emitted upsert rank-guards EVERY measured column, not just precip_in', async () => {
    // Asserted on the SQL the driver actually received, not on the source file. The nightly run
    // rewrites D-2 as well as D-1, and by then the AmbientWeather buckets behind D-2's gauge figure
    // are gone — so without these arms every night would overwrite yesterday's measured rain with an
    // estimate, and precip_source would faithfully record the replacement while looking healthy.
    // BUG-WXWRITEOVERWRITE-001: that protection covered precip_in ALONE. et0_in/tmax_f/tmin_f were
    // `coalesce(excluded.x, weather_daily.x)`, which is last-writer-wins for every non-null value.
    const pg = recordingPg();
    await writeWeatherDaily(pg, SPACE, TODAY, hydrology(), {});
    const sql = wdInserts(pg)[0].sql;
    expect(normalizeSql(sql)).toMatch(/on conflict \(space_id, "date"\) do update set/i);
    const policy = parseConflictSet(sql);
    // ENUMERATED, not spot-checked. A column added to weather_daily and left off the SET list is
    // silently last-writer-wins, which is the whole defect — so the assertion is on the exact set.
    expect(Object.keys(policy).sort())
      .toEqual(['daylight_s', 'et0_in', 'et0_source', 'precip_hours', 'precip_in', 'precip_source',
        'solar_mj_m2', 'sunshine_s', 'tmax_f', 'tmin_f', 'wind_max_mph']);
    // Each column is guarded by the provenance column that actually describes it. tmax_f/tmin_f have
    // none of their own and ride on et0_source — the payload they arrive in. If that pairing ever
    // changes, this is the line that has to change with it. The five V5 columns are the same case:
    // one Open-Meteo payload, no competing instrument, so et0_source is their provenance too.
    expect(policy.precip_in.guard).toBe('precip_source');
    expect(policy.precip_source.guard).toBe('precip_source');
    expect(policy.et0_in.guard).toBe('et0_source');
    expect(policy.et0_source.guard).toBe('et0_source');
    expect(policy.tmax_f.guard).toBe('et0_source');
    expect(policy.tmin_f.guard).toBe('et0_source');
    for (const col of ['daylight_s', 'sunshine_s', 'solar_mj_m2', 'wind_max_mph', 'precip_hours']) {
      expect(policy[col].guard, `${col} must rank on et0_source`).toBe('et0_source');
    }
    // THE PARTITION, pinned exactly (V5-WXBACKFILLVARS-001). Which columns take the STRICT outranked
    // branch and which take the FILL one is a design decision with a live consequence — a V5 column
    // flipped to STRICT makes the ERA5 backfill a silent no-op on every row the nightly writer has
    // touched, and an original column flipped to FILL would let an archive pass write into a gap the
    // gauge deliberately left. Neither shows up in any other assertion.
    const byBranch = (b) => Object.keys(policy).filter((c) => policy[c].outranked === b).sort();
    expect(byBranch('strict'))
      .toEqual(['et0_in', 'et0_source', 'precip_in', 'precip_source', 'tmax_f', 'tmin_f']);
    expect(byBranch('fill'))
      .toEqual(['daylight_s', 'precip_hours', 'solar_mj_m2', 'sunshine_s', 'wind_max_mph']);
    // And the ranking itself, in the emitted text: worst first, best last.
    for (const col of Object.keys(policy)) {
      expect(policy[col].order).toEqual(['openmeteo_archive', 'openmeteo_live', 'gauge_merged']);
    }
    expect(normalizeSql(sql)).toContain('updated_at = now()');
  });

  // ── BUG-WXWRITEOVERWRITE-001, the behaviour half ────────────────────────────────────────────────
  // WHAT THESE PROVE AND WHAT THEY DO NOT. There is no database in this suite (it is mock-sql), so
  // nothing here can prove Postgres executes the statement as written. What applyConflictSet does is
  // read the ON CONFLICT arms OUT OF THE EMITTED SQL — which column, which guard column, which rank
  // order, which branch — and evaluate exactly those arms against a stored row and an incoming row.
  // A statement that dropped a column, swapped a guard, reordered the rank array or replaced a CASE
  // with a bare COALESCE fails to parse or evaluates differently, so the test is not a paraphrase of
  // the policy: it is derived from the text the driver received. Real DB behaviour still needs the
  // migration gates.
  describe('the conflict policy, evaluated against the emitted SQL', () => {
    const emitted = async () => {
      const pg = recordingPg();
      await writeWeatherDaily(pg, SPACE, TODAY, hydrology(), {});
      return wdInserts(pg)[0].sql;
    };

    it('a gauge-sourced tmax_f SURVIVES a later model write — the 24-hour-lifetime defect', async () => {
      const sql = await emitted();
      // Stored: the on-site station's block. Incoming: tonight's Open-Meteo pass, which carries a
      // different number for the same day. Before this fix tmax_f was `coalesce(excluded.tmax_f, ...)`
      // and 84.2 replaced 79.9 every single night.
      const merged = applyConflictSet(sql,
        { tmax_f: 79.9, tmin_f: 51.4, et0_in: 0.171, et0_source: 'gauge_merged',
          precip_in: 2.22, precip_source: 'gauge_merged' },
        { tmax_f: 84.2, tmin_f: 55.0, et0_in: 0.201, et0_source: 'openmeteo_live',
          precip_in: 4.63, precip_source: 'openmeteo_live' });
      expect(merged.tmax_f).toBe(79.9);
      expect(merged.tmin_f).toBe(51.4);
      expect(merged.et0_in).toBe(0.171);
      expect(merged.et0_source).toBe('gauge_merged');
      // The pre-existing precip guard is unchanged by the generalisation — 2.22 is the real WS-2902
      // reading Open-Meteo hindcast as 4.63 (BUG-RAINACTUAL-001).
      expect(merged.precip_in).toBe(2.22);
      expect(merged.precip_source).toBe('gauge_merged');
    });

    it('the ERA5 backfill can no longer overwrite a live value in ANY column', async () => {
      const sql = await emitted();
      const merged = applyConflictSet(sql,
        { tmax_f: 84.2, tmin_f: 55.0, et0_in: 0.201, et0_source: 'openmeteo_live',
          precip_in: 0.31, precip_source: 'openmeteo_live' },
        { tmax_f: 92.4, tmin_f: 55.0, et0_in: 0.18, et0_source: 'openmeteo_archive',
          precip_in: 0.9, precip_source: 'openmeteo_archive' });
      expect(merged.tmax_f).toBe(84.2);   // ERA5-Land reads warm on this site; it is a gap-filler
      expect(merged.et0_in).toBe(0.201);
      expect(merged.precip_in).toBe(0.31);
    });

    it('an equal or better source still WINS — the guard is not a freeze', async () => {
      const sql = await emitted();
      // Same rank both sides (the ordinary nightly re-write of D-2): the new number lands.
      const sameRank = applyConflictSet(sql,
        { tmax_f: 84.2, et0_in: 0.201, et0_source: 'openmeteo_live', precip_in: 0.31, precip_source: 'openmeteo_live' },
        { tmax_f: 85.1, et0_in: 0.205, et0_source: 'openmeteo_live', precip_in: 0.34, precip_source: 'openmeteo_live' });
      expect(sameRank.tmax_f).toBe(85.1);
      expect(sameRank.precip_in).toBe(0.34);
      // Better source over a worse one (the gauge merge arriving on top of an archive row): lands.
      const better = applyConflictSet(sql,
        { tmax_f: 92.4, et0_in: 0.18, et0_source: 'openmeteo_archive', precip_in: 0.9, precip_source: 'openmeteo_archive' },
        { tmax_f: 84.2, et0_in: 0.201, et0_source: 'openmeteo_live', precip_in: 2.22, precip_source: 'gauge_merged' });
      expect(better.tmax_f).toBe(84.2);
      expect(better.precip_source).toBe('gauge_merged');
      // Nothing stored yet in a field: the incoming value lands whatever it is labelled.
      const fresh = applyConflictSet(sql,
        { tmax_f: null, et0_in: null, et0_source: null, precip_in: null, precip_source: null },
        { tmax_f: 92.4, et0_in: 0.18, et0_source: 'openmeteo_archive', precip_in: 0.9, precip_source: 'openmeteo_archive' });
      expect(fresh.tmax_f).toBe(92.4);
      expect(fresh.precip_in).toBe(0.9);
    });

    it('a pass carrying NULL never erases what an earlier pass established', async () => {
      const sql = await emitted();
      // The COALESCE half, kept from the original policy. Same rank on both sides so the guard arm
      // is NOT what is being measured here.
      const merged = applyConflictSet(sql,
        { tmax_f: 84.2, tmin_f: 55.0, et0_in: 0.201, et0_source: 'openmeteo_live', precip_in: 0.31, precip_source: 'openmeteo_live' },
        { tmax_f: null, tmin_f: null, et0_in: null, et0_source: 'openmeteo_live', precip_in: null, precip_source: 'openmeteo_live' });
      expect(merged.tmax_f).toBe(84.2);
      expect(merged.tmin_f).toBe(55.0);
      expect(merged.et0_in).toBe(0.201);
      expect(merged.precip_in).toBe(0.31);
    });

    // ── V5-WXBACKFILLVARS-001 — the FILL branch, which is the whole reason the backfill can work ──
    it('an ERA5 pass FILLS a null V5 column on a live-sourced row — the backfill is not a no-op', async () => {
      const sql = await emitted();
      // The exact shape of every row in prod on the day the migration lands: written by the nightly
      // writer (so et0_source = openmeteo_live, rank 2), with all five V5 columns NULL because the
      // columns did not exist when it wrote. The backfill arrives labelled openmeteo_archive (rank
      // 1) and is therefore OUTRANKED on every arm. Under the strict branch the five would stay NULL
      // for ever and `--apply` would report "upserted 114 rows" having changed nothing.
      const merged = applyConflictSet(sql,
        { tmax_f: 84.2, et0_in: 0.201, et0_source: 'openmeteo_live', precip_in: 0.31, precip_source: 'openmeteo_live',
          daylight_s: null, sunshine_s: null, solar_mj_m2: null, wind_max_mph: null, precip_hours: null },
        { tmax_f: 92.4, et0_in: 0.18, et0_source: 'openmeteo_archive', precip_in: 0.9, precip_source: 'openmeteo_archive',
          daylight_s: 52498.66, sunshine_s: 7267.21, solar_mj_m2: 5.81, wind_max_mph: 9.3, precip_hours: 17 });
      expect(merged.daylight_s).toBe(52498.66);
      expect(merged.sunshine_s).toBe(7267.21);
      expect(merged.solar_mj_m2).toBe(5.81);
      expect(merged.wind_max_mph).toBe(9.3);
      expect(merged.precip_hours).toBe(17);
      // ...and the six original columns are NOT touched by the same outranked pass. This is the half
      // that makes the fill safe: one statement, two policies, and the gauge/live values still stand.
      expect(merged.tmax_f).toBe(84.2);
      expect(merged.et0_in).toBe(0.201);
      expect(merged.precip_in).toBe(0.31);
    });

    it('but an ERA5 pass may NOT overwrite a V5 value a live pass established', async () => {
      const sql = await emitted();
      const merged = applyConflictSet(sql,
        { et0_source: 'openmeteo_live', daylight_s: 46690.77, sunshine_s: 35960.79,
          solar_mj_m2: 19.35, wind_max_mph: 11.2, precip_hours: 1 },
        { et0_source: 'openmeteo_archive', daylight_s: 46690.5, sunshine_s: 21600,
          solar_mj_m2: 12.4, wind_max_mph: 8.1, precip_hours: 4 });
      expect(merged.daylight_s).toBe(46690.77);
      expect(merged.sunshine_s).toBe(35960.79);
      expect(merged.solar_mj_m2).toBe(19.35);
      expect(merged.wind_max_mph).toBe(11.2);
      expect(merged.precip_hours).toBe(1);
    });

    it('a V5 zero is a MEASUREMENT and survives — 0 sunshine is a real overcast day', async () => {
      const sql = await emitted();
      // `??` and COALESCE both treat 0 as present; `||` would not. A stored 0 must not be treated as
      // a hole an outranked archive pass may fill with its own number.
      const merged = applyConflictSet(sql,
        { et0_source: 'openmeteo_live', sunshine_s: 0, precip_hours: 0 },
        { et0_source: 'openmeteo_archive', sunshine_s: 18000, precip_hours: 6 });
      expect(merged.sunshine_s).toBe(0);
      expect(merged.precip_hours).toBe(0);
    });

    it('an out-of-domain source string cannot outrank a real one (the CHECK-constraint backstop)', async () => {
      const sql = await emitted();
      const merged = applyConflictSet(sql,
        { precip_in: 2.22, precip_source: 'gauge_merged', tmax_f: 79.9, et0_source: 'gauge_merged' },
        { precip_in: 4.63, precip_source: 'wunderground', tmax_f: 84.2, et0_source: 'wunderground' });
      // Unrecognised ranks 0, so it loses to everything — including, deliberately, the case the old
      // `<> 'gauge_merged'` test could not distinguish from a legitimate source.
      expect(merged.precip_in).toBe(2.22);
      expect(merged.tmax_f).toBe(79.9);
    });
  });

  // ── BUG-WXWRITEOVERWRITE-001, the loop boundary ─────────────────────────────────────────────────
  describe('one bad row does not take the rest of the run with it', () => {
    // Three completed days, the MIDDLE one poisoned. Before the fix the try sat outside the loop, so
    // 08-10 wrote, 08-09 threw, and 08-08 was never attempted — one warning, no count, and the run
    // looked like a single failed write rather than a two-thirds capture loss.
    const THREE = [
      { date: '2026-08-08', et0_in: 0.181, tmax_f: 80.1, tmin_f: 57.2, precip_in: 0 },
      { date: '2026-08-09', et0_in: -1, tmax_f: 81.0, tmin_f: 57.9, precip_in: 0 },
      { date: '2026-08-10', et0_in: 0.186, tmax_f: 82.3, tmin_f: 58.0, precip_in: 0 },
    ];
    const poisonedPg = () => {
      const pg = recordingPg();
      const inner = pg.query;
      pg.query = vi.fn(async (sql, params) => {
        // A real CHECK violation, not a transport error: weather_daily_et0_nonneg_chk fires on the
        // negative ET0 a unit or array-index bug upstream would produce. Recorded on pg.calls BEFORE
        // it throws — a statement the database rejected is still a statement that was ATTEMPTED, and
        // "was 08-10 attempted after 08-09 threw" is the entire question this block asks.
        if (/insert into weather_daily/i.test(sql) && params[2] < 0) {
          pg.calls.push({ sql, params });
          const e = new Error('new row for relation "weather_daily" violates check constraint "weather_daily_et0_nonneg_chk"');
          e.code = '23514';
          throw e;
        }
        return inner(sql, params);
      });
      return pg;
    };

    it('skips the bad day, writes the good ones, and reports the count', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pg = poisonedPg();
      expect(await writeWeatherDaily(pg, SPACE, TODAY, hydrology({ settled_days: THREE }), {})).toBe(2);
      // ALL THREE reached the driver — the point is that 08-10 was still ATTEMPTED after 08-09 threw.
      expect(wdInserts(pg).map((c) => c.params[1])).toEqual(['2026-08-08', '2026-08-09', '2026-08-10']);
      const skips = warn.mock.calls.map((c) => JSON.parse(c[0])).filter((l) => l.msg === 'weather_daily row skipped — plan unaffected');
      expect(skips).toHaveLength(1);
      expect(skips[0].date).toBe('2026-08-09');
      expect(skips[0].error).toMatch(/weather_daily_et0_nonneg_chk/);
    });

    it('counts the skip on the observability line — a partial run used to log nothing at all', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await writeWeatherDaily(poisonedPg(), SPACE, TODAY, hydrology({ settled_days: THREE }), {});
      const line = log.mock.calls.map((c) => JSON.parse(c[0])).find((l) => l.msg === 'weather-daily-write');
      expect(line).toBeTruthy();
      expect(line.rows).toBe(2);
      expect(line.skipped).toBe(1);
    });

    it('a MISSING RELATION still stops the loop after one warning, not N identical ones', async () => {
      // The seededgate posture is deliberately kept: every remaining day would throw identically, and
      // N copies of the same line is how a genuine per-row defect gets lost in the noise later. It
      // keeps the ORIGINAL wording too — this is not a bad row, the whole write failed.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pg = recordingPg({ throwOnWeatherDaily: true });
      expect(await writeWeatherDaily(pg, SPACE, TODAY, hydrology({ settled_days: THREE }), {})).toBe(0);
      expect(wdInserts(pg)).toHaveLength(1);
      const msgs = warn.mock.calls.map((c) => JSON.parse(c[0])).map((l) => l.msg);
      expect(msgs).toEqual(['weather_daily write failed — plan unaffected']);
    });
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
// SCOPE NOTE (2026-08-28, extended 2026-09-08): every claim below is about the WATER-LEDGER reader
// specifically, not about weather_daily reads in general — drive() suppresses the rain logger, which
// is a second and independently-gated reader of the same table. The distinction matters:
// CARE_WATER_LEDGER_ENABLED arms only on the exact string 'true' because its read could blank the
// nightly plan, whereas RAIN_AUTOLOG_ENABLED defaults ON because its read is fail-open and runs after
// the plan is durable. V5-LEGACYEXCEPTIONCARE-001 adds a THIRD: the drought counter, ungated, covered
// by its own describe below. Three readers, three risk profiles. Assertions here use ledgerSelects()
// so the ledger's gating claims stay exactly as strict as they were.
describe('CARE_WATER_LEDGER_ENABLED — flag OFF issues ZERO water-ledger weather_daily reads', () => {
  it('flag OFF, dry run: not one LEDGER statement mentions weather_daily', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive({ dryRun: true });
    expect(ledgerSelects(pg)).toHaveLength(0);
    expect(wdInserts(pg)).toHaveLength(0);
  });

  it('flag OFF, LIVE: the writer runs, and the number of LEDGER READS is exactly zero', async () => {
    // This is the shape that matters. The write is intentionally NOT flag-gated — the substrate has
    // to accumulate before F2 can consume it — so weather_daily statements DO appear on a live run.
    // What must not appear, at all, is the FOLD's SELECT: that is the ungated-read-of-a-missing-
    // relation that blanked the nightly plan in BUG-SEEDEDGATE-001.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive();
    expect(wdInserts(pg).length).toBeGreaterThan(0);
    expect(ledgerSelects(pg)).toHaveLength(0);
  });

  it('flag ON, LIVE: exactly one read per space appears, over the 30-day window', async () => {
    vi.stubEnv('CARE_WATER_LEDGER_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive();
    expect(ledgerSelects(pg)).toHaveLength(1);
    expect(ledgerSelects(pg)[0].params).toEqual([SPACE, weatherWindowStart(TODAY), YESTERDAY]);
  });

  it('only the exact string "true" arms it — a truthy-looking value must stay OFF', async () => {
    // The flag is the gate on a read against a relation that may not exist. Loose coercion here
    // ('1', 'yes', 'TRUE') is how a config typo becomes an outage, so the check is ===.
    for (const v of ['1', 'yes', 'TRUE', 'True', '', 'false']) {
      vi.stubEnv('CARE_WATER_LEDGER_ENABLED', v);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { pg } = await drive();
      expect(ledgerSelects(pg), `flag value ${JSON.stringify(v)} must not arm the read`).toHaveLength(0);
    }
  });

  it('a DRY run never writes, even with the flag ON', async () => {
    // The wrapper contract: scripts/rerun-daily-plan.sh --diff must be zero-write. The read may
    // happen (it is harmless and the diff wants it); the write may not.
    vi.stubEnv('CARE_WATER_LEDGER_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive({ dryRun: true });
    expect(wdInserts(pg)).toHaveLength(0);
    expect(ledgerSelects(pg)).toHaveLength(1);
  });
});

// V5-LEGACYEXCEPTIONCARE-001 — the drought counter's series, and why it is NOT behind the flag.
// CARE_WATER_LEDGER_ENABLED is absent from the live garden-daily-plan env, so a gated drought read
// would be null in every production run and the trigger would be an inert branch. Flipping that flag
// to unblock it would arm the whole Water Ledger fold for both users at once, which the crucible
// verdict forbids as an opening move. The seededgate reasoning that justifies gating the fold's read
// does not transfer: this same handler already writes weather_daily unconditionally on every live run,
// so the relation is known to exist by the time this SELECT is issued.
describe('the drought series reads UNCONDITIONALLY, and touches nothing the ledger owns', () => {
  it('flag OFF, LIVE: exactly one drought read per space, over its own window', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive();
    expect(droughtSelects(pg)).toHaveLength(1);
    expect(droughtSelects(pg)[0].params).toEqual([SPACE, weatherWindowStart(TODAY), YESTERDAY]);
    expect(droughtSelects(pg)[0].sql).not.toMatch(/et0_in|tmax_f|tmin_f/);   // date + precip_in only
  });

  it('flag OFF, DRY run: the read still happens — a diff must see the same signal a live run does', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive({ dryRun: true });
    expect(droughtSelects(pg)).toHaveLength(1);
    expect(wdInserts(pg)).toHaveLength(0);
  });

  it('flag ON does not duplicate or displace it — the two readers coexist, one each', async () => {
    vi.stubEnv('CARE_WATER_LEDGER_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive();
    expect(droughtSelects(pg)).toHaveLength(1);
    expect(ledgerSelects(pg)).toHaveLength(1);
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// V4-RAINAUTOLOG-001 part 2 — the rain logger, driven through run() rather than in isolation.
//
// rainLog.test.js proves every DECISION without a database. What it cannot prove is that
// logRainEvents is actually REACHED by run(), which is the failure mode that ships a feature that
// looks wired and never fires — precisely the bug this whole ticket exists to fix. So these tests
// count the statements run() genuinely sends, the same technique the water-ledger block above uses.
describe('rain auto-log — reached by run(), and correctly gated (V4-RAINAUTOLOG-001)', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });

  // A gauge-sourced day above threshold. weatherRows is what recordingPg returns to every
  // weather_daily SELECT, which is enough for the rain reader's single-row lookup.
  const RAINY = [{ precip_in: 0.34, precip_source: 'gauge_merged' }];
  const rainInserts = (pg) => pg.calls.filter((c) => /insert into event_log/i.test(c.sql));
  const rainReads = (pg) => pg.calls.filter((c) => /select precip_in, precip_source from weather_daily/i.test(c.sql));

  it('IS wired into run(): armed, it reads weather_daily and writes rain events', async () => {
    const { pg } = await drive({ event: { rainLog: true }, pgOpts: { weatherRows: RAINY } });
    expect(rainReads(pg), 'the rain reader never ran — logRainEvents is not reachable').toHaveLength(1);
    expect(rainInserts(pg)).toHaveLength(1);
    // The measured amount reaches the row, and it is the gauge value, not a rounded or default one.
    expect(rainInserts(pg)[0].params).toContain(0.34);
  });

  it('logs YESTERDAY, not today — the day being closed out', async () => {
    const { pg } = await drive({ event: { rainLog: true }, pgOpts: { weatherRows: RAINY } });
    expect(rainReads(pg)[0].params[0]).toBe(YESTERDAY);
    expect(rainInserts(pg)[0].params[0]).toBe(YESTERDAY);
  });

  it('writes NO reward side effect — no XP, no critter, no streak, no app_events', async () => {
    // reward-ux-guideline-V102: auto-logged rain is not a user logging action. This is the assertion
    // that keeps a future refactor from routing it through POST /api/events/batch, whose
    // batchSideEffects.js would credit the weather with a watering streak.
    const { pg } = await drive({ event: { rainLog: true }, pgOpts: { weatherRows: RAINY } });
    const forbidden = pg.calls.filter((c) => /app_events|user_stats|critter|streak|achievement|xp_/i.test(c.sql));
    expect(forbidden.map((c) => c.sql)).toEqual([]);
  });

  it('maintains BOTH care-cache arms, and neither bakes next_water_at', async () => {
    // entity_memory is keyed plant-first but also carries a project-keyed row, and they are not
    // interchangeable. The first version of this code updated only the plant arm and set
    // next_water_at on it — wrong twice, caught by the gate-invariants sweep rather than here.
    // See migrations/v4-rainbackfill-001/0c-cachearms.sql.
    const { pg } = await drive({ event: { rainLog: true }, pgOpts: { weatherRows: RAINY } });
    const cache = pg.calls.filter((c) => /into entity_memory/i.test(c.sql));
    expect(cache, 'both arms must be maintained — plant AND project').toHaveLength(2);
    // UPSERTS, not UPDATEs: a plant whose FIRST event is this rain row has no cache row to update,
    // and an UPDATE skips it silently. That is how staging failed the missing-cache-row invariant
    // while prod, where every row already existed, stayed green.
    expect(cache.some((c) => /on conflict \(plant_id\)/i.test(c.sql))).toBe(true);
    expect(cache.some((c) => /on conflict \(project_id\)/i.test(c.sql))).toBe(true);
    for (const c of cache) {
      expect(c.sql, 'forward-only; never walks the cache backwards').toMatch(/greatest/i);
      // next_water_at is PROJECT-ARM-ONLY and belongs to the daily-plan engine. v4-carekey-001 pins
      // plant-row next_water_at at zero, so an event writer must not set it on either arm here.
      expect(c.sql, 'next_water_at belongs to the engine, not to this writer').not.toMatch(/next_water_at/i);
    }
  });

  it('a model-sourced day writes NOTHING, however wet', async () => {
    const { pg } = await drive({
      event: { rainLog: true },
      pgOpts: { weatherRows: [{ precip_in: 2.0, precip_source: 'openmeteo_archive' }] },
    });
    expect(rainReads(pg)).toHaveLength(1);      // it looked...
    expect(rainInserts(pg)).toHaveLength(0);    // ...and declined
  });

  it('suppressed, it does not even READ weather_daily — the gate is before the query', async () => {
    const { pg } = await drive({ event: { rainLog: false }, pgOpts: { weatherRows: RAINY } });
    expect(rainReads(pg)).toHaveLength(0);
    expect(rainInserts(pg)).toHaveLength(0);
  });

  it('a dry run looks but never writes', async () => {
    const { pg } = await drive({ dryRun: true, event: { rainLog: true }, pgOpts: { weatherRows: RAINY } });
    expect(rainReads(pg)).toHaveLength(1);
    expect(rainInserts(pg)).toHaveLength(0);
  });

  it('is NON-FATAL: a rain-log failure must not cost the daily plan', async () => {
    // The whole reason logRainEvents sits after the durable plan write and catches everything.
    const pg = recordingPg({ weatherRows: RAINY });
    const realQuery = pg.query;
    pg.query = vi.fn(async (sql, params) => {
      if (/select precip_in, precip_source from weather_daily/i.test(sql)) throw new Error('boom');
      return realQuery(sql, params);
    });
    pg.calls = pg.calls;
    const { res } = await drive({ pg, event: { rainLog: true } });
    expect(res.rows).toBeGreaterThan(0);       // the plan still got written
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// BUG-CACHEORPHANREGRESS-001 — the rain night's care-cache upserts write LIVE parents only.
//
// WHAT IS GUARDED. The two entity_memory upserts logRainEvents sends after the rain INSERT. The plant
// arm must skip a soft-deleted planting and the container arm a soft-deleted container, and both must
// still write an ARCHIVED one. Until this change neither joined its parent at all, so every rain night
// re-created a cache row for each soft-deleted planting that had ever been watered: the very rows that
// lambda/plants/index.js and merge.js delete along with the soft-delete (BUG-CACHEORPHANLEAK-001).
// Seven of them sat on prod from 2026-08-28, each counted by integrity-weekly-check.sh's
// entity_memory_orphans (migrations/v5-cacheorphan-001 removes them). Archived stays WRITTEN because
// migrations/v4-cachemissingrow-001 gates every non-deleted planting and container with events on
// having a cache row, archived included.
//
// METHOD. The statements are the ones run() actually sent (drive() above), not the handler's source,
// so a filter left in a branch that never runs is a filter that is not there. Each is parsed into its
// FROM list and its WHERE and evaluated for the four states a parent can be in on deleted_at x
// archived_at, the way rain-live-filter.test.js evaluates the rain INSERT: the parent's two columns are
// PINNED from the state, the join key is TRUE (it is the event's own foreign key, so every event row
// finds its parent) and every other term is left free. The join type is READ: under an INNER join the
// ON and the WHERE both filter; under a LEFT join the ON only decides whether the parent's columns are
// filled, and a row whose ON failed reaches the WHERE with all of them NULL.
//
// WHY NOT THAT FILE'S PARSER. Its header asks that a third guard needing it hoist it into a module
// outside this function directory rather than copy it again, and moving its two existing copies is not
// this change. This model is narrower on purpose: the WHERE must be a conjunction, and a parent term it
// cannot place (inside an OR, a NOT, a COALESCE, a CASE, a HAVING, a subquery, or another join's ON)
// THROWS instead of being scored. An unusual but correct spelling therefore fails loudly and has to be
// written plainly; nothing can pass for the wrong reason.
//
// LIMIT: the pg stub records SQL and runs none of it, so this proves the statements' shape, not the rows
// they match. The prod read of both statements and the fork rehearsal are in the migration's README.

const PARENT_STATES = {
  live: { deleted_at: false, archived_at: false },
  deleted: { deleted_at: true, archived_at: false },
  archived: { deleted_at: false, archived_at: true },
  deletedAndArchived: { deleted_at: true, archived_at: true },
};
// The ONLY acceptable answer on either arm: a soft-deleted parent gets no row, an archived one does.
const DELETED_REFUSED = { live: true, deleted: false, archived: true, deletedAndArchived: false };
const EVERY_STATE = { live: true, deleted: true, archived: true, deletedAndArchived: true };

// Each arm's key column on event_log, and the relations its parent may be read from (the view or the
// table under it; both carry deleted_at and archived_at).
const CACHE_ARMS = {
  plant: { key: 'plant_id', parents: ['garden_node', 'plants'] },
  project: { key: 'project_id', parents: ['container', 'plant_projects'] },
};

// SQL comments as Postgres reads them (a quoted `--` stays a literal), lower-cased outside string
// literals, then tokenised.
const CACHE_SQL_COMMENT = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g;
const CACHE_TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|[a-z0-9_$.]+|\S/g;
function cacheTokens(sql) {
  return sql
    .replace(CACHE_SQL_COMMENT, (m) => (m.startsWith('--') || m.startsWith('/*') ? ' ' : m))
    .replace(/'(?:[^']|'')*'|[^']+/g, (m) => (m.startsWith("'") ? m : m.toLowerCase()))
    .match(CACHE_TOKEN) ?? [];
}

function closeOf(tokens, open) {
  for (let depth = 0, k = open; k < tokens.length; k += 1) {
    if (tokens[k] === '(') depth += 1;
    else if (tokens[k] === ')' && --depth === 0) return k;
  }
  throw new Error(`unbalanced ( at token ${open}`);
}

// Split at depth-0 `sep` tokens. BETWEEN's own AND, and anything inside CASE ... END, stay in their term.
function splitTop(tokens, sep) {
  const out = [[]];
  for (let k = 0, depth = 0, cases = 0, between = false; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t === '(') depth += 1;
    else if (t === ')') depth -= 1;
    else if (t === 'case') cases += 1;
    else if (t === 'end') cases -= 1;
    else if (depth === 0 && cases === 0) {
      if (t === 'between') between = true;
      else if (t === 'and' && between) between = false;
      else if (t === sep) { out.push([]); continue; }
    }
    out.at(-1).push(t);
  }
  return out;
}

// A clause's conjuncts: split at depth-0 AND, a fully parenthesised conjunct unwrapped and split again.
// A depth-0 OR keeps the clause as ONE term, which is harmless unless it names a parent column (then the
// caller throws).
function conjuncts(tokens) {
  if (!tokens.length) return [];
  if (splitTop(tokens, 'or').length > 1) return [tokens];
  return splitTop(tokens, 'and').flatMap((t) => {
    if (!t.length) throw new Error('an empty term in a conjunction');
    const wrapped = t[0] === '(' && closeOf(t, 0) === t.length - 1 && !/^(select|with|values)$/.test(t[1]);
    return wrapped ? conjuncts(t.slice(1, -1)) : [t];
  });
}

// The SELECT's FROM list, WHERE and HAVING, each found at depth 0. `on conflict` also ends the SELECT.
const SELECT_END = new Set(['group', 'having', 'order', 'limit', 'offset', 'window', 'union', 'returning', ';']);
function selectClauses(tokens) {
  const depth = [];
  tokens.reduce((d, t) => { const here = t === ')' ? d - 1 : d; depth.push(here); return t === '(' ? d + 1 : here; }, 0);
  const find = (from, test) => tokens.findIndex((t, k) => k > from && depth[k] === 0 && test(t, k));
  const s = find(-1, (t) => t === 'select');
  const f = find(s, (t) => t === 'from');
  if (s < 0 || f < 0) throw new Error('no SELECT ... FROM at the top level of the statement');
  const ends = (t, k) => SELECT_END.has(t) || (t === 'on' && tokens[k + 1] === 'conflict');
  const endAt = (k) => { const e = find(k, ends); return e < 0 ? tokens.length : e; };
  const e = endAt(f);
  const w = find(f, (t, k) => t === 'where' && k < e);
  const h = find(f, (t) => t === 'having');
  return {
    from: tokens.slice(f + 1, w < 0 ? e : w),
    where: w < 0 ? [] : tokens.slice(w + 1, e),
    having: h < 0 ? [] : tokens.slice(h + 1, endAt(h)),
  };
}

// The FROM list as relations in order, each with how it is joined and its ON's tokens.
const JOIN_WORDS = new Set(['join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'outer', 'lateral']);
function fromItems(tokens) {
  const items = [];
  let k = 0;
  const relation = (how) => {
    if (tokens[k] === '(' || tokens[k] === 'lateral') throw new Error('a subquery or LATERAL in the FROM list: this model reads plain relations only');
    const table = String(tokens[k]).replace(/^public\./, '');
    k += 1;
    if (tokens[k] === 'as') k += 1;
    const alias = tokens[k] !== undefined && !JOIN_WORDS.has(tokens[k]) && !['on', 'using', ','].includes(tokens[k]) ? tokens[k++] : table;
    if (tokens[k] === 'using') throw new Error('JOIN ... USING: this model reads ON only');
    const item = { table, alias, how, on: [] };
    if (tokens[k] === 'on') {
      const start = ++k;
      for (let depth = 0; k < tokens.length; k += 1) {
        if (tokens[k] === '(') depth += 1;
        else if (tokens[k] === ')') depth -= 1;
        else if (depth === 0 && (tokens[k] === ',' || JOIN_WORDS.has(tokens[k]))) break;
      }
      item.on = tokens.slice(start, k);
    }
    items.push(item);
  };
  relation('from');
  while (k < tokens.length) {
    if (tokens[k] === ',') { k += 1; relation('inner'); continue; }
    const words = [];
    while (tokens[k] !== 'join') {
      if (!JOIN_WORDS.has(tokens[k])) throw new Error(`unexpected "${tokens[k]}" in the FROM list`);
      words.push(tokens[k]);
      k += 1;
    }
    k += 1;
    const kind = words.join(' ');
    const how = kind === '' || kind === 'inner' ? 'inner' : kind === 'left' || kind === 'left outer' ? 'left' : null;
    if (!how) throw new Error(`${kind} join: this model reads JOIN, INNER JOIN and LEFT [OUTER] JOIN only`);
    relation(how);
  }
  return items;
}

// Which parent states the statement writes a cache row for. `parent` is null when the statement does not
// read its parent at all (then every state is written); `pinned` names the parent-column terms found.
function cacheParentModel(sql, arm) {
  const { key, parents } = CACHE_ARMS[arm];
  const { from, where, having } = selectClauses(cacheTokens(sql));
  const items = fromItems(from);
  const [base] = items;
  if (base.table !== 'event_log') throw new Error(`the ${arm} arm no longer reads FROM event_log first: this model takes the event rows as the base`);
  const hidden = [...where, ...having].find((t) => parents.includes(t.replace(/^public\./, '')));
  if (hidden) throw new Error(`the ${arm} arm reads ${hidden} inside its WHERE or HAVING: a parent this model cannot place`);
  const bound = items.filter((it) => parents.includes(it.table));
  if (bound.length > 1) throw new Error(`the ${arm} arm binds its parent ${bound.length} times: "the parent" is ambiguous`);
  if (!bound.length) return { parent: null, pinned: [], admits: { ...EVERY_STATE } };
  const [p] = bound;
  const cols = new Map([[`${p.alias}.deleted_at`, 'deleted_at'], [`${p.alias}.archived_at`, 'archived_at']]);
  const names = (toks) => toks.some((t) => cols.has(t));
  for (const it of items) {
    if (it !== p && names(it.on)) throw new Error(`the ${arm} parent's filter sits in the ON of ${it.table}, not its own`);
  }
  if (names(having)) throw new Error(`the ${arm} parent's filter sits in the HAVING: this model cannot place it`);
  const classify = (terms, place) => terms.map((t) => {
    const text = t.join(' ');
    for (const [c, col] of cols) {
      if (text === `${c} is null`) return { text, col, isNull: true };
      if (text === `${c} is not null`) return { text, col, isNull: false };
    }
    if (names(t)) throw new Error(`the ${arm} parent's filter is buried in ${place}, inside an expression this model cannot evaluate: ${text.slice(0, 90)}`);
    return { text };
  });
  const on = classify(conjuncts(p.on), 'its ON');
  const wh = classify(conjuncts(where), 'the WHERE');
  const keyed = [`${p.alias}.id = ${base.alias}.${key}`, `${base.alias}.${key} = ${p.alias}.id`];
  const hasKey = (terms) => terms.some((t) => keyed.includes(t.text));
  if (!hasKey(on) && !(p.how === 'inner' && hasKey(wh))) {
    throw new Error(`the ${arm} arm joins ${p.table} on something other than the event's own ${key}`);
  }
  const holds = (terms, state) => terms.every((t) => !t.col || (t.isNull ? !state[t.col] : state[t.col]));
  const NULLS = { deleted_at: false, archived_at: false };
  const admits = Object.fromEntries(Object.entries(PARENT_STATES).map(([name, state]) => [name,
    p.how === 'inner'
      ? holds(on, state) && holds(wh, state)
      // LEFT: the ON decides only whether the parent's columns are filled; the WHERE then reads them.
      : holds(wh, holds(on, state) ? state : NULLS)]));
  return { parent: { table: p.table, alias: p.alias, how: p.how }, pinned: [...on, ...wh].filter((t) => t.col).map((t) => t.text), admits };
}

// Synthetic statements in the two arms' shapes, for the bench below.
const PLANT_ARM = (from, where) => `insert into entity_memory (plant_id, last_event_at, last_watered_at)
       select e.plant_id, max(e.event_date), max(e.event_date)
         from ${from}
        where ${where}
        group by e.plant_id
       on conflict (plant_id) where plant_id is not null do update set
         last_event_at = greatest(coalesce(entity_memory.last_event_at, excluded.last_event_at), excluded.last_event_at)`;
const PROJECT_ARM = (from, where) => `insert into entity_memory (project_id, last_event_at, last_watered_at)
       select e.project_id, max(e.event_date), max(e.event_date) filter (where e.event_type in ('watering','rain'))
         from ${from}
        where ${where}
        group by e.project_id
       having max(e.event_date) filter (where e.event_type in ('watering','rain')) is not null
       on conflict (project_id) do update set
         last_event_at = greatest(coalesce(entity_memory.last_event_at, excluded.last_event_at), excluded.last_event_at)`;

describe('BUG-CACHEORPHANREGRESS-001 — the rain night care-cache upserts never write a soft-deleted parent', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });

  // Driven inside each test, so a model that throws reds that test and leaves the others running.
  const sent = async () => {
    const { pg } = await drive({ event: { rainLog: true }, pgOpts: { weatherRows: [{ precip_in: 0.34, precip_source: 'gauge_merged' }] } });
    const cache = pg.calls.filter((c) => /into entity_memory/i.test(c.sql));
    return {
      cache,
      plant: cache.filter((c) => /on conflict \(plant_id\)/i.test(c.sql)),
      project: cache.filter((c) => /on conflict \(project_id\)/i.test(c.sql)),
    };
  };

  it('is evaluating the two statements run() sends, each reading its parent (vacuity floor)', async () => {
    const { cache, plant, project } = await sent();
    expect(cache, 'the rain night no longer sends both cache upserts').toHaveLength(2);
    expect(plant).toHaveLength(1);
    expect(project).toHaveLength(1);
    expect(plant[0].sql).toMatch(/insert into entity_memory \(plant_id,/);
    expect(project[0].sql).toMatch(/insert into entity_memory \(project_id,/);
    for (const [arm, [c]] of [['plant', plant], ['project', project]]) {
      const m = cacheParentModel(c.sql, arm);
      expect(m.parent, `the ${arm} arm no longer reads its parent: every soft-deleted one gets a row`).not.toBeNull();
      // Named here, so a lost filter reports THAT rather than only a state table below.
      expect(m.pinned.some((t) => t.startsWith(`${m.parent.alias}.deleted_at `)), `the ${arm} arm carries no deleted_at term`).toBe(true);
    }
  });

  it('the plant arm writes a live or archived planting and never a soft-deleted one', async () => {
    const m = cacheParentModel((await sent()).plant[0].sql, 'plant');
    expect(m.admits.live, 'the plant arm writes no live planting: the writer, or this model, has gone dead').toBe(true);
    expect(m.admits.archived, 'an archived planting loses its cache row (v4-cachemissingrow-001)').toBe(true);
    expect(m.admits, 'the plant arm writes these planting states').toEqual(DELETED_REFUSED);
  });

  it('the container arm writes a live or archived container and never a soft-deleted one', async () => {
    const m = cacheParentModel((await sent()).project[0].sql, 'project');
    expect(m.admits.live, 'the container arm writes no live container: the writer, or this model, has gone dead').toBe(true);
    expect(m.admits.archived, 'an archived container loses its cache row (v4-cachemissingrow-001)').toBe(true);
    expect(m.admits, 'the container arm writes these container states').toEqual(DELETED_REFUSED);
  });

  it('reads the plant filter from the statement, not its spelling (synthetic statements)', () => {
    // The same model on statements no writer contains, so it is shown to SEPARATE the shapes rather
    // than merely agree with today's handler.
    const E = "e.event_type in ('watering','rain') and e.deleted_at is null and e.plant_id is not null";
    const J = 'event_log e join garden_node gn on gn.id = e.plant_id';
    const of = (from, where) => cacheParentModel(PLANT_ARM(from, where), 'plant').admits;
    const REFUSED = [
      [J, `${E} and gn.deleted_at is null`],                                                   // the handler's shape
      ['event_log e join garden_node gn on gn.id = e.plant_id and gn.deleted_at is null', E],  // in an INNER join's ON
      ['event_log e inner join public.garden_node as gn on e.plant_id = gn.id', `gn.deleted_at is null and ${E}`],
      ['event_log e left join garden_node gn on gn.id = e.plant_id', `${E} and gn.deleted_at is null`],  // LEFT, filter in the WHERE
      ['event_log e, garden_node gn', `gn.id = e.plant_id and ${E} and (gn.deleted_at is null)`],       // comma join, key in the WHERE
      ['event_log e join plants p on p.id = e.plant_id', `${E} and p.deleted_at is null`],               // the table, not the view
      [J, `${E} and gn.deleted_at is null and gn.status is distinct from 'ended'`],             // another parent term stays free
      [J, `x <> '--' and ${E} and gn.deleted_at is null`],                                      // a quoted -- is not a comment
      [J, `e.event_date between '2026-01-01' and '2027-01-01' and ${E} and gn.deleted_at is null`],  // BETWEEN's AND is its own
    ];
    for (const [f, w] of REFUSED) expect(of(f, w), `${f} / ${w}`).toEqual(DELETED_REFUSED);
    const T = true;
    const F = false;
    const LEAKS = [
      ['event_log e', E, EVERY_STATE],                                                                    // no join (the regression)
      [J, E, EVERY_STATE],                                                                                // joined, never filtered
      [J, `${E} and gn.deleted_at is not null`, { live: F, deleted: T, archived: F, deletedAndArchived: T }],   // inverted
      [J, `${E} and gn.archived_at is null`, { live: T, deleted: T, archived: F, deletedAndArchived: F }],      // archived instead
      [J, `${E} and gn.deleted_at is null and gn.archived_at is null`, { ...DELETED_REFUSED, archived: F }],    // archived as well
      ['event_log e left join garden_node gn on gn.id = e.plant_id and gn.deleted_at is null', E, EVERY_STATE],  // LEFT, filter in the ON
      ['event_log e left join garden_node gn on gn.id = e.plant_id and gn.deleted_at is null',                // ...and repeated in the
        `${E} and gn.deleted_at is null`, EVERY_STATE],                                                   // WHERE: the NULLs pass it
      [J, `${E}\n         -- and gn.deleted_at is null\n`, EVERY_STATE],                                  // a line comment
      [J, `${E} /* and gn.deleted_at is null */`, EVERY_STATE],                                           // a block comment
      [J, `${E} and e.deleted_at is null`, EVERY_STATE],                                                  // the event's column, not the parent's
      [`${J} join container ct on ct.id = gn.container_id`, `${E} and ct.deleted_at is null`, EVERY_STATE],  // the container's, not the planting's
    ];
    for (const [f, w, admits] of LEAKS) expect(of(f, w), `${f} / ${w}`).toEqual(admits);
    const THROWS = [
      [J, `${E} and coalesce(gn.deleted_at, gn.archived_at) is null`, /buried/],
      [J, `${E} and (gn.deleted_at is null or e.event_type = 'rain')`, /buried/],
      [J, `${E} and gn.deleted_at is null or e.plant_id is null`, /buried/],
      [J, `${E} and not gn.deleted_at is not null`, /buried/],
      [J, `${E} and case when true then gn.deleted_at is null else true end`, /buried/],
      ['event_log e', `${E} and exists (select 1 from garden_node g2 where g2.id = e.plant_id and g2.deleted_at is null)`, /cannot place/],
      ['event_log e join garden_node gn on gn.id = e.project_id', `${E} and gn.deleted_at is null`, /own plant_id/],
      [`${J} join garden_node g2 on g2.id = e.plant_id`, `${E} and gn.deleted_at is null`, /ambiguous/],
      ['event_log e right join garden_node gn on gn.id = e.plant_id', `${E} and gn.deleted_at is null`, /JOIN only/],
      ['event_log e join garden_node gn using (id)', `${E} and gn.deleted_at is null`, /USING/],
      ['garden_node gn join event_log e on e.plant_id = gn.id', `${E} and gn.deleted_at is null`, /event_log first/],
      [`${J} join locations l on l.id = gn.location_id and gn.deleted_at is null`, E, /ON of locations/],
    ];
    for (const [f, w, re] of THROWS) expect(() => of(f, w), `${f} / ${w}`).toThrow(re);
  });

  it('reads the container filter from the statement, not its spelling (synthetic statements)', () => {
    const E = 'e.deleted_at is null and e.project_id is not null';
    const J = 'event_log e join container ct on ct.id = e.project_id';
    const of = (from, where) => cacheParentModel(PROJECT_ARM(from, where), 'project').admits;
    expect(of(J, `${E} and ct.deleted_at is null`)).toEqual(DELETED_REFUSED);                                        // the handler's shape
    expect(of('event_log e join plant_projects pp on pp.id = e.project_id and pp.deleted_at is null', E)).toEqual(DELETED_REFUSED);
    expect(of('event_log e', E)).toEqual(EVERY_STATE);                                                                // no join
    expect(of(J, E)).toEqual(EVERY_STATE);                                                                            // never filtered
    expect(of(J, `${E} and ct.deleted_at is not null`)).toEqual({ live: false, deleted: true, archived: false, deletedAndArchived: true });
    expect(of(J, `${E} and ct.archived_at is null`)).toEqual({ live: true, deleted: true, archived: false, deletedAndArchived: false });
    expect(of('event_log e left join container ct on ct.id = e.project_id and ct.deleted_at is null', E)).toEqual(EVERY_STATE);
    // The planting's filter does not stand in for the container's.
    expect(of(`${J} join garden_node gn on gn.id = e.plant_id`, `${E} and gn.deleted_at is null`)).toEqual(EVERY_STATE);
    expect(() => of('event_log e join container ct on ct.id = e.plant_id', `${E} and ct.deleted_at is null`)).toThrow(/own project_id/);
    // The select list's FILTER (WHERE ...) is not the statement's WHERE, and a HAVING cannot hide a filter.
    const inHaving = PROJECT_ARM(J, E).replace(/(having [^\n]* is not null)\n/, '$1 and bool_and(ct.deleted_at is null)\n');
    expect(inHaving, 'the HAVING edit did not land').toMatch(/is not null and bool_and\(ct\.deleted_at is null\)\n\s*on conflict/);
    expect(() => cacheParentModel(inHaving, 'project')).toThrow(/HAVING/);
  });
});
