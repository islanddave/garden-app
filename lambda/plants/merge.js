// V4-PLANTMERGE-001 — planting merge core.
//
// Combines N sibling plantings into one surviving row: repoints every child surface onto the
// winner, collapses batch fan-out duplicates, reconciles the winner's own scalars, and soft-deletes
// the losers — with a full pre-state snapshot so the whole thing can be replayed backwards.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT MODELLED ON reparentCore
//
// reparentCore (lambda/projects/index.js) is one CTE on one table; its atomicity is free because
// "a single neon request = one txn". This operation touches 13 surfaces and soft-deletes hundreds
// of event rows, so it CANNOT inherit that property. Three concrete differences:
//
//   1. Transaction boundary is explicit — every write goes through ONE sql.transaction([...]).
//      The serverless client issues one request per tagged call, so a sequence of awaits would be
//      a sequence of transactions, i.e. a partially-applied merge on any mid-flight error.
//   2. The concurrency guard is SET-level, not row-level. A single-row `version` check cannot
//      protect a set operation: another writer can add an event to a loser between the caller's
//      read and the cutover and it would be swept into the winner with no row-level conflict.
//      We fingerprint (rows, max(updated_at)) per surface and re-assert it inside the operation.
//   3. The snapshot is a full pre-state payload, not a five-field jsonb (see merge_event DDL).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DEDUP KEY IS GROUP-SCOPED — THE ONE THING NOT TO GET WRONG
//
// `metadata.batch_id` is a GARDEN-WIDE bulk-action marker, not a sibling fan-out marker. Measured
// on prod: 368 batches over 11,960 events, ~32 plants each; the largest single batch spans 157
// plants across 10 merge groups, and 137 batches include plants in NO merge group. A key of
// (event_type, batch_id) applied globally would delete events on plantings that are not being
// merged at all. Every statement below is constrained to the group's plant ids.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IDENTIFIERS ARE LITERAL, ALWAYS
//
// @neondatabase/serverless 0.10.x has NO sql.unsafe and NO sql.query (see lambda/tags/index.js).
// Every table and column name below is written literally in-template. SURFACES is the declarative
// policy spec; the literal statements are the implementation; merge.test.js asserts they agree, so
// a surface added to the spec without an implementation fails the build rather than silently
// no-op'ing at runtime.

export const SNAPSHOT_VERSION = 1

// Every surface holding a reference to a planting, with its disposition.
// DERIVED, NOT REMEMBERED: scripts/merge-surface-inventory.py regenerates this from pg_constraint
// plus every plant-id-bearing column, and FAILS if prod grows a surface absent from this map.
//
// `holds` is not uniform and conflating it corrupts an id space: favorites/critter_state store
// plants.id, while slug_alias.entity_id and evidence.entity_id store entity.id.
export const SURFACES = Object.freeze([
  // ── repoint ───────────────────────────────────────────────────────────────────────────────
  { table: 'event_log',               column: 'plant_id',       action: 'repoint' },
  { table: 'photos',                  column: 'plant_id',       action: 'repoint' },
  { table: 'preservation_log',        column: 'plant_id',       action: 'repoint' },
  { table: 'critter_state',           column: 'plant_id',       action: 'repoint' },
  { table: 'critter_state',           column: 'target_id',      action: 'repoint' },
  { table: 'evidence',                column: 'garden_node_id', action: 'repoint' },
  { table: 'findings',                column: 'garden_node_id', action: 'repoint', conflict: 'skip' },
  { table: 'treatment_association',   column: 'target_id',      action: 'repoint' },
  { table: 'seen_event',              column: 'leaf_id',        action: 'repoint' },
  { table: 'favorites',               column: 'entity_id',      action: 'repoint', conflict: 'skip' },
  { table: 'watch_impression',        column: 'plant_id',       action: 'repoint', conflict: 'skip' },
  { table: 'harvest_watch_dismissal', column: 'plant_id',       action: 'repoint', conflict: 'skip' },

  // ── supersede ─────────────────────────────────────────────────────────────────────────────
  // uq_plant_anchor_derivation_live UNIQUE(plant_id) WHERE superseded_at IS NULL. Two of the
  // approved groups already hold 2 live rows across their siblings, so a repoint is a certain 23505.
  { table: 'plant_anchor_derivation', column: 'plant_id',       action: 'supersede' },

  // ── delete ────────────────────────────────────────────────────────────────────────────────
  // entity_memory is 1-row-per-plant (entity_memory_plant_id_key) and its columns are scalar
  // timestamps/smallints/jsonb — "concatenating" them is type-invalid. It has NO deleted_at, so
  // leaving the loser's row alive strands a live next_water_at on an invisible planting.
  // Deleted here; the inference job recomputes the winner's.
  { table: 'entity_memory',           column: 'plant_id',       action: 'delete' },

  // ── leave — touching these destroys what they exist to record ──────────────────────────────
  // 211 non-null succession_group_id values garden-wide are ALL self-references (0 cross-refs);
  // repointing splices a soft-deleted planting into the winner's succession group.
  { table: 'plants',              column: 'succession_group_id',   action: 'leave' },
  // Exactly one live parent link exists garden-wide, a clone pair on the never-merge list.
  // Repointing rewrites a never-merged clone's lineage — the precise thing that rule protects.
  { table: 'plants',              column: 'parent_plant_id',       action: 'leave' },
  // 1:1 with the planting and retired by plants_entity_softdel when the loser is soft-deleted.
  // Repointing violates entity_planting_uniq on every group.
  { table: 'entity',              column: 'planting_ref_id',       action: 'leave' },
  // Historical audit rows record where something WAS; rewriting them falsifies history. The archive
  // tables are read by v4-archrestore-001's routines, so a repoint would let a later restore
  // re-materialise a row onto a soft-deleted loser.
  { table: 'proj_rescope_events', column: 'plant_id',              action: 'leave' },
  { table: 'proj_rescope_events', column: 'resulting_planting_id', action: 'leave' },
  { table: 'reparent_event',      column: 'subject_id',            action: 'leave' },
  { table: 'event_log_archive',   column: 'plant_id',              action: 'leave' },
  { table: 'event_log_archive',   column: 'archived_plant_id',     action: 'leave' },
  { table: 'harvest_log_archive', column: 'archived_plant_id',     action: 'leave' },
  { table: 'photo_detach_archive',column: 'archived_plant_id',     action: 'leave' },
  // DIFFERENT ID SPACE — these look plant-shaped to the inventory's name matcher but hold
  // plant_varieties.id, not plants.id (verified: entity_tag 1016/1016 rows join plant_varieties,
  // entity_type='cultivar'; slug_redirects 5/5 join plant_varieties, target_entity_type='variety';
  // NEITHER joins plants or entity at all). Repointing either would write a planting id into a
  // cultivar column — the exact id-space corruption that classifying every surface exists to catch.
  { table: 'entity_tag',          column: 'entity_id',             action: 'leave' },
  { table: 'slug_redirects',      column: 'target_entity_id',      action: 'leave' },
])

export const REPOINT_SURFACES   = SURFACES.filter((s) => s.action === 'repoint')
export const FINGERPRINT_TABLES = ['event_log', 'photos', 'harvest_log', 'plants']

// Reconciled to the LATEST cohort value, never the winner's. Peppers, tomatoes and kohlrabi resolve
// DTM on a `from-transplant` basis, so taking the winner's anchor can move a late cohort's harvest
// window weeks earlier and turn a straddling-frost verdict into a false all-clear. Latest keeps the
// surviving window conservative.
export const PHENOLOGY_COLUMNS = ['sown_at', 'germinated_at', 'transplanted_at', 'planted_out_at']

// Columns plan §4.1 flagged as "still needing an explicit rule" and never got one. Rather than let
// them fall to winner-takes-all, mergeCore REFUSES (422) when live siblings disagree and no override
// is supplied. container_type/container_size are the sharp end — they feed vesselProfile and thus the
// water verdict — but the others carry identity a merge would silently discard.
// featured_photo_id and notes are deliberately NOT guarded. Both diverge on almost every group, so
// guarding them would bury the vessel and cultivar decisions that actually change behaviour under a
// pile of thumbnail prompts — and neither loses information: the losers' photos all repoint to the
// winner, so the "discarded" photo is still on the merged planting and is one tap to feature.
export const DIVERGENCE_GUARDED = Object.freeze([
  'container_type', 'container_size', 'location_id', 'variety_id', 'archived_at',
])

// `status` is the sole carrier of stage (qty_lost/loss_cause are near-universally unset), so a
// winner-takes-all status silently regresses a fruiting planting to vegetative.
// `harvested` ranks BELOW `fruiting` deliberately. For the indeterminate crops this garden actually
// grows (peppers, tomatoes), `harvested` records that fruit was picked — it is a milestone, not an
// end state. A sibling still `fruiting` means the merged row is still producing, so ranking
// `harvested` higher resolved group 6 (Chili Red) to `harvested` and told the user a live plant was
// done. That is the exact "still-producing -> harvested" regression plan §4.1 exists to prevent;
// the rank table contradicted the rule it was implementing. Measured on a branch rehearsal
// 2026-08-14 before the swap. Ledger V4-MERGESTATUS-001.
const STATUS_RANK = Object.freeze({
  seed: 0, sown: 1, germinated: 2, seedling: 3, rooting: 3, potting_up: 4,
  transplanted: 5, vegetative: 6, flowering: 7, fruit_set: 8, harvested: 9,
  fruiting: 10, dormant: 11, ended: 12, failed: 13, dead: 13, archived: 14,
})
const TERMINAL_STATUS = new Set(['ended', 'failed', 'dead', 'archived'])

/** Most-advanced live stage across siblings. A terminal state never wins over a live one — a merged
 *  row with any living cohort is alive. */
export function resolveStatus(statuses) {
  const present = statuses.filter((s) => s != null && s !== '')
  if (!present.length) return null
  const live = present.filter((s) => !TERMINAL_STATUS.has(s))
  const pool = live.length ? live : present
  return pool.reduce((best, s) => ((STATUS_RANK[s] ?? -1) > (STATUS_RANK[best] ?? -1) ? s : best))
}

/** Latest non-null date across siblings, or null when no sibling has one — a suppressed window
 *  stays suppressed rather than being invented from a sibling that has no anchor either. */
export function resolvePhenology(values) {
  const present = values.filter((v) => v != null)
  if (!present.length) return null
  return present.reduce((a, b) => (new Date(a) >= new Date(b) ? a : b))
}

/** Sum across siblings, treating null as absent but preserving all-null as null. */
export function sumQty(values) {
  const present = values.filter((v) => v != null)
  if (!present.length) return null
  return present.reduce((a, b) => Number(a) + Number(b), 0)
}

/**
 * Build the drop set for one merge group. ONE collapse, group-scoped:
 *
 *  (a) BATCH FAN-OUT — rows sharing (event_type, metadata->>'batch_id') are one real action recorded
 *      once per sibling. Keep the earliest, drop the rest.
 *
 * THERE IS DELIBERATELY NO SAME-DAY WATER COLLAPSE. An earlier draft had one, on the premise that
 * lambda/daily-plan/ledger.js folds water credit PER EVENT ROW and would over-credit a merged plant
 * into a wrong "not thirsty" verdict. That premise was measured against prod and REFUTED:
 *
 *   * The ledger's per-row accumulating branches are `light` (ledger.js:265) and banked `deep`
 *     (:261). Prod holds ZERO rows of either — 10,114 water/rain rows are 9,711 null + 403 'normal',
 *     and both map to the `normal` branch, which ASSIGNS (D = 0 / containerResetWi) rather than
 *     accumulating. The one exception: `normal` on a long-dry IN-GROUND profile (:267-269) does
 *     decrement per row — bounded by inGroundCapWi and self-limiting once D falls under longDryWi.
 *   * Decisively: 25.24% of ALL plant-day water buckets garden-wide already hold multiple rows,
 *     1,996 of them on the 278 plantings in no merge group. The collapse imposed on 34 plants an
 *     invariant the other 278 do not have. If multi-row same-day water broke the ledger, it would
 *     already be breaking it everywhere.
 *   * And it was wrong on its own terms: it bucketed by UTC while the ledger buckets by
 *     America/New_York, so 24 of 37 dropped rows sat on an ET day NO SURVIVOR OCCUPIED (a 21:37
 *     watering folded into the next afternoon's 14:11); it had no cross-sibling scoping, so 19 of 37
 *     drops were already on the same planting pre-merge, 9 of them the winner deleting its own
 *     history; and it always dropped the LATER row, moving the last-water reset backwards.
 *
 * Removing it costs ~200-250 rows across the full run, ~130-170 of them genuinely distinct history.
 * With (a) alone the drop set matches plan §1 exactly. Do not re-add it without first re-measuring
 * water_depth on prod — the whole argument turns on that distribution.
 *
 * Survivor selection is deterministic (created_at, id) so a branch rehearsal and the prod run pick
 * the same rows and can be diffed — without that the run is unverifiable.
 */
export function planDedup(events) {
  const ordered = [...events].sort((a, b) => {
    const t = new Date(a.created_at) - new Date(b.created_at)
    return t !== 0 ? t : String(a.id).localeCompare(String(b.id))
  })

  const seenBatch = new Map()
  const droppedBatch = []
  const survivors = []
  for (const e of ordered) {
    const batchId = e.metadata?.batch_id ?? null
    if (batchId == null) { survivors.push(e); continue }
    const key = `${e.event_type} ${batchId}`
    if (seenBatch.has(key)) droppedBatch.push(e.id)
    else { seenBatch.set(key, e); survivors.push(e) }
  }

  return {
    dropped: [...droppedBatch],
    droppedBatch,
    kept: survivors.map((e) => e.id),
  }
}

/**
 * Merge N loser plantings into a winner.
 *
 * @param sql                neon client; must expose .transaction([...]) for the atomic cutover
 * @param opts.winnerId      surviving planting id
 * @param opts.loserIds      plantings to fold in and soft-delete
 * @param opts.opId          idempotency key; a replay returns the prior outcome
 * @param opts.fingerprint   caller's pre-read {table:{rows,max_updated_at}}; re-asserted here
 * @param opts.overrides     explicit winner scalars; beat the reconciliation rules
 * @param opts.dryRun        compute and return the plan without writing
 */
export async function mergeCore(sql, {
  winnerId, loserIds, opId, fingerprint = null, overrides = {},
  userId, householdIds, groupLabel = null, dryRun = false,
}) {
  if (!winnerId) return { status: 400, body: { error: 'winnerId is required' } }
  if (!Array.isArray(loserIds) || !loserIds.length) {
    return { status: 400, body: { error: 'loserIds must be a non-empty array' } }
  }
  if (loserIds.includes(winnerId)) {
    return { status: 400, body: { error: 'A planting cannot be merged into itself' } }
  }
  if (new Set(loserIds).size !== loserIds.length) {
    return { status: 400, body: { error: 'loserIds contains duplicates' } }
  }
  if (!opId) return { status: 400, body: { error: 'opId is required' } }

  // 1. Idempotent replay.
  const prior = await sql`
    SELECT winner_plant_id, loser_plant_ids, events_dropped, rows_repointed, merged_at
    FROM merge_event WHERE op_id = ${opId}
  `
  if (prior.length) return { status: 200, body: replayBody(prior[0]) }

  // 2. Load the whole group, household-scoped and live, in one read — so a loser that is already
  //    deleted, foreign, or absent fails here rather than half-way through the cutover.
  //
  //    THE PREDICATE IS THE CANONICAL TWO-ARM ONE, byte-for-byte the form that gates
  //    GET/PUT/PATCH-archive/DELETE/seen in index.js and loadOwnedPlantingRef in authz-parents.js.
  //    It is NOT `created_by = ANY(householdIds)` alone. That is a correction, not a widening — the
  //    bare form was WRONG IN BOTH DIRECTIONS:
  //      * it 404'd rows whose CONTAINER the household owns but whose own created_by is a synthetic
  //        import identity. 24 such rows existed in prod from rescue-intake-longriver-20260712; they
  //        are visible, editable and deletable in the app, and merge alone refused them.
  //      * it ACCEPTED a planting the caller created inside ANOTHER household's container — a row
  //        they can neither read nor delete — and would have repointed its events onto their own
  //        winner and soft-deleted it. The `project_id IS NULL` conjunct closes that, and it is
  //        load-bearing exactly as index.js:588 and authz-parents.js:66 say. Do not simplify it away.
  //    Bar chosen deliberately: what you may soft-delete one row at a time via DELETE /plants/{id}
  //    (index.js:853-877, same predicate) is what you may soft-delete as a merge loser. A stricter
  //    bar here buys nothing — those rows are reachable by DELETE regardless — and costs false 404s.
  //    `pp.deleted_at IS NULL` is carried per the V4-SOFTDEL-001 F4 container-deleted gate, so merge
  //    cannot operate on a planting stranded under a soft-deleted container.
  const groupIds = [winnerId, ...loserIds]
  const plants = await sql`
    SELECT p.id, p.name, p.status, p.quantity, p.qty_initial, p.qty_current, p.qty_harvested,
           p.qty_lost, p.loss_cause, p.sown_at, p.germinated_at, p.transplanted_at, p.planted_out_at,
           p.sown_at_approx, p.germinated_at_approx, p.transplanted_at_approx, p.planted_out_at_approx,
           p.variety_id, p.project_id, p.location_id, p.notes, p.featured_photo_id, p.container_type,
           p.container_size, p.archived_at, p.version, p.workspace_id, p.created_by
    FROM plants p
    LEFT JOIN plant_projects pp ON pp.id = p.project_id
    WHERE p.id = ANY(${groupIds}) AND p.deleted_at IS NULL
      AND ( (pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL)
            OR (p.project_id IS NULL AND p.created_by = ANY(${householdIds})) )
  `
  if (plants.length !== groupIds.length) {
    const found = new Set(plants.map((p) => p.id))
    return { status: 404, body: {
      error: 'One or more plantings not found in your garden',
      missing: groupIds.filter((id) => !found.has(id)),
    } }
  }
  const winner = plants.find((p) => p.id === winnerId)
  const losers = plants.filter((p) => p.id !== winnerId)

  // 3. Set-level concurrency guard (see header note 2).
  const liveFp = await readFingerprint(sql, groupIds)
  if (fingerprint) {
    const drift = diffFingerprint(fingerprint, liveFp)
    if (drift.length) {
      return { status: 409, body: {
        error: 'The group changed since it was read — re-read and retry', drift, current: liveFp,
      } }
    }
  }

  // 3b. REFUSE on unreconciled divergence rather than silently defaulting to the winner's value.
  //     plan §4.1 listed these as "still needing an explicit rule" and no rule was ever written, so
  //     they fell to winner-takes-all. For the vessel columns that is a silent WRONG WATER VERDICT:
  //     container_type/container_size feed vesselProfile (daily-plan/ledger.js:109-128) via
  //     engine.js:426, and group 3 Habanero spans a whiskey_barrel 15gal, a fabric_bag 5gal and an
  //     unsized plastic_pot — opposite ends of VESSEL_CLASS_FACTOR, with fabric_bag carrying its own
  //     heat ramp. Before a merge Dave gets three verdicts; after, one, chosen by import order.
  //     Refusing converts that silent default into a required human decision, which is what §4 asked
  //     for. Nothing here is guessable from the data: only Dave knows which pot the plant is in.
  const divergences = []
  for (const col of DIVERGENCE_GUARDED) {
    if (col in overrides) continue
    const distinct = [...new Set(plants.map((p) => p[col]).filter((v) => v != null).map(String))]
    if (distinct.length > 1) {
      divergences.push({
        column: col,
        values: plants
          .filter((p) => p[col] != null)
          .map((p) => ({ plant_id: p.id, name: p.name, value: p[col] })),
      })
    }
  }
  if (divergences.length) {
    return { status: 422, body: {
      error: 'Siblings disagree on columns with no reconciliation rule — supply overrides to proceed',
      divergences,
      hint: `Pass overrides.{${divergences.map((d) => d.column).join(',')}} with the value the merged planting should carry.`,
    } }
  }

  // 4. Dedup plan over the group's live events.
  const events = await sql`
    SELECT id, plant_id, event_type, event_date, created_at, metadata
    FROM event_log
    WHERE plant_id = ANY(${groupIds}) AND deleted_at IS NULL
    ORDER BY created_at, id
  `
  const dedup = planDedup(events)

  // 5. Reconcile the winner's scalars. Overrides beat the rules — quantity in particular is a human
  //    judgment (a group's real surviving count is not always the sum). Anything unstated falls to
  //    the documented rule, never to winner-takes-all.
  const resolved = {
    name:          overrides.name          ?? winner.name,
    status:        overrides.status        ?? resolveStatus(plants.map((p) => p.status)),
    quantity:      overrides.quantity      ?? sumQty(plants.map((p) => p.quantity)),
    qty_initial:   overrides.qty_initial   ?? sumQty(plants.map((p) => p.qty_initial)),
    qty_current:   overrides.qty_current   ?? sumQty(plants.map((p) => p.qty_current)),
    qty_harvested: overrides.qty_harvested ?? sumQty(plants.map((p) => p.qty_harvested)),
    qty_lost:      overrides.qty_lost      ?? sumQty(plants.map((p) => p.qty_lost)),
    loss_cause:    overrides.loss_cause    ?? winner.loss_cause
                     ?? losers.find((l) => l.loss_cause)?.loss_cause ?? null,
  }
  for (const col of PHENOLOGY_COLUMNS) {
    resolved[col] = overrides[col] ?? resolvePhenology(plants.map((p) => p[col]))
  }
  // The DIVERGENCE_GUARDED columns must be resolved and WRITTEN too. Accepting an override and then
  // not applying it is worse than not accepting one: the 422 clears, the caller believes the ruling
  // landed, and the winner silently keeps its own value — precisely the silent default the guard
  // exists to prevent. Caught on a branch rehearsal where g12 Cilantro's archived_at override was
  // taken and discarded. If no override is supplied the group is uniform by construction (a
  // divergence would have 422'd above), so the winner's value is the only legal outcome — except
  // where the winner's own value is NULL and a loser carries the group's single value, which is the
  // `?? first non-null` arm.
  for (const col of DIVERGENCE_GUARDED) {
    resolved[col] = overrides[col]
      ?? winner[col]
      ?? plants.map((p) => p[col]).find((v) => v != null)
      ?? null
  }

  if (dryRun) {
    return { status: 200, body: {
      dry_run: true, winner_id: winnerId, loser_ids: loserIds,
      events_total: events.length,
      events_dropped: dedup.dropped.length,
      dropped_batch: dedup.droppedBatch.length,
      events_kept: dedup.kept.length,
      resolved, fingerprint: liveFp,
    } }
  }

  // 6. Snapshot every row about to move, BEFORE moving it, so a restore can put each one back
  //    exactly where it came from. Literal per surface (no dynamic identifiers available).
  const repoints = []
  const push = (table, column, rows) => {
    for (const r of rows) repoints.push({ table, column, row_id: r.id, old_value: r.old_value })
  }
  push('event_log', 'plant_id',
    await sql`SELECT id, plant_id AS old_value FROM event_log WHERE plant_id = ANY(${loserIds})`)
  push('photos', 'plant_id',
    await sql`SELECT id, plant_id AS old_value FROM photos WHERE plant_id = ANY(${loserIds})`)
  push('preservation_log', 'plant_id',
    await sql`SELECT id, plant_id AS old_value FROM preservation_log WHERE plant_id = ANY(${loserIds})`)
  push('critter_state', 'plant_id',
    await sql`SELECT id, plant_id AS old_value FROM critter_state WHERE plant_id = ANY(${loserIds})`)
  push('critter_state', 'target_id',
    await sql`SELECT id, target_id AS old_value FROM critter_state
              WHERE target_id = ANY(${loserIds}) AND target_kind = 'plant'`)
  push('evidence', 'garden_node_id',
    await sql`SELECT id, garden_node_id AS old_value FROM evidence WHERE garden_node_id = ANY(${loserIds})`)
  push('findings', 'garden_node_id',
    await sql`SELECT id, garden_node_id AS old_value FROM findings WHERE garden_node_id = ANY(${loserIds})`)
  push('treatment_association', 'target_id',
    await sql`SELECT id, target_id AS old_value FROM treatment_association
              WHERE target_id = ANY(${loserIds}) AND target = 'leaf'::node_class`)
  push('seen_event', 'leaf_id',
    await sql`SELECT id, leaf_id AS old_value FROM seen_event WHERE leaf_id = ANY(${loserIds})`)
  push('favorites', 'entity_id',
    await sql`SELECT id, entity_id AS old_value FROM favorites WHERE entity_id = ANY(${loserIds})`)
  push('watch_impression', 'plant_id',
    await sql`SELECT id, plant_id AS old_value FROM watch_impression WHERE plant_id = ANY(${loserIds})`)
  push('harvest_watch_dismissal', 'plant_id',
    await sql`SELECT id, plant_id AS old_value FROM harvest_watch_dismissal WHERE plant_id = ANY(${loserIds})`)

  const memoryRows  = await sql`SELECT * FROM entity_memory WHERE plant_id = ANY(${loserIds})`
  // V4-ANCHORSUPERSEDE-001: the winner is a supersede target too, not just the losers. The
  // phenology reconciliation below can hand the winner a real sown/transplanted/planted-out date it
  // did not have, which contradicts any derivation it is still holding. `resolved` is computed
  // before the transaction, so whether that happens is known here — and the snapshot has to record
  // the winner's retired row or a restore would put the merge back without it.
  const winnerGainsAnchor = resolved.sown_at != null
    || resolved.transplanted_at != null
    || resolved.planted_out_at != null
  const anchorTargets = winnerGainsAnchor ? [...loserIds, winnerId] : loserIds
  const liveAnchors = await sql`
    SELECT id FROM plant_anchor_derivation WHERE plant_id = ANY(${anchorTargets}) AND superseded_at IS NULL
  `

  const snapshot = {
    schema_version: SNAPSHOT_VERSION,
    winner,
    losers,
    repoints,
    dropped: dedup.dropped,
    dropped_batch: dedup.droppedBatch,
    anchors_superseded: liveAnchors.map((a) => a.id),
    entity_memory_deleted: memoryRows,
    fingerprint: liveFp,
    resolved,
  }

  // 7. THE CUTOVER — one transaction. Ordering: conflict-prune before repoint (so the move cannot
  //    trip a unique index), repoint before the drop (so the drop set is evaluated on the winner),
  //    and soft-delete the losers LAST so plants_entity_softdel retires their entity rows only once
  //    nothing references them.
  //
  //    Conflict-prune rationale: on the four surfaces whose unique index has no deleted_at escape,
  //    a loser row that would collide with an existing winner row is DELETED rather than moved.
  //    All four are derived impression/dismissal/favourite state — a duplicate carries nothing the
  //    winner's own row does not already have — and the snapshot holds the row for restore.
  const stmts = [
    sql`DELETE FROM favorites l
         WHERE l.entity_id = ANY(${loserIds})
           AND EXISTS (SELECT 1 FROM favorites w
                       WHERE w.entity_id = ${winnerId}
                         AND w.user_id = l.user_id AND w.entity_type = l.entity_type)`,
    sql`DELETE FROM watch_impression l
         WHERE l.plant_id = ANY(${loserIds})
           AND EXISTS (SELECT 1 FROM watch_impression w
                       WHERE w.plant_id = ${winnerId}
                         AND w.user_id = l.user_id AND w.shown_on = l.shown_on
                         AND w.region = l.region)`,
    sql`DELETE FROM harvest_watch_dismissal l
         WHERE l.plant_id = ANY(${loserIds}) AND l.undone_at IS NULL
           AND EXISTS (SELECT 1 FROM harvest_watch_dismissal w
                       WHERE w.plant_id = ${winnerId} AND w.undone_at IS NULL
                         AND w.user_id = l.user_id AND w.observed_on = l.observed_on)`,
    sql`DELETE FROM findings l
         WHERE l.garden_node_id = ANY(${loserIds}) AND l.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM findings w
                       WHERE w.garden_node_id = ${winnerId} AND w.deleted_at IS NULL
                         AND w.entity_id IS NOT DISTINCT FROM l.entity_id
                         AND w.finding_type = l.finding_type)`,

    sql`UPDATE event_log        SET plant_id = ${winnerId} WHERE plant_id = ANY(${loserIds})`,
    sql`UPDATE photos           SET plant_id = ${winnerId} WHERE plant_id = ANY(${loserIds})`,
    sql`UPDATE preservation_log SET plant_id = ${winnerId} WHERE plant_id = ANY(${loserIds})`,
    sql`UPDATE critter_state    SET plant_id = ${winnerId} WHERE plant_id = ANY(${loserIds})`,
    sql`UPDATE critter_state    SET target_id = ${winnerId}
         WHERE target_id = ANY(${loserIds}) AND target_kind = 'plant'`,
    sql`UPDATE evidence         SET garden_node_id = ${winnerId} WHERE garden_node_id = ANY(${loserIds})`,
    sql`UPDATE findings         SET garden_node_id = ${winnerId} WHERE garden_node_id = ANY(${loserIds})`,
    sql`UPDATE treatment_association SET target_id = ${winnerId}
         WHERE target_id = ANY(${loserIds}) AND target = 'leaf'::node_class`,
    sql`UPDATE seen_event       SET leaf_id = ${winnerId} WHERE leaf_id = ANY(${loserIds})`,
    sql`UPDATE favorites        SET entity_id = ${winnerId} WHERE entity_id = ANY(${loserIds})`,
    sql`UPDATE watch_impression SET plant_id = ${winnerId} WHERE plant_id = ANY(${loserIds})`,
    sql`UPDATE harvest_watch_dismissal SET plant_id = ${winnerId} WHERE plant_id = ANY(${loserIds})`,

    // Supersede rather than repoint (uq_plant_anchor_derivation_live).
    sql`UPDATE plant_anchor_derivation SET superseded_at = now()
         WHERE plant_id = ANY(${loserIds}) AND superseded_at IS NULL`,
    // Derived state: delete, never merge. The inference job recomputes the winner's.
    sql`DELETE FROM entity_memory WHERE plant_id = ANY(${loserIds})`,
  ]

  // Drop set: archive + soft-delete. The routine refuses any set containing a harvest, photo or
  // calibration sample, so a future dedup-key regression aborts here instead of eating yield data.
  if (dedup.dropped.length) {
    stmts.push(sql`
      SELECT archive_events_subset(${dedup.dropped}::uuid[],
                                   'planting merge — batch-duplicate collapse', ${userId})
    `)
  }

  stmts.push(sql`
    UPDATE plants SET
      name = ${resolved.name},
      status = ${resolved.status},
      quantity = COALESCE(${resolved.quantity}, quantity),
      qty_initial = ${resolved.qty_initial},
      qty_current = ${resolved.qty_current},
      qty_harvested = ${resolved.qty_harvested},
      qty_lost = ${resolved.qty_lost},
      loss_cause = ${resolved.loss_cause},
      sown_at = ${resolved.sown_at},
      germinated_at = ${resolved.germinated_at},
      transplanted_at = ${resolved.transplanted_at},
      planted_out_at = ${resolved.planted_out_at},
      container_type = ${resolved.container_type},
      container_size = ${resolved.container_size},
      location_id = ${resolved.location_id},
      variety_id = ${resolved.variety_id},
      archived_at = ${resolved.archived_at},
      version = version + 1,
      updated_at = now()
    WHERE id = ${winnerId}
  `)

  // V4-ANCHORSUPERSEDE-001 — the winner's own derivation, retired the moment the merge gives it a
  // real date. Placed AFTER the winner UPDATE above so the EXISTS reads the reconciled row inside
  // this transaction, and kept as a predicated statement rather than a JS-side `if` so the same
  // rule the nightly sweep and the plants PUT apply is the one evaluated here.
  // Retire, never delete — the (guess, later truth) pair is the baseline tier's only ground truth.
  stmts.push(sql`
    UPDATE plant_anchor_derivation d
       SET superseded_at = now(),
           superseded_by = 'observed_anchor',
           updated_at    = now()
     WHERE d.plant_id = ${winnerId}
       AND d.superseded_at IS NULL
       AND EXISTS (
             SELECT 1 FROM plants wp
              WHERE wp.id = d.plant_id
                AND (wp.sown_at IS NOT NULL
                     OR wp.transplanted_at IS NOT NULL
                     OR wp.planted_out_at IS NOT NULL))
  `)

  // Losers last — fires plants_entity_softdel, retiring their entity rows.
  stmts.push(sql`
    UPDATE plants SET deleted_at = now(), updated_at = now()
    WHERE id = ANY(${loserIds}) AND deleted_at IS NULL
  `)

  stmts.push(sql`
    INSERT INTO merge_event
      (op_id, winner_plant_id, loser_plant_ids, group_label, snapshot, snapshot_version,
       events_dropped, rows_repointed, merged_by, workspace_id)
    VALUES (${opId}, ${winnerId}, ${loserIds}, ${groupLabel},
            ${JSON.stringify(snapshot)}::jsonb, ${SNAPSHOT_VERSION},
            ${dedup.dropped.length}, ${repoints.length}, ${userId}, ${winner.workspace_id})
    RETURNING id, merged_at
  `)

  try {
    const res = await sql.transaction(stmts)
    const rec = res[res.length - 1]
    return { status: 200, body: {
      id: winnerId,
      merge_event_id: rec?.[0]?.id,
      merged_at: rec?.[0]?.merged_at,
      loser_ids: loserIds,
      events_dropped: dedup.dropped.length,
      dropped_batch: dedup.droppedBatch.length,
      rows_repointed: repoints.length,
      resolved,
    } }
  } catch (err) {
    const msg = err?.message ?? String(err)
    // A concurrent identical op landed first — return its outcome rather than a 500.
    if (/merge_event_op_uniq|duplicate key/i.test(msg)) {
      const r = await sql`
        SELECT winner_plant_id, loser_plant_ids, events_dropped, rows_repointed, merged_at
        FROM merge_event WHERE op_id = ${opId}
      `
      if (r.length) return { status: 200, body: replayBody(r[0]) }
    }
    if (/archive_events_subset/i.test(msg)) {
      return { status: 422, body: { error: 'Refused: the drop set is not chores-only', detail: msg } }
    }
    if (/unique constraint/i.test(msg)) {
      return { status: 409, body: { error: 'Merge collided with existing rows', detail: msg } }
    }
    throw err
  }
}

function replayBody(row) {
  return {
    id: row.winner_plant_id,
    loser_ids: row.loser_plant_ids,
    events_dropped: row.events_dropped,
    rows_repointed: row.rows_repointed,
    merged_at: row.merged_at,
    replayed: true,
  }
}

/** Per-surface (rows, max_updated_at) used as the set-level concurrency guard. */
export async function readFingerprint(sql, groupIds) {
  const [ev]  = await sql`SELECT count(*)::int AS rows, max(updated_at) AS max_updated_at
                          FROM event_log WHERE plant_id = ANY(${groupIds}) AND deleted_at IS NULL`
  const [ph]  = await sql`SELECT count(*)::int AS rows, max(updated_at) AS max_updated_at
                          FROM photos WHERE plant_id = ANY(${groupIds}) AND deleted_at IS NULL`
  const [hv]  = await sql`SELECT count(*)::int AS rows, max(h.updated_at) AS max_updated_at
                          FROM harvest_log h JOIN event_log e ON e.id = h.event_id
                          WHERE e.plant_id = ANY(${groupIds}) AND h.deleted_at IS NULL`
  const [pl]  = await sql`SELECT count(*)::int AS rows, max(updated_at) AS max_updated_at
                          FROM plants WHERE id = ANY(${groupIds}) AND deleted_at IS NULL`
  return { event_log: fp(ev), photos: fp(ph), harvest_log: fp(hv), plants: fp(pl) }
}

const fp = (r) => ({ rows: r.rows, max_updated_at: r.max_updated_at })

export function diffFingerprint(expected, actual) {
  const drift = []
  for (const t of Object.keys(expected)) {
    const e = expected[t]
    const a = actual[t]
    if (!a) { drift.push({ table: t, reason: 'missing' }); continue }
    if (e.rows !== a.rows) {
      drift.push({ table: t, reason: 'rows', expected: e.rows, actual: a.rows })
    }
    const et = e.max_updated_at ? new Date(e.max_updated_at).getTime() : null
    const at = a.max_updated_at ? new Date(a.max_updated_at).getTime() : null
    if (et !== at) {
      drift.push({ table: t, reason: 'max_updated_at', expected: e.max_updated_at, actual: a.max_updated_at })
    }
  }
  return drift
}
