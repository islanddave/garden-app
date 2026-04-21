// ============================================================
// garden-ops.js — Post-event side effects
//
// Called after every event_log insert. Maintains:
//   1. entity_memory — last_*_at timestamps per project + location
//   2. user_stats    — streak, XP, level, total_events
//
// V2 will extend these with inference engine writes.
// Keep all DB logic here so EventNew and future log pages
// share a single implementation.
// ============================================================

import { supabase } from './supabase.js'

// ---- XP per event type ----
const XP_BY_TYPE = {
  watering:    10,
  observation: 15,
  pruning:     20,
  fertilizing: 20,
  transplant:  25,
  harvest:     30,
  first_harvest: 30,
}
const DEFAULT_XP = 10
const PHOTO_BONUS_XP = 5

// ---- Level thresholds (XP → level) ----
// Sorted descending so the first match wins.
const LEVEL_THRESHOLDS = [
  { xp: 15000, level: 9 },
  { xp: 7500,  level: 8 },
  { xp: 4000,  level: 7 },
  { xp: 2000,  level: 6 },
  { xp: 1000,  level: 5 },
  { xp: 500,   level: 4 },
  { xp: 250,   level: 3 },
  { xp: 100,   level: 2 },
  { xp: 0,     level: 1 },
]

function xpToLevel(totalXp) {
  for (const { xp, level } of LEVEL_THRESHOLDS) {
    if (totalXp >= xp) return level
  }
  return 1
}

// ---- Map event_type → entity_memory column ----
function memoryColumnForType(eventType) {
  const map = {
    watering:    'last_watered_at',
    fertilizing: 'last_fertilized_at',
    pruning:     'last_pruned_at',
    observation: 'last_observed_at',
    harvest:     'last_harvested_at',
    first_harvest: 'last_harvested_at',
  }
  return map[eventType] ?? null
}

// ---- Today as a date string (YYYY-MM-DD, local) ----
function toDateStr(date) {
  const d = date instanceof Date ? date : new Date(date)
  return d.toISOString().split('T')[0]
}
function today() { return toDateStr(new Date()) }
function yesterday() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return toDateStr(d)
}


// ============================================================
// updateEntityMemory
// Upserts entity_memory for both project and location.
// Only updates timestamps — never touches inference fields.
// ============================================================
export async function updateEntityMemory(projectId, locationId, eventType, eventDate) {
  const ts     = eventDate instanceof Date ? eventDate.toISOString() : eventDate
  const typeCol = memoryColumnForType(eventType)
  const shared  = { last_event_at: ts, updated_at: new Date().toISOString() }
  const typeUpdate = typeCol ? { [typeCol]: ts } : {}

  const updates = { ...shared, ...typeUpdate }

  // Upsert project memory
  if (projectId) {
    await supabase
      .from('entity_memory')
      .upsert(
        { project_id: projectId, ...updates },
        { onConflict: 'project_id', ignoreDuplicates: false }
      )
  }

  // Upsert location memory
  if (locationId) {
    await supabase
      .from('entity_memory')
      .upsert(
        { location_id: locationId, ...updates },
        { onConflict: 'location_id', ignoreDuplicates: false }
      )
  }
}


// ============================================================
// updateUserStats
// Upserts user_stats for a single user.
// Handles: streak calc, XP grant, level update, event count.
// Returns { newXp, newLevel, newStreak, isLevelUp }
// ============================================================
export async function updateUserStats(userId, eventType, { hasPhoto = false, eventLogId = null } = {}) {
  // 1 — Fetch current stats (may not exist yet)
  const { data: current } = await supabase
    .from('user_stats')
    .select('xp, level, current_streak, longest_streak, last_active_date, total_events')
    .eq('user_id', userId)
    .maybeSingle()

  const todayStr     = today()
  const yesterdayStr = yesterday()

  // ---- Streak calc ----
  const lastActive = current?.last_active_date ?? null
  let newStreak
  if (!lastActive || lastActive < yesterdayStr) {
    newStreak = 1  // first ever, or gap — reset
  } else if (lastActive === yesterdayStr) {
    newStreak = (current?.current_streak ?? 0) + 1  // consecutive day
  } else {
    newStreak = current?.current_streak ?? 1  // same day, no change
  }

  const newLongest = Math.max(current?.longest_streak ?? 0, newStreak)
  const newEvents  = (current?.total_events ?? 0) + 1

  // ---- XP grant ----
  const baseXp  = XP_BY_TYPE[eventType] ?? DEFAULT_XP
  const photoXp = hasPhoto ? PHOTO_BONUS_XP : 0
  const earnedXp = baseXp + photoXp
  const newXp    = (current?.xp ?? 0) + earnedXp
  const newLevel = xpToLevel(newXp)
  const isLevelUp = newLevel > (current?.level ?? 1)

  // ---- Upsert user_stats ----
  await supabase
    .from('user_stats')
    .upsert(
      {
        user_id:          userId,
        xp:               newXp,
        level:            newLevel,
        current_streak:   newStreak,
        longest_streak:   newLongest,
        last_active_date: todayStr,
        total_events:     newEvents,
      },
      { onConflict: 'user_id', ignoreDuplicates: false }
    )

  // ---- Write xp_events audit row ----
  const xpRows = [
    { user_id: userId, amount: baseXp,  reason: 'event_logged',  source_id: eventLogId },
  ]
  if (hasPhoto) {
    xpRows.push({ user_id: userId, amount: photoXp, reason: 'photo_bonus', source_id: eventLogId })
  }
  await supabase.from('xp_events').insert(xpRows)

  return { newXp, newLevel, newStreak, isLevelUp, earnedXp }
}
