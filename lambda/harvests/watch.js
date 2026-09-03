// watch.js — V4-HARVSURFACE-001 slice 1. DB-free PURE candidate logic for the Today "Worth checking
// this week" watch list (harvest-two-section-design-V100-20260811.md §3). Imports NOTHING runtime
// (no neon/clerk/aws) so it unit-tests under the root vitest config, same split as ./aggregate.js.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS MODULE EXISTS: the categorical blind spot it fixes
//
// The shipped readiness surface (GET /api/events/harvest-ready + src/lib/harvestReadiness.js) can
// NEVER show a large class of Dave's garden, because it gates twice:
//   (a) SERVER — lambda/events/index.js joins `last_pick` INNER, so a planting with ZERO recorded
//       picks is structurally absent from the payload. That route's own header calls this
//       deliberate ("Evidence only ... nothing here is a prediction of first harvest"), and for an
//       OVERDUE band that is right. It is exactly wrong for a FIRST-harvest watch list.
//   (b) CLIENT — isReadyToPick() returns false unless harvest_habit ∈ {repeat, cut_and_come_again},
//       so `single` is rejected even when it does reach the client.
//
// Measured against live prod 2026-08-12 (read-only, garden_ro), household = Dave (Jen has zero live
// plantings, so every figure here is Dave's, not a household average):
//   * 30 live plantings carry harvest_habit='single'; 23 of them have ZERO recorded picks.
//   * Those 23 include actively FRUITING Charentais + Green Flesh melons, a Tender Sweet Orange
//     watermelon, Yukon Gold potato, and a cabbage — crops in the ground, setting fruit, invisible.
//   * The other 7 single-habit plantings DO have picks and so clear gate (a), only to be dropped by
//     gate (b). Neither gate alone explains the hole; both must go.
//   * Live plantings with harvest_habit IS NULL (51, of which 50 have zero picks) are NOT part of
//     this blind spot — every one is an ornamental (geranium, coleus, succulent, pothos, hosta...).
//     They are correctly excluded and must STAY excluded. Do not "fix" that number.
//
// So this module admits `single` habit and requires no prior harvest. It anchors on what the
// planting actually has: an observed signal, a sibling's pick, or its own sow/transplant date.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GRAMMAR CONTRACT (design §3.1, unanimous panel ruling — enforced by naming, not by copy)
//
// This module produces a WATCH LIST, never a verdict. Nothing here decides "ready"; it decides
// "worth walking over to look at". Field names say so on purpose (`check_from`, `days_watching`,
// `confidence`) so a client cannot render a prediction in an observation's grammar without first
// renaming a field. At 11.8% calibration with a 22-day median error, a row asserting "your window
// opened" is wrong most of the time and costs trust in the whole surface.

// ── Constants, each with its provenance stated ───────────────────────────────────────────────────

// Bumped whenever the anchoring math changes. FROZEN onto every dismissal row so a later model
// revision cannot silently re-interpret negative samples that an older model produced. Without
// this, the calibration set quietly mixes incompatible labels the first time a constant moves.
export const WATCH_MODEL_VERSION = 'watch-v1';

// MEASURED, not invented. The harvest-window crucible V100 measured calibration at 11.8% with a
// -22d median error: 30 of 34 picks happened BEFORE the model's predicted window opened. The model
// runs LATE by about three weeks, so a watch list anchored on nominal DTM would open its row about
// three weeks after Dave already picked the crop. The lead cancels that measured bias.
export const WATCH_LEAD_DAYS = 22;

// JUDGMENT BOUND, and labelled as one — this is the only constant here with no measurement behind
// it. It caps the lead at a quarter of the predicted interval so a short-interval crop cannot have
// its watch opened before the crop could plausibly be anywhere near picking (a 42-day fruit-set
// interval minus a flat 22 would start checking on day 20). Tighten it if watch rows read as noise.
export const WATCH_LEAD_MAX_FRACTION = 0.25;

// MEASURED from Dave's own plantings, live prod 2026-08-12: median (transplanted_at - sown_at) = 31
// days over the 39 plantings carrying both dates (range 0-64). Used ONLY for the basis-shift case
// below. The live route recomputes this per household and passes it in, so this value is the
// documented fallback when a household has too little data to compute its own.
export const NURSERY_OFFSET_DAYS_FALLBACK = 31;

// V4-FRUITINGTIER-001. MEASURED from Dave's own history, live prod 2026-08-14: the interval from the
// first status_change to `fruiting` to the first harvest event on the same planting is a median of
// 18 days over 39 plantings (p25 12, p75 23). By crop: tomato 18 (n=20), pepper 20 (n=13),
// tomatillo 21 (n=3) — the three dominant crops within 3 days of each other.
//
// WHY THIS CONSTANT UNBLOCKS A ROW THAT WAS BLOCKED. V4-FRUITINGTIER-001 sat planned with the note
// "blocked on an interval no column answers": crop_types.set_to_first_pick_days is a FRUIT-SET
// interval and prod populates it for melon (42) and watermelon (45) only, so the existing observed
// anchor below can never fire for a tomato. The interval was not missing from the world, only from
// the schema — Dave's event log had 39 samples of it the whole time. As with the nursery offset, the
// live route recomputes this per household and passes it in; this is the documented fallback.
//
// TIGHTER THAN THE TIER IT REPLACES. The add-date baseline the derived tier rests on has a measured
// IQR of 20 days (anchorDerive.js ADD_DATE_OFFSET_MEASURED: p25 +2, p75 +22) around a date the
// system invented. This has an IQR of 11 around a date Dave entered.
export const FRUITING_TO_PICK_DAYS_FALLBACK = 18;

// JUDGMENT BOUND, panel-decided (harvest-panel-decisions-20260812.md Q3). A "not yet" tap silences
// a planting for this many days, then the row RETURNS — dismissal is a snooze, not a queue exit.
// Both bounds were confirmed: season-long suppression yields exactly ONE negative-class label per
// planting per season (starving the calibration set the table exists to build); 10 days over the 47
// days to frost yields 2-3; 3 days yields duplicates-in-substance against observables that move on
// a multi-day scale. Deliberately UNIFORM, no crop-class clamp: the obvious clamp column,
// crop_types.loss_horizon_hours, measures POST-HARVEST shelf life, not on-plant velocity (verified:
// melon 168h / watermelon 240h vs basil 24h — it would clamp exactly the wrong crops and miss the
// fast-flip melons entirely). No schema column encodes observable velocity; the refit supplies the
// crop-level answer once the dismissal table has real taps.
//
// THE REFIT THAT REPLACES THIS VALUE IS dismissalRefit.js — do not hand-compute a percentile here.
// §4.4's plan as written is not sound (repeated dismissals on one planting are a correlated series,
// the estimator ignores right-censoring on the plantings that never fruit, and the n>=20-per-crop
// gate can essentially never fire); V4-DISMISSREFITSTATS-001 built those three corrections into that
// module as REFUSALS, so a fit that should not have been run returns a named reason instead of a
// number. When it does produce one, replace this constant WITH its provenance — n in PLANTINGS, the
// censoring fraction, the partition it was fitted on — the way maturityCalibration.js records its.
export const WATCH_SUPPRESS_DAYS = 10;

// V4-ANCHORBASE-001. OFF, and off is the decision, not a placeholder.
//
// A fourth anchor tier — `derived` — reads a backfilled anchor for plantings that have NO date of
// their own (public.plant_anchor_derivation, migrations/v4-anchorbase-001/). Measured by running
// this module over live prod rows on 2026-08-12 (scripts/measure-anchor-coverage.{sql,mjs}): of the
// 64 anchorless live plantings, sow events recover 0 and transplant events recover 0 (every
// planting with a transplant event ALREADY has transplanted_at — the app writes the column when the
// event is logged), nursery-proxy events recover 7, and the add-date baseline recovers the
// remaining 57. So 89% of anything this tier contributes is a baseline guess whose measured
// accuracy is 47.3% within a week (median +9d, p75 +22d, max +48d over Dave's own 112 dual-dated
// plantings).
//
// A surface that opens a watch row on that number is asserting a date Dave never entered, on the
// strength of a coin flip. Admitting the tier is Dave's call, and this constant is where he makes
// it: flipping it to true is the whole change.
//
// WHAT THE FLIP IS WORTH, measured, in combination with the sibling restriction below — because the
// two levers are not independent and pricing them separately is misleading:
//     A  as shipped                     75 candidates,  62 sibling-anchored,  16 no_anchor
//     B  sibling restricted only        40 candidates,   7 sibling-anchored,  25 no_anchor
//     C  derived tier only              80 candidates,  62 sibling-anchored,   7 no_anchor
//     D  both                           49 candidates,   7 sibling-anchored,   9 no_anchor
// Read C carefully: the derived tier ALONE makes the queue WORSE (75 -> 80). It can only ADD rows,
// never remove them, because queue entry takes the EARLIEST anchor. Its real value is visible only
// in B vs D — restricting the sibling anchor on its own pushes 9 extra plantings into `no_anchor`
// (16 -> 25), i.e. it HIDES them; the derived tier is what buys them back and then some (25 -> 9).
// The derivation is what makes the sibling restriction affordable, not a queue-thinning measure.
//
// STATUS 2026-08-13 (V4-ANCHORFLIP-001). The second half of that last sentence is NO LONGER TRUE:
// public.plant_anchor_derivation is applied and populated in staging (12 rows) and prod (66 rows),
// and watch-route.js now JOINs it, so `derived_anchor_*` arrives on every row. The flag is therefore
// the ONLY thing holding the tier off — which is exactly the state the expert consult
// (project-state/anchor-consult-20260812.md) required BEFORE the flip could be considered, because
// flipping it while the route did not join was a runtime no-op that would have manufactured
// confidence in an untested path.
//
// FLIPPED TRUE 2026-08-14 (V4-ANCHORFLIP-001 condition 9 — Dave's call, the last of the 9). All of
// conditions 1-8 shipped to prod in v4.14.0 and the anchor_kind CHECK migration is applied, so this
// flag was the only remaining gate. Measured live effect at the time of the call: +2 watch rows,
// 0 existing rows changed — the suppression rules below (conditions 3/4/5) are what shrank it from
// the consult's original 9 net-new rows to 2 by removing the noise class the horticulture seat
// identified. The tier can only ADD rows, never remove them (queue entry takes the EARLIEST
// anchor), so this is a strictly additive change to the watch queue.
export const DERIVED_ANCHOR_ENABLED = true;

// ── The derived tier's suppression rules (V4-ANCHORFLIP-001 conditions 3/4/5) ────────────────────
//
// Each of these narrows the derived tier and NONE of them touches any other anchor kind. They exist
// because the horticulture seat read all 9 net-new rows the flip would have opened and found 1
// decision-bearing, 3 marginal and 5 noise. These three rules remove the noise and the one class of
// error the seat called non-negotiable, so what the flip is worth can be re-measured honestly.

// Condition 5. `cut_and_come_again` is DROPPED from the derived tier — 5 of the 9 net-new rows were
// cut-and-come-again herbs and bolted greens. The habit is still watched (WATCHED_HABITS) and still
// admitted on every OTHER anchor: a cut-and-come-again crop with a real sow date keeps its calendar
// row. What it may not have is a row resting on a date the system invented, because for a crop
// harvested continuously from the moment it has leaves, "the catalogue says day 45" answers a
// question nobody asked — the plant is either big enough to cut or it is not, and looking at it is
// both cheap and conclusive. The derivation buys nothing it does not already know.
export const DERIVED_ANCHOR_HABITS = new Set(['single', 'repeat']);

// Condition 4. A planting whose OWN logged status already says `flowering` or `fruiting` does not
// get a derived row. The status is a signal Dave entered; the derivation is a guess about the same
// underlying question, and a guess must never speak over a record (the same marking-rule ordering
// TIER_RANK encodes). 3 of the 9 net-new rows were peppers the app already knew were fruiting.
//
// RECOMMENDATION, NOT BUILT (consult condition 4's open half): `status='fruiting'` SHOULD eventually
// open its own row, as an `observed`-class anchor rather than a derived one — a logged status change
// is strictly better evidence than any derivation, and today it is used only to SUPPRESS. That is a
// new tier with its own interval question ("how long from status=fruiting to first pick?", which no
// column currently answers) and it is deliberately out of scope here: adding it under this item
// would ship an unmeasured tier alongside a measured suppression. File it as its own ledger row.
export const DERIVED_STATUS_SUPPRESSED = new Set(['flowering', 'fruiting']);

// Condition 3 — the horticulture seat's ONE non-negotiable. A derived row that opens within ~10 days
// either side of first fall frost is wrong in a way that looking at the plant cannot fix: the window
// it points at does not exist, because the plant will be dead. Suppression is therefore applied at
// `check_from >= firstFallFrost - DERIVED_FROST_WINDOW_DAYS` — which contains the seat's symmetric
// ±10d window and everything past it, since a row opening 30 days AFTER frost is more wrong than one
// opening 5 days after, not less.
//
// BUG-WATCHFROSTSUPPRESS-001 — this consumer is now HARDINESS-SCOPED, which is what unblocked it.
//
// BUG-FROSTANCHORWRONG-001 classified it as wanting the measured date by contract (the comment above
// says "within ~10 days either side of first fall frost", and against measurement the margin fires
// ~31 days early ON TOP OF this window — two conservatisms stacked) and then deliberately did NOT
// move it, for a reason that was about the code: the arithmetic is a SUPPRESSION, and the band it
// suppresses is habit-scoped (single/repeat), not hardiness-scoped. Moving the constant alone would
// have un-suppressed derived rows for frost-TENDER crops as well as hardy ones, which is strictly
// worse than the conservatism it was fixing. Its prohibition on "finishing the job by editing the
// number" was right, and this is not that edit: the discrimination it said was missing is supplied
// below, and only then does the anchor move — for hardy crops ONLY.
//
// WHY crop_type_slug IS THE VECTOR, established rather than assumed. Three candidates were checked:
//   * The frostClass BAND — the semantically ideal answer ("unharmed or improved by frost") — is in
//     lambda/daily-plan/. Not importable: deploy-lambda.yml zips each function from its own directory
//     (`cd lambda/<fn> && zip -r`), so a cross-directory import resolves under vitest and then 502s
//     at module load in the deployed function. That is the documented house hazard at
//     lambda/plants/validate.js:5-8, and it applies identically to src/lib/sowEngine.js.
//   * A crop_types COLUMN would need no mirror at all. There is none: the live prod table carries no
//     hardiness/frost column of any kind (checked 2026-08-18), and frostClass's bands are code-side
//     slug lists, not data. So no join can answer this.
//   * `row.crop_type_slug` IS already on every row this module sees — watch-route.js's `live` CTE
//     selects cv.crop_type_slug and the final SELECT is `l.*`; projectWatchRow already re-emits it.
// So the set is mirrored here and pinned in lockstep, the same trade the frost date itself already
// makes below.
//
// FAIL-SAFE DIRECTION, deliberately. An unknown/absent slug falls through to the MARGIN, i.e. stays
// suppressed — matching frostClass's own UNKNOWN_BAND='tender' rule. The two errors are not
// symmetric: wrongly calling a crop hardy opens a row inviting Dave to walk out to a dead plant (the
// horticulture seat's one non-negotiable), while wrongly calling it tender only preserves today's
// behaviour.
//
// SINGLE SOURCE OF TRUTH: src/lib/sowEngine.js — FROST_ANCHORS (`firstFallFrost` /
// `windowClosingDays`), OBSERVED_FIRST_FALL_FROST.medianMonthDay, and FALL_HARDY_CROPS. This Lambda
// CANNOT import them (see the zip constraint above; watch-route.js states the same for
// IMPRESSION_PROJECT_SLOT_CAP). So all four are RESTATED here and pinned in lockstep by
// anchorDerive.test.js, which imports BOTH modules at test time and fails if they ever diverge.
// Change them in sowEngine.js; this copy follows. FALL_HARDY_CROPS is in turn pinned as a subset of
// frostClass.js's `hardy` band by sowEngine.test.js, so the chain reaches the canonical vocabulary
// without this file importing across either boundary.
export const DERIVED_FIRST_FALL_FROST_MMDD = '09-28'; // = FROST_ANCHORS.firstFallFrost
export const DERIVED_FROST_WINDOW_DAYS = 10;          // = FROST_ANCHORS.windowClosingDays
// = OBSERVED_FIRST_FALL_FROST.medianMonthDay. A MEASURED central estimate (11 seasons, 3-station
// GHCN composite near this site), not a margin — read the two-anchor note at sowEngine.js
// FROST_ANCHORS before touching it.
//
// BUG-FROSTANCHORERA5-001 moved this 10-29 -> 10-15: the old value was ERA5 reanalysis, which runs
// ~+8F warm on sub-32F minima here and reads a frost median a fortnight late. THIS LAMBDA IS A
// SEPARATE DEPLOY ARTIFACT from the SPA — promote-gate.yml runs deploy-lambda as a `needs:`
// predecessor of the SPA deploy, so the Lambda ships FIRST and the SPA is withheld if the matrix
// fails; the divergence window is new-Lambda + old-SPA, never the reverse. The behaviour that moves
// here: `frostSuppressed` fires when check_from >= firstFallFrostFor(...) - DERIVED_FROST_WINDOW_DAYS,
// so for the 26 hardy slugs the suppression cutoff moves Oct 19 -> Oct 5, permanently and not just
// during the window. More derived rows are suppressed. That is the fail-safe direction by this file's
// own rule at the head of this block (a suppressed row preserves today's behaviour; an admitted one
// invites a walk to a dead plant), so the correction does not need a coordinated cutover.
export const DERIVED_OBSERVED_FIRST_FALL_FROST_MMDD = '10-15';
// = FALL_HARDY_CROPS. The edible subset of frostClass's hardy band: the harvested organ keeps
// standing, or improves, through repeated fall frost — so for these crops the window this tier
// points at DOES exist past the margin, which is the whole premise of the suppression.
export const DERIVED_FROST_HARDY_SLUGS = new Set([
  'arugula', 'beet', 'bok_choy', 'broccoli', 'brussels_sprouts', 'bunching_onion', 'cabbage',
  'carrot', 'celery', 'chard', 'chervil', 'chives', 'cilantro', 'collard', 'endive', 'garlic',
  'kale', 'kohlrabi', 'leek', 'lettuce', 'mustard', 'parsley', 'parsnip', 'radicchio', 'radish',
  'spinach', 'turnip',
]);

// The first-fall-frost date for the grow year `ymd` sits in, for a crop of type `cropTypeSlug`. The
// grow year runs Nov 1 - Oct 31 (the boundary watch-route.js's `bounds` CTE already uses), so from
// November onward the NEXT first fall frost belongs to the following calendar year.
//
// `cropTypeSlug` selects WHICH anchor, per the note above: measured for a fall-hardy crop, the
// sowing-safety margin for everything else including null/unknown. It is optional so the function
// stays callable without a row, and omitting it yields the pre-BUG-WATCHFROSTSUPPRESS-001 answer.
export function firstFallFrostFor(ymd, cropTypeSlug = null) {
  const s = toYmd(ymd);
  if (s == null) return null;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const mmdd = DERIVED_FROST_HARDY_SLUGS.has(cropTypeSlug)
    ? DERIVED_OBSERVED_FIRST_FALL_FROST_MMDD
    : DERIVED_FIRST_FALL_FROST_MMDD;
  return `${month >= 11 ? year + 1 : year}-${mmdd}`;
}

// A single-habit crop is the POINT of this module (see the blind-spot note above). Repeating habits
// are admitted too: their FIRST harvest of the season is a watch-list event even though every
// subsequent one belongs to the overdue band. NULL habit is excluded — on live prod that set is
// entirely ornamental.
export const WATCHED_HABITS = new Set(['single', 'repeat', 'cut_and_come_again']);

// V4-ANCHORBASE-001. The sibling anchor is restricted to `single`-habit crops, and the restriction
// exists because the anchor's own justification was falsified against live prod.
//
// The comment below still says "same genetics, same bed, same weather". Two of those three are true.
// The FIRST one is not, because the sibling CTE matches on `crop_type_slug` — the crop — and not on
// the cultivar. Measured read-only against prod 2026-08-12 (household = Dave; Jen has zero live
// plantings):
//     Peppers project   56 live plantings, 49 DISTINCT varieties, DTM 57-100  -> 43-day spread
//     Tomatoes project  44 live plantings, 41 DISTINCT varieties, DTM 52- 85  -> 33-day spread
// In the two largest projects a "sibling" is a different cultivar 49 times out of 56 and 41 out of
// 44. Borrowing a first-pick date across a 43-day maturity spread is not same-genetics evidence; it
// is a coin flip with a date attached. And because the anchor fires for EVERY un-picked planting in
// a project where any same-crop sibling has picked, one 56-plant pepper project alone can contribute
// ~50 near-identical rows against a display cap of 5.
//
// WHY `single` IS THE RIGHT CUT, rather than tightening the join to cultivar. Matching on cultivar
// would be more defensible per row but would collapse the anchor to almost nothing — Dave grows one
// or two plants of most varieties, so a same-cultivar sibling that has already picked is rare. The
// habit restriction keeps the anchor exactly where its logic actually holds: for a `single`-habit
// crop, "the first fruit in this bed came off on date D" is a real, dated observation about a
// one-shot harvest. For a `repeat` crop it is not even the right question — a pepper plant picked
// in July says nothing about when a different variety beside it starts, because both will be picked
// repeatedly for months.
//
// MEASURED EFFECT (live prod 2026-08-12, this module's own classifier run over live rows via
// scripts/measure-anchor-coverage.{sql,mjs}): sibling-anchored candidates 62 -> 7, total queue
// 75 -> 40. The rows that leave do not vanish silently — 31 of them still hold their OWN calendar
// anchor and simply stop borrowing one, and their `basis` stops citing a neighbour's pick date as
// evidence about them. 9 DO fall out of sight (no_anchor 16 -> 25), which is the cost of this
// change and the reason it is paired with the derived tier above rather than shipped alone.
export const SIBLING_ANCHOR_HABITS = new Set(['single']);

// ── Pure YYYY-MM-DD date math ────────────────────────────────────────────────────────────────────
// String in, string out, UTC-anchored internally. NO `new Date()` without arguments anywhere in this
// file: every time input arrives as an argument (et_today is computed server-side in HARVEST_TZ), so
// jsdom tests cannot flake across a midnight boundary and the reporting zone stays the Lambda's.

export function toYmd(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function ymdToUtc(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(ymd, n) {
  const s = toYmd(ymd);
  if (s == null || !Number.isFinite(Number(n))) return null;
  return new Date(ymdToUtc(s) + Math.trunc(Number(n)) * 86400000).toISOString().slice(0, 10);
}

// Whole days from `a` to `b`. Negative when b precedes a.
export function daysBetween(a, b) {
  const x = toYmd(a); const y = toYmd(b);
  if (x == null || y == null) return null;
  return Math.round((ymdToUtc(y) - ymdToUtc(x)) / 86400000);
}

// ── Anchor selection (design §3.4 hierarchy) ─────────────────────────────────────────────────────
//
// A watch row must REST on something. In descending strength:
//   1. `observed` — a signal Dave himself logged. Today the only such signal with a usable interval
//      is a `fruit_set` event paired with crop_types.set_to_first_pick_days (populated for melon=42
//      and watermelon=45 on live prod; 51 fruit_set events exist). Still a prediction FROM an
//      observation, so it takes the lead like any other prediction.
//   2. `sibling` — a sibling planting in the SAME project already picked this season. Same genetics,
//      same bed, same weather. The design calls this "the strongest anchor available in the data and
//      it is currently unused", and it is the anchor that rescues the exact crops Dave named:
//      Charentais and Tender Sweet Orange have NO sown_at at all, but each sits in a project whose
//      sibling (Minnesota Mini, Sugar Baby) first picked days ago.
//      This anchor takes NO lead: the sibling's pick date is an OBSERVATION that the crop is picking
//      in that bed right now, not a prediction to be de-biased. check_from IS that date.
//   3. `calendar` — sow/transplant/planted-out plus catalogue DTM, admitted only with its basis
//      carried on the wire so the client can state it ("sown 118d ago; catalogue 95d from sow").
//
// BASIS SHIFT — the defect that would otherwise sink tier 3 for the named crops. dtm_basis says
// which event the catalogue DTM counts from, and the planting frequently lacks THAT date but has
// another. Direction matters and the two directions are not symmetric:
//   * basis 'from-sow', only transplanted_at known: the transplant date is LATER than the true sow
//     date, so elapsed time is UNDERSTATED and the watch opens LATE — the failure mode that hides a
//     fruiting melon. Corrected by subtracting the measured nursery offset from the anchor date.
//   * basis 'from-transplant', only sown_at known: sowing PRECEDES transplant, so elapsed time is
//     OVERSTATED and the watch opens EARLY. Left uncorrected on purpose — early is the safe error
//     for a surface whose whole job is "go look", and inventing a second offset to fix a
//     conservative bias would be unjustified precision.
// Either way `basis_shifted` rides the wire so the row can say what it actually rested on.

const BASIS_PREFERENCE = {
  'from-sow': ['sown_at', 'transplanted_at', 'planted_out_at'],
  'from-transplant': ['transplanted_at', 'planted_out_at', 'sown_at'],
};
const DEFAULT_PREFERENCE = ['transplanted_at', 'planted_out_at', 'sown_at'];

// Cap the lead so it can never exceed WATCH_LEAD_MAX_FRACTION of the interval it is de-biasing.
export function leadDaysFor(expectedDays) {
  const n = Number(expectedDays);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(WATCH_LEAD_DAYS, Math.round(n * WATCH_LEAD_MAX_FRACTION));
}

// V4-ANCHORFLIP-001 condition 7. The basis correction, EXTRACTED from calendarAnchor so the derived
// tier below runs the identical arithmetic rather than a parallel copy of it.
//
// The defect this closes: the calendar path corrects a from-sow DTM read off a transplant date by
// subtracting the nursery offset, and the derived path did not — so the SAME date arriving through
// the two paths produced a `check_from` about a MONTH apart, with no way to tell from the payload
// which correction a row had received. Sharing one function makes the parity structural instead of
// a convention; anchorDerive.test.js pins it by driving both paths off one date and asserting the
// two check_from values are equal.
//
// `field` is the column the date STANDS FOR — the real column for a calendar anchor, and
// plant_anchor_derivation.anchor_field for a derived one. NULL means the source did not say, in
// which case nothing is shifted and nothing is corrected (an unlabelled date cannot be re-based
// without inventing which end of the nursery gap it sits on).
export function applyBasisCorrection(basis, field, date, nurseryOffsetDays) {
  const order = BASIS_PREFERENCE[basis] ?? DEFAULT_PREFERENCE;
  const shifted = field != null && field !== order[0];
  // Only the from-sow-measured-from-transplant direction is corrected; see the note above.
  const needsOffset = basis === 'from-sow' && (field === 'transplanted_at' || field === 'planted_out_at');
  const offset = needsOffset
    ? Math.max(0, Math.trunc(Number(nurseryOffsetDays ?? NURSERY_OFFSET_DAYS_FALLBACK)) || 0)
    : 0;
  return {
    date: offset > 0 ? addDays(date, -offset) : date,
    observed_date: date,
    basis_shifted: shifted,
    nursery_offset_applied: offset,
  };
}

// Pick the calendar anchor for a row, honouring dtm_basis and reporting any basis shift.
export function calendarAnchor(row, nurseryOffsetDays) {
  const basis = row?.dtm_basis ?? null;
  const order = BASIS_PREFERENCE[basis] ?? DEFAULT_PREFERENCE;
  for (const field of order) {
    const date = toYmd(row?.[field]);
    if (date == null) continue;
    const c = applyBasisCorrection(basis, field, date, nurseryOffsetDays);
    return {
      kind: 'calendar',
      date: c.date,
      observed_date: c.observed_date,
      basis,
      basis_field: field,
      basis_shifted: c.basis_shifted,
      nursery_offset_applied: c.nursery_offset_applied,
    };
  }
  return null;
}

// expected_days = the EARLIEST defensible maturity figure (design §3.5: "enters when its earliest
// defensible anchor fires"). days_to_maturity_min first, max only as a fallback.
export function expectedDaysFor(row) {
  const min = Number(row?.days_to_maturity_min);
  if (Number.isFinite(min) && min > 0) return min;
  const max = Number(row?.days_to_maturity_max);
  if (Number.isFinite(max) && max > 0) return max;
  return null;
}

// Tier rank, used ONLY to break a tie between anchors that open on the same day. It is NOT a
// precedence order — see the selection rule below, which is the opposite.
// EXPORTED so the tier ordering can be pinned directly. The derived-vs-calendar pair is currently
// UNOBSERVABLE through behaviour — availableAnchors refuses to build a derived anchor when a
// calendar one exists, so no row can ever hold both — which means a mutation swapping their ranks
// passes every behavioural test. That is precisely why it is asserted as an invariant in the suite:
// the ordering becomes load-bearing the moment that coexistence guard is relaxed, and a silent
// inversion would make a row cite an invented date over one Dave entered.
// `derived` ranks LAST on purpose (V4-ANCHORBASE-001, marking-rule layer 2): a date the system
// invented must never be the provenance a row cites when a date Dave entered is available. Since
// this rank governs only the CITATION and never queue entry (see resolveWatchAnchor), a derived
// anchor can still open a watch early — it just never gets to claim credit for it.
export const TIER_RANK = Object.freeze({ observed: 0, sibling: 1, calendar: 2, derived: 3 });

// Build every anchor this row can support. Selection happens in resolveWatchAnchor.
//
// `siblingHabits` is injectable rather than read straight from the constant so the measurement
// harness (scripts/measure-anchor-coverage.mjs) can price the restriction against live rows in BOTH
// directions. Without it, "what did restricting the sibling anchor cost/save" is unanswerable except
// by editing the module and re-running, which is how a claimed effect size ends up unverified.
// `etToday` rides along ONLY for the frost window (condition 3) — it selects which grow year's frost
// anchor applies and nothing else. When absent it falls back to the derived date's own year, so this
// function stays callable without a clock.
function availableAnchors(row, nurseryOffsetDays, siblingHabits = SIBLING_ANCHOR_HABITS,
  derivedEnabled = DERIVED_ANCHOR_ENABLED, etToday = null,
  fruitingIntervalDays = FRUITING_TO_PICK_DAYS_FALLBACK) {
  const out = [];

  // Observed — a fruit_set event Dave logged, plus the crop's fruit-set-to-first-pick interval.
  //
  // COVERAGE NOTE CORRECTED 2026-08-14. This comment used to read "populated for melon=42 and
  // watermelon=45 on live prod; NULL elsewhere", and that has not been true for some time: prod now
  // carries the interval for pepper 50, tomato 45, watermelon 45, melon 42, cucamelon 10, cucumber 8
  // and squash 5 — seven crops, including the two that dominate this garden. Only broccoli and
  // cabbage log a fruit_set without one. The stale version of this note is load-bearing in the wrong
  // direction: it is the reason V4-FRUITINGTIER-001 sat blocked as though no fruit interval existed
  // anywhere. Re-measure before quoting it. The behaviour is unchanged — a fruit_set with no
  // interval still predicts nothing and still produces no anchor.
  const fruitSet = toYmd(row?.fruit_set_date);
  const setToPick = Number(row?.set_to_first_pick_days);
  if (fruitSet != null && Number.isFinite(setToPick) && setToPick > 0) {
    const lead = leadDaysFor(setToPick);
    out.push({
      kind: 'observed', anchor_date: fruitSet, basis: 'from-fruit-set', basis_shifted: false,
      basis_field: 'fruit_set_date', expected_days: setToPick, lead_days: lead,
      nursery_offset_applied: 0, check_from: addDays(fruitSet, setToPick - lead), source_plant_id: null,
    });
  }

  // Observed — V4-FRUITINGTIER-001. Dave's own logged status_change to `fruiting`, plus the
  // household's measured fruiting-to-first-pick interval.
  //
  // `observed` and not a fourth kind: the anchor date is a date Dave entered about THIS planting,
  // which is the same class of evidence as the fruit_set anchor above and strictly better than
  // anything the derived tier can produce. It sits second so fruit_set keeps citation priority when
  // a planting somehow has both — fruit_set is the narrower, crop-calibrated observation, and a tie
  // in TIER_RANK is broken by check_from, which is the behaviour resolveWatchAnchor already wants.
  //
  // NO FROST GATE, deliberately, unlike the derived tier's condition 3. That gate exists because a
  // derived row invites Dave to look for a window that cannot happen — the plant will be dead before
  // the catalogue says it matures. This anchor rests on the plant ALREADY FRUITING: the fruit exists,
  // and picking it green ahead of frost is a real and useful thing to be reminded of. Suppressing
  // this row near frost would hide exactly the rows most worth showing in late September.
  //
  // NOR a habit gate: condition 5 drops cut_and_come_again from the DERIVED tier because for a crop
  // picked continuously "the catalogue says day 45" answers nothing. That reasoning does not carry
  // here — `fruiting` on a cut-and-come-again crop is still Dave saying he saw fruit — but prod has
  // exactly one such sample (basil, 5d), so the household median governs it and nothing special is
  // needed. WATCHED_HABITS still applies upstream.
  // SCOPE, and why it is NOT widened to the fruit_set event. Over the 44 live plantings at status
  // `fruiting` on prod 2026-08-14: 25 carry a status_change event to fruiting, 15 carry ONLY a
  // fruit_set event (that event AUTO-ADVANCED the status via lambda/events/statusTransitions.js and
  // wrote no status_change event), 4 carry neither. Feeding those 15 into this tier looks like a
  // coverage win and is not: they are peppers and tomatoes, and set_to_first_pick_days is populated
  // for BOTH (50 and 45), so the crop-calibrated observed anchor above already serves them on their
  // own crop's number. The only plantings a fruit_set arm would actually add are the 3 with a
  // fruit_set and no interval — broccoli and cabbage — where "fruit set" is not the harvested
  // product at all and an 18-day median measured on tomato/pepper/tomatillo predicts nothing about
  // a head. This tier reads the status Dave logged, and nothing else.
  const fruitingDays = Number(fruitingIntervalDays);
  const fruitingOn = toYmd(row?.fruiting_status_date);
  if (fruitingOn != null && Number.isFinite(fruitingDays) && fruitingDays > 0) {
    const lead = leadDaysFor(fruitingDays);
    out.push({
      kind: 'observed', anchor_date: fruitingOn, basis: 'from-fruiting-status', basis_shifted: false,
      basis_field: 'fruiting_status_date', expected_days: fruitingDays, lead_days: lead,
      nursery_offset_applied: 0, check_from: addDays(fruitingOn, fruitingDays - lead),
      source_plant_id: null,
    });
  }

  // Sibling — a planting of the same crop in the same project already picked. NO lead: this is an
  // observation that the bed is producing, not a prediction to be de-biased.
  // Gated on habit — see SIBLING_ANCHOR_HABITS. The crop-not-cultivar mismatch means this anchor is
  // only defensible where "the first fruit came off on date D" is a real one-shot event.
  const sibling = toYmd(row?.sibling_first_pick_date);
  if (sibling != null && siblingHabits.has(row?.harvest_habit)) {
    out.push({
      kind: 'sibling', anchor_date: sibling, basis: 'sibling-first-pick', basis_shifted: false,
      basis_field: 'sibling_first_pick_date', expected_days: null, lead_days: 0,
      nursery_offset_applied: 0, check_from: sibling, source_plant_id: row?.sibling_plant_id ?? null,
    });
  }

  // Calendar — sow/transplant plus catalogue DTM, basis carried on the wire.
  const expected = expectedDaysFor(row);
  const cal = calendarAnchor(row, nurseryOffsetDays);
  if (cal != null && expected != null) {
    const lead = leadDaysFor(expected);
    out.push({
      kind: 'calendar', anchor_date: cal.date, observed_anchor_date: cal.observed_date,
      basis: cal.basis, basis_shifted: cal.basis_shifted, basis_field: cal.basis_field,
      expected_days: expected, lead_days: lead, nursery_offset_applied: cal.nursery_offset_applied,
      check_from: addDays(cal.date, expected - lead), source_plant_id: null,
    });
  }

  // Derived — a backfilled anchor for a planting that has NO date of its own (V4-ANCHORBASE-001).
  // Read from the persisted derived_anchor_* columns rather than derived here, so the value the
  // watch list uses is the same value that was recorded, labelled and can be audited or reverted.
  // Guarded by BOTH the feature flag and the presence of the column, and — the invariant that makes
  // this safe — it is skipped outright whenever `cal` produced anything, because a planting with a
  // real date must never also carry a derived one.
  //
  // V4-ANCHORFLIP-001 layers three further suppressions on top, each stated where its constant is
  // declared: the habit gate (condition 5), the contradicting-status gate (condition 4) and the
  // frost window (condition 3). All three narrow ONLY this tier — no other anchor kind changes
  // behaviour, so with the flag off this whole block remains dead code and the module is
  // byte-for-byte equivalent to the shipped one.
  if (derivedEnabled && cal == null && expected != null
      && DERIVED_ANCHOR_HABITS.has(row?.harvest_habit)
      && !DERIVED_STATUS_SUPPRESSED.has(row?.status)) {
    const derivedDate = toYmd(row?.derived_anchor_date);
    if (derivedDate != null) {
      // Condition 7. The derived date is re-based exactly as a calendar date would be, using the
      // column the derivation says it STANDS FOR (plant_anchor_derivation.anchor_field). Without
      // this, a from-sow crop whose derived anchor stands for `transplanted_at` opened its watch a
      // nursery-gap (~31d) later through this path than through the calendar path.
      const basisField = row?.derived_anchor_field ?? null;
      const c = applyBasisCorrection(row?.dtm_basis ?? null, basisField, derivedDate, nurseryOffsetDays);
      const lead = leadDaysFor(expected);
      const checkFrom = addDays(c.date, expected - lead);

      // Condition 3 — the frost window. Suppression compares the date the watch would OPEN against
      // the frost anchor, not the anchor date: a row is useless precisely when the thing it invites
      // Dave to go look for cannot happen before the plant dies.
      //
      // BUG-WATCHFROSTSUPPRESS-001: which frost anchor is per-crop. "Before the plant dies" is a
      // premise, not a constant — for a FALL_HARDY_CROPS slug the plant does not die at first frost,
      // so the row it would suppress is a real one and the anchor becomes a measurement. An absent or
      // unknown slug keeps the margin; see the fail-safe note at the constants.
      const frost = firstFallFrostFor(etToday ?? derivedDate, row?.crop_type_slug ?? null);
      const frostCutoff = frost == null ? null : addDays(frost, -DERIVED_FROST_WINDOW_DAYS);
      const frostSuppressed = checkFrom != null && frostCutoff != null && checkFrom >= frostCutoff;

      if (!frostSuppressed) {
        out.push({
          kind: 'derived', anchor_date: c.date, observed_anchor_date: c.observed_date,
          basis: 'derived-anchor', basis_shifted: c.basis_shifted,
          basis_field: 'derived_anchor_date', expected_days: expected, lead_days: lead,
          nursery_offset_applied: c.nursery_offset_applied, check_from: checkFrom,
          source_plant_id: null,
          derived_source: row?.derived_anchor_source ?? null,
          derived_confidence: row?.derived_anchor_confidence ?? null,
          // The column the derived date stands in for, carried so an audit can see WHICH correction
          // was applied without re-deriving it. `basis_field` stays 'derived_anchor_date' because
          // that is where the row's date literally came from — the two answer different questions.
          derived_anchor_field: basisField,
        });
      }
    }
  }

  return out.filter((a) => a.check_from != null);
}

// Resolve the anchor a row rests on. Returns null when the planting rests on nothing — a row with
// no anchor is NOT shown (design §3.4: "what a window row must rest on to be shown at all"), rather
// than shown with a shrug.
//
// TWO SEPARATE QUESTIONS, TWO SEPARATE ANSWERS. Collapsing them is what produced the live-prod bug
// described below, and both halves of this split are load-bearing:
//
//   1. WHEN DOES THE WATCH OPEN?  ->  the EARLIEST check_from across every available anchor.
//      Design §3.5: the queue admits a planting "when its EARLIEST defensible anchor fires", and
//      every anchor built above is by construction defensible. Critically, this makes it IMPOSSIBLE
//      for one anchor to suppress another — the failure mode below. This date is `check_from` /
//      `watching_since`, and it is the "checking since Aug 4" the design asks the row to show.
//
//   2. WHAT DOES THE ROW SAY IT RESTS ON?  ->  the STRONGEST anchor that has ALREADY FIRED.
//      Provenance should cite the best evidence actually in hand. A sibling that has been picked is
//      a completed observation of this crop ripening in this bed; a catalogue DTM measured off an
//      estimated sow date is a guess that happens to fire earlier. Telling Dave the guess when the
//      observation is available would be strictly worse copy, so `basis` and `confidence` come from
//      here while `watching_since` comes from (1).
//
// THE REGRESSION THIS REPLACED. Strict tier precedence — always prefer observed, then sibling, then
// calendar — produced the exact bug this whole slice exists to fix. Charentais and Tender Sweet
// Orange each carry a fruit_set dated 2026-07-23 AND a sibling (Minnesota Mini, Crimson Sweet) that
// had ALREADY picked on 08-08 / 08-10. The `observed` anchor won on tier and pushed check_from out
// to 08-23 / 08-26, so both rows read `not_yet_open` and were INVISIBLE on 08-12 — two of the very
// plantings whose absence motivated the slice. A fruit_set run through a catalogue interval is still
// a PREDICTION, merely one starting from an observed event; letting it outrank and suppress a
// completed pick inverts the evidence hierarchy the design was arguing for.
//
// Caught only by running the real query against live prod. The fixture tests passed, because no
// fixture carried both a fruit_set and a sibling — which is why the fixtures now do.
export function resolveWatchAnchor(row, opts = {}) {
  const nurseryOffsetDays = opts.nurseryOffsetDays ?? NURSERY_OFFSET_DAYS_FALLBACK;
  const anchors = availableAnchors(row, nurseryOffsetDays, opts.siblingHabits ?? SIBLING_ANCHOR_HABITS,
    opts.derivedEnabled ?? DERIVED_ANCHOR_ENABLED, toYmd(opts.etToday),
    opts.fruitingIntervalDays ?? FRUITING_TO_PICK_DAYS_FALLBACK);
  if (anchors.length === 0) return null;

  const byDate = [...anchors].sort((a, b) => (
    a.check_from < b.check_from ? -1 : a.check_from > b.check_from ? 1
      : TIER_RANK[a.kind] - TIER_RANK[b.kind]
  ));
  const earliestAll = byDate[0];

  // Strongest anchor already in hand. Before ANY anchor has fired the row is not eligible anyway, so
  // fall back to the earliest — that is the one whose firing will admit it.
  const today = toYmd(opts.etToday);
  const fired = today == null ? [] : anchors.filter((a) => a.check_from <= today);
  const pool = fired.length > 0 ? fired : [earliestAll];
  const strongest = [...pool].sort((a, b) => (
    TIER_RANK[a.kind] - TIER_RANK[b.kind] || (a.check_from < b.check_from ? -1 : 1)
  ))[0];

  // V4-ANCHORFLIP-001 condition 6 — the UNCITED-DERIVED-DATE LEAK, and the ONE place the two-question
  // split above needed narrowing rather than defending.
  //
  // THE LEAK. Queue entry takes the earliest anchor; the citation takes the strongest FIRED one. For
  // the three real anchor kinds that is exactly right and stays untouched — an early calendar anchor
  // opening a watch that a later sibling pick then explains is two true statements about the same
  // planting. But a DERIVED anchor is not a fourth kind of observation, it is a date the system made
  // up, and TIER_RANK deliberately forbids it from ever being cited while a real date exists. The
  // combination produced a row whose `watching_since` came from the invented date and whose `basis`
  // cited something else entirely: the consult's Cantaloupe, sliding to Jul 27 while still reading
  // "sibling picked Aug 8". The two do not reconcile, and `days_watching` inflates by the gap.
  //
  // THE RULE. A derived anchor may set `watching_since` only when it is also what the row CITES.
  // Whenever the citation is real, queue entry is computed over the real anchors alone, so the
  // displayed date and the stated basis always come from the same resolved anchor.
  //
  // NON-CIRCULAR, and a strict no-op with the flag off: `strongest` is computed before this and
  // never depends on it, and with no derived anchor in `anchors` the filter removes nothing.
  const entryPool = strongest.kind === 'derived' ? byDate : byDate.filter((a) => a.kind !== 'derived');
  const earliest = entryPool[0] ?? earliestAll;

  return {
    ...strongest,
    // (1) — queue entry. Always the earliest, whatever the row cites as provenance.
    check_from: earliest.check_from,
    opened_by: earliest.kind,
    // `alternates` records every anchor not cited, so a row is auditable without re-deriving it and
    // a later tuning pass can see which anchors disagreed and by how much.
    alternates: byDate.filter((a) => a !== strongest).map((a) => ({ kind: a.kind, check_from: a.check_from })),
  };
}

// ── Short provenance string (`basis` on the wire) ────────────────────────────────────────────────
//
// The canon rule that a derivation must be LABELLED still binds (design §3.4 rank 3: calendar is
// "permitted only with its basis visible"), but the watch row is compact and a long field turns the
// list back into the inventory it replaces. So: short, and honest about the weakest link.
//
// A basis-shifted calendar anchor gets the "(est. sow)" qualifier because that row rests on a date
// this module INFERRED — the crop's DTM counts from sowing, no sow date exists, and the anchor was
// reconstructed by subtracting the household's median nursery gap from the transplant date. Printing
// it as a plain sow date would launder an estimate into a record.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(ymd) {
  const s = toYmd(ymd);
  if (s == null) return null;
  const [, m, d] = s.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

const FIELD_VERB = { sown_at: 'sown', transplanted_at: 'transplanted', planted_out_at: 'planted out' };

// A borrowed anchor must LOOK borrowed. `sibling picked Aug 10` says a sibling picked, but never
// says WHICH — so a row silently presents a neighbouring planting's date as evidence about itself,
// and Dave has no way to see that the "sibling" is a different variety with a different maturity
// (V4-ANCHORBASE-001: 49 varieties in one pepper project). Naming it makes the borrow visible and
// checkable at a glance. The name is truncated because the design's ~40-char basis budget is what
// keeps the watch row a row instead of the inventory it replaced.
const SIBLING_NAME_MAX = 18;

export function siblingLabel(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  if (s === '') return null;
  return s.length <= SIBLING_NAME_MAX ? s : `${s.slice(0, SIBLING_NAME_MAX - 1).trimEnd()}…`;
}

// PANEL Q2 (harvest-panel-decisions-20260812.md): "Add the sibling's planting-date offset where
// available — a 3-week succession breaks the shared-clock premise even for `single` crops." The
// offset is only meaningful comparing LIKE dates, so it uses the first field BOTH plantings carry.
// Positive = this planting went in AFTER the sibling (its clock started later, so the borrowed pick
// date overstates its progress by about this much).
export function siblingPlantingOffsetDays(row) {
  for (const f of ['sown_at', 'transplanted_at', 'planted_out_at']) {
    const own = toYmd(row?.[f]);
    const sib = toYmd(row?.[`sibling_${f}`]);
    if (own != null && sib != null) return daysBetween(sib, own);
  }
  return null;
}

export function describeBasis(anchor, etToday, row = null) {
  if (!anchor) return null;
  if (anchor.kind === 'sibling') {
    const who = siblingLabel(row?.sibling_planting_name ?? anchor.source_planting_name);
    // Falls back to the unnamed form rather than printing an empty slot — a sibling with no name on
    // the row is a data gap, not a reason to drop the provenance entirely.
    const core = who == null
      ? `sibling picked ${shortDate(anchor.anchor_date)}`
      : `sibling ${who} picked ${shortDate(anchor.anchor_date)}`;
    // The planting-date offset makes the borrow's weakest premise visible: a sibling planted weeks
    // apart is not on this planting's clock. Zero offset says nothing and is omitted.
    const off = siblingPlantingOffsetDays(row);
    if (off == null || off === 0) return core;
    return `${core} · planted ${Math.abs(off)}d ${off > 0 ? 'earlier' : 'later'}`;
  }
  // Two observed anchors now share this kind, and they must NOT share copy. Printing "fruit set" for
  // a row resting on a status_change would cite an event Dave never logged — the provenance would be
  // a fabrication even though the date is real, which is the same class of error the derived tier's
  // `est.` prefix exists to prevent. Branch on the field the anchor actually came from.
  if (anchor.kind === 'observed') {
    return anchor.basis_field === 'fruiting_status_date'
      ? `fruiting ${shortDate(anchor.anchor_date)}`
      : `fruit set ${shortDate(anchor.anchor_date)}`;
  }

  // V4-ANCHORBASE-001, marking-rule layer 3. A derived anchor's copy leads with `est.` — ALWAYS,
  // before any date or number — because this row rests on a date Dave never entered. The
  // add-date baseline says so in as many words: at 47.3% accuracy within a week it is not a date,
  // it is an assumption, and printing it as `planted 62d` would launder it into a record.
  if (anchor.kind === 'derived') {
    const from = anchor.derived_source === 'add_date_baseline' ? 'est. from add-date'
      : anchor.derived_source === 'nursery_proxy_event' ? 'est. from nursery event'
        : anchor.derived_source === 'sow_event' ? 'est. from sow event'
          : anchor.derived_source === 'transplant_event' ? 'est. from transplant event'
            : 'est. anchor';
    const days = daysBetween(anchor.anchor_date, etToday);
    const dtm = anchor.expected_days == null ? null : `catalogue ${anchor.expected_days}d`;
    const core = days == null ? from : `${from} ${days}d`;
    return dtm ? `${core} · ${dtm}` : core;
  }

  // The age is measured from anchor_date — the date the DTM math ACTUALLY used — never from the raw
  // field. When the nursery offset was applied, those differ by a month, and printing the raw
  // transplant age beside a catalogue figure computed from the estimated sow date produced a
  // sentence whose two numbers could not both be true ("sown 62d · catalogue 85d" on a planting the
  // model believed was 93 days from sowing).
  //
  // The verb follows the FIELD, not the basis, for the same reason: a from-transplant crop anchored
  // on sown_at must not print "transplanted" over a sow-date age.
  const offset = Number(anchor.nursery_offset_applied ?? 0);
  const verb = offset > 0 ? 'sown' : (FIELD_VERB[anchor.basis_field] ?? 'planted');
  const age = daysBetween(anchor.anchor_date, etToday);
  const agePart = age == null ? verb : `${verb} ${age}d`;
  const dtm = anchor.expected_days == null ? null : `catalogue ${anchor.expected_days}d`;
  const core = dtm ? `${agePart} · ${dtm}` : agePart;

  // Short provenance qualifier — the canon rule that a derivation must be LABELLED. `(est. sow)`
  // marks a sow date this module RECONSTRUCTED; `(est.)` marks the uncorrected shift, where the DTM
  // basis and the available date simply disagree.
  if (offset > 0) return `${core} (est. sow)`;
  return anchor.basis_shifted ? `${core} (est.)` : core;
}

// ── Bounded-suppression guard (panel Q3) ─────────────────────────────────────────────────────────
//
// A returning row must carry NEW content. Panel decision: "if the basis string is byte-identical to
// the dismissed instance, suppress another cycle rather than show it, because an identical row
// genuinely is the app ignoring him." The dismissed instance's basis string is reconstructed from
// the FROZEN snapshot columns (anchor kind/date/basis/shift/expected/lead) rendered as of the
// observation day. In practice this only ever matches for the age-free anchor kinds (sibling,
// observed): a calendar basis embeds an age ("sown 93d") that moves daily, which is exactly the
// "fresh basis date" the panel said makes a calendar return legitimate.

export function reconstructDismissedBasis(row) {
  const kind = row?.dismissal_anchor_kind;
  if (!kind) return null;
  const frozen = {
    kind,
    anchor_date: toYmd(row.dismissal_anchor_date),
    basis: row.dismissal_anchor_basis ?? null,
    basis_shifted: !!row.dismissal_anchor_basis_shifted,
    basis_field: null,
    expected_days: row.dismissal_expected_days == null ? null : Number(row.dismissal_expected_days),
    lead_days: row.dismissal_lead_days == null ? null : Number(row.dismissal_lead_days),
    nursery_offset_applied: 0,
  };
  return describeBasis(frozen, toYmd(row.dismissal_observed_on), row);
}

// Returns the extended return date when the guard suppresses, else null. Bounded to ONE extra cycle
// (the panel's words: "suppress another cycle") — past dismissal_suppressed_until + WATCH_SUPPRESS_DAYS
// the row shows even if still identical, so the guard can never quietly become season-long.
export function basisUnchangedUntil(row, anchor, today) {
  const until = toYmd(row?.dismissal_suppressed_until);
  if (until == null || until > today) return null; // no bounded dismissal, or it is still active
  const extra = addDays(until, WATCH_SUPPRESS_DAYS);
  if (today >= extra) return null;
  const frozen = reconstructDismissedBasis(row);
  if (frozen == null) return null;
  return describeBasis(anchor, today, row) === frozen ? extra : null;
}

// ── Candidate classification ─────────────────────────────────────────────────────────────────────
//
// Returns a discriminated result for EVERY row, eligible or not, so the route can report why a
// planting is absent instead of collapsing three different silences into one empty list (the
// `return null` failure the band already has). `reason` is diagnostic, never user copy.

export function classifyWatchCandidate(row, etToday, opts = {}) {
  const today = toYmd(etToday);
  if (!row || today == null) return { eligible: false, reason: 'no_today' };

  // The habit gate this module exists to widen. `single` is IN.
  if (!WATCHED_HABITS.has(row.harvest_habit)) {
    return { eligible: false, reason: 'habit_not_watched' };
  }

  // Queue exit 1 — Dave logged a first harvest. The planting graduates to the overdue band's world.
  if (Number(row.prior_harvest_count ?? 0) > 0) {
    return { eligible: false, reason: 'already_harvested' };
  }

  // Queue SNOOZE — an active "not yet" dismissal. Suppression is a JOIN condition on the live route
  // as well; repeated here so the pure function tells the whole truth on its own. Under bounded
  // suppression (panel Q3) this is a snooze, not an exit: suppressed_until rides the verdict so the
  // route can print the return date.
  if (row.dismissed_active === true) {
    return {
      eligible: false, reason: 'dismissed',
      suppressed_until: toYmd(row.dismissal_suppressed_until),
    };
  }

  const anchor = resolveWatchAnchor(row, { ...opts, etToday: today });
  if (anchor == null) return { eligible: false, reason: 'no_anchor' };
  if (anchor.check_from == null) return { eligible: false, reason: 'no_anchor' };

  const daysWatching = daysBetween(anchor.check_from, today);
  if (daysWatching == null) return { eligible: false, reason: 'no_anchor' };
  if (daysWatching < 0) return { eligible: false, reason: 'not_yet_open', check_from: anchor.check_from };

  // Byte-identical-basis guard (panel Q3): a row returning from suppression with a basis string
  // identical to the one it was dismissed under is suppressed one more cycle instead of shown.
  const guardUntil = basisUnchangedUntil(row, anchor, today);
  if (guardUntil != null) {
    return { eligible: false, reason: 'basis_unchanged', suppressed_until: guardUntil };
  }

  return { eligible: true, reason: 'watching', anchor, check_from: anchor.check_from, days_watching: daysWatching };
}

// Wire projection.
//
// FIELD NAMES ARE A CROSS-LANE CONTRACT. `name`, `variety_ref`, `watching_since` and `basis` match
// the shape the concurrent UI lane committed and tested against — they are NOT this module's
// preferred spellings, they are the agreed ones, and renaming them silently breaks 33 UI tests.
//
// The grammar contract still binds on top of that (design §3.1): `watching_since` and `basis`, never
// `ready_at` or `days_overdue`. A client cannot render a prediction in an observation's grammar
// without first renaming a field.
//
// `check_from` / `days_watching` / `crop_type_slug` are kept as ADDITIVE aliases rather than
// dropped: the dismissal snapshot is built from this same object, and the calibration columns are
// named for the model, not for the row.
export function projectWatchRow(row, verdict, etToday) {
  const a = verdict.anchor;
  return {
    plant_id: row.plant_id,
    project_id: row.project_id,

    // ── UI contract ──────────────────────────────────────────────────────────────────────────────
    name: row.planting_name ?? null,
    location_name: row.location_name ?? null,
    variety_ref: {
      name: row.variety_name ?? null,
      crop_type_slug: row.crop_type_slug ?? null,
    },
    watching_since: verdict.check_from,
    basis: describeBasis(a, etToday, row),

    // ── Additive: everything the UI does not render but the server/audit path needs ───────────────
    location_id: row.location_id ?? null,
    crop_type_slug: row.crop_type_slug ?? null,
    crop_display_name: row.crop_display_name ?? null,
    variety_id: row.variety_id ?? null,
    harvest_habit: row.harvest_habit ?? null,
    status: row.status ?? null,
    prior_harvest_count: Number(row.prior_harvest_count ?? 0),
    // `confidence` is the anchor tier, named for what the client must SAY about the row, not a score.
    confidence: a.kind,
    anchor: {
      kind: a.kind,
      date: a.anchor_date,
      observed_date: a.observed_anchor_date ?? a.anchor_date,
      basis: a.basis,
      basis_field: a.basis_field,
      basis_shifted: !!a.basis_shifted,
      expected_days: a.expected_days,
      lead_days: a.lead_days,
      nursery_offset_applied: a.nursery_offset_applied,
      source_plant_id: a.source_plant_id ?? null,
      source_planting_name: a.kind === 'sibling' ? (row.sibling_planting_name ?? null) : null,
      // V4-ANCHORBASE-001: the marking rides the wire, not just the copy. `derived` is a boolean a
      // consumer can filter on without parsing prose — a calibration query that silently trained on
      // invented anchors would be fitting its own assumption.
      derived: a.kind === 'derived',
      derived_source: a.derived_source ?? null,
      derived_confidence: a.derived_confidence ?? null,
      // V4-ANCHORFLIP-001 condition 7: the column the derived date stands in for. Paired with
      // basis_shifted / nursery_offset_applied above, this is what makes the basis correction
      // AUDITABLE on the wire — the ~40-char basis string has no room to say it, and a correction
      // nobody can see is a correction nobody can check.
      derived_anchor_field: a.derived_anchor_field ?? null,
      alternates: a.alternates ?? [],
    },
    check_from: verdict.check_from,
    days_watching: verdict.days_watching,
  };
}

// Newest first (design §3.5: "Newest first"), i.e. most-recently-opened watch at the top — a row
// that has been watched for 40 days is the one Dave has already looked past. plant_id breaks ties so
// the order is total and the payload is stable across identical requests.
export function rankWatchCandidates(rows) {
  return [...rows].sort((x, y) => {
    if (x.days_watching !== y.days_watching) return x.days_watching - y.days_watching;
    return String(x.plant_id).localeCompare(String(y.plant_id));
  });
}

// Cross-lane contract: the exact keys the UI lane committed against. Asserted in the test suite so a
// rename here fails HERE rather than as a blank row in the client after integration.
export const UI_CONTRACT_FIELDS = Object.freeze([
  'plant_id', 'project_id', 'name', 'location_name', 'variety_ref', 'watching_since', 'basis',
]);

// Snoozed wire projection (panel Q3 + Q4). Everything the tail's "Snoozed" subgroup needs to print
// a row and its return date — nothing more. suppressed_until NULL = a pre-bounded-suppression
// season-long row (0 in prod at ship time, but the shape must not lie about them).
export function projectSnoozedRow(row, verdict) {
  return {
    plant_id: row.plant_id,
    project_id: row.project_id ?? null,
    name: row.planting_name ?? null,
    location_name: row.location_name ?? null,
    crop_display_name: row.crop_display_name ?? null,
    suppressed_until: verdict.suppressed_until ?? null,
    reason: verdict.reason,
  };
}

// Full pipeline over raw SQL rows. Returns the ranked list PLUS a reason census, so a zero-length
// list is explainable at the API boundary instead of being an unreadable silence — and the snoozed
// rows themselves, so the tail can print each suppressed planting with its return date (panel Q4).
//
// V4-WATCHEXCLUDEDLOG-001 adds `excludedRows`: the SAME verdicts as the `excluded` census, at row
// grain instead of count grain. The census is what goes on the wire (a client needs "why is this
// list empty", not a list of ids); excludedRows is what gets PERSISTED, because a count can never be
// joined to event_log to ask whether the model was right to decline a particular planting. Both are
// derived from one pass over one verdict per row, so they cannot disagree.
//
// RANKING NOTE (panel Q3: "the returning row must not come back at the top"). No code change was
// needed for that and none should be added: rankWatchCandidates orders by days_watching ascending
// (newest watch first) and suppression never touches check_from, so a returning row re-enters
// exactly where its watch age puts it — never promoted by the "not yet" tap. Pinned in the suite.
export function buildWatchList(rows, etToday, opts = {}) {
  const candidates = [];
  const excluded = {};
  const excludedRows = [];
  const snoozed = [];
  for (const row of rows ?? []) {
    const verdict = classifyWatchCandidate(row, etToday, opts);
    if (verdict.eligible) candidates.push(projectWatchRow(row, verdict, etToday));
    else {
      excluded[verdict.reason] = (excluded[verdict.reason] ?? 0) + 1;
      // plant_id may be absent on a malformed row; such a row cannot be persisted (the column is
      // NOT NULL and FK'd) but MUST still count in the census, which is why the guard is here and
      // not above.
      if (row?.plant_id != null) excludedRows.push({ plant_id: row.plant_id, reason: verdict.reason });
      if (verdict.reason === 'dismissed' || verdict.reason === 'basis_unchanged') {
        snoozed.push(projectSnoozedRow(row, verdict));
      }
    }
  }
  // Soonest-returning first; name then plant_id break ties so the payload is stable.
  snoozed.sort((a, b) => String(a.suppressed_until ?? '9999').localeCompare(String(b.suppressed_until ?? '9999'))
    || String(a.name ?? '').localeCompare(String(b.name ?? ''))
    || String(a.plant_id).localeCompare(String(b.plant_id)));
  return { candidates: rankWatchCandidates(candidates), excluded, excludedRows, snoozed };
}

// ── Dismissal snapshot ───────────────────────────────────────────────────────────────────────────
//
// WHY THE SERVER FREEZES THIS, AND WHY IT IS NOT JUST A UI HIDE.
//
// The harvest dataset has never held a single negative-class sample: every label in it is "Dave
// picked on date D". You cannot calibrate a ripeness model from positives alone — that is precisely
// why the estimate sits at 11.8% with a 22-day median error and has no mechanism to improve.
//
// A "not yet" tap is the first negative label the system can ever collect: at a KNOWN instant, on a
// KNOWN planting, a human LOOKED and reported not-ready. To be usable as a training sample it must
// carry the model's claim AS IT STOOD AT THAT MOMENT, which is what this function freezes:
//   * Recomputing the features later would LEAK THE ANSWER (the eventual harvest date is by then in
//     the data) and would drift anyway — crop_types.days_to_maturity and dtm_basis are edited, and
//     the anchor dates themselves get corrected. A sample whose features move is not a sample.
//   * `model_version` partitions the set, so a constant change here does not silently mix labels
//     produced by incompatible models.
//   * `observed_on` is separate from `dismissed_at` because it follows the harvest-date convention
//     this codebase already enforces — the OBSERVATION date is the truth, the write timestamp is
//     bookkeeping (30% of harvests are backdated; the same will be true of dismissals).
//
// The resulting pair is a supervised sample: features frozen here, and the label supplied later by
// the planting's eventual first-harvest date (already in event_log — no new capture needed). The
// target is `days_from_observation_to_first_pick`, which is > 0 by construction for every dismissal.
// A dismissal on a planting that NEVER gets harvested is not waste either: it is a right-censored
// observation, which survival-style calibration consumes directly.
//
// Built server-side from the server's own candidate row, never from client-supplied fields — a
// client that could post its own model snapshot could poison the calibration set, and a stale PWA
// bundle would post an old model's numbers under the current version string.
export function buildDismissalSnapshot(candidate, observedOn) {
  if (!candidate) return null;
  const a = candidate.anchor ?? {};
  return {
    plant_id: candidate.plant_id,
    project_id: candidate.project_id ?? null,
    observed_on: toYmd(observedOn),
    // Bounded suppression (panel Q3): the row returns this many days after the OBSERVATION — the
    // date the human looked, not the write timestamp, per the backdating convention above.
    suppressed_until: addDays(toYmd(observedOn), WATCH_SUPPRESS_DAYS),
    model_version: WATCH_MODEL_VERSION,
    crop_type_slug: candidate.crop_type_slug ?? null,
    variety_id: candidate.variety_id ?? null,
    anchor_kind: a.kind ?? null,
    anchor_date: toYmd(a.date),
    anchor_basis: a.basis ?? null,
    anchor_basis_shifted: !!a.basis_shifted,
    expected_days: a.expected_days ?? null,
    lead_days: a.lead_days ?? null,
    check_from: toYmd(candidate.check_from),
    days_watching: candidate.days_watching ?? null,
  };
}
