import { describe, it, expect } from 'vitest';
import { computeStreak, STREAK_GRACE_DAYS } from './streak.js';

// All dates expressed as offsets from a fixed "today" = 2026-05-25 (UTC calendar math).
const TODAY = '2026-05-25';
const BASE = Date.UTC(2026, 4, 25); // month index 4 = May
const day = (offset) => new Date(BASE + offset * 86400000).toISOString().slice(0, 10);

describe('computeStreak — empties & guards', () => {
  it('empty array -> 0/0', () => {
    expect(computeStreak([], TODAY)).toEqual({ current: 0, longest: 0 });
  });
  it('null/undefined input -> 0/0', () => {
    expect(computeStreak(null, TODAY)).toEqual({ current: 0, longest: 0 });
    expect(computeStreak(undefined, TODAY)).toEqual({ current: 0, longest: 0 });
  });
  it('garbage day strings are ignored', () => {
    expect(computeStreak(['not-a-date', day(0)], TODAY)).toEqual({ current: 1, longest: 1 });
  });
});

describe('computeStreak — single day & liveness (grace=1)', () => {
  it('logged today -> 1/1', () => {
    expect(computeStreak([day(0)], TODAY)).toEqual({ current: 1, longest: 1 });
  });
  it('logged yesterday -> still alive 1/1', () => {
    expect(computeStreak([day(-1)], TODAY)).toEqual({ current: 1, longest: 1 });
  });
  it('logged 2 days ago -> within grace, alive 1/1', () => {
    expect(computeStreak([day(-2)], TODAY)).toEqual({ current: 1, longest: 1 });
  });
  it('logged 3 days ago -> stale, current decays to 0 (longest preserved)', () => {
    expect(computeStreak([day(-3)], TODAY)).toEqual({ current: 0, longest: 1 });
  });
});

describe('computeStreak — consecutive runs', () => {
  it('3 consecutive ending today -> 3/3', () => {
    expect(computeStreak([day(0), day(-1), day(-2)], TODAY)).toEqual({ current: 3, longest: 3 });
  });
  it('3 consecutive ending yesterday -> alive 3/3', () => {
    expect(computeStreak([day(-1), day(-2), day(-3)], TODAY)).toEqual({ current: 3, longest: 3 });
  });
  it('3 consecutive ending 3 days ago -> stale current 0, longest 3', () => {
    expect(computeStreak([day(-3), day(-4), day(-5)], TODAY)).toEqual({ current: 0, longest: 3 });
  });
});

describe('computeStreak — break-recovery (grace) semantics', () => {
  it('one forgiven missed day keeps the run (gap of 2 calendar days)', () => {
    expect(computeStreak([day(0), day(-2)], TODAY)).toEqual({ current: 2, longest: 2 });
  });
  it('two missed days breaks the run', () => {
    expect(computeStreak([day(0), day(-3)], TODAY)).toEqual({ current: 1, longest: 1 });
  });
  it('every-other-day sustains under grace=1 (counts activity days)', () => {
    expect(computeStreak([day(0), day(-2), day(-4), day(-6)], TODAY)).toEqual({ current: 4, longest: 4 });
  });
  it('grace=0 (strict consecutive) breaks every-other-day', () => {
    expect(computeStreak([day(0), day(-2), day(-4)], TODAY, 0)).toEqual({ current: 1, longest: 1 });
  });
  it('grace=0 still counts truly consecutive days', () => {
    expect(computeStreak([day(0), day(-1), day(-2)], TODAY, 0)).toEqual({ current: 3, longest: 3 });
  });
});

describe('computeStreak — input hygiene', () => {
  it('unsorted + duplicate days collapse correctly', () => {
    expect(computeStreak([day(-2), day(0), day(0), day(-1), day(-1)], TODAY)).toEqual({ current: 3, longest: 3 });
  });
  it('future-dated days are excluded', () => {
    expect(computeStreak([day(1), day(0), day(-1)], TODAY)).toEqual({ current: 2, longest: 2 });
  });
  it('accepts Date objects and ISO timestamps, not just YYYY-MM-DD', () => {
    const iso = new Date(BASE).toISOString();
    expect(computeStreak([iso, day(-1)], TODAY)).toEqual({ current: 2, longest: 2 });
  });
});

describe('computeStreak — longest across islands', () => {
  it('current run can be shorter than the longest historical run', () => {
    expect(computeStreak([day(0), day(-1), day(-5), day(-6), day(-7)], TODAY)).toEqual({ current: 2, longest: 3 });
  });
});

describe('computeStreak — Dave production data (2026-05-25)', () => {
  const daveDays = ['2026-05-24', '2026-05-19', '2026-05-18', '2026-05-14', '2026-05-12', '2026-05-01', '2026-04-30'];
  it('reproduces stored current_streak=1, longest_streak=2', () => {
    expect(computeStreak(daveDays, '2026-05-25')).toEqual({ current: 1, longest: 2 });
  });
  it('logging activity TODAY (May 25) extends to 2 — the fix Dave will see', () => {
    expect(computeStreak([...daveDays, '2026-05-25'], '2026-05-25')).toEqual({ current: 2, longest: 2 });
  });
  it('THE FIX: two consecutive activity days backfilled in one session count as 2', () => {
    expect(computeStreak(['2026-05-18', '2026-05-19'], '2026-05-19')).toEqual({ current: 2, longest: 2 });
  });
});

describe('computeStreak — config', () => {
  it('default grace constant is 1', () => {
    expect(STREAK_GRACE_DAYS).toBe(1);
  });
  it('today=null falls back to counting the run from the latest activity day', () => {
    expect(computeStreak([day(0), day(-1)], null)).toEqual({ current: 2, longest: 2 });
  });
});
