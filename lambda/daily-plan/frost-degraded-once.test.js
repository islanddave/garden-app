// BUG-DEGRADEDALERTDEDUPE-001 — the two "frost could not be evaluated" ops emails (frost_eval_degraded and
// frost_advisory_degraded) send at most once per ET day, from the first evaluating run (14:00 ET), the same
// stateless cap the station-health alerts use (frostRun.firstOfDay, V5-STATIONHEALTHYEAR-001). Owner decision
// 2026-10-11, with the accepted cost: a failure that starts after the 14:00 run sends no email that day (the later
// runs log it instead).
//
// The safety property pinned at the bottom: the cap is on the DEGRADED emails only. A real frost warning (topic
// 'frost') still sends from any evaluating run, including one whose degraded email was skipped.
//
// Driven through the real run(). The unit suite mocks SQL (memory garden-lambda-unit-suite-proves-no-db-behavior):
// this proves the decisions, the publish calls and the log lines, not anything the database or SNS does. Each
// drive() is one invocation with nothing carried over, which is what a scheduled run is: the pg stub stores no
// alerts_sent, so nothing but the run's own hour can hold a send back.
import { describe, it, expect, vi, afterEach } from 'vitest';
import h from './handler.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;

const { run } = h;

const USER = 'user_dave';
const DATE = '2026-09-20';        // inside the frost season
const NEXT = '2026-09-21';
const FIRST = 14;                 // the first evaluating run of the ET day
const LATER = [15, 16, 17];       // the rest of the evaluating window
const HOME = { id: 'sp1', postal_code: null, weather_lat: 42.5, weather_lng: -72.6 };

const EVAL_SUBJECT = 'Garden ops - frost evaluation DEGRADED';
const ADVISORY_SUBJECT = 'Garden ops - frost advisory DEGRADED';
const EVAL_SKIPPED = 'frost degraded-alert SKIPPED — not the first evaluating run of the day';
const ADVISORY_SKIPPED = 'frost-advisory-degraded alert SKIPPED — not the first evaluating run of the day';

const planting = (id) => withCoverFlags({
  id, name: `pepper ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: 'pepper', genus: null, project: 'Garden',
  project_status: 'active', workspace_id: 'sp1', crop_type_slug: 'pepper', covered: false,
  assignee_user_id: USER, db_cadence: null, last_water: '2026-09-19', last_fert: '2026-09-01',
  substrate_start: '2026-05-01', transplant_at: null,
});

function pgStub() {
  const writes = [];
  return {
    writes,
    query: vi.fn(async (sql, params) => {
      if (/insert into daily_plan/.test(sql)) writes.push(JSON.parse(params[2]));
      if (/from plants/.test(sql)) return { rows: [planting('p1')] };
      if (/from spaces/.test(sql)) return { rows: [HOME] };
      return { rows: [] };
    }),
  };
}

const hydro = (lows) => ({
  forecast_lows: lows, forecast_dates: ['2026-09-21', '2026-09-22', '2026-09-23'],
  recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
  tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0, hourly_frost: null,
});
const nws = (tonightLow) => ({ tonightLow, highToday: 75, code: 1, unit: 'F', short: 'Clear' });

// `low: null` is the shipped weather fetcher's failure shape (it catches everything and returns null);
// `lows: null` is the shipped hydrology fetcher's. Defaults are a mild night and a healthy D1..D3 window.
async function drive({ etHour = FIRST, today = DATE, low = 60, lows = [58, 59, 60], event = {}, dryRun = false } = {}) {
  const pg = pgStub();
  const publishAlert = vi.fn(async () => ({ messageId: 'mid-1' }));
  await run({
    pg, today, dryRun,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => (low === null ? null : nws(low)),
    fetchPrecip: async () => (lows === null ? null : hydro(lows)),
    fetchStation: async () => null,
    publishAlert, etHour, event,
  });
  return { pg, calls: publishAlert.mock.calls.map(([a]) => a) };
}

const logLines = (spy) => spy.mock.calls
  .map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function quiet() {
  vi.stubEnv('FROST_ALERT_ENABLED', 'true');
  return { log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    err: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}) };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('frost_eval_degraded — no tonight low in season: ONE ops email a day, from the 14:00 ET run', () => {
  it('the first evaluating run sends it, wording unchanged', async () => {
    const { log } = quiet();
    const { calls } = await drive({ low: null });
    expect(calls).toEqual([{ topic: 'ops', subject: EVAL_SUBJECT,
      message: `frost_eval_degraded — no tonight low available for space sp1 on ${DATE} during frost season. ` +
        'The frost alert could not be evaluated; treat tonight as UNKNOWN, not safe.' }]);
    expect(logLines(log).some((l) => l.msg === EVAL_SKIPPED)).toBe(false);
  });

  it('the later evaluating runs (15, 16, 17 ET) send nothing and say so in the log', async () => {
    for (const etHour of LATER) {
      const { log } = quiet();
      const { calls, pg } = await drive({ low: null, etHour });
      expect(calls).toEqual([]);
      const skipped = logLines(log).filter((l) => l.msg === EVAL_SKIPPED);
      expect(skipped).toEqual([{ msg: EVAL_SKIPPED, space: 'sp1', plan_date: DATE, run: 'intraday-pm',
        dedup_key: `sp1|${DATE}|frost_eval_degraded` }]);
      // The evaluation record still names the failure on every run: the log is where a later-starting fault shows.
      expect(logLines(log).find((l) => l.msg === 'frost-eval')).toMatchObject({ degraded: true, run: 'intraday-pm' });
      expect(pg.writes.length).toBeGreaterThan(0);
      vi.restoreAllMocks();
    }
  });

  it('the next day\'s first run sends again', async () => {
    quiet();
    expect((await drive({ low: null })).calls).toHaveLength(1);
    expect((await drive({ low: null, etHour: 17 })).calls).toHaveLength(0);
    const next = await drive({ low: null, today: NEXT });
    expect(next.calls).toHaveLength(1);
    expect(next.calls[0].subject).toBe(EVAL_SUBJECT);
    expect(next.calls[0].message).toContain(`on ${NEXT} during frost season`);
  });

  it('a dry run on a later hour sends nothing and logs no skip (nothing was going to be sent)', async () => {
    const { log } = quiet();
    const { calls } = await drive({ low: null, etHour: 15, dryRun: true });
    expect(calls).toEqual([]);
    expect(logLines(log).some((l) => l.msg === EVAL_SKIPPED)).toBe(false);
  });
});

describe('frost_advisory_degraded — no D1..D3 lows in season: ONE ops email a day, from the 14:00 ET run', () => {
  it('the first evaluating run sends it, wording unchanged', async () => {
    const { log } = quiet();
    const { calls } = await drive({ lows: null });
    expect(calls).toEqual([{ topic: 'ops', subject: ADVISORY_SUBJECT,
      message: `frost_advisory_degraded — no forecast lows for the 3-night advisory window for space sp1 on ${DATE} ` +
        'during frost season: the Open-Meteo hydrology fetch returned nothing. The advance frost advisory could not be ' +
        'evaluated; treat those nights as UNKNOWN, not safe. Tonight\'s imminent check still ran on the NWS low.' }]);
    expect(logLines(log).some((l) => l.msg === ADVISORY_SKIPPED)).toBe(false);
  });

  it('the later evaluating runs (15, 16, 17 ET) send nothing and say so in the log', async () => {
    for (const etHour of LATER) {
      const { log } = quiet();
      const { calls, pg } = await drive({ lows: null, etHour });
      expect(calls).toEqual([]);
      const skipped = logLines(log).filter((l) => l.msg === ADVISORY_SKIPPED);
      expect(skipped).toEqual([{ msg: ADVISORY_SKIPPED, space: 'sp1', plan_date: DATE, run: 'intraday-pm',
        dedup_key: `sp1|${DATE}|frost_advisory_degraded` }]);
      expect(logLines(log).some((l) => l.msg === 'frost-advisory-degraded alert PUBLISHED')).toBe(false);
      expect(pg.writes.length).toBeGreaterThan(0);
      vi.restoreAllMocks();
    }
  });

  it('the next day\'s first run sends again', async () => {
    quiet();
    expect((await drive({ lows: null })).calls).toHaveLength(1);
    expect((await drive({ lows: null, etHour: 16 })).calls).toHaveLength(0);
    const next = await drive({ lows: null, today: NEXT });
    expect(next.calls).toHaveLength(1);
    expect(next.calls[0].subject).toBe(ADVISORY_SUBJECT);
    expect(next.calls[0].message).toContain(`on ${NEXT} during frost season`);
  });

  it('both checks blind: the first run sends both, a later run sends neither and logs both', async () => {
    const { log } = quiet();
    expect((await drive({ low: null, lows: null })).calls.map((c) => c.subject)).toEqual([EVAL_SUBJECT, ADVISORY_SUBJECT]);
    expect(logLines(log).some((l) => l.msg === EVAL_SKIPPED || l.msg === ADVISORY_SKIPPED)).toBe(false);
    expect((await drive({ low: null, lows: null, etHour: 16 })).calls).toEqual([]);
    expect(logLines(log).filter((l) => l.msg === EVAL_SKIPPED)).toHaveLength(1);
    expect(logLines(log).filter((l) => l.msg === ADVISORY_SKIPPED)).toHaveLength(1);
  });
});

// The safety property. The cap above must never reach the frost warning itself.
describe('a real frost warning is NOT capped: it still sends from every evaluating run', () => {
  it('a hard-freeze night on a later run sends the frost warning, with the advisory-degraded email skipped beside it', async () => {
    for (const etHour of LATER) {
      const { log } = quiet();
      const { calls, pg } = await drive({ low: 30, lows: null, etHour });
      expect(calls).toHaveLength(1);
      expect(calls[0].topic).toBe('frost');
      expect(calls[0].subject).toMatch(/tonight \(low 30F\)/);
      expect(logLines(log).filter((l) => l.msg === 'frost alert PUBLISHED')).toHaveLength(1);
      expect(logLines(log).filter((l) => l.msg === ADVISORY_SKIPPED)).toHaveLength(1);
      // The warning is recorded as sent beside the skipped email: without the record the next run sends it again.
      expect(pg.writes.at(-1).alerts_sent).toEqual([expect.objectContaining({ tier: 'imminent', run: 'intraday-pm', key: expect.stringContaining(`sp1|${DATE}|`) })]);
      vi.restoreAllMocks();
    }
  });

  it('an advance frost warning on a later run sends while tonight\'s low is missing and that email is skipped', async () => {
    for (const etHour of LATER) {
      const { log } = quiet();
      const { calls } = await drive({ low: null, lows: [30, 30, 30], etHour });
      expect(calls).toHaveLength(1);
      expect(calls[0].topic).toBe('frost');
      expect(logLines(log).filter((l) => l.msg === 'frost alert PUBLISHED')).toHaveLength(1);
      expect(logLines(log).filter((l) => l.msg === EVAL_SKIPPED)).toHaveLength(1);
      vi.restoreAllMocks();
    }
  });

  it('a frost warning with nothing degraded sends from all four evaluating runs alike', async () => {
    quiet();
    for (const etHour of [FIRST, ...LATER]) {
      const { calls } = await drive({ low: 30, etHour });
      expect(calls.map((c) => c.topic)).toEqual(['frost']);
    }
  });

  it('on the first run a frost warning and a degraded email both send', async () => {
    quiet();
    const { calls } = await drive({ low: 30, lows: null });
    expect(calls.map((c) => c.topic).sort()).toEqual(['frost', 'ops']);
    expect(calls.find((c) => c.topic === 'ops').subject).toBe(ADVISORY_SUBJECT);
  });

  it('a forced rehearsal is never the first run: its degraded email is skipped, its frost warning still sends', async () => {
    const { log } = quiet();
    const { calls } = await drive({ low: 30, lows: null, etHour: FIRST, event: { frostEval: true } });
    expect(calls.map((c) => c.topic)).toEqual(['frost']);
    expect(logLines(log).filter((l) => l.msg === ADVISORY_SKIPPED)).toEqual([expect.objectContaining({ run: 'forced' })]);
  });
});
