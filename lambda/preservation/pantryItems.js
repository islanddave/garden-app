// Put-Up release 2 (B′) — the Pantry's pure rules: the pantry_item body rules, the item projection, the
// one household loader for a body-settable pantry_item_id, and the ONE row shape GET /api/pantry emits
// for a put-up and for a pantry item (V4 §2.5, §4.3, §5.1 row "2"; the pinned B′ cross-lane contract).
//
// PURE apart from loadPantryItems (which takes `sql`): no clock read inside — `now` is passed in — and no
// neon/clerk/aws import, so pantryRoutes.js, lineRoutes.js and their tests can import it.
//
// DATES (V4 §3). A pantry item's discard date is TYPED ONLY: nothing here derives one, and the basis a
// row reports for an item is 'typed' or nothing. A put-up's date and basis are read as STORED — the
// engine (shelfLife.js) wrote them at create/move/correction and a read never re-derives (§3.4 "a rule
// change never rewrites a stored date"). The status is classifyUseBy's (useBy.js), mapped to words the
// contract names: ok | soon | past.
import { KITCHEN_UUID_RE, MASS_G, isMassUnit, normalizeText } from './kitchenBatch.js';
import { JAR_PRECISIONS, JAR_LABEL_MAX, isJarDate } from './jarRules.js';
import { classifyUseBy } from './useBy.js';
import { plantingLabel } from './attribution.js';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
export const isUuid = (v) => typeof v === 'string' && KITCHEN_UUID_RE.test(v);

// storage_location.kind (chk_storage_location_kind) — the same list jarRoutes.js binds for a new place.
export const PANTRY_PLACE_KINDS = ['deep_freezer', 'fridge_freezer', 'fridge', 'pantry', 'cold_storage', 'other'];
// The §3.6 vocabulary (chk_pantry_item_acquired_precision), the same words as a jar's.
export const PANTRY_PRECISIONS = JAR_PRECISIONS;
export const PANTRY_NAME_MAX = JAR_LABEL_MAX;

// The create body (the pinned contract). A key outside it is a client bug, never something to ignore.
export const ITEM_CREATE_KEYS = [
  'idempotency_key', 'name', 'storage_location_id', 'place', 'acquired_at', 'acquired_precision',
  'use_by_target', 'notes', 'plant_id', 'crop_type_slug',
];
// The PATCH presence-sentinel allowlist. acquired_at and acquired_precision travel together.
export const ITEM_PATCH_KEYS = ['name', 'storage_location_id', 'acquired_at', 'acquired_precision', 'use_by_target', 'notes', 'used_up_at'];

// A DATE column leaves as the calendar day it is — jarRules.js calendarDay's rule, restated (it is
// module-private there): the driver hands a DATE back as a Date at local midnight in the Lambda's zone.
export function ymd(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function nameError(v) {
  if (typeof v !== 'string' || v.trim() === '') return 'name what it is';
  if (v.trim().length > PANTRY_NAME_MAX) return `a name can be at most ${PANTRY_NAME_MAX} characters`;
  return null;
}

function placeError(place) {
  if (!isObj(place)) return 'place must be {kind, label}';
  if (!PANTRY_PLACE_KINDS.includes(place.kind)) return `place.kind must be one of: ${PANTRY_PLACE_KINDS.join(', ')}`;
  const label = normalizeText(place.label);
  if (label == null) return 'a new place needs a name';
  if (label.length > 120) return 'a place name can be at most 120 characters';
  return null;
}

// acquired_at + acquired_precision (chk_pantry_item_acquired_pairing): a known day carries a precision
// that is not 'unknown'; no day means no precision or 'unknown'. A day with no precision is 'day'.
export function acquiredOf(body) {
  const at = body.acquired_at ?? null;
  let precision = normalizeText(body.acquired_precision);
  if (at != null && !isJarDate(String(at))) return { error: 'acquired_at must be a date (YYYY-MM-DD)' };
  if (precision != null && !PANTRY_PRECISIONS.includes(precision)) {
    return { error: `acquired_precision must be one of: ${PANTRY_PRECISIONS.join(', ')}` };
  }
  if (at != null && precision == null) precision = 'day';
  if (at != null && precision === 'unknown') return { error: "'unknown' means there is no date — send no acquired_at with it" };
  if (at == null && precision != null && precision !== 'unknown') return { error: `acquired_precision '${precision}' needs an acquired_at` };
  return { acquired_at: at == null ? null : String(at).slice(0, 10), acquired_precision: precision };
}

function useByError(v) {
  if (v == null) return null;
  return isJarDate(String(v)) ? null : 'use_by_target must be a date (YYYY-MM-DD) or null';
}

function notesError(v) {
  return v != null && typeof v !== 'string' ? 'notes must be text' : null;
}

export function validateItemCreate(body) {
  if (!isObj(body)) return 'body required';
  const unknown = Object.keys(body).filter((k) => !ITEM_CREATE_KEYS.includes(k));
  if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;
  if (!isUuid(body.idempotency_key ?? null)) return 'idempotency_key must be a uuid';
  const e = nameError(body.name);
  if (e) return e;
  const hasId = body.storage_location_id != null;
  const hasPlace = body.place != null;
  if (hasId === hasPlace) return 'say where it lives: storage_location_id or place {kind, label}, one of them';
  if (hasId && !isUuid(body.storage_location_id)) return 'storage_location_id must be a uuid';
  if (hasPlace) {
    const pe = placeError(body.place);
    if (pe) return pe;
  }
  const acq = acquiredOf(body);
  if (acq.error) return acq.error;
  if (body.plant_id != null && !isUuid(body.plant_id)) return 'plant_id must be a uuid';
  if (body.crop_type_slug != null && normalizeText(body.crop_type_slug) == null) return 'crop_type_slug cannot be blank';
  return useByError(body.use_by_target) ?? notesError(body.notes);
}

export function validateItemPatch(body) {
  if (!isObj(body)) return 'body required';
  const unknown = Object.keys(body).filter((k) => !ITEM_PATCH_KEYS.includes(k));
  if (unknown.length) return `these cannot be changed here: ${unknown.join(', ')}`;
  if (!Object.keys(body).length) return 'nothing to update';
  if (has(body, 'name')) {
    const e = nameError(body.name);
    if (e) return e;
  }
  if (has(body, 'storage_location_id') && !isUuid(body.storage_location_id ?? null)) {
    return 'storage_location_id must be a uuid — an item always lives somewhere';
  }
  if (has(body, 'acquired_at') !== has(body, 'acquired_precision')) return 'acquired_at and acquired_precision are edited together';
  if (has(body, 'acquired_at')) {
    const acq = acquiredOf(body);
    if (acq.error) return acq.error;
  }
  if (has(body, 'used_up_at') && body.used_up_at !== 'now' && body.used_up_at !== null) {
    return 'used_up_at must be "now" or null';
  }
  if (has(body, 'use_by_target')) {
    const e = useByError(body.use_by_target);
    if (e) return e;
  }
  return has(body, 'notes') ? notesError(body.notes) : null;
}

// The item as every item route returns it (idempotency_key is the client's own and never echoed back).
export function projectItem(r) {
  return {
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    storage_location_id: r.storage_location_id,
    place: placeOf(r),
    acquired_at: ymd(r.acquired_at),
    acquired_precision: r.acquired_precision ?? null,
    use_by_target: ymd(r.use_by_target),
    plant_id: r.plant_id ?? null,
    crop_type_slug: r.crop_type_slug ?? null,
    used_up_at: r.used_up_at ?? null,
    notes: r.notes ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at ?? null,
  };
}

function placeOf(r) {
  if (r.storage_location_id == null) return null;
  return { id: r.storage_location_id, label: r.place_label ?? null, kind: r.place_kind ?? null };
}

// ── the household loader (V4 §5.3: every body-settable FK has one) ──────────────────────────────────
// Contract, same as household.js / lineRoutes.js: rows on success, nothing on ANY failure (foreign,
// malformed, absent), so a caller answers a foreign id with the same 400 as a malformed one. An item comes
// back even when soft-deleted — "That was removed" is a household fact, never a foreign one.
export async function loadPantryItems(sql, ids, householdIds) {
  const clean = [...new Set((ids ?? []).filter(isUuid))];
  if (!clean.length) return [];
  return sql`
    SELECT i.id, i.name, i.plant_id, i.crop_type_slug, i.used_up_at, i.deleted_at
    FROM pantry_item i
    WHERE i.id = ANY(${clean}::uuid[])
      AND i.user_id = ANY(${householdIds})
  `;
}

// ── GET /api/pantry — the ONE row shape (the pinned contract) ──────────────────────────────────────
export const PANTRY_GROUPS = ['place', 'kind'];
// Catch-all buckets sort after every named group (the whats-put-up precedent).
export const NO_PLACE = 'no_place';
export const NO_KIND = 'other';

const STATUS_WORDS = { ok: 'ok', use_soon: 'soon', past_use_by: 'past' };

export function discardOf(useByTarget, basis, startDate, now) {
  const date = ymd(useByTarget);
  const status = date == null ? null : (STATUS_WORDS[classifyUseBy(startDate ?? null, date, now)] ?? null);
  return { date, basis: basis ?? null, status };
}

function groupOf(group, r) {
  if (group === 'kind') {
    return r.crop_type_slug
      ? { group_key: r.crop_type_slug, group_label: r.crop_display_name ?? r.crop_type_slug }
      : { group_key: NO_KIND, group_label: 'Other things' };
  }
  return r.storage_location_id
    ? { group_key: r.storage_location_id, group_label: r.place_label ?? 'A place' }
    : { group_key: NO_PLACE, group_label: 'No place' };
}

// A put-up's name, in the order a person would say it: what he called it, then the variety, the
// planting, the crop, a named Other; "Put-up" only when the row carries nothing at all.
export function jarName(r) {
  return normalizeText(r.label) ?? normalizeText(r.variety_name) ?? normalizeText(r.planting_name)
    ?? normalizeText(r.crop_display_name) ?? normalizeText(r.method_other_text) ?? 'Put-up';
}

// Where it came from (the contract's where_from). A put-up: the vendor or farm stand it was bought from
// (source_label, set only when the source is not our garden), else the planting it came from. A pantry
// item: the planting a "Fresh, as picked" item keeps. Notes are free text and are never read as a source.
function whereFrom(r) {
  return normalizeText(r.source_label) ?? (r.plant_id ? plantingLabel(r) : null);
}

export function jarRow(r, group, now) {
  const weighed = Number(r.package_count) === 1 && isMassUnit(r.quantity_unit);
  const grams = r.remaining_amount != null
    ? Number(r.remaining_amount)
    : (r.quantity_value == null ? null : Number(r.quantity_value) * MASS_G[r.quantity_unit]);
  return {
    stock_kind: 'put_up',
    stock_id: r.id,
    name: jarName(r),
    ...groupOf(group, r),
    place: placeOf(r),
    where_from: whereFrom(r),
    from_garden: r.from_garden === true,
    plant_id: r.plant_id ?? null,
    crop_type_slug: r.crop_type_slug ?? null,
    batch_id: r.batch_id ?? null,
    stock_mode: weighed ? 'weighed' : 'counted',
    count_left: weighed ? null : Number(r.remaining_count ?? r.package_count),
    count_made: weighed ? null : Number(r.package_count),
    grams_left: weighed && grams != null && Number.isFinite(grams) ? grams : null,
    method: r.method ?? null,
    discard: discardOf(r.use_by_target, r.use_by_basis, r.preserved_at, now),
    acquired_at: ymd(r.preserved_at),
    acquired_precision: r.preserved_at_precision ?? null,
    notes: r.notes ?? null,
    created_by: r.user_id,
    updated_at: r.updated_at,
  };
}

export function itemRow(r, group, now) {
  const date = ymd(r.use_by_target);
  return {
    stock_kind: 'pantry_item',
    stock_id: r.id,
    name: r.name,
    ...groupOf(group, r),
    place: placeOf(r),
    where_from: r.plant_id ? plantingLabel(r) : null,
    from_garden: r.plant_id != null,
    plant_id: r.plant_id ?? null,
    crop_type_slug: r.crop_type_slug ?? null,
    batch_id: null,
    stock_mode: 'item',
    count_left: null,
    count_made: null,
    grams_left: null,
    method: null,
    // Typed only (V4 §4.3): a date is his, so its basis is 'typed'; no date is no basis and no status.
    discard: date == null ? { date: null, basis: null, status: null } : discardOf(date, 'typed', r.acquired_at, now),
    acquired_at: ymd(r.acquired_at),
    acquired_precision: r.acquired_precision ?? null,
    notes: r.notes ?? null,
    created_by: r.user_id,
    updated_at: r.updated_at,
  };
}

// Sorted by group then name (the contract): named groups by label, the catch-all last; within a group by
// name, then put-ups before items, then id, so the order is total and stable across calls.
export function sortPantryRows(rows) {
  const catchAll = (r) => r.group_key === NO_PLACE || r.group_key === NO_KIND;
  const cmp = (a, b) => String(a).localeCompare(String(b), 'en', { sensitivity: 'base' });
  const kindRank = (r) => (r.stock_kind === 'put_up' ? 0 : 1);
  return [...rows].sort((a, b) => {
    if (catchAll(a) !== catchAll(b)) return catchAll(a) ? 1 : -1;
    return cmp(a.group_label, b.group_label)
      || String(a.group_key).localeCompare(String(b.group_key))
      || cmp(a.name, b.name)
      || kindRank(a) - kindRank(b)
      || String(a.stock_id).localeCompare(String(b.stock_id));
  });
}

// The page search (V4 §2.5): name match only, case-insensitive, trimmed. Empty q matches everything.
export function matchesQuery(row, q) {
  const needle = normalizeText(q);
  if (needle == null) return true;
  return String(row.name).toLowerCase().includes(needle.toLowerCase());
}
