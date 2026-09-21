// BUG-FROSTREHEARSALSWALLOWS-001 — a forced frost rehearsal must never count as the day's real frost email.
//
// THE DEFECT (real run() at base 3425da14; first seen by lane-frostnightmove, probe on 1f0751fa). A rehearsal is a
// FORCED run (event.frostEval, the F5 lever) whose trip points may be raised (FROST_ADVISORY_LOW_F=58 on 2026-09-07).
// Sent before 14:00 ET it stored an advisory entry, and the real 14-17 ET runs then read that entry as the day's
// email already sent: the same key and night -> the key gate skipped the genuine advisory, and escalatesBeyond saw
// nothing worse. A real frost warning went unsent that day.
//
// DAVE'S DECISION (2026-09-21, AskUserQuestion, "Tests never count"): "When deciding whether today's alert already
// went out, test runs are ignored, so a real warning always sends. The cost: if a session ever forces a REAL
// (non-test) alert, you get the same email again at the 4-5pm run."
//
// THE RULE. An alerts_sent entry whose `run` is 'forced' (OPS-FROSTREHEARSALMARK-001 stores the slot on every send)
// counts for nothing: not in the key gate, not in escalatesBeyond, not in the post-window in-ground coverage
// (sentCoverage), not in the HELD line's already_sent, and it never renders on Today. frostEval.countsAsSent is the
// one predicate on the server; src/lib/frostAlertLine.js pickAdvisory applies the same rule and is held to it below.
// An entry with no `run` (stored before the field existed) still counts as real. A forced entry is still STORED:
// it is the record of an email that went out.
//
// Every run() case drives the real handler against frostnightmove.test.js's in-memory daily_plan (upserts on
// (user_id, plan_date), answers both alerts_sent reads), each run on its own ET-hour clock so every send has its own
// `at`, as in prod. The unit suite mocks SQL: none of this proves what Postgres does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import h from './handler.js';
import fe from './frostEval.js';
import { buildFrostAlertLine } from '../../src/lib/frostAlertLine.js';

const { run } = h;
const { escalatesBeyond, sentCoverage, countsAsSent } = fe;

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

// One run. NWS 45F by default (the imminent tier stays silent). D1's minimum at 05:00 by default: the night that
// starts this evening, located, so every advisory here names TONIGHT. The clock is the run's own ET hour (EDT).
async function once(t, pub, { etHour, nws = 45, lows = [39, 46, 50], minHours = [5, 6, 6], event = {}, runFn = run }) {
  pub.at(etHour);
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 5, etHour + 4, 0, 0)));
  const from = logSpy.mock.calls.length;
  const res = await runFn({
    pg: t.pg, today: TODAY, dryRun: false, etHour, event, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: nws, highToday: nws + 20, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => ({ forecast_lows: lows, forecast_dates: DATES, recent_precip_in: 0, today_precip_in: 0,
      today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0,
      hourly_frost: null, hourly_temp: hourlyTemp(lows, minHours) }),
    fetchStation: async () => null, publishAlert: pub.fn,
  });
  const logs = logSpy.mock.calls.slice(from).map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const cards = res ? res.plans.flatMap((pl) => pl.plan.tasks.cold) : [];
  return { evalLine: logs.find((l) => l.msg === 'frost-eval') || null,
    held: logs.filter((l) => l.msg === 'frost alert HELD — not an escalation'),
    card: (name) => cards.find((c) => c.name === name) || null };
}

// THE REHEARSAL LEVER as it is pulled on a deployed Lambda: trip points are read at MODULE LOAD (frostEval
// DEFAULT_THRESHOLDS, frostClass BAND_THRESHOLDS), so a raised FROST_ADVISORY_LOW_F needs a fresh handler.
// frostnightmove.test.js "THE 2026-09-07 SHAPE" loads it the same way. The stub stays until afterEach: nothing reads
// it at call time, so the scheduled runs below keep the default-threshold handler imported at the top.
function rehearsalHandler(advisoryLowF = '58') {
  vi.stubEnv('FROST_ADVISORY_LOW_F', advisoryLowF);
  const req = createRequire(import.meta.url);
  const drop = () => { for (const f of ['./handler.js', './frostEval.js', './frostClass.js']) delete req.cache[req.resolve(f)]; };
  drop();
  try { return req('./handler.js'); } finally { drop(); }
}

const FORCED = { frostEval: true };
const snsHead = (msg) => (/^(FROST ADVISORY — frost possible .+? \(low [\d.]+°F)/.exec(msg) || [])[1] || null;

// ── the swallow, end to end ───────────────────────────────────────────────────────────────────────────────────────
describe('BUG-FROSTREHEARSALSWALLOWS-001 — a rehearsal before 14:00 ET no longer swallows the real advisory', () => {
  it('forced advisory at 13 ET (trip raised to 58) -> the real 14 ET run STILL sends; 15-17 ET stay quiet', async () => {
    const rehearsal = rehearsalHandler();
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    const r13 = await once(t, pub, { etHour: 13, lows: [45, 50, 52], event: FORCED, runFn: rehearsal.run });
    // What the rehearsal stored, and that Today does not show it as a real alert.
    expect(t.sent()).toHaveLength(1);
    expect(t.sent()[0]).toMatchObject({ tier: 'advisory', lowF: 45, nightOffset: 0, run: 'forced' });
    expect(buildFrostAlertLine(t.sent())).toBeNull();
    const r14 = await once(t, pub, { etHour: 14 });
    for (const hr of [15, 16, 17]) await once(t, pub, { etHour: hr });
    // THE CONTROL that makes this the swallow: the real decision has the rehearsal's key AND night, so before the fix
    // the key gate read the forced entry as "exactly this, already sent".
    expect(r14.evalLine.dedup_key).toBe(r13.evalLine.dedup_key);
    expect(r13.evalLine).toMatchObject({ run: 'forced', advisoryNightOffset: 0 });
    expect(r14.evalLine).toMatchObject({ run: 'intraday-pm', advisoryNightOffset: 0 });
    expect(pub.frost().map((c) => [c.hour, snsHead(c.message)])).toEqual([
      [13, 'FROST ADVISORY — frost possible tonight (low 45°F'],
      [14, 'FROST ADVISORY — frost possible tonight (low 39°F'],
    ]);
    expect(pub.frost()[1].subject).toBe('Garden alert - Frost advisory tonight (low 39F)');
    // The real send is what dedups the rest of the window, and what Today shows.
    expect(t.sent().map((a) => [a.run, a.lowF])).toEqual([['forced', 45], ['intraday-pm', 39]]);
    expect(buildFrostAlertLine(t.sent()).text).toBe('Frost possible tonight — low 39°F. Plan cover for tender plants.');
  });

  it('escalation gate too: a forced send of a WORSE level cannot hold the real one (key differs, same night)', async () => {
    // The rehearsal raises the tender trip to 58: at 45F the tomato only reaches its advisory point, but with the
    // imminent point also raised the forced run sends PROTECT. The real 14 ET advisory has a different key, so only
    // escalatesBeyond could hold it: before the fix it did (advisory is not worse than protect).
    vi.stubEnv('FROST_IMMINENT_LOW_F', '50');
    const rehearsal = rehearsalHandler();
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    const r13 = await once(t, pub, { etHour: 13, nws: 45, lows: [45, 50, 52], event: FORCED, runFn: rehearsal.run });
    expect(r13.evalLine).toMatchObject({ run: 'forced', tier: 'imminent', level: 'protect' });
    const r14 = await once(t, pub, { etHour: 14 });
    expect(r14.evalLine.dedup_key).not.toBe(r13.evalLine.dedup_key);
    expect(r14.held).toEqual([]);
    expect(pub.frost().map((c) => c.hour)).toEqual([13, 14]);
    expect(pub.frost()[1].subject).toBe('Garden alert - Frost advisory tonight (low 39F)');
  });

  it('a HELD line lists only the sends that count: the rehearsal is not "already sent"', async () => {
    const rehearsal = rehearsalHandler();
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    await once(t, pub, { etHour: 13, lows: [45, 50, 52], event: FORCED, runFn: rehearsal.run });
    await once(t, pub, { etHour: 14 });                                   // real: tonight, sent
    const r15 = await once(t, pub, { etHour: 15, minHours: [23, 6, 6] }); // the night moves LATER: held
    expect(pub.frost().map((c) => c.hour)).toEqual([13, 14]);
    expect(r15.held).toHaveLength(1);
    expect(r15.held[0].already_sent).toEqual([{ level: 'advisory', crops: { tomato: 'advisory' }, night: 0 }]);
  });

  it('one direction only: a rehearsal AFTER a real send is still held by the real send (it cannot duplicate it)', async () => {
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    await once(t, pub, { etHour: 14 });
    await once(t, pub, { etHour: 19, event: FORCED });                    // the same decision, forced after the window
    expect(pub.frost().map((c) => c.hour)).toEqual([14]);
    expect(t.sent().map((a) => a.run)).toEqual(['intraday-pm']);
  });

  it('THE ACCEPTED COST (Dave, 2026-09-21): a forced REAL alert before the window is sent again by the scheduled run', async () => {
    const t = planTable({ rows: TOMATO });
    const pub = publisher();
    await once(t, pub, { etHour: 13, event: FORCED });                    // default trip points: a real 39F advisory
    for (const hr of [14, 15, 16, 17]) await once(t, pub, { etHour: hr });
    expect(pub.frost().map((c) => [c.hour, c.subject])).toEqual([
      [13, 'Garden alert - Frost advisory tonight (low 39F)'],
      [14, 'Garden alert - Frost advisory tonight (low 39F)'],
    ]);
  });

  it('an entry with no `run` (stored before the field existed) still counts as real: no re-send', async () => {
    const t0 = planTable({ rows: TOMATO });
    await once(t0, publisher(), { etHour: 14 });
    const legacy = { ...t0.sent()[0] };
    delete legacy.run;
    const t = planTable({ rows: TOMATO, seed: { [`${DAVE}|${TODAY}`]: { alerts_sent: [legacy] } } });
    const pub = publisher();
    for (const hr of [15, 16, 17]) await once(t, pub, { etHour: hr });
    expect(pub.frost()).toEqual([]);
    expect(t.sent()).toEqual([legacy]);
    // ...while the SAME entry marked forced does not.
    const t2 = planTable({ rows: TOMATO, seed: { [`${DAVE}|${TODAY}`]: { alerts_sent: [{ ...legacy, run: 'forced' }] } } });
    const pub2 = publisher();
    for (const hr of [15, 16, 17]) await once(t2, pub2, { etHour: hr });
    expect(pub2.frost().map((c) => c.hour)).toEqual([15]);
  });

  it('after the window, a rehearsal\'s email does not stand in for a real one: the in-ground bed keeps its card', async () => {
    // frostsent.test.js BUG-INGROUNDPOSTWINDOW-001: after 17:59 ET a bed's bring-in card drops only for an email that
    // went out and named its crop (sentCoverage). A rehearsal after the window (the old workaround) names potatoes at
    // 36F; the 20 ET run must not read that as the warning Dave was sent.
    const potato = (id, containerType) => ({ ...row(id, DAVE, 'potato'), variety: 'Yukon Gold', genus: 'Solanum', container_type: containerType });
    const BED = potato('Potato bed', 'in_ground');
    const BAG = potato('Potato bag', 'fabric_bag');
    const t = planTable({ rows: [BED, BAG] });
    const pub = publisher();
    await once(t, pub, { etHour: 19, nws: 36, lows: [45, 50, 52], event: FORCED });
    expect(pub.frost()).toHaveLength(1);
    expect(pub.frost()[0].message).toMatch(/potatoes/);
    expect(t.sent()[0]).toMatchObject({ run: 'forced', crops: { potato: 'protect' } });
    const r20 = await once(t, pub, { etHour: 20, nws: 36, lows: [45, 50, 52] });
    expect(r20.card('Potato bed')).toMatchObject({ level: 'bring_in' });
    expect(r20.card('Potato bag')).toMatchObject({ level: 'bring_in' });   // control: the bag never relied on an email
    // CONTROL: the same email from a scheduled run does cover the bed (frostsent.test.js, "an email that WAS sent").
    const t2 = planTable({ rows: [BED, BAG] });
    await once(t2, publisher(), { etHour: 15, nws: 36, lows: [45, 50, 52] });
    expect((await once(t2, publisher(), { etHour: 20, nws: 36, lows: [45, 50, 52] })).card('Potato bed')).toBeNull();
  });

  it('two users in the Space: the rehearsal on Jen\'s row does not swallow the Space\'s real email either', async () => {
    const rehearsal = rehearsalHandler();
    const t = planTable({ rows: [row('Tomato Dave', DAVE, 'tomato'), row('Tomato Jen', JEN, 'tomato')] });
    const pub = publisher();
    await once(t, pub, { etHour: 13, lows: [45, 50, 52], event: FORCED, runFn: rehearsal.run });
    for (const hr of [14, 15]) await once(t, pub, { etHour: hr });
    expect(pub.frost().map((c) => c.hour)).toEqual([13, 14]);
    expect(t.sent(JEN)).toEqual(t.sent(DAVE));
    expect(t.sent(JEN).map((a) => a.run)).toEqual(['forced', 'intraday-pm']);
  });
});

// ── the predicate, unit by unit ───────────────────────────────────────────────────────────────────────────────────
describe('countsAsSent — the one server predicate, and every gate that reads it', () => {
  const entry = (over = {}) => ({ key: 'sp1|2026-10-05|advisory|advisory|s51rcs', tier: 'advisory', level: 'advisory',
    at: '2026-10-05T18:00:00.000Z', crops: { tomato: 'advisory' }, lowF: 39, dayOffset: 1, date: '2026-10-06', nightOffset: 0, ...over });

  it('false only for run "forced"; a scheduled send and a send stored before the field count', () => {
    expect(countsAsSent(entry({ run: 'forced' }))).toBe(false);
    expect(countsAsSent(entry({ run: 'intraday-pm' }))).toBe(true);
    expect(countsAsSent(entry())).toBe(true);
    for (const junk of [null, undefined]) expect(countsAsSent(junk)).toBe(false);
  });

  it('escalatesBeyond: a forced send is no high-water mark on any axis (level, night, crops)', () => {
    const now = { level: 'advisory', crops: { tomato: 'advisory' }, night: 0 };
    expect(escalatesBeyond([entry({ run: 'intraday-pm' })], now)).toBe(false);   // control: a real one holds it
    expect(escalatesBeyond([entry()], now)).toBe(false);                         // ...and so does one with no run
    expect(escalatesBeyond([entry({ run: 'forced' })], now)).toBe(true);
    expect(escalatesBeyond([entry({ run: 'forced', level: 'protect', tier: 'imminent', crops: { tomato: 'protect' } })], now)).toBe(true);
    // a real send beside a forced one: the real one decides
    expect(escalatesBeyond([entry({ run: 'forced', nightOffset: 0 }), entry({ run: 'intraday-pm', nightOffset: 1 })], now)).toBe(true);
    expect(escalatesBeyond([entry({ run: 'forced', nightOffset: 1 }), entry({ run: 'intraday-pm', nightOffset: 0 })], now)).toBe(false);
  });

  it('sentCoverage (the post-window in-ground card): only an email that counts keeps a planting "named"', () => {
    const decision = { trippedCrops: [{ slug: 'tomato', label: 'tomatoes', level: 'advisory', ids: ['p1'] }] };
    const cov = new Map([['p1', 'named']]);
    expect([...sentCoverage(decision, cov, [entry({ run: 'intraday-pm' })])]).toEqual([['p1', 'named']]);
    expect([...sentCoverage(decision, cov, [entry()])]).toEqual([['p1', 'named']]);
    expect([...sentCoverage(decision, cov, [entry({ run: 'forced' })])]).toEqual([['p1', 'unnamed']]);
  });

  it('the Today client applies the same rule (src/lib/frostAlertLine.js pickAdvisory), entry for entry', () => {
    const shapes = [entry(), entry({ run: 'intraday-pm' }), entry({ run: 'forced' }), entry({ run: 'other' }),
      entry({ run: null }), entry({ run: 'FORCED' })];
    for (const e of shapes) {
      expect(buildFrostAlertLine([e]) != null, JSON.stringify(e.run)).toBe(countsAsSent(e));
    }
    // a forced entry never outranks, replaces or hides a real one
    const real = entry({ run: 'intraday-pm', lowF: 38, nightOffset: 1, at: '2026-10-05T18:00:00.000Z' });
    const forced = entry({ run: 'forced', lowF: 45, nightOffset: 0, at: '2026-10-05T19:00:00.000Z' });
    expect(buildFrostAlertLine([real, forced]).text).toBe('Frost possible tomorrow night — low 38°F. Plan cover for tender plants.');
    expect(buildFrostAlertLine([forced, real]).text).toBe('Frost possible tomorrow night — low 38°F. Plan cover for tender plants.');
  });
});
