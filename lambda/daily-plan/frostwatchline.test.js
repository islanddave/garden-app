// V5-TODAYRADIATIVEWATCH-001 — the radiative "Frost watch" email and the Today line, end to end.
//
// THE GAP (FROST_RADIATIVE_ENABLED=true in prod). A radiative imminent trip fires when tonight's low is ABOVE the trip
// point but the night is clear and calm: with the tender band (38F) and the 4F proximity, at 39-42F. The email says
// "Garden alert - Frost watch tonight (low 41F)". The plan's weather cue for that low is "Cool night (41°F) — …" (or
// nothing at 45F+), and src/lib/frostAlertLine.js skipped every imminent entry on the premise that the freeze cue
// covers them. So Today never said "watch" on the evening the email did. A radiative-only ADVISORY had the same
// problem one tier down: its entry carried no trip basis, so its line read "Frost possible tonight — low 42°F".
//
// DAVE'S DECISION (2026-09-21, "Show it on Today"): Today shows the watch whenever that email goes out, and the in-app
// advisory says watch. The fix: frostWeatherFacts stores `trip: 'radiative'` on a radiative-only advisory entry (the
// imminent entry already carried it), and the client words any `trip: 'radiative'` entry as a watch and renders a
// radiative imminent entry (a threshold one still never renders). The email's "harvest ahead and stage row cover"
// clause is untouched (out of scope).
//
// Every run() case drives the real handler against an in-memory daily_plan (frostnightmove.test.js's shape) and reads
// the stored row back through the real client (buildFrostAlertLine, agreedTonightLow). The unit suite mocks SQL: none
// of this proves what Postgres does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import h from './handler.js';
import fe from './frostEval.js';
import _cf from './_coverFlags.js';
import { buildFrostAlertLine, buildFrostAlertLines, resolveNight, nightPhrase as clientNightPhrase } from '../../src/lib/frostAlertLine.js';
import { agreedTonightLow, agreeCallout } from '../../src/lib/tonightLow.js';

const { run, frostWeatherFacts, frostSubject } = h;
const { frostEval } = fe;
const { withCoverFlags } = _cf;

const SPACE = 'sp1';
const DAVE = 'user_dave';
const FRI = '2026-10-09';                                     // D1 Sat 10-10, D2 Sun 10-11, D3 Mon 10-12
const DATES = ['2026-10-10', '2026-10-11', '2026-10-12'];
const pad = (n) => String(n).padStart(2, '0');
const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };

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
const curve = (low, hour) => Array.from({ length: 24 }, (_, i) => (i === hour ? low : low + 4 + Math.abs(i - hour) * 0.5));
const hourlyTemp = (lows, minHours) => ({
  time: DATES.flatMap((d) => Array.from({ length: 24 }, (_, i) => `${d}T${pad(i)}:00`)),
  temperature_2m: DATES.flatMap((d, i) => curve(lows[i], minHours[i])), timezone: 'America/New_York',
});

function planTable(rows) {
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
  const items = () => store.get(`${DAVE}|${FRI}`) || {};
  return { pg, items, sent: () => items().alerts_sent || [] };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('FROST_ALERT_ENABLED', 'true');
  vi.stubEnv('FROST_RADIATIVE_ENABLED', 'true');   // prod, read 2026-09-18
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// One run of the plan date. Open-Meteo D1..D3 at 46/50/51 by default, above every advisory trip and its radiative
// reach (40 + 4), so the imminent tier is the whole story unless a case lowers them.
async function once(t, emails, { etHour, nws, lows = [46, 50, 51], minHours = [5, 6, 6], skies = [CLEAR, CLOUDY], event = {} }) {
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 9, etHour + 4, 0, 0)));
  await run({
    pg: t.pg, today: FRI, dryRun: false, etHour, event, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: nws, highToday: nws + 20, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => ({ forecast_lows: lows, forecast_dates: DATES, recent_precip_in: 0, today_precip_in: 0,
      today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0,
      hourly_frost: frostBlock(...skies), hourly_temp: hourlyTemp(lows, minHours) }),
    fetchStation: async () => null,
    publishAlert: async (m) => { if (m.topic === 'frost') emails.push({ hour: etHour, subject: m.subject, message: m.message }); return { messageId: 'mid' }; },
  });
}

const LINE = (when, t) => `Frost watch ${when} — clear and calm, low ${t}°F. Plan cover for tender plants.`;

describe('V5-TODAYRADIATIVEWATCH-001 — the radiative imminent email and Today say the same thing (real run())', () => {
  it('THE GAP: NWS 41 on a clear, calm night -> "Frost watch tonight (low 41F)", a trip:radiative entry, and the same watch on Today', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    await once(t, emails, { etHour: 15, nws: 41 });
    expect(emails.map((e) => e.subject)).toEqual(['Garden alert - Frost watch tonight (low 41F)']);
    expect(emails[0].message.startsWith('FROST WATCH TONIGHT — forecast low 41°F, but clear and calm')).toBe(true);
    expect(t.sent()).toHaveLength(1);
    expect(t.sent()[0]).toMatchObject({ tier: 'imminent', level: 'protect', lowF: 41, dayOffset: 0, trip: 'radiative', run: 'intraday-pm' });
    // The premise: the cue the plan carries for that low says "Cool night", not "Freeze".
    expect(t.items().weather.callout).toEqual({ icon: 'cold', text: 'Cool night (41°F) — protect flowering peppers/tomatoes' });
    // What Today renders from the stored row (it rendered nothing at base 3425da14).
    expect(buildFrostAlertLine(t.sent()).text).toBe(LINE('tonight', 41));
    expect(agreedTonightLow(t.items())).toEqual({ lowF: 41, lowRaw: 41 });
  });

  it('the rest of the evening: one email, and the watch stays on Today at the colder low as the forecast warms', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    for (const [hr, nws] of [[15, 41], [16, 41], [17, 43], [20, 44]]) await once(t, emails, { etHour: hr, nws });
    expect(emails.map((e) => e.hour)).toEqual([15]);
    expect(t.items().weather.tonightLow).toBe(44);
    expect(buildFrostAlertLine(t.sent()).text).toBe(LINE('tonight', 41));
    expect(agreedTonightLow(t.items())).toEqual({ lowF: 41, lowRaw: 41 });
  });

  it('unchanged: a THRESHOLD imminent send (NWS 36) stores no trip and stays off the line — the freeze cue says it', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    await once(t, emails, { etHour: 15, nws: 36 });
    expect(emails.map((e) => e.subject)).toEqual(['Garden alert - Frost protect tonight (low 36F)']);
    expect(t.sent()[0]).not.toHaveProperty('trip');
    expect(t.items().weather.callout).toEqual({ icon: 'freeze', text: 'Freeze tonight (36°F) — cover or bring peppers & tomatoes in' });
    expect(buildFrostAlertLine(t.sent())).toBeNull();
  });

  it('a hard freeze sent after the watch hands tonight back to the freeze cue: no stale watch beside "Freeze tonight"', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    await once(t, emails, { etHour: 15, nws: 41 });
    await once(t, emails, { etHour: 16, nws: 32 });
    expect(emails.map((e) => [e.hour, e.subject])).toEqual([
      [15, 'Garden alert - Frost watch tonight (low 41F)'], [16, 'Garden alert - HARD FREEZE tonight (low 32F)']]);
    expect(t.sent().map((a) => [a.level, a.trip ?? null])).toEqual([['protect', 'radiative'], ['hard_freeze', null]]);
    expect(t.items().weather.callout.icon).toBe('freeze');
    expect(buildFrostAlertLine(t.sent())).toBeNull();
  });

  it('a radiative-only ADVISORY (NWS 55, D1 42 before dawn, tonight clear) -> "Frost watch tonight" email, entry and line', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    await once(t, emails, { etHour: 15, nws: 55, lows: [42, 50, 51] });
    expect(emails.map((e) => e.subject)).toEqual(['Garden alert - Frost watch tonight (low 42F)']);
    expect(emails[0].message.startsWith('FROST WATCH — tonight looks clear and calm (low 42°F, 2026-10-10')).toBe(true);
    expect(t.sent()[0]).toMatchObject({ tier: 'advisory', lowF: 42, nightOffset: 0, trip: 'radiative' });
    expect(buildFrostAlertLine(t.sent()).text).toBe(LINE('tonight', 42));
    // CHANGED by V5-TODAYFROSTLINEGAPS-001 follow-up F3: this pinned the tail as out of scope ("Harvest ahead and stage row
    // cover."); Dave has since been asked (2026-09-21) and an email about TONIGHT now says what to do tonight.
    expect(emails[0].message.endsWith('Pick what\'s ripe and cover tender plants tonight.')).toBe(true);
  });

  // V5-TODAYFROSTLINEGAPS-001 — the colder advisory the watch email carries is stored on the entry (`colder`).
  it('a watch whose email carries "Colder on a second forecast: 35°F tonight" stores the 35 and its night on the entry', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    for (const hr of [15, 16, 17]) await once(t, emails, { etHour: hr, nws: 39, lows: [35, 50, 51], minHours: [4, 6, 6] });
    expect(emails.map((e) => [e.hour, e.subject])).toEqual([[15, 'Garden alert - Frost watch tonight (low 39F)']]);   // one email, as before
    expect(emails[0].message.endsWith(' Colder on a second forecast: 35°F tonight, 2026-10-10 — pick what\'s ripe and cover tender plants tonight.')).toBe(true);
    expect(t.sent()).toHaveLength(1);
    expect(t.sent()[0]).toMatchObject({ tier: 'imminent', level: 'protect', lowF: 39, dayOffset: 0, trip: 'radiative', run: 'intraday-pm',
      colder: { lowF: 35, dayOffset: 1, date: '2026-10-10', nightOffset: 0 } });
  });

  it('a watch whose email carries "Colder ahead: 35°F tomorrow night" stores that night on the entry', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    await once(t, emails, { etHour: 15, nws: 41, lows: [46, 35, 51], minHours: [5, 5, 6] });
    expect(emails.map((e) => e.subject)).toEqual(['Garden alert - Frost watch tonight (low 41F)']);
    expect(emails[0].message.endsWith(' Colder ahead: 35°F tomorrow night, 2026-10-11 — harvest ahead and stage row cover.')).toBe(true);
    expect(t.sent()).toHaveLength(1);   // the advisory is inside the watch email: no advisory entry of its own
    expect(t.sent()[0]).toMatchObject({ tier: 'imminent', trip: 'radiative', lowF: 41, colder: { lowF: 35, dayOffset: 2, date: '2026-10-11', nightOffset: 1 } });
  });
});

// ── V5-TODAYFROSTLINEGAPS-001 — what Today renders from the rows the real run() writes ────────────────────────────────
// Dave's three decisions (2026-09-21): (1) a watch and a later night's advisory are two lines, tonight's first; (2) the
// watch line shows its email's colder second forecast and the night agrees on it; (3) after a threshold frost email,
// "Forecast warmed to N°F since the 3 PM frost email." once the plan low has left the freeze cue. Every row below is
// written by the real handler and read back through the real client, as Today reads it.
const POSSIBLE = (when, t) => `Frost possible ${when} — low ${t}°F. Plan cover for tender plants.`;
const ASLOW = (when, t) => `Frost watch ${when} — clear and calm, as low as ${t}°F. Plan cover for tender plants.`;
const lines = (t) => buildFrostAlertLines(t.sent(), { lowShown: agreedTonightLow(t.items())?.lowF, planLow: t.items().weather.tonightLow }).map((l) => l.text);

describe('V5-TODAYFROSTLINEGAPS-001 — Today after the real run()', () => {
  it('(1) a 2 PM advisory for tomorrow night, then a 3 PM watch whose email repeats it -> both lines, tonight first', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    await once(t, emails, { etHour: 14, nws: 45, lows: [46, 35, 51], minHours: [5, 5, 6] });
    await once(t, emails, { etHour: 15, nws: 41, lows: [46, 35, 51], minHours: [5, 5, 6] });
    expect(emails.map((e) => e.hour)).toEqual([14, 15]);
    expect(emails[0].message.startsWith('FROST ADVISORY — frost possible tomorrow night (low 35°F, 2026-10-11)')).toBe(true);
    expect(emails[1].message).toMatch(/ Colder ahead: 35°F tomorrow night, 2026-10-11 — harvest ahead and stage row cover\.$/);
    expect(lines(t)).toEqual([LINE('tonight', 41), POSSIBLE('tomorrow night', 35)]);
    // BEFORE (base d9affbeb): the watch alone — one slot, and it took it.
    expect(buildFrostAlertLine(t.sent()).text).toBe(LINE('tonight', 41));
  });

  it('(1) the displaced case exactly: the watch email carries no clause, and the 2 PM advisory entry still shows', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    await once(t, emails, { etHour: 14, nws: 45, lows: [46, 35, 51], minHours: [5, 5, 6] });
    // by 3 PM tomorrow night's second-model low is no colder than the watch's 39: the watch email names no other night
    await once(t, emails, { etHour: 15, nws: 39, lows: [46, 39.5, 51], minHours: [5, 5, 6] });
    expect(emails.map((e) => e.hour)).toEqual([14, 15]);
    expect(emails[1].message).not.toMatch(/Colder/);
    expect(t.sent().map((a) => [a.tier, a.colder ?? null])).toEqual([['advisory', null], ['imminent', null]]);
    expect(lines(t)).toEqual([LINE('tonight', 39), POSSIBLE('tomorrow night', 35)]);
  });

  it('(1) the watch the first send of the day: its "Colder ahead" is the later night\'s line (no advisory entry exists)', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    await once(t, emails, { etHour: 15, nws: 41, lows: [46, 35, 51], minHours: [5, 5, 6] });
    expect(t.sent().map((a) => a.tier)).toEqual(['imminent']);
    expect(lines(t)).toEqual([LINE('tonight', 41), POSSIBLE('tomorrow night', 35)]);
  });

  it('(2) "Colder on a second forecast: 35°F tonight" -> "as low as 35°F", and the card and the cue say 35', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    await once(t, emails, { etHour: 15, nws: 39, lows: [35, 50, 51], minHours: [4, 6, 6] });
    expect(emails.map((e) => e.subject)).toEqual(['Garden alert - Frost watch tonight (low 39F)']);
    expect(lines(t)).toEqual([ASLOW('tonight', 35)]);
    const agreed = agreedTonightLow(t.items());
    expect(agreed).toEqual({ lowF: 35, lowRaw: 35 });
    expect(t.items().weather.callout).toEqual({ icon: 'freeze', text: 'Freeze tonight (39°F) — cover or bring peppers & tomatoes in' });
    expect(agreeCallout(t.items().weather.callout, agreed)).toMatchObject({ icon: 'freeze', text: 'Freeze tonight (35°F) — cover or bring peppers & tomatoes in' });
  });

  it('(3) a 3 PM "Frost protect tonight (low 36F)", then the plan warms: nothing while it freezes, then the facts', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    await once(t, emails, { etHour: 15, nws: 36 });
    expect(emails.map((e) => e.subject)).toEqual(['Garden alert - Frost protect tonight (low 36F)']);
    expect(lines(t)).toEqual([]);                                  // the cue says "Freeze tonight (36°F)"
    await once(t, emails, { etHour: 17, nws: 39 });
    expect(t.items().weather.callout.icon).toBe('freeze');
    expect(lines(t)).toEqual([]);                                  // still covered by the cue
    await once(t, emails, { etHour: 20, nws: 44 });
    expect(emails).toHaveLength(1);
    expect(t.items().weather.callout).toEqual({ icon: 'cold', text: 'Cool night (44°F) — protect flowering peppers/tomatoes' });
    expect(lines(t)).toEqual(['Forecast warmed to 44°F since the 3 PM frost email.']);
    expect(agreedTonightLow(t.items())).toBeNull();                // the card keeps the plan's 44
  });

  it('(3) a FORCED rehearsal never counts: the same warming after a rehearsal says nothing', async () => {
    const t = planTable(PEPTOM);
    const emails = [];
    await once(t, emails, { etHour: 13, nws: 36, event: { frostEval: true } });
    expect(emails.map((e) => e.hour)).toEqual([13]);
    expect(t.sent()[0]).toMatchObject({ tier: 'imminent', run: 'forced' });
    await once(t, emails, { etHour: 20, nws: 44 });
    expect(lines(t)).toEqual([]);
  });
});

// ── frostWeatherFacts — the advisory entry's trip basis ─────────────────────────────────────────────────────────────
describe('frostWeatherFacts — `trip: \'radiative\'` on exactly the advisories whose email is a watch', () => {
  const T = { ADVISORY_LOW_F: 40, IMMINENT_LOW_F: 38, HARD_FREEZE_LOW_F: 33 };
  const tender = (over = {}) => ({ slug: 'pepper', label: 'peppers', band: 'tender', count: 5, containers: 1, thresholds: T, ...over });
  const stamps = (date) => Array.from({ length: 24 }, (_, i) => `${date}T${pad(i)}:00`);
  const minAt = (date, low, hour) => ({ time: stamps(date), temperature_2m: curve(low, hour) });
  const clear = (date) => ({ date, minDewpointF: 33, meanCloudPct: 5, meanWindMph: 2, hours: 15, radiative: true });
  const ev = (over = {}) => frostEval({
    tonightLow: 55, highToday: 60, forecastLows: [42, 50, 51], forecastDates: DATES, lowSource: 'forecast',
    forecastHourly: minAt('2026-10-10', 42, 5), radiativeNights: [clear('2026-10-09')],
    exposure: { tender: 5, unknown: 0, tenderContainers: 1, atRisk: 5, byCropType: [tender()] },
    spaceId: 'S1', eventDate: FRI, ...over,
  }, { frostSeason: true, radiativeEnabled: true });

  it('a radiative-only advisory: the trip, beside the facts it always stored', () => {
    const d = ev();
    expect(d.message.startsWith('FROST WATCH — tonight')).toBe(true);
    expect(frostWeatherFacts(d)).toEqual({ lowF: 42, dayOffset: 1, date: '2026-10-10', nightOffset: 0, trip: 'radiative' });
  });

  it('a threshold advisory and a MIXED one (the plain "FROST ADVISORY" copy) store no trip', () => {
    const threshold = ev({ forecastLows: [37, 50, 51], forecastHourly: minAt('2026-10-10', 37, 5) });
    expect(threshold.message.startsWith('FROST ADVISORY — frost possible tonight')).toBe(true);
    expect(frostWeatherFacts(threshold)).not.toHaveProperty('trip');
    const cold = { ADVISORY_LOW_F: 36, IMMINENT_LOW_F: 34, HARD_FREEZE_LOW_F: 30 };
    const mixed = ev({ forecastLows: [39, 50, 51], forecastHourly: minAt('2026-10-10', 39, 5),
      exposure: { tender: 9, unknown: 0, atRisk: 9, byCropType: [tender(), tender({ slug: 'chard', label: 'chard', count: 4, thresholds: cold })] } });
    expect(mixed.trippedCrops.map((c) => c.trip || 'threshold').sort()).toEqual(['radiative', 'threshold']);
    expect(frostWeatherFacts(mixed)).not.toHaveProperty('trip');
    expect(buildFrostAlertLine([{ tier: 'advisory', level: 'advisory', at: 'z', ...frostWeatherFacts(mixed) }]).text)
      .toBe('Frost possible tonight — low 39°F. Plan cover for tender plants.');
  });

  it('an imminent decision keeps its own rule: the trip only when the IMMINENT tier was radiative-only', () => {
    const rad = ev({ tonightLow: 41, radiativeNights: [clear('2026-10-09')] });
    expect(rad.tier).toBe('imminent');
    expect(frostWeatherFacts(rad)).toEqual({ lowF: 41, dayOffset: 0, trip: 'radiative' });
    const thr = ev({ tonightLow: 36 });
    expect(frostWeatherFacts(thr)).toEqual({ lowF: 36, dayOffset: 0 });
  });
});

// ── V5-TODAYFROSTLINEGAPS-001 — the colder advisory a watch email carries is stored on its entry (`colder`) ──────────
// A radiative imminent message carries a colder advisory in its body ("Colder on a second forecast: 35°F tonight" or
// "Colder ahead: 35°F tomorrow night"), and the advisory entry is never written when the imminent tier wins. So the
// figure reached no screen. frostEval records it (decision.colder) and frostWeatherFacts stores it on the imminent entry
// in the advisory entry's own vocabulary; the Today client reads it (src/lib/frostAlertLine.js).
describe('colder — the advisory figure a watch email carries, stored where the client can read it', () => {
  const T = { ADVISORY_LOW_F: 40, IMMINENT_LOW_F: 38, HARD_FREEZE_LOW_F: 33 };
  const tender = { slug: 'pepper', label: 'peppers', band: 'tender', count: 5, containers: 1, thresholds: T };
  const stamps = (date) => Array.from({ length: 24 }, (_, i) => `${date}T${pad(i)}:00`);
  const minAt = (date, low, hour) => ({ time: stamps(date), temperature_2m: curve(low, hour) });
  const clear = (date) => ({ date, minDewpointF: 33, meanCloudPct: 5, meanWindMph: 2, hours: 15, radiative: true });
  const watchEv = (lows, hourly, tonightLow = 39) => frostEval({
    tonightLow, highToday: 60, forecastLows: lows, forecastDates: DATES, lowSource: 'forecast', forecastHourly: hourly,
    radiativeNights: [clear('2026-10-09')], exposure: { tender: 5, unknown: 0, tenderContainers: 1, atRisk: 5, byCropType: [tender] },
    spaceId: 'S1', eventDate: FRI,
  }, { frostSeason: true, radiativeEnabled: true });

  it('the same night: the second forecast\'s low, its day, and night 0 — exactly what the clause printed', () => {
    const d = watchEv([35, 50, 51], minAt('2026-10-10', 35, 4));
    expect(d.message).toMatch(/ Colder on a second forecast: 35°F tonight, 2026-10-10 — /);
    expect(d.colder).toEqual({ lowF: 35, dayOffset: 1, date: '2026-10-10', nightOffset: 0 });
    expect(frostWeatherFacts(d)).toEqual({ lowF: 39, dayOffset: 0, trip: 'radiative', colder: { lowF: 35, dayOffset: 1, date: '2026-10-10', nightOffset: 0 } });
  });

  it('a later night: the night the "Colder ahead" clause named, tomorrow night or a weekday', () => {
    const tomorrow = watchEv([46, 35, 51], minAt('2026-10-11', 35, 5), 41);
    expect(tomorrow.message).toMatch(/ Colder ahead: 35°F tomorrow night, 2026-10-11 — harvest ahead and stage row cover\.$/);
    expect(frostWeatherFacts(tomorrow).colder).toEqual({ lowF: 35, dayOffset: 2, date: '2026-10-11', nightOffset: 1 });
    const evening = watchEv([34.5, 50, 51], minAt('2026-10-10', 34.5, 22), 41);   // D1's minimum at 22:00 -> tomorrow night
    expect(evening.message).toMatch(/ Colder ahead: 34\.5°F tomorrow night, 2026-10-10 — /);
    expect(evening.colder).toEqual({ lowF: 34.5, dayOffset: 1, date: '2026-10-10', nightOffset: 1 });
    const monday = watchEv([46, 47, 33], minAt('2026-10-12', 33, 23), 41);
    expect(monday.message).toMatch(/ Colder ahead: 33°F Monday night, 2026-10-12 — /);
    expect(monday.colder).toEqual({ lowF: 33, dayOffset: 3, date: '2026-10-12', nightOffset: 3 });
  });

  it('no clause, no field: an advisory not colder than the watch, one that does not fire, and a threshold imminent', () => {
    // 39 is not colder than the watch's 39: no clause, and the entry is exactly what it was before this change.
    const tie = watchEv([39, 50, 51], minAt('2026-10-10', 39, 4));
    expect(tie.tier).toBe('imminent');
    expect(tie.message).not.toMatch(/Colder/);
    expect(tie.colder).toBeNull();
    expect(frostWeatherFacts(tie)).toEqual({ lowF: 39, dayOffset: 0, trip: 'radiative' });
    const warm = watchEv([46, 50, 51], minAt('2026-10-10', 46, 4));
    expect([warm.message.includes('Colder'), warm.colder]).toEqual([false, null]);
    // A threshold imminent carries no clause (the rule is for the radiative watch only), so no field.
    const thr = watchEv([33, 50, 51], minAt('2026-10-10', 33, 4), 36);
    expect(thr.imminent.radiativeOnly).toBe(false);
    expect([thr.message.includes('Colder'), thr.colder]).toEqual([false, null]);
    expect(frostWeatherFacts(thr)).toEqual({ lowF: 36, dayOffset: 0 });
    // NEAR-MISS CONTROL for the tie: one tenth colder and the clause and the field both appear.
    expect(watchEv([38.9, 50, 51], minAt('2026-10-10', 38.9, 4)).colder).toEqual({ lowF: 38.9, dayOffset: 1, date: '2026-10-10', nightOffset: 0 });
  });

  it('PARITY GRID — whenever the message carries a clause, `colder` holds its figure and names its night; else absent', () => {
    let same = 0; let ahead = 0; let none = 0;
    for (const day of [0, 1, 2]) {
      for (const hour of [0, 4, 7, 11, 12, 18, 23, null]) {
        for (const low of [30, 34.5, 36, 37, 39, 41]) {
          for (const tonightLow of [39, 41.5]) {
            const lows = [50, 51, 52]; lows[day] = low;
            const d = watchEv(lows, hour == null ? null : minAt(DATES[day], low, hour), tonightLow);
            const at = `D${day + 1} hour=${hour} low=${low} nws=${tonightLow}`;
            expect(d.tier, at).toBe('imminent');
            const m = / Colder (on a second forecast|ahead): (-?[\d.]+)°F (.+?), (\d{4}-\d{2}-\d{2}) — /.exec(d.message);
            const facts = frostWeatherFacts(d);
            if (!m) { expect(facts, at).not.toHaveProperty('colder'); none++; continue; }
            expect(facts.colder.lowF, at).toBe(Number(m[2]));
            expect(facts.colder.date, at).toBe(m[4]);
            // the night the CLIENT resolves from the stored facts is the night the clause named
            expect(clientNightPhrase(resolveNight(facts.colder)), at).toBe(m[3]);
            expect(facts.colder.nightOffset === 0, at).toBe(m[1] === 'on a second forecast');
            if (m[1] === 'ahead') ahead++; else same++;
          }
        }
      }
    }
    expect(same).toBeGreaterThan(20);
    expect(ahead).toBeGreaterThan(20);
    expect(none).toBeGreaterThan(20);
  });

  it('no "already sent?" reader sees it: the gates answer the same for the entry with and without `colder`', () => {
    const d = watchEv([35, 50, 51], minAt('2026-10-10', 35, 4));
    const withC = { key: d.dedupKey, tier: 'imminent', level: 'protect', at: '2026-10-09T19:00:00.000Z', run: 'intraday-pm', crops: d.cropLevels, ...frostWeatherFacts(d) };
    const { colder: _c, ...without } = withC;
    expect(withC.colder).toBeTruthy();
    expect(fe.sentNight(withC)).toBe(fe.sentNight(without));
    expect(fe.countsAsSent(withC)).toBe(fe.countsAsSent(without));
    for (const next of [{ level: 'protect', crops: d.cropLevels, night: 0 }, { level: 'advisory', crops: null, night: 1 }, { level: 'hard_freeze', crops: { pepper: 'hard_freeze' }, night: 0 }]) {
      expect(fe.escalatesBeyond([withC], next), JSON.stringify(next)).toBe(fe.escalatesBeyond([without], next));
    }
    const coverage = new Map([['p1', 'named']]);
    const dec = { trippedCrops: [{ slug: 'pepper', level: 'protect', ids: ['p1'] }] };
    expect([...fe.sentCoverage(dec, coverage, [withC])]).toEqual([...fe.sentCoverage(dec, coverage, [without])]);
  });
});

// ── PARITY — the watch email and the Today watch line name the same night and the same number ──────────────────────
describe('PARITY — a radiative-only advisory: body, subject and Today line agree on the night and the low', () => {
  it('for every day, every hour of the minimum (and none), across month, year and DST edges', () => {
    const T = { ADVISORY_LOW_F: 40, IMMINENT_LOW_F: 38, HARD_FREEZE_LOW_F: 33 };
    const exposure = { tender: 5, unknown: 0, tenderContainers: 1, atRisk: 5,
      byCropType: [{ slug: 'pepper', label: 'peppers', band: 'tender', count: 5, containers: 1, thresholds: T }] };
    const stamps = (date) => Array.from({ length: 24 }, (_, i) => `${date}T${pad(i)}:00`);
    let n = 0;
    for (const plan of ['2026-09-20', '2026-10-30', '2026-10-31', '2026-11-13', '2026-12-30', '2027-03-12']) {
      const dates = [1, 2, 3].map((k) => addDays(plan, k));
      // every candidate night clear, so whichever night the trigger judges can trip
      const nights = [-1, 0, 1, 2, 3].map((k) => ({ date: addDays(plan, k), minDewpointF: 33, meanCloudPct: 5, meanWindMph: 2, hours: 15, radiative: true }));
      for (const day of [1, 2, 3]) {
        for (const hour of [0, 4, 7, 11, 12, 18, 23, null]) {
          for (const low of [40.6, 42.4, 43.6]) {
            const lows = [50, 50, 50]; lows[day - 1] = low;
            const hourly = hour == null ? null : { time: stamps(dates[day - 1]), temperature_2m: curve(low, hour) };
            const d = frostEval({ tonightLow: 60, highToday: 70, forecastLows: lows, forecastDates: dates, forecastHourly: hourly,
              radiativeNights: nights, exposure, spaceId: 'S', eventDate: plan }, { frostSeason: true, radiativeEnabled: true });
            const at = `${plan} D${day} ${hour}:00 ${low}F`;
            expect(d.tier, at).toBe('advisory');
            const body = /^FROST WATCH — (.+?) looks clear and calm \(low (-?[\d.]+)°F/.exec(d.message);
            const subj = /^Garden alert - Frost watch (.+?) \(low (-?\d+)F\)$/.exec(frostSubject(d));
            const line = /^Frost watch (.+?) — clear and calm, low (-?\d+)°F\. Plan cover for tender plants\.$/
              .exec(buildFrostAlertLine([{ tier: 'advisory', level: 'advisory', at: 'z', ...frostWeatherFacts(d) }]).text);
            expect([!!body, !!subj, !!line], at).toEqual([true, true, true]);
            expect([line[1], Number(line[2])], at).toEqual([body[1], Math.round(Number(body[2]))]);
            expect([subj[1], Number(subj[2])], at).toEqual([line[1], Number(line[2])]);
            n++;
          }
        }
      }
    }
    expect(n).toBe(6 * 3 * 8 * 3);
  });
});
