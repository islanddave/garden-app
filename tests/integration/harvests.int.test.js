// harvests.int.test.js — real-Postgres integration coverage for the harvests read model
// (lambda/harvests/index.js). Runs the REAL handler against an ephemeral Neon branch (SecretsManager
// + Clerk stubbed by _harness.js; the SQL layer is REAL). CI-run only (integration-test.yml) — these
// need INT_DATABASE_URL and do not execute in the local/root vitest pass.
//
// What only a real DB proves here (the pure aggregation math is exhaustively covered in
// lambda/harvests/index.test.js against synthetic rows):
//   * Household scope anchors on plant_projects.created_by via event_log.project_id (NOT NULL) — two
//     household ids see DISJOINT sets; a foreign owner's harvest is never visible. (#1 security item.)
//   * The LEFT JOIN harvest_log with the soft-delete predicate in the ON clause renders an ORPHAN
//     harvest event (no harvest_log row) instead of dropping it (M2 — built from a fixture, since
//     live prod currently has 0 orphans).
//   * Grow-year season boundary: Oct 31 vs Nov 1 bucket into adjacent seasons (design §4).
//   * (event_date,id) keyset predicate returns strictly-older rows past a cursor.
//   * Response contract shape (M5): entries[], aggregates{...}, cursor.
//   * The garden_node/cultivar/crop_types LEFT JOINs are schema-valid against the live views.
//
// Crop attribution (plant_id -> crop_type_slug) rows are left plant_id=null here (they land in the
// "Other" bucket); the crop/variety/first-pick aggregation is unit-covered. This keeps the DB fixture
// free of the plants+plant_varieties+crop_types setup while still exercising the full join chain.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js';
import { handler } from '../../lambda/harvests/index.js';

const RUN = testRunId();
const USER_A = `user_int_harv_a_${RUN}`;       // household member 1
const USER_B = `user_int_harv_b_${RUN}`;       // household member 2 (shares with A when env set)
const USER_C = `user_int_harv_foreign_${RUN}`; // foreign owner — must never be visible to A/B

let projA, projB, projC;
const ENV_KEY = 'GARDEN_HOUSEHOLD_IDS';
let savedEnv;

async function mkProject(user, tag) {
  const r = await insertProject({ name: 'int-harv-' + tag + '-' + RUN, createdBy: user });
  return r.id;
}
// Insert a harvest event; opts.quantity=null => ORPHAN (no harvest_log row).
async function mkHarvest(user, projectId, { date, type = 'harvest', quantity = null, unit = 'count', quality = null } = {}) {
  const ev = await directSql`
    INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public, logged_by, created_by)
    VALUES (${projectId}, NULL, ${type}, ${date}::timestamptz, true, ${user}, ${user}) RETURNING id`;
  const eventId = ev[0].id;
  if (quantity != null) {
    await directSql`
      INSERT INTO harvest_log (event_id, project_id, quantity, unit, quality_rating, created_by)
      VALUES (${eventId}, ${projectId}, ${quantity}::numeric, ${unit}, ${quality}, ${user})`;
  }
  return eventId;
}

beforeAll(async () => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY]; // default: single-user scope unless a test opts into household mode
  projA = await mkProject(USER_A, 'a');
  projB = await mkProject(USER_B, 'b');
  projC = await mkProject(USER_C, 'c');
});

afterAll(async () => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv;
  await directSql`DELETE FROM harvest_log WHERE created_by IN (${USER_A}, ${USER_B}, ${USER_C})`;
  await directSql`DELETE FROM event_log   WHERE created_by IN (${USER_A}, ${USER_B}, ${USER_C})`;
  await directSql`DELETE FROM plant_projects WHERE created_by IN (${USER_A}, ${USER_B}, ${USER_C})`;
});

describe('GET /api/harvests — contract shape (M5)', () => {
  it('returns entries[], aggregates{...}, cursor', async () => {
    setTestUserId(USER_A);
    delete process.env[ENV_KEY];
    await mkHarvest(USER_A, projA, { date: '2026-07-20T16:00:00Z', quantity: '2.5', unit: 'cup', quality: 4 });
    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=all' });
    expect(status).toBe(200);
    expect(body).toHaveProperty('time_zone', 'America/New_York');
    expect(body).toHaveProperty('timeframe');
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body).toHaveProperty('cursor');
    expect(body.aggregates).toBeTruthy();
    for (const k of ['crops', 'other', 'weekly', 'first_pick', 'crop_list', 'unquantified_total']) {
      expect(body.aggregates).toHaveProperty(k);
    }
    const entry = body.entries.find((e) => e.quantity != null);
    expect(entry).toMatchObject({ event_type: 'harvest', unit: 'cup', quality_rating: 4 });
    expect(entry).toHaveProperty('day_key', '2026-07-20');
    expect(Array.isArray(entry.photos)).toBe(true);
  });

  it('unknown timeframe -> 400', async () => {
    setTestUserId(USER_A);
    const { status } = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=week' });
    expect(status).toBe(400);
  });

  it('include=aggregates omits entries/cursor; include=entries omits aggregates', async () => {
    setTestUserId(USER_A);
    const aggOnly = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=all&include=aggregates' });
    expect(aggOnly.body.entries).toBeUndefined();
    expect(aggOnly.body.cursor).toBeUndefined();
    expect(aggOnly.body.aggregates).toBeTruthy();
    const entOnly = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=all&include=entries' });
    expect(entOnly.body.aggregates).toBeUndefined();
    expect(Array.isArray(entOnly.body.entries)).toBe(true);
  });
});

describe('orphan / quantity-less render (M2)', () => {
  it('a harvest event with NO harvest_log row still returns, harvest_log_id null, counted unquantified', async () => {
    setTestUserId(USER_A);
    delete process.env[ENV_KEY];
    const orphanId = await mkHarvest(USER_A, projA, { date: '2026-07-19T16:00:00Z', quantity: null });
    const { body } = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=all' });
    const row = body.entries.find((e) => e.event_id === orphanId);
    expect(row).toBeTruthy();
    expect(row.harvest_log_id).toBeNull();
    expect(row.quantity).toBeNull();
    expect(body.aggregates.unquantified_total).toBeGreaterThanOrEqual(1);
  });
});

describe('household scope — disjoint sets (#1 correctness/security item)', () => {
  it('single-user (env unset): A sees own harvests, never the foreign owner C', async () => {
    delete process.env[ENV_KEY];
    setTestUserId(USER_A);
    const cId = await mkHarvest(USER_C, projC, { date: '2026-07-18T16:00:00Z', quantity: '9', unit: 'count' });
    const { body } = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=all' });
    const ids = body.entries.map((e) => e.event_id);
    expect(ids).not.toContain(cId);
    expect(body.entries.every((e) => e.project_id === projA)).toBe(true);
  });

  it('household env {A,B}: A now sees B\'s harvest, still never C\'s', async () => {
    const bId = await mkHarvest(USER_B, projB, { date: '2026-07-17T16:00:00Z', quantity: '3', unit: 'count' });
    const cId = await mkHarvest(USER_C, projC, { date: '2026-07-16T16:00:00Z', quantity: '1', unit: 'count' });
    process.env[ENV_KEY] = `${USER_A},${USER_B}`;
    setTestUserId(USER_A);
    const { body } = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=all' });
    const ids = body.entries.map((e) => e.event_id);
    expect(ids).toContain(bId);
    expect(ids).not.toContain(cId);
    // And B, as a member, sees A's harvests too (symmetric household widening).
    setTestUserId(USER_B);
    const bView = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=all' });
    expect(bView.body.entries.some((e) => e.project_id === projA)).toBe(true);
    delete process.env[ENV_KEY];
  });

  it('a non-member who authenticates (C) never sees the household data', async () => {
    process.env[ENV_KEY] = `${USER_A},${USER_B}`;
    setTestUserId(USER_C);
    const { body } = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=all' });
    expect(body.entries.every((e) => e.project_id === projC)).toBe(true);
    delete process.env[ENV_KEY];
  });
});

describe('grow-year season boundary (Oct 31 vs Nov 1)', () => {
  it('Oct 31 falls in season:<year>; Nov 1 falls in the next season', async () => {
    delete process.env[ENV_KEY];
    setTestUserId(USER_A);
    // Noon ET (16:00Z, EDT) so the AT TIME ZONE date is unambiguous.
    const octId = await mkHarvest(USER_A, projA, { date: '2025-10-31T16:00:00Z', quantity: '1', unit: 'count' });
    const novId = await mkHarvest(USER_A, projA, { date: '2025-11-01T16:00:00Z', quantity: '1', unit: 'count' });
    const s2025 = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=season:2025&include=entries' });
    const s2026 = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=season:2026&include=entries' });
    const ids2025 = s2025.body.entries.map((e) => e.event_id);
    const ids2026 = s2026.body.entries.map((e) => e.event_id);
    expect(ids2025).toContain(octId);
    expect(ids2025).not.toContain(novId);
    expect(ids2026).toContain(novId);
    expect(ids2026).not.toContain(octId);
  });
});

describe('keyset pagination predicate', () => {
  it('passing a cursor returns strictly-older (event_date,id) rows', async () => {
    delete process.env[ENV_KEY];
    setTestUserId(USER_A);
    const full = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=all&include=entries' });
    expect(full.body.entries.length).toBeGreaterThanOrEqual(2);
    // entries are event_date DESC; take the newest as the cursor anchor.
    const top = full.body.entries[0];
    const cursor = Buffer.from(`${top.event_date}|${top.event_id}`, 'utf8').toString('base64');
    const next = await callHandler(handler, { method: 'GET', path: `/api/harvests?timeframe=all&include=entries&cursor=${encodeURIComponent(cursor)}` });
    const nextIds = next.body.entries.map((e) => e.event_id);
    expect(nextIds).not.toContain(top.event_id);
    for (const e of next.body.entries) {
      expect(new Date(e.event_date).getTime()).toBeLessThanOrEqual(new Date(top.event_date).getTime());
    }
  });
});

describe('unattributed rows -> Other bucket', () => {
  it('plant_id-null harvests aggregate into aggregates.other (never silently dropped)', async () => {
    delete process.env[ENV_KEY];
    setTestUserId(USER_A);
    const { body } = await callHandler(handler, { method: 'GET', path: '/api/harvests?timeframe=all&include=aggregates' });
    const bucket = body.aggregates.other.find((o) => o.project_id === projA);
    expect(bucket).toBeTruthy();
    // No attributed crops in this fixture (all plant_id null) -> crops list is empty, Other holds them.
    expect(body.aggregates.crops).toEqual([]);
  });
});
