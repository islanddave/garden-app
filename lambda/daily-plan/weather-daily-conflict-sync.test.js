// BUG-WXWRITEOVERWRITE-001 — the two weather_daily writers must carry ONE conflict policy.
//
// scripts/backfill-weather-daily.mjs has always claimed, in a comment, to be "byte-for-byte the same
// conflict policy as lambda/daily-plan/handler.js writeWeatherDaily, and it must stay that way: a
// backfill with a laxer policy than the nightly writer would undo the nightly writer's work every
// time it ran." That claim was FALSE at the time it was written — only the two precip arms matched;
// et0_in/tmax_f/tmin_f were `coalesce(excluded.x, weather_daily.x)` in both files, so the archive
// script overwrote the nightly writer's better-sourced values on every overlapping day, exactly the
// outcome the comment says it must not have. A sentence is not a mechanism. This is the mechanism.
//
// Source-text over both files, matching the house `*-copies-sync.test.js` idiom. It cannot execute
// SQL and does not try to: the behaviour of the policy is evaluated in weatherdaily.test.js against
// the statement the driver actually receives. This test answers one narrower question — are the two
// copies the same text — which is the one a behaviour test on a single writer structurally cannot.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HANDLER = readFileSync(join(ROOT, 'lambda/daily-plan/handler.js'), 'utf8');
const BACKFILL = readFileSync(join(ROOT, 'scripts/backfill-weather-daily.mjs'), 'utf8');

// From `on conflict` through the `updated_at = now()` that closes the SET list. Bounded on both ends
// deliberately: an unbounded tail reads the rest of the file and would compare two things that are
// not the policy (source-text guards need a length bound).
const POLICY = /on conflict \(space_id, "date"\) do update set\b[\s\S]*?updated_at = now\(\)/;

const extract = (src, label) => {
  const m = src.match(POLICY);
  if (!m) throw new Error(`no weather_daily conflict policy found in ${label}`);
  return m[0];
};

// Whitespace only. Comments are NOT stripped: the rationale for each arm is part of what has to stay
// in step, and a copy that kept the SQL but dropped the reasoning is the one that gets "simplified"
// next time. Indentation is allowed to differ because the two live at different nesting depths.
const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe('weather_daily — one conflict policy, two writers', () => {
  const handlerPolicy = extract(HANDLER, 'lambda/daily-plan/handler.js');
  const backfillPolicy = extract(BACKFILL, 'scripts/backfill-weather-daily.mjs');

  it('found a policy block in BOTH writers (anti-vacuity: two empty strings compare equal)', () => {
    expect(handlerPolicy.length).toBeGreaterThan(500);
    expect(backfillPolicy.length).toBeGreaterThan(500);
  });

  it('the nightly writer and the archive backfill emit the SAME policy', () => {
    expect(norm(backfillPolicy)).toBe(norm(handlerPolicy));
  });

  it('every measured column is rank-guarded, none left on a bare COALESCE', () => {
    // The defect in one line. `tmax_f = coalesce(excluded.tmax_f, ...)` is last-writer-wins for every
    // non-null value, and it is what these six columns used to be.
    for (const col of ['precip_in', 'precip_source', 'et0_in', 'et0_source', 'tmax_f', 'tmin_f']) {
      expect(norm(handlerPolicy)).toMatch(new RegExp(`${col} = case when coalesce\\(array_position\\(`));
      expect(norm(handlerPolicy)).not.toMatch(new RegExp(`${col} = coalesce\\(excluded\\.${col}`));
    }
  });

  it('the rank order is worst-to-best and names exactly the three CHECK-constrained sources', () => {
    // Ordering is the whole policy: reversed, this file would happily let the ERA5 archive overwrite
    // a gauge reading. The three strings are also the domain of weather_daily_precip_source_chk.
    const arrays = norm(handlerPolicy).match(/array\[[^\]]*\]/g) || [];
    expect(arrays.length).toBe(12); // 6 columns x 2 sides
    for (const a of arrays) expect(a).toBe("array['openmeteo_archive','openmeteo_live','gauge_merged']");
  });
});
