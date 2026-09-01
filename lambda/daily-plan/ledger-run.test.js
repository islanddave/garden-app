// ledger-run.test.js — V4-WATERMATH-001 F2 at run()/invoke level.
// The claims here are about REACHABILITY and the shadow harness's fail-safe direction, so — exactly
// like weatherdaily.test.js, whose recordingPg pattern this reuses — every headline assertion counts
// statements the driver genuinely received or options run() genuinely honored. A source grep proves
// where a call is written; the thing worth proving is that it is never reached (BUG-SEEDEDGATE-001).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import handler from './handler.js';
import LP from './ledgerParams.js';

const { run, resolveInvokeOptions, readLedgerEvents, weatherWindowStart, LEDGER_OVERRIDABLE_FLAGS } = handler;

const SPACE = 'sp-1';
const USER = 'user_1';
const TODAY = '2026-08-12';

const PLANTINGS = [{
  id: 'p1', name: 'Pepper p1', project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: 'pepper', genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: 'pepper', covered: false,
  frost_covered_resolved: false, rain_exposed_resolved: true, assignee_user_id: USER, db_cadence: null,
  last_water: '2026-08-01', last_fert: '2026-08-01', substrate_start: '2026-05-01', transplant_at: null,
}];

const hydrology = () => ({
  forecast_lows: [null, null, null], forecast_dates: [null, null, null],
  recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
  tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0, settled_days: [],
});

// The ledger event-window statement is the only SQL in this Lambda that selects water_depth.
const isLedgerEventsSql = (sql) => /water_depth/.test(sql);

function recordingPg({ throwOnLedgerEvents = false, eventRows = [] } = {}) {
  const calls = [];
  const pg = {
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (isLedgerEventsSql(sql)) {
        if (throwOnLedgerEvents) throw new Error('boom: event window unavailable');
        return { rows: eventRows };
      }
      if (/weather_daily/.test(sql)) return { rows: [] };
      if (/from plants/.test(sql)) return { rows: PLANTINGS };
      if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
      return { rows: [] };
    }),
    calls,
  };
  return pg;
}
const ledgerQ = (pg) => pg.calls.filter((c) => isLedgerEventsSql(c.sql));
const planWrites = (pg) => pg.calls.filter((c) => /insert into daily_plan/.test(c.sql));
const storedItems = (pg) => planWrites(pg).map((c) => { const o = JSON.parse(c.params[2]); delete o.generated_at; return o; });

async function drive(opts = {}) {
  const pg = opts.pg || recordingPg(opts.pgOpts);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const res = await run({
    pg, today: TODAY, dryRun: opts.dryRun ?? false, flagOverrides: opts.flagOverrides ?? null,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 60, highToday: 82, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => hydrology(),
    fetchStation: async () => null,
    publishAlert: vi.fn(async () => ({ messageId: 'm1' })),
    etHour: 2, event: {},
  });
  return { res, pg };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// ── the headline proof: flag OFF issues ZERO ledger event-window queries ─────────────────────────
describe('CARE_WATER_LEDGER_ENABLED — flag OFF issues ZERO event-window queries', () => {
  it('flag OFF, live: not one statement selects the event window', async () => {
    const { pg } = await drive();
    expect(ledgerQ(pg)).toHaveLength(0);
  });
  it('flag ON, live: exactly ONE windowed query per run, over the 30-day window', async () => {
    vi.stubEnv('CARE_WATER_LEDGER_ENABLED', 'true');
    const { pg } = await drive();
    expect(ledgerQ(pg)).toHaveLength(1);
    expect(ledgerQ(pg)[0].params).toEqual([weatherWindowStart(TODAY), TODAY]);
    // and it is per-run, not per-planting/per-space: one round trip regardless of count
  });
  it('only the exact string "true" arms it', async () => {
    for (const v of ['1', 'yes', 'TRUE', '', 'false']) {
      vi.stubEnv('CARE_WATER_LEDGER_ENABLED', v);
      const { pg } = await drive();
      expect(ledgerQ(pg), `flag value ${JSON.stringify(v)}`).toHaveLength(0);
    }
  });
});

describe('the fold can never take down (or silently distort) the nightly plan', () => {
  it('event-window read failure -> loud warn, run completes, payload EQUALS flag-OFF byte-for-byte', async () => {
    // The keystone degrade: null (read failed) must NOT fold against a falsely-empty window — that
    // would declare every planting ~30 demand-days overdue. The whole run drops to flag-OFF.
    const off = await drive();
    vi.stubEnv('CARE_WATER_LEDGER_ENABLED', 'true');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = await drive({ pg: recordingPg({ throwOnLedgerEvents: true }) });
    expect(broken.res.rows).toBeGreaterThan(0);
    expect(storedItems(broken.pg)).toEqual(storedItems(off.pg));
    const msgs = warn.mock.calls.map(([l]) => { try { return JSON.parse(l).msg; } catch { return null; } });
    expect(msgs).toContain('ledger event-window read failed — ledger degrades to flag-OFF this run');
  });
  it('readLedgerEvents distinguishes empty ({}) from failed (null) — the two MUST differ', async () => {
    const ok = recordingPg({ eventRows: [] });
    expect(await readLedgerEvents(ok, '2026-07-13', TODAY)).toEqual({});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = recordingPg({ throwOnLedgerEvents: true });
    expect(await readLedgerEvents(bad, '2026-07-13', TODAY)).toBeNull();
  });
  it('groups rows per plant with numeric timestamps and null-safe depth', async () => {
    const pg = recordingPg({ eventRows: [
      { id: 'e1', plant_id: 'p1', event_type: 'watering', t_ms: '1754900000000', water_depth: 'deep' },
      { id: 'e2', plant_id: 'p1', event_type: 'moisture_check', t_ms: 1754990000000, water_depth: null },
      { id: 'e3', plant_id: 'p2', event_type: 'rain', t_ms: 1754990000000, water_depth: '' },
    ] });
    const by = await readLedgerEvents(pg, '2026-07-13', TODAY);
    expect(by.p1).toEqual([
      { id: 'e1', t: 1754900000000, type: 'watering', depth: 'deep', gaugeSourced: false },
      { id: 'e2', t: 1754990000000, type: 'moisture_check', depth: null, gaugeSourced: false },
    ]);
    expect(by.p2[0].depth).toBeNull();
  });

  // BUG-RAINEVENTNEUTRALIZES-001 — the fold cannot price a gauge rain day correctly unless this
  // read tells it which rain events are gauge-written. Pinned at the READ boundary because that is
  // where the distinction is available (metadata.precip_source) and lost if the column is dropped
  // from the select; ledger.test.js pins what the fold then does with it.
  it('marks gauge-written rain events via metadata.precip_source, manual ones stay false', async () => {
    const pg = recordingPg({ eventRows: [
      { id: 'g1', plant_id: 'p1', event_type: 'rain', t_ms: 1754990000000, water_depth: null,
        precip_source: 'awn_gauge' },
      { id: 'm1', plant_id: 'p2', event_type: 'rain', t_ms: 1754990000000, water_depth: null,
        precip_source: null },
    ] });
    const by = await readLedgerEvents(pg, '2026-07-13', TODAY);
    expect(by.p1[0].gaugeSourced).toBe(true);
    expect(by.p2[0].gaugeSourced).toBe(false);   // manual log keeps its full-reset semantics
  });

  it('the event-window SQL selects precip_source (dropping it silently re-breaks the depth model)', async () => {
    const pg = recordingPg();
    await readLedgerEvents(pg, '2026-07-13', TODAY);
    expect(ledgerQ(pg)[0].sql).toMatch(/metadata->>'precip_source'/);
  });
  it('every bind in the event-window SQL carries an explicit cast (Neon null-typing rule)', async () => {
    const pg = recordingPg();
    await readLedgerEvents(pg, '2026-07-13', TODAY);
    const sql = ledgerQ(pg)[0].sql;
    expect(sql).toMatch(/\$1::date/);
    expect(sql).toMatch(/\$2::date/);
    expect(sql).toMatch(/deleted_at is null/);
    expect(sql).toMatch(/'watering','rain','moisture_check'/);
  });
});

// ── A0.4 flag overrides: the dryRun-ONLY shadow seam ─────────────────────────────────────────────
describe('flagOverrides — honored on DRY runs only (the env-flip A/B hazard)', () => {
  it('dry run + override ON arms the ledger with the env flag off', async () => {
    const { pg } = await drive({ dryRun: true, flagOverrides: { CARE_WATER_LEDGER_ENABLED: true } });
    expect(ledgerQ(pg)).toHaveLength(1);
  });
  it('dry run + override OFF disarms an env-armed flag (the reverse A/B leg)', async () => {
    vi.stubEnv('CARE_WATER_LEDGER_ENABLED', 'true');
    const { pg } = await drive({ dryRun: true, flagOverrides: { CARE_WATER_LEDGER_ENABLED: false } });
    expect(ledgerQ(pg)).toHaveLength(0);
  });
  it('a LIVE run ignores overrides even if a caller smuggles them past resolveInvokeOptions', async () => {
    const { pg } = await drive({ dryRun: false, flagOverrides: { CARE_WATER_LEDGER_ENABLED: true } });
    expect(ledgerQ(pg)).toHaveLength(0);
  });
});

describe('resolveInvokeOptions — flagOverrides sanitization', () => {
  const OPTS = { envDryRun: 'true', todayDefault: TODAY };
  it('dry + whitelisted strict-boolean keys pass; everything else is stripped', () => {
    const out = resolveInvokeOptions({ flagOverrides: {
      CARE_WATER_LEDGER_ENABLED: true, CARE_RAIN_CREDIT_ENABLED: false,
      CARE_TODAY_AWARE_ENABLED: 'true',            // non-boolean -> stripped
      DRY_RUN: true, EVIL_FLAG: true,              // not whitelisted -> stripped
    } }, OPTS);
    expect(out.flagOverrides).toEqual({ CARE_WATER_LEDGER_ENABLED: true, CARE_RAIN_CREDIT_ENABLED: false });
  });
  it('LIVE run -> flagOverrides is null no matter what the event carried (hard-reject)', () => {
    const out = resolveInvokeOptions({ flagOverrides: { CARE_WATER_LEDGER_ENABLED: true } },
      { envDryRun: 'false', todayDefault: TODAY });
    expect(out.dryRun).toBe(false);
    expect(out.flagOverrides).toBeNull();
  });
  it('event dryRun:true makes overrides usable even when env is live (the wrapper path)', () => {
    const out = resolveInvokeOptions({ dryRun: true, flagOverrides: { CARE_WATER_LEDGER_ENABLED: true } },
      { envDryRun: 'false', todayDefault: TODAY });
    expect(out.dryRun).toBe(true);
    expect(out.flagOverrides).toEqual({ CARE_WATER_LEDGER_ENABLED: true });
  });
  it('arrays/garbage/absence -> null; the whitelist is exactly the seven CARE flags', () => {
    expect(resolveInvokeOptions({ flagOverrides: [true] }, OPTS).flagOverrides).toBeNull();
    expect(resolveInvokeOptions({ flagOverrides: 'CARE_WATER_LEDGER_ENABLED' }, OPTS).flagOverrides).toBeNull();
    expect(resolveInvokeOptions({}, OPTS).flagOverrides).toBeNull();
    // Exhaustive on purpose: widening the shadow seam is a decision, so it has to be made HERE as
    // well as at the read site. V4-COVEREDNOTMODELLED-001 added the seventh entry.
    expect(LEDGER_OVERRIDABLE_FLAGS).toEqual(['CARE_WATER_LEDGER_ENABLED', 'CARE_RAIN_CREDIT_ENABLED',
      'CARE_RAIN_MAXDAYS_ENABLED', 'CARE_TODAY_AWARE_ENABLED', 'CARE_CADENCE_SCOPES_ENABLED',
      'CARE_RAIN_MEASURED_CREDIT_ENABLED', 'CARE_COVER_INHERIT_ENABLED']);
  });
  // DRG-INTRADAY-002 Track 0. Asserted on its own rather than left to the list pin above, because
  // the list pin passes whether or not the name is spelled the same as the read site at :939 — and
  // a near-miss there strips the key silently, which is exactly how this went unnoticed until a
  // replay produced a number for a question nobody asked.
  it('CARE_RAIN_MEASURED_CREDIT_ENABLED survives sanitization on a dry run, both directions', () => {
    expect(resolveInvokeOptions({ flagOverrides: { CARE_RAIN_MEASURED_CREDIT_ENABLED: false } }, OPTS).flagOverrides)
      .toEqual({ CARE_RAIN_MEASURED_CREDIT_ENABLED: false });
    expect(resolveInvokeOptions({ flagOverrides: { CARE_RAIN_MEASURED_CREDIT_ENABLED: true } }, OPTS).flagOverrides)
      .toEqual({ CARE_RAIN_MEASURED_CREDIT_ENABLED: true });
    // Still hard-rejected on a live run — widening the whitelist must not widen the blast radius.
    expect(resolveInvokeOptions({ flagOverrides: { CARE_RAIN_MEASURED_CREDIT_ENABLED: false } },
      { envDryRun: 'false', todayDefault: TODAY }).flagOverrides).toBeNull();
  });
  // V4-COVEREDNOTMODELLED-001, same reasoning as the block above and for the same reason: the list
  // pin passes whether or not this name matches the read site in run(). It does not merely enable a
  // computation here — it reshapes the plantings SELECT, so a near-miss spelling silently replays
  // the OLD classification and reports it as the new one's blast radius.
  it('CARE_COVER_INHERIT_ENABLED survives sanitization on a dry run, both directions', () => {
    expect(resolveInvokeOptions({ flagOverrides: { CARE_COVER_INHERIT_ENABLED: true } }, OPTS).flagOverrides)
      .toEqual({ CARE_COVER_INHERIT_ENABLED: true });
    expect(resolveInvokeOptions({ flagOverrides: { CARE_COVER_INHERIT_ENABLED: false } }, OPTS).flagOverrides)
      .toEqual({ CARE_COVER_INHERIT_ENABLED: false });
    expect(resolveInvokeOptions({ flagOverrides: { CARE_COVER_INHERIT_ENABLED: true } },
      { envDryRun: 'false', todayDefault: TODAY }).flagOverrides).toBeNull();
  });
});

// ── static source pins (index.js pulls AWS/neon at module load — same constraint as A0.2/A0.3) ───
describe('index.js wiring (static source guard)', () => {
  const RAW = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'index.js'), 'utf8');
  const decomment = (s) => s.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  const SRC = decomment(RAW);
  it('A0.4-FLAG-OVERRIDES sentinel present; flagOverrides destructured and passed into run()', () => {
    expect(RAW).toContain('A0.4-FLAG-OVERRIDES sentinel');
    expect(SRC).toMatch(/\{ dryRun, today, ping, flagOverrides \} = resolveInvokeOptions/);
    expect(SRC).toMatch(/run\(\{ pg: pool, today, dryRun, flagOverrides,/);
  });
  it('fetchPrecip exposes D0 live-forecast ET0 + Tmax at index 2 (today\'s demand input)', () => {
    expect(SRC).toMatch(/today_et0_in: Number\.isFinite\(et0\[2\]\) \? round3\(et0\[2\]\) : null/);
    expect(SRC).toMatch(/today_tmax_f: Number\.isFinite\(tmax\[2\]\) \? round2\(tmax\[2\]\) : null/);
  });
});

describe('constant lockstep', () => {
  it('the fold window and the weather window are one number', () => {
    expect(LP.WINDOW_DAYS).toBe(handler.WEATHER_DAILY_WINDOW_DAYS);
  });
});
