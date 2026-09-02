// DRG-BACKBONE-001 P0 / G-PARITY — representative fixture set for the daily-plan golden parity gate.
//
// §13 G-PARITY requires goldens that exercise "all branches: rain-credit, dormant-skip,
// harvested-keep-water, CARESTATUS check-off, WX/WXROLL/WXLOC". Each scenario is a FROZEN, fully-specified
// engine input (plantings + weather + hydrology + today + ownerFallback) chosen to land on a distinct
// engine branch. Inputs are pinned (fixed dates, weather, precip) so generatePlan is deterministic and the
// captured golden is byte-stable. The bundled cadence + fertilization model are the engine's own data files
// (part of its deterministic inputs); plantings mostly carry an explicit _seeded db_cadence so a scenario's
// branch does not depend on cadence-data drift, with one real-variety planting (Cayenne) to exercise the
// by_variety resolution path.
//
// Loaded by both the vitest parity test and scripts/parity/capture-daily-plan-golden.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import engineMod from '../../../lambda/daily-plan/engine.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const DP = '../../../lambda/daily-plan/';
export const cadence = JSON.parse(readFileSync(here(DP + 'cadence-data-v2.json'), 'utf8'));
export const fertModel = JSON.parse(readFileSync(here(DP + 'fertilization-model.json'), 'utf8'));
export const engine = engineMod;

// Reusable seeded cadence profiles — explicit so a scenario's branch is robust to cadence-data edits.
const PEPPER = { _seeded: true, crop: 'pepper', water_interval_days_container: 3, water_method: 'deep_even', soil_moisture_target: 'evenly_moist', drought_tolerance: 'medium', cold: { tender: true, protect_below_F: 45 }, fertilize_interval_days: 14 };
const TOMATO = { _seeded: true, crop: 'tomato', water_interval_days_container: 2, water_method: 'deep_even', soil_moisture_target: 'evenly_moist', drought_tolerance: 'low', cold: { tender: true, protect_below_F: 45 }, fertilize_interval_days: 14 };
const LETTUCE = { _seeded: true, crop: 'lettuce', water_interval_days_container: 2, water_method: 'light_frequent', soil_moisture_target: 'consistently_moist', drought_tolerance: 'low', cold: { tender: false, protect_below_F: 25 }, fertilize_interval_days: 21 };
// Explicit in_ground interval so the today-rain scenarios exercise the inground cadence key (a bare
// water_interval_days leaves the planting in NO bucket, silently — verified landmine).
const INGROUND_TOMATO = { _seeded: true, crop: 'tomato', water_interval_days_container: 2, water_interval_days_inground: 4, water_method: 'deep_even', soil_moisture_target: 'evenly_moist', drought_tolerance: 'medium', cold: { tender: true, protect_below_F: 45 }, fertilize_interval_days: 14 };

// ── BUG-TODAYWATER-001 goldens — today-QUALIFYING inputs (today_precip_in >= SOAK_FCST_QPF_IN @ pop >= SOAK_FCST_POP_PCT).
// The original 8 scenarios all carry today_precip_in ~0, so the parity gate was BLIND to the entire today
// branch (crucible mutation test: hard-wiring the production defect killed only 2 tests). Each input below is
// captured TWICE — flag OFF (pins that CARE_TODAY_AWARE_ENABLED unset stays byte-identical to the pre-change
// engine, incl. the part-prediction soak basis wp=recent+forecast) and flag ON (pins the reviewed today-branch
// verdicts: small-vessel SOAK_TODAY_SMALL_IN bar, in-ground general bar, 'today' subordinate to
// bagHeatGate/freshTransplant, covered exemption). Scenario objects share one frozen input; the engine does
// not mutate plantings.
// TODAY_MODERATE: 1.0" @ 80% forecast, 0.2" recent, 86°F (>= BAG_HEAT_GATE_F 85, < HOT_F 88).
//   flag-OFF: windowPrecip 1.2 >= SOAK_CAP_IN -> ALL outdoor soak-suppressed (forecast counted in the basis).
//   flag-ON: soak judges actuals (0.2) only -> solo_cup WATERS (1.0 < 2.0 small bar, rain-credit note),
//            in_ground SKIPS kind 'today' (1.0 >= 0.5), fabric bag WATERS (heat gate outranks the forecast),
//            covered lettuce waters under both flags.
const TODAY_MODERATE = {
  today: '2026-08-03',
  weather: { tonightLow: 68, highToday: 86, code: 61, short: 'Rain developing', unit: 'F' },
  hydrology: { recent_precip_in: 0.2, today_precip_in: 1.0, today_pop: 80, upcoming_precip_in: 0.1, tomorrow_precip_in: 0.1, tomorrow_pop: 20 },
  ownerFallback: 'dave',
  rainCreditEnabled: false,
  plantings: [
    P({ id: 'sv1', name: 'Bench Pepper Cell', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', container_type: 'solo_cup', container_size: '0.5 qt', substrate_start: '2026-06-01', transplant_at: '2026-06-01', last_water: '2026-07-30', covered: false, db_cadence: PEPPER }),
    P({ id: 'bed1', name: 'Main Bed Tomato', variety: 'Beefsteak', genus: 'Solanum', status: 'fruiting', container_type: 'in_ground', container_size: null, substrate_start: '2026-06-01', transplant_at: '2026-06-01', last_water: '2026-07-29', covered: false, db_cadence: INGROUND_TOMATO }),
    P({ id: 'fb1', name: 'Deck Bag Tomato', variety: 'Beefsteak', genus: 'Solanum', status: 'fruiting', container_type: 'fabric_bag', container_size: '7 gal', substrate_start: '2026-06-01', transplant_at: '2026-06-01', last_water: '2026-07-30', covered: false, db_cadence: TOMATO }),
    P({ id: 'cv1', name: 'Covered Shelf Lettuce', variety: 'Buttercrunch', genus: 'Lactuca', status: 'vegetative', container_type: 'pot', container_size: '2 gal', substrate_start: '2026-06-01', transplant_at: '2026-06-01', last_water: '2026-07-31', covered: true, db_cadence: LETTUCE }),
  ],
};
// TODAY_HEAVY: 2.5" @ 90% forecast, 0 recent, mild 78°F (no heat gates).
//   flag-OFF: windowPrecip 2.5 -> ALL outdoor soak-suppressed (incl. the fresh transplant — soak outranks it).
//   flag-ON: established solo_cup SKIPS kind 'today' (2.5 >= SOAK_TODAY_SMALL_IN 2.0), fresh tray_cell WATERS
//            (freshTransplant outranks the forecast), in_ground SKIPS kind 'today'.
const TODAY_HEAVY = {
  today: '2026-08-03',
  weather: { tonightLow: 66, highToday: 78, code: 63, short: 'Heavy rain', unit: 'F' },
  hydrology: { recent_precip_in: 0, today_precip_in: 2.5, today_pop: 90, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave',
  rainCreditEnabled: false,
  plantings: [
    P({ id: 'sv1', name: 'Bench Pepper Cell', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', container_type: 'solo_cup', container_size: '0.5 qt', substrate_start: '2026-06-01', transplant_at: '2026-06-01', last_water: '2026-07-30', covered: false, db_cadence: PEPPER }),
    P({ id: 'ft1', name: 'Fresh Pepper Cell', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', container_type: 'tray_cell', container_size: '0.5 qt', substrate_start: '2026-07-29', transplant_at: '2026-07-29', last_water: '2026-07-30', covered: false, db_cadence: PEPPER }),
    P({ id: 'bed1', name: 'Main Bed Tomato', variety: 'Beefsteak', genus: 'Solanum', status: 'fruiting', container_type: 'in_ground', container_size: null, substrate_start: '2026-06-01', transplant_at: '2026-06-01', last_water: '2026-07-29', covered: false, db_cadence: INGROUND_TOMATO }),
  ],
};

// ── BUG-PARITYFLAGBLIND-001 goldens — CARE_RAIN_CREDIT_ENABLED coverage.
// planFor never passed rainCreditEnabled, so it defaulted false (engine.js:811) and EVERY scenario — including
// rain-credit-skip, whose 0.6" looks like rain-credit coverage — ran the flag-OFF branch. RAIN_TIER_IA,
// RAIN_TIER_HOLD and rainTierFor were unreachable from this gate while prod runs the flag ON, which is why the
// gate stayed green through six mutations of the tier tables. Every scenario now DECLARES rainCreditEnabled
// (guarded by the harness self-test below) and these two inputs are captured under BOTH configurations.
// RAIN_TIER_KNIFE: 0.35" window rain, established outdoor 'pot' (small_fast tier), exactly due (dW 3 = wi 3).
//   flag-OFF: RAIN_IA.outdoor 0.25 -> eff 0.10 -> credited -> rain_skipped.
//   flag-ON:  RAIN_TIER_IA.small_fast 0.35 -> eff 0 -> NO credit -> waters, and the note prints the tier IA.
//   Sits ON the small_fast IA, so any retune of that constant flips the bucket AND the note (falsifiability).
const RAIN_TIER_KNIFE = {
  today: '2026-06-22',
  weather: { tonightLow: 60, highToday: 80, code: 1, short: 'Clearing', unit: 'F' },
  hydrology: { recent_precip_in: 0.35, today_precip_in: 0, today_pop: 10, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave',
  plantings: [
    P({ id: 'rk1', name: 'Deck Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'pot', container_size: '5 gal', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-06-19', covered: false, db_cadence: PEPPER }),
  ],
};
// RAIN_TIER_VESSELS: 0.30" window rain across the two tiers prod actually lands on.
//   nv1 — NULL container_type (~22 such rows in prod): rainTierFor's 'small_fast' FALLBACK, IA 0.35 -> no credit
//         under the flag, so it waters. Pins the fail-safe direction of the fallback: re-pointing it at
//         intermediate/in_ground (IA 0.25/0.20) would credit it and flip this golden.
//   bed2 — in_ground: IA 0.20 -> credited, and RAIN_TIER_HOLD.in_ground 3 gives credited_days 3 vs the
//         flag-OFF RAIN_HOLD_DAYS 1, so the hold table is pinned too.
const RAIN_TIER_VESSELS = {
  today: '2026-06-22',
  weather: { tonightLow: 60, highToday: 79, code: 1, short: 'Clearing', unit: 'F' },
  hydrology: { recent_precip_in: 0.30, today_precip_in: 0, today_pop: 10, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave',
  plantings: [
    P({ id: 'nv1', name: 'Unlabelled Vessel Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: null, container_size: null, substrate_start: '2026-05-01', transplant_at: null, last_water: '2026-06-19', covered: false, db_cadence: PEPPER }),
    P({ id: 'bed2', name: 'Main Bed Tomato', variety: 'Beefsteak', genus: 'Solanum', status: 'fruiting', container_type: 'in_ground', container_size: null, substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-06-18', covered: false, db_cadence: INGROUND_TOMATO }),
  ],
};
// RAIN_TIER_FABRIC: 0.30" window rain across three fabric bags that differ ONLY in container_size, so the
// size gate is the only variable in play. BUG-RAINCREDITLIVEPATH-001 added RAIN_TIER_IA/HOLD.fabric_ground
// (0.20 / 3) behind rainTierFor's >= FABRIC_GROUND_MIN_GAL (3 gal) gate; KNIFE and VESSELS reach the tier
// path but never that row, so without this pair the gate stays blind to it (verified: setting
// RAIN_TIER_IA.fabric_ground = -99 left the parity suite 36/36 green).
//   fg1 — '5 gal' (Dave's modal bag, 76 of 80 active bags are >= 3 gal): promotes to fabric_ground, IA 0.20
//         -> eff 0.10 -> credited, and RAIN_TIER_HOLD.fabric_ground 3 gives credited_days 3. The PEPPER
//         3-day interval is deliberate: credit_days is min(hold, wi), so on a 2-day cadence a hold of 2, 3 or
//         99 would all read 2 and the hold value would not actually be pinned.
//   fg2 — '3 in' (0.06 gal — the one live below-gate bag): stays small_fast, IA 0.35 -> no credit -> waters.
//   fg3 — unsized: sizeGal null -> stays small_fast -> waters. Pins the fail-safe direction of an unparseable
//         or absent size.
// Because all three are the same container_type, fg1 diverging from fg2/fg3 pins the gate itself AND the call
// site passing sizeGal through: a silent revert to the one-arg rainTierFor collapses fg1 onto fg2.
const RAIN_TIER_FABRIC = {
  today: '2026-06-22',
  weather: { tonightLow: 60, highToday: 79, code: 1, short: 'Clearing', unit: 'F' },
  hydrology: { recent_precip_in: 0.30, today_precip_in: 0, today_pop: 10, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave',
  plantings: [
    P({ id: 'fg1', name: 'Big Bag Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'fabric_bag', container_size: '5 gal', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-06-19', covered: false, db_cadence: PEPPER }),
    P({ id: 'fg2', name: 'Small Bag Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'fabric_bag', container_size: '3 in', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-06-19', covered: false, db_cadence: PEPPER }),
    P({ id: 'fg3', name: 'Unsized Bag Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'fabric_bag', container_size: null, substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-06-19', covered: false, db_cadence: PEPPER }),
  ],
};

// BUG-CADENCESIZE-001 — VESSEL_FLOOR: the only scenario that reaches dailyFloorFor's decision.
// Before it was added, the gate carried no trough, no whiskey_barrel and no rigid pot at or above
// SIZE_BUCKETS.largeMinGal, so the entire vessel floor could be deleted without moving a single golden.
//
// One frozen input, nine plantings on a 1-day cadence. Eight sit at dW=1 (last_water 08-17, today 08-18)
// — precisely the knife edge where a floor of 2 is the difference between due and not due. Three must move
// off the list and four must stay on it, so the scenario discriminates in BOTH directions:
//   tr1  trough '6x2 ft'        -> floored, NOT due   (the clearest live mis-assignment: 4 prod peppers)
//   wb1  whiskey_barrel '15 gall' -> floored, NOT due (through the live size typo, so the parse is pinned)
//   cer1 ceramic '15 gal'       -> floored, NOT due   (rigid pot qualifying on PARSED volume)
//   fb2  fabric_bag '10 gal'    -> NOT floored, DUE   (the bulk of the live bag population, 31 prod rows)
//   fb3  fabric_bag '20 gal'    -> NOT floored, DUE   (the deliberate exclusion, and the ONLY row here that
//                                                      pins it: at 10 gal a bag is below largeMinGal anyway,
//                                                      so folding fabric into the rigid set leaves fb2
//                                                      unmoved and the golden green — verified by mutation.
//                                                      This is the live Jet Star case, whose own profile
//                                                      says "20-gal bag min ... 1-2 gal am+pm in 85F+")
//   pp2  plastic_pot '6 in'     -> NOT floored, DUE   (small rigid: the threshold is real, not decorative)
//   pp3  plastic_pot NULL size  -> NOT floored, DUE   (THE fail-safe row, and the largest uncertain live
//                                                      population: 24 active plantings are a rigid type with
//                                                      no recorded size, including the "Bag Area" rows that
//                                                      photos suggest are really fabric bags. An unparseable
//                                                      size must never read as large — without this row the
//                                                      mutation that treats unknown as >= largeMinGal
//                                                      SURVIVED this gate. It is also why the change is safe
//                                                      to ship ahead of the data cleanup: recorded-as-pot and
//                                                      actually-a-bag both land here, both keep wi=1.)
//   nv3  NULL container_type    -> NOT floored, DUE   (fail-safe: unknown vessel keeps today's behaviour)
// The eighth pins the floor's VALUE, not just its existence:
//   tr2  trough '6x2 ft' at dW=2 -> DUE with interval 2, overdue_by 0. At dW=1 every floored row is absent
//        from the payload whatever the floor is, so a floor of 3 or 4 — or switching to the `_inground`
//        arm (3 here) — produced a byte-identical golden and this gate could not see the difference.
//        Verified by mutation: before tr2 existed, DAILY_FLOOR_DAYS 2->4 and the inground-arm swap both
//        SURVIVED the parity gate while the unit suite killed them. tr2 is due at 2 and not due at 3+, so
//        the magnitude is now pinned here too.
// Dry hydrology and 79F on purpose: no rain credit, no saturation cap, no bag heat gate and no >=88F heat
// gate, so the ONLY thing separating these rows is the vessel floor.
// rainCreditEnabled: true — prod's live configuration (CARE_RAIN_CREDIT_ENABLED=true). With zero rain in
// the window the flag changes no verdict here, so there is no flag PAIR: pairing it would pin the flag,
// not the floor, and this scenario exists to pin the floor.
const DAILY_CROP = { _seeded: true, crop: 'pepper', water_interval_days_container: 1, water_interval_days_inground: 3, water_method: 'deep_even', soil_moisture_target: 'evenly_moist', drought_tolerance: 'medium', cold: { tender: true, protect_below_F: 45 }, fertilize_interval_days: 14 };
const VESSEL_FLOOR = {
  today: '2026-08-18',
  weather: { tonightLow: 62, highToday: 79, code: 1, short: 'Clearing', unit: 'F' },
  hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave',
  rainCreditEnabled: true,
  plantings: [
    P({ id: 'tr1', name: 'Trough Jalapeno', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'trough', container_size: '6x2 ft', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-08-17', covered: false, db_cadence: DAILY_CROP }),
    P({ id: 'tr2', name: 'Trough Serrano', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'trough', container_size: '6x2 ft', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-08-16', covered: false, db_cadence: DAILY_CROP }),
    P({ id: 'wb1', name: 'Barrel Habanero', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'whiskey_barrel', container_size: '15 gall', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-08-17', covered: false, db_cadence: DAILY_CROP }),
    P({ id: 'cer1', name: 'Ceramic Coleus', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', container_type: 'ceramic', container_size: '15 gal', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-08-17', covered: false, db_cadence: DAILY_CROP }),
    P({ id: 'fb2', name: 'Ten Gallon Bag Tomato', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'fabric_bag', container_size: '10 gal', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-08-17', covered: false, db_cadence: DAILY_CROP }),
    P({ id: 'fb3', name: 'Twenty Gallon Bag Tomato', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'fabric_bag', container_size: '20 gal', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-08-17', covered: false, db_cadence: DAILY_CROP }),
    P({ id: 'pp2', name: 'Six Inch Pot Basil', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', container_type: 'plastic_pot', container_size: '6 in', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-08-17', covered: false, db_cadence: DAILY_CROP }),
    P({ id: 'pp3', name: 'Bag Area Unsized Pot', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'plastic_pot', container_size: null, substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-08-17', covered: false, db_cadence: DAILY_CROP }),
    P({ id: 'nv3', name: 'Unlabelled Vessel Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: null, container_size: null, substrate_start: '2026-05-01', transplant_at: null, last_water: '2026-08-17', covered: false, db_cadence: DAILY_CROP }),
  ],
};

// ── BUG-PARITYGOLDENSBLIND-001 — the two temperature KNIFE EDGES.
// Every temperature in the 21 pre-existing goldens sat clear of both thresholds: 78/79/80/82 well below,
// 86 between them, 90/92 above both. Mutation-measured consequence — HOT_F anywhere in [87,90] and
// BAG_HEAT_GATE_F anywhere in [80,86] left ALL 21 goldens BYTE-IDENTICAL, so the live temperature response
// was retunable by three degrees against a fully green suite. Same failure shape as BUG-PARITYFLAGBLIND-001
// (coverage that names a branch without straddling its boundary), one level down: these scenarios reached
// the heat code, they just never reached its edge.
//
// Each input is captured on BOTH sides of one threshold, one degree apart, so the golden pair pins the
// constant to a single value in both directions: drop it and the cooler golden moves, raise it and the
// hotter one does. The two pairs are deliberately isolated from each other — the HEAT pair carries no
// fabric bag and no rain, the BAG pair sits at 84/85 where `hot` is false either way — so a mutation of
// one constant moves exactly one pair and the failure names its own cause.

// HEAT_KNIFE: HOT_F (88), the drought-cadence accelerator. Dry window, rigid pots, no bag anywhere.
//   hk1 — TOMATO, drought_tolerance 'low', wi 2, dW 2: the ONLY shape the accelerator acts on. At 87 it is
//         due at interval 2 / overdue 0; at 88 `hot` walks wi to 1, so it reads interval 1 / overdue 1.
//   hk2 — PEPPER, drought_tolerance 'medium', wi 3, dW 3: due at interval 3 on BOTH sides. Pins the
//         drought-tolerance scoping — widening the accelerator to every crop moves this row, not hk1's.
// The top-level `hot` boolean flips across the pair too, so even a future engine that retires the wi
// decrement keeps a sensitive golden here.
// NOTE (not a defect this fixture can fix): computeCallout tests `high >= 88` as a LITERAL, not HOT_F, so
// the callout divergence across this pair is NOT evidence of HOT_F sensitivity — the wi/`hot` divergence is.
const HEAT_KNIFE = {
  today: '2026-07-15',
  hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave',
  rainCreditEnabled: false,
  plantings: [
    P({ id: 'hk1', name: 'Knife Tomato', variety: 'Beefsteak', genus: 'Solanum', status: 'fruiting', container_type: 'pot', container_size: '5 gal', substrate_start: '2026-04-01', transplant_at: '2026-04-01', last_water: '2026-07-13', covered: false, db_cadence: TOMATO }),
    P({ id: 'hk2', name: 'Knife Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'pot', container_size: '5 gal', substrate_start: '2026-04-01', transplant_at: '2026-04-01', last_water: '2026-07-12', covered: false, db_cadence: PEPPER }),
  ],
};
// BAG_KNIFE: BAG_HEAT_GATE_F (85), the fabric-bag rain-credit demotion. Flag ON (prod's live config) and
// 0.30" in the window, the depth that clears the 0.20 IA of both tiers below and so earns a credit worth
// demoting — with no credit earned the gate is a no-op and the golden would be blind again.
//   bk1 — 5 gal fabric_bag, PEPPER wi 3, dW 3: fabric_ground, hold 3 -> credited_days 3 at 84; at 85 the
//         gate cuts it to 1 and the reason string names the cut. 5 gal is deliberate (>= FABRIC_GROUND_MIN_GAL)
//         — a sub-3-gal bag stays small_fast, never clears IA 0.35 at 0.30", and would water on both sides.
//   bk2 — in_ground bed, INGROUND_TOMATO wi 4, dW 4: in_ground hold 3 -> credited_days 3 on BOTH sides.
//         Pins the vessel scoping — a gate that stopped keying on fabric_bag moves this row.
const BAG_KNIFE = {
  today: '2026-07-15',
  hydrology: { recent_precip_in: 0.30, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave',
  rainCreditEnabled: true,
  plantings: [
    P({ id: 'bk1', name: 'Knife Bag Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'fabric_bag', container_size: '5 gal', substrate_start: '2026-04-01', transplant_at: '2026-04-01', last_water: '2026-07-12', covered: false, db_cadence: PEPPER }),
    P({ id: 'bk2', name: 'Knife Bed Tomato', variety: 'Beefsteak', genus: 'Solanum', status: 'fruiting', container_type: 'in_ground', container_size: null, substrate_start: '2026-04-01', transplant_at: '2026-04-01', last_water: '2026-07-11', covered: false, db_cadence: INGROUND_TOMATO }),
  ],
};

// Helper to keep planting literals terse + uniform.
//
// BUG-NOLOCOUTDOOR-001: the handler no longer hands the engine a single `covered` boolean. It
// resolves a three-state in SQL and splits it into two flags that are DELIBERATELY not complements
// (rain_exposed_resolved = state IS FALSE; frost_covered_resolved = state IS TRUE) — both false for
// an unknown location, because rain credit and frost alerting fail safe in OPPOSITE directions.
// Every scenario below still expresses coverage as the KNOWN `covered: true|false`, which maps onto
// both flags cleanly, so they are derived here rather than restated 40-odd times.
//
// Derived BEFORE the `...o` spread so a scenario can still pin either flag explicitly — which is
// how an UNKNOWN-location scenario is written: pass both resolved flags false and omit `covered`.
function P(o) {
  const _covered = o.covered ?? false;
  return {
    assignee_user_id: 'dave', project_id: o.project_id ?? 'pj1', project: o.project ?? 'Garden',
    project_status: o.project_status ?? 'active', last_fert: o.last_fert ?? null,
    covered: _covered,
    rain_exposed_resolved: _covered === false,
    frost_covered_resolved: _covered === true,
    ...o,
  };
}

export const scenarios = [
  {
    name: 'baseline-mixed',
    desc: 'Two users; water-due (overdue), no-history (never watered), dormant-skip, and a past-window heavy feeder.',
    input: {
      today: '2026-06-20',
      weather: { tonightLow: 58, highToday: 78, code: 1, short: 'Partly cloudy', unit: 'F' },
      hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
      ownerFallback: 'dave',
      rainCreditEnabled: false,
      plantings: [
        P({ id: 'w1', name: 'Cayenne Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'pot', container_size: '3 gal', substrate_start: '2026-06-12', transplant_at: '2026-06-12', last_water: '2026-06-15', db_cadence: PEPPER }),
        P({ id: 'nh1', name: 'New Basil', variety: 'Genovese', genus: 'Ocimum', status: 'vegetative', container_type: 'pot', container_size: '1 gal', substrate_start: '2026-06-18', transplant_at: null, last_water: null, db_cadence: LETTUCE }),
        P({ id: 'd1', name: 'Dormant Fig', variety: 'Brown Turkey', genus: 'Ficus', status: 'dormant', container_type: 'pot', container_size: '7 gal', substrate_start: '2025-09-01', transplant_at: '2025-09-01', last_water: '2026-06-10', db_cadence: { _seeded: true, crop: 'fig', water_interval_days_container: 4, fertilize_interval_days: 30 } }),
        P({ id: 'f1', name: 'Beefsteak Tomato', variety: 'Beefsteak', genus: 'Solanum', status: 'fruiting', assignee_user_id: 'jen', container_type: 'pot', container_size: '5 gal', substrate_start: '2026-01-01', transplant_at: '2026-05-01', last_water: '2026-06-19', last_fert: null, db_cadence: TOMATO }),
      ],
    },
  },
  {
    name: 'rain-credit-skip',
    desc: 'Outdoor established pot, due today, recent rain over the 0.25in initial-abstraction -> rain_skipped.',
    input: {
      today: '2026-06-22',
      weather: { tonightLow: 60, highToday: 80, code: 1, short: 'Clearing', unit: 'F' },
      hydrology: { recent_precip_in: 0.6, today_precip_in: 0, today_pop: 10, upcoming_precip_in: 0.1, tomorrow_precip_in: 0.1, tomorrow_pop: 20 },
      ownerFallback: 'dave',
      // The BUG-PARITYFLAGBLIND-001 trap: this scenario NAMES rain credit but pinned the flag-OFF
      // (RAIN_IA.outdoor 0.25) verdict the whole time. Kept OFF deliberately — the flag-ON tier path is
      // covered by the rain-tier-* pairs below — but now says so.
      rainCreditEnabled: false,
      plantings: [
        P({ id: 'rc1', name: 'Outdoor Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'pot', container_size: '5 gal', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-06-19', covered: false, db_cadence: PEPPER }),
      ],
    },
  },
  {
    name: 'fresh-transplant-no-credit',
    desc: 'Small vessel (solo_cup) transplanted within the 21-day carve-out: rain credit denied -> water with fresh-transplant note.',
    input: {
      today: '2026-06-22',
      weather: { tonightLow: 62, highToday: 80, code: 1, short: 'Clearing', unit: 'F' },
      hydrology: { recent_precip_in: 0.8, today_precip_in: 0, today_pop: 10, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
      ownerFallback: 'dave',
      rainCreditEnabled: false,
      plantings: [
        P({ id: 'ft1', name: 'Pepper Plug', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', container_type: 'solo_cup', container_size: '0.5 qt', substrate_start: '2026-06-10', transplant_at: '2026-06-12', last_water: '2026-06-18', covered: false, db_cadence: PEPPER }),
      ],
    },
  },
  {
    name: 'fabric-bag-heat-gate',
    desc: 'Outdoor fabric_bag on a >=85F day, 2-class flag-OFF path: rain credit demoted (DRG-WATERCREDIT-004 / BUG-HEATDEMOTETOTAL-001) -> still water, with the heat note carrying the credit that survived. The demotion cannot MOVE the number here (this path\'s base credit is already the 1-day floor); its flag-ON twin below is where it does.',
    input: {
      today: '2026-06-22',
      weather: { tonightLow: 66, highToday: 90, code: 0, short: 'Hot and sunny', unit: 'F' },
      hydrology: { recent_precip_in: 0.7, today_precip_in: 0, today_pop: 5, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
      ownerFallback: 'dave',
      rainCreditEnabled: false,
      plantings: [
        P({ id: 'fb1', name: 'Bag Tomato', variety: 'Beefsteak', genus: 'Solanum', status: 'fruiting', container_type: 'fabric_bag', container_size: '7 gal', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-06-19', covered: false, db_cadence: TOMATO }),
      ],
    },
  },
  {
    name: 'harvested-keep-water',
    desc: 'Harvested planting is NOT dormant -> still surfaces for watering (DRG-CARESTATUS harvested-keeps-water).',
    input: {
      today: '2026-06-22',
      weather: { tonightLow: 60, highToday: 82, code: 1, short: 'Mild', unit: 'F' },
      hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
      ownerFallback: 'dave',
      rainCreditEnabled: false,
      plantings: [
        P({ id: 'hv1', name: 'Harvested Lettuce', variety: 'Buttercrunch', genus: 'Lactuca', status: 'harvested', container_type: 'pot', container_size: '2 gal', substrate_start: '2026-05-10', transplant_at: '2026-05-10', last_water: '2026-06-18', covered: false, db_cadence: LETTUCE }),
      ],
    },
  },
  {
    name: 'planning-excluded',
    desc: 'Planting under a planning-stage project is excluded entirely; the active sibling still appears.',
    input: {
      today: '2026-06-20',
      weather: { tonightLow: 60, highToday: 80, code: 1, short: 'Mild', unit: 'F' },
      hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
      ownerFallback: 'dave',
      rainCreditEnabled: false,
      plantings: [
        P({ id: 'act1', name: 'Active Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', project: 'Active', project_id: 'pa', project_status: 'active', container_type: 'pot', container_size: '3 gal', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-06-10', db_cadence: PEPPER }),
        P({ id: 'plan1', name: 'Future Bed Tomato', variety: 'Beefsteak', genus: 'Solanum', status: 'vegetative', project: 'Planning', project_id: 'pp', project_status: 'planning', container_type: null, container_size: null, substrate_start: null, transplant_at: null, last_water: null, db_cadence: TOMATO }),
      ],
    },
  },
  {
    name: 'wx-freeze-coldprotect',
    desc: 'Freeze callout (low<40) + pepper cold bring-in branch (WX path).',
    input: {
      today: '2026-06-20',
      weather: { tonightLow: 37, highToday: 55, code: 2, short: 'Cold front', unit: 'F' },
      hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
      ownerFallback: 'dave',
      rainCreditEnabled: false,
      plantings: [
        P({ id: 'cp1', name: 'Tender Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'flowering', container_type: 'pot', container_size: '3 gal', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-06-19', db_cadence: PEPPER }),
      ],
    },
  },
  {
    name: 'wx-heat-and-rain-status',
    desc: 'Hot-day callout (high>=88) + hydrologyStatus uncertainty (high PoP today) — exercises WXROLL/WX honesty path.',
    input: {
      today: '2026-06-22',
      weather: { tonightLow: 70, highToday: 92, code: 0, short: 'Hot', unit: 'F' },
      hydrology: { recent_precip_in: 0.05, today_precip_in: 0.02, today_pop: 80, upcoming_precip_in: 0.4, tomorrow_precip_in: 0.4, tomorrow_pop: 70 },
      ownerFallback: 'dave',
      rainCreditEnabled: false,
      plantings: [
        P({ id: 'ht1', name: 'Thirsty Tomato', variety: 'Beefsteak', genus: 'Solanum', status: 'fruiting', container_type: 'pot', container_size: '5 gal', substrate_start: '2026-05-01', transplant_at: '2026-05-01', last_water: '2026-06-20', covered: false, db_cadence: TOMATO }),
      ],
    },
  },
  // DRG-NOCALWATER-001 — profile-declared calendar-watering suppression (flag-independent, shared pre-branch
  // path). Three plantings: (a) seeded Lithops-class profile with no_calendar_water -> dormancy_suppressed,
  // (b) the LIVE prod shape (signals WITHOUT _seeded, so resolveCadence falls back to bundled JSON — the raw
  // db_cadence read must still suppress), (c) a normal pepper that keeps its ordinary water_due item.
  {
    name: 'dormancy-suppressed',
    desc: 'no_calendar_water / growth_gated profiles get NO calendar watering item; loud counts + per-item rule/reason.',
    input: {
      today: '2026-08-03',
      weather: { tonightLow: 66, highToday: 82, code: 1, short: 'Mild', unit: 'F' },
      hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
      ownerFallback: 'dave',
      rainCreditEnabled: false,
      plantings: [
        P({ id: 'li1', name: 'Lithops (seeded)', variety: 'Lithops', genus: null, status: 'active', container_type: 'pot', container_size: '4 in', substrate_start: '2026-01-01', transplant_at: null, last_water: '2026-06-24', covered: true, db_cadence: { _seeded: true, crop: 'succulent (Lithops / living stone)', no_calendar_water: true, water_rule: 'growth_gated', water_interval_days_container: 30, fertilize_interval_days: 0, soil_moisture_target: 'OVERRIDE: water ONLY when actively growing; otherwise DO NOT WATER' } }),
        // variety deliberately ABSENT from cadence-data-v2.json by_variety (the bundled 'Lithops' entry
        // carries dormant_skip and would divert to the dormant bucket before the suppression gate) — this
        // row must resolve to the DEFAULT cadence so ONLY the raw unseeded db_cadence signal protects it.
        P({ id: 'li2', name: 'Living Stone (live unseeded shape)', variety: 'Lithops karasmontana C368', genus: null, status: 'active', container_type: 'pot', container_size: '4 in', substrate_start: '2026-01-01', transplant_at: null, last_water: '2026-06-24', covered: true, db_cadence: { crop: 'succulent (Lithops / living stone)', no_calendar_water: true, water_rule: 'growth_gated', water_interval_days_container: 30, soil_moisture_target: 'OVERRIDE: water ONLY when actively growing; otherwise DO NOT WATER' } }),
        P({ id: 'pep1', name: 'Bench Pepper', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', container_type: 'pot', container_size: '3 gal', substrate_start: '2026-06-01', transplant_at: '2026-06-01', last_water: '2026-07-25', covered: false, db_cadence: PEPPER }),
      ],
    },
  },
  // BUG-TODAYWATER-001 — today-qualifying pairs (see TODAY_MODERATE/TODAY_HEAVY above for the verdict map).
  {
    name: 'today-moderate-flagoff',
    desc: '1.0"@80% today forecast, flag OFF: part-prediction soak basis suppresses all outdoor (pre-change parity).',
    input: TODAY_MODERATE,
  },
  {
    name: 'today-moderate-flagon',
    desc: '1.0"@80% today forecast, flag ON: solo_cup NOW SKIPS (BUG-SOAKBAR-001 moved the small bar 2.0 -> 0.91, and 1.0" clears it — this is the one golden that changed), in_ground skips kind today, hot fabric bag waters (gate outranks forecast).',
    input: { ...TODAY_MODERATE, todayAwareEnabled: true },
  },
  {
    name: 'today-heavy-flagoff',
    desc: '2.5"@90% today forecast, flag OFF: soak suppresses all outdoor incl. the fresh transplant (pre-change parity).',
    input: TODAY_HEAVY,
  },
  {
    name: 'today-heavy-flagon',
    desc: '2.5"@90% today forecast, flag ON: established solo_cup skips at the 0.91" small bar (2.5" cleared the old 2.0" bar too, so this golden is unchanged), fresh transplant still waters, in_ground skips.',
    input: { ...TODAY_HEAVY, todayAwareEnabled: true },
  },
  // BUG-PARITYFLAGBLIND-001 — rain-credit flag pairs (see RAIN_TIER_KNIFE/RAIN_TIER_VESSELS above for the
  // verdict map). These are the ONLY scenarios that reach RAIN_TIER_IA / RAIN_TIER_HOLD / rainTierFor, i.e.
  // the configuration prod actually runs (CARE_RAIN_CREDIT_ENABLED=true). rainMaxDaysEnabled stays OFF —
  // that is a separately-flagged clamp (DRG-WXFLAGSPLIT-001 F1) and pinning it here would conflate the two.
  {
    name: 'rain-tier-knife-flagoff',
    desc: '0.35" on an established outdoor pot, flag OFF: clears RAIN_IA.outdoor 0.25 -> rain_skipped.',
    input: { ...RAIN_TIER_KNIFE, rainCreditEnabled: false },
  },
  {
    name: 'rain-tier-knife-flagon',
    desc: '0.35" on an established outdoor pot, flag ON: sits exactly ON RAIN_TIER_IA.small_fast 0.35 -> eff 0, no credit -> waters with the "under the 0.35\\" soak-in threshold" note. Retuning that constant either way changes this golden.',
    input: { ...RAIN_TIER_KNIFE, rainCreditEnabled: true },
  },
  {
    name: 'rain-tier-vessels-flagoff',
    desc: '0.30" across a NULL-container_type planting and an in-ground bed, flag OFF: one undifferentiated 0.25 IA / 1-day hold -> both rain_skipped with credited_days 1.',
    input: { ...RAIN_TIER_VESSELS, rainCreditEnabled: false },
  },
  {
    name: 'rain-tier-vessels-flagon',
    desc: '0.30" same input, flag ON: the NULL vessel takes rainTierFor\'s small_fast fallback (IA 0.35 -> no credit, waters) while the bed takes in_ground (IA 0.20, hold 3 -> credited_days 3). Pins both the fallback direction and the hold table.',
    input: { ...RAIN_TIER_VESSELS, rainCreditEnabled: true },
  },
  {
    name: 'rain-tier-fabric-flagoff',
    desc: '0.30" across a 5 gal / "3 in" / unsized fabric bag, flag OFF: size is not consulted at all -> one undifferentiated RAIN_IA.outdoor 0.25 / 1-day hold -> all three rain_skipped with credited_days 1.',
    input: { ...RAIN_TIER_FABRIC, rainCreditEnabled: false },
  },
  {
    name: 'rain-tier-fabric-flagon',
    desc: '0.30" same input, flag ON: the 5 gal bag promotes to fabric_ground (IA 0.20, hold 3 -> credited_days 3) while the "3 in" and unsized bags stay small_fast (IA 0.35 -> no credit, water). The only scenario that reaches RAIN_TIER_IA/HOLD.fabric_ground, and it pins the >= 3 gal gate in both directions.',
    input: { ...RAIN_TIER_FABRIC, rainCreditEnabled: true },
  },
  {
    // BUG-HEATDEMOTETOTAL-001 — the configuration prod actually runs (CARE_RAIN_CREDIT_ENABLED=true)
    // at the temperature the bag gate fires was unreachable from this gate: `fabric-bag-heat-gate` is
    // flag-OFF with a 1-day cadence (credit already at the floor) and the three rain-tier fabric
    // scenarios all sit at 79F. So the gate carried nothing that could tell a DEMOTION from a DENIAL,
    // and the denial shipped. This is RAIN_TIER_FABRIC's inputs at 90F, which is the only combination
    // where the demoted number is observable: fg1 3 -> 1.
    name: 'fabric-bag-heat-gate-flagon',
    desc: '0.30" across a 5 gal / "3 in" / unsized fabric bag at 90F, flag ON: the 5 gal bag still earns fabric_ground credit but the >=85F gate CUTS it 3 -> 1 (credited_days 1, reason names the cut) instead of erasing it; at dW=3 vs a 3-day cadence that 1 day is what keeps it on rain_skipped. The other two never cleared small_fast IA 0.35, so they water with the SOAK-IN THRESHOLD note — the gate must not claim to have withheld a credit that was never earned. Compare rain-tier-fabric-flagon (same inputs, 79F, credited_days 3).',
    input: { ...RAIN_TIER_FABRIC, weather: { tonightLow: 70, highToday: 90, code: 0, short: 'Hot and sunny', unit: 'F' }, rainCreditEnabled: true },
  },
  {
    // BUG-PARITYGOLDENSBLIND-001 — the knife pairs (see HEAT_KNIFE/BAG_KNIFE above for the verdict map).
    // Not flag pairs: the only thing that differs inside each pair is one degree of highToday.
    name: 'heat-knife-87',
    desc: '87F, one degree UNDER HOT_F: `hot` false, so the drought-tolerance-low tomato keeps its full 2-day interval (due, overdue 0) and no heat callout fires. Lowering HOT_F to 87 or below moves this golden.',
    input: { ...HEAT_KNIFE, weather: { tonightLow: 66, highToday: 87, code: 0, short: 'Hot and sunny', unit: 'F' } },
  },
  {
    name: 'heat-knife-88',
    desc: '88F, exactly ON HOT_F: `hot` true, the drought-tolerance-low tomato is accelerated to interval 1 (overdue 1) while the medium-tolerance pepper stays at 3. Raising HOT_F to 89 or above moves this golden.',
    input: { ...HEAT_KNIFE, weather: { tonightLow: 66, highToday: 88, code: 0, short: 'Hot and sunny', unit: 'F' } },
  },
  {
    name: 'bag-heat-knife-84',
    desc: '0.30" on a 5 gal fabric bag + an in-ground bed at 84F, one degree UNDER BAG_HEAT_GATE_F, flag ON: no demotion, both rain_skipped with the full credited_days 3 and the plain rain reason. Lowering the gate to 84 or below moves this golden.',
    input: { ...BAG_KNIFE, weather: { tonightLow: 66, highToday: 84, code: 0, short: 'Sunny', unit: 'F' } },
  },
  {
    name: 'bag-heat-knife-85',
    desc: '0.30" same input at 85F, exactly ON BAG_HEAT_GATE_F: the bag is cut 3 -> 1 with the heat reason while the bed keeps 3. Raising the gate to 86 or above moves this golden.',
    input: { ...BAG_KNIFE, weather: { tonightLow: 66, highToday: 85, code: 0, short: 'Sunny', unit: 'F' } },
  },
  {
    name: 'vessel-floor',
    desc: 'Nine 1-day-cadence plantings on the vessels that discriminate. At dW=1 trough/whiskey_barrel/15-gal ceramic are floored to 2 and drop off water_due while 10-gal and 20-gal fabric bags, a 6-in pot, an UNSIZED rigid pot and a NULL-vessel row stay due; a second trough at dW=2 is due with interval 2, which pins the floor VALUE (a floor of 3+, or the _inground arm, drops it). Pins the BUG-CADENCESIZE-001 floor, the deliberate fabric-bag exclusion, and the unknown-vessel fail-safe in one golden.',
    input: { ...VESSEL_FLOOR },
  },
];

// Compute a plan for a scenario by name (or the scenario object) using the bundled engine + data.
export function planFor(scenarioOrName) {
  const s = typeof scenarioOrName === 'string' ? scenarios.find((x) => x.name === scenarioOrName) : scenarioOrName;
  if (!s) throw new Error(`unknown parity scenario: ${scenarioOrName}`);
  return engine.generatePlan({ ...s.input, cadence, fertModel });
}
