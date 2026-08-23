'use strict';
// V4-WATERMATH-001 F2 — the ONE table-driven params module for every tuned Water Ledger constant.
// Canon: watering-cadence-math-design-V100-20260812.md Part 5: "All tuned constants live in ONE
// table-driven params module … bank magnitudes, hedge thresholds, vessel/size factors, ramps, clamp
// bounds, snooze floor, confidence thresholds, and the flip gate's global normalization multiplier —
// ~15 constants across four mechanism families are tunable as a set or the 'one global normalization
// constant' lever is unexercisable."
//
// Everything here is a POLICY NUMBER, not code: the fold (ledger.js) and the engine branch read these
// and only these. Retuning for the flip gate is an edit to THIS file (or, for the whole-system case,
// to GLOBAL_NORMALIZATION alone), never a hunt through the fold.

// ── Demand family ────────────────────────────────────────────────────────────────────────────────
// ET0_REF_PEAK: ONE site-wide climatological reference, inches/day, for the one live Space
// (42.5087,-72.6471, W. MA). NEVER a rolling median — canon Decision 2: a rolling median is a
// high-pass filter that re-centers onto a heat wave by day ~7-10 (demand -> 1.0 exactly in the lethal
// window) and deletes the fall decline.
//
// BUG-ETNOAMPLITUDE-001 (2026-08-20) — WHY THIS IS A SCALAR AND MUST STAY ONE.
// Until this fix the denominator was a TWELVE-ENTRY table, ET0_REF_MONTHLY, whose May-Aug entries
// were literally the measured mean of that same month (0.160/0.202/0.190/0.174 vs prod weather_daily
// means 0.1602/0.2019/0.1898/0.1729 — equal to three decimals). Dividing each day's ET0 by its own
// month's mean is a per-month self-reference: it re-centers every month on 1.0 and subtracts the
// entire seasonal signal, which is the SAME high-pass defect Decision 2 rejected, just precomputed
// annually instead of rolling. Measured over 11 years of site archive, the monthly-mean multiplier
// under that table spanned only 0.879..1.048 across May-Oct while actual ET0 fell 0.1775 -> 0.0714
// (2.5x), and the curve INVERTED: October (1.048) and March (1.182) both read HOTTER than July
// (0.948). Crossing into September the multiplier ROSE in 11 of 11 years (late-Aug 0.853 ->
// early-Sep 1.054, +24%), i.e. the model SHORTENED fall watering intervals as evapotranspiration
// fell. The soak's own maintenance step ("ET0_ref Sep/Oct refresh as those months accrue",
// scripts/f2-shadow-soak.sh) would have driven Sep/Oct to exactly 1.0 and made it worse.
// A single denominator is the fix: the multiplier is then ET0(day)/ET0(peak season), which carries
// the full seasonal amplitude by construction and cannot be re-centered by a later retune.
//
// PROVENANCE — MEASURED, not estimated. 0.1775 in/day = the mean of every July day, 2015-01-01..
// 2025-12-31 (n=341), from the Open-Meteo ERA5 archive at the Space's exact coordinates, via the
// SAME endpoint/fields/units scripts/backfill-weather-daily.mjs writes weather_daily from:
//   https://archive-api.open-meteo.com/v1/archive?latitude=42.508744987687344
//     &longitude=-72.64706648619953&start_date=2015-01-01&end_date=2025-12-31
//     &daily=et0_fao_evapotranspiration&temperature_unit=fahrenheit&precipitation_unit=inch
//     &timezone=America/New_York
// July is the annual peak (11y monthly means: Jan .031 Feb .043 Mar .070 Apr .103 May .145 Jun .173
// Jul .1775 Aug .154 Sep .114 Oct .071 Nov .046 Dec .028). Per-year July means run 0.132 (2021) to
// 0.213 (2022); that spread is weather, and the daily ET0 numerator is what carries it — the
// reference is a climatological anchor, not a forecast.
//
// ⚠ FOR DAVE — the LEVEL is a tuning choice, the AMPLITUDE is not.
// Any single denominator restores the same seasonal SHAPE; the choice of value only sets where 1.0
// sits. Peak-season was chosen because it holds the summer level almost exactly where both the
// legacy engine and the pre-fix ledger already put it: over the live 98-day prod window the mean
// multiplier moves 1.016 -> 1.058, +4.1%, inside the flip gate's +-10% band, so this patch changes
// autumn without silently re-tuning summer. The May-Sep growing-season mean (0.1528) was the other
// candidate and would have shifted the same window +20%. If the shadow soak says the level is wrong,
// move GLOBAL_NORMALIZATION — never this constant, and never back to a per-period table.
const ET0_REF_PEAK = 0.1775;
// Clamp bounds on ET0(day)/ET0_REF_PEAK. The floor is what caps the autumn stretch at 2x the
// researched interval and it now binds from roughly Oct 1 onward (11y: 68% of October days, 98% of
// November, 100% of Dec-Jan) — which is also what retired the old `ref < WINTER_REF_MIN` winter-mode
// branch. That branch pinned Nov-Feb at exactly this floor without dividing; under one reference the
// floor delivers the identical value from the physics, and an anomalously warm November day now
// reads above 0.5 instead of being pinned, which is the "err toward watering" direction. The ceiling
// is now a true outlier guard rather than a routine operator (11y: it binds on <1% of days; the
// hottest day in the live prod window, 0.288, reaches 1.62).
const DEMAND_CLAMP = { min: 0.5, max: 2.0 };
// The flip gate's single lever (canon Part 5): if the shadow diff shows a median effective-interval
// shift per crop class > +-10%, ONE multiplier is applied here — never hand-edits to 159 profiles.
// Multiplies the whole demand term: >1 shortens effective intervals, <1 lengthens them.
const GLOBAL_NORMALIZATION = 1.0;

// ── Vessel family ────────────────────────────────────────────────────────────────────────────────
// Class factors (canon Part 2 vesselFactor table). NOTE the grouping differs from the rain-credit
// tier taxonomy: raised_bed rides with in_ground here (thermal mass/soil coupling) while it is
// 'intermediate' for rain IA/hold. fabric_bag is handled by the continuous heat ramp below, and the
// tray class is handled by the wi hard cap, so neither appears in this map.
// Unknown/NULL container_type fails toward prompting (small_fast-ish 1.1), same DIRECTION as the rain
// resolvers' unknown fail-safe (most demand / least credit -> water it). Note the rain side no longer
// spells that direction 'small_fast' on both tables — see engine RAIN_VESSEL_TIER and RAIN_DEPTH.unknown.
const VESSEL_CLASS_FACTOR = {
  in_ground: 0.85, raised_bed: 0.85,
  trough: 1.0, whiskey_barrel: 1.0, window_box: 1.0,
  plastic_pot: 1.1, terracotta: 1.1, ceramic: 1.1, pot: 1.1, hanging_basket: 1.1, other: 1.1,
};
const VESSEL_UNKNOWN_FACTOR = 1.1;
// fabric_bag: factor = base + gain x ramp(Tmax, lo -> hi), continuous — replaces the demand-side
// binary >=85F step (canon: the legacy binary gates double-count heat next to ET scaling).
const FABRIC_BAG = { base: 1.1, rampGain: 0.25, rampLoF: 80, rampHiF: 90 };
// tray_cell / soil_block / solo_cup: own class — tablespoons of buffer, dries in hours at 90F.
// wi is HARD-CAPPED at 1 day; unprofiled tray plantings render LOW.
const TRAY_TYPES = ['tray_cell', 'soil_block', 'solo_cup'];
const TRAY_WI_CAP_DAYS = 1;
// Size buckets (multiply the class factor). Parsed from free-text container_size by
// ledger.parseContainerGal; unparseable/ambiguous -> unsized (x1.0 + LOW driver).
const SIZE_BUCKETS = {
  smallMaxGal: 3, smallFactor: 1.3,
  midFactor: 1.0,
  largeMinGal: 15, largeFactor: 0.85,
  unsizedFactor: 1.0,
  bedGal: 100,          // ft-dimension strings ("6x2 ft") parse to bed/large — any value >= largeMinGal
};

// ── Stage family ─────────────────────────────────────────────────────────────────────────────────
// Establishment x1.3 for the first 14 days after a REAL transplant event (p.transplant_at — the
// signal the rain-credit carve-out already uses). Fruiting-load x1.2 is deferred to V1.1 (canon).
const STAGE = { establishmentDays: 14, establishmentFactor: 1.3 };

// ── Credit / bank family ─────────────────────────────────────────────────────────────────────────
const DUE = { droughtHighBias: 1.15 };       // dueThreshold = wi_eff x (drought_tolerance=='high' ? this : 1.0)
// Deep-soak banking — IN-GROUND CLASS (in_ground/raised_bed) or >=15-gal containers ONLY (canon
// Decision 4: banking is physically fictional in a drained vessel; the deficit->soak cycle is the
// textbook BER trigger in bag solanums). Deliberately small: fractional time already fixes the
// evening-soak failure and stacking both over-corrects (canon Part 2, fractional-time note).
const BANK = { deepBankWi: 0.15, bankFloorWi: 0.25 };
// Partial-rewet hedges on a Normal watering of a long-dry profile (D > longDryWi x wi at watering):
//   in-ground class:  D := min(D - wi, inGroundCapWi x wi)   (top of profile wetted, not root zone)
//   container:        D := containerResetWi x wi             (hydrophobic peat channels the shrinkage gap)
// Deep clears both hedges.
const HEDGE = { longDryWi: 1.5, inGroundCapWi: 0.5, containerResetWi: 0.25 };
const LIGHT_CREDIT_WI = 0.5;                 // Light: D := max(0, D - this x wi)
// Gauge/forecast rain day-credits, applied ONCE per qualifying weather_daily day at 23:59 ET,
// floored at 0 (rain never banks negative — the resurfacing guarantee that retires the maxdays
// ceiling; preserved by DRG-RAINDEPTH-001 below, see allowBank).
// ia/hold NO LONGER DRIVE THE FOLD as of DRG-RAINDEPTH-001 — RAIN_DEPTH does. They are retained
// because they still MIRROR engine.js RAIN_TIER_IA / RAIN_TIER_HOLD, which remain live on the
// flag-OFF legacy path, and ledger.test.js pins the two tables equal to catch drift while both
// models coexist. Delete both halves together at the CARE_WATER_LEDGER_ENABLED flip, alongside the
// CARE_RAIN_MAXDAYS removal already owed there.
const RAIN_DAY = {
  // fabric_ground added by BUG-RAINCREDITLIVEPATH-001 purely to hold the mirror equal — these two maps drive
  // NOTHING (only bagHeatSoftenF below is read at runtime); the engine-side row is the one with behaviour.
  ia: { in_ground: 0.20, intermediate: 0.25, small_fast: 0.35, fabric_ground: 0.20 },
  hold: { in_ground: 3, intermediate: 2, small_fast: 1, fabric_ground: 3 },
  // Bag >=85F credit demotion. Keyed to weather_daily.tmax_f of the qualifying day, not today's
  // forecast high. Under RAIN_DEPTH this is a ONE-CLASS DEMOTION (deep->normal->light->nothing)
  // rather than a 0.5x scalar — the scalar had no meaning once the credit stopped being a number of
  // days. bagHeatSoftenFactor/bagHeatMinCreditDays are the LEGACY engine path's form of the same
  // rule; see BUG-HEATDEMOTETOTAL-001 below.
  //
  // CORRECTION 2026-08-17 (crucible D2, 8 seats): this block previously called the rule "SOFTENED".
  // The live record says otherwise. All 7 hot (tmax>=85F) crediting days in the 90-day prod
  // weather_daily window classify as LIGHT, and demoteDepth('light') returns null — so 7 of 7
  // observed firings are TOTAL credit denial, not a one-class softening. "Softened" describes the
  // intent, not the behaviour. Second mismatch worth stating: the rationale is about MULCH
  // interception while the code keys on VESSEL fabric, so a strawed bed gets no demotion and an
  // unmulched bag does. Behaviourally identical today (Dave mulches every bag); recorded because
  // that mismatch is how a correct rule gets deleted later by someone who notices it.
  //
  // DEFERRED REPLACEMENT (crucible verdict C5 — apply at the CARE_WATER_LEDGER_ENABLED flip, NOT
  // now): replace the class step with a depth subtraction, `P_eff = max(0, P - 0.08")` when
  // tmax >= bagHeatSoftenF, then classify P_eff. Rationale: tmax is a gridded model output with
  // +-2-3F error, so a hard class step keyed to a 85F threshold is a discontinuity on noise — a 0.1F
  // move erases ~1.5 cadence-days. The 0.08" form preserves all 7 observed outcomes byte-identically
  // while removing the cliff, and it stays temperature-GATED (an unconditional subtraction would push
  // a 0.10" rain to 0.04" and silently delete the whole Light class for bags year-round).
  // WHY DEFERRED: the whole ledger path is inert behind the flag, the replacement is a second
  // unmeasured tuning stacked on the D1 rescope, and the panel converged on one cheap instrument
  // (weigh a bag / finger-test a mulched vs bare bag after a >=0.2" rain) that has not been run yet.
  // Sequence is measurement -> ET denominator -> rain thresholds -> flip. Do not land this early.
  //
  // BUG-HEATDEMOTETOTAL-001 (2026-08-23) — the LEGACY engine path, which is the one prod runs
  // (CARE_WATER_LEDGER_ENABLED unset, CARE_RAIN_CREDIT_ENABLED=true), had NO demotion at all: it
  // short-circuited `bagHeatGate ? null`, i.e. TOTAL credit denial at every rain depth, and
  // bagHeatSoftenFactor — declared here for exactly that path — was read by nothing. Measured on
  // engine.js for a 5-gal outdoor bag with 0.5" window rain and wi=3: 84F -> 3 credit-days,
  // 85F -> 0, 90F -> 0. engine.js now reads BOTH constants below:
  //     credit := max(bagHeatMinCreditDays, floor(credit x bagHeatSoftenFactor))
  // The MIN is load-bearing, not decoration. It is what makes "demote, never deny" a property of the
  // rule rather than an accident of today's numbers: without it, a retune of the factor below 1/3 —
  // or the flag-OFF 2-class path, whose base credit is already the 1-day minimum — silently restores
  // the denial this fix removes. Same reasoning as the RAIN_DEPTH.unknown derivation above.
  bagHeatSoftenF: 85, bagHeatSoftenFactor: 0.5, bagHeatMinCreditDays: 1,
};
// DRG-RAINDEPTH-001 (2026-08-17, Dave directive) — measured daily precip -> Light/Normal/Deep class,
// per substrate tier. REPLACES the RAIN_DAY.ia cliff + amount-blind `min(hold, wi)` credit, under
// which 0.21" and 2.1" bought an in-ground bed the identical 3 days while a fabric bag got nothing
// from either. Rain now folds through the SAME depth arithmetic as a manual watering, so a sprinkle
// no longer resets a cadence and a real soak is no longer discarded.
// Values are inches of gauge-measured daily precip, read as lower bounds: >=deep is Deep, >=normal
// is Normal, >=light is Light, below light is a trace and earns nothing.
// Provenance: agronomy estimate for the Conway MA site (cool-humid, clay-ish native soil), NOT
// measured. These are the #1 soak-tune target — same posture as RAIN_DAY.ia was (err toward
// watering: raise the thresholds, never lower them, on an unproven shadow-soak).
// TIER HISTORY — read this before retuning any row.
// 2026-08-17 (morning): small_fast was flattened to the in_ground row on Dave's field observation.
// 2026-08-17 (afternoon, crucible D1 REVISE, 8 seats): that edit was RESCOPED, not reverted. Dave's
// report is specifically about 5-10 gal FABRIC BAGS: fabric walls sat ON SOIL (wicking contact),
// mulched or strawed on top (suppressed evaporation), clustered adjacent on a slope (mutual
// shading). Those three properties are what make retention bed-equivalent, and they are properties
// of THAT vessel, not of the small_fast tier. small_fast also carried 87 live plantings that have
// none of them — 61 rigid plastic pots (mostly 2-6in nursery), 15 tray cells, 4 hanging baskets, 3
// solo cups, 2 ceramic, 1 terracotta, 1 soil block. A 4in pot holds ~0.9in of plant-available water
// against a 5-gal bag's ~2.5in, and the compensating heat demotion (RAIN_DAY.bagHeatSoftenF) is
// gated on vessel.isFabric — so those 87 took the full loosening with NO offsetting penalty at any
// temperature. That is the one arm of this model with a plant-death pathway rather than a
// water-waste pathway. Hence:
//   fabric_ground  NEW row, fabric_bag ONLY — bed-equivalent, where the evidence actually applies.
//   small_fast     RESTORED to 0.15/0.40/0.90 — the coarse-vessel-sheds-faster estimate, correct for
//                  a rigid pot even though it was wrong for a strawed bag on soil.
//   intermediate   lowered to the in_ground row. It had ended up STRICTER than small_fast, i.e. a
//                  raised bed / trough / whiskey barrel — the highest-buffer vessels in the table —
//                  needed MORE rain to earn credit than a solo cup. Backwards on both arms.
// The bed-equivalent rows are gated on size at the resolver, not here: engine.rainDepthTierFor only
// hands a fabric_bag the fabric_ground row at vesselProfile().sizeGal >= FABRIC_GROUND_MIN_GAL. This
// table has no size dimension while the demand side is fully size-bucketed, and one live fabric_bag
// is recorded as "3 in" (0.06 gal). Cross-row ordering is pinned by test, not by comment.
const RAIN_DEPTH_TIERS = {
  in_ground:     { light: 0.10, normal: 0.25, deep: 0.60 },
  intermediate:  { light: 0.10, normal: 0.25, deep: 0.60 },
  fabric_ground: { light: 0.10, normal: 0.25, deep: 0.60 },
  small_fast:    { light: 0.15, normal: 0.40, deep: 0.90 },
};
// Unrecognized/NULL container_type (engine rainDepthTierFor -> 'unknown'). The invariant is
// "err toward watering": an unknown vessel gets the LEAST credit, i.e. must clear the HIGHEST bar at
// every class. DERIVED as the per-class max, deliberately not an alias of a named tier and
// deliberately NOT A LITERAL — until 2026-08-17 this fell back to small_fast, which WAS the
// strictest row and silently stopped being one the moment small_fast was revised down to the
// in_ground values. A named alias encodes today's ordering; so does a hardcoded row. The max
// survives any future threshold edit, because it is recomputed from whatever the tiers say.
//
// KEEP THE DERIVATION. It was briefly replaced with the literal {0.15, 0.40, 0.90} during the D1
// rescope on the grounds that a derived max makes its own guard tautological. Both halves of that
// are true and the conclusion still does not follow:
//   - The values are identical either way. Post-rescope the max IS {0.15, 0.40, 0.90}; the earlier
//     objection that it evaluated to {0.10, 0.30, 0.75} was an artifact of small_fast having been
//     flattened, i.e. of the very defect this file's rescope fixes. Deriving costs nothing today.
//   - A literal is correct today and silently stops being correct on the next retune — the SAME
//     failure mode, one turn later. The rescope above moved `intermediate` down to the bed row,
//     which is exactly the class of edit that falsified the last hardcoded fail-safe.
//   - The tautology is real but it is a property of the TEST, not of the value. Handled test-side:
//     ledger.test.js pins (a) what the derivation evaluates to today, as a canary that fires when a
//     retune moves it, (b) unknown >= every named tier at every class — vacuous against the derived
//     form by construction, and deliberately so: it is a CONTRACT test whose job is to go red the
//     moment someone swaps the derivation back out for a literal that has gone stale (mutation-proven
//     in that exact configuration), and (c) unknown STRICTLY > the most-credited tier at every class,
//     which is NOT vacuous even under derivation — it fails if the tiers are ever flattened together,
//     which is the failure this whole file exists to undo.
const RAIN_DEPTH_CLASSES = ['light', 'normal', 'deep'];
const RAIN_DEPTH = {
  ...RAIN_DEPTH_TIERS,
  unknown: Object.fromEntries(RAIN_DEPTH_CLASSES.map((cls) =>
    [cls, Math.max(...Object.values(RAIN_DEPTH_TIERS).map((t) => t[cls]))])),
};
const TRANSPLANT_CARVEOUT_DAYS = 21;         // mirrors engine.TRANSPLANT_CARVEOUT_DAYS (pinned by test)

// ── Snooze / confidence family ───────────────────────────────────────────────────────────────────
// Moisture check ("Not thirsty"): D := min(D, max(0, thr - max(minFloorWi x wi, demand(day)))).
// The demand term is what makes the snooze survive to at least tomorrow's run (canon: a snooze that
// resurfaces in hours reads as the app overriding the user). The max(0,·) floor keeps a snooze from
// ever BANKING water — on a wi=1 planting in a 2.0-demand heat wave the target would go negative;
// physically that means even D=0 re-dues tomorrow, which is the honest answer.
const SNOOZE = { minFloorWi: 0.5 };
const CONFIDENCE = {
  minWeatherRows: 7,        // <7 weather_daily rows in the window -> Space degenerate: demand 1.0 flat + LOW driver
  overrideDemoteCount: 2,   // >=2 moisture_check taps in the window demote one tier (F2 approximation
                            // of the canon 5-due-cycle override rate; full cycle tracking is F3+)
};

const WINDOW_DAYS = 30;      // fold lookback; MUST equal handler.WEATHER_DAILY_WINDOW_DAYS (pinned by test)

module.exports = {
  ET0_REF_PEAK, DEMAND_CLAMP, GLOBAL_NORMALIZATION,
  VESSEL_CLASS_FACTOR, VESSEL_UNKNOWN_FACTOR, FABRIC_BAG, TRAY_TYPES, TRAY_WI_CAP_DAYS, SIZE_BUCKETS,
  STAGE, DUE, BANK, HEDGE, LIGHT_CREDIT_WI, RAIN_DAY, RAIN_DEPTH, RAIN_DEPTH_TIERS, RAIN_DEPTH_CLASSES,
  TRANSPLANT_CARVEOUT_DAYS,
  SNOOZE, CONFIDENCE, WINDOW_DAYS,
};
