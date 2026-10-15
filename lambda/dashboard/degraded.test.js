// I33 (BUG-LAMBDAERRPATHS-001) — the dashboard and header search fold a failed tile/section into a
// safe fallback (Promise.allSettled), which kept the page up but made a failure look like real data:
// a dead activity_days tile computed a streak of 0, and a dead dashboard rendered as an empty garden.
// Contract: top-level `degraded: [names]` only when non-empty; `current_streak: null` when
// activity_days failed; 503 with a client-showable `error` when EVERY tile failed. Search names a
// failed section at the top level, never inside `results` (Search.jsx spreads results).
// Executes the real pure handlers against a fake sql (handlers.js imports no driver).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleDashboard, handleSearch, SEARCH_SECTIONS } from './handlers.js';

afterEach(() => vi.restoreAllMocks());

// Rows the assembly indexes into need real shapes; everything else is [].
function dashSql({ fail = () => false } = {}) {
  return (strings, ...values) => {
    const text = strings.join('?');
    const call = { text, values };
    if (fail(call)) return Promise.reject(new Error('tile boom'));
    if (/AS project_count/.test(text)) return Promise.resolve([{ project_count: 3, plant_count: 9, location_count: 2 }]);
    if (/COUNT\(\*\)::int AS count|AS count/.test(text)) return Promise.resolve([{ count: 0 }]);
    if (isActivityDays(call)) return Promise.resolve([{ today: '2026-08-12', days: ['2026-08-12', '2026-08-11'] }]);
    if (/FROM user_stats|user_stats/.test(text)) return Promise.resolve([{ current_streak: 7, longest_streak: 9, last_active_date: '2026-08-01', total_events: 4, xp: 10 }]);
    return Promise.resolve([]);
  };
}
// The activity_days builder is the one that binds the non-reward event-type exclusion list.
const isActivityDays = (c) => c.values.some((v) => Array.isArray(v) && v.includes('moisture_check'));

describe('handleDashboard — degraded tiles are named (I33)', () => {
  it('all tiles fine -> 200 and NO degraded key', async () => {
    const res = await handleDashboard(dashSql(), 'user_alpha');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).not.toHaveProperty('degraded');
  });

  it('one failing tile -> 200 with degraded naming exactly that tile', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleDashboard(dashSql({ fail: (c) => /AS project_count/.test(c.text) }), 'user_alpha');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.degraded).toEqual(['counts']);
    expect(body.counts.projects).toBe(0); // fallback still served
  });

  it('activity_days failed -> current_streak is null (unknown), not a computed 0', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleDashboard(dashSql({ fail: isActivityDays }), 'user_alpha');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.degraded).toEqual(['activity_days']);
    expect(body.user_stats.current_streak).toBeNull();
  });

  it('activity_days fine -> current_streak is the live computed number', async () => {
    const res = await handleDashboard(dashSql(), 'user_alpha');
    expect(typeof JSON.parse(res.body).user_stats.current_streak).toBe('number');
  });

  it('every tile failed -> 503 with a sentence the client shows and the full degraded list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleDashboard(dashSql({ fail: () => true }), 'user_alpha');
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('The dashboard could not load. Try again in a minute.');
    expect(body.degraded).toEqual(['recent_events', 'counts', 'favorites', 'active_projects', 'user_stats',
      'water_due', 'harvest_ready', 'heads_up', 'inactive_count', 'activity_days', 'give_attention']);
  });
});

describe('handleSearch — degraded sections are named at the top level (I33)', () => {
  const photoSearch = (strings) => strings.join('?').includes('FROM photos p');
  const searchSql = (fail) => (strings) => (fail(strings) ? Promise.reject(new Error('section boom')) : Promise.resolve([]));

  it('all sections fine -> no degraded key', async () => {
    const res = await handleSearch(searchSql(() => false), 'user_alpha', 'basil');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).not.toHaveProperty('degraded');
  });

  it('a failing section -> degraded at the top level, never a key inside results', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleSearch(searchSql(photoSearch), 'user_alpha', 'basil');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.degraded).toEqual(['photos']);
    expect(body.results.photos).toEqual([]);
    expect(Object.keys(body.results).sort()).toEqual([...SEARCH_SECTIONS].sort());
  });
});
