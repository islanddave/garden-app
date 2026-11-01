// Put-up provenance vocabulary + validation (V4-PUTUPPROV-001).
//
// Dependency-free on purpose, like ./attribution.js: index.js imports neon/clerk/aws, which are not in the
// root package.json, so a unit test importing index.js dies under `npm ci` in CI. Everything here is
// importable by the BLOCKING build-and-test suite. Do not add imports.
//
// The vocabulary lives in THREE places by necessity: this file, chk_preservation_log_source_kind in
// migrations/v4-putupprov-001/0a-additive-ddl.sql, and PUTUP_SOURCE_OPTIONS in src/lib/dropdownRegistry.js.
// The migration's post gate asserts the DB constraint's exact membership, and
// src/__tests__/preservationProvenance.test.js asserts VALID_SOURCE_KINDS as a literal AND equal to the
// dropdownRegistry list, so a drift reds CI before it can reach a 23514 in prod.

// D1-a. Widen this list (and the DB CHECK, and dropdownRegistry) to add a value. Do NOT drop the DB CHECK
// and go free-text: that fragments the vocabulary. `other` + source_label is the escape hatch, so an
// unforeseen source never blocks a save. `traded`/`plant_swap` is deliberately absent: a swapped PLANT is a
// lineage fact, and swapped PRODUCE behaves like a gift on a freezer inventory.
export const VALID_SOURCE_KINDS = [
  'own_garden', 'u_pick', 'farm_stand', 'csa', 'store', 'gift', 'foraged', 'other',
];

export const SOURCE_LABEL_MAX = 120;

// The full set of columns a client may write: THE SINGLE SOURCE OF TRUTH for four hand-maintained
// enumerations (the INSERT column list, the full-replace UPDATE SET list, projectRow's whitelist, and
// buildFullPayload in src/pages/PutUp.jsx). The parity tests key off this constant so the next column
// cannot be half-added.
export const PRESERVATION_EDITABLE_COLUMNS = [
  'crop_type_slug', 'variety_id', 'plant_id', 'harvest_log_id',
  // preserved_at_approx rides beside the date it qualifies: TRUE means preserved_at is an estimate the
  // freezer walk derived from a coarse answer; NULL means nobody was ever asked. Only TRUE changes how a
  // date renders.
  'preserved_at', 'preserved_at_approx', 'method', 'method_other_text', 'quantity_value', 'quantity_unit',
  'package_count', 'storage_location_id', 'use_by_target',
  'remaining_count', 'consumed_at', 'notes', 'photo_id',
  'source_kind', 'source_label',
];

// Normalize a label to "meaningful string or null". Mirrors chk_preservation_log_source_label_nonblank so
// a whitespace-only label never reaches the column and fragments the vendor list. Always write THIS,
// never body.source_label.
export function normalizeSourceLabel(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

// Validate the provenance fields of a create/update body. Returns an error STRING or null
// (validateCreate's contract). Every rule duplicates a DB CHECK on purpose (the VALID_METHODS
// belt-and-suspenders pattern): a 23514 reads as `Constraint violation: chk_preservation_log_source_kind`,
// which no one can act on. The DB is the belt; these messages are the product.
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

  // D2-c. A farm-stand peach attributed to a planting is a data lie: REJECT, never coerce (under a
  // full-replace PUT an alternating stale/current client would toggle plant_id with no audit trail).
  // harvest_log_id is included because the harvest-triggered prefill sets BOTH, and leaving the harvest
  // link would be a second way to tell the same lie.
  if (kind !== 'own_garden') {
    if (body.plant_id) return 'clear the planting before recording a non-garden source';
    if (body.harvest_log_id) return 'clear the harvest link before recording a non-garden source';
  }

  return null;
}
