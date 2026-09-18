// V5-STATIONHEALTHYEAR-001 — the station-health alerts run YEAR-ROUND, send at most once per ET day (from the first
// evaluating run, 14:00 ET), read no frost flag, and gain a third condition: the console is online but the
// outdoor array went quiet (station.js arraySilence — the alkaline cold dropout Ambient's FAQ calls "Sensor Array
// Loses Signal At Night", or a dead array).
//
// The run() cases are driven through the real handler because every condition here only exists at the seam:
// station.js decides freshness, binding and silence; handler.js counts them and gates the publish. The clock is
// PINNED (Date only; timers stay real): handler derives the station with Date.now(), so a fixed-date record set
// would otherwise turn stale, or slide out of the 24 h silence window, on whatever day the suite runs. The unit
// suite mocks SQL (memory garden-lambda-unit-suite-proves-no-db-behavior): this proves the decisions and the
// publish calls, not anything the database or SNS does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import h from './handler.js';
import st from './station.js';
import fe from './frostEval.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;

const { run } = h;
const { arraySilence, deriveStation, ARRAY_SILENT_MIN_GAP_MIN } = st;
const { resolveFrostRun, FROST_RUN_START_HOUR, FROST_RUN_END_HOUR } = fe;

const USER = 'user_dave';
const DATE = '2026-09-20';            // in frost season; the out-of-season cases pass their own plan date
const WINTER = '2027-01-15';          // the season this row exists for
const CHECK_HOUR = 14;                // the first evaluating run of the ET day — the only one that may send
const MAC = 'AA:BB:CC:DD:EE:FF';
const HOME = { id: 'sp1', postal_code: null, weather_lat: 42.5, weather_lng: -72.6 };    // at the gauge
const HOME2 = { id: 'sp2', postal_code: null, weather_lat: 42.5, weather_lng: -72.6 };   // also at the gauge
const AWAY = { id: 'sp3', postal_code: null, weather_lat: 41.0, weather_lng: -70.0 };    // nowhere near it
const CFG = JSON.stringify([{ mac: MAC, tz: 'America/New_York', lat: 42.5, lng: -72.6 }]);
const DEDUP_KEY = `station|${DATE}|station_array_silent`;

const edt = (hhmm, day = DATE) => Date.parse(`${day}T${hhmm}:00-04:00`);
const NOW = edt('14:05');                         // the 14:00 ET run, five minutes in
const NEWEST = edt('14:00');                      // newest record 5 min old: FRESH
const STEP = 5 * 60000;

// 30 h of 5-minute records ending at `newest` (the live fetch holds ~72 h; 30 covers the 24 h window with
// margin). `omit` deletes fields over inclusive [from, to] ranges — absent keys, the shape a console with no
// array signal uploads.
function records({ omit = [], hours = 30, newest = NEWEST } = {}) {
  const out = [];
  for (let t = newest; t > newest - hours * 3600000; t -= STEP) {
    const r = { dateutc: t, tempf: 50, dailyrainin: 0 };
    for (const o of omit) if (t >= o.from && t <= o.to) for (const f of o.fields) delete r[f];
    out.push(r);
  }
  return out;
}
const OVERNIGHT = { from: edt('02:00'), to: edt('08:00'), fields: ['tempf', 'dailyrainin'] };   // 6 h, recovered

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

// A mild night and a healthy D1..D3 window, so no frost alert and no frost degrade fires unless a case asks
// for one: every other publish in this file is a station one.
async function drive(opts = {}) {
  vi.setSystemTime(opts.now ?? NOW);
  const pg = opts.pg || pgStub(opts.pgOpts);
  const publishAlert = opts.publishAlert === null ? undefined : (opts.publishAlert || vi.fn(async () => ({ messageId: 'mid-1' })));
  await run({
    pg, today: opts.today || DATE, dryRun: opts.dryRun ?? false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: opts.fetchNWS || (async () => ({ tonightLow: 60, highToday: 75, code: 1, unit: 'F', short: 'Clear' })),
    fetchPrecip: async () => ({
      forecast_lows: [58, 59, 60], forecast_dates: ['2026-09-21', '2026-09-22', '2026-09-23'],
      recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
      tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0, hourly_frost: null,
    }),
    fetchStation: async () => ({ mac: MAC, records: opts.records || records({ omit: [OVERNIGHT] }) }),
    publishAlert, etHour: opts.etHour ?? CHECK_HOUR, event: opts.event || {},
  });
  return { pg, publishAlert };
}

const logLines = (spy) => spy.mock.calls
  .map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const callsFor = (publishAlert, kind) => publishAlert.mock.calls.map(([a]) => a).filter((a) => (a.message || '').includes(kind));

function quiet() {
  return { log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    err: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}) };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.stubEnv('AWN_STATIONS_JSON', CFG); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('resolveFrostRun.firstOfDay — the once-a-day cap is the first evaluating run', () => {
  it('14:00 ET is the first evaluating run', () => {
    expect(resolveFrostRun({}, { etHour: 14 })).toMatchObject({ evaluate: true, slot: 'intraday-pm', firstOfDay: true });
  });

  it('the later evaluating runs evaluate but are not first', () => {
    for (const etHour of [15, 16, 17]) expect(resolveFrostRun({}, { etHour })).toMatchObject({ evaluate: true, firstOfDay: false });
  });

  it('runs outside the window are neither', () => {
    for (const etHour of [0, 2, 5, 9, 13, 18, 21]) expect(resolveFrostRun({}, { etHour })).toMatchObject({ evaluate: false, firstOfDay: false });
  });

  it('a forced, suppressed or hourless run is never first — a rehearsal cannot send a station alert', () => {
    expect(resolveFrostRun({ frostEval: true }, { etHour: 14 })).toMatchObject({ evaluate: true, slot: 'forced', firstOfDay: false });
    expect(resolveFrostRun({ frostEval: false }, { etHour: 14 })).toMatchObject({ evaluate: false, firstOfDay: false });
    expect(resolveFrostRun({}, {})).toMatchObject({ evaluate: false, firstOfDay: false });
  });
});

// The cap assumes the schedule HAS a run in the first hour of the window. The cron is fixed in UTC and the ET
// hour shifts with DST, so check both offsets. If a schedule edit ever drops that hour, firstOfDay is never true
// and every station alert goes silent with the suite still green — this is the test that stops that.
describe('the cap hour is actually scheduled (deploy-lambda.yml garden-daily-plan-hourly)', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const WF = readFileSync(join(ROOT, '.github/workflows/deploy-lambda.yml'), 'utf8');
  const m = WF.match(/ensure_rule garden-daily-plan-hourly 'cron\(([^)]*)\)'/);

  it('the rule is declared with a single minute, so each listed hour is ONE run', () => {
    expect(m).not.toBeNull();
    expect(m[1].split(/\s+/)[0]).toMatch(/^\d+$/);
  });

  it('in EDT and in EST, the earliest scheduled ET hour inside the evaluating window is FROST_RUN_START_HOUR', () => {
    const hoursField = m[1].split(/\s+/)[1];
    const utc = new Set();
    for (const part of hoursField.split(',')) {
      const [a, b] = part.split('-').map(Number);
      for (let x = a; x <= (Number.isFinite(b) ? b : a); x++) utc.add(x);
    }
    for (const offset of [4, 5]) {
      const et = [...utc].map((u) => (u - offset + 24) % 24)
        .filter((x) => x >= FROST_RUN_START_HOUR && x <= FROST_RUN_END_HOUR).sort((p, q) => p - q);
      expect(et.length).toBeGreaterThan(0);
      expect(et[0]).toBe(FROST_RUN_START_HOUR);
    }
  });
});

describe('arraySilence — the trailing-24 h outdoor gap, pure', () => {
  it('a healthy array: nothing silent, no gaps, 288 records in the window', () => {
    const s = arraySilence(records(), { nowMs: NOW });
    expect(s.silent).toEqual([]);
    expect(s.records).toBe(288);
    expect(s.gaps.tempf).toMatchObject({ missing: 0, longestMin: 0, missingNow: false });
    expect(s.gaps.dailyrainin).toMatchObject({ missing: 0, longestMin: 0, missingNow: false });
  });

  it('an overnight dropout that recovered by morning IS silent — the mode a newest-record test misses', () => {
    const s = arraySilence(records({ omit: [OVERNIGHT] }), { nowMs: NOW });
    expect(s.silent).toEqual(['tempf', 'dailyrainin']);
    expect(s.gaps.tempf).toEqual({ missing: 73, longestMin: 360, fromMs: edt('02:00'), toMs: edt('08:00'), missingNow: false });
    expect(s.gaps.dailyrainin.longestMin).toBe(360);
  });

  it('a dropout still running at the check is missing now', () => {
    const s = arraySilence(records({ omit: [{ from: edt('12:30'), to: NEWEST, fields: ['tempf'] }] }), { nowMs: NOW });
    expect(s.silent).toEqual(['tempf']);
    expect(s.gaps.tempf).toMatchObject({ longestMin: 90, missingNow: true });
  });

  it('missing now is the NEWEST record, not the longest gap: the night recovered, a new short gap is running', () => {
    const s = arraySilence(records({ omit: [OVERNIGHT, { from: edt('13:40'), to: NEWEST, fields: ['tempf'] }] }), { nowMs: NOW });
    expect(s.gaps.tempf).toMatchObject({ longestMin: 360, fromMs: edt('02:00'), missingNow: true });
    expect(s.gaps.dailyrainin).toMatchObject({ longestMin: 360, missingNow: false });
  });

  it(`the threshold is ${ARRAY_SILENT_MIN_GAP_MIN} min, first-missing to last-missing record`, () => {
    const at = (to) => arraySilence(records({ omit: [{ from: edt('02:00'), to: edt(to), fields: ['tempf'] }] }), { nowMs: NOW });
    expect(at('02:55').silent).toEqual([]);            // 55 min
    expect(at('02:55').gaps.tempf.longestMin).toBe(55);
    expect(at('03:00').silent).toEqual(['tempf']);     // 60 min
  });

  it('isolated missing samples never add up to a gap', () => {
    const recs = records();
    for (let i = 0; i < recs.length; i += 2) delete recs[i].tempf;   // every other record, all day
    const s = arraySilence(recs, { nowMs: NOW });
    expect(s.gaps.tempf.missing).toBe(144);
    expect(s.gaps.tempf.longestMin).toBe(0);
    expect(s.silent).toEqual([]);
  });

  it('only the trailing 24 h counts: an older gap is ignored, a straddling one counts its in-window part', () => {
    const old = arraySilence(records({ omit: [{ from: edt('08:00', '2026-09-19'), to: edt('13:00', '2026-09-19'), fields: ['tempf'] }] }), { nowMs: NOW });
    expect(old.silent).toEqual([]);
    const straddle = arraySilence(records({ omit: [{ from: edt('12:00', '2026-09-19'), to: edt('16:00', '2026-09-19'), fields: ['tempf'] }] }), { nowMs: NOW });
    expect(straddle.gaps.tempf).toMatchObject({ longestMin: 115, fromMs: edt('14:05', '2026-09-19') });
    expect(straddle.silent).toEqual(['tempf']);
  });

  it('each field is judged on its own: rain alone can be silent', () => {
    const s = arraySilence(records({ omit: [{ from: edt('09:00'), to: edt('11:00'), fields: ['dailyrainin'] }] }), { nowMs: NOW });
    expect(s.silent).toEqual(['dailyrainin']);
    expect(s.gaps.tempf.missing).toBe(0);
  });

  it('null, a string and an absent key are all "no reading"; 0 is a reading', () => {
    const recs = records();
    const inGap = recs.filter((r) => r.dateutc >= edt('09:00') && r.dateutc <= edt('11:00'));
    inGap.forEach((r, i) => { r.tempf = [null, '50', undefined][i % 3]; r.dailyrainin = 0; });
    const s = arraySilence(recs, { nowMs: NOW });
    expect(s.silent).toEqual(['tempf']);
    expect(s.gaps.tempf.longestMin).toBe(120);
  });

  it('of two equally long gaps the LATER (more recent) one is reported', () => {
    const s = arraySilence(records({ omit: [
      { from: edt('02:00'), to: edt('03:00'), fields: ['tempf'] },
      { from: edt('09:00'), to: edt('10:00'), fields: ['tempf'] },
    ] }), { nowMs: NOW });
    expect(s.gaps.tempf).toMatchObject({ longestMin: 60, fromMs: edt('09:00'), toMs: edt('10:00'), missingNow: false });
  });

  it('unusable input returns null (unknown), never an all-clear', () => {
    expect(arraySilence(null, { nowMs: NOW })).toBeNull();
    expect(arraySilence(records(), {})).toBeNull();
  });

  it('deriveStation carries it, and a throw inside it costs only the silence field — never the gauge', () => {
    const recs = records();
    // A record whose dailyrainin read throws ONLY when arraySilence is on the stack: every other reader in
    // deriveStation sees a normal value, so the one throw is the one the try/catch in deriveStation must contain.
    recs[0] = new Proxy(recs[0], { get(t, k) {
      if (k === 'dailyrainin' && /\bat arraySilence\b/.test(new Error().stack || '')) throw new Error('boom');
      return t[k];
    } });
    const s = deriveStation({ mac: MAC, records: recs }, { nowMs: NOW });
    expect(s).not.toBeNull();
    expect(s.fresh).toBe(true);
    expect(s.todayPrecipIn).toBe(0);
    expect(s.arraySilence).toBeNull();
    expect(deriveStation({ mac: MAC, records: records() }, { nowMs: NOW }).arraySilence.silent).toEqual([]);
  });
});

describe('station_array_silent — console online, outdoor array quiet: ONE ops alert from the 14:00 run', () => {
  it('(a) an overnight dropout -> one alert on the ops topic naming both fields, the gap, the batteries, and the key', async () => {
    const { log } = quiet();
    const { publishAlert, pg } = await drive();
    const stLine = logLines(log).find((l) => l.msg === 'station');
    expect(stLine).toMatchObject({ boundSpaces: 1, fresh: true, tempF: 50, arraySilent: ['tempf', 'dailyrainin'],
      arrayGapMin: { tempf: 360, dailyrainin: 360 } });                  // bound, FRESH, newest reading fine
    expect(publishAlert).toHaveBeenCalledTimes(1);
    const [call] = publishAlert.mock.calls.map(([a]) => a);
    expect(call.topic).toBe('ops');
    expect(call.subject).toBe('Garden ops - weather station ARRAY SILENT');
    expect(call.subject).toMatch(/^[\x20-\x7E]+$/);                     // SNS Subject must be ASCII
    expect(call.message).toContain('station_array_silent');
    expect(call.message).toContain(MAC);
    expect(call.message).toContain('newest reading 5 min old');
    expect(call.message).toContain('outdoor temperature (tempf) missing for 6 h 0 min, 02:00-08:00, and reporting at this check');
    expect(call.message).toContain('rain gauge (dailyrainin) missing for 6 h 0 min, 02:00-08:00, and reporting at this check');
    expect(call.message).toContain(`${ARRAY_SILENT_MIN_GAP_MIN} min or more in the 24 h`);
    expect(call.message).toMatch(/lithium AAs/);
    expect(call.message).toMatch(/\+10F/);
    expect(call.message).toContain('no station floor');
    expect(call.message).toContain('rain is forecast-only');
    expect(call.message).not.toMatch(/42\.5|-72\.6/);                  // no coordinates in the email
    const published = logLines(log).filter((l) => l.msg === 'station-array-silent alert PUBLISHED');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ dedup_key: DEDUP_KEY, silent: ['tempf', 'dailyrainin'], gap_min: { tempf: 360, dailyrainin: 360 } });
    expect(pg.writes.length).toBeGreaterThan(0);                       // the plan is still written
  });

  it('(b) a dropout still running says so', async () => {
    quiet();
    const { publishAlert } = await drive({ records: records({ omit: [{ from: edt('11:00'), to: NEWEST, fields: ['tempf', 'dailyrainin'] }] }) });
    expect(callsFor(publishAlert, 'station_array_silent')).toHaveLength(1);
    expect(publishAlert.mock.calls[0][0].message).toContain('missing for 3 h 0 min, 11:00-14:00, and missing at this check');
  });

  it('(c) a healthy array -> no alert, and the station line still reports the zero gaps', async () => {
    const { log } = quiet();
    const { publishAlert } = await drive({ records: records() });
    expect(logLines(log).find((l) => l.msg === 'station')).toMatchObject({ fresh: true, arraySilent: [], arrayGapMin: { tempf: 0, dailyrainin: 0 } });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('(d) a gap under the threshold -> no alert', async () => {
    quiet();
    const { publishAlert } = await drive({ records: records({ omit: [{ from: edt('02:00'), to: edt('02:45'), fields: ['tempf', 'dailyrainin'] }] }) });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('(e) temperature alone -> names temperature, not rain, and only what temperature costs', async () => {
    quiet();
    const { publishAlert } = await drive({ records: records({ omit: [{ from: edt('02:00'), to: edt('08:00'), fields: ['tempf'] }] }) });
    const { message } = publishAlert.mock.calls[0][0];
    expect(message).toContain('outdoor temperature (tempf) missing');
    expect(message).not.toContain('dailyrainin');
    expect(message).toContain('no station floor');
    expect(message).not.toContain('rain is forecast-only');
  });

  it('(f) stale AND quiet -> station_stale only: the console is the fault to fix first', async () => {
    quiet();
    const { publishAlert } = await drive({ now: NEWEST + 120 * 60000 });
    expect(publishAlert).toHaveBeenCalledTimes(1);
    expect(publishAlert.mock.calls[0][0].message).toContain('station_stale');
    expect(callsFor(publishAlert, 'station_array_silent')).toHaveLength(0);
  });

  it('(g) quiet but bound to NO Space -> station_unbound only', async () => {
    quiet();
    const { publishAlert } = await drive({ pgOpts: { spaces: [AWAY], plantings: [planting('p3', 'sp3')] } });
    expect(publishAlert).toHaveBeenCalledTimes(1);
    expect(publishAlert.mock.calls[0][0].message).toContain('station_unbound');
  });

  it('(h) two Spaces at the gauge -> ONE alert per run', async () => {
    quiet();
    const { publishAlert } = await drive({ pgOpts: { spaces: [HOME, HOME2], plantings: [planting('p1', 'sp1'), planting('p2', 'sp2')] } });
    expect(callsFor(publishAlert, 'station_array_silent')).toHaveLength(1);
    expect(publishAlert).toHaveBeenCalledTimes(1);
  });
});

describe('station_array_silent — the gate: year-round, no switch, first evaluating run only', () => {
  it('the later evaluating runs (15, 16, 17 ET) -> no alert', async () => {
    quiet();
    for (const etHour of [15, 16, 17]) {
      const { publishAlert } = await drive({ etHour });
      expect(publishAlert).not.toHaveBeenCalled();
    }
  });

  it('a non-evaluating run (02:00 ET) -> no alert', async () => {
    quiet();
    const { publishAlert } = await drive({ etHour: 2 });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('a forced frost rehearsal at 14:00 -> no station alert', async () => {
    quiet();
    const { publishAlert } = await drive({ event: { frostEval: true } });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('in January, with FROST_ALERT_ENABLED unset -> still one alert', async () => {
    quiet();
    const { publishAlert } = await drive({ today: WINTER });
    expect(publishAlert).toHaveBeenCalledTimes(1);
    expect(callsFor(publishAlert, 'station_array_silent')).toHaveLength(1);
  });

  it('frost_eval_degraded stays frost-season in the same run: January sends only the station alert, September both', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    quiet();
    const winter = await drive({ today: WINTER, fetchNWS: async () => null });
    expect(callsFor(winter.publishAlert, 'frost_eval_degraded')).toHaveLength(0);
    expect(callsFor(winter.publishAlert, 'station_array_silent')).toHaveLength(1);
    const autumn = await drive({ fetchNWS: async () => null });
    expect(callsFor(autumn.publishAlert, 'frost_eval_degraded')).toHaveLength(1);   // the negative above has teeth
    expect(callsFor(autumn.publishAlert, 'station_array_silent')).toHaveLength(1);
  });

  it('a dry run -> no alert', async () => {
    quiet();
    const { publishAlert } = await drive({ dryRun: true });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('no publisher injected -> the run completes', async () => {
    quiet();
    const { pg } = await drive({ publishAlert: null });
    expect(pg.writes.length).toBeGreaterThan(0);
  });

  it('a publish failure fails LOUD after the plan is written, and is not recorded as sent', async () => {
    const { log, err } = quiet();
    const pg = pgStub();
    const boom = vi.fn(async () => { throw new Error('sns down'); });
    await expect(drive({ pg, publishAlert: boom })).rejects.toThrow(/frost alert publish failed \(1\)/);
    expect(pg.writes.length).toBeGreaterThan(0);
    expect(logLines(err).some((l) => l.msg === 'station-array-silent alert publish FAILED' && l.dedup_key === DEDUP_KEY)).toBe(true);
    expect(logLines(log).some((l) => l.msg === 'station-array-silent alert PUBLISHED')).toBe(false);
  });
});
