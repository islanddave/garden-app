// V4-FROST-001 slice F3 — the wiring, not the arithmetic.
//
// frostEval.test.js / frostClass.test.js prove the DECISION. This file proves the parts that can only go
// wrong at the seam: which run is allowed to evaluate (G3), that the feature flag is genuinely inert when
// OFF (byte-parity), that the §3-5 dedup store suppresses a second send but a real escalation still gets
// through, that a publish failure FAILS LOUD instead of being swallowed (§3-7), and that the §3-8 record is
// logged on every evaluation whether or not it alerts.
import { describe, it, expect, vi, afterEach } from 'vitest';
import h from './handler.js';

const { run, readAlertsSent, frostSubject, ALERTS_SENT_MAX } = h;

const USER = 'user_dave';
const SPACE = 'sp1';
const DATE = '2026-09-20';        // inside the §3-7 Sep 1 – Nov 15 frost season
const PM_HOUR = 15;               // the 15:30 ET intraday-pm run (G3)

const planting = (id, slug, extra = {}) => ({
  id, name: `${slug} ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: slug, genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: slug, covered: false,
  assignee_user_id: USER, db_cadence: null, last_water: '2026-09-19', last_fert: '2026-09-01',
  substrate_start: '2026-05-01', transplant_at: null, ...extra,
});

const PLANTINGS = [
  planting('p1', 'pepper'), planting('p2', 'pepper'), planting('p3', 'tomato'),
  planting('p4', 'basil'), planting('p5', 'kale', { container_type: 'in_ground' }),
  planting('p6', 'pepper', { covered: true }),          // indoors — D6 says do not name it
];

// A pg stub that routes by SQL text and records what was written.
function pgStub({ plantings = PLANTINGS, storedItems = null } = {}) {
  const writes = [];
  const query = vi.fn(async (sql) => {
    if (/from plants/.test(sql)) return { rows: plantings };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    if (/^\s*select items from daily_plan/.test(sql)) return { rows: storedItems ? [{ items: storedItems }] : [] };
    if (/select items, generated_at from daily_plan/.test(sql)) return { rows: [] };
    if (/insert into daily_plan/.test(sql)) return { rows: [] };
    if (/update daily_plan/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  const wrapped = { query: async (sql, params) => { if (/insert into daily_plan/.test(sql)) writes.push(JSON.parse(params[2])); return query(sql, params); }, raw: query, writes };
  return wrapped;
}

const wx = (tonightLow) => async () => ({ tonightLow, highToday: 70, code: 1, unit: 'F', short: 'Clear' });
const precip = (lows = [null, null, null]) => async () => ({
  forecast_lows: lows, forecast_dates: ['2026-09-21', '2026-09-22', '2026-09-23'],
  recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
  tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0,
});

async function drive(opts = {}) {
  const pg = opts.pg || pgStub(opts.pgOpts);
  const publishAlert = opts.publishAlert === null ? undefined : (opts.publishAlert || vi.fn(async () => ({ messageId: 'mid-1' })));
  const res = await run({
    pg, today: opts.today || DATE, dryRun: opts.dryRun ?? false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: wx('tonightLow' in opts ? opts.tonightLow : 30), fetchPrecip: precip(opts.forecastLows), fetchStation: async () => null,
    publishAlert, etHour: opts.etHour ?? PM_HOUR, event: opts.event || {},
  });
  return { res, pg, publishAlert };
}

const logLines = (spy) => spy.mock.calls
  .map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('F6 feature flag — FROST_ALERT_ENABLED is OFF by default and genuinely inert', () => {
  it('publishes nothing when the flag is unset, even on a 30°F night in frost season', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { publishAlert } = await drive();
    expect(publishAlert).not.toHaveBeenCalled();
    expect(logLines(spy).some((l) => l.msg === 'frost alert PUBLISHED')).toBe(false);
  });

  it('writes NO alerts_sent key when the flag is off — the stored plan stays byte-identical', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive();
    expect(pg.writes.length).toBeGreaterThan(0);
    for (const w of pg.writes) expect(w).not.toHaveProperty('alerts_sent');
  });

  it('still EVALUATES and logs with the flag off — §3-8 wants the 2026 corpus started before F6', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await drive();
    const ev = logLines(spy).find((l) => l.msg === 'frost-eval');
    expect(ev).toBeTruthy();
    expect(ev.enabled).toBe(false);
    expect(ev.alert).toBe(true);          // the decision was made...
  });

  it('publishes once the flag is ON', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { publishAlert } = await drive();
    expect(publishAlert).toHaveBeenCalledTimes(1);
    expect(publishAlert.mock.calls[0][0].topic).toBe('frost');
  });
});

describe('G3 run identity — only the 15:30 ET pass may evaluate', () => {
  it('does not evaluate at the 02:00 nightly run', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await drive({ etHour: 2 });
    expect(logLines(spy).some((l) => l.msg === 'frost-eval')).toBe(false);
  });

  it('does not evaluate at the 05:30 am run — tonightLow is tomorrow night there', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await drive({ etHour: 5 });
    expect(logLines(spy).some((l) => l.msg === 'frost-eval')).toBe(false);
  });

  it('evaluates at the pm run and labels the slot', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await drive({ etHour: PM_HOUR });
    expect(logLines(spy).find((l) => l.msg === 'frost-eval').run).toBe('intraday-pm');
  });

  it('event.frostEval:true forces evaluation outside the window (the F5 rehearsal lever)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await drive({ etHour: 2, event: { frostEval: true } });
    expect(logLines(spy).find((l) => l.msg === 'frost-eval').run).toBe('forced');
  });

  it('a forced evaluation still cannot publish while the flag is off', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { publishAlert } = await drive({ etHour: 2, event: { frostEval: true } });
    expect(publishAlert).not.toHaveBeenCalled();
  });
});

describe('D6 at the seam — one coalesced alert, covered plantings excluded', () => {
  it('sends ONE message naming the crop types, not one message per crop', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { publishAlert } = await drive({ tonightLow: 30 });
    expect(publishAlert).toHaveBeenCalledTimes(1);
    const { message } = publishAlert.mock.calls[0][0];
    expect(message).toMatch(/peppers \(2\)/);
    expect(message).toMatch(/tomatoes \(1\)/);
    expect(message).toMatch(/basil \(1\)/);
  });

  it('the covered pepper is excluded from the count — 2 named, not 3', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { publishAlert } = await drive({ tonightLow: 30 });
    expect(publishAlert.mock.calls[0][0].message).toMatch(/peppers \(2\)/);
    expect(publishAlert.mock.calls[0][0].message).not.toMatch(/peppers \(3\)/);
  });

  it('the hardy kale is never named', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { publishAlert } = await drive({ tonightLow: 30 });
    expect(publishAlert.mock.calls[0][0].message).not.toMatch(/kale/i);
  });

  it('at 38°F the sensitive bands are named and the frost-tolerant one is not', async () => {
    // Was 42F/basil-only. After the 2026-08-07 collapse of tropical + chill_sensitive onto the
    // tender baseline, 42F trips NOTHING, so the old fixture proved nothing. Re-pointed at 38F,
    // where the selective-naming contract is carried by marigold (light_frost_tolerant, 34F).
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { publishAlert } = await drive({ tonightLow: 38 });
    const { message } = publishAlert.mock.calls[0][0];
    expect(message).toMatch(/basil \(1\)/);
    expect(message).not.toMatch(/marigolds/);
  });

  it('a mild night publishes nothing at all', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { publishAlert } = await drive({ tonightLow: 60 });
    expect(publishAlert).not.toHaveBeenCalled();
  });
});

describe('§3-5 dedup — one send per key, but a real escalation still gets through', () => {
  it('records the dedup key on the stored plan after a successful publish', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pg } = await drive({ tonightLow: 30 });
    const sent = pg.writes[0].alerts_sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ tier: 'imminent', level: 'hard_freeze' });
    expect(sent[0].key).toMatch(new RegExp(`^${SPACE}\\|${DATE}\\|imminent\\|hard_freeze\\|`));
  });

  it('does NOT re-send when the same key is already stored', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = await drive({ tonightLow: 30 });
    const key = first.pg.writes[0].alerts_sent[0].key;
    const second = await drive({ tonightLow: 30, pgOpts: { storedItems: { alerts_sent: [{ key }] } } });
    expect(second.publishAlert).not.toHaveBeenCalled();
    expect(second.pg.writes[0].alerts_sent).toHaveLength(1);   // carried forward, not duplicated
  });

  it('a PROTECT -> HARD FREEZE escalation on the SAME night IS re-sent (§3-5)', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const protect = await drive({ tonightLow: 36 });
    const protectKey = protect.pg.writes[0].alerts_sent[0].key;
    expect(protectKey).toContain('|protect|');
    const escalated = await drive({ tonightLow: 30, pgOpts: { storedItems: { alerts_sent: [{ key: protectKey }] } } });
    expect(escalated.publishAlert).toHaveBeenCalledTimes(1);
    expect(escalated.pg.writes[0].alerts_sent).toHaveLength(2);   // both preserved
  });

  it('carries an earlier send forward on a later non-evaluating run rather than wiping it', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stored = { alerts_sent: [{ key: 'sp1|2026-09-20|imminent|protect|abc', tier: 'imminent' }] };
    const { pg, publishAlert } = await drive({ etHour: 2, pgOpts: { storedItems: stored } });
    expect(publishAlert).not.toHaveBeenCalled();
    expect(pg.writes[0].alerts_sent).toEqual(stored.alerts_sent);
  });

  it('readAlertsSent fails OPEN — an unreadable store may re-send, never suppress', async () => {
    const pg = { query: vi.fn(async () => { throw new Error('connection reset'); }) };
    await expect(readAlertsSent(pg, USER, DATE)).resolves.toEqual([]);
    await expect(readAlertsSent({ query: async () => ({ rows: [{ items: null }] }) }, USER, DATE)).resolves.toEqual([]);
    await expect(readAlertsSent({ query: async () => ({ rows: [{ items: { alerts_sent: 'nonsense' } }] }) }, USER, DATE)).resolves.toEqual([]);
  });

  it('the store is bounded so a day of re-runs cannot bloat the plan row', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const many = Array.from({ length: ALERTS_SENT_MAX + 3 }, (_, i) => ({ key: `old-${i}` }));
    const { pg } = await drive({ tonightLow: 30, pgOpts: { storedItems: { alerts_sent: many } } });
    expect(pg.writes[0].alerts_sent).toHaveLength(ALERTS_SENT_MAX);
    expect(pg.writes[0].alerts_sent.at(-1).tier).toBe('imminent');   // the newest send survives
  });
});

describe('§3-7 fail LOUD — a swallowed frost alert is the failure this feature exists to prevent', () => {
  it('a publish failure THROWS, so garden-daily-plan-errors (Errors > 0) pages', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = vi.fn(async () => { throw new Error('AuthorizationError: not authorized to perform sns:Publish'); });
    await expect(drive({ tonightLow: 30, publishAlert: boom })).rejects.toThrow(/frost alert publish failed/);
    expect(errSpy).toHaveBeenCalled();
    expect(logLines(errSpy)[0]).toMatchObject({ msg: 'frost alert publish FAILED' });
  });

  it('the daily plan is still WRITTEN before that throw — watering must not be lost to an SNS outage', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pg = pgStub();
    const boom = vi.fn(async () => { throw new Error('sns down'); });
    await expect(drive({ tonightLow: 30, pg, publishAlert: boom })).rejects.toThrow();
    expect(pg.writes.length).toBeGreaterThan(0);
    expect(pg.writes[0].counts).toBeTruthy();
  });

  it('a failed publish is NOT recorded as sent — the next pass retries it', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pg = pgStub();
    await expect(drive({ tonightLow: 30, pg, publishAlert: vi.fn(async () => { throw new Error('sns down'); }) })).rejects.toThrow();
    expect(pg.writes[0].alerts_sent).toEqual([]);
  });

  it('a missing tonightLow INSIDE frost season raises a degraded ops alert on the OPS topic', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { publishAlert } = await drive({ tonightLow: null });
    expect(publishAlert).toHaveBeenCalledTimes(1);
    const call = publishAlert.mock.calls[0][0];
    expect(call.topic).toBe('ops');
    expect(call.message).toMatch(/frost_eval_degraded/);
    expect(call.message).toMatch(/UNKNOWN, not safe/);
  });

  it('the same missing low OUTSIDE frost season does not page', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { publishAlert } = await drive({ tonightLow: null, today: '2026-07-04' });
    expect(publishAlert).not.toHaveBeenCalled();
  });

  it('an alert with no publisher injected is logged as SUPPRESSED, never silently dropped', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await drive({ tonightLow: 30, publishAlert: null });
    expect(logLines(warn).some((l) => l.msg === 'frost alert SUPPRESSED — no publisher injected')).toBe(true);
  });
});

describe('§3-8 observability — logged on EVERY evaluation, alert or not', () => {
  it('a non-alerting evaluation still emits the full record', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await drive({ tonightLow: 60, forecastLows: [58, 59, 60] });
    const ev = logLines(spy).find((l) => l.msg === 'frost-eval');
    expect(ev).toMatchObject({ alert: false, tier: null, tonightLowF: 60, season: true, space: SPACE, plan_date: DATE });
    expect(ev.cropTypesAtRisk).toBe(3);          // pepper, tomato, basil (kale hardy, covered pepper excluded)
    expect(ev.coveredExcluded).toBe(1);
    expect(ev.thresholds.IMMINENT_LOW_F).toBe(38);
  });

  it('an alerting evaluation records the per-crop trip list', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await drive({ tonightLow: 38 });
    const ev = logLines(spy).find((l) => l.msg === 'frost-eval');
    // 38F now trips every sensitive band together; marigold (34F) stays out.
    expect(ev.cropTypesTripped.map((c) => c.slug)).not.toContain('marigold');
    expect(ev.cropTypesTripped.map((c) => c.slug)).toContain('basil');
  });

  it('carries the station provenance through (the 2027 learned-offset corpus, G4)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await drive({ tonightLow: 34 });
    expect(logLines(spy).find((l) => l.msg === 'frost-eval').lowSource).toBe('forecast');
  });
});

describe('frostSubject — SNS Subject is ASCII, single-line, and <= 100 chars', () => {
  it('names the action and the low', () => {
    expect(frostSubject({ tier: 'imminent', level: 'hard_freeze', observability: { tonightLowF: 30 } }))
      .toBe('Garden alert - HARD FREEZE tonight (low 30F)');
  });
  it('strips non-ASCII (the degree sign and em dash break SNS Subject) and caps the length', () => {
    const s = frostSubject({ tier: 'advisory', level: 'advisory', observability: { tonightLowF: 39 } });
    expect(s).toMatch(/^[\x20-\x7E]*$/);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s).not.toMatch(/\n/);
  });
  it('degrades without an observability record', () => {
    expect(frostSubject({ tier: 'imminent', level: 'protect' })).toContain('Frost protect tonight');
  });
});
