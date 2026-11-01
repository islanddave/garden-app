// preservation_log CRUD + read surfaces Lambda (Put-Up). Mirrors lambda/inventory-items/index.js (auth/
// scope/resp skeleton, PG error-code map) and its literal-subroute-before-:id routing:
// /api/preservation/whats-put-up and /use-soon are matched BEFORE the :id route.
// Owner column is user_id (not created_by). Soft-Delete-Only: every read filters deleted_at IS NULL.
import { neon } from '@neondatabase/serverless';
import { householdScope, loadOwnedPhoto } from './household.js';
import { requestContext } from './request-context.js';
import { withActor } from './audit-actor.js';
import { dbErrorReply, logCaughtError } from './db-error.js';
import { reconcilePlantAttribution, plantingLabel } from './attribution.js';
import { VALID_SOURCE_KINDS, normalizeSourceLabel } from './provenance.js';
import { classifyUseBy, dayMs, USE_SOON_FRACTION, etDay, ET_TZ } from './useBy.js';
// The jar engine lives in two dependency-free siblings so every jar writer can import it (this file
// cannot: neon/clerk/aws at module scope, and kitchenRoutes is imported BY this file). shelfLife.js: the
// method x storage-kind table and the date it yields. jarRules.js: the method vocabulary, the validators
// and the read projection. Re-exported below so existing importers keep resolving.
import { HOUSE_SOURCED_SHELF_LIFE, defaultUseByTarget, resolveJarUseBy } from './shelfLife.js';
import {
  validateCreate, validateUpdate, validateLegacyPut, projectRow, countRefusal, clientStale,
  normalizeJarText as normalizeText, normalizeJarUnit, jarErrorMessage,
} from './jarRules.js';
// /api/kitchen-batches rides THIS Lambda, not a 27th one: a new function needs an AWS function + Function
// URL created out of band, a new VITE_API_* variable, a row in deploy-staging.yml's env: block and one in
// deploy-lambda.yml's matrix (which rewrites the live config of all 26 functions on every run). Its tables
// are in the preservation family, where householdScope() isolation is already wired. The handlers live in
// ./kitchenRoutes.js so vitest can import them; this file cannot.
import { handleKitchenRoute } from './kitchenRoutes.js';
import { kitchenErrorMessage } from './kitchenBatch.js';
// /api/preservation/:id/sources is its own importable module for the same reason: this file loads neon and
// clerk at module scope, so vitest cannot import it.
import { handleSourceRoute, sourceErrorMessage } from './sourceRoutes.js';
// PATCH /api/preservation/:id and POST /:id/move, importable for the same reason (see jarRoutes.js).
import { handleJarRoute } from './jarRoutes.js';
// POST /api/pantry/uses (Mark used / Used up), importable for the same reason.
import { handlePantryUses } from './pantryUses.js';
// GET /api/pantry, /api/pantry/items[/:id], /api/pantry/uses/:id/undo, and Remove on a put-up (removeJar).
import { handlePantryRoute, removeJar } from './pantryRoutes.js';
// /api/recipes (the recipe library).
import { handleRecipeRoute } from './recipeRoutes.js';
import { MASS_UNITS, MASS_FACTORS } from './lineRoutes.js';

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

// dayMs and classifyUseBy live in ./useBy.js, imported above and re-exported here so existing importers
// keep resolving. That module has no neon/clerk/aws imports, which is the point: a date boundary defined
// in THIS file could only be asserted by spelling (see useBy.test.js).
export { classifyUseBy, dayMs, USE_SOON_FRACTION, etDay, ET_TZ };
export { HOUSE_SOURCED_SHELF_LIFE, defaultUseByTarget, validateCreate, validateUpdate };

export { reconcilePlantAttribution, plantingLabel };

// Planting attribution (reconcilePlantAttribution, plantingLabel) lives in ./attribution.js, dependency-
// free so unit tests can import it without this file's neon/clerk/aws imports (absent under `npm ci`).

// A malformed id must get the SAME generic null/400 these loaders give a foreign id, never a 22P02 falling
// through this handler's catch to an opaque 500. Same literal as household.js / authz-parents.js; local
// because the loaders below are module-private.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Load the planting behind a plant_id, HOUSEHOLD-SCOPED. garden_node is the canonical plantings view;
// cultivar carries crop_type_slug. The scope is required: without it any authenticated user could attach
// another household's plant_id, leaking that planting's name/variety through the read surface and writing
// a cross-household FK. A planting is in scope through its container's created_by or, for container-less
// plantings, its own; every branch ends in `= ANY(householdIds)`. Returning null makes
// reconcilePlantAttribution reject with the generic "does not match a planting you can log against"
// (no existence oracle).
//
// Strict dialect (authz-parents.js loadOwnedPlantingRef): the bare own-
// created_by arm would reach a planting the caller created INSIDE another household's container, so the
// `container_id IS NULL` conjunct guarding it is LOAD-BEARING. `garden_node.container_id` is the view's
// name for `plants.project_id`; this loader stays on the views because it also reads cultivar columns.
//
// The UUID pre-check keeps a malformed plant_id on the same generic 400 as a foreign one;
// validateCreate / validateUpdate do not shape-check plant_id.
async function loadPlanting(sql, plantId, householdIds) {
  if (!UUID_RE.test(String(plantId))) return null;
  const rows = await sql`
    SELECT gn.id, gn.display_name, gn.sown_at, gn.succession_order, gn.succession_group_id,
           gn.cultivar_id AS variety_id, cv.crop_type_slug, cv.display_name AS variety_name
    FROM garden_node gn
    LEFT JOIN container pp ON pp.id = gn.container_id
    LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
    WHERE gn.id = ${plantId}
      AND gn.deleted_at IS NULL
      AND ( pp.created_by = ANY(${householdIds})
            OR (gn.container_id IS NULL AND gn.created_by = ANY(${householdIds})) )
  `;
  return rows.length ? rows[0] : null;
}

// Verify a storage_location_id belongs to the caller's household. Returns { id, kind } (kind feeds the
// shelf-life default) or null for out-of-household / absent / soft-deleted: the same "no existence
// oracle" contract as loadPlanting. The FK enforces EXISTENCE, not ownership; this is the ownership half
// (mirrors lambda/storage-location/index.js scope).
async function loadStorageLocation(sql, storageLocationId, householdIds) {
  if (!UUID_RE.test(String(storageLocationId))) return null;
  const rows = await sql`
    SELECT id, kind FROM storage_location
    WHERE id = ${storageLocationId}
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// Verify a harvest_log_id belongs to the caller's household. Returns { id } or null. Anchored on
// harvest_log.created_by (TEXT NOT NULL) rather than the project owner: harvest_log.project_id is
// NULLABLE (projectless plantings), so a project-owner anchor would reject an owner's OWN projectless
// harvest. Defense-in-depth: stops a cross-household id being stored before any read can leak it.
async function loadHarvestLog(sql, harvestLogId, householdIds) {
  if (!UUID_RE.test(String(harvestLogId))) return null;
  const rows = await sql`
    SELECT id FROM harvest_log
    WHERE id = ${harvestLogId}
      AND created_by = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// Photo ownership is gated by loadOwnedPhoto (household.js, imported above). The photos(id) FK enforces
// EXISTENCE only, and photo_id is echoed by projectRow() through all four GET routes, so an ungated id is
// a read-surface leak like storage_location_id. Anchored on photos.created_by (TEXT NOT NULL), not the
// nullable legacy uploaded_by: the convention lambda/authz-write-fk.test.js enforces.

export const handler = async (event) => {
  // The kit answers OPTIONS and every sign-in refusal (401, the household gate's 403) before any statement, and
  // scopes only after its empty-sub 401, so no `= ANY(householdIds)` predicate here ever binds [''].
  const ctx = await requestContext(event, { resp, neon, scope: householdScope });
  if (ctx.response) return ctx.response;
  const { userId, sql, householdIds } = ctx;
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/preservation';

  try {
    // Delegated routes return null for any path that is not their own, so the routes below are reached
    // unchanged. Household scope is passed in, not recomputed: one householdScope() call per request.
    // POST /api/pantry/uses is a LITERAL matched first ('/api/pantry' resolves here by prefix, src/lib/api.js).
    const use = await handlePantryUses({ sql, rawPath, method, rawBody: event.body, userId, householdIds });
    if (use) return resp(use.status, use.body);
    // /api/pantry, /api/pantry/items[/:id], /api/pantry/uses/:id/undo (null for every other path).
    const pantry = await handlePantryRoute({
      sql, rawPath, method, rawBody: event.body, query: event.queryStringParameters ?? {}, userId, householdIds,
    });
    if (pantry) return resp(pantry.status, pantry.body);

    const kitchen = await handleKitchenRoute({
      sql,
      rawPath,
      method,
      rawBody: event.body,
      query: event.queryStringParameters ?? {},
      userId,
      householdIds,
    });
    if (kitchen) return resp(kitchen.status, kitchen.body);

    // /api/recipes/**, delegated whole.
    const recipes = await handleRecipeRoute({
      sql, rawPath, method, rawBody: event.body, query: event.queryStringParameters ?? {}, userId, householdIds,
    });
    if (recipes) return resp(recipes.status, recipes.body);

    // /api/preservation/:id/sources, delegated whole. Safe above the literal sub-routes because
    // parseSourceRoute matches ONLY /api/preservation/{uuid}/sources, so '/api/preservation/whats-put-up/
    // sources' falls through unclaimed.
    const sources = await handleSourceRoute({
      sql,
      rawPath,
      method,
      rawBody: event.body,
      userId,
      householdIds,
    });
    if (sources) return resp(sources.status, sources.body);

    // PATCH /api/preservation/:id and POST /:id/move, delegated. handleJarRoute returns null for every
    // other verb on /:id, so GET / PUT / DELETE below are reached unchanged.
    const jar = await handleJarRoute({ sql, rawPath, method, rawBody: event.body, userId, householdIds });
    if (jar) return resp(jar.status, jar.body);

    // Literal sub-routes, checked BEFORE /api/preservation/:id so 'whats-put-up' / 'use-soon' are not
    // mis-parsed as a row id.

    // GET /api/preservation/whats-put-up: grouped inventory (default by storage location); ?group=crop
    // regroups by crop_type. NULL storage -> "Unassigned". Excludes soft-deleted + fully-consumed
    // (remaining_count=0). Headlines count PACKAGES and list per-record units, NEVER summing incompatible
    // quantity_units.
    //
    // ?include_consumed=1 keeps fully-consumed rows in: "what is in the freezer" must drop an empty jar, but
    // "where did this planting's harvest go" must not (an eaten jar is an answer to the second). OPT-IN:
    // anything but 1 keeps the exclusion.
    if (rawPath === '/api/preservation/whats-put-up') {
      if (method !== 'GET') return resp(405, { error: 'Method not allowed' });
      const rawGroup = event.queryStringParameters?.group;
      const groupBy = rawGroup === 'crop' ? 'crop' : rawGroup === 'planting' ? 'planting' : 'storage';
      // Optional ?plant_id= scopes the whole surface to ONE planting (feeds the planting-detail surface).
      // An empty result is a legitimate answer, not a 404.
      const plantFilter = event.queryStringParameters?.plant_id || null;
      const includeConsumed = event.queryStringParameters?.include_consumed === '1';
      const rows = await sql`
        SELECT p.*, s.label AS storage_label, s.kind AS storage_kind, ct.display_name AS crop_display_name,
               gn.display_name AS planting_name, gn.sown_at AS planting_sown_at,
               gn.succession_order AS planting_succession_order,
               cv.display_name AS planting_variety_name
        FROM preservation_log p
        LEFT JOIN storage_location s ON s.id = p.storage_location_id
        LEFT JOIN crop_types ct ON ct.slug = p.crop_type_slug
        LEFT JOIN garden_node gn ON gn.id = p.plant_id AND gn.deleted_at IS NULL
        LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
        WHERE p.user_id = ANY(${householdIds})
          AND p.deleted_at IS NULL
          AND (${includeConsumed} OR p.remaining_count IS NULL OR p.remaining_count > 0)
          AND (${plantFilter}::uuid IS NULL OR p.plant_id = ${plantFilter}::uuid)
        ORDER BY p.preserved_at DESC, p.created_at DESC
      `;
      const groups = new Map();
      for (const r of rows) {
        let key, label, extra;
        if (groupBy === 'crop') {
          key = r.crop_type_slug ?? 'unattributed';
          label = r.crop_display_name ?? (r.crop_type_slug ?? 'Unattributed');
          extra = { crop_type_slug: r.crop_type_slug ?? null };
        } else if (groupBy === 'planting') {
          // plant_id is OPTIONAL by design (a put-up drawn from several waves has no single planting);
          // those land in an explicit bucket rather than a false attribution.
          key = r.plant_id ?? 'no_planting';
          label = r.plant_id ? plantingLabel(r) : 'Not tied to a planting';
          extra = {
            plant_id: r.plant_id ?? null,
            planting_sown_at: r.planting_sown_at ?? null,
            planting_succession_order: r.planting_succession_order ?? null,
          };
        } else {
          key = r.storage_location_id ?? 'unassigned';
          label = r.storage_label ?? 'Unassigned';
          extra = { storage_location_id: r.storage_location_id ?? null, kind: r.storage_kind ?? null };
        }
        if (!groups.has(key)) {
          groups.set(key, { group_key: key, label, ...extra, total_packages: 0, units: new Set(), use_soon_count: 0, records: [] });
        }
        const g = groups.get(key);
        const proj = projectRow(r);
        g.total_packages += Number(r.package_count) || 0;
        if (r.quantity_unit) g.units.add(r.quantity_unit);
        if (proj.use_by_status === 'use_soon' || proj.use_by_status === 'past_use_by') g.use_soon_count += 1;
        g.records.push(proj);
      }
      const out = [...groups.values()].map((g) => ({ ...g, units: [...g.units] }));
      // Catch-all buckets sort last; otherwise alphabetical by label, EXCEPT plantings, which sort by sown
      // date (alphabetical would interleave "wave 10" between 1 and 2).
      const CATCHALL = new Set(['unassigned', 'unattributed', 'no_planting']);
      out.sort((a, b) => {
        const au = CATCHALL.has(a.group_key);
        const bu = CATCHALL.has(b.group_key);
        if (au !== bu) return au ? 1 : -1;
        if (groupBy === 'planting' && !au && !bu) {
          const at = a.planting_sown_at ? dayMs(a.planting_sown_at) : Infinity;
          const bt = b.planting_sown_at ? dayMs(b.planting_sown_at) : Infinity;
          if (at !== bt) return at - bt;
        }
        return String(a.label).localeCompare(String(b.label));
      });
      return resp(200, { group_by: groupBy, groups: out });
    }

    // GET /api/preservation/use-soon: server-side shelf-life window. Returns rows whose STORED use_by_target
    // puts them in the final ~15-20% of their span ('use_soon') OR already past ('past_use_by'). Excludes
    // null use_by_target, not-yet-soon, soft-deleted and fully-consumed. Never sums across incompatible units.
    if (rawPath === '/api/preservation/use-soon') {
      if (method !== 'GET') return resp(405, { error: 'Method not allowed' });
      const rows = await sql`
        SELECT p.*, s.label AS storage_label, s.kind AS storage_kind, ct.display_name AS crop_display_name,
               gn.display_name AS planting_name, gn.sown_at AS planting_sown_at,
               gn.succession_order AS planting_succession_order, cv.display_name AS planting_variety_name
        FROM preservation_log p
        LEFT JOIN storage_location s ON s.id = p.storage_location_id
        LEFT JOIN crop_types ct ON ct.slug = p.crop_type_slug
        LEFT JOIN garden_node gn ON gn.id = p.plant_id AND gn.deleted_at IS NULL
        LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
        WHERE p.user_id = ANY(${householdIds})
          AND p.deleted_at IS NULL
          AND p.use_by_target IS NOT NULL
          AND (p.remaining_count IS NULL OR p.remaining_count > 0)
        ORDER BY p.use_by_target ASC
      `;
      const items = [];
      for (const r of rows) {
        const status = classifyUseBy(r.preserved_at, r.use_by_target);
        if (status !== 'use_soon' && status !== 'past_use_by') continue;
        items.push({
          ...projectRow(r),
          use_by_status: status,
          storage_label: r.storage_label ?? null,
          storage_kind: r.storage_kind ?? null,
          crop_display_name: r.crop_display_name ?? null,
        });
      }
      return resp(200, { items });
    }

    const idMatch = rawPath.match(/^\/api\/preservation\/([^/]+)$/);

    if (idMatch) {
      const rowId = idMatch[1];

      if (method === 'GET') {
        const rows = await sql`
          SELECT p.*, s.label AS storage_label, s.kind AS storage_kind, ct.display_name AS crop_display_name,
               gn.display_name AS planting_name, gn.sown_at AS planting_sown_at,
               gn.succession_order AS planting_succession_order, cv.display_name AS planting_variety_name
          FROM preservation_log p
          LEFT JOIN storage_location s ON s.id = p.storage_location_id
          LEFT JOIN crop_types ct ON ct.slug = p.crop_type_slug
          LEFT JOIN garden_node gn ON gn.id = p.plant_id AND gn.deleted_at IS NULL
          LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
          WHERE p.id = ${rowId} AND p.user_id = ANY(${householdIds}) AND p.deleted_at IS NULL
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        const r = rows[0];
        return resp(200, { ...projectRow(r), storage_label: r.storage_label ?? null, storage_kind: r.storage_kind ?? null, crop_display_name: r.crop_display_name ?? null });
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');
        const verr = validateLegacyPut(body);
        if (verr) return resp(400, { error: verr });
        const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

        // L7 cross-field: the same planting reconciliation as POST, so an edit cannot drift a put-up onto a
        // planting of a different crop.
        let attr = { crop_type_slug: body.crop_type_slug ?? null, variety_id: body.variety_id ?? null };
        if (body.plant_id) {
          const rec = reconcilePlantAttribution(body, await loadPlanting(sql, body.plant_id, householdIds));
          if (rec.error) return resp(400, { error: rec.error });
          attr = rec;
        }

        // AUTHZ: a PUT can set/replace these FKs too, so it needs the same ownership gate as POST.
        if (body.storage_location_id) {
          const sl = await loadStorageLocation(sql, body.storage_location_id, householdIds);
          if (!sl) return resp(400, { error: 'storage_location_id does not match a storage location you can use' });
        }
        if (body.harvest_log_id) {
          const hl = await loadHarvestLog(sql, body.harvest_log_id, householdIds);
          if (!hl) return resp(400, { error: 'harvest_log_id does not match a harvest you can log against' });
        }
        // photo_id is body-settable and echoed by projectRow, so it needs the same ownership gate.
        if (body.photo_id) {
          const ph = await loadOwnedPhoto(sql, body.photo_id, householdIds);
          if (!ph) return resp(400, { error: 'photo_id does not match a photo you can use' });
        }

        // Legacy PUT "from 1b" rules (V4's legacy-PUT section). This PUT is now the shipped bundle's door
        // only: the 1b client moves a jar through Move and edits date, method and notes through PATCH.
        //   * AN ABSENT KEY IS UNCHANGED, on every column (1a wrote NULL for an absent remaining_count and
        //     1 for an absent package_count; a 1b bundle that omits them must not).
        //   * storage_location_id, use_by_target, method, method_other_text, notes are no longer WRITTEN
        //     here. A present value EQUAL to the stored one is the shipped echo (a no-op); one that DIFFERS
        //     is a tab older than the row: 409 client_stale, decided in the UPDATE's WHERE on the row it
        //     locks. Dates compare as ::date; the text columns compare trimmed with blank = NULL, as the
        //     shipped RowEditor writes them, so an untouched echo never reads as a change.
        //   * THE STALE-TAB COUNT RACE (05 §6a). A package_count AND a remaining_count that both differ
        //     from the stored ones is neither shipped action on a fresh row (a count edit echoes the
        //     remaining; a Mark used echoes the count): it is a tab that missed somebody's count edit,
        //     whose Mark used would revert their count. Refused as client_stale, in the WHERE, race-free.
        //   * The stored quantity pair is KEPT when quantity_value is null, absent or 0.
        //   * Attribution and a named Other are judged on the EFFECTIVE row by the relaxed CHECKs
        //     (chk_preservation_log_attribution / _method_other), mapped to words in the catch below.
        // Every preservation_log write runs under withActor, so trg_audit_preservation_log_upd records who
        // changed what.
        const hasAttr = has('crop_type_slug') || has('variety_id') || has('plant_id');
        const keepQuantity = body.quantity_value == null || Number(body.quantity_value) === 0;
        const packageCount = body.package_count == null ? null : Number(body.package_count);
        const hasRemaining = has('remaining_count');
        const remaining = body.remaining_count ?? null;
        const hasConsumed = has('consumed_at');
        const hasLoc = has('storage_location_id');
        const hasUseBy = has('use_by_target');
        const hasMethod = has('method');
        const hasMethodOther = has('method_other_text');
        const hasNotes = has('notes');
        const useBy = body.use_by_target == null ? null : String(body.use_by_target).slice(0, 10);

        const [, rows] = await withActor(sql, userId, () => [
          sql`
          WITH stored AS (
            SELECT package_count AS stored_package_count, remaining_count AS stored_remaining_count,
                   delta_at AS stored_delta_at,
                   -- The five-column echo rule and the count race, restated over the SNAPSHOT so a
                   -- refusal can say which it was. The UPDATE below decides on the locked row; this
                   -- only explains. Keep the two blocks term-for-term identical.
                   NOT (
                         (NOT ${hasLoc}::boolean OR ${body.storage_location_id ?? null}::uuid IS NOT DISTINCT FROM storage_location_id)
                     AND (NOT ${hasUseBy}::boolean OR ${useBy}::date IS NOT DISTINCT FROM use_by_target)
                     AND (NOT ${hasMethod}::boolean OR ${body.method ?? null}::text IS NOT DISTINCT FROM method)
                     AND (NOT ${hasMethodOther}::boolean OR NULLIF(btrim(${body.method_other_text ?? null}::text), '') IS NOT DISTINCT FROM NULLIF(btrim(method_other_text), ''))
                     AND (NOT ${hasNotes}::boolean OR NULLIF(btrim(${body.notes ?? null}::text), '') IS NOT DISTINCT FROM NULLIF(btrim(notes), ''))
                     AND NOT (${packageCount}::int IS NOT NULL AND package_count <> ${packageCount}::int
                              AND ${hasRemaining}::boolean AND ${remaining}::int IS DISTINCT FROM remaining_count)
                   ) AS stored_stale
            FROM preservation_log
            WHERE id = ${rowId}
              AND user_id = ANY(${householdIds})
              AND deleted_at IS NULL
          ), updated AS (
          UPDATE preservation_log SET
            crop_type_slug      = CASE WHEN ${hasAttr}::boolean THEN ${attr.crop_type_slug ?? null}::text ELSE crop_type_slug END,
            variety_id          = CASE WHEN ${hasAttr}::boolean THEN ${attr.variety_id ?? null}::uuid ELSE variety_id END,
            plant_id            = CASE WHEN ${hasAttr}::boolean THEN ${body.plant_id ?? null}::uuid ELSE plant_id END,
            harvest_log_id      = CASE WHEN ${has('harvest_log_id')}::boolean THEN ${body.harvest_log_id ?? null}::uuid ELSE harvest_log_id END,
            preserved_at        = COALESCE(${body.preserved_at ?? null}::date, preserved_at),
            -- V4-PUTUPSESSION-001 slice 1 — COALESCE-PRESERVED, same contract and same reason as
            -- source_kind below. Written house-style (a plain body-or-null replace) every "Mark
            -- used" tap from a service-worker-cached bundle would rewrite an estimate as a date the
            -- user chose, return 200, and look like nothing happened. Absent key means unchanged.
            -- An explicit false is NOT absent (nullish-coalescing passes false straight through), so
            -- a client that corrects an estimate to a real date can still clear the flag.
            -- ::boolean IS LOAD-BEARING for the same reason the ::text casts below are: the neon
            -- driver sends untyped params, and an untyped placeholder in COALESCE() gives Postgres
            -- no type context to resolve against.
            preserved_at_approx = COALESCE(${body.preserved_at_approx ?? null}::boolean, preserved_at_approx),
            -- 1b: never written here (PATCH owns it); a present value is equal or refused below.
            method              = method,
            method_other_text   = method_other_text,
            quantity_value      = CASE WHEN ${keepQuantity}::boolean THEN quantity_value ELSE ${keepQuantity ? null : body.quantity_value}::numeric END,
            quantity_unit       = CASE WHEN ${keepQuantity}::boolean THEN quantity_unit ELSE ${keepQuantity ? null : normalizeText(body.quantity_unit)}::text END,
            package_count       = COALESCE(${packageCount}::int, package_count),
            -- 1b: never written here (Move owns it); a present value is equal or refused below.
            storage_location_id = storage_location_id,
            -- 1b: never written here (PATCH owns it, with its basis); equal or refused below.
            use_by_target       = use_by_target,
            -- Put-Up release 1a — ONE WRITER FOR THE COUNT (V4's legacy-PUT section, "From 1a"). A
            -- package_count that DIFFERS from the stored one moves remaining_count by the same delta,
            -- from COALESCE(remaining_count, package_count) — what has been used stays used — and the
            -- body's remaining_count is IGNORED on that write. With the count unchanged (or absent) a
            -- PRESENT remaining_count applies exactly as before (the shipped Mark used / Used up) and an
            -- ABSENT one is unchanged (1b). Refusal, like the arithmetic, is decided INSIDE the one
            -- UPDATE on the row it locks, so a concurrent Mark used cannot slip between a read and this
            -- write; the stored CTE only tells a missing jar (404) from a refused write (409).
            remaining_count     = CASE WHEN ${packageCount}::int IS NOT NULL AND package_count <> ${packageCount}::int
                                         THEN COALESCE(remaining_count, package_count) + (${packageCount}::int - package_count)
                                       WHEN ${hasRemaining}::boolean THEN ${remaining}::int
                                       ELSE remaining_count
                                  END,
            -- A count change re-derives consumed_at from the count it produced: stamped (or kept) at
            -- 0 left, cleared otherwise. A present remaining_count: the body's consumed_at if it sent
            -- one, else stamped (kept) at 0 and cleared above 0. Neither: the body's consumed_at if
            -- present, else unchanged.
            consumed_at         = CASE WHEN ${packageCount}::int IS NOT NULL AND package_count <> ${packageCount}::int
                                         THEN CASE WHEN COALESCE(remaining_count, package_count) + (${packageCount}::int - package_count) = 0
                                                   THEN COALESCE(consumed_at, NOW()) END
                                       WHEN ${hasRemaining}::boolean
                                         THEN COALESCE(${body.consumed_at ?? null}::timestamptz,
                                                       CASE WHEN ${remaining}::int = 0 THEN COALESCE(consumed_at, NOW()) END)
                                       WHEN ${hasConsumed}::boolean THEN ${body.consumed_at ?? null}::timestamptz
                                       ELSE consumed_at
                                  END,
            -- 1b: never written here (PATCH owns it); a present value is equal or refused below.
            notes               = notes,
            photo_id            = CASE WHEN ${has('photo_id')}::boolean THEN ${body.photo_id ?? null}::uuid ELSE photo_id END,
            -- V4-PUTUPPROV-001 — DELIBERATE DEVIATION FROM THIS BLOCK'S HOUSE STYLE. Do not
            -- "correct" these two back to the plain body-or-null interpolation every other column
            -- above uses; that reopens a silent data-loss bug.
            --
            -- Every other column above is a total replace, which is correct: every client that can
            -- issue a PUT builds all of them. It is WRONG for a column no already-deployed client
            -- knows about. This is a PWA — after the promote, a loaded tab keeps its old bundle until
            -- reload, and that bundle's buildFullPayload has never heard of these columns. Written
            -- house-style, every "Mark used" tap from a stale client would rewrite a farm-stand
            -- put-up as own_garden with the vendor erased, return 200, and look like a render glitch.
            --
            -- Contract: source_kind OWNS THE PAIR. Request carries it => it owns both columns and may
            -- set the label to anything including null (so a mistyped vendor is still erasable).
            -- Request omits it => both untouched. Explicit own_garden => label cleared, because the
            -- label is vendor-only (D2-b, Dave-confirmed 2026-07-26).
            -- NOTE the CASE keys on the REQUEST's source_kind, not COALESCE(request, stored): keying
            -- on the stored value would null the label whenever the row was already own_garden,
            -- which is the bug the boss pass caught in the first draft.
            -- ::text CASTS ARE LOAD-BEARING, not decoration. A bare placeholder in a
            -- WHEN ... IS NULL test gives Postgres no type context, and the neon driver sends
            -- untyped params — the server answers "could not determine data type of parameter $18"
            -- and the whole PUT 500s. Caught by the real-Postgres integration suite; every unit
            -- and static-parity test passed with it broken, because none of them speak to a
            -- database. Keep the casts on every placeholder inside this CASE.
            source_kind         = COALESCE(${body.source_kind ?? null}::text, source_kind),
            source_label        = CASE
                                    WHEN ${body.source_kind ?? null}::text IS NULL         THEN source_label
                                    WHEN ${body.source_kind ?? null}::text = 'own_garden'  THEN NULL
                                    ELSE ${normalizeSourceLabel(body.source_label)}::text
                                  END,
            updated_at          = NOW()
          WHERE id = ${rowId}
            AND user_id = ANY(${householdIds})
            AND deleted_at IS NULL
            -- 1b: the five-column echo rule and the count race (see above). Term-for-term the
            -- stored_stale expression, un-negated.
            AND (NOT ${hasLoc}::boolean OR ${body.storage_location_id ?? null}::uuid IS NOT DISTINCT FROM storage_location_id)
            AND (NOT ${hasUseBy}::boolean OR ${useBy}::date IS NOT DISTINCT FROM use_by_target)
            AND (NOT ${hasMethod}::boolean OR ${body.method ?? null}::text IS NOT DISTINCT FROM method)
            AND (NOT ${hasMethodOther}::boolean OR NULLIF(btrim(${body.method_other_text ?? null}::text), '') IS NOT DISTINCT FROM NULLIF(btrim(method_other_text), ''))
            AND (NOT ${hasNotes}::boolean OR NULLIF(btrim(${body.notes ?? null}::text), '') IS NOT DISTINCT FROM NULLIF(btrim(notes), ''))
            AND NOT (${packageCount}::int IS NOT NULL AND package_count <> ${packageCount}::int
                     AND ${hasRemaining}::boolean AND ${remaining}::int IS DISTINCT FROM remaining_count)
            -- Release F (06 §1.3 item 4; V4 "From release 2"): a body carrying remaining_count on a jar
            -- that a use or a draw has moved (delta_at set) is a pre-F bundle echoing a count this
            -- jar no longer has. Only pre-F bundles send the key — the F client moves counts through
            -- POST /api/pantry/uses — so refusing here strands nobody: the 409 is client_stale, whose
            -- Refresh now loads the bundle that does not send it. Race-free: decided on the locked row.
            AND (NOT ${hasRemaining}::boolean OR delta_at IS NULL)
            -- The count refusal. The same expression as remaining_count's SET, on the same row: the
            -- write happens only if what it would store is a count of jars that can exist,
            -- 0..package_count. NULL stays legal exactly as before.
            AND COALESCE(
                  CASE WHEN ${packageCount}::int IS NOT NULL AND package_count <> ${packageCount}::int
                         THEN COALESCE(remaining_count, package_count) + (${packageCount}::int - package_count)
                       WHEN ${hasRemaining}::boolean THEN ${remaining}::int
                       ELSE remaining_count
                  END BETWEEN 0 AND COALESCE(${packageCount}::int, package_count),
                  TRUE)
          RETURNING *
          )
          SELECT updated.*, stored.stored_package_count, stored.stored_remaining_count, stored.stored_stale,
                 stored.stored_delta_at
          FROM stored LEFT JOIN updated ON TRUE
        `,
        ]);
        if (!rows.length) return resp(404, { error: 'Not found' });
        const { stored_package_count: storedCount, stored_remaining_count: storedRemaining,
                stored_stale: storedStale, stored_delta_at: storedDeltaAt, ...row } = rows[0];
        if (row.id == null) {
          if (storedStale) return resp(409, clientStale());
          // Branched EXPLICITLY, never left to countRefusal's fall-through, which would answer a stale
          // Used up with count_below_used.
          if (hasRemaining && storedDeltaAt != null) return resp(409, clientStale());
          return resp(409, countRefusal({
            storedCount, storedRemaining,
            packageCount: packageCount ?? storedCount,
            remaining: hasRemaining ? remaining : storedRemaining,
          }));
        }
        return resp(200, row);
      }

      if (method === 'DELETE') {
        // Remove: refused on a jar that was used or that a live batch line draws from, with the reason and
        // a path; otherwise the 1b soft delete, in the actor transaction (pantryRoutes.js removeJar, executed by
        // pantryRoutes.test.js).
        const removed = await removeJar(sql, rowId, userId, householdIds);
        return resp(removed.status, removed.body);
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // The list answers the COLLECTION only, for the reason the create below does
    // (BUG-PRESERVPOSTFALLTHROUGH-001): a bare `method === 'GET'` handed the household's jars to any
    // unclaimed GET ('/api/preservation/x/y', '/api/pantry/typo') with a 200.
    if (method === 'GET' && rawPath !== '/api/preservation' && rawPath !== '/api/preservation/') {
      return resp(404, { error: 'Not found' });
    }

    if (method === 'GET') {
      const rows = await sql`
        SELECT p.*, s.label AS storage_label, s.kind AS storage_kind, ct.display_name AS crop_display_name,
               gn.display_name AS planting_name, gn.sown_at AS planting_sown_at,
               gn.succession_order AS planting_succession_order, cv.display_name AS planting_variety_name
        FROM preservation_log p
        LEFT JOIN storage_location s ON s.id = p.storage_location_id
        LEFT JOIN crop_types ct ON ct.slug = p.crop_type_slug
        LEFT JOIN garden_node gn ON gn.id = p.plant_id AND gn.deleted_at IS NULL
        LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
        WHERE p.user_id = ANY(${householdIds}) AND p.deleted_at IS NULL
        ORDER BY p.preserved_at DESC, p.created_at DESC
      `;
      return resp(200, rows.map((r) => ({ ...projectRow(r), storage_label: r.storage_label ?? null, storage_kind: r.storage_kind ?? null, crop_display_name: r.crop_display_name ?? null })));
    }

    // Create answers the COLLECTION only (BUG-PRESERVPOSTFALLTHROUGH-001). Every delegate above returns
    // null for a path it does not own, and '/api/pantry', '/api/kitchen-batches' and '/api/recipes'
    // resolve to this Lambda too, so a bare `method === 'POST'` made a jar out of any unclaimed POST
    // ('/api/preservation/x/y', '/api/pantry/typo') carrying a valid body.
    if (method === 'POST' && rawPath !== '/api/preservation' && rawPath !== '/api/preservation/') {
      return resp(404, { error: 'Not found' });
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const verr = validateCreate(body);
      if (verr) return resp(400, { error: verr });

      // L7 cross-field: resolve the planting FIRST; it can supply the crop/variety the DB CHECK needs, and
      // it rejects a planting that contradicts an explicitly-picked crop or variety.
      let attr = { crop_type_slug: body.crop_type_slug ?? null, variety_id: body.variety_id ?? null };
      if (body.plant_id) {
        const rec = reconcilePlantAttribution(body, await loadPlanting(sql, body.plant_id, householdIds));
        if (rec.error) return resp(400, { error: rec.error });
        attr = rec;
      }
      // A label attributes a jar on its own (chk_preservation_log_attribution).
      if (!attr.crop_type_slug && !attr.variety_id && normalizeText(body.label) == null) {
        return resp(400, { error: 'that planting has no variety — pick a crop as well' });
      }

      // AUTHZ: validate the two nullable, owner-scoped FKs BEFORE insert. The FK enforces EXISTENCE, not
      // ownership: without these an authed user could attach another household's storage_location_id
      // (leaked back as storage_label + storage_kind through the read surfaces that join it) or
      // harvest_log_id (defense-in-depth against a future leak). Same "no existence oracle" reject shape as
      // the planting path. storageKind is reused for the shelf-life default below so the ownership check
      // runs UNCONDITIONALLY, not only when use_by_target is omitted.
      let storageKind = null;
      if (body.storage_location_id) {
        const sl = await loadStorageLocation(sql, body.storage_location_id, householdIds);
        if (!sl) return resp(400, { error: 'storage_location_id does not match a storage location you can use' });
        storageKind = sl.kind;
      }
      if (body.harvest_log_id) {
        const hl = await loadHarvestLog(sql, body.harvest_log_id, householdIds);
        if (!hl) return resp(400, { error: 'harvest_log_id does not match a harvest you can log against' });
      }
      // Mirrors the PUT gate above (loadOwnedPhoto).
      if (body.photo_id) {
        const ph = await loadOwnedPhoto(sql, body.photo_id, householdIds);
        if (!ph) return resp(400, { error: 'photo_id does not match a photo you can use' });
      }

      const packageCount = body.package_count ?? 1;
      // Fresh put-up: initialize remaining_count so the decrement/"used up" flow and the fully-consumed
      // filter are meaningful from the first row. Client may override.
      const remaining = body.remaining_count ?? packageCount;

      // The discard-by rule (V4): a PRESENT use_by_target is the user's date, basis 'typed' (including an
      // explicit null, "no date · set by hand"); an ABSENT one is the engine's, resolved from the method, the
      // place's kind and the 1b facts, with its basis. storageKind was resolved above.
      const typed = Object.prototype.hasOwnProperty.call(body, 'use_by_target');
      const precision = body.preserved_at_precision ?? null;
      const resolved = typed
        ? { use_by_target: body.use_by_target == null ? null : String(body.use_by_target).slice(0, 10), use_by_basis: 'typed' }
        : resolveJarUseBy({
            method: body.method, kind: storageKind, isRaw: body.is_raw ?? null, inOil: body.in_oil ?? null,
            texture: body.texture ?? null, precision,
          }, body.preserved_at);
      // A typed heat estimate on a jar is 'typed' (only shu-estimate/save writes 'computed').
      const shuLow = body.shu_est_low == null ? null : Number(body.shu_est_low);
      const shuHigh = shuLow == null ? null : Number(body.shu_est_high ?? body.shu_est_low);
      // pH at bottling: ph_read_at defaults to the jar's own date, never earlier.
      const phReading = body.ph_reading == null ? null : String(body.ph_reading).trim();
      const phReadAt = phReading == null ? null : (body.ph_read_at ?? String(body.preserved_at).slice(0, 10));

      let rows;
      try {
        rows = await sql`
          INSERT INTO preservation_log (
            user_id, crop_type_slug, variety_id, plant_id, harvest_log_id,
            preserved_at, preserved_at_approx, method, method_other_text, quantity_value, quantity_unit,
            package_count, storage_location_id, use_by_target, remaining_count, notes, photo_id,
            source_kind, source_label,
            label, container_label, use_by_basis, preserved_at_precision, is_raw, in_oil, texture,
            ph_reading, ph_read_at, idempotency_key,
            shu_est_low, shu_est_high, shu_est_basis, cooked, remaining_amount
          ) VALUES (
            ${userId}, ${attr.crop_type_slug ?? null}, ${attr.variety_id ?? null}, ${body.plant_id ?? null}, ${body.harvest_log_id ?? null},
            ${body.preserved_at}, ${body.preserved_at_approx ?? null}, ${body.method}, ${body.method === 'other' ? normalizeText(body.method_other_text) : null}, ${body.quantity_value ?? null}, ${normalizeJarUnit(body.quantity_unit)},
            ${packageCount}, ${body.storage_location_id ?? null}, ${resolved.use_by_target}, ${remaining}, ${body.notes ?? null}, ${body.photo_id ?? null},
            ${body.source_kind ?? null}, ${body.source_kind === 'own_garden' ? null : normalizeSourceLabel(body.source_label)},
            ${normalizeText(body.label)}, ${normalizeText(body.container_label)}, ${resolved.use_by_basis}, ${precision},
            ${body.is_raw ?? null}, ${body.in_oil ?? null}, ${body.texture ?? null},
            ${phReading}::numeric, ${phReadAt}::timestamptz, ${body.idempotency_key ?? null}::uuid,
            ${shuLow}::int, ${shuHigh}::int, ${shuLow == null ? null : 'typed'}::text, ${body.cooked ?? null}::boolean,
            -- Release F (06 §1.4 "Seeding"): a WEIGHED jar (one container, a mass unit) starts with its
            -- grams, so the first draw moves remaining_amount from a real number.
            CASE WHEN ${packageCount}::int = 1
                 THEN ${body.quantity_value ?? null}::numeric
                      * (SELECT m.factor FROM unnest(${MASS_UNITS}::text[], ${MASS_FACTORS}::numeric[]) AS m(unit, factor)
                          WHERE m.unit = ${normalizeJarUnit(body.quantity_unit)}::text) END
          ) RETURNING *
        `;
      } catch (err) {
        // A 23505 on THIS index (only this one) is a replay: re-read the jar by its key, owner-scoped; a key
        // someone outside the household holds is a 409 with no payload (V4 "Idempotency").
        if (err?.code === '23505' && err.constraint === 'uq_preservation_log_idempotency_key') {
          const prior = await sql`
            SELECT * FROM preservation_log
            WHERE idempotency_key = ${body.idempotency_key}::uuid
              AND user_id = ANY(${householdIds})
          `;
          if (!prior.length) return resp(409, { error: 'That key is already in use.', code: 'key_conflict' });
          return resp(200, { ...prior[0], replayed: true });
        }
        throw err;
      }
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    logCaughtError('preservation lambda error', err);
    // The kitchen_* CHECKs, given words. Consulted FIRST and returns null for anything it does not own, so
    // every mapping below keeps its behaviour. The one overlap is chk_preservation_log_one_provenance,
    // which only the batch close-out route can violate.
    const kitchenMsg = kitchenErrorMessage(err);
    if (kitchenMsg) return resp(400, { error: kitchenMsg });
    // The relaxed and new preservation_log CHECKs, given words (jarRules.js).
    const jarMsg = jarErrorMessage(err);
    if (jarMsg) return resp(400, { error: jarMsg });
    // The preservation_source CHECKs, given words. Same null-for-not-mine contract; it cannot shadow the
    // kitchen mapper above or the two provenance mappings below (its constraint names are all chk_ps_*).
    const sourceMsg = sourceErrorMessage(err);
    if (sourceMsg) return resp(400, { error: sourceMsg });
    // The two provenance CHECKs, given human text. validateUpdate skips provenance when a PUT omits
    // source_kind (it cannot see the STORED kind without a read), so these are reachable, and RecordRow.put()
    // would otherwise swallow them into an undiagnosable "try again" retry loop.
    if (err.code === '23514' && err.constraint === 'chk_preservation_log_source_plant') {
      return resp(400, { error: 'This put-up is linked to a planting, so its source must be your own garden. Clear the planting first.' });
    }
    if (err.code === '23514' && String(err.constraint ?? '').startsWith('chk_preservation_log_source')) {
      return resp(400, { error: 'Source is not valid', code: 'check_violation' });
    }
    // 42P01 / 42703 = the Lambda shipped ahead of this environment's DDL (the migration-sequencing window).
    // The reply says which kind is missing instead of a bare 500; the name is in the log line.
    const db = dbErrorReply(err, ['42P01', '23514', '42703', '23502', '23503']);
    if (db) return resp(db.status, db.body);
    return resp(500, { error: 'Internal server error' });
  }
};
