// V5-LEAFWETNESS-001 — END-TO-END: does the key actually reach the STORED row?
//
// WHY THIS FILE EXISTS, stated plainly because it is the whole lesson of this change. The first cut
// of V5-LEAFWETNESS-001 shipped with the engine computing `leaf_wetness`, the component rendering it,
// Today mounting it, a mutation-confirmed mount assertion, 16,050 tests green and G-PARITY green —
// and the feature 100% INERT in production. `handler.js`'s daily_plan write is an explicit named-key
// allowlist, not a spread of `plan`, so a key the engine emits and that literal omits is discarded on
// write and can never render. Nothing in the suite failed.
//
// NONE of the existing gates could have caught it:
//   - Component and mount tests feed a SYNTHETIC plan straight to the component, bypassing persistence.
//   - The engine test asserts generatePlan's RETURN value, which was always correct.
//   - G-PARITY compares STORED payloads, so a key that never reaches a row leaves the goldens green
//     for the wrong reason — its result is identical whether the spread works or the key is dropped.
//
// So the assertion has to be made against the row that was actually written. This drives the real
// nightly entry point with a mocked pg, captures the `insert into daily_plan` parameters, and parses
// what would have gone into the database. Harness modelled on droughtsignal.test.js's E2E block,
// which exists for the identical reason on the sibling `drought` key.

import { describe, it, expect, vi, afterEach } from 'vitest';
import handler from './handler.js';

const SPACE = 'sp-1';
const USER = 'user_1';
const TODAY = '2026-09-08';

const PLANTINGS = [{
  id: 'tm1', name: 'Tomato', project_id: 'pj1', status: 'fruiting', container_type: 'in_ground',
  container_size: null, rain_exposed: null, variety: 'sungold', genus: null, project: 'Beds',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: 'tomato',
  covered: false, frost_covered_resolved: false, assignee_user_id: USER,
  db_cadence: { crop: 'tomato', water_interval_days_inground: 3 },
  last_water: '2026-09-07', last_fert: '2026-08-01', substrate_start: '2026-05-01', transplant_at: null,
}];

// Arrays are [D-2, D-1, D0, D+1, D+2, D+3]; index 2 is today. Three qualifying days — two behind,
// one ahead — so the assertion can tell the two halves apart rather than just "something appeared".
const WET_WINDOW = [
  { date: '2026-09-06', precip_hours: 12, tmax_f: 78, tmin_f: 62 },
  { date: '2026-09-07', precip_hours: 0,  tmax_f: 76, tmin_f: 61 },
  { date: TODAY,        precip_hours: 10, tmax_f: 77, tmin_f: 63 },
  { date: '2026-09-09', precip_hours: 9,  tmax_f: 75, tmin_f: 64 },
  { date: '2026-09-10', precip_hours: 1,  tmax_f: 74, tmin_f: 60 },
  { date: '2026-09-11', precip_hours: 0,  tmax_f: 73, tmin_f: 59 },
];

const DRY_WINDOW = WET_WINDOW.map((d) => ({ ...d, precip_hours: 0 }));

function mockPg() {
  return {
    query: vi.fn(async (sql) => {
      if (/from plants/.test(sql)) return { rows: PLANTINGS };
      if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
      if (/weather_daily/.test(sql)) return { rows: [] };
      return { rows: [] };
    }),
  };
}

const storedPlans = (pg) => pg.query.mock.calls
  .filter(([sql]) => /insert into daily_plan/.test(sql))
  .map(([, params]) => JSON.parse(params[2]));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const driveRun = (wetnessWindow) => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const pg = mockPg();
  return handler.run({
    pg, today: TODAY, dryRun: false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 62, highToday: 78, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => ({
      forecast_lows: [null, null, null], forecast_dates: [null, null, null],
      recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
      tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0, settled_days: [],
      ...(wetnessWindow ? { wetness_window: wetnessWindow } : {}),
    }),
    fetchStation: async () => null, publishAlert: vi.fn(async () => ({ messageId: 'm1' })),
    etHour: 2, event: { rainLog: false },
  }).then(() => pg);
};

describe('the key reaches the row that is actually written', () => {
  it('THE REGRESSION CASE — leaf_wetness survives the handler write', async () => {
    // Removing `...(plan.leaf_wetness ? { leaf_wetness: plan.leaf_wetness } : {})` from handler.js's
    // daily_plan literal reddens THIS and nothing else in the entire suite. That is the point.
    const pg = await driveRun(WET_WINDOW);
    const [stored] = storedPlans(pg);
    expect(stored).toBeTruthy();
    expect(stored.leaf_wetness).toBeTruthy();
    expect(stored.leaf_wetness.recent_wet_days).toBe(2);   // 09-06 + today
    expect(stored.leaf_wetness.ahead_wet_days).toBe(1);    // 09-09
    expect(stored.leaf_wetness.basis).toBe('modelled_precip_hours');
  });

  it('omits the key entirely on a dry window — byte-identical to the pre-feature row', async () => {
    // The conditional spread, asserted where it actually matters. An always-present key here would
    // change every stored row and redden all 26 G-PARITY goldens.
    const pg = await driveRun(DRY_WINDOW);
    const [stored] = storedPlans(pg);
    expect(stored).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(stored, 'leaf_wetness')).toBe(false);
  });

  it('omits the key when the fetch supplies no window at all', async () => {
    // The shape before index.js's lift existed — guards against the lift regressing without the
    // engine or the component noticing.
    const pg = await driveRun(null);
    const [stored] = storedPlans(pg);
    expect(stored).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(stored, 'leaf_wetness')).toBe(false);
  });
});
