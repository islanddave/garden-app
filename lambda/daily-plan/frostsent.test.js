// BUG-FROSTDUPTWOUSERS-001 + BUG-INGROUNDPOSTWINDOW-001 — what was SENT is a fact about the Space, and after
// the email window it is the only thing an in-ground card may rely on.
//
// 1. One Space, two users (prod 2026-09-18: 98 + 10 live plantings, a daily_plan row per user per date). The
//    frost dedup store (alerts_sent) was per ROW, so a send was recorded only on the row of the user whose loop
//    published it, and the next evaluating run read the other user's empty row and sent the same email again
//    (real run(): 14 AND 15 ET). run() now reads the Space's sends off every row for the date, gates on them, and
//    writes them back onto every member's row.
// 2. The runs after 14-17 ET used to drop an in-ground card on a PREDICTION of the email; if tonight's low crossed
//    the trip after 17:59 nothing was ever sent (16 ET 39F carded, 20 ET 38F no card, 0 emails). After the window a
//    card now drops only for an email that went out and named the crop at least as severely (sentCoverage).
//
// Everything drives the real run() against `planTable`, an in-memory daily_plan that upserts on (user_id, plan_date)
// and answers every daily_plan read the handler issues, so each run sees what the earlier runs wrote. The unit suite
// mocks SQL (memory garden-lambda-unit-suite-proves-no-db-behavior): this proves the decisions and the stored
// payloads against a stubbed table, NOT what Postgres does with the one new SELECT.
//
// MUTATION LOG — 2026-09-18, lane-frostsent-20260918. 35 mutations, each applied alone, this file plus
// ingroundsliver, frost-wiring, frostescalation, station-health-year, coldcardreachable and ingroundoffseason run
// (175 tests), file restored and sha256 + git status checked. All 35 RED; every test in this file is killed by at
// least one. RED counts over the 175:
//   dedup:  gate/write read only the row (pre-fix) 9 · earlier send this run not merged 3 · other rows not merged 3 ·
//           Space prefix filter removed 2 · Space read returns [] 8 · send recorded before publish succeeds 7 ·
//           any send blocks every later one 3 · cap dropped 1 (frost-wiring) · merge identity by key only 1 ·
//           merge keeps nulls 1 · merge does not dedupe 8 · Space read throws instead of failing open 1
//   window: post-window branch removed (pre-fix) 6 · sent rule also before the window 1 (ingroundsliver 09 ET) ·
//           never trusts a send 6 · any send covers whatever its level 3 · same-level send does not cover 5 ·
//           no-send guard dropped 1 · sent map read by slug only 1 · cropLevels writes slug only 2 ·
//           beforeWindow up to the window END 1 · no ET hour / suppressed / forced counted as before 2 / 1 / 1 ·
//           Space read with the flag off 1 · log line removed 1 · demotes nothing 11 · rank from the headline 1 ·
//           no coverage -> empty Map 1
//   kinds:  station_stale from every evaluating run 1 · per-USER send of frost_eval_degraded / station_unbound /
//           station_array_silent / frost_advisory_degraded / station_stale 1 / 1 / 2 / 1 / 1
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import h from './handler.js';
import fe from './frostEval.js';
import fc from './frostClass.js';

const { run, readSpaceAlertsSent, mergeAlertsSent } = h;
const { frostEval, frostCoverage, sentCoverage, resolveFrostRun } = fe;

const SPACE = 'sp1';
const DAVE = 'user_dave';
const JEN = 'user_jen';
const TODAY = '2026-10-05';   // in frost season, the ledger rows' date
const EVALUATING = [14, 15, 16, 17];
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

const row = (id, user, extra) => ({
  id, name: id, project_id: 'pj1', status: 'vegetative', container_size: '5gal', rain_exposed: null,
  project: 'Garden', project_status: 'active', workspace_id: SPACE, assignee_user_id: user,
  db_cadence: null, cadence_scopes: null, last_water: '2026-10-04', last_fert: null, substrate_start: '2026-04-20',
  transplant_at: null, rain_exposed_resolved: true, frost_covered_resolved: false, heated_resolved: false,
  ...extra,
});
const tomato = (id, user) => row(id, user, { variety: 'Sungold', genus: 'Solanum', crop_type_slug: 'tomato', container_type: 'plastic_pot' });
const potato = (id, user, container_type) => row(id, user, { variety: 'Yukon Gold', genus: 'Solanum', crop_type_slug: 'potato', container_type });

// The in-memory daily_plan. `seed` is { 'user|date': items }. The per-date read returns what Postgres returns for
// items->'alerts_sent': the array, or null when the key is absent.
function planTable({ rows, seed = {} }) {
  const store = new Map(Object.entries(seed));
  const sqls = [];
  const pg = { query: vi.fn(async (sql, params = []) => {
    sqls.push(sql);
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
  return {
    pg, store, sqls,
    sent: (user, date = TODAY) => ((store.get(`${user}|${date}`) || {}).alerts_sent) || [],
    setRows: (next) => { rows = next; },
  };
}

// One SNS publisher across a whole night. `fail(n, hour)` decides which calls throw (1-based call count).
function publisher({ fail = () => false } = {}) {
  let n = 0; let hour = null;
  const calls = [];
  const fn = vi.fn(async (m) => {
    n += 1;
    const ok = !fail(n, hour);
    calls.push({ hour, topic: m.topic, message: m.message, subject: m.subject, ok });
    if (!ok) throw new Error('sns down');
    return { messageId: `mid-${n}` };
  });
  return { fn, calls, at: (hr) => { hour = hr; },
    delivered: (topic = 'frost') => calls.filter((c) => c.ok && c.topic === topic) };
}

// V5-RADIATIVEFROST-001 fixture shape (frost-wiring.test.js): a clear, calm 18:00->08:00 night keyed on `date`.
const clearNight = (date = TODAY) => {
  const hours = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8];
  const time = hours.map((hr) => `${hr >= 18 ? date : addDays(date, 1)}T${String(hr).padStart(2, '0')}:00`);
  return { time, dew_point_2m: time.map(() => 33), cloud_cover: time.map(() => 4),
    wind_speed_10m: time.map(() => 2), timezone: 'America/New_York' };
};

// One run of the handler. A frost publish failure makes run() throw AFTER the plans are written (§3-7 fail loud);
// that is returned as `error`, not thrown, so a night can continue. `om` is the Open-Meteo D1..D3 lows.
async function once(t, pub, { etHour, nws, om = [45, 50, 55], hourlyFrost = null, runFn = run, event = {} }) {
  pub.at(etHour);
  let res = null; let error = null;
  try {
    res = await runFn({
      pg: t.pg, today: TODAY, dryRun: false, etHour, event, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
      fetchNWS: async () => (nws == null ? null : { tonightLow: nws, highToday: nws + 20, code: 1, unit: 'F', short: 'Clear' }),
      fetchPrecip: async () => ({ forecast_lows: om, forecast_dates: [1, 2, 3].map((n) => addDays(TODAY, n)),
        recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0,
        tomorrow_pop: 0, yesterday_precip_actual_in: 0, hourly_frost: hourlyFrost }),
      fetchStation: async () => null, publishAlert: pub.fn,
    });
  } catch (e) { error = e; }
  const cards = res ? res.plans.flatMap((pl) => pl.plan.tasks.cold) : [];
  return { res, error, card: (p) => cards.find((c) => c.name === p.name) || null };
}

const logLines = (spy) => spy.mock.calls.map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

let logSpy;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// ── 1 ── BUG-FROSTDUPTWOUSERS-001 ─────────────────────────────────────────────────────────────────────────────
describe('BUG-FROSTDUPTWOUSERS-001 — one frost email per Space per night, whichever user it was recorded under', () => {
  const TWO = [tomato('Tomato Dave', DAVE), tomato('Tomato Jen', JEN)];
  const TIERS = [
    { tier: 'imminent', nws: 35, om: [45, 50, 55], match: /FROST PROTECT TONIGHT/ },
    { tier: 'advisory', nws: 45, om: [38, 46, 50], match: /FROST ADVISORY/ },
    { tier: 'radiative FROST WATCH', nws: 39, om: [45, 46, 47], hourlyFrost: clearNight(), env: { FROST_RADIATIVE_ENABLED: 'true' },
      match: /FROST WATCH TONIGHT/ },
  ];
  for (const c of TIERS) {
    it(`${c.tier}: two users, runs 14/15/16/17 ET -> exactly ONE email, and both rows carry it from the first run on`, async () => {
      vi.stubEnv('FROST_ALERT_ENABLED', 'true');
      for (const [k, v] of Object.entries(c.env || {})) vi.stubEnv(k, v);
      const t = planTable({ rows: TWO });
      const pub = publisher();
      await once(t, pub, { etHour: 14, nws: c.nws, om: c.om, hourlyFrost: c.hourlyFrost });
      // both rows carry the one send as soon as the run that sent it is over, not a run later
      expect(t.sent(DAVE)).toHaveLength(1);
      expect(t.sent(JEN)).toEqual(t.sent(DAVE));
      for (const hr of EVALUATING.slice(1)) await once(t, pub, { etHour: hr, nws: c.nws, om: c.om, hourlyFrost: c.hourlyFrost });
      const got = pub.delivered();
      expect(got.map((x) => x.hour)).toEqual([14]);
      expect(got[0].message).toMatch(c.match);
      expect(t.sent(DAVE)).toHaveLength(1);
      expect(t.sent(JEN)).toEqual(t.sent(DAVE));
    });
  }

  it('heat (FROST_HEAT_ENABLED; off in prod) rides the same store and the same fix — one email', async () => {
    // HEAT_ENABLED is read at module load, so this case loads a FRESH handler/frostEval pair with the env set.
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('FROST_HEAT_ENABLED', 'true');
    const req = createRequire(import.meta.url);
    const drop = () => { for (const f of ['./handler.js', './frostEval.js']) delete req.cache[req.resolve(f)]; };
    drop();
    try {
      const hot = req('./handler.js');
      const t = planTable({ rows: TWO });
      const pub = publisher();
      // highToday = nws + 20 = 96, past the 95F heat trip; a 76F night trips no frost tier
      for (const hr of EVALUATING) await once(t, pub, { etHour: hr, nws: 76, om: [60, 61, 62], runFn: hot.run });
      expect(pub.delivered().map((x) => [x.hour, /HEAT/.test(x.message)])).toEqual([[14, true]]);
      expect(t.sent(JEN)).toEqual(t.sent(DAVE));
    } finally { drop(); }
  });

  it('the rows as prod holds them today (the send on ONE user\'s row only): the next run sends nothing and heals the other row', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    // The 14 ET send, recorded the pre-fix way: on Dave's row only. Jen's row exists for today with no alerts_sent.
    const t0 = planTable({ rows: TWO });
    const pub0 = publisher();
    await once(t0, pub0, { etHour: 14, nws: 35 });
    const legacy = t0.sent(DAVE);
    expect(legacy).toHaveLength(1);
    const t = planTable({ rows: TWO, seed: { [`${DAVE}|${TODAY}`]: { alerts_sent: legacy }, [`${JEN}|${TODAY}`]: { counts: {} } } });
    const pub = publisher();
    for (const hr of [15, 16, 17]) await once(t, pub, { etHour: hr, nws: 35 });
    expect(pub.delivered()).toHaveLength(0);
    expect(t.sent(JEN)).toEqual(legacy);
  });

  it('a user who has LEFT the Space still holds the send: her row is read by date, not by who is a member now', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const t0 = planTable({ rows: [tomato('Tomato Jen', JEN)] });
    await once(t0, publisher(), { etHour: 14, nws: 35 });
    const jenSend = t0.sent(JEN);
    expect(jenSend).toHaveLength(1);
    // By 15 ET Jen has no live planting in the Space; Dave's row for today predates the fix and holds nothing.
    const t = planTable({ rows: [tomato('Tomato Dave', DAVE)], seed: { [`${JEN}|${TODAY}`]: { alerts_sent: jenSend }, [`${DAVE}|${TODAY}`]: { counts: {} } } });
    const pub = publisher();
    await once(t, pub, { etHour: 15, nws: 35 });
    expect(pub.delivered()).toHaveLength(0);
    expect(t.sent(DAVE)).toEqual(jenSend);
  });

  it('within one run: the first user\'s attempt fails, the second user\'s succeeds -> one email, the run still fails loud, and no re-send next run', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const t = planTable({ rows: TWO });
    const pub = publisher({ fail: (n) => n === 1 });
    const r14 = await once(t, pub, { etHour: 14, nws: 35 });
    expect(r14.error && r14.error.message).toMatch(/frost alert publish failed \(1\)/);
    expect(pub.calls.filter((c) => c.topic === 'frost').map((c) => [c.hour, c.ok])).toEqual([[14, false], [14, true]]);
    // the row written BEFORE the successful retry does not have it yet...
    expect(t.sent(DAVE)).toHaveLength(0);
    expect(t.sent(JEN)).toHaveLength(1);
    await once(t, pub, { etHour: 15, nws: 35 });
    expect(pub.delivered()).toHaveLength(1);
    // ...and is healed by the next run
    expect(t.sent(DAVE)).toEqual(t.sent(JEN));
  });

  it('a publish that fails for every user is recorded NOWHERE, so the next run sends it — once', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const t = planTable({ rows: TWO });
    const pub = publisher({ fail: (n, hr) => hr === 14 });
    const r14 = await once(t, pub, { etHour: 14, nws: 35 });
    expect(r14.error && r14.error.message).toMatch(/frost alert publish failed \(2\)/);
    expect(t.sent(DAVE)).toEqual([]);
    expect(t.sent(JEN)).toEqual([]);
    for (const hr of [15, 16, 17]) await once(t, pub, { etHour: hr, nws: 35 });
    expect(pub.delivered().map((x) => x.hour)).toEqual([15]);
  });

  it('a real escalation still gets through, once for the Space: PROTECT at 14 ET, HARD FREEZE at 15 ET', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const t = planTable({ rows: TWO });
    const pub = publisher();
    await once(t, pub, { etHour: 14, nws: 36 });
    await once(t, pub, { etHour: 15, nws: 30 });
    await once(t, pub, { etHour: 16, nws: 30 });
    const got = pub.delivered();
    expect(got.map((x) => x.hour)).toEqual([14, 15]);
    expect(got[0].message).toMatch(/FROST PROTECT TONIGHT/);
    expect(got[1].message).toMatch(/HARD FREEZE TONIGHT/);
    expect(t.sent(JEN).map((a) => a.level)).toEqual(['protect', 'hard_freeze']);
  });

  it('another Space\'s send on a row for the same date suppresses nothing here', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    // The same crops at the same level, sent for sp2 and recorded on a user of sp2 only. escalatesBeyond would
    // HOLD sp1's email against it if it leaked into sp1's list.
    const other = [{ key: `sp2|${TODAY}|imminent|protect|zz`, tier: 'imminent', level: 'protect', at: `${TODAY}T18:00:00.000Z`,
      crops: { tomato: 'protect' }, lowF: 35, dayOffset: 0 }];
    const t = planTable({ rows: TWO, seed: { [`user_sp2|${TODAY}`]: { alerts_sent: other } } });
    const pub = publisher();
    await once(t, pub, { etHour: 14, nws: 35 });
    expect(pub.delivered()).toHaveLength(1);
    expect(t.sent(DAVE).map((a) => a.key.split('|')[0])).toEqual([SPACE]);
  });
});

describe('readSpaceAlertsSent / mergeAlertsSent — the per-Space record', () => {
  const a = (space, tail, at) => ({ key: `${space}|${TODAY}|imminent|protect|${tail}`, tier: 'imminent', level: 'protect', at });
  const pgOf = (rows) => ({ query: vi.fn(async () => ({ rows })) });

  it('unions every row for the date, keeps only this Space\'s keys, and drops an identical copy', async () => {
    const x = a(SPACE, 'x', '2026-10-05T18:00:00.000Z');
    const y = a(SPACE, 'y', '2026-10-05T20:00:00.000Z');
    const other = a('sp2', 'x', '2026-10-05T18:00:00.000Z');
    const pg = pgOf([{ alerts_sent: [x, other] }, { alerts_sent: [x, y] }, { alerts_sent: null }, { alerts_sent: 'junk' }]);
    await expect(readSpaceAlertsSent(pg, SPACE, TODAY)).resolves.toEqual([x, y]);
    expect(pg.query.mock.calls[0][1]).toEqual([TODAY]);
    expect(pg.query.mock.calls[0][0]).toMatch(/select items->'alerts_sent' as alerts_sent from daily_plan where plan_date = \$1/);
  });

  it('two REAL sends of one key (the duplicates already on prod rows) both survive', async () => {
    const first = a(SPACE, 'x', '2026-10-05T18:00:00.000Z');
    const dup = a(SPACE, 'x', '2026-10-05T19:00:00.000Z');
    await expect(readSpaceAlertsSent(pgOf([{ alerts_sent: [first] }, { alerts_sent: [dup] }]), SPACE, TODAY)).resolves.toEqual([first, dup]);
  });

  it('fails OPEN — an unreadable store may re-send, never suppress', async () => {
    await expect(readSpaceAlertsSent({ query: async () => { throw new Error('connection reset'); } }, SPACE, TODAY)).resolves.toEqual([]);
    await expect(readSpaceAlertsSent({ query: async () => ({}) }, SPACE, TODAY)).resolves.toEqual([]);
  });

  it('mergeAlertsSent: first occurrence wins, order kept, nulls dropped', () => {
    const x = a(SPACE, 'x', 't1'); const y = a(SPACE, 'y', 't2'); const z = { key: 'old-1' };
    expect(mergeAlertsSent([x, null, z], [y, { ...x }], [z])).toEqual([x, z, y]);
    expect(mergeAlertsSent(undefined, null, 'junk')).toEqual([]);
  });
});

// ── 2 ── BUG-INGROUNDPOSTWINDOW-001 ───────────────────────────────────────────────────────────────────────────
describe('BUG-INGROUNDPOSTWINDOW-001 — after the window, the bed card drops only for an email that went out', () => {
  const BED = potato('Potato bed', DAVE, 'in_ground');
  const BAG = potato('Potato bag', DAVE, 'fabric_bag');

  it('the ledger row: 16 ET NWS 39 / OM 42 carded, then 20 ET NWS 38 / OM 45 STILL carded — no email was ever sent', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const t = planTable({ rows: [BED, BAG] });
    const pub = publisher();
    const r16 = await once(t, pub, { etHour: 16, nws: 39, om: [42, 50, 54] });
    expect(r16.card(BED)).toMatchObject({ level: 'bring_in' });
    const r20 = await once(t, pub, { etHour: 20, nws: 38, om: [45, 53, 57] });
    expect(r20.card(BED)).toMatchObject({ level: 'bring_in' });
    expect(r20.card(BAG)).toMatchObject({ level: 'bring_in' });
    expect(pub.calls).toHaveLength(0);
    // and it says so, once per Space: both potatoes are named by the 20 ET forecast and by no sent email (only the
    // bed's card depended on it)
    const lines = logLines(logSpy).filter((l) => l.msg === 'frost coverage — post-window: named by the forecast, by no email sent today');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ space: SPACE, plan_date: TODAY, run: 'other', plantings: 2, sent: 0 });
  });

  it('an email that WAS sent covers it: 15 ET names potatoes, so the 20 ET bed card stays dropped (the bag keeps its own)', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const t = planTable({ rows: [BED, BAG] });
    const pub = publisher();
    const r15 = await once(t, pub, { etHour: 15, nws: 36 });
    expect(pub.delivered()).toHaveLength(1);
    expect(pub.delivered()[0].message).toMatch(/potatoes/);
    expect(r15.card(BED)).toBeNull();
    const r20 = await once(t, pub, { etHour: 20, nws: 36 });
    expect(r20.card(BED)).toBeNull();
    expect(r20.card(BAG)).toMatchObject({ level: 'bring_in' });
    expect(pub.calls).toHaveLength(1);
  });

  it('worse after the window keeps the card: PROTECT sent at 15 ET, HARD FREEZE by 20 ET, and no run is left to email it', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const t = planTable({ rows: [BED, BAG] });
    const pub = publisher();
    await once(t, pub, { etHour: 15, nws: 36 });
    const r20 = await once(t, pub, { etHour: 20, nws: 30 });
    expect(r20.card(BED)).toMatchObject({ level: 'bring_in' });
    expect(pub.calls).toHaveLength(1);
  });

  it('an ADVISORY sent at 15 ET covers the same forecast at 20 ET, but not a crossing into the imminent tier', async () => {
    // NWS 39 is above the imminent trip (38) and inside the card's own < 40, so the bed WOULD be carded at 39;
    // Open-Meteo D1 39 trips the advisory, which names the potatoes.
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const t = planTable({ rows: [BED, BAG] });
    const pub = publisher();
    const r15 = await once(t, pub, { etHour: 15, nws: 39, om: [39, 47, 51] });
    expect(pub.delivered()[0].message).toMatch(/FROST ADVISORY/);
    expect(r15.card(BED)).toBeNull();
    expect(r15.card(BAG)).toMatchObject({ level: 'bring_in' });
    // unchanged forecast: the advisory that went out says as much as this run's decision would -> still dropped
    const same = await once(t, pub, { etHour: 20, nws: 39, om: [39, 47, 51] });
    expect(same.card(BED)).toBeNull();
    // tonight crossed to 38 after the window: the imminent tier would have sent, nothing will -> card kept
    const crossed = await once(t, pub, { etHour: 21, nws: 38, om: [45, 53, 57] });
    expect(crossed.card(BED)).toMatchObject({ level: 'bring_in' });
    expect(pub.calls).toHaveLength(1);
  });

  it('the record is the SPACE\'s: Jen\'s bed after the window is covered by the email sent from Dave\'s loop, even on the pre-fix rows', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const JBED = potato('Jen potato bed', JEN, 'in_ground');
    const rows = [tomato('Tomato Dave', DAVE), JBED];
    const t0 = planTable({ rows });
    await once(t0, publisher(), { etHour: 15, nws: 36 });
    const sent = t0.sent(DAVE);
    expect(sent[0].crops).toMatchObject({ potato: 'protect' });
    // prod's shape today: the send on Dave's row only
    const t = planTable({ rows, seed: { [`${DAVE}|${TODAY}`]: { alerts_sent: sent }, [`${JEN}|${TODAY}`]: { counts: {} } } });
    const r20 = await once(t, publisher(), { etHour: 20, nws: 36 });
    expect(r20.card(JBED)).toBeNull();
  });

  it('17 ET publish fails (the bed dropped on the decision, no email): the 18 ET run puts the card back', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const t = planTable({ rows: [BED, BAG] });
    const pub = publisher({ fail: () => true });
    const r17 = await once(t, pub, { etHour: 17, nws: 36 });
    expect(r17.error).toBeTruthy();
    expect(r17.card(BED)).toBeNull();
    const r18 = await once(t, pub, { etHour: 18, nws: 36 });
    expect(r18.card(BED)).toMatchObject({ level: 'bring_in' });
  });

  it('a run with no ET hour cannot place itself before the window, so it too needs a sent email', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const t = planTable({ rows: [BED, BAG] });
    const r = await once(t, publisher(), { etHour: undefined, nws: 38, om: [45, 53, 57] });
    expect(r.card(BED)).toMatchObject({ level: 'bring_in' });
  });

  it('flag off: unchanged — the bed keeps its card and no run reads the Space record', async () => {
    const t = planTable({ rows: [BED, BAG] });
    for (const hr of [15, 20]) {
      const r = await once(t, publisher(), { etHour: hr, nws: 38, om: [45, 53, 57] });
      expect(r.card(BED)).toMatchObject({ level: 'bring_in' });
    }
    expect(t.sqls.some((s) => /from daily_plan where plan_date = \$1/.test(s))).toBe(false);
  });
});

// ── 3 ── the pure pieces ──────────────────────────────────────────────────────────────────────────────────────
describe('sentCoverage — restates only \'named\', against what was sent', () => {
  const P = potato('p1', DAVE, 'in_ground');
  const T = row('t1', DAVE, { variety: 'Sungold', genus: 'Solanum', crop_type_slug: 'tomato', container_type: 'in_ground' });
  const M = row('m1', DAVE, { variety: 'Test Marigold', genus: 'Tagetes', crop_type_slug: 'marigold', container_type: 'in_ground' });
  const U = row('u1', DAVE, { variety: 'Mystery', genus: null, crop_type_slug: 'no_such_slug', container_type: 'in_ground' });
  const decide = (nws, om = [45, 50, 55]) => {
    const exposure = fc.summarize([P, T, M, U]);
    const decision = frostEval({ tonightLow: nws, forecastLows: om, forecastDates: [1, 2, 3].map((n) => addDays(TODAY, n)),
      exposure, spaceId: SPACE, eventDate: TODAY });
    return { decision, coverage: frostCoverage(decision, exposure, nws) };
  };
  const at = (cov) => Object.fromEntries(['p1', 't1', 'm1', 'u1'].map((id) => [id, cov.get(id) ?? null]));
  const sentWith = (crops) => [{ key: `${SPACE}|${TODAY}|imminent|protect|x`, tier: 'imminent', level: 'protect', crops }];

  // 37F: the tender band (potato, tomato, the unclassified bucket treated as tender) trips PROTECT at 38; the
  // light_frost_tolerant marigold's own advisory point is 36, so 37 is above its band.
  it('nothing sent: every \'named\' becomes \'unnamed\'; above_band stays', () => {
    const { decision, coverage } = decide(37);
    expect(at(coverage)).toEqual({ p1: 'named', t1: 'named', m1: 'above_band', u1: 'named' });
    expect(at(sentCoverage(decision, coverage, []))).toEqual({ p1: 'unnamed', t1: 'unnamed', m1: 'above_band', u1: 'unnamed' });
  });

  it('sent at the same level stays named; per crop, so a crop the email left out is not covered by the others', () => {
    const { decision, coverage } = decide(37);
    expect(at(sentCoverage(decision, coverage, sentWith({ potato: 'protect' })))).toEqual({ p1: 'named', t1: 'unnamed', m1: 'above_band', u1: 'unnamed' });
  });

  it('the unclassified bucket is matched by its label, the key cropLevels writes', () => {
    const { decision, coverage } = decide(37);
    expect(decision.cropLevels).toHaveProperty('unclassified');
    expect(sentCoverage(decision, coverage, sentWith({ unclassified: 'protect' })).get('u1')).toBe('named');
  });

  it('sent LESS severely than this decision is not covered; MORE severely is', () => {
    const { decision, coverage } = decide(30);   // hard_freeze for the tender band
    expect(sentCoverage(decision, coverage, sentWith({ potato: 'protect' })).get('p1')).toBe('unnamed');
    const mild = decide(37);
    expect(sentCoverage(mild.decision, mild.coverage, sentWith({ potato: 'hard_freeze' })).get('p1')).toBe('named');
  });

  it('an entry with no crops, or a non-frost level, names nothing', () => {
    const { decision, coverage } = decide(37);
    expect(sentCoverage(decision, coverage, [{ key: 'k', tier: 'imminent', level: 'protect' }]).get('p1')).toBe('unnamed');
    expect(sentCoverage(decision, coverage, sentWith({ potato: 'heat' })).get('p1')).toBe('unnamed');
  });

  it('a tripped crop carrying no level is not covered by nothing (fails toward the card)', () => {
    const coverage = new Map([['p1', 'named']]);
    const decision = { trippedCrops: [{ slug: 'potato', label: 'potatoes', ids: ['p1'] }] };
    expect(sentCoverage(decision, coverage, []).get('p1')).toBe('unnamed');
  });

  it('no coverage in, no coverage out', () => {
    expect(sentCoverage(decide(37).decision, null, [])).toBeNull();
  });
});

describe('resolveFrostRun.beforeWindow — which non-evaluating runs may keep the prediction', () => {
  it('true only for a known ET hour before the window', () => {
    for (let hr = 0; hr < 24; hr++) expect(resolveFrostRun({}, { etHour: hr }).beforeWindow).toBe(hr < 14);
  });
  it('false when forced, suppressed, or the hour is unknown', () => {
    expect(resolveFrostRun({ frostEval: true }, { etHour: 9 }).beforeWindow).toBe(false);
    expect(resolveFrostRun({ frostEval: false }, { etHour: 9 }).beforeWindow).toBe(false);
    expect(resolveFrostRun({}, {}).beforeWindow).toBe(false);
  });
});

// ── 4 ── the kinds that do NOT dedup through alerts_sent ─────────────────────────────────────────────────────
// Checked, not assumed (brief: "if the year-round station alerts share the per-user dedup they duplicate every
// day"). They do not: they sit in the per-Space block, outside the per-user loop. The station trio is capped at
// the 14 ET run (firstOfDay, V5-STATIONHEALTHYEAR-001); the two frost-degrade alerts send once per EVALUATING run,
// which is BUG-DEGRADEDALERTDEDUPE-001 (filed, SOMEDAY) and not this row. Pinned here: two users send exactly
// what one user sends.
describe('station and frost-degrade alerts are per Space, never per user', () => {
  const MAC = 'AA:BB:CC:DD:EE:FF';
  const CFG = JSON.stringify([{ mac: MAC, tz: 'America/New_York', lat: 42.5, lng: -72.6 }]);
  const edt = (hhmm) => Date.parse(`${TODAY}T${hhmm}:00-04:00`);
  const NOW = edt('14:05');
  const records = ({ newest, gap = null }) => {
    const out = [];
    for (let ts = newest; ts > newest - 30 * 3600000; ts -= 5 * 60000) {
      const r = { dateutc: ts, tempf: 50, dailyrainin: 0 };
      if (gap && ts >= gap.from && ts <= gap.to) { delete r.tempf; delete r.dailyrainin; }
      out.push(r);
    }
    return out;
  };
  const KINDS = {
    station_unbound: { station: () => null },
    station_stale: { station: () => ({ mac: MAC, records: records({ newest: NOW - 120 * 60000 }) }) },
    station_array_silent: { station: () => ({ mac: MAC, records: records({ newest: NOW - 5 * 60000, gap: { from: edt('02:00'), to: edt('08:00') } }) }) },
    frost_eval_degraded: { nws: null },
    frost_advisory_degraded: { om: [null, null, null] },
  };
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  const night = async (kind, users) => {
    const k = KINDS[kind];
    const t = planTable({ rows: users.map((u, i) => tomato(`Tomato ${i}`, u)) });
    const pub = publisher();
    for (const hr of EVALUATING) {
      pub.at(hr);
      await run({ pg: t.pg, today: TODAY, dryRun: false, etHour: hr, event: {}, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
        fetchNWS: async () => (k.nws === null ? null : { tonightLow: 60, highToday: 75, code: 1, unit: 'F', short: 'Clear' }),
        fetchPrecip: async () => ({ forecast_lows: k.om || [58, 59, 60], forecast_dates: [1, 2, 3].map((n) => addDays(TODAY, n)),
          recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0,
          tomorrow_pop: 0, yesterday_precip_actual_in: 0, hourly_frost: null }),
        fetchStation: async () => (k.station ? k.station() : null), publishAlert: pub.fn });
    }
    return pub.calls.filter((c) => (c.message || '').startsWith(`${kind} `)).map((c) => c.hour);
  };

  for (const [kind, expected] of [['station_unbound', [14]], ['station_stale', [14]], ['station_array_silent', [14]],
    ['frost_eval_degraded', EVALUATING], ['frost_advisory_degraded', EVALUATING]]) {
    it(`${kind}: two users send exactly what one user sends (${expected.join('/')} ET)`, async () => {
      vi.stubEnv('FROST_ALERT_ENABLED', 'true');
      if (kind.startsWith('station')) vi.stubEnv('AWN_STATIONS_JSON', CFG);
      expect(await night(kind, [DAVE])).toEqual(expected);
      expect(await night(kind, [DAVE, JEN])).toEqual(expected);
    });
  }
});
