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

// Helper to keep planting literals terse + uniform.
function P(o) {
  return { assignee_user_id: 'dave', project_id: o.project_id ?? 'pj1', project: o.project ?? 'Garden', project_status: o.project_status ?? 'active', last_fert: o.last_fert ?? null, covered: o.covered ?? false, ...o };
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
];

// Compute a plan for a scenario by name (or the scenario object) using the bundled engine + data.
export function planFor(scenarioOrName) {
  const s = typeof scenarioOrName === 'string' ? scenarios.find((x) => x.name === scenarioOrName) : scenarioOrName;
  if (!s) throw new Error(`unknown parity scenario: ${scenarioOrName}`);
  return engine.generatePlan({ ...s.input, cadence, fertModel });
}
