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
  plantings: [
    P({ id: 'sv1', name: 'Bench Pepper Cell', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', container_type: 'solo_cup', container_size: '0.5 qt', substrate_start: '2026-06-01', transplant_at: '2026-06-01', last_water: '2026-07-30', covered: false, db_cadence: PEPPER }),
    P({ id: 'ft1', name: 'Fresh Pepper Cell', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', container_type: 'tray_cell', container_size: '0.5 qt', substrate_start: '2026-07-29', transplant_at: '2026-07-29', last_water: '2026-07-30', covered: false, db_cadence: PEPPER }),
    P({ id: 'bed1', name: 'Main Bed Tomato', variety: 'Beefsteak', genus: 'Solanum', status: 'fruiting', container_type: 'in_ground', container_size: null, substrate_start: '2026-06-01', transplant_at: '2026-06-01', last_water: '2026-07-29', covered: false, db_cadence: INGROUND_TOMATO }),
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
      plantings: [
        P({ id: 'ft1', name: 'Pepper Plug', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', container_type: 'solo_cup', container_size: '0.5 qt', substrate_start: '2026-06-10', transplant_at: '2026-06-12', last_water: '2026-06-18', covered: false, db_cadence: PEPPER }),
      ],
    },
  },
  {
    name: 'fabric-bag-heat-gate',
    desc: 'Outdoor fabric_bag on a >=85F day: rain credit withheld (DRG-WATERCREDIT-004) -> water with heat note.',
    input: {
      today: '2026-06-22',
      weather: { tonightLow: 66, highToday: 90, code: 0, short: 'Hot and sunny', unit: 'F' },
      hydrology: { recent_precip_in: 0.7, today_precip_in: 0, today_pop: 5, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
      ownerFallback: 'dave',
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
];

// Compute a plan for a scenario by name (or the scenario object) using the bundled engine + data.
export function planFor(scenarioOrName) {
  const s = typeof scenarioOrName === 'string' ? scenarios.find((x) => x.name === scenarioOrName) : scenarioOrName;
  if (!s) throw new Error(`unknown parity scenario: ${scenarioOrName}`);
  return engine.generatePlan({ ...s.input, cadence, fertModel });
}
