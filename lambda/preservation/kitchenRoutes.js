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
import { loadOwnedPhoto } from './household.js';
import { ET_TZ } from './useBy.js';
import {
  KITCHEN_UUID_RE, parseKitchenRoute, parseBatchState, normalizeText,
  validateBatchCreate, validateBatchUpdate, batchUpdatePatch,
  validateStage, validateInputPayload, normalizeInputRows, harvestIdsIn,
  validateClose, outputIdsIn,
} from './kitchenBatch.js';

const notFound = { status: 404, body: { error: 'Not found' } };
const notAllowed = { status: 405, body: { error: 'Method not allowed' } };
const bad = (error) => ({ status: 400, body: { error } });

// ── ownership loaders ────────────────────────────────────────────────────────────────────────────
// Uniform contract, lifted from index.js: return the row on success, null on ANY failure — absent id,
// malformed id, out-of-household, soft-deleted. Callers answer a null with the SAME generic response
// they would give a malformed id, never "not found" vs "forbidden": that distinction is itself a leak.

// Reads the VIEW, not kitchen_batch, so even the ownership gate has one derivation. closed_at and
// suspended_at ride along because two routes branch on them.
async function loadOwnedBatch(sql, batchId, householdIds) {
  if (!KITCHEN_UUID_RE.test(String(batchId))) return null;
  const rows = await sql`
    SELECT id, closed_at, suspended_at FROM v_kitchen_batch_current
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
    if (method === 'GET') return listBatches(sql, q, householdIds);
    if (method === 'POST') return createBatch(sql, parseBody(), userId, householdIds);
    return notAllowed;
  }

  const batch = await loadOwnedBatch(sql, route.id, householdIds);
  if (!batch) return notFound;

  if (route.kind === 'batch') {
    if (method === 'GET') return getBatch(sql, batch.id, householdIds);
    if (method === 'PUT') return updateBatch(sql, batch.id, parseBody(), householdIds);
    if (method === 'DELETE') return deleteBatch(sql, batch.id, householdIds);
    return notAllowed;
  }
  if (route.kind === 'stages') {
    if (method === 'POST') return addStage(sql, batch.id, parseBody(), userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'inputs') {
    if (method === 'POST') return addInputs(sql, batch.id, parseBody(), userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'input') {
    if (method === 'DELETE') return deleteInput(sql, batch.id, route.inputId);
    return notAllowed;
  }
  if (route.kind === 'close') {
    if (method === 'POST') return closeBatch(sql, batch.id, parseBody(), householdIds);
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

// GET /api/kitchen-batches/:id — the view row plus its inputs and its stage log.
//
// Both child lists are ordered newest-first with an `id DESC` tiebreak. On the stage log that
// tiebreak is load-bearing: two rows written in one statement tie on entered_at AND created_at, and a
// "topped up + skimmed" double-tap produces exactly that. It matches idx_ksl_batch, so the ordering is
// the index rather than a sort.
async function getBatch(sql, batchId, householdIds) {
  const row = await readBatch(sql, batchId, householdIds);
  if (!row) return notFound;
  const inputs = await sql`
    SELECT id, batch_id, input_kind, harvest_log_id, label, qty, qty_unit, is_byproduct,
           added_at, note, created_by, created_at
    FROM kitchen_batch_input
    WHERE batch_id = ${batchId}::uuid
    ORDER BY added_at DESC, id DESC
  `;
  // ph_reading / ph_read_at ride the same projection (V5-PHRECORD-001). This list IS the reading
  // history: one dated line per row, in the order they were logged, with no count, streak, run or
  // any other aggregate over them — a batch that never acidified produces an unbroken sequence of
  // rows, so a summary of them would turn absent failure signs into apparent success.
  const stages = await sql`
    SELECT id, batch_id, stage_kind, label, amount, amount_unit, cue_observed, entered_at,
           ph_reading, ph_read_at,
           storage_location_id, photo_id, note, created_by, created_at
    FROM kitchen_stage_log
    WHERE batch_id = ${batchId}::uuid
    ORDER BY entered_at DESC, id DESC
  `;
  return { status: 200, body: { ...row, inputs, stages } };
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
  const kind = normalizeText(body.kind);
  const rows = await sql`
    WITH b AS (
      INSERT INTO kitchen_batch (
        user_id, label, kind, kind_other, started_at, start_precision,
        start_anchor_kind, start_anchor_id, expected_days_min, expected_days_max,
        brine_note, cover_photo_id, notes
      ) VALUES (
        ${userId}::text, ${normalizeText(body.label)}::text, ${kind}::text,
        ${kind === 'other' ? normalizeText(body.kind_other) : null}::text,
        ${body.started_at ?? null}::timestamptz, ${normalizeText(body.start_precision)}::text,
        ${normalizeText(body.start_anchor_kind)}::text, ${body.start_anchor_id ?? null}::uuid,
        ${body.expected_days_min ?? null}::integer, ${body.expected_days_max ?? null}::integer,
        ${normalizeText(body.brine_note)}::text, ${body.cover_photo_id ?? null}::uuid,
        ${normalizeText(body.notes)}::text
      ) RETURNING id
    ), s AS (
      INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, photo_id, created_by)
      SELECT b.id, 'started'::text, COALESCE(${body.started_at ?? null}::timestamptz, now()),
             ${body.cover_photo_id ?? null}::uuid, ${userId}::text
      FROM b
      RETURNING id
    )
    SELECT id FROM b
  `;
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
// updated_at is NOT set here: kitchen_batch carries the set_updated_at trigger the preservation family
// lacks. Setting it by hand would be a second writer for a value that already has one.
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
      suspended_at      = CASE WHEN ${present.suspended_at}::boolean      THEN ${value.suspended_at}::timestamptz ELSE suspended_at END
    WHERE id = ${batchId}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
    RETURNING id
  `;
  if (!rows.length) return notFound;
  return { status: 200, body: await readBatch(sql, batchId, householdIds) };
}

// DELETE /api/kitchen-batches/:id — soft delete. The view already filters deleted_at, so the row
// leaves every read surface in the same statement.
async function deleteBatch(sql, batchId, householdIds) {
  const rows = await sql`
    UPDATE kitchen_batch
    SET deleted_at = NOW()
    WHERE id = ${batchId}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
    RETURNING id
  `;
  if (!rows.length) return notFound;
  return { status: 200, body: { ok: true } };
}

// POST /api/kitchen-batches/:id/stages — append-only.
//
// There is no PUT and no DELETE on a stage row, and that absence is the design: the off-log repair
// path is exactly what produced the seed-lot divergence this schema refuses to copy. A mistake is
// corrected by appending the correction, which is also what makes the log readable afterwards.
//
// A stage may be appended to a CLOSED batch on purpose. "It went mouldy in the jar three weeks later"
// is a fact about the process, and refusing it would push it into a note nothing can read.
async function addStage(sql, batchId, body, userId, householdIds) {
  const verr = validateStage(body);
  if (verr) return bad(verr);
  if (body.storage_location_id) {
    const loc = await loadOwnedStorageLocation(sql, body.storage_location_id, householdIds);
    if (!loc) return bad('storage_location_id does not match a storage location you can use');
  }
  if (body.photo_id) {
    const ph = await loadOwnedPhoto(sql, body.photo_id, householdIds);
    if (!ph) return bad('photo_id does not match a photo you can use');
  }
  // ph_reading IS NOT NORMALIZED AND IS NOT COERCED (V5-PHRECORD-001). It reaches the ::numeric cast
  // as the exact string the client sent, because a Number round-trip drops a trailing zero the meter
  // displayed, and Postgres preserves the scale of the literal it is given — so a value typed with a
  // trailing digit reads back with it.
  // ph_read_at has NO COALESCE, unlike entered_at directly above: entered_at legitimately defaults to
  // "now, because that is when you logged it", while a defaulted read-time would stamp an instant
  // onto a measurement nobody took then. validateStage has already forced the pair to travel
  // together, and chk_ksl_ph_pairing is the backstop behind it.
  const rows = await sql`
    INSERT INTO kitchen_stage_log (
      batch_id, stage_kind, label, amount, amount_unit, cue_observed,
      entered_at, ph_reading, ph_read_at, storage_location_id, photo_id, note, created_by
    ) VALUES (
      ${batchId}::uuid, ${normalizeText(body.stage_kind)}::text, ${normalizeText(body.label)}::text,
      ${body.amount ?? null}::numeric, ${normalizeText(body.amount_unit)}::text,
      ${normalizeText(body.cue_observed)}::text,
      COALESCE(${body.entered_at ?? null}::timestamptz, now()),
      ${body.ph_reading ?? null}::numeric, ${body.ph_read_at ?? null}::timestamptz,
      ${body.storage_location_id ?? null}::uuid, ${body.photo_id ?? null}::uuid,
      ${normalizeText(body.note)}::text, ${userId}::text
    ) RETURNING id, batch_id, stage_kind, label, amount, amount_unit, cue_observed, entered_at,
               ph_reading, ph_read_at,
               storage_location_id, photo_id, note, created_by, created_at
  `;
  // The batch rides along because appending a stage is the one write that changes the view's derived
  // columns, and the card that issued it renders from exactly those.
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
  if (body.predicate) return addInputsByPredicate(sql, batchId, body.predicate, userId, householdIds);

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
async function addInputsByPredicate(sql, batchId, predicate, userId, householdIds) {
  const cropSlug = normalizeText(predicate.crop_type_slug);
  const varietyId = predicate.variety_id ?? null;
  const plantId = predicate.plant_id ?? null;
  const inserted = await sql`
    INSERT INTO kitchen_batch_input (batch_id, input_kind, harvest_log_id, created_by)
    SELECT ${batchId}::uuid, 'harvest'::text, h.id, ${userId}::text
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
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return { status: 201, body: { inserted: inserted.length, predicate } };
}

// DELETE /api/kitchen-batches/:id/inputs/:inputId — a hard delete, because kitchen_batch_input has no
// deleted_at: the link is not a record of an event, it is an assertion about what is in the pot, and a
// retracted assertion has nothing to preserve. Scoped by batch_id as well as id so an input id from
// another batch cannot be deleted through a batch the caller does own.
async function deleteInput(sql, batchId, inputId) {
  if (!KITCHEN_UUID_RE.test(String(inputId))) return notFound;
  const rows = await sql`
    DELETE FROM kitchen_batch_input
    WHERE id = ${inputId}::uuid
      AND batch_id = ${batchId}::uuid
    RETURNING id
  `;
  if (!rows.length) return notFound;
  return { status: 200, body: { ok: true } };
}

// POST /api/kitchen-batches/:id/close
//
// THE ONLY WRITER OF preservation_log.batch_id. That column is deliberately absent from
// PRESERVATION_EDITABLE_COLUMNS (provenance.js:33), which is the declared single source of truth for
// four hand-lists — one of them, buildFullPayload, lives in the FRONTEND. If batch_id joined it, the
// full-replace PUT would let a "Mark used" tap from a service-worker-cached bundle NULL a batch's
// output link and return 200.
//
// ONE STATEMENT, and the ORDER of the two CTEs is the whole point. `linked` reads `closed`'s output, so
// a batch that is already closed, soft-deleted or not the caller's produces an empty `closed` and the
// preservation_log update touches nothing. Written the other way round, a failed close would still
// have relabelled the jars.
//
// A jar that already cites a single harvest raises chk_preservation_log_one_provenance, which rolls the
// whole statement back and surfaces through kitchenErrorMessage — the close FAILS rather than silently
// linking fewer jars than were asked for.
async function closeBatch(sql, batchId, body, householdIds) {
  const verr = validateClose(body);
  if (verr) return bad(verr);
  const outputIds = outputIdsIn(body);
  const rows = await sql`
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
      RETURNING p.id
    )
    SELECT (SELECT count(*)::int FROM closed) AS closed_count,
           (SELECT count(*)::int FROM linked) AS linked_count
  `;
  if (!rows[0]?.closed_count) return { status: 409, body: { error: 'This batch is already closed' } };
  return {
    status: 200,
    body: {
      ...(await readBatch(sql, batchId, householdIds)),
      linked_output_count: rows[0].linked_count,
    },
  };
}
