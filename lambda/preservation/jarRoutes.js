// Put-Up release 1b — the two jar writers that are not the legacy PUT:
//   PATCH /api/preservation/:id        presence-sentinel edit + V4's correction rule
//   POST  /api/preservation/:id/move   a place change + V4's move rule
//
// WHY A SIBLING MODULE. Same reason as kitchenRoutes.js and sourceRoutes.js: index.js loads neon, clerk
// and aws at module scope, so a route written there is asserted only by its spelling. This file takes
// `sql` as an argument and imports only dependency-free siblings, so every statement below is EXECUTED
// under `npm test` against a mock driver (jarRoutes.test.js). index.js delegates to it with the same
// null-for-not-mine contract the kitchen and sources delegations use.
//
// THE DATE RULES LIVE IN ONE PLACE PER RULE (V4 "What changes a date after it is written"):
//   * resolveJarUseBy (shelfLife.js) is the engine answer — never re-derived here.
//   * correctionUseBy / moveUseBy below decide WHEN the engine is consulted, from the stored basis.
// A stored basis of NULL is a row written before 1b whose backfill (0p) has not run: its date's
// provenance is unknown, so it is treated as TYPED — never re-derived, never nulled. Destroying a date
// someone may have typed is the failure mode; keeping a table date one extra edit is not.
//
// OPTIMISTIC GUARD. Both writers read the jar, compute the date in JS (the engine is JS), then write.
// When the write depends on what was read, it carries `AND xmin = <read xmin>`: xmin changes on every
// UPDATE of the row, so any write in between (another phone's Mark used, Move, PATCH) makes this one
// match 0 rows, and the answer is 409 client_stale — the shipped client's Refresh door. A PATCH that
// touches nothing the date rule reads (a name, a note) carries no guard, so a concurrent Mark used can
// never make a label edit fail.
//
// AUDIT. preservation_log carries trg_audit_preservation_log_upd (1b). Every write here runs in
// sql.transaction([set_config('app.actor_clerk_sub', <sub>, true), <write>]) — the grouping
// lambda/audit-actor-guc.test.js asserts.
import { resolveJarUseBy } from './shelfLife.js';
import {
  VALID_METHODS, projectRow, clientStale, normalizeJarText, normalizeJarUnit, isJarDate,
  jarLabelError, jarQuantityError, jarPhError, JAR_TEXTURES, JAR_TEXTURE_METHODS,
} from './jarRules.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const has = (body, k) => Object.prototype.hasOwnProperty.call(body, k);
const notFound = { status: 404, body: { error: 'Not found', code: 'not_found' } };
const bad = (error) => ({ status: 400, body: { error } });
const stale = () => ({ status: 409, body: clientStale() });

// storage_location.kind (chk_storage_location_kind).
export const PLACE_KINDS = ['deep_freezer', 'fridge_freezer', 'fridge', 'pantry', 'cold_storage', 'other'];

// Returns { id } or { id: null } for paths that are ours, null otherwise.
export function parseJarRoute(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const m = rawPath.match(/^\/api\/preservation\/([0-9a-f-]{36})(?:\/(move))?\/?$/i);
  if (!m || !UUID_RE.test(m[1])) return null;
  return { id: m[1], sub: m[2] ?? null };
}

export async function handleJarRoute({ sql, rawPath, method, rawBody, userId, householdIds }) {
  const route = parseJarRoute(rawPath);
  if (!route) return null;
  if (route.sub === 'move') {
    if (method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
    return moveJar(sql, route.id, JSON.parse(rawBody ?? '{}'), userId, householdIds);
  }
  // Only PATCH is ours on /:id; GET, PUT and DELETE stay in index.js (null = fall through).
  if (method !== 'PATCH') return null;
  return patchJar(sql, route.id, JSON.parse(rawBody ?? '{}'), userId, householdIds);
}

// ── the jar, as the date rules read it ───────────────────────────────────────────────────────────
async function loadJar(sql, jarId, householdIds) {
  const rows = await sql`
    SELECT p.id, p.method, p.method_other_text, p.label, p.is_raw, p.in_oil, p.texture,
           p.storage_location_id, s.kind AS storage_kind, p.preserved_at, p.preserved_at_precision,
           p.use_by_target, p.use_by_basis, p.storage_moved_at, p.xmin::text AS row_version
    FROM preservation_log p
    LEFT JOIN storage_location s ON s.id = p.storage_location_id
    WHERE p.id = ${jarId}::uuid
      AND p.user_id = ANY(${householdIds})
      AND p.deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

const dayOf = (v) => {
  if (v == null) return null;
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};

const factsOf = (jar, kind) => ({
  method: jar.method, kind: kind ?? null, isRaw: jar.is_raw ?? null, inOil: jar.in_oil ?? null,
  texture: jar.texture ?? null, precision: jar.preserved_at_precision ?? null,
});

// ── V4: "A correction of method, Raw/In oil or texture at the same place re-derives a table/house date
// from the jar's stored anchor if the jar has never moved, else nulls. Typed dates (and an explicit
// 'no date') survive; a recipe date survives while the storage kind still matches. Clearing a typed date
// ('clear' on the PATCH) resolves the same way." Returns null for "leave the date as it is".
export function correctionUseBy(stored, next, { clearing = false } = {}) {
  const basis = stored.use_by_basis ?? null;
  if (!clearing) {
    if (basis == null || basis === 'typed' || basis === 'recipe') return null;
  }
  if (stored.storage_moved_at != null) return { use_by_target: null, use_by_basis: 'none' };
  // The anchor is the STORED put-up date and its precision (a correction never changes when it was put
  // up); the facts are the corrected ones.
  return resolveJarUseBy({ ...factsOf(next, stored.storage_kind), precision: stored.preserved_at_precision ?? null },
    dayOf(stored.preserved_at));
}

// ── V4: "A Move (a change of storage kind, a thaw included) nulls every date that is not typed —
// table, house AND recipe — and stamps storage_moved_at. It never re-derives. Exception: house-sourced
// rows (candy) re-derive from the move date with the destination leg." A move within one kind (Chest
// Freezer 1 → Chest Freezer 2) is not a change of storage kind: the date and storage_moved_at stay, so
// a later correction can still re-derive from the anchor. Returns { kindChanged, useBy|null }.
export function moveUseBy(stored, destKind, moveDate) {
  const kindChanged = (stored.storage_kind ?? null) !== destKind;
  if (!kindChanged) return { kindChanged, useBy: null };
  const basis = stored.use_by_basis ?? null;
  if (basis == null || basis === 'typed') return { kindChanged, useBy: null };
  if (basis === 'house') {
    return { kindChanged, useBy: resolveJarUseBy({ ...factsOf(stored, destKind), precision: null }, moveDate) };
  }
  return { kindChanged, useBy: { use_by_target: null, use_by_basis: 'none' } };
}

// ── PATCH /api/preservation/:id ─────────────────────────────────────────────────────────────────
// Presence-sentinel (V4 API table): label, container_label, is_raw, in_oil, texture, the pH pair,
// method (+ method_other_text), discard_by (a date / "none" / "clear"), notes (full replace),
// notes_append, and the quantity pair (05 §6: "so the zucchini fix has a writer"). Absent = unchanged;
// an explicit null clears where the column is nullable. Anything else is refused: this is not the
// full-replace PUT, and a key it does not know is a client bug, never something to ignore.
export const JAR_PATCH_KEYS = [
  'label', 'container_label', 'is_raw', 'in_oil', 'texture', 'ph_reading', 'ph_read_at',
  'method', 'method_other_text', 'discard_by', 'notes', 'notes_append', 'quantity_value', 'quantity_unit',
  // Release F (contract-F §2.6): the jar's typed heat estimate and "Cooked after blending?".
  'shu_est_low', 'shu_est_high', 'cooked',
];

export function validateJarPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const unknown = Object.keys(body).filter((k) => !JAR_PATCH_KEYS.includes(k));
  if (unknown.length) return `these fields cannot be edited here: ${unknown.join(', ')}`;
  if (!Object.keys(body).length) return 'nothing to update';
  if (has(body, 'label') && body.label != null) {
    const e = jarLabelError(body.label); if (e) return e;
  }
  if (has(body, 'container_label') && body.container_label != null) {
    const e = jarLabelError(body.container_label, 'container_label'); if (e) return e;
  }
  for (const k of ['is_raw', 'in_oil']) {
    if (body[k] != null && typeof body[k] !== 'boolean') return `${k} must be true or false`;
  }
  if (body.texture != null && !JAR_TEXTURES.includes(body.texture)) {
    return `texture must be one of: ${JAR_TEXTURES.join(', ')}`;
  }
  if (has(body, 'method') && (!body.method || !VALID_METHODS.includes(body.method))) {
    return `method must be one of: ${VALID_METHODS.join(', ')}`;
  }
  if (has(body, 'method_other_text') && !has(body, 'method')) {
    return 'method_other_text travels with method';
  }
  if (has(body, 'discard_by')) {
    const d = body.discard_by;
    if (!(d === 'none' || d === 'clear' || isJarDate(d))) return 'discard_by must be a YYYY-MM-DD date, "none" or "clear"';
  }
  if (has(body, 'quantity_value') !== has(body, 'quantity_unit')) {
    return 'quantity_value and quantity_unit are edited together';
  }
  if (has(body, 'quantity_value')) {
    const e = jarQuantityError(body.quantity_value, body.quantity_unit); if (e) return e;
  }
  if (has(body, 'ph_read_at') && !has(body, 'ph_reading')) return 'ph_read_at travels with ph_reading';
  if (has(body, 'ph_reading')) {
    const e = jarPhError(body.ph_reading ?? null, body.ph_read_at ?? null, { readAtRequired: false });
    if (e) return e;
  }
  if (has(body, 'notes') && has(body, 'notes_append')) return 'send notes or notes_append, not both';
  if (has(body, 'shu_est_high') && !has(body, 'shu_est_low')) return 'shu_est_high travels with shu_est_low';
  if (has(body, 'shu_est_low') && body.shu_est_low != null) {
    if (!Number.isInteger(Number(body.shu_est_low)) || Number(body.shu_est_low) < 0) return 'shu_est_low must be a whole number, 0 or more';
    if (body.shu_est_high != null && (!Number.isInteger(Number(body.shu_est_high)) || Number(body.shu_est_high) < Number(body.shu_est_low))) {
      return 'shu_est_high must be a whole number at least shu_est_low';
    }
  }
  if (has(body, 'cooked') && body.cooked != null && typeof body.cooked !== 'boolean') return 'cooked must be true or false';
  if (has(body, 'notes_append') && normalizeJarText(body.notes_append) == null) return 'notes_append cannot be blank';
  return null;
}

async function patchJar(sql, jarId, body, userId, householdIds) {
  const verr = validateJarPatch(body);
  if (verr) return bad(verr);
  const jar = await loadJar(sql, jarId, householdIds);
  if (!jar) return notFound;

  const next = {
    method: has(body, 'method') ? body.method : jar.method,
    is_raw: has(body, 'is_raw') ? body.is_raw : jar.is_raw,
    in_oil: has(body, 'in_oil') ? body.in_oil : jar.in_oil,
    texture: has(body, 'texture') ? body.texture : jar.texture,
  };
  // chk_preservation_log_texture_method: a texture only on a dried food. A method corrected AWAY from
  // dried clears a stored texture it did not mention (the texture described the dried food it no
  // longer is); a texture SENT with a non-dried method is the client's mistake and is refused.
  if (next.texture != null && !JAR_TEXTURE_METHODS.includes(next.method)) {
    if (has(body, 'texture')) return bad('texture only applies to a dried food (dehydrate or powder)');
    next.texture = null;
  }
  const textureChanged = (next.texture ?? null) !== (jar.texture ?? null);
  // Written only when sent or auto-cleared: an unguarded write (a name, a note) must never re-assert a
  // value read before a concurrent change.
  const writeTexture = has(body, 'texture') || textureChanged;

  // The date. discard_by wins; else a correction of what the engine reads re-derives per the rule.
  const corrected = next.method !== jar.method || (next.is_raw ?? null) !== (jar.is_raw ?? null)
    || (next.in_oil ?? null) !== (jar.in_oil ?? null) || textureChanged;
  let useBy = null;
  if (has(body, 'discard_by')) {
    if (body.discard_by === 'none') useBy = { use_by_target: null, use_by_basis: 'typed' };
    else if (body.discard_by === 'clear') useBy = correctionUseBy(jar, next, { clearing: true });
    else useBy = { use_by_target: body.discard_by, use_by_basis: 'typed' };
  } else if (corrected) {
    useBy = correctionUseBy(jar, next);
  }
  // The guard rides only on a write that depends on what was read (see the header).
  const guarded = useBy != null || corrected || textureChanged;

  const method = next.method;
  const methodOther = !has(body, 'method') ? null
    : method === 'other' ? normalizeJarText(has(body, 'method_other_text') ? body.method_other_text : jar.method_other_text)
      : null;
  const phReading = has(body, 'ph_reading') && body.ph_reading != null ? String(body.ph_reading).trim() : null;
  // A reading edited later defaults its time to now (V4 pH section: "today (a later Edit)").
  const phReadAt = phReading == null ? null : (body.ph_read_at ?? new Date().toISOString());
  const shuLow = body.shu_est_low == null ? null : Number(body.shu_est_low);
  const shuHigh = shuLow == null ? null : Number(body.shu_est_high ?? body.shu_est_low);
  const qv = has(body, 'quantity_value') && body.quantity_value != null && String(body.quantity_value).trim() !== ''
    ? body.quantity_value : null;

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
    sql`
    UPDATE preservation_log SET
      label             = CASE WHEN ${has(body, 'label')}::boolean THEN ${normalizeJarText(body.label)}::text ELSE label END,
      container_label   = CASE WHEN ${has(body, 'container_label')}::boolean THEN ${normalizeJarText(body.container_label)}::text ELSE container_label END,
      is_raw            = CASE WHEN ${has(body, 'is_raw')}::boolean THEN ${body.is_raw ?? null}::boolean ELSE is_raw END,
      in_oil            = CASE WHEN ${has(body, 'in_oil')}::boolean THEN ${body.in_oil ?? null}::boolean ELSE in_oil END,
      texture           = CASE WHEN ${writeTexture}::boolean THEN ${next.texture ?? null}::text ELSE texture END,
      method            = CASE WHEN ${has(body, 'method')}::boolean THEN ${method}::text ELSE method END,
      method_other_text = CASE WHEN ${has(body, 'method')}::boolean THEN ${methodOther}::text ELSE method_other_text END,
      ph_reading        = CASE WHEN ${has(body, 'ph_reading')}::boolean THEN ${phReading}::numeric ELSE ph_reading END,
      ph_read_at        = CASE WHEN ${has(body, 'ph_reading')}::boolean THEN ${phReadAt}::timestamptz ELSE ph_read_at END,
      quantity_value    = CASE WHEN ${has(body, 'quantity_value')}::boolean THEN ${qv}::numeric ELSE quantity_value END,
      quantity_unit     = CASE WHEN ${has(body, 'quantity_value')}::boolean THEN ${qv == null ? null : normalizeJarUnit(body.quantity_unit)}::text ELSE quantity_unit END,
      use_by_target     = CASE WHEN ${useBy != null}::boolean THEN ${useBy?.use_by_target ?? null}::date ELSE use_by_target END,
      use_by_basis      = CASE WHEN ${useBy != null}::boolean THEN ${useBy?.use_by_basis ?? null}::text ELSE use_by_basis END,
      shu_est_low       = CASE WHEN ${has(body, 'shu_est_low')}::boolean THEN ${shuLow}::int ELSE shu_est_low END,
      shu_est_high      = CASE WHEN ${has(body, 'shu_est_low')}::boolean THEN ${shuHigh}::int ELSE shu_est_high END,
      shu_est_basis     = CASE WHEN ${has(body, 'shu_est_low')}::boolean THEN ${shuLow == null ? null : 'typed'}::text ELSE shu_est_basis END,
      cooked            = CASE WHEN ${has(body, 'cooked')}::boolean THEN ${body.cooked ?? null}::boolean ELSE cooked END,
      notes             = CASE WHEN ${has(body, 'notes')}::boolean THEN ${normalizeJarText(body.notes)}::text
                               WHEN ${has(body, 'notes_append')}::boolean
                                 THEN concat_ws(E'\\n', NULLIF(btrim(notes), ''), ${normalizeJarText(body.notes_append)}::text)
                               ELSE notes END
    WHERE id = ${jar.id}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
      AND (NOT ${guarded}::boolean OR xmin = ${jar.row_version}::text::xid)
    RETURNING *
  `,
  ]);
  if (!rows.length) return guarded ? stale() : notFound;
  return { status: 200, body: projectRow(rows[0]) };
}

// ── POST /api/preservation/:id/move ─────────────────────────────────────────────────────────────
// `{ place: {id} | {kind, label}, when?: 'YYYY-MM-DD' | {date} }`. A new place is found-or-created in
// the SAME statement as the move (household-first, then the caller's own; label trimmed — 05 §6a), and
// only while the jar is still the one that was read, so a stale move leaves no place behind. storage_moved_at is the move's When (default now).
export function validatePlace(place) {
  if (!place || typeof place !== 'object' || Array.isArray(place)) return 'place must be {id} or {kind, label}';
  if (place.id != null) {
    if (!UUID_RE.test(String(place.id))) return 'place.id must be a uuid';
    return null;
  }
  if (!PLACE_KINDS.includes(place.kind)) return `place.kind must be one of: ${PLACE_KINDS.join(', ')}`;
  if (normalizeJarText(place.label) == null) return 'a new place needs a name';
  if (normalizeJarText(place.label).length > 120) return 'a place name can be at most 120 characters';
  return null;
}

function whenDate(when) {
  if (when == null) return null;
  const d = typeof when === 'string' ? when : when.date;
  return d ?? null;
}

export function validateMove(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const perr = validatePlace(body.place);
  if (perr) return perr;
  const d = whenDate(body.when);
  if (body.when != null && !isJarDate(d)) return 'when must be a YYYY-MM-DD date';
  return null;
}

async function loadPlace(sql, placeId, householdIds) {
  const rows = await sql`
    SELECT id, kind, label FROM storage_location
    WHERE id = ${placeId}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

async function moveJar(sql, jarId, body, userId, householdIds) {
  const verr = validateMove(body);
  if (verr) return bad(verr);
  const jar = await loadJar(sql, jarId, householdIds);
  if (!jar) return notFound;
  let destKind;
  let placeId = null;
  if (body.place.id != null) {
    const pl = await loadPlace(sql, body.place.id, householdIds);
    if (!pl) return bad('that place does not match a place you can use');
    destKind = pl.kind;
    placeId = pl.id;
  } else {
    destKind = body.place.kind;
  }
  const label = placeId ? null : normalizeJarText(body.place.label);
  const moveDate = whenDate(body.when);
  const today = new Date().toISOString().slice(0, 10);
  const { kindChanged, useBy } = moveUseBy(jar, destKind, moveDate ?? today);

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
    sql`
    WITH found AS (
      SELECT id, label, kind FROM storage_location
      WHERE ${placeId}::uuid IS NULL
        AND user_id = ANY(${householdIds})
        AND kind = ${destKind}::text
        AND lower(btrim(label)) = lower(${label}::text)
        AND deleted_at IS NULL
      ORDER BY (user_id = ${userId}::text) DESC, created_at, id
      LIMIT 1
    ), made AS (
      INSERT INTO storage_location (user_id, label, kind)
      SELECT ${userId}::text, ${label}::text, ${destKind}::text
      WHERE ${placeId}::uuid IS NULL AND NOT EXISTS (SELECT 1 FROM found)
        -- A stale move creates no place: the same xmin test as the UPDATE, on this statement's
        -- snapshot (a data-modifying CTE runs even when the UPDATE below matches nothing).
        AND EXISTS (SELECT 1 FROM preservation_log j
                     WHERE j.id = ${jar.id}::uuid AND j.xmin = ${jar.row_version}::text::xid)
      ON CONFLICT (user_id, kind, lower(label)) WHERE deleted_at IS NULL
        DO UPDATE SET label = storage_location.label
      RETURNING id, label, kind
    ), place AS (
      SELECT id FROM found UNION ALL SELECT id FROM made
      UNION ALL SELECT ${placeId}::uuid WHERE ${placeId}::uuid IS NOT NULL
    ), moved AS (
      UPDATE preservation_log SET
        storage_location_id = (SELECT id FROM place LIMIT 1),
        storage_moved_at    = CASE WHEN ${kindChanged}::boolean
                                   THEN COALESCE(${moveDate}::date::timestamptz, now()) ELSE storage_moved_at END,
        use_by_target       = CASE WHEN ${useBy != null}::boolean THEN ${useBy?.use_by_target ?? null}::date ELSE use_by_target END,
        use_by_basis        = CASE WHEN ${useBy != null}::boolean THEN ${useBy?.use_by_basis ?? null}::text ELSE use_by_basis END
      WHERE id = ${jar.id}::uuid
        AND user_id = ANY(${householdIds})
        AND deleted_at IS NULL
        AND xmin = ${jar.row_version}::text::xid
        AND EXISTS (SELECT 1 FROM place)
      RETURNING *
    )
    SELECT * FROM moved
  `,
  ]);
  if (!rows.length) return stale();
  return { status: 200, body: projectRow(rows[0]) };
}
