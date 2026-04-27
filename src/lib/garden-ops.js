// garden-ops.js — DB-MIGRATE-2 stub
// updateEntityMemory and updateUserStats moved server-side to events Lambda.
// Events POST now returns { eventId, stats } with XP/level data.
// Exports retained as no-ops so un-migrated imports don't crash.

export function updateEntityMemory() {}
export function updateUserStats() {}
