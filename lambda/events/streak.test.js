import { describe, it, expect } from 'vitest';
import { computeStreak, STREAK_GRACE_DAYS } from './streak.js';

// Dates as offsets from a fixed "today" = 2026-05-25 (UTC calendar math).
const TODAY = '2026-05-25';
const BASE = Date.UTC(2026, 4, 25);
const day = (offset) => new Date(BASE + offset * 86400000).toISOString().slice(0, 10);

describe('computeStreak — empties & guards', () => {
  it('empty -> 0/0', () => expect(computeStreak([], TODAY)).toEqual({ current: 0, longest: 0 }));
  it('null/undefined -> 0/0', () => {
    expect(computeStreak(null, TODAY)).toEqual({ current: 0, longest: 0 });
    expect(computeStreak(undefined, TODAY)).toEqual({ current: 0, longest: 0 });
  });
  it('garbage ignored', () => expect(computeStreak(['nope', day(0)], TODAY)).toEqual({ current: 1, longest: 1 }));
});

describe('computeStreak — single day & liveness (default strict, grace=0)', () => {
  it('today -> 1/1', () => expect(computeStreak([day(0)], TODAY)).toEqual({ current: 1, longest: 1 }));
  it('yesterday -> still alive 1/1 (one day to keep it going)', () =>
    expect(computeStreak([day(-1)], TODAY)).toEqual({ current: 1, longest: 1 }));
  it('2 days ago -> STRICT: not alive, current 0 (longest kept)', () =>
    expect(computeStreak([day(-2)], TODAY)).toEqual({ current: 0, longest: 1 }));
  it('3 days ago -> current 0, longest 1', () =>
    expect(computeStreak([day(-3)], TODAY)).toEqual({ current: 0, longest: 1 }));
});

describe('computeStreak — consecutive runs', () => {
  it('3 consecutive ending today -> 3/3', () =>
    expect(computeStreak([day(0), day(-1), day(-2)], TODAY)).toEqual({ current: 3, longest: 3 }));
  it('3 consecutive ending yesterday -> alive 3/3', () =>
    expect(computeStreak([day(-1), day(-2), day(-3)], TODAY)).toEqual({ current: 3, longest: 3 }));
  it('3 consecutive ending 3 days ago -> stale current 0, longest 3', () =>
    expect(computeStreak([day(-3), day(-4), day(-5)], TODAY)).toEqual({ current: 0, longest: 3 }));
});

describe('computeStreak — STRICT semantics (no auto-grace)', () => {
  it('a single missed day BREAKS the run', () =>
    expect(computeStreak([day(0), day(-2)], TODAY)).toEqual({ current: 1, longest: 1 }));
  it('two missed days breaks the run', () =>
    expect(computeStreak([day(0), day(-3)], TODAY)).toEqual({ current: 1, longest: 1 }));
  it('every-other-day does NOT sustain a streak', () =>
    expect(computeStreak([day(0), day(-2), day(-4), day(-6)], TODAY)).toEqual({ current: 1, longest: 1 }));
});

describe('computeStreak — catch-up by back-dating (the recovery mechanism)', () => {
  it('missed yesterday -> run is broken until backfilled', () => {
    // active today + 2-days-ago, yesterday missing
    expect(computeStreak([day(0), day(-2)], TODAY)).toEqual({ current: 1, longest: 1 });
  });
  it('back-date the missed day -> run reconnects to 3', () => {
    expect(computeStreak([day(0), day(-1), day(-2)], TODAY)).toEqual({ current: 3, longest: 3 });
  });
});

describe('computeStreak — explicit grace param still works (opt-in)', () => {
  it('grace=1 forgives one missed day', () =>
    expect(computeStreak([day(0), day(-2)], TODAY, 1)).toEqual({ current: 2, longest: 2 }));
  it('grace=1 sustains every-other-day', () =>
    expect(computeStreak([day(0), day(-2), day(-4)], TODAY, 1)).toEqual({ current: 3, longest: 3 }));
});

describe('computeStreak — input hygiene', () => {
  it('unsorted + dup collapse', () =>
    expect(computeStreak([day(-2), day(0), day(0), day(-1), day(-1)], TODAY)).toEqual({ current: 3, longest: 3 }));
  it('future excluded', () =>
    expect(computeStreak([day(1), day(0), day(-1)], TODAY)).toEqual({ current: 2, longest: 2 }));
  it('Date / ISO accepted', () => {
    const iso = new Date(BASE).toISOString();
    expect(computeStreak([iso, day(-1)], TODAY)).toEqual({ current: 2, longest: 2 });
  });
});

describe('computeStreak — longest across islands', () => {
  it('current can be shorter than longest', () =>
    expect(computeStreak([day(0), day(-1), day(-5), day(-6), day(-7)], TODAY)).toEqual({ current: 2, longest: 3 }));
});

describe('computeStreak — Dave data', () => {
  it('original set (2026-05-25) -> 1/2', () => {
    const d = ['2026-05-24','2026-05-19','2026-05-18','2026-05-14','2026-05-12','2026-05-01','2026-04-30'];
    expect(computeStreak(d, '2026-05-25')).toEqual({ current: 1, longest: 2 });
  });
  it('current 3-day run (23-24-25) -> 3/3', () => {
    const d = ['2026-05-25','2026-05-24','2026-05-23','2026-05-19','2026-05-18','2026-05-14','2026-05-12'];
    expect(computeStreak(d, '2026-05-25')).toEqual({ current: 3, longest: 3 });
  });
  it('two consecutive backfilled in one session count as 2', () =>
    expect(computeStreak(['2026-05-18','2026-05-19'], '2026-05-19')).toEqual({ current: 2, longest: 2 }));
});

describe('computeStreak — config', () => {
  it('default grace constant is 0 (strict)', () => expect(STREAK_GRACE_DAYS).toBe(0));
  it('today=null falls back to run from latest', () =>
    expect(computeStreak([day(0), day(-1)], null)).toEqual({ current: 2, longest: 2 }));
});
