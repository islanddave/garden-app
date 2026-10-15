// BUG-AUTHZLAMBDA-001 — the nightly plan is per Space household, driven through run().
//
// rain-live-filter.test.js (the owner pass) proves the plantings SELECT admits only the Space household's
// plantings. The mocks below return their fixture rows whatever the SQL says, so what THIS file proves is
// the JS half the SQL cannot do: the bind the SELECT is handed, an assignee outside the Space household
// dropped, unassigned plantings going to the Space's own owner (never the old OWNER_FALLBACK_SUB), an
// unowned Space owning nothing, and the three log lines that make each of those visible.
import { describe, it, expect, vi, afterEach } from 'vitest';
import h from './handler.js';
import _cf from './_coverFlags.js';

const { run } = h;
const { withCoverFlags } = _cf;

const DATE = '2026-06-20';
const DAVE = 'user_dave';
const JEN = 'user_jen';
const STRANGER = 'user_stranger';

const P = (id, ov = {}) => withCoverFlags({
  id, name: `Plant ${id}`, project_id: 'pj1', project: 'Garden', project_status: 'active', workspace_id: 'sp1',
  rain_exposed: null, covered: false, assignee_user_id: null, last_water: '2026-06-14', variety: null, genus: null,
  crop_type_slug: 'tomato', container_type: 'fabric_bag', container_size: '5 gal', status: 'vegetative',
  last_fert: '2026-06-01', substrate_start: '2026-06-01', transplant_at: '2026-06-01', db_cadence: null, ...ov,
});
const SPACE = (id, created_by) => ({ id, postal_code: null, weather_lat: 42.5, weather_lng: -72.6, created_by });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// `env` absent = the full household; `env: undefined` = the key unset.
async function drive({ plantings, spaces, ...o }) {
  vi.stubEnv('GARDEN_HOUSEHOLD_IDS', 'env' in o ? o.env : `${DAVE},${JEN}`);
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const calls = [];
  const writes = [];
  const pg = {
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/from plants/.test(sql)) return { rows: plantings };
      if (/from spaces/.test(sql)) return { rows: spaces };
      if (/insert into daily_plan/.test(sql)) { writes.push({ user: params[0], items: JSON.parse(params[2]) }); return { rows: [] }; }
      return { rows: [] };
    }),
  };
  await run({ pg, today: DATE, dryRun: false, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 58, highToday: 78, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => null, fetchStation: async () => null, etHour: 2, event: {} });
  const lines = spy.mock.calls.map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { calls, writes, lines, plantings };
}
const users = (writes) => [...new Set(writes.map((w) => w.user))].sort();
const msgs = (lines, msg) => lines.filter((l) => l.msg === msg);

describe('the plantings SELECT is handed the household list, read as lambda/household.js reads it', () => {
  it('binds the trimmed, non-empty GARDEN_HOUSEHOLD_IDS entries as its one parameter', async () => {
    const { calls } = await drive({ plantings: [], spaces: [SPACE('sp1', DAVE)], env: ` ${DAVE} ,, ${JEN} , ` });
    const sel = calls.filter((c) => /from plants p\b/.test(c.sql));
    expect(sel).toHaveLength(1);
    expect(sel[0].params).toEqual([[DAVE, JEN]]);
  });

  it('binds the EMPTY list when the env is unset (fail closed: each Space narrows to its owner in SQL)', async () => {
    const { calls } = await drive({ plantings: [], spaces: [SPACE('sp1', DAVE)], env: undefined });
    expect(calls.find((c) => /from plants p\b/.test(c.sql)).params).toEqual([[]]);
  });

  it('is still the first statement of the run, so db-ready still times the cold resume', async () => {
    const { calls, lines } = await drive({ plantings: [P('a')], spaces: [SPACE('sp1', DAVE)] });
    expect(calls[0].sql).toMatch(/from plants p\b/);
    expect(msgs(lines, 'db-ready')[0].rows).toBe(1);
  });
});

describe('assignees and unassigned plantings follow the planting\'s own Space household', () => {
  it('keeps a household assignee, and gives an unassigned planting to the Space owner', async () => {
    const { writes, lines } = await drive({
      plantings: [P('a', { assignee_user_id: JEN }), P('b')], spaces: [SPACE('sp1', DAVE)] });
    expect(users(writes)).toEqual([DAVE, JEN]);
    expect(msgs(lines, 'assignee-outside-household')).toHaveLength(0);
    expect(msgs(lines, 'household-scope-degraded')).toHaveLength(0);
    expect(msgs(lines, 'space-owner-missing')).toHaveLength(0);
  });

  it('drops an assignee outside the household: the planting goes to the Space owner, and it is logged', async () => {
    const { writes, lines, plantings } = await drive({
      plantings: [P('a', { assignee_user_id: STRANGER }), P('b', { assignee_user_id: JEN })], spaces: [SPACE('sp1', DAVE)] });
    expect(users(writes)).toEqual([DAVE, JEN]);
    expect(writes.map((w) => w.user)).not.toContain(STRANGER);
    expect(plantings[0].assignee_user_id).toBeNull();
    expect(msgs(lines, 'assignee-outside-household')).toEqual([
      expect.objectContaining({ space_id: 'sp1', count: 1, plant_ids: ['a'] })]);
  });

  it('a Jen assignment in a Space Jen is NOT a member of is dropped (the household is per Space)', async () => {
    // sp2 is owned by someone outside GARDEN_HOUSEHOLD_IDS, so its household is that owner alone.
    const { writes, lines } = await drive({
      plantings: [P('a', { assignee_user_id: JEN }), P('b', { workspace_id: 'sp2', assignee_user_id: JEN })],
      spaces: [SPACE('sp1', DAVE), SPACE('sp2', STRANGER)] });
    expect(users(writes)).toEqual([JEN, STRANGER]);
    expect(msgs(lines, 'assignee-outside-household')).toEqual([
      expect.objectContaining({ space_id: 'sp2', count: 1, plant_ids: ['b'] })]);
    expect(msgs(lines, 'household-scope-degraded')).toEqual([
      expect.objectContaining({ space_id: 'sp2', reason: 'owner-not-in-household', members: 1, assignees_excluded: 1 })]);
  });

  it('an unowned Space owns nothing: no fallback to OWNER_FALLBACK_SUB, plans go to __UNASSIGNED__, logged', async () => {
    vi.stubEnv('OWNER_FALLBACK_SUB', DAVE);
    for (const blank of [null, '', '   ']) {
      const { writes, lines } = await drive({
        plantings: [P('a'), P('b', { assignee_user_id: DAVE })], spaces: [SPACE('sp1', blank)] });
      expect(users(writes), `created_by=${JSON.stringify(blank)}`).toEqual(['__UNASSIGNED__']);
      expect(msgs(lines, 'space-owner-missing')).toEqual([expect.objectContaining({ space_id: 'sp1', plantings: 2 })]);
      expect(msgs(lines, 'assignee-outside-household')[0]).toEqual(expect.objectContaining({ space_id: 'sp1', count: 1 }));
      vi.restoreAllMocks();
    }
  });

  it('a planting whose workspace_id names no Space keeps no assignee', async () => {
    const { writes, lines } = await drive({
      plantings: [P('a', { workspace_id: 'sp-gone', assignee_user_id: DAVE })], spaces: [SPACE('sp1', DAVE)] });
    expect(users(writes)).toEqual(['__UNASSIGNED__']);
    expect(msgs(lines, 'space-owner-missing')).toEqual([expect.objectContaining({ space_id: 'sp-gone', plantings: 1 })]);
  });
});

describe('household-scope-degraded — named whenever a Space narrows to its owner alone', () => {
  it.each([
    ['unset env', undefined, 'env-missing'],
    ['whitespace env', ' , ', 'env-missing'],
    ['owner absent from the list', `${JEN},${STRANGER}`, 'owner-not-in-household'],
    ['a one-entry list', DAVE, 'env-single-entry'],
  ])('%s', async (_, env, reason) => {
    const { lines } = await drive({ plantings: [P('a')], spaces: [SPACE('sp1', DAVE)], env });
    expect(msgs(lines, 'household-scope-degraded')).toEqual([
      expect.objectContaining({ space_id: 'sp1', reason, members: 1, plantings: 1 })]);
  });

  it('is silent for a full household', async () => {
    const { lines } = await drive({ plantings: [P('a')], spaces: [SPACE('sp1', DAVE)] });
    expect(msgs(lines, 'household-scope-degraded')).toHaveLength(0);
  });
});
