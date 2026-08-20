// V4-MATURITYBASIS-001 — dtm_basis must resolve CULTIVAR-first on the watch route.
//
// THE DEFECT. V4-DTMBASISVAR-001 promoted dtm_basis from crop_types to plant_varieties precisely
// because a cultivar can be quoted on a different basis than its crop, and it taught three readers
// to resolve COALESCE(cultivar, crop): all 3 variety_ref blocks in lambda/plants/index.js, and the
// v_sow_candidates view. lambda/harvests/watch-route.js was NOT taught — it kept selecting a bare
// ct.dtm_basis — so the harvest-watch surface read the crop basis while every other surface read
// the resolved one. Verified read-only against live prod Neon 2026-08-20: exactly 2 cultivars carry
// a basis that CONTRADICTS their crop (Rapini and Kailaan, both crop_type 'broccoli' =
// 'from-transplant', both cultivar 'from-sow'), and 1 has a live planting.
//
// The fixtures below are that live prod row and its reverse. Transcribed 2026-08-20:
//   Rapini Broccoli Raab | status seedling | sown_at 2026-07-30 | transplanted_at NULL
//                        | planted_out_at NULL | cultivar from-sow vs crop from-transplant
//                        | days_to_maturity 45/45 (V4-RAPINIDTM-001, packet-sourced "45 from
//                          direct seed" — a from-sow figure, which is the whole point)
//
// WHY BOTH HALVES. calendarAnchor is pure JS and is tested by EXECUTION (house rule, watch.test.js
// header). The COALESCE itself lives in a SQL string that no unit test can execute — the route
// suite drives a tagged-template stub and feeds dtm_basis in by hand, so it cannot see which column
// the SELECT read. That half gets the static guard select-columns.test.js uses for the same reason,
// decommented so the guard cannot match its own explanatory comment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calendarAnchor, NURSERY_OFFSET_DAYS_FALLBACK } from './watch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const ROUTE_SRC = decomment(readFileSync(resolve(__dirname, 'watch-route.js'), 'utf8'));

// The live prod Rapini: direct-sown, no transplant date of any kind.
const rapini = (basis) => ({
  sown_at: '2026-07-30', transplanted_at: null, planted_out_at: null,
  days_to_maturity_min: 45, days_to_maturity_max: 45, dtm_basis: basis,
});

// The reverse pairing — a from-sow cultivar known ONLY by its transplant date. This is the arm
// where the two bases produce genuinely DIFFERENT dates rather than different labels.
const transplantOnly = (basis) => ({
  sown_at: null, transplanted_at: '2026-06-11', planted_out_at: null,
  days_to_maturity_min: 85, days_to_maturity_max: null, dtm_basis: basis,
});

describe('V4-MATURITYBASIS-001 calendarAnchor honours the resolved basis', () => {
  // Direction 1: from-sow read off the sow date. Nothing to shift, nothing to correct.
  it("from-sow + sown_at only anchors ON the sow date and does NOT flag a shift", () => {
    const a = calendarAnchor(rapini('from-sow'), 31);
    expect(a.date).toBe('2026-07-30');
    expect(a.basis_field).toBe('sown_at');
    expect(a.basis_shifted).toBe(false);
    expect(a.nursery_offset_applied).toBe(0);
  });

  // Direction 1, pre-fix. Same row, crop-level basis. BASIS_PREFERENCE falls through
  // transplanted_at -> planted_out_at -> sown_at and lands on the same date, so the date is NOT
  // what regressed here — the row was reported as basis_shifted when it had not shifted, and
  // labelled 'from-transplant' while carrying a packet DTM quoted from seed.
  it("from-transplant on the SAME row keeps the date but falsely flags basis_shifted", () => {
    const a = calendarAnchor(rapini('from-transplant'), 31);
    expect(a.date).toBe('2026-07-30');
    expect(a.basis_field).toBe('sown_at');
    expect(a.basis_shifted).toBe(true);
    expect(a.basis).toBe('from-transplant');
  });

  // Direction 2 — THE DATE MOVES. A from-sow DTM read off a transplant date understates elapsed
  // time by the nursery period, so the anchor is pulled BACK by the measured offset.
  it('from-sow + transplant date only subtracts the nursery offset (2026-06-11 -> 2026-05-11)', () => {
    const a = calendarAnchor(transplantOnly('from-sow'), 31);
    expect(a.date).toBe('2026-05-11');
    expect(a.observed_date).toBe('2026-06-11');
    expect(a.basis_field).toBe('transplanted_at');
    expect(a.basis_shifted).toBe(true);
    expect(a.nursery_offset_applied).toBe(31);
  });

  it('from-transplant + the same transplant date does NOT subtract anything', () => {
    const a = calendarAnchor(transplantOnly('from-transplant'), 31);
    expect(a.date).toBe('2026-06-11');
    expect(a.basis_shifted).toBe(false);
    expect(a.nursery_offset_applied).toBe(0);
  });

  // The two bases stated against each other on one identical row: 31 days apart, not zero. This is
  // the assertion that fails if a future edit collapses the basis branch back to one code path.
  it('the two bases disagree by exactly the nursery offset on one identical row', () => {
    const row = { sown_at: null, transplanted_at: '2026-06-11', planted_out_at: null };
    const sow = calendarAnchor({ ...row, dtm_basis: 'from-sow' }, NURSERY_OFFSET_DAYS_FALLBACK);
    const tp = calendarAnchor({ ...row, dtm_basis: 'from-transplant' }, NURSERY_OFFSET_DAYS_FALLBACK);
    expect(NURSERY_OFFSET_DAYS_FALLBACK).toBe(31);
    expect(sow.date).toBe('2026-05-11');
    expect(tp.date).toBe('2026-06-11');
    expect(sow.date).not.toBe(tp.date);
  });
});

describe('V4-MATURITYBASIS-001 the watch route SELECTs the resolved basis', () => {
  it('watch-route.js resolves dtm_basis cultivar-first', () => {
    expect(ROUTE_SRC).toMatch(/COALESCE\(\s*cv\.dtm_basis\s*,\s*ct\.dtm_basis\s*\)\s+AS\s+dtm_basis/);
  });

  // The actual regression: a bare `ct.dtm_basis` in the select list silently reverts the route to
  // the crop basis and re-ships the defect with every JS test still green.
  it('no bare ct.dtm_basis survives in the select list', () => {
    const all = ROUTE_SRC.match(/\bct\.dtm_basis\b/g) || [];
    const inCoalesce = ROUTE_SRC.match(/COALESCE\(\s*cv\.dtm_basis\s*,\s*ct\.dtm_basis\s*\)/g) || [];
    expect(all.length, 'expected at least one ct.dtm_basis to guard').toBeGreaterThan(0);
    expect(all.length, 'every ct.dtm_basis must sit inside the COALESCE').toBe(inCoalesce.length);
  });
});
