// The shelf-life engine — Put-Up release 1a. The V4 design's engine section: "release 1a extracts it
// into lambda/preservation/shelfLife.js, imported by every jar writer".
//
// WHY ITS OWN MODULE. The table and the date it yields were module-private inside index.js, which the
// kitchen routes cannot import (index.js imports THEM, so the reverse import is circular) and which
// carries neon/clerk/aws at module scope. A second jar writer — release 1b's Put it up, in
// kitchenRoutes.js — must resolve a jar's date from the SAME table, so the table moves here and every
// writer imports it. Same shape and the same reason as ./useBy.js (the use-soon window) and
// ./provenance.js: PURE, no imports, nothing read from a clock or a database. shelfLife.test.js pins
// every cell of the matrix this module computes.
//
// Moved verbatim from index.js; the only edits in the move are `export` on shelfLifeMonths and
// addMonths, which were module-private.

// ── Methods whose SHELF_LIFE_MONTHS figures come from the HOUSE, not from published guidance. ──
// A DATA fact, not a comment, because the UI has to be able to act on it: FOODSAFETY-RULING-V101 §8.2
// rules that a house-sourced shelf life is either DISTINGUISHABLE ON THE SURFACE — a provenance line
// the user can see — or it takes `default: null`. A migration header is read by nobody using the app,
// and the number reaches every viewer in the household as a use-by date and a warn-coloured chip.
// src/pages/PutUp.jsx keeps its own copy of this list (the two are separate deploy artifacts and
// cannot import each other) and renders the label off it; src/__tests__/putUpMethodParity.test.js
// binds the two and asserts every member is labelled. Adding a method here without adding it there
// is the failure that ruling exists to prevent.
//
// EXPORTED with no importer today, deliberately: it is a contract about the table below rather than
// this file's private state, and nothing in this Lambda branches on it — the label is a client
// concern. What this list CANNOT prove is its own completeness. Provenance is not in the data, so a
// figure invented at a keyboard and left off this list is indistinguishable here from a cited one.
// The only defence against that is the citation discipline in the table's header.
export const HOUSE_SOURCED_SHELF_LIFE = ['candy'];

// ── Shelf-life defaults (L6): MONTHS from the put-up date, keyed by method × storage-kind. ──
// SOURCE (cited per boss-strategic safety note — these drive "use soon" on stored FOOD and must
// NOT be one-person hand-invented): National Center for Home Food Preservation (NCHFP,
// nchfp.uga.edu) & USDA Complete Guide to Home Canning (Agriculture Information Bulletin No. 539);
// freezer figures per USDA "Freezing and Food Safety" (0°F / -18°C storage). Published ranges are
// collapsed to a single conservative default; deep_freezer (0°F) gets the upper end, fridge_freezer
// (3–6 mo, not held at 0°F) the lower. Values are DEFAULTS: user-overridable per row (L6). A null
// result => no default expiry (row excluded from "use soon" until a use_by_target is set).
//
// ONE EXCEPTION, AND THE SENTENCE ABOVE IS AMENDED RATHER THAN LEFT TO READ FALSE (V5-PUTUPCANDY-001,
// 2026-09-04). `candy` is the first and only entry here with NO published source, because none
// exists: a search of NCHFP, UGA, Penn State, OSU, UMN, USU, MSU and NC State found no home-
// preservation guidance covering candied-fruit endpoints, storage or shelf life — a documented
// negative result, not an unfinished search (project-state/_build-inflight-20260904/
// foodsafety-research.md §6.3, §9.1: "there is nothing to cite"). Its figures come from Dave's own
// house guide and are a HOUSE PROCEDURE'S STORAGE NOTE, never Extension or USDA guidance; they must
// not be described as either, anywhere. Every OTHER row here still holds to the original rule, and
// the next uncited figure does not inherit a precedent from this one — it inherits a CONDITION.
// FOODSAFETY-RULING-V101 §8.2 attaches it: a house-sourced shelf life is either distinguishable on
// the surface, as a provenance line the user can see, or it takes `default: null`. The list above,
// HOUSE_SOURCED_SHELF_LIFE, is how that condition is carried into the UI, and the parity test is
// what stops a future entry from arriving without one.
const SHELF_LIFE_MONTHS = {
  roast_freeze:   { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  whole_freeze:   { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  blanch_freeze:  { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  // ── Dried foods. THE ONE ROW WITH A PUBLISHED FRUIT/VEGETABLE SPLIT THE METHOD CANNOT SEE. ─────
  // NCHFP, verbatim (foodsafety-research.md §6.2): "Recommended storage times for dried foods range
  // from 4 months to 1 year... Most dried fruits can be stored for 1 year at 60F, 6 months at 80F.
  // Vegetables have about half the shelf-life of fruits." That is a 2x2 — fruit 12/6, veg 6/3, by
  // storage temperature — plus a printed 4-to-12 envelope. Three decisions, all declared:
  //   TEMPERATURE. `pantry` takes the WARM anchor (80F), `cold_storage` the COOL one (60F). NCHFP
  //     defines neither word; this mapping is THE ONLY INFERENCE HERE, and the numbers on both sides
  //     of it are printed. It survives its own stress test: a ~70F pantry interpolated between the
  //     anchors gives veg 4.5 (linear) or 4.24 (log-linear), and the real response is Arrhenius-shaped,
  //     which bends lower still. Three routes, one answer — 4 is the GENEROUS read of the warm leg.
  //     Nothing is extrapolated below 60F: no anchor exists there, and inventing one is what this
  //     table forbids. (A root cellar is also the most HUMID room in the house, which is the dried-food
  //     enemy NCHFP names; that is why cold_storage takes 6 exactly and is never rounded up.)
  //   FRUIT vs VEGETABLE. Takes the VEGETABLE leg. The method spans both; splitting it is
  //     V5-PUTUPOUTPUTSHELF-001, not this constant. The chosen error is UNDERSTATING A DRIED FRUIT,
  //     chosen because the errors are not symmetric: overstating points at NCHFP's named dried-food
  //     failure ("Moldy foods should be discarded" — and the mould floor a_w ~0.65 sits far below any
  //     pathogen threshold, research §6.1), understating points at an early chip on a row the cook can
  //     override. cure_store, one line down, already set this precedent — a published 3-9 crop spread
  //     shipped as 3/4, the low end.
  //   PANTRY IS 4, NOT 3. "About half" of 6 is 3, but 3 falls below NCHFP's own printed envelope floor
  //     of 4 months. 4 is a number the source prints; 3 would be this file's arithmetic overruling it.
  //   DEFAULT = the pantry (shorter) leg. No fridge figure here, so shelf-life-default-floor.test.js
  //     does not bind — but its rule does, restated: an unrecorded storage kind must not be read as
  //     "somebody put this somewhere cool". It is also the leg that will actually fire; prod has three
  //     deep_freezer locations and zero pantry/cold_storage rows (verified 2026-09-06).
  dehydrate:      { pantry: 4, cold_storage: 6, default: 4 },   // fruit 12 @60F / 6 @80F, veg half that (fruit/veg-varying; vegetable leg)
  // powder INHERITS dehydrate EXACTLY — no new source, one existing row reused (the ferment_mash
  // pattern). It previously read { 18, 18, 18 } with the comment "powdered: 18-24 mo (NCHFP dehydrate)".
  // THAT CITATION IS FALSE AND IS BEING REMOVED, NOT SOFTENED: NCHFP's dried-food ceiling in the text
  // above is ONE YEAR and half that for vegetables, so 18 was 1.5x its own cited source's maximum and
  // 4.5x the vegetable figure; a 2026-09-06 grep of the whole evidence base found no 18- and no
  // 24-month figure anywhere in it; and git log -S dates the line to c2371b4, 2026-07-20, seven weeks
  // BEFORE that evidence base existed. Grinding also runs the wrong way mechanically — a powder has far
  // more surface area than the slices it came from, is more hygroscopic, and CAKES as it reabsorbs
  // moisture, which is the failure NCHFP names ("Foods that are packaged seemingly 'bone dry' can spoil
  // if moisture is reabsorbed during storage"). Equal-to-dehydrate is already the generous reading;
  // longer is unsupportable in citation AND in mechanism. Not house-sourced — every figure is derived
  // from the printed NCHFP text above — so HOUSE_SOURCED_SHELF_LIFE stays ['candy'].
  powder:         { pantry: 4, cold_storage: 6, default: 4 },   // ground dried food = dehydrate, same source, same figures
  passata:        { pantry: 12, cold_storage: 18, default: 12 },   // canned tomato sauce, high-acid
  can_water_bath: { pantry: 12, cold_storage: 18, default: 12 },   // high-acid: 12–18 mo best quality
  can_pressure:   { pantry: 12, cold_storage: 12, default: 12 },   // low-acid pressure-canned: ~12 mo
  jam_preserve:   { pantry: 12, cold_storage: 18, default: 12 },
  ferment:        { fridge: 6, fridge_freezer: 6, cold_storage: 8, default: 6 }, // fridge ferment 4–8 mo
  // DEFAULT CORRECTED 4 -> 3, 2026-09-08 (BUG-SHELFDEFAULTGUARDGAP-001). It was the COLD_STORAGE
  // figure — the LONGER of the two legs this row declares — so a cure-and-store logged with no
  // storage kind was read as "somebody put this somewhere cool", which is the pantry/cold_storage
  // form of the exact error hot_sauce was corrected for four days earlier. No new source and no new
  // number: 3 is this row's own already-cited pantry figure, and the legs are untouched. It shipped
  // this way because shelf-life-default-floor.test.js only checked rows that declare a FRIDGE leg,
  // and this row declares none; that gate is now a floor over the shortest declared route.
  cure_store:     { cold_storage: 4, pantry: 3, default: 3 },      // squash 3–6, garlic 6–8, potatoes 4–9 (crop-varying; default = the shorter declared leg)
  cold_store:     { cold_storage: 6, fridge: 4, default: 4 },
  // ── V4-PUTUPTAXONOMY-001 (BD-034). ───────────────────────────────────────────────────────────
  // A CITED ENTRY HERE IS A HARD PRECONDITION FOR A NEW METHOD, not a nicety. shelfLifeMonths()
  // returns null for a method absent from this table, which yields no use_by_target, and use-soon
  // then never surfaces the row: the 'Vinegar dill pickles' row is already the only one of five
  // live put-ups with use_by_target IS NULL, purely because it had to be logged as 'other'. Four
  // uncited methods would have taken that from one-in-five to five-in-nine.
  //
  // Every figure below is DERIVED from a source already cited at the head of this table, never
  // freshly invented — the derivation is named per line. `smoke` was dropped from this change for
  // exactly this reason: no defensible published figure could be sourced, and shipping it uncited
  // would have widened the blind spot this block exists to close.
  //
  // quick_pickle spans two real cases. Processed in a water-bath it IS shelf-stable, so the pantry
  // and cold-storage figures are the high-acid canning ones; unprocessed it is a fridge item, so
  // `fridge` takes NCHFP's refrigerator-pickle figure. The DEFAULT is the fridge number, because an
  // unrecorded storage kind must not be read as "somebody processed this".
  quick_pickle:   { pantry: 12, cold_storage: 12, fridge: 2, deep_freezer: 12, fridge_freezer: 4, default: 2 },
  // pesto is a frozen product — both live pesto rows sit in a deep freezer (prod, 2026-08-25) — so
  // it inherits the freeze family verbatim (USDA "Freezing and Food Safety", 0degF). This is also
  // the point the crucible made against pesto as a METHOD: frozen pesto keeps exactly as long as
  // anything else frozen, which is why these numbers are identical to whole_freeze's and not a
  // separate judgement.
  pesto:          { deep_freezer: 12, fridge_freezer: 4, default: 10 },
  // hot_sauce is an acidified product — fermented or vinegar-based — so the shelf-stable kinds take
  // the high-acid canning figures (as passata and can_water_bath do) and the fridge kind takes the
  // fermented figure from `ferment` below-line. No new source, two existing rows recombined.
  //
  // DEFAULT CORRECTED 12 -> 6, 2026-09-04. It was the PANTRY figure, which broke the rule stated
  // eleven lines above on quick_pickle — "the DEFAULT is the fridge number, because an unrecorded
  // storage kind must not be read as 'somebody processed this'" — and broke it in the more dangerous
  // direction than quick_pickle would have. Same reasoning, opposite outcome, adjacent lines; ferment
  // and ferment_mash below both already default to their fridge figure.
  //
  // The two explicit shelf-stable legs are DELIBERATELY unchanged. A vinegar hot sauce made to a
  // tested recipe and water-bath processed is genuinely shelf-stable, and the user who picked
  // `pantry` made that determination themselves — which the app records rather than second-guesses.
  // What it must not do is make that determination FOR them out of a blank field.
  //
  // Worth knowing when revisiting: this method spans two products the corpus treats differently. A
  // 2026-09-04 search of NCHFP, Penn State, UMN, USU, OSU, UGA and NC State found no tested home
  // recipe for a fermented pepper-mash hot sauce and no home path to making one shelf-stable, and BC
  // CDC's default for an unverified ferment is explicit: refrigerated. The shelf-stable legs are
  // defensible for the vinegar-and-processed case and not for the fermented one, and `method` cannot
  // tell them apart. Splitting that is a vocabulary change, not a constant change — see
  // project-state/_build-inflight-20260904/FOODSAFETY-RULING-V100.md and its adversarial review.
  hot_sauce:      { pantry: 12, cold_storage: 18, fridge: 6, default: 6 },
  // ferment_mash inherits `ferment` EXACTLY. A mash under brine is preserved by the same acidity as
  // a finished ferment and lives in the same places, so shortening it would be an invented number
  // dressed as caution. What makes it a distinct value is that it is UNFINISHED, which the label
  // carries; that is a fact about the food, not about how long it keeps.
  ferment_mash:   { fridge: 6, fridge_freezer: 6, cold_storage: 8, default: 6 },
  // ── V5-PUTUPCANDY-001. THE ONE HOUSE-SOURCED ROW IN THIS TABLE. ───────────────────────────────
  // Read the amended header above first. Nothing below is published guidance and none of it may be
  // presented as such; every figure is from Dave's own crucible-hardened house guide,
  // unsweet-watermelon-guide-V100-20260811.html (Part 5 and Part 6), and it ships only because
  // FOODSAFETY-RULING-V101 §8.2's condition is met — HOUSE_SOURCED_SHELF_LIFE carries `candy` into
  // the UI, which labels the estimate on screen and asks the cook for the real date.
  //   deep_freezer 6   — the one figure the guide states directly: Part 5 "Candied rind, uncoated
  //                      ... ~6 months", Part 6 "undusted 6 months frozen".
  //   fridge_freezer 4 — NOT stated by the guide. DERIVED, and marked as derived: this table's own
  //                      convention gives deep_freezer the upper end and fridge_freezer the lower
  //                      (it is not held at 0°F), and the guide names self-defrost cycling as the
  //                      specific enemy of a candied product.
  //   default 1        — the room-temperature case, and it is THE TABLE'S FLOOR rather than an
  //                      answer. The guide says 2-3 weeks; the unit here is whole months and
  //                      addMonths() takes an integer, so 1 is the shortest expressible non-zero and
  //                      it OVERRUNS the house figure by about a week. 0 would read "past use by" on
  //                      day one, teaching the user that the warn state means nothing; null would
  //                      make the row invisible to use-soon forever, which is the exact failure this
  //                      value exists to prevent; anything above 1 would be invention, since there is
  //                      no published figure to round toward. Nobody may later read this as a sourced
  //                      30-day claim.
  // fridge, pantry and cold_storage are deliberately UNLISTED — they fall through to the same floor
  // without implying a per-kind judgement that nothing supports.
  candy:          { deep_freezer: 6, fridge_freezer: 4, default: 1 },
  // D6: acquisition age is unknown, so there is no honest shelf-life anchor. NULL => no default
  // expiry => excluded from "use soon" until the user sets one. Same reasoning as the non-garden
  // suppression in index.js's create path.
  purchased_preserved: { default: null },
  other:          { default: null },
};

export function shelfLifeMonths(method, kind) {
  const m = SHELF_LIFE_MONTHS[method];
  if (!m) return null;
  const v = kind != null && kind in m ? m[kind] : m.default;
  return v ?? null;
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
