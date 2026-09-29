// V5-SEASONSTATS-001 — three copies of the pepper heat bands must agree.
//
//   1. HEAT_BANDS in lambda/varieties/crop-derive.js — the catalogue's own banding (canonical).
//   2. The CASE in public.stat_planting (migrations/v5-seasonstats-001/0a-additive-ddl.sql) — what
//      every Season stats heat figure is grouped by.
//   3. HEAT_BANDS in ./season-stats-sections.js — the band order and labels the page receives.
//
// They cannot share a constant (SQL, and two Lambda dirs that are zipped separately), so drift is
// silent: a band edge moved in one place re-buckets peppers on one surface and not another. This
// parses (2) from the migration text and compares slugs, ceilings and order across all three.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEAT_BANDS as CANON, heatBand } from '../varieties/crop-derive.js';
import { HEAT_BANDS as SHAPER } from './season-stats-sections.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DDL = readFileSync(resolve(__dirname, '../../migrations/v5-seasonstats-001/0a-additive-ddl.sql'), 'utf8');

function sqlBands() {
  const view = DDL.match(/CREATE OR REPLACE VIEW public\.stat_planting AS([\s\S]*?);/)[1];
  const caseBody = view.match(/CASE WHEN v\.scoville_max IS NULL OR v\.scoville_max < 0 THEN NULL([\s\S]*?)END AS heat_band/)[1];
  const bands = [...caseBody.matchAll(/WHEN v\.scoville_max <= (\d+)\s+THEN '([a-z_]+)'/g)]
    .map((m) => ({ max: Number(m[1]), slug: m[2] }));
  const tail = caseBody.match(/ELSE '([a-z_]+)'/);
  if (tail) bands.push({ max: Infinity, slug: tail[1] });
  return bands;
}

const pairs = (list) => list.map((b) => [b.slug, b.max]);

describe('heat band parity: crop-derive.js = stat_planting CASE = season-stats shapers', () => {
  it('parses six bands out of the migration, so the comparison is not vacuous', () => {
    expect(sqlBands()).toHaveLength(6);
  });

  it('the SQL CASE matches crop-derive HEAT_BANDS (slug, ceiling, order)', () => {
    expect(pairs(sqlBands())).toEqual(pairs(CANON));
  });

  it('the shaper band list matches crop-derive HEAT_BANDS (slug, ceiling, order)', () => {
    expect(pairs(SHAPER)).toEqual(pairs(CANON));
  });

  it('labels differ only in case (contract uses sentence case: "Very hot")', () => {
    expect(SHAPER.map((b) => b.label.toLowerCase())).toEqual(CANON.map((b) => b.label.toLowerCase()));
  });

  it('the SQL treats null and negative as no band, like heatBand()', () => {
    expect(DDL).toMatch(/CASE WHEN v\.scoville_max IS NULL OR v\.scoville_max < 0 THEN NULL/);
    expect(heatBand(null)).toBeNull();
    expect(heatBand(-1)).toBeNull();
  });

  it('edge values land in the same band on both sides', () => {
    const sqlBand = (n) => sqlBands().find((b) => n <= b.max)?.slug ?? null;
    for (const n of [0, 1, 999, 1000, 9999, 10000, 49999, 50000, 249999, 250000, 2_200_000]) {
      expect(sqlBand(n), String(n)).toBe(heatBand(n).slug);
    }
  });
});
