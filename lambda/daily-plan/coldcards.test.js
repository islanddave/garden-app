// V5-COLDSHADOWCENSUS-001 — the POTTED plantings among the 19 live plantings whose bundled bring-inside threshold a
// database care profile shadows (the mechanism, and the first two, are coldshadow.test.js / v5-coldshadow-001).
// Dave, 2026-09-19: "card the potted ones". migrations/v5-coldshadow-002 adds the one key, `cold`, to ten cultivar
// care profiles written by cadence-backfill-20260823, copying the bundled value the census resolved. No engine change.
//
// Pinned here, through the real call site (engine.generatePlan -> tasks.cold) and coldFor itself:
//   * every value 0a writes, PARSED OUT OF 0a-data.sql, equals the bundled entry the census resolved for that
//     cultivar's plantings (resolveCadence with no database scope), and 0r and the gates.yml receipts carry the
//     same literals;
//   * 0a writes exactly the ten rows, none of the eight the decision excluded, and none of v5-coldshadow-001's;
//   * each bundled entry is about the same plant as the cultivar it is copied onto (its crop names the genus) — the
//     by_variety["Peach"] pepper fails that check, which is why the Peach tree is not here;
//   * each of the eleven plantings cards at its threshold and not one degree above; before the apply none cards at
//     any temperature except Spider Plant, at the crop-type fallback's 45F;
//   * the fixtures really exercise the ADOPTED DATABASE PROFILE (`_via 'db'`), and the bundled entry alone gives the
//     same threshold — so a fixture that silently fell through to it would be caught;
//   * the frost email does not move: every crop type here is banded, and the cadence promotion only lifts unbanded
//     ones;
//   * the three brief-named exclusions are what the decision says they are: writing the bundled value would change
//     nothing for Echeveria or Ginger, and would drop Jade from 45F to 40F.
// The unit suite mocks SQL: nothing here proves the migration applied or the rows exist. Its gates do.
//
// MUTATION LOG — 2026-09-19, lane-coldcards-20260919. Each applied to ONE file, this file run, RED observed, file
// restored byte-for-byte (sha256 checked), GREEN re-observed. Recorded in the lane findings
// (_mainsync5_20260919/coldcards.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
import fc from './frostClass.js';

const { generatePlan, resolveCadence, coldFor } = engine;
const { summarize } = fc;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', '..', 'migrations');
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, '');
const RAW_0A = readFileSync(join(MIGRATIONS, 'v5-coldshadow-002', '0a-data.sql'), 'utf8');
const SQL_0A = stripSqlComments(RAW_0A);
const RAW_0R = readFileSync(join(MIGRATIONS, 'v5-coldshadow-002', '0r-rollback.sql'), 'utf8');
const SQL_0R = stripSqlComments(RAW_0R);
const GATES = readFileSync(join(MIGRATIONS, 'v5-coldshadow-002', 'gates.yml'), 'utf8');
const SQL_001 = stripSqlComments(readFileSync(join(MIGRATIONS, 'v5-coldshadow-001', '0a-data.sql'), 'utf8'));

// Read on prod 2026-09-19: care_profile row -> its cultivar (plant_varieties id, name, genus, crop type) -> the
// bundled entry the census resolved for its plantings -> the row's profile exactly as read (8 keys, no `cold`) ->
// every planting of that cultivar (all live, all potted, none heated, none with a leaf-scope row).
const ROWS = [
  { row: '9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c', cultivar: '3db84405-1941-4e88-bb77-58595f47c3e7',
    variety: 'Cobaea scandens (Violet)', genus: 'Cobaea', slug: 'cobaea', bundled: ['by_genus_fallback', 'Cobaea'],
    profile: { crop: 'cobaea', water_interval_days_container: 2, water_method: 'drench_to_drainage', drought_tolerance: 'low',
      confidence: 'medium', _tier: 'T2', _source: 'cadence-backfill-20260823',
      notes: "No crop baseline existed. Cadence derived from Dave's own watering log: median gap 1.5d over 18 intervals." },
    plantings: [{ id: '1ef9592e-4d69-4171-a21e-24cf5c3f2e61', name: 'Cobaea scandens (Violet)', container_type: 'plastic_pot', status: 'vegetative' }] },
  { row: '04554719-e633-44d7-8791-f3e33c90ed2d', cultivar: 'ba53f113-9903-449d-81b9-7dce30ef3934',
    variety: 'Easy Wave Berry Velour', genus: 'Petunia', slug: 'petunia', bundled: ['by_genus_fallback', 'Petunia'],
    profile: { crop: 'petunia', water_interval_days_container: 1, water_method: 'drench_to_drainage', drought_tolerance: 'low',
      confidence: 'medium', _tier: 'T2', _source: 'cadence-backfill-20260823',
      notes: "No crop baseline existed. Cadence derived from Dave's own watering log: median gap 1.0d over 19 intervals." },
    plantings: [{ id: 'ac3c0e05-aada-47c6-a4c1-447ee3906b79', name: 'Easy Wave Berry Velour Petunia', container_type: 'plastic_pot', status: 'flowering' }] },
  { row: '573c512c-f98a-4b1f-9fc6-c18afced8306', cultivar: 'ba9e69e5-b8e5-40ea-a4a4-aeee7411ddd2',
    variety: 'Fairway Orange', genus: 'Coleus', slug: 'coleus', bundled: ['by_genus_fallback', 'Coleus'],
    profile: { crop: 'coleus', water_interval_days_container: 1, water_method: 'drench_to_drainage', drought_tolerance: 'low',
      confidence: 'medium', _tier: 'T2', _source: 'cadence-backfill-20260823',
      notes: "No crop baseline existed. Cadence derived from Dave's own watering log: median gap 1.0d over 32 intervals." },
    plantings: [{ id: '293cd7d2-2fee-41c8-8d88-30b9dcfffb9e', name: 'Fairway Orange Coleus', container_type: 'terracotta', status: 'vegetative' },
      { id: '6cfdc63e-a62a-4408-b9b9-6edf913ff1ce', name: 'Fairway Orange Coleus Clone 1', container_type: 'terracotta', status: 'vegetative' }] },
  { row: '2d2bc039-58e4-4ce7-8930-e58a66c4cd5a', cultivar: 'd3101ac0-fd4e-456e-86b7-ebea732ac84c',
    variety: 'Jewel Mix Nasturtium', genus: 'Tropaeolum', slug: 'nasturtium', bundled: ['by_genus_fallback', 'Tropaeolum'],
    profile: { crop: 'nasturtium', water_interval_days_container: 2, water_method: 'drench_to_drainage', drought_tolerance: 'low',
      confidence: 'medium', _tier: 'T2', _source: 'cadence-backfill-20260823',
      notes: "No crop baseline existed. Cadence derived from Dave's own watering log: median gap 2.0d over 21 intervals." },
    plantings: [{ id: '731682ea-a840-469d-8cf8-2fb143c993b9', name: 'Jewel Mix Nasturtium', container_type: 'plastic_pot', status: 'flowering' }] },
  { row: '56d1cef3-b0ab-4556-b926-93f61fc8304b', cultivar: 'd62f0fa1-05c6-4fb9-8861-e16ce66b82ef',
    variety: 'Kiwi Fern', genus: 'Coleus', slug: 'coleus', bundled: ['by_genus_fallback', 'Coleus'],
    profile: { crop: 'coleus', water_interval_days_container: 1, water_method: 'drench_to_drainage', drought_tolerance: 'low',
      confidence: 'medium', _tier: 'T2', _source: 'cadence-backfill-20260823',
      notes: "No crop baseline existed. Cadence derived from Dave's own watering log: median gap 1.0d over 19 intervals." },
    plantings: [{ id: '9a75c6e2-922c-4509-8ef2-0aec1385b013', name: 'Kiwi Fern Coleus', container_type: 'terracotta', status: 'vegetative' }] },
  { row: '315a0e95-0469-4b88-9647-5662c0edc884', cultivar: 'f46745bf-c77e-4f42-b939-5363378a035e',
    variety: 'Petunia', genus: 'Petunia', slug: 'petunia', bundled: ['by_genus_fallback', 'Petunia'],
    profile: { crop: 'petunia', water_interval_days_container: 1, water_method: 'drench_to_drainage', drought_tolerance: 'low',
      confidence: 'medium', _tier: 'T2', _source: 'cadence-backfill-20260823',
      notes: "No crop baseline existed. Cadence derived from Dave's own watering log: median gap 1.0d over 19 intervals." },
    plantings: [{ id: 'e6f33a3d-f861-4354-8728-34c08b84e1be', name: 'Petunia', container_type: 'hanging_basket', status: 'flowering' }] },
  { row: '54187824-9ea7-4c5c-9fbf-da5f2326b84e', cultivar: '4379ae45-51ac-49f2-8205-aea13c3c64ad',
    variety: 'Silver (Licorice Plant)', genus: 'Helichrysum', slug: 'helichrysum', bundled: ['by_genus_fallback', 'Helichrysum'],
    profile: { crop: 'helichrysum', water_interval_days_container: 2, water_method: 'drench_to_drainage', drought_tolerance: 'low',
      confidence: 'medium', _tier: 'T2', _source: 'cadence-backfill-20260823',
      notes: "No crop baseline existed. Cadence derived from Dave's own watering log: median gap 1.5d over 18 intervals." },
    plantings: [{ id: 'a70bc754-04a0-4c85-8bec-5febe0bf33c9', name: 'Silver Helichrysum', container_type: 'plastic_pot', status: 'vegetative' }] },
  { row: '241d3455-8961-4c8c-a7ab-4a73e84fc002', cultivar: 'ece82bf2-6a60-4186-b031-64af0519aa49',
    variety: 'Spider Plant', genus: 'Chlorophytum', slug: 'spider_plant', bundled: ['by_variety', 'Spider Plant'],
    profile: { crop: 'spider plant', water_interval_days_container: 7, water_method: 'drench_to_drainage', drought_tolerance: 'high',
      confidence: 'low', _tier: 'T2', _source: 'cadence-backfill-20260823',
      notes: "No crop baseline existed. Cadence derived from Dave's own watering log: median gap 7.0d over 7 intervals — THIN SAMPLE, revisit." },
    plantings: [{ id: 'dc196337-453b-4c44-94c0-f1e20d6deef3', name: 'Spider Plant', container_type: 'plastic_pot', status: 'vegetative' }] },
  { row: 'f9a3ca14-5a9e-4cd9-8294-babd6e90279f', cultivar: 'eb7e7347-26f2-42aa-b042-967511a31c0d',
    variety: 'Sunny Susy White Halo', genus: 'Thunbergia', slug: 'thunbergia', bundled: ['by_genus_fallback', 'Thunbergia'],
    profile: { crop: 'thunbergia', water_interval_days_container: 1, water_method: 'drench_to_drainage', drought_tolerance: 'low',
      confidence: 'medium', _tier: 'T2', _source: 'cadence-backfill-20260823',
      notes: "No crop baseline existed. Cadence derived from Dave's own watering log: median gap 1.0d over 19 intervals." },
    plantings: [{ id: '8ca4d744-77e8-432d-b130-b862768fa55c', name: 'Sunny Susy White Halo Thunbergia', container_type: 'plastic_pot', status: 'flowering' }] },
  { row: '19c81d1a-c313-4ae2-bc82-5069eee72fe6', cultivar: 'a3d41b0a-f79e-4301-b710-587b6d8544bf',
    variety: 'Wishbone Flower', genus: 'Torenia', slug: 'torenia', bundled: ['by_genus_fallback', 'Torenia'],
    profile: { crop: 'torenia', water_interval_days_container: 1, water_method: 'drench_to_drainage', drought_tolerance: 'low',
      confidence: 'medium', _tier: 'T2', _source: 'cadence-backfill-20260823',
      notes: "No crop baseline existed. Cadence derived from Dave's own watering log: median gap 1.0d over 19 intervals." },
    plantings: [{ id: 'ae936173-1806-419b-a7e1-eb00a294dc74', name: 'Wishbone Flower (Torenia)', container_type: 'plastic_pot', status: 'flowering' }] },
];

// The eight rows the decision leaves alone (prod ids, read 2026-09-19), and why.
const EXCLUDED = {
  '58586ba5-7080-469d-bf77-3f5746cd2132': 'Alaska Mix — a 6x2 ft trough planter, cannot be carried in',
  '834a3a15-bd59-4801-ac2d-1d58bc0c79a3': 'Clemson Spineless 80 — okra, in the ground',
  'd9690105-fb81-40cf-abb0-218972f86daa': 'Peach — in the ground; its bundled entry is a pepper',
  'bdbf05dd-0239-4ac0-b0d1-b0cbc816a62c': 'Graptosedum — v5-coldshadow-001',
  '5a179436-7feb-4e3d-9f29-bbf5272b9414': 'Pachyphytum — v5-coldshadow-001',
  'f427ea8a-ff79-478b-beb8-14b2a0a6750d': 'Echeveria — the crop-type fallback already gives its bundled 40F',
  'a29447b8-387f-4390-ac73-7e152efcbe8d': 'Ginger — the crop-type fallback already gives its bundled 55F',
  'f672d2a4-0c89-4e81-8e2d-06ed466aa9c4': 'Crassula ovata (Jade) — its bundled 40F would lower the 45F it gets',
};

// Every care_profile UPDATE in 0a, in file order. The guard and the create_missing flag are part of the shape: an
// UPDATE that loses either no longer matches, and the binding test below goes red.
const UPDATES = [...SQL_0A.matchAll(
  /UPDATE public\.care_profile\s+SET profile = jsonb_set\(profile, '\{cold\}', '(\{[^']*\})'::jsonb, (true|false)\),\s*updated_at = now\(\)\s+WHERE id = '([0-9a-f-]{36})'\s+AND scope = 'cultivar' AND scope_id = '([0-9a-f-]{36})'\s+AND NOT \(profile \? 'cold'\);/g)]
  .map((m) => ({ row: m[3], cultivar: m[4], cold: JSON.parse(m[1]), createMissing: m[2] }));
const coldWrittenFor = (row) => (UPDATES.find((u) => u.row === row) || {}).cold;
const bundledFor = (r) => cad[r.bundled[0]][r.bundled[1]];

// One gate's text, from its `- name:` line to the next gate's.
const gate = (name) => {
  const i = GATES.indexOf(`- name: ${name}\n`);
  if (i < 0) throw new Error(`gate ${name} not found`);
  const j = GATES.indexOf('- name: ', i + 1);
  return GATES.slice(i, j < 0 ? undefined : j);
};

// v_resolved_care = system || cultivar (no leaf row on any of these plantings): the system row's keys under it.
const SYSTEM = { light: 'part_sun', water_amount_ml: 250, water_interval_days: 3, fertilize_interval_days: 14 };
const resolved = (cultivarProfile) => ({ ...SYSTEM, ...cultivarProfile });

// The planting shape handler.js selects, as read on prod: potted, not in a heated location, never logged as
// brought inside, adopting its cultivar profile (cadence_scopes {cultivar}).
const planting = (r, p, db) => ({
  id: p.id, name: p.name, variety: r.variety, crop_type_slug: r.slug, genus: r.genus,
  container_type: p.container_type, status: p.status, heated_resolved: false,
  db_cadence: db, cadence_scopes: ['cultivar'], last_brought_inside: null, last_brought_outside: null,
});
const CASES = ROWS.flatMap((r) => r.plantings.map((p) => ({
  r, name: p.name, threshold: coldWrittenFor(r.row) && coldWrittenFor(r.row).protect_below_F,
  after: planting(r, p, resolved({ ...r.profile, cold: coldWrittenFor(r.row) })),
  before: planting(r, p, resolved(r.profile)),
})));

// frostAlertEnabled: prod's live value (the coldshadow.test.js / coldcardreachable.test.js helper shape).
const planFor = (p, low) => generatePlan({
  plantings: [{ project: 'Annuals', project_id: 'pj', substrate_start: '2026-05-01',
    last_water: '2026-09-18', last_fert: null, ...p }],
  cadence: cad, fertModel: fm, today: '2026-09-19', weather: { unit: 'F', tonightLow: low, highToday: low + 20 },
  ownerFallback: 'dave', frostAlertEnabled: true,
});
const card = (p, low) => Object.values(planFor(p, low).users).flatMap((u) => u.tasks.cold)
  .find((x) => x.id === p.id) || null;
// Every threshold in play and the degree above it: 55/56, 50/51, 45/46, 40/41, 35/36, 32/33.
const LOWS = [60, 56, 55, 51, 50, 46, 45, 41, 40, 36, 35, 33, 32, 31, 28, 20, 10];
const carded = (p) => LOWS.filter((low) => card(p, low));

describe('v5-coldshadow-002 writes the bundled value, and only that key, on exactly the ten rows', () => {
  it('0a sets `cold` on the ten rows, by id and (scope, scope_id), guarded on the key being absent, create_missing true', () => {
    expect(UPDATES.map(({ row, cultivar, createMissing }) => ({ row, cultivar, createMissing })))
      .toEqual(ROWS.map(({ row, cultivar }) => ({ row, cultivar, createMissing: 'true' })));
    expect((SQL_0A.match(/UPDATE public\.care_profile/g) || []).length).toBe(ROWS.length);
  });

  it.each(ROWS)('$variety: the value is the bundled entry the census resolved for its plantings', (r) => {
    expect(coldWrittenFor(r.row)).toEqual(bundledFor(r).cold);
    for (const p of r.plantings) {
      const bundledOnly = resolveCadence({ ...planting(r, p, resolved(r.profile)), cadence_scopes: [] }, cad);
      expect(bundledOnly._via).toBe(r.bundled[0] === 'by_variety' ? `variety:${r.bundled[1]}` : `genus:${r.bundled[1]}`);
      expect(coldWrittenFor(r.row)).toEqual(bundledOnly.cold);
    }
  });

  it.each(ROWS)('$variety: the bundled entry is about the same plant — its crop names the genus $genus', (r) => {
    expect(bundledFor(r).crop.toLowerCase()).toContain(r.genus.toLowerCase());
  });

  it('negative control for that identity check: by_variety["Peach"] (a pepper) fails it for the Peach tree (Prunus)', () => {
    expect(cad.by_variety.Peach.crop.toLowerCase()).not.toContain('prunus');
  });

  it('0a names none of the eight excluded rows anywhere, and none of v5-coldshadow-001\'s', () => {
    for (const [id, why] of Object.entries(EXCLUDED)) expect(RAW_0A.includes(id), why).toBe(false);
    const rows001 = [...SQL_001.matchAll(/WHERE id = '([0-9a-f-]{36})'/g)].map((m) => m[1]);
    expect(rows001).toHaveLength(2);
    for (const id of rows001) expect(UPDATES.map((u) => u.row)).not.toContain(id);
    expect(RAW_0A).toContain("'5.0.0-coldshadow-002'");
    expect(RAW_0A).not.toContain("'5.0.0-coldshadow-001'");
  });

  it('0r removes only what 0a wrote, row by row', () => {
    const rolledBack = [...SQL_0R.matchAll(/WHERE id = '([0-9a-f-]{36})'[\s\S]*?profile->'cold' = '(\{[^']*\})'::jsonb/g)]
      .map((m) => ({ row: m[1], cold: JSON.parse(m[2]) }));
    expect(rolledBack).toEqual(ROWS.map((r) => ({ row: r.row, cold: coldWrittenFor(r.row) })));
  });

  it('gates.yml: the value receipt, the engine-view receipt and the standing floors carry the same values', () => {
    const colds = [...gate('post_each_row_carries_its_bundled_value').matchAll(
      /\('([0-9a-f-]{36})'::uuid, '([0-9a-f-]{36})'::uuid, '(\{[^']*\})'::jsonb\)/g)]
      .map((m) => ({ row: m[1], cultivar: m[2], cold: JSON.parse(m[3]) }));
    expect(colds).toEqual(ROWS.map((r) => ({ row: r.row, cultivar: r.cultivar, cold: bundledFor(r).cold })));
    const view = [...gate('post_engine_view_of_the_eleven_carries_the_cold_block').matchAll(
      /\('([0-9a-f-]{36})'::uuid, '(\{[^']*\})'::jsonb, '(\d+)'\)/g)]
      .map((m) => ({ id: m[1], cold: JSON.parse(m[2]), wi: Number(m[3]) }));
    expect(view).toEqual(CASES.map((c) => ({ id: c.after.id, cold: bundledFor(c.r).cold, wi: c.r.profile.water_interval_days_container })));
    const floors = [...gate('post_no_db_profile_shadows_the_potted_cold_cards').matchAll(/\('([0-9a-f-]{36})'::uuid, (\d+)\)/g)]
      .map((m) => ({ cultivar: m[1], floor: Number(m[2]) }));
    expect(floors).toEqual(ROWS.map((r) => ({ cultivar: r.cultivar, floor: bundledFor(r).cold.protect_below_F })));
  });
});

describe('CARD — each of the eleven plantings cards at its threshold and not one degree above', () => {
  it('eleven plantings on ten rows (Fairway Orange carries two)', () => {
    expect(CASES).toHaveLength(11);
    expect(new Set(CASES.map((c) => c.after.id)).size).toBe(11);
  });

  it.each(CASES)('$name: generatePlan puts a bring-inside card on tasks.cold at $threshold°F, none one degree above', ({ after, threshold }) => {
    expect(card(after, threshold + 1)).toBeNull();
    expect(card(after, threshold)).toMatchObject({ id: after.id, level: 'protect' });
    expect(card(after, threshold).text).toContain(`≤ ${threshold}°F`);
  });

  it.each(CASES)('$name: coldFor itself — {level: protect} at $threshold°F, null one degree above', ({ after, threshold }) => {
    expect(coldFor(after, cad, threshold, true, null)).toMatchObject({ level: 'protect' });
    expect(coldFor(after, cad, threshold + 1, true, null)).toBeNull();
  });

  it.each(CASES)('$name: carded on exactly the nights at or below $threshold°F', ({ after, threshold }) => {
    expect(carded(after)).toEqual(LOWS.filter((low) => low <= threshold));
  });

  it.each(CASES)('$name BEFORE the apply (no `cold` key): the defect', ({ before, r }) => {
    // Spider Plant alone is partly rescued today, by frostClass.COLD_BY_CROP_TYPE.spider_plant (45F).
    const expected = r.slug === 'spider_plant' ? LOWS.filter((low) => low <= 45) : [];
    expect(carded(before)).toEqual(expected);
  });

  it('instrument check: every fixture takes the ADOPTED DATABASE PROFILE, and the bundled entry alone gives the same threshold', () => {
    for (const c of CASES) {
      expect(resolveCadence(c.after, cad)._via, c.name).toBe('db');
      expect(resolveCadence(c.before, cad)._via, c.name).toBe('db');
      expect(carded({ ...c.before, cadence_scopes: [] }), c.name).toEqual(LOWS.filter((low) => low <= c.threshold));
    }
  });
});

describe('EMAIL — the frost alert does not move', () => {
  // handler.js's cadenceTenderFor, reproduced verbatim: a tender cold block promotes an UNBANDED slug only.
  const cadenceTenderFor = (p) => { const c = resolveCadence(p, cad); return !!(c && c.cold && c.cold.tender); };
  const shape = (s) => ({ tender: s.tender, unknown: s.unknown, atRisk: s.atRisk,
    byCropType: s.byCropType.map((g) => [g.label, g.count, g.class, g.band, g.thresholds]) });
  it('every crop type here is banded, so the email classifies the eleven exactly as before the apply', () => {
    const after = shape(summarize(CASES.map((c) => c.after), { cadenceTenderFor }));
    expect(after).toEqual(shape(summarize(CASES.map((c) => c.before), { cadenceTenderFor })));
    expect(after.unknown).toBe(0);
    for (const r of ROWS) expect(fc.BAND_BY_SLUG[r.slug], r.slug).toBeTruthy();
  });
});

describe('DECISION — the three brief-named plantings left out, and why', () => {
  // Shape as read on prod 2026-09-19 (abridged: coldFor reads only the resolved `cold` and the crop type; each
  // profile adopts on its container interval, cadence_scopes {cultivar}, no `cold`). Bundled `cold` from the same
  // resolution the census used.
  const P = (o) => ({ container_type: 'plastic_pot', status: 'vegetative', heated_resolved: false,
    cadence_scopes: ['cultivar'], last_brought_inside: null, last_brought_outside: null, ...o });
  const ECHEVERIA = P({ id: '8a25017f-2678-4b02-8f66-8ae3ad7f14ef', name: 'Echeveria', variety: 'Echeveria', genus: 'Echeveria',
    crop_type_slug: 'echeveria', db_cadence: resolved({ crop: 'succulent (Echeveria rosette)', water_interval_days_container: 12,
      water_interval_days: 12, _source: 'cowork_care_audit_20260709' }) });
  const GINGER = P({ id: '0064e3a9-3168-4fe0-a6eb-42fc84ad8a04', name: 'Ginger', variety: 'Ginger', genus: null,
    crop_type_slug: 'ginger', last_brought_inside: '2026-09-17', db_cadence: resolved({ crop: 'ginger',
      water_interval_days_container: 2, _source: 'cadence-backfill-20260823' }) });
  const JADE = P({ id: '7ea05605-e08c-4bcc-8e85-8387a965d027', name: 'Jade Plant', variety: 'Crassula ovata', genus: 'Crassula',
    crop_type_slug: 'jade', heated_resolved: true, db_cadence: resolved({ crop: 'succulent (jade / Crassula ovata)',
      water_interval_days_container: 12, water_interval_days: 12, _source: 'cowork_care_audit_20260709' }) });
  const bundledCold = (p) => resolveCadence({ ...p, cadence_scopes: [] }, cad).cold;
  const withBundled = (p) => ({ ...p, db_cadence: { ...p.db_cadence, cold: bundledCold(p) } });
  const outdoors = (p) => ({ ...p, heated_resolved: false, last_brought_outside: '2026-09-18' });

  it('Echeveria: its bundled 40F equals the crop-type fallback it already gets — writing it changes no card', () => {
    expect(bundledCold(ECHEVERIA)).toEqual({ tender: true, protect_below_F: 40 });
    expect(carded(ECHEVERIA)).toEqual(LOWS.filter((low) => low <= 40));
    expect(carded(withBundled(ECHEVERIA))).toEqual(carded(ECHEVERIA));
  });

  it('Ginger: logged brought inside, so no card either way; once out, the crop-type fallback already gives its bundled 55F', () => {
    expect(bundledCold(GINGER)).toEqual({ tender: true, protect_below_F: 55 });
    expect(carded(GINGER)).toEqual([]);
    expect(carded(withBundled(GINGER))).toEqual([]);
    expect(carded(outdoors(GINGER))).toEqual(LOWS.filter((low) => low <= 55));
    expect(carded(withBundled(outdoors(GINGER)))).toEqual(carded(outdoors(GINGER)));
  });

  it('Jade: in the heated House no card either way; anywhere else the bundled 40F would LOWER the 45F it gets', () => {
    expect(bundledCold(JADE)).toEqual({ tender: true, protect_below_F: 40 });
    expect(carded(JADE)).toEqual([]);
    expect(carded(withBundled(JADE))).toEqual([]);
    expect(carded(outdoors(JADE))).toEqual(LOWS.filter((low) => low <= 45));
    expect(carded(withBundled(outdoors(JADE)))).toEqual(LOWS.filter((low) => low <= 40));
  });
});
