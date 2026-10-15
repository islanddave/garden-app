// indoorcadence.test.js — BUG-INDOORCADENCE-001 part 2: water_interval_days_indoor.
//
// Dave 2026-10-14 ("Split it"): five plants summer outside on intervals that are right for summer and
// winter in the Stable, where those intervals over-ask. The profile gains an indoor value that the
// engine reads in place of the container/in-ground interval ONLY while the planting is indoors
// (ledger.exposureClass === 'indoor'). Pinned here:
//   * indoors the key wins, in the legacy chain, in the Water Ledger fold (_wiBase) and in the
//     overwinter check's base;
//   * outdoors, unknown-location and rain-exposed-override plantings ignore it;
//   * an absent or unusable key leaves today's interval exactly as it was;
//   * migrations/v5-indoorcadence-002 writes the five values it says, binds 0a/0r/gates to each other,
//     and its prod-shaped profiles resolve as intended for the Stable pots and for the coleus parent
//     still outside in the Trough (it shares the Fairway Orange cultivar row with Clone 1).
// The unit suite mocks SQL: nothing here proves the migration applied. Its gates do that.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
import _cf from './_coverFlags.js';
import lf from './ledger-fixtures.js';
import { scenarios as paritySc } from '../../tests/parity/daily-plan/fixtures.mjs';

const { withCoverFlags } = _cf;
const { generatePlan, resolveCadence, baseWaterInterval } = engine;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, '..', '..', 'migrations', 'v5-indoorcadence-002');
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, '');
const SQL_0A = stripSqlComments(readFileSync(join(MIGRATION, '0a-data.sql'), 'utf8'));
const SQL_0R = stripSqlComments(readFileSync(join(MIGRATION, '0r-rollback.sql'), 'utf8'));
const GATES = readFileSync(join(MIGRATION, 'gates.yml'), 'utf8');

const TODAY = '2026-10-20';
const ago = (n) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const SYSTEM = { water_interval_days: 3, fertilize_interval_days: 14 };
// A cultivar profile shaped like the five on prod (cadence-backfill-20260823), plus the indoor key.
const PROF = (o) => ({ crop: 'ginger', _tier: 'T2', _source: 'cadence-backfill-20260823', confidence: 'low',
  water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2, ...o });

// A 10 in plastic pot: no vessel floor (dailyFloorFor needs a reservoir type or >= the large bucket),
// so the legacy interval is the base interval unchanged.
const P = (o) => withCoverFlags({ id: 'g1', name: 'Ginger', variety: 'Ginger', genus: 'Zingiber', status: 'vegetative',
  project: 'Herbs', project_id: 'ph', project_status: 'active', container_type: 'plastic_pot', container_size: '10 in',
  substrate_start: '2026-04-01', transplant_at: null, last_fert: ago(3), assignee_user_id: 'dave',
  covered: true, cadence_scopes: ['cultivar'], db_cadence: { ...SYSTEM, ...PROF({ water_interval_days_indoor: 5 }) },
  last_water: ago(3), ...o });
const MILD = { tonightLow: 45, highToday: 62, unit: 'F' };
const DRY = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 };
const LIVE = { rainCreditEnabled: true, rainMaxDaysEnabled: false, todayAwareEnabled: true };
const plan = (plantings, extra = {}) => generatePlan({ plantings, cadence: cad, fertModel: fm, today: TODAY,
  weather: MILD, hydrology: DRY, ownerFallback: 'dave', ...LIVE, ...extra }).users.dave;
const dueRow = (u, id) => u.tasks.water_due.find((r) => r.id === id);
const cOf = (p) => resolveCadence(p, cad);

describe('baseWaterInterval: the indoor key replaces the interval only indoors', () => {
  it('indoors (a covered location) the indoor value wins over the container interval', () => {
    const p = P({});
    expect(baseWaterInterval(p, cOf(p), cad)).toBe(5);
  });

  it('outdoors the key is ignored: the summer container interval stands', () => {
    const p = P({ covered: false });
    expect(baseWaterInterval(p, cOf(p), cad)).toBe(2);
  });

  it('an unknown location (both resolved flags false) is not indoors', () => {
    const p = P({ covered: undefined, rain_exposed_resolved: false, frost_covered_resolved: false });
    expect(baseWaterInterval(p, cOf(p), cad)).toBe(2);
  });

  it('an explicit rain_exposed override wins both ways: true or false, neither reads as indoors', () => {
    for (const rain_exposed of [true, false]) {
      const p = P({ rain_exposed });
      expect(baseWaterInterval(p, cOf(p), cad), String(rain_exposed)).toBe(2);
    }
  });

  it('indoors it also replaces an in-ground interval', () => {
    const p = P({ container_type: 'raised_bed', db_cadence: { ...SYSTEM, ...PROF({ water_interval_days_inground: 4, water_interval_days_indoor: 9 }) } });
    expect(baseWaterInterval(p, cOf(p), cad)).toBe(9);
    expect(baseWaterInterval({ ...p, frost_covered_resolved: false, rain_exposed_resolved: true }, cOf(p), cad)).toBe(4);
  });

  it('absent key: indoors and outdoors both get exactly the container interval, as before', () => {
    for (const covered of [true, false]) {
      const p = P({ covered, db_cadence: { ...SYSTEM, ...PROF({}) } });
      expect(baseWaterInterval(p, cOf(p), cad), String(covered)).toBe(2);
    }
  });

  it('an unusable value (0, negative, a string, null, NaN, Infinity) is ignored, never "every 0 days"', () => {
    for (const bad of [0, -3, '7', null, NaN, Infinity]) {
      const p = P({ db_cadence: { ...SYSTEM, ...PROF({ water_interval_days_indoor: bad }) } });
      expect(baseWaterInterval(p, cOf(p), cad), String(bad)).toBe(2);
    }
  });

  it('a bundled-fallback planting with no key keeps the house default', () => {
    const p = P({ cadence_scopes: [], db_cadence: null, variety: null, name: 'Mystery', genus: null });
    expect(baseWaterInterval(p, cOf(p), cad)).toBe(cad.default.water_interval_days_container);
  });
});

describe('legacy chain (ledger off): the morning list', () => {
  it('indoors, 3 days since water on a 5-day indoor value: not due; the summer 2 would have asked', () => {
    expect(dueRow(plan([P({})]), 'g1')).toBeUndefined();
    expect(dueRow(plan([P({ db_cadence: { ...SYSTEM, ...PROF({}) } })]), 'g1')).toMatchObject({ interval: 2, overdue_by: 1 });
  });

  it('indoors, 5 days since water: due on the indoor interval', () => {
    expect(dueRow(plan([P({ last_water: ago(5) })]), 'g1')).toMatchObject({ interval: 5, days_since: 5, overdue_by: 0 });
  });

  it('outdoors, the same profile asks on the summer interval', () => {
    expect(dueRow(plan([P({ covered: false })]), 'g1')).toMatchObject({ interval: 2, overdue_by: 1 });
  });

  it('outdoors the key is inert: the whole plan deep-equals the plan with no key', () => {
    const withKey = plan([P({ covered: false })]);
    const without = plan([P({ covered: false, db_cadence: { ...SYSTEM, ...PROF({}) } })]);
    expect(withKey).toEqual(without);
  });

  it('a never-watered indoor planting reports the indoor interval on its no-history row', () => {
    const u = plan([P({ last_water: null })]);
    const row = [...u.tasks.water_due, ...u.tasks.no_history].find((r) => r.id === 'g1');
    expect(row).toMatchObject({ interval: 5, never: true });
  });
});

describe('Water Ledger fold (ledger on): _wiBase carries the indoor value', () => {
  const at = (d, h) => lf.at(d, h);
  const ledgerPlan = (p) => generatePlan({ plantings: [p], cadence: cad, fertModel: fm, today: lf.TODAY, nowMs: lf.NOW,
    weather: lf.WX, hydrology: lf.HY, ownerFallback: 'dave', ...LIVE, waterLedgerEnabled: true,
    weatherDaily: lf.weatherDaily(), eventsByPlant: { [p.id]: [{ id: 'e1', t: at(p.last_water, 9), type: 'watering', depth: null }] },
  }).users.dave;
  const LP = (o) => P({ last_water: lf.ago(6), ...o });

  it('indoors the fold uses 5 (wi_eff 5), not the summer 2', () => {
    const row = dueRow(ledgerPlan(LP({})), 'g1');
    expect(row).toBeDefined();
    expect(row.interval).toBe(5);
    expect(row.ledger.wi_eff).toBe(5);
  });

  it('indoors at 4 days the fold is not due on 5, and is due on the summer 2', () => {
    expect(dueRow(ledgerPlan(LP({ last_water: lf.ago(4) })), 'g1')).toBeUndefined();
    const summer = dueRow(ledgerPlan(LP({ last_water: lf.ago(4), db_cadence: { ...SYSTEM, ...PROF({}) } })), 'g1');
    expect(summer && summer.ledger.wi_eff).toBe(2);
  });

  it('outdoors the fold ignores the key', () => {
    const row = dueRow(ledgerPlan(LP({ covered: false })), 'g1');
    expect(row && row.ledger.wi_eff).toBe(2);
  });
});

describe('overwinter check: the indoor value is the base under the regime minimum', () => {
  const OW = (indoor, o = {}) => P({ id: 'ow1', last_water: '2026-12-01', last_hand_water: '2026-12-01',
    db_cadence: { ...SYSTEM, ...PROF({ ...(indoor == null ? {} : { water_interval_days_indoor: indoor }) }), overwintering: { regime: 'tender_indoors' } }, ...o });
  const owPlan = (p) => generatePlan({ plantings: [p], cadence: cad, fertModel: fm, today: '2027-01-15',
    weather: { tonightLow: 22, highToday: 34, unit: 'F' }, hydrology: DRY, ownerFallback: 'dave' }).users.dave;
  const owRow = (u) => (u.tasks.overwintering || []).find((r) => r.id === 'ow1');

  it('an indoor value above the 7-day tender_indoors check is used (12)', () => {
    expect(owRow(owPlan(OW(12)))).toMatchObject({ interval: 12 });
  });

  it('below it, the regime minimum still wins (max(4, 7) = 7), as it does with no key', () => {
    expect(owRow(owPlan(OW(4)))).toMatchObject({ interval: 7 });
    expect(owRow(owPlan(OW(null)))).toMatchObject({ interval: 7 });
  });
});

describe('no existing fixture carries the key, so every committed golden is untouched', () => {
  it('parity and ledger scenarios: no profile names water_interval_days_indoor', () => {
    const all = [...paritySc, ...lf.scenarios].flatMap((s) => s.input.plantings || []);
    expect(all.length).toBeGreaterThan(10);
    expect(JSON.stringify(all)).not.toContain('water_interval_days_indoor');
    expect(JSON.stringify(cad)).not.toContain('water_interval_days_indoor');
  });
});

// ── migrations/v5-indoorcadence-002 ────────────────────────────────────────────────────────────────
// care_profile row -> cultivar -> Stable planting, read on prod 2026-10-14 (indoor-intervals-20261014.md).
const ROWS = [
  { row: 'a29447b8-387f-4390-ac73-7e152efcbe8d', cultivar: 'be1211e0-0e4f-41c2-a37d-f48c313aac0b', md5: '5421338c837dae75308c5df32312e817',
    planting: '0064e3a9-3168-4fe0-a6eb-42fc84ad8a04', name: 'Ginger', crop: 'ginger', summer: 2, indoor: 5, ct: 'plastic_pot', size: '10 in' },
  { row: 'e74d95b7-df0a-4948-9bf2-d5bfd1bbeeea', cultivar: '72ebf73c-bf46-429a-bb2d-3243e3d0826d', md5: '81f8ce0784e2747cf5a2ee469ec558b7',
    planting: 'edfc68f5-2342-4605-9e82-e03f94f3143d', name: 'Lemon Verbena', crop: 'lemon verbena', summer: 1, indoor: 7, ct: 'fabric_bag', size: '5 gal' },
  { row: '6b8e2195-5534-4bb6-aceb-c91a9daebc88', cultivar: 'db83be63-5344-4615-9399-4eb0644dce14', md5: 'fff6d33d22b85c1bd849b7d2c22a3e48',
    planting: '39141bf6-fc5d-46a6-99d8-2a190906956a', name: 'Lemon Thyme', crop: 'thyme', summer: 2, indoor: 7, ct: 'ceramic', size: '4 in' },
  { row: '573c512c-f98a-4b1f-9fc6-c18afced8306', cultivar: 'ba9e69e5-b8e5-40ea-a4a4-aeee7411ddd2', md5: 'f1da83d4f74e9ebd64f003074786bc8c',
    planting: '6cfdc63e-a62a-4408-b9b9-6edf913ff1ce', name: 'Fairway Orange Coleus Clone 1', crop: 'coleus', summer: 1, indoor: 5, ct: 'terracotta', size: '15 gal' },
  { row: '6834e8f5-2342-4605-9e82-e03f94f3143d', cultivar: '6f1ebb8f-9e65-4a95-bd7e-4ba9b1a659ef', md5: 'ca6ecefc181fbc46514d1976ab831ffa',
    planting: '2d50a15d-0bc3-4a37-a9aa-5a134df7b0a9', name: 'Italian Parsley', crop: 'parsley', summer: 2, indoor: 4, ct: 'plastic_pot', size: '4 in' },
];
const STAMP = '5.0.0-indoorcadence-002';
const TROUGH_COLEUS = '293cd7d2-2fee-41c8-8d88-30b9dcfffb9e';

// The UPDATE's VALUES list: (id, cultivar, md5, indoor, note).
const WRITES = [...SQL_0A.matchAll(/\('([0-9a-f-]{36})'::uuid, '([0-9a-f-]{36})'::uuid,\s+'([0-9a-f]{32})', (\d+),\s+'([^']+)'\)/g)]
  .map((m) => ({ row: m[1], cultivar: m[2], md5: m[3], indoor: Number(m[4]), note: m[5] }));
// The DO block's assert list: (id, indoor, summer).
const ASSERTS = [...SQL_0A.matchAll(/\('([0-9a-f-]{36})'::uuid, (\d+), (\d+)\)/g)]
  .map((m) => ({ row: m[1], indoor: Number(m[2]), summer: Number(m[3]) }));
const gate = (name) => {
  const i = GATES.indexOf(`- name: ${name}\n`);
  if (i < 0) throw new Error(`gate ${name} not found`);
  const j = GATES.indexOf('- name: ', i + 1);
  return GATES.slice(i, j < 0 ? undefined : j);
};

describe('v5-indoorcadence-002 0a: five indoor values, merged in, nothing else', () => {
  it('writes exactly the five rows, each keyed by id + (cultivar, scope_id) + md5, at Dave\'s values', () => {
    expect(WRITES.map(({ row, cultivar, md5, indoor }) => ({ row, cultivar, md5, indoor })))
      .toEqual(ROWS.map(({ row, cultivar, md5, indoor }) => ({ row, cultivar, md5, indoor })));
    expect(SQL_0A).toMatch(/WHERE cp\.id = v\.id\s+AND cp\.scope = 'cultivar'\s+AND cp\.scope_id = v\.cultivar\s+AND md5\(cp\.profile::text\) = v\.md5_before;/);
  });

  it('merges (||) three keys and never replaces the profile or touches the summer interval', () => {
    expect(SQL_0A).toMatch(/SET profile = cp\.profile \|\| jsonb_build_object\(\s*'water_interval_days_indoor', v\.indoor,\s*'_indoor_source', 'v5-indoorcadence-002',\s*'_indoor_note', v\.note\)/);
    expect(SQL_0A).not.toMatch(/'water_interval_days_container'\s*,/);
    expect(SQL_0A).not.toMatch(/'_source'\s*,|'notes'\s*,/);
  });

  it('the assert block names the same five rows, the same indoor values and today\'s summer values', () => {
    expect(ASSERTS).toEqual(ROWS.map(({ row, indoor, summer }) => ({ row, indoor, summer })));
    expect(SQL_0A).toMatch(/IF n <> 5 THEN\s+RAISE EXCEPTION/);
  });

  it('writes only care_profile and the stamp; no DELETE anywhere in 0a or 0r', () => {
    expect(SQL_0A.match(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.\w+/g))
      .toEqual(['UPDATE public.care_profile', 'INSERT INTO public.schema_version']);
    expect(SQL_0A).toContain(`VALUES ('${STAMP}',`);
    expect(SQL_0A + SQL_0R).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
  });
});

describe('0r strips exactly what 0a added, only where 0a wrote it', () => {
  it('removes the three keys, on the five rows, only when _indoor_source is this migration', () => {
    expect(SQL_0R).toMatch(/SET profile = profile - 'water_interval_days_indoor' - '_indoor_source' - '_indoor_note'/);
    for (const r of ROWS) expect(SQL_0R).toContain(`'${r.row}'`);
    expect(SQL_0R).toMatch(/AND scope = 'cultivar'\s+AND profile->>'_indoor_source' = 'v5-indoorcadence-002';/);
  });

  it('0a followed by 0r is the profile 0a read (the md5 guard matches again)', () => {
    const before = { ...PROF({}) };
    const after0a = { ...before, water_interval_days_indoor: 5, _indoor_source: 'v5-indoorcadence-002', _indoor_note: 'x' };
    const { water_interval_days_indoor, _indoor_source, _indoor_note, ...after0r } = after0a;
    expect([water_interval_days_indoor, _indoor_source, _indoor_note].every((v) => v != null)).toBe(true);
    expect(after0r).toEqual(before);
  });

  it('marks the receipt rolled back instead of deleting it, so the post gates disarm', () => {
    expect(SQL_0R).toMatch(new RegExp(`UPDATE public\\.schema_version\\s+SET description = 'ROLLED BACK '[\\s\\S]*WHERE version = '${STAMP.replace(/\./g, '\\.')}'\\s+AND description NOT LIKE 'ROLLED BACK %';`));
  });
});

describe('gates.yml carries the same rows and values as 0a', () => {
  it('pre pins the same five md5s', () => {
    const g = gate('pre_five_profiles_as_read_on_prod');
    for (const r of ROWS) expect(g).toContain(`('${r.row}'::uuid, '${r.md5}')`);
    expect(g).toMatch(/value: 5\n/);
  });

  it('the standing gate is continuous, self-armed on a live receipt, and names all five rows', () => {
    const g = gate('post_indoor_interval_stays_on_the_five_profiles');
    expect(g).not.toMatch(/continuous: false/);
    expect(g).toContain(`WHERE version = '${STAMP}'`);
    expect(g).toContain(`description NOT LIKE 'ROLLED BACK %'`);
    for (const r of ROWS) expect(g).toContain(r.row);
  });

  it('the apply-time gates carry 0a\'s values and the five Stable plantings', () => {
    const s = gate('post_summer_intervals_untouched');
    for (const r of ROWS) expect(s).toContain(`('${r.row}'::uuid, ${r.indoor}, ${r.summer})`);
    const v = gate('post_stable_plantings_resolve_the_indoor_interval');
    for (const r of ROWS) expect(v).toContain(r.planting);
    expect(v).not.toContain(TROUGH_COLEUS);
  });

  it('every gate that names a prod id is env: prod', () => {
    const names = [...GATES.matchAll(/- name: (\S+)\n/g)].map((m) => m[1]);
    expect(names.length).toBe(5);
    for (const n of names) {
      const g = gate(n);
      if (/[0-9a-f]{8}-[0-9a-f]{4}-/.test(g)) expect(g, n).toMatch(/\n\s+env: prod\n/);
    }
  });
});

describe('the migrated profiles, end to end through the engine', () => {
  const merged = (r) => ({ ...SYSTEM, ...PROF({ crop: r.crop, water_interval_days_container: r.summer }),
    water_interval_days_indoor: WRITES.find((w) => w.row === r.row).indoor });
  const stablePot = (r) => P({ id: r.planting, name: r.name, variety: r.name, container_type: r.ct, container_size: r.size,
    covered: true, db_cadence: merged(r) });

  it('each Stable planting still resolves from the database and gets its indoor value', () => {
    for (const r of ROWS) {
      const p = stablePot(r);
      const c = cOf(p);
      expect(c._via, r.name).toBe('db');
      expect(baseWaterInterval(p, c, cad), r.name).toBe(r.indoor);
    }
  });

  it('the coleus parent outside in the Trough shares the cultivar row and keeps its summer 1', () => {
    const coleus = ROWS.find((r) => r.crop === 'coleus');
    const p = P({ id: TROUGH_COLEUS, name: 'Fairway Orange Coleus', variety: 'Fairway Orange', container_type: 'terracotta',
      container_size: '15 gal', covered: false, db_cadence: merged(coleus) });
    expect(baseWaterInterval(p, cOf(p), cad)).toBe(1);
  });

  it('on the morning list, 3 days after a watering none of the five Stable pots is asked; before 0a all five were', () => {
    const after = plan(ROWS.map((r) => stablePot(r)));
    const before = plan(ROWS.map((r) => ({ ...stablePot(r), db_cadence: { ...SYSTEM, ...PROF({ crop: r.crop, water_interval_days_container: r.summer }) } })));
    expect(after.tasks.water_due.map((x) => x.id)).toEqual([]);
    expect(before.tasks.water_due.map((x) => x.id).sort()).toEqual(ROWS.map((r) => r.planting).sort());
  });
});
