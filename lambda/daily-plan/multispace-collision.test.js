// V5-SPACEISOLATION-001 — the multi-space 6a collision guard (handler.js firstGroupItems), driven through run().
//
// daily_plan is one row per (user_id, plan_date). A user with plantings in two Spaces gets one plan per Space, and
// before this guard the later Space's upsert replaced the earlier one's row whole. The guard keeps the FIRST group's
// items, unions alerts_sent, marks the row `multi_space_collision: true` and logs daily-plan-multispace-collision.
//
// The single-group row is byte-identical to before the guard: recorded on the base (51a97146) and replayed after it
// for one user flag off and on, two users in one Space, and two Spaces with two owners (lane C2 record-and-replay,
// project-state/_multispace-20261015/lanes/C2.md). The cases below pin the behaviour that replay cannot see.
//
// MUTATION LOG — 2026-10-16, lane t3-ms1-c2. Each applied alone, this file run, RED observed, handler.js restored:
//   * firstGroupItems always returns the incoming items (the second group overwrites)  -> 2 RED
//   * planWritten hoisted to module scope (survives a warm invocation)                  -> 4 RED (the two-run()
//     case alone, run with -t, reds by itself; the others red because the set leaks across this file's cases)
import { describe, it, expect, vi, afterEach } from 'vitest';
import handler from './handler.js';

const TODAY = '2026-10-02';
const SP_A = 'sp-a';
const SP_B = 'sp-b';
const DAVE = 'user_1';
const JEN = 'user_2';

const planting = (id, ws, who, crop = 'tomato') => ({
  id, name: crop, project_id: `pj-${ws}`, status: 'fruiting', container_type: 'in_ground',
  container_size: null, rain_exposed: null, variety: 'x', genus: null, project: 'Beds',
  project_status: 'active', workspace_id: ws, crop_type_slug: crop,
  covered: false, frost_covered_resolved: false, assignee_user_id: who,
  db_cadence: { crop, water_interval_days_inground: 3 },
  last_water: '2026-09-29', last_fert: '2026-08-01', substrate_start: '2026-05-01', transplant_at: null,
});
const space = (id, owner) => ({ id, postal_code: null, weather_lat: 42.5, weather_lng: -72.6, created_by: owner });

// One send already recorded for each Space today (readSpaceAlertsSent filters these by the Space prefix).
const SENT_A = { key: `${SP_A}|${TODAY}|imminent|1`, at: '2026-10-02T18:00:00.000Z' };
const SENT_B = { key: `${SP_B}|${TODAY}|imminent|1`, at: '2026-10-02T18:05:00.000Z' };

function mockPg({ plantings, spaces }) {
  return {
    query: vi.fn(async (sql) => {
      if (/from plants/.test(sql)) return { rows: plantings };
      if (/from spaces/.test(sql)) return { rows: spaces };
      if (/items->'alerts_sent'/.test(sql)) return { rows: [{ alerts_sent: [SENT_A] }, { alerts_sent: [SENT_B] }] };
      return { rows: [] };
    }),
  };
}

const upserts = (pg) => pg.query.mock.calls
  .filter(([sql]) => /insert into daily_plan/.test(sql))
  .map(([, params]) => ({ user: params[0], date: params[1], raw: params[2], items: JSON.parse(params[2]) }));
const backfills = (pg) => pg.query.mock.calls.filter(([sql]) => /update daily_plan/.test(sql)).map(([, p]) => p[0]);
const collisionLogs = (spy) => spy.mock.calls.map(([s]) => { try { return JSON.parse(s); } catch { return null; } })
  .filter((o) => o && o.msg === 'daily-plan-multispace-collision');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function drive(input) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const pg = mockPg(input);
  await handler.run({
    pg, today: TODAY, dryRun: false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 62, highToday: 78, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => ({
      forecast_lows: [null, null, null], forecast_dates: [null, null, null],
      recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
      tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0.2, settled_days: [],
    }),
    fetchStation: async () => null, publishAlert: vi.fn(async () => ({ messageId: 'm1' })),
    etHour: 2, event: { rainLog: false },
  });
  return pg;
}

describe('V5-SPACEISOLATION-001 — one user, two Spaces, one daily_plan row', () => {
  it('keeps the first group\'s items, unions alerts_sent, marks the row and logs once', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pg = await drive({
      plantings: [planting('a1', SP_A, DAVE), planting('b1', SP_B, DAVE, 'pepper')],
      spaces: [space(SP_A, DAVE), space(SP_B, DAVE)],
    });
    const rows = upserts(pg);
    expect(rows.map((r) => [r.user, r.date])).toEqual([[DAVE, TODAY], [DAVE, TODAY]]);
    const [first, second] = rows;
    expect(first.raw).toContain('"a1"');
    expect(first.raw).not.toContain('"b1"');
    expect(first.items).not.toHaveProperty('multi_space_collision');
    expect(first.items.alerts_sent).toEqual([SENT_A]);
    // the second write is the first group's row, with both Spaces' sends and the marker
    expect(second.items).toEqual({ ...first.items, alerts_sent: [SENT_A, SENT_B], multi_space_collision: true });
    expect(second.raw).not.toContain('"b1"');
    expect(collisionLogs(err)).toEqual([{ msg: 'daily-plan-multispace-collision', user: DAVE, plan_date: TODAY,
      first_space: SP_A, space: SP_B }]);
    // yesterday's rain is written by the group that kept the row only
    expect(backfills(pg)).toEqual([DAVE]);
  });

  it('flag off: no alerts_sent key appears on the collided row either', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pg = await drive({
      plantings: [planting('a1', SP_A, DAVE), planting('b1', SP_B, DAVE, 'pepper')],
      spaces: [space(SP_A, DAVE), space(SP_B, DAVE)],
    });
    const [first, second] = upserts(pg);
    expect(first.items).not.toHaveProperty('alerts_sent');
    expect(second.items).toEqual({ ...first.items, multi_space_collision: true });
    expect(collisionLogs(err)).toHaveLength(1);
  });

  it('two Spaces with two different owners do not collide', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pg = await drive({
      plantings: [planting('a1', SP_A, DAVE), planting('b1', SP_B, JEN, 'pepper')],
      spaces: [space(SP_A, DAVE), space(SP_B, JEN)],
    });
    const rows = upserts(pg);
    expect(rows.map((r) => r.user)).toEqual([DAVE, JEN]);
    expect(rows[1].raw).toContain('"b1"');
    for (const r of rows) expect(r.items).not.toHaveProperty('multi_space_collision');
    expect(collisionLogs(err)).toEqual([]);
  });

  it('two users in ONE Space are one group, never a collision', async () => {
    vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${DAVE},${JEN}`);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pg = await drive({
      plantings: [planting('a1', SP_A, DAVE), planting('a2', SP_A, JEN, 'pepper')],
      spaces: [space(SP_A, DAVE)],
    });
    const rows = upserts(pg);
    expect(rows.map((r) => r.user).sort()).toEqual([DAVE, JEN]);
    for (const r of rows) expect(r.items).not.toHaveProperty('multi_space_collision');
    expect(collisionLogs(err)).toEqual([]);
  });

  it('the seen set is per invocation: two run() calls in one module instance both write their own plan', async () => {
    // RIA I7: a module-scoped set would survive a warm Lambda, so the second hourly run would find its pair taken
    // and write the FIRST run's items back. Changed inputs make that visible.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pg1 = await drive({ plantings: [planting('a1', SP_A, DAVE)], spaces: [space(SP_A, DAVE)] });
    const pg2 = await drive({ plantings: [planting('a9', SP_A, DAVE, 'bean')], spaces: [space(SP_A, DAVE)] });
    const [r1] = upserts(pg1);
    const [r2] = upserts(pg2);
    expect(r1.raw).toContain('"a1"');
    expect(r2.raw).toContain('"a9"');
    expect(r2.raw).not.toContain('"a1"');
    expect(r2.items).not.toHaveProperty('multi_space_collision');
    expect(collisionLogs(err)).toEqual([]);
  });
});
