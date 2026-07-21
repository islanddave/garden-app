// V4-HARVESTCENTER-001 (Put-Up) — preservation_log CRUD + read surfaces Lambda.
// Mirrors lambda/inventory-items/index.js (auth/scope/resp skeleton, PG error-code map) and its
// literal-subroute-before-:id routing (the SEEDINV sow-candidates/extract-seeds precedent):
// /api/preservation/whats-put-up and /api/preservation/use-soon are matched BEFORE the :id route.
// Owner column is user_id (not created_by). Soft-Delete-Only: every read filters deleted_at IS NULL.
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { householdScope } from './household.js';
import { reconcilePlantAttribution, plantingLabel } from './attribution.js';

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
  'can_water_bath', 'can_pressure', 'jam_preserve', 'ferment', 'cure_store', 'cold_store', 'other',
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

export function validateCreate(body) {
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

// PUT is "replace editable fields" (frontend sends a complete payload) INCLUDING the minimal
// decrement (remaining_count / consumed_at). Same core validation as create.
export const validateUpdate = validateCreate;

export { reconcilePlantAttribution, plantingLabel };

// ── Planting attribution (L7 cross-field integrity) ──────────────────────────
// reconcilePlantAttribution + plantingLabel live in ./attribution.js — dependency-free so unit
// tests can import them without this file's neon/clerk/aws imports (which are NOT in the root
// package.json and so are absent under `npm ci` in CI). See that file's header.

// Load the planting behind a plant_id, HOUSEHOLD-SCOPED. garden_node is the canonical plantings
// view (plants.name → display_name, plants.variety_id → cultivar_id); cultivar carries crop_type_slug.
// SCOPE (required — without it any authenticated user could attach another household's plant_id,
// which both leaks that planting's name/variety back through the read surface and writes a
// cross-household FK). A planting is in scope when EITHER its own created_by or its container's
// is in the household: lambda/plants scopes through container.created_by, but garden_node carries
// created_by too, and container-less plantings exist (the integration fixture creates them). Both
// columns are populated on all 240 live plantings, so this is belt-and-braces, not a widening —
// every branch still terminates in `= ANY(householdIds)`.
// Returning null makes reconcilePlantAttribution reject with the generic "does not match a
// planting you can log against" — no existence oracle for out-of-household ids.
async function loadPlanting(sql, plantId, householdIds) {
  const rows = await sql`
    SELECT gn.id, gn.display_name, gn.sown_at, gn.succession_order, gn.succession_group_id,
           gn.cultivar_id AS variety_id, cv.crop_type_slug, cv.display_name AS variety_name
    FROM garden_node gn
    LEFT JOIN container pp ON pp.id = gn.container_id
    LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
    WHERE gn.id = ${plantId}
      AND gn.deleted_at IS NULL
      AND (gn.created_by = ANY(${householdIds}) OR pp.created_by = ANY(${householdIds}))
  `;
  return rows.length ? rows[0] : null;
}

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
    if (rawPath === '/api/preservation/whats-put-up') {
      if (method !== 'GET') return resp(405, { error: 'Method not allowed' });
      const rawGroup = event.queryStringParameters?.group;
      const groupBy = rawGroup === 'crop' ? 'crop' : rawGroup === 'planting' ? 'planting' : 'storage';
      // Optional ?plant_id= — scopes the whole surface to ONE planting (the seed→…→put-up spine:
      // "what did wave 2 of the zucchini actually yield into the freezer"). Feeds the planting-detail
      // surface. Empty result is a legitimate answer, not a 404.
      const plantFilter = event.queryStringParameters?.plant_id || null;
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
          AND (p.remaining_count IS NULL OR p.remaining_count > 0)
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

      const packageCount = body.package_count ?? 1;
      // Fresh put-up: initialize remaining_count so the decrement/"used up" flow + fully-consumed
      // filter are meaningful from the first row (L4). Client may override.
      const remaining = body.remaining_count ?? packageCount;

      // L6: auto-apply the shelf-life default use_by_target when the client did not send one.
      // Explicit null => "no expiry" (kept null, excluded from use-soon). Needs the storage kind.
      let useByTarget = body.use_by_target;
      if (useByTarget === undefined) {
        let kind = null;
        if (body.storage_location_id) {
          const sk = await sql`SELECT kind FROM storage_location WHERE id = ${body.storage_location_id} AND user_id = ANY(${householdIds}) AND deleted_at IS NULL`;
          kind = sk.length ? sk[0].kind : null;
        }
        useByTarget = defaultUseByTarget(body.method, kind, body.preserved_at);
      }

      const rows = await sql`
        INSERT INTO preservation_log (
          user_id, crop_type_slug, variety_id, plant_id, harvest_log_id,
          preserved_at, method, method_other_text, quantity_value, quantity_unit,
          package_count, storage_location_id, use_by_target, remaining_count, notes, photo_id
        ) VALUES (
          ${userId}, ${attr.crop_type_slug ?? null}, ${attr.variety_id ?? null}, ${body.plant_id ?? null}, ${body.harvest_log_id ?? null},
          ${body.preserved_at}, ${body.method}, ${body.method === 'other' ? (body.method_other_text ?? null) : null}, ${body.quantity_value}, ${body.quantity_unit},
          ${packageCount}, ${body.storage_location_id ?? null}, ${useByTarget ?? null}, ${remaining}, ${body.notes ?? null}, ${body.photo_id ?? null}
        ) RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('preservation lambda error', err);
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    if (err.code === '23502') return resp(400, { error: `Required field missing: ${err.column ?? err.message}` });
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};
