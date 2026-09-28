// V5-TODAYFROSTWARMEDADVISORY-001 — the second model's lows reach the STORED plan, and nothing else moves.
//
// WHY. An advisory entry in alerts_sent ("Frost possible tonight — low 38°F") is a snapshot of Open-Meteo's best_match
// low at send time. Dedup is escalation-only, so a warmer forecast writes no fresh entry, and generatePlan copied the
// hydrology by named key without forecast_lows/forecast_dates: Today could not tell "the second model still says 38"
// from "it now says 45", and the email's figure held the card, the cue and the line all evening. The engine now stores
// the arrays this run fetched; src/lib/frostAlertLine.js decides what to do with them.
//
// Two layers, because each can fail on its own:
//   - generatePlan's RETURN: stored verbatim with the flag on; absent with it off or when the fetch supplied none (the
//     conditional spread that keeps every G-PARITY golden and every flag-off row byte-identical);
//   - the WRITTEN ROW through the real run(): handler.js's daily_plan write is a named-key literal, so only a written-row
//     test catches a key the engine emits and the write drops (leafWetnessWiring.test.js). The last case hands that row
//     to the Today client's own rule, end to end.
import { describe, it, expect, vi, afterEach } from 'vitest';
import engine from './engine.js';
import h from './handler.js';
import _cf from './_coverFlags.js';
import { buildFrostAlertLines, currentLows } from '../../src/lib/frostAlertLine.js';
import { agreedTonightLow } from '../../src/lib/tonightLow.js';

const { generatePlan } = engine;
const { withCoverFlags } = _cf;

const SPACE = 'sp1';
const USER = 'user_dave';
const TODAY = '2026-10-09';   // Fri, in the frost season
const LOWS = [41.2, 45.3, 47.1];
const DATES = ['2026-10-10', '2026-10-11', '2026-10-12'];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── the engine unit ──────────────────────────────────────────────────────────────────────────────────────────────────
const CAD = { default: { crop: 'unknown' }, by_variety: {}, by_genus_fallback: {} };
const WX = { tonightLow: 44, highToday: 62, code: 3, short: 'Cloudy', unit: 'F' };
const HY = {
  recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0,
  forecast_lows: LOWS, forecast_dates: DATES,
};
const withoutLows = ({ forecast_lows: _l, forecast_dates: _d, ...rest }) => rest;
const planOf = (hydrology, flag) => generatePlan({ plantings: [], cadence: CAD, fertModel: {}, today: TODAY, weather: WX, hydrology,
  ...(flag === undefined ? {} : { frostAlertEnabled: flag }) });

describe('generatePlan — the D1..D3 lows ride in the stored hydrology while the frost alert is on', () => {
  it('flag ON: stored verbatim, beside an otherwise unchanged hydrology', () => {
    const on = planOf(HY, true);
    expect(on.hydrology.forecast_lows).toEqual([41.2, 45.3, 47.1]);
    expect(on.hydrology.forecast_dates).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    expect(withoutLows(on.hydrology)).toEqual(planOf(HY, false).hydrology);
    // a hole stays a hole: null is never read as 0°F, here or by the client
    const holed = planOf({ ...HY, forecast_lows: [null, 45.3, null] }, true);
    expect(holed.hydrology.forecast_lows).toEqual([null, 45.3, null]);
  });

  it('flag OFF, or not passed: neither key exists, and the plan is byte-identical to one fed no lows at all', () => {
    for (const flag of [false, undefined]) {
      const off = planOf(HY, flag);
      expect(has(off.hydrology, 'forecast_lows'), String(flag)).toBe(false);
      expect(has(off.hydrology, 'forecast_dates'), String(flag)).toBe(false);
      expect(JSON.stringify(off)).toBe(JSON.stringify(planOf(withoutLows(HY), flag)));
    }
  });

  it('flag ON but the fetch supplied no lows: absent, byte-identical to the flag-off plan', () => {
    const on = planOf(withoutLows(HY), true);
    expect(has(on.hydrology, 'forecast_lows')).toBe(false);
    expect(has(on.hydrology, 'forecast_dates')).toBe(false);
    expect(JSON.stringify(on)).toBe(JSON.stringify(planOf(withoutLows(HY), false)));
    expect(planOf(null, true).hydrology).toEqual(planOf(null, false).hydrology);   // Open-Meteo down: status only
  });

  it('dates that are not an array are stored as null, never guessed; the lows still ride', () => {
    for (const forecast_dates of [undefined, null, 'x']) {
      const on = planOf({ ...HY, forecast_dates }, true);
      expect(on.hydrology.forecast_lows, String(forecast_dates)).toEqual(LOWS);
      expect(on.hydrology.forecast_dates, String(forecast_dates)).toBeNull();
    }
  });
});

// ── the written row, through the real run() ──────────────────────────────────────────────────────────────────────────
// The I2 ladder's alerts, as frostWeatherFacts stored them on this plan date: "Frost possible tonight (low 38°F)" at
// 14:02 ET on best_match's D1 minimum of 37.6, then "Frost protect tonight (low 38°F)" at 15:02 ET on the NWS low.
const SENT = [
  { key: `${SPACE}|${TODAY}|advisory|advisory`, tier: 'advisory', level: 'advisory', at: '2026-10-09T18:02:00.000Z', run: 'intraday-pm',
    lowF: 37.6, dayOffset: 1, date: '2026-10-10', nightOffset: 0 },
  { key: `${SPACE}|${TODAY}|imminent|protect`, tier: 'imminent', level: 'protect', at: '2026-10-09T19:02:00.000Z', run: 'intraday-pm',
    lowF: 38, dayOffset: 0 },
];

const planting = (id, slug, extra = {}) => withCoverFlags({
  id, name: `${slug} ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'pot', container_size: '5gal',
  rain_exposed: null, variety: slug, genus: null, project: 'Garden', project_status: 'active', workspace_id: SPACE,
  crop_type_slug: slug, covered: false, assignee_user_id: USER, db_cadence: null, last_water: '2026-10-08',
  last_fert: '2026-09-20', substrate_start: '2026-05-01', transplant_at: null, ...extra,
});

function pgStub(sent, plantings = [planting('p1', 'pepper'), planting('p2', 'tomato')]) {
  return {
    query: vi.fn(async (sql) => {
      if (/from plants/.test(sql)) return { rows: plantings };
      if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
      if (/select items->'alerts_sent' as alerts_sent from daily_plan/.test(sql)) return { rows: sent ? [{ alerts_sent: sent }] : [] };
      if (/^\s*select items from daily_plan/.test(sql)) return { rows: sent ? [{ items: { alerts_sent: sent } }] : [] };
      return { rows: [] };
    }),
  };
}
const written = (pg) => pg.query.mock.calls.filter(([sql]) => /insert into daily_plan/.test(sql)).map(([, p]) => JSON.parse(p[2]));

// A post-window evening run (20:00 ET): nothing evaluates, the list is carried forward, the plan is rewritten.
async function driveRun({ flag, lows = LOWS, dates = DATES, sent = null, tonightLow = 44 } = {}) {
  if (flag) vi.stubEnv('FROST_ALERT_ENABLED', 'true');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const pg = pgStub(sent);
  await h.run({
    pg, today: TODAY, dryRun: false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow, highToday: 60, code: 3, unit: 'F', short: 'Cloudy' }),
    fetchPrecip: async () => ({
      forecast_lows: lows, forecast_dates: dates,
      recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
      tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0,
    }),
    fetchStation: async () => null, publishAlert: vi.fn(async () => ({ messageId: 'm1' })),
    etHour: 20, event: {},
  });
  const rows = written(pg);
  expect(rows).toHaveLength(1);
  return rows[0];
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('the lows reach the row that is actually written', () => {
  it('THE REGRESSION CASE — flag on: this run\'s D1..D3 lows and dates are on the written row\'s hydrology', async () => {
    const row = await driveRun({ flag: true });
    expect(row.hydrology.forecast_lows).toEqual([41.2, 45.3, 47.1]);
    expect(row.hydrology.forecast_dates).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
  });

  it('flag off: neither key on the written row (and no alerts_sent, as before)', async () => {
    const row = await driveRun({ flag: false, sent: SENT });
    expect(has(row.hydrology, 'forecast_lows')).toBe(false);
    expect(has(row.hydrology, 'forecast_dates')).toBe(false);
    expect(has(row, 'alerts_sent')).toBe(false);
    expect(row.hydrology.tomorrow_pop).toBe(0);   // anti-vacuity: this IS the fetched hydrology
  });

  it('the evening after the ladder: the frozen emails are carried forward verbatim beside the fresh lows', async () => {
    const row = await driveRun({ flag: true, sent: SENT });
    expect(row.alerts_sent).toEqual(SENT);                  // no fresh entry: the advisory still says 37.6
    expect(row.hydrology.forecast_lows).toEqual(LOWS);
    expect(row.weather.tonightLow).toBe(44);
  });
});

describe('END TO END — the written row, read by the Today client\'s own rule', () => {
  const lines = (plan) => buildFrostAlertLines(plan.alerts_sent, { planLow: plan.weather.tonightLow, current: currentLows(plan) })
    .map((l) => l.text);

  it('both models warmed (NWS 44, best_match D1 41.2): the warmed line citing the 3:02 PM email, and the plan\'s own low', async () => {
    const row = await driveRun({ flag: true, sent: SENT });
    expect(lines(row)).toEqual(['Forecast warmed to 44°F since the 3:02 PM frost email.']);
    expect(agreedTonightLow(row)).toBeNull();               // the card and the cue keep the plan's 44
    // CONTROL: the same row without the stored lows is what Today showed before — the email's 38, frozen all evening.
    const before = { ...row, hydrology: withoutLows(row.hydrology) };
    expect(lines(before)).toEqual(['Frost possible tonight — low 38°F. Plan cover for tender plants.']);
    expect(agreedTonightLow(before)).toEqual({ lowF: 38, lowRaw: 37.6 });
  });

  it('the second model still in range (D1 39.6): the email\'s line and figure stand — colder wins', async () => {
    const row = await driveRun({ flag: true, sent: SENT, lows: [39.6, 45.3, 47.1] });
    expect(row.hydrology.forecast_lows).toEqual([39.6, 45.3, 47.1]);
    expect(lines(row)).toEqual(['Frost possible tonight — low 38°F. Plan cover for tender plants.']);
    expect(agreedTonightLow(row)).toEqual({ lowF: 38, lowRaw: 37.6 });
  });
});

// Adopted from the v4.158.0 pre-promote QA review (review-v4158-qa.md, the two-users probe). One Space holds plantings for
// Dave AND Jen, so one run() writes two daily_plan rows. Both must carry this run's lows and the same carried-forward
// alerts_sent (handler.readSpaceAlertsSent), so both phones retire the same email from the same facts.
describe('both users\' rows — one run(), two written rows, one decision (QA probe)', () => {
  it('two users, one Space, a post-window run: both written rows carry the arrays and both say "warmed"', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pg = pgStub(SENT, [planting('p1', 'pepper'), planting('p2', 'tomato', { assignee_user_id: 'user_jen' })]);
    await h.run({
      pg, today: TODAY, dryRun: false,
      geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
      fetchNWS: async () => ({ tonightLow: 44, highToday: 60, code: 3, unit: 'F', short: 'Cloudy' }),
      fetchPrecip: async () => ({ forecast_lows: LOWS, forecast_dates: DATES, recent_precip_in: 0, today_precip_in: 0, today_pop: 0,
        upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0 }),
      fetchStation: async () => null, publishAlert: vi.fn(async () => ({ messageId: 'm1' })),
      etHour: 20, event: {},
    });
    const rows = pg.query.mock.calls.filter(([sql]) => /insert into daily_plan/.test(sql)).map(([, p]) => ({ user: p[0], items: JSON.parse(p[2]) }));
    expect(rows.map((r) => r.user).sort()).toEqual(['user_dave', 'user_jen']);
    for (const r of rows) {
      expect(r.items.hydrology.forecast_lows, r.user).toEqual(LOWS);
      expect(r.items.hydrology.forecast_dates, r.user).toEqual(DATES);
      expect(r.items.alerts_sent, r.user).toEqual(SENT);
      const lines = buildFrostAlertLines(r.items.alerts_sent, { planLow: r.items.weather.tonightLow, current: currentLows(r.items) }).map((l) => l.text);
      expect(lines, r.user).toEqual(['Forecast warmed to 44°F since the 3:02 PM frost email.']);
    }
  });
});
