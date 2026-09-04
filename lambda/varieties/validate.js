// lambda/varieties/validate.js — pure request-body validators for the varieties Lambda.
// Extracted from index.js so they can be unit-tested without importing the handler's
// runtime deps (@neondatabase/serverless etc.). Bundled with index.js (whole-dir zip),
// so the relative import resolves at runtime. No side effects, no I/O.

export const VALID_SUN = ['full_sun', 'part_sun', 'part_shade', 'full_shade'];
// PLANTTYPE: mirrors the chk_plant_varieties_lifecycle CHECK + crop_types.default_lifecycle CHECK.
export const VALID_LIFECYCLE = ['annual', 'tender_perennial', 'perennial', 'biennial'];
// CLASSIFY (v4-classify): mirror the live plant_varieties CHECK constraints.
export const VALID_DETERMINACY = ['determinate', 'semi_determinate', 'indeterminate', 'dwarf'];
export const VALID_DAY_LENGTH = ['long_day', 'short_day', 'day_neutral', 'intermediate'];
export const VALID_GROWN_AS = ['annual', 'tender_perennial', 'perennial', 'biennial'];
// SEEDINV (V4-SEEDINV-001): mirror the sow-profile CHECKs in migrations/v4-seedinv-001/0a.
export const VALID_START_METHOD = ['start_indoors', 'direct_sow', 'both', 'indoors_only'];
export const VALID_SOW_SEASON = ['cool', 'warm', 'cool_warm'];

// V4-EDITCOMPLETE-001 — the columns a PUT may explicitly set back to NULL via `body.clear`.
// Deliberately excludes `name`: display_name is the identity every planting, harvest chip and
// picker row renders, and validateBody already refuses a blank one — a "clear the name" path
// would be a data-loss affordance, not an edit affordance. Also excludes the system columns
// (id/created_by/created_at/updated_at/deleted_at/model_version/source_proj_rescope_project_id),
// which no edit surface owns, and dtm_basis, which has no read path or consumer yet
// (V4-MATURITYBASIS-001) — exposing a clear for a field nothing renders would be its own trap.
export const CLEARABLE_FIELDS = [
  'species', 'genus', 'days_to_maturity_min', 'days_to_maturity_max',
  'care_notes', 'soil_notes', 'sun_requirements', 'common_diseases', 'expected_yield_notes',
  'photo_id', 'source_url', 'crop_type_slug', 'lifecycle',
  'scoville_min', 'scoville_max', 'growth_habit', 'produces_scape',
  'determinacy', 'day_length_response', 'grown_as',
  'start_method', 'start_indoor_weeks_min', 'start_indoor_weeks_max',
  'direct_sow_timing', 'sow_depth_in', 'seed_spacing_in', 'row_spacing_in',
  'days_to_germ_min', 'days_to_germ_max', 'sow_season', 'sow_notes',
];

const CLEARABLE_SET = new Set(CLEARABLE_FIELDS);

// BUG-VARIETYACTOREMPTY-001 — the actor GUC bind. Not a body validator, but pure, and this is the
// only module in this Lambda a unit test can import without dragging in @neondatabase/serverless.
//
// `set_config(name, NULL, true)` does NOT leave the setting unset — Postgres stores the EMPTY
// STRING. `current_setting('app.actor_clerk_sub', true)` then returns '', which is not NULL, so the
// live trg_audit_plant_varieties expression `COALESCE(current_setting(...), 'system')` never fires
// and the audit row records an actor of ''. Measured on prod 2026-08-21:
//   set_config('app.actor_clerk_sub', NULL::text, true) -> current_setting(...) = ''  -> COALESCE = ''
// 201 plant_varieties audit rows (2026-06-26 … 2026-08-06) carry exactly that empty actor.
//
// So an absent userId does not degrade to 'system'. It degrades to a row asserting that somebody
// acted while refusing to say who — worse than no row, because it looks like a record. Refuse the
// write instead. Every call site is already behind `if (!userId) return 401`, so this is unreachable
// in production and exists to keep it that way: it is the last line, not the first.
// Whitespace-only is refused with the empty string and NOT trimmed on the way through: '   ' is
// just as unattributable as '', while trimming a value that IS a sub would quietly rewrite the
// identity being recorded.
export function auditActor(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('audit actor is absent — refusing to write an unattributable audit row');
  }
  return userId;
}

// Absent/[] is the legacy no-op. A key that is BOTH cleared and given a value is rejected rather
// than silently resolved — picking a winner for an ambiguous request is the exact failure mode
// this whole ticket exists to remove.
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
  // BUG-BLANKNAME-001 (2026-08-07). These were ONE condition gated entirely on requireName, so the
  // PUT — which passes requireName:false so it can omit the key — also skipped the BLANK check.
  // plant_varieties.name is NOT NULL, but the COALESCE binds '' rather than NULL, so '' passed both
  // the validator and the constraint and blanked the cultivar name. Absence and emptiness are
  // different questions: only the first is optional on a partial update.
  if (requireName && body.name == null) return 'name is required';
  if (body.name != null && (typeof body.name !== 'string' || !body.name.trim())) return 'name cannot be blank';
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
  // PLANTTYPE field validation (all optional). crop_type_slug existence is enforced by the
  // crop_types FK at the DB (bad slug → 23503 → 400); here we only type-check.
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
  // CLASSIFY + SEEDINV enum fields (all optional) — mirror the DB CHECK constraints so a
  // bad value 400s here instead of surfacing as a 23514 constraint-violation string.
  for (const [k, valid] of [
    ['determinacy', VALID_DETERMINACY],
    ['day_length_response', VALID_DAY_LENGTH],
    ['grown_as', VALID_GROWN_AS],
    ['start_method', VALID_START_METHOD],
    ['sow_season', VALID_SOW_SEASON],
  ]) {
    if (body[k] != null && !valid.includes(body[k])) {
      return `${k} must be one of: ${valid.join(', ')}`;
    }
  }
  // SEEDINV integer fields (weeks + germination days), scoville-style checks.
  for (const k of ['start_indoor_weeks_min', 'start_indoor_weeks_max', 'days_to_germ_min', 'days_to_germ_max']) {
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
  // SEEDINV numeric (inches) fields — non-negative numbers.
  for (const k of ['sow_depth_in', 'seed_spacing_in', 'row_spacing_in']) {
    if (body[k] != null) {
      const n = Number(body[k]);
      if (Number.isNaN(n) || n < 0) return `${k} must be a non-negative number or null`;
    }
  }
  // SEEDINV free-text fields — length caps.
  for (const [k, cap] of [['direct_sow_timing', 2000], ['sow_notes', 4000]]) {
    if (body[k] != null) {
      if (typeof body[k] !== 'string') return `${k} must be a string or null`;
      if (body[k].length > cap) return `${k} must be <= ${cap} characters`;
    }
  }
  return null;
}

// ── V4-CROPTYPE-001 — user-minted crop types ────────────────────────────────────────────────
// Dave's accepted design: "synonyms-not-types + always-add-on-the-fly. Guard only the 8
// code-coupled slugs; all else creates free." Everything below implements exactly that, and
// nothing more restrictive — a genuinely new crop (hibiscus, amaranth, luffa) must create freely.

// The categories actually in use. `crop_types.category` has NO CHECK constraint, so this is the
// only thing keeping the facet vocabulary from fragmenting into ornamental/Ornamental/ornamentals.
//
// V4-PUTUPFOODCATEGORY-001 adds 'non_plant_food' — bread, cheese, milk, butter, yogurt, meat, fish.
// It is NOT a botanical category and nothing about it is a garden facet: it is the gate the app
// filters ON, so that food classes reach the Put-Up crop field and no other picker (useCropTypes
// defaults to scope 'garden', which excludes exactly this value). It is listed here so that minting
// a further food class through the app is possible rather than rejected as an invalid category —
// the seed migration writes raw SQL and does not depend on this list.
export const VALID_CROP_CATEGORY = [
  'vegetable', 'flower', 'herb', 'fruit', 'succulent', 'houseplant', 'tree', 'ornamental',
  'non_plant_food',
];

// The 9 slugs that crop-derive branches on (lambda/{varieties,tags}/crop-derive.js, kept
// byte-identical by a test). A variety typed to one of these gets crop-specific DERIVED facets:
// pepper -> heat/scoville, tomato -> determinacy, onion -> day_length, onion|garlic|shallot|chives
// -> allium_type, bunching_onion -> allium_type, basil -> basil_use, bean -> bean_type/habit/use.
// This is why they are guarded: minting "Peppers" as a SECOND type does not error anywhere — it
// silently produces varieties that derive NO heat facet and quietly fall out of those views. The
// failure is invisible, which is exactly the kind worth blocking at the door.
export const COUPLED_CROP_SLUGS = ['basil', 'bean', 'bunching_onion', 'chives', 'garlic', 'onion', 'pepper', 'shallot', 'tomato'];

// Hand-maintained aliases for the coupled 8 ONLY. Deliberately narrow: a false positive here
// blocks a legitimate crop, so entries must be names that are unambiguously the coupled crop.
// (Notably absent: "garlic chives" — that is a distinct crop from both garlic and chives, and
// Dave already keeps it as its own thing.)
export const COUPLED_CROP_SYNONYMS = {
  chili: 'pepper', chile: 'pepper', chilli: 'pepper', capsicum: 'pepper',
  sweet_pepper: 'pepper', hot_pepper: 'pepper', bell_pepper: 'pepper', chili_pepper: 'pepper',
  tomatoe: 'tomato', love_apple: 'tomato',
  scallion: 'bunching_onion', green_onion: 'bunching_onion', spring_onion: 'bunching_onion',
  welsh_onion: 'bunching_onion', japanese_bunching_onion: 'bunching_onion',
  snap_bean: 'bean', green_bean: 'bean', string_bean: 'bean', pole_bean: 'bean', bush_bean: 'bean',
  sweet_basil: 'basil',
};

// display_name -> slug. Server-derived, never caller-supplied: the slug is a PRIMARY KEY and an FK
// target, so letting a client name it invites collisions and unicode games.
export function slugifyCropType(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip combining accents: "Épinard" -> "Epinard"
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

// Crude singularization, enough for the plural-collision case ("Tomatoes" -> tomato). Only ever
// used to LOOK UP an existing slug, never to mint one, so an over-eager strip is harmless.
function singularize(slug) {
  if (/ies$/.test(slug)) return slug.replace(/ies$/, 'y');
  // 'o' is in the group for tomatoes/potatoes; without it "Tomatoes" only resolves via the
  // hand-maintained synonym map, which would leave every NON-coupled plural unguarded.
  if (/(ch|sh|s|x|z|o)es$/.test(slug)) return slug.replace(/es$/, '');
  if (/[^s]s$/.test(slug)) return slug.replace(/s$/, '');
  return slug;
}

// Decide what a proposed crop-type name should do.
//   { ok: true,  slug }                          -> create it
//   { ok: false, reason, slug, existingSlug }    -> steer to existingSlug instead
// `existingSlugs` is the live set of crop_types.slug (including soft-deleted, so a resurrect
// collides rather than violating the PK).
export function resolveCropTypeName(name, existingSlugs = []) {
  const slug = slugifyCropType(name);
  if (!slug) return { ok: false, reason: 'invalid', slug: '', existingSlug: null };

  const have = new Set(existingSlugs);
  // 1. Exact collision — steer to it whether or not it is coupled. Not an error: the user asked
  //    for a type that already exists, so the right outcome is "use that one".
  if (have.has(slug)) return { ok: false, reason: 'exists', slug, existingSlug: slug };

  // 2. Plural of something that exists ("Tomatoes" when tomato exists).
  const sing = singularize(slug);
  if (sing !== slug && have.has(sing)) return { ok: false, reason: 'plural', slug, existingSlug: sing };

  // 2b. ...and the reverse: a SINGULAR of an existing plural ("Chive" when chives exists). Without
  // this, every crop whose canonical slug is already plural is unguarded from the singular form.
  if (have.has(`${slug}s`)) return { ok: false, reason: 'plural', slug, existingSlug: `${slug}s` };

  // 3. Known alias of a COUPLED slug. Checked on both the raw and singularized form so
  //    "chilis" -> chili -> pepper resolves.
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

// ── V4-SOURCEREG-001 / V5-SOURCEKIND-001 — the provenance registry ──────────────────────────
// public.source is WHO/WHERE a plant or packet came from; public.source_kind is the controlled
// vocabulary source.kind is typed against. Both mint from the app, on the crop-types contract.

// The fold BOTH partial-unique indexes on those two tables use, mirrored expression-for-expression:
//   public.source.match_key       GENERATED ALWAYS AS regexp_replace(lower(name),'[^a-z0-9]','','g')
//                                 with uq_source_match_key_live UNIQUE on it WHERE deleted_at IS NULL
//   uq_source_kind_display_live   UNIQUE on that same expression over display_name, live rows only
//
// DELIBERATELY NOT slugifySourceKind's fold. That one NFKD-normalises first, so "Épinard" folds to
// "epinard" there and to "pinard" here — Postgres lower() leaves the combining accent alone and the
// strip then removes the whole letter. Folding HARDER than the database steers a caller away from a
// name the index would have accepted; folding SOFTER lets the collision reach the INSERT as a 23505,
// which surfaces as a 500 the client cannot tell apart from a transport failure. Neither outcome is
// recoverable from the response, so this mirrors the index rather than approximating it.
export function foldSourceKey(s) {
  if (typeof s !== 'string') return '';
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// '' -> null for an optional column. Every optional text input in the app submits an empty string
// rather than omitting its key, and Postgres would store that happily — leaving two spellings of
// "not recorded" for every reader to handle and a blank locality chip rendering for one of them.
export function blankToNull(v) {
  if (typeof v !== 'string') return v ?? null;
  const t = v.trim();
  return t === '' ? null : t;
}

// display_name -> slug. Server-derived, never caller-supplied: source_kind.slug is a PRIMARY KEY
// and the FK target of source.kind. Same derivation as slugifyCropType and deliberately a SEPARATE
// function rather than an alias — these are two independent primary keys with two independent shape
// CHECKs, and a tweak made for crop types must not silently re-derive what source rows point at.
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
// The two collision sets are different sets, and that asymmetry is the point:
//   `existingSlugs` is EVERY slug INCLUDING soft-deleted ones — slug is the PK, so a resurrect
//   would violate it rather than politely conflict.
//   `liveKinds` is the LIVE rows only, as { slug, display_name } — uq_source_kind_display_live is
//   a PARTIAL index, so a retired label blocks nothing and steering on one would refuse a create
//   the database would have accepted.
export function resolveSourceKindName(displayName, existingSlugs = [], liveKinds = []) {
  const slug = slugifySourceKind(displayName);
  // chk_source_kind_slug_shape floors the slug at 2 characters, so a name that derives a shorter
  // one ("A!") is invalid here rather than a 23514 raised by the INSERT.
  if (slug.length < 2) return { ok: false, reason: 'invalid', slug, existingSlug: null };

  const have = new Set(existingSlugs);
  if (have.has(slug)) return { ok: false, reason: 'exists', slug, existingSlug: slug };

  const sing = singularize(slug);
  if (sing !== slug && have.has(sing)) return { ok: false, reason: 'plural', slug, existingSlug: sing };
  // ...and the reverse: a SINGULAR of an existing plural ("Farm stand" beside "Farm stands").
  if (have.has(`${slug}s`)) return { ok: false, reason: 'plural', slug, existingSlug: `${slug}s` };

  // THE LOAD-BEARING CHECK. A label that folds onto a live row without colliding on slug —
  // "Seedcompany" beside the seeded "Seed company", slug `seedcompany` vs `seed_company` — passes
  // every slug test above and then raises 23505 on uq_source_kind_display_live. That is a 500 where
  // the user should have been handed the row they meant.
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
  // Refused rather than ignored. A caller that supplies a slug has a model of this table in which
  // it names its own primary key, and silently overwriting that guess would leave it believing the
  // key it chose is the one every source row now points at.
  if (body.slug != null) return 'slug is derived from display_name and cannot be supplied';
  return null;
}

export function validateSourceBody(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  const n = body.name.trim();
  // Mirrors chk_source_name_shape (trimmed, 2..200 chars, contains an alphanumeric).
  if (n.length < 2 || n.length > 200) return 'name must be 2-200 characters';
  if (!/[A-Za-z0-9]/.test(n)) return 'name must contain at least one letter or number';
  // chk_source_website_url is `website_url IS NULL OR ~ '^https?://'`. A BLANK string is treated as
  // absent rather than as a violation — the same call validateBody already makes for source_url
  // above. A create that 400s because an untouched optional field submitted '' is indistinguishable
  // to the user from one that 400s because what they typed was wrong.
  if (body.website_url != null && typeof body.website_url !== 'string') {
    return 'website_url must be a string or null';
  }
  const url = blankToNull(body.website_url);
  if (url != null && !/^https?:\/\//.test(url)) {
    return 'website_url must start with http:// or https://';
  }
  // kind's membership in the live vocabulary is a DB question, checked by the route; this is the
  // type check only.
  if (body.kind != null && typeof body.kind !== 'string') {
    return 'kind must be a source kind slug or null';
  }
  for (const k of ['locality', 'address', 'notes']) {
    if (body[k] != null && typeof body[k] !== 'string') return `${k} must be a string or null`;
  }
  return null;
}
