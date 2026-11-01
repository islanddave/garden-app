'use strict';
// The ONE table-driven params module for every tuned Water Ledger constant (V4-WATERMATH-001 F2; canon
// watering-cadence-math-design-V100-20260812.md Part 5): bank magnitudes, hedge thresholds, vessel/size
// factors, ramps, clamp bounds, snooze floor, confidence thresholds, and the flip gate's global
// normalization multiplier.
//
// Everything here is a POLICY NUMBER, not code: the fold (ledger.js) and the engine branch read these and
// only these. Retuning for the flip gate is an edit to THIS file (or, for the whole-system case, to
// GLOBAL_NORMALIZATION alone), never a hunt through the fold.

// ── Demand family ────────────────────────────────────────────────────────────────────────────────
// ET0_REF_PEAK: ONE site-wide climatological reference, inches/day, for the one live Space. NEVER a
// rolling median (canon Decision 2): a rolling median is a high-pass filter that re-centers onto a heat
// wave within about a week (demand -> 1.0 exactly in the lethal window) and deletes the fall decline.
//
// WHY THIS IS A SCALAR AND MUST STAY ONE (BUG-ETNOAMPLITUDE-001). The denominator used to be a twelve-entry
// per-month table whose entries were the measured mean of that same month. Dividing each day's ET0 by its
// own month's mean re-centers every month on 1.0 and subtracts the entire seasonal signal: the same
// high-pass defect as the rolling median, precomputed. The curve even inverted (October and March read
// hotter than July), and the model SHORTENED fall watering intervals as evapotranspiration fell. A single
// denominator makes the multiplier ET0(day)/ET0(peak season), which carries the full seasonal amplitude
// and cannot be re-centered by a later retune. Never go back to a per-period table, and do not "refresh"
// the reference per month (the shadow soak's maintenance step once suggested it).
//
// PROVENANCE: MEASURED. 0.1775 in/day is the mean of every July day, 2015-2025, from the Open-Meteo ERA5
// archive at the Space's coordinates, via the same endpoint/fields/units scripts/backfill-weather-daily.mjs
// writes weather_daily from (archive-api.open-meteo.com, daily=et0_fao_evapotranspiration,
// temperature_unit=fahrenheit, precipitation_unit=inch, timezone=America/New_York). July is the annual
// peak. The per-year spread is weather, which the daily ET0 numerator carries; the reference is a
// climatological anchor, not a forecast.
//
// The LEVEL is a tuning choice; the AMPLITUDE is not. Any single denominator restores the same seasonal
// SHAPE; the value only sets where 1.0 sits. Peak-season holds the summer level almost exactly where both
// the legacy engine and the earlier ledger put it (mean multiplier moved +4.1% on the live window, inside
// the flip gate's +-10% band), so it changes autumn without silently re-tuning summer. If the shadow soak
// says the level is wrong, move GLOBAL_NORMALIZATION, never this constant.
const ET0_REF_PEAK = 0.1775;
// Clamp bounds on ET0(day)/ET0_REF_PEAK. The floor caps the autumn stretch at 2x the researched interval
// and binds from roughly Oct 1 onward; it also replaced the old `ref < WINTER_REF_MIN` winter-mode branch,
// since under one reference the floor delivers the same value from the physics, and an anomalously warm
// November day reads above 0.5 instead of being pinned (the "err toward watering" direction). The ceiling
// is an outlier guard, not a routine operator.
const DEMAND_CLAMP = { min: 0.5, max: 2.0 };
// The flip gate's single lever (canon Part 5): if the shadow diff shows a median effective-interval shift
// per crop class beyond +-10%, ONE multiplier is applied here, never hand-edits to the cadence profiles.
// Multiplies the whole demand term: >1 shortens effective intervals, <1 lengthens them.
const GLOBAL_NORMALIZATION = 1.0;

// ── Vessel family ────────────────────────────────────────────────────────────────────────────────
// Class factors (canon Part 2 vesselFactor table). NOTE the grouping differs from the rain-credit tier
// taxonomy: raised_bed rides with in_ground here (thermal mass/soil coupling) while it is 'intermediate'
// for rain IA/hold. fabric_bag is handled by the continuous heat ramp below and the tray class by the wi
// hard cap, so neither appears in this map.
// Unknown/NULL container_type fails toward prompting (1.1), the same DIRECTION as the rain resolvers'
// unknown fail-safe (most demand / least credit -> water it).
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
// Establishment x1.3 for the first 14 days after a REAL transplant event (p.transplant_at, the signal the
// rain-credit carve-out already uses). Fruiting-load x1.2 is deferred to V1.1 (canon).
const STAGE = { establishmentDays: 14, establishmentFactor: 1.3 };

// ── Credit / bank family ─────────────────────────────────────────────────────────────────────────
const DUE = { droughtHighBias: 1.15 };       // dueThreshold = wi_eff x (drought_tolerance=='high' ? this : 1.0)
// Deep-soak banking: IN-GROUND CLASS (in_ground/raised_bed) or >=15-gal containers ONLY (canon Decision 4:
// banking is physically fictional in a drained vessel, and the deficit->soak cycle is the textbook BER
// trigger in bag solanums). Deliberately small: fractional time already fixes the evening-soak failure and
// stacking both over-corrects (canon Part 2, fractional-time note).
const BANK = { deepBankWi: 0.15, bankFloorWi: 0.25 };
// Partial-rewet hedges on a Normal watering of a long-dry profile (D > longDryWi x wi at watering):
//   in-ground class:  D := min(D - wi, inGroundCapWi x wi)   (top of profile wetted, not root zone)
//   container:        D := containerResetWi x wi             (hydrophobic peat channels the shrinkage gap)
// Deep clears both hedges.
const HEDGE = { longDryWi: 1.5, inGroundCapWi: 0.5, containerResetWi: 0.25 };
const LIGHT_CREDIT_WI = 0.5;                 // Light: D := max(0, D - this x wi)
// Gauge/forecast rain day-credits, applied ONCE per qualifying weather_daily day at 23:59 ET, floored at 0
// (rain never banks negative: the resurfacing guarantee that retires the maxdays ceiling; see allowBank in
// ledger.js).
// ia/hold NO LONGER DRIVE THE FOLD (RAIN_DEPTH does). They are retained because they MIRROR engine.js
// RAIN_TIER_IA / RAIN_TIER_HOLD, which remain live on the flag-OFF legacy path, and ledger.test.js pins
// the two tables equal to catch drift while both models coexist. Delete both halves together at the
// CARE_WATER_LEDGER_ENABLED flip, alongside the CARE_RAIN_MAXDAYS removal owed there.
const RAIN_DAY = {
  // These two maps drive NOTHING (only bagHeatSoftenF below is read at runtime); the engine-side rows are
  // the ones with behaviour. They are derived/kept equal to the engine's, and the lockstep test in this
  // directory compares them to engine.RAIN_TIER_IA/HOLD with toEqual, so a one-sided edit reds there
  // rather than drifting quietly.
  ia: { in_ground: 0.20, intermediate: 0.25, small_fast: 0.17, fabric_ground: 0.20, unknown: 0.25 },
  hold: { in_ground: 3, intermediate: 2, small_fast: 1, fabric_ground: 3, unknown: 1 },
  // Bag >=85F credit demotion. Keyed to weather_daily.tmax_f of the qualifying day, not today's forecast
  // high. Under RAIN_DEPTH this is a ONE-CLASS DEMOTION (deep->normal->light->nothing), not a 0.5x scalar:
  // the scalar had no meaning once the credit stopped being a number of days. bagHeatSoftenFactor and
  // bagHeatMinCreditDays are the LEGACY engine path's form of the same rule (see below).
  //
  // Behaviour is TOTAL denial for a Light day, not a softening: demoteDepth('light') returns null, and on
  // the observed record every hot crediting day classified Light. "Softened" describes the intent, not the
  // behaviour. Second mismatch: the rationale is MULCH interception while the code keys on VESSEL fabric, so
  // a strawed bed gets no demotion and an unmulched bag does. Recorded because that mismatch is how a
  // correct rule gets deleted later by someone who notices it.
  //
  // DEFERRED REPLACEMENT (crucible verdict C5, apply at the CARE_WATER_LEDGER_ENABLED flip, NOT before):
  // replace the class step with a depth subtraction, `P_eff = max(0, P - 0.08")` when tmax >=
  // bagHeatSoftenF, then classify P_eff. tmax is a gridded output with +-2-3F error, so a hard class step
  // keyed to 85F is a discontinuity on noise. The 0.08" form preserves all observed outcomes while
  // removing the cliff, and stays temperature-GATED (an unconditional subtraction would push 0.10" to
  // 0.04" and delete the Light class for bags year-round). Deferred because the ledger path is inert
  // behind the flag and the replacement would be a second unmeasured tuning; the order is measurement ->
  // ET denominator -> rain thresholds -> flip. Do not land it early.
  //
  // LEGACY engine path (BUG-HEATDEMOTETOTAL-001): the path prod runs (CARE_WATER_LEDGER_ENABLED unset)
  // used to short-circuit `bagHeatGate ? null`, i.e. TOTAL credit denial at every depth, and
  // bagHeatSoftenFactor was read by nothing. engine.js now reads BOTH constants below:
  //     credit := max(bagHeatMinCreditDays, floor(credit x bagHeatSoftenFactor))
  // The MIN is load-bearing: it makes "demote, never deny" a property of the rule, so a retune of the
  // factor below 1/3, or the flag-OFF 2-class path whose base credit is already the 1-day minimum, cannot
  // silently restore the denial.
  bagHeatSoftenF: 85, bagHeatSoftenFactor: 0.5, bagHeatMinCreditDays: 1,
};
// DRG-RAINDEPTH-001: measured daily precip -> Light/Normal/Deep class, per substrate tier. REPLACES the
// RAIN_DAY.ia cliff + amount-blind `min(hold, wi)` credit, under which 0.21" and 2.1" bought an in-ground
// bed the identical 3 days. Rain now folds through the SAME depth arithmetic as a manual watering, so a
// sprinkle no longer resets a cadence and a real soak is no longer discarded.
// Values are inches of gauge-measured daily precip, read as lower bounds: >=deep is Deep, >=normal is
// Normal, >=light is Light, below light is a trace and earns nothing.
// Provenance: agronomy estimate for the site (cool-humid, clay-ish native soil), NOT measured. These are
// the #1 soak-tune target; err toward watering: raise the thresholds, never lower them, on an unproven
// shadow-soak.
//
// TIER RATIONALE, read before retuning any row. The bed-equivalent retention applies to 5-10 gal FABRIC
// BAGS specifically: fabric walls sit ON SOIL (wicking contact), are mulched or strawed on top (suppressed
// evaporation) and cluster adjacent on a slope (mutual shading). Those are properties of that vessel, not
// of the small_fast tier, which also carries rigid pots, tray cells, hanging baskets and solo cups with
// none of them. A small pot holds a fraction of a bag's plant-available water, and the compensating heat
// demotion (RAIN_DAY.bagHeatSoftenF) is gated on vessel.isFabric, so loosening small_fast would give those
// vessels the full loosening with NO offsetting penalty: the one arm of this model with a plant-death
// pathway rather than a water-waste pathway. Hence:
//   fabric_ground  fabric_bag ONLY, bed-equivalent, where the evidence applies.
//   small_fast     0.15/0.40/0.90: the coarse-vessel-sheds-faster estimate, right for a rigid pot.
//   intermediate   equal to the in_ground row. It must never be STRICTER than small_fast: a raised bed,
//                  trough or whiskey barrel (the highest-buffer vessels) cannot need more rain to earn
//                  credit than a solo cup.
// The bed-equivalent rows are gated on size at the resolver, not here: engine.rainDepthTierFor only hands a
// fabric_bag the fabric_ground row at vesselProfile().sizeGal >= FABRIC_GROUND_MIN_GAL. This table has no
// size dimension while the demand side is fully size-bucketed. Cross-row ordering is pinned by test.
const RAIN_DEPTH_TIERS = {
  in_ground:     { light: 0.10, normal: 0.25, deep: 0.60 },
  intermediate:  { light: 0.10, normal: 0.25, deep: 0.60 },
  fabric_ground: { light: 0.10, normal: 0.25, deep: 0.60 },
  small_fast:    { light: 0.15, normal: 0.40, deep: 0.90 },
};
// Unrecognized/NULL container_type (engine rainDepthTierFor -> 'unknown'). The invariant is "err toward
// watering": an unknown vessel gets the LEAST credit, i.e. must clear the HIGHEST bar at every class.
// DERIVED as the per-class max, deliberately not an alias of a named tier and NOT A LITERAL: a named alias
// or hardcoded row encodes today's ordering and silently stops being the strictest row after the next
// retune (it happened once when small_fast was revised down).
//
// KEEP THE DERIVATION. A literal is correct today and wrong after the next retune, the same failure one
// turn later. The derived form makes its own guard tautological, but that is a property of the TEST, handled
// test-side: ledger.test.js pins (a) what the derivation evaluates to today, a canary for retunes; (b)
// unknown >= every named tier at every class, a CONTRACT test that goes red if someone swaps the derivation
// for a stale literal (mutation-proven in that configuration); and (c) unknown STRICTLY > the most-credited
// tier at every class, which is not vacuous and fails if the tiers are ever flattened together.
const RAIN_DEPTH_CLASSES = ['light', 'normal', 'deep'];
const RAIN_DEPTH = {
  ...RAIN_DEPTH_TIERS,
  unknown: Object.fromEntries(RAIN_DEPTH_CLASSES.map((cls) =>
    [cls, Math.max(...Object.values(RAIN_DEPTH_TIERS).map((t) => t[cls]))])),
};
const TRANSPLANT_CARVEOUT_DAYS = 21;         // mirrors engine.TRANSPLANT_CARVEOUT_DAYS (pinned by test)

// ── Snooze / confidence family ───────────────────────────────────────────────────────────────────
// Moisture check ("Not thirsty"): D := min(D, max(0, thr - max(minFloorWi x wi, demand(day)))).
// The demand term makes the snooze survive to at least tomorrow's run (a snooze that resurfaces in hours
// reads as the app overriding the user). The max(0,·) floor keeps a snooze from ever BANKING water: where
// the target would go negative (wi=1 in a heat wave), even D=0 re-dues tomorrow, which is the honest answer.
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
