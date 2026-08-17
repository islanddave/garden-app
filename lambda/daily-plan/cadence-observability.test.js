// DRG-CADENCEOBS-001 — the `cadence-fallback` emit. MEASUREMENT ONLY.
//
// The engine resolves a cadence four times a night and throws the provenance away at all four call
// sites, so engine.js:81 — the `_via:'default'` fallthrough that hands a planting the house 3-day
// container cadence — is invisible. On prod 2026-08-17 that fallthrough owned 20 of 229 active
// plantings (all 20 Dave's, 0 of Jen's 16) and produced 18 of Dave's 194 water_due tasks.
//
// These tests are the anti-vacuity core of the slice. A counter is the easiest thing in this repo to
// ship broken-but-green: hard-code the number, count the wrong array, or read a stale copy of
// `plantings` and every naive "the number is 1" assertion still passes. So every count assertion below
// is paired with a MUTATION that must move it, in both directions.
//
// FIXTURE PROVENANCE — all three rows are verbatim live prod shapes read 2026-08-17 (read-only SELECT
// against Neon `neondb`, joining plants -> plant_varieties -> v_resolved_care, exactly the handler's own
// query at handler.js:693-789):
//
//   Yellow Brandywine  genus NULL   cadence_scopes {}          system-only profile  -> _via 'default'
//   Redbor Kale        Brassica     cadence_scopes {}          system-only profile  -> _via 'genus'
//   Jade Plant         Crassula     cadence_scopes {cultivar}  researched profile   -> _via 'db'
//
// Two shape details that an invented fixture would get wrong, and that matter:
//   (1) `cadence_scopes: []` — a real empty text[], NOT null/absent. Every one of the 29 parity
//       fixtures omits this key, so the whole parity corpus takes the legacy `_seeded` arm of
//       engine.js:44 — an arm prod does not execute (CARE_CADENCE_SCOPES_ENABLED=true).
//   (2) the system profile expresses its interval under `water_interval_days`, a key the engine NEVER
//       reads (engine.js:489-491 reads only *_container / *_inground). Its value happens to equal
//       cad.default's 3, which is why this has never been noticed.
//
// Jade Plant carries Jen's real Clerk sub so by_owner is exercised with two distinct owners rather
// than one — pooled-only counting is the specific way this measurement would go blind to her.
import { describe, it, expect, vi, afterEach } from 'vitest';
import h from './handler.js';
import engine from './engine.js';
import cadence from './cadence-data-v2.json';
import _cf from './_coverFlags.js';

const { run } = h;
const { resolveCadence } = engine;
const { withCoverFlags } = _cf;

const SPACE = 'sp1';
const DATE = '2026-06-20';
const FALLBACK = 'user_owner_fallback';   // OWNER_FALLBACK_SUB — unassigned rows land here
const JEN = 'user_3E2xA85kQhr1vSZhiv4W1GLudJV';

// The system-only resolved_profile, verbatim from prod. Identical on every naked-default row.
const SYSTEM_PROFILE = { light: 'part_sun', water_amount_ml: 250, water_interval_days: 3, fertilize_interval_days: 14 };
// The researched Crassula cultivar profile, trimmed to the cadence-bearing keys.
const JADE_PROFILE = { _source: 'cowork_care_audit_20260709', crop: 'succulent (jade / Crassula ovata)',
  drought_tolerance: 'high', water_interval_days: 12, water_interval_days_container: 12,
  water_interval_days_inground: null, fertilize_interval_days: 45 };

const P = (ov) => withCoverFlags({
  project_id: 'pj1', project: 'Garden', project_status: 'active', workspace_id: SPACE,
  rain_exposed: null, covered: false, assignee_user_id: null, last_water: '2026-06-14',
  last_fert: '2026-06-01', substrate_start: '2026-06-01', transplant_at: '2026-06-01', ...ov,
});

const ROWS = () => [
  P({ id: 'nd1', name: 'Yellow Brandywine', variety: 'Yellow Brandywine', genus: null,
      crop_type_slug: 'tomato', container_type: 'fabric_bag', container_size: '5 gal',
      status: 'vegetative', cadence_scopes: [], db_cadence: { ...SYSTEM_PROFILE } }),
  P({ id: 'gn1', name: 'Redbor Kale', variety: 'Redbor', genus: 'Brassica', crop_type_slug: 'kale',
      container_type: 'tray_cell', container_size: null, status: 'seedling',
      cadence_scopes: [], db_cadence: { ...SYSTEM_PROFILE } }),
  P({ id: 'db1', name: 'Jade Plant', variety: 'Crassula ovata', genus: 'Crassula',
      crop_type_slug: 'jade', container_type: 'plastic_pot', container_size: null,
      status: 'vegetative', assignee_user_id: JEN,
      cadence_scopes: ['cultivar'], db_cadence: { ...JADE_PROFILE } }),
];

function pgStub(plantings) {
  const writes = [];
  const query = vi.fn(async (sql, params) => {
    if (/from plants/.test(sql)) return { rows: plantings };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    if (/insert into daily_plan/.test(sql)) { writes.push(JSON.parse(params[2])); return { rows: [] }; }
    return { rows: [] };
  });
  return { query, writes };
}

const wx = async () => ({ tonightLow: 58, highToday: 78, code: 1, unit: 'F', short: 'Clear' });
const precip = async () => ({ forecast_lows: [null, null, null],
  forecast_dates: ['2026-06-21', '2026-06-22', '2026-06-23'], recent_precip_in: 0, today_precip_in: 0,
  today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0 });

async function drive(plantings = ROWS()) {
  vi.stubEnv('OWNER_FALLBACK_SUB', FALLBACK);
  vi.stubEnv('CARE_CADENCE_SCOPES_ENABLED', 'true');           // the live prod arm
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const pg = pgStub(plantings);
  const res = await run({ pg, today: DATE, dryRun: false, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: wx, fetchPrecip: precip, fetchStation: async () => null, etHour: 2, event: {} });
  const lines = spy.mock.calls.map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { res, pg, spy, lines, emits: lines.filter((l) => l.msg === 'cadence-fallback') };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// ── The fixture must genuinely exercise the branches it claims to, or every count below is theatre ──
describe('fixture validity — the rows resolve the arms they are named for', () => {
  it('each row resolves its intended arm under the flag-ON (real prod) shape', () => {
    const [nd, gn, db] = ROWS();
    expect(resolveCadence(nd, cadence)._via).toBe('default');
    expect(resolveCadence(gn, cadence)._via).toBe('genus:Brassica');
    expect(resolveCadence(db, cadence)._via).toBe('db');
  });

  it('the naked-default row really does land on the bare 3-day container interval', () => {
    // If cad.default ever gains an inground key or the fallthrough changes shape, this reds and the
    // "20 plantings on a cadence nobody chose" framing needs rewriting.
    const c = resolveCadence(ROWS()[0], cadence);
    expect(c.water_interval_days_container).toBe(3);
    expect(c.water_interval_days_inground).toBeUndefined();
  });

  it('the system-only profile hides its interval under a key the engine never reads', () => {
    // The trap: `water_interval_days: 3` reads correct in the DB and does nothing. It is a coincidence
    // that it equals cad.default. Change it to 7 here and the resolved interval does not move.
    const c = resolveCadence(P({ id: 'x', variety: 'Yellow Brandywine', genus: null,
      cadence_scopes: [], db_cadence: { ...SYSTEM_PROFILE, water_interval_days: 7 } }), cadence);
    expect(c.water_interval_days_container).toBe(3);
  });
});

describe('the emit reports the correct arm counts', () => {
  it('counts every arm, names the naked-default rows, and totals to the row count', async () => {
    const { emits } = await drive();
    expect(emits).toHaveLength(1);
    const e = emits[0];
    expect(e.rows).toBe(3);
    expect(e.via).toEqual({ default: 1, genus: 1, db: 1 });
    expect(e.naked_default).toBe(1);
    expect(e.naked_default_ids).toEqual(['nd1']);
    expect(Object.values(e.via).reduce((a, b) => a + b, 0)).toBe(e.rows);
  });

  it('MUTATION (a): giving the default row a bearing cadence_scope drops naked_default 1 -> 0', async () => {
    // Broke: nd1.cadence_scopes [] -> ['cultivar'] with a *_container key, so engine.js:46 adopts it.
    // Confirmed failing against a hard-coded counter.
    const rows = ROWS();
    rows[0].cadence_scopes = ['cultivar'];
    rows[0].db_cadence = { ...SYSTEM_PROFILE, water_interval_days_container: 5 };
    const { emits } = await drive(rows);
    expect(emits[0].naked_default).toBe(0);
    expect(emits[0].naked_default_ids).toEqual([]);
    expect(emits[0].via).toEqual({ db: 2, genus: 1 });
  });

  it('MUTATION (b): a genus absent from by_genus_fallback pushes naked_default 1 -> 2', async () => {
    // Broke: gn1.genus 'Brassica' -> 'Zzzz'. The genus arm cannot fire, so the row joins the
    // fallthrough. This is the direction that a counter reading a stale copy of `plantings` misses.
    const rows = ROWS();
    rows[1].genus = 'Zzzz';
    const { emits } = await drive(rows);
    expect(emits[0].naked_default).toBe(2);
    expect(emits[0].naked_default_ids).toEqual(['nd1', 'gn1']);
    expect(emits[0].via).toEqual({ default: 2, db: 1 });
  });

  it('MUTATION (c): the count follows the array, not a constant — one row in, one row counted', async () => {
    const { emits } = await drive([ROWS()[0]]);
    expect(emits[0].rows).toBe(1);
    expect(emits[0].via).toEqual({ default: 1 });
    expect(emits[0].naked_default).toBe(1);
  });
});

describe('per-user disaggregation — Jen must not be invisible inside Dave', () => {
  it('by_owner keys on the assignee, falling back to OWNER_FALLBACK_SUB', async () => {
    const { emits } = await drive();
    expect(emits[0].by_owner).toEqual({
      [FALLBACK]: { default: 1, genus: 1 },
      [JEN]: { db: 1 },
    });
  });

  it('by_owner sums to via for every arm', async () => {
    const rows = ROWS();
    rows[1].assignee_user_id = JEN;                    // move one row across the owner boundary
    const { emits } = await drive(rows);
    const e = emits[0];
    for (const arm of Object.keys(e.via)) {
      const summed = Object.values(e.by_owner).reduce((a, o) => a + (o[arm] || 0), 0);
      expect(summed).toBe(e.via[arm]);
    }
    expect(e.by_owner[JEN]).toEqual({ genus: 1, db: 1 });
  });

  it('MUTATION (d): a naked default on the OTHER user shows up under that user, not pooled away', async () => {
    // Jen's real 0 % is a 16-row sample-size zero, not a property. If the emit ever collapsed to a
    // pooled total her first unresolved planting would be one row inside Dave's 213.
    const rows = ROWS();
    rows[0].assignee_user_id = JEN;
    const { emits } = await drive(rows);
    expect(emits[0].by_owner[JEN]).toEqual({ default: 1, db: 1 });
    expect(emits[0].by_owner[FALLBACK]).toEqual({ genus: 1 });
  });
});

describe('no_interval_key — the second, less obvious entry to the bare 3 (engine.js:489-491)', () => {
  it('is 0 when every adopted profile carries an interval key (prod today)', async () => {
    const { emits } = await drive();
    expect(emits[0].no_interval_key).toBe(0);
  });

  it('MUTATION (e): adopting a profile with NO *_container / *_inground key counts', async () => {
    // Broke: db1's profile stripped of both interval keys while keeping a bearing scope — the exact
    // Collards shape (a cultivar row with sizing only). It is adopted _via db and then falls to
    // cad.default anyway at engine.js:489-491, silently.
    const rows = ROWS();
    rows[2].db_cadence = { crop: 'x', container_type: 'fabric_grow_bag', water_interval_days: 3 };
    const { emits } = await drive(rows);
    expect(emits[0].via.db).toBe(1);          // still adopted...
    expect(emits[0].no_interval_key).toBe(1); // ...and still lands on the bare 3
  });
});

describe('containment — an observability slice can never cost a nightly plan', () => {
  it('does not mutate the plantings array (it is handed on to generatePlan AND frostClass)', async () => {
    // The obvious convenient implementation stamps p._cadence_via = c._via onto each row. That field
    // would travel into two consumers. Snapshot is taken of the SAME array object the handler mutates
    // in place (line 809 nulls System subs, 916 nulls cadence_scopes), so it is captured after drive()
    // resolves against a deep clone made before the run.
    const rows = ROWS();
    const before = JSON.parse(JSON.stringify(rows));
    await drive(rows);
    for (let i = 0; i < rows.length; i++) {
      // Only the handler's own documented in-place edits are permitted; no new keys at all.
      expect(Object.keys(rows[i]).sort()).toEqual(Object.keys(before[i]).sort());
      expect(rows[i]._cadence_via).toBeUndefined();
    }
  });

  it('a throwing row is contained: the plan is still produced and the failure is logged', async () => {
    // The obvious injection — a null row — is NOT usable here: the handler dereferences
    // p.assignee_user_id at line 809, well before this emit, so a null row kills the run for a reason
    // that has nothing to do with observability. Injecting at the exact seam instead: a one-shot
    // throwing `variety` getter, which is what resolveCadence dereferences unguarded (engine.js:48,
    // after the `p && p.cadence_scopes` guard at :43). It throws on the emit's read and behaves
    // normally for generatePlan's, so this isolates the emit's blast radius from everything else.
    // Remove the try/catch and this test throws instead of asserting.
    const rows = ROWS();
    let armed = true;
    Object.defineProperty(rows[1], 'variety', {
      configurable: true,
      get() { if (armed) { armed = false; throw new Error('boom'); } return 'Redbor'; },
    });
    const { res, lines, emits } = await drive(rows);
    expect(armed).toBe(false);                       // the seam really was reached
    expect(res).toBeTruthy();                        // the nightly plan survived
    expect(emits).toHaveLength(0);
    const failed = lines.find((l) => l.msg === 'cadence-fallback-failed');
    expect(failed).toBeTruthy();
    expect(failed.error).toBe('boom');
  });

  it('emits EXACTLY ONE line per run and it parses as JSON', async () => {
    // Placed six lines lower it would sit inside the per-space loop (handler.js:938) and produce N
    // lines with N different denominators. Two spaces, one emit.
    const rows = ROWS();
    rows[2].workspace_id = 'sp2';
    vi.stubEnv('OWNER_FALLBACK_SUB', FALLBACK);
    vi.stubEnv('CARE_CADENCE_SCOPES_ENABLED', 'true');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pg = {
      query: vi.fn(async (sql) => {
        if (/from plants/.test(sql)) return { rows };
        if (/from spaces/.test(sql)) return { rows: [
          { id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 },
          { id: 'sp2', postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
        return { rows: [] };
      }),
    };
    await run({ pg, today: DATE, dryRun: false, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
      fetchNWS: wx, fetchPrecip: precip, fetchStation: async () => null, etHour: 2, event: {} });
    const raw = spy.mock.calls.map(([l]) => l).filter((l) => typeof l === 'string' && l.includes('"cadence-fallback"'));
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0]).rows).toBe(3);
  });
});

describe('the emit contributes nothing to the stored plan payload', () => {
  it('no cadence/provenance key reaches daily_plan.items', async () => {
    const { pg } = await drive();
    expect(pg.writes.length).toBeGreaterThan(0);
    const blob = JSON.stringify(pg.writes);
    for (const leaked of ['_via', 'cadence_fallback', 'naked_default', 'by_owner', '_cadence_via']) {
      expect(blob).not.toContain(leaked);
    }
  });
});

describe('anti-drift source guards', () => {
  it('the emit lives OUTSIDE generatePlan and reads the post-flag plantings array', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'handler.js'), 'utf8');
    const emitAt = src.indexOf("msg: 'cadence-fallback'");
    const flagAt = src.indexOf('p.cadence_scopes = null');
    const loopAt = src.indexOf('(bySpace[p.workspace_id]');
    expect(emitAt).toBeGreaterThan(flagAt);   // observes what generatePlan will receive
    expect(emitAt).toBeLessThan(loopAt);      // one line per run, not one per space
  });

  it('the emit is wrapped — the catch arm is present and logs its own msg', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'handler.js'), 'utf8');
    expect(src).toMatch(/msg: 'cadence-fallback-failed'/);
  });
});
