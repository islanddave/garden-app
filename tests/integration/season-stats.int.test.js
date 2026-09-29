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
//   * Grow-year boundary on the ET calendar: a pick on Oct 31 ET is season 2026, Nov 1 ET is 2027.
//   * A saved-seed lot inherits its parent planting's source, contact links included.
//
// Skips cleanly on a branch that lacks the views (the migration is applied to staging before the
// dev push per the rollout, and this suite forks staging).
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

const RUN = testRunId();
const USER_A = `user_int_stats_a_${RUN}`;       // household member 1 (owns the weather space)
const USER_B = `user_int_stats_b_${RUN}`;       // household member 2
const USER_C = `user_int_stats_foreign_${RUN}`; // foreign owner — must never be visible to A/B
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

    // Weather for A only: June 2026, a constant 80/60 F => 20 degree-days a day.
    ids.space = (await directSql`
      INSERT INTO spaces (name, created_by) VALUES (${`int-stats-space-${RUN}`}, ${USER_A}) RETURNING id`)[0].id;
    await directSql`
      INSERT INTO weather_daily (space_id, date, tmax_f, tmin_f, precip_in)
      SELECT ${ids.space}::uuid, d::date, 80, 60, 0.1
        FROM generate_series('2026-06-01'::date, '2026-06-30'::date, interval '1 day') d`;

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
  });

  beforeEach(() => { delete process.env[ENV_KEY]; });

  afterAll(async () => {
    if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv;
    const users = [USER_A, USER_B, USER_C];
    await settle('season-stats.int', [
      () => directSql`DELETE FROM inventory_items WHERE created_by = ANY(${users}::text[])`,
      () => directSql`DELETE FROM harvest_log WHERE created_by = ANY(${users}::text[])`,
      () => directSql`DELETE FROM event_log WHERE created_by = ANY(${users}::text[])`,
      () => directSql`DELETE FROM plants WHERE created_by = ANY(${users}::text[])`,
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

  it('ribbon: 30 weather days, the watering day carries water, care counted in days', async () => {
    const { body } = await stats(USER_A);
    const r = body.sections.ribbon;
    expect(r.series.days).toHaveLength(30);
    expect(r.series.days.find((d) => d.date === '2026-06-02').care).toEqual(['water']);
    expect(r.meta.care_day_totals.water).toBe(1);
    expect(r.meta.pins.first_setout).toBe('2026-06-01');
    expect(r.series.weeks.reduce((s, w) => s + w.tomato_fruit, 0)).toBe(3);
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
});
