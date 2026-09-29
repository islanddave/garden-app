// The per-jar rules — Put-Up release 1a (the V4 design's "shelfLife.js / jarRules.js extraction"): the
// method vocabulary the write gate accepts, the validators every jar write passes, and the one read
// projection every preservation GET returns.
//
// WHY ITS OWN MODULE. Same reason as ./shelfLife.js: these were module-private inside index.js, and a
// second jar writer (release 1b's Put it up, in kitchenRoutes.js, which index.js imports) must apply
// the same rules and return the same row shape. Dependency-free apart from its pure siblings, so it is
// importable by kitchenRoutes.js and executable under the root vitest run.
//
// Moved verbatim from index.js; the only edits in the move are `export` on VALID_METHODS,
// validateCommon and projectRow, which were module-private.
import { validateProvenance } from './provenance.js';
import { classifyUseBy } from './useBy.js';

// Mirrors chk_preservation_log_method — belt-and-suspenders over the DB CHECK (L5 vocab).
export const VALID_METHODS = [
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
  // V5-PUTUPCANDY-001. Sugar-preserved confection — the staged-syrup candying method. Passes the
  // strict axis test pesto and hot_sauce failed: it names a PROCESS that genuinely moves the
  // shelf-life number (weeks dusted at room temperature against months undusted frozen), not a dish.
  // Its shelf-life figures are HOUSE-SOURCED — see HOUSE_SOURCED_SHELF_LIFE in ./shelfLife.js before
  // touching them, and note that its entry in SHELF_LIFE_MONTHS is a hard precondition of this value
  // existing at all: a method absent from that table never gets a use_by_target and vanishes from
  // use-soon.
  'candy',
  'other',
];

export function validateCommon(body) {
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
  // V4-PUTUPSESSION-001 slice 1. Shape-only, and absent stays legal on BOTH verbs — the column is
  // nullable with NULL meaning "nobody was ever asked", and a service-worker-cached bundle from
  // before this ship never sends the key. Rejecting a non-boolean matters because Postgres would
  // silently accept 'yes'/'on'/'t' through a ::boolean cast, so a client typo would land as TRUE and
  // stamp a date the user picked as an estimate — the defect inverted.
  if (body.preserved_at_approx != null && typeof body.preserved_at_approx !== 'boolean') {
    return 'preserved_at_approx must be true or false';
  }
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
// COALESCE-preserve UPDATE in index.js's PUT — absent key means "unchanged", at both layers.
export function validateUpdate(body) {
  return validateCommon(body) ?? (body.source_kind === undefined ? null : validateProvenance(body));
}

// Shared row projection for the read surfaces (single source of columns).
export function projectRow(r) {
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
    // V5-INFLIGHTBATCH-001 / BUG-JARSTEAL-001. READ-ONLY here and nowhere else: batch_id stays out of
    // PRESERVATION_EDITABLE_COLUMNS (see kitchen-batch-id-guard.test.js — a stale cached bundle's
    // full-replace PUT would NULL it and return 200), but it must be READABLE or no picker can tell a
    // linked jar from an unlinked one, and a close that re-points another batch's jar is undetectable
    // by any client. Written only by the kitchen-batch close / outputs routes, server-side.
    batch_id: r.batch_id ?? null,
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
    // V4-PUTUPSESSION-001 slice 1 — the whole point of the slice reaches the UI through THIS LINE.
    // Every read surface that prints a put-up date (RecordRow, PutUpFromPlanting) goes through the
    // four GET routes, so without this key an estimate reads back as a date the user chose and the
    // column changes nothing the user can see. `?? null` and never `?? false`: NULL means unrecorded
    // and FALSE means chosen, and the read path must not invent the second.
    preserved_at_approx: r.preserved_at_approx ?? null,
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
