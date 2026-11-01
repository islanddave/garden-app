// /api/preservation/:id/sources (V5-PUTUPMULTISOURCE-001).
//
// The database half: every decision lives in putUpSources.js; this file loads, writes and scopes. It imports
// only dependency-free siblings and takes `sql` as an argument, so vitest can RUN it (the property that
// lets kitchenRoutes.test.js assert bound parameters rather than spelling); index.js cannot be imported by a
// test, so the routes live here and index.js only delegates.
//
// TWO ROUTES, deliberately: GET reads the list; PUT replaces it whole. No POST-one, no DELETE-one:
//   * A whole-list PUT makes "I mistyped ingredient 3" one well-defined request. A per-row API makes the
//     CLIENT compute a diff against a list it may hold staler than it thinks (the predicate add on
//     kitchen_batch_input "discards its RETURNING ids so even a targeted undo needs a full before/after
//     GET diff").
//   * The replace is a SOFT delete of the previous set plus an insert of the new one in one transaction.
//     Ordinals are reassigned from array position every time, so uq_ps_parent_ordinal (partial on
//     deleted_at IS NULL) always sees exactly one row per slot.
//
// THE PARENT CACHE IS WRITTEN IN THE SAME REQUEST AS THE CHILDREN, ALWAYS.
// migrations/v5-putupmultisource-001/0a-additive-ddl.sql D1 leaves preservation_log unmigrated by
// re-reading its source columns as a mirror of the ordinal-0 child. If this handler wrote the children
// without the parent, the mirror would go stale silently, because nothing reads the two together.
// `parentCache` is called on every PUT, including the one that ends with an empty list.
//
// Scoping: `= ANY(householdIds)` on every predicate, never `= userId`. The ownership loader returns null for
// absent / malformed / out-of-household / soft-deleted alike: "not found" vs "forbidden" is a distinction
// worth having only to an attacker.
import { withActor } from './audit-actor.js';
import {
  PS_ORDER, PS_WRITABLE_COLUMNS, normalizeSourceRows, parentCache,
} from './putUpSources.js';
// The batch household loaders for the two garden pointers a row may carry (pantryRoutes.js imports the same
// module, so it already loads under vitest).
import { loadPlantings, loadPicks } from './lineRoutes.js';
import { warnRejectedFk } from './household.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = { status: 404, body: { error: 'Not found' } };
const notAllowed = { status: 405, body: { error: 'Method not allowed' } };

// /api/preservation/{uuid}/sources and NOTHING ELSE. Null for every other path lets index.js delegate this
// FIRST without disturbing the literal sub-routes ('whats-put-up', 'use-soon') that must be checked before
// /api/preservation/:id. The uuid shape is tested HERE rather than at the loader so a typo shape like
// /api/preservation/whats-put-up/sources falls through to the existing 404.
export function parseSourceRoute(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const m = path.match(/^\/api\/preservation\/([^/]+)\/sources$/);
  if (!m) return null;
  if (!UUID_RE.test(m[1])) return null;
  return { kind: 'sources', id: m[1] };
}

// Uniform contract, from index.js and kitchenRoutes.js: the row on success, null on ANY failure. Reads
// preservation_log directly (no view).
async function loadOwnedPutUp(sql, id, householdIds) {
  if (!UUID_RE.test(String(id))) return null;
  const rows = await sql`
    SELECT id, user_id FROM preservation_log
    WHERE id = ${id}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// The live sources of one jar, in ordinal order. Columns are named rather than SELECT *, so a column added
// later must be added to the read deliberately (which also lets preservation-source-columns.test.js's L-081
// contract see the read surface).
async function listSources(sql, putUpId, householdIds) {
  const rows = await sql`
    SELECT id, preservation_log_id, ordinal, source_kind, source_label, display_label,
           provenance_grade, crop_type_slug, variety_id, plant_id, harvest_log_id,
           quantity_value, quantity_unit, note, created_at, updated_at
    FROM preservation_source
    WHERE preservation_log_id = ${putUpId}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
    ORDER BY ordinal ASC, id ASC
  `;
  return { status: 200, body: { sources: rows } };
}

// sourceRowError proves only the uuid SHAPE of plant_id / harvest_log_id. This proves each one is the
// household's, then that the row agrees with what it points at. It runs BEFORE the soft-delete, so a
// refusal writes nothing and the existing list survives. A miss answers the same generic sentence for a
// foreign, absent or deleted id (no existence oracle) and goes to CloudWatch through warnRejectedFk. Two
// batch reads cover the whole list; a list with no garden pointers issues none. Ids are compared
// lower-cased: the shape check is case-insensitive and Postgres returns lower case.
async function gardenPointerError(sql, rows, userId, householdIds) {
  const lc = (v) => (v == null ? null : String(v).toLowerCase());
  const distinct = (col) => [...new Set(rows.map((r) => lc(r[col])).filter((v) => v != null))];
  const plantings = new Map(
    (await loadPlantings(sql, distinct('plant_id'), householdIds)).map((p) => [lc(p.id), p]),
  );
  const picks = new Map(
    (await loadPicks(sql, distinct('harvest_log_id'), householdIds)).map((h) => [lc(h.id), h]),
  );
  for (const r of rows) {
    const at = `source ${r.ordinal + 1}`;
    const plantId = lc(r.plant_id);
    const pickId = lc(r.harvest_log_id);
    const planting = plantId == null ? null : plantings.get(plantId);
    const pick = pickId == null ? null : picks.get(pickId);
    if (plantId != null && !planting) {
      warnRejectedFk(userId, 'preservation_source', 'plant_id', r.plant_id);
      return `${at}: that planting / pick does not match one you can use`;
    }
    if (pickId != null && !pick) {
      warnRejectedFk(userId, 'preservation_source', 'harvest_log_id', r.harvest_log_id);
      return `${at}: that planting / pick does not match one you can use`;
    }
    // The pantryRoutes.js rule: refused only when both sides name a crop and they differ.
    if (planting && r.crop_type_slug != null && planting.crop_type_slug != null
        && r.crop_type_slug !== planting.crop_type_slug) {
      return `${at}: that planting is a different crop`;
    }
    // Only when the row names both: a pick alone is a complete pointer, and is not refused for
    // lacking a planting.
    if (planting && pick && lc(pick.plant_id) !== plantId) {
      return `${at}: that pick is from a different planting`;
    }
  }
  return null;
}

// The whole-list replace. Order of statements is load-bearing:
//   1. soft-delete the current set: frees every ordinal before any is reused, so the partial unique index
//      cannot collide with a row on its way out (inserting first would make replacing [A,B] with [B,A] a
//      23505 on ordinal 0);
//   2. insert the new set;
//   3. write the parent cache from ordinal 0.
//
// All three run in ONE sql.transaction, in that order, behind the actor GUC. Every value is known before the
// batch is built (rows normalized, garden pointers checked, parent cache computed from the rows, not read
// back), so nothing has to run between the statements. A failure anywhere (a nonexistent variety_id is only
// shape-checked, so row k can 23503) rolls the whole replace back and the old list stays live. Refusals
// (400) all happen before the batch, so a refused PUT writes nothing.
async function replaceSources(sql, putUp, body, userId, householdIds) {
  const submitted = body?.sources;

  const softDelete = () => sql`
      UPDATE preservation_source SET deleted_at = NOW()
      WHERE preservation_log_id = ${putUp.id}::uuid
        AND user_id = ANY(${householdIds})
        AND deleted_at IS NULL
    `;

  // An explicit empty list is a legitimate request: "I do not know what went into this after all." It
  // clears the children AND the parent cache; normalizeSourceRows refuses [] so this branch has to be
  // written on purpose.
  if (Array.isArray(submitted) && submitted.length === 0) {
    const cache = parentCache([]);
    // preservation_log carries trg_audit_preservation_log_upd, so its writes ride the actor GUC in one
    // transaction (lambda/audit-actor-guc.test.js), whether or not this statement touches a watched column.
    await withActor(sql, userId, () => [
      softDelete(),
      sql`
      UPDATE preservation_log
      SET source_kind = ${cache.source_kind}::text,
          source_label = ${cache.source_label}::text,
          plant_id = ${cache.plant_id}::uuid,
          harvest_log_id = ${cache.harvest_log_id}::uuid,
          updated_at = NOW()
      WHERE id = ${putUp.id}::uuid
        AND user_id = ANY(${householdIds})
    `,
    ]);
    return { status: 200, body: { sources: [], cleared: true } };
  }

  const { error, rows } = normalizeSourceRows(submitted);
  if (error) return { status: 400, body: { error } };

  const refused = await gardenPointerError(sql, rows, userId, householdIds);
  if (refused) return { status: 400, body: { error: refused } };

  // Step 3. Unconditional and total: the source, label and garden-pointer columns are assigned nulls
  // included. A COALESCE-preserving update would retain a plant_id from a previous edit whose source row is
  // now soft-deleted (the "false-provenance generator" shape).
  const cache = parentCache(rows);
  await withActor(sql, userId, () => [
    softDelete(),
    // EVERY NULL PARAMETER CARRIES AN EXPLICIT ::cast. Neon cannot infer a type for a null bound parameter and
    // answers `could not determine data type of parameter`, a 500 not a 400, and only for rows that omit a
    // column. Bought-ingredient rows omit four at once, so this is the COMMON path.
    // user_id is copied from the PARENT rather than the caller: a household member editing another member's
    // jar must not silently re-own its sources.
    ...rows.map((r) => sql`
      INSERT INTO preservation_source
        (preservation_log_id, user_id, ordinal, source_kind, source_label, display_label,
         provenance_grade, crop_type_slug, variety_id, plant_id, harvest_log_id,
         quantity_value, quantity_unit, note)
      VALUES
        (${putUp.id}::uuid, ${putUp.user_id}::text, ${r.ordinal}::smallint,
         ${r.source_kind}::text, ${r.source_label}::text, ${r.display_label}::text,
         ${r.provenance_grade}::text, ${r.crop_type_slug}::text, ${r.variety_id}::uuid,
         ${r.plant_id}::uuid, ${r.harvest_log_id}::uuid,
         ${r.quantity_value}::numeric, ${r.quantity_unit}::text, ${r.note}::text)
    `),
    sql`
    UPDATE preservation_log
    SET source_kind = ${cache.source_kind}::text,
        source_label = ${cache.source_label}::text,
        plant_id = ${cache.plant_id}::uuid,
        harvest_log_id = ${cache.harvest_log_id}::uuid,
        crop_type_slug = COALESCE(${cache.crop_type_slug}::text, crop_type_slug),
        variety_id = COALESCE(${cache.variety_id}::uuid, variety_id),
        updated_at = NOW()
    WHERE id = ${putUp.id}::uuid
      AND user_id = ANY(${householdIds})
  `,
  ]);
  // crop_type_slug / variety_id are the ONE pair written with COALESCE, deliberately:
  // chk_preservation_log_attribution requires at least one non-null, so an all-bought source list (neither)
  // would otherwise null the jar's own crop and 23514 the update. The jar's crop is a fact about the JAR,
  // set at creation, not derived from its ingredients.

  return listSources(sql, putUp.id, householdIds);
}

export async function handleSourceRoute({ sql, rawPath, method, rawBody, userId, householdIds }) {
  const route = parseSourceRoute(rawPath);
  if (!route) return null;
  // userId is not a scope (household scoping covers that): it is the actor the preservation_log writes set
  // for the audit trigger. It arrives in the same argument object index.js passes handleKitchenRoute, since
  // two near-identical call sites with different shapes is how one drifts.

  const putUp = await loadOwnedPutUp(sql, route.id, householdIds);
  if (!putUp) return notFound;

  if (method === 'GET') return listSources(sql, putUp.id, householdIds);
  if (method === 'PUT') {
    let body;
    try {
      body = JSON.parse(rawBody ?? '{}');
    } catch {
      return { status: 400, body: { error: 'Body must be valid JSON' } };
    }
    return replaceSources(sql, putUp, body, userId, householdIds);
  }
  return notAllowed;
}

// The CHECKs on preservation_source, given words. Consulted by index.js's error mapper so a 23514 that
// slips past validateCreate reads as a sentence. Returns null for anything not ours, so the mappers below
// it are reached unchanged.
export function sourceErrorMessage(err) {
  if (!err || err.code !== '23514') return null;
  const c = err.constraint;
  if (c === 'chk_ps_garden_only') {
    return 'A bought or foraged ingredient cannot be linked to a planting or a pick.';
  }
  if (c === 'chk_ps_source_kind') return 'That is not a source this app knows.';
  if (c === 'chk_ps_provenance_grade') return 'That is not a provenance level this app knows.';
  if (c === 'chk_ps_label_nonblank' || c === 'chk_ps_label_len') {
    return 'Every ingredient needs a name, 120 characters or fewer.';
  }
  if (c === 'chk_ps_source_label_nonblank' || c === 'chk_ps_source_label_len') {
    return 'A vendor name must not be blank, and must be 120 characters or fewer.';
  }
  if (c === 'chk_ps_qty_pairing') return 'An amount needs a unit, and a unit needs an amount.';
  if (c === 'chk_ps_qty_positive') return 'An amount must be greater than zero.';
  if (c === 'chk_ps_qty_unit') return 'That is not a unit this app knows.';
  if (c === 'chk_ps_ordinal_nonneg') return 'Source positions start at zero.';
  return null;
}

// Re-exported so the columns contract and the route tests read the allowlist from one place.
export { PS_WRITABLE_COLUMNS, PS_ORDER };
