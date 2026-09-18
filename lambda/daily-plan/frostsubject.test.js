// BUG-FROSTADVISORYNIGHTWORDING-001 F9.1 — the frost EMAIL SUBJECT names the advisory's own night and low.
//
// THE DEFECT. handler.frostSubject appended observability.tonightLowF — the NWS low for TONIGHT — for every tier.
// For an advisory that is a second model's figure about a night the advisory is usually not about, so the line
// the phone notification shows read "Garden alert - Frost advisory (low 55F)" above a body saying "frost possible
// Monday night (low 34.7°F, 2026-09-21)". With NWS down it quoted no low at all.
//
// THE FIX, pinned here: the advisory subject takes its night (frostEval nightPhrase(advisoryNight(a))) and its low
// (a.lowF ?? a.minLowF, rounded as src/lib/frostAlertLine.js rounds the Today line) from the record advisoryMessage
// worded. Imminent and heat subjects are byte-identical to the pre-fix function, held against a verbatim copy of it.
//
// INSTRUMENTS. Every advisory below comes out of the REAL frostEval or the real run(), never a hand-built record,
// except where a test says why, so a drift between what the body prints and what the subject prints cannot hide
// in a fixture. The run() cases capture the SNS publish and the written row. Run under TZ=UTC and
// TZ=America/New_York: the weekday names must not move with the process zone.
//
// MUTATION LOG — 2026-09-18, lane-frostsubject-20260918. 21 mutations of handler.js, each applied alone, this file
// plus frost-wiring, advisorynight and frostsent run (142 tests) under BOTH zones, file restored and sha256-checked
// against HEAD. All 21 RED, same tests in both zones; every test in this file is killed by at least one. RED counts
// over the 142:
//   advisory tail: reverted to tonightLowF (the defect) 16 · night phrase dropped 16 · low not rounded / floored /
//     truncated 13 / 13 / 13 · minLowF before lowF 1 · || for ?? 1 · 0F read as missing 2 · null low -> 0F 1 ·
//     night from dayOffset (the old night bug) 12 · night from the base rate only 5 · no-record guard removed 2 ·
//     publish site drops the advisory record 4
//   other tiers: advisory tail on any tier carrying an advisory record 7 · imminent low rounded 4 · heat label 3 ·
//     radiative imminent label 3
//   shape: ASCII filter removed / admits control chars / admits non-ASCII 1 / 1 / 1 · 100-char cap removed 1
// The filter mutations are killed ONLY here: frost-wiring's "strips non-ASCII" case feeds no non-ASCII character.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fe from './frostEval.js';
import h from './handler.js';
import _cf from './_coverFlags.js';
import { buildFrostAlertLine } from '../../src/lib/frostAlertLine.js';

const { frostEval, advisoryMessage } = fe;
const { run, frostSubject, frostWeatherFacts } = h;
const { withCoverFlags } = _cf;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// The pre-fix function, VERBATIM (base 9df5903ddfa393e7b74e7d0dc42d4754ad0368d7). Imminent and heat must still
// produce exactly this; an advisory must not.
function legacySubject(d) {
  const radiativeOnly = !!(d.imminent && d.imminent.radiativeOnly);
  const label = d.tier === 'imminent'
    ? (d.level === 'hard_freeze' ? 'HARD FREEZE tonight'
      : (radiativeOnly ? 'Frost watch tonight' : 'Frost protect tonight'))
    : (d.tier === 'advisory' ? 'Frost advisory' : 'Heat advisory');
  const low = d.observability && d.observability.tonightLowF != null ? ` (low ${d.observability.tonightLowF}F)` : '';
  return `Garden alert - ${label}${low}`.replace(/[^\x20-\x7E]/g, '').slice(0, 100);
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const stamps = (date) => Array.from({ length: 24 }, (_, i) => `${date}T${pad(i)}:00`);
const round1 = (n) => Math.round(n * 10) / 10;
const addDays = (d, k) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + k)).toISOString().slice(0, 10); };
// A day whose single coldest hour is `hour` at `low`; every other hour is warmer.
const dayCurve = (low, hour) => Array.from({ length: 24 }, (_, i) => (i === hour ? low : low + 4 + Math.abs(i - hour) * 0.5));

// advisorynight.test.js LIVE_0918: the live forecast at this Space's coordinates, fetched 2026-09-18, D-2..D3.
// Its own minima: D1 47.5 at 07:00, D2 47.8 at 02:00, D3 44.7 at 23:00. Shifting a day -10F crosses the 40F trip
// point without moving the hour of its minimum — the advisorynight F7 inputs, one of each night case.
const LIVE_0918 = [
  ['2026-09-16', [53.0, 52.0, 51.1, 50.3, 50.1, 50.4, 51.1, 52.0, 54.8, 57.4, 62.1, 66.3, 68.4, 71.8, 73.5, 75.0, 75.0, 75.0, 73.7, 70.8, 70.0, 68.4, 67.4, 66.4]],
  ['2026-09-17', [65.3, 64.7, 64.4, 64.7, 63.9, 63.6, 63.6, 63.7, 65.8, 67.4, 70.0, 71.6, 73.2, 75.4, 75.2, 74.2, 75.3, 73.4, 71.5, 70.5, 71.1, 70.9, 70.5, 69.2]],
  ['2026-09-18', [69.2, 68.4, 68.0, 67.2, 67.8, 67.8, 66.7, 65.6, 67.6, 69.2, 70.1, 72.3, 73.3, 74.7, 75.7, 74.9, 74.2, 72.8, 70.0, 65.9, 63.1, 61.0, 58.9, 57.0]],
  ['2026-09-19', [55.9, 54.8, 53.9, 52.7, 51.7, 49.7, 48.3, 47.5, 48.8, 50.8, 53.0, 55.6, 57.8, 60.0, 61.6, 62.8, 63.3, 62.7, 61.2, 58.4, 55.9, 53.9, 52.8, 51.5]],
  ['2026-09-20', [49.6, 48.6, 47.8, 49.4, 50.1, 50.3, 48.5, 48.0, 50.5, 50.8, 51.7, 51.5, 51.1, 51.1, 50.8, 50.6, 51.3, 51.9, 52.0, 52.0, 52.0, 52.0, 52.0, 51.9]],
  ['2026-09-21', [51.7, 51.5, 51.5, 51.7, 51.7, 51.7, 49.5, 48.6, 50.4, 52.9, 55.5, 58.2, 60.5, 61.9, 61.0, 61.0, 62.3, 62.8, 58.2, 52.9, 50.2, 48.3, 46.1, 44.7]],
];
const shifted = (coldDays, by = -10) => LIVE_0918.map(([d, t]) => [d, coldDays.includes(d) ? t.map((v) => round1(v + by)) : t]);

// The hydrology index.js fetchPrecip hands the handler for these six days: D1..D3 daily minima + labels, and the
// hourly temperature block VERBATIM (its hourly_temp key). Overcast/breezy is irrelevant: hourly_frost is null.
const hydrologyOf = (days, { withTemp = true } = {}) => {
  const d1to3 = days.slice(3);
  return {
    forecast_lows: d1to3.map(([, t]) => Math.min(...t)), forecast_dates: d1to3.map(([d]) => d),
    hourly_temp: withTemp
      ? { time: days.flatMap(([d]) => stamps(d)), temperature_2m: days.flatMap(([, t]) => t), timezone: 'America/New_York' }
      : null,
    hourly_frost: null, recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
    tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0,
  };
};

const EXPOSURE = { tender: 3, unknown: 0, tenderContainers: 3 };
const PLAN_DATE = '2026-09-18';   // a Friday, inside the frost season
// The real frostEval on those days, the way frostForSpace calls it (global path; the run() cases below add crops).
const decide = (days, { tonightLow = 55, withTemp = true } = {}) => {
  const hy = hydrologyOf(days, { withTemp });
  return frostEval({
    tonightLow, highToday: 70, forecastLows: hy.forecast_lows, forecastDates: hy.forecast_dates,
    forecastHourly: hy.hourly_temp, exposure: EXPOSURE, spaceId: 'S', eventDate: PLAN_DATE,
  });
};

// What the BODY says, in either advisory shape: the night phrase and the printed low.
const bodyNightLow = (msg) => {
  const m = /^FROST ADVISORY — (?:frost possible (.+?)|(.+?) looks clear and calm) \(low (-?\d+(?:\.\d+)?)°F/.exec(msg);
  return m ? { night: m[1] || m[2], low: Number(m[3]) } : null;
};
// What the SUBJECT says for an advisory.
const subjectNightLow = (s) => {
  const m = /^Garden alert - Frost advisory (.+?) \(low (-?\d+)F\)$/.exec(s);
  return m ? { night: m[1], low: Number(m[2]) } : null;
};
// What the Today line says (src/lib/frostAlertLine.js), from the entry the handler persists for this decision.
const todayNightLow = (d) => {
  const line = buildFrostAlertLine([{ tier: 'advisory', level: 'advisory', at: 'z', ...frostWeatherFacts(d) }]);
  const m = line && /^Frost possible (.+?) — low (-?\d+)°F\./.exec(line.text);
  return m ? { night: m[1], low: Number(m[2]) } : null;
};

// ── 1 — the advisorynight F7 nights, through the real frostSubject ────────────────────────────────────
describe('frostSubject — an ADVISORY names its own night and low, the ones its body prints', () => {
  const F7 = [
    ['A: D1 minimum 07:00 Sat -> tonight', shifted(['2026-09-19']), {}, 'Garden alert - Frost advisory tonight (low 38F)', 'tonight', 37.5],
    ['B: D2 minimum 02:00 Sun -> tomorrow night', shifted(['2026-09-20']), {}, 'Garden alert - Frost advisory tomorrow night (low 38F)', 'tomorrow night', 37.8],
    ['C: D3 minimum 23:00 Mon -> Monday night', shifted(['2026-09-21']), {}, 'Garden alert - Frost advisory Monday night (low 35F)', 'Monday night', 34.7],
    ['D: C with no hourly temperature -> the base-rate night, Sunday', shifted(['2026-09-21']), { withTemp: false }, 'Garden alert - Frost advisory Sunday night (low 35F)', 'Sunday night', 34.7],
  ];
  for (const [name, days, opt, subject, night, low] of F7) {
    it(name, () => {
      const d = decide(days, opt);
      expect(d.tier).toBe('advisory');
      expect(d.observability.tonightLowF).toBe(55);                 // what the subject USED to print
      expect(bodyNightLow(d.message)).toEqual({ night, low });       // the body, unchanged by this fix
      expect(frostSubject(d)).toBe(subject);
      expect(frostSubject(d)).not.toBe(legacySubject(d));             // pre-fix: "Garden alert - Frost advisory (low 55F)"
    });
  }

  it('tonight\'s NWS low never reaches an advisory subject — whatever it is, or when it is missing', () => {
    const days = shifted(['2026-09-21']);
    // 39 sits between the imminent point (38) and the advisory low; null is NWS down (degraded, still advisory).
    for (const tonightLow of [39, 45, 55, 72, null]) {
      const d = decide(days, { tonightLow });
      expect(d.tier, `tonightLow ${tonightLow}`).toBe('advisory');
      expect(frostSubject(d), `tonightLow ${tonightLow}`).toBe('Garden alert - Frost advisory Monday night (low 35F)');
    }
  });

  it('0F is a temperature, not a missing low (and -0.4 does not print "-0")', () => {
    const one = (lows) => frostEval({ tonightLow: 60, forecastLows: lows, forecastDates: ['2026-12-19', '2026-12-20', '2026-12-21'],
      exposure: EXPOSURE, spaceId: 'S', eventDate: '2026-12-18' });
    expect(frostSubject(one([0, 20, 20]))).toBe('Garden alert - Frost advisory tonight (low 0F)');
    expect(frostSubject(one([-0.4, 20, 20]))).toBe('Garden alert - Frost advisory tonight (low 0F)');
    expect(frostSubject(one([-12.6, 20, 20]))).toBe('Garden alert - Frost advisory tonight (low -13F)');
  });

  it('with no labelled dates the night is "in N days", the same words the body uses', () => {
    const d = frostEval({ tonightLow: 60, forecastLows: [50, 50, 35], forecastDates: null, exposure: EXPOSURE, spaceId: 'S', eventDate: PLAN_DATE });
    expect(bodyNightLow(d.message)).toEqual({ night: 'in 2 days', low: 35 });
    expect(frostSubject(d)).toBe('Garden alert - Frost advisory in 2 days (low 35F)');
  });

  it('the radiative-only advisory names the night whose SKY the body quotes, not the one the hours alone would pick', () => {
    // advisorynight.test.js case: the D1 minimum (42F) falls at 23:00, which alone says "tomorrow night"; the body
    // is about the clear, calm night radAdvisory measured (keyed prevDate(date) = tonight) and says so.
    const T = { ADVISORY_LOW_F: 40, IMMINENT_LOW_F: 38, HARD_FREEZE_LOW_F: 33 };
    const tender = { slug: 'pepper', label: 'peppers', band: 'tender', count: 5, containers: 1, thresholds: T };
    const d = frostEval({
      tonightLow: 55, highToday: 60, forecastLows: [42, 50, 51], forecastDates: ['2026-10-10', '2026-10-11', '2026-10-12'],
      forecastHourly: { time: stamps('2026-10-10'), temperature_2m: dayCurve(42, 23) }, lowSource: 'forecast',
      radiativeNights: [{ date: '2026-10-09', minDewpointF: 34, meanCloudPct: 5, meanWindMph: 2, radiative: true }],
      exposure: { tender: 5, unknown: 0, tenderContainers: 1, atRisk: 5, byCropType: [tender] }, spaceId: 'S1', eventDate: '2026-10-09',
    }, { frostSeason: true, radiativeEnabled: true });
    expect(d.tier).toBe('advisory');
    expect(bodyNightLow(d.message)).toEqual({ night: 'tonight', low: 42 });
    expect(frostSubject(d)).toBe('Garden alert - Frost advisory tonight (low 42F)');
  });

  it('a record carrying its own lowF is quoted the way the body quotes it: lowF first, minLowF only when lowF is absent', () => {
    // Hand-built on purpose: no frostEval record carries lowF today, but advisoryMessage prints a.lowF ?? a.minLowF,
    // and the subject must not disagree with the body the day one does. lowF 0 is a temperature (?? not ||).
    const rec = (over) => ({ fires: true, minLowF: 39, dayOffset: 2, date: '2026-09-22', ...over });
    for (const [over, want] of [[{ lowF: 36.6 }, 37], [{ lowF: 0 }, 0], [{ lowF: null }, 39], [{}, 39]]) {
      const a = rec(over);
      const body = bodyNightLow(advisoryMessage(a, EXPOSURE));
      const s = frostSubject({ tier: 'advisory', level: 'advisory', advisory: a, observability: { tonightLowF: 55 } });
      expect(s, JSON.stringify(over)).toBe(`Garden alert - Frost advisory tomorrow night (low ${want}F)`);
      expect(Math.round(body.low), JSON.stringify(over)).toBe(want);
    }
  });

  it('an advisory decision with no advisory record says only "Frost advisory" — it never falls back to tonight\'s low', () => {
    expect(frostSubject({ tier: 'advisory', level: 'advisory', observability: { tonightLowF: 39 } })).toBe('Garden alert - Frost advisory');
    // a record with no low at all names its night and prints no number — never "(low 0F)" from Number(null)
    for (const over of [{}, { lowF: null, minLowF: null }, { minLowF: 'n/a' }]) {
      const advisory = { fires: true, dayOffset: 1, date: '2026-09-19', ...over };
      expect(frostSubject({ tier: 'advisory', level: 'advisory', advisory, observability: { tonightLowF: 55 } }), JSON.stringify(over))
        .toBe('Garden alert - Frost advisory tonight');
    }
  });
});

// ── 2 — PARITY: subject, body and Today line agree on the night and the number, across the grid ────────
describe('PARITY — the subject says what the body says and what the Today line says', () => {
  it('for every day, every hour of the minimum, and lows that round both ways, across month, year and DST edges', () => {
    let n = 0;
    const planDates = ['2026-09-18', '2026-10-30', '2026-10-31', '2026-11-13', '2026-12-30', '2027-03-12', '2027-02-26'];
    for (const plan of planDates) {
      for (const day of [1, 2, 3]) {
        for (const hour of [0, 7, 11, 12, 23, null]) {
          for (const low of [37.5, 34.7, 39.4, 12.5, -3.5]) {
            const dates = [addDays(plan, 1), addDays(plan, 2), addDays(plan, 3)];
            const lows = [50, 50, 50]; lows[day - 1] = low;
            const forecastHourly = hour == null ? null : { time: stamps(dates[day - 1]), temperature_2m: dayCurve(low, hour) };
            const d = frostEval({ tonightLow: 60, forecastLows: lows, forecastDates: dates, forecastHourly,
              exposure: EXPOSURE, spaceId: 'S', eventDate: plan });
            const at = `${plan} D${day} ${hour}:00 ${low}F`;
            expect(d.tier, at).toBe('advisory');
            const body = bodyNightLow(d.message);
            const subj = subjectNightLow(frostSubject(d));
            expect(subj, at).toEqual({ night: body.night, low: Math.round(body.low) });
            expect(todayNightLow(d), at).toEqual(subj);
            n++;
          }
        }
      }
    }
    expect(n).toBe(7 * 3 * 6 * 5);
  });
});

// ── 3 — imminent and heat: byte-identical to the pre-fix function ─────────────────────────────────────
describe('frostSubject — IMMINENT and HEAT subjects are byte-identical to before', () => {
  it('every imminent decision the real frostEval makes, with and without a colder advisory window behind it', () => {
    let n = 0;
    const days = shifted(['2026-09-21']);
    for (const tonightLow of [38, 37.8, 36, 33.2, 33, 30, 12.5, 0, -4]) {
      for (const withWindow of [true, false]) {
        const hy = hydrologyOf(days);
        const d = frostEval({
          tonightLow, highToday: 70, forecastLows: withWindow ? hy.forecast_lows : null, forecastDates: hy.forecast_dates,
          forecastHourly: hy.hourly_temp, exposure: EXPOSURE, spaceId: 'S', eventDate: PLAN_DATE,
        });
        expect(d.tier, `${tonightLow}`).toBe('imminent');
        expect(frostSubject(d), `${tonightLow} window ${withWindow}`).toBe(legacySubject(d));
        n++;
      }
    }
    expect(n).toBe(18);
    // the literal, so a change to the oracle cannot carry the test with it
    expect(frostSubject(decide(days, { tonightLow: 36 }))).toBe('Garden alert - Frost protect tonight (low 36F)');
    expect(frostSubject(decide(days, { tonightLow: 30 }))).toBe('Garden alert - HARD FREEZE tonight (low 30F)');
    // a station-floored low keeps its decimal, exactly as before (imminent is NOT rounded by this fix)
    expect(frostSubject(decide(days, { tonightLow: 37.8 }))).toBe('Garden alert - Frost protect tonight (low 37.8F)');
  });

  it('the radiative FROST WATCH, including when a colder advisory rides along in its body ("Colder ahead")', () => {
    const T = { ADVISORY_LOW_F: 40, IMMINENT_LOW_F: 38, HARD_FREEZE_LOW_F: 33 };
    const tender = { slug: 'pepper', label: 'peppers', band: 'tender', count: 5, containers: 1, thresholds: T };
    const d = frostEval({
      tonightLow: 39, highToday: 60, forecastLows: [35, 50, 51], forecastDates: ['2026-10-10', '2026-10-11', '2026-10-12'],
      forecastHourly: { time: stamps('2026-10-10'), temperature_2m: dayCurve(35, 4) }, lowSource: 'forecast',
      radiativeNights: [{ date: '2026-10-09', minDewpointF: 33, meanCloudPct: 5, meanWindMph: 2, radiative: true }],
      exposure: { tender: 5, unknown: 0, tenderContainers: 1, atRisk: 5, byCropType: [tender] }, spaceId: 'S1', eventDate: '2026-10-09',
    }, { frostSeason: true, radiativeEnabled: true });
    expect(d.tier).toBe('imminent');
    expect(d.message).toMatch(/Colder ahead: 35°F tonight/);           // the advisory is in the body...
    expect(frostSubject(d)).toBe('Garden alert - Frost watch tonight (low 39F)');   // ...and not in the subject
    expect(frostSubject(d)).toBe(legacySubject(d));
  });

  it('heat (off in prod, D5) keeps its old tail', () => {
    for (const tonightLow of [70, 64.5, null]) {
      const d = frostEval({ tonightLow, highToday: 97, forecastLows: [60, 61, 62], forecastDates: ['2026-07-02', '2026-07-03', '2026-07-04'],
        exposure: EXPOSURE, spaceId: 'S', eventDate: '2026-07-01' }, { heatEnabled: true });
      expect(d.tier).toBe('heat');
      expect(frostSubject(d)).toBe(legacySubject(d));
    }
    expect(frostSubject({ tier: 'heat', level: 'heat', observability: { tonightLowF: 70 } })).toBe('Garden alert - Heat advisory (low 70F)');
  });

  it('a non-advisory tier never reads the advisory record, even when one is attached', () => {
    const advisory = { fires: true, minLowF: 20, dayOffset: 2, date: '2026-09-22', nightOffset: 1, nightDate: '2026-09-21' };
    for (const d of [
      { tier: 'imminent', level: 'hard_freeze', advisory, observability: { tonightLowF: 30 } },
      { tier: 'imminent', level: 'protect', advisory, imminent: { radiativeOnly: true }, observability: { tonightLowF: 39 } },
      { tier: 'heat', level: 'heat', advisory, observability: { tonightLowF: 71 } },
      { tier: 'imminent', level: 'protect', advisory },
    ]) expect(frostSubject(d)).toBe(legacySubject(d));
  });
});

// ── 4 — the SNS shape: ASCII, one line, <= 100 chars ─────────────────────────────────────────────────
describe('frostSubject — SNS Subject shape (ASCII, one line, <= 100 chars), with the longest phrases', () => {
  it('every weekday night and the widest lows fit whole — the cap never cuts an advisory subject', () => {
    // Plan date Sun 2026-09-20: D3 = Wed 09-23 with a 23:00 minimum names "Wednesday night", the longest phrase.
    const plans = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'];
    const seen = new Set();
    for (const plan of plans) {
      for (const low of [-40.6, 39.5, -0.4]) {
        const dates = [addDays(plan, 1), addDays(plan, 2), addDays(plan, 3)];
        const d = frostEval({ tonightLow: 60, forecastLows: [50, 50, low], forecastDates: dates,
          forecastHourly: { time: stamps(dates[2]), temperature_2m: dayCurve(low, 23) }, exposure: EXPOSURE, spaceId: 'S', eventDate: plan });
        const s = frostSubject(d);
        const { night } = bodyNightLow(d.message);
        seen.add(night);
        expect(s).toBe(`Garden alert - Frost advisory ${night} (low ${Math.round(low)}F)`);   // whole, not cut
        expect(s).toMatch(/^[\x20-\x7E]+$/);
        expect(s.length).toBeLessThanOrEqual(100);
      }
    }
    expect([...seen].sort()).toEqual(['Friday night', 'Monday night', 'Saturday night', 'Sunday night',
      'Thursday night', 'Tuesday night', 'Wednesday night']);
    expect('Garden alert - Frost advisory Wednesday night (low -41F)'.length).toBe(56);
  });

  it('strips what SNS rejects: non-ASCII and control characters, wherever they come from', () => {
    // No real input carries one today (labels are literals, lows are Numbers, night phrases are ASCII), so the
    // filter is defence in depth. The imminent low is the one field interpolated as given, so it carries the probe:
    // a degree sign, an em dash, a newline and a tab.
    expect(frostSubject({ tier: 'imminent', level: 'protect', observability: { tonightLowF: '36°—\n\t' } }))
      .toBe('Garden alert - Frost protect tonight (low 36F)');
  });

  it('caps at 100 characters', () => {
    const s = frostSubject({ tier: 'imminent', level: 'protect', observability: { tonightLowF: '9'.repeat(300) } });
    expect(s).toHaveLength(100);
    expect(s.startsWith('Garden alert - Frost protect tonight (low 999')).toBe(true);
  });
});

// ── 5 — end to end: the real run(), the captured SNS publish, the written row ─────────────────────────
const USER = 'user_dave';
const SPACE = 'sp1';
const planting = (id, slug) => withCoverFlags({
  id, name: `${slug} ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: slug, genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: slug, covered: false,
  assignee_user_id: USER, db_cadence: null, last_water: '2026-09-17', last_fert: '2026-09-01',
  substrate_start: '2026-05-01', transplant_at: null,
});
const PLANTINGS = [planting('p1', 'pepper'), planting('p2', 'tomato'), planting('p3', 'basil')];

function pgStub() {
  const writes = [];
  const query = vi.fn(async (sql, params) => {
    if (/insert into daily_plan/.test(sql)) { writes.push(JSON.parse(params[2])); return { rows: [] }; }
    if (/from plants/.test(sql)) return { rows: PLANTINGS };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    return { rows: [] };
  });
  return { query, writes };
}

async function drive(days, { tonightLow = 55, highToday = 70, withTemp = true, runFn = run } = {}) {
  vi.stubEnv('FROST_ALERT_ENABLED', 'true');
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const pg = pgStub();
  const publishAlert = vi.fn(async () => ({ messageId: 'mid-1' }));
  await runFn({
    pg, today: PLAN_DATE, dryRun: false, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow, highToday, code: 3, unit: 'F', short: 'Cloudy' }),
    fetchPrecip: async () => hydrologyOf(days, { withTemp }), fetchStation: async () => null,
    publishAlert, etHour: 15, event: {},
  });
  const frost = publishAlert.mock.calls.map(([a]) => a).filter((a) => a.topic === 'frost');
  const row = pg.writes[pg.writes.length - 1];
  const evalLine = logs.mock.calls.map(([l]) => { try { return JSON.parse(l); } catch { return null; } })
    .find((l) => l && l.msg === 'frost-eval');
  return { frost, row, evalLine };
}

// The pre-fix subject rebuilt from the frost-eval CloudWatch line: everything the old function read is on it.
const legacyFromEvalLine = (ev) => legacySubject({ tier: ev.tier, level: ev.level,
  imminent: { radiativeOnly: ev.radiativeTripped }, observability: { tonightLowF: ev.tonightLowF } });

describe('END TO END through run() — the published subject agrees with the published body and the stored entry', () => {
  const CASES = [
    ['A: D1 cold, minimum 07:00', shifted(['2026-09-19']), {}, 'Garden alert - Frost advisory tonight (low 38F)'],
    ['B: D2 cold, minimum 02:00', shifted(['2026-09-20']), {}, 'Garden alert - Frost advisory tomorrow night (low 38F)'],
    ['C: D3 cold, minimum 23:00', shifted(['2026-09-21']), {}, 'Garden alert - Frost advisory Monday night (low 35F)'],
    ['D: D3 cold, hourly temperature missing', shifted(['2026-09-21']), { withTemp: false }, 'Garden alert - Frost advisory Sunday night (low 35F)'],
  ];
  for (const [name, days, opt, subject] of CASES) {
    it(`${name} -> "${subject}"`, async () => {
      const { frost, row, evalLine } = await drive(days, opt);
      expect(frost).toHaveLength(1);
      expect(frost[0].subject).toBe(subject);
      const body = bodyNightLow(frost[0].message);
      expect(subjectNightLow(frost[0].subject)).toEqual({ night: body.night, low: Math.round(body.low) });
      const entry = row.alerts_sent.at(-1);
      expect(entry.tier).toBe('advisory');
      expect(Math.round(entry.lowF)).toBe(subjectNightLow(frost[0].subject).low);
      expect(buildFrostAlertLine(row.alerts_sent).text).toMatch(new RegExp(`^Frost possible ${body.night} — low ${Math.round(body.low)}°F\\.`));
      // what the same run published before the fix
      expect(legacyFromEvalLine(evalLine)).toBe('Garden alert - Frost advisory (low 55F)');
    });
  }

  it('imminent through run(): the subject is what it was, tonight\'s low included', async () => {
    const days = shifted(['2026-09-19']);   // a colder advisory window is there too; imminent wins
    for (const [tonightLow, subject] of [[36, 'Garden alert - Frost protect tonight (low 36F)'], [30, 'Garden alert - HARD FREEZE tonight (low 30F)']]) {
      const { frost, evalLine } = await drive(days, { tonightLow });
      expect(frost).toHaveLength(1);
      expect(evalLine.tier).toBe('imminent');
      expect(frost[0].subject).toBe(subject);
      expect(frost[0].subject).toBe(legacyFromEvalLine(evalLine));
      vi.restoreAllMocks();
    }
  });

  it('heat through run() (FROST_HEAT_ENABLED; off in prod): the subject is what it was', async () => {
    // HEAT_ENABLED is read at module load (frostsent.test.js method): a FRESH handler/frostEval pair with the env set.
    vi.stubEnv('FROST_HEAT_ENABLED', 'true');
    const req = createRequire(import.meta.url);
    const drop = () => { for (const f of ['./handler.js', './frostEval.js']) delete req.cache[req.resolve(f)]; };
    drop();
    try {
      const hot = req('./handler.js');
      const { frost, evalLine } = await drive(LIVE_0918, { tonightLow: 76, highToday: 97, runFn: hot.run });
      expect(frost).toHaveLength(1);
      expect(evalLine.tier).toBe('heat');
      expect(frost[0].message).toMatch(/^HEAT — high 97°F today/);
      expect(frost[0].subject).toBe('Garden alert - Heat advisory (low 76F)');
      expect(frost[0].subject).toBe(legacyFromEvalLine(evalLine));
    } finally { drop(); }
  });
});
