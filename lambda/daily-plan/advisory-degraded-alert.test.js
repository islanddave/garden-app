// BUG-HYDROLOGYNULLSILENT-001 — a frost evaluation with ZERO usable D1..D3 forecast lows in season pages ops,
// instead of reading as "no frost ahead". frostEval.test.js proves the flag; this file proves the seam: that
// the flag travels from a real run() to one ops publish, under frost_eval_degraded's gate, clause for clause.
// Both live shapes are driven: fetchPrecip -> null (the shipped fetcher's catch-all) and fetchPrecip -> an
// object with no lows (what 2026-09-02 19:30Z logged: forecastCoveredDays 0 with hy:true).
// The unit suite mocks SQL (memory garden-lambda-unit-suite-proves-no-db-behavior): this proves the decision
// and the publish, not anything the database does.
import { describe, it, expect, vi, afterEach } from 'vitest';
import h from './handler.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;

const { run } = h;

const USER = 'user_dave';
const DATE = '2026-09-20';        // inside the §3-7 Sep 1 – Nov 15 frost season
const PM_HOUR = 15;               // an evaluating run (G3 window 14:00-17:59 ET)
const HOME = { id: 'sp1', postal_code: null, weather_lat: 42.5, weather_lng: -72.6 };
const SHED = { id: 'sp2', postal_code: null, weather_lat: 41.0, weather_lng: -70.0 };
const DEDUP_KEY = `sp1|${DATE}|frost_advisory_degraded`;

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

// Open-Meteo's bag with every rain field present and the D1..D3 lows as given.
const hydro = (lows) => ({
  forecast_lows: lows, forecast_dates: ['2026-09-21', '2026-09-22', '2026-09-23'],
  recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
  tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0, hourly_frost: null,
});

// A mild night (60F) so no FROST alert can fire: every publish in this file is an ops one.
async function drive(opts = {}) {
  const pg = opts.pg || pgStub(opts.pgOpts);
  const publishAlert = opts.publishAlert === null ? undefined : (opts.publishAlert || vi.fn(async () => ({ messageId: 'mid-1' })));
  await run({
    pg, today: opts.today || DATE, dryRun: opts.dryRun ?? false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: 'fetchNWS' in opts ? opts.fetchNWS : async () => ({ tonightLow: 60, highToday: 75, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: 'fetchPrecip' in opts ? opts.fetchPrecip : async () => null,   // the shipped failure shape
    fetchStation: async () => null,
    publishAlert, etHour: opts.etHour ?? PM_HOUR, event: {},
  });
  return { pg, publishAlert };
}

const logLines = (spy) => spy.mock.calls
  .map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const advisoryCalls = (publishAlert) => publishAlert.mock.calls.map(([a]) => a).filter((a) => /frost_advisory_degraded/.test(a.message || ''));

function quiet() {
  return { log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    err: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}) };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('BUG-HYDROLOGYNULLSILENT-001 — a blind D1..D3 advisory window raises ONE ops alert per Space', () => {
  it('(a) fetchPrecip -> null: exactly one alert, on the ops topic, with the per-Space dedup key, and the plan is written', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const { log } = quiet();
    const { publishAlert, pg } = await drive();
    expect(publishAlert).toHaveBeenCalledTimes(1);
    const [call] = publishAlert.mock.calls.map(([a]) => a);
    expect(call.topic).toBe('ops');                                    // email-only topic, same as frost_eval_degraded
    expect(call.subject).toBe('Garden ops - frost advisory DEGRADED');
    expect(call.subject).toMatch(/^[\x20-\x7E]+$/);                     // SNS Subject must be ASCII
    expect(call.message).toContain('frost_advisory_degraded');
    expect(call.message).toContain('space sp1');
    expect(call.message).toContain('3-night advisory window');
    expect(call.message).toContain('the Open-Meteo hydrology fetch returned nothing');
    expect(call.message).toContain('UNKNOWN, not safe');
    expect(call.message).toContain('imminent check still ran on the NWS low');
    expect(call.message).not.toMatch(/42\.5|-72\.6/);                  // no coordinates in the email
    const published = logLines(log).filter((l) => l.msg === 'frost-advisory-degraded alert PUBLISHED');
    expect(published).toHaveLength(1);
    expect(published[0].dedup_key).toBe(DEDUP_KEY);
    expect(pg.writes.length).toBeGreaterThan(0);
  });

  it('(b) fetchPrecip -> an object with no lows (the live 2026-09-02 shape): the alert fires and names that cause', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const { log } = quiet();
    const { publishAlert } = await drive({ fetchPrecip: async () => hydro([null, null, null]) });
    expect(logLines(log).find((l) => l.msg === 'frost-eval').forecastCoveredDays).toBe(0);   // the logged shape
    expect(publishAlert).toHaveBeenCalledTimes(1);
    expect(publishAlert.mock.calls[0][0].message).toContain('carried no temperature_2m_min');
  });

  it('(c) a healthy window -> no alert', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { publishAlert } = await drive({ fetchPrecip: async () => hydro([58, 59, 60]) });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('(c) partial coverage (1 of 3 nights) -> no alert: the tier still evaluated', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { publishAlert } = await drive({ fetchPrecip: async () => hydro([null, 58, null]) });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('(d) weather AND hydrology both gone -> frost_eval_degraded, then this alert saying tonight is missing too', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { publishAlert } = await drive({ fetchNWS: async () => null });
    expect(publishAlert.mock.calls.map(([a]) => a.message)).toEqual([
      expect.stringContaining('frost_eval_degraded'), expect.stringContaining('frost_advisory_degraded')]);
    expect(advisoryCalls(publishAlert)[0].message).toContain('Tonight\'s low is ALSO missing');
  });

  it('(e) two blind Spaces -> one alert EACH, like frost_eval_degraded (hydrology is fetched per Space)', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { publishAlert } = await drive({ pgOpts: { spaces: [HOME, SHED], plantings: [planting('p1', 'sp1'), planting('p2', 'sp2')] } });
    const msgs = advisoryCalls(publishAlert).map((a) => a.message);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain('space sp1');
    expect(msgs[1]).toContain('space sp2');
  });
});

describe('BUG-HYDROLOGYNULLSILENT-001 — the gate is frost_eval_degraded\'s gate, clause for clause', () => {
  it('outside frost season -> no alert', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { publishAlert } = await drive({ today: '2026-07-04' });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('a non-evaluating run (02:00 ET) -> no alert', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const { publishAlert } = await drive({ etHour: 2 });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('FROST_ALERT_ENABLED unset -> no alert', async () => {
    quiet();
    const { publishAlert } = await drive();
    expect(publishAlert).not.toHaveBeenCalled();
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
    expect(logLines(err).some((l) => l.msg === 'frost-advisory-degraded alert publish FAILED' && l.dedup_key === DEDUP_KEY)).toBe(true);
    expect(logLines(log).some((l) => l.msg === 'frost-advisory-degraded alert PUBLISHED')).toBe(false);
  });
});
