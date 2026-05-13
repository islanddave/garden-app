// /api/dashboard — V1.2a-2 Session 2 Lambda tests
// Vitest unit tests covering routing, validation, and SQL-query shape for the
// extended dashboard Lambda. Uses a mocked `neon` tagged-template that records
// the assembled SQL strings + bound params; tests assert both response behavior
// AND query contract (F1 calendar-day, F7 stale predicate, F9 UUID, dedup, etc.).
//
// Test inventory (per task brief):
//   T1   F1 calendar-day correctness in harvest_ready
//   T2   F1 calendar-day correctness in heads_up stale
//   T3   F7 stale predicate handles NULL last_observed_at with last_event_at fallback
//   T4   Tile 4 dedup — flagged-AND-stale project surfaces ONCE as 'flagged'
//   T5   Tile 4 severity ordering — severity=3 sorts before severity=1
//   T6   F9 UUID parse — POST /dismiss with not-a-uuid → 404
//   T7   T9 cross-user authorization — POST /dismiss other user's project → 404
//   T8   T9 GET /inactive returns only requester's projects (WHERE created_by=user)
//   T9   Idempotent dismiss — two POSTs return 200 with same dismissed_at
//   T10  Empty harvest_ready when no harvesting projects
//   T11  Empty heads_up when no flagged or stale
//   T12  inactive_projects_count = 0 when all dismissed
//   T13  inactive_projects_count = N when none dismissed
//   T14  GET /api/dashboard wrong method → 405
//   T15  POST /dismiss wrong method (GET) → 405
//   T16  OPTIONS preflight → 204
//   T17  Unauthorized (verifyToken throws) → 401
//   T18  Unknown route → 404
//   T19  Promise.all parallelization — all 9 queries fire concurrently
//   T20  inactive listing sort — undismissed-first, then last_event_at DESC

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Mock infrastructure --------------------------------------------------

const sqlCalls = []; // [{ strings: TemplateStringsArray, values: any[], resolved: string }]
const sqlResults = []; // FIFO queue of result arrays for sequential calls

function makeNeonMock() {
  return function sqlTag(strings, ...values) {
    // Reconstruct a "resolved" SQL string with $1, $2... placeholders for assertions
    let resolved = '';
    strings.forEach((s, i) => {
      resolved += s;
      if (i < values.length) resolved += `$${i + 1}`;
    });
    sqlCalls.push({ strings: Array.from(strings), values, resolved });
    // Return next queued result (default: empty array)
    const result = sqlResults.length > 0 ? sqlResults.shift() : [];
    return Promise.resolve(result);
  };
}

vi.mock('@neondatabase/serverless', () => ({
  neon: () => makeNeonMock(),
}));

const verifyTokenMock = vi.fn();
vi.mock('@clerk/backend', () => ({
  verifyToken: (...args) => verifyTokenMock(...args),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { send() {
    return Promise.resolve({
      SecretString: JSON.stringify({
        CLERK_SECRET_KEY: 'sk_test_placeholder',
        NEON_DATABASE_URL: 'postgres://test',
      }),
    });
  } },
  GetSecretValueCommand: class { constructor(args) { this.args = args; } },
}));

// ---- Import after mocks ---------------------------------------------------

const { handler } = await import('./index.js');

// ---- Helpers --------------------------------------------------------------

function mkEvent({ method = 'GET', path = '/api/dashboard', auth = 'Bearer ok' } = {}) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: { authorization: auth },
  };
}

function parseBody(res) { return JSON.parse(res.body); }

function findSql(predicate) {
  return sqlCalls.find(c => predicate(c.resolved));
}

beforeEach(() => {
  sqlCalls.length = 0;
  sqlResults.length = 0;
  verifyTokenMock.mockReset();
  verifyTokenMock.mockResolvedValue({ sub: 'user_alpha' });
});

// ---- Tests ----------------------------------------------------------------

describe('GET /api/dashboard — aggregation', () => {
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
    const res = await handler(mkEvent());
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
    const res = await handler(mkEvent());
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
    await handler(mkEvent());
    const headsSql = findSql(s => s.includes('WITH flagged AS'));
    expect(headsSql).toBeDefined();
    // F7 — predicate uses COALESCE(em.last_event_at, pp.created_at) when last_observed_at IS NULL
    expect(headsSql.resolved).toMatch(/em\.last_observed_at IS NULL[\s\S]*COALESCE\(em\.last_event_at,\s*pp\.created_at\)\s*<\s*NOW\(\)\s*-\s*INTERVAL\s*'21 days'/);
    // And the OR branch handles non-null last_observed_at
    expect(headsSql.resolved).toMatch(/em\.last_observed_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s*'21 days'/);
  });

  it('T4: Tile 4 dedup — flagged-AND-stale project surfaces ONCE as flagged (NOT EXISTS in stale CTE)', async () => {
    queueAggregationResults();
    await handler(mkEvent());
    const headsSql = findSql(s => s.includes('WITH flagged AS'));
    expect(headsSql).toBeDefined();
    // The stale CTE must contain a NOT EXISTS subquery referencing event_log
    // with flagged_as_issue=true AND resolved_at IS NULL → guarantees a flagged project
    // never appears in the 'stale' partition.
    expect(headsSql.resolved).toMatch(/NOT EXISTS\s*\([\s\S]*event_log[\s\S]*flagged_as_issue\s*=\s*true[\s\S]*resolved_at IS NULL/);
    // DISTINCT ON ensures one row per project_id in the flagged CTE
    expect(headsSql.resolved).toMatch(/DISTINCT ON \(el\.project_id\)/);
  });

  it('T5: Tile 4 severity ordering — severity DESC NULLS LAST (sev=3 before sev=1, stale last)', async () => {
    // Mock result reflects DB ordering; the assertion is on the SQL ORDER BY clause.
    queueAggregationResults({
      heads: [
        { project_id: 'p3', name: 'A', reason: 'flagged', severity: 3, event_at: '2026-05-12T00:00:00Z', days_stale: 1 },
        { project_id: 'p4', name: 'B', reason: 'flagged', severity: 1, event_at: '2026-05-12T00:00:00Z', days_stale: 1 },
        { project_id: 'p5', name: 'C', reason: 'stale',   severity: null, event_at: '2026-04-22T00:00:00Z', days_stale: 21 },
      ],
    });
    const res = await handler(mkEvent());
    const body = parseBody(res);
    expect(body.heads_up.map(r => r.severity)).toEqual([3, 1, null]);

    const headsSql = findSql(s => s.includes('WITH flagged AS'));
    // Final ORDER BY of the UNION ALL — severity DESC NULLS LAST, event_at ASC
    expect(headsSql.resolved).toMatch(/UNION ALL[\s\S]*ORDER BY severity DESC NULLS LAST,\s*event_at ASC/);
    expect(headsSql.resolved).toMatch(/LIMIT 10/);
  });

  it('T10: harvest_ready empty when no harvesting projects', async () => {
    queueAggregationResults({ harvest: [] });
    const res = await handler(mkEvent());
    expect(parseBody(res).harvest_ready).toEqual([]);
  });

  it('T11: heads_up empty when no flagged or stale', async () => {
    queueAggregationResults({ heads: [] });
    const res = await handler(mkEvent());
    expect(parseBody(res).heads_up).toEqual([]);
  });

  it('T12: inactive_projects_count = 0 when all dismissed', async () => {
    queueAggregationResults({ inactive: [{ count: 0 }] });
    const res = await handler(mkEvent());
    expect(parseBody(res).inactive_projects_count).toBe(0);
  });

  it('T13: inactive_projects_count = N when none dismissed', async () => {
    queueAggregationResults({ inactive: [{ count: 7 }] });
    const res = await handler(mkEvent());
    expect(parseBody(res).inactive_projects_count).toBe(7);

    const countSql = findSql(s => s.includes("pp.status IN ('harvested','ended')") && s.includes('NOT EXISTS') && s.includes('inactive_project_dismissals'));
    expect(countSql).toBeDefined();
    // user_id filter on dismissals subquery — multi-user safe
    expect(countSql.resolved).toMatch(/d\.user_id\s*=\s*\$\d+/);
  });

  it('T19: Promise.all parallelization — all 9 aggregation queries fire', async () => {
    queueAggregationResults();
    await handler(mkEvent());
    // 9 parallel queries: recentEvents, counts, favCount, activeProjects,
    //                    userStats, waterDue, harvestReady, headsUp, inactiveCount
    expect(sqlCalls.length).toBe(9);
  });

  it('T14: GET /api/dashboard with wrong method → 405', async () => {
    const res = await handler(mkEvent({ method: 'PUT' }));
    expect(res.statusCode).toBe(405);
  });

  it('T16: OPTIONS preflight → 204', async () => {
    const res = await handler(mkEvent({ method: 'OPTIONS' }));
    expect(res.statusCode).toBe(204);
  });

  it('T17: Unauthorized when verifyToken throws → 401', async () => {
    verifyTokenMock.mockRejectedValueOnce(new Error('bad token'));
    const res = await handler(mkEvent());
    expect(res.statusCode).toBe(401);
    expect(parseBody(res).error).toBe('Unauthorized');
  });

  it('T18: Unknown route → 404', async () => {
    const res = await handler(mkEvent({ path: '/api/nonexistent' }));
    expect(res.statusCode).toBe(404);
  });
});

// ---- GET /api/projects/inactive -------------------------------------------

describe('GET /api/projects/inactive', () => {
  it('T8/T20: scoped to created_by=userId; sorted undismissed-first then last_event_at DESC', async () => {
    sqlResults.push([
      { id: 'p10', name: 'Cucumber', variety: 'Bush', status: 'harvested', start_date: '2026-01-01',
        last_event_at: '2026-04-10T00:00:00Z', last_harvested_at: '2026-04-01T00:00:00Z',
        dismissed: false, dismissed_at: null },
      { id: 'p11', name: 'Pea', variety: 'Sugar Snap', status: 'ended', start_date: '2026-02-01',
        last_event_at: '2026-03-10T00:00:00Z', last_harvested_at: '2026-03-05T00:00:00Z',
        dismissed: true, dismissed_at: '2026-04-15T00:00:00Z' },
    ]);
    const res = await handler(mkEvent({ method: 'GET', path: '/api/projects/inactive' }));
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body).toHaveLength(2);
    expect(body[0].dismissed).toBe(false);

    const q = sqlCalls[0];
    expect(q.resolved).toMatch(/pp\.status IN \('harvested','ended'\)/);
    expect(q.resolved).toMatch(/pp\.created_by\s*=\s*\$\d+/);
    expect(q.values).toContain('user_alpha');
    // Sort clause — undismissed-first, then last_event_at DESC NULLS LAST
    expect(q.resolved).toMatch(/ORDER BY d\.dismissed_at IS NULL DESC,\s*em\.last_event_at DESC NULLS LAST/);
    // No pagination
    expect(q.resolved).not.toMatch(/LIMIT/);
  });

  it('wrong method on /api/projects/inactive → 405', async () => {
    const res = await handler(mkEvent({ method: 'POST', path: '/api/projects/inactive' }));
    expect(res.statusCode).toBe(405);
  });
});

// ---- POST /api/projects/inactive/:projectId/dismiss -----------------------

describe('POST /api/projects/inactive/:projectId/dismiss', () => {
  const VALID_UUID = '11111111-2222-3333-4444-555555555555';

  it('T6: F9 — malformed UUID → 404 (not 500)', async () => {
    const res = await handler(mkEvent({
      method: 'POST',
      path: '/api/projects/inactive/not-a-uuid/dismiss',
    }));
    expect(res.statusCode).toBe(404);
    // No DB query was issued — UUID parse oracle closed
    expect(sqlCalls.length).toBe(0);
  });

  it('F9: UUID with wrong length → 404', async () => {
    const res = await handler(mkEvent({
      method: 'POST',
      path: '/api/projects/inactive/12345/dismiss',
    }));
    expect(res.statusCode).toBe(404);
    expect(sqlCalls.length).toBe(0);
  });

  it('T7: cross-user — POST other user\'s project → 404 (existence-oblivious)', async () => {
    // CTE returns row with status='not_found' when owned CTE is empty
    sqlResults.push([{ status: 'not_found', dismissed_at: null }]);
    const res = await handler(mkEvent({
      method: 'POST',
      path: `/api/projects/inactive/${VALID_UUID}/dismiss`,
    }));
    expect(res.statusCode).toBe(404);

    const q = sqlCalls[0];
    expect(q.resolved).toMatch(/WITH owned AS/);
    expect(q.resolved).toMatch(/created_by\s*=\s*\$\d+/);
    expect(q.resolved).toMatch(/ON CONFLICT \(user_id, project_id\) DO NOTHING/);
    expect(q.values).toContain('user_alpha');
    expect(q.values).toContain(VALID_UUID);
  });

  it('happy path — POST /dismiss → 200 with dismissed_at', async () => {
    sqlResults.push([{ status: 'dismissed', dismissed_at: '2026-05-13T12:00:00Z' }]);
    const res = await handler(mkEvent({
      method: 'POST',
      path: `/api/projects/inactive/${VALID_UUID}/dismiss`,
    }));
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body).toEqual({ dismissed: true, dismissed_at: '2026-05-13T12:00:00Z' });
  });

  it('T9: idempotent dismiss — second call returns 200 with same dismissed_at (COALESCE branch)', async () => {
    const ts = '2026-05-13T12:00:00Z';
    // First POST — INSERT succeeds via upsert RETURNING
    sqlResults.push([{ status: 'dismissed', dismissed_at: ts }]);
    const r1 = await handler(mkEvent({
      method: 'POST', path: `/api/projects/inactive/${VALID_UUID}/dismiss`,
    }));
    // Second POST — ON CONFLICT DO NOTHING returns empty; COALESCE picks up the existing row
    sqlResults.push([{ status: 'dismissed', dismissed_at: ts }]);
    const r2 = await handler(mkEvent({
      method: 'POST', path: `/api/projects/inactive/${VALID_UUID}/dismiss`,
    }));
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(parseBody(r1).dismissed_at).toEqual(parseBody(r2).dismissed_at);
  });

  it('T15: GET /dismiss → 405 (per-path method dispatch)', async () => {
    const res = await handler(mkEvent({
      method: 'GET',
      path: `/api/projects/inactive/${VALID_UUID}/dismiss`,
    }));
    expect(res.statusCode).toBe(405);
    expect(sqlCalls.length).toBe(0);
  });

  it('dismiss CTE uses COALESCE for idempotency', async () => {
    sqlResults.push([{ status: 'dismissed', dismissed_at: '2026-05-13T12:00:00Z' }]);
    await handler(mkEvent({
      method: 'POST',
      path: `/api/projects/inactive/${VALID_UUID}/dismiss`,
    }));
    const q = sqlCalls[0];
    expect(q.resolved).toMatch(/COALESCE\(\s*\(SELECT dismissed_at FROM upsert\)/);
    // Ownership check requires status IN harvested/ended AND deleted_at IS NULL
    expect(q.resolved).toMatch(/status IN \('harvested','ended'\)/);
    expect(q.resolved).toMatch(/deleted_at IS NULL/);
  });
});
