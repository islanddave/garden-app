// Streak computation: pure, DB-free, unit-testable.
//
// KEEP IN SYNC with lambda/events/streak.js (an in-dir copy; the deploy zips only each Lambda's
// own directory, so a shared import would 502 at module load, L-089).
//
// Model:
//   - A streak counts DISTINCT calendar days with garden ACTIVITY, keyed on the event's
//     `event_date` in the user's timezone, not the moment it was logged. Backfill counts.
//   - A run tolerates up to `graceDays` missed days: two activity days stay in one run when the
//     gap between them is <= graceDays + 1.
//   - `current` = length of the run ending at the most-recent activity day, reported only if that
//     day is within the grace window of `today`, else 0. A stale streak therefore reads 0 with no
//     write or cron; callers recompute live.
//   - `longest` = the longest such run across all history.
//   - Future-dated activity days (> today) are ignored.
//
// STREAK_GRACE_DAYS = 0 (Dave decision): STRICT consecutive days. Recovery is by back-dating a
// log for the missed day, not auto-grace. 1 would let every-other-day sustain a streak, which is
// why it is not the default.

export const STREAK_GRACE_DAYS = 0;

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
