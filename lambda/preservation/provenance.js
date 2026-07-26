// V4-PUTUPPROV-001 — put-up provenance vocabulary + validation.
//
// DEPENDENCY-FREE ON PURPOSE, exactly like ./attribution.js: index.js imports neon/clerk/aws, none of
// which are in the root package.json, so a unit test that imports index.js dies under `npm ci` in CI.
// Everything here is importable by the BLOCKING build-and-test suite. Do not add imports.
//
// The vocabulary lives in THREE places by necessity — this file, chk_preservation_log_source_kind in
// migrations/v4-putupprov-001/0a-additive-ddl.sql, and PUTUP_SOURCE_OPTIONS in
// src/lib/dropdownRegistry.js. That is one more copy than anyone wants, so:
//   - the migration's post gate asserts the DB constraint's exact membership,
//   - src/__tests__/preservationProvenance.test.js asserts VALID_SOURCE_KINDS as a literal AND
//     asserts it equals the dropdownRegistry list.
// A vocab drift therefore reds CI before it can reach a 23514 in prod.

// D1-a. Widen this list (and the DB CHECK, and dropdownRegistry) to add a value.
// DO NOT drop the DB CHECK and go free-text — that is what v4-source-freetext did to
// plants.source_type on 2026-07-07 and the vocabulary fragmented. `other` + source_label is the
// escape hatch that means an unforeseen source never blocks a save, so there is never schedule
// pressure to drop it.
// `traded`/`plant_swap` is deliberately absent: a swapped PLANT is a lineage fact, swapped PRODUCE
// behaves identically to a gift on a freezer inventory.
export const VALID_SOURCE_KINDS = [
  'own_garden', 'u_pick', 'farm_stand', 'csa', 'store', 'gift', 'foraged', 'other',
];

export const SOURCE_LABEL_MAX = 120;

// The full set of columns a client may write. THE SINGLE SOURCE OF TRUTH for the four hand-maintained
// enumerations that used to drift independently: the INSERT column list, the full-replace UPDATE SET
// list, projectRow's whitelist, and buildFullPayload in src/pages/PutUp.jsx.
// Adding a column to four hand-lists is the defect generator; the parity tests key off this constant
// so the NEXT column cannot be half-added either.
export const PRESERVATION_EDITABLE_COLUMNS = [
  'crop_type_slug', 'variety_id', 'plant_id', 'harvest_log_id',
  'preserved_at', 'method', 'method_other_text', 'quantity_value', 'quantity_unit',
  'package_count', 'storage_location_id', 'use_by_target',
  'remaining_count', 'consumed_at', 'notes', 'photo_id',
  'source_kind', 'source_label',
];

// Normalize a label to "meaningful string or null". Mirrors the DB's
// chk_preservation_log_source_label_nonblank so a whitespace-only label can never reach the column
// and fragment the vendor list. Always write THIS, never body.source_label.
export function normalizeSourceLabel(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

// Validate the provenance fields of a create/update body. Returns an error STRING or null, matching
// validateCreate's existing contract.
//
// Every rule here duplicates a DB CHECK on purpose (the VALID_METHODS belt-and-suspenders pattern):
// a 23514 surfaces to the user as `Constraint violation: chk_preservation_log_source_kind`, which is
// not something anyone can act on. The DB is the belt; these messages are the product.
export function validateProvenance(body) {
  const kind = body.source_kind;

  // Absent is legal on create — NULL means "unrecorded" (D1-b). It is never defaulted to own_garden.
  if (kind == null) {
    // ...but a label with no kind is a row that says "from somewhere" and won't say where.
    if (normalizeSourceLabel(body.source_label) != null) {
      return 'source_label needs a source_kind — pick where this came from';
    }
    return null;
  }

  if (!VALID_SOURCE_KINDS.includes(kind)) {
    return `source_kind must be one of: ${VALID_SOURCE_KINDS.join(', ')}`;
  }

  const label = normalizeSourceLabel(body.source_label);

  // D1-c. NULL-safe here as it is in the DB: `label == null` is checked explicitly, because the
  // naive SQL form of this rule evaluates to NULL and a NULL CHECK passes.
  if (kind === 'other' && label == null) {
    return "source_label is required when source_kind is 'other' — name where it came from";
  }

  if (label != null && label.length > SOURCE_LABEL_MAX) {
    return `source_label must be ${SOURCE_LABEL_MAX} characters or fewer`;
  }

  // D2-c. A farm-stand peach attributed to a planting is a data lie. REJECT, never coerce: silent
  // coercion is the same class of lie the feature exists to remove, and under a full-replace PUT an
  // alternating stale/current client would toggle plant_id on and off with no audit trail.
  // harvest_log_id is included because the harvest-triggered prefill path sets BOTH — the brief
  // named only plant_id, which would have left the harvest link as a second way to tell the same lie.
  if (kind !== 'own_garden') {
    if (body.plant_id) return 'clear the planting before recording a non-garden source';
    if (body.harvest_log_id) return 'clear the harvest link before recording a non-garden source';
  }

  return null;
}
