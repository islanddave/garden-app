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
  collapseBatches,
  FEED_CAP,
  queryCounts,
  queryFavoriteCount,
  queryActiveProjects,
  queryUserStats,
  queryWaterDue,
  queryWaterDueFromPlan,
  queryHarvestReady,
  queryHeadsUp,
  queryInactiveCount,
  queryGiveAttention,
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

// HOUSEHOLD-MODE: ownership filters now bind householdScope(userId) — an ARRAY — via
// `created_by = ANY(${householdIds})`. With GARDEN_HOUSEHOLD_IDS unset (test default),
// householdScope('user_alpha') === ['user_alpha'], so the bound value is the array
// ['user_alpha'], NOT the bare string. Per-user surfaces (user_id, dismissal INSERT)
// still bind the bare string. These helpers count a userId bind in either form.
function bindsUserArray(values, uid) {
  return values.some(v => Array.isArray(v) && v.length === 1 && v[0] === uid);
}
function bindsUserAnyForm(values, uid) {
  return values.includes(uid) || bindsUserArray(values, uid);
}
function countUserBinds(values, uid) {
  return values.filter(v => v === uid || (Array.isArray(v) && v.length === 1 && v[0] === uid)).length;
}


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

  it('V3-ATTNFILTER-001: give_attention is plantings-only (oldest stale planting, server-ranked)', async () => {
    queueAggregationResults();
    sqlResults.push([], [
      { plant_id: 'pl1', plant_name: 'Greek Oregano', project_id: 'pr1', project_name: 'Oregano', last_event_at: '2026-06-14T12:00:00Z', days_stale: 8 },
    ]); // 10th = queryActivityDays (empty), 11th = queryGiveAttention
    const res = await handleDashboard(makeSql(), 'user_alpha');
    const body = parseBody(res);
    expect(body.give_attention).toEqual({ plant_id: 'pl1', plant_name: 'Greek Oregano', project_id: 'pr1', project_name: 'Oregano', last_event_at: '2026-06-14T12:00:00Z', days_stale: 8 });
    const q = findSql(x => x.includes('planting_activity'));
    expect(q).toBeDefined();
    expect(q.resolved).toMatch(/FROM public\.garden_node/);
    expect(q.resolved).toMatch(/INTERVAL '30 days'/);
    expect(q.resolved).toMatch(/INTERVAL '24 hours'/);
    expect(q.resolved).toMatch(/LIMIT 1/);
  });

  it('give_attention is null when no planting is stale', async () => {
    queueAggregationResults();
    const res = await handleDashboard(makeSql(), 'user_alpha');
    expect(parseBody(res).give_attention).toBeNull();
  });

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

  it('T19: Promise.all parallelization — all 11 aggregation queries fire', async () => {
    queueAggregationResults();
    await handleDashboard(makeSql(), 'user_alpha');
    expect(sqlCalls.length).toBe(11);
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

  it('V1.2-streak-fix: streak is recomputed LIVE from activity days, not read from the stored row', async () => {
    // stored row claims streak 99; activity shows two consecutive days ending today -> live = 2
    queueAggregationResults({ stats: [{ current_streak: 99, longest_streak: 99, last_active_date: '2020-01-01', total_events: 5, xp: 50 }] });
    sqlResults.push([{ today: '2026-05-25', days: ['2026-05-25', '2026-05-24'] }]); // 10th query = queryActivityDays
    const res = await handleDashboard(makeSql(), 'user_alpha');
    const body = parseBody(res);
    expect(body.user_stats.current_streak).toBe(2);            // recomputed, stored 99 ignored
    expect(body.user_stats.last_active_date).toBe('2026-05-25');
    expect(body.user_stats.longest_streak).toBe(99);           // never regresses below stored
    expect(body.user_stats.xp).toBe(50);                       // xp/total_events still from stored row
    expect(body.user_stats.total_events).toBe(5);
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
    // HOUSEHOLD-MODE: 7 ownership builders bind ['user_alpha'] (array); favorites + userStats bind the bare string.
    const userBound = sqlCalls.filter(c => bindsUserAnyForm(c.values, 'user_alpha'));
    expect(userBound.length).toBe(11);
  });
});

describe('V3-SCOPE-002 + V3-ATTN-002 — caretaker scope + planting-status suppression', () => {
  it('water_due scopes by caretaker (assignee) with created_by fallback — not created_by alone', () => {
    queryWaterDue(makeSql(), 'user_alpha');
    const q = sqlCalls[0].resolved;
    expect(q).toMatch(/pp\.assignee_user_id\s*=\s*\$\d+/);
    expect(q).toMatch(/pp\.assignee_user_id IS NULL AND pp\.created_by\s*=\s*\$\d+/);
    expect(countUserBinds(sqlCalls[0].values, 'user_alpha')).toBe(2);
  });

  it('water_due only alerts projects holding an actionable planting (suppress dormant/ended/failed/rooting)', () => {
    queryWaterDue(makeSql(), 'user_alpha');
    const q = sqlCalls[0].resolved;
    expect(q).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM public\.garden_node gn/);
    expect(q).toMatch(/NOT IN \('dormant','ended','failed','rooting'\)/);
    expect(q).toMatch(/gn\.status IS NULL OR/);
  });

  it('heads_up stale gets caretaker scope + actionable-planting filter; project-status gate preserved', () => {
    queryHeadsUp(makeSql(), 'user_beta');
    const q = sqlCalls[0].resolved;
    expect(q).toMatch(/pp\.assignee_user_id\s*=\s*\$\d+/);
    expect(q).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM public\.garden_node gn/);
    expect(q).toMatch(/pp\.status IN \('sprouting','growing','flowering','fruiting'\)/);
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
    // HOUSEHOLD-MODE: created_by now widened to ANY(${householdIds}); the dismissals
    // LEFT JOIN still binds d.user_id = ${userId} (bare string).
    expect(q.resolved).toMatch(/pp\.created_by\s*=\s*ANY\(\$\d+\)/);
    expect(bindsUserAnyForm(q.values, 'user_alpha')).toBe(true);
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
    // HOUSEHOLD-MODE: owned-existence check widened to created_by = ANY(${householdIds});
    // dismissal INSERT + COALESCE subquery still bind user_id = ${userId} (bare string).
    expect(q.resolved).toMatch(/created_by\s*=\s*ANY\(\$\d+\)/);
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
  it('queryRecentEvents binds userId + V3-FEED-001 raw window with batch linkage', async () => {
    await queryRecentEvents(makeSql(), 'user_alpha');
    // HOUSEHOLD-MODE: pp.created_by widened to ANY(['user_alpha']).
    expect(bindsUserAnyForm(sqlCalls[0].values, 'user_alpha')).toBe(true);
    expect(sqlCalls[0].resolved).toMatch(/LIMIT 200/);
    expect(sqlCalls[0].resolved).toMatch(/metadata->>'batch_id'/);
    expect(sqlCalls[0].resolved).toMatch(/LEFT JOIN event_batches/);
  });
  it('queryCounts binds householdScope twice (projects + plants sub-counts)', async () => {
    await queryCounts(makeSql(), 'user_alpha');
    // HOUSEHOLD-MODE: both ownership sub-counts widened to ANY(['user_alpha']).
    expect(countUserBinds(sqlCalls[0].values, 'user_alpha')).toBe(2);
  });
  it('queryFavoriteCount binds userId', async () => {
    await queryFavoriteCount(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values).toContain('user_alpha');
  });
  it('queryActiveProjects binds userId', async () => {
    await queryActiveProjects(makeSql(), 'user_alpha');
    expect(bindsUserAnyForm(sqlCalls[0].values, 'user_alpha')).toBe(true);
  });
  it('queryUserStats binds userId', async () => {
    await queryUserStats(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values).toContain('user_alpha');
  });
  it('queryWaterDue binds userId', async () => {
    await queryWaterDue(makeSql(), 'user_alpha');
    expect(bindsUserAnyForm(sqlCalls[0].values, 'user_alpha')).toBe(true);
  });
  it('queryHarvestReady binds userId', async () => {
    await queryHarvestReady(makeSql(), 'user_alpha');
    expect(bindsUserAnyForm(sqlCalls[0].values, 'user_alpha')).toBe(true);
  });
  it('queryHeadsUp binds userId', async () => {
    await queryHeadsUp(makeSql(), 'user_alpha');
    // V3-SCOPE-002: flagged + stale CTEs caretaker-scoped (assignee OR created_by fallback) = 2 binds each = 4.
    expect(countUserBinds(sqlCalls[0].values, 'user_alpha')).toBe(4);
  });
  it('queryInactiveCount binds twice — household array (created_by) + bare string (dismissals NOT EXISTS)', async () => {
    await queryInactiveCount(makeSql(), 'user_alpha');
    // HOUSEHOLD-MODE: outer created_by -> ANY(['user_alpha']); dismissals d.user_id stays bare string.
    expect(countUserBinds(sqlCalls[0].values, 'user_alpha')).toBe(2);
    expect(sqlCalls[0].values).toContain('user_alpha'); // dismissal guard still per-user (string)
    expect(bindsUserArray(sqlCalls[0].values, 'user_alpha')).toBe(true); // created_by widened (array)
  });
  it('queryInactiveList binds twice — bare string (dismissals JOIN) + household array (WHERE created_by)', async () => {
    await queryInactiveList(makeSql(), 'user_alpha');
    // HOUSEHOLD-MODE: dismissals LEFT JOIN d.user_id stays bare string; created_by -> ANY(['user_alpha']).
    expect(countUserBinds(sqlCalls[0].values, 'user_alpha')).toBe(2);
    expect(sqlCalls[0].values).toContain('user_alpha'); // dismissal join still per-user (string)
    expect(bindsUserArray(sqlCalls[0].values, 'user_alpha')).toBe(true); // created_by widened (array)
  });
  it('queryDismissInactive binds projectId twice (CTE + ::uuid cast) and userId three times', async () => {
    const VALID_UUID = '11111111-2222-3333-4444-555555555555';
    sqlResults.push([{ status: 'dismissed', dismissed_at: '2026-05-13T12:00:00Z' }]);
    await queryDismissInactive(makeSql(), 'user_alpha', VALID_UUID);
    expect(sqlCalls[0].values).toContain(VALID_UUID);
    // HOUSEHOLD-MODE: owned-check created_by -> ANY(['user_alpha']) (array); the dismissal
    // INSERT + COALESCE subquery still bind user_id = ${userId} (>=2 bare-string binds).
    expect(sqlCalls[0].values.filter(v => v === 'user_alpha').length).toBeGreaterThanOrEqual(2);
    expect(bindsUserArray(sqlCalls[0].values, 'user_alpha')).toBe(true);
  });
});


// ---- V3-FEED-001 — collapseBatches (Log Many feed collapse) ----------------

describe('collapseBatches — V3-FEED-001 log-many feed collapse', () => {
  const ev = (id, over = {}) => ({
    id, event_type: 'watering', event_date: '2026-06-10',
    created_at: '2026-06-10T12:00:00Z', batch_id: null, item_count: null,
    project_name: 'P-' + id, ...over,
  });

  it('passes singletons through with batch_count 1, order preserved', () => {
    const out = collapseBatches([ev('a'), ev('b')]);
    expect(out.map(r => r.id)).toEqual(['a', 'b']);
    expect(out.every(r => r.batch_count === 1)).toBe(true);
  });

  it('folds a batch into ONE entry anchored at its newest row', () => {
    const rows = [ev('n1'), ev('b1', { batch_id: 'B' }), ev('n2'), ev('b2', { batch_id: 'B' }), ev('b3', { batch_id: 'B' })];
    const out = collapseBatches(rows);
    expect(out.map(r => r.id)).toEqual(['n1', 'b1', 'n2']);
    expect(out[1].batch_count).toBe(3);
  });

  it('prefers event_batches.item_count (exact) over occurrences when the window truncates a batch', () => {
    const rows = [ev('b1', { batch_id: 'B', item_count: 12 }), ev('b2', { batch_id: 'B', item_count: 12 })];
    const out = collapseBatches(rows);
    expect(out).toHaveLength(1);
    expect(out[0].batch_count).toBe(12);
  });

  it('separate batches stay separate entries', () => {
    const out = collapseBatches([ev('x1', { batch_id: 'X' }), ev('y1', { batch_id: 'Y' })]);
    expect(out).toHaveLength(2);
    expect(out.map(r => r.batch_count)).toEqual([1, 1]);
  });

  it('caps at FEED_CAP=20 AFTER collapsing (batch counts as one entry)', () => {
    const batch = Array.from({ length: 10 }, (_, i) => ev('b' + i, { batch_id: 'B' }));
    const singles = Array.from({ length: 30 }, (_, i) => ev('s' + i));
    const out = collapseBatches([...batch, ...singles]);
    expect(FEED_CAP).toBe(20);
    expect(out).toHaveLength(20);
    expect(out[0].batch_count).toBe(10);   // collapsed batch = entry 1
    expect(out[1].id).toBe('s0');          // then 19 singles
    expect(out[19].id).toBe('s18');
  });

  it('null / empty input is safe', () => {
    expect(collapseBatches(null)).toEqual([]);
    expect(collapseBatches([])).toEqual([]);
  });

  it('handleDashboard returns recent_events already collapsed', async () => {
    sqlResults.push(
      [
        { id: 'e1', event_type: 'watering', created_at: 'c3', batch_id: 'B', item_count: 2, project_name: 'A' },
        { id: 'e2', event_type: 'watering', created_at: 'c2', batch_id: 'B', item_count: 2, project_name: 'B' },
        { id: 'e3', event_type: 'observation', created_at: 'c1', batch_id: null, item_count: null, project_name: 'C' },
      ],
      [{ project_count: 0, plant_count: 0, location_count: 0 }],
      [{ count: 0 }], [], [], [], [], [], [{ count: 0 }],
    );
    const res = await handleDashboard(makeSql(), 'user_alpha');
    const re = parseBody(res).recent_events;
    expect(re).toHaveLength(2);
    expect(re[0]).toMatchObject({ id: 'e1', batch_count: 2 });
    expect(re[1]).toMatchObject({ id: 'e3', batch_count: 1 });
  });
});

describe('V3-ATTNFILTER-001 — queryGiveAttention builder', () => {
  it('targets plantings (garden_node), caretaker-scoped, 24h-30d window, LIMIT 1', () => {
    queryGiveAttention(makeSql(), 'user_alpha');
    const q = sqlCalls[0].resolved;
    expect(q).toMatch(/FROM public\.garden_node/);
    expect(q).toMatch(/pp\.assignee_user_id\s*=\s*\$\d+/);
    expect(q).toMatch(/pp\.assignee_user_id IS NULL AND pp\.created_by\s*=\s*\$\d+/);
    expect(q).toMatch(/gn\.status NOT IN \('dormant','ended','failed','rooting'\)/);
    expect(q).toMatch(/LIMIT 1/);
    expect(countUserBinds(sqlCalls[0].values, 'user_alpha')).toBe(2);
  });
});


// ---- DRG-WATERRECON-001: bar reads the engine verdict (daily_plan), not entity_memory --------
describe('DRG-WATERRECON-001 — queryWaterDueFromPlan (alert bar reads the DrG engine verdict)', () => {
  it('reads today daily_plan, freshness-filters via event_log (ET), groups, joins entity_memory, falls back to legacy', () => {
    queryWaterDueFromPlan(makeSql(), 'user_alpha');
    const q = findSql(s => s.includes('daily_plan') && s.includes("items->'water_due'"));
    expect(q).toBeDefined();
    // plan keyed per-user + ET day
    expect(q.resolved).toMatch(/FROM daily_plan/);
    expect(q.resolved).toMatch(/America\/New_York/);
    // same-day done-set (mirrors daily-plan-read.annotateDone): watering/rain event today ET
    expect(q.resolved).toMatch(/FROM event_log/);
    expect(q.resolved).toMatch(/event_type IN \('watering','rain'\)/);
    // display fields the UI reads (WaterMeTile + todayBand) preserved from entity_memory + container
    expect(q.resolved).toMatch(/entity_memory/);
    expect(q.resolved).toMatch(/public\.container/);
    expect(q.resolved).toMatch(/last_watered_at/);
    expect(q.resolved).toMatch(/location_type/);
    // observable fallback source flag + legacy branch gated on a COMPATIBLE plan (DRG-WATERRECON-002:
    // has_plan replaced by the schema_version compat gate — present-but-incompatible -> legacy fallback)
    expect(q.resolved).toMatch(/water_due_source/);
    expect(q.resolved).toMatch(/NOT \(SELECT ok FROM compat\)/);
    // binds userId (plan + legacy assignee/created_by => 3 binds)
    expect(countUserBinds(q.values, 'user_alpha')).toBeGreaterThanOrEqual(1);
  });

  it('handleDashboard passes queryWaterDueFromPlan rows through to water_due (drop-in for queryWaterDue)', async () => {
    // position 6 in the aggregation FIFO is now queryWaterDueFromPlan's single call
    sqlResults.push([], [{ project_count: 0, plant_count: 0, location_count: 0 }], [{ count: 0 }], [], [],
      [{ project_id: 'pr1', project_name: 'Peppers', last_watered_at: '2026-06-24T10:00:00Z', location_type: null,
         watering_interval_days: null, next_water_at: '2026-06-23T00:00:00Z',
         plantings: [{ id: 'p1', name: 'Jalapeño' }], water_due_source: 'plan' }],
      [], [], [{ count: 0 }]);
    const res = await handleDashboard(makeSql(), 'user_alpha');
    const body = parseBody(res);
    expect(body.water_due).toHaveLength(1);
    expect(body.water_due[0].project_name).toBe('Peppers');
    expect(body.water_due[0].last_watered_at).toBe('2026-06-24T10:00:00Z');
    expect(body.water_due[0].water_due_source).toBe('plan');
  });
});

// DRG-WXWATER-002b — the active_projects tile must carry NO naive water verdict. It feeds count/harvest-gate/
// zero-state only; the dashboard's water cue is the water_due tile (queryWaterDueFromPlan, plan-reconciled).
// A raw entity_memory next_water_at re-added here would reintroduce the rain-blind "false Overdue" class.
describe('DRG-WXWATER-002b — queryActiveProjects carries no naive water verdict', () => {
  it('selects activity last_* timestamps but NOT next_water_at / watering_interval_days', () => {
    queryActiveProjects(makeSql(), 'user_alpha');
    const q = findSql(s => s.includes('last_pruned_at') && s.includes('ORDER BY pp.created_at DESC'));
    expect(q, 'queryActiveProjects SQL not captured').toBeDefined();
    // naive water verdict fields are GONE (the divergence trap)
    expect(q.resolved).not.toMatch(/next_water_at/);
    expect(q.resolved).not.toMatch(/watering_interval_days/);
    // activity timestamps + household scope preserved (behavior unchanged for real consumers)
    expect(q.resolved).toMatch(/last_watered_at/);
    expect(q.resolved).toMatch(/last_event_at/);
    expect(q.resolved).toMatch(/pp\.created_by = ANY/);
  });
});


// DRG-WATERRECON-001 drift guard: the alert bar (queryWaterDueFromPlan `fresh` CTE) and the Today page
// (daily-plan-read annotateDone) are two independent reimplementations of the SAME "satisfied today" filter.
// They MUST keep the same water-done event types or bar and Today silently re-diverge (the 0%-overlap bug class).
import { readFileSync as __readFileSync } from 'fs';
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. These anti-drift guards read two files and assert they agree, so a
// comment in EITHER could fake agreement that the code no longer has. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const __decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const __readSrc = (p) => __decomment(__readFileSync(p, 'utf8'));
describe('DRG-WATERRECON-001 — bar/Today freshness filters stay in lockstep (anti-drift)', () => {
  it('the bar SQL and Today annotateDone use the same water-done event types + ET-day boundary', () => {
    const barSrc = __readSrc('lambda/dashboard/handlers.js');
    const todaySrc = __readSrc('lambda/daily-plan-read/index.js');
    // bar: SQL literal IN ('watering','rain'); Today: DONE_EVENTS.water_due array ['watering','rain']
    expect(barSrc).toMatch(/event_type IN \('watering','rain'\)/);
    expect(todaySrc).toMatch(/water_due:\s*\[\s*'watering',\s*'rain'\s*\]/);
    // both key the done-day on America/New_York ::date
    expect(barSrc).toMatch(/event_date AT TIME ZONE 'America\/New_York'\)::date/);
    expect(todaySrc).toMatch(/event_date AT TIME ZONE 'America\/New_York'\)::date/);
    // both filter soft-deleted events out of the done-set
    expect(barSrc).toMatch(/ev\.deleted_at IS NULL/);
    expect(todaySrc).toMatch(/e\.deleted_at IS NULL/);
  });
});


// ── DRG-WATERRECON-002 ───────────────────────────────────────────────────────
// (1) the bar's plan-trust gate keys on the stored items.schema_version; (2) the version literal stays in
// lockstep across the engine writer + both readers; (3) one failing tile no longer 500s the whole dashboard.
describe('DRG-WATERRECON-002 — queryWaterDueFromPlan schema_version guard', () => {
  it('only trusts a daily_plan whose stored schema_version matches; mismatch -> schema_mismatch, absent -> legacy', () => {
    queryWaterDueFromPlan(makeSql(), 'user_alpha');
    const q = sqlCalls[sqlCalls.length - 1];
    expect(q.resolved).toMatch(/items->>'schema_version'/);
    expect(q.resolved).toMatch(/compat AS \(SELECT EXISTS\(SELECT 1 FROM plan WHERE sv IS NULL OR sv = \$\d+\)/);
    expect(q.resolved).toMatch(/THEN 'schema_mismatch' ELSE 'legacy'/);
    // BOTH branches gate on compat.ok (compatible plan present), not bare plan presence
    expect(q.resolved).toMatch(/FROM plan_rows\s+WHERE\s+\(SELECT ok FROM compat\)/);
    expect(q.resolved).toMatch(/FROM legacy_rows WHERE NOT \(SELECT ok FROM compat\)/);
    // the expected version is BOUND (parameterized), never string-inlined
    expect(q.values).toContain(1);
  });
});

describe('DRG-WATERRECON-002 — plan schema_version stays in lockstep across engine + readers (anti-drift)', () => {
  const grab = (src) => { const m = src.match(/PLAN_SCHEMA_VERSION\s*=\s*(\d+)/); return m ? m[1] : null; };
  it('engine, dashboard bar, and Today reader pin the SAME PLAN_SCHEMA_VERSION integer', () => {
    const ev = grab(__readSrc('lambda/daily-plan/engine.js'));
    const bv = grab(__readSrc('lambda/dashboard/handlers.js'));
    const tv = grab(__readSrc('lambda/daily-plan-read/index.js'));
    expect(ev).not.toBeNull();
    expect(bv).toBe(ev);
    expect(tv).toBe(ev);
  });
  it('the engine writer STAMPS schema_version into the stored daily_plan.items jsonb', () => {
    const handler = __readSrc('lambda/daily-plan/handler.js');
    expect(handler).toMatch(/schema_version:\s*PLAN_SCHEMA_VERSION/);
    expect(handler).toMatch(/require\('\.\/engine'\)/);
  });
  it('both readers FAIL LOUD on a version mismatch — no silent empty/garbage verdict', () => {
    const bar = __readSrc('lambda/dashboard/handlers.js');
    const today = __readSrc('lambda/daily-plan-read/index.js');
    expect(bar).toMatch(/schema_mismatch/);
    expect(bar).toMatch(/console\.error\([\s\S]*?schema_version MISMATCH/);
    expect(today).toMatch(/schema_stale/);
    expect(today).toMatch(/console\.error\([\s\S]*?schema_version mismatch/);
  });
});

describe('DRG-WATERRECON-002 — handleDashboard per-tile isolation (Promise.allSettled)', () => {
  it('one failing tile degrades to a safe fallback and the dashboard still returns 200', async () => {
    let n = 0;
    const sql = (_strings, ..._vals) => {
      n += 1;
      if (n === 6) return Promise.reject(new Error('water tile boom')); // queryWaterDueFromPlan
      if (n === 2) return Promise.resolve([{ project_count: 3, plant_count: 9, location_count: 2 }]); // counts
      if (n === 3) return Promise.resolve([{ count: 5 }]);   // favCount (indexed [0])
      if (n === 9) return Promise.resolve([{ count: 0 }]);   // inactiveCount
      if (n === 11) return Promise.resolve([{ plant_id: 'pl1', plant_name: 'Basil' }]); // giveAttention
      return Promise.resolve([]);
    };
    const res = await handleDashboard(sql, 'user_alpha');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.water_due).toEqual([]);                 // failed tile -> safe empty fallback (not a 500)
    expect(body.counts.projects).toBe(3);               // sibling tiles unaffected
    expect(body.give_attention).toEqual({ plant_id: 'pl1', plant_name: 'Basil' });
  });
});
