// The pure half of "what went into this jar, and where did each part come from?"
// (V5-PUTUPMULTISOURCE-001).
//
// Seam rule, as kitchenBatch.js/kitchenRoutes.js: anything that DECIDES lives here, anything that TOUCHES
// THE DATABASE lives in sourceRoutes.js. Every function is pure (no sql, no clock, no env), so vitest can
// import it without index.js's module-scope neon/clerk loads.
//
// The rulings this file enforces (read the absences as hard as the presences):
//   1. THE PARENT IS A CACHE OF ORDINAL 0, which keeps preservation_log untouched.
//      migrations/v5-putupmultisource-001/0a-additive-ddl.sql D1 leaves the parent's source columns as they
//      are and re-reads them as a mirror of the ordinal-0 source row; that is sound only if a writer
//      maintains the mirror, and `parentCache` below is that writer's single source of truth. It is why
//      chk_preservation_log_source_plant need not be dropped: the combination it forbids (a vendor
//      source_kind beside a garden plant_id) is one this function cannot emit. NO SQL GATE CAN SEE THIS
//      INVARIANT (gates.yml says so); the parent's CHECK is the backstop, putUpSources.test.js the proof.
//   2. PROVENANCE_GRADE IS SENT, NOT INFERRED AT READ TIME. `deriveGrade` only proposes a default AT ENTRY
//      when a client omits it; nothing re-derives a stored grade. After an ON DELETE SET NULL the row no
//      longer carries the evidence its grade was based on, and re-deriving would downgrade "he knew, and
//      the planting is gone" to "he never knew".
//   3. A SOURCE ROW ALWAYS HAS A LABEL. display_label is NOT NULL (the identity rule, 0a header D2). No
//      path invents one from a crop slug or planting id: an invented label would be indistinguishable from
//      one the user wrote.
//   4. HETEROGENEITY IS THE FEATURE. A bought ingredient with no planting behind it is a first-class row:
//      it needs no crop_types entry, may carry its own vendor, and sits in the same list as a
//      planting-grade garden source.
//   5. EVERY REFUSAL NAMES THE ROW: each message carries the 1-based position, since "label required"
//      against a five-ingredient pesto is unactionable on a phone.

// Vocabularies. PINNED TO THE DDL, not merely copied: putUpSources.test.js text-reads all three arrays out
// of migrations/v5-putupmultisource-001/0a-additive-ddl.sql's CHECK clauses and asserts set equality (the
// model is startChipParity.test.js). The eight source kinds are preservation_log's own vocabulary verbatim
// (chk_preservation_log_source_kind), re-homed to the child so two ingredients can carry two vendors.
export const PS_SOURCE_KINDS = [
  'own_garden', 'u_pick', 'farm_stand', 'csa', 'store', 'gift', 'foraged', 'other',
];

// Coarsest to finest; the ORDER IS SEMANTIC (`gradeAtLeast` compares by index). Do not alphabetise.
export const PS_PROVENANCE_GRADES = ['origin', 'crop', 'planting', 'harvest'];

// chk_kbi_qty_unit's fourteen, verbatim, so an ingredient moved from a kitchen batch to a jar never
// needs its unit respelled. Note the space in 'fl oz'.
export const PS_QTY_UNITS = [
  'g', 'kg', 'oz', 'lb', 'count', 'cup', 'tbsp', 'tsp', 'fl oz', 'qt', 'gal', 'ml', 'l', 'other',
];

// The columns a client may set; everything else is server-owned. An allowlist, so a column added later is
// not writable by an old client by default.
export const PS_WRITABLE_COLUMNS = [
  'source_kind', 'source_label', 'display_label', 'provenance_grade',
  'crop_type_slug', 'variety_id', 'plant_id', 'harvest_log_id',
  'quantity_value', 'quantity_unit', 'note',
];

// Live rows of one jar, in entry order; mirrors idx_ps_parent. `id` breaks the tie two rows written in one
// statement would otherwise have (the nondeterminism STAGE_LOG_ORDER removes).
export const PS_ORDER = 'ordinal ASC, id ASC';

export const PS_MAX_SOURCES = 24;
// Bounded because the list is rendered and edited whole. 24 is not a database limit: it is "more
// ingredients than any jar described", so a runaway client loop cannot write a thousand rows against one
// jar through a directly-callable Function URL.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_MAX = 120;

// '' collapses to null. A whitespace-only label is NOT a label (chk_ps_label_nonblank), applied here so the
// refusal is a 400 with words rather than a 23514.
export function normalizeText(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

// The 1-based position the messages share: a person reads it against the list they are looking at.
const at = (i) => `source ${i + 1}`;

// One row's error, or null. EVERY branch corresponds to a CHECK on preservation_source. Shape errors (kind,
// label) come before relational ones (garden_only), so a row wrong in two ways names the wrong the user
// can act on first.
export function sourceRowError(raw, i = 0) {
  const r = raw ?? {};

  const kind = normalizeText(r.source_kind);
  if (kind == null) return `${at(i)}: needs a source — where did it come from?`;
  if (!PS_SOURCE_KINDS.includes(kind)) {
    return `${at(i)}: source must be one of: ${PS_SOURCE_KINDS.join(', ')}`;
  }

  // chk_ps_label_nonblank + the NOT NULL. The identity rule has no exemption: a garden source is named too,
  // because after the planting is deleted the label is all that is left.
  const label = normalizeText(r.display_label);
  if (label == null) return `${at(i)}: needs a name — what went in?`;
  if (label.length > LABEL_MAX) return `${at(i)}: name must be ${LABEL_MAX} characters or fewer`;

  // chk_ps_source_label_nonblank / _len. Vendor-only by convention; `normalizeSourceRows` nulls it on
  // own_garden rather than refusing, because a stale client sending a leftover vendor with a flipped kind
  // is a UI artefact, not a user error.
  const vendor = normalizeText(r.source_label);
  if (vendor != null && vendor.length > LABEL_MAX) {
    return `${at(i)}: vendor must be ${LABEL_MAX} characters or fewer`;
  }

  const grade = normalizeText(r.provenance_grade);
  if (grade != null && !PS_PROVENANCE_GRADES.includes(grade)) {
    return `${at(i)}: provenance_grade must be one of: ${PS_PROVENANCE_GRADES.join(', ')}`;
  }

  for (const col of ['plant_id', 'variety_id', 'harvest_log_id']) {
    const v = normalizeText(r[col]);
    if (v != null && !UUID_RE.test(v)) return `${at(i)}: ${col} must be a uuid`;
  }

  // chk_ps_garden_only, refused here so the message says WHY rather than surfacing a 23514. Also the
  // client-side half of what keeps preservation_log's chk_preservation_log_source_plant true (0a header
  // D1): a bought ingredient never carries a garden pointer, at either cardinality.
  const plant = normalizeText(r.plant_id);
  const harvest = normalizeText(r.harvest_log_id);
  if (kind !== 'own_garden' && (plant != null || harvest != null)) {
    return `${at(i)}: something from ${kind} cannot be linked to a planting or a pick`;
  }

  // chk_ps_qty_pairing. A blank typed into a number box is NOT zero and NOT a quantity ('' would pair-check
  // as present, then coerce to 0 and fail chk_ps_qty_positive). Both halves collapse to absent together;
  // an absent pair means "how much was not recorded".
  const qtyRaw = normalizeText(r.quantity_value);
  const unit = normalizeText(r.quantity_unit);
  if ((qtyRaw == null) !== (unit == null)) {
    return `${at(i)}: amount and unit must both be set, or both be empty`;
  }
  if (qtyRaw != null) {
    const n = Number(qtyRaw);
    if (!Number.isFinite(n) || n <= 0) return `${at(i)}: amount must be greater than 0`;
    if (!PS_QTY_UNITS.includes(unit)) {
      return `${at(i)}: unit must be one of: ${PS_QTY_UNITS.join(', ')}`;
    }
  }

  return null;
}

// The grade a row would be given IF the client sent none (finest evidence wins). NOT a read-time
// derivation (ruling 2). Exported so the client can show the same default and a test can assert the two agree.
export function deriveGrade(raw) {
  const r = raw ?? {};
  if (normalizeText(r.harvest_log_id) != null) return 'harvest';
  if (normalizeText(r.plant_id) != null) return 'planting';
  if (normalizeText(r.crop_type_slug) != null || normalizeText(r.variety_id) != null) return 'crop';
  return 'origin';
}

// Index comparison against PS_PROVENANCE_GRADES' semantic order. Returns false for anything not in
// the vocabulary rather than throwing — an unknown grade is not "at least" anything.
export function gradeAtLeast(grade, floor) {
  const a = PS_PROVENANCE_GRADES.indexOf(grade);
  const b = PS_PROVENANCE_GRADES.indexOf(floor);
  return a >= 0 && b >= 0 && a >= b;
}

// { error, rows }: rows is null whenever error is set, and vice versa. Ordinals are assigned by POSITION IN
// THE SUBMITTED ARRAY and never read from the client, so uq_ps_parent_ordinal has exactly one row per slot.
// A whole-list replace, not a merge: the caller (sourceRoutes.js) soft-deletes the previous set in the same
// transaction, so re-sending a five-row list after editing row three is well-defined without a
// client-computed diff.
export function normalizeSourceRows(rows) {
  if (!Array.isArray(rows)) return { error: 'sources must be an array', rows: null };
  if (rows.length === 0) return { error: 'sources must be a non-empty array', rows: null };
  if (rows.length > PS_MAX_SOURCES) {
    return { error: `a put-up may list at most ${PS_MAX_SOURCES} sources`, rows: null };
  }

  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const err = sourceRowError(rows[i], i);
    if (err) return { error: err, rows: null };
    const r = rows[i] ?? {};
    const kind = normalizeText(r.source_kind);
    const qtyRaw = normalizeText(r.quantity_value);

    out.push({
      ordinal: i,
      source_kind: kind,
      // Vendor is nulled on own_garden rather than refused (see sourceRowError): a vendor beside own_garden
      // is always a stale control, and the parent's write path does the same nulling.
      source_label: kind === 'own_garden' ? null : normalizeText(r.source_label),
      display_label: normalizeText(r.display_label),
      // Sent value wins; the derivation is only a default, so a client that knows the planting is gone can
      // still assert 'planting' and keep the history.
      provenance_grade: normalizeText(r.provenance_grade) ?? deriveGrade(r),
      crop_type_slug: normalizeText(r.crop_type_slug),
      variety_id: normalizeText(r.variety_id),
      plant_id: normalizeText(r.plant_id),
      harvest_log_id: normalizeText(r.harvest_log_id),
      quantity_value: qtyRaw == null ? null : Number(qtyRaw),
      quantity_unit: qtyRaw == null ? null : normalizeText(r.quantity_unit),
      note: normalizeText(r.note),
    });
  }
  return { error: null, rows: out };
}

// The ordinal-0 mirror (ruling 1): the only place the parent's source columns are computed from a source
// list, and the correctness of leaving preservation_log unmigrated rests on it.
//
// Returns exactly the six parent columns, always all six, explicit nulls included. A partial object would
// let a COALESCE-preserving PUT keep a stale plant_id from a previous edit (a "false-provenance
// generator"), so the caller assigns every key unconditionally.
//
// THE CONDITIONAL ON own_garden IS THE INVARIANT, not defensive coding. chk_preservation_log_source_plant
// reads (source_kind IS NULL OR source_kind = 'own_garden' OR plant_id IS NULL), so a cache copying plant_id
// from a `store` ordinal-0 row would 23514 the parent UPDATE. A valid list cannot produce one
// (sourceRowError refuses a non-garden row carrying a planting), but the no-parent-migration decision rests
// on this function, so it is enforced a second time.
export function parentCache(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const primary = list.find((r) => Number(r?.ordinal) === 0) ?? null;
  if (!primary) {
    // No live sources: the honest cache is "unrecorded" across the board, NEVER a retained value from before
    // (NULL source_kind means unrecorded, v4-putupprov-001 D1-b).
    return {
      source_kind: null, source_label: null, plant_id: null,
      harvest_log_id: null, crop_type_slug: null, variety_id: null,
    };
  }
  const garden = primary.source_kind === 'own_garden';
  return {
    source_kind: primary.source_kind ?? null,
    source_label: garden ? null : (normalizeText(primary.source_label) ?? null),
    plant_id: garden ? (normalizeText(primary.plant_id) ?? null) : null,
    harvest_log_id: garden ? (normalizeText(primary.harvest_log_id) ?? null) : null,
    // Crop identity is NOT gated on own_garden: a bought ingredient may be a known crop, and
    // chk_preservation_log_attribution needs one of these two present. Only the GARDEN POINTERS are conditional.
    crop_type_slug: normalizeText(primary.crop_type_slug) ?? null,
    variety_id: normalizeText(primary.variety_id) ?? null,
  };
}

// True when this jar draws on more than one source: decides whether a surface says "and 2 more", nothing
// about storage.
export function isMultiSource(sources) {
  return Array.isArray(sources) && sources.length > 1;
}

// One line for one stored row. Says what is KNOWABLE from the row and never invents the rest; in particular
// it never renders a raw machine value: source_kind and provenance_grade reach the DOM through the label
// maps below, whose fallbacks are prose.
export const PS_KIND_LABELS = {
  own_garden: 'from the garden',
  u_pick: 'picked at a u-pick',
  farm_stand: 'from a farm stand',
  csa: 'from the CSA',
  store: 'bought',
  gift: 'a gift',
  foraged: 'foraged',
  other: 'from somewhere else',
};
export const PS_KIND_FALLBACK = 'from somewhere';

// The phrase for a grade whose pointer has since been nulled: the sentence the stored grade buys (0a header
// D3). Without it nothing distinguishes this row from one never better than crop-grade, and the app would
// show the coarser thing as the whole truth.
export const PS_LOST_POINTER = 'from a planting that has since been removed';

export function describeSource(row) {
  const r = row ?? {};
  const label = normalizeText(r.display_label) ?? '';
  const kind = normalizeText(r.source_kind);
  const vendor = normalizeText(r.source_label);
  const where = vendor ?? PS_KIND_LABELS[kind] ?? PS_KIND_FALLBACK;

  const qty = r.quantity_value == null || r.quantity_value === '' ? null : Number(r.quantity_value);
  const unit = normalizeText(r.quantity_unit);
  const amount = (qty != null && Number.isFinite(qty) && unit != null) ? ` — ${qty} ${unit}` : '';

  // The lost-pointer case: the row claims a grade finer than crop and the pointer it was based on is gone.
  // Reported, not hidden, not silently downgraded.
  const grade = normalizeText(r.provenance_grade);
  const lost = gradeAtLeast(grade, 'planting')
    && normalizeText(r.plant_id) == null
    && normalizeText(r.harvest_log_id) == null;

  return `${label} — ${lost ? PS_LOST_POINTER : where}${amount}`;
}
