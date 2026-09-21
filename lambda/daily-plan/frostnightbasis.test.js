// BUG-FROSTESCALATENIGHTMOVE-001, pre-promote item I1 (mainsync5-20260919) — a DATA GAP is not the cold moving to
// another night.
//
// THE DEFECT (base 95668818, found by the pre-promote review through the real run()). The night-move re-send
// (frostnightmove.test.js) compares the night an advisory names against the nights already warned about. That night
// is LOCATED only when Open-Meteo's hourly temperature vouches for the daily minimum (frostEval.locateNight, basis
// 'hourly'). Without it the night is a guess: the base rate (basis 'base_rate') is always the EARLIER of the two
// candidate nights, and the radiative-only fallback (basis 'radiative') names whichever candidate's sky tripped. So
// one run whose Open-Meteo body lacked `hourly.temperature_2m`, between two that had it, read as "the cold moved to
// tonight": a second email naming tonight; Today saying "Frost possible tonight" and applying the single-low rule for
// the rest of the plan date (the newest entry wins: src/lib/frostAlertLine.js pickAdvisory, src/lib/tonightLow.js);
// and the later runs that located the minimum again stayed silent, their key and night matching the first send.
//
// THE RULE (orchestrator's decision): only a night the hours LOCATED can be a move. A guessed night keeps the gate
// the night-move rule replaced: the same key is already sent, and only severity and crops escalate. The next run
// whose hours locate the minimum decides, so a real move still re-sends, one hourly run late when a gap coincides
// with it. What a send stores is unchanged.
//
// RESIDUAL, accepted with the rule (pinned by the last case): when every remaining run of the 14-17 ET window guesses,
// a genuine move earlier is not re-sent that plan date. That is exactly what v4.139.0 does. It never hides a first
// email or a colder one: an empty history always sends, and the level and crop axes do not read the night.
//
// Every case drives the real run() against frostnightmove.test.js's in-memory daily_plan (upserts on
// (user_id, plan_date), answers both alerts_sent reads), so each run sees what the earlier ones wrote. Each run sets
// the clock to its own ET hour, so every send carries a distinct `at`, as in prod. The unit suite mocks SQL: none of
// this proves what Postgres does.
//
// MUTATION LOG — 2026-09-19, lane-nightbasis-20260919 (harness mutate.mjs in the lane scratch: each mutation applied
// alone; this file run as an expect.soft copy, so every failing assertion counts, with frostnightmove.test.js, under
// TZ=UTC; file restored and sha256 + git status verified). All 43 assertion sites are killed by at least one. RED tests
// here / in frostnightmove.test.js:
//   the rule: basis check dropped (the base) 6/0 · inverted 9/9 · threshold path only 1/0 · radiative path only 5/0 ·
//             identity keeps a guessed night 3/0 · escalation keeps a guessed night 1/0 · a guessed night never
//             escalates 3/0 · a gap run sends nothing new, any tier 4/0 · HELD drops night_basis 1/0
//   the gate: no dedup gate at all 10/12 · the stored entry drops its night 9/11
//   scenario guards: the gap run has a located series (fixture) 9/0 · key ignores the crop set 2/1 · key names the
//             advisory night 4/1 · locateNight never locates 12/9
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import h from './handler.js';
import _cf from './_coverFlags.js';
import { buildFrostAlertLine } from '../../src/lib/frostAlertLine.js';
import { agreedTonightLow } from '../../src/lib/tonightLow.js';

const { run } = h;
const { withCoverFlags } = _cf;

const SPACE = 'sp1';
const DAVE = 'user_dave';
const pad = (n) => String(n).padStart(2, '0');
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// Open-Meteo hourly temperature: each day's single coldest hour is minHours[i] at lows[i], so the series vouches for
// the daily minimum and locateNight places the night from the hour (before noon: the night that ends that morning).
const curve = (low, hour) => Array.from({ length: 24 }, (_, i) => (i === hour ? low : low + 4 + Math.abs(i - hour) * 0.5));
const hourlyTemp = (dates, lows, minHours) => ({
  time: dates.flatMap((d) => Array.from({ length: 24 }, (_, i) => `${d}T${pad(i)}:00`)),
  temperature_2m: dates.flatMap((d, i) => curve(lows[i], minHours[i])),
  timezone: 'America/New_York',
});
const TOMORROW = [23, 6, 6];   // D1's minimum at 23:00: the night that starts tomorrow evening, located
const TONIGHT = [5, 6, 6];     // D1's minimum at 05:00: the night that starts this evening, located
const GAP = null;              // the body carried the lows but no hourly temperature: the night is a guess

// In-memory daily_plan (frostnightmove.test.js planTable).
function planTable(rows, today) {
  const store = new Map();
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
  const items = () => store.get(`${DAVE}|${today}`) || {};
  return { pg, items, sent: () => items().alerts_sent || [] };
}

let logSpy;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('FROST_ALERT_ENABLED', 'true');
  vi.stubEnv('FROST_RADIATIVE_ENABLED', 'true');   // prod, read 2026-09-18
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// The runs of one plan date, in order. Each run's clock is its own ET hour (EDT = UTC-4).
async function sequence({ today, rows, runs }) {
  const t = planTable(rows, today);
  const [y, m, d] = today.split('-').map(Number);
  const emails = [];
  const out = {};
  for (const r of runs) {
    vi.setSystemTime(new Date(Date.UTC(y, m - 1, d, r.etHour + 4, 0, 0)));
    const from = logSpy.mock.calls.length;
    await run({
      pg: t.pg, today, dryRun: false, etHour: r.etHour, event: {}, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
      fetchNWS: async () => ({ tonightLow: r.nws, highToday: r.nws + 20, code: 1, unit: 'F', short: 'Clear' }),
      fetchPrecip: async () => ({ forecast_lows: r.lows, forecast_dates: r.dates, recent_precip_in: 0, today_precip_in: 0,
        today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0,
        hourly_frost: r.frost ?? null, hourly_temp: r.hourly }),
      fetchStation: async () => null,
      publishAlert: async (msg) => { if (msg.topic === 'frost') emails.push({ hour: r.etHour, subject: msg.subject }); return { messageId: 'mid' }; },
    });
    const logs = logSpy.mock.calls.slice(from).map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    out[r.etHour] = { evalLine: logs.find((l) => l.msg === 'frost-eval') || null,
      held: logs.filter((l) => l.msg === 'frost alert HELD — not an escalation') };
  }
  return { t, runs: out, emails, nights: () => emails.map((e) => [e.hour, subjectNight(e.subject)]) };
}
// The night the email subject named ("tonight" / "tomorrow night" / "Thursday night").
const subjectNight = (s) => (/^Garden alert - Frost (?:advisory|watch|protect) (.+?) \(low /.exec(s) || [])[1] || null;

// ── the threshold advisory: plan date Mon 2026-10-05, D1 Tue 10-06 at 38F. NWS 45F keeps the imminent tier silent. ──
const MON = '2026-10-05';
const MON_DATES = [1, 2, 3].map((n) => addDays(MON, n));
const LOWS = [38, 46, 50];
const row = (id, slug) => ({
  id, name: id, project_id: 'pj1', status: 'vegetative', container_size: '5gal', rain_exposed: null,
  project: 'Garden', project_status: 'active', workspace_id: SPACE, assignee_user_id: DAVE,
  db_cadence: null, cadence_scopes: null, last_water: '2026-10-04', last_fert: null, substrate_start: '2026-04-20',
  transplant_at: null, rain_exposed_resolved: true, frost_covered_resolved: false, heated_resolved: false,
  variety: slug, genus: null, crop_type_slug: slug, container_type: 'plastic_pot',
});
const TOMATO = [row('Tomato Dave', 'tomato')];
// marigold is light_frost_tolerant (advisory point 36F): at 35F both crops trip, at 38F only the tomato.
const TOMATO_MARIGOLD = [row('Tomato Dave', 'tomato'), row('Marigold Dave', 'marigold')];
const thr = (etHour, minHours, { lows = LOWS, nws = 45 } = {}) => ({ etHour, nws, lows, dates: MON_DATES,
  hourly: minHours ? hourlyTemp(MON_DATES, lows, minHours) : null });

// ── the radiative-only advisory, a Frost watch: plan date Fri 2026-10-09, D1 Sat 10-10 at 42F (above the 40F trip,
// inside its 4F proximity), NWS 55F. radiativepairing.test.js's fixtures. ──
const FRI = '2026-10-09';
const FRI_DATES = ['2026-10-10', '2026-10-11', '2026-10-12'];
const RLOWS = [42, 50, 51];
const planting = (id, slug) => withCoverFlags({
  id, name: `${slug} ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: slug, genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: slug, covered: false,
  assignee_user_id: DAVE, db_cadence: null, last_water: '2026-10-08', last_fert: '2026-09-20',
  substrate_start: '2026-05-01', transplant_at: null,
});
const PEPTOM = [planting('p1', 'pepper'), planting('p2', 'tomato')];
// index.js hourly_frost for the nights that start 10-09 (tonight) and 10-10 (tomorrow night), 18:00 -> 08:00 each.
const frostBlock = (tonight, tomorrow) => {
  const time = []; const dew = []; const cloud = []; const wind = [];
  const add = (date, next, n) => {
    for (const hr of [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      time.push(`${hr >= 18 ? date : next}T${pad(hr)}:00`);
      dew.push(n.dew); cloud.push(n.cloud); wind.push(n.wind);
    }
  };
  add('2026-10-09', '2026-10-10', tonight);
  add('2026-10-10', '2026-10-11', tomorrow);
  return { time, dew_point_2m: dew, cloud_cover: cloud, wind_speed_10m: wind, timezone: 'America/New_York' };
};
const CLEAR = { dew: 31, cloud: 4, wind: 2 };
const CLOUDY = { dew: 31, cloud: 95, wind: 12 };
const rad = (etHour, minHours, [tonight, tomorrow]) => ({ etHour, nws: 55, lows: RLOWS, dates: FRI_DATES,
  hourly: minHours ? hourlyTemp(FRI_DATES, RLOWS, minHours) : null, frost: frostBlock(tonight, tomorrow) });

const TOMORROW_LINE_38 = 'Frost possible tomorrow night — low 38°F. Plan cover for tender plants.';

describe('I1 — a gap in the hourly data is not the cold moving to another night (real run(), persisting stub)', () => {
  it.each([['off', 'false'], ['on, as in prod', 'true']])(
    'S1 threshold, radiative %s: located -> no hourly temperature -> located: ONE email, and Today stays on tomorrow night',
    async (_label, flag) => {
      vi.stubEnv('FROST_RADIATIVE_ENABLED', flag);
      const s = await sequence({ today: MON, rows: TOMATO, runs: [thr(14, TOMORROW), thr(15, GAP), thr(16, TOMORROW), thr(17, TOMORROW)] });
      // The gap is real: at 15 ET the decision named TONIGHT on the base-rate guess, under the key already sent.
      expect(s.runs[15].evalLine).toMatchObject({ tier: 'advisory', advisoryNightBasis: 'base_rate', advisoryNightOffset: 0 });
      expect(s.runs[15].evalLine.dedup_key).toBe(s.runs[14].evalLine.dedup_key);
      expect(s.nights()).toEqual([[14, 'tomorrow night']]);
      // Same key = already sent, as before the night-move rule: not a hold, so no HELD line either.
      expect(s.runs[15].held).toEqual([]);
      expect(s.t.sent().map((a) => a.nightOffset)).toEqual([1]);
      expect(buildFrostAlertLine(s.t.sent()).text).toBe(TOMORROW_LINE_38);
      expect(agreedTonightLow(s.t.items())).toBeNull();
    });

  it('S1c control: the hours locate the minimum on every run -> ONE email', async () => {
    const s = await sequence({ today: MON, rows: TOMATO, runs: [14, 15, 16, 17].map((hr) => thr(hr, TOMORROW)) });
    expect(s.nights()).toEqual([[14, 'tomorrow night']]);
    expect(buildFrostAlertLine(s.t.sent()).text).toBe(TOMORROW_LINE_38);
  });

  it('a genuine move, located both times (tomorrow night -> tonight): TWO emails, the second names tonight', async () => {
    const s = await sequence({ today: MON, rows: TOMATO, runs: [thr(14, TOMORROW), thr(15, TONIGHT), thr(16, TONIGHT), thr(17, TONIGHT)] });
    expect(s.runs[15].evalLine).toMatchObject({ advisoryNightBasis: 'hourly', advisoryNightOffset: 0 });
    expect(s.nights()).toEqual([[14, 'tomorrow night'], [15, 'tonight']]);
    expect(s.t.sent().map((a) => a.nightOffset)).toEqual([1, 0]);
    expect(buildFrostAlertLine(s.t.sent()).text).toBe('Frost possible tonight — low 38°F. Plan cover for tender plants.');
    expect(agreedTonightLow(s.t.items())).toMatchObject({ lowF: 38 });
  });

  it('a gap coinciding with a genuine move: silent at the gap, re-sent by the next located run (16 ET)', async () => {
    const s = await sequence({ today: MON, rows: TOMATO, runs: [thr(14, TOMORROW), thr(15, GAP), thr(16, TONIGHT), thr(17, TONIGHT)] });
    expect(s.runs[15].evalLine).toMatchObject({ advisoryNightBasis: 'base_rate', advisoryNightOffset: 0 });
    expect(s.runs[16].evalLine).toMatchObject({ advisoryNightBasis: 'hourly', advisoryNightOffset: 0 });
    expect(s.nights()).toEqual([[14, 'tomorrow night'], [16, 'tonight']]);
    expect(s.t.sent().map((a) => a.nightOffset)).toEqual([1, 0]);
  });

  it('a NEW key during a gap (the crop set shrank) is held: only a located night can move, and the hold names its basis', async () => {
    // frostnightmove.test.js re-sends this same shrink when the hours locate tonight; here tonight is a guess.
    const s = await sequence({ today: MON, rows: TOMATO_MARIGOLD, runs: [thr(14, TOMORROW, { lows: [35, 46, 50] }), thr(15, GAP)] });
    expect(s.runs[15].evalLine.dedup_key).not.toBe(s.runs[14].evalLine.dedup_key);
    expect(s.nights()).toEqual([[14, 'tomorrow night']]);
    expect(s.runs[15].held).toHaveLength(1);
    expect(s.runs[15].held[0]).toMatchObject({ tier: 'advisory', night: 0, night_basis: 'base_rate' });
    expect(s.runs[15].held[0].already_sent.map((a) => a.night)).toEqual([1]);
  });

  it('S2 radiative-only: located -> no hourly temperature (the fallback names the EARLIER night) -> located: ONE email', async () => {
    const skies = [CLEAR, CLEAR];   // both nights clear, equal dewpoints: the fallback's tie keeps the earlier night
    const s = await sequence({ today: FRI, rows: PEPTOM, runs: [rad(14, TOMORROW, skies), rad(15, GAP, skies), rad(16, TOMORROW, skies)] });
    expect(s.runs[15].evalLine).toMatchObject({ tier: 'advisory', advisoryNightBasis: 'radiative', advisoryNightOffset: 0,
      radiativeAdvisoryNightBasis: 'base_rate' });
    expect(s.runs[15].evalLine.dedup_key).toBe(s.runs[14].evalLine.dedup_key);
    expect(s.emails.map((e) => [e.hour, e.subject])).toEqual([[14, 'Garden alert - Frost watch tomorrow night (low 42F)']]);
    expect(s.runs[15].held).toEqual([]);
    expect(s.t.sent().map((a) => a.nightOffset)).toEqual([1]);
    // CHANGED by V5-TODAYRADIATIVEWATCH-001 (lane frostwatch, 2026-09-21): the radiative-only advisory's entry now carries
    // `trip: 'radiative'` and Today words it as the watch its email is titled (was "Frost possible tomorrow night — …").
    expect(buildFrostAlertLine(s.t.sent()).text).toBe('Frost watch tomorrow night — clear and calm, low 42°F. Plan cover for tender plants.');
    expect(agreedTonightLow(s.t.items())).toBeNull();
  });

  it('S3 radiative-only: the fallback names the LATER night, then the hours locate the earlier one: TWO emails, as intended', async () => {
    const s = await sequence({ today: FRI, rows: PEPTOM, runs: [
      rad(14, GAP, [CLOUDY, CLEAR]),       // only tomorrow night is clear: the fallback trips on it and names it
      rad(15, TONIGHT, [CLEAR, CLEAR]),    // the hours put the minimum at the end of tonight, now clear too
      rad(16, TONIGHT, [CLEAR, CLEAR]),
    ] });
    expect(s.runs[14].evalLine).toMatchObject({ advisoryNightBasis: 'radiative', advisoryNightOffset: 1 });
    expect(s.runs[15].evalLine).toMatchObject({ advisoryNightBasis: 'hourly', advisoryNightOffset: 0 });
    expect(s.nights()).toEqual([[14, 'tomorrow night'], [15, 'tonight']]);
    expect(s.t.sent().map((a) => a.nightOffset)).toEqual([1, 0]);
  });
});

// A guessed night must never cost the warnings the rule does not touch: the first email of the day, a severity
// escalation and a crop newly at risk all go out on a gap run, at once.
describe('I1 — what a guessed night can never hide', () => {
  it('the first email of the plan date goes out on a gap run, naming the base-rate night; a later located night holds', async () => {
    const s = await sequence({ today: MON, rows: TOMATO, runs: [thr(14, GAP), thr(15, TOMORROW)] });
    expect(s.runs[14].evalLine).toMatchObject({ advisoryNightBasis: 'base_rate', advisoryNightOffset: 0 });
    expect(s.nights()).toEqual([[14, 'tonight']]);
    expect(s.runs[15].held).toHaveLength(1);
  });

  it('a crop newly at risk on a gap run is sent at once (the crop axis does not read the night)', async () => {
    const s = await sequence({ today: MON, rows: TOMATO_MARIGOLD, runs: [thr(14, TOMORROW), thr(15, GAP, { lows: [35, 46, 50] })] });
    expect(s.nights()).toEqual([[14, 'tomorrow night'], [15, 'tonight']]);
    expect(s.t.sent().at(-1).crops).toEqual({ tomato: 'advisory', marigold: 'advisory' });
  });

  it('a severity escalation on a gap run is sent at once (advisory -> FROST PROTECT TONIGHT)', async () => {
    const s = await sequence({ today: MON, rows: TOMATO, runs: [thr(14, TOMORROW), thr(15, GAP, { nws: 36 })] });
    expect(s.emails.map((e) => [e.hour, e.subject])).toEqual([
      [14, 'Garden alert - Frost advisory tomorrow night (low 38F)'],
      [15, 'Garden alert - Frost protect tonight (low 36F)'],
    ]);
  });

  it('RESIDUAL, accepted with the rule: every later run guesses while the coldest day really moved earlier -> not re-sent (v4.139.0 behaviour)', async () => {
    // 14 ET: D3's minimum at 23:00, located -> "Thursday night". 15-17 ET: D1 is now the coldest day, but no run has
    // the hours to say which of its two nights holds the minimum, so none of them counts as a move.
    const s = await sequence({ today: MON, rows: TOMATO, runs: [
      thr(14, [6, 6, 23], { lows: [44, 45, 38] }),
      ...[15, 16, 17].map((hr) => thr(hr, GAP, { lows: [38, 45, 44] })),
    ] });
    expect(s.runs[15].evalLine).toMatchObject({ advisoryNightBasis: 'base_rate', advisoryNightOffset: 0 });
    expect(s.runs[15].evalLine.dedup_key).toBe(s.runs[14].evalLine.dedup_key);
    expect(s.nights()).toEqual([[14, 'Thursday night']]);
  });
});
