// BUG-INGROUND39FSLIVER-001 — an in-ground cold card may drop only when the frost EMAIL names the planting.
//
// V5-COLDCARDREACHABLE-001 drops an in-ground planting's bring_in/protect card because a bed cannot be carried
// inside, so it relies on the frost email (Dave 2026-09-17). The drop was keyed on the CLASS only ("a kind the
// alert ever names"), so on nights the email stayed silent the bed got nothing: NWS 39F with Open-Meteo D1 42F
// trips neither the imminent tier (<= 38 on NWS) nor the advisory (<= 40 on Open-Meteo). coldFor now reads
// frostEval.frostCoverage over the handler's own frost decision (handler.frostForSpace), per planting:
// 'named' / 'above_band' drop the card, 'unnamed' / absent / no coverage keep it.
//
// coldcardreachable.test.js carries the NWS-vs-Open-Meteo INVARIANT matrix and the 40/41F gap boundary. This
// file pins the OTHER ways "the email covers it" can be false, and that the coverage follows the email in each:
// a radiative trip, a crop the single message leaves out, the non-evaluating runs, and an invalid override.
// Everything that says "the email" drives the real run() and reads what publishAlert received. No Postgres:
// decisions and the stored plan only, not DB behaviour.
//
// MUTATION LOG — 2026-09-18, lane-ingroundsliver-20260918. Each applied alone, this file plus
// coldcardreachable.test.js and ingroundoffseason.test.js run, RED observed, file restored (sha256 checked).
// RED counts are over all three files (46 tests):
//   * coldFor drops on class alone (the pre-fix semantics)                 -> 6 RED (matrix, boundary, cloudy, supersede, 09/20 ET)
//   * coldFor drops on the card's own `low < 40` instead of the decision   -> 5 RED
//   * accepted gap closed (only 'named' drops)                             -> 6 RED (41F boundary, 48F pins, 50F-profile beds)
//   * no coverage / no entry also drops                                    -> 5 RED (hardy leek, invalid override x2, defaults)
//   * band judged on Open-Meteo D1 instead of the NWS low (source swap)     -> 8 RED
//   * named = message crops UNION all advisory-tripped crops               -> 1 RED (single-message supersede)
//   * named from the imminent tier only                                    -> 3 RED (matrix, 41/39 unit, supersede)
//   * frostCoverage: null-low branch / no-decision branch / null-band
//     branch dropped                                                       -> 1 RED each (their unit tests)
//   * above_band restated as `low > 40`                                    -> 2 RED (the light_frost_tolerant marigold)
//   * summarize stops recording ids                                        -> 23 RED
//   * handler: non-evaluating runs never compute coverage                  -> 3 RED; compute it with the flag off -> 1 RED;
//     no try/catch there -> 1 RED; evaluating runs swallow the throw too   -> 1 RED
//   * handler hands no coverage / engine stops forwarding it (x2)          -> 12 / 19 / 18 RED
//   * coverage from a second, threshold-only evaluation (no radiative)     -> 1 RED (the FROST WATCH case)
//   * coverage looked up by name instead of id                             -> 7 RED
//   * flag defaults true at coldFor / generatePlanForUser / generatePlan,
//     `!!flag` for `=== true`                                              -> 1 RED each (ingroundoffseason defaults)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import h from './handler.js';
import fe from './frostEval.js';
import fc from './frostClass.js';

const { run, frostForSpace } = h;
const { frostEval, frostCoverage } = fe;

const SPACE = 'sp1';
const USER = 'user_dave';
const TODAY = '2026-10-05';   // in frost season, the ledger row's date
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

const row = (id, extra) => ({
  id, name: id, project_id: 'pj1', status: 'vegetative', container_size: null, rain_exposed: null,
  project: 'Garden', project_status: 'active', workspace_id: SPACE, assignee_user_id: USER,
  db_cadence: null, cadence_scopes: null, last_water: null, last_fert: null, substrate_start: '2026-04-20',
  transplant_at: null, rain_exposed_resolved: true, frost_covered_resolved: false, heated_resolved: false,
  ...extra,
});
const potato = (id, container_type) => row(id, { variety: 'Yukon Gold', genus: 'Solanum', crop_type_slug: 'potato', container_type });
const BED = potato('Potato bed', 'in_ground');
const BAG = potato('Potato bag', 'fabric_bag');
// HYPOTHETICAL profile, to reach the per-crop path: a light_frost_tolerant crop (band 36/34/30) carrying a
// tender cold profile above its own imminent point. The one bundled marigold profile carries 32F, where the
// band's imminent tier (34) always trips first, so no bundled row is in this gap today. `_seeded` is how a DB
// profile is adopted with CARE_CADENCE_SCOPES_ENABLED off (engine.resolveCadence).
const MARIGOLD_BED = row('Marigold bed', { variety: 'Test Marigold', genus: 'Tagetes', crop_type_slug: 'marigold',
  container_type: 'in_ground', db_cadence: { _seeded: true, crop: 'marigold', cold: { tender: true, protect_below_F: 40 },
    water_interval_days_inground: 3 } });
const TOMATO_POT = row('Tomato pot', { variety: 'Sungold', genus: 'Solanum', crop_type_slug: 'tomato', container_type: 'plastic_pot' });

// V5-RADIATIVEFROST-001 fixture shape (frost-wiring.test.js): a clear, calm 18:00->08:00 night keyed on `date`.
const night = (date, { dew = 33, cloud = 4, wind = 2 } = {}) => {
  const hours = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8];
  const time = hours.map((hr) => `${hr >= 18 ? date : addDays(date, 1)}T${String(hr).padStart(2, '0')}:00`);
  return { time, dew_point_2m: time.map(() => dew), cloud_cover: time.map(() => cloud),
    wind_speed_10m: time.map(() => wind), timezone: 'America/New_York' };
};

async function drive({ rows, nws, om, etHour = 15, today = TODAY, hourlyFrost = null }) {
  const publishAlert = vi.fn(async () => ({ messageId: 'mid' }));
  const pg = { query: async (sql) => {
    if (/from plants/.test(sql)) return { rows };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    return { rows: [] };
  } };
  const res = await run({
    pg, today, dryRun: false, etHour, event: {}, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: nws, highToday: nws + 20, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => ({ forecast_lows: [om, om + 8, om + 12], forecast_dates: [1, 2, 3].map((n) => addDays(today, n)),
      recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0,
      tomorrow_pop: 0, yesterday_precip_actual_in: 0, hourly_frost: hourlyFrost }),
    fetchStation: async () => null, publishAlert,
  });
  const cards = res.plans.flatMap((pl) => pl.plan.tasks.cold);
  return {
    card: (p) => cards.find((c) => c.name === p.name) || null,
    frost: publishAlert.mock.calls.map(([m]) => m).filter((m) => m.topic === 'frost'),
  };
}

let logSpy, errSpy;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('BUG-INGROUND39FSLIVER-001 — frostCoverage reads the decision; it restates no threshold', () => {
  const P = potato('p1', 'in_ground');
  const W = row('w1', { variety: 'Tender Sweet Orange', genus: 'Citrullus', crop_type_slug: 'watermelon', container_type: 'in_ground' });
  const M = { ...MARIGOLD_BED, id: 'm1' };
  const K = row('k1', { variety: 'Lacinato', genus: 'Brassica', crop_type_slug: 'kale', container_type: 'in_ground' });
  const HOUSE = { ...potato('h1', 'plastic_pot'), heated_resolved: true };
  const cover = ({ nws, om = null, bandThresholds }) => {
    const exposure = fc.summarize([P, W, M, K, HOUSE], bandThresholds ? { bandThresholds } : {});
    const decision = frostEval({ tonightLow: nws, forecastLows: om == null ? null : [om, om + 8, om + 12],
      forecastDates: [addDays(TODAY, 1), addDays(TODAY, 2), addDays(TODAY, 3)], exposure, spaceId: SPACE, eventDate: TODAY });
    return { decision, cov: frostCoverage(decision, exposure, nws) };
  };
  const standing = (c) => Object.fromEntries(['p1', 'w1', 'm1', 'k1', 'h1'].map((id) => [id, c.get(id) ?? null]));

  it('39/42 (the ledger row): the email sends nothing, so every in-band planting is unnamed', () => {
    const { decision, cov } = cover({ nws: 39, om: 42 });
    expect(decision.alert).toBe(false);
    // marigold's own advisory point is 36: 39 is above its band, silent by design
    expect(standing(cov)).toEqual({ p1: 'unnamed', w1: 'unnamed', m1: 'above_band', k1: null, h1: null });
  });

  it('38 on NWS: imminent names the tender and chill bands; the marigold (imminent 34) is not in the message', () => {
    const { decision, cov } = cover({ nws: 38, om: 45 });
    expect(decision.tier).toBe('imminent');
    expect(decision.message).toMatch(/potatoes/);
    expect(decision.message).not.toMatch(/marigold/i);
    expect(standing(cov)).toEqual({ p1: 'named', w1: 'named', m1: 'above_band', k1: null, h1: null });
  });

  it('41 on NWS, 39 on Open-Meteo: the ADVISORY names them, so the higher NWS low does not matter', () => {
    const { decision, cov } = cover({ nws: 41, om: 39 });
    expect(decision.tier).toBe('advisory');
    expect(standing(cov)).toMatchObject({ p1: 'named', w1: 'named' });
  });

  it('null tonight low proves nothing is above a band: unnamed, never above_band', () => {
    const { cov } = cover({ nws: null, om: 45 });
    expect(standing(cov)).toEqual({ p1: 'unnamed', w1: 'unnamed', m1: 'unnamed', k1: null, h1: null });
  });

  it('a band with NO trip points (explicit null override) has no band to be above: unnamed', () => {
    // tender -> null makes the email never name potatoes; the potato still sits in the exposure.
    const { cov } = cover({ nws: 45, om: 47, bandThresholds: { tender: null } });
    expect(cov.get('p1')).toBe('unnamed');
    expect(cov.get('w1')).toBe('above_band');   // chill_sensitive still has its 40F advisory point
  });

  it('no decision -> no coverage at all (the engine then keeps every card)', () => {
    const exposure = fc.summarize([P]);
    expect(frostCoverage(null, exposure, 38)).toBeNull();
  });

  it('summarize carries EVERY planting id per crop group (names stay capped at 5)', () => {
    const seven = Array.from({ length: 7 }, (_, i) => potato(`pp${i}`, 'in_ground'));
    const [g] = fc.summarize(seven).byCropType;
    expect(g.names).toHaveLength(5);
    expect(g.ids).toEqual(seven.map((p) => p.id));
  });
});

describe('BUG-INGROUND39FSLIVER-001 — the coverage follows the email through run()', () => {
  it('radiative trip (prod has FROST_RADIATIVE_ENABLED on): 39F clear and calm is a FROST WATCH naming potatoes, so the bed drops', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('FROST_RADIATIVE_ENABLED', 'true');
    const r = await drive({ rows: [BED, BAG], nws: 39, om: 45, hourlyFrost: night(TODAY) });
    expect(r.frost).toHaveLength(1);
    expect(r.frost[0].message).toMatch(/FROST WATCH TONIGHT/);
    expect(r.frost[0].message).toMatch(/potatoes/);
    expect(r.card(BED)).toBeNull();
    expect(r.card(BAG)).toMatchObject({ level: 'bring_in' });
  });

  it('the SAME 39F on a cloudy, windy night trips nothing, so the bed keeps its card', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('FROST_RADIATIVE_ENABLED', 'true');
    const r = await drive({ rows: [BED, BAG], nws: 39, om: 45, hourlyFrost: night(TODAY, { cloud: 95, wind: 12 }) });
    expect(r.frost).toHaveLength(0);
    expect(r.card(BED)).toMatchObject({ level: 'bring_in' });
  });

  it('the single message names only the imminent crops: a bed whose crop only met its ADVISORY point keeps its card', async () => {
    // Space-level, not per planting: with the tomato present the imminent tier wins (36 <= 38) and the one
    // message names tomatoes only; the marigold's own imminent point is 34, and its advisory match (Open-Meteo
    // 35 <= 36) is not in the message. The class-only check dropped this bed's card anyway.
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const both = await drive({ rows: [MARIGOLD_BED, TOMATO_POT], nws: 36, om: 35 });
    expect(both.frost).toHaveLength(1);
    expect(both.frost[0].message).toMatch(/tomatoes/);
    expect(both.frost[0].message).not.toMatch(/marigold/i);
    expect(both.card(MARIGOLD_BED)).toMatchObject({ level: 'protect' });
    // CONTROL: alone, nothing trips imminent, the advisory names the marigolds, and the bed's card drops.
    const alone = await drive({ rows: [MARIGOLD_BED], nws: 36, om: 35 });
    expect(alone.frost).toHaveLength(1);
    expect(alone.frost[0].message).toMatch(/FROST ADVISORY/);
    expect(alone.frost[0].message).toMatch(/marigolds/);
    expect(alone.card(MARIGOLD_BED)).toBeNull();
  });
});

describe('BUG-INGROUND39FSLIVER-001 — the runs that do not evaluate frost', () => {
  // 18 of the 19 hourly runs a day fall outside 14-17 ET or before it; their plan is what Today shows for
  // most of the day. They compute the same decision from their own forecast and use only its coverage: no
  // publish, no frost-eval log. Without that the in-ground card would return every frost morning.
  // CHANGED by BUG-INGROUNDPOSTWINDOW-001 (lane frostsent, 2026-09-18): this was one loop over [9, 20] asserting
  // the 20:00 run ALSO drops the 38F bed "because the email's predicate names it" — with nothing sent. That is
  // the post-window silence the row closes (no card, no email). The 09:00 half is unchanged: the evaluating runs
  // still follow a morning run on the same plan date. The 20:00 half now asserts the card is kept, and
  // frostsent.test.js carries the post-window cases with an email that WAS sent.
  it('09:00 ET, flag on: 38F drops the bed (the email\'s predicate names it), 39/42 keeps it; nothing is sent', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const cold = await drive({ rows: [BED, BAG], nws: 38, om: 45, etHour: 9 });
    expect(cold.frost).toHaveLength(0);
    expect(cold.card(BED)).toBeNull();
    expect(cold.card(BAG)).toMatchObject({ level: 'bring_in' });
    const sliver = await drive({ rows: [BED, BAG], nws: 39, om: 42, etHour: 9 });
    expect(sliver.frost).toHaveLength(0);
    expect(sliver.card(BED)).toMatchObject({ level: 'bring_in' });
  });

  it('20:00 ET, flag on, nothing sent today: 38F KEEPS the bed (no email went out to cover it), and so does 39/42', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const cold = await drive({ rows: [BED, BAG], nws: 38, om: 45, etHour: 20 });
    expect(cold.frost).toHaveLength(0);
    expect(cold.card(BED)).toMatchObject({ level: 'bring_in' });
    expect(cold.card(BAG)).toMatchObject({ level: 'bring_in' });
    const sliver = await drive({ rows: [BED, BAG], nws: 39, om: 42, etHour: 20 });
    expect(sliver.frost).toHaveLength(0);
    expect(sliver.card(BED)).toMatchObject({ level: 'bring_in' });
  });

  it('an invalid FROST_BAND_THRESHOLDS_JSON: a non-evaluating run still writes its plan and KEEPS the bed card', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('FROST_BAND_THRESHOLDS_JSON', JSON.stringify({ not_a_band: { ADVISORY_LOW_F: 1 } }));
    const r = await drive({ rows: [BED, BAG], nws: 35, om: 40, etHour: 9 });
    expect(r.card(BED)).toMatchObject({ level: 'bring_in' });
    const errs = errSpy.mock.calls.map(([l]) => { try { return JSON.parse(l); } catch { return {}; } });
    expect(errs.some((e) => e.msg === 'frost coverage FAILED — in-ground cold cards kept' && /unknown band/.test(e.error))).toBe(true);
  });

  it('...while the evaluating run still fails LOUD on it, exactly as before', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    vi.stubEnv('FROST_BAND_THRESHOLDS_JSON', JSON.stringify({ not_a_band: { ADVISORY_LOW_F: 1 } }));
    await expect(drive({ rows: [BED, BAG], nws: 35, om: 40, etHour: 15 })).rejects.toThrow(/unknown band/);
  });

  it('flag off: a non-evaluating run does not evaluate frost at all (the invalid override is never read)', async () => {
    vi.stubEnv('FROST_BAND_THRESHOLDS_JSON', JSON.stringify({ not_a_band: { ADVISORY_LOW_F: 1 } }));
    const r = await drive({ rows: [BED, BAG], nws: 35, om: 40, etHour: 9 });
    expect(r.card(BED)).toMatchObject({ level: 'bring_in' });
    expect(errSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some(([l]) => /frost-eval/.test(String(l)))).toBe(false);
  });
});
