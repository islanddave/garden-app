// V4-HARVESTCENTER-001 (Put-Up) — preservation_log CRUD + read surfaces Lambda.
// Mirrors lambda/inventory-items/index.js (auth/scope/resp skeleton, PG error-code map) and its
// literal-subroute-before-:id routing (the SEEDINV sow-candidates/extract-seeds precedent):
// /api/preservation/whats-put-up and /api/preservation/use-soon are matched BEFORE the :id route.
// Owner column is user_id (not created_by). Soft-Delete-Only: every read filters deleted_at IS NULL.
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { householdScope, loadOwnedPhoto } from './household.js';
import { reconcilePlantAttribution, plantingLabel } from './attribution.js';
import { VALID_SOURCE_KINDS, normalizeSourceLabel } from './provenance.js';
import { classifyUseBy, dayMs, USE_SOON_FRACTION, etDay, ET_TZ } from './useBy.js';
// Put-Up release 1a (V4 §3.3, §4.1) — the jar engine lives in two dependency-free siblings so every
// jar writer can import it, which this file cannot offer (neon/clerk/aws at module scope, and
// kitchenRoutes is imported BY this file). shelfLife.js: the method × storage-kind table and the date
// it yields. jarRules.js: the per-jar rules — the method vocabulary, the validators, the read
// projection. Moved verbatim; re-exported below so any existing importer of this file keeps resolving.
import { HOUSE_SOURCED_SHELF_LIFE, defaultUseByTarget, resolveJarUseBy } from './shelfLife.js';
import {
  validateCreate, validateUpdate, validateLegacyPut, projectRow, countRefusal, clientStale,
  normalizeJarText as normalizeText, normalizeJarUnit, jarErrorMessage,
} from './jarRules.js';
// V5-INFLIGHTBATCH-001 — /api/kitchen-batches rides THIS Lambda, not a 27th one. A new function needs
// an AWS function + Function URL created out of band, a new VITE_API_* repo variable, a row in
// deploy-staging.yml's hardcoded env: block and a 27th row in deploy-lambda.yml's matrix — and that
// matrix rewrites the live config of all 26 existing functions on every run. Two paths already map to
// one Lambda in src/lib/api.js (/api/entity-tags, /api/search), and these tables are in the
// preservation family, where householdScope() isolation is already wired.
// The handlers live in ./kitchenRoutes.js so they can be IMPORTED and executed by vitest; this file
// cannot be. See that file's header.
import { handleKitchenRoute } from './kitchenRoutes.js';
import { kitchenErrorMessage } from './kitchenBatch.js';
// V5-PUTUPMULTISOURCE-001 — /api/preservation/:id/sources lives in its own importable module for
// the same reason the kitchen routes do: this file loads @neondatabase/serverless and
// @clerk/backend at module scope and therefore cannot be imported by vitest.
import { handleSourceRoute, sourceErrorMessage } from './sourceRoutes.js';
// Put-Up release 1b — PATCH /api/preservation/:id and POST /api/preservation/:id/move, importable for
// the same reason (see jarRoutes.js's header).
import { handleJarRoute } from './jarRoutes.js';
// Release F — POST /api/pantry/uses (Mark used / Used up), importable for the same reason.
import { handlePantryUses } from './pantryUses.js';
// Put-Up release 4 — /api/recipes (the recipe library), importable for the same reason.
import { handleRecipeRoute } from './recipeRoutes.js';
import { MASS_UNITS, MASS_FACTORS } from './lineRoutes.js';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

// dayMs and classifyUseBy MOVED to ./useBy.js under BUG-USEBYDAYBOUNDARY-001 — imported above with
// the other local modules, and re-exported here so any existing importer of this file keeps
// resolving. The definitions live in a module with no @neondatabase / @clerk / @aws-sdk imports,
// which is the whole point: THIS file cannot be imported by vitest at all, so a date boundary
// defined in it can only ever be asserted by spelling. See useBy.js's header and useBy.test.js.
export { classifyUseBy, dayMs, USE_SOON_FRACTION, etDay, ET_TZ };
export { HOUSE_SOURCED_SHELF_LIFE, defaultUseByTarget, validateCreate, validateUpdate };

export { reconcilePlantAttribution, plantingLabel };

// ── Planting attribution (L7 cross-field integrity) ──────────────────────────
// reconcilePlantAttribution + plantingLabel live in ./attribution.js — dependency-free so unit
// tests can import them without this file's neon/clerk/aws imports (which are NOT in the root
// package.json and so are absent under `npm ci` in CI). See that file's header.

// A malformed id must answer the SAME generic null/400 these loaders give a foreign id — never a
// 22P02 ("invalid input syntax for type uuid") falling through this handler's catch to an opaque
// 500. Same literal as household.js / authz-parents.js; declared locally because the four loaders
// below are module-private to this handler. (V4-AUTHZRESIDUE-001.)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Load the planting behind a plant_id, HOUSEHOLD-SCOPED. garden_node is the canonical plantings
// view (plants.name → display_name, plants.variety_id → cultivar_id); cultivar carries crop_type_slug.
// SCOPE (required — without it any authenticated user could attach another household's plant_id,
// which both leaks that planting's name/variety back through the read surface and writes a
// cross-household FK). A planting is in scope through its container's created_by, or — for
// container-less plantings, which exist (the integration fixture creates them) — its own.
// Both columns are populated on all 240 live plantings, so this is belt-and-braces, not a widening —
// every branch still terminates in `= ANY(householdIds)`.
// Returning null makes reconcilePlantAttribution reject with the generic "does not match a
// planting you can log against" — no existence oracle for out-of-household ids.
//
// V4-AUTHZRESIDUE-001 — RECONCILED TO THE STRICT DIALECT (household.js loadOwnedPlanting /
// authz-parents.js loadOwnedPlantingRef). The ownership arms previously read
// `gn.created_by = ANY(h) OR pp.created_by = ANY(h)`; the bare own-created_by arm reaches a planting
// the caller created INSIDE another household's container. The `container_id IS NULL` conjunct that
// now guards it is LOAD-BEARING — container-less plantings still resolve through that arm, it is
// narrowed rather than removed. (`garden_node.container_id` is the view's name for
// `plants.project_id`; this loader stays on the views because it also reads cultivar columns.)
//
// MEASURED, NOT ASSUMED, on BOTH environments: for the configured household the strict predicate
// accepts the identical planting set as the loose one (prod 269 = 269, staging 1 = 1, newly-rejected
// = 0), and 0 of the live preservation_log rows carrying a plant_id would fail it. No legitimate
// flow regresses.
//
// The UUID pre-check keeps a malformed plant_id on the SAME generic 400 as a foreign one. Without it
// a non-uuid string reached Postgres, raised 22P02, and fell through this handler's catch to an
// opaque 500 — a worse contract and a weak "is this even a uuid" side channel. validateCreate /
// validateUpdate do NOT shape-check plant_id, so that path was genuinely reachable.
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

// Verify a storage_location_id belongs to the caller's household. Returns { id, kind } (kind feeds
// the L6 shelf-life default) or null when the id is out-of-household / absent / soft-deleted — the
// same "no existence oracle → null" contract as loadPlanting. The storage_location_id FK enforces
// EXISTENCE, not ownership; this predicate is the ownership half. Mirrors storage_location's own
// scope (lambda/storage-location/index.js): user_id = ANY(householdIds) AND deleted_at IS NULL.
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

// Verify a harvest_log_id belongs to the caller's household. Returns { id } or null.
// Anchored on harvest_log.created_by (TEXT NOT NULL — always populated) rather than the project
// owner: care-rekey-001 made harvest_log.project_id NULLABLE (projectless plantings), so a
// project-owner anchor would wrongly reject an owner's OWN projectless harvest_log. No read surface
// JOINs harvest_log today, so this is defense-in-depth — it stops a cross-household harvest_log_id
// from being stored before any future read can leak it (the storage_location_id class, pre-empted).
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

// Verify a photo_id belongs to the caller's household. Returns { id } or null.
//
// V4-AUTHZRESIDUE-001 — THIS GATE WAS MISSING ENTIRELY. preservation_log.photo_id has a
// `REFERENCES photos(id)` FK (verified live) which enforces EXISTENCE and says nothing about
// OWNERSHIP, and body.photo_id was written verbatim on BOTH verbs while the sibling FKs
// (plant_id / storage_location_id / harvest_log_id) were all gated. photo_id is in projectRow(), so
// it is echoed back through all four GET routes — this is the same read-surface class as
// storage_location_id, not merely a bad FK.
//
// Anchored on photos.created_by (TEXT NOT NULL), NOT the nullable legacy uploaded_by — the same
// convention every other featured-photo validator uses, and the divergence
// lambda/authz-write-fk.test.js already forbids for locations.
//
// MEASURED: 0 live preservation_log rows carry a photo_id on prod, so this gate rejects nothing that
// exists today.

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const secrets = await getSecrets();

  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let userId;
  try {
    const payload = await verifyToken(token, {
      secretKey: secrets.CLERK_SECRET_KEY,
      authorizedParties: [
        'https://garden.futureishere.net',
        'https://dg6mmjhepoyt9.cloudfront.net',
      ],
    });
    userId = payload.sub;
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }
  // V4-AUTHZRESIDUE-001 (mirrors lambda/plants + lambda/photos): householdScope('') returns [''] and
  // `'' = ANY(ARRAY[''])` is TRUE in Postgres, so an empty/absent JWT subject would be a live
  // ownership value rather than a no-match — every `= ANY(householdIds)` predicate in this file
  // would then match rows whose owner column is ''. verifyToken rejects such a token first, so this
  // is defence-in-depth; the point is that the invariant is ENFORCED here rather than relied upon
  // from one layer up.
  if (!userId) return resp(401, { error: 'Unauthorized' });

  const sql = neon(secrets.NEON_DATABASE_URL);
  const householdIds = householdScope(userId);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/preservation';

  try {
    // ── /api/kitchen-batches/** (V5-INFLIGHTBATCH-001), delegated whole. ──
    // Returns null for every path that is not one of its own, so the preservation routes below are
    // reached unchanged. Household scope is passed in rather than recomputed — one call to
    // householdScope() per request, the same array every predicate in this handler binds.
    // ── POST /api/pantry/uses (Release F), a LITERAL matched first. '/api/pantry' resolves to this
    //    Lambda by prefix (src/lib/api.js), so no infra change is needed; nothing else here claims it.
    const use = await handlePantryUses({ sql, rawPath, method, rawBody: event.body, userId, householdIds });
    if (use) return resp(use.status, use.body);

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

    // ── /api/recipes/** (Put-Up release 4), delegated whole; null for every path that is not its own.
    const recipes = await handleRecipeRoute({
      sql, rawPath, method, rawBody: event.body, query: event.queryStringParameters ?? {}, userId, householdIds,
    });
    if (recipes) return resp(recipes.status, recipes.body);

    // ── /api/preservation/:id/sources (V5-PUTUPMULTISOURCE-001), delegated whole. ──
    // Placed HERE, above the literal sub-routes, and it is safe there because parseSourceRoute
    // matches ONLY /api/preservation/{uuid}/sources — the uuid shape is part of the pattern, so
    // '/api/preservation/whats-put-up/sources' returns null from it and falls through to the
    // existing handling rather than being claimed. Same null-for-not-mine contract as the kitchen
    // delegation above, and the same argument object, deliberately.
    const sources = await handleSourceRoute({
      sql,
      rawPath,
      method,
      rawBody: event.body,
      userId,
      householdIds,
    });
    if (sources) return resp(sources.status, sources.body);

    // ── PATCH /api/preservation/:id and POST /api/preservation/:id/move (Put-Up release 1b),
    //    delegated. parseJarRoute claims only a uuid-shaped id, and handleJarRoute returns null for
    //    every verb on /:id that is not PATCH, so GET / PUT / DELETE below are reached unchanged.
    const jar = await handleJarRoute({ sql, rawPath, method, rawBody: event.body, userId, householdIds });
    if (jar) return resp(jar.status, jar.body);

    // ── Literal sub-routes, checked BEFORE /api/preservation/:id so 'whats-put-up' / 'use-soon'
    //    are not mis-parsed as a row id (mirrors the inventory-items SEEDINV precedent). ──

    // GET /api/preservation/whats-put-up — grouped inventory (default by storage location).
    // ?group=crop regroups by crop_type (JOIN crop_types for display). NULL storage → "Unassigned".
    // Excludes soft-deleted + fully-consumed (remaining_count=0). Headlines count PACKAGES and list
    // per-record units — NEVER sums across incompatible quantity_units (L5).
    //
    // V4-HARVESTFATE-001 — ?include_consumed=1 keeps the fully-consumed rows in. STORES and FATE are
    // two different questions over one table: "what is in the freezer" must drop an empty jar, and
    // "where did this planting's harvest go" must not — an eaten jar is an ANSWER to the second and
    // absent from the first. Without this flag a planting reverts to "nothing put up" the day its
    // last jar is finished, silently rewriting its history. Zero live rows are consumed today
    // (5 of 5 have remaining_count > 0, prod 2026-08-24), so this changes no response yet; it is
    // here because the day it starts mattering is the day the record is already wrong.
    // OPT-IN: absent/anything-but-1 keeps the exclusion, so the Put-Up inventory page is untouched.
    if (rawPath === '/api/preservation/whats-put-up') {
      if (method !== 'GET') return resp(405, { error: 'Method not allowed' });
      const rawGroup = event.queryStringParameters?.group;
      const groupBy = rawGroup === 'crop' ? 'crop' : rawGroup === 'planting' ? 'planting' : 'storage';
      // Optional ?plant_id= — scopes the whole surface to ONE planting (the seed→…→put-up spine:
      // "what did wave 2 of the zucchini actually yield into the freezer"). Feeds the planting-detail
      // surface. Empty result is a legitimate answer, not a 404.
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
          // plant_id is OPTIONAL by design (a put-up drawn from several waves has no single
          // planting — design V101 line 57 "multi-planting → nullable"). Those land in an explicit
          // bucket rather than being hidden or forced into a false attribution.
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
      // Catch-all buckets sort last; otherwise alphabetical by label — EXCEPT plantings, which sort
      // by sown date so successive waves of the same variety read in the order they went in the
      // ground (alphabetical would interleave "wave 10" between 1 and 2).
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

    // GET /api/preservation/use-soon — server-side shelf-life window (L6). Returns rows whose STORED
    // use_by_target puts them in the final ~15–20% of their span ('use_soon') OR already past
    // ('past_use_by', distinct flag). Excludes null use_by_target, not-yet-soon, soft-deleted,
    // and fully-consumed. Never sums across incompatible units.
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

        // L7 cross-field: same planting reconciliation as POST, so an edit can't drift a put-up
        // onto a planting of a different crop.
        let attr = { crop_type_slug: body.crop_type_slug ?? null, variety_id: body.variety_id ?? null };
        if (body.plant_id) {
          const rec = reconcilePlantAttribution(body, await loadPlanting(sql, body.plant_id, householdIds));
          if (rec.error) return resp(400, { error: rec.error });
          attr = rec;
        }

        // AUTHZ (0A.5): a PUT can set/replace these FKs too, so it needs the same ownership gate as
        // POST — otherwise the edit path reopens exactly what the create path closes. Mirrors POST.
        if (body.storage_location_id) {
          const sl = await loadStorageLocation(sql, body.storage_location_id, householdIds);
          if (!sl) return resp(400, { error: 'storage_location_id does not match a storage location you can use' });
        }
        if (body.harvest_log_id) {
          const hl = await loadHarvestLog(sql, body.harvest_log_id, householdIds);
          if (!hl) return resp(400, { error: 'harvest_log_id does not match a harvest you can log against' });
        }
        // V4-AUTHZRESIDUE-001: photo_id was the one body-settable FK on this handler with no
        // ownership gate, on either verb — and it IS a read surface (projectRow echoes it back).
        if (body.photo_id) {
          const ph = await loadOwnedPhoto(sql, body.photo_id, householdIds);
          if (!ph) return resp(400, { error: 'photo_id does not match a photo you can use' });
        }

        // Put-Up release 1b — THE LEGACY PUT'S "FROM 1b" RULES (V4's legacy-PUT section). This PUT is
        // now the shipped bundle's door only: the 1b client moves a jar through Move and edits its
        // date, method and notes through PATCH /api/preservation/:id, and it stops echoing them here.
        //   * AN ABSENT KEY IS UNCHANGED, on every column. Today (1a) an absent remaining_count wrote
        //     NULL and an absent package_count wrote 1; a 1b bundle that omits them must not do that.
        //     A present key behaves as 1a's did, except for the five below.
        //   * storage_location_id, use_by_target, method, method_other_text, notes: this PUT no longer
        //     WRITES them. A present value EQUAL to the stored one is the shipped echo (a no-op); one
        //     that DIFFERS is a tab older than the row (another phone moved the jar, or corrected its
        //     date) — 409 client_stale, decided in the UPDATE's WHERE on the row it locks. Dates
        //     compare as ::date; the two text columns compare trimmed, with blank = NULL, which is how
        //     the shipped RowEditor writes them, so an untouched echo can never read as a change.
        //   * THE STALE-TAB COUNT RACE (05 §6a). A package_count that differs from the stored one AND
        //     a remaining_count that differs from the stored one is neither shipped action on a fresh
        //     row (a count edit echoes the remaining; a Mark used echoes the count): it is a tab that
        //     missed somebody else's count edit, whose Mark used would otherwise be read as a count
        //     change and revert their count. Refused as client_stale, in the WHERE, race-free.
        //   * The stored quantity pair is KEPT when quantity_value is null, absent or 0.
        //   * Attribution and a named Other are judged on the EFFECTIVE row, by the relaxed CHECKs
        //     (chk_preservation_log_attribution / _method_other name the stored label), mapped to words
        //     in the catch below.
        // Every preservation_log write runs in sql.transaction([set_config(actor), write]):
        // trg_audit_preservation_log_upd records who changed what (V4 "Audit").
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

        const [, rows] = await sql.transaction([
          sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
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
          // Branched EXPLICITLY (boss-technical, the used-up variant), never left to countRefusal's
          // fall-through, which would answer a stale Used up with count_below_used.
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
        // Put-Up release 1b: deleted_at is a watched column of trg_audit_preservation_log_upd, so the
        // actor GUC rides in the same transaction (V4 "Audit"; lambda/audit-actor-guc.test.js).
        const [, rows] = await sql.transaction([
          sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
          sql`
          UPDATE preservation_log
          SET deleted_at = NOW()
          WHERE id = ${rowId}
            AND user_id = ANY(${householdIds})
            AND deleted_at IS NULL
          RETURNING id
        `,
        ]);
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
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

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const verr = validateCreate(body);
      if (verr) return resp(400, { error: verr });

      // L7 cross-field: resolve the planting FIRST — it can supply the crop/variety the DB CHECK
      // needs, and it rejects a planting that contradicts an explicitly-picked crop or variety.
      let attr = { crop_type_slug: body.crop_type_slug ?? null, variety_id: body.variety_id ?? null };
      if (body.plant_id) {
        const rec = reconcilePlantAttribution(body, await loadPlanting(sql, body.plant_id, householdIds));
        if (rec.error) return resp(400, { error: rec.error });
        attr = rec;
      }
      // 1b: a label attributes a jar on its own (chk_preservation_log_attribution, relaxed in place).
      if (!attr.crop_type_slug && !attr.variety_id && normalizeText(body.label) == null) {
        return resp(400, { error: 'that planting has no variety — pick a crop as well' });
      }

      // AUTHZ (0A.5): validate the two nullable, owner-scoped FKs BEFORE insert. The FK enforces
      // EXISTENCE, not ownership — without these an authed user could attach another household's
      // storage_location_id (leaked straight back as storage_label + storage_kind through the four
      // read surfaces that LEFT JOIN storage_location) or harvest_log_id (no read JOINs it TODAY, so
      // that arm is defense-in-depth against a future Finding-1-class leak). Same "no existence
      // oracle" reject shape as the planting path. storageKind is reused for the L6 default below so
      // the ownership check runs UNCONDITIONALLY — not only when use_by_target is omitted (the old
      // bypass: an explicit use_by_target skipped the kind lookup and stored the id unchecked).
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
      // V4-AUTHZRESIDUE-001: mirrors the PUT gate above — see loadOwnedPhoto.
      if (body.photo_id) {
        const ph = await loadOwnedPhoto(sql, body.photo_id, householdIds);
        if (!ph) return resp(400, { error: 'photo_id does not match a photo you can use' });
      }

      const packageCount = body.package_count ?? 1;
      // Fresh put-up: initialize remaining_count so the decrement/"used up" flow + fully-consumed
      // filter are meaningful from the first row (L4). Client may override.
      const remaining = body.remaining_count ?? packageCount;

      // L6, as release 1b states it (V4's one discard-by rule): a PRESENT use_by_target is his date —
      // basis 'typed', including an explicit null ("no date · set by hand"); an ABSENT one is the
      // engine's, resolved from the method, the place's kind and the 1b facts, with its basis.
      // storageKind was resolved (and ownership-validated) above — no second lookup.
      const typed = Object.prototype.hasOwnProperty.call(body, 'use_by_target');
      const precision = body.preserved_at_precision ?? null;
      const resolved = typed
        ? { use_by_target: body.use_by_target == null ? null : String(body.use_by_target).slice(0, 10), use_by_basis: 'typed' }
        : resolveJarUseBy({
            method: body.method, kind: storageKind, isRaw: body.is_raw ?? null, inOil: body.in_oil ?? null,
            texture: body.texture ?? null, precision,
          }, body.preserved_at);
      // Release F: a typed heat estimate on a jar is 'typed' (only shu-estimate/save writes 'computed').
      const shuLow = body.shu_est_low == null ? null : Number(body.shu_est_low);
      const shuHigh = shuLow == null ? null : Number(body.shu_est_high ?? body.shu_est_low);
      // pH at bottling: ph_read_at defaults to the jar's own date, never earlier (V4 pH section).
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
        // V4 "Idempotency": a 23505 on THIS index (only this one) is a replay — re-read the jar by its
        // key, owner-scoped; a key someone outside the household holds is a 409 with no payload.
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
    console.error('preservation lambda error', err);
    // V5-INFLIGHTBATCH-001: the kitchen_* CHECKs, given words. Consulted FIRST and returns null for
    // anything it does not own, so every mapping below keeps its existing behaviour. The one overlap
    // is chk_preservation_log_one_provenance, which only the batch close-out route can violate.
    const kitchenMsg = kitchenErrorMessage(err);
    if (kitchenMsg) return resp(400, { error: kitchenMsg });
    // Put-Up release 1b: the relaxed and new preservation_log CHECKs, given words (jarRules.js).
    const jarMsg = jarErrorMessage(err);
    if (jarMsg) return resp(400, { error: jarMsg });
    // V5-PUTUPMULTISOURCE-001: the preservation_source CHECKs, given words. Same null-for-not-mine
    // contract, and it cannot shadow the kitchen mapper above or the two putupprov mappings below —
    // its constraint names are all chk_ps_* and share no spelling with either set.
    const sourceMsg = sourceErrorMessage(err);
    if (sourceMsg) return resp(400, { error: sourceMsg });
    // 42P01 = relation missing, the OTHER half of the 42703 case below and the expected failure in the
    // window this feature's sequencing creates: old schema + new Lambda 500s on every batch route.
    // Without this the operator gets a bare "Internal server error" during exactly that window.
    if (err.code === '42P01') {
      return resp(500, { error: `Schema out of date for this deploy — relation missing: ${err.message}` });
    }
    // V4-PUTUPPROV-001: give the two provenance CHECKs human text. validateUpdate deliberately
    // skips provenance when a PUT omits source_kind (it cannot see the STORED kind without a read),
    // so these are genuinely reachable — and RecordRow.put() would otherwise swallow them into an
    // undiagnosable "try again" retry loop.
    if (err.code === '23514' && err.constraint === 'chk_preservation_log_source_plant') {
      return resp(400, { error: 'This put-up is linked to a planting, so its source must be your own garden. Clear the planting first.' });
    }
    if (err.code === '23514' && String(err.constraint ?? '').startsWith('chk_preservation_log_source')) {
      return resp(400, { error: `Source is not valid: ${err.constraint}` });
    }
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    // 42703 = the Lambda shipped ahead of this environment's DDL. Without this the operator gets a
    // bare "Internal server error" during exactly the window the migration sequencing creates.
    if (err.code === '42703') return resp(500, { error: `Schema out of date for this deploy — column missing: ${err.column ?? err.message}` });
    if (err.code === '23502') return resp(400, { error: `Required field missing: ${err.column ?? err.message}` });
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};
