// BUG-COLDPROFILESHADOWSBUNDLED-001 — Graptosedum and Pachyphytum, potted in the unheated Stable. The
// bundled cadence data gives both a bring-inside threshold (by_variety, tender, protect below 40F), but
// since 2026-08-23 each has a cultivar care profile (cadence-backfill-20260823, "Cloned from the
// succulent crop baseline") with watering keys and NO `cold` key. The planting adopts that database
// profile (cadence_scopes {cultivar}) and resolveCadence returns it WHOLE, so the bundled threshold is
// shadowed and the card is silent at every temperature. migrations/v5-coldshadow-001 adds the one key,
// with the bundled value (Dave, 2026-09-18: a card at 40F). No engine change.
//
// Pinned here, through the real call site (engine.generatePlan -> tasks.cold) and coldFor itself:
//   * a profile shaped like the corrected rows — the 13 keys read on prod plus the cold block 0a writes,
//     PARSED OUT OF 0a-data.sql, never retyped — cards at 40F and not at 41F;
//   * the same profile without the key (prod before the apply) cards at no temperature: the defect;
//   * the fixture really exercises the ADOPTED DATABASE PROFILE. The bundled entry alone would pass the
//     40F test, so without the `_via` check a fixture that silently fell through to it would prove nothing;
//   * the migration's literals (0a, 0r, gates.yml receipts) equal cadence-data-v2.json by_variety[..].cold.
// The unit suite mocks SQL: nothing here proves the migration applied or the rows exist. Its gates do.
//
// MUTATION LOG — 2026-09-18, lane-coldshadow-20260918. Each applied to ONE file, this file run, RED
// observed, file restored byte-for-byte (sha256 checked), GREEN re-observed. Recorded in the lane findings
// (_mainsync4_20260918/coldshadow.md §5).
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
const MIGRATION = join(here, '..', '..', 'migrations', 'v5-coldshadow-001');
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, '');
const SQL_0A = stripSqlComments(readFileSync(join(MIGRATION, '0a-data.sql'), 'utf8'));
const SQL_0R = stripSqlComments(readFileSync(join(MIGRATION, '0r-rollback.sql'), 'utf8'));
const GATES = readFileSync(join(MIGRATION, 'gates.yml'), 'utf8');

// Read on prod 2026-09-18: care_profile row id -> the cultivar it belongs to -> its one live planting.
const ROWS = [
  { row: 'bdbf05dd-0239-4ac0-b0d1-b0cbc816a62c', cultivar: 'f4919a6f-eb7e-4c03-bc0f-b158f8ef51fd',
    planting: '931f80a6-9262-483f-9a38-e1a98144194a', name: 'Graptosedum' },
  { row: '5a179436-7feb-4e3d-9f29-bbf5272b9414', cultivar: 'b3666254-9b71-478b-bf9e-2f2bb97dd8a9',
    planting: 'fdeb1317-6b11-4ac9-8289-75f3ac758a56', name: 'Pachyphytum' },
];

// Every care_profile UPDATE in 0a, in file order. The guard and the create_missing flag are part of the
// shape: an UPDATE that loses either no longer matches, and the binding test below goes red.
const UPDATES = [...SQL_0A.matchAll(
  /UPDATE public\.care_profile\s+SET profile = jsonb_set\(profile, '\{cold\}', '(\{[^']*\})'::jsonb, (true|false)\),\s*updated_at = now\(\)\s+WHERE id = '([0-9a-f-]{36})'\s+AND scope = 'cultivar' AND scope_id = '([0-9a-f-]{36})'\s+AND NOT \(profile \? 'cold'\);/g)]
  .map((m) => ({ row: m[3], cultivar: m[4], cold: JSON.parse(m[1]), createMissing: m[2] }));
const coldWrittenFor = (row) => (UPDATES.find((u) => u.row === row) || {}).cold;

// The cultivar profile as read on prod 2026-09-18 (identical on both rows): 13 keys, no `cold`.
const PROFILE_BEFORE = Object.freeze({
  crop: 'succulent', _tier: 'T1',
  notes: 'Cloned from the succulent crop baseline; all 1 sibling profiles agree on this container cadence.',
  indoor: true, _source: 'cadence-backfill-20260823', confidence: 'high', water_method: 'soak_then_dry',
  seasonal_note: 'Winter: ~25-30d, no feed.', drought_tolerance: 'high',
  water_volume_note: 'Drench-and-dry. When unsure, underwater.',
  soil_moisture_target: 'pot fully dry to base before rewater', fertilize_interval_days: 45,
  water_interval_days_container: 14,
});
// v_resolved_care = system || cultivar (no leaf row on either planting): the system row's keys under it.
const SYSTEM = { light: 'part_sun', water_amount_ml: 250, water_interval_days: 3, fertilize_interval_days: 14 };
const resolved = (cultivarProfile) => ({ ...SYSTEM, ...cultivarProfile });

// The planting shape handler.js selects, as read on prod: potted, vegetative, in the Stable (covered,
// UNHEATED), typed succulent, no genus, never logged as brought inside.
const planting = ({ planting: id, name }, db) => ({
  id, name, variety: name, crop_type_slug: 'succulent', genus: null, container_type: 'plastic_pot',
  status: 'vegetative', frost_covered_resolved: true, heated_resolved: false,
  db_cadence: db, cadence_scopes: ['cultivar'], last_brought_inside: null, last_brought_outside: null,
});
const AFTER = ROWS.map((r) => planting(r, resolved({ ...PROFILE_BEFORE, cold: coldWrittenFor(r.row) })));
const BEFORE = ROWS.map((r) => planting(r, resolved(PROFILE_BEFORE)));

// frostAlertEnabled: prod's live value (the coldcardreachable.test.js / frostband.test.js helper shape).
const planFor = (p, low) => generatePlan({
  plantings: [{ project: 'Succulents & Cacti', project_id: 'pj', substrate_start: '2026-05-01',
    last_water: '2026-09-17', last_fert: null, ...p }],
  cadence: cad, fertModel: fm, today: '2026-09-18', weather: { unit: 'F', tonightLow: low, highToday: low + 20 },
  ownerFallback: 'dave', frostAlertEnabled: true,
});
const card = (p, low) => Object.values(planFor(p, low).users).flatMap((u) => u.tasks.cold)
  .find((r) => r.id === p.id) || null;
const LOWS = [60, 50, 45, 42, 41, 40, 39, 38, 33, 32, 28, 20, 10];
const carded = (p) => LOWS.filter((low) => card(p, low));

describe('v5-coldshadow-001 writes the bundled value, and only that key', () => {
  it('0a sets `cold` on exactly the two rows, by id and (scope, scope_id), guarded on the key being absent, create_missing true', () => {
    expect(UPDATES.map(({ row, cultivar, createMissing }) => ({ row, cultivar, createMissing })))
      .toEqual(ROWS.map(({ row, cultivar }) => ({ row, cultivar, createMissing: 'true' })));
  });

  it('each value is cadence-data-v2.json by_variety[<cultivar>].cold — tender, protect below 40F', () => {
    for (const r of ROWS) {
      expect(coldWrittenFor(r.row), r.name).toEqual(cad.by_variety[r.name].cold);
      expect(coldWrittenFor(r.row), r.name).toEqual({ tender: true, protect_below_F: 40 });
    }
  });

  it('0r removes only what 0a wrote, and gates.yml receipts compare against the same values', () => {
    const rolledBack = [...SQL_0R.matchAll(/WHERE id = '([0-9a-f-]{36})'[\s\S]*?profile->'cold' = '(\{[^']*\})'::jsonb/g)]
      .map((m) => ({ row: m[1], cold: JSON.parse(m[2]) }));
    expect(rolledBack).toEqual(ROWS.map((r) => ({ row: r.row, cold: coldWrittenFor(r.row) })));
    const receipts = [...GATES.matchAll(/'(\{"tender"[^']*\})'::jsonb/g)].map((m) => JSON.parse(m[1]));
    expect(receipts).toHaveLength(4);   // two row receipts + the engine-view receipt's two arms
    for (const v of receipts) expect(v).toEqual(cad.by_variety.Graptosedum.cold);
    expect(cad.by_variety.Pachyphytum.cold).toEqual(cad.by_variety.Graptosedum.cold);
  });
});

describe('CARD — the corrected profile cards at 40F and not at 41F', () => {
  it.each(ROWS.map((r, i) => [r.name, AFTER[i]]))('%s: generatePlan puts a bring-inside card on tasks.cold at 40F, none at 41F', (_n, p) => {
    expect(card(p, 41)).toBeNull();
    expect(card(p, 40)).toMatchObject({ id: p.id, level: 'protect' });
    expect(card(p, 40).text).toContain('≤ 40°F');
  });

  it.each(ROWS.map((r, i) => [r.name, AFTER[i]]))('%s: coldFor itself — {level: protect} at 40F, null at 41F', (_n, p) => {
    expect(coldFor(p, cad, 40, true, null)).toMatchObject({ level: 'protect' });
    expect(coldFor(p, cad, 41, true, null)).toBeNull();
  });

  it.each(ROWS.map((r, i) => [r.name, AFTER[i]]))('%s: carded on exactly the nights at or below 40F', (_n, p) => {
    expect(carded(p)).toEqual(LOWS.filter((low) => low <= 40));
  });

  it.each(ROWS.map((r, i) => [r.name, BEFORE[i]]))('%s BEFORE the apply (no `cold` key): no card at any temperature — the defect', (_n, p) => {
    expect(carded(p)).toEqual([]);
  });

  it('instrument check: both fixtures take the ADOPTED DATABASE PROFILE, and the bundled entry it shadows cards at 40F', () => {
    for (const p of [...AFTER, ...BEFORE]) expect(resolveCadence(p, cad)._via, p.name).toBe('db');
    for (const p of BEFORE) {
      const bundledOnly = { ...p, cadence_scopes: [] };
      expect(resolveCadence(bundledOnly, cad)._via).toBe(`variety:${p.name}`);
      expect(carded(bundledOnly), p.name).toEqual(LOWS.filter((low) => low <= 40));
    }
  });
});

describe('EMAIL — the same tender block names them, same trip band', () => {
  // handler.js's cadenceTenderFor, reproduced verbatim: a tender cold block promotes an UNBANDED slug.
  const cadenceTenderFor = (p) => { const c = resolveCadence(p, cad); return !!(c && c.cold && c.cold.tender); };
  it('after the apply both leave "unclassified" and are named "succulents"; before, they were unclassified', () => {
    const after = summarize(AFTER, { cadenceTenderFor });
    expect(after.byCropType.map((g) => [g.label, g.count, g.band])).toEqual([['succulents', 2, 'tender']]);
    const before = summarize(BEFORE, { cadenceTenderFor });
    expect(before.byCropType.map((g) => [g.label, g.count, g.band])).toEqual([['unclassified', 2, 'tender']]);
    expect(after.byCropType[0].thresholds).toEqual(before.byCropType[0].thresholds);
  });
});
