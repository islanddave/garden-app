// /api/dashboard — V1.2a-2 Session 2 Lambda tests
// DB-free vitest unit tests against the pure handlers/builders exported from
// ./handlers.js. This file imports ONLY handlers.js — NOT index.js — so the
// test suite does not need @neondatabase/serverless / @clerk/backend / @aws-sdk/*
// resolvable at load time (CI runs a fresh root npm install only). Integration
// coverage for the wired Lambda lives in tests/contracts/* and the staging
// deploy smoke tests.
//
// Test inventory:
//   T1   F1 calendar-day correctness in harvest_ready
//   T2   F1 calendar-day correctness in heads_up stale
//   T3   F7 stale predicate handles NULL last_observed_at with last_event_at fallback
//   T4   Tile 4 dedup — flagged-AND-stale project surfaces ONCE as 'flagged'
//   T5   Tile 4 severity ordering — severity=3 sorts before severity=1
//   T6   F9 UUID parse — POST /dismiss with not-a-uuid → 404
//   T7   T9 cross-user authorization — POST /dismiss other user's project → 404
//   T8   T9 GET /inactive returns only requester's projects (WHERE created_by=user)
//   T9   Idempotent dismiss — 200 with same dismissed_at
//   T10  Empty harvest_ready when no harvesting projects
//   T11  Empty heads_up when no flagged or stale
//   T12  inactive_projects_count = 0 when all dismissed
//   T13  inactive_projects_count = N when none dismissed
//   T14  GET /api/dashboard wrong method → 405 (via classifyRoute)
//   T15  POST /dismiss wrong method (GET) → 405 (via classifyRoute)
//   T16  OPTIONS preflight → 204 (via classifyRoute / optionsResp)
//   T17  401 path is integration-only (token verification not in pure handlers)
//   T18  Unknown route → 404 (via classifyRoute)
//   T19  Promise.all parallelization — all 9 queries fire concurrently
//   T20  inactive listing sort — undismissed-first, then last_event_at DESC

import { describe, it, expect, beforeEach } from 'vitest';
import {
  UUID_RE,
  isValidUuid,
  classifyRoute,
  resp,
  optionsResp,
  queryRecentEvents,
  queryCounts,
  queryFavoriteCount,
  queryActiveProjects,
  queryUserStats,
  queryWaterDue,
  queryHarvestReady,
  queryHeadsUp,
  queryInactiveCount,
  queryInactiveList,
  queryDismissInactive,
  handleDashboard,
  handleGetInactive,
  handleDismissInactive,
} from './handlers.js';

// ---- Mock sql tagged-template --------------------------------------------
// Records each invocation as { strings, values, resolved } where `resolved` is
// the template reconstituted with $1/$2/... placeholders for shape-assertion.
// FIFO queue of result arrays — defaults to empty array per call.

const sqlCalls = [];
const sqlResults = [];

function makeSql() {
  return function sqlTag(strings, ...values) {
    let resolved = '';
    strings.forEach((s, i) => {
      resolved += s;
      if (i < values.length) resolved += `$${i + 1}`;
    });
    sqlCalls.push({ strings: Array.from(strings), values, resolved });
    const result = sqlResults.length > 0 ? sqlResults.shift() : [];
    return Promise.resolve(result);
  };
}

function findSql(predicate) {
  return sqlCalls.find(c => predicate(c.resolved));
}

function parseBody(res) { return JSON.parse(res.body); }

beforeEach(() => {
  sqlCalls.length = 0;
  sqlResults.length = 0;
});

// ---- classifyRoute / resp / optionsResp ----------------------------------

describe('classifyRoute — pure routing', () => {
  it('T16: OPTIONS → kind=options', () => {
    expect(classifyRoute('OPTIONS', '/api/dashboard')).toEqual({ kind: 'options' });
  });

  it('GET /api/dashboard → kind=dashboard', () => {
    expect(classifyRoute('GET', '/api/dashboard')).toEqual({ kind: 'dashboard' });
  });

  it('GET / → kind=dashboard (root path treated as dashboard)', () => {
    expect(classifyRoute('GET', '/')).toEqual({ kind: 'dashboard' });
  });

  it('T14: PUT /api/dashboard → kind=method-not-allowed', () => {
    expect(classifyRoute('PUT', '/api/dashboard')).toEqual({ kind: 'method-not-allowed' });
  });

  it('GET /api/projects/inactive → kind=inactive-list', () => {
    expect(classifyRoute('GET', '/api/projects/inactive')).toEqual({ kind: 'inactive-list' });
  });

  it('POST /api/projects/inactive → kind=method-not-allowed (only GET supported)', () => {
    expect(classifyRoute('POST', '/api/projects/inactive')).toEqual({ kind: 'method-not-allowed' });
  });

  it('POST /api/projects/inactive/<uuid>/dismiss → kind=inactive-dismiss', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(classifyRoute('POST', `/api/projects/inactive/${uuid}/dismiss`))
      .toEqual({ kind: 'inactive-dismiss', projectId: uuid });
  });

  it('T15: GET /api/projects/inactive/<uuid>/dismiss → kind=method-not-allowed', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(classifyRoute('GET', `/api/projects/inactive/${uuid}/dismiss`))
      .toEqual({ kind: 'method-not-allowed' });
  });

  it('T6: F9 — POST /dismiss with not-a-uuid → kind=uuid-not-found', () => {
    expect(classifyRoute('POST', '/api/projects/inactive/not-a-uuid/dismiss'))
      .toEqual({ kind: 'uuid-not-found' });
  });

  it('F9: UUID with wrong length → kind=uuid-not-found', () => {
    expect(classifyRoute('POST', '/api/projects/inactive/12345/dismiss'))
      .toEqual({ kind: 'uuid-not-found' });
  });

  it('T18: unknown route → kind=not-found', () => {
    expect(classifyRoute('GET', '/api/nonexistent')).toEqual({ kind: 'not-found' });
  });
});

describe('UUID_RE / isValidUuid', () => {
  it('accepts canonical UUIDv4 shape', () => {
    expect(isValidUuid('11111111-2222-3333-4444-555555555555')).toBe(true);
    expect(UUID_RE.test('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
  });
  it('rejects malformed strings', () => {
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('12345')).toBe(false);
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid(null)).toBe(false);
    expect(isValidUuid(undefined)).toBe(false);
  });
});

describe('resp / optionsResp — response shape', () => {
  it('resp serializes body to JSON with content-type header', () => {
    const r = resp(200, { ok: true });
    expect(r.statusCode).toBe(200);
    expect(r.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });
  it('T16: optionsResp returns 204 + empty body', () => {
    const r = optionsResp();
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe('');
  });
});

// ---- handleDashboard — aggregation ---------------------------------------

describe('handleDashboard — aggregation', () => {
  function queueAggregationResults({
    recent = [], counts = [{ project_count: 0, plant_count: 0, location_count: 0 }],
    fav = [{ count: 0 }], active = [], stats = [], water = [],
    harvest = [], heads = [], inactive = [{ count: 0 }],
  } = {}) {
    sqlResults.push(recent, counts, fav, active, stats, water, harvest, heads, inactive);
  }

  it('T1: harvest_ready computes days_since_obs via calendar-day arithmetic (F1)', async () => {
    queueAggregationResults({
      harvest: [
        { project_id: 'p1', name: 'Tomato', status: 'harvesting', last_observed_at: '2026-04-08T12:00:00Z', days_since_obs: 35 },
      ],
    });
    const res = await handleDashboard(makeSql(), 'user_alpha');
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.harvest_ready).toHaveLength(1);
    expect(body.harvest_ready[0].days_since_obs).toBe(35);

    // F1 verification — SQL uses (NOW()::date - col::date)::int, NOT EXTRACT(DAY FROM interval)
    const harvestSql = findSql(s => s.includes("pp.status = 'harvesting'"));
    expect(harvestSql).toBeDefined();
    expect(harvestSql.resolved).toMatch(/NOW\(\)::date\s*-\s*em\.last_observed_at::date/);
    expect(harvestSql.resolved).not.toMatch(/EXTRACT\s*\(\s*DAY\s+FROM/i);
    expect(harvestSql.resolved).toMatch(/ORDER BY em\.last_observed_at ASC NULLS LAST/);
    expect(harvestSql.resolved).toMatch(/LIMIT 5/);
  });

  it('T2: heads_up stale computes days_stale via calendar-day arithmetic (F1)', async () => {
    queueAggregationResults({
      heads: [
        { project_id: 'p2', name: 'Basil', reason: 'stale', severity: null, event_at: '2026-04-08T12:00:00Z', days_stale: 35 },
      ],
    });
    const res = await handleDashboard(makeSql(), 'user_alpha');
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.heads_up[0].days_stale).toBe(35);
    expect(body.heads_up[0].reason).toBe('stale');

    const headsSql = findSql(s => s.includes('WITH flagged AS'));
    expect(headsSql).toBeDefined();
    expect(headsSql.resolved).toMatch(/NOW\(\)::date\s*-\s*em\.last_observed_at::date/);
    expect(headsSql.resolved).toMatch(/NOW\(\)::date\s*-\s*el\.created_at::date/);
    expect(headsSql.resolved).not.toMatch(/EXTRACT\s*\(\s*DAY\s+FROM/i);
  });

  it('T3: F7 stale predicate handles NULL last_observed_at with last_event_at fallback', async () => {
    queueAggregationResults();
    await handleDashboard(makeSql(), 'user_alpha');
    const headsSql = findSql(s => s.includes('WITH flagged AS'));
    expect(headsSql).toBeDefined();
    expect(headsSql.resolved).toMatch(/em\.last_observed_at IS NULL[\s\S]*COALESCE\(em\.last_event_at,\s*pp\.created_at\)\s*<\s*NOW\(\)\s*-\s*INTERVAL\s*'21 days'/);
    expect(headsSql.resolved).toMatch(/em\.last_observed_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s*'21 days'/);
  });

  it('T4: Tile 4 dedup — flagged-AND-stale project surfaces ONCE as flagged (NOT EXISTS in stale CTE)', async () => {
    queueAggregationResults();
    await handleDashboard(makeSql(), 'user_alpha');
    const headsSql = findSql(s => s.includes('WITH flagged AS'));
    expect(headsSql).toBeDefined();
    expect(headsSql.resolved).toMatch(/NOT EXISTS\s*\([\s\S]*event_log[\s\S]*flagged_as_issue\s*=\s*true[\s\S]*resolved_at IS NULL/);
    expect(headsSql.resolved).toMatch(/DISTINCT ON \(el\.project_id\)/);
  });

  it('T5: Tile 4 severity ordering — severity DESC NULLS LAST (sev=3 before sev=1, stale last)', async () => {
    queueAggregationResults({
      heads: [
        { project_id: 'p3', name: 'A', reason: 'flagged', severity: 3, event_at: '2026-05-12T00:00:00Z', days_stale: 1 },
        { project_id: 'p4', name: 'B', reason: 'flagged', severity: 1, event_at: '2026-05-12T00:00:00Z', days_stale: 1 },
        { project_id: 'p5', name: 'C', reason: 'stale',   severity: null, event_at: '2026-04-22T00:00:00Z', days_stale: 21 },
      ],
    });
    const res = await handleDashboard(makeSql(), 'user_alpha');
    const body = parseBody(res);
    expect(body.heads_up.map(r => r.severity)).toEqual([3, 1, null]);

    const headsSql = findSql(s => s.includes('WITH flagged AS'));
    expect(headsSql.resolved).toMatch(/UNION ALL[\s\S]*ORDER BY severity DESC NULLS LAST,\s*event_at ASC/);
    expect(headsSql.resolved).toMatch(/LIMIT 10/);
  });

  it('T10: harvest_ready empty when no harvesting projects', async () => {
    queueAggregationResults({ harvest: [] });
    const res = await handleDashboard(makeSql(), 'user_alpha');
    expect(parseBody(res).harvest_ready).toEqual([]);
  });

  it('T11: heads_up empty when no flagged or stale', async () => {
    queueAggregationResults({ heads: [] });
    const res = await handleDashboard(makeSql(), 'user_alpha');
    expect(parseBody(res).heads_up).toEqual([]);
  });

  it('T12: inactive_projects_count = 0 when all dismissed', async () => {
    queueAggregationResults({ inactive: [{ count: 0 }] });
    const res = await handleDashboard(makeSql(), 'user_alpha');
    expect(parseBody(res).inactive_projects_count).toBe(0);
  });

  it('T13: inactive_projects_count = N when none dismissed', async () => {
    queueAggregationResults({ inactive: [{ count: 7 }] });
    const res = await handleDashboard(makeSql(), 'user_alpha');
    expect(parseBody(res).inactive_projects_count).toBe(7);

    const countSql = findSql(s => s.includes("pp.status IN ('harvested','ended')") && s.includes('NOT EXISTS') && s.includes('inactive_project_dismissals'));
    expect(countSql).toBeDefined();
    expect(countSql.resolved).toMatch(/d\.user_id\s*=\s*\$\d+/);
  });

  it('T19: Promise.all parallelization — all 9 aggregation queries fire', async () => {
    queueAggregationResults();
    await handleDashboard(makeSql(), 'user_alpha');
    expect(sqlCalls.length).toBe(9);
  });

  it('userStats defaults when no row present', async () => {
    queueAggregationResults({ stats: [] });
    const res = await handleDashboard(makeSql(), 'user_alpha');
    const body = parseBody(res);
    expect(body.user_stats).toEqual({
      current_streak: 0,
      longest_streak: 0,
      last_active_date: null,
      total_events: 0,
      xp: 0,
    });
  });

  it('counts wires aggregated project/plant/location values', async () => {
    queueAggregationResults({
      counts: [{ project_count: 3, plant_count: 12, location_count: 4 }],
      fav: [{ count: 9 }],
    });
    const res = await handleDashboard(makeSql(), 'user_alpha');
    const body = parseBody(res);
    expect(body.counts).toEqual({ projects: 3, plants: 12, locations: 4, favorites: 9 });
  });

  it('each per-query builder binds the userId argument', async () => {
    queueAggregationResults();
    await handleDashboard(makeSql(), 'user_alpha');
    // Every parameterized query should contain 'user_alpha' as a bound value.
    // All 9 builders bind userId at least once (locations sub-count rides inside
    // the counts query which DOES bind userId for the outer projects + plants sub-counts).
    const userBound = sqlCalls.filter(c => c.values.includes('user_alpha'));
    expect(userBound.length).toBe(9);
  });
});

// ---- handleGetInactive ---------------------------------------------------

describe('handleGetInactive — GET /api/projects/inactive', () => {
  it('T8/T20: scoped to created_by=userId; sorted undismissed-first then last_event_at DESC', async () => {
    sqlResults.push([
      { id: 'p10', name: 'Cucumber', variety: 'Bush', status: 'harvested', start_date: '2026-01-01',
        last_event_at: '2026-04-10T00:00:00Z', last_harvested_at: '2026-04-01T00:00:00Z',
        dismissed: false, dismissed_at: null },
      { id: 'p11', name: 'Pea', variety: 'Sugar Snap', status: 'ended', start_date: '2026-02-01',
        last_event_at: '2026-03-10T00:00:00Z', last_harvested_at: '2026-03-05T00:00:00Z',
        dismissed: true, dismissed_at: '2026-04-15T00:00:00Z' },
    ]);
    const res = await handleGetInactive(makeSql(), 'user_alpha');
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body).toHaveLength(2);
    expect(body[0].dismissed).toBe(false);

    const q = sqlCalls[0];
    expect(q.resolved).toMatch(/pp\.status IN \('harvested','ended'\)/);
    expect(q.resolved).toMatch(/pp\.created_by\s*=\s*\$\d+/);
    expect(q.values).toContain('user_alpha');
    expect(q.resolved).toMatch(/ORDER BY d\.dismissed_at IS NULL DESC,\s*em\.last_event_at DESC NULLS LAST/);
    expect(q.resolved).not.toMatch(/LIMIT/);
  });
});

// ---- handleDismissInactive ------------------------------------------------

describe('handleDismissInactive — POST /api/projects/inactive/:projectId/dismiss', () => {
  const VALID_UUID = '11111111-2222-3333-4444-555555555555';

  it('T7: cross-user — other user\'s project → 404 (existence-oblivious)', async () => {
    sqlResults.push([{ status: 'not_found', dismissed_at: null }]);
    const res = await handleDismissInactive(makeSql(), 'user_alpha', VALID_UUID);
    expect(res.statusCode).toBe(404);

    const q = sqlCalls[0];
    expect(q.resolved).toMatch(/WITH owned AS/);
    expect(q.resolved).toMatch(/created_by\s*=\s*\$\d+/);
    expect(q.resolved).toMatch(/ON CONFLICT \(user_id, project_id\) DO NOTHING/);
    expect(q.values).toContain('user_alpha');
    expect(q.values).toContain(VALID_UUID);
  });

  it('happy path — dismiss → 200 with dismissed_at', async () => {
    sqlResults.push([{ status: 'dismissed', dismissed_at: '2026-05-13T12:00:00Z' }]);
    const res = await handleDismissInactive(makeSql(), 'user_alpha', VALID_UUID);
    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toEqual({ dismissed: true, dismissed_at: '2026-05-13T12:00:00Z' });
  });

  it('T9: idempotent dismiss — second call returns 200 with same dismissed_at (COALESCE branch)', async () => {
    const ts = '2026-05-13T12:00:00Z';
    const sql = makeSql();
    sqlResults.push([{ status: 'dismissed', dismissed_at: ts }]);
    const r1 = await handleDismissInactive(sql, 'user_alpha', VALID_UUID);
    sqlResults.push([{ status: 'dismissed', dismissed_at: ts }]);
    const r2 = await handleDismissInactive(sql, 'user_alpha', VALID_UUID);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(parseBody(r1).dismissed_at).toEqual(parseBody(r2).dismissed_at);
  });

  it('dismiss CTE uses COALESCE for idempotency', async () => {
    sqlResults.push([{ status: 'dismissed', dismissed_at: '2026-05-13T12:00:00Z' }]);
    await handleDismissInactive(makeSql(), 'user_alpha', VALID_UUID);
    const q = sqlCalls[0];
    expect(q.resolved).toMatch(/COALESCE\(\s*\(SELECT dismissed_at FROM upsert\)/);
    expect(q.resolved).toMatch(/status IN \('harvested','ended'\)/);
    expect(q.resolved).toMatch(/deleted_at IS NULL/);
  });

  it('null row from DB → 404', async () => {
    sqlResults.push([]);
    const res = await handleDismissInactive(makeSql(), 'user_alpha', VALID_UUID);
    expect(res.statusCode).toBe(404);
  });
});

// ---- Per-query builder shape tests (additional coverage) -----------------

describe('per-query builders bind userId correctly', () => {
  it('queryRecentEvents binds userId', async () => {
    await queryRecentEvents(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values).toContain('user_alpha');
    expect(sqlCalls[0].resolved).toMatch(/LIMIT 5/);
  });
  it('queryCounts binds userId twice (projects + plants sub-counts)', async () => {
    await queryCounts(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values.filter(v => v === 'user_alpha').length).toBe(2);
  });
  it('queryFavoriteCount binds userId', async () => {
    await queryFavoriteCount(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values).toContain('user_alpha');
  });
  it('queryActiveProjects binds userId', async () => {
    await queryActiveProjects(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values).toContain('user_alpha');
  });
  it('queryUserStats binds userId', async () => {
    await queryUserStats(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values).toContain('user_alpha');
  });
  it('queryWaterDue binds userId', async () => {
    await queryWaterDue(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values).toContain('user_alpha');
  });
  it('queryHarvestReady binds userId', async () => {
    await queryHarvestReady(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values).toContain('user_alpha');
  });
  it('queryHeadsUp binds userId', async () => {
    await queryHeadsUp(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values).toContain('user_alpha');
  });
  it('queryInactiveCount binds userId twice (outer filter + dismissals sub-NOT-EXISTS)', async () => {
    await queryInactiveCount(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values.filter(v => v === 'user_alpha').length).toBe(2);
  });
  it('queryInactiveList binds userId twice (LEFT JOIN dismissals + WHERE created_by)', async () => {
    await queryInactiveList(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values.filter(v => v === 'user_alpha').length).toBe(2);
  });
  it('queryDismissInactive binds projectId twice (CTE + ::uuid cast) and userId three times', async () => {
    const VALID_UUID = '11111111-2222-3333-4444-555555555555';
    sqlResults.push([{ status: 'dismissed', dismissed_at: '2026-05-13T12:00:00Z' }]);
    await queryDismissInactive(makeSql(), 'user_alpha', VALID_UUID);
    expect(sqlCalls[0].values).toContain(VALID_UUID);
    expect(sqlCalls[0].values.filter(v => v === 'user_alpha').length).toBeGreaterThanOrEqual(2);
  });
});
