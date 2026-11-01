// Pure request-body validators for the varieties Lambda, extracted from index.js so they can be
// unit-tested without the handler's runtime deps (@neondatabase/serverless etc.). Bundled with
// index.js (whole-dir zip), so the relative import resolves at runtime. No side effects, no I/O.

export const VALID_SUN = ['full_sun', 'part_sun', 'part_shade', 'full_shade'];
// Mirrors the chk_plant_varieties_lifecycle CHECK + crop_types.default_lifecycle CHECK.
export const VALID_LIFECYCLE = ['annual', 'tender_perennial', 'perennial', 'biennial'];
// Mirror the live plant_varieties CHECK constraints (v4-classify).
export const VALID_DETERMINACY = ['determinate', 'semi_determinate', 'indeterminate', 'dwarf'];
export const VALID_DAY_LENGTH = ['long_day', 'short_day', 'day_neutral', 'intermediate'];
export const VALID_GROWN_AS = ['annual', 'tender_perennial', 'perennial', 'biennial'];
// Mirror the sow-profile CHECKs in migrations/v4-seedinv-001/0a.
export const VALID_START_METHOD = ['start_indoors', 'direct_sow', 'both', 'indoors_only'];
export const VALID_SOW_SEASON = ['cool', 'warm', 'cool_warm'];
// Mirror chk_plant_varieties_breeding_system and the ONE provenance vocabulary that
// chk_plant_varieties_breeding_source and chk_plant_varieties_scoville_source share.
export const VALID_BREEDING_SYSTEM = ['f1', 'open_pollinated', 'landrace', 'unknown'];
export const VALID_FACT_SOURCE = [
  'packet_label', 'vendor_catalog', 'breeder', 'reference_work', 'grower_record', 'inference',
];
// Free text with no CHECK (v2-variety-origin). Trimmed on the way in; see normalizeOriginText.
export const ORIGIN_TEXT_FIELDS = ['origin_country', 'origin_region'];

// The columns a PUT may explicitly set back to NULL via `body.clear`. Deliberately excludes `name`:
// display_name is the identity every planting, harvest chip and picker row renders, and validateBody
// refuses a blank one, so a "clear the name" path would be a data-loss affordance. Also excludes the
// system columns (id/created_by/created_at/updated_at/deleted_at/model_version/
// source_proj_rescope_project_id) and dtm_basis: it IS read (the harvest watch anchors on
// COALESCE(cultivar's, crop's); the seed card words it after days to maturity) but this PUT has no arm
// that writes it, and a clear alone would be half a channel: a way to NULL a value readers use, with no
// way to put it back.
export const CLEARABLE_FIELDS = [
  'species', 'genus', 'days_to_maturity_min', 'days_to_maturity_max',
  'care_notes', 'soil_notes', 'sun_requirements', 'common_diseases', 'expected_yield_notes',
  'photo_id', 'source_url', 'crop_type_slug', 'lifecycle',
  'scoville_min', 'scoville_max', 'growth_habit', 'produces_scape',
  'determinacy', 'day_length_response', 'grown_as',
  'start_method', 'start_indoor_weeks_min', 'start_indoor_weeks_max',
  'direct_sow_timing', 'sow_depth_in', 'seed_spacing_in', 'row_spacing_in',
  'days_to_germ_min', 'days_to_germ_max', 'sow_season', 'sow_notes',
  // breeding_confidence and variety_rank stay OFF: no edit surface owns them, and variety_rank is half of
  // chk_plant_varieties_op_requires_cultivar (breedingPairingError).
  'origin_country', 'origin_region', 'breeding_system', 'breeding_source', 'scoville_source',
];

const CLEARABLE_SET = new Set(CLEARABLE_FIELDS);

// The actor GUC bind (BUG-VARIETYACTOREMPTY-001). Not a body validator, but pure, and the only module in
// this Lambda a unit test can import without @neondatabase/serverless.
//
// `set_config(name, NULL, true)` does NOT leave the setting unset: Postgres stores the EMPTY STRING.
// `current_setting('app.actor_clerk_sub', true)` then returns '', not NULL, so the audit trigger's
// `COALESCE(current_setting(...), 'system')` never fires and the audit row records an actor of ''. An
// absent userId would therefore produce a row asserting that somebody acted while refusing to say who,
// which is worse than no row because it looks like a record. Refuse the write instead. Every call site is
// already behind `if (!userId) return 401`, so this is unreachable in production and is the last line,
// not the first. Whitespace-only is refused with the empty string and NOT trimmed on the way through:
// '   ' is just as unattributable, while trimming a real sub would rewrite the recorded identity.
export function auditActor(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('audit actor is absent — refusing to write an unattributable audit row');
  }
  return userId;
}

// Absent/[] is the legacy no-op. A key that is BOTH cleared and given a value is rejected rather than
// silently resolved: picking a winner for an ambiguous request is the failure mode this exists to remove.
export function validateClear(clear, body = {}) {
  if (clear == null) return null;
  if (!Array.isArray(clear)) return 'clear must be an array of field names';
  for (const k of clear) {
    if (typeof k !== 'string' || !CLEARABLE_SET.has(k)) {
      return `clear contains a field that cannot be cleared: ${String(k)}`;
    }
    if (body[k] != null) return `${k} cannot be both cleared and set in the same request`;
  }
  return null;
}

export function validateBody(body, { requireName = true } = {}) {
  if (!body || typeof body !== 'object') return 'body required';
  // The blank check is NOT gated on requireName. Gating both on it let the PUT (requireName:false, so
  // the key may be omitted) skip the BLANK check, and '' passed the validator and the NOT NULL constraint
  // (the COALESCE binds '' rather than NULL). Absence and emptiness are different questions: only the
  // first is optional on a partial update. Guarded by blank-name-guard.test.js.
  if (requireName && body.name == null) return 'name is required';
  if (body.name != null && (typeof body.name !== 'string' || !body.name.trim())) return 'name cannot be blank';
  // The botanical identity pair gets the same shape check as every other user-typed string: non-empty
  // string or null, plus a cap. BLANK is refused rather than stored, because `clear` is the channel for
  // emptying these and a '' genus reads as "set" to every consumer. The caps are far above any real
  // binomial (they stop a pasted paragraph landing in a column crop-derive.js substring-matches) and loose
  // enough that no existing row becomes un-editable on PUT.
  for (const [k, cap] of [['genus', 120], ['species', 200]]) {
    if (body[k] != null) {
      if (typeof body[k] !== 'string' || !body[k].trim()) return `${k} must be a non-empty string or null`;
      if (body[k].length > cap) return `${k} must be <= ${cap} characters`;
    }
  }
  if (body.sun_requirements != null && !VALID_SUN.includes(body.sun_requirements)) {
    return `sun_requirements must be one of: ${VALID_SUN.join(', ')}`;
  }
  if (body.source_url != null && body.source_url !== '' && !/^https:\/\//.test(body.source_url)) {
    return 'source_url must use https://';
  }
  if (body.days_to_maturity_min != null && body.days_to_maturity_max != null) {
    const min = Number(body.days_to_maturity_min);
    const max = Number(body.days_to_maturity_max);
    if (!Number.isNaN(min) && !Number.isNaN(max) && min > max) {
      return 'days_to_maturity_min must be <= days_to_maturity_max';
    }
  }
  if (body.common_diseases != null && !Array.isArray(body.common_diseases)) {
    return 'common_diseases must be an array of strings';
  }
  // crop_type_slug existence is enforced by the crop_types FK (bad slug -> 23503 -> 400); here we only type-check.
  if (body.crop_type_slug != null && (typeof body.crop_type_slug !== 'string' || !body.crop_type_slug.trim())) {
    return 'crop_type_slug must be a non-empty string or null';
  }
  if (body.lifecycle != null && !VALID_LIFECYCLE.includes(body.lifecycle)) {
    return `lifecycle must be one of: ${VALID_LIFECYCLE.join(', ')}`;
  }
  for (const k of ['scoville_min', 'scoville_max']) {
    if (body[k] != null) {
      const n = Number(body[k]);
      if (!Number.isInteger(n) || n < 0) return `${k} must be a non-negative integer or null`;
    }
  }
  if (body.scoville_min != null && body.scoville_max != null && Number(body.scoville_min) > Number(body.scoville_max)) {
    return 'scoville_min must be <= scoville_max';
  }
  if (body.growth_habit != null && typeof body.growth_habit !== 'string') {
    return 'growth_habit must be a string or null';
  }
  if (body.produces_scape != null && typeof body.produces_scape !== 'boolean') {
    return 'produces_scape must be a boolean or null';
  }
  // Enum fields mirror the DB CHECK constraints so a bad value 400s here instead of surfacing as a 23514 string.
  for (const [k, valid] of [
    ['determinacy', VALID_DETERMINACY],
    ['day_length_response', VALID_DAY_LENGTH],
    ['grown_as', VALID_GROWN_AS],
    ['start_method', VALID_START_METHOD],
    ['sow_season', VALID_SOW_SEASON],
    ['breeding_system', VALID_BREEDING_SYSTEM],
    ['breeding_source', VALID_FACT_SOURCE],
    ['scoville_source', VALID_FACT_SOURCE],
  ]) {
    if (body[k] != null && !valid.includes(body[k])) {
      return `${k} must be one of: ${valid.join(', ')}`;
    }
  }
  // Capped like species at 200, to stop a pasted essay while staying loose enough that no stored row
  // becomes un-editable on PUT (research loads write origin_region by SQL, past this validator, and some
  // run past 120). Measured after the trim, so padding never counts; the POST, which does not trim, is
  // measured the same way.
  for (const k of ORIGIN_TEXT_FIELDS) {
    if (body[k] != null) {
      if (typeof body[k] !== 'string') return `${k} must be a string or null`;
      if (body[k].trim().length > 200) return `${k} must be <= 200 characters`;
    }
  }
  // Integer fields (weeks, germination days, DTM), scoville-style checks. DTM needs them because its
  // both-sent ordering check above lets -5 or 2.5 through.
  for (const k of ['days_to_maturity_min', 'days_to_maturity_max', 'start_indoor_weeks_min', 'start_indoor_weeks_max', 'days_to_germ_min', 'days_to_germ_max']) {
    if (body[k] != null) {
      const n = Number(body[k]);
      if (!Number.isInteger(n) || n < 0) return `${k} must be a non-negative integer or null`;
    }
  }
  for (const [minK, maxK] of [
    ['start_indoor_weeks_min', 'start_indoor_weeks_max'],
    ['days_to_germ_min', 'days_to_germ_max'],
  ]) {
    if (body[minK] != null && body[maxK] != null && Number(body[minK]) > Number(body[maxK])) {
      return `${minK} must be <= ${maxK}`;
    }
  }
  // Numeric (inches) fields: non-negative numbers.
  for (const k of ['sow_depth_in', 'seed_spacing_in', 'row_spacing_in']) {
    if (body[k] != null) {
      const n = Number(body[k]);
      if (Number.isNaN(n) || n < 0) return `${k} must be a non-negative number or null`;
    }
  }
  // Free-text fields: length caps.
  for (const [k, cap] of [['direct_sow_timing', 2000], ['sow_notes', 4000]]) {
    if (body[k] != null) {
      if (typeof body[k] !== 'string') return `${k} must be a string or null`;
      if (body[k].length > cap) return `${k} must be <= ${cap} characters`;
    }
  }
  return null;
}

// ── Origin, breeding and heat source on the PUT (V5-VARIETYFACTSEDIT-001) ───────────────────────

// Origin text is trimmed, and a value EMPTY after the trim is a clear, not a '' stored as a second
// spelling of "not recorded". Done by rewriting the body before any validator sees it, so validateClear,
// the CASE arms and the RETURNING treat it like a `clear` the client sent; a caller sending '' AND
// naming the key in `clear` is not refused as "both cleared and set", because it asked for one thing
// twice. A malformed `clear` is left untouched for validateClear to refuse.
export function normalizeOriginText(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out = { ...body };
  for (const k of ORIGIN_TEXT_FIELDS) {
    if (typeof out[k] !== 'string') continue;
    const t = out[k].trim();
    if (t) { out[k] = t; continue; }
    delete out[k];
    if (out.clear == null) out.clear = [];
    if (Array.isArray(out.clear) && !out.clear.includes(k)) out.clear = [...out.clear, k];
  }
  return out;
}

// True when the patch can change either side of a breeding pairing, the only time the PUT needs the
// current row. Anything else cannot violate either CHECK below.
export function touchesBreeding(body, clear = []) {
  return ['breeding_system', 'breeding_source'].some((k) => body?.[k] != null || clear.includes(k));
}

// The two CHECKs on plant_varieties that couple breeding_system to ANOTHER column, evaluated on the row
// as it will be AFTER the patch (cleared -> NULL, sent -> the value, absent -> the current value). Checked
// before the UPDATE so the caller gets a plain-English 400 instead of a raw 23514. The messages name the
// editor's labels, never a column, because they reach the user verbatim in the editor's error banner.
// `current` is { breeding_system, breeding_source, variety_rank } read under the PUT's own ownership
// predicate.
//   chk_plant_varieties_breeding_sourced:     breeding_system IS NULL OR breeding_source IS NOT NULL
//   chk_plant_varieties_op_requires_cultivar: breeding_system IS DISTINCT FROM 'open_pollinated'
//                                             OR variety_rank IS NOT DISTINCT FROM 'cultivar'
// variety_rank has no edit surface. Choosing Open-pollinated on a variety whose rank was never recorded
// (NULL) records it as a single named cultivar: fillsCultivarRank says when, and the UPDATE fills the
// rank in the same statement. A rank that IS recorded and is not cultivar (market_class, blend,
// species, placeholder) refuses; the CHECK would too. Both CHECKs still stand behind this: a concurrent
// write between the read and the UPDATE lands on them.
export const RANK_WORDS = {
  market_class: 'a market class (a group of similar varieties)',
  blend: 'a seed blend',
  species: 'a whole species',
  placeholder: 'a placeholder',
};

// The two refusals, worded once: breedingPairingError says them before the UPDATE, and CONSTRAINT_MESSAGES
// below says the same thing when the CHECK itself refuses it.
const SOURCE_REQUIRED = '"Breeding info from" is required when Breeding is set.';
const opNeedsCultivar = (rank) => 'Open-pollinated applies only to a single named variety, and this entry is recorded as '
  + `${RANK_WORDS[rank] ?? 'something other than a single named variety'}.`;

export function breedingPairingError(body, clear = [], current = {}) {
  const after = (k) => (clear.includes(k) ? null : (body?.[k] ?? current?.[k] ?? null));
  const system = after('breeding_system');
  if (system == null) return null;
  if (after('breeding_source') == null) return SOURCE_REQUIRED;
  const rank = current?.variety_rank ?? null;
  if (system === 'open_pollinated' && rank != null && rank !== 'cultivar') return opNeedsCultivar(rank);
  return null;
}

// True when this patch records Open-pollinated on a row with no recorded rank, so the UPDATE sets
// variety_rank = 'cultivar' in the same statement (the invariant v5-varietyhybridflag-001 states: a
// positive open-pollinated claim structurally requires the rank that makes it meaningful). The CHECK is
// NULL-safe (v5-oprankchecknull-001), so without this fill the UPDATE would be refused; the fill records
// the rank and the CHECK stops any other writer skipping it. Only a row whose rank is NULL: a recorded
// rank is never overwritten. Call it after breedingPairingError returned null.
export function fillsCultivarRank(body, clear = [], current = {}) {
  return body?.breeding_system === 'open_pollinated'
    && !clear.includes('breeding_system')
    && (current?.variety_rank ?? null) === null;
}

// The race path. breedingPairingError decides on a row read BEFORE the UPDATE, so a write landing
// between the two is refused by the CHECK itself and the Lambda's catch sees a 23514 naming the
// constraint. It consults this map before its generic arm (the lambda/plants CONSTRAINT_MESSAGES
// pattern), so the banner reads the preflight's own sentence whichever side of the race caught it. The
// rank that tripped op_requires_cultivar is not known here, so that sentence takes the rank-agnostic
// wording. Every other constraint keeps "Constraint violation: <name>".
export const CONSTRAINT_MESSAGES = {
  chk_plant_varieties_breeding_sourced: SOURCE_REQUIRED,
  chk_plant_varieties_op_requires_cultivar: opNeedsCultivar(null),
};

// ── User-minted crop types (V4-CROPTYPE-001) ───────────────────────────────────────────────────
// Design: synonyms-not-types and always-add-on-the-fly. Guard only the code-coupled slugs; everything
// else creates free, so a genuinely new crop (hibiscus, amaranth, luffa) is never blocked.

// The categories actually in use. `crop_types.category` has NO CHECK constraint, so this is the only thing
// keeping the facet vocabulary from fragmenting into ornamental/Ornamental/ornamentals.
//
// 'non_plant_food' (bread, cheese, milk, ...) is NOT a botanical category: it is the gate the app filters
// ON, so food classes reach the Put-Up crop field and no other picker (useCropTypes defaults to scope
// 'garden', which excludes exactly this value). It is listed so minting a further food class through
// the app is possible; the seed migration writes raw SQL and does not depend on this list.
export const VALID_CROP_CATEGORY = [
  'vegetable', 'flower', 'herb', 'fruit', 'succulent', 'houseplant', 'tree', 'ornamental',
  'non_plant_food',
];

// The slugs that crop-derive branches on (lambda/{varieties,tags}/crop-derive.js, kept byte-identical by
// a test). A variety typed to one gets crop-specific DERIVED facets: pepper -> heat/scoville, tomato ->
// determinacy, onion -> day_length, onion|garlic|shallot|chives -> allium_type, bunching_onion ->
// allium_type, basil -> basil_use, bean -> bean_type/habit/use. That is why they are guarded: minting
// "Peppers" as a SECOND type errors nowhere and silently produces varieties that derive NO heat facet
// and fall out of those views. The failure is invisible, so it is blocked at the door.
export const COUPLED_CROP_SLUGS = ['basil', 'bean', 'bunching_onion', 'chives', 'garlic', 'onion', 'pepper', 'shallot', 'tomato'];

// Hand-maintained aliases for the coupled slugs ONLY. Deliberately narrow: a false positive blocks a
// legitimate crop, so entries must be names that are unambiguously the coupled crop. Notably absent:
// "garlic chives", a distinct crop from both garlic and chives.
export const COUPLED_CROP_SYNONYMS = {
  chili: 'pepper', chile: 'pepper', chilli: 'pepper', capsicum: 'pepper',
  sweet_pepper: 'pepper', hot_pepper: 'pepper', bell_pepper: 'pepper', chili_pepper: 'pepper',
  tomatoe: 'tomato', love_apple: 'tomato',
  scallion: 'bunching_onion', green_onion: 'bunching_onion', spring_onion: 'bunching_onion',
  welsh_onion: 'bunching_onion', japanese_bunching_onion: 'bunching_onion',
  snap_bean: 'bean', green_bean: 'bean', string_bean: 'bean', pole_bean: 'bean', bush_bean: 'bean',
  sweet_basil: 'basil',
};

// display_name -> slug. Server-derived, never caller-supplied: the slug is a PRIMARY KEY and an FK target,
// so letting a client name it invites collisions and unicode games.
export function slugifyCropType(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip combining accents: "Épinard" -> "Epinard"
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

// Crude singularization for the plural-collision case ("Tomatoes" -> tomato). Only ever used to LOOK UP an
// existing slug, never to mint one, so an over-eager strip is harmless.
function singularize(slug) {
  if (/ies$/.test(slug)) return slug.replace(/ies$/, 'y');
  // 'o' is in the group for tomatoes/potatoes; without it "Tomatoes" only resolves via the synonym map,
  // leaving every NON-coupled plural unguarded.
  if (/(ch|sh|s|x|z|o)es$/.test(slug)) return slug.replace(/es$/, '');
  if (/[^s]s$/.test(slug)) return slug.replace(/s$/, '');
  return slug;
}

// Decide what a proposed crop-type name should do.
//   { ok: true,  slug }                          -> create it
//   { ok: false, reason, slug, existingSlug }    -> steer to existingSlug instead
// `existingSlugs` is the set of crop_types.slug INCLUDING soft-deleted, so a resurrect collides rather
// than violating the PK.
export function resolveCropTypeName(name, existingSlugs = []) {
  const slug = slugifyCropType(name);
  if (!slug) return { ok: false, reason: 'invalid', slug: '', existingSlug: null };

  const have = new Set(existingSlugs);
  // 1. Exact collision: steer to it whether or not it is coupled. Not an error; the user asked for a
  //    type that exists, so the right outcome is "use that one".
  if (have.has(slug)) return { ok: false, reason: 'exists', slug, existingSlug: slug };

  // 2. Plural of something that exists ("Tomatoes" when tomato exists).
  const sing = singularize(slug);
  if (sing !== slug && have.has(sing)) return { ok: false, reason: 'plural', slug, existingSlug: sing };

  // 2b. ...and the reverse: a SINGULAR of an existing plural ("Chive" when chives exists), else every crop
  // whose canonical slug is already plural is unguarded from the singular form.
  if (have.has(`${slug}s`)) return { ok: false, reason: 'plural', slug, existingSlug: `${slug}s` };

  // 3. Known alias of a COUPLED slug, checked on both the raw and singularized form ("chilis" -> chili -> pepper).
  const alias = COUPLED_CROP_SYNONYMS[slug] ?? COUPLED_CROP_SYNONYMS[sing];
  if (alias && have.has(alias)) return { ok: false, reason: 'coupled_synonym', slug, existingSlug: alias };

  // Everything else creates free — including brand-new crops that no code branches on.
  return { ok: true, slug, existingSlug: null };
}

export function validateCropTypeBody(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.display_name || typeof body.display_name !== 'string' || !body.display_name.trim()) {
    return 'display_name is required';
  }
  if (body.display_name.length > 80) return 'display_name must be <= 80 characters';
  if (body.category != null && !VALID_CROP_CATEGORY.includes(body.category)) {
    return `category must be one of: ${VALID_CROP_CATEGORY.join(', ')}`;
  }
  if (body.default_lifecycle != null && !VALID_LIFECYCLE.includes(body.default_lifecycle)) {
    return `default_lifecycle must be one of: ${VALID_LIFECYCLE.join(', ')}`;
  }
  return null;
}

// ── The provenance registry (V4-SOURCEREG-001 / V5-SOURCEKIND-001) ───────────────────────────
// public.source is WHO/WHERE a plant or packet came from; public.source_kind is the controlled vocabulary
// source.kind is typed against. Both mint from the app, on the crop-types contract.

// The fold BOTH partial-unique indexes use, mirrored expression-for-expression:
//   public.source.match_key       GENERATED ALWAYS AS regexp_replace(lower(name),'[^a-z0-9]','','g')
//                                 with uq_source_match_key_live UNIQUE on it WHERE deleted_at IS NULL
//   uq_source_kind_display_live   UNIQUE on that same expression over display_name, live rows only
//
// DELIBERATELY NOT slugifySourceKind's fold, which NFKD-normalises first: "Épinard" folds to "epinard"
// there and to "pinard" here (Postgres lower() leaves the combining accent alone and the strip removes
// the whole letter). Folding HARDER than the database steers a caller away from a name the index would
// accept; folding SOFTER lets the collision reach the INSERT as a 23505, a 500 the client cannot tell
// from a transport failure. So this mirrors the index rather than approximating it.
export function foldSourceKey(s) {
  if (typeof s !== 'string') return '';
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// '' -> null for an optional column. Every optional text input submits an empty string rather than
// omitting its key, and Postgres would store it, leaving two spellings of "not recorded" for every
// reader to handle.
export function blankToNull(v) {
  if (typeof v !== 'string') return v ?? null;
  const t = v.trim();
  return t === '' ? null : t;
}

// display_name -> slug. Server-derived, never caller-supplied: source_kind.slug is a PRIMARY KEY and the
// FK target of source.kind. Same derivation as slugifyCropType and deliberately a SEPARATE function: two
// independent primary keys with independent shape CHECKs, and a tweak for crop types must not silently
// re-derive what source rows point at.
export function slugifySourceKind(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip combining accents, as slugifyCropType does
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

// Decide what a proposed source-kind name should do.
//   { ok: true,  slug }                          -> create it
//   { ok: false, reason, slug, existingSlug }    -> steer to existingSlug instead
//
// The two collision sets differ on purpose:
//   `existingSlugs` is EVERY slug INCLUDING soft-deleted ones: slug is the PK, so a resurrect would
//   violate it.
//   `liveKinds` is the LIVE rows only, as { slug, display_name }: uq_source_kind_display_live is a PARTIAL
//   index, so a retired label blocks nothing and steering on one would refuse a create the database accepts.
export function resolveSourceKindName(displayName, existingSlugs = [], liveKinds = []) {
  const slug = slugifySourceKind(displayName);
  // chk_source_kind_slug_shape floors the slug at 2 characters, so a shorter derived slug is invalid here
  // rather than a 23514 raised by the INSERT.
  if (slug.length < 2) return { ok: false, reason: 'invalid', slug, existingSlug: null };

  const have = new Set(existingSlugs);
  if (have.has(slug)) return { ok: false, reason: 'exists', slug, existingSlug: slug };

  const sing = singularize(slug);
  if (sing !== slug && have.has(sing)) return { ok: false, reason: 'plural', slug, existingSlug: sing };
  // ...and the reverse: a SINGULAR of an existing plural ("Farm stand" beside "Farm stands").
  if (have.has(`${slug}s`)) return { ok: false, reason: 'plural', slug, existingSlug: `${slug}s` };

  // THE LOAD-BEARING CHECK. A label that folds onto a live row without colliding on slug ("Seedcompany"
  // beside "Seed company") passes every slug test above and then raises 23505 on
  // uq_source_kind_display_live, a 500 where the user should be handed the row they meant.
  const label = foldSourceKey(displayName);
  const clash = liveKinds.find((k) => foldSourceKey(k?.display_name) === label);
  if (clash) return { ok: false, reason: 'label', slug, existingSlug: clash.slug };

  return { ok: true, slug, existingSlug: null };
}

export function validateSourceKindBody(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (typeof body.display_name !== 'string' || !body.display_name.trim()) {
    return 'display_name is required';
  }
  const n = body.display_name.trim();
  // Mirrors chk_source_kind_display_name_shape (trimmed, 2..80 chars, contains an alphanumeric).
  if (n.length < 2 || n.length > 80) return 'display_name must be 2-80 characters';
  if (!/[A-Za-z0-9]/.test(n)) return 'display_name must contain at least one letter or number';
  // Refused rather than ignored: silently overwriting a supplied slug would leave the caller believing
  // the key it chose is the one every source row points at.
  if (body.slug != null) return 'slug is derived from display_name and cannot be supplied';
  return null;
}

// The three link columns on public.source, each backed by the same `IS NULL OR ~ '^https?://'` CHECK
// (chk_source_website_url, chk_source_instagram_url, chk_source_facebook_url). One list so POST and PATCH
// cannot disagree about which fields are links.
export const URL_FIELDS = ['website_url', 'instagram_url', 'facebook_url'];
const SOURCE_TEXT_FIELDS = ['locality', 'address', 'notes'];

// Every column a PATCH may write. Anything else is refused rather than ignored: a caller that sends a key
// this route drops would believe it saved.
export const SOURCE_PATCH_FIELDS = ['name', 'kind', ...SOURCE_TEXT_FIELDS, ...URL_FIELDS];
// Named separately so the refusal says WHY. id is the key; match_key is GENERATED from name; created_by is
// the audit anchor (see authz.js); deleted_at is soft-delete, which this route does not offer; the two
// timestamps are the database's.
export const SOURCE_PATCH_FORBIDDEN = ['id', 'match_key', 'created_by', 'deleted_at', 'created_at', 'updated_at'];

function sourceNameError(name) {
  if (typeof name !== 'string' || !name.trim()) return 'name is required';
  const n = name.trim();
  // Mirrors chk_source_name_shape (trimmed, 2..200 chars, contains an alphanumeric).
  if (n.length < 2 || n.length > 200) return 'name must be 2-200 characters';
  if (!/[A-Za-z0-9]/.test(n)) return 'name must contain at least one letter or number';
  return null;
}

// Type + scheme checks for the optional columns present in `body`. Absent keys are not checked.
function sourceOptionalFieldsError(body) {
  // A BLANK link is treated as absent rather than a violation (as validateBody does for source_url): a
  // save that 400s because an untouched optional field submitted '' looks, to the user, like one that
  // 400s because what they typed was wrong.
  for (const k of URL_FIELDS) {
    if (body[k] != null && typeof body[k] !== 'string') return `${k} must be a string or null`;
    const url = blankToNull(body[k]);
    if (url != null && !/^https?:\/\//.test(url)) return `${k} must start with http:// or https://`;
  }
  // kind's membership in the live vocabulary is a DB question checked by the route; this is the type check only.
  if (body.kind != null && typeof body.kind !== 'string') {
    return 'kind must be a source kind slug or null';
  }
  for (const k of SOURCE_TEXT_FIELDS) {
    if (body[k] != null && typeof body[k] !== 'string') return `${k} must be a string or null`;
  }
  return null;
}

export function validateSourceBody(body) {
  if (!body || typeof body !== 'object') return 'body required';
  return sourceNameError(body.name) ?? sourceOptionalFieldsError(body);
}

// PATCH /api/varieties/sources/:id: partial. Only keys PRESENT in the body are written; a present blank
// optional field is a clear (stored as NULL). name cannot be cleared: it is the table's one NOT NULL column.
export function validateSourcePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const keys = Object.keys(body);
  const forbidden = keys.find((k) => SOURCE_PATCH_FORBIDDEN.includes(k));
  if (forbidden) return `${forbidden} cannot be changed`;
  const unknown = keys.find((k) => !SOURCE_PATCH_FIELDS.includes(k));
  if (unknown) return `unknown field: ${unknown}`;
  if (!keys.length) return 'nothing to update';
  if ('name' in body) {
    const err = sourceNameError(body.name);
    if (err) return err;
  }
  return sourceOptionalFieldsError(body);
}
