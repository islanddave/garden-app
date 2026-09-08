// V4-FROST-001 G5 — anti-drift guard on the Open-Meteo daily-array indexing.
//
// fetchPrecip reads its values by POSITION out of j.daily.* ([D-2, D-1, D0, D1, D2, D3] with past_days=2 +
// forecast_days=4). Frost work added temperature_2m_min and bumped forecast_days 3 -> 4. Both changes are
// safe ONLY because they APPEND: past_days is what sets the offset of D0, so every pre-existing index still
// means the same day. Change past_days, reorder the `daily=` list in a way that matters, or drop
// forecast_days below 4, and the breakage is SILENT — the plan keeps generating with the wrong day's rain
// and the advisory tier quietly loses its third night.
//
// index.js pulls AWS/neon at module load and cannot be imported by the unit suite (same constraint that put
// resolveInvokeOptions in handler.js), so this is a source assertion — the pattern used by
// archived-exclusion.test.js, wxcoverloc.test.js and nightly-timeout.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// An index NAMED IN A COMMENT is not that index. Every assertion below reads CODE, not SRC.
// MUTATION that this closes: change the live URL to `past_days=3` — which silently shifts D0 from
// ps[2] to ps[3], i.e. exactly the wrong-day-rain breakage this file's header describes — and leave
// `// past_days=2 was the original` on the line. The whole suite passed.
// `//` stripping is URL-safe (`[^:]` guard) because the assertions read an https:// URL literal.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const CODE = decomment(SRC);

// Branch-bounded (also stops at exports.handler) so a trailing function cannot be satisfied by the
// handler that follows it.
const fnBody = (name) => {
  const i = CODE.indexOf(`async function ${name}`);
  expect(i, `async function ${name} present in index.js`).toBeGreaterThan(-1);
  const ends = [CODE.indexOf('async function', i + 1), CODE.indexOf('exports.handler', i + 1)]
    .filter((x) => x > -1);
  const j = ends.length ? Math.min(...ends) : -1;
  const body = CODE.slice(i, j === -1 ? undefined : j);
  expect(body.length, `${name} body extraction collapsed to nothing`).toBeGreaterThan(40);
  return body;
};
const fetchPrecipBody = fnBody('fetchPrecip');

describe('Open-Meteo daily indexing must not drift (G5)', () => {
  it('past_days stays 2 — it is what makes D0 index 2 for every existing field', () => {
    expect(fetchPrecipBody).toMatch(/past_days=2/);
  });

  it('forecast_days is at least 4 so the advisory tier can see three future nights', () => {
    const m = fetchPrecipBody.match(/forecast_days=(\d+)/);
    expect(m, 'forecast_days present on the Open-Meteo URL').toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(4);
  });

  it('requests temperature_2m_min, in Fahrenheit — the whole of G5', () => {
    expect(fetchPrecipBody).toMatch(/daily=[^`'"]*temperature_2m_min/);
    expect(fetchPrecipBody).toMatch(/temperature_unit=fahrenheit/);
  });

  it('still requests the two precipitation fields the hydrology path depends on', () => {
    expect(fetchPrecipBody).toMatch(/daily=[^`'"]*precipitation_sum/);
    expect(fetchPrecipBody).toMatch(/daily=[^`'"]*precipitation_probability_max/);
    expect(fetchPrecipBody).toMatch(/precipitation_unit=inch/);
  });

  it('the pre-frost precipitation indices are UNCHANGED (ps[0..4], pop[2..3])', () => {
    for (const frag of [
      'round2((ps[0] || 0) + (ps[1] || 0))',   // recent = D-2 + D-1
      'round2(ps[2] || 0)',                    // today = D0
      'pop[2] != null',                        // today PoP
      'round2(tomorrow + (ps[4] || 0))',       // upcoming = D1 + D2
      'pop[3] != null',                        // tomorrow PoP
      'Number.isFinite(ps[1])',                // yesterday actual = D-1
    ]) expect(fetchPrecipBody).toContain(frag);
    expect(fetchPrecipBody).toMatch(/const tomorrow = ps\[3\] \|\| 0/);
  });

  it('the frost lows read D1..D3 — indices 3,4,5, one past the precip window', () => {
    expect(fetchPrecipBody).toMatch(/forecast_lows: \[lowOrNull\(tmin\[3\]\), lowOrNull\(tmin\[4\]\), lowOrNull\(tmin\[5\]\)\]/);
    expect(fetchPrecipBody).toMatch(/forecast_dates: \[times\[3\] \|\| null, times\[4\] \|\| null, times\[5\] \|\| null\]/);
  });

  it('an absent low becomes null, NEVER 0°F — absence is not a temperature', () => {
    expect(fetchPrecipBody).toMatch(/const lowOrNull = \(v\) => \(Number\.isFinite\(v\) \? v : null\)/);
    expect(fetchPrecipBody).not.toMatch(/tmin\[\d\] \|\| 0/);
  });

  // ── BUG-RAINACTUAL-001 H5 — the hourly append, guarded by exactly the same rule as G5's ────────
  it('requests hourly precipitation on the SAME call (one request, not two)', () => {
    expect(fetchPrecipBody).toMatch(/hourly=precipitation/);
    expect((fetchPrecipBody.match(/api\.open-meteo\.com/g) || []).length).toBe(1);
  });

  it('the hourly append does not disturb the daily list — `daily=` still starts with precipitation_sum', () => {
    // `hourly` is a separate response object from `daily`, so appending it cannot shift ps[]/pop[]/tmin[].
    // This pins the URL shape so a future edit cannot fold hourly INTO the daily list and silently slide them.
    expect(fetchPrecipBody).toMatch(/daily=precipitation_sum,precipitation_probability_max,temperature_2m_min/);
    expect(fetchPrecipBody).not.toMatch(/daily=[^&`'"]*hourly/);
  });

  it('hourly_precip is carried VERBATIM with its timezone — the day-boundary guard depends on it', () => {
    expect(fetchPrecipBody).toMatch(/hourly_precip:/);
    expect(fetchPrecipBody).toMatch(/time: j\.hourly\.time, precipitation: j\.hourly\.precipitation, timezone: j\.timezone/);
  });

  it('an absent hourly block becomes null, NEVER [] — absence must not read as "no rain coming"', () => {
    expect(fetchPrecipBody).toMatch(/Array\.isArray\(j\.hourly\.time\) && Array\.isArray\(j\.hourly\.precipitation\)/);
    // ANCHORED TO hourly_precip, not to the end of the returned object.
    //
    // This assertion previously read /:\s*null,\s*\n\s*\};/ — "somewhere there is a `: null,` on the
    // last line before the closing brace". That only tested the right thing while hourly_precip
    // happened to be the FINAL key in the return, and it went red the moment V4-WATERMATH-001 F1
    // appended settled_days after it, despite the else-branch it cares about being untouched. Worse
    // in the other direction: as a floating pattern it could have been satisfied by ANY other key's
    // `: null,` while hourly_precip's else-branch quietly became `[]` — which is the exact defect the
    // test is named for (an empty array reads downstream as "no more rain coming" and over-waters
    // into a storm; remainingHourlyIn returns null, never 0, for precisely this reason).
    //
    // The form below binds the ternary to its own key, so it survives appends and cannot be met by a
    // neighbour.
    expect(fetchPrecipBody).toMatch(/hourly_precip:[\s\S]{0,240}?\?[\s\S]{0,240}?\n\s*:\s*null,/);
    expect(fetchPrecipBody).not.toMatch(/hourly_precip:[\s\S]{0,240}?\?[\s\S]{0,240}?\n\s*:\s*\[\],/);
  });

  it('fetchPrecip keeps its null-fallback catch — hydrology degrades, it does not crash the run', () => {
    expect(fetchPrecipBody).toMatch(/catch[\s\S]*return null/);
  });
});

// ── V4-WATERMATH-001 F1 — the ET0 append, and the two Open-Meteo call sites this file never pinned ──
//
// Until now this file guarded ONE of the three Open-Meteo surfaces in the codebase. The other two were
// unguarded, and each is a positional-indexing surface in its own right:
//
//   (1) fetchNWS's weather_code call — its own URL, its own daily array, read at index [0].
//   (2) fetchPrecip's main list      — the one this file was written for.
//   (3) scripts/backfill-weather-daily.mjs — the archive endpoint, added by F1. Same field NAMES,
//       different endpoint, and crucially NO past_days, so importing the [D-2, D-1, D0, ...]
//       convention into it would be the bug rather than the guard.
//
// All three are pinned below, because the failure mode they share is silence: the plan keeps
// generating, the numbers stay plausible, and only the day they describe is wrong.
describe('F1 — et0_fao_evapotranspiration is APPENDED, never inserted', () => {
  const dailyList = () => {
    const m = fetchPrecipBody.match(/&daily=([a-z0-9_,]+)/i);
    expect(m, '`daily=` list present on the fetchPrecip URL').toBeTruthy();
    return m[1].split(',');
  };

  it('requests ET0 at all — the whole point of F1', () => {
    expect(fetchPrecipBody).toMatch(/daily=[^`'"]*et0_fao_evapotranspiration/);
  });

  it('the three pre-existing daily fields are STILL THE FIRST THREE, in their original order', () => {
    // This is the assertion that makes "appended" mean something. `toMatch` on a prefix would also
    // pass if a fourth field were spliced in ahead of temperature_2m_min; comparing the leading
    // slice of the parsed list cannot.
    expect(dailyList().slice(0, 3)).toEqual([
      'precipitation_sum', 'precipitation_probability_max', 'temperature_2m_min',
    ]);
  });

  it('ET0 and the daily max come AFTER them, at the end of the list', () => {
    const list = dailyList();
    expect(list.indexOf('et0_fao_evapotranspiration')).toBeGreaterThan(list.indexOf('temperature_2m_min'));
    expect(list.indexOf('temperature_2m_max')).toBeGreaterThan(list.indexOf('temperature_2m_min'));
    // The count assertion this line used to carry (`toHaveLength(5)`) was a FROZEN COUNT: it went
    // red the moment V5-WXBACKFILLVARS-001 appended five more fields, despite the append being the
    // very discipline this describe block exists to enforce, and the only available fix was to bump
    // the number — which teaches the next author that the number is negotiable. The anti-splice
    // guarantee lives entirely in the slice comparison above and in the V5 block below; both are
    // exact, neither rots on a widening.
    expect(list.length).toBeGreaterThanOrEqual(5);
  });

  it('fetches temperature_2m_max — without it weather_daily.tmax_f is NULL forever', () => {
    // NWS supplies highToday, which is TODAY's forecast high. The writer persists COMPLETED days, so
    // that value is the wrong day by construction and cannot feed F2's fabric-bag heat ramp.
    expect(fetchPrecipBody).toMatch(/daily=[^`'"]*temperature_2m_max/);
    expect(fetchPrecipBody).toMatch(/const tmax = \(j\.daily && j\.daily\.temperature_2m_max\)/);
  });

  it('no unit conversion is performed on ET0 — the endpoint already returns inches', () => {
    // Verified live 2026-08-12: with precipitation_unit=inch the endpoint reports
    // daily_units.et0_fao_evapotranspiration = "inch". A stray mm->in factor would be a silent 25x.
    expect(fetchPrecipBody).toMatch(/precipitation_unit=inch/);
    expect(fetchPrecipBody).not.toMatch(/25\.4/);
    expect(fetchPrecipBody).not.toMatch(/et0[^\n]*\/\s*25/);
  });

  it('ET0 keeps a third decimal — round2 would collapse the entire useful range', () => {
    // Live values at this Space run ~0.15-0.25 in/day (0.186 and 0.193 on consecutive days), and the
    // demand term is a RATIO, so two decimals inject several percent of error before any modelling.
    expect(fetchPrecipBody).toMatch(/et0_in: Number\.isFinite\(et0\[i\]\) \? round3\(et0\[i\]\)/);
    expect(SRC).toMatch(/const round3 = \(n\) => Math\.round\(\(n \+ Number\.EPSILON\) \* 1000\) \/ 1000/);
  });

  it('settled_days carries D-2 and D-1 ONLY — today is still accumulating', () => {
    // D0 is index 2. Including it would let a 15:30 intraday run persist a partial day as the day's
    // actual, which no later read could tell apart from a genuinely dry day.
    expect(fetchPrecipBody).toMatch(/settled_days: \[0, 1\]\.map/);
    expect(fetchPrecipBody).not.toMatch(/settled_days: \[0, 1, 2\]/);
  });

  it('an absent settled value becomes null, NEVER 0 — same rule as the yesterday actual', () => {
    expect(fetchPrecipBody).toMatch(/precip_in: Number\.isFinite\(ps\[i\]\) \? round2\(ps\[i\]\) : null/);
    expect(fetchPrecipBody).not.toMatch(/et0\[i\] \|\| 0/);
    expect(fetchPrecipBody).not.toMatch(/tmax\[i\] \|\| 0/);
  });

  it('the day label is Open-Meteo\'s own ET-local date, not one derived from the clock', () => {
    // weather_daily."date" is contracted to be the ET civil day. Deriving it from the fetch clock
    // would put the row on the wrong day whenever a run straddles midnight.
    expect(fetchPrecipBody).toMatch(/date: times\[i\] \|\| null/);
    expect(fetchPrecipBody).toMatch(/timezone=America\/New_York/);
  });
});

// ── V5-WXBACKFILLVARS-001 — five more appended fields, same discipline, one new URL parameter ─────
//
// The failure this block guards is the one the whole file is about, in a new place: five values read
// BY NAME out of one JSON payload. Get a name wrong and Open-Meteo does not error — it omits the
// field, the array reads empty, every value becomes null, and the column silently never populates.
// Get the ORDER wrong relative to the archive call and the two surfaces stop being readable against
// each other. Both are pinned below.
describe('V5 — the five backfillable quantities are APPENDED, never inserted', () => {
  const dailyList = () => {
    const m = fetchPrecipBody.match(/&daily=([a-z0-9_,]+)/i);
    expect(m, '`daily=` list present on the fetchPrecip URL').toBeTruthy();
    return m[1].split(',');
  };
  const V5_FIELDS = ['daylight_duration', 'sunshine_duration', 'shortwave_radiation_sum',
    'wind_speed_10m_max', 'precipitation_hours'];

  it('the five PRE-EXISTING daily fields are still the first five, in their original order', () => {
    // The anti-splice guarantee, exact and widening-proof: anything inserted ahead of these shifts
    // the slice and fails, however many fields are appended after them.
    expect(dailyList().slice(0, 5)).toEqual([
      'precipitation_sum', 'precipitation_probability_max', 'temperature_2m_min',
      'et0_fao_evapotranspiration', 'temperature_2m_max',
    ]);
  });

  it('requests all five, each strictly after the pre-existing block', () => {
    const list = dailyList();
    for (const f of V5_FIELDS) {
      expect(list.indexOf(f), `${f} present on the daily= list`).toBeGreaterThan(-1);
      expect(list.indexOf(f)).toBeGreaterThan(list.indexOf('temperature_2m_max'));
    }
  });

  it('sends wind_speed_unit=mph — the only new URL parameter, and wind_max_mph depends on it', () => {
    // Without it Open-Meteo serves km/h and the column name becomes a lie, with no error anywhere:
    // 15 km/h stored as 15 mph is a plausible number in the wrong unit, which is the failure class
    // the ET0 "no 25.4 anywhere" assertion above exists for.
    expect(fetchPrecipBody).toMatch(/wind_speed_unit=mph/);
  });

  it('carries the two durations in SECONDS, unconverted — a divide here is a silent 3600x', () => {
    expect(fetchPrecipBody).toMatch(/daylight_s: Number\.isFinite\(daylight\[i\]\) \? round2\(daylight\[i\]\)/);
    expect(fetchPrecipBody).toMatch(/sunshine_s: Number\.isFinite\(sunshine\[i\]\) \? round2\(sunshine\[i\]\)/);
    expect(fetchPrecipBody).not.toMatch(/3600/);
  });

  it('settled_days carries all five, and an absent value becomes null, NEVER 0', () => {
    // 0 sunshine seconds is a real overcast day and 0 precipitation_hours a real dry one, so the
    // usual rule bites harder here than anywhere else in this file: a coerced 0 is indistinguishable
    // from a measurement.
    for (const [key, arr] of [['daylight_s', 'daylight'], ['sunshine_s', 'sunshine'],
      ['solar_mj_m2', 'solar'], ['wind_max_mph', 'windmax'], ['precip_hours', 'preciph']]) {
      expect(fetchPrecipBody).toMatch(new RegExp(`${key}: Number\\.isFinite\\(${arr}\\[i\\]\\) \\? round2\\(${arr}\\[i\\]\\) : null`));
      expect(fetchPrecipBody).not.toMatch(new RegExp(`${arr}\\[i\\] \\|\\| 0`));
    }
  });

  it('reads each of the five off j.daily BY NAME — a typo omits the field silently', () => {
    for (const f of V5_FIELDS) {
      expect(fetchPrecipBody).toMatch(new RegExp(`j\\.daily && j\\.daily\\.${f}`));
    }
  });

  it('is still ONE request — the five ride the call that was already being made', () => {
    expect((fetchPrecipBody.match(/api\.open-meteo\.com/g) || []).length).toBe(1);
  });
});

// ── V5-RADIATIVEFROST-001 — three fields appended to the HOURLY list ──────────────────────────────
//
// The safest append in this function's history, for a structural reason: `hourly` is a separate
// response object from `daily`, so it cannot shift ps[]/pop[]/tmin[]. That is exactly the argument
// BUG-RAINACTUAL-001 H5 made, and the assertions below are what stop a future edit from quietly
// invalidating it by folding these into `daily=` instead.
describe('V5 RADIATIVE — the three radiative-frost inputs ride the hourly list', () => {
  const hourlyList = () => {
    const m = fetchPrecipBody.match(/&hourly=([a-z0-9_,]+)/i);
    expect(m, '`hourly=` list present on the fetchPrecip URL').toBeTruthy();
    return m[1].split(',');
  };

  it('requests dewpoint, cloud cover and wind — none of which was fetched anywhere before', () => {
    for (const f of ['dew_point_2m', 'cloud_cover', 'wind_speed_10m']) {
      expect(hourlyList(), `${f} present on the hourly= list`).toContain(f);
    }
  });

  it('precipitation is STILL FIRST on the hourly list — these are appended, never spliced', () => {
    // Same anti-splice guarantee the daily list gets, and it matters for the same reason: the hourly
    // block is read by name downstream, and a reorder is the kind of edit that looks harmless.
    expect(hourlyList()[0]).toBe('precipitation');
  });

  it('the DAILY list is untouched by this change — the archive backfill mirrors it field-for-field', () => {
    const daily = fetchPrecipBody.match(/&daily=([a-z0-9_,]+)/i)[1].split(',');
    for (const f of ['dew_point_2m', 'cloud_cover', 'wind_speed_10m']) {
      expect(daily, `${f} must NOT be on the daily list`).not.toContain(f);
    }
    expect(daily.slice(0, 5)).toEqual([
      'precipitation_sum', 'precipitation_probability_max', 'temperature_2m_min',
      'et0_fao_evapotranspiration', 'temperature_2m_max',
    ]);
  });

  it('sends wind_speed_unit=mph and temperature_unit=fahrenheit — the hourly fields honour both', () => {
    // Verified live 2026-09-08: hourly_units gave dew_point_2m "°F", cloud_cover "%",
    // wind_speed_10m "mp/h". Drop either parameter and the values silently change unit with no error,
    // which for wind flips a 14 km/h night (not calm) into a "14 mph" reading that still is not calm —
    // but a 9 km/h night (5.6 mph, calm) reads as 9 mph and stays calm for the wrong reason.
    expect(fetchPrecipBody).toMatch(/wind_speed_unit=mph/);
    expect(fetchPrecipBody).toMatch(/temperature_unit=fahrenheit/);
  });

  it('carries hourly_frost VERBATIM with its timezone — the night bucketing depends on the stamps', () => {
    expect(fetchPrecipBody).toMatch(/hourly_frost:/);
    for (const f of ['dew_point_2m', 'cloud_cover', 'wind_speed_10m']) {
      expect(fetchPrecipBody).toMatch(new RegExp(`${f}: j\\.hourly\\.${f}`));
    }
    expect(fetchPrecipBody).toMatch(/hourly_frost:[\s\S]{0,600}?timezone: j\.timezone/);
  });

  it('an absent block becomes null, NEVER {} — absence must not read as a clear calm night', () => {
    // The strongest form of this codebase's null-never-0 rule. The trip condition is cloud and wind at
    // or near ZERO, so coercing absence into an object of zeros would MANUFACTURE the positive case,
    // on exactly the nights when the data is missing.
    expect(fetchPrecipBody).toMatch(/hourly_frost:[\s\S]{0,600}?\n\s*:\s*null,/);
    expect(fetchPrecipBody).not.toMatch(/hourly_frost:[\s\S]{0,600}?\n\s*:\s*\{\},/);
    // and every one of the three arrays must be checked, not just the first
    for (const f of ['dew_point_2m', 'cloud_cover', 'wind_speed_10m']) {
      expect(fetchPrecipBody).toMatch(new RegExp(`Array\\.isArray\\(j\\.hourly\\.${f}\\)`));
    }
  });

  it('REALLY RETURNS the block — a source regex cannot tell a shape from a value', async () => {
    // THE HOLE THIS CLOSES, and why it needs an unusual instrument. Every other assertion in this file
    // is a regex over index.js's SOURCE TEXT, because the module cannot be imported (it pulls AWS/neon
    // at load — see this file's header). A reviewer demonstrated the consequence: wrapping the
    // hourly_frost guard in `false &&` so it ALWAYS emits null left all 320 tests green. The string
    // shape still matched; the value was inverted. That is the "shipped feature that never ran" class,
    // and no amount of extra regex fixes it — the next inversion just takes a different form.
    //
    // So: compile the REAL source of fetchPrecip into a callable and invoke it with a stubbed fetch.
    // This executes the actual code without importing the module, which is the only way to assert on
    // the VALUE. Extraction is guarded below so a future refactor fails loudly rather than vacuously.
    // Cut at the function's own closing brace at column 0 — not at the next `async function`, which
    // overshoots into the trailing comment block and would swallow the appended `return` into it.
    const src = SRC.slice(SRC.indexOf('async function fetchPrecip'));
    const end = src.indexOf('\n}\n');
    expect(end, 'fetchPrecip closing brace found').toBeGreaterThan(-1);
    const body = src.slice(0, end + 3);
    expect(body, 'fetchPrecip source extracted').toMatch(/hourly_frost:/);
    expect(body.trimEnd().endsWith('}'), 'extraction ends at the closing brace').toBe(true);
    expect(body.length).toBeGreaterThan(500);

    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
    const hours = ['2026-10-09T18:00', '2026-10-09T19:00', '2026-10-10T03:00'];
    const payload = {
      timezone: 'America/New_York',
      daily: {
        time: ['a', 'b', 'c', 'd', 'e', 'f'],
        precipitation_sum: [0, 0, 0, 0, 0, 0], precipitation_probability_max: [0, 0, 0, 0, 0, 0],
        temperature_2m_min: [40, 40, 40, 40, 40, 40], et0_fao_evapotranspiration: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
        temperature_2m_max: [60, 60, 60, 60, 60, 60], daylight_duration: [1, 1, 1, 1, 1, 1],
        sunshine_duration: [1, 1, 1, 1, 1, 1], shortwave_radiation_sum: [1, 1, 1, 1, 1, 1],
        wind_speed_10m_max: [5, 5, 5, 5, 5, 5], precipitation_hours: [0, 0, 0, 0, 0, 0],
      },
      hourly: {
        time: hours, precipitation: [0, 0, 0],
        dew_point_2m: [33, 33, 32], cloud_cover: [4, 5, 6], wind_speed_10m: [2, 2, 3],
      },
    };
    const make = new Function('round2', 'round3', 'fetch', 'AbortSignal', 'console',
      `${body}\nreturn fetchPrecip;`);
    const fetchPrecip = make(round2, round3,
      async () => ({ json: async () => payload }),
      { timeout: () => undefined }, { warn() {} });

    const out = await fetchPrecip(42.5, -72.6);
    expect(out.hourly_frost, 'hourly_frost must be the real block, not null').not.toBeNull();
    expect(out.hourly_frost.time).toEqual(hours);
    expect(out.hourly_frost.dew_point_2m).toEqual([33, 33, 32]);
    expect(out.hourly_frost.cloud_cover).toEqual([4, 5, 6]);
    expect(out.hourly_frost.wind_speed_10m).toEqual([2, 2, 3]);
    expect(out.hourly_frost.timezone).toBe('America/New_York');
    // and the absence branch really returns null, from the same real code
    const bare = { ...payload, hourly: { time: hours, precipitation: [0, 0, 0] } };
    const fp2 = make(round2, round3, async () => ({ json: async () => bare }),
      { timeout: () => undefined }, { warn() {} });
    expect((await fp2(42.5, -72.6)).hourly_frost).toBeNull();
  });

  it('is STILL one request — the three ride the call that was already being made', () => {
    expect((fetchPrecipBody.match(/api\.open-meteo\.com/g) || []).length).toBe(1);
  });
});

describe('call site (1) — fetchNWS\'s weather_code call, previously unpinned', () => {
  const nwsBody = fnBody('fetchNWS');

  it('reads the WMO code at index 0, and has no past_days that could move it', () => {
    // A SECOND Open-Meteo URL with its own daily array. It has no past_days, so index 0 IS today.
    // Adding one here — the obvious "make it consistent with fetchPrecip" edit — would silently turn
    // the widget icon into the weather from two days ago.
    expect(nwsBody).toMatch(/daily=weather_code/);
    expect(nwsBody).not.toMatch(/past_days/);
    expect(nwsBody).toMatch(/forecast_days=1/);
    expect(nwsBody).toMatch(/om\.daily\.weather_code\[0\]/);
  });

  it('the icon fetch stays cosmetic — its failure must not cost the temperatures', () => {
    // It sits in its own inner try/catch inside fetchNWS precisely so an Open-Meteo blip cannot
    // take out the NWS-sourced tonightLow/highToday that the frost path depends on.
    expect(nwsBody).toMatch(/try\s*{[\s\S]*open-meteo[\s\S]*}\s*catch/);
  });

  it('is a genuinely separate request from fetchPrecip\'s', () => {
    expect((nwsBody.match(/api\.open-meteo\.com/g) || []).length).toBe(1);
  });
});

describe('call site (3) — the archive backfill, a third positional surface', () => {
  const ARCHIVE = decomment(
    readFileSync(resolve(__dirname, '..', '..', 'scripts', 'backfill-weather-daily.mjs'), 'utf8'));

  it('uses the ARCHIVE endpoint with an explicit date range, not past_days', () => {
    expect(ARCHIVE).toMatch(/archive-api\.open-meteo\.com\/v1\/archive/);
    expect(ARCHIVE).toMatch(/start_date=\$\{startDate\}&end_date=\$\{endDate\}/);
    // past_days is what creates the D0-offset convention. This endpoint has no such offset, so
    // importing the convention would misread every row by however many days someone assumed.
    expect(ARCHIVE).not.toMatch(/past_days/);
  });

  it('requests the same field names, in the same order, as the forecast call', () => {
    // Compared as a LIST against the forecast call's own list, not as two hand-copied string
    // literals. V5-WXBACKFILLVARS-001 appended five fields to both, and a pair of literals is
    // exactly the shape where one gets updated and the other does not — which is how the two
    // surfaces stop being readable against each other while every assertion here still passes.
    const forecastList = fetchPrecipBody.match(/&daily=([a-z0-9_,]+)/i)[1].split(',');
    const archiveList = ARCHIVE.match(/&daily=([a-z0-9_,]+)/i)[1].split(',');
    expect(archiveList).toEqual(forecastList);
    expect(archiveList).toContain('daylight_duration');
    expect(ARCHIVE).toMatch(/temperature_unit=fahrenheit/);
    expect(ARCHIVE).toMatch(/precipitation_unit=inch/);
    // The archive honours wind_speed_unit too — verified live 2026-09-07, daily_units gave "mp/h".
    // Without it this script would write km/h into a column called wind_max_mph.
    expect(ARCHIVE).toMatch(/wind_speed_unit=mph/);
    expect(ARCHIVE).toMatch(/timezone=America\/New_York/);
  });

  it('pairs every value with ITS OWN time[i] entry rather than assuming a fixed offset', () => {
    // The safe form: map over d.time and index the value arrays with the same i. There is no
    // "index 2 is today" assumption anywhere, which is what makes this call site drift-proof.
    expect(ARCHIVE).toMatch(/times\.map\(\(date, i\) =>/);
    for (const f of ['et0_fao_evapotranspiration', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum',
      'daylight_duration', 'sunshine_duration', 'shortwave_radiation_sum', 'wind_speed_10m_max', 'precipitation_hours']) {
      expect(ARCHIVE).toMatch(new RegExp(`d\\.${f}\\?\\.\\[i\\]`));
    }
  });

  it('emits the same five V5 row keys as the Lambda — the writers share one upsert', () => {
    // The archive rows are handed to the SAME column list handler.js writes. A key named differently
    // here (daylight_seconds, say) is not a type error in JS: it becomes `undefined`, the `??` turns
    // it into NULL, and the backfill reports "upserted 114 rows" having written five NULL columns.
    for (const k of ['daylight_s', 'sunshine_s', 'solar_mj_m2', 'wind_max_mph', 'precip_hours']) {
      expect(ARCHIVE).toMatch(new RegExp(`${k}: Number\\.isFinite\\(`));
    }
  });

  it('never writes today, and is dry unless --apply is passed', () => {
    expect(ARCHIVE).toMatch(/const endDate = shiftDays\(today, -1\)/);
    expect(ARCHIVE).toMatch(/const apply = argv\.includes\('--apply'\)/);
  });

  it('carries the SAME quality-rank guard as the nightly writer, on EVERY measured column', () => {
    // A backfill with a laxer conflict policy than the Lambda would undo the Lambda's work on every
    // run — the two policies have to move together or not at all. This asserts the shape is present
    // here; whether the two texts are actually identical is weather-daily-conflict-sync.test.js,
    // which is the only place that can answer it (this file never reads handler.js).
    //
    // BUG-WXWRITEOVERWRITE-001: this used to pin the precip-only `case when
    // weather_daily.precip_source = 'gauge_merged'` form — which both files did carry, and which is
    // why the drift went unnoticed. et0_in/tmax_f/tmin_f were bare COALESCE in both, so this script
    // overwrote the nightly writer's better-sourced values on every overlapping day.
    const flat = ARCHIVE.replace(/\s+/g, ' ');
    expect(flat).toMatch(/on conflict \(space_id, "date"\) do update set/i);
    for (const col of ['precip_in', 'precip_source', 'et0_in', 'et0_source', 'tmax_f', 'tmin_f']) {
      expect(flat).toMatch(new RegExp(`${col} = case when coalesce\\(array_position\\(`, 'i'));
      expect(flat).not.toMatch(new RegExp(`${col} = coalesce\\(excluded\\.${col}`, 'i'));
    }
  });

  it('labels everything it writes as openmeteo_archive — it can never produce a gauge value', () => {
    // The AmbientWeather API serves a rolling ~3-day window, so gauge history is unreachable from
    // this script by construction. Saying so on the row is the honest outcome.
    expect(ARCHIVE).toMatch(/const SOURCE = 'openmeteo_archive'/);
  });
});

describe('SNS publish path (F3) — deliberately NOT fail-soft', () => {
  const publishBody = (() => {
    const i = CODE.indexOf('async function publishAlert');
    expect(i, 'async function publishAlert present in index.js').toBeGreaterThan(-1);
    const j = CODE.indexOf('\n}', i);
    const body = CODE.slice(i, j);
    // The two assertions below are NEGATIVE, so a truncated (or empty) haystack would pass them
    // vacuously. Pin the extraction to something only the real body carries.
    expect(body, 'publishAlert body extraction truncated — the negative assertions below would ' +
      'pass against a short slice regardless of what the function does').toMatch(/PublishCommand/);
    return body;
  })();

  it('has NO try/catch — §3-7 forbids swallowing a frost publish failure', () => {
    expect(publishBody).not.toMatch(/try\s*{/);
    expect(publishBody).not.toMatch(/catch/);
  });

  // BUG-FROSTTOPICDEFAULT-001 (2026-09-07). This test used to pin the FROST default to
  // `garden-frost-alerts` — A TOPIC THAT HAS NEVER EXISTED. `aws sns list-topics` returns exactly
  // two topics in the account: garden-alerts and garden-ops-alerts. So the test was green, specific,
  // and asserting a value that would have thrown `Topic does not exist` on every frost publish had
  // the live env not overridden it. A characterization test pins whatever the code says; it cannot
  // tell you the code is wrong, and here it actively defended the defect against exactly the reading
  // that would have caught it.
  //
  // The routing assertion still means something and stays: two named constants, chosen by `topic`.
  // What changed is the DEFAULT they fall back to. D3's "separate topic" intent was never realised
  // in the account — frost and ops both resolve to garden-ops-alerts, which carries Dave's confirmed
  // email subscription (rehearsed end to end 2026-09-07). The test name no longer claims otherwise.
  it('routes frost and ops through separate constants, both defaulting to a topic that EXISTS', () => {
    expect(publishBody).toMatch(/topic === 'ops' \? OPS_TOPIC_ARN : FROST_TOPIC_ARN/);
    expect(SRC).toMatch(/FROST_TOPIC_ARN = process\.env\.FROST_TOPIC_ARN \|\| 'arn:aws:sns:us-east-1:\d+:garden-ops-alerts'/);
    expect(SRC).toMatch(/OPS_TOPIC_ARN = process\.env\.OPS_TOPIC_ARN \|\| 'arn:aws:sns:us-east-1:\d+:garden-ops-alerts'/);
    // The point of the fix: no topic constant may DEFAULT to a topic outside the account's real set.
    // Scoped to the assignment rather than the whole file on purpose — the BUG-FROSTTOPICDEFAULT-001
    // note above the constants names the dead topic to explain the history, and a blanket negative
    // would forbid recording why the bug happened. Ban the code path, not the word.
    expect(SRC).not.toMatch(/TOPIC_ARN\s*=\s*process\.env\.[A-Z_]+\s*\|\|\s*'[^']*garden-frost-alerts'/);
  });

  it('the ET hour is passed into run() — G3 run identity has no other source', () => {
    expect(SRC).toMatch(/etHour: hourET\(\)/);
    expect(SRC).toMatch(/hourCycle: 'h23'/);
  });

  it('@aws-sdk/client-sns is a declared dependency (deploy-lambda.yml runs npm install --omit=dev)', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@aws-sdk/client-sns']).toBeTruthy();
  });
});

describe('handler query carries the frost inputs', () => {
  // Decommented BEFORE flattening. handler.js's plantings query carries ~40 lines of explanatory
  // `--` prose that names these very columns, so on the raw text either assertion could be
  // satisfied by the commentary describing the column rather than by the column being selected.
  const H = decomment(readFileSync(resolve(__dirname, 'handler.js'), 'utf8')).replace(/\s+/g, ' ');
  it('selects crop_type_slug — frost class is derived from it, never from coldFor (G2)', () => {
    expect(H).toMatch(/pv\.crop_type_slug/);
  });
  it('still derives the coverage flag the D6 exclusion intersects with', () => {
    // NOTE: this was a byte-identical COPY of wxcoverloc.test.js's derivation guard, and the
    // duplication was itself a hazard — BUG-NOLOCOUTDOOR-001 changed the SQL and reddened an
    // assertion in a file that is otherwise about Open-Meteo indices, in a suite nobody would think
    // to look at. wxcoverloc.test.js owns the full derivation contract (alias arms, the
    // unknown-is-not-outdoor negative assertion, and the two-flag split).
    // What THIS file legitimately needs is only that the flag D6 consumes still exists.
    expect(H).toMatch(/as frost_covered_resolved/);
  });
});
