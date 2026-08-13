// Unit tests for the watch-surface IMPRESSION LOG (V4-WATCHIMPRESSION-001) — the GET-path writer
// in lambda/harvests/watch-route.js and its region/slot split.
//
// Same discipline as watch-route.test.js: these EXECUTE the handlers against a recording
// tagged-template `sql` stub and assert on the parameters actually bound — never a regex over the
// module source. What a stub cannot prove (the unnest expansion, the ON CONFLICT arbiter, the FK)
// belongs in tests/integration/ once migrations/v4-watchimpression-001 is applied; it is not
// written yet because the relation exists in no environment.
//
// THE INVARIANT UNDER TEST: the impression writer is a PASSENGER on the GET, never a driver. It
// records exactly what was served (region-labelled, model-versioned), and no failure of it —
// including the migration not having landed — may alter the response by one byte.
import { describe, it, expect, vi } from 'vitest';
import {
  handleWatchGet, handleDismissalPost, recordWatchImpressions, splitImpressionRegions,
  IMPRESSION_PROJECT_SLOT_CAP, DEFAULT_LIMIT,
} from './watch-route.js';
import { WATCH_MODEL_VERSION } from './watch.js';

const USER = 'user_dave';
const HOUSEHOLD = ['user_dave', 'user_jen'];
const TZ = 'America/New_York';
const TODAY = '2026-08-12';
const PLANT = '11111111-2222-4333-8444-555555555555';

// Same live-prod-shaped candidate row watch-route.test.js uses (Tender Sweet Orange): sibling
// anchor 'sibling', earliest check_from 2026-07-14, eligible today.
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

// N eligible candidates in DISTINCT projects. Ranking ties on days_watching break by plant_id, so
// ascending id prefixes make the served order deterministic.
function candidates(n) {
  return Array.from({ length: n }, (_, i) => row({
    plant_id: `${i}1111111-2222-4333-8444-555555555555`,
    project_id: `${i}9999999-2222-4333-8444-555555555555`,
    planting_name: `P${i}`,
  }));
}

function makeSql(results) {
  const calls = [];
  const queue = [...results];
  const sql = (strings, ...params) => {
    const text = strings.join('?');
    calls.push({ text, params });
    return Promise.resolve(queue.length ? queue.shift() : []);
  };
  sql.calls = calls;
  return sql;
}

// First call answers the candidate query; every later call REJECTS — the exact shape of the
// migration-lands-late window ("relation does not exist").
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

const ctx = (sql, over = {}) => ({ sql, householdIds: HOUSEHOLD, userId: USER, tz: TZ, ...over });

// Destructure the impression INSERT's binds by template position:
// SELECT ${userId} .. ${shownOn} .. ${WATCH_MODEL_VERSION} .. FROM unnest(${plantIds}, ${slots},
// ${regions}, ${anchorKinds}, ${checkFroms}).
function impressionBinds(call) {
  const [userId, shownOn, modelVersion, plantIds, slots, regions, anchorKinds, checkFroms] = call.params;
  return { userId, shownOn, modelVersion, plantIds, slots, regions, anchorKinds, checkFroms };
}

describe('splitImpressionRegions — the region/slot walk', () => {
  it('labels the first five slots top5 and the rest tail, slots 1-based within each region', () => {
    const served = candidates(7).map((c) => ({
      plant_id: c.plant_id, project_id: c.project_id,
      anchor: { kind: 'sibling' }, check_from: '2026-07-14',
    }));
    const rows = splitImpressionRegions(served, []);
    expect(rows.map((r) => r.region)).toEqual(['top5', 'top5', 'top5', 'top5', 'top5', 'tail', 'tail']);
    expect(rows.map((r) => r.slot)).toEqual([1, 2, 3, 4, 5, 1, 2]);
    expect(DEFAULT_LIMIT).toBe(5); // the visible cap the walk fills — design §3.5's 5
  });

  // MIRROR OF src/lib/harvestWatch.js selectWatchDisplay (panel Q2). MUTATION TARGET: drop the
  // per-project quota from the walk -> red here, and the region labels would lie about what the
  // client actually put in the visible band.
  it('a third same-project row is capped out to the tail even while visible slots remain', () => {
    const proj = 'aaaaaaaa-2222-4333-8444-555555555555';
    const served = ['0', '1', '2', '3', '4', '5', '6'].map((i) => ({
      plant_id: `${i}1111111-2222-4333-8444-555555555555`,
      // first three share one project; the rest are distinct
      project_id: Number(i) < 3 ? proj : `${i}9999999-2222-4333-8444-555555555555`,
      anchor: { kind: 'calendar' }, check_from: '2026-07-14',
    }));
    const rows = splitImpressionRegions(served, []);
    expect(IMPRESSION_PROJECT_SLOT_CAP).toBe(2);
    expect(rows.map((r) => r.region)).toEqual(['top5', 'top5', 'tail', 'top5', 'top5', 'top5', 'tail']);
    expect(rows.map((r) => r.slot)).toEqual([1, 2, 1, 3, 4, 5, 2]);
  });

  it('snoozed rows carry region snoozed, NULL slot and NULL anchor fields', () => {
    const rows = splitImpressionRegions([], [{ plant_id: PLANT, suppressed_until: '2026-08-20' }]);
    expect(rows).toEqual([{ plant_id: PLANT, slot: null, region: 'snoozed', anchor_kind: null, check_from: null }]);
  });

  it('freezes anchor_kind and check_from from the served candidate, as served', () => {
    const [r] = splitImpressionRegions(
      [{ plant_id: PLANT, project_id: 'p', anchor: { kind: 'sibling' }, check_from: '2026-07-14' }], []);
    expect(r.anchor_kind).toBe('sibling');
    expect(r.check_from).toBe('2026-07-14');
  });
});

describe('GET /api/harvests/watch — the impression write', () => {
  it('writes ONE batch statement: a row per served candidate with the region split, plus snoozed', async () => {
    const rows = [
      ...candidates(7),
      row({
        plant_id: '81111111-2222-4333-8444-555555555555', planting_name: 'Charentais',
        dismissed_active: true, dismissal_suppressed_until: '2026-08-20',
      }),
    ];
    const sql = makeSql([rows]);
    const res = await handleWatchGet(ctx(sql, { query: { limit: '200' } }));
    expect(res.statusCode).toBe(200);

    expect(sql.calls).toHaveLength(2); // candidate query + ONE impression batch, never N inserts
    const insert = sql.calls[1];
    expect(insert.text).toMatch(/INSERT INTO public\.watch_impression/);

    const b = impressionBinds(insert);
    expect(b.userId).toBe(USER);
    expect(b.shownOn).toBe(TODAY);
    expect(b.plantIds).toHaveLength(8); // 7 served + 1 snoozed — and NOTHING else
    expect(b.regions).toEqual(['top5', 'top5', 'top5', 'top5', 'top5', 'tail', 'tail', 'snoozed']);
    expect(b.slots).toEqual([1, 2, 3, 4, 5, 1, 2, null]);
    // Frozen as served: the sibling anchor and the earliest check_from; snoozed rows carry neither
    // (their frozen anchor already lives on their dismissal row).
    expect(b.anchorKinds).toEqual(['sibling', 'sibling', 'sibling', 'sibling', 'sibling', 'sibling', 'sibling', null]);
    expect(b.checkFroms).toEqual(['2026-07-14', '2026-07-14', '2026-07-14', '2026-07-14', '2026-07-14', '2026-07-14', '2026-07-14', null]);
  });

  // The join key of the whole calibration design: numerator (dismissals) and denominator
  // (impressions) must be stamped by the SAME constant in the SAME model generation.
  // MUTATION TARGET: hardcode a string in either INSERT -> red here.
  it('stamps the impression with the SAME model_version constant the dismissal write records', async () => {
    const getSql = makeSql([candidates(1).map((c) => c)]);
    await handleWatchGet(ctx(getSql, { query: {} }));
    const { modelVersion } = impressionBinds(getSql.calls[1]);
    expect(modelVersion).toBe(WATCH_MODEL_VERSION);

    const postSql = makeSql([[row()], [{ id: 'd-1', plant_id: PLANT, observed_on: TODAY }]]);
    await handleDismissalPost(ctx(postSql, { body: { plant_id: PLANT } }));
    const dismissalInsert = postSql.calls[1];
    expect(dismissalInsert.text).toMatch(/INSERT INTO public\.harvest_watch_dismissal/);
    expect(dismissalInsert.params).toContain(modelVersion);
  });

  // "Never seen" must stay distinguishable from "shown" — that distinction IS the table.
  it('under the default limit only the five SERVED rows get impressions; unserved rows get none', async () => {
    const sql = makeSql([candidates(9)]);
    await handleWatchGet(ctx(sql, { query: {} })); // default limit 5
    const b = impressionBinds(sql.calls[1]);
    expect(b.plantIds).toHaveLength(5);
    expect(b.regions).toEqual(['top5', 'top5', 'top5', 'top5', 'top5']);
  });

  it('records snoozed impressions even on a day when nothing at all was served', async () => {
    const sql = makeSql([[row({ dismissed_active: true, dismissal_suppressed_until: '2026-08-20' })]]);
    const res = await handleWatchGet(ctx(sql, { query: {} }));
    expect(res.body.candidates).toEqual([]);
    const b = impressionBinds(sql.calls[1]);
    expect(b.regions).toEqual(['snoozed']);
    expect(b.slots).toEqual([null]);
  });

  // THE NON-FATALITY INVARIANT — the exact shape of the migration-lands-late window. MUTATION
  // TARGET: remove the try/catch (or move the write after the return) -> red here.
  it('a failing impression insert logs a warning and never affects the GET response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = makeSqlInsertFails([row()], 'relation "public.watch_impression" does not exist');
      const res = await handleWatchGet(ctx(sql, { query: {} }));
      expect(res.statusCode).toBe(200);
      expect(res.body.total_watching).toBe(1);
      expect(res.body.candidates).toHaveLength(1);
      expect(res.body.model_version).toBe(WATCH_MODEL_VERSION);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/GET response unaffected/);
      expect(warn.mock.calls[0][0]).toMatch(/does not exist/);
    } finally {
      warn.mockRestore();
    }
  });

  it('issues ZERO insert statements when nothing was served and nothing is snoozed', async () => {
    // habit_not_watched excludes the row without snoozing it — there is nothing to record.
    const sql = makeSql([[row({ harvest_habit: null })]]);
    const res = await handleWatchGet(ctx(sql, { query: {} }));
    expect(res.statusCode).toBe(200);
    expect(sql.calls).toHaveLength(1); // the candidate query only
  });

  it('refuses to write without an ET day rather than corrupting the day grain', async () => {
    // Belt over the classifier's own no_today suspenders: bind NULL into shown_on NOT NULL and the
    // whole batch fails; skipping is the honest zero.
    const sql = makeSql([]);
    const n = await recordWatchImpressions(sql, {
      userId: USER, shownOn: null, served: [], snoozed: [{ plant_id: PLANT }],
    });
    expect(n).toBe(0);
    expect(sql.calls).toHaveLength(0);
  });

  // Neon missing-cast class: the driver cannot type a NULL bind (or any bind in a bare SELECT
  // list), and inside a non-fatal try/catch that presents as the log silently never populating.
  // MUTATION TARGET: drop any ::cast from the INSERT -> red here.
  it('every bind in the impression INSERT carries an explicit ::cast', async () => {
    const sql = makeSql([candidates(1)]);
    await handleWatchGet(ctx(sql, { query: {} }));
    const q = sql.calls[1].text;
    expect(q).toMatch(/\?::text,/);          // user_id
    expect(q).toMatch(/\?::date,/);          // shown_on
    expect(q).toMatch(/\?::uuid\[\]/);       // plant_ids
    expect(q).toMatch(/\?::smallint\[\]/);   // slots (nullable elements)
    expect(q).toMatch(/\?::text\[\]/);       // regions / anchor_kinds (nullable elements)
    expect(q).toMatch(/\?::date\[\]/);       // check_froms (nullable elements)
    expect(q).toMatch(/ON CONFLICT \(user_id, plant_id, shown_on, region\) DO NOTHING/);
  });
});
