// The shelf-life engine (V4 engine section), imported by every jar writer.
//
// Its own module because the table and the date it yields were private to index.js, which the kitchen
// routes cannot import (index.js imports THEM) and which carries neon/clerk/aws at module scope. A second
// jar writer (Put it up, in kitchenRoutes.js) must resolve a jar's date from the SAME table. Same shape and
// reason as ./useBy.js and ./provenance.js: PURE, no imports, nothing read from a clock or a database.
// shelfLife.test.js pins every cell of the matrix.

// Methods whose SHELF_LIFE_MONTHS figures come from the HOUSE, not from published guidance. A DATA fact,
// not a comment, because the UI has to act on it: FOODSAFETY-RULING-V101 §8.2 rules that a house-sourced
// shelf life is either DISTINGUISHABLE ON THE SURFACE (a provenance line the user can see) or it takes
// `default: null`. The number reaches every viewer in the household as a use-by date and a warn-coloured
// chip. src/pages/PutUp.jsx keeps its own copy of this list (separate deploy artifacts cannot import each
// other) and renders the label off it; src/__tests__/putUpMethodParity.test.js binds the two and asserts
// every member is labelled. A method added here without being added there is the failure that ruling exists
// to prevent.
//
// Exported as a contract about the table below. Its one reader here is resolveShelfLife, which names a candy
// cell's basis 'house'; nothing in this Lambda branches on it to WRITE anything. What this list CANNOT prove
// is its own completeness: provenance is not in the data, so a figure invented at a keyboard and left off
// the list is indistinguishable from a cited one. The only defence is the citation discipline in the
// table's header.
export const HOUSE_SOURCED_SHELF_LIFE = ['candy'];

// Shelf-life defaults: MONTHS from the put-up date, keyed by method x storage-kind.
// SOURCE (these drive "use soon" on stored FOOD and must NOT be one-person hand-invented): National Center
// for Home Food Preservation (NCHFP, nchfp.uga.edu) & USDA Complete Guide to Home Canning (Agriculture
// Information Bulletin No. 539); freezer figures per USDA "Freezing and Food Safety" (0°F / -18°C storage).
// Published ranges are collapsed to a single conservative default; deep_freezer (0°F) gets the upper end,
// fridge_freezer (3–6 mo, not held at 0°F) the lower. Values are DEFAULTS, user-overridable per row. A null
// result => no default expiry (row excluded from "use soon" until a use_by_target is set).
//
// ONE EXCEPTION: `candy` has NO published source, because none exists (a search of NCHFP, UGA, Penn State,
// OSU, UMN, USU, MSU and NC State found no home-preservation guidance on candied-fruit endpoints, storage or
// shelf life; project-state/_build-inflight-20260904/foodsafety-research.md §6.3, §9.1). Its figures come
// from the house guide and are a HOUSE PROCEDURE'S STORAGE NOTE, never Extension or USDA guidance, and must
// not be described as either. Every OTHER row holds to the rule above, and the next uncited figure inherits
// a CONDITION, not a precedent: FOODSAFETY-RULING-V101 §8.2 (house-sourced is either distinguishable on the
// surface or takes `default: null`). HOUSE_SOURCED_SHELF_LIFE carries that condition into the UI, and the
// parity test stops a future entry from arriving without one.
//
// Engine rules (V4 engine section (a), (b)):
//   FREEZER LEGS ARE EXPLICIT. Every method with a figure names deep_freezer and fridge_freezer, at the
//     number that cell would fall through to, so the rule below can stop the fall-through without touching
//     a freezer.
//   NO FIGURE => NO DATE, on the fridge. A recorded storage kind with no figure for its method gets no date
//     instead of borrowing `default`, a figure meant for somewhere else (fridge pesto read 10 months).
//     `default` answers only an UNRECORDED kind (NO_FIGURE_NO_DATE_KINDS below). A rule change never
//     rewrites a stored date: these apply at create only.
// shelfLife.test.js pins every cell; shelf-life-default-floor.test.js pins the explicit legs themselves.
const SHELF_LIFE_MONTHS = {
  roast_freeze:   { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  whole_freeze:   { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  blanch_freeze:  { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  // Dried foods: THE ONE ROW WITH A PUBLISHED FRUIT/VEGETABLE SPLIT THE METHOD CANNOT SEE. NCHFP, verbatim
  // (foodsafety-research.md §6.2): "Recommended storage times for dried foods range from 4 months to 1
  // year... Most dried fruits can be stored for 1 year at 60F, 6 months at 80F. Vegetables have about half
  // the shelf-life of fruits." That is a 2x2 (fruit 12/6, veg 6/3, by storage temperature) plus a printed
  // 4-to-12 envelope. Three declared decisions:
  //   TEMPERATURE. `pantry` takes the WARM anchor (80F), `cold_storage` the COOL one (60F). NCHFP defines
  //     neither word; this mapping is THE ONLY INFERENCE HERE. A ~70F pantry interpolated between the
  //     anchors gives veg 4.5 (linear) or 4.24 (log-linear), and the real response is Arrhenius-shaped,
  //     which bends lower still, so 4 is the GENEROUS read of the warm leg. Nothing is extrapolated below
  //     60F: no anchor exists there. (A root cellar is also the most HUMID room, the dried-food enemy NCHFP
  //     names, so cold_storage takes 6 exactly and is never rounded up.)
  //   FRUIT vs VEGETABLE. Takes the VEGETABLE leg; the method spans both, and splitting it is
  //     V5-PUTUPOUTPUTSHELF-001. The chosen error is UNDERSTATING a dried fruit, because the errors are not
  //     symmetric: overstating points at NCHFP's named failure ("Moldy foods should be discarded"),
  //     understating at an early chip on a row the cook can override. cure_store already set this
  //     precedent (a published 3-9 crop spread shipped as 3/4, the low end).
  //   PANTRY IS 4, NOT 3. "About half" of 6 is 3, but 3 falls below NCHFP's printed envelope floor of 4
  //     months; 4 is a number the source prints.
  //   DEFAULT = the pantry (shorter) leg: an unrecorded storage kind must not be read as "somebody put this
  //     somewhere cool" (shelf-life-default-floor.test.js binds fridge legs only; this restates its rule).
  dehydrate:      { pantry: 4, cold_storage: 6, deep_freezer: 4, fridge_freezer: 4, default: 4 },   // fruit 12 @60F / 6 @80F, veg half that (fruit/veg-varying; vegetable leg)
  // powder INHERITS dehydrate EXACTLY (no new source, one existing row reused, the ferment_mash pattern).
  // The former 18-month figure cited NCHFP wrongly: NCHFP's dried-food ceiling is ONE YEAR and half that for
  // vegetables, and no 18- or 24-month figure exists anywhere in the evidence base. Grinding also runs the
  // wrong way mechanically: a powder has far more surface area, is more hygroscopic and CAKES as it
  // reabsorbs moisture, the failure NCHFP names ("Foods that are packaged seemingly 'bone dry' can spoil if
  // moisture is reabsorbed during storage"). Equal-to-dehydrate is already the generous reading. Not
  // house-sourced, so HOUSE_SOURCED_SHELF_LIFE stays ['candy'].
  powder:         { pantry: 4, cold_storage: 6, deep_freezer: 4, fridge_freezer: 4, default: 4 },   // ground dried food = dehydrate, same source, same figures
  passata:        { pantry: 12, cold_storage: 18, deep_freezer: 12, fridge_freezer: 12, default: 12 },   // canned tomato sauce, high-acid
  can_water_bath: { pantry: 12, cold_storage: 18, deep_freezer: 12, fridge_freezer: 12, default: 12 },   // high-acid: 12–18 mo best quality
  can_pressure:   { pantry: 12, cold_storage: 12, deep_freezer: 12, fridge_freezer: 12, default: 12 },   // low-acid pressure-canned: ~12 mo
  jam_preserve:   { pantry: 12, cold_storage: 18, deep_freezer: 12, fridge_freezer: 12, default: 12 },
  ferment:        { fridge: 6, fridge_freezer: 6, cold_storage: 8, deep_freezer: 6, default: 6 }, // fridge ferment 4–8 mo
  // cure_store DEFAULT is 3, its own already-cited pantry figure and the shorter declared leg: the
  // COLD_STORAGE figure (4) would read a cure-and-store logged with no storage kind as "somebody put this
  // somewhere cool". No new source or number. shelf-life-default-floor.test.js is a floor over the shortest
  // declared route, so it covers rows that declare no fridge leg.
  cure_store:     { cold_storage: 4, pantry: 3, deep_freezer: 3, fridge_freezer: 3, default: 3 },      // squash 3–6, garlic 6–8, potatoes 4–9 (crop-varying; default = the shorter declared leg)
  cold_store:     { cold_storage: 6, fridge: 4, deep_freezer: 4, fridge_freezer: 4, default: 4 },
  // A CITED ENTRY HERE IS A HARD PRECONDITION FOR A NEW METHOD: shelfLifeMonths() returns null for a method
  // absent from this table, which yields no use_by_target, and use-soon then never surfaces the row. Every
  // figure below is DERIVED from a source already cited at the head of this table, never freshly invented;
  // the derivation is named per line. `smoke` is absent for exactly this reason: no defensible published
  // figure could be sourced.
  //
  // quick_pickle spans two real cases. Processed in a water-bath it IS shelf-stable, so the pantry and
  // cold-storage figures are the high-acid canning ones; unprocessed it is a fridge item, so `fridge` takes
  // NCHFP's refrigerator-pickle figure. The DEFAULT is the fridge number, because an unrecorded storage
  // kind must not be read as "somebody processed this".
  quick_pickle:   { pantry: 12, cold_storage: 12, fridge: 2, deep_freezer: 12, fridge_freezer: 4, default: 2 },
  // pesto is a frozen product, so it inherits the freeze family verbatim (USDA "Freezing and Food Safety",
  // 0degF): frozen pesto keeps exactly as long as anything else frozen, so these numbers are whole_freeze's,
  // not a separate judgement.
  pesto:          { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  // hot_sauce is an acidified product (fermented or vinegar-based), so the shelf-stable kinds take the
  // high-acid canning figures (as passata and can_water_bath do) and the fridge kind takes the fermented
  // figure from `ferment`. No new source, two existing rows recombined.
  //
  // DEFAULT is 6, the fridge figure, per the quick_pickle rule above (an unrecorded storage kind must not
  // be read as "somebody processed this"); ferment and ferment_mash already default to their fridge figure.
  // The two explicit shelf-stable legs are DELIBERATE: a vinegar hot sauce made to a tested recipe and
  // water-bath processed is genuinely shelf-stable, and the user who picked `pantry` made that
  // determination, which the app records rather than second-guesses. It must not make that determination
  // FOR them out of a blank field.
  //
  // This method spans two products the corpus treats differently. A search of NCHFP, Penn State, UMN, USU,
  // OSU, UGA and NC State found no tested home recipe for a fermented pepper-mash hot sauce and no home
  // path to making one shelf-stable, and BC CDC's default for an unverified ferment is refrigerated. The
  // shelf-stable legs are defensible for the vinegar-and-processed case and not for the fermented one, and
  // `method` cannot tell them apart. Splitting that is a vocabulary change, not a constant change
  // (project-state/_build-inflight-20260904/FOODSAFETY-RULING-V100.md).
  hot_sauce:      { pantry: 12, cold_storage: 18, fridge: 6, deep_freezer: 6, fridge_freezer: 6, default: 6 },
  // ferment_mash inherits `ferment` EXACTLY: a mash under brine is preserved by the same acidity as a
  // finished ferment and lives in the same places, so shortening it would be an invented number dressed as
  // caution. It is a distinct value because it is UNFINISHED, which the label carries; that is a fact about
  // the food, not about how long it keeps.
  ferment_mash:   { fridge: 6, fridge_freezer: 6, cold_storage: 8, deep_freezer: 6, default: 6 },
  // candy: THE ONE HOUSE-SOURCED ROW IN THIS TABLE (see the header's exception). Nothing below is published
  // guidance and none of it may be presented as such; every figure is from the house guide,
  // unsweet-watermelon-guide-V100-20260811.html (Part 5 and Part 6), and ships only because
  // FOODSAFETY-RULING-V101 §8.2's condition is met: HOUSE_SOURCED_SHELF_LIFE carries `candy` into the UI,
  // which labels the estimate on screen and asks the cook for the real date.
  //   deep_freezer 6   the one figure the guide states directly: Part 5 "Candied rind, uncoated ... ~6
  //                    months", Part 6 "undusted 6 months frozen".
  //   fridge_freezer 4 NOT stated by the guide. DERIVED, and marked as derived: this table's convention
  //                    gives deep_freezer the upper end and fridge_freezer the lower (not held at 0°F), and
  //                    the guide names self-defrost cycling as the specific enemy of a candied product.
  //   default 1        the room-temperature case, and THE TABLE'S FLOOR rather than an answer. The guide
  //                    says 2-3 weeks; the unit is whole months and addMonths() takes an integer, so 1 is
  //                    the shortest expressible non-zero and OVERRUNS the house figure by about a week. 0
  //                    would read "past use by" on day one, teaching the user the warn state means nothing;
  //                    null would make the row invisible to use-soon forever, the failure this value exists
  //                    to prevent; anything above 1 would be invention. Nobody may read this as a sourced
  //                    30-day claim.
  //   fridge, pantry, cold_storage, other 1  each RESTATES THE FLOOR, not a per-kind judgement. They are
  //                    listed because a recorded storage kind never borrows `default` (see
  //                    NO_FIGURE_NO_DATE_KINDS below), and candy must keep its floor there rather than lose
  //                    its date. Still house.
  candy:          { deep_freezer: 6, fridge_freezer: 4, fridge: 1, pantry: 1, cold_storage: 1, other: 1, default: 1 },
  // D6: acquisition age is unknown, so there is no honest shelf-life anchor. NULL => no default expiry =>
  // excluded from "use soon" until the user sets one.
  purchased_preserved: { default: null },
  other:          { default: null },
};

// V4 engine rule (a): the RECORDED storage kinds that never borrow `default` when the method names no
// figure for them: the fridge, the shelf (pantry), the cellar (cold_storage) and the counter (other). Every
// explicit pantry / cold_storage leg stays as it was, and each cell that only ever had a number by falling
// through to `default` becomes no date: the freeze family on a shelf or in a cellar (frozen food off the
// freezer is thawed), cold_store on a shelf, pesto on a shelf or in a cellar, ferment and ferment_mash on a
// pantry shelf, and every method at the counter except candy, whose `other: 1` leg is explicit. `default`
// answers only an UNRECORDED kind. The freezer kinds never need to be here: every freezer cell is an
// explicit leg.
const NO_FIGURE_NO_DATE_KINDS = new Set(['fridge', 'pantry', 'cold_storage', 'other']);

// The storage kinds where nothing grows (−18 °C). V4's engine rule (d): a Raw or In-oil jar keeps its freezer
// leg there — a thaw is a Move, and a Move nulls the date — and gets no date anywhere else.
const FREEZER_KINDS = new Set(['deep_freezer', 'fridge_freezer']);

// V4's estimated-date words on preservation_log.preserved_at_precision. 'unknown' is its own case
// (the Walk's Not sure: the stored date is only the day it was logged).
const ESTIMATED_PRECISIONS = new Set(['week', 'month', 'season', 'year', 'after']);

// Stored produce whose "use by" would start from an estimate's earliest day: an early start shows sound
// onions as past their use-by (V4's one discard-by rule), so an estimated date gets no table figure on these two.
const NO_DATE_WHEN_ESTIMATED = new Set(['cure_store', 'cold_store']);

// Dried-food texture words that mean "not dry enough for the dried figure" (V4's engine rule (e)).
const UNDRIED_TEXTURES = new Set(['bends', 'still_soft']);

export function shelfLifeMonths(method, kind) {
  const m = SHELF_LIFE_MONTHS[method];
  if (!m) return null;
  if (kind != null && kind in m) return m[kind] ?? null;
  if (kind != null && NO_FIGURE_NO_DATE_KINDS.has(kind)) return null;
  return m.default ?? null;
}

// One cell of the engine with the word for where its date comes from: 'table' (a general figure from the
// cited table above), 'house' (a house-sourced figure, HOUSE_SOURCED_SHELF_LIFE) or 'none' (no date).
// Deciding it here, beside the months, keeps a second jar writer from deciding it twice.
export function resolveShelfLife(method, kind) {
  const months = shelfLifeMonths(method, kind);
  if (months == null) return { months: null, basis: 'none' };
  return { months, basis: HOUSE_SOURCED_SHELF_LIFE.includes(method) ? 'house' : 'table' };
}

// One JAR's engine answer, with the facts the 1b columns add (V4's engine rules (d), (e)) and the put-up
// date's precision. Every jar writer (Put it up, POST /api/preservation, the PATCH correction rule, Move)
// resolves a non-typed date here and nowhere else; the cell table above stays the single source of the
// months. The order of the refusals is irrelevant: each yields no date, and a no-date answer always carries
// basis 'none'.
//   precision 'unknown'                        -> none (the stored date is only the day it was logged)
//   cure_store / cold_store with an estimate   -> none (an early start makes sound onions look past)
//   Raw or In oil anywhere but a freezer       -> none (an unrecorded place is not assumed to be a freezer)
//   dried and marked bends / still_soft        -> none ("no general figure for a bendy dried food")
//   otherwise                                  -> resolveShelfLife(method, kind)
export function resolveJarShelfLife({ method, kind = null, isRaw = null, inOil = null, texture = null, precision = null }) {
  const none = { months: null, basis: 'none' };
  if (precision === 'unknown') return none;
  if (NO_DATE_WHEN_ESTIMATED.has(method) && ESTIMATED_PRECISIONS.has(precision)) return none;
  if ((isRaw === true || inOil === true) && !FREEZER_KINDS.has(kind)) return none;
  if (texture != null && UNDRIED_TEXTURES.has(texture)) return none;
  return resolveShelfLife(method, kind);
}

// The jar's stored pair (use_by_target, use_by_basis) when nobody typed a date: the engine's months forward
// from the stored anchor (preserved_at; for an estimate, its earliest day), or no date. Never 'typed'; the
// writers decide typed from the request.
export function resolveJarUseBy(facts, anchorDate) {
  const { months, basis } = resolveJarShelfLife(facts);
  if (months == null || !anchorDate) return { use_by_target: null, use_by_basis: 'none' };
  return { use_by_target: addMonths(anchorDate, months), use_by_basis: basis };
}

// date (YYYY-MM-DD string, ISO string, or Date) + n months → YYYY-MM-DD (clamps day to the
// target month's last day).
export function addMonths(dateInput, months) {
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

// The RECIPE basis (V4 §3.1, §3.2, §3.4): the one discard-by rule's second rung, typed > RECIPE > table >
// none. A recipe's keeps line (n, day / week / month, storage kind) gives a jar a date ONLY when the jar's
// storage kind is the recipe's keeps storage kind: "Fridge 7 days" says nothing about a jar in the freezer,
// which falls through to the table. The basis is 'recipe', worded "from the recipe: <recipe name>" with no
// duration (the recipe is mutable; the jar's date is not). A jar with no known put-up date (precision
// 'unknown') gets no recipe date either. Nothing here reads the recipe's notes.
export const RECIPE_KEEPS_UNITS = ['day', 'week', 'month'];

// date (YYYY-MM-DD string, ISO string, or Date) + n days → YYYY-MM-DD, in the civil calendar (UTC arithmetic
// on the date part only, the addMonths convention).
export function addDays(dateInput, days) {
  const src = dateInput instanceof Date ? dateInput.toISOString() : String(dateInput);
  const [y, mo, d] = src.slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return t.toISOString().slice(0, 10);
}

// recipe: { keeps_n, keeps_unit, keeps_storage_kind } (a recipe row, or null). Returns the stored pair, or
// null for "the recipe does not decide this jar" (the caller falls through to the engine).
export function recipeUseBy(recipe, kind, anchorDay, { precision = null } = {}) {
  if (!recipe || recipe.keeps_n == null || recipe.keeps_unit == null || recipe.keeps_storage_kind == null) return null;
  if (kind == null || kind !== recipe.keeps_storage_kind) return null;
  if (!anchorDay || precision === 'unknown') return null;
  const n = Number(recipe.keeps_n);
  if (!Number.isInteger(n) || n < 1 || !RECIPE_KEEPS_UNITS.includes(recipe.keeps_unit)) return null;
  const date = recipe.keeps_unit === 'month' ? addMonths(anchorDay, n)
    : addDays(anchorDay, recipe.keeps_unit === 'week' ? n * 7 : n);
  return { use_by_target: date, use_by_basis: 'recipe' };
}
