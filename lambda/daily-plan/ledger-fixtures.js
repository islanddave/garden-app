'use strict';
// V4-WATERMATH-001 F2 — deterministic engine-level fixture set for the ledger acceptance tests AND
// the committed shadow goldens (ledger-goldens.json). These are the flip gate's expected-delta
// baseline at fixture level: each scenario is a frozen generatePlan input captured flag-OFF and
// flag-ON, so "what changes when the flag flips" is a reviewable, committed diff — the same shape
// the seededgate flip shipped with ("exactly 6 plantings"). Consumed by ledger-engine.test.js.
const { withCoverFlags } = require('./_coverFlags');
const ledger = require('./ledger');

const H = 3600000;
const TODAY = '2026-08-12';
const NOW = ledger.etMidnightMs(TODAY) + 2 * H;                 // the 02:00 nightly slot
const at = (d, h, m = 0) => ledger.etMidnightMs(d) + h * H + m * 60000;
const ago = (n) => ledger.addDays(TODAY, -n);

// Seeded cadence: explicit both-key intervals so container_type never silently drops a planting
// out of every bucket (fixtures.mjs landmine). cadence_scopes rides per planting where a scenario
// wants the researched-provenance (via 'db') path under the LIVE flag combo.
const SEED = (o) => ({ _seeded: true, crop: 'tomato', water_interval_days_container: 3,
  water_interval_days_inground: 5, water_method: 'soak', soil_moisture_target: 'moist',
  drought_tolerance: 'medium', ...o });

const P = (o) => withCoverFlags({ id: 'p', name: 'X', variety: 'v', genus: 'g', status: 'active',
  project: 'P', project_id: 'pp', container_type: 'trough', container_size: '5 gal', covered: false,
  last_water: ago(2), substrate_start: ago(81), transplant_at: ago(400), db_cadence: SEED({}), ...o });

// Flat weather: each settled day's ET0 = the site reference -> ratio exactly 1.0. ONE value for
// every date (BUG-ETNOAMPLITUDE-001 retired the per-month table); imported rather than mirrored so a
// retune of the reference cannot leave these fixtures silently off-ratio.
const REF = require('./ledgerParams').ET0_REF_PEAK;
function weatherDaily({ et0 = null, tmax = 75, precipOn = {}, days = 30 } = {}) {
  const rows = [];
  for (let d = ledger.addDays(TODAY, -days); d < TODAY; d = ledger.addDays(d, 1)) {
    rows.push({ date: d, et0_in: et0 ?? REF, tmax_f: precipOn[d + '_tmax'] ?? tmax,
      tmin_f: 60, precip_in: precipOn[d] ?? 0 });
  }
  return rows;
}
const WX = { tonightLow: 62, highToday: 82 };
const HY = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
  tomorrow_precip_in: 0, tomorrow_pop: 0, today_et0_in: REF, today_tmax_f: 82 };
const w = (d, h, depth, id) => ({ id, t: at(d, h), type: 'watering', depth });

// Every scenario: { name, note, input } where input is a complete generatePlan argument bag MINUS
// cadence/fertModel (the test supplies the bundled files) and MINUS the flag itself (captured both
// ways). All scenarios run under the LIVE prod combo (rainCredit + todayAware ON, maxdays OFF).
const scenarios = [
  {
    name: 'evening-soak-wi1',
    note: '(a) 19:00 Normal on wi=1: legacy re-dues next morning, ledger does not',
    input: {
      today: TODAY, nowMs: NOW, weather: WX, hydrology: HY, ownerFallback: 'dave',
      plantings: [
        P({ id: 'ev1', container_type: 'pot', container_size: '1 gal', last_water: ago(1),
          db_cadence: SEED({ water_interval_days_container: 1, water_interval_days_inground: 1 }) }),
        P({ id: 'ctl', last_water: ago(9) }),           // control: overdue under both engines
      ],
      weatherDaily: weatherDaily(),
      eventsByPlant: { ev1: [w(ago(1), 19, null, 'e1')],
        ctl: [w(ago(9), 12, null, 'c1')] },
    },
  },
  {
    name: 'deep-vs-normal-inground',
    note: '(b) same in-ground planting pair, Deep banks and crosses later than Normal',
    input: {
      today: TODAY, nowMs: NOW, weather: WX, hydrology: HY, ownerFallback: 'dave',
      plantings: [
        P({ id: 'dp', container_type: 'in_ground', container_size: null, last_water: ago(2) }),
        P({ id: 'nm', container_type: 'in_ground', container_size: null, last_water: ago(2) }),
      ],
      weatherDaily: weatherDaily(),
      eventsByPlant: {
        dp: [w(ago(20), 12, null, 'pr1'), w(ago(2), 19, 'deep', 'd1')],
        nm: [w(ago(20), 12, null, 'pr2'), w(ago(2), 19, null, 'n1')],
      },
    },
  },
  {
    name: 'rain-week-resurfaces',
    note: '(d) a week of qualifying rain floors D at 0; planting resurfaces once it stops',
    input: {
      today: TODAY, nowMs: NOW, weather: WX, hydrology: HY, ownerFallback: 'dave',
      plantings: [P({ id: 'rw', last_water: ago(25) })],
      weatherDaily: weatherDaily({ precipOn: Object.fromEntries(
        Array.from({ length: 18 }, (_, i) => [ago(25 - i), 1.0]) ) }),   // rain ago(25)..ago(8), dry since
      eventsByPlant: { rw: [w(ago(25), 12, null, 'r1')] },
    },
  },
  {
    name: 'rain-light-partial-credit',
    note: '(d2) DRG-RAINDEPTH-001: ONE 0.21" day across all three substrate tiers. The discriminating '
      + 'case the 1.0" rain-week golden cannot see — at 1.0" every tier saturates to a full reset and '
      + 'the retired IA-cliff model and the depth model converge. At 0.21" they disagree in BOTH '
      + 'directions: the cliff gave in_ground a full 3-day hold and gave the bed/bag exactly nothing.',
    input: {
      today: TODAY, nowMs: NOW, weather: WX, hydrology: HY, ownerFallback: 'dave',
      plantings: [
        P({ id: 'rl-ig', container_type: 'in_ground', container_size: null, last_water: ago(6) }),
        P({ id: 'rl-bed', container_type: 'raised_bed', container_size: null, last_water: ago(6) }),
        P({ id: 'rl-bag', container_type: 'fabric_bag', container_size: '5 gal', last_water: ago(6) }),
      ],
      weatherDaily: weatherDaily({ precipOn: { [ago(3)]: 0.21 } }),
      eventsByPlant: {
        'rl-ig': [w(ago(6), 12, null, 'i1')],
        'rl-bed': [w(ago(6), 12, null, 'b1')],
        'rl-bag': [w(ago(6), 12, null, 'g1')],
      },
    },
  },
  {
    name: 'heatwave-fixed-ref',
    note: '(e) 14 flat hot days: demand stays >1 all wave; bag ramp reads weather_daily.tmax_f',
    input: {
      today: TODAY, nowMs: NOW, weather: { tonightLow: 70, highToday: 92 },
      hydrology: { ...HY, today_et0_in: 0.30, today_tmax_f: 92 }, ownerFallback: 'dave',
      plantings: [P({ id: 'hw', container_type: 'fabric_bag', container_size: '7 gal', last_water: ago(2) })],
      weatherDaily: weatherDaily({ et0: 0.30, tmax: 92 }),
      eventsByPlant: { hw: [w(ago(2), 19, null, 'h1')] },
    },
  },
  {
    name: 'degraded-no-weather',
    note: '(f) empty weather_daily: demand 1.0 flat, weather_degraded driver + one-step tier demotion, run does not blank',
    input: {
      today: TODAY, nowMs: NOW, weather: WX, hydrology: HY, ownerFallback: 'dave',
      plantings: [P({ id: 'dg', last_water: ago(9) })],
      weatherDaily: [],
      eventsByPlant: { dg: [w(ago(9), 12, null, 'g1')] },
    },
  },
  {
    name: 'never-watered',
    note: '(g) no watering history: the never:true/no_history path is byte-identical',
    input: {
      today: TODAY, nowMs: NOW, weather: WX, hydrology: HY, ownerFallback: 'dave',
      plantings: [P({ id: 'nv', last_water: null })],
      weatherDaily: weatherDaily(),
      eventsByPlant: {},
    },
  },
  {
    name: 'snooze-today',
    note: '(h) due planting with a moisture_check this morning drops out of water_due',
    input: {
      today: TODAY, nowMs: ledger.etMidnightMs(TODAY) + 15.5 * H,       // the 15:30 run
      weather: WX, hydrology: HY, ownerFallback: 'dave',
      plantings: [P({ id: 'sz', last_water: ago(9) })],
      weatherDaily: weatherDaily(),
      eventsByPlant: { sz: [w(ago(9), 12, null, 's1'),
        { id: 's2', t: at(TODAY, 8), type: 'moisture_check', depth: null }] },
    },
  },
  {
    name: 'satcap-supremacy',
    note: 'heavy soak outranks a ledger-due verdict -> rain_skipped saturated, D-gated (not dW-gated)',
    input: {
      today: TODAY, nowMs: NOW, weather: WX,
      hydrology: { ...HY, recent_precip_in: 1.4 }, ownerFallback: 'dave',
      plantings: [
        P({ id: 'sat', last_water: ago(9) }),           // ledger-due AND soaked -> saturated skip
        P({ id: 'fresh', last_water: ago(4) }),         // dW(4)>=wi(3) but D<thr after yesterday's Normal
      ],
      weatherDaily: weatherDaily(),
      eventsByPlant: { sat: [w(ago(9), 12, null, 't1')],
        fresh: [w(ago(9), 12, null, 't2'), w(ago(1), 19, null, 't3')] },
    },
  },
  {
    name: 'live-combo-confidence',
    note: 'researched scopes + known vessel + weather -> HIGH; genus fallback -> LOW; 2 snoozes demote',
    input: {
      today: TODAY, nowMs: NOW, weather: WX, hydrology: HY, ownerFallback: 'dave',
      plantings: [
        P({ id: 'hi', cadence_scopes: ['cultivar'], last_water: ago(9) }),
        P({ id: 'lo', db_cadence: null, variety: 'no-such-variety', genus: 'no-such-genus', last_water: ago(9) }),
        P({ id: 'dm', cadence_scopes: ['cultivar'], last_water: ago(9) }),
      ],
      weatherDaily: weatherDaily(),
      eventsByPlant: {
        hi: [w(ago(9), 12, null, 'q1')],
        lo: [w(ago(9), 12, null, 'q2')],
        dm: [w(ago(9), 12, null, 'q3'),
          { id: 'q4', t: at(ago(6), 9), type: 'moisture_check', depth: null },
          { id: 'q5', t: at(ago(3), 9), type: 'moisture_check', depth: null }],
      },
    },
  },
];

// Compact, order-stable projection of one generatePlan output for the goldens file: verdicts and
// the ledger key's decision surface, not the whole payload (names/notes would make every copy edit
// a golden churn).
function project(plan) {
  const users = {};
  for (const [u, up] of Object.entries(plan.users)) {
    users[u] = {
      counts: up.counts,
      water_due: up.tasks.water_due.map((x) => ({ id: x.id, days_since: x.days_since,
        interval: x.interval, overdue_by: x.overdue_by,
        ...(x.ledger ? { d: x.ledger.d, confidence: x.ledger.confidence } : {}) })),
      no_history: up.tasks.no_history.map((x) => x.id),
      rain_skipped: up.tasks.rain_skipped.map((x) => ({ id: x.id, saturated: !!x.saturated,
        ...(x.sat_kind ? { sat_kind: x.sat_kind } : {}), ...(x.ledger ? { d: x.ledger.d } : {}) })),
    };
  }
  return users;
}

module.exports = { scenarios, project, TODAY, NOW, at, ago, P, SEED, weatherDaily, WX, HY, w };
