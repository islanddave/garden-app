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
import { VALID_SOURCE_KINDS, validateProvenance, normalizeSourceLabel } from './provenance.js';

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

// Mirrors chk_preservation_log_method — belt-and-suspenders over the DB CHECK (L5 vocab).
const VALID_METHODS = [
  'roast_freeze', 'whole_freeze', 'blanch_freeze', 'dehydrate', 'powder', 'passata',
  'can_water_bath', 'can_pressure', 'jam_preserve', 'ferment', 'cure_store', 'cold_store',
  // D6 (V4-PUTUPPROV-001): bought already preserved. No method was performed here — every other
  // value in this list asserts an action Dave took, so store-bought frozen fruit previously had to
  // be logged as 'other', overloading that escape hatch until it meant two unrelated things.
  'purchased_preserved',
  // V4-PUTUPTAXONOMY-001 (BD-034). Four values Dave's practice needed and this list did not have.
  // quick_pickle: vinegar pickling — NOT a ferment (no lactic culture) and not necessarily
  //   processed (a fridge pickle never is). It was already the ONLY method='other' row in prod
  //   ('Vinegar dill pickles'), i.e. a food-safety-distinct process living in the escape hatch.
  // pesto / hot_sauce: named by Dave. Both name a DISH rather than a process and so fail the strict
  //   "does it move the shelf-life number" axis test — recorded in the migration header rather than
  //   silently resolved. They ship because this is the field he reads back, and 2 of 5 live rows are
  //   pesto currently mis-filed as passata.
  // ferment_mash: an UNFINISHED intermediate — still working, not a finished preserve.
  'quick_pickle', 'pesto', 'hot_sauce', 'ferment_mash',
  'other',
];

// ── Shelf-life defaults (L6): MONTHS from the put-up date, keyed by method × storage-kind. ──
// SOURCE (cited per boss-strategic safety note — these drive "use soon" on stored FOOD and must
// NOT be one-person hand-invented): National Center for Home Food Preservation (NCHFP,
// nchfp.uga.edu) & USDA Complete Guide to Home Canning (Agriculture Information Bulletin No. 539);
// freezer figures per USDA "Freezing and Food Safety" (0°F / -18°C storage). Published ranges are
// collapsed to a single conservative default; deep_freezer (0°F) gets the upper end, fridge_freezer
// (3–6 mo, not held at 0°F) the lower. Values are DEFAULTS: user-overridable per row (L6). A null
// result => no default expiry (row excluded from "use soon" until a use_by_target is set).
const SHELF_LIFE_MONTHS = {
  roast_freeze:   { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  whole_freeze:   { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  blanch_freeze:  { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  dehydrate:      { pantry: 12, cold_storage: 12, default: 12 },
  powder:         { pantry: 18, cold_storage: 18, default: 18 },   // powdered: 18–24 mo (NCHFP dehydrate)
  passata:        { pantry: 12, cold_storage: 18, default: 12 },   // canned tomato sauce, high-acid
  can_water_bath: { pantry: 12, cold_storage: 18, default: 12 },   // high-acid: 12–18 mo best quality
  can_pressure:   { pantry: 12, cold_storage: 12, default: 12 },   // low-acid pressure-canned: ~12 mo
  jam_preserve:   { pantry: 12, cold_storage: 18, default: 12 },
  ferment:        { fridge: 6, fridge_freezer: 6, cold_storage: 8, default: 6 }, // fridge ferment 4–8 mo
  cure_store:     { cold_storage: 4, pantry: 3, default: 4 },      // squash 3–6, garlic 6–8, potatoes 4–9 (crop-varying; conservative default)
  cold_store:     { cold_storage: 6, fridge: 4, default: 4 },
  // ── V4-PUTUPTAXONOMY-001 (BD-034). ───────────────────────────────────────────────────────────
  // A CITED ENTRY HERE IS A HARD PRECONDITION FOR A NEW METHOD, not a nicety. shelfLifeMonths()
  // returns null for a method absent from this table, which yields no use_by_target, and use-soon
  // then never surfaces the row: the 'Vinegar dill pickles' row is already the only one of five
  // live put-ups with use_by_target IS NULL, purely because it had to be logged as 'other'. Four
  // uncited methods would have taken that from one-in-five to five-in-nine.
  //
  // Every figure below is DERIVED from a source already cited at the head of this table, never
  // freshly invented — the derivation is named per line. `smoke` was dropped from this change for
  // exactly this reason: no defensible published figure could be sourced, and shipping it uncited
  // would have widened the blind spot this block exists to close.
  //
  // quick_pickle spans two real cases. Processed in a water-bath it IS shelf-stable, so the pantry
  // and cold-storage figures are the high-acid canning ones; unprocessed it is a fridge item, so
  // `fridge` takes NCHFP's refrigerator-pickle figure. The DEFAULT is the fridge number, because an
  // unrecorded storage kind must not be read as "somebody processed this".
  quick_pickle:   { pantry: 12, cold_storage: 12, fridge: 2, deep_freezer: 12, fridge_freezer: 4, default: 2 },
  // pesto is a frozen product — both live pesto rows sit in a deep freezer (prod, 2026-08-25) — so
  // it inherits the freeze family verbatim (USDA "Freezing and Food Safety", 0degF). This is also
  // the point the crucible made against pesto as a METHOD: frozen pesto keeps exactly as long as
  // anything else frozen, which is why these numbers are identical to whole_freeze's and not a
  // separate judgement.
  pesto:          { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  // hot_sauce is an acidified product — fermented or vinegar-based — so the shelf-stable kinds take
  // the high-acid canning figures (as passata and can_water_bath do) and the fridge kind takes the
  // fermented figure from `ferment` below-line. No new source, two existing rows recombined.
  hot_sauce:      { pantry: 12, cold_storage: 18, fridge: 6, default: 12 },
  // ferment_mash inherits `ferment` EXACTLY. A mash under brine is preserved by the same acidity as
  // a finished ferment and lives in the same places, so shortening it would be an invented number
  // dressed as caution. What makes it a distinct value is that it is UNFINISHED, which the label
  // carries; that is a fact about the food, not about how long it keeps.
  ferment_mash:   { fridge: 6, fridge_freezer: 6, cold_storage: 8, default: 6 },
  // D6: acquisition age is unknown, so there is no honest shelf-life anchor. NULL => no default
  // expiry => excluded from "use soon" until the user sets one. Same reasoning as the non-garden
  // suppression in the create path below.
  purchased_preserved: { default: null },
  other:          { default: null },
};

// "use soon" occupies the final USE_SOON_FRACTION of the preserved_at→use_by_target span (L6: ~15–20%).
const USE_SOON_FRACTION = 0.175;

function shelfLifeMonths(method, kind) {
  const m = SHELF_LIFE_MONTHS[method];
  if (!m) return null;
  const v = kind != null && kind in m ? m[kind] : m.default;
  return v ?? null;
}

// date (YYYY-MM-DD string, ISO string, or Date) + n months → YYYY-MM-DD (clamps day to the
// target month's last day).
function addMonths(dateInput, months) {
  const src = dateInput instanceof Date ? dateInput.toISOString() : String(dateInput);
  const [y, mo, d] = src.slice(0, 10).split('-').map(Number);
  const base = new Date(Date.UTC(y, mo - 1, d));
  const targetMonth = base.getUTCMonth() + months;
  const t = new Date(Date.UTC(base.getUTCFullYear(), targetMonth, 1));
  const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, lastDay));
  return t.toISOString().slice(0, 10);
}

// L6 default use-by from the shelf-life table; null method/kind combo => null (no expiry).
export function defaultUseByTarget(method, kind, preservedAt) {
  const months = shelfLifeMonths(method, kind);
  if (months == null || !preservedAt) return null;
  return addMonths(preservedAt, months);
}

// UTC-midnight epoch ms for a Date OR a YYYY-MM-DD / ISO string. The neon driver returns date/
// timestamptz columns as JS Date objects, so String(v).slice(0,10) is NOT safe — normalize both.
function dayMs(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Classify a row's freshness against its STORED use_by_target (L6 window, server-side).
// Returns 'past_use_by' | 'use_soon' | 'ok'; null when there is no use_by_target (no expiry).
export function classifyUseBy(preservedAt, useByTarget, now = new Date()) {
  if (!useByTarget) return null;
  const preserved = dayMs(preservedAt);
  const useBy = dayMs(useByTarget);
  const nowMs = now.getTime();
  if (nowMs > useBy) return 'past_use_by';
  const span = useBy - preserved;
  if (span <= 0) return 'use_soon'; // degenerate/zero span already at expiry
  const threshold = useBy - span * USE_SOON_FRACTION;
  return nowMs >= threshold ? 'use_soon' : 'ok';
}

function validateCommon(body) {
  if (!body || typeof body !== 'object') return 'body required';
  // L7: at least one of {crop_type_slug, variety_id, plant_id}. The DB CHECK only knows about the
  // first two (chk_preservation_log_attribution) — plant_id is accepted here because the handler
  // DERIVES crop+variety from the planting before insert, so the CHECK is always satisfied by the
  // time the row lands. Picking a planting alone is complete attribution from the user's side.
  if (!body.crop_type_slug && !body.variety_id && !body.plant_id) {
    return 'at least one of crop_type_slug, variety_id or plant_id is required';
  }
  if (!body.method || !VALID_METHODS.includes(body.method)) return `method must be one of: ${VALID_METHODS.join(', ')}`;
  if (body.method === 'other' && (!body.method_other_text || !String(body.method_other_text).trim())) {
    return "method_other_text is required when method is 'other'";
  }
  if (body.quantity_value == null || Number(body.quantity_value) <= 0) return 'quantity_value must be > 0';
  if (!body.quantity_unit || !String(body.quantity_unit).trim()) return 'quantity_unit is required';
  if (body.package_count != null && Number(body.package_count) < 1) return 'package_count must be >= 1';
  if (!body.preserved_at) return 'preserved_at is required';
  if (body.remaining_count != null && Number(body.remaining_count) < 0) return 'remaining_count must be >= 0';
  return null;
}

export function validateCreate(body) {
  return validateCommon(body) ?? validateProvenance(body);
}

// PUT is "replace editable fields" (frontend sends a complete payload) INCLUDING the minimal
// decrement (remaining_count / consumed_at).
//
// validateUpdate is NO LONGER an alias for validateCreate (V4-PUTUPPROV-001). It was
// `export const validateUpdate = validateCreate`, which meant every rule added to create became a
// hard requirement on every PUT — including the one-tap "Mark used" decrement the user never
// experiences as a form submit. A service-worker-cached bundle built before this ship omits
// source_kind entirely, so aliasing would 400 every decrement for the length of the cache window.
// Rule: a payload that never mentions provenance is not judged on it. Pairs with the
// COALESCE-preserve UPDATE below — absent key means "unchanged", at both layers.
export function validateUpdate(body) {
  return validateCommon(body) ?? (body.source_kind === undefined ? null : validateProvenance(body));
}

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

// Shared row projection for the read surfaces (single source of columns).
function projectRow(r) {
  return {
    id: r.id,
    user_id: r.user_id,
    crop_type_slug: r.crop_type_slug,
    variety_id: r.variety_id,
    plant_id: r.plant_id,
    // Planting provenance for display (present only on reads that JOIN garden_node). Lets the
    // record row say WHICH wave a put-up came from without a second round-trip.
    planting_name: r.planting_name ?? null,
    planting_sown_at: r.planting_sown_at ?? null,
    planting_succession_order: r.planting_succession_order ?? null,
    harvest_log_id: r.harvest_log_id,
    preserved_at: r.preserved_at,
    method: r.method,
    method_other_text: r.method_other_text,
    quantity_value: r.quantity_value,
    quantity_unit: r.quantity_unit,
    package_count: r.package_count,
    storage_location_id: r.storage_location_id,
    use_by_target: r.use_by_target,
    remaining_count: r.remaining_count,
    consumed_at: r.consumed_at,
    notes: r.notes,
    photo_id: r.photo_id,
    // V4-PUTUPPROV-001. projectRow is an explicit whitelist and is the ONLY projection for all four
    // GET routes, while POST/PUT return raw rows[0] from RETURNING *. So omitting these here is
    // INVISIBLE to create-path smoke testing: the POST echoes them back correctly while every read
    // surface renders blank. That asymmetry is why this line has a comment.
    source_kind: r.source_kind ?? null,
    source_label: r.source_label ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    use_by_status: classifyUseBy(r.preserved_at, r.use_by_target),
  };
}

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
        const verr = validateUpdate(body);
        if (verr) return resp(400, { error: verr });

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

        const packageCount = body.package_count ?? 1;
        const remaining = body.remaining_count ?? null;
        // Server convenience for the "used up" case: stamp consumed_at when count hits 0 and the
        // client did not supply one. Otherwise pass the client value through (L4 minimal decrement).
        const consumedAt = body.consumed_at ?? (Number(remaining) === 0 ? new Date().toISOString() : null);

        const rows = await sql`
          UPDATE preservation_log SET
            crop_type_slug      = ${attr.crop_type_slug ?? null},
            variety_id          = ${attr.variety_id ?? null},
            plant_id            = ${body.plant_id ?? null},
            harvest_log_id      = ${body.harvest_log_id ?? null},
            preserved_at        = ${body.preserved_at},
            method              = ${body.method},
            method_other_text   = ${body.method === 'other' ? (body.method_other_text ?? null) : null},
            quantity_value      = ${body.quantity_value},
            quantity_unit       = ${body.quantity_unit},
            package_count       = ${packageCount},
            storage_location_id = ${body.storage_location_id ?? null},
            use_by_target       = ${body.use_by_target ?? null},
            remaining_count     = ${remaining},
            consumed_at         = ${consumedAt},
            notes               = ${body.notes ?? null},
            photo_id            = ${body.photo_id ?? null},
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
          RETURNING *
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        const rows = await sql`
          UPDATE preservation_log
          SET deleted_at = NOW()
          WHERE id = ${rowId}
            AND user_id = ANY(${householdIds})
            AND deleted_at IS NULL
          RETURNING id
        `;
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
      if (!attr.crop_type_slug && !attr.variety_id) {
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

      // L6: auto-apply the shelf-life default use_by_target when the client did not send one.
      // Explicit null => "no expiry" (kept null, excluded from use-soon). storageKind was resolved
      // (and ownership-validated) above — no second lookup.
      let useByTarget = body.use_by_target;
      if (useByTarget === undefined) {
        useByTarget = defaultUseByTarget(body.method, storageKind, body.preserved_at);
      }

      const rows = await sql`
        INSERT INTO preservation_log (
          user_id, crop_type_slug, variety_id, plant_id, harvest_log_id,
          preserved_at, method, method_other_text, quantity_value, quantity_unit,
          package_count, storage_location_id, use_by_target, remaining_count, notes, photo_id,
          source_kind, source_label
        ) VALUES (
          ${userId}, ${attr.crop_type_slug ?? null}, ${attr.variety_id ?? null}, ${body.plant_id ?? null}, ${body.harvest_log_id ?? null},
          ${body.preserved_at}, ${body.method}, ${body.method === 'other' ? (body.method_other_text ?? null) : null}, ${body.quantity_value}, ${body.quantity_unit},
          ${packageCount}, ${body.storage_location_id ?? null}, ${useByTarget ?? null}, ${remaining}, ${body.notes ?? null}, ${body.photo_id ?? null},
          ${body.source_kind ?? null}, ${body.source_kind === 'own_garden' ? null : normalizeSourceLabel(body.source_label)}
        ) RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('preservation lambda error', err);
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
