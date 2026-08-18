// Unit tests for the watch-surface EXCLUSION LOG (V4-WATCHEXCLUDEDLOG-001) — the GET-path writer in
// lambda/harvests/watch-route.js and the row-grain verdict list buildWatchList now returns.
//
// Same discipline as watch-impression.test.js: these EXECUTE the handler against a recording
// tagged-template `sql` stub and assert on the parameters actually bound — never a regex over the
// module source. What a stub cannot prove (the unnest expansion, the ON CONFLICT arbiter, the FK,
// the reason CHECK) belongs in tests/integration/ once migrations/v4-watchexcluded-001 is applied;
// it is not written yet because the relation exists in no environment.
//
// THE INVARIANT UNDER TEST: the exclusion writer is a PASSENGER on the GET, never a driver. It
// records every planting the resolver DECLINED and why, at row grain, stamped with the same
// model_version the impression and dismissal rows carry — and no failure of it, including the
// migration not having landed, may alter the response by one byte.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleWatchGet, recordWatchExclusions } from './watch-route.js';
import { buildWatchList, WATCH_MODEL_VERSION } from './watch.js';

const USER = 'user_dave';
const HOUSEHOLD = ['user_dave', 'user_jen'];
const TZ = 'America/New_York';
const TODAY = '2026-08-12';
const PLANT = '11111111-2222-4333-8444-555555555555';

// The same live-prod-shaped candidate row the impression suite uses (Tender Sweet Orange): sibling
// anchor, earliest check_from 2026-07-14, eligible today.
function row(over = {}) {
  return {
    plant_id: PLANT, project_id: '99999999-2222-4333-8444-555555555555',
    planting_name: 'Tender Sweet Orange', status: 'fruiting', location_id: null,
    location_name: 'Hilltop Bed 2',
    sown_at: null, transplanted_at: '2026-06-11', planted_out_at: null,
    variety_id: '77777777-2222-4333-8444-555555555555', variety_name: 'Tender Sweet Orange',
    crop_type_slug: 'watermelon', days_to_maturity_min: 85, days_to_maturity_max: null,
    crop_display_name: 'Watermelon', harvest_habit: 'single', dtm_basis: 'from-sow',
    set_to_first_pick_days: 45, prior_harvest_count: 0, fruit_set_date: null,
    sibling_plant_id: 'sib-1', sibling_planting_name: 'Sugar Baby', sibling_first_pick_date: '2026-08-10',
    dismissed_active: false, et_today: TODAY, season_start: '2025-11-01',
    nursery_sample_n: 39, nursery_median_gap: 31,
    ...over,
  };
}

function makeSql(results) {
  const calls = [];
  const queue = [...results];
  const sql = (strings, ...params) => {
    calls.push({ text: strings.join('?'), params });
    return Promise.resolve(queue.length ? queue.shift() : []);
  };
  sql.calls = calls;
  return sql;
}

// First call answers the candidate query; every later call REJECTS — the migration-lands-late shape.
function makeSqlInsertFails(firstResult, message) {
  const calls = [];
  let n = 0;
  const sql = (strings, ...params) => {
    calls.push({ text: strings.join('?'), params });
    n += 1;
    return n === 1 ? Promise.resolve(firstResult) : Promise.reject(new Error(message));
  };
  sql.calls = calls;
  return sql;
}

const ctx = (sql, over = {}) => ({
  sql, householdIds: HOUSEHOLD, userId: USER, tz: TZ, etTodayFallback: TODAY, query: {}, ...over,
});

const exclusionInsert = (sql) => sql.calls.find((c) => /INSERT INTO public\.watch_exclusion/.test(c.text));

// Bind order mirrors the writer: userId, evaluatedOn, model_version, then the two unnest arrays.
function exclusionBinds(call) {
  const [userId, evaluatedOn, modelVersion, plantIds, reasons] = call.params;
  return { userId, evaluatedOn, modelVersion, plantIds, reasons };
}

describe('buildWatchList — row-grain exclusions alongside the census', () => {
  it('returns one excludedRows entry per declined planting, agreeing with the census', () => {
    const rows = [
      row({ plant_id: 'a1111111-2222-4333-8444-555555555555', harvest_habit: null }),
      row({ plant_id: 'b1111111-2222-4333-8444-555555555555', prior_harvest_count: 3 }),
      row({ plant_id: 'c1111111-2222-4333-8444-555555555555' }), // eligible
    ];
    const { candidates, excluded, excludedRows } = buildWatchList(rows, TODAY);
    expect(candidates).toHaveLength(1);
    expect(excluded).toEqual({ habit_not_watched: 1, already_harvested: 1 });
    expect(excludedRows).toEqual([
      { plant_id: 'a1111111-2222-4333-8444-555555555555', reason: 'habit_not_watched' },
      { plant_id: 'b1111111-2222-4333-8444-555555555555', reason: 'already_harvested' },
    ]);
  });

  it('the census and the row list can never disagree — one verdict feeds both', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({
      plant_id: `${i}1111111-2222-4333-8444-555555555555`,
      harvest_habit: i % 2 === 0 ? null : 'single',
      prior_harvest_count: i % 2 === 0 ? 0 : 4,
    }));
    const { excluded, excludedRows } = buildWatchList(rows, TODAY);
    const fromRows = {};
    for (const r of excludedRows) fromRows[r.reason] = (fromRows[r.reason] ?? 0) + 1;
    expect(fromRows).toEqual(excluded);
    expect(excludedRows).toHaveLength(6);
  });

  it('records a snoozed planting as an exclusion too — the two tables answer different questions', () => {
    // `dismissed` rows ARE served (in the tail's Snoozed subgroup) so they get an impression; they
    // are also not candidates, so they belong in the declined census. Both facts, deliberately.
    const { excludedRows, snoozed } = buildWatchList(
      [row({ dismissed_active: true, dismissal_suppressed_until: '2026-08-20' })], TODAY);
    expect(snoozed).toHaveLength(1);
    expect(excludedRows).toEqual([{ plant_id: PLANT, reason: 'dismissed' }]);
  });

  it('counts a plant_id-less row in the census but never emits it as a persistable row', () => {
    // The column is NOT NULL and FK'd — a row with no id would drop the whole batch on the CHECK
    // path. It must still be counted, or the census would silently under-report.
    const { excluded, excludedRows } = buildWatchList([row({ plant_id: null, harvest_habit: null })], TODAY);
    expect(excluded).toEqual({ habit_not_watched: 1 });
    expect(excludedRows).toEqual([]);
  });
});

describe('GET /api/harvests/watch — the exclusion write', () => {
  it('writes ONE batch statement carrying every declined planting and its reason', async () => {
    const rows = [
      row({ plant_id: 'a1111111-2222-4333-8444-555555555555', harvest_habit: null }),
      row({ plant_id: 'b1111111-2222-4333-8444-555555555555', prior_harvest_count: 3 }),
      row({ plant_id: 'c1111111-2222-4333-8444-555555555555' }), // eligible — not in this log
    ];
    const sql = makeSql([rows]);
    const res = await handleWatchGet(ctx(sql, { query: { limit: '200' } }));
    expect(res.statusCode).toBe(200);

    const inserts = sql.calls.filter((c) => /INSERT INTO public\.watch_exclusion/.test(c.text));
    expect(inserts).toHaveLength(1);
    const b = exclusionBinds(inserts[0]);
    expect(b.userId).toBe(USER);
    expect(b.evaluatedOn).toBe(TODAY);
    expect(b.plantIds).toEqual([
      'a1111111-2222-4333-8444-555555555555', 'b1111111-2222-4333-8444-555555555555',
    ]);
    expect(b.reasons).toEqual(['habit_not_watched', 'already_harvested']);
  });

  it('stamps the exclusion with the SAME model_version the impression and dismissal rows carry', async () => {
    // The join key of the whole calibration design: served set, declined set and dismissals must all
    // be partitionable within ONE model generation.
    // MUTATION TARGET: hardcode a string in the INSERT -> red here.
    const sql = makeSql([[row({ harvest_habit: null })]]);
    await handleWatchGet(ctx(sql));
    expect(exclusionBinds(exclusionInsert(sql)).modelVersion).toBe(WATCH_MODEL_VERSION);
  });

  it('names the ON CONFLICT arbiter that makes the day the exposure grain', async () => {
    // Without it, N Today opens in one day mint N rows and "exclusions per day" measures
    // phone-checking frequency rather than the resolver's verdict.
    const sql = makeSql([[row({ harvest_habit: null })]]);
    await handleWatchGet(ctx(sql));
    expect(exclusionInsert(sql).text)
      .toMatch(/ON CONFLICT \(user_id, plant_id, evaluated_on, reason\) DO NOTHING/);
  });

  it('binds every parameter with an explicit ::cast', async () => {
    // Neon cannot type a scalar bind in a SELECT list or a nullable array element; without the casts
    // the insert throws "could not determine data type of parameter" INSIDE the try/catch, and the
    // table silently never populates.
    const sql = makeSql([[row({ harvest_habit: null })]]);
    await handleWatchGet(ctx(sql));
    const { text } = exclusionInsert(sql);
    expect(text).toMatch(/\?::text, u\.plant_id, \?::date, u\.reason, \?::text/);
    expect(text).toMatch(/\?::uuid\[\]/);
    expect(text).toMatch(/\?::text\[\]/);
  });

  it('writes NOTHING when every planting is a candidate — an empty batch is not an empty statement', async () => {
    const sql = makeSql([[row()]]);
    const res = await handleWatchGet(ctx(sql));
    expect(res.body.candidates).toHaveLength(1);
    expect(exclusionInsert(sql)).toBeUndefined();
  });

  it('refuses to write without an ET day rather than corrupting the day grain', async () => {
    // Belt over the classifier's own no_today suspenders: binding NULL into evaluated_on NOT NULL
    // would fail the whole batch anyway, so skipping is the honest zero.
    const sql = makeSql([[]]);
    await handleWatchGet(ctx(sql, { etTodayFallback: null }));
    expect(exclusionInsert(sql)).toBeUndefined();
    expect(await recordWatchExclusions(sql, {
      userId: USER, evaluatedOn: null, excludedRows: [{ plant_id: PLANT, reason: 'no_anchor' }],
    })).toBe(0);
  });

  // THE NON-FATALITY INVARIANT — the exact shape of the migration-lands-late window. MUTATION
  // TARGET: remove the try/catch (or move the write after the return) -> red here.
  it('a failing exclusion insert logs a warning and never affects the GET response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = makeSqlInsertFails(
        [row({ harvest_habit: null })], 'relation "public.watch_exclusion" does not exist');
      const res = await handleWatchGet(ctx(sql));
      expect(res.statusCode).toBe(200);
      expect(res.body.excluded).toEqual({ habit_not_watched: 1 });
      expect(res.body.model_version).toBe(WATCH_MODEL_VERSION);
      expect(warn.mock.calls.some((c) => /watch_exclusion write failed/.test(c[0]))).toBe(true);
      expect(warn.mock.calls.some((c) => /GET response unaffected/.test(c[0]))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('drops a malformed entry instead of failing the batch it rides in', async () => {
    const sql = makeSql([[]]);
    const written = await recordWatchExclusions(sql, {
      userId: USER, evaluatedOn: TODAY,
      excludedRows: [
        { plant_id: PLANT, reason: 'no_anchor' },
        { plant_id: null, reason: 'no_anchor' },
        { plant_id: PLANT, reason: null },
      ],
    });
    expect(written).toBe(1);
    expect(exclusionBinds(exclusionInsert(sql)).plantIds).toEqual([PLANT]);
  });

  // CROSS-ARTIFACT GUARD. The classifier's reason vocabulary and the migration's CHECK are two
  // artifacts that must agree, and nothing else makes them. If they drift, the whole request's batch
  // is dropped by the CHECK — non-fatally, inside a try/catch — on the very day the new reason
  // starts firing, which is the day the log would most need to be trustworthy.
  it('every reason the resolver can emit is inside the migration CHECK vocabulary', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const ddl = readFileSync(
      join(here, '..', '..', 'migrations', 'v4-watchexcluded-001', '0a-additive-ddl.sql'), 'utf8');
    const clause = ddl.match(/CHECK \(reason IN \(([^)]*)\)\)/);
    expect(clause).not.toBeNull();
    const pinned = [...clause[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(pinned.sort()).toEqual([
      'already_harvested', 'basis_unchanged', 'dismissed', 'habit_not_watched',
      'no_anchor', 'no_today', 'not_yet_open',
    ]);

    // Five of the seven, produced by executing the classifier — not by reading its source. The two
    // absent here are covered elsewhere: `basis_unchanged` in watch.test.js's bounded-suppression
    // block, and `no_today` by the ET-day refusal above (it never reaches a persistable row).
    const cases = [
      row({ harvest_habit: null }),
      row({ prior_harvest_count: 3 }),
      row({ dismissed_active: true, dismissal_suppressed_until: '2026-08-20' }),
      row({ transplanted_at: null, sibling_first_pick_date: null, days_to_maturity_min: null }),
      row({ transplanted_at: '2026-08-11', sibling_first_pick_date: null }),
    ];
    const seen = new Set();
    for (const r of cases) for (const e of buildWatchList([r], TODAY).excludedRows) seen.add(e.reason);
    expect([...seen].sort()).toEqual([
      'already_harvested', 'dismissed', 'habit_not_watched', 'no_anchor', 'not_yet_open',
    ]);
    for (const reason of seen) expect(pinned).toContain(reason);
  });
});
