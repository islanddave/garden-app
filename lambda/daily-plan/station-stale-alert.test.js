// BUG-STATIONSTALESILENT-001 — a station that BINDS but has stopped reporting (newest reading older than
// FRESHNESS_MAX_MIN) pages ops, instead of counting in boundSpaces and staying silent.
//
// Driven through the real run(), because the condition only exists at the seam: station.js decides `fresh`
// and binding, handler.js counts them. The clock is PINNED: handler calls deriveStation with Date.now(), so
// a fixture record's freshness is otherwise decided by the day the suite happens to run. Only Date is faked;
// timers stay real. The unit suite mocks SQL (memory garden-lambda-unit-suite-proves-no-db-behavior): this
// proves the decision and the publish, not anything the database does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import h from './handler.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;

const { run } = h;

const USER = 'user_dave';
const DATE = '2026-09-20';        // inside the §3-7 Sep 1 – Nov 15 frost season
// V5-STATIONHEALTHYEAR-001: the FIRST evaluating run (14:00 ET), the only run that may send a station alert.
// This was 15 (any evaluating run) before the once-a-day cap; at 15 every positive case below now goes red.
const PM_HOUR = 14;
const MAC = 'AA:BB:CC:DD:EE:FF';
const HOME = { id: 'sp1', postal_code: null, weather_lat: 42.5, weather_lng: -72.6 };    // at the gauge
const HOME2 = { id: 'sp2', postal_code: null, weather_lat: 42.5, weather_lng: -72.6 };   // also at the gauge
const AWAY = { id: 'sp3', postal_code: null, weather_lat: 41.0, weather_lng: -70.0 };    // nowhere near it
const DEDUP_KEY = `station|${DATE}|station_stale`;

const NEWEST = Date.parse('2026-09-20T18:00:00Z');
const FRESH_NOW = NEWEST + 5 * 60000;       // newest reading 5 min old
const STALE_NOW = NEWEST + 120 * 60000;     // 120 min old, past AWN_FRESHNESS_MAX_MIN (90)

const CFG = JSON.stringify([{ mac: MAC, tz: 'America/New_York', lat: 42.5, lng: -72.6 }]);
const STATION_RAW = { mac: MAC, records: [{ dateutc: NEWEST, tempf: 55, dailyrainin: 0 }] };

const planting = (id, spaceId) => withCoverFlags({
  id, name: `pepper ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: 'pepper', genus: null, project: 'Garden',
  project_status: 'active', workspace_id: spaceId, crop_type_slug: 'pepper', covered: false,
  assignee_user_id: USER, db_cadence: null, last_water: '2026-09-19', last_fert: '2026-09-01',
  substrate_start: '2026-05-01', transplant_at: null,
});

function pgStub({ spaces = [HOME], plantings = [planting('p1', 'sp1')] } = {}) {
  const writes = [];
  return {
    writes,
    query: vi.fn(async (sql, params) => {
      if (/insert into daily_plan/.test(sql)) writes.push(JSON.parse(params[2]));
      if (/from plants/.test(sql)) return { rows: plantings };
      if (/from spaces/.test(sql)) return { rows: spaces };
      return { rows: [] };
    }),
  };
}

// A mild night (60F) and a healthy D1..D3 window, so no frost alert and no frost_eval/advisory degrade can
// fire: every publish in this file is a station one.
async function drive(opts = {}) {
  vi.setSystemTime(opts.now ?? STALE_NOW);
  const pg = opts.pg || pgStub(opts.pgOpts);
  const publishAlert = opts.publishAlert === null ? undefined : (opts.publishAlert || vi.fn(async () => ({ messageId: 'mid-1' })));
  await run({
    pg, today: opts.today || DATE, dryRun: opts.dryRun ?? false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 60, highToday: 75, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => ({
      forecast_lows: [58, 59, 60], forecast_dates: ['2026-09-21', '2026-09-22', '2026-09-23'],
      recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
      tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0, hourly_frost: null,
    }),
    fetchStation: async () => STATION_RAW,
    publishAlert, etHour: opts.etHour ?? PM_HOUR, event: {},
  });
  return { pg, publishAlert };
}

const logLines = (spy) => spy.mock.calls
  .map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const staleCalls = (publishAlert) => publishAlert.mock.calls.map(([a]) => a).filter((a) => /station_stale/.test(a.message || ''));

function quiet() {
  return { log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    err: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}) };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.stubEnv('AWN_STATIONS_JSON', CFG); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('BUG-STATIONSTALESILENT-001 — a bound station that stopped reporting raises ONE ops alert', () => {
  it('(a) bound + stale -> exactly one alert, on the ops topic, naming the age, with the per-run dedup key', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const { log } = quiet();
    const { publishAlert, pg } = await drive();
    const st = logLines(log).find((l) => l.msg === 'station');
    expect(st).toMatchObject({ present: true, boundSpaces: 1, fresh: false, dataAgeMin: 120 });   // the fixture really is bound AND stale
    expect(publishAlert).toHaveBeenCalledTimes(1);
    const [call] = publishAlert.mock.calls.map(([a]) => a);
    expect(call.topic).toBe('ops');                                    // email-only topic, same as station_unbound
    expect(call.subject).toBe('Garden ops - weather station STALE');
    expect(call.subject).toMatch(/^[\x20-\x7E]+$/);                     // SNS Subject must be ASCII
    expect(call.message).toContain('station_stale');
    expect(call.message).toContain(MAC);
    expect(call.message).toContain('bound to 1 of 1 Space(s)');
    expect(call.message).toContain('newest reading is 120 min old (limit 90)');
    expect(call.message).not.toMatch(/42\.5|-72\.6/);                  // no coordinates in the email
    const published = logLines(log).filter((l) => l.msg === 'station-stale alert PUBLISHED');
    expect(published).toHaveLength(1);
    expect(published[0].dedup_key).toBe(DEDUP_KEY);
    expect(pg.writes.length).toBeGreaterThan(0);                       // the plan is still written
  });

  it('(b) bound + fresh -> no alert', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const { log } = quiet();
    const { publishAlert } = await drive({ now: FRESH_NOW });
    expect(logLines(log).find((l) => l.msg === 'station')).toMatchObject({ boundSpaces: 1, fresh: true });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('(c) stale but bound to NO Space -> station_unbound only, never both in one run', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { publishAlert } = await drive({ pgOpts: { spaces: [AWAY], plantings: [planting('p3', 'sp3')] } });
    expect(publishAlert).toHaveBeenCalledTimes(1);
    expect(publishAlert.mock.calls[0][0].message).toContain('station_unbound');
    expect(staleCalls(publishAlert)).toHaveLength(0);
  });

  it('(d) two Spaces bound to the same stale station -> ONE alert per run', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { publishAlert } = await drive({ pgOpts: { spaces: [HOME, HOME2], plantings: [planting('p1', 'sp1'), planting('p2', 'sp2')] } });
    expect(staleCalls(publishAlert)).toHaveLength(1);
    expect(staleCalls(publishAlert)[0].message).toContain('bound to 2 of 2 Space(s)');
  });
});

// V5-STATIONHEALTHYEAR-001 changed station_unbound's gate on purpose, and this one with it: year-round, flag-free,
// first evaluating run only. The two cases that used to assert "outside season -> none" and "flag unset -> none"
// now assert the opposite.
describe('BUG-STATIONSTALESILENT-001 — the gate is station_unbound\'s gate, clause for clause', () => {
  it('outside frost season -> STILL one alert (year-round)', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { publishAlert } = await drive({ today: '2026-07-04' });
    expect(publishAlert).toHaveBeenCalledTimes(1);
    expect(staleCalls(publishAlert)).toHaveLength(1);
  });

  it('a non-evaluating run (02:00 ET) -> no alert', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { publishAlert } = await drive({ etHour: 2 });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('the later evaluating runs (15, 16, 17 ET) -> no alert: one email per day, from the 14:00 run', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    for (const etHour of [15, 16, 17]) {
      const { publishAlert } = await drive({ etHour });
      expect(publishAlert).not.toHaveBeenCalled();
    }
  });

  it('FROST_ALERT_ENABLED unset -> STILL one alert (no switch; turning frost off must not silence the station)', async () => {
    quiet();
    const { publishAlert } = await drive();
    expect(publishAlert).toHaveBeenCalledTimes(1);
    expect(staleCalls(publishAlert)).toHaveLength(1);
  });

  it('a dry run -> no alert', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { publishAlert } = await drive({ dryRun: true });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('no publisher injected -> the run completes (nothing to call, nothing thrown)', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { pg } = await drive({ publishAlert: null });
    expect(pg.writes.length).toBeGreaterThan(0);
  });

  it('a publish failure fails LOUD after the plan is written, and is not recorded as sent', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const { log, err } = quiet();
    const pg = pgStub();
    const boom = vi.fn(async () => { throw new Error('sns down'); });
    await expect(drive({ pg, publishAlert: boom })).rejects.toThrow(/frost alert publish failed \(1\)/);
    expect(pg.writes.length).toBeGreaterThan(0);
    expect(logLines(err).some((l) => l.msg === 'station-stale alert publish FAILED' && l.dedup_key === DEDUP_KEY)).toBe(true);
    expect(logLines(log).some((l) => l.msg === 'station-stale alert PUBLISHED')).toBe(false);
  });
});
