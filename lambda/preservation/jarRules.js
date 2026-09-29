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
import { isMassUnit } from './kitchenBatch.js';

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

// ── Put-Up release 1b: the jar vocabularies and the relaxed create gate ───────────────────────────────
// Every list below mirrors a CHECK in migrations/v5-putupmake-001/0a-additive-ddl.sql, the same
// belt-and-suspenders VALID_METHODS is: a raw 23514 is not something a cook can act on.

// chk_preservation_log_quantity_unit — THE PERMISSIVE UNION (V4 "Units"): the 25 KITCHEN_UNITS plus the
// ten legacy plurals the shipped picker writes. Never narrowed. New writers store the singular
// (normalizeJarUnit); the legacy PUT stores what it is sent, so a stale bundle's echo is never rewritten.
export const JAR_UNITS = [
  'g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'fl oz', 'cup', 'pint', 'qt', 'gal',
  'count', 'clove', 'head', 'bunch', 'pinch', 'peck', 'bushel', 'half-bushel', 'flat', 'jar', 'bag', 'other',
  'lbs', 'cups', 'pints', 'quarts', 'bushels', 'half-bushels', 'pecks', 'flats', 'jars', 'bags',
];
const JAR_UNIT_PLURALS = {
  lbs: 'lb', cups: 'cup', pints: 'pint', quarts: 'qt', bushels: 'bushel', 'half-bushels': 'half-bushel',
  pecks: 'peck', flats: 'flat', jars: 'jar', bags: 'bag',
};
export function normalizeJarUnit(u) {
  if (u == null) return null;
  const t = String(u).trim();
  if (t === '') return null;
  return JAR_UNIT_PLURALS[t] ?? t;
}

// chk_preservation_log_preserved_at_precision. On this table the date is NOT NULL, so 'after' means
// "the stored date is the earliest it could be" (Put it up's Not sure) and 'unknown' means "the stored
// date is only the day it was logged" (the Walk's Not sure) — V4's estimated-dates section.
export const JAR_PRECISIONS = ['exact', 'hour', 'day', 'week', 'month', 'season', 'year', 'after', 'unknown'];
// chk_preservation_log_texture / _texture_method.
export const JAR_TEXTURES = ['snaps', 'bends', 'still_soft'];
export const JAR_TEXTURE_METHODS = ['dehydrate', 'powder'];
// chk_preservation_log_label_len.
export const JAR_LABEL_MAX = 120;

const JAR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const hasKey = (body, k) => Object.prototype.hasOwnProperty.call(body, k);

export function normalizeJarText(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

export function isJarDate(v) {
  if (typeof v !== 'string' || !JAR_DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// A label is optional and, when given, a name: nonblank after trim and at most 120 characters.
export function jarLabelError(v, field = 'label') {
  if (v == null) return null;
  if (typeof v !== 'string') return `${field} must be text`;
  if (v.trim() === '') return `${field} cannot be blank`;
  if (v.trim().length > JAR_LABEL_MAX) return `${field} can be at most ${JAR_LABEL_MAX} characters`;
  return null;
}

// The quantity pair: both or neither, value > 0, unit inside the union (chk_preservation_log_
// quantity_pairing + _quantity_unit). A jar may be logged with no size.
export function jarQuantityError(value, unit) {
  const hasValue = value != null && String(value).trim() !== '';
  const u = normalizeJarText(unit);
  if (!hasValue && u == null) return null;
  if (!hasValue) return 'quantity_value and quantity_unit go together — give an amount with the unit';
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return 'quantity_value must be > 0';
  if (u == null) return 'quantity_unit is required';
  if (!JAR_UNITS.includes(u)) return `quantity_unit must be one of: ${JAR_UNITS.join(', ')}`;
  return null;
}

// chk_preservation_log_ph_pairing + _ph_scale, and nothing else (FOODSAFETY-RULING-V101 §2 — see
// kitchenBatch.js's KITCHEN_PH_SCALE_MIN). The reading stays the STRING that was sent.
export function jarPhError(reading, readAt, { readAtRequired = true } = {}) {
  if (reading == null && readAt == null) return null;
  if (reading == null) return 'a pH time needs a pH reading';
  const s = String(reading).trim();
  const n = Number(s);
  if (s === '' || !Number.isFinite(n)) return 'a pH reading has to be a number';
  if (n < 0 || n > 14) return 'a pH reading has to be on the pH scale — 0 to 14';
  if (readAt == null) return readAtRequired ? 'a pH reading needs the time it was read' : null;
  if (Number.isNaN(new Date(String(readAt)).getTime())) return 'ph_read_at has to be a timestamp';
  return null;
}

// The 1b facts a jar row carries, shape-checked the same way on every 1b writer (Put it up rows, the
// create, the PATCH). `method` is the jar's method AFTER the write, for the texture rule.
export function jarFactsError(body, method) {
  for (const k of ['is_raw', 'in_oil']) {
    if (body[k] != null && typeof body[k] !== 'boolean') return `${k} must be true or false`;
  }
  if (body.texture != null) {
    if (!JAR_TEXTURES.includes(body.texture)) return `texture must be one of: ${JAR_TEXTURES.join(', ')}`;
    if (!JAR_TEXTURE_METHODS.includes(method)) return 'texture only applies to a dried food (dehydrate or powder)';
  }
  // Release F: a jar's typed heat estimate (chk_preservation_log_shu_est_range) and "Cooked after
  // blending?" (a record only; shelfLife.js never reads it).
  if (body.shu_est_low != null || body.shu_est_high != null) {
    if (body.shu_est_low == null) return 'a heat estimate needs its low end';
    if (!Number.isInteger(Number(body.shu_est_low)) || Number(body.shu_est_low) < 0) return 'shu_est_low must be a whole number, 0 or more';
    if (body.shu_est_high != null && (!Number.isInteger(Number(body.shu_est_high)) || Number(body.shu_est_high) < Number(body.shu_est_low))) {
      return 'shu_est_high must be a whole number at least shu_est_low';
    }
  }
  if (body.shu_est_basis != null && body.shu_est_basis !== 'typed') return "a heat estimate typed here is 'typed'";
  if (body.cooked != null && typeof body.cooked !== 'boolean') return 'cooked must be true or false';
  if (body.preserved_at_precision != null && !JAR_PRECISIONS.includes(body.preserved_at_precision)) {
    return `preserved_at_precision must be one of: ${JAR_PRECISIONS.join(', ')}`;
  }
  return jarLabelError(body.label) ?? jarLabelError(body.container_label, 'container_label');
}

// POST /api/preservation from release 1b (V4 API table, row "POST /api/preservation"). The 1a gate
// (validateCommon) required a crop, a variety or a planting, a named Other and a size; 1b's DDL relaxes
// each of those under its own name, and this gate relaxes with it: a label attributes a jar and names an
// Other, and a jar may be logged with no size. The messages keep their 1a words where 1a had one, so an
// integration assertion on the old text still reads true about the new rule.
export function validateCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const label = normalizeJarText(body.label);
  if (!body.crop_type_slug && !body.variety_id && !body.plant_id && label == null) {
    return 'at least one of crop_type_slug, variety_id or plant_id is required (or a label)';
  }
  if (!body.method || !VALID_METHODS.includes(body.method)) return `method must be one of: ${VALID_METHODS.join(', ')}`;
  if (body.method === 'other' && normalizeJarText(body.method_other_text) == null && label == null) {
    return "method_other_text is required when method is 'other' (or give the put-up a label)";
  }
  const qErr = jarQuantityError(body.quantity_value, body.quantity_unit);
  if (qErr) return qErr;
  if (body.package_count != null && (!Number.isInteger(Number(body.package_count)) || Number(body.package_count) < 1)) {
    return 'package_count must be >= 1';
  }
  if (!body.preserved_at) return 'preserved_at is required';
  if (body.preserved_at_approx != null && typeof body.preserved_at_approx !== 'boolean') {
    return 'preserved_at_approx must be true or false';
  }
  if (body.remaining_count != null && Number(body.remaining_count) < 0) return 'remaining_count must be >= 0';
  if (body.use_by_target != null && !isJarDate(String(body.use_by_target).slice(0, 10))) {
    return 'use_by_target must be a YYYY-MM-DD date';
  }
  if (body.idempotency_key != null && !JAR_UUID_RE.test(String(body.idempotency_key))) {
    return 'idempotency_key must be a uuid';
  }
  return jarFactsError(body, body.method)
    ?? jarPhError(body.ph_reading ?? null, body.ph_read_at ?? null, { readAtRequired: false })
    ?? validateProvenance(body);
}

// The legacy full-replace PUT from release 1b (V4's legacy-PUT section, "From 1b"). An ABSENT key is
// unchanged, so nothing here requires a key; a PRESENT key is shape-checked as 1a checked it. The
// attribution and method-other rules are judged on the EFFECTIVE row by the database (the relaxed
// CHECKs), because this gate cannot see the stored label: a label-only jar from Put it up echoes
// crop_type_slug: null and must still take a Mark used. method is never WRITTEN by this PUT from 1b —
// a differing one is a stale tab (409) — so it is checked for shape only.
export function validateLegacyPut(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  if (hasKey(body, 'method') && (!body.method || !VALID_METHODS.includes(body.method))) {
    return `method must be one of: ${VALID_METHODS.join(', ')}`;
  }
  // The stored pair is KEPT when quantity_value is null, absent or 0 (the shipped RowEditor sends
  // `Number(x) || rec.quantity_value`, and a label-only jar has no size to echo).
  const qv = body.quantity_value;
  const keepsQuantity = qv == null || Number(qv) === 0;
  if (!keepsQuantity) {
    if (!Number.isFinite(Number(qv)) || Number(qv) < 0) return 'quantity_value must be > 0';
    const u = normalizeJarText(body.quantity_unit);
    if (u == null) return 'quantity_unit is required';
    if (!JAR_UNITS.includes(u)) return `quantity_unit must be one of: ${JAR_UNITS.join(', ')}`;
  }
  if (body.package_count != null && (!Number.isInteger(Number(body.package_count)) || Number(body.package_count) < 1)) {
    return 'package_count must be >= 1';
  }
  if (hasKey(body, 'preserved_at') && !body.preserved_at) return 'preserved_at is required';
  if (body.preserved_at_approx != null && typeof body.preserved_at_approx !== 'boolean') {
    return 'preserved_at_approx must be true or false';
  }
  if (body.remaining_count != null && (!Number.isInteger(Number(body.remaining_count)) || Number(body.remaining_count) < 0)) {
    return 'remaining_count must be >= 0';
  }
  return body.source_kind === undefined ? null : validateProvenance(body);
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

// Put-Up release 1a — A DATE COLUMN LEAVES AS THE CALENDAR DAY IT IS ('YYYY-MM-DD'), never as a Date.
// The driver parses a DATE into a Date at local midnight of that day in the LAMBDA's zone (UTC), and
// JSON turns that into "...T00:00:00.000Z": an instant, which a phone west of Greenwich reads as the
// evening BEFORE. So every put-up and use-by date showed a day early in ET, and RecordRow's full-replace
// PUT echoed the earlier day back — each Mark used moved preserved_at and use_by_target back one day.
// Proved, and pinned, in src/__tests__/putUpDateEcho.tz.test.js. A plain day has no zone to misread.
// The LOCAL getters read the driver's Date back exactly in any process zone (toISOString would agree
// only in UTC); a value that is already text keeps its first ten characters, the day.
function calendarDay(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v).slice(0, 10);
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
    planting_sown_at: calendarDay(r.planting_sown_at),   // garden_node.sown_at is a DATE too
    planting_succession_order: r.planting_succession_order ?? null,
    harvest_log_id: r.harvest_log_id,
    // V5-INFLIGHTBATCH-001 / BUG-JARSTEAL-001. READ-ONLY here and nowhere else: batch_id stays out of
    // PRESERVATION_EDITABLE_COLUMNS (see kitchen-batch-id-guard.test.js — a stale cached bundle's
    // full-replace PUT would NULL it and return 200), but it must be READABLE or no picker can tell a
    // linked jar from an unlinked one, and a close that re-points another batch's jar is undetectable
    // by any client. Written only by the kitchen-batch close / outputs routes, server-side.
    batch_id: r.batch_id ?? null,
    preserved_at: calendarDay(r.preserved_at),
    method: r.method,
    method_other_text: r.method_other_text,
    quantity_value: r.quantity_value,
    quantity_unit: r.quantity_unit,
    package_count: r.package_count,
    storage_location_id: r.storage_location_id,
    use_by_target: calendarDay(r.use_by_target),
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
    // Put-Up release 1b. READ-ONLY on every legacy surface: none of these is in
    // PRESERVATION_EDITABLE_COLUMNS or buildFullPayload, so the full-replace PUT never echoes them —
    // they are written by Put it up, the create, PATCH /api/preservation/:id and Move only. `?? null`
    // throughout: a pre-1b row has none of them, and NULL is what "never asked" means.
    label: r.label ?? null,
    container_label: r.container_label ?? null,
    use_by_basis: r.use_by_basis ?? null,
    preserved_at_precision: r.preserved_at_precision ?? null,
    storage_moved_at: r.storage_moved_at ?? null,
    texture: r.texture ?? null,
    is_raw: r.is_raw ?? null,
    in_oil: r.in_oil ?? null,
    ph_reading: r.ph_reading ?? null,
    ph_read_at: r.ph_read_at ?? null,
    put_up_stage_id: r.put_up_stage_id ?? null,
    // Release F. Read-only here too (never in PRESERVATION_EDITABLE_COLUMNS or buildFullPayload):
    // the heat estimate and "cooked" are written by Put it up, the create, the PATCH and
    // shu-estimate/save; remaining_amount only by draws and uses. stock_mode is derived — weighed when
    // one container was logged in a mass unit (the route rule; readers show "about N g left" only then).
    shu_est_low: r.shu_est_low ?? null,
    shu_est_high: r.shu_est_high ?? null,
    shu_est_basis: r.shu_est_basis ?? null,
    cooked: r.cooked ?? null,
    remaining_amount: r.remaining_amount ?? null,
    stock_mode: Number(r.package_count) === 1 && isMassUnit(r.quantity_unit) ? 'weighed' : 'counted',
    // A3: the place's kind, read-only, where the read joined it (the discard-by basis words say
    // "general figure: hot sauce, fridge"). NULL on a write's RETURNING, which joins nothing.
    storage_kind: r.storage_kind ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    // From the driver's values, not the projected text: classifyUseBy reads either, and leaving its
    // input as it was keeps the status byte-identical to what it computed before the dates were fixed.
    use_by_status: classifyUseBy(r.preserved_at, r.use_by_target),
  };
}

// Put-Up release 1a — the words for a legacy PUT the count rule refused (see the PUT in index.js).
// The UPDATE decides; this only explains, from the statement's own snapshot of the stored counts,
// which of the two refusals it was. Every refusal is a 409 carrying a `code` for the client to
// branch on and a plain-words `message` (mirrored in `error`, which apiFetch surfaces as the
// Error's message) that can be shown as it is.
function coded(code, message) {
  return { error: message, code, message };
}

export function countRefusal({ storedCount, storedRemaining, packageCount, remaining }) {
  const stored = Number(storedCount);
  const count = Number(packageCount);
  const left = storedRemaining == null ? stored : Number(storedRemaining);
  const next = stored !== count ? left + (count - stored) : (remaining == null ? null : Number(remaining));
  if (next != null && next < 0) {
    const used = stored - left;
    return coded('count_below_used',
      `${used} of these ${used === 1 ? 'is' : 'are'} already used, so the count can't go below ${used}.`);
  }
  if (next != null && next > count) {
    return coded('remaining_above_count',
      "That would leave more left than there are containers. Refresh and try again.");
  }
  // The snapshot says the write would have passed, so the jar changed between the statement's
  // snapshot and its row lock (another tap, another phone). The words say so.
  return clientStale();
}

// Put-Up release 1b — the preservation_log CHECKs 1b relaxes or adds, given words. Returns null for
// anything else, so index.js's existing PG-code map keeps its behaviour. The two provenance CHECKs keep
// their own mapping in index.js (chk_preservation_log_source*), which this map does not shadow.
const JAR_CONSTRAINT_MESSAGES = {
  chk_preservation_log_attribution: 'Say what this is — a crop, a variety, a planting or a name.',
  chk_preservation_log_method_other: "Name an 'Other' put-up — give it a name or say what was done.",
  chk_preservation_log_label_nonblank: 'A name cannot be blank.',
  chk_preservation_log_label_len: `A name can be at most ${JAR_LABEL_MAX} characters.`,
  chk_preservation_log_use_by_basis: 'That is not a discard-by basis this app knows.',
  chk_preservation_log_use_by_basis_date: 'That discard-by date does not match where it came from. Refresh and try again.',
  chk_preservation_log_texture: 'That is not a texture this app knows.',
  chk_preservation_log_texture_method: 'Texture only applies to a dried food.',
  chk_preservation_log_ph_pairing: 'A pH reading needs the time it was read, and a time needs a reading.',
  chk_preservation_log_ph_scale: 'That is not a reading on the pH scale.',
  chk_preservation_log_put_up_stage_batch: 'That jar has to belong to its batch.',
  chk_preservation_log_preserved_at_precision: 'That is not a date precision this app knows.',
  chk_preservation_log_quantity_pairing: 'An amount needs its unit, and a unit needs an amount above 0.',
  chk_preservation_log_quantity_unit: 'That is not a unit this app knows.',
  chk_preservation_log_remaining_within_package: 'That would leave more left than there are containers.',
};

export function jarErrorMessage(err) {
  if (!err || err.code !== '23514') return null;
  return JAR_CONSTRAINT_MESSAGES[String(err.constraint ?? '')] ?? null;
}

// Put-Up release 1b: the refusal for a tab older than the row — the legacy PUT's echo rule and count
// race, and the optimistic guard on PATCH / Move. The same code and words as countRefusal's fall-through,
// so the shipped client's CLIENT_STALE_TEXT and its Refresh door apply unchanged.
export function clientStale() {
  return coded('client_stale', 'This jar just changed. Refresh and try again.');
}
