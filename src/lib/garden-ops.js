// garden-ops.js — DB-MIGRATE-2 stub
// updateEntityMemory and updateUserStats moved server-side to events Lambda.
// Exports retained as no-ops so un-migrated imports don't crash.
//
// This header used to claim "Events POST now returns { eventId, stats } with XP/level data". That
// was false in both halves and cost a session real time: the response has no `stats` envelope (it
// spreads the event and adds newly_earned_achievements / updated_streak / xp_gained /
// daily_xp_remaining), and it carried no level data at all until BUG-XPPROGRESSION-001 added
// `level` and `leveled_up`. The pre-DB-MIGRATE-2 version of THIS file held the original client-side
// level ladder (LEVEL_THRESHOLDS + xpToLevel + PHOTO_BONUS_XP); recover it from git at 90ab22c if
// you need the history. The curve is now server-side and canonical in
// migrations/v4-xpprogression-001/0a-level-curve.sql; src/lib/xpLevel.js is a display-only mirror.

export function updateEntityMemory() {}
export function updateUserStats() {}
