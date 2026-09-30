// V5-INFLIGHTBATCH-001 — the /api/kitchen-batches handlers.
//
// WHY A SIBLING MODULE AND NOT index.js. index.js imports @neondatabase/serverless, @clerk/backend and
// @aws-sdk at module scope, so it cannot be imported by vitest AT ALL — every test against it is a
// text assertion over its source, and a text assertion cannot prove that a household predicate is
// actually bound or that an ORDER BY carries its tiebreak. This file takes `sql` as an argument and
// imports nothing but dependency-free siblings, so the routes below are EXECUTED under `npm test`
// against a mock driver. Same shape as lambda/harvests/watch-route.js and lambda/plants/merge.js.
// index.js keeps the auth/secrets/CORS skeleton and one delegation.
//
// THE VIEW IS THE ONLY READ SURFACE. Nothing here does `SELECT ... FROM kitchen_batch`; every read of
// current state goes through v_kitchen_batch_current. That is what makes "no current-stage cache"
// survivable — one derivation instead of N, so there is nothing to diverge. The base table appears
// only in INSERT and UPDATE.
//
// SHIP ORDERING. Old Lambda + new schema is INERT; new Lambda + old schema is HARD — every route here
// 500s on missing tables. The migration is applied to prod BEFORE this code is promoted, and index.js
// maps 42P01 so that window is diagnosable rather than an opaque "Internal server error".
import { randomUUID } from 'node:crypto';
import { loadOwnedPhoto } from './household.js';
import { ET_TZ, etDay } from './useBy.js';
import {
  KITCHEN_UUID_RE, parseKitchenRoute, parseBatchState, normalizeText,
  validateBatchCreate, validateBatchUpdate, batchUpdatePatch,
  validateStage, validateInputPayload, normalizeInputRows, harvestIdsIn,
  validateClose, outputIdsIn, validateOutputsPayload, outputLogIdsIn,
  KITCHEN_VOIDABLE_KINDS, KITCHEN_LIFECYCLE_KINDS, KITCHEN_STATE_STAGE_KINDS,
} from './kitchenBatch.js';
import {
  validatePutUp, planPutUp, putUpColumns, putUpPlaceIds, putUpInUse, putUpLineBodies, BATCH_CLOSED,
} from './putUp.js';
import { projectRow } from './jarRules.js';
import { inputsForm, lineError, actsOf, phReadAtError, stagePatchError } from './kitchenLines.js';
import {
  addKeyedLines, patchLine, takeOutLine, restoreLine, readLines, publicLine, shuLine, prepareLines,
  lineColumns, drawRefusal, MASS_UNITS, MASS_FACTORS,
} from './lineRoutes.js';
import { lineSearch } from './lineSearch.js';
import { estimateShu, isStale } from './shuEstimate.js';
// B′ release 3 — How it was made → and the planting read (batchBuilderRoutes.js).
import { fromJars, plantingBatches } from './batchBuilderRoutes.js';
import { closeWhenOf } from './batchBuilder.js';
// Put-Up release 4 — a batch names the recipe it follows (household-loaded), and reads it back.
import { loadOwnedRecipe, readRecipeForBatch } from './recipeRoutes.js';

const notFound = { status: 404, body: { error: 'Not found' } };
const notAllowed = { status: 405, body: { error: 'Method not allowed' } };
const bad = (error) => ({ status: 400, body: { error } });
// contract-F §2 common: a key held outside the household is a 409 with no payload.
const keyConflict = { status: 409, body: { error: 'That key is already in use.', code: 'key_conflict' } };
// THE POST-CLOSE WRITE POLICY, in one place (Release F, 06 §3.13; Dave 15:55, "as we go", including
// at and after bottling). "Put it up and finish" is the DEFAULT, so a policy that locked what went in at
// close would lock the record at the exact moment he adds and weighs. F therefore RETIRES the old
// closedForEdits refusal for content: on a closed batch the line POST / PATCH / take-out / restore, the
// stage POST and PATCH, the merge PUT, shu-estimate/save and the jar PATCH are all ACCEPTED, and every
// edit after close is audited and shows "edited". The ONE content write still refused is a NEW put-up
// sitting — 409 batch_closed with the Reopen door (putUp.js BATCH_CLOSED), never a bare 409. Outcome
// changes go through close / reopen as they always did.

// ── ownership loaders ────────────────────────────────────────────────────────────────────────────
// Uniform contract, lifted from index.js: return the row on success, null on ANY failure — absent id,
// malformed id, out-of-household, soft-deleted. Callers answer a null with the SAME generic response
// they would give a malformed id, never "not found" vs "forbidden": that distinction is itself a leak.

// Reads the VIEW, not kitchen_batch, so even the ownership gate has one derivation.
//
// closed_at rides along because the route table below BRANCHES ON IT — since release F for exactly one
// route, a new put-up sitting (see the policy above). started_at rides along for the pH read-time's
// lower bound. suspended_at is loaded and not branched on — no route refuses a paused batch, by design.
async function loadOwnedBatch(sql, batchId, householdIds) {
  if (!KITCHEN_UUID_RE.test(String(batchId))) return null;
  const rows = await sql`
    SELECT id, closed_at, suspended_at, started_at FROM v_kitchen_batch_current
    WHERE id = ${batchId}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// Mirrors index.js's loadStorageLocation. The FK enforces EXISTENCE, not ownership; this is the
// ownership half, and without it a stage row could pin a batch to another household's shelf and leak
// it back through current_storage_location_id.
async function loadOwnedStorageLocation(sql, storageLocationId, householdIds) {
  if (!KITCHEN_UUID_RE.test(String(storageLocationId))) return null;
  const rows = await sql`
    SELECT id, kind FROM storage_location
    WHERE id = ${storageLocationId}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// Anchored on harvest_log.created_by, NOT the project owner: care-rekey-001 made harvest_log.project_id
// nullable, so a project-owner anchor would wrongly reject an owner's own projectless harvest.
// Returns the ids that ARE in the household; the caller compares counts rather than trusting the FK.
async function loadOwnedHarvestLogs(sql, harvestLogIds, householdIds) {
  if (!harvestLogIds.length) return [];
  if (!harvestLogIds.every((v) => KITCHEN_UUID_RE.test(String(v)))) return [];
  const rows = await sql`
    SELECT h.id FROM harvest_log h
    WHERE h.id = ANY(${harvestLogIds}::uuid[])
      AND h.created_by = ANY(${householdIds})
      AND h.deleted_at IS NULL
  `;
  return rows.map((r) => r.id);
}

// start_anchor_id is the one FK-shaped column here with NO database FK — a polymorphic uuid naming
// photos.id or harvest_log.id — so nothing enforces even EXISTENCE, let alone ownership. Left ungated
// it stores another household's row id, which is the storage_location_id class pre-empted: nothing
// dereferences it TODAY, and the day something does ("first recorded from this photo") it becomes a
// read-surface leak with no code change. validateBatchCreate/Update has already narrowed the kind to
// harvest or photo by the time this runs, so the two arms below are exhaustive.
async function gateStartAnchor(sql, body, householdIds) {
  const id = body.start_anchor_id ?? null;
  if (id == null) return null;
  if (normalizeText(body.start_anchor_kind) === 'photo') {
    return (await loadOwnedPhoto(sql, id, householdIds))
      ? null : 'start_anchor_id does not match a photo you can use';
  }
  const owned = await loadOwnedHarvestLogs(sql, [id], householdIds);
  return owned.length ? null : 'start_anchor_id does not match a harvest you can log against';
}

// The one projection. Every route that returns a batch returns exactly the view's row shape — all of
// kitchen_batch plus current_stage_kind / current_stage_label / current_stage_entered_at /
// current_storage_location_id / input_count / output_count.
async function readBatch(sql, batchId, householdIds) {
  const rows = await sql`
    SELECT * FROM v_kitchen_batch_current
    WHERE id = ${batchId}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// ── the route table ──────────────────────────────────────────────────────────────────────────────
// Returns null when rawPath is not one of ours, so index.js falls through to the preservation routes
// untouched. Every other return is a fully-formed { status, body }.
export async function handleKitchenRoute({ sql, rawPath, method, rawBody, query, userId, householdIds }) {
  const route = parseKitchenRoute(rawPath);
  if (!route) return null;
  const q = query ?? {};
  const parseBody = () => JSON.parse(rawBody ?? '{}');

  if (route.kind === 'collection') {
    // B′ release 3: ?plant_id= is the planting read (its own shape; batchBuilderRoutes.js).
    if (method === 'GET' && q.plant_id != null) return plantingBatches(sql, q.plant_id, householdIds);
    if (method === 'GET') return listBatches(sql, q, householdIds);
    if (method === 'POST') return createBatch(sql, parseBody(), userId, householdIds);
    return notAllowed;
  }
  // Release F: a literal, matched before any :id (parseKitchenRoute), household-scoped inside.
  if (route.kind === 'line_search') {
    if (method === 'GET') return lineSearch(sql, q, householdIds);
    return notAllowed;
  }
  // B′ release 3: How it was made → — a literal, household-scoped inside; answers in GET /:id's shape.
  if (route.kind === 'from_jars') {
    if (method === 'POST') {
      return fromJars(sql, parseBody(), userId, householdIds, async (id) => (await getBatch(sql, id, householdIds)).body);
    }
    return notAllowed;
  }

  const batch = await loadOwnedBatch(sql, route.id, householdIds);
  if (!batch) return notFound;
  // The one closed-batch predicate, read once from the gate row. Since release F it gates exactly one
  // route — a new put-up sitting (see the policy at the top of this file).
  const isClosed = batch.closed_at != null;

  if (route.kind === 'batch') {
    if (method === 'GET') return getBatch(sql, batch.id, householdIds);
    // ACCEPTED on a closed batch from release F (06 §3.13).
    if (method === 'PUT') return updateBatch(sql, batch.id, parseBody(), householdIds);
    if (method === 'DELETE') return deleteBatch(sql, batch.id, userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'stages') {
    if (method === 'POST') return addStage(sql, batch, parseBody(), userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'stage') {
    if (method === 'PATCH') return patchStage(sql, batch, route.stageId, parseBody(), userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'inputs') {
    if (method === 'POST') {
      const body = parseBody();
      // Three forms (contract-F §2.2): the predicate and the un-keyed list are the shipped ones; a list
      // whose every row carries an idempotency_key is F's keyed form (lineRoutes.js).
      if (body && Array.isArray(body.inputs) && inputsForm(body.inputs) !== 'shipped') {
        return addKeyedLines(sql, batch.id, body, userId, householdIds);
      }
      return addInputs(sql, batch.id, body, userId, householdIds);
    }
    return notAllowed;
  }
  if (route.kind === 'input') {
    if (method === 'DELETE') return takeOutLine(sql, batch.id, route.inputId, userId);
    if (method === 'PATCH') return patchLine(sql, batch.id, route.inputId, parseBody(), userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'input_restore') {
    if (method === 'POST') return restoreLine(sql, batch.id, route.inputId, userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'shu_estimate') {
    if (method === 'GET') return shuEstimateRoute(sql, batch.id, q, householdIds);
    return notAllowed;
  }
  if (route.kind === 'shu_estimate_save') {
    if (method === 'POST') return shuEstimateSave(sql, batch.id, parseBody(), userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'put_up') {
    if (method !== 'POST') return notAllowed;
    const body = parseBody();
    if (isClosed) {
      // A retry of a sitting that FINISHED the batch meets a closed batch — it is that sitting's
      // replay, not a new sitting, and gets its own answer back rather than the door.
      const replay = await putUpReplay(sql, batch.id, body?.idempotency_key, householdIds);
      return replay ?? { status: 409, body: BATCH_CLOSED };
    }
    return putUp(sql, batch.id, body, userId, householdIds);
  }
  if (route.kind === 'put_up_undo') {
    if (method !== 'POST') return notAllowed;
    return undoPutUp(sql, batch.id, route.stageId, userId, householdIds);
  }
  if (route.kind === 'close') {
    if (method === 'POST') return closeBatch(sql, batch.id, parseBody(), userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'reopen') {
    if (method === 'POST') return reopenBatch(sql, batch.id, userId, householdIds);
    return notAllowed;
  }
  // ALLOWED on a closed batch, and this one is the REPAIR PATH rather than an exception to the
  // policy. Closing as `put_up` with the wrong jars selected is the expensive mis-tap, and before
  // these routes existed it was permanently unfixable — close is the only other writer of
  // preservation_log.batch_id and it can only run once. Refusing an unlink here would re-create
  // exactly the trap the decoupling ruling removed.
  if (route.kind === 'outputs') {
    if (method === 'POST') return linkOutputs(sql, batch.id, parseBody(), userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'output') {
    if (method === 'DELETE') return unlinkOutput(sql, batch.id, route.outputId, userId, householdIds);
    return notAllowed;
  }
  return notFound;
}

// GET /api/kitchen-batches?state=going|closed|all
//
// `going` INCLUDES suspended batches — the client distinguishes them by suspended_at. NULLS LAST on
// started_at is mandatory and is the SavedSeeds.jsx:594-613 ruling: an unknown start must not outrank
// a measured one at the top of a "check this" list. first_recorded_at is the second key because it is
// NOT NULL, so a screen full of unknown starts still has a stable, meaningful order.
async function listBatches(sql, q, householdIds) {
  const state = parseBatchState(q.state);
  const wantAll = state === 'all';
  const wantGoing = state === 'going';
  const wantClosed = state === 'closed';
  const rows = await sql`
    SELECT * FROM v_kitchen_batch_current
    WHERE user_id = ANY(${householdIds})
      AND deleted_at IS NULL
      AND (${wantAll}
           OR (${wantGoing} AND closed_at IS NULL)
           OR (${wantClosed} AND closed_at IS NOT NULL))
    ORDER BY started_at DESC NULLS LAST, first_recorded_at DESC
  `;
  return { status: 200, body: { state, batches: rows } };
}

// GET /api/kitchen-batches/:id — the view row plus its inputs, its stage log and its outputs.
//
// Put-Up release 1b, in contract-F §2.1's shape (the 1b columns; release F adds its own):
//   * inputs — LIVE lines only (a taken-out line is soft-deleted and is not returned; the client holds
//     its struck-through row until navigation), ordered `ordinal NULLS FIRST, added_at, id`: the order
//     they were written, legacy un-ordinalled lines first.
//   * stages — EVERY row, void rows included, each with voids_id, so the client can hide a voided row
//     and its void together; ordered `entered_at DESC NULLS LAST, created_at DESC, id DESC` (V4
//     Appendix A). NULLS LAST is load-bearing now that a put_up row may be undated ("Not sure"): the
//     shipped `entered_at DESC` put NULLs FIRST. created_at before id is the write order, which is what
//     breaks a tie between two rows the same statement wrote.
//     (The VIEW row — readBatch — already derives current stage, place and pH skipping void and voided
//     rows: 1b's view LATERALs. That is the "readBatch excludes void rows" rule, and it lives in the DDL.)
//   * outputs — live jars, the shipped projection plus the 1b columns, and stock_mode (weighed iff one
//     container logged in a mass unit — the route rule, not a CHECK).
async function getBatch(sql, batchId, householdIds) {
  const row = await readBatch(sql, batchId, householdIds);
  if (!row) return notFound;
  // Release F (contract-F §2.1, boss F3): LIVE lines only, every §1.2 column but the key, plus
  // from_garden and count_drawn (lineRoutes.js readLines). A taken-out line is not returned — the
  // struck-through "Taken out · Undo" row is client-held from the take-out response until navigation.
  const lineRows = await readLines(sql, batchId);
  // ph_reading / ph_read_at ride the same projection (V5-PHRECORD-001). This list IS the reading
  // history: one dated line per row, in the order they were logged, with no count, streak, run or
  // any other aggregate over them — a batch that never acidified produces an unbroken sequence of
  // rows, so a summary of them would turn absent failure signs into apparent success.
  const stages = await sql`
    SELECT id, batch_id, stage_kind, label, amount, amount_unit, cue_observed, entered_at, entered_precision,
           ph_reading, ph_read_at, voids_id, acts, mash_in_g, edited_at,
           storage_location_id, photo_id, note, created_by, created_at
    FROM kitchen_stage_log
    WHERE batch_id = ${batchId}::uuid
    ORDER BY entered_at DESC NULLS LAST, created_at DESC, id DESC
  `;
  // "Which jars came from that mash" was unanswerable before this: the view carries output_count, an
  // integer, and preservation_log.batch_id was write-only. output_count already filters deleted_at,
  // so this list states the same predicate to stay countable against it.
  //
  // use_by_target AND use_by_status ARE DELIBERATELY ABSENT from this projection. The shipped
  // put-up row renders a warn-coloured "Use soon" / "Past use-by" chip off those two, and composed
  // with a recorded outcome on one surface that becomes a shelf-stability endorsement this app does
  // not make. The date is still on the row for every surface whose job is the pantry; it is not on
  // the surface whose job is the batch. An explicit column list rather than SELECT * is what keeps
  // that a decision instead of an accident.
  const outputs = await sql`
    SELECT id, batch_id, user_id, crop_type_slug, variety_id, plant_id, harvest_log_id,
           preserved_at, preserved_at_approx, method, method_other_text,
           quantity_value, quantity_unit, package_count, storage_location_id,
           remaining_count, consumed_at, notes, photo_id, created_at, updated_at,
           label, container_label, put_up_stage_id, is_raw, in_oil, texture, ph_reading, ph_read_at,
           preserved_at_precision, use_by_basis, shu_est_low, shu_est_high, shu_est_basis, cooked,
           remaining_amount,
           CASE WHEN package_count = 1 AND quantity_unit = ANY(${MASS_UNITS}::text[])
                THEN 'weighed' ELSE 'counted' END AS stock_mode
    FROM preservation_log
    WHERE batch_id = ${batchId}::uuid
      AND deleted_at IS NULL
    ORDER BY preserved_at DESC, id DESC
  `;
  const inputs = lineRows.map(publicLine);
  // "From the garden" (06 §2.7): distinct names of the live lines that came from the garden, sitting
  // lines included, in the lines' own order. A reward surface — ambient, never a count or a sum.
  const garden_names = [...new Set(inputs.filter((l) => l.from_garden && l.label).map((l) => l.label))];
  const out = { ...row, garden_names, inputs, stages, outputs };
  // Release 4: the recipe it follows — name, keeps line and lines as reference text (never its notes, which
  // carry his target pH and render only on recipe detail). The key is present only when the batch names one.
  if (row.recipe_id) out.recipe = await readRecipeForBatch(sql, row.recipe_id, householdIds);
  // A stored COMPUTED estimate is never silently recomputed (06 §2.6.4): it is flagged when today's
  // recompute differs. 'typed' is never flagged. The key is present only when true.
  if (row.shu_est_basis === 'computed') {
    const fresh = estimateShu({
      scope: 'batch', lines: lineRows.map(shuLine), about: aboutOf(stages),
      pepperNames: await householdPepperNames(sql, householdIds),
    });
    if (isStale(row, fresh)) out.shu_est_stale = true;
  }
  return { status: 200, body: out };
}

// The stage facts the heat estimate reads: "About ___ in it" is the live started row's amount; a
// sitting is a live (un-voided) put_up row, its Made g the amount when the unit is g, and its mash_in_g.
const voidedIds = (stages) => new Set(stages.filter((x) => x.stage_kind === 'void').map((x) => x.voids_id));
export function aboutOf(stages) {
  const v = voidedIds(stages);
  const started = stages.find((x) => x.stage_kind === 'started' && !v.has(x.id));
  return started && started.amount != null ? { amount: started.amount, amount_unit: started.amount_unit } : null;
}
export function sittingsOf(stages) {
  const v = voidedIds(stages);
  return stages.filter((x) => x.stage_kind === 'put_up' && !v.has(x.id)).map((x) => ({
    id: x.id,
    made_g: x.amount != null && x.amount_unit === 'g' ? x.amount : null,
    mash_in_g: x.mash_in_g ?? null,
  }));
}

// Pepper variety names among the household's plantings: a typed line naming one is a heat line
// (06 §2.6.2). Same strict planting dialect as every loader here.
async function householdPepperNames(sql, householdIds) {
  const rows = await sql`
    SELECT DISTINCT lower(cv.display_name) AS name
    FROM garden_node gn
    JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
    LEFT JOIN container pp ON pp.id = gn.container_id
    WHERE cv.crop_type_slug = 'pepper'
      AND gn.deleted_at IS NULL
      AND ( pp.created_by = ANY(${householdIds})
            OR (gn.container_id IS NULL AND gn.created_by = ANY(${householdIds})) )
  `;
  return rows.map((r) => r.name).filter(Boolean);
}

// ── GET /:id/shu-estimate?scope=batch|sitting|jar&id= and POST /:id/shu-estimate/save (contract-F §2.5)
// GET writes nothing. save RECOMPUTES server-side and writes basis 'computed' (half-up integers) on the
// batch or the jar — the only writer of 'computed'. A refusal is 409 shu_cannot_compute carrying the
// same refusal body, so the sheet can say exactly what is missing. Never 0 from absence.
async function shuFor(sql, batchId, scope, id, householdIds) {
  if (!['batch', 'sitting', 'jar'].includes(scope)) return { error: bad('scope must be batch, sitting or jar') };
  if (scope !== 'batch' && !KITCHEN_UUID_RE.test(String(id ?? ''))) return { error: bad('id must be the sitting or jar') };
  const lineRows = await readLines(sql, batchId);
  const stages = await sql`
    SELECT id, stage_kind, amount, amount_unit, mash_in_g, voids_id
    FROM kitchen_stage_log
    WHERE batch_id = ${batchId}::uuid
  `;
  let jar = null;
  if (scope === 'jar') {
    const j = await sql`
      SELECT id, put_up_stage_id, quantity_value, quantity_unit
      FROM preservation_log
      WHERE id = ${id}::uuid AND batch_id = ${batchId}::uuid AND deleted_at IS NULL
    `;
    if (!j.length) return { error: notFound };
    jar = j[0];
  }
  const est = estimateShu({
    scope, lines: lineRows.map(shuLine), about: aboutOf(stages), sittings: sittingsOf(stages),
    sitting_id: scope === 'sitting' ? id : null, jar, pepperNames: await householdPepperNames(sql, householdIds),
  });
  if (est.refusal === 'not_found') return { error: notFound };
  return { est, jar };
}

async function shuEstimateRoute(sql, batchId, q, householdIds) {
  const r = await shuFor(sql, batchId, q.scope ?? 'batch', q.id ?? null, householdIds);
  if (r.error) return r.error;
  return { status: 200, body: r.est };
}

async function shuEstimateSave(sql, batchId, body, userId, householdIds) {
  const scope = body?.scope ?? 'batch';
  if (scope === 'sitting') return bad('a sitting has no stored estimate — save it on the batch or on a jar');
  const r = await shuFor(sql, batchId, scope, body?.id ?? null, householdIds);
  if (r.error) return r.error;
  if (r.est.refusal) {
    return { status: 409, body: { error: "Can't work it out yet.", code: 'shu_cannot_compute', ...r.est } };
  }
  const { low, high } = r.est;
  if (scope === 'batch') {
    const rows = await sql`
      UPDATE kitchen_batch SET shu_est_low = ${low}::int, shu_est_high = ${high}::int, shu_est_basis = 'computed'
      WHERE id = ${batchId}::uuid AND user_id = ANY(${householdIds}) AND deleted_at IS NULL
      RETURNING shu_est_low, shu_est_high, shu_est_basis
    `;
    if (!rows.length) return notFound;
    return { status: 200, body: rows[0] };
  }
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
    sql`
    UPDATE preservation_log SET shu_est_low = ${low}::int, shu_est_high = ${high}::int, shu_est_basis = 'computed'
    WHERE id = ${r.jar.id}::uuid AND batch_id = ${batchId}::uuid
      AND user_id = ANY(${householdIds}) AND deleted_at IS NULL
    RETURNING shu_est_low, shu_est_high, shu_est_basis
  `,
  ]);
  if (!rows.length) return notFound;
  return { status: 200, body: rows[0] };
}

// POST /api/kitchen-batches
//
// ONE STATEMENT, so the batch and its opening stage row cannot land apart. A data-modifying CTE is
// executed exactly once and always to completion, so `s` runs even though the primary query never
// reads it — and the neon HTTP driver cannot carry a generated id between two statements in one
// transaction, which is why this is a CTE rather than sql.transaction().
//
// entered_at is COALESCE(started_at, now()): when the cook back-dates a start, that IS when this stage
// began, and first_recorded_at on the batch still carries the honest floor. Age never feeds a
// readiness computation, so a coarse start here cannot become a "due" anywhere.
async function createBatch(sql, body, userId, householdIds) {
  const verr = validateBatchCreate(body);
  if (verr) return bad(verr);
  if (body.cover_photo_id) {
    const ph = await loadOwnedPhoto(sql, body.cover_photo_id, householdIds);
    if (!ph) return bad('cover_photo_id does not match a photo you can use');
  }
  const anchorErr = await gateStartAnchor(sql, body, householdIds);
  if (anchorErr) return bad(anchorErr);
  // Release 4: "Following a recipe?" — a recipe_id must be a live recipe of the household (V4 §5.3).
  if (body.recipe_id != null && !(await loadOwnedRecipe(sql, body.recipe_id, householdIds))) {
    return bad('recipe_id does not match a recipe you can use');
  }
  const kind = normalizeText(body.kind);
  // Put-Up release 1b — the started row MIRRORS the batch's start (V4 Appendix A): with a precision the
  // row carries the same date and word, and "Not sure" ('unknown') stores NO date rather than stamping
  // now() on a start nobody knows ("no route stamps now() on a retrospective entry"). A body with no
  // precision is the pre-1b writer's shape and keeps its old stamp (entered_precision NULL).
  const precision = normalizeText(body.start_precision);
  const key = body.idempotency_key ?? null;
  let rows;
  try {
    rows = await sql`
      WITH b AS (
        INSERT INTO kitchen_batch (
          user_id, label, kind, kind_other, started_at, start_precision,
          start_anchor_kind, start_anchor_id, expected_days_min, expected_days_max,
          brine_note, cover_photo_id, notes, idempotency_key, recipe_id, recipe_ref
        ) VALUES (
          ${userId}::text, ${normalizeText(body.label)}::text, ${kind}::text,
          ${kind === 'other' ? normalizeText(body.kind_other) : null}::text,
          ${body.started_at ?? null}::timestamptz, ${precision}::text,
          ${normalizeText(body.start_anchor_kind)}::text, ${body.start_anchor_id ?? null}::uuid,
          ${body.expected_days_min ?? null}::integer, ${body.expected_days_max ?? null}::integer,
          ${normalizeText(body.brine_note)}::text, ${body.cover_photo_id ?? null}::uuid,
          ${normalizeText(body.notes)}::text, ${key}::uuid,
          ${body.recipe_id ?? null}::uuid, ${normalizeText(body.recipe_ref)}::text
        ) RETURNING id
      ), s AS (
        INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, photo_id, created_by)
        SELECT b.id, 'started'::text,
               CASE WHEN ${precision}::text IS NULL THEN COALESCE(${body.started_at ?? null}::timestamptz, now())
                    ELSE ${body.started_at ?? null}::timestamptz END,
               ${precision}::text,
               ${body.cover_photo_id ?? null}::uuid, ${userId}::text
        FROM b
        RETURNING id
      )
      SELECT id FROM b
    `;
  } catch (err) {
    // V4 "Idempotency": a 23505 on THIS index is a replay; the key's owner is checked by the read.
    if (err?.code === '23505' && err.constraint === 'uq_kitchen_batch_idempotency_key') {
      const prior = await sql`
        SELECT * FROM v_kitchen_batch_current
        WHERE idempotency_key = ${key}::uuid
          AND user_id = ANY(${householdIds})
          AND deleted_at IS NULL
      `;
      if (!prior.length) return keyConflict;
      return { status: 200, body: { ...prior[0], replayed: true } };
    }
    throw err;
  }
  const created = await readBatch(sql, rows[0].id, householdIds);
  return { status: 201, body: created };
}

// PUT /api/kitchen-batches/:id — an explicit-allowlist MERGE.
//
// EVERY COLUMN IS A CASE ON A PRESENCE FLAG, and that is not house style for a reason. index.js:589-610
// is a full replace and is correct there, because every client that can issue that PUT builds all of
// its columns. It is wrong here: absent must mean "unchanged" while an explicit null must mean
// "clear", and COALESCE collapses those two into one. A merge written with COALESCE cannot clear a
// field at all; one written as a plain body-or-null replace would let a stale service-worker bundle
// wipe brine_note on an unrelated tap.
//
// ::CASTS ARE LOAD-BEARING on every placeholder, exactly as they are in the source_label CASE: the
// neon driver sends untyped params, and a bare placeholder inside a CASE gives Postgres no type
// context — "could not determine data type of parameter" and the whole PUT 500s.
//
// updated_at is NOT set here: kitchen_batch carries the set_updated_at trigger. Setting it by hand
// would be a second writer for a value that already has one. (preservation_log gained the same trigger
// in Put-Up release 1b; the shipped `updated_at = NOW()` on its link/unlink writes is now redundant
// and harmless.)
async function updateBatch(sql, batchId, body, householdIds) {
  const verr = validateBatchUpdate(body);
  if (verr) return bad(verr);
  const { present, value } = batchUpdatePatch(body);
  if (present.cover_photo_id && value.cover_photo_id != null) {
    const ph = await loadOwnedPhoto(sql, value.cover_photo_id, householdIds);
    if (!ph) return bad('cover_photo_id does not match a photo you can use');
  }
  // The edit path needs the SAME gate as create, or it reopens exactly what create closes — the
  // asymmetry index.js's AUTHZ (0A.5) note calls out. anchorError has already forced the kind to
  // travel with the id, so `body` carries both halves whenever there is anything to check.
  const anchorErr = await gateStartAnchor(sql, body, householdIds);
  if (anchorErr) return bad(anchorErr);
  const rows = await sql`
    UPDATE kitchen_batch SET
      label             = CASE WHEN ${present.label}::boolean             THEN ${value.label}::text             ELSE label END,
      kind              = CASE WHEN ${present.kind}::boolean              THEN ${value.kind}::text              ELSE kind END,
      kind_other        = CASE WHEN ${present.kind_other}::boolean        THEN ${value.kind_other}::text        ELSE kind_other END,
      started_at        = CASE WHEN ${present.started_at}::boolean        THEN ${value.started_at}::timestamptz ELSE started_at END,
      start_precision   = CASE WHEN ${present.start_precision}::boolean   THEN ${value.start_precision}::text   ELSE start_precision END,
      start_anchor_kind = CASE WHEN ${present.start_anchor_kind}::boolean THEN ${value.start_anchor_kind}::text ELSE start_anchor_kind END,
      start_anchor_id   = CASE WHEN ${present.start_anchor_id}::boolean   THEN ${value.start_anchor_id}::uuid   ELSE start_anchor_id END,
      expected_days_min = CASE WHEN ${present.expected_days_min}::boolean THEN ${value.expected_days_min}::integer ELSE expected_days_min END,
      expected_days_max = CASE WHEN ${present.expected_days_max}::boolean THEN ${value.expected_days_max}::integer ELSE expected_days_max END,
      brine_note        = CASE WHEN ${present.brine_note}::boolean        THEN ${value.brine_note}::text         ELSE brine_note END,
      cover_photo_id    = CASE WHEN ${present.cover_photo_id}::boolean    THEN ${value.cover_photo_id}::uuid     ELSE cover_photo_id END,
      notes             = CASE WHEN ${present.notes}::boolean             THEN ${value.notes}::text              ELSE notes END,
      suspended_at      = CASE WHEN ${present.suspended_at}::boolean      THEN ${value.suspended_at}::timestamptz ELSE suspended_at END,
      vessel_label      = CASE WHEN ${present.vessel_label}::boolean      THEN ${value.vessel_label}::text       ELSE vessel_label END,
      vessel_size       = CASE WHEN ${present.vessel_size}::boolean       THEN ${value.vessel_size}::numeric     ELSE vessel_size END,
      vessel_unit       = CASE WHEN ${present.vessel_unit}::boolean       THEN ${value.vessel_unit}::text        ELSE vessel_unit END,
      vessel_count      = CASE WHEN ${present.vessel_count}::boolean      THEN ${value.vessel_count}::smallint   ELSE vessel_count END,
      no_salt           = CASE WHEN ${present.no_salt}::boolean           THEN ${value.no_salt}::boolean         ELSE no_salt END,
      shu_est_low       = CASE WHEN ${present.shu_est_low}::boolean       THEN ${value.shu_est_low}::integer     ELSE shu_est_low END,
      shu_est_high      = CASE WHEN ${present.shu_est_high}::boolean      THEN ${value.shu_est_high}::integer    ELSE shu_est_high END,
      recipe_ref        = CASE WHEN ${present.recipe_ref}::boolean        THEN ${value.recipe_ref}::text         ELSE recipe_ref END,
      -- A heat estimate written here is 'typed' (only shu-estimate/save writes 'computed'); clearing it
      -- clears its basis (chk_kitchen_batch_shu_est_pairing).
      shu_est_basis     = CASE WHEN ${present.shu_est_low}::boolean
                               THEN CASE WHEN ${value.shu_est_low}::integer IS NULL THEN NULL ELSE 'typed' END
                               ELSE shu_est_basis END
    WHERE id = ${batchId}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
      -- "No salt" is set only when no live salt line exists, decided HERE on the locked row, so a salt
      -- line added a moment earlier cannot be contradicted (06 §2.1). 0 rows → 409 has_salt_line.
      AND (${value.no_salt === true}::boolean IS NOT TRUE
           OR NOT EXISTS (SELECT 1 FROM kitchen_batch_input i
                           WHERE i.batch_id = ${batchId}::uuid AND i.role = 'salt' AND i.deleted_at IS NULL))
    RETURNING id
  `;
  if (!rows.length) {
    if (value.no_salt === true) {
      return { status: 409, body: { error: 'Take the salt line out first.', code: 'has_salt_line' } };
    }
    return notFound;
  }
  return { status: 200, body: await readBatch(sql, batchId, householdIds) };
}

// DELETE /api/kitchen-batches/:id — "Remove this batch" (started by mistake). Put-Up release 1b, with the
// archive decision 05 §6a left to this lane, taken as 06-ferment-path §3.12 settles it for F:
//   * REFUSED while the batch has live jars (409 has_jars, "undo its put-ups first" — V4).
//   * Otherwise ONE statement, all or nothing: soft-delete the batch; soft-delete its live non-harvest
//     lines; HARD-delete its harvest-pick lines.
// WHY THE PICK LINES ARE HARD-DELETED (of the three ways out of the archive trap v5-putupmake-001's
// README records): kitchen_batch_input.harvest_log_id is ON DELETE RESTRICT and a foreign key does not
// read deleted_at, so a pick line under a soft-deleted batch kept its harvest_log row pinned and the
// planting / container archive died on a bare 23503 — the one app-reachable shape of that trap. The
// alternatives were (a) SET NULL on the FK, which chk_kbi_harvest_pairing turns into a 23514 inside the
// RI trigger, and (b) teaching both archive routines to delete lines of soft-deleted batches, which
// re-pins 0a's routine fingerprints and re-opens the rehearsed DDL. A pick line is a LINK, not evidence:
// the pick itself stays in harvest_log, and a removed batch offers no restore, so nothing a restore could
// need is lost. The routines stay as rehearsed.
// Release F: the same statement reverses the unreversed draws of the lines it takes out (a reversing
// pantry_use per counted draw; the grams back for a weighed one, F2's un-consume rule), aggregated per
// jar FIRST and applied as ONE UPDATE per jar (boss condition F1). Any 23514 aborts it all and the batch
// stays live.
// The whole statement rides a set_config: release F attaches an audit trigger to kitchen_batch_input.
async function deleteBatch(sql, batchId, userId, householdIds) {
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
    sql`
    WITH gone AS (
      UPDATE kitchen_batch
      SET deleted_at = NOW()
      WHERE id = ${batchId}::uuid
        AND user_id = ANY(${householdIds})
        AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM preservation_log p
                         WHERE p.batch_id = ${batchId}::uuid AND p.deleted_at IS NULL)
      RETURNING id
    ), lines_out AS (
      UPDATE kitchen_batch_input i
      SET deleted_at = NOW()
      FROM gone g
      WHERE i.batch_id = g.id
        AND i.deleted_at IS NULL
        AND i.harvest_log_id IS NULL
      RETURNING i.id, i.preservation_log_id, i.qty, i.qty_unit
    ), picks_gone AS (
      DELETE FROM kitchen_batch_input i
      USING gone g
      WHERE i.batch_id = g.id
        AND i.harvest_log_id IS NOT NULL
      RETURNING i.id
    ), mass AS (
      SELECT m.unit, m.factor FROM unnest(${MASS_UNITS}::text[], ${MASS_FACTORS}::numeric[]) AS m(unit, factor)
    ), fwd AS (
      -- Release F (06 §3.12): the draws of the lines taken out HERE — lines already taken out were
      -- reversed then, and lines_out skips them.
      SELECT u.id, u.preservation_log_id, u.count_used, u.kitchen_batch_input_id
      FROM pantry_use u JOIN lines_out l ON l.id = u.kitchen_batch_input_id
      WHERE u.count_used > 0
        AND NOT EXISTS (SELECT 1 FROM pantry_use r WHERE r.reverses_use_id = u.id)
    ), weighed AS (
      SELECT l.preservation_log_id, l.qty * (SELECT factor FROM mass WHERE unit = l.qty_unit) AS g
      FROM lines_out l
      WHERE l.preservation_log_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pantry_use u WHERE u.kitchen_batch_input_id = l.id)
    ), rev AS (
      INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id, reverses_use_id)
      SELECT ${userId}::text, f.preservation_log_id, -f.count_used, 'batch', f.kitchen_batch_input_id, f.id
      FROM fwd f
      RETURNING id
    ), moved AS (
      -- Boss F1: every jar moves ONCE — two lines of this batch drawing one jar give back their SUM.
      UPDATE preservation_log p SET
        remaining_count  = CASE WHEN a.n IS NOT NULL THEN COALESCE(p.remaining_count, p.package_count) + a.n
                                WHEN a.g IS NOT NULL
                                 AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                 AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL)
                                  THEN p.package_count
                                ELSE p.remaining_count END,
        remaining_amount = CASE WHEN a.g IS NOT NULL
                                  THEN COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) + a.g
                                ELSE p.remaining_amount END,
        consumed_at      = CASE WHEN a.g IS NOT NULL
                                 AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                 AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL)
                                  THEN NULL
                                ELSE p.consumed_at END,
        delta_at         = CASE WHEN a.n IS NOT NULL
                                  OR (a.g IS NOT NULL
                                      AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                      AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL))
                                  THEN now()
                                ELSE p.delta_at END
      FROM (SELECT x.preservation_log_id, sum(x.n) AS n, sum(x.g) AS g FROM (
              SELECT f.preservation_log_id, f.count_used AS n, NULL::numeric AS g FROM fwd f
              UNION ALL
              SELECT w.preservation_log_id, NULL::int, w.g FROM weighed w
            ) x GROUP BY x.preservation_log_id) a
      WHERE p.id = a.preservation_log_id
      RETURNING p.id
    )
    SELECT (SELECT count(*)::int FROM gone) AS deleted_count,
           (SELECT count(*)::int FROM preservation_log p
             WHERE p.batch_id = ${batchId}::uuid AND p.deleted_at IS NULL) AS live_jar_count,
           (SELECT count(*)::int FROM lines_out) AS lines_removed,
           (SELECT count(*)::int FROM picks_gone) AS picks_unlinked,
           (SELECT count(*)::int FROM rev) AS uses_reversed,
           (SELECT count(*)::int FROM moved) AS jars_moved
  `,
  ]);
  const r = rows[0] ?? {};
  if (r.deleted_count) return { status: 200, body: { ok: true } };
  if (r.live_jar_count) {
    return {
      status: 409,
      body: {
        error: 'This batch still has jars. Undo its put-ups (or unlink the jars) first.',
        code: 'has_jars',
      },
    };
  }
  return notFound;
}

// ph_read_at bounds (06 §3.7, FS-I3), on the check-in POST and the stage PATCH alike: refused if later
// than now + 5 min or earlier than the batch's start day (ET), so a typo cannot silence
// fermentStallPrompt. A batch with no start date has no lower bound.
function phBoundsError(readAt, batch) {
  return phReadAtError(readAt, {
    nowMs: Date.now(),
    startDay: batch.started_at ? etDay(new Date(batch.started_at)) : null,
    etDayOf: etDay,
  });
}

// POST /api/kitchen-batches/:id/stages — append-only.
//
// There is no DELETE on a stage row, and that absence is the design: the off-log repair path is exactly
// what produced the seed-lot divergence this schema refuses to copy. A mistake is undone by appending a
// void. Release F adds an in-place EDIT (PATCH /:id/stages/:stageId, below) at Dave's direction — the
// row keeps its identity (trigger-enforced), the edit is audited and shows "edited".
//
// A stage may be appended to a CLOSED batch on purpose. "It went mouldy in the jar three weeks later"
// is a fact about the process, and refusing it would push it into a note nothing can read.
//
// Put-Up release 1b (V4 API table + Appendix A):
//   * void — an Undo: a row pointing at a tended, moved or noted row OF THIS BATCH (put_up and finished
//     rows are voided only by Undo that put-up). A second Undo of the same row is a 23505 on
//     uq_ksl_voids_id, answered as a replay.
//   * paused / resumed / reopened — the row AND the batch column it records, in ONE statement, so the
//     column stays authoritative and the log can never disagree with it.
//   * noted — a note, stamped now.
//   * entered_precision — with it, the row carries exactly the date and word it was given ('unknown' =
//     no date); without it (the pre-1b shape) the row keeps its old stamp, COALESCE(entered_at, now()).
async function addStage(sql, batch, body, userId, householdIds) {
  const batchId = batch.id;
  const verr = validateStage(body) ?? phBoundsError(body.ph_read_at, batch);
  if (verr) return bad(verr);
  const kind = normalizeText(body.stage_kind);
  if (kind === 'void') return voidStage(sql, batchId, body.voids_id, userId, householdIds);
  if (KITCHEN_STATE_STAGE_KINDS.includes(kind)) return stateStage(sql, batchId, kind, body, userId, householdIds);
  if (body.storage_location_id) {
    const loc = await loadOwnedStorageLocation(sql, body.storage_location_id, householdIds);
    if (!loc) return bad('storage_location_id does not match a storage location you can use');
  }
  if (body.photo_id) {
    const ph = await loadOwnedPhoto(sql, body.photo_id, householdIds);
    if (!ph) return bad('photo_id does not match a photo you can use');
  }
  // How entered_at is written, decided once: 'now' (a note), 'value' (a precision was given, so the date
  // is exactly what was sent — NULL for 'unknown'), 'legacy' (the pre-1b stamp).
  const precision = kind === 'noted' ? 'exact' : normalizeText(body.entered_precision);
  const mode = kind === 'noted' ? 'now' : precision != null ? 'value' : 'legacy';
  // ph_reading IS NOT NORMALIZED AND IS NOT COERCED (V5-PHRECORD-001). It reaches the ::numeric cast
  // as the exact string the client sent, because a Number round-trip drops a trailing zero the meter
  // displayed, and Postgres preserves the scale of the literal it is given — so a value typed with a
  // trailing digit reads back with it.
  // ph_read_at has NO COALESCE, unlike entered_at directly above: entered_at legitimately defaults to
  // "now, because that is when you logged it", while a defaulted read-time would stamp an instant
  // onto a measurement nobody took then. validateStage has already forced the pair to travel
  // together, and chk_ksl_ph_pairing is the backstop behind it.
  // Release F: what he did at a check-in, de-duplicated (validateStage allowed it on tended only).
  const acts = actsOf(body.acts ?? null).acts;
  const rows = await sql`
    INSERT INTO kitchen_stage_log (
      batch_id, stage_kind, label, amount, amount_unit, cue_observed,
      entered_at, entered_precision, ph_reading, ph_read_at, storage_location_id, photo_id, note, created_by,
      acts
    ) VALUES (
      ${batchId}::uuid, ${kind}::text, ${normalizeText(body.label)}::text,
      ${body.amount ?? null}::numeric, ${normalizeText(body.amount_unit)}::text,
      ${normalizeText(body.cue_observed)}::text,
      CASE ${mode}::text WHEN 'now' THEN now()
                         WHEN 'value' THEN ${body.entered_at ?? null}::timestamptz
                         ELSE COALESCE(${body.entered_at ?? null}::timestamptz, now()) END,
      ${precision}::text,
      ${body.ph_reading ?? null}::numeric, ${body.ph_read_at ?? null}::timestamptz,
      ${body.storage_location_id ?? null}::uuid, ${body.photo_id ?? null}::uuid,
      ${normalizeText(body.note)}::text, ${userId}::text,
      ${acts}::text[]
    ) RETURNING id, batch_id, stage_kind, label, amount, amount_unit, cue_observed, entered_at, entered_precision,
               ph_reading, ph_read_at, voids_id, storage_location_id, photo_id, note, created_by, created_at,
               acts, mash_in_g, edited_at
  `;
  // The batch rides along because appending a stage is the one write that changes the view's derived
  // columns, and the card that issued it renders from exactly those.
  return { status: 201, body: { stage: rows[0], batch: await readBatch(sql, batchId, householdIds) } };
}

// PATCH /api/kitchen-batches/:id/stages/:stageId (Release F; 06 §3.7; contract-F §2.3).
//
// Stages became editable in F ("each stage should allow me to make notes and add/edit the information",
// Dave 15:55). What an entry IS never changes — its kind, batch, what it voids, who wrote it (the
// identity trigger backs this) — and a started / put_up / finished row keeps its date. Per kind:
// every kind takes note, photo_id and label; tended its cue, acts, pH pair, top-up amount and date;
// moved its place and date; noted its date; put_up its Made g and mash_in_g; started "About ___ in it".
// A void row, and a row that has been voided, are note-only. Scoped `WHERE id AND batch_id` (the
// take-out idiom), presence-sentinel, stamps edited_at; the loaders refuse a foreign place or photo;
// the pH read-time takes the same bounds as the POST. Accepted on a closed batch (06 §3.13).
// kitchen_stage_log is audited from F, so the write rides the actor GUC in one transaction.
async function patchStage(sql, batch, stageId, body, userId, householdIds) {
  if (!KITCHEN_UUID_RE.test(String(stageId))) return notFound;
  const found = await sql`
    SELECT s.id, s.stage_kind, s.amount_unit,
           EXISTS (SELECT 1 FROM kitchen_stage_log v WHERE v.voids_id = s.id) AS voided
    FROM kitchen_stage_log s
    WHERE s.id = ${stageId}::uuid
      AND s.batch_id = ${batch.id}::uuid
  `;
  if (!found.length) return notFound;
  const stored = found[0];
  const verr = stagePatchError(body, stored) ?? phBoundsError(body.ph_read_at ?? null, batch);
  if (verr) return bad(verr);
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (body.storage_location_id != null) {
    const loc = await loadOwnedStorageLocation(sql, body.storage_location_id, householdIds);
    if (!loc) return bad('storage_location_id does not match a storage location you can use');
  }
  if (body.photo_id != null) {
    const ph = await loadOwnedPhoto(sql, body.photo_id, householdIds);
    if (!ph) return bad('photo_id does not match a photo you can use');
  }
  const isPutUp = stored.stage_kind === 'put_up';
  const amountUnit = isPutUp ? (body.amount == null ? null : 'g') : normalizeText(body.amount_unit);
  const phReading = body.ph_reading == null ? null : String(body.ph_reading).trim();
  const acts = has('acts') ? actsOf(body.acts).acts : null;
  const precision = normalizeText(body.entered_precision);
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
    sql`
    UPDATE kitchen_stage_log SET
      note                = CASE WHEN ${has('note')}::boolean THEN ${normalizeText(body.note)}::text ELSE note END,
      photo_id            = CASE WHEN ${has('photo_id')}::boolean THEN ${body.photo_id ?? null}::uuid ELSE photo_id END,
      label               = CASE WHEN ${has('label')}::boolean THEN ${normalizeText(body.label)}::text ELSE label END,
      cue_observed        = CASE WHEN ${has('cue_observed')}::boolean THEN ${normalizeText(body.cue_observed)}::text ELSE cue_observed END,
      acts                = CASE WHEN ${has('acts')}::boolean THEN ${acts}::text[] ELSE acts END,
      ph_reading          = CASE WHEN ${has('ph_reading')}::boolean THEN ${phReading}::numeric ELSE ph_reading END,
      ph_read_at          = CASE WHEN ${has('ph_reading')}::boolean THEN ${body.ph_read_at ?? null}::timestamptz ELSE ph_read_at END,
      amount              = CASE WHEN ${has('amount')}::boolean THEN ${body.amount == null ? null : String(body.amount)}::numeric ELSE amount END,
      amount_unit         = CASE WHEN ${has('amount')}::boolean THEN ${amountUnit}::text ELSE amount_unit END,
      mash_in_g           = CASE WHEN ${has('mash_in_g')}::boolean THEN ${body.mash_in_g == null ? null : String(body.mash_in_g)}::numeric ELSE mash_in_g END,
      storage_location_id = CASE WHEN ${has('storage_location_id')}::boolean THEN ${body.storage_location_id ?? null}::uuid ELSE storage_location_id END,
      entered_at          = CASE WHEN ${has('entered_precision')}::boolean THEN ${body.entered_at ?? null}::timestamptz ELSE entered_at END,
      entered_precision   = CASE WHEN ${has('entered_precision')}::boolean THEN ${precision}::text ELSE entered_precision END,
      edited_at           = now()
    WHERE id = ${stored.id}::uuid
      AND batch_id = ${batch.id}::uuid
    RETURNING id, batch_id, stage_kind, label, amount, amount_unit, cue_observed, entered_at, entered_precision,
              ph_reading, ph_read_at, voids_id, storage_location_id, photo_id, note, created_by, created_at,
              acts, mash_in_g, edited_at
  `,
  ]);
  if (!rows.length) return notFound;
  return { status: 200, body: { stage: rows[0] } };
}

// The void. The INSERT…SELECT reads the target row in the same statement, scoped to THIS batch and to
// the three voidable kinds, so a foreign, cross-batch or put_up/finished id writes nothing (400) and
// there is no read-then-write gap. The composite FK (batch_id, voids_id) is the backstop.
async function voidStage(sql, batchId, voidsId, userId, householdIds) {
  let rows;
  try {
    rows = await sql`
      INSERT INTO kitchen_stage_log (batch_id, stage_kind, voids_id, entered_at, entered_precision, created_by)
      SELECT t.batch_id, 'void'::text, t.id, now(), 'exact'::text, ${userId}::text
      FROM kitchen_stage_log t
      WHERE t.id = ${voidsId}::uuid
        AND t.batch_id = ${batchId}::uuid
        AND t.stage_kind = ANY(${KITCHEN_VOIDABLE_KINDS}::text[])
      RETURNING id, batch_id, stage_kind, label, amount, amount_unit, cue_observed, entered_at, entered_precision,
               ph_reading, ph_read_at, voids_id, storage_location_id, photo_id, note, created_by, created_at
    `;
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'uq_ksl_voids_id') {
      const prior = await sql`
        SELECT id, batch_id, stage_kind, label, amount, amount_unit, cue_observed, entered_at, entered_precision,
               ph_reading, ph_read_at, voids_id, storage_location_id, photo_id, note, created_by, created_at FROM kitchen_stage_log
        WHERE voids_id = ${voidsId}::uuid AND batch_id = ${batchId}::uuid
      `;
      return {
        status: 200,
        body: { stage: prior[0] ?? null, batch: await readBatch(sql, batchId, householdIds), replayed: true },
      };
    }
    throw err;
  }
  if (!rows.length) return bad('only a check-in, a move or a note of this batch can be undone here');
  return { status: 201, body: { stage: rows[0], batch: await readBatch(sql, batchId, householdIds) } };
}

// paused / resumed / reopened: the batch column and the row, one statement. The UPDATE's WHERE is the
// state precondition (pause an open, unpaused batch; resume a paused one; reopen a closed one), so a
// double tap writes one row and answers the second with a 409 that says why.
const STATE_REFUSALS = {
  paused: 'This batch is already paused or finished.',
  resumed: 'This batch is not paused.',
  reopened: 'This batch is not closed.',
};
async function stateStage(sql, batchId, kind, body, userId, householdIds) {
  const rows = await sql`
    WITH b AS (
      UPDATE kitchen_batch SET
        suspended_at = CASE ${kind}::text WHEN 'paused' THEN now()
                                          WHEN 'resumed' THEN NULL ELSE suspended_at END,
        closed_at    = CASE WHEN ${kind}::text = 'reopened' THEN NULL ELSE closed_at END,
        outcome      = CASE WHEN ${kind}::text = 'reopened' THEN NULL ELSE outcome END,
        outcome_note = CASE WHEN ${kind}::text = 'reopened' THEN NULL ELSE outcome_note END
      WHERE id = ${batchId}::uuid
        AND user_id = ANY(${householdIds})
        AND deleted_at IS NULL
        AND CASE ${kind}::text WHEN 'paused'  THEN closed_at IS NULL AND suspended_at IS NULL
                               WHEN 'resumed' THEN suspended_at IS NOT NULL
                               ELSE closed_at IS NOT NULL END
      RETURNING id
    )
    INSERT INTO kitchen_stage_log (batch_id, stage_kind, note, entered_at, entered_precision, created_by)
    SELECT b.id, ${kind}::text, ${normalizeText(body.note)}::text, now(), 'exact'::text, ${userId}::text
    FROM b
    RETURNING id, batch_id, stage_kind, label, amount, amount_unit, cue_observed, entered_at, entered_precision,
               ph_reading, ph_read_at, voids_id, storage_location_id, photo_id, note, created_by, created_at
  `;
  if (!rows.length) return { status: 409, body: { error: STATE_REFUSALS[kind], code: `not_${kind}_able` } };
  return { status: 201, body: { stage: rows[0], batch: await readBatch(sql, batchId, householdIds) } };
}

// POST /api/kitchen-batches/:id/inputs — two forms, one route.
//
// ON CONFLICT DO NOTHING against uq_kbi_batch_harvest on both, and the returned count is the number
// ACTUALLY inserted rather than the number asked for. That is what makes re-running the same predicate
// safe AND honest: a second run reports 0, not 139.
async function addInputs(sql, batchId, body, userId, householdIds) {
  const verr = validateInputPayload(body);
  if (verr) return bad(verr);
  if (body.predicate) {
    return addInputsByPredicate(
      sql, batchId, body.predicate, userId, householdIds, body.preview === true);
  }

  const rows = normalizeInputRows(body.inputs);
  const harvestIds = harvestIdsIn(rows);
  if (harvestIds.length) {
    const owned = await loadOwnedHarvestLogs(sql, harvestIds, householdIds);
    // Count comparison, not a per-id report: naming WHICH id was rejected is an existence oracle for
    // another household's harvests.
    if (owned.length !== harvestIds.length) {
      return bad('one of those harvests does not match a harvest you can log against');
    }
  }
  const inserted = await sql`
    INSERT INTO kitchen_batch_input (
      batch_id, input_kind, harvest_log_id, label, qty, qty_unit, is_byproduct, note, created_by
    )
    SELECT ${batchId}::uuid, u.input_kind, u.harvest_log_id, u.label, u.qty, u.qty_unit,
           u.is_byproduct, u.note, ${userId}::text
    FROM unnest(
           ${rows.map((r) => r.input_kind)}::text[],
           ${rows.map((r) => r.harvest_log_id)}::uuid[],
           ${rows.map((r) => r.label)}::text[],
           ${rows.map((r) => r.qty)}::numeric[],
           ${rows.map((r) => r.qty_unit)}::text[],
           ${rows.map((r) => r.is_byproduct)}::boolean[],
           ${rows.map((r) => r.note)}::text[]
         ) AS u(input_kind, harvest_log_id, label, qty, qty_unit, is_byproduct, note)
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return { status: 201, body: { inserted: inserted.length, requested: rows.length } };
}

// The predicate form, and it is REQUIRED rather than a convenience. The measured fan-in for one
// five-week pepper mash is 139 harvest_log rows across 30 plantings; a 139-row hand-pick is a
// discoverability failure arriving through the schema.
//
// ONE STATEMENT: the window resolves inside the INSERT..SELECT, so there is no read-then-write gap in
// which a harvest could be logged, archived or re-owned. Household scope rides on harvest_log.created_by
// (see loadOwnedHarvestLogs), so a foreign harvest cannot enter through a slug either.
//
// The window is a CIVIL range in ET — the same zone every other date in this system is stamped in —
// because "the peppers I picked between the 3rd and the 10th" is a calendar claim, not an instant one.
//
// ONE HANDLER, ONE WHERE — the whole reason the dry run is shaped this way. A preview built on
// /api/harvests would enumerate a DIFFERENT row set from the one this inserts (that route takes an
// enum `timeframe`, not from/to, and has no variety_id), and nothing could catch the divergence: two
// Lambdas, no shared predicate module. Here the predicate is written ONCE, in the `matched` CTE, and
// the INSERT reads it. The preview arm and the commit arm are the SAME STATEMENT TEXT with one bound
// boolean different — `WHERE NOT ${preview}::boolean` — so a statement-text assertion that the two
// arms are byte-identical is a proof they bind an identical predicate, not an argument that they do.
// A data-modifying CTE always runs to completion, so on a preview the INSERT executes and selects
// zero rows: nothing lands, and `inserted` is honestly 0.
//
// `matched` is also what makes a retry honest. ON CONFLICT DO NOTHING is safe but SILENT: on a
// re-run after a dropped response `inserted` reads 0 while 139 rows are already present, which a
// client would render as "nothing added". Reporting both numbers lets it say the true thing.
async function addInputsByPredicate(sql, batchId, predicate, userId, householdIds, preview) {
  const cropSlug = normalizeText(predicate.crop_type_slug);
  const varietyId = predicate.variety_id ?? null;
  const plantId = predicate.plant_id ?? null;
  const rows = await sql`
    WITH matched AS (
      SELECT h.id
      FROM harvest_log h
      JOIN event_log e ON e.id = h.event_id AND e.deleted_at IS NULL
      LEFT JOIN garden_node gn ON gn.id = e.plant_id AND gn.deleted_at IS NULL
      LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
      WHERE h.created_by = ANY(${householdIds})
        AND h.deleted_at IS NULL
        AND (e.event_date AT TIME ZONE ${ET_TZ}::text)::date >= ${predicate.from}::date
        AND (e.event_date AT TIME ZONE ${ET_TZ}::text)::date <= ${predicate.to}::date
        AND (${plantId}::uuid IS NULL OR e.plant_id = ${plantId}::uuid)
        AND (${varietyId}::uuid IS NULL OR gn.cultivar_id = ${varietyId}::uuid)
        AND (${cropSlug}::text IS NULL OR cv.crop_type_slug = ${cropSlug}::text)
    ), added AS (
      INSERT INTO kitchen_batch_input (batch_id, input_kind, harvest_log_id, created_by)
      SELECT ${batchId}::uuid, 'harvest'::text, m.id, ${userId}::text
      FROM matched m
      WHERE NOT ${preview}::boolean
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    SELECT (SELECT count(*)::int FROM matched) AS matched_count,
           (SELECT count(*)::int FROM added) AS inserted_count
  `;
  const matched = rows[0]?.matched_count ?? 0;
  if (preview) return { status: 200, body: { matched, predicate } };
  return {
    status: 201,
    body: { inserted: rows[0]?.inserted_count ?? 0, matched, predicate },
  };
}

// DELETE /api/kitchen-batches/:id/inputs/:inputId lives in lineRoutes.js (takeOutLine) from release F:
// a pick line is still a hard delete; every other line is taken out (soft) and its draw reversed.

// POST /api/kitchen-batches/:id/close
//
// One of TWO writers of preservation_log.batch_id in this module — this and linkOutputs/unlinkOutput
// below, which exist because linking a jar used to require ENDING the batch. It remains absent from
// PRESERVATION_EDITABLE_COLUMNS (provenance.js:33), the declared single source of truth for four
// hand-lists — one of them, buildFullPayload, lives in the FRONTEND. If batch_id joined that list the
// full-replace PUT would let a "Mark used" tap from a service-worker-cached bundle NULL a batch's
// output link and return 200. Every writer of it is server-side and in this file; that is the
// invariant, not "exactly one route".
//
// ONE STATEMENT, and the ORDER of the CTEs is the whole point. `linked` and `finished` both read
// `closed`'s output, so a batch that is already closed, soft-deleted or not the caller's produces an
// empty `closed`, the preservation_log update touches nothing and no stage row is written. Written
// the other way round, a failed close would still have relabelled the jars.
//
// AND p.batch_id IS NULL — BUG-JARSTEAL-001. Without it, closing batch B with a jar already linked to
// batch A RE-POINTS it: 200, `linked_count` counts it, and A's output_count silently drops with no
// error and no record. The sibling collision (a jar that already cites a single harvest) fails LOUDLY
// via chk_preservation_log_one_provenance, which rolls the whole statement back and surfaces through
// kitchenErrorMessage. This one had no constraint behind it, so the conjunct IS the guard: an
// already-linked jar is now silently SKIPPED, and `linked_output_count` coming back below the number
// of ids sent is the client's signal — the same contract a foreign or soft-deleted id already had.
//
// THE `finished` STAGE ROW is written here rather than left to the client, and it carries
// cue_observed. The DDL's own rule is that every consequential transition is decided by an observed
// cue and not a clock, and recording only the instant records the less authoritative half. Written in
// the SAME statement so a close and its stage row cannot land apart — the createBatch idiom, and the
// neon HTTP driver cannot carry an id between two statements in one transaction anyway. It is written
// on every close, cue or no cue: the transition happened either way, and a NULL cue records that
// nobody said how they knew rather than inventing that they did.
async function closeBatch(sql, batchId, body, userId, householdIds) {
  const verr = validateClose(body);
  if (verr) return bad(verr);
  // B′ release 3: the close sheet's optional When dates the finished row (absent = the shipped now()).
  const when = closeWhenOf(body);
  if (when?.error) return bad(when.error);
  const outputIds = outputIdsIn(body);
  // Put-Up release 1b: `linked` writes preservation_log, which now carries an audit trigger, so the
  // statement rides a set_config in one transaction (V4 "Audit").
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
    sql`
    WITH closed AS (
      UPDATE kitchen_batch
      SET closed_at = NOW(),
          outcome = ${normalizeText(body.outcome)}::text,
          outcome_note = ${normalizeText(body.outcome_note)}::text,
          suspended_at = NULL
      WHERE id = ${batchId}::uuid
        AND user_id = ANY(${householdIds})
        AND deleted_at IS NULL
        AND closed_at IS NULL
      RETURNING id
    ), linked AS (
      UPDATE preservation_log p
      SET batch_id = c.id, updated_at = NOW()
      FROM closed c
      WHERE p.id = ANY(${outputIds}::uuid[])
        AND p.user_id = ANY(${householdIds})
        AND p.deleted_at IS NULL
        AND p.batch_id IS NULL
      RETURNING p.id
    ), finished AS (
      INSERT INTO kitchen_stage_log (batch_id, stage_kind, cue_observed, entered_at, entered_precision, created_by)
      SELECT c.id, 'finished'::text, ${normalizeText(body.cue_observed)}::text,
             CASE WHEN ${when != null}::boolean THEN ${when?.at ?? null}::timestamptz ELSE now() END,
             ${when?.precision ?? null}::text, ${userId}::text
      FROM closed c
      RETURNING id
    )
    SELECT (SELECT count(*)::int FROM closed) AS closed_count,
           (SELECT count(*)::int FROM linked) AS linked_count
  `,
  ]);
  if (!rows[0]?.closed_count) return { status: 409, body: { error: 'This batch is already closed' } };
  return {
    status: 200,
    body: {
      ...(await readBatch(sql, batchId, householdIds)),
      linked_output_count: rows[0].linked_count,
    },
  };
}

// POST /api/kitchen-batches/:id/reopen — UNCONDITIONAL, and no DDL.
//
// NULLs exactly KITCHEN_BATCH_CLOSE_COLUMNS, which is what close writes. Both halves of
// chk_kitchen_batch_close_pairing ((closed_at IS NULL) = (outcome IS NULL)) are cleared in the same
// statement, so the biconditional is satisfied; clearing closed_at alone would raise 23514 and
// surface as "closing a batch needs an outcome", which on a reopen would be actively misleading.
// chk_kitchen_batch_suspend_exclusive is strictly relaxed. outcome_note is outside the pairing and is
// cleared anyway, or it dangles as a note describing an outcome no longer recorded.
//
// NO output_count GATE, deliberately. A "reopen only while nothing is linked" rule reads as safety
// and is not: output_count is non-monotonic (soft-delete the jars and it falls to 0, so the gate
// opens through an action with nothing to do with reopening), and it forbids repair of the one
// EXPENSIVE mis-tap — closed as put_up with the wrong jars — while permitting the cheap one.
// DELETE /:id/outputs/:plid is the repair for a wrong link now, so the gate would protect nothing.
//
// IT ALSO DOES NOT UNLINK. Close is no longer the only writer of batch_id: a jar linked on an OPEN
// batch through POST /:id/outputs is a deliberate, standalone assertion, and a reopen that cleared
// every link would destroy it. Reopen inverts the CLOSE, not the linking.
//
// REOPEN RESUMES A PAUSED BATCH — stated, not silent. Close sets suspended_at = NULL (the CHECK
// requires it), so a paused batch that is closed and reopened comes back ACTIVE and moves out of the
// Paused group. Preserving the pause through a close would need a new kitchen_batch column, which
// forces a CREATE OR REPLACE VIEW and re-pins a frozen count gate, for no gain: a batch you closed by
// mistake is one you are picking back up. suspended_at is in KITCHEN_BATCH_EDITABLE_COLUMNS, so
// re-pausing is one PUT.
//
// Put-Up release 1b: the reopen also writes its 'reopened' stage row in the same statement (V4 Appendix
// A), so the log records it and Undo that put-up can see a lifecycle row written after a sitting.
async function reopenBatch(sql, batchId, userId, householdIds) {
  const rows = await sql`
    WITH b AS (
      UPDATE kitchen_batch
      SET closed_at = NULL,
          outcome = NULL,
          outcome_note = NULL
      WHERE id = ${batchId}::uuid
        AND user_id = ANY(${householdIds})
        AND deleted_at IS NULL
        AND closed_at IS NOT NULL
      RETURNING id
    ), r AS (
      INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, created_by)
      SELECT b.id, 'reopened'::text, now(), 'exact'::text, ${userId}::text FROM b
      RETURNING id
    )
    SELECT id FROM b
  `;
  // Mirrors closeBatch's 409 rather than a 404: the batch was found by loadOwnedBatch, so the only
  // reason the scoped UPDATE matched nothing is that it was not closed. (The TOCTOU window — a batch
  // soft-deleted between the gate and this statement — reports the same thing and is the one case
  // this message is wrong about, exactly as close's is.)
  if (!rows.length) return { status: 409, body: { error: 'This batch is not closed' } };
  return { status: 200, body: await readBatch(sql, batchId, householdIds) };
}

// POST /api/kitchen-batches/:id/outputs — link jars to a batch WITHOUT closing it.
//
// Same four predicates as close's `linked` CTE, for the same reasons, including
// `p.batch_id IS NULL`: a jar belongs to at most one batch and this route must not be the door
// BUG-JARSTEAL-001 came back through. An id that is foreign, soft-deleted, absent, or already linked
// is SILENTLY SKIPPED — the caller compares `linked` to `requested` and says so. Naming which id
// failed would be an existence oracle for another household's jars, the same reason the harvest gate
// reports a count.
//
// `requested` is the POST-DEDUPE length, matching the explicit inputs form's contract: a body naming
// one jar twice asked for one link.
async function linkOutputs(sql, batchId, body, userId, householdIds) {
  const verr = validateOutputsPayload(body);
  if (verr) return bad(verr);
  const ids = outputLogIdsIn(body);
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
    sql`
    UPDATE preservation_log p
    SET batch_id = ${batchId}::uuid, updated_at = NOW()
    WHERE p.id = ANY(${ids}::uuid[])
      AND p.user_id = ANY(${householdIds})
      AND p.deleted_at IS NULL
      AND p.batch_id IS NULL
    RETURNING p.id
  `,
  ]);
  return { status: 200, body: { linked: rows.length, requested: ids.length } };
}

// DELETE /api/kitchen-batches/:id/outputs/:plid — unlink one jar.
//
// Scoped by batch_id AS WELL AS id, the deleteInput idiom: a jar linked to another batch cannot be
// unlinked through a batch the caller does own. The household predicate is bound here rather than
// inherited from loadOwnedBatch, and it is `= ANY(householdIds)` rather than `= userId` so link and
// unlink are exactly symmetric — Dave can link Jen's jar to his batch, so he must be able to undo it.
//
// Put-Up release 1b: a jar that CAME FROM a put-up sitting (put_up_stage_id set) is refused with 409 —
// "undo that put-up" is its door (V4 API table). Without the refusal the UPDATE would raise 23514
// chk_preservation_log_put_up_stage_batch (a sitting's jar must keep its batch). JarPicker-linked jars
// unlink exactly as before. The snapshot CTE only tells "not here" (404) from "a put-up jar" (409).
//
// 404 rather than 200 when nothing matched, mirroring deleteInput: idempotent in STATE, not in
// status.
async function unlinkOutput(sql, batchId, plId, userId, householdIds) {
  if (!KITCHEN_UUID_RE.test(String(plId))) return notFound;
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
    sql`
    WITH stored AS (
      SELECT p.put_up_stage_id
      FROM preservation_log p
      WHERE p.id = ${plId}::uuid
        AND p.batch_id = ${batchId}::uuid
        AND p.user_id = ANY(${householdIds})
        AND p.deleted_at IS NULL
    ), unlinked AS (
      UPDATE preservation_log p
      SET batch_id = NULL, updated_at = NOW()
      WHERE p.id = ${plId}::uuid
        AND p.batch_id = ${batchId}::uuid
        AND p.user_id = ANY(${householdIds})
        AND p.deleted_at IS NULL
        AND p.put_up_stage_id IS NULL
      RETURNING p.id
    )
    SELECT (SELECT count(*)::int FROM stored) AS found_count,
           (SELECT count(*)::int FROM unlinked) AS unlinked_count
  `,
  ]);
  const r = rows[0] ?? {};
  if (r.unlinked_count) return { status: 200, body: { ok: true } };
  if (r.found_count) {
    return {
      status: 409,
      body: { error: 'This jar came from a put-up. Undo that put-up instead.', code: 'put_up_jar' },
    };
  }
  return notFound;
}

// ── Put-Up release 1b: Put it up, and Undo that put-up ────────────────────────────────────────────

// The sitting as both routes answer it: the put_up row, its live jars (the read projection plus where
// each went), its live lines, and the batch.
async function readSitting(sql, batchId, stageId, householdIds) {
  const stage = await sql`
    SELECT id, batch_id, stage_kind, label, amount, amount_unit, cue_observed, entered_at, entered_precision,
           ph_reading, ph_read_at, voids_id, storage_location_id, photo_id, note, created_by, created_at
    FROM kitchen_stage_log
    WHERE id = ${stageId}::uuid AND batch_id = ${batchId}::uuid
  `;
  const jars = await sql`
    SELECT p.*, s.label AS storage_label, s.kind AS storage_kind
    FROM preservation_log p
    LEFT JOIN storage_location s ON s.id = p.storage_location_id
    WHERE p.put_up_stage_id = ${stageId}::uuid
      AND p.batch_id = ${batchId}::uuid
      AND p.user_id = ANY(${householdIds})
      AND p.deleted_at IS NULL
    ORDER BY p.created_at, p.id
  `;
  // The sitting's live lines, in the one projection (lineRoutes.js readLines).
  const inputs = (await readLines(sql, batchId)).filter((l) => l.put_up_stage_id === stageId).map(publicLine);
  return {
    stage: stage[0] ?? null,
    jars: jars.map((r) => ({ ...projectRow(r), storage_label: r.storage_label ?? null, storage_kind: r.storage_kind ?? null })),
    inputs,
    batch: await readBatch(sql, batchId, householdIds),
  };
}

// The sitting already written under this key, household-scoped: 200 replayed with its read-back when
// it is THIS batch's; 409 key_conflict when the key belongs elsewhere; null when nothing holds it.
async function putUpReplay(sql, batchId, key, householdIds) {
  if (!KITCHEN_UUID_RE.test(String(key ?? ''))) return null;
  const prior = await sql`
    SELECT s.id, s.batch_id FROM kitchen_stage_log s
    JOIN v_kitchen_batch_current b ON b.id = s.batch_id
    WHERE s.idempotency_key = ${key}::uuid
      AND b.user_id = ANY(${householdIds})
  `;
  if (!prior.length) return null;
  if (prior[0].batch_id !== batchId) return keyConflict;
  return { status: 200, body: { replayed: true, ...(await readSitting(sql, batchId, prior[0].id, householdIds)) } };
}

// POST /api/kitchen-batches/:id/put-up — V4 "Put it up", contract-F §2.4 (1b half).
//
// ONE STATEMENT, keyed. Every row it writes hangs off the `gate` UPDATE of the batch (open, in the
// household, not deleted — the row lock that makes two sittings on one batch serialise, and the place
// the "finish" writes close the batch), so a batch that closed or went away in between writes nothing
// and answers 409 batch_closed. From `gate`: the put_up stage row (its idempotency_key is the event's
// key), the places found-or-created (household-first on lower(btrim(label)); a new one under the caller;
// the 1b UNIQUE's ON CONFLICT DO UPDATE returns the row a concurrent tap made), the jars, their lines,
// the 'noted' row for "Next time…", and the 'finished' row when it finishes. The plan (putUp.js) mints
// every id, so a line names its jar and a jar its place without a round trip.
//
// No ON CONFLICT on the keyed row: a retry after a lost response is a 23505 on uq_ksl_idempotency_key,
// which re-reads the sitting by its key (owner-scoped) and answers 200 replayed.
async function putUp(sql, batchId, body, userId, householdIds) {
  const verr = validatePutUp(body);
  if (verr) return bad(verr);
  const placeIds = putUpPlaceIds(body);
  const placeKinds = {};
  if (placeIds.length) {
    const found = await sql`
      SELECT id, kind FROM storage_location
      WHERE id = ANY(${placeIds}::uuid[])
        AND user_id = ANY(${householdIds})
        AND deleted_at IS NULL
    `;
    if (found.length !== placeIds.length) return bad('one of those places does not match a place you can use');
    for (const r of found) placeKinds[r.id] = r.kind;
  }
  // "Not sure" (V4 "Put it up"): the batch's latest dated event, never before its start. With no dated
  // event at all a coarse chip is required instead.
  const meta = await sql`
    SELECT b.label, rc.name AS recipe_name, rc.keeps_n, rc.keeps_unit, rc.keeps_storage_kind,
           to_char((GREATEST(
             (SELECT max(sl.entered_at) FROM kitchen_stage_log sl
               WHERE sl.batch_id = b.id AND sl.entered_at IS NOT NULL AND sl.stage_kind <> 'void'
                 AND NOT EXISTS (SELECT 1 FROM kitchen_stage_log v WHERE v.voids_id = sl.id)),
             b.started_at) AT TIME ZONE ${ET_TZ}::text)::date, 'YYYY-MM-DD') AS not_sure_day
    FROM v_kitchen_batch_current b
    -- Release 4: the batch's recipe keeps line (V4 §3.1's second rung), the household's and live only.
    LEFT JOIN recipe rc ON rc.id = b.recipe_id AND rc.user_id = ANY(${householdIds}) AND rc.deleted_at IS NULL
    WHERE b.id = ${batchId}::uuid AND b.user_id = ANY(${householdIds}) AND b.deleted_at IS NULL
  `;
  if (!meta.length) return notFound;
  if (body.when.precision === 'unknown' && meta[0].not_sure_day == null) {
    return bad("this batch has no date to count from yet — pick a rough time instead of 'Not sure'");
  }
  // A replay is decided before anything is checked against the jars (a retried draw that took the
  // last jar would otherwise meet jar_used_up instead of its own success).
  const replay = await putUpReplay(sql, batchId, body.idempotency_key, householdIds);
  if (replay) return replay;
  // Release F: every "added at the end" line resolved the way What went in resolves it (household
  // loaders, stamped labels, the pick's planting, the draw's stock mode), in body order.
  const prep = await prepareLines(sql, batchId, putUpLineBodies(body), householdIds, { sittingFixed: true });
  if (prep.refusal) return prep.refusal;
  const plan = planPutUp(body, {
    batchLabel: meta[0].label, notSureDay: meta[0].not_sure_day, placeKinds, newId: randomUUID,
    prepared: prep.rows,
    recipe: meta[0].keeps_n == null ? null : {
      name: meta[0].recipe_name, keeps_n: meta[0].keeps_n, keeps_unit: meta[0].keeps_unit,
      keeps_storage_kind: meta[0].keeps_storage_kind,
    },
  });
  const c = putUpColumns(plan);
  const drawnJars = [...new Set(plan.lines.map((l) => l.preservation_log_id).filter((v) => v != null))];
  let rows;
  try {
    [, rows] = await sql.transaction([
      sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
      sql`
      WITH gate AS (
        UPDATE kitchen_batch SET
          closed_at    = CASE WHEN ${body.finish}::boolean THEN now() ELSE closed_at END,
          outcome      = CASE WHEN ${body.finish}::boolean THEN 'put_up' ELSE outcome END,
          suspended_at = CASE WHEN ${body.finish}::boolean THEN NULL ELSE suspended_at END
        WHERE id = ${batchId}::uuid
          AND user_id = ANY(${householdIds})
          AND deleted_at IS NULL
          AND closed_at IS NULL
        RETURNING id
      ), stage AS (
        INSERT INTO kitchen_stage_log (
          id, batch_id, stage_kind, entered_at, entered_precision, amount, amount_unit, mash_in_g,
          idempotency_key, created_by
        )
        SELECT ${plan.stage.id}::uuid, g.id, 'put_up'::text, ${plan.stage.entered_at}::timestamptz,
               ${plan.stage.entered_precision}::text, ${plan.stage.made_g}::numeric,
               CASE WHEN ${plan.stage.made_g}::numeric IS NULL THEN NULL ELSE 'g' END,
               ${plan.stage.mash_in_g}::numeric,
               ${body.idempotency_key}::uuid, ${userId}::text
        FROM gate g
        RETURNING id, batch_id
      ), mass AS (
        SELECT m.unit, m.factor FROM unnest(${MASS_UNITS}::text[], ${MASS_FACTORS}::numeric[]) AS m(unit, factor)
      ), places_in AS (
        SELECT DISTINCT t.kind, t.label
        FROM unnest(${c.place.kind}::text[], ${c.place.label}::text[]) AS t(kind, label)
      ), found AS (
        SELECT DISTINCT ON (pi.kind, lower(pi.label)) pi.kind, lower(pi.label) AS lkey, sl.id
        FROM places_in pi
        JOIN storage_location sl
          ON sl.kind = pi.kind AND lower(btrim(sl.label)) = lower(pi.label)
         AND sl.user_id = ANY(${householdIds}) AND sl.deleted_at IS NULL
        ORDER BY pi.kind, lower(pi.label), (sl.user_id = ${userId}::text) DESC, sl.created_at, sl.id
      ), made AS (
        INSERT INTO storage_location (user_id, label, kind)
        SELECT ${userId}::text, pi.label, pi.kind
        FROM places_in pi
        WHERE EXISTS (SELECT 1 FROM stage)
          AND NOT EXISTS (SELECT 1 FROM found f WHERE f.kind = pi.kind AND f.lkey = lower(pi.label))
        ON CONFLICT (user_id, kind, lower(label)) WHERE deleted_at IS NULL
          DO UPDATE SET label = storage_location.label
        RETURNING id, kind, lower(label) AS lkey
      ), places AS (
        SELECT kind, lkey, id FROM found UNION ALL SELECT kind, lkey, id FROM made
      ), jars AS (
        -- A WEIGHED row (one container, a mass unit) is seeded with its grams, so a later draw moves
        -- remaining_amount from a real start (06 §1.4 "Seeding").
        INSERT INTO preservation_log (
          id, user_id, batch_id, put_up_stage_id, label, container_label, method,
          preserved_at, preserved_at_approx, preserved_at_precision,
          quantity_value, quantity_unit, package_count, remaining_count, remaining_amount, storage_location_id,
          use_by_target, use_by_basis, is_raw, in_oil, texture, ph_reading, ph_read_at,
          shu_est_low, shu_est_high, shu_est_basis, cooked
        )
        SELECT r.id, ${userId}::text, st.batch_id, st.id, r.label, r.container_label, ${body.method}::text,
               ${plan.jar_day}::date, ${plan.approx}::boolean, ${plan.jar_precision}::text,
               r.quantity_value, r.quantity_unit, r.package_count, r.package_count,
               CASE WHEN r.package_count = 1
                    THEN r.quantity_value * (SELECT factor FROM mass WHERE unit = r.quantity_unit) END,
               COALESCE(r.place_id, (SELECT pl.id FROM places pl
                                      WHERE pl.kind = r.place_kind AND pl.lkey = lower(r.place_label) LIMIT 1)),
               r.use_by_target, r.use_by_basis, r.is_raw, r.in_oil, r.texture, r.ph_reading, r.ph_read_at,
               r.shu_est_low, r.shu_est_high, r.shu_est_basis, r.cooked
        FROM stage st
        CROSS JOIN unnest(
          ${c.jar.id}::uuid[], ${c.jar.label}::text[], ${c.jar.container_label}::text[],
          ${c.jar.quantity_value}::numeric[], ${c.jar.quantity_unit}::text[], ${c.jar.package_count}::int[],
          ${c.jar.place_id}::uuid[], ${c.jar.place_kind}::text[], ${c.jar.place_label}::text[],
          ${c.jar.use_by_target}::date[], ${c.jar.use_by_basis}::text[],
          ${c.jar.is_raw}::boolean[], ${c.jar.in_oil}::boolean[], ${c.jar.texture}::text[],
          ${c.jar.ph_reading}::numeric[], ${c.jar.ph_read_at}::timestamptz[],
          ${c.jar.shu_est_low}::int[], ${c.jar.shu_est_high}::int[], ${c.jar.shu_est_basis}::text[],
          ${c.jar.cooked}::boolean[]
        ) AS r(id, label, container_label, quantity_value, quantity_unit, package_count,
               place_id, place_kind, place_label, use_by_target, use_by_basis,
               is_raw, in_oil, texture, ph_reading, ph_read_at, shu_est_low, shu_est_high, shu_est_basis, cooked)
        RETURNING id
      ), lines AS (
        INSERT INTO kitchen_batch_input (
          id, batch_id, input_kind, harvest_log_id, plant_id, preservation_log_id, crop_type_slug, label,
          source_label, qty, qty_unit, form, brand, note, shu_rating_low, shu_rating_high, role,
          put_up_stage_id, output_id, ordinal, idempotency_key, created_by
        )
        SELECT l.id, st.batch_id, l.input_kind, l.harvest_log_id, l.plant_id, l.preservation_log_id,
               l.crop_type_slug, l.label, l.source_label, l.qty, l.qty_unit, l.form, l.brand, l.note,
               l.shu_rating_low, l.shu_rating_high, l.role, st.id, l.output_id, l.ordinal,
               l.idempotency_key, ${userId}::text
        FROM stage st
        CROSS JOIN unnest(
          ${c.line.id}::uuid[], ${c.line.input_kind}::text[], ${c.line.harvest_log_id}::uuid[],
          ${c.line.plant_id}::uuid[], ${c.line.preservation_log_id}::uuid[], ${c.line.crop_type_slug}::text[],
          ${c.line.label}::text[], ${c.line.source_label}::text[], ${c.line.qty}::numeric[],
          ${c.line.qty_unit}::text[], ${c.line.form}::text[], ${c.line.brand}::text[], ${c.line.note}::text[],
          ${c.line.shu_rating_low}::int[], ${c.line.shu_rating_high}::int[], ${c.line.role}::text[],
          ${c.line.output_id}::uuid[], ${c.line.ordinal}::int[], ${c.line.idempotency_key}::uuid[]
        ) AS l(id, input_kind, harvest_log_id, plant_id, preservation_log_id, crop_type_slug, label,
               source_label, qty, qty_unit, form, brand, note, shu_rating_low, shu_rating_high, role,
               output_id, ordinal, idempotency_key)
        -- A row's line names its jar: reading jars orders this INSERT after that one.
        WHERE l.output_id IS NULL OR l.output_id IN (SELECT id FROM jars)
        RETURNING id, preservation_log_id, qty, qty_unit
      ), draws AS (
        SELECT i.id AS line_id, i.preservation_log_id, d.n,
               CASE WHEN d.weighed THEN i.qty * (SELECT factor FROM mass WHERE unit = i.qty_unit) END AS g
        FROM lines i
        JOIN unnest(${c.line.id}::uuid[], ${c.line.draw_count}::int[], ${c.line.draw_weighed}::boolean[])
          AS d(line_id, n, weighed) ON d.line_id = i.id
        WHERE i.preservation_log_id IS NOT NULL
      ), moved AS (
        -- Boss F1: ONE movement per drawn jar (the sitting refuses a jar named twice, and aggregates anyway).
        UPDATE preservation_log p SET
          remaining_count  = CASE WHEN a.n IS NOT NULL THEN COALESCE(p.remaining_count, p.package_count) - a.n
                                  WHEN a.g IS NOT NULL
                                   AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0
                                    THEN 0
                                  ELSE p.remaining_count END,
          remaining_amount = CASE WHEN a.g IS NOT NULL
                                    THEN COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g
                                  ELSE p.remaining_amount END,
          consumed_at      = CASE WHEN a.g IS NOT NULL
                                   AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0
                                    THEN COALESCE(p.consumed_at, now())
                                  ELSE p.consumed_at END,
          delta_at         = CASE WHEN a.n IS NOT NULL
                                    OR (a.g IS NOT NULL
                                        AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0)
                                    THEN now()
                                  ELSE p.delta_at END
        FROM (SELECT x.preservation_log_id, sum(x.n) AS n, sum(x.g) AS g
                FROM draws x GROUP BY x.preservation_log_id) a
        WHERE p.id = a.preservation_log_id
          AND p.user_id = ANY(${householdIds})
        RETURNING p.id
      ), uses AS (
        INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id)
        SELECT ${userId}::text, d.preservation_log_id, d.n, 'batch', d.line_id
        FROM draws d WHERE d.n IS NOT NULL
        RETURNING id
      ), noted AS (
        INSERT INTO kitchen_stage_log (batch_id, stage_kind, note, entered_at, entered_precision, created_by)
        SELECT st.batch_id, 'noted'::text, ${plan.stage.next_time}::text, now(), 'exact'::text, ${userId}::text
        FROM stage st
        WHERE ${plan.stage.next_time}::text IS NOT NULL
        RETURNING id
      ), finished AS (
        -- Written in the SAME statement as the put_up row, so it shares its created_at: that equality is
        -- how Undo that put-up finds "the finished row this sitting wrote" (no column links them).
        INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, created_by)
        SELECT st.batch_id, 'finished'::text, ${plan.stage.entered_at}::timestamptz,
               ${plan.stage.entered_precision}::text, ${userId}::text
        FROM stage st
        WHERE ${body.finish}::boolean
        RETURNING id
      )
      SELECT (SELECT count(*)::int FROM stage) AS stage_count,
             (SELECT count(*)::int FROM jars) AS jar_count,
             (SELECT count(*)::int FROM lines) AS line_count,
             (SELECT count(*)::int FROM moved) AS jars_drawn
    `,
    ]);
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'uq_ksl_idempotency_key') {
      return (await putUpReplay(sql, batchId, body.idempotency_key, householdIds)) ?? keyConflict;
    }
    if (err?.code === '23505' && err.constraint === 'uq_kbi_batch_harvest') {
      return { status: 409, body: { error: 'That pick is already in this batch.', code: 'already_in' } };
    }
    const r = await drawRefusal(err, sql, drawnJars, householdIds);
    if (r) return r;
    throw err;
  }
  if (!rows[0]?.stage_count) return { status: 409, body: BATCH_CLOSED };
  return { status: 201, body: await readSitting(sql, batchId, plan.stage.id, householdIds) };
}

// POST /api/kitchen-batches/:id/put-up/:stageId/undo — V4 "Undo that put-up", contract-F §2.4 (1b).
//
// ONE STATEMENT: void the sitting's put_up row and, if that sitting closed the batch, its finished row;
// soft-delete the sitting's jars and their lines (row lines and sitting lines alike — every line with
// this put_up_stage_id); reopen the batch ONLY if that sitting closed it and no lifecycle row (put_up,
// finished, failed, reopened, paused, resumed) was written after it — noted, tended, moved and void rows
// do not count, and a voided lifecycle row is not a row.
// REFUSED (409 put_up_in_use, with the jar ids) if any of the sitting's jars was drawn — in 1b: fewer
// left than were made, or marked used up; release F adds an unreversed use not from the sitting's own
// lines, and any live line anywhere drawing one of the jars (DS-I4). Release F also reverses the
// sitting's own lines' draws in this statement, aggregated per jar (boss condition F1).
// "The finished row this sitting wrote" is the finished row with the put_up row's created_at: both were
// inserted by one statement, so they share now() — and no other statement can produce that instant.
// A second Undo is a 23505 on uq_ksl_voids_id → 200 replayed (any household member).
// preservation_log is audited from 1b, so the statement rides a set_config in one transaction.
async function undoPutUp(sql, batchId, stageId, userId, householdIds) {
  if (!KITCHEN_UUID_RE.test(String(stageId))) return notFound;
  let rows;
  try {
    [, rows] = await sql.transaction([
      sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
      sql`
      WITH target AS (
        SELECT s.id, s.created_at
        FROM kitchen_stage_log s
        WHERE s.id = ${stageId}::uuid
          AND s.batch_id = ${batchId}::uuid
          AND s.stage_kind = 'put_up'
      ), sitting_jars AS (
        SELECT p.id, p.package_count, p.remaining_count, p.consumed_at
        FROM preservation_log p
        WHERE p.put_up_stage_id = ${stageId}::uuid
          AND p.batch_id = ${batchId}::uuid
          AND p.deleted_at IS NULL
      ), used AS (
        -- REFUSED if any of the sitting's jars was used. 1b: fewer left than made, or marked used up.
        -- F (06 §5.2, DS-I4): an unreversed pantry_use on them that is not from the sitting's own
        -- lines, or ANY live line anywhere drawing one of them (a weighed draw writes no use).
        SELECT j.id FROM sitting_jars j
        WHERE COALESCE(j.remaining_count, j.package_count) < j.package_count
           OR j.consumed_at IS NOT NULL
        UNION
        SELECT u.preservation_log_id FROM pantry_use u
        WHERE u.preservation_log_id IN (SELECT id FROM sitting_jars)
          AND u.count_used > 0
          AND NOT EXISTS (SELECT 1 FROM pantry_use r WHERE r.reverses_use_id = u.id)
          AND (u.kitchen_batch_input_id IS NULL
               OR u.kitchen_batch_input_id NOT IN (SELECT k.id FROM kitchen_batch_input k
                                                    WHERE k.put_up_stage_id = ${stageId}::uuid))
        UNION
        SELECT k.preservation_log_id FROM kitchen_batch_input k
        WHERE k.deleted_at IS NULL
          AND k.preservation_log_id IN (SELECT id FROM sitting_jars)
      ), go AS (
        SELECT t.id FROM target t WHERE NOT EXISTS (SELECT 1 FROM used)
      ), fin AS (
        SELECT f.id
        FROM kitchen_stage_log f
        JOIN target t ON f.created_at = t.created_at
        WHERE f.batch_id = ${batchId}::uuid
          AND f.stage_kind = 'finished'
          AND NOT EXISTS (SELECT 1 FROM kitchen_stage_log v WHERE v.voids_id = f.id)
      ), later AS (
        SELECT l.id
        FROM kitchen_stage_log l
        JOIN target t ON l.created_at > t.created_at
        WHERE l.batch_id = ${batchId}::uuid
          AND l.stage_kind = ANY(${KITCHEN_LIFECYCLE_KINDS}::text[])
          AND NOT EXISTS (SELECT 1 FROM kitchen_stage_log v WHERE v.voids_id = l.id)
      ), voids AS (
        INSERT INTO kitchen_stage_log (batch_id, stage_kind, voids_id, entered_at, entered_precision, created_by)
        SELECT ${batchId}::uuid, 'void'::text, x.id, now(), 'exact'::text, ${userId}::text
        FROM (SELECT id FROM go
              UNION ALL
              SELECT id FROM fin WHERE EXISTS (SELECT 1 FROM go)) x
        RETURNING voids_id
      ), gone_lines AS (
        UPDATE kitchen_batch_input i
        SET deleted_at = now()
        WHERE i.batch_id = ${batchId}::uuid
          AND i.put_up_stage_id = ${stageId}::uuid
          AND i.deleted_at IS NULL
          AND i.harvest_log_id IS NULL
          AND EXISTS (SELECT 1 FROM voids v WHERE v.voids_id = ${stageId}::uuid)
        RETURNING i.id, i.preservation_log_id, i.qty, i.qty_unit
      ), gone_picks AS (
        -- B′ release 3, BUG-ARCHIVESOFTDELBATCH-001: a pick added at this sitting is HARD-deleted, as
        -- take-out and "Remove this batch" do (06 §3.11-§3.12) — a soft-deleted pick line would pin its
        -- harvest_log row under the RESTRICT FK and turn a planting archive into a bare 23503.
        DELETE FROM kitchen_batch_input i
        WHERE i.batch_id = ${batchId}::uuid
          AND i.put_up_stage_id = ${stageId}::uuid
          AND i.harvest_log_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM voids v WHERE v.voids_id = ${stageId}::uuid)
        RETURNING i.id
      ), mass AS (
        SELECT m.unit, m.factor FROM unnest(${MASS_UNITS}::text[], ${MASS_FACTORS}::numeric[]) AS m(unit, factor)
      ), fwd AS (
        -- Release F (06 §5.2, QA-I9 / HS-I3): the sitting's own lines' draws are given back here.
        SELECT u.id, u.preservation_log_id, u.count_used, u.kitchen_batch_input_id
        FROM pantry_use u JOIN gone_lines l ON l.id = u.kitchen_batch_input_id
        WHERE u.count_used > 0
          AND NOT EXISTS (SELECT 1 FROM pantry_use r WHERE r.reverses_use_id = u.id)
      ), weighed AS (
        SELECT l.preservation_log_id, l.qty * (SELECT factor FROM mass WHERE unit = l.qty_unit) AS g
        FROM gone_lines l
        WHERE l.preservation_log_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pantry_use u WHERE u.kitchen_batch_input_id = l.id)
      ), rev AS (
        INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id, reverses_use_id)
        SELECT ${userId}::text, f.preservation_log_id, -f.count_used, 'batch', f.kitchen_batch_input_id, f.id
        FROM fwd f
        RETURNING id
      ), gone_jars AS (
        -- ONE UPDATE of preservation_log for the whole undo (boss F1): the sitting's jars are removed
        -- and the jars its lines drew are given back, each jar once, its movements summed first — the
        -- reaper bag drawn 8 g into the mash and 5 g at the bottling gets 13 g back, not 8 or 5.
        UPDATE preservation_log p SET
          deleted_at       = CASE WHEN a.remove THEN now() ELSE p.deleted_at END,
          remaining_count  = CASE WHEN a.n IS NOT NULL THEN COALESCE(p.remaining_count, p.package_count) + a.n
                                  WHEN a.g IS NOT NULL
                                   AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                   AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL)
                                    THEN p.package_count
                                  ELSE p.remaining_count END,
          remaining_amount = CASE WHEN a.g IS NOT NULL
                                    THEN COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) + a.g
                                  ELSE p.remaining_amount END,
          consumed_at      = CASE WHEN a.g IS NOT NULL
                                   AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                   AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL)
                                    THEN NULL
                                  ELSE p.consumed_at END,
          delta_at         = CASE WHEN a.n IS NOT NULL
                                    OR (a.g IS NOT NULL
                                        AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                        AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL))
                                    THEN now()
                                  ELSE p.delta_at END
        FROM (SELECT x.preservation_log_id, bool_or(x.remove) AS remove, sum(x.n) AS n, sum(x.g) AS g FROM (
                SELECT j.id AS preservation_log_id, true AS remove, NULL::int AS n, NULL::numeric AS g
                FROM sitting_jars j
                WHERE EXISTS (SELECT 1 FROM voids v WHERE v.voids_id = ${stageId}::uuid)
                UNION ALL
                SELECT f.preservation_log_id, false, f.count_used, NULL::numeric FROM fwd f
                UNION ALL
                SELECT w.preservation_log_id, false, NULL::int, w.g FROM weighed w
              ) x GROUP BY x.preservation_log_id) a
        WHERE p.id = a.preservation_log_id
        RETURNING p.id, a.remove
      ), reopened AS (
        UPDATE kitchen_batch b
        SET closed_at = NULL, outcome = NULL, outcome_note = NULL
        WHERE b.id = ${batchId}::uuid
          AND b.closed_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM fin)
          AND NOT EXISTS (SELECT 1 FROM later)
          AND EXISTS (SELECT 1 FROM voids v WHERE v.voids_id = ${stageId}::uuid)
        RETURNING b.id
      )
      SELECT (SELECT count(*)::int FROM target) AS found_count,
             (SELECT array_agg(id) FROM used) AS used_jar_ids,
             (SELECT count(*)::int FROM voids) AS voided_count,
             (SELECT count(*)::int FROM gone_jars WHERE remove) AS jars_removed,
             (SELECT count(*)::int FROM rev) AS uses_reversed,
             (SELECT count(*)::int FROM gone_lines) AS lines_removed,
             (SELECT count(*)::int FROM reopened) AS reopened_count
    `,
    ]);
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'uq_ksl_voids_id') {
      return {
        status: 200,
        body: { ok: true, replayed: true, reopened: false, batch: await readBatch(sql, batchId, householdIds) },
      };
    }
    throw err;
  }
  const r = rows[0] ?? {};
  if (!r.found_count) return notFound;
  if (r.used_jar_ids?.length) return { status: 409, body: putUpInUse(r.used_jar_ids) };
  return {
    status: 200,
    body: { ok: true, reopened: r.reopened_count > 0, batch: await readBatch(sql, batchId, householdIds) },
  };
}
