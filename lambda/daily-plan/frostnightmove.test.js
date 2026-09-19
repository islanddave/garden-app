// BUG-FROSTESCALATENIGHTMOVE-001 — the frost ALERT-SENT path, when the cold night moves.
//
// Frost email is Dave's only frost channel (email-only, his decision). An advisory sent at 14 ET said "frost
// possible tomorrow night"; by 15 ET the forecast put the same minimum at 05:00, the end of TONIGHT. Nothing
// re-sent (real run() at base 10452156, probe-nightmove.cjs): the dedup key names the plan date, not the night,
// so the unchanged crop set re-minted the same key, and escalatesBeyond compared level and crops only, so a
// different key would have been held as well. The email he had named a night one day too late.
//
// Now "the night moved EARLIER than every night already warned about" is an escalation, once per new night:
// the send records its night (nightOffset, already on the entry since BUG-FROSTADVISORYNIGHTWORDING-001), the
// key gate treats an advisory as "exactly this" only for the same key AND night, and escalatesBeyond compares the
// new night against the earliest one warned. A night moving LATER is not news and is held (and logged). The
// tests that matter most are the silent ones: a forecast that flip-flops every hour must not become an email an
// hour.
//
// Everything below the unit block drives the real run() against `planTable`, an in-memory daily_plan (the same
// shape as frostsent.test.js) that upserts on (user_id, plan_date) and answers both alerts_sent reads, so each run
// sees what the earlier ones wrote. Each run sets the clock to its own ET hour, so every send carries a distinct
// `at` as it does in prod (mergeAlertsSent's identity is key + at). The unit suite mocks SQL: none of this proves
// what Postgres does.
//
// Also here: OPS-FROSTREHEARSALMARK-001 (every send stores the run slot that made it) and OPS-SPACEALERTSREADLOG-001
// (frost-eval logs space_sent; scripts/weather-observability.sh meters the fail-open dedup-read WARN).
//
// MUTATION LOG — 2026-09-19, lane-frostnightmove-20260919 (harness mutate.py in the lane scratch; each mutation
// applied alone, 8 files run under TZ=UTC, file restored and sha256 + git status verified). 33/33 RED; every test
// in this file is killed by at least one. RED counts over the run (this file's share in brackets), at HEAD:
//   night: axis removed 10 · same night counts (<=) 8 · later escalates 12 · no-night history never escalates 2 ·
//          latest not earliest 2 · imminent has no night 5 · sentNight reads dayOffset 15 · any non-null nightOffset 1 ·
//          key-only identity (pre-fix) 8 · night compared for every tier 1 [0; frost-wiring "does NOT re-send when the
//          same key is already stored"] · night not passed 7 · decision night from dayOffset 7 · entry drops its night
//          18 [11] · HELD drops night 2 · HELD drops sent nights 1 · HELD identity key-only 2 · guard loosened 1 ·
//          axis with no night 1
//   run:   field dropped 3 · constant slot 2 · only on forced 1 · gate reads it 2 · Today client reads it 1 ·
//          merge identity reads it 1
//   log:   space_sent dropped 3 · 0 with the flag off 1 · per-Space WARN loses the phrase 2 · per-user WARN loses it 1 ·
//          filter narrowed 1 · filter broadened 1 · filter removed 2 · sample line drifts 1 · failed read goes silent 2
// The script's own test-patterns controls were mutated separately (bash -e, a fake aws that emulates a quoted
// phrase as a substring and touches nothing): 4/4 fail the run, the unmutated control passes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import h from './handler.js';
import fe from './frostEval.js';
import { buildFrostAlertLine } from '../../src/lib/frostAlertLine.js';

const { run, mergeAlertsSent, readSpaceAlertsSent, readAlertsSent, readPriorRuns, readWeatherDaily } = h;
const { escalatesBeyond, sentNight, sentCoverage, advisoryNight, nightPhrase } = fe;

const SPACE = 'sp1';
const DAVE = 'user_dave';
const JEN = 'user_jen';
const TODAY = '2026-10-05';   // Monday, in frost season. D1 Tue 10-06, D2 Wed 10-07, D3 Thu 10-08.
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const DATES = [1, 2, 3].map((n) => addDays(TODAY, n));

const row = (id, user, slug) => ({
  id, name: id, project_id: 'pj1', status: 'vegetative', container_size: '5gal', rain_exposed: null,
  project: 'Garden', project_status: 'active', workspace_id: SPACE, assignee_user_id: user,
  db_cadence: null, cadence_scopes: null, last_water: '2026-10-04', last_fert: null, substrate_start: '2026-04-20',
  transplant_at: null, rain_exposed_resolved: true, frost_covered_resolved: false, heated_resolved: false,
  variety: slug, genus: null, crop_type_slug: slug, container_type: 'plastic_pot',
});
const TOMATO = [row('Tomato Dave', DAVE, 'tomato')];

// In-memory daily_plan: `seed` is { 'user|date': items }.
function planTable({ rows, seed = {} }) {
  const store = new Map(Object.entries(seed));
  const pg = { query: vi.fn(async (sql, params = []) => {
    if (/from plants/.test(sql)) return { rows };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    if (/insert into daily_plan/.test(sql)) { store.set(`${params[0]}|${params[1]}`, JSON.parse(params[2])); return { rows: [] }; }
    if (/from daily_plan where user_id = \$1 and plan_date = \$2/.test(sql)) {
      const items = store.get(`${params[0]}|${params[1]}`);
      return { rows: items ? [{ items, generated_at: `${params[1]}T12:00:00Z` }] : [] };
    }
    if (/from daily_plan where plan_date = \$1/.test(sql)) {
      return { rows: [...store].filter(([k]) => k.endsWith(`|${params[0]}`)).map(([, items]) => ({ alerts_sent: items.alerts_sent ?? null })) };
    }
    return { rows: [] };
  }) };
  return { pg, store, sent: (user = DAVE) => ((store.get(`${user}|${TODAY}`) || {}).alerts_sent) || [] };
}

function publisher() {
  let hour = null;
  const calls = [];
  const fn = vi.fn(async (m) => { calls.push({ hour, topic: m.topic, subject: m.subject, message: m.message }); return { messageId: `mid-${calls.length}` }; });
  return { fn, at: (hr) => { hour = hr; }, frost: () => calls.filter((c) => c.topic === 'frost') };
}

// Open-Meteo hourly temperature for D1..D3: each day's single coldest hour is minHours[i] at lows[i], so the
// series vouches for the printed daily minimum and locateNight places the night from the hour.
const pad = (n) => String(n).padStart(2, '0');
const curve = (low, hour) => Array.from({ length: 24 }, (_, i) => (i === hour ? low : low + 4 + Math.abs(i - hour) * 0.5));
const hourlyTemp = (lows, minHours) => {
  const days = DATES.map((date, i) => [date, curve(lows[i], minHours[i])]);
  return { time: days.flatMap(([date]) => Array.from({ length: 24 }, (_, i) => `${date}T${pad(i)}:00`)),
    temperature_2m: days.flatMap(([, t]) => t), timezone: 'America/New_York' };
};

let logSpy;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('FROST_ALERT_ENABLED', 'true');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// One run. NWS 45F by default, so the imminent tier is silent and the advisory is the whole story. `minHours` is the
// hour of each day's minimum; D1 at 23:00 is "tomorrow night", at 05:00 "tonight". The clock is the run's own ET
// hour (EDT = UTC-4), so each send's `at` is distinct, as in prod.
async function once(t, pub, { etHour, nws = 45, lows = [38, 46, 50], minHours = [23, 6, 6], event = {}, runFn = run }) {
  pub.at(etHour);
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 5, etHour + 4, 0, 0)));
  const from = logSpy.mock.calls.length;
  let error = null;
  try {
    await runFn({
      pg: t.pg, today: TODAY, dryRun: false, etHour, event, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
      fetchNWS: async () => ({ tonightLow: nws, highToday: nws + 20, code: 1, unit: 'F', short: 'Clear' }),
      fetchPrecip: async () => ({ forecast_lows: lows, forecast_dates: DATES, recent_precip_in: 0, today_precip_in: 0,
        today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0,
        hourly_frost: null, hourly_temp: hourlyTemp(lows, minHours) }),
      fetchStation: async () => null, publishAlert: pub.fn,
    });
  } catch (e) { error = e; }
  const logs = logSpy.mock.calls.slice(from).map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { error, logs, evalLine: logs.find((l) => l.msg === 'frost-eval') || null,
    held: logs.filter((l) => l.msg === 'frost alert HELD — not an escalation') };
}

// The night phrase the SNS text named ("tonight" / "tomorrow night" / "Wednesday night").
const snsNight = (msg) => (/FROST ADVISORY — frost possible (.+?) \(low /.exec(msg) || [])[1] || null;
const TONIGHT = { minHours: [5, 6, 6] };        // D1's minimum at 05:00 -> the night that starts this evening
const TOMORROW = { minHours: [23, 6, 6] };      // D1's minimum at 23:00 -> the night that starts tomorrow evening

// ── sentNight — the night a stored entry warned about ──────────────────────────────────────────────────────────
describe('sentNight — the night on record for a sent entry', () => {
  it('an imminent send is TONIGHT by construction, with or without the persisted facts', () => {
    expect(sentNight({ tier: 'imminent', level: 'protect', dayOffset: 0 })).toBe(0);
    expect(sentNight({ tier: 'imminent', level: 'hard_freeze' })).toBe(0);
  });
  it('an advisory is the nightOffset its message named', () => {
    for (const n of [0, 1, 2, 3]) expect(sentNight({ tier: 'advisory', level: 'advisory', dayOffset: 1, nightOffset: n })).toBe(n);
  });
  it('no night on record: an advisory written before nightOffset existed (prod v4.136), heat, junk', () => {
    expect(sentNight({ tier: 'advisory', level: 'advisory', lowF: 38, dayOffset: 1, date: '2026-10-06' })).toBeNull();
    expect(sentNight({ tier: 'advisory', level: 'advisory' })).toBeNull();
    for (const bad of [-1, 1.5, '0', null]) expect(sentNight({ tier: 'advisory', nightOffset: bad })).toBeNull();
    expect(sentNight({ tier: 'heat', level: 'heat' })).toBeNull();
    for (const junk of [null, undefined, {}, { key: 'k' }]) expect(sentNight(junk)).toBeNull();
  });
});

// ── escalatesBeyond — the TIME axis ──────────────────────────────────────────────────────────────────────────────
describe('escalatesBeyond — a night moving EARLIER is an escalation, once', () => {
  const adv = (night, crops = { tomato: 'advisory' }) => ({ tier: 'advisory', level: 'advisory', crops, ...(night == null ? {} : { nightOffset: night }) });
  const imm = (level = 'protect', crops = { tomato: level }) => ({ tier: 'imminent', level, crops, dayOffset: 0 });
  const now = (night, crops = { tomato: 'advisory' }) => ({ level: 'advisory', crops, night });

  it('tomorrow night was sent; the same advisory now names tonight -> escalates', () => {
    expect(escalatesBeyond([adv(1)], now(0))).toBe(true);
  });
  it('a later night is not news: tonight was sent, tomorrow night now -> holds', () => {
    expect(escalatesBeyond([adv(0)], now(1))).toBe(false);
  });
  it('the same night again, even with the crop set wobbling -> holds (the no-storm guard)', () => {
    expect(escalatesBeyond([adv(1)], now(1))).toBe(false);
    expect(escalatesBeyond([adv(0, { tomato: 'advisory', marigold: 'advisory' })], now(0, { tomato: 'advisory' }))).toBe(false);
  });
  it('judged against the EARLIEST night already warned, not the last one sent', () => {
    const history = [adv(2), adv(1)];
    expect(escalatesBeyond(history, now(2))).toBe(false);
    expect(escalatesBeyond(history, now(1))).toBe(false);
    expect(escalatesBeyond(history, now(0))).toBe(true);
    expect(escalatesBeyond([adv(1), adv(2)], now(1))).toBe(false);
  });
  it('an imminent already sent covers tonight: an advisory for tonight is not earlier than it', () => {
    expect(escalatesBeyond([imm()], now(0, { tomato: 'advisory' }))).toBe(false);
    expect(escalatesBeyond([adv(1), imm()], now(0, { tomato: 'advisory' }))).toBe(false);
  });
  it('a prior advisory with NO night on record contributes nothing: the first decision with a night goes out once', () => {
    expect(escalatesBeyond([adv(null)], now(1))).toBe(true);
    expect(escalatesBeyond([adv(null), adv(1)], now(1))).toBe(false);   // ...and the send that followed now holds it
    expect(escalatesBeyond([adv(null), adv(1)], now(0))).toBe(true);
  });
  it('a caller that passes no night keeps the old two-axis behaviour exactly', () => {
    expect(escalatesBeyond([adv(1)], { level: 'advisory', crops: { tomato: 'advisory' } })).toBe(false);
    expect(escalatesBeyond([adv(null)], { level: 'advisory', crops: { tomato: 'advisory' } })).toBe(false);
    for (const bad of [-1, 0.5, '0', null]) expect(escalatesBeyond([adv(1)], now(bad))).toBe(false);
  });
  it('severity and crop escalations are untouched by the night', () => {
    expect(escalatesBeyond([adv(0)], { level: 'protect', crops: { tomato: 'protect' }, night: 0 })).toBe(true);
    expect(escalatesBeyond([adv(0)], now(1, { tomato: 'advisory', pepper: 'advisory' }))).toBe(true);
    expect(escalatesBeyond([imm('hard_freeze')], { level: 'protect', crops: { tomato: 'protect' }, night: 0 })).toBe(false);
  });
});

// ── through the real run() ───────────────────────────────────────────────────────────────────────────────────────
describe('BUG-FROSTESCALATENIGHTMOVE-001 — the night moves between hourly runs (real run(), persisting stub)', () => {
  it('tomorrow night -> tonight: exactly ONE more email, naming tonight, and the entry records the night', async () => {
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    const r14 = await once(t, pub, { etHour: 14, ...TOMORROW });
    const r15 = await once(t, pub, { etHour: 15, ...TONIGHT });
    await once(t, pub, { etHour: 16, ...TONIGHT });
    await once(t, pub, { etHour: 17, ...TONIGHT });
    expect(pub.frost().map((c) => [c.hour, snsNight(c.message)])).toEqual([[14, 'tomorrow night'], [15, 'tonight']]);
    expect(pub.frost()[1].subject).toBe('Garden alert - Frost advisory tonight (low 38F)');
    // The control that makes this a NIGHT escalation: the key did not change between the two sends.
    expect(r15.evalLine.dedup_key).toBe(r14.evalLine.dedup_key);
    const sent = t.sent();
    expect(sent.map((a) => [a.key, a.nightOffset])).toEqual([[r14.evalLine.dedup_key, 1], [r14.evalLine.dedup_key, 0]]);
    // What the next run reads back is the night the email named.
    for (const [i, a] of sent.entries()) expect(nightPhrase(advisoryNight(a))).toBe(snsNight(pub.frost()[i].message));
  });

  it('the night moving LATER never re-sends, and each hold is logged with both nights', async () => {
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    await once(t, pub, { etHour: 14, ...TONIGHT });
    const r15 = await once(t, pub, { etHour: 15, ...TOMORROW });
    await once(t, pub, { etHour: 16, ...TOMORROW });
    await once(t, pub, { etHour: 17, ...TOMORROW });
    expect(pub.frost().map((c) => [c.hour, snsNight(c.message)])).toEqual([[14, 'tonight']]);
    expect(r15.held).toHaveLength(1);
    expect(r15.held[0]).toMatchObject({ tier: 'advisory', night: 1 });
    expect(r15.held[0].already_sent.map((a) => a.night)).toEqual([0]);
    expect(t.sent()).toHaveLength(1);
  });

  it('NO STORM: the night flip-flops on every run, forced runs included -> one email per new night, then silence', async () => {
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    const seq = [TOMORROW, TONIGHT, TOMORROW, TONIGHT, TOMORROW, TONIGHT];
    for (const [i, s] of seq.entries()) {
      const etHour = 14 + i;   // 14-17 ET evaluate on schedule; 18 and 19 ET are forced (event.frostEval)
      await once(t, pub, { etHour, ...s, event: etHour > 17 ? { frostEval: true } : {} });
    }
    expect(pub.frost().map((c) => [c.hour, snsNight(c.message)])).toEqual([[14, 'tomorrow night'], [15, 'tonight']]);
    // Starting from tonight, the flip-flop never sends again at all.
    const t2 = planTable({ rows: TOMATO });
    const pub2 = publisher();
    for (const [i, s] of [TONIGHT, TOMORROW, TONIGHT, TOMORROW].entries()) await once(t2, pub2, { etHour: 14 + i, ...s });
    expect(pub2.frost().map((c) => c.hour)).toEqual([14]);
  });

  it('two steps earlier (Wednesday night -> tomorrow night -> tonight): one email per new night', async () => {
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    await once(t, pub, { etHour: 14, lows: [44, 36, 50], minHours: [6, 23, 6] });   // D2 min 23:00 -> Wednesday night
    await once(t, pub, { etHour: 15, lows: [44, 36, 50], minHours: [6, 5, 6] });    // D2 min 05:00 -> tomorrow night
    await once(t, pub, { etHour: 16, lows: [35, 36, 50], minHours: [5, 5, 6] });    // D1 min 05:00 -> tonight
    await once(t, pub, { etHour: 17, lows: [35, 36, 50], minHours: [5, 5, 6] });
    expect(pub.frost().map((c) => [c.hour, snsNight(c.message)]))
      .toEqual([[14, 'Wednesday night'], [15, 'tomorrow night'], [16, 'tonight']]);
    expect(t.sent().map((a) => a.nightOffset)).toEqual([2, 1, 0]);
  });

  it('a new key (the crop set shrank) is still re-sent when the night moved earlier — it used to be HELD', async () => {
    // marigold is light_frost_tolerant (advisory point 36F): at 35F both crops trip, at 38F only the tomato.
    const t = planTable({ rows: [row('Tomato Dave', DAVE, 'tomato'), row('Marigold Dave', DAVE, 'marigold')] });
    const pub = publisher();
    const r14 = await once(t, pub, { etHour: 14, lows: [35, 46, 50], ...TOMORROW });
    const r15 = await once(t, pub, { etHour: 15, lows: [38, 46, 50], ...TONIGHT });
    await once(t, pub, { etHour: 16, lows: [38, 46, 50], ...TONIGHT });
    expect(r15.evalLine.dedup_key).not.toBe(r14.evalLine.dedup_key);
    expect(pub.frost().map((c) => [c.hour, snsNight(c.message)])).toEqual([[14, 'tomorrow night'], [15, 'tonight']]);
    expect(pub.frost()[1].message).toMatch(/At risk: tomatoes \(1\)\./);
  });

  it('an imminent already sent covers tonight: an advisory whose night moves to tonight is held, not re-sent', async () => {
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    await once(t, pub, { etHour: 14, nws: 35, ...TOMORROW });                  // FROST PROTECT TONIGHT
    const r15 = await once(t, pub, { etHour: 15, nws: 45, ...TONIGHT });       // NWS warmed; OM says tonight
    expect(pub.frost().map((c) => c.hour)).toEqual([14]);
    expect(pub.frost()[0].message).toMatch(/FROST PROTECT TONIGHT/);
    expect(r15.held).toHaveLength(1);
    expect(r15.held[0]).toMatchObject({ tier: 'advisory', night: 0 });
  });

  it('the deploy day: an advisory stored the v4.136 way (no nightOffset) -> ONE re-send naming the located night, then quiet', async () => {
    const t0 = planTable({ rows: TOMATO });
    await once(t0, publisher(), { etHour: 14, ...TOMORROW });
    const legacy = { ...t0.sent()[0] };
    delete legacy.nightOffset;
    expect(sentNight(legacy)).toBeNull();
    const t = planTable({ rows: TOMATO, seed: { [`${DAVE}|${TODAY}`]: { alerts_sent: [legacy] } } });
    const pub = publisher();
    for (const hr of [15, 16, 17]) await once(t, pub, { etHour: hr, ...TOMORROW });
    expect(pub.frost().map((c) => [c.hour, snsNight(c.message)])).toEqual([[15, 'tomorrow night']]);
    expect(t.sent().map((a) => a.nightOffset ?? null)).toEqual([null, 1]);
  });

  it('two users in the Space: the move sends ONE email for the Space, and both rows carry both sends', async () => {
    const t = planTable({ rows: [row('Tomato Dave', DAVE, 'tomato'), row('Tomato Jen', JEN, 'tomato')] });
    const pub = publisher();
    await once(t, pub, { etHour: 14, ...TOMORROW });
    for (const hr of [15, 16, 17]) await once(t, pub, { etHour: hr, ...TONIGHT });
    expect(pub.frost().map((c) => [c.hour, snsNight(c.message)])).toEqual([[14, 'tomorrow night'], [15, 'tonight']]);
    expect(t.sent(DAVE).map((a) => a.nightOffset)).toEqual([1, 0]);
    expect(t.sent(JEN)).toEqual(t.sent(DAVE));
  });

  it('a steady night stays one email across the whole window (control)', async () => {
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    for (const hr of [14, 15, 16, 17]) await once(t, pub, { etHour: hr, ...TONIGHT });
    expect(pub.frost().map((c) => c.hour)).toEqual([14]);
  });
});

// ── OPS-FROSTREHEARSALMARK-001 ───────────────────────────────────────────────────────────────────────────────────
// The only advisory prod has ever sent (2026-09-07, key ...|advisory|advisory|d0ew9) was the F5 rehearsal: a
// forced run (event.frostEval) with FROST_ADVISORY_LOW_F raised to 58. Its entry was key/tier/level/at, the same
// as a real send, so four code comments read it as a real <= 40F night; only the frost-eval CloudWatch line (run
// "forced", thresholds.ADVISORY_LOW_F 58; 30-day retention) could tell. Every send now stores the slot that made it.
describe('OPS-FROSTREHEARSALMARK-001 — the stored entry says which run sent it', () => {
  it('a scheduled send records run "intraday-pm"', async () => {
    const t = planTable({ rows: TOMATO });
    await once(t, publisher(), { etHour: 15, ...TONIGHT });
    expect(t.sent()).toHaveLength(1);
    expect(t.sent()[0].run).toBe('intraday-pm');
  });

  it('a forced send (event.frostEval, the rehearsal lever) records run "forced", after the window as well', async () => {
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    await once(t, pub, { etHour: 20, nws: 35, ...TONIGHT, event: { frostEval: true } });
    await once(t, pub, { etHour: 21, ...TONIGHT, event: { frostEval: true } });
    expect(pub.frost().map((c) => c.hour)).toEqual([20]);
    expect(t.sent()).toHaveLength(1);
    expect(t.sent()[0]).toMatchObject({ tier: 'imminent', run: 'forced' });
  });

  it('THE 2026-09-07 SHAPE: ADVISORY_LOW_F raised to 58, forced at 19 ET, a 55.7F forecast -> the entry is marked forced', async () => {
    // Trip points are read at MODULE LOAD (frostEval DEFAULT_THRESHOLDS, frostClass BAND_THRESHOLDS), exactly as the
    // rehearsal lever works on a deployed Lambda, so this case loads a fresh handler with the env set.
    vi.stubEnv('FROST_ADVISORY_LOW_F', '58');
    const req = createRequire(import.meta.url);
    const drop = () => { for (const f of ['./handler.js', './frostEval.js', './frostClass.js']) delete req.cache[req.resolve(f)]; };
    drop();
    try {
      const rehearsal = req('./handler.js');
      const t = planTable({ rows: TOMATO });
      const pub = publisher();
      await once(t, pub, { etHour: 19, lows: [55.7, 57, 60], minHours: [7, 6, 6], event: { frostEval: true }, runFn: rehearsal.run });
      expect(pub.frost()).toHaveLength(1);
      expect(pub.frost()[0].message).toMatch(/^FROST ADVISORY — frost possible tonight \(low 55\.7°F/);
      expect(t.sent()[0]).toMatchObject({ tier: 'advisory', level: 'advisory', lowF: 55.7, nightOffset: 0, run: 'forced' });
    } finally { drop(); }
  });

  it('an entry stored before the field (no `run`) reads exactly as before, in every reader of the entry', () => {
    const withRun = { key: 'sp1|2026-10-05|advisory|advisory|s51rcs', tier: 'advisory', level: 'advisory',
      at: '2026-10-05T19:00:00.000Z', run: 'forced', crops: { tomato: 'advisory' },
      lowF: 38, dayOffset: 1, date: '2026-10-06', nightOffset: 0 };
    const { run: _dropped, ...without } = withRun;
    expect(without).not.toHaveProperty('run');
    // the escalation gate and the night on record
    for (const d of [{ level: 'advisory', crops: { tomato: 'advisory' }, night: 0 }, { level: 'advisory', crops: { tomato: 'advisory' }, night: 1 },
      { level: 'advisory', crops: { pepper: 'advisory' }, night: 0 }, { level: 'protect', crops: { tomato: 'protect' }, night: 0 }]) {
      expect(escalatesBeyond([withRun], d)).toBe(escalatesBeyond([without], d));
    }
    expect(escalatesBeyond([withRun], { level: 'advisory', crops: { tomato: 'advisory' }, night: 0 })).toBe(false);
    expect(sentNight(withRun)).toBe(0);
    expect(sentNight(without)).toBe(0);
    // the post-window in-ground coverage (BUG-INGROUNDPOSTWINDOW-001)
    const decision = { trippedCrops: [{ slug: 'tomato', label: 'Tomatoes', level: 'advisory', ids: ['p1'] }] };
    const cov = new Map([['p1', 'named']]);
    expect([...sentCoverage(decision, cov, [withRun])]).toEqual([...sentCoverage(decision, cov, [without])]);
    // the per-Space merge: same key and `at` is the same send, with or without the field
    expect(mergeAlertsSent([without], [withRun])).toEqual([without]);
    // the client that words the Today line (src/lib/frostAlertLine.js)
    expect(buildFrostAlertLine([withRun])).toEqual(buildFrostAlertLine([without]));
    expect(buildFrostAlertLine([without]).text).toBe('Frost possible tonight — low 38°F. Plan cover for tender plants.');
  });
});

// ── OPS-SPACEALERTSREADLOG-001 ───────────────────────────────────────────────────────────────────────────────────
// readSpaceAlertsSent (BUG-FROSTDUPTWOUSERS-001) is the one new SQL statement of v4.138 and has no real-Postgres
// coverage in CI (preship-qa I2). A successful read logged nothing, and a failed one logged a WARN that no metric
// filter or alarm watched, so a broken read would surface only as a duplicate frost email. Now every frost-eval
// line carries `space_sent`, and scripts/weather-observability.sh provisions a filter on the WARN phrase. The filter
// is AWS config, so it is proven here from the CODE side: the phrase must be in both fail-open WARNs the handler
// really emits, in nothing a healthy frost run logs, and in neither neighbouring fail-open WARN.
const SCRIPT = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/weather-observability.sh'), 'utf8');
const filterPhrase = () => {
  const m = /^\s*emit_filter\s+frost-dedup-read-failed\s+'"([^"]+)"'\s+FrostDedupReadFailed\s*$/m.exec(SCRIPT);
  return m ? m[1] : null;
};
// A sample line's `msg` in the script's test_patterns (a bash string with \" escapes).
const sampleMsg = (name) => {
  const m = new RegExp(`local ${name}="[^\\n]*?\\{\\\\"msg\\\\":\\\\"([^\\\\]+)\\\\"`).exec(SCRIPT);
  return m ? m[1] : null;
};
const warned = () => console.warn.mock.calls.map(([l]) => String(l));
const boom = () => ({ query: async () => { throw new Error('relation "daily_plan" does not exist'); } });

describe('OPS-SPACEALERTSREADLOG-001 — the per-Space dedup read is visible when it works and metered when it fails', () => {
  it('every frost-eval line carries space_sent: the Space\'s sends BEFORE that run', async () => {
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    const got = [];
    for (const [hr, s] of [[14, TOMORROW], [15, TOMORROW], [16, TONIGHT], [17, TONIGHT]]) got.push((await once(t, pub, { etHour: hr, ...s })).evalLine.space_sent);
    expect(got).toEqual([0, 1, 1, 2]);
    expect(pub.frost().map((c) => c.hour)).toEqual([14, 16]);
  });

  it('flag OFF: the read is not attempted, so the line says null, never a 0 that claims a read', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'false');
    const t = planTable({ rows: TOMATO });
    const r = await once(t, publisher(), { etHour: 15, ...TONIGHT });
    expect(r.evalLine).toMatchObject({ enabled: false, space_sent: null });
    expect(t.pg.query.mock.calls.some(([sql]) => /from daily_plan where plan_date = \$1/.test(sql))).toBe(false);
  });

  it('a failed per-Space read: space_sent 0 on the line, and exactly one WARN carrying the metered phrase', async () => {
    const t = planTable({ rows: TOMATO });
    const inner = t.pg.query.getMockImplementation();
    t.pg.query.mockImplementation(async (sql, params) => {
      if (/from daily_plan where plan_date = \$1/.test(sql)) throw new Error('permission denied for table daily_plan');
      return inner(sql, params);
    });
    const r = await once(t, publisher(), { etHour: 15, ...TONIGHT });
    expect(r.evalLine.space_sent).toBe(0);
    const w = warned().filter((l) => l.includes(filterPhrase()));
    expect(w).toHaveLength(1);
    expect(JSON.parse(w[0])).toMatchObject({ msg: 'space alerts_sent read failed — continuing (may re-send)', space: SPACE });
  });

  it('the filter phrase in scripts/weather-observability.sh is in both fail-open WARNs, and in nothing else', async () => {
    const phrase = filterPhrase();
    expect(phrase, 'provision() no longer declares the frost-dedup-read-failed filter').toBe('alerts_sent read failed');
    await readSpaceAlertsSent(boom(), SPACE, TODAY);
    await readAlertsSent(boom(), DAVE, TODAY);
    const [spaceWarn, userWarn] = warned();
    expect(spaceWarn).toContain(phrase);
    expect(userWarn).toContain(phrase);
    // negative controls: the neighbouring fail-open WARNs must not move this metric
    console.warn.mockClear();
    await readPriorRuns(boom(), DAVE, TODAY);
    await readWeatherDaily(boom(), SPACE, '2026-09-28', TODAY);
    expect(warned()).toHaveLength(2);
    for (const l of warned()) expect(l).not.toContain(phrase);
    // ...and nothing a healthy frost run logs (a send, a hold, the frost-eval line) may match it either
    console.warn.mockClear();
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    for (const [hr, s] of [[14, TONIGHT], [15, TOMORROW], [16, TONIGHT]]) await once(t, pub, { etHour: hr, ...s });
    const all = [...logSpy.mock.calls, ...console.warn.mock.calls, ...console.error.mock.calls].map(([l]) => String(l));
    expect(all.some((l) => l.includes('"frost-eval"'))).toBe(true);
    expect(all.some((l) => l.includes('frost alert HELD'))).toBe(true);
    for (const l of all) expect(l).not.toContain(phrase);
    // The script's own server-side test lines must be the strings the code really emits.
    expect(sampleMsg('L_SPACEFAIL')).toBe(JSON.parse(spaceWarn).msg);
    expect(sampleMsg('L_USERFAIL')).toBe(JSON.parse(userWarn).msg);
    expect(sampleMsg('L_FROSTEVAL')).toBe('frost-eval');
  });
});
