// season-stats.int.test.js — real-Postgres coverage for GET /api/harvests/season-stats
// (lambda/harvests/season-stats.js over the migrations/v5-seasonstats-001 stat_* views). Runs the
// REAL handler against an ephemeral Neon branch (SecretsManager + Clerk stubbed by _harness.js; the
// SQL layer is REAL). CI-run only (integration-test.yml) — needs INT_DATABASE_URL.
//
// What only a real DB proves here (the shapers are unit-covered in lambda/harvests/
// season-stats-sections.test.js, the handler's fencing in season-stats.test.js):
//   * The views exist on the branch and every column the handler names resolves.
//   * Household scope: a foreign owner's planting, source and picks never reach the page; household
//     mode widens to the second member and still never to the foreigner.
//   * The heat clock's arithmetic end to end: transplant Jun 1, first pick Jun 25, a constant
//     80/60 F June = 20 degree-days a day, so 24 days and 480 heat units.
//   * The 86 F cap and 50 F floor in stat_weather_day.gdd50: one 95/45 F day (Jul 1) banks
//     (86+50)/2-50 = 18, not the uncapped/unfloored 20. 80/60 alone sits inside both clamps, so
//     without this day removing either clamp survived every test in the repo (QA 2026-09-29).
//   * Grow-year boundary on the ET calendar: a pick on Oct 31 ET is season 2026, Nov 1 ET is 2027.
//   * A saved-seed lot inherits its parent planting's source, contact links included.
//   * V5-SEEDSTATSPARENTS-001 (release 2a): a lot with SEVERAL parent plantings is still ONE row of
//     stat_saved_lot, with parent_count = its live seed_parent links; a parent that is linked but is not
//     the cached one counts the lot on ITS source's card too; and that second road to a planting
//     (UNION, never UNION ALL) does not double the planting's plantings, plants or pounds.
//
// Skips on a branch that lacks the views (the migration is applied to staging before the dev push
// per the rollout, and this suite forks staging) — but FAILS, not skips, on a branch whose
// schema_version carries the 5.0.0-seasonstats-001 receipt without the views: a silent skip there is
// CI going green having tested none of the 17 views.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js';
import { settle, assertFixtureId } from './_cleanup.js';
import { handler } from '../../lambda/harvests/index.js';
import { _resetSeasonStatsCache } from '../../lambda/harvests/season-stats.js';

const HAS_STATS = (await directSql`
  SELECT (to_regclass('public.stat_saved_lot') IS NOT NULL
    AND to_regclass('public.stat_heat_clock_cultivar') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'source' AND column_name = 'instagram_url')
    AND EXISTS (SELECT 1 FROM public.crop_types WHERE slug = 'tomato')) AS ok`)[0].ok;

const HAS_RECEIPT = (await directSql`
  SELECT (to_regclass('public.schema_version') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-seasonstats-001')) AS ok`)[0].ok;

// The handler's seed-lots read names stat_saved_lot.parent_count (migrations/v5-seedstatsparents-001).
// On a branch with the views and without that column every season-stats call is a 42703, so the rest
// of this file would fail for a reason none of its assertions names. One case says it instead.
const HAS_PARENT_COUNT = (await directSql`
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stat_saved_lot'
                    AND column_name = 'parent_count') AS ok`)[0].ok;

describe('season-stats schema presence', () => {
  it.runIf(HAS_RECEIPT)('the 5.0.0-seasonstats-001 receipt means the stat_* views are there', () => {
    expect(HAS_STATS).toBe(true);
  });
  it.runIf(HAS_STATS)('stat_saved_lot carries parent_count (apply migrations/v5-seedstatsparents-001/0a-replace-views.sql before the code that names it)', () => {
    expect(HAS_PARENT_COUNT, 'public.stat_saved_lot has no parent_count column on the database this suite forks').toBe(true);
  });
});

const RUN = testRunId();
const USER_A = `user_int_stats_a_${RUN}`;       // household member 1 (owns the weather space)
const USER_B = `user_int_stats_b_${RUN}`;       // household member 2
const USER_C = `user_int_stats_foreign_${RUN}`; // foreign owner — must never be visible to A/B
const USER_D = `user_int_stats_d_${RUN}`;       // a household of its own: the several-parent lot
const ENV_KEY = 'GARDEN_HOUSEHOLD_IDS';
const PATH = '/api/harvests/season-stats';

let savedEnv;
const ids = {};

// created_at is pinned inside season 2026: a planting with no sow/transplant date is dated by entry,
// and a lot by its save time, so leaving them at now() would move them to 2027 on any run after Oct 31.
async function mkPlanting(user, projectId, { name, sourceId, transplantedAt = null, varietyId }) {
  const r = await directSql`
    INSERT INTO plants (project_id, name, created_by, variety_id, quantity, source_id, source_type, transplanted_at, created_at)
    VALUES (${projectId}, ${name}, ${user}, ${varietyId}, 1, ${sourceId}, 'nursery_transplant', ${transplantedAt}::date,
            '2026-05-15T16:00:00Z')
    RETURNING id`;
  return r[0].id;
}
async function mkPick(user, projectId, plantId, date, grams) {
  const ev = await directSql`
    INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public, logged_by, created_by)
    VALUES (${projectId}, ${plantId}, 'harvest', ${date}::timestamptz, true, ${user}, ${user}) RETURNING id`;
  await directSql`
    INSERT INTO harvest_log (event_id, project_id, quantity, unit, weight_grams, weight_estimated, weight_basis, created_by)
    VALUES (${ev[0].id}, ${projectId}, 3, 'count', ${grams}::numeric, false, 'measured', ${user})`;
  return ev[0].id;
}
const IG = 'https://www.instagram.com/intstats';
const FB = 'https://www.facebook.com/intstats';
// Bound, not inlined: lambda/sql-comment-hygiene.test.js forbids a literal '//' inside a sql`` template.
async function mkSource(user, name) {
  const r = await directSql`
    INSERT INTO source (name, created_by, instagram_url, facebook_url)
    VALUES (${name}, ${user}, ${IG}, ${FB})
    RETURNING id`;
  return r[0].id;
}
const stats = async (user, query = 'season=2026') => {
  _resetSeasonStatsCache();
  setTestUserId(user);
  return callHandler(handler, { method: 'GET', path: `${PATH}?${query}` });
};
const cardFor = (body, sourceId) => body.sections.sources.series.cards.find((c) => c.source_id === sourceId);

describe.skipIf(!HAS_STATS)('GET /api/harvests/season-stats (V5-SEASONSTATS-001)', () => {
  beforeAll(async () => {
    assertFixtureId(RUN);
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];

    ids.projA = (await insertProject({ name: `int-stats-a-${RUN}`, createdBy: USER_A })).id;
    ids.projB = (await insertProject({ name: `int-stats-b-${RUN}`, createdBy: USER_B })).id;
    ids.projC = (await insertProject({ name: `int-stats-c-${RUN}`, createdBy: USER_C })).id;
    ids.cv = (await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug)
      VALUES (${`int-stats-cv-${RUN}`}, ${USER_A}, 'tomato') RETURNING id`)[0].id;
    ids.srcA = await mkSource(USER_A, `int-stats-src-a-${RUN}`);
    ids.srcB = await mkSource(USER_B, `int-stats-src-b-${RUN}`);
    ids.srcC = await mkSource(USER_C, `int-stats-src-c-${RUN}`);

    // Weather for A only: June 2026, a constant 80/60 F => 20 degree-days a day; then Jul 1 at 95/45 F,
    // which the 86 F cap and the 50 F floor turn into 18 degree-days.
    ids.space = (await directSql`
      INSERT INTO spaces (name, created_by) VALUES (${`int-stats-space-${RUN}`}, ${USER_A}) RETURNING id`)[0].id;
    await directSql`
      INSERT INTO weather_daily (space_id, date, tmax_f, tmin_f, precip_in)
      SELECT ${ids.space}::uuid, d::date, 80, 60, 0.1
        FROM generate_series('2026-06-01'::date, '2026-06-30'::date, interval '1 day') d`;
    await directSql`
      INSERT INTO weather_daily (space_id, date, tmax_f, tmin_f, precip_in)
      VALUES (${ids.space}::uuid, '2026-07-01'::date, 95, 45, 0)`;

    ids.plantA = await mkPlanting(USER_A, ids.projA, { name: `int-stats-pa-${RUN}`, sourceId: ids.srcA, transplantedAt: '2026-06-01', varietyId: ids.cv });
    ids.plantB = await mkPlanting(USER_B, ids.projB, { name: `int-stats-pb-${RUN}`, sourceId: ids.srcB, varietyId: ids.cv });
    ids.plantC = await mkPlanting(USER_C, ids.projC, { name: `int-stats-pc-${RUN}`, sourceId: ids.srcC, varietyId: ids.cv });

    // 16:00Z is noon ET: Jun 25, Oct 31 (season 2026) and Nov 1 (season 2027).
    await mkPick(USER_A, ids.projA, ids.plantA, '2026-06-25T16:00:00Z', 300);
    await mkPick(USER_A, ids.projA, ids.plantA, '2026-10-31T16:00:00Z', 150);
    await mkPick(USER_A, ids.projA, ids.plantA, '2026-11-01T16:00:00Z', 999);
    await mkPick(USER_B, ids.projB, ids.plantB, '2026-07-01T16:00:00Z', 200);
    await mkPick(USER_C, ids.projC, ids.plantC, '2026-07-01T16:00:00Z', 5000);

    await directSql`
      INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public, logged_by, created_by)
      VALUES (${ids.projA}, ${ids.plantA}, 'watering', '2026-06-02T16:00:00Z', true, ${USER_A}, ${USER_A})`;

    // A saved lot from A's planting, naming no source of its own.
    ids.lot = (await directSql`
      INSERT INTO inventory_items (user_id, created_by, type, name, category, unit, quantity_on_hand,
                                   variety_id, status, source_plant_id, seed_stage, created_at)
      VALUES (${USER_A}, ${USER_A}, 'consumable', ${`int-stats-lot-${RUN}`}, 'seeds', 'packet', 1,
              ${ids.cv}, 'active', ${ids.plantA}, 'drying', '2026-09-02T16:00:00Z')
      RETURNING id`)[0].id;
    // V5-SEEDMULTIPARENT-001: a lot's parent is a seed_lot_parent_planting row with source_plant_id as
    // its member cache. This fixture is hand-written, so it writes the row beside the column, as every
    // route does; a column with no row is the drifted state the migration's reconcile repairs.
    await directSql`
      INSERT INTO seed_lot_parent_planting (inventory_item_id, plant_id, role, created_by)
      VALUES (${ids.lot}, ${ids.plantA}, 'seed_parent', ${USER_A})`;
  });

  beforeEach(() => { delete process.env[ENV_KEY]; });

  afterAll(async () => {
    if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv;
    const users = [USER_A, USER_B, USER_C, USER_D];
    await settle('season-stats.int', [
      // Both foreign keys on a parent link are ON DELETE RESTRICT: it goes before its lot and its planting.
      () => directSql`DELETE FROM seed_lot_parent_planting WHERE created_by = ANY(${users}::text[])`,
      () => directSql`DELETE FROM inventory_items WHERE created_by = ANY(${users}::text[])`,
      () => directSql`DELETE FROM harvest_log WHERE created_by = ANY(${users}::text[])`,
      () => directSql`DELETE FROM event_log WHERE created_by = ANY(${users}::text[])`,
      // A plants INSERT also writes an `entity` row (entity_planting_ref_id_fkey), and a plant_varieties
      // INSERT one of its own (entity_cultivar_ref_id_fkey); both are RESTRICT, so each goes before its
      // parent. The plantings name their cultivar, source and project, so they go before all three.
      () => directSql`DELETE FROM entity WHERE planting_ref_id IN (SELECT id FROM plants WHERE created_by = ANY(${users}::text[]))`,
      () => directSql`DELETE FROM plants WHERE created_by = ANY(${users}::text[])`,
      () => directSql`DELETE FROM entity WHERE cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ANY(${users}::text[]))`,
      () => directSql`DELETE FROM plant_varieties WHERE created_by = ANY(${users}::text[])`,
      // weather_daily goes with its space (ON DELETE CASCADE).
      () => directSql`DELETE FROM spaces WHERE created_by = ANY(${users}::text[])`,
      // public.source carries trg_audit_source_del, so bind the audit actor the way lambda/varieties does.
      () => directSql.transaction([
        directSql`SELECT set_config('app.actor_clerk_sub', ${USER_A}, true)`,
        directSql`DELETE FROM source WHERE created_by = ANY(${users}::text[])`,
      ]),
      () => directSql`DELETE FROM plant_projects WHERE created_by = ANY(${users}::text[])`,
    ]);
  });

  it('returns the v1 envelope with all eight sections', async () => {
    const { status, body } = await stats(USER_A);
    expect(status).toBe(200);
    expect(body.version).toBe(1);
    expect(body.season).toEqual({ year: 2026, start: '2025-11-01', end: '2026-10-31' });
    expect(Object.keys(body.sections)).toEqual([
      'ribbon', 'sources', 'heat_clock', 'heat_ladder', 'tomato_keep', 'longest', 'sep_size', 'seed_lots',
    ]);
  });

  it('single-user: A sees its own source card, never B\'s or the foreign owner\'s', async () => {
    const { body } = await stats(USER_A);
    const a = cardFor(body, ids.srcA);
    expect(a).toMatchObject({ plantings: 1, plants: 1, picked: 1, lost: 0, saved_lots: 1 });
    // Jun 25 + Oct 31 = 450 g; the Nov 1 pick belongs to season 2027.
    expect(a.lb).toBeCloseTo(450 / 453.592, 1);
    expect(cardFor(body, ids.srcB)).toBeUndefined();
    expect(cardFor(body, ids.srcC)).toBeUndefined();
    expect(body.sections.sources.meta.total_lb).toBeCloseTo(450 / 453.592, 1);
  });

  it('household {A,B}: A now sees B\'s card, still never C\'s', async () => {
    process.env[ENV_KEY] = `${USER_A},${USER_B}`;
    const { body } = await stats(USER_A);
    expect(cardFor(body, ids.srcB)).toMatchObject({ plantings: 1, picked: 1 });
    expect(cardFor(body, ids.srcC)).toBeUndefined();
  });

  it('a non-member of the household sees only its own rows even with the env set', async () => {
    process.env[ENV_KEY] = `${USER_A},${USER_B}`;
    const { body } = await stats(USER_C);
    expect(cardFor(body, ids.srcC)).toMatchObject({ plantings: 1 });
    expect(cardFor(body, ids.srcA)).toBeUndefined();
    expect(body.sections.ribbon.series.days).toEqual([]);
  });

  it('heat clock: transplant Jun 1 -> first pick Jun 25 = 24 days, 480 heat units', async () => {
    const { body } = await stats(USER_A);
    const hc = body.sections.heat_clock;
    expect(hc.meta.origin_date).toBe('2026-06-01');
    const row = hc.series.by_cultivar.find((r) => r.planting_id === ids.plantA);
    expect(row).toMatchObject({ crop_slug: 'tomato', transplanted_at: '2026-06-01', first_pick: '2026-06-25', days: 24, heat_units: 480 });
    expect(hc.meta.median_heat.tomato).toBe(480);
    expect(hc.series.by_crop.find((r) => r.crop_slug === 'tomato')).toMatchObject({ first_pick: '2026-06-25', heat_units: 480 });
  });

  it('ribbon: 31 weather days, the watering day carries water, care counted in days', async () => {
    const { body } = await stats(USER_A);
    const r = body.sections.ribbon;
    expect(r.series.days).toHaveLength(31);
    expect(r.series.days.find((d) => d.date === '2026-06-02').care).toEqual(['water']);
    expect(r.meta.care_day_totals.water).toBe(1);
    expect(r.meta.pins.first_setout).toBe('2026-06-01');
    expect(r.series.weeks.reduce((s, w) => s + w.tomato_fruit, 0)).toBe(3);
  });

  it('heat units cap at 86 F and floor at 50 F: a 95/45 day banks 18, not 20', async () => {
    const day = await directSql`
      SELECT gdd50 FROM public.stat_weather_day WHERE owner = ${USER_A} AND day = '2026-07-01'::date`;
    expect(day).toEqual([{ gdd50: 18 }]);
    // Week of Mon Jun 29: Jun 29 + Jun 30 at 20 each, Jul 1 at 18. No cap -> 63, no floor -> 56, neither -> 60.
    const { body } = await stats(USER_A);
    const wk = body.sections.ribbon.series.weeks.find((w) => w.week_start === '2026-06-29');
    expect(wk.heat_units).toBe(58);
  });

  it('grow-year boundary: Oct 31 ET is season 2026, Nov 1 ET is 2027', async () => {
    const byYear = await directSql`
      SELECT grow_year, count(*)::int AS n FROM public.stat_pick
       WHERE planting_id = ${ids.plantA} GROUP BY grow_year ORDER BY grow_year`;
    expect(byYear).toEqual([{ grow_year: 2026, n: 2 }, { grow_year: 2027, n: 1 }]);
  });

  it('a saved lot inherits the parent planting\'s source, contact links included', async () => {
    const { body } = await stats(USER_A, 'season=2026&sections=seed_lots');
    expect(Object.keys(body.sections)).toEqual(['seed_lots']);
    const lot = body.sections.seed_lots.series.rows.find((r) => r.lot_id === ids.lot);
    expect(lot.parent).toMatchObject({ planting_id: ids.plantA });
    expect(lot.source).toMatchObject({ id: ids.srcA, instagram_url: IG, facebook_url: FB });
  });

  it('unknown section -> 400; POST -> 405', async () => {
    expect((await stats(USER_A, 'sections=nope')).status).toBe(400);
    setTestUserId(USER_A);
    expect((await callHandler(handler, { method: 'POST', path: PATH })).status).toBe(405);
  });

  // ── V5-SEEDSTATSPARENTS-001 ─────────────────────────────────────────────────────────────────────
  // One lot, saved by USER_D, from three of D's plantings bought from three different places:
  //   parentA  the CACHE (inventory_items.source_plant_id) and a live link     from source dA
  //   parentB  a live link ONLY                                                from source dB
  //   parentR  a RETIRED link (a parent that was taken off the lot)            from source dR
  // plus a pollen_parent row on parentR, which is not a seed parent at all. Hand-written rows, as the
  // fixture above: the stat views read tables, and the states are exactly the ones the routes leave.
  describe.skipIf(!HAS_PARENT_COUNT)('a lot with several parent plantings (V5-SEEDSTATSPARENTS-001)', () => {
    const d = {};

    beforeAll(async () => {
      d.proj = (await insertProject({ name: `int-stats-d-${RUN}`, createdBy: USER_D })).id;
      for (const k of ['A', 'B', 'R']) {
        // eslint-disable-next-line no-await-in-loop
        d[`src${k}`] = await mkSource(USER_D, `int-stats-src-d${k}-${RUN}`);
        // eslint-disable-next-line no-await-in-loop
        d[`parent${k}`] = await mkPlanting(USER_D, d.proj, {
          name: `int-stats-pd${k}-${RUN}`, sourceId: d[`src${k}`], varietyId: ids.cv,
        });
      }
      await mkPick(USER_D, d.proj, d.parentA, '2026-07-10T16:00:00Z', 400);
      await mkPick(USER_D, d.proj, d.parentB, '2026-07-11T16:00:00Z', 100);
      d.lot = (await directSql`
        INSERT INTO inventory_items (user_id, created_by, type, name, category, unit, quantity_on_hand,
                                     variety_id, status, source_plant_id, seed_stage, created_at)
        VALUES (${USER_D}, ${USER_D}, 'consumable', ${`int-stats-lot-d-${RUN}`}, 'seeds', 'packet', 1,
                ${ids.cv}, 'active', ${d.parentA}, 'drying', '2026-09-03T16:00:00Z')
        RETURNING id`)[0].id;
      await directSql`
        INSERT INTO seed_lot_parent_planting (inventory_item_id, plant_id, role, created_by, deleted_at)
        VALUES (${d.lot}, ${d.parentA}, 'seed_parent', ${USER_D}, NULL),
               (${d.lot}, ${d.parentB}, 'seed_parent', ${USER_D}, NULL),
               (${d.lot}, ${d.parentR}, 'seed_parent', ${USER_D}, now()),
               (${d.lot}, ${d.parentR}, 'pollen_parent', ${USER_D}, NULL)`;
    });

    it('the lot is ONE row of stat_saved_lot and of the seed-lots section, with parent_count 2 (the retired link and the pollen row do not count)', async () => {
      const view = await directSql`
        SELECT lot_id, parent_count FROM public.stat_saved_lot WHERE lot_id = ${d.lot}`;
      expect(view).toEqual([{ lot_id: d.lot, parent_count: 2 }]);

      const { status, body } = await stats(USER_D, 'season=2026&sections=seed_lots');
      expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
      const rows = body.sections.seed_lots.series.rows.filter((r) => r.lot_id === d.lot);
      expect(rows, 'a lot must not be returned once per parent').toHaveLength(1);
      expect(rows[0].parent_count).toBe(2);
      // The row's own parent and source are still the CACHED planting's.
      expect(rows[0].parent).toMatchObject({ planting_id: d.parentA });
      expect(rows[0].source).toMatchObject({ id: d.srcA });
      // The one-parent lot above reads 1, through the same column.
      const a = await stats(USER_A, 'season=2026&sections=seed_lots');
      expect(a.body.sections.seed_lots.series.rows.find((r) => r.lot_id === ids.lot).parent_count).toBe(1);
    });

    it('the linked-only parent\'s source card counts the lot too; the retired parent\'s does not', async () => {
      const { body } = await stats(USER_D);
      expect(cardFor(body, d.srcA).saved_lots).toBe(1);
      expect(cardFor(body, d.srcB).saved_lots).toBe(1);
      expect(cardFor(body, d.srcR).saved_lots).toBe(0);
    });

    it('and nothing doubles: the cached parent is reached by BOTH roads (the column and its link row) and its card still reads one planting, one plant, its own pounds', async () => {
      const { body } = await stats(USER_D);
      const a = cardFor(body, d.srcA);
      expect(a).toMatchObject({ plantings: 1, plants: 1, picked: 1, lost: 0, saved_lots: 1 });
      expect(a.lb).toBeCloseTo(400 / 453.592, 1);
      const b = cardFor(body, d.srcB);
      expect(b).toMatchObject({ plantings: 1, plants: 1, picked: 1, lost: 0, saved_lots: 1 });
      expect(b.lb).toBeCloseTo(100 / 453.592, 1);
      expect(cardFor(body, d.srcR)).toMatchObject({ plantings: 1, plants: 1, picked: 0, saved_lots: 0 });
      expect(body.sections.sources.meta.total_lb).toBeCloseTo(500 / 453.592, 1);
      // Read off the view too, so a shaper that summed twice could not hide a doubled row.
      const cards = await directSql`
        SELECT source_id, plantings::int AS plantings, plants::int AS plants, saved_lots::int AS saved_lots
          FROM public.stat_source_card
         WHERE source_id = ANY(${[d.srcA, d.srcB, d.srcR]}::uuid[]) ORDER BY source_id`;
      expect(cards).toHaveLength(3);
      expect(cards.reduce((s, c) => s + c.plantings, 0)).toBe(3);
      expect(cards.reduce((s, c) => s + c.plants, 0)).toBe(3);
      expect(cards.reduce((s, c) => s + c.saved_lots, 0)).toBe(2);
    });

    it('another household sees none of it', async () => {
      const { body } = await stats(USER_A);
      expect(cardFor(body, d.srcB)).toBeUndefined();
      expect(body.sections.seed_lots?.series.rows.find((r) => r.lot_id === d.lot)).toBeUndefined();
    });
  });
});
