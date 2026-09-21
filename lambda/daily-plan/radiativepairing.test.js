// BUG-RADIATIVEPAIRINGNIGHT-001 — WHOSE SKY the radiative advisory trigger judges.
//
// THE DEFECT (live: FROST_RADIATIVE_ENABLED=true in prod since v4.135.1). The radiative advisory test asks whether
// the night that makes the picked civil day's minimum is clear and calm enough to fall below its forecast. It
// judged the night keyed D-1 — the one that ENDED on D's morning — whatever hour the minimum fell. Right for a
// morning minimum; for an evening one (~22% of days here) it judged the previous night's sky: it could MISS the
// minimum's own clear night, and FIRE on the previous night's clear sky while naming it "tonight".
//
// THE FIX, pinned here: frostEval.radiativeAdvisoryPairing.
//   hourly    — the series located the minimum (frostEval.locateNight, v4.138.0): judge that night, and only it.
//               A night with no sky in the window (a D3 evening minimum) gives no radiative verdict.
//   base_rate — the series could not say: judge BOTH candidate nights and trip if either would
//               (radiativeFrost.mostPermissiveNight). A superset of the old D-1 pairing, so a missing hourly
//               block can add a false alarm but never cost an alert the old code sent.
// The pairing basis rides on the frost-eval line (radiativeAdvisoryNight / radiativeAdvisoryNightBasis), in the
// vocabulary advisoryNightBasis already uses.
//
// Also pinned: the no-lows record no longer THROWS with radiative on (preship-delta 2a — `prevDate(undefined)` in
// the old pairing line took down every evaluating run during an Open-Meteo outage, imminent tier included).
//
// Run under TZ=UTC and TZ=America/New_York. Every date here is a label; nothing should move with the zone.
//
// MUTATION LOG — 2026-09-19, lane-radiativefix-20260919. Each applied alone to frostEval.js / radiativeFrost.js; the
// 11 frost test files (362 tests) run under BOTH zones; file restored and sha256-checked against HEAD. All RED, same
// tests in both zones; every test in this file is killed by at least one. RED counts over the 362:
//   pairing reverted to night D-1 (the defect) 15 · located ignored, always the fallback 13 · fallback judges only D-1
//   6 / only D 9 · located also unions 10 · mostPermissiveNight: highest dewpoint 3 / tie -> later 1 / ignores
//   `radiative` 5 / first candidate always 7 / nothing trippable -> null 2 · candidates reversed 2 · fallback names the
//   base-rate night 3 · located copy re-based 'radiative' 4 · nightOffset always day-1 4 · line drops the night 10 /
//   constant basis 7 · no-date guard removed (the crash) 48 · flag gate removed 1 · pairing from the gated view 1 ·
//   threshold branch reads the night first 7.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fe from './frostEval.js';
import rf from './radiativeFrost.js';
import h from './handler.js';
import _cf from './_coverFlags.js';
import { buildFrostAlertLine } from '../../src/lib/frostAlertLine.js';

const { frostEval, radiativeAdvisoryPairing } = fe;
const { radiativeTrips, mostPermissiveNight, nightsFrom } = rf;
const { run, frostForSpace, frostWeatherFacts } = h;
const { withCoverFlags } = _cf;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
// Plan date Fri 2026-10-09 (in season). D1 = Sat 10-10, D2 = Sun 10-11, D3 = Mon 10-12.
const PLAN = '2026-10-09';
const DATES = ['2026-10-10', '2026-10-11', '2026-10-12'];
const T = { ADVISORY_LOW_F: 40, IMMINENT_LOW_F: 38, HARD_FREEZE_LOW_F: 33 };
const tender = (over = {}) => ({ slug: 'pepper', label: 'peppers', band: 'tender', count: 5, containers: 1, thresholds: T, ...over });
const pad = (n) => String(n).padStart(2, '0');
const stamps = (date) => Array.from({ length: 24 }, (_, i) => `${date}T${pad(i)}:00`);
// A day whose single coldest hour is `hour` at `low`; every other hour is warmer (the daily figure is its minimum).
const dayCurve = (low, hour) => Array.from({ length: 24 }, (_, i) => (i === hour ? low : low + 4 + Math.abs(i - hour) * 0.5));
const minAt = (date, low, hour) => ({ time: stamps(date), temperature_2m: dayCurve(low, hour), timezone: 'America/New_York' });
const CLEAR = { meanCloudPct: 5, meanWindMph: 2, hours: 15, radiative: true };
const CLOUDY = { meanCloudPct: 95, meanWindMph: 12, hours: 15, radiative: false };
const clear = (date, minDewpointF = 34) => ({ ...CLEAR, date, minDewpointF });
const cloudy = (date, minDewpointF = 34) => ({ ...CLOUDY, date, minDewpointF });

// The real frostEval, the way frostForSpace calls it, radiative ON unless told otherwise.
const ev = (over = {}, opts = {}) => frostEval({
  tonightLow: 55, highToday: 60, forecastLows: [42, 50, 51], forecastDates: DATES, lowSource: 'forecast',
  forecastHourly: null, radiativeNights: [],
  exposure: { tender: 5, unknown: 0, tenderContainers: 1, atRisk: 5, byCropType: [tender()] },
  spaceId: 'S1', eventDate: PLAN, ...over,
}, { frostSeason: true, radiativeEnabled: true, ...opts });

// The radiative-only advisory head (a FROST WATCH since V5-RADIATIVESUBJECTCOPY-001): night, low, date, dewpoint.
const head = (msg) => (/^FROST WATCH — (.+?) looks clear and calm \(low (\d+)°F, (\S+), dewpoint (\d+)°F\)/.exec(msg || '') || []).slice(1);

// ── 1 — the located pairing ───────────────────────────────────────────────────────────────────────────
describe('located minimum — the trigger judges the night the hours put the minimum in, and only that night', () => {
  it('EVENING minimum (23:00 D1): its own night\'s clear sky fires — the case the old pairing MISSED', () => {
    const r = ev({ forecastHourly: minAt('2026-10-10', 42, 23), radiativeNights: [cloudy('2026-10-09'), clear('2026-10-10', 31)] });
    expect(r.tier).toBe('advisory');
    expect(r.advisoryCrops.tripped[0].trip).toBe('radiative');
    expect(head(r.message)).toEqual(['tomorrow night', '42', '2026-10-10', '31']);
    expect(r.advisory).toMatchObject({ nightOffset: 1, nightDate: '2026-10-10', nightBasis: 'hourly', minHour: 23 });
    expect(frostWeatherFacts(r)).toMatchObject({ lowF: 42, dayOffset: 1, nightOffset: 1 });
  });

  it('EVENING minimum: the PREVIOUS night\'s clear sky no longer fires — the old false alarm, which called it "tonight"', () => {
    const r = ev({ forecastHourly: minAt('2026-10-10', 42, 23), radiativeNights: [clear('2026-10-09'), cloudy('2026-10-10')] });
    expect(r.tier).toBeNull();
    expect(r.advisoryCrops.tripped).toEqual([]);
  });

  it('MORNING minimum (05:00 D1): unchanged — the night that ended that morning is judged, "tonight"', () => {
    const fires = ev({ forecastHourly: minAt('2026-10-10', 42, 5), radiativeNights: [clear('2026-10-09', 33), cloudy('2026-10-10')] });
    expect(fires.tier).toBe('advisory');
    expect(head(fires.message)).toEqual(['tonight', '42', '2026-10-10', '33']);
    expect(fires.advisory).toMatchObject({ nightOffset: 0, nightDate: '2026-10-09', nightBasis: 'hourly' });
    const silent = ev({ forecastHourly: minAt('2026-10-10', 42, 5), radiativeNights: [cloudy('2026-10-09'), clear('2026-10-10')] });
    expect(silent.tier).toBeNull();
  });

  it('located means ONE night: a clearer neighbour is not borrowed (its lower dewpoint is not quoted either)', () => {
    // Both nights clear. Morning minimum -> night 10-09 (dewpoint 39, still <= 40). The fallback would pick 10-10's
    // 30F dewpoint; the located pairing must not.
    const r = ev({ forecastHourly: minAt('2026-10-10', 42, 5), radiativeNights: [clear('2026-10-09', 39), clear('2026-10-10', 30)] });
    expect(head(r.message)).toEqual(['tonight', '42', '2026-10-10', '39']);
    expect(r.observability).toMatchObject({ radiativeAdvisoryNight: '2026-10-09', radiativeAdvisoryNightBasis: 'hourly' });
    // and a located night that cannot trip stays silent even when the neighbour could
    const r2 = ev({ forecastHourly: minAt('2026-10-10', 42, 5), radiativeNights: [clear('2026-10-09', 41), clear('2026-10-10', 30)] });
    expect(r2.tier).toBeNull();
  });

  it('D2 and D3 shift the same way', () => {
    const lows = (i) => { const l = [50, 51, 52]; l[i] = 42; return l; };
    // D2 = 10-11: morning -> night 10-10 ("tomorrow night"); evening -> night 10-11 ("Sunday night").
    const d2m = ev({ forecastLows: lows(1), forecastHourly: minAt('2026-10-11', 42, 6), radiativeNights: [clear('2026-10-10', 33), cloudy('2026-10-11')] });
    expect(head(d2m.message).slice(0, 1)).toEqual(['tomorrow night']);
    const d2e = ev({ forecastLows: lows(1), forecastHourly: minAt('2026-10-11', 42, 22), radiativeNights: [cloudy('2026-10-10'), clear('2026-10-11', 33)] });
    expect(head(d2e.message).slice(0, 1)).toEqual(['Sunday night']);
    const d2eOld = ev({ forecastLows: lows(1), forecastHourly: minAt('2026-10-11', 42, 22), radiativeNights: [clear('2026-10-10', 33), cloudy('2026-10-11')] });
    expect(d2eOld.tier).toBeNull();
    // D3 = 10-12: morning -> night 10-11 ("Sunday night").
    const d3m = ev({ forecastLows: lows(2), forecastHourly: minAt('2026-10-12', 42, 7), radiativeNights: [clear('2026-10-11', 33)] });
    expect(head(d3m.message).slice(0, 1)).toEqual(['Sunday night']);
  });

  it('D3 EVENING minimum: its night runs past the forecast window, so there is no sky to judge — no verdict, never another night\'s', () => {
    // The real window: past_days=2 & forecast_days=4 -> hourly 10-07..10-12. Build every hour clear and calm and let
    // the REAL nightsFrom key it: night 10-12 holds only 18:00-23:00 (6 < MIN_HOURS) and is not derived.
    const days = ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'];
    const time = days.flatMap(stamps);
    const nights = nightsFrom({ time, dew_point_2m: time.map(() => 33), cloud_cover: time.map(() => 3), wind_speed_10m: time.map(() => 1) });
    expect(nights.map((n) => n.date)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
    const r = ev({ forecastLows: [50, 51, 42], forecastHourly: minAt('2026-10-12', 42, 23), radiativeNights: nights });
    expect(r.advisory).toMatchObject({ dayOffset: 3, nightOffset: 3, nightBasis: 'hourly' });
    expect(r.tier).toBeNull();                                  // night 10-11 is clear, and is not this minimum's night
    expect(r.observability).toMatchObject({ radiativeAdvisoryNight: null, radiativeAdvisoryNightBasis: 'hourly' });
    // CONTROL: the same window with a D3 MORNING minimum judges night 10-11, which exists, and fires.
    const m = ev({ forecastLows: [50, 51, 42], forecastHourly: minAt('2026-10-12', 42, 7), radiativeNights: nights });
    expect(m.tier).toBe('advisory');
    expect(m.observability).toMatchObject({ radiativeAdvisoryNight: '2026-10-11', radiativeAdvisoryNightBasis: 'hourly' });
  });

  it('the THRESHOLD trigger does not read the pairing: a 38F D1 fires on its trip point whatever the skies', () => {
    for (const hourly of [minAt('2026-10-10', 38, 5), minAt('2026-10-10', 38, 23), null]) {
      for (const nights of [[], [clear('2026-10-09')], [clear('2026-10-10')], [cloudy('2026-10-09'), cloudy('2026-10-10')]]) {
        const r = ev({ forecastLows: [38, 50, 51], forecastHourly: hourly, radiativeNights: nights });
        expect(r.tier).toBe('advisory');
        expect(r.advisoryCrops.tripped).toEqual([expect.objectContaining({ slug: 'pepper', level: 'advisory' })]);
        expect(r.advisoryCrops.tripped[0].trip).toBeUndefined();
        expect(r.message).toMatch(/^FROST ADVISORY — frost possible /);
      }
    }
  });
});

// ── 2 — the fallback ─────────────────────────────────────────────────────────────────────────────────────
describe('no usable hourly series — BOTH candidate nights are judged (the frost-safe direction)', () => {
  it('only the night keyed D-1 is clear: fires, names it (the old pairing, kept)', () => {
    const r = ev({ radiativeNights: [clear('2026-10-09', 33), cloudy('2026-10-10')] });
    expect(r.tier).toBe('advisory');
    expect(head(r.message)).toEqual(['tonight', '42', '2026-10-10', '33']);
    expect(r.advisory).toMatchObject({ nightOffset: 0, nightDate: '2026-10-09', nightBasis: 'radiative' });
    expect(r.observability).toMatchObject({ advisoryNightBasis: 'radiative', radiativeAdvisoryNight: '2026-10-09', radiativeAdvisoryNightBasis: 'base_rate' });
  });

  it('only the night keyed D is clear: fires too (the extra warning), and names THAT night, whose sky it quotes', () => {
    const r = ev({ radiativeNights: [cloudy('2026-10-09'), clear('2026-10-10', 31)] });
    expect(r.tier).toBe('advisory');
    expect(head(r.message)).toEqual(['tomorrow night', '42', '2026-10-10', '31']);
    expect(r.advisory).toMatchObject({ nightOffset: 1, nightDate: '2026-10-10', nightBasis: 'radiative' });
    expect(frostWeatherFacts(r)).toMatchObject({ nightOffset: 1 });
    // CHANGED by V5-TODAYRADIATIVEWATCH-001 (lane frostwatch, 2026-09-21): the entry carries `trip: 'radiative'`, so the
    // Today line is the watch its email is titled. Was "Frost possible tomorrow night — low 42°F. …".
    expect(buildFrostAlertLine([{ tier: 'advisory', level: 'advisory', at: 'z', ...frostWeatherFacts(r) }]).text)
      .toBe('Frost watch tomorrow night — clear and calm, low 42°F. Plan cover for tender plants.');
    expect(r.observability).toMatchObject({ advisoryNightOffset: 1, radiativeAdvisoryNight: '2026-10-10', radiativeAdvisoryNightBasis: 'base_rate' });
  });

  it('a series that cannot vouch for the figure (misaligned) is the same as none: both nights judged', () => {
    // The hours say 45 at 23:00; the printed daily minimum is 42. locateNight refuses (base_rate), so the pairing
    // may not trust the hour either.
    const misaligned = { time: stamps('2026-10-10'), temperature_2m: dayCurve(45, 23) };
    const r = ev({ forecastHourly: misaligned, radiativeNights: [cloudy('2026-10-09'), clear('2026-10-10')] });
    expect(r.advisory.minHour).toBeUndefined();
    expect(r.tier).toBe('advisory');
    expect(r.observability.radiativeAdvisoryNightBasis).toBe('base_rate');
  });

  it('both clear: the lower dewpoint is the one quoted and named; a tie keeps the EARLIER night', () => {
    const lower = ev({ radiativeNights: [clear('2026-10-09', 38), clear('2026-10-10', 30)] });
    expect(head(lower.message)).toEqual(['tomorrow night', '42', '2026-10-10', '30']);
    const tie = ev({ radiativeNights: [clear('2026-10-09', 34), clear('2026-10-10', 34)] });
    expect(head(tie.message)).toEqual(['tonight', '42', '2026-10-10', '34']);
    const earlierLower = ev({ radiativeNights: [clear('2026-10-09', 30), clear('2026-10-10', 38)] });
    expect(head(earlierLower.message)).toEqual(['tonight', '42', '2026-10-10', '30']);
  });

  it('neither clear: silent, and the line records the D-1 night as the one judged', () => {
    const r = ev({ radiativeNights: [cloudy('2026-10-09'), cloudy('2026-10-10', 20)] });
    expect(r.tier).toBeNull();
    expect(r.observability).toMatchObject({ radiativeAdvisoryNight: '2026-10-09', radiativeAdvisoryNightBasis: 'base_rate' });
  });

  it('UNION GRID — per crop, the fallback trips EXACTLY when either candidate night would, and never less than the old D-1 pairing', () => {
    const variants = [null, { ...CLOUDY, minDewpointF: 30 }, ...[30, 38, 40, 41, 45].map((d) => ({ ...CLEAR, minDewpointF: d }))];
    let n = 0; let added = 0; let unionTrips = 0; let oldTrips = 0;
    for (const e of variants) {
      for (const l of variants) {
        const early = e && { ...e, date: '2026-10-09' };
        const late = l && { ...l, date: '2026-10-10' };
        for (const trip of [36, 40, 44, 47]) {
          for (const low of [38, 40, 42, 44, 45]) {
            const band = { ADVISORY_LOW_F: trip, IMMINENT_LOW_F: trip - 2, HARD_FREEZE_LOW_F: trip - 7 };
            const r = ev({ forecastLows: [low, 55, 56], radiativeNights: [early, late].filter(Boolean),
              exposure: { tender: 5, unknown: 0, atRisk: 5, byCropType: [tender({ thresholds: band })] } });
            const union = radiativeTrips(early, low, trip) || radiativeTrips(late, low, trip);
            const old = radiativeTrips(early, low, trip);
            const at = `early=${JSON.stringify(e)} late=${JSON.stringify(l)} trip=${trip} low=${low}`;
            const got = r.advisoryCrops.tripped[0] || null;
            expect(!!got, at).toBe(low <= trip || union);
            if (low > trip) {
              expect(!!got && got.trip === 'radiative', at).toBe(union);
              if (old) expect(got, `${at} lost a pre-fix trip`).toBeTruthy();
              if (union && !old) added++;
              if (union) unionTrips++;
              if (old) oldTrips++;
            }
            // the helper's equivalence, checked against radiativeTrips itself
            expect(radiativeTrips(mostPermissiveNight([early, late]), low, trip), at).toBe(union);
            n++;
          }
        }
      }
    }
    expect(n).toBe(7 * 7 * 4 * 5);
    expect(added, 'the fallback must add trips the old pairing missed').toBeGreaterThan(0);
    expect(oldTrips, 'the grid must contain pre-fix trips').toBeGreaterThan(0);
    expect(unionTrips).toBeGreaterThan(oldTrips);
  });

  it('LOCATED GRID — with the hours, exactly one night is judged, and the verdict differs from the old pairing when the minimum is in the evening', () => {
    const variants = [null, { ...CLOUDY, minDewpointF: 30 }, ...[30, 38, 41].map((d) => ({ ...CLEAR, minDewpointF: d }))];
    let differsFromOld = 0; let differsFromUnion = 0;
    for (const e of variants) {
      for (const l of variants) {
        const early = e && { ...e, date: '2026-10-09' };
        const late = l && { ...l, date: '2026-10-10' };
        for (const hour of [0, 5, 11, 12, 18, 23]) {
          const r = ev({ forecastHourly: minAt('2026-10-10', 42, hour), radiativeNights: [early, late].filter(Boolean) });
          const judged = hour < 12 ? early : late;
          const want = radiativeTrips(judged, 42, 40);
          const at = `hour=${hour} early=${JSON.stringify(e)} late=${JSON.stringify(l)}`;
          expect(r.advisoryCrops.tripped.length > 0, at).toBe(want);
          expect(r.observability.radiativeAdvisoryNightBasis, at).toBe('hourly');
          expect(r.observability.radiativeAdvisoryNight, at).toBe(judged ? judged.date : null);
          if (want !== radiativeTrips(early, 42, 40)) differsFromOld++;
          if (want !== (radiativeTrips(early, 42, 40) || radiativeTrips(late, 42, 40))) differsFromUnion++;
        }
      }
    }
    expect(differsFromOld).toBeGreaterThan(0);
    expect(differsFromUnion).toBeGreaterThan(0);
  });
});

// ── 3 — the pairing helper, directly ──────────────────────────────────────────────────────────────────────
describe('radiativeAdvisoryPairing / mostPermissiveNight — the pieces', () => {
  const pick = (over) => ({ fires: false, minLowF: 42, dayOffset: 1, date: '2026-10-10', ...over });
  const nights = [clear('2026-10-09', 38), clear('2026-10-10', 30)];

  it('a located record pairs with its own night; the fallback with the more permissive candidate', () => {
    expect(radiativeAdvisoryPairing(nights, pick({ nightBasis: 'hourly', nightDate: '2026-10-09', nightOffset: 0 })))
      .toEqual({ night: nights[0], nightDate: '2026-10-09', nightOffset: 0, basis: 'hourly' });
    expect(radiativeAdvisoryPairing(nights, pick({ nightBasis: 'base_rate', nightDate: '2026-10-09', nightOffset: 0 })))
      .toEqual({ night: nights[1], nightDate: '2026-10-10', nightOffset: 1, basis: 'base_rate' });
    // D3: the candidates are nights 10-11 and 10-12; offsets count from the plan date.
    expect(radiativeAdvisoryPairing([clear('2026-10-11')], pick({ dayOffset: 3, date: '2026-10-12', nightBasis: 'base_rate' })))
      .toMatchObject({ nightDate: '2026-10-11', nightOffset: 2, basis: 'base_rate' });
  });

  it('nothing to pair -> nulls, never a throw (the no-lows record, a pick with no date, garbage)', () => {
    const none = { night: null, nightDate: null, nightOffset: null, basis: null };
    for (const a of [{ fires: false, reason: 'no_forecast_lows', minLowF: null, coveredDays: 0 }, pick({ date: null }),
      pick({ date: '2026-13-45x' }), pick({ dayOffset: 0 }), null, undefined]) {
      expect(radiativeAdvisoryPairing(nights, a)).toEqual(none);
    }
    expect(radiativeAdvisoryPairing(null, pick({ nightBasis: 'base_rate' }))).toMatchObject({ night: null, basis: 'base_rate' });
  });

  it('mostPermissiveNight ignores a non-radiative night however low its dewpoint, and a radiative one with no dewpoint', () => {
    const c = cloudy('2026-10-09', 10);
    const noDew = { ...CLEAR, date: '2026-10-10', minDewpointF: null };
    expect(mostPermissiveNight([c, clear('2026-10-10', 39)]).date).toBe('2026-10-10');
    expect(mostPermissiveNight([c, noDew])).toBe(c);                    // nothing can trip: the first present
    expect(mostPermissiveNight([null, noDew])).toBe(noDew);
    expect(mostPermissiveNight([])).toBeNull();
    expect(mostPermissiveNight(null)).toBeNull();
  });
});

// ── 4 — observability, flag off, and the crash ───────────────────────────────────────────────────────────
describe('the frost-eval line records the pairing; the flag still gates the trip', () => {
  it('flag OFF: the pairing is recorded (corpus rule) and nothing trips', () => {
    const r = ev({ forecastHourly: minAt('2026-10-10', 42, 23), radiativeNights: [clear('2026-10-10')] }, { radiativeEnabled: false });
    expect(r.tier).toBeNull();
    expect(r.observability).toMatchObject({ radiativeEnabled: false, radiativeAdvisoryNight: '2026-10-10', radiativeAdvisoryNightBasis: 'hourly' });
  });

  it('no pick -> the pairing fields are null', () => {
    const r = ev({ forecastLows: null, radiativeNights: [clear('2026-10-09')] });
    expect(r.observability).toMatchObject({ radiativeAdvisoryNight: null, radiativeAdvisoryNightBasis: null });
  });
});

describe('preship-delta 2a — radiative ON and no usable lows no longer throws', () => {
  it('frostEval: the no-lows record and a pick with no date label evaluate, degraded, without a throw', () => {
    const noLows = ev({ forecastLows: null, forecastDates: null, radiativeNights: [] });
    expect(noLows.advisoryDegraded).toBe(true);
    expect(noLows.advisory.reason).toBe('no_forecast_lows');
    const noDates = ev({ forecastLows: [42, 50, 51], forecastDates: null, radiativeNights: [clear('2026-10-09')] });
    expect(noDates.advisory.date).toBeNull();
    expect(noDates.tier).toBeNull();                            // no date -> no night to judge -> no radiative trip
  });

  it('frostForSpace with hydrology null and FROST_RADIATIVE_ENABLED=true (the env the Lambda reads)', () => {
    vi.stubEnv('FROST_RADIATIVE_ENABLED', 'true');
    const row = withCoverFlags({ id: 'p1', name: 'pepper p1', status: 'fruiting', container_type: 'pot', crop_type_slug: 'pepper', variety: 'pepper', covered: false });
    const { decision } = frostForSpace({ rows: [row], weather: { tonightLow: 50, highToday: 60 }, hydrology: null,
      spaceId: 'S1', today: PLAN, frostSeason: true });
    expect(decision.observability.radiativeEnabled).toBe(true);
    expect(decision.advisoryDegraded).toBe(true);
    expect(decision.advisoryDegradedAlert).toBe(true);
  });
});

// ── 5 — end to end through the real run() ───────────────────────────────────────────────────────────────
const SPACE = 'sp1';
const planting = (id, slug) => withCoverFlags({
  id, name: `${slug} ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: slug, genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: slug, covered: false,
  assignee_user_id: 'user_dave', db_cadence: null, last_water: '2026-10-08', last_fert: '2026-09-20',
  substrate_start: '2026-05-01', transplant_at: null,
});
const PLANTINGS = [planting('p1', 'pepper'), planting('p2', 'tomato')];

// index.js hourly_frost for nights 10-09 and 10-10, verbatim shape: 18:00 -> 08:00 per night.
const frostBlock = (n0909, n1010) => {
  const time = []; const dew = []; const cloud = []; const wind = [];
  const add = (date, next, n) => {
    for (const hr of [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      time.push(`${hr >= 18 ? date : next}T${pad(hr)}:00`);
      dew.push(n.dew); cloud.push(n.cloud); wind.push(n.wind);
    }
  };
  add('2026-10-09', '2026-10-10', n0909);
  add('2026-10-10', '2026-10-11', n1010);
  return { time, dew_point_2m: dew, cloud_cover: cloud, wind_speed_10m: wind, timezone: 'America/New_York' };
};
const SKY_CLEAR = { dew: 31, cloud: 4, wind: 2 };
const SKY_CLOUDY = { dew: 31, cloud: 95, wind: 12 };
const hydrology = ({ hourlyTemp, frost }) => ({
  forecast_lows: [42, 50, 51], forecast_dates: DATES, hourly_temp: hourlyTemp, hourly_frost: frost,
  recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0,
  tomorrow_pop: 0, yesterday_precip_actual_in: 0,
});

async function drive({ hy, tonightLow = 55 }) {
  vi.stubEnv('FROST_ALERT_ENABLED', 'true');
  vi.stubEnv('FROST_RADIATIVE_ENABLED', 'true');
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const writes = [];
  const pg = { query: vi.fn(async (sql, params) => {
    if (/insert into daily_plan/.test(sql)) { writes.push(JSON.parse(params[2])); return { rows: [] }; }
    if (/from plants/.test(sql)) return { rows: PLANTINGS };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    return { rows: [] };
  }) };
  const publishAlert = vi.fn(async () => ({ messageId: 'mid-1' }));
  await run({
    pg, today: PLAN, dryRun: false, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow, highToday: 60, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => hy, fetchStation: async () => null, publishAlert, etHour: 15, event: {},
  });
  const published = publishAlert.mock.calls.map(([a]) => a);
  const evalLine = logs.mock.calls.map(([l]) => { try { return JSON.parse(l); } catch { return null; } })
    .find((l) => l && l.msg === 'frost-eval');
  return { frost: published.filter((a) => a.topic === 'frost'), ops: published.filter((a) => a.topic === 'ops'), row: writes.at(-1), evalLine };
}

describe('END TO END — real run(), radiative ON: the published text, the stored entry, the Today line and the log agree', () => {
  it('evening minimum, the minimum\'s own night clear: published, "tomorrow night", basis hourly on the line', async () => {
    const { frost, row, evalLine } = await drive({ hy: hydrology({ hourlyTemp: minAt('2026-10-10', 42, 23), frost: frostBlock(SKY_CLOUDY, SKY_CLEAR) }) });
    expect(frost).toHaveLength(1);
    expect(head(frost[0].message)).toEqual(['tomorrow night', '42', '2026-10-10', '31']);
    expect(frost[0].subject).toBe('Garden alert - Frost watch tomorrow night (low 42F)');
    // CHANGED by V5-TODAYRADIATIVEWATCH-001 (lane frostwatch, 2026-09-21): the entry records the radiative trip and the
    // Today line says watch, naming the same night. Was: no `trip`, "Frost possible tomorrow night — low 42°F. …".
    expect(row.alerts_sent.at(-1)).toMatchObject({ tier: 'advisory', lowF: 42, dayOffset: 1, date: '2026-10-10', nightOffset: 1, trip: 'radiative' });
    expect(buildFrostAlertLine(row.alerts_sent).text).toBe('Frost watch tomorrow night — clear and calm, low 42°F. Plan cover for tender plants.');
    expect(evalLine).toMatchObject({ forecastMinHour: 23, advisoryNightOffset: 1, advisoryNightBasis: 'hourly',
      radiativeAdvisoryNight: '2026-10-10', radiativeAdvisoryNightBasis: 'hourly', radiativeNightsAvailable: 2 });
  });

  it('evening minimum, only the PREVIOUS night clear: nothing published (the old pairing sent "tonight looks clear and calm")', async () => {
    const { frost, evalLine } = await drive({ hy: hydrology({ hourlyTemp: minAt('2026-10-10', 42, 23), frost: frostBlock(SKY_CLEAR, SKY_CLOUDY) }) });
    expect(frost).toHaveLength(0);
    expect(evalLine).toMatchObject({ tier: null, radiativeAdvisoryNight: '2026-10-10', radiativeAdvisoryNightBasis: 'hourly' });
  });

  it('hourly temperature missing: both nights judged, the later one\'s clear sky publishes and is named', async () => {
    const { frost, row, evalLine } = await drive({ hy: hydrology({ hourlyTemp: null, frost: frostBlock(SKY_CLOUDY, SKY_CLEAR) }) });
    expect(frost).toHaveLength(1);
    expect(head(frost[0].message)).toEqual(['tomorrow night', '42', '2026-10-10', '31']);
    expect(row.alerts_sent.at(-1)).toMatchObject({ nightOffset: 1 });
    expect(evalLine).toMatchObject({ advisoryNightBasis: 'radiative', radiativeAdvisoryNight: '2026-10-10', radiativeAdvisoryNightBasis: 'base_rate' });
  });

  it('Open-Meteo down (hydrology null) at an evaluating hour: the run completes, the NWS imminent alert and the degraded notice go out', async () => {
    // At base 10452156 this run THREW (TypeError reading 'split'): no plan row, no frost alert of any tier.
    const { frost, ops, row, evalLine } = await drive({ hy: null, tonightLow: 36 });
    expect(row).toBeTruthy();
    expect(frost).toHaveLength(1);
    expect(frost[0].message).toMatch(/^FROST PROTECT TONIGHT — low 36°F\./);
    expect(ops.map((a) => a.subject)).toContain('Garden ops - frost advisory DEGRADED');
    expect(evalLine).toMatchObject({ radiativeEnabled: true, radiativeNightsAvailable: 0, radiativeAdvisoryNightBasis: null });
  });
});
