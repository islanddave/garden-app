// lambda/preservation/sourceRoutes.js
// V5-PUTUPMULTISOURCE-001 (BD-058) — /api/preservation/:id/sources.
//
// The database half. Every decision lives in putUpSources.js; this file loads, writes and scopes.
// It imports only dependency-free siblings and takes `sql` as an argument, so vitest can import and
// RUN it — the same property that lets kitchenRoutes.test.js assert bound parameters rather than
// spelling. index.js cannot be imported by a test (module-scope @neondatabase/serverless and
// @clerk/backend), which is why the routes live here and index.js only delegates.
//
// TWO ROUTES, deliberately. GET reads the list; PUT replaces it whole. There is no POST-one and no
// DELETE-one:
//   * A whole-list PUT makes "I mistyped ingredient 3" a single well-defined request. The per-row
//     alternative makes the CLIENT compute a diff against a list it may be holding staler than it
//     thinks, and kitchen_batch_input's own per-row add already carries the scar — its predicate
//     form "discards its RETURNING ids so even a targeted undo needs a full before/after GET diff"
//     (kitchenBatch.js:100-106).
//   * The replace is a SOFT delete of the previous set plus an insert of the new one, in ONE
//     statement pair inside one request. Ordinals are reassigned from array position every time, so
//     uq_ps_parent_ordinal (partial on deleted_at IS NULL) always sees exactly one row per slot.
//
// ⚠ THE PARENT CACHE IS WRITTEN IN THE SAME REQUEST AS THE CHILDREN, ALWAYS.
// migrations/v5-putupmultisource-001/0a-additive-ddl.sql D1 leaves preservation_log unmigrated by
// re-reading its source columns as a mirror of the ordinal-0 child. If this handler ever wrote the
// children without the parent, the mirror would be stale and the design's central claim would be
// false — silently, because nothing reads the two together. `parentCache` is called on every PUT,
// including the one that ends with an empty list.
//
// SCOPING: `= ANY(householdIds)` on every predicate, never `= userId`, matching every other handler
// in this directory. The ownership loader returns null for absent / malformed / out-of-household /
// soft-deleted alike — that uniformity is itself the leak prevention, since "not found" vs
// "forbidden" is a distinction worth having only to an attacker.
import {
  PS_ORDER, PS_WRITABLE_COLUMNS, normalizeSourceRows, parentCache,
} from './putUpSources.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = { status: 404, body: { error: 'Not found' } };
const notAllowed = { status: 405, body: { error: 'Method not allowed' } };

// /api/preservation/{uuid}/sources — and NOTHING ELSE. Returning null for every other path is what
// lets index.js delegate this FIRST without disturbing the literal sub-routes ('whats-put-up',
// 'use-soon') that must be checked before /api/preservation/:id. The uuid shape is tested HERE
// rather than at the loader so that /api/preservation/whats-put-up/sources — a real typo shape —
// falls through to the existing 404 instead of being claimed by this module.
export function parseSourceRoute(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const m = path.match(/^\/api\/preservation\/([^/]+)\/sources$/);
  if (!m) return null;
  if (!UUID_RE.test(m[1])) return null;
  return { kind: 'sources', id: m[1] };
}

// Uniform contract, lifted from index.js and kitchenRoutes.js: the row on success, null on ANY
// failure. Reads preservation_log directly — there is no view for it, unlike the kitchen family.
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

// The live sources of one jar, in ordinal order. Columns are named rather than SELECT *: a column
// added to the table later must be added to the read deliberately, which is also what makes
// preservation-source-columns.test.js's L-081 contract able to see the read surface at all.
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

// The whole-list replace. Order of statements is load-bearing:
//   1. soft-delete the current set  — frees every ordinal before any is reused, so the partial
//      unique index cannot collide with a row that is on its way out. Doing the insert first would
//      make replacing [A,B] with [B,A] a 23505 on ordinal 0.
//   2. insert the new set
//   3. write the parent cache from ordinal 0
//
// ⚠ These are three statements and the Neon HTTP driver gives no transaction across them. That is
// stated rather than papered over: a failure between 1 and 2 leaves a jar with no sources and a
// nulled parent cache, which is RECOVERABLE (re-submit) and is the direction that cannot lie — an
// emptied list reads as "unrecorded", never as a wrong provenance. A failure between 2 and 3 leaves
// the children right and the parent cache stale, so step 3 is written to be idempotent and the
// client is told to re-read. The alternative ordering (parent first) would leave a parent claiming a
// provenance no child supports, which is the direction that DOES lie.
async function replaceSources(sql, putUp, body, householdIds) {
  const submitted = body?.sources;

  // An explicit empty list is a legitimate request: "I do not know what went into this after all."
  // It clears the children AND the parent cache, and normalizeSourceRows refuses [] precisely so
  // this branch has to be written on purpose rather than falling out of a loop that ran zero times.
  if (Array.isArray(submitted) && submitted.length === 0) {
    await sql`
      UPDATE preservation_source SET deleted_at = NOW()
      WHERE preservation_log_id = ${putUp.id}::uuid
        AND user_id = ANY(${householdIds})
        AND deleted_at IS NULL
    `;
    const cache = parentCache([]);
    await sql`
      UPDATE preservation_log
      SET source_kind = ${cache.source_kind}::text,
          source_label = ${cache.source_label}::text,
          plant_id = ${cache.plant_id}::uuid,
          harvest_log_id = ${cache.harvest_log_id}::uuid,
          updated_at = NOW()
      WHERE id = ${putUp.id}::uuid
        AND user_id = ANY(${householdIds})
    `;
    return { status: 200, body: { sources: [], cleared: true } };
  }

  const { error, rows } = normalizeSourceRows(submitted);
  if (error) return { status: 400, body: { error } };

  await sql`
    UPDATE preservation_source SET deleted_at = NOW()
    WHERE preservation_log_id = ${putUp.id}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
  `;

  // ⚠ EVERY NULL PARAMETER CARRIES AN EXPLICIT ::cast. Neon cannot infer a type for a null bound
  // parameter and answers `could not determine data type of parameter` — a 500, not a 400, and one
  // that only appears for the rows that happen to omit a column. Bought-ingredient rows omit four of
  // these at once, so this is the COMMON path here, not an edge.
  // user_id is copied from the PARENT rather than from the caller: a household member editing
  // another member's jar must not silently re-own its sources.
  for (const r of rows) {
    await sql`
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
    `;
  }

  // Step 3. Unconditional and total — every one of the six columns is assigned, including the nulls.
  // A COALESCE-preserving update here would be a bug, not a kindness: it would retain a plant_id
  // from a previous edit whose source row is now soft-deleted, which is the "false-provenance
  // generator" shape v4-putupprov-001's own header rejects a DEFAULT for.
  const cache = parentCache(rows);
  await sql`
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
  `;
  // crop_type_slug / variety_id are the ONE pair written with COALESCE, and the asymmetry is
  // deliberate: chk_preservation_log_attribution requires at least one of them to be non-null, so
  // an all-bought source list (which carries neither) would otherwise null the jar's own crop and
  // 23514 the update. Keeping the existing value is correct — the jar's crop is a fact about the
  // JAR, set when it was created, not a fact derived from its ingredients.

  return listSources(sql, putUp.id, householdIds);
}

export async function handleSourceRoute({ sql, rawPath, method, rawBody, userId, householdIds }) {
  const route = parseSourceRoute(rawPath);
  if (!route) return null;
  // userId is unused by the SQL below (household scoping covers it) and is accepted so the delegation
  // block in index.js passes the identical argument object it passes handleKitchenRoute. Two
  // near-identical call sites with different shapes is how one of them drifts.
  void userId;

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
    return replaceSources(sql, putUp, body, householdIds);
  }
  return notAllowed;
}

// The CHECKs on preservation_source, given words. Consulted by index.js's error mapper so a 23514
// that slips past validateCreate reads as a sentence rather than a constraint name. Returns null for
// anything that is not ours, so the existing mappers below it are reached unchanged.
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
