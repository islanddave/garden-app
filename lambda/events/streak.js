// Streak computation — pure, DB-free, unit-testable (V1.2-streak-fix, 2026-05-25).
//
// KEEP IN SYNC with lambda/dashboard/streak.js — it is a byte-identical copy. The deploy
// packages each Lambda by zipping ONLY its own directory (`cd lambda/<fn> && zip -r ../<fn>.zip .`),
// so a shared `../shared/streak.js` import is excluded from the bundle and 502s at module load
// (L-089). Two in-dir copies is the intentional workaround, not accidental duplication.
//
// WHY THIS EXISTS (the bug it replaces):
//   The previous streak math keyed off NOW() — the calendar day the event was *logged* — and
//   incremented current_streak by +1 per logging day. Two real failures:
//     1. Bulk/backfilled logging of multiple consecutive activity days in ONE sitting counted as a
//        single day (Dave logged May 18 + May 19 activity on May 19 -> streak saw one day, showed 1).
//     2. It only ran on POST, so a stale streak was never decayed — the dashboard kept showing the
//        last-written value until the next log.
//
// THE MODEL (this file):
//   - A streak counts DISTINCT calendar days on which the user has garden ACTIVITY, keyed on the
//     event's `event_date` in the user's timezone — NOT the moment it was logged. Backfill counts.
//   - Break-recovery (required by CLAUDE.md Streaks rule): a run tolerates up to `graceDays` missed
//     days between activity days. In calendar terms, two activity days stay in the same run when the
//     gap between them is <= graceDays + 1. Default graceDays = 1 (one missed day forgiven).
//   - `current` = length of the run ending at the most-recent activity day, reported only if that day
//     is within the grace window of `today` (today - latest <= graceDays + 1). Otherwise 0. This is
//     what makes a stale streak read 0 with NO write/cron needed — callers recompute live.
//   - `longest` = the longest such run across all of history.
//   - Future-dated activity days (> today) are ignored.
//
// GRACE KNOB: graceDays = 1 forgives a single missed day. Trade-off: it also lets an every-other-day
// cadence sustain a streak (each gap is 1 missed day). For STRICT consecutive-days (any miss breaks
// it) set STREAK_GRACE_DAYS = 0. This is a product call — see the session report.

export const STREAK_GRACE_DAYS = 1;

// Convert a 'YYYY-MM-DD' string (or a Date / ISO timestamp) to an integer day index (days since
// the Unix epoch, UTC). Calendar-only — no time component, no local-TZ shift.
function toDayNum(v) {
  if (v == null) return null;
  let y, m, d;
  if (v instanceof Date) {
    y = v.getUTCFullYear(); m = v.getUTCMonth() + 1; d = v.getUTCDate();
  } else {
    const p = String(v).slice(0, 10).split('-');
    y = Number(p[0]); m = Number(p[1]); d = Number(p[2]);
  }
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

// activityDays: array of activity-day identifiers ('YYYY-MM-DD' preferred). Order/dupes don't matter.
// today: the user's "today" in their timezone ('YYYY-MM-DD'). May be null (then liveness check is skipped).
// Returns { current, longest } integers.
export function computeStreak(activityDays, today, graceDays = STREAK_GRACE_DAYS) {
  const maxGap = graceDays + 1; // max allowed calendar-day gap between two days in the same run
  const todayNum = toDayNum(today);

  // unique day-numbers, future excluded, sorted descending
  let nums = [...new Set((activityDays ?? []).map(toDayNum).filter((n) => n != null))];
  if (todayNum != null) nums = nums.filter((n) => n <= todayNum);
  nums.sort((a, b) => b - a);
  if (nums.length === 0) return { current: 0, longest: 0 };

  // longest run across all history (islands separated by a gap > maxGap)
  let longest = 1;
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    run = nums[i - 1] - nums[i] <= maxGap ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  // current run: ends at the most-recent activity day, alive only if within grace of today
  let current = 0;
  const ref = todayNum == null ? nums[0] : todayNum;
  if (ref - nums[0] <= maxGap) {
    current = 1;
    for (let i = 1; i < nums.length; i++) {
      if (nums[i - 1] - nums[i] <= maxGap) current++;
      else break;
    }
  }

  return { current, longest };
}
