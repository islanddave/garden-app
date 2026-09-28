// BUG-RAINBEDWAITCONFLICT-001 — Dave, 2026-09-28: with 0.50" or more forecast for tomorrow at 60%+, a DRY
// in-ground bed waits for the rain. Before this, Today's rain line said "let in-ground beds wait" on a private
// 0.30"/50% bar while the list under it watered every dry bed (the engine's 'incoming' skip needs wet media).
// Now the engine runs 'incoming_dry' for in-ground plantings (generatePlan deferDryBedsEnabled, armed in
// handler.js) and the callout fires on the same bars. Containers and fresh transplants keep watering.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import h from './handler.js';
import engine from './engine.js';
import _cf from './_coverFlags.js';
import THRESHOLDS from './wateringThresholds.json';

const { withCoverFlags } = _cf;
const { run } = h;
const { computeCallout } = engine;
const { SOAK_FCST_QPF_IN, SOAK_FCST_POP_PCT } = THRESHOLDS;

describe('computeCallout — the rain line fires exactly when dry beds are let wait', () => {
  const hy = (o) => ({ recent_precip_in: 0.05, tomorrow_precip_in: 0, tomorrow_pop: null, ...o });
  const rain = (h2, bedsWait) => computeCallout({ tonightLow: 55, highToday: 70 }, h2, bedsWait)?.icon === 'rain';

  it('bedsWait: 0.50" at 60%+ fires; just under either bar does not', () => {
    expect(rain(hy({ tomorrow_precip_in: SOAK_FCST_QPF_IN, tomorrow_pop: SOAK_FCST_POP_PCT }), true)).toBe(true);
    expect(rain(hy({ tomorrow_precip_in: SOAK_FCST_QPF_IN - 0.01, tomorrow_pop: 95 }), true)).toBe(false);
    expect(rain(hy({ tomorrow_precip_in: 2.0, tomorrow_pop: SOAK_FCST_POP_PCT - 1 }), true)).toBe(false);
  });

  it('bedsWait: the retired 0.30"/50% cases no longer fire (09-17: 1.12" at 53%, 0.17" fell)', () => {
    expect(rain(hy({ tomorrow_precip_in: 0.3, tomorrow_pop: 50 }), true)).toBe(false);
    expect(rain(hy({ tomorrow_precip_in: 1.12, tomorrow_pop: 53 }), true)).toBe(false);
  });

  it('bedsWait: an unknown chance or an unknown rain history never claims the beds can wait', () => {
    expect(rain(hy({ tomorrow_precip_in: 3.0, tomorrow_pop: null }), true)).toBe(false);
    expect(rain({ recent_precip_in: null, tomorrow_precip_in: 3.0, tomorrow_pop: 95 }, true)).toBe(false);
  });

  it('without bedsWait the old gate is kept byte-for-byte (every un-armed caller and parity golden)', () => {
    expect(rain(hy({ tomorrow_precip_in: 0.3, tomorrow_pop: 50 }), false)).toBe(true);
    expect(rain(hy({ tomorrow_precip_in: 0.3, tomorrow_pop: null }), false)).toBe(true);
    expect(rain(hy({ tomorrow_precip_in: 0.29, tomorrow_pop: 99 }), false)).toBe(false);
    expect(rain(hy({ tomorrow_precip_in: 0.3, tomorrow_pop: 50 }))).toBe(true);   // default = off
  });

  it('the wording is unchanged, so the cue line and its impression model version are unaffected', () => {
    const c = computeCallout({ tonightLow: 55, highToday: 70 }, hy({ tomorrow_precip_in: 0.74, tomorrow_pop: 70 }), true);
    expect(c.text).toBe('0.74" rain tomorrow (70% chance) — water containers today, let in-ground beds wait');
  });
});

// ── Through the real run(): the handler arms it, and the stored plan shows it ──────────────────────────────
const USER = 'user_dave';
const SPACE = 'sp1';
const DATE = '2026-09-28';
const planting = (id, extra = {}) => withCoverFlags({
  id, name: `pepper ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'in_ground',
  container_size: null, rain_exposed: null, variety: 'pepper', genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: 'pepper', covered: false,
  assignee_user_id: USER, db_cadence: null, last_water: '2026-09-18', last_fert: '2026-09-01',
  substrate_start: '2026-05-01', transplant_at: null, ...extra,
});
const PLANTINGS = [
  planting('bed'),
  planting('bag', { container_type: 'fabric_bag', container_size: '5 gal' }),
  planting('newbed', { transplant_at: '2026-09-24' }),
];
function pgStub() {
  const writes = [];
  const query = vi.fn(async (sql, params) => {
    if (/insert into daily_plan/.test(sql)) { writes.push(JSON.parse(params[2])); return { rows: [] }; }
    if (/from plants/.test(sql)) return { rows: PLANTINGS };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    return { rows: [] };
  });
  return { query, writes };
}
const precip = (tomorrow_precip_in, tomorrow_pop) => async () => ({
  forecast_lows: [52, 50, 49], forecast_dates: ['2026-09-29', '2026-09-30', '2026-10-01'],
  recent_precip_in: 0, today_precip_in: 0, today_pop: 5, upcoming_precip_in: tomorrow_precip_in, upcoming_pop: tomorrow_pop,
  tomorrow_precip_in, tomorrow_pop, day2_precip_in: 0, day2_pop: 10, day2_date: '2026-09-30', yesterday_precip_actual_in: 0,
});
async function drive(fetchPrecip) {
  const pg = pgStub();
  await run({
    pg, today: DATE, dryRun: false, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 52, highToday: 66, code: 3, unit: 'F', short: 'Cloudy' }),
    fetchPrecip, fetchStation: async () => null, publishAlert: vi.fn(async () => ({ messageId: 'm' })), etHour: 9, event: {},
  });
  return pg.writes.find((w) => w && w.hydrology) || pg.writes[0];
}
const ids = (rows) => (rows || []).map((r) => r.id).sort();

afterEach(() => { vi.restoreAllMocks(); });

describe('BUG-RAINBEDWAITCONFLICT-001 — through the real run()', () => {
  it('0.74" at 70% tomorrow: the dry bed waits, the bag and the fresh transplant are watered', async () => {
    const plan = await drive(precip(0.74, 70));
    expect(ids(plan.water_due)).toEqual(['bag', 'newbed']);
    const bed = plan.rain_skipped.find((r) => r.id === 'bed');
    expect(bed).toMatchObject({ sat_kind: 'incoming_dry', in_ground: true });
    expect(bed.reason).toMatch(/rain expected tomorrow/);
    expect(plan.weather.callout.text).toMatch(/let in-ground beds wait$/);
  });

  it('0.74" at 55%: under the chance bar, every dry planting is watered and no line says beds can wait', async () => {
    // The retired callout bar (0.30"/50%) would have fired here over a list that waters the bed.
    const plan = await drive(precip(0.74, 55));
    expect(ids(plan.water_due)).toEqual(['bag', 'bed', 'newbed']);
    expect(plan.weather.callout?.icon).not.toBe('rain');
  });
});

describe('generatePlan without deferDryBedsEnabled is inert (the parity goldens call it that way)', () => {
  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  const cadence = JSON.parse(readFileSync(here('./cadence-data-v2.json'), 'utf8'));
  const fertModel = JSON.parse(readFileSync(here('./fertilization-model.json'), 'utf8'));
  const SEED = { _seeded: true, crop: 'pepper', water_interval_days_container: 1, water_interval_days_inground: 2,
    water_method: 'soak', soil_moisture_target: 'moist', drought_tolerance: 'medium' };
  const rows = PLANTINGS.map((p) => ({ ...p, db_cadence: SEED }));
  const hydrology = { recent_precip_in: 0, today_precip_in: 0, today_pop: 5, tomorrow_precip_in: 0.74, tomorrow_pop: 70 };
  const gen = (extra) => engine.generatePlan({ plantings: rows, cadence, fertModel, today: DATE,
    weather: { tonightLow: 52, highToday: 66 }, hydrology, ownerFallback: USER, todayAwareEnabled: true, ...extra });
  const due = (plan) => Object.values(plan.users).flatMap((u) => u.tasks.water_due).map((r) => r.id).sort();

  it('off: the dry bed stays listed and the rain line keeps its old gate; on: the bed waits', () => {
    const off = gen({});
    const on = gen({ deferDryBedsEnabled: true });
    expect(due(off)).toEqual(['bag', 'bed', 'newbed']);
    expect(due(on)).toEqual(['bag', 'newbed']);
    // Only the separate all-outdoor flag (CARE_RAIN_DEFER_DRY_ENABLED, OFF in prod) defers the bag.
    expect(due(gen({ deferDryEnabled: true }))).not.toContain('bag');
  });
});
