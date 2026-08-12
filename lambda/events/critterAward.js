// Server-side critter award — events Lambda hook (architectural refactor 2026-05-30).
// Spec: revision §2.7 ("events Lambda → critter Lambda hook"), §3.10 (fire-and-forget +
// server-driven backfill). Replaces the client-side awardCritter() pattern, which had
// per-surface wiring + cold-start race conditions.
//
// Pattern: any event_log INSERT with plant_id IS NOT NULL triggers an inline critter_state
// INSERT via this module. Same Lambda call, same SQL connection, runs immediately after
// the event INSERT transaction commits. Critter row exists by the time POST /api/events
// returns to the client → Dashboard backfill on the next navigate finds it deterministically,
// no race, no client coordination, no per-surface wiring.
//
// Idempotency: UNIQUE INDEX on critter_state(source_event_id) WHERE deleted_at IS NULL
// (revision §3.27). ON CONFLICT DO NOTHING means re-fires (e.g., on retry/backfill audit)
// are no-ops, not errors.

import { pickSpecies, pickCopyVariant } from './critterSpecies.js'
import { isRewardedEventType } from './eventTypes.generated.js'

// V3-DELIGHT-001 D2 — shared household "sighting tally".
// CONTRACT: TALLY_SIGHTINGS mirrors src/lib/sharedStateClient.js (frontend read) and the
// garden_shared_state incentive_counter rows; SENTINEL_WORKSPACE mirrors
// lambda/shared-state/index.js (denormalized pre-V4-Workspaces value). Keep all in sync.
const TALLY_SIGHTINGS = 'tally:sightings'
const SENTINEL_WORKSPACE = '00000000-0000-0000-0000-000000000001'

// Increment the garden-wide sighting tally by 1. NON-FATAL: a failure here must NEVER affect
// event logging or critter awarding (cosmetic counter). Atomic single-statement upsert mirrors
// the shared-state Lambda's increment path (row-level lock on ON CONFLICT serializes concurrent
// +1 writes). Called EXACTLY ONCE per genuine new award — the caller gates on an actually-
// inserted critter row, so idempotent ON-CONFLICT-DO-NOTHING re-hits never reach here.
async function incrementSightingTally(sql) {
  try {
    await sql`
      INSERT INTO garden_shared_state (workspace_id, kind, natural_key, counter)
      VALUES (${SENTINEL_WORKSPACE}::uuid, 'incentive_counter', ${TALLY_SIGHTINGS}, 1)
      ON CONFLICT (workspace_id, kind, natural_key) WHERE deleted_at IS NULL
      DO UPDATE SET counter = garden_shared_state.counter + 1
    `
  } catch (err) {
    console.warn('sighting tally increment failed (non-fatal):', err?.message ?? String(err))
  }
}

// Build deterministic seed. This is now the ONLY seed builder: the client mirror in
// src/lib/critterClient.js was removed with POST /api/critters (BUG-CRITTERSELFGRANT-001).
// Its output is stored as meta.deterministic_seed, so this function's behavior is
// load-bearing for the provenance of every existing critter_state row — do not change it.
function buildSeed(sourceEventId, eventCreatedAt, householdId) {
  return [
    sourceEventId ?? '',
    eventCreatedAt ?? '',
    householdId ?? '',
  ].join('|')
}

// Quiet-hours dot_visible_after computation (ported byte-identical from critter Lambda).
// Returns ISO timestamp of the "dot becomes visible" moment.
export function computeDotVisibleAfter(now, quietStart, quietEnd, tzOffsetMin) {
  const start = quietStart ?? '21:00'
  const end = quietEnd ?? '07:00'
  const offset = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0
  const localNow = new Date(now.getTime() - offset * 60 * 1000)
  const localHM = `${String(localNow.getUTCHours()).padStart(2, '0')}:${String(localNow.getUTCMinutes()).padStart(2, '0')}`
  const inQuiet = start > end
    ? (localHM >= start || localHM < end)
    : (localHM >= start && localHM < end)
  if (!inQuiet) return now.toISOString()
  const [eh, em] = end.split(':').map(Number)
  const target = new Date(localNow)
  target.setUTCHours(eh, em, 0, 0)
  if (target <= localNow) target.setUTCDate(target.getUTCDate() + 1)
  return new Date(target.getTime() + offset * 60 * 1000).toISOString()
}

// Read user notification prefs (stateless defaults applied at read; no first-read-side-effect write).
// Mirrors critter Lambda's readUserPrefs. Caller can pass cached prefs to avoid duplicate fetches
// in batch paths.
export async function readUserPrefs(sql, clerkSub) {
  const rows = await sql`
    SELECT critter_visit, quiet_hours_start, quiet_hours_end,
           coachmark_seen_at, opt_in_prompt_seen_at, last_garden_view_at, created_at, updated_at
      FROM public.user_notification_prefs
     WHERE created_by = ${clerkSub}
     LIMIT 1
  `
  if (rows.length > 0) return rows[0]
  return {
    critter_visit: 'in_app_only',
    quiet_hours_start: '21:00:00',
    quiet_hours_end: '07:00:00',
    coachmark_seen_at: null,
    opt_in_prompt_seen_at: null,
    last_garden_view_at: null,
    created_at: null,
    updated_at: null,
  }
}

// Read user species-pref weights for D-INV-1 long-press love/meh modulation.
// Returns { [species_id]: weight } map (empty if no rows).
export async function readSpeciesPrefs(sql, clerkSub) {
  const rows = await sql`
    SELECT species_id, weight
      FROM public.critter_species_prefs
     WHERE created_by = ${clerkSub}
  `
  const out = {}
  for (const r of rows) out[r.species_id] = Number(r.weight)
  return out
}

// awardCritterServer — INSERT a critter_state row for one event.
//
// Inputs:
//   sql              — Neon serverless sql tag function
//   userId           — clerk_sub of the event creator (becomes critter_state.created_by)
//   eventId          — UUID of the just-inserted event_log row (source_event_id)
//   plantId          — UUID of the event's plant; if null/undefined → no-op (MVP plant-only)
//   eventCreatedAt   — ISO string from event_log.created_at (used in seed)
//   householdId      — clerk_sub for seed (typically same as userId in V2.x)
//   tzOffsetMin      — minutes from UTC (JS getTimezoneOffset convention); 0 if unknown
//   prefs            — { quiet_hours_start, quiet_hours_end } from readUserPrefs (or null → defaults)
//   speciesPrefs     — { [species_id]: weight } from readSpeciesPrefs (or {} for none)
//
// Returns the inserted critter row, or null if:
//   - no plantId (MVP plant-only scope cut per revision §1.1)
//   - ON CONFLICT DO NOTHING fired (idempotent re-hit, source_event_id already has a critter)
//   - SQL error (silent — events Lambda continues; critter not awarded, server-driven backfill
//                may catch it later per spec §3.10)
//
// NEVER throws — caller doesn't need try/catch.
export async function awardCritterServer({
  sql,
  userId,
  eventId,
  plantId,
  eventCreatedAt = null,
  householdId = null,
  tzOffsetMin = 0,
  prefs = null,
  speciesPrefs = {},
  speciesMultipliers = {},   // future: season/milestone modulation (V4 blocker)
  skipAward = false,          // smoke bypass — events Lambda passes true when event.metadata._skip_critter_award is set
  eventType = undefined,      // event_log.event_type of the source event — see the gate below
} = {}) {
  if (skipAward) return null  // explicit caller bypass (smoke / admin)
  // BUG-CRITTERNONREWARD-001 — the NON_REWARD_EVENT_TYPES contract ("ZERO xp, ZERO streak credit,
  // ZERO total_events") had THREE enforcement points (index.js Step 3a/3b/3c, batchSideEffects.js,
  // dashboard/handlers.js) and this was the FOURTH grant path, ungated. A critter is the one reward
  // here that writes DURABLE data — a critter_state row cannot be un-granted without a delete — and
  // pickSpecies is a ~33% variable-ratio roll with no daily cap, so an unfiltered moisture_check
  // made "I checked the soil" a farmable collectible loop: exactly what the partition exists to
  // prevent, and strictly worse than the xp it already correctly withholds.
  //
  // This is the CHOKEPOINT (same role as the archived-planting gate below), but it is deliberately
  // NOT the only control: both call sites gate before calling, because `eventType` is optional here
  // and isRewardedEventType(undefined) is TRUE. That fail-open is intentional — a caller that omits
  // eventType keeps awarding rather than silently killing all critters — but it means the chokepoint
  // alone cannot be trusted. critter-nonreward.test.js pins BOTH call sites to keep passing it.
  if (!isRewardedEventType(eventType)) return null
  if (!plantId) return null  // MVP plant-only scope (§1.1)
  if (!userId || !eventId) return null
  // V3-ARCHIVE-001 (Decision 6): logging on an archived planting is allowed, but the REWARD is
  // suppressed (a critter popping on a put-away plant is incongruous). Single chokepoint covers
  // both the batch (one-shot) and single-POST award paths. Non-fatal: a lookup failure fails OPEN
  // (awards) rather than dropping a legit reward. In unit tests the mock sql returns [] -> not archived.
  try {
    const arch = await sql`SELECT archived_at FROM public.garden_node WHERE id = ${plantId}`
    if (arch[0]?.archived_at) return null
  } catch (archErr) {
    console.warn('archived-state check failed (non-fatal, awarding):', archErr?.message ?? String(archErr))
  }
  const seed = buildSeed(eventId, eventCreatedAt, householdId ?? userId)
  // Probabilistic gate (Dave directive 2026-05-30): pickSpecies may return null = "no critter
  // this event." Variable-ratio reward schedule — ~33% baseline chance, per-species variability
  // already baked in via SPECIES_POOL.base_probability + opts.speciesMultipliers.
  const speciesId = pickSpecies(seed, speciesPrefs, { speciesMultipliers })
  if (speciesId == null) {
    // Not awarded — by design. Deterministic from seed (same event always rolls the same way).
    return null
  }
  const copyVariantId = pickCopyVariant(seed, 10)
  const now = new Date()
  const quietStart = prefs?.quiet_hours_start ?? null
  const quietEnd = prefs?.quiet_hours_end ?? null
  const dotVisibleAfter = computeDotVisibleAfter(now, quietStart, quietEnd, tzOffsetMin)
  const meta = {
    deterministic_seed: seed,
    copy_variant_id: copyVariantId,
  }
  try {
    const rows = await sql`
      INSERT INTO public.critter_state
        (created_by, species_id, target_kind, target_id, plant_id,
         source_event_id, dot_visible_after, meta)
      VALUES
        (${userId}, ${speciesId}, 'plant', ${plantId}, ${plantId},
         ${eventId}, ${dotVisibleAfter}::timestamptz, ${JSON.stringify(meta)}::jsonb)
      ON CONFLICT (source_event_id) WHERE deleted_at IS NULL DO NOTHING
      RETURNING id, species_id, target_id, plant_id, earned_at, dot_visible_after
    `
    const awarded = rows[0] ?? null
    // Genuine new award only (idempotent re-hit -> rows empty -> awarded null -> no double-count).
    if (awarded) await incrementSightingTally(sql)
    return awarded
  } catch (err) {
    // Per spec §3.10: log telemetry, defer to server-driven backfill on next garden-view open.
    console.warn('awardCritterServer failed:', err?.code ?? '', err?.message ?? String(err))
    return null
  }
}

// awardCrittersForBatch — fire awardCritterServer for an array of inserted events.
// Single prefs + speciesPrefs fetch is reused across all events in the batch (one SQL call
// regardless of batch size). All awards are sequential within the same Lambda; the events
// Lambda runs them inside its existing user-scope so this is safe.
export async function awardCrittersForBatch({
  sql,
  userId,
  events,                    // [{ id, plant_id, created_at, metadata? }, ...]
  householdId = null,
  tzOffsetMin = 0,
  speciesMultipliers = {},
  skipAward = false,
  eventType = undefined,     // the batch's single event_type (a batch is homogeneous)
} = {}) {
  if (skipAward) return []
  if (!Array.isArray(events) || events.length === 0) return []
  // BUG-CRITTERNONREWARD-001 — mirror of the single-POST gate. moisture_check is in
  // BATCH_EXCLUDED_TYPES today, so a batch cannot currently CREATE one and this gate is
  // defence-in-depth rather than a live fix; it is here so that lifting that exclusion later
  // cannot silently re-open the hole through the path nobody re-checks.
  //
  // Filtering happens BEFORE the chosen-event selection, not after, and per-event rather than
  // only on the batch-level `eventType`: selection takes the lowest sorted id, so gating after
  // it would let one non-reward row in a mixed batch suppress the whole batch's legitimate award.
  if (!isRewardedEventType(eventType)) return []
  const eligible = events.filter(e => e && e.id && e.plant_id && isRewardedEventType(e.event_type))
  if (eligible.length === 0) return []
  // SINGLE roll per batch (Dave directive 2026-05-30: "one logging action = one shot at the
  // reward"). Per V100 §7 burst rule + project CLAUDE.md Reward UX Rule. Deterministic
  // event selection by sorted id so retries pick the same event (UNIQUE INDEX idempotency
  // on critter_state.source_event_id makes this safe even on retry).
  const sortedEligible = [...eligible].sort((a, b) => a.id.localeCompare(b.id))
  const chosenEvent = sortedEligible[0]
  // If the batch carried _skip_critter_award on the chosen event (smoke / admin), skip.
  if (chosenEvent.metadata && chosenEvent.metadata._skip_critter_award === true) return []
  // One prefs fetch for the (single) award attempt.
  let prefs = null
  let speciesPrefs = {}
  try {
    prefs = await readUserPrefs(sql, userId)
    speciesPrefs = await readSpeciesPrefs(sql, userId)
  } catch (err) {
    console.warn('awardCrittersForBatch prefs fetch failed (using defaults):', err?.message ?? String(err))
  }
  // pickSpecies decides probabilistically — may return null = no critter for this batch.
  const row = await awardCritterServer({
    sql,
    userId,
    eventId: chosenEvent.id,
    plantId: chosenEvent.plant_id,
    eventCreatedAt: chosenEvent.created_at ?? null,
    householdId,
    tzOffsetMin,
    prefs,
    speciesPrefs,
    speciesMultipliers,
    eventType: eventType ?? chosenEvent.event_type,
  })
  return row ? [row] : []
}
