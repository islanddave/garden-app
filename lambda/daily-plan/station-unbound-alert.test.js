// BUG-STATIONDEGRADESILENT-001 — a CONFIGURED station bound to NO Space pages ops, instead of leaving
// `boundSpaces: 0` in a CloudWatch line nobody reads.
//
// Driven through the real run(), because the condition only exists at the seam: station.js decides
// binding, handler.js counts it, and frostEval decides nothing about it at all. Every case below pins
// one clause of the gate, and each was mutation-checked (see _mainsync_20260918/stationdegrade.md).
// The unit suite mocks SQL (memory garden-lambda-unit-suite-proves-no-db-behavior): this proves the
// decision and the publish, not anything the database does.
import { describe, it, expect, vi, afterEach } from 'vitest';
import h from './handler.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;

const { run } = h;

const USER = 'user_dave';
const DATE = '2026-09-20';        // inside the §3-7 Sep 1 – Nov 15 frost season
const PM_HOUR = 15;               // an evaluating run (G3 window 14:00-17:59 ET)
const MAC = 'AA:BB:CC:DD:EE:FF';
const HOME = { id: 'sp1', postal_code: null, weather_lat: 42.5, weather_lng: -72.6 };   // at the gauge
const AWAY = { id: 'sp2', postal_code: null, weather_lat: 41.0, weather_lng: -70.0 };   // nowhere near it
const DEDUP_KEY = `station|${DATE}|station_unbound`;

const cfg = (extra = {}) => JSON.stringify([{ mac: MAC, tz: 'America/New_York', lat: 42.5, lng: -72.6, ...extra }]);
const STATION_RAW = { mac: MAC, records: [{ dateutc: Date.parse('2026-09-20T18:00:00Z'), tempf: 55, dailyrainin: 0 }] };

const planting = (id, spaceId) => withCoverFlags({
  id, name: `pepper ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: 'pepper', genus: null, project: 'Garden',
  project_status: 'active', workspace_id: spaceId, crop_type_slug: 'pepper', covered: false,
  assignee_user_id: USER, db_cadence: null, last_water: '2026-09-19', last_fert: '2026-09-01',
  substrate_start: '2026-05-01', transplant_at: null,
});

// Plantings in BOTH Spaces by default, so the per-Space frost block runs twice and the per-run dedup key
// is load-bearing rather than trivially satisfied.
function pgStub({ spaces = [HOME, AWAY], plantings = [planting('p1', 'sp1'), planting('p2', 'sp2')] } = {}) {
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

// A mild night (60F, lows 58-60) so no FROST alert can fire: every publish in this file is the station one.
async function drive(opts = {}) {
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
    fetchStation: 'fetchStation' in opts ? opts.fetchStation : async () => null,
    publishAlert, etHour: opts.etHour ?? PM_HOUR, event: {},
  });
  return { pg, publishAlert };
}

const logLines = (spy) => spy.mock.calls
  .map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const stationCalls = (publishAlert) => publishAlert.mock.calls.map(([a]) => a).filter((a) => /station_unbound/.test(a.message || ''));

function quiet() {
  return { log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    err: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}) };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('BUG-STATIONDEGRADESILENT-001 — a configured station bound to no Space raises ONE ops alert', () => {
  it('(a) configured + zero Spaces bound -> exactly one alert across two Spaces, on the ops topic, with the per-run dedup key', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', cfg());
    const { log } = quiet();
    const { publishAlert, pg } = await drive();                       // fetchStation -> null: the AWN-outage shape
    expect(publishAlert).toHaveBeenCalledTimes(1);
    const [call] = publishAlert.mock.calls.map(([a]) => a);
    expect(call.topic).toBe('ops');                                    // email-only topic, same as frost_eval_degraded
    expect(call.subject).toMatch(/^[\x20-\x7E]+$/);                     // SNS Subject must be ASCII
    expect(call.message).toContain('station_unbound');
    expect(call.message).toContain(MAC);                               // the configured station id
    expect(call.message).toContain('bound to 0 of 2 Space(s)');
    expect(call.message).toContain('the station fetch returned nothing');
    const published = logLines(log).filter((l) => l.msg === 'station-unbound alert PUBLISHED');
    expect(published).toHaveLength(1);
    expect(published[0].dedup_key).toBe(DEDUP_KEY);
    expect(pg.writes.length).toBeGreaterThan(0);                       // the plan is still written
  });

  it('(b) no station configured -> no alert, even though nothing is bound', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', '');
    quiet();
    const { publishAlert } = await drive();
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('(c) the station binds the only Space -> no alert', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', cfg());
    const { log } = quiet();
    const { publishAlert } = await drive({ pgOpts: { spaces: [HOME], plantings: [planting('p1', 'sp1')] }, fetchStation: async () => STATION_RAW });
    expect(logLines(log).find((l) => l.msg === 'station').boundSpaces).toBe(1);   // the fixture really binds
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('(c) partial: one Space bound, one remote Space unbound -> no alert (a Space away from the gauge is correctly unbound)', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', cfg());
    const { log } = quiet();
    const { publishAlert } = await drive({ fetchStation: async () => STATION_RAW });
    expect(logLines(log).find((l) => l.msg === 'station').boundSpaces).toBe(1);
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('(d) deriveStation THREW and the guard caught it -> the alert still fires, names station_derive_failed, and the plan survives', async () => {
    // The live throw path: an invalid tz in the hand-edited AWN_STATIONS_JSON reaches Intl. lat/lng DO match
    // HOME, so the derive failure is the only thing standing between this run and a bound station.
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', cfg({ tz: 'Not/AZone' }));
    const { err } = quiet();
    const { publishAlert, pg } = await drive({ fetchStation: async () => STATION_RAW });
    expect(logLines(err).some((l) => l.degraded === 'station_derive_failed')).toBe(true);   // the guard caught it
    expect(publishAlert).toHaveBeenCalledTimes(1);
    const { message } = publishAlert.mock.calls[0][0];
    expect(message).toContain('station_derive_failed');
    expect(message).toMatch(/Invalid time zone/i);                     // the caught error travels into the body
    expect(message).toContain('Cause: deriveStation threw');
    expect(message).toContain(MAC);
    expect(pg.writes.length).toBeGreaterThan(0);
  });

  it('names the per-Space weather and hydrology degrades that fired in the same run', async () => {
    // Context, not cause: neither fetch can unbind a station (binding reads only the station and the Space
    // coordinates). A throwing weather fetch ALSO raises frost_eval_degraded, as it always has.
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', cfg());
    quiet();
    const publishAlert = vi.fn(async () => ({ messageId: 'mid-1' }));
    await run({
      pg: pgStub({ spaces: [HOME], plantings: [planting('p1', 'sp1')] }), today: DATE, dryRun: false,
      geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
      fetchNWS: async () => { throw new Error('nws 503'); },
      fetchPrecip: async () => { throw new Error('open-meteo 503'); },
      fetchStation: async () => null, publishAlert, etHour: PM_HOUR, event: {},
    });
    const calls = stationCalls(publishAlert);
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('weather_fetch_failed (space sp1)');
    expect(calls[0].message).toContain('hydrology_fetch_failed (space sp1)');
    expect(publishAlert.mock.calls.some(([a]) => /frost_eval_degraded/.test(a.message))).toBe(true);
  });
});

describe('BUG-STATIONDEGRADESILENT-001 — the gate is frost_eval_degraded\'s gate, clause for clause', () => {
  it('outside frost season -> no alert', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', cfg());
    quiet();
    const { publishAlert } = await drive({ today: '2026-07-04' });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('a non-evaluating run (02:00 ET) -> no alert', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', cfg());
    quiet();
    const { publishAlert } = await drive({ etHour: 2 });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('FROST_ALERT_ENABLED unset -> no alert', async () => {
    vi.stubEnv('AWN_STATIONS_JSON', cfg());
    quiet();
    const { publishAlert } = await drive();
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('a dry run -> no alert', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', cfg());
    quiet();
    const { publishAlert } = await drive({ dryRun: true });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('no publisher injected -> the run completes (nothing to call, nothing thrown)', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', cfg());
    quiet();
    const { pg } = await drive({ publishAlert: null });
    expect(pg.writes.length).toBeGreaterThan(0);
  });

  it('no Spaces at all -> no alert (nothing to bind is not an outage)', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', cfg());
    quiet();
    const { publishAlert } = await drive({ pgOpts: { spaces: [], plantings: [planting('p1', 'sp1')] } });
    // With no Space row there is no weather and no hydrology either, so frost_eval_degraded and (since
    // BUG-HYDROLOGYNULLSILENT-001) frost_advisory_degraded rightly fire; only ours must not.
    expect(publishAlert.mock.calls.map(([a]) => a.message)).toEqual([
      expect.stringContaining('frost_eval_degraded'), expect.stringContaining('frost_advisory_degraded')]);
    expect(stationCalls(publishAlert)).toHaveLength(0);
  });

  it('a publish failure fails LOUD after the plan is written, and is not recorded as sent', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('AWN_STATIONS_JSON', cfg());
    const { log, err } = quiet();
    const pg = pgStub();
    const boom = vi.fn(async () => { throw new Error('sns down'); });
    await expect(drive({ pg, publishAlert: boom })).rejects.toThrow(/frost alert publish failed/);
    expect(pg.writes.length).toBeGreaterThan(0);
    expect(logLines(err).some((l) => l.msg === 'station-unbound alert publish FAILED' && l.dedup_key === DEDUP_KEY)).toBe(true);
    expect(logLines(log).some((l) => l.msg === 'station-unbound alert PUBLISHED')).toBe(false);
  });
});
