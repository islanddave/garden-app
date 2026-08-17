// BUG-ENTITYMEMSTALE-001 — the plant-keyed care cache, and the repoint that owes it a rebuild.
//
// entity_memory's last_*_at columns are a RECENCY CACHE over event_log. Every forward writer
// (events POST single, events POST batch, both status-change writers) advances them with
// GREATEST(...), which is correct precisely because an INSERT can only ever move truth forward.
//
// A REPOINT is the one mutation that breaks that assumption. `UPDATE event_log SET plant_id = W`
// moves an existing history onto W without inserting anything, so W's truth jumps to the union of
// two event sets while its cache still describes only its own. GREATEST never runs, nothing is
// behind at the row level, and the drift is invisible to every forward path.
//
// merge.js shipped with the repoint and a comment reading "the inference job recomputes the
// winner's". No such job exists — grep entity_memory across lambda/daily-plan/,
// lambda/daily-plan-read/ and lambda/xp-reconcile/ and the answer is zero hits; the nightly engine
// owns next_water_at only, never the recency columns. So the winner's cache was never rebuilt by
// anything, and the 2026-08-14 merge run put five winners permanently BEHIND their own event log
// (Cilantro, Ghost, French Tarragon, Serranos, Habanero — the exact set
// migrations/v4-cachefwdgap-001/gates.yml:post_no_cache_behind_event_log reports).
//
// WHY A MODULE AND NOT AN Nth CALL SITE. The repoint statement and the rebuild it owes are exported
// as ONE pair from ONE function. lambda/plant-memory-repoint-guard.test.js then bans the raw
// `UPDATE event_log ... SET plant_id` string everywhere else under lambda/, so a future repointer
// cannot write the statement by hand — it has to come here, and it cannot arrive here without the
// recompute in the same returned object. That is the enforcement, not a convention.

// The seven recency columns, in the order the canonical rebuild writes them. Frozen so the parity
// test can compare against lambda/events/index.js rather than restating the list.
export const PLANT_MEMORY_COLUMNS = Object.freeze([
  'last_event_at', 'last_watered_at', 'last_fertilized_at',
  'last_pruned_at', 'last_observed_at', 'last_harvested_at', 'last_issue_at',
])

// ONE definition of truth, not a second one. This is the plant-keyed rebuild from
// lambda/events/index.js (the PUT's newPlantId arm), transcribed column-for-column and
// predicate-for-predicate: same event_type mapping ('watering'/'rain' -> watered,
// 'harvest'/'first_harvest' -> harvested, flagged_as_issue -> issue), same deleted_at IS NULL
// survivorship, same upsert shape. The parity case in lambda/plant-memory-repoint-guard.test.js
// fails the build if the two drift apart.
//
// Deliberately an UPSERT, not an UPDATE: it also HEALS a planting that has events but no cache row.
// Deliberately absolute (EXCLUDED), not GREATEST: a rebuild has to be able to move a column DOWN,
// which is what makes it correct after the merge's drop-set archive removes events as well.
// next_water_at is absent on purpose — the plant-keyed arm has never carried it (the daily-plan
// engine owns "due"), and every other plant-keyed writer in the codebase omits it identically.
export function buildPlantMemoryRecompute(sql, plantId) {
  return sql`
    INSERT INTO entity_memory
      (plant_id, last_event_at, last_watered_at, last_fertilized_at,
       last_pruned_at, last_observed_at, last_harvested_at, last_issue_at)
    SELECT ${plantId}::uuid,
      (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${plantId} AND e.deleted_at IS NULL),
      (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${plantId} AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL),
      (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${plantId} AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL),
      (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${plantId} AND e.event_type = 'pruning' AND e.deleted_at IS NULL),
      (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${plantId} AND e.event_type = 'observation' AND e.deleted_at IS NULL),
      (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${plantId} AND e.event_type IN ('harvest','first_harvest') AND e.deleted_at IS NULL),
      (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${plantId} AND e.flagged_as_issue = true AND e.deleted_at IS NULL)
    ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL DO UPDATE SET
      last_event_at      = EXCLUDED.last_event_at,
      last_watered_at    = EXCLUDED.last_watered_at,
      last_fertilized_at = EXCLUDED.last_fertilized_at,
      last_pruned_at     = EXCLUDED.last_pruned_at,
      last_observed_at   = EXCLUDED.last_observed_at,
      last_harvested_at  = EXCLUDED.last_harvested_at,
      last_issue_at      = EXCLUDED.last_issue_at,
      updated_at = NOW()
  `
}

// The repoint and the rebuild it owes, together. Callers MUST push both into the same transaction.
//
// PLACEMENT IS PART OF THE CONTRACT: `recompute` reads the SURVIVING event set, so it has to sit
// after every statement in that transaction that can still change which of toPlantId's events
// survive — in merge.js that means after archive_events_subset drops the batch-duplicate collapse
// set. Running it earlier would leave the cache AHEAD of truth, trading this bug for its sibling
// (v4-carecacheundo's post_no_cache_ahead_of_event_log). Hence "last statement before the audit
// row", asserted by the ordering test rather than left to the next reader's judgement.
//
// Only the plant-keyed arm is rebuilt, and that is not an omission: a repoint rewrites plant_id and
// leaves event_log.project_id untouched, so no project's surviving event set changes and no
// project-keyed cache row can have drifted.
export function buildPlantEventRepoint(sql, { fromPlantIds, toPlantId }) {
  return Object.freeze({
    repoint: sql`UPDATE event_log SET plant_id = ${toPlantId} WHERE plant_id = ANY(${fromPlantIds})`,
    recompute: buildPlantMemoryRecompute(sql, toPlantId),
  })
}
