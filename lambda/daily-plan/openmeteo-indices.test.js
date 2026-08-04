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
const fetchPrecipBody = (() => {
  const i = SRC.indexOf('async function fetchPrecip');
  expect(i, 'async function fetchPrecip present in index.js').toBeGreaterThan(-1);
  const j = SRC.indexOf('async function', i + 1);
  return SRC.slice(i, j === -1 ? undefined : j);
})();

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
    expect(fetchPrecipBody).toMatch(/:\s*null,\s*\n\s*\};/);
  });

  it('fetchPrecip keeps its null-fallback catch — hydrology degrades, it does not crash the run', () => {
    expect(fetchPrecipBody).toMatch(/catch[\s\S]*return null/);
  });
});

describe('SNS publish path (F3) — deliberately NOT fail-soft', () => {
  const publishBody = (() => {
    const i = SRC.indexOf('async function publishAlert');
    expect(i, 'async function publishAlert present in index.js').toBeGreaterThan(-1);
    const j = SRC.indexOf('\n}', i);
    return SRC.slice(i, j);
  })();

  it('has NO try/catch — §3-7 forbids swallowing a frost publish failure', () => {
    expect(publishBody).not.toMatch(/try\s*{/);
    expect(publishBody).not.toMatch(/catch/);
  });

  it('routes the ops topic separately from the frost topic (D3: a separate topic)', () => {
    expect(publishBody).toMatch(/topic === 'ops' \? OPS_TOPIC_ARN : FROST_TOPIC_ARN/);
    expect(SRC).toMatch(/FROST_TOPIC_ARN = process\.env\.FROST_TOPIC_ARN \|\| 'arn:aws:sns:us-east-1:\d+:garden-frost-alerts'/);
    expect(SRC).toMatch(/OPS_TOPIC_ARN = process\.env\.OPS_TOPIC_ARN \|\| 'arn:aws:sns:us-east-1:\d+:garden-ops-alerts'/);
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
  const H = readFileSync(resolve(__dirname, 'handler.js'), 'utf8').replace(/\s+/g, ' ');
  it('selects crop_type_slug — frost class is derived from it, never from coldFor (G2)', () => {
    expect(H).toMatch(/pv\.crop_type_slug/);
  });
  it('still derives the covered flag the D6 exclusion intersects with', () => {
    expect(H).toMatch(/coalesce\(l\.type_label in \('shelf','rack','tray'\) or l\.name in \('Stable','House'\), false\) as covered/);
  });
});
