// DATA-FALLDECKPOTS-001 — the three fall pots on the Deck (Garden Chrysanthemum, Prairie Sun, Purple
// Majesty Millet): Dave's decided watering, the Millet rename, and daisy/millet recorded as not harvested.
//
// Dave's decisions, 2026-10-14: water every 3 days, rain counts, _basis dave_decision; rename Miller to
// Millet; daisy and millet not harvested. Shape and helpers follow crabappleprofile.test.js: the profiles
// are PARSED OUT of migrations/v5-deckpots-001/0a-data.sql, never retyped.
//
// The unit suite mocks SQL: nothing here proves the migration applied. Its gates do that
// (migrations/v5-deckpots-001/gates.yml). This file binds 0a, 0r and that gates file to each other and to
// the engine.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import engine from './engine.js';
import cad from './cadence-data-v2.json';

const { resolveCadence } = engine;

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');
const MIGRATION = join(REPO, 'migrations', 'v5-deckpots-001');
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, '');
const SQL_0A = stripSqlComments(readFileSync(join(MIGRATION, '0a-data.sql'), 'utf8'));
const SQL_0R = stripSqlComments(readFileSync(join(MIGRATION, '0r-rollback.sql'), 'utf8'));
const GATES = readFileSync(join(MIGRATION, 'gates.yml'), 'utf8');
const ATTR = JSON.parse(readFileSync(join(REPO, 'src', 'data', 'harvest-attributes-v1.json'), 'utf8'));
const HABIT_GATES = readFileSync(join(REPO, 'migrations', 'v4-harvhabitgap-001', 'gates.yml'), 'utf8');
// The SPA's copied not-tracked list, read as TEXT: a node-project test must not load SPA code
// (scripts/ci-telemetry/vitest-projects.test.js). src/__tests__/harvestTracked.test.js runs the function.
const NOT_TRACKED_COPY = (() => {
  const src = readFileSync(join(REPO, 'src', 'lib', 'harvestTracked.js'), 'utf8');
  const m = src.match(/NOT_HARVEST_TRACKED_SLUGS = Object\.freeze\(\[([\s\S]*?)\]\)/);
  return m ? [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]) : [];
})();

const STAMP = '5.0.0-deckpots-001';
const MD5_BEFORE = 'd5335984e4af2339fe6ee7b4f4946436';   // md5(profile::text) of each placeholder, prod 2026-10-14
// care_profile row -> cultivar -> planting, read on prod 2026-10-14
const POTS = [
  { row: '63463242-7d45-43cb-821a-55450f8320bd', cultivar: 'f1588cbd-0861-45ef-8c5a-42687839e218',
    planting: '5735a21b-8e2b-4bcd-bc1c-e506b0331a35', crop: 'chrysanthemum', variety: 'Garden Chrysanthemum', genus: 'Chrysanthemum' },
  { row: '737964e9-f583-49af-bf1c-34058376e934', cultivar: '0f89c33f-8c9a-479f-8e80-aca9091b3622',
    planting: '1fc6fe9b-c7b0-4671-854a-5bb419f085f6', crop: 'daisy', variety: 'Prairie Sun', genus: 'Rudbeckia' },
  { row: 'f61237a4-1868-4cfe-9710-7916b42dcf77', cultivar: '7a61c3e5-b90a-4f32-a21f-ba08d7daa3d3',
    planting: '31ab9250-f584-4ed4-a4dc-766dcd8239e1', crop: 'millet', variety: 'Purple Majesty Millet', genus: 'Pennisetum' },
];
const MILLET = POTS[2].cultivar;

// Postgres jsonb text: keys by byte length then bytewise, ': ' and ', ' (crabappleprofile.test.js).
const pgJsonbText = (o) => `{${Object.keys(o)
  .sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)))
  .map((k) => `${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(', ')}}`;
const md5 = (s) => createHash('md5').update(Buffer.from(s, 'utf8')).digest('hex');

// Every care_profile UPDATE in 0a. Key, (scope, scope_id) and md5 guard are part of the pattern.
const PROFILE_UPDATES = [...SQL_0A.matchAll(
  /UPDATE public\.care_profile\s+SET profile = '(\{[^']*\})'::jsonb,\s*updated_at = now\(\)\s+WHERE id = '([0-9a-f-]{36})'\s+AND scope = 'cultivar' AND scope_id = '([0-9a-f-]{36})'\s+AND md5\(profile::text\) = '([0-9a-f]{32})';/g)]
  .map((m) => ({ row: m[2], cultivar: m[3], md5: m[4], profile: JSON.parse(m[1]) }));
const profileFor = (cultivar) => PROFILE_UPDATES.find((u) => u.cultivar === cultivar)?.profile;

const PLACEHOLDER = (() => {
  const m = SQL_0R.match(/\$placeholder\$(\{[\s\S]*?\})\$placeholder\$/);
  return m ? JSON.parse(m[1]) : undefined;
})();

const gate = (name) => {
  const i = GATES.indexOf(`- name: ${name}\n`);
  if (i < 0) throw new Error(`gate ${name} not found`);
  const j = GATES.indexOf('- name: ', i + 1);
  return GATES.slice(i, j < 0 ? undefined : j);
};

const pot = (p, cultivarProfile, scopes) => ({
  id: p.planting, name: p.variety, variety: p.variety, crop_type_slug: p.crop, genus: p.genus,
  container_type: 'plastic_pot', status: 'flowering', frost_covered_resolved: false, heated_resolved: false,
  rain_exposed_resolved: true, db_cadence: { ...SYSTEM, ...cultivarProfile }, cadence_scopes: scopes,
});
// The system row's two keys (crabappleprofile.test.js): v_resolved_care merges it UNDER the cultivar row,
// which is how a cultivar row without a feed key hands the engine 14 (v5-feedinherit-001).
const SYSTEM = { water_interval_days: 3, fertilize_interval_days: 14 };

describe('0a writes Dave\'s decision on each of the three placeholders, and nothing else', () => {
  it('exactly three profile replaces, one per row, each keyed by id + (scope, scope_id) and the placeholder md5', () => {
    expect(PROFILE_UPDATES.map(({ row, cultivar, md5: h }) => ({ row, cultivar, md5: h })))
      .toEqual(POTS.map(({ row, cultivar }) => ({ row, cultivar, md5: MD5_BEFORE })));
  });

  it('each profile: 3-day container interval, dave_decision, this migration as source, its own crop', () => {
    for (const p of POTS) {
      expect(profileFor(p.cultivar), p.variety).toMatchObject({
        crop: p.crop, _basis: 'dave_decision', _source: 'v5-deckpots-001', water_interval_days_container: 3,
      });
    }
  });

  it('no key 0a was not asked for: no cold block, no in-ground interval, no rain or suppression key', () => {
    const base = ['_basis', '_source', '_tier', 'confidence', 'crop', 'drought_tolerance',
      'notes', 'water_interval_days_container', 'water_method'];
    for (const p of POTS) {
      const keys = Object.keys(profileFor(p.cultivar)).sort();
      const want = p.crop === 'chrysanthemum' ? [...base, 'fertilize_interval_days'].sort() : base;
      expect(keys, p.variety).toEqual(want);
    }
  });

  it('the engine adopts each profile from the database at 3 days, where before it fell through', () => {
    for (const p of POTS) {
      const before = resolveCadence(pot(p, PLACEHOLDER, []), cad);
      expect(before._via, p.variety).not.toBe('db');
      const after = resolveCadence(pot(p, profileFor(p.cultivar), ['cultivar']), cad);
      expect(after._via, p.variety).toBe('db');
      expect(after.water_interval_days_container, p.variety).toBe(3);
    }
  });

  it('adopting the row moves neither the watering nor the feeding interval any pot gets today', () => {
    for (const p of POTS) {
      const before = resolveCadence(pot(p, PLACEHOLDER, []), cad);
      const after = resolveCadence(pot(p, profileFor(p.cultivar), ['cultivar']), cad);
      expect(after.water_interval_days_container, p.variety).toBe(before.water_interval_days_container);
      expect(after.fertilize_interval_days, p.variety).toBe(before.fertilize_interval_days);
    }
    // instrument check: the mums' genus entry really feeds on something other than the house 14, so the
    // equality above would red without the explicit key (the v5-feedinherit-001 defect)
    const mums = POTS[0];
    expect(resolveCadence(pot(mums, PLACEHOLDER, []), cad).fertilize_interval_days).not.toBe(SYSTEM.fertilize_interval_days);
  });

  it('the rename: by id, only while the old name is there', () => {
    expect(SQL_0A).toMatch(new RegExp(`UPDATE public\\.plant_varieties\\s+SET name = 'Purple Majesty Millet',\\s*updated_at = now\\(\\)\\s+WHERE id = '${MILLET}'\\s+AND name = 'Purple Majesty Miller'\\s+AND deleted_at IS NULL;`));
  });

  it('writes only the three profiles, the name and the stamp', () => {
    expect(SQL_0A.match(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.\w+/g)).toEqual([
      'UPDATE public.care_profile', 'UPDATE public.care_profile', 'UPDATE public.care_profile',
      'UPDATE public.plant_varieties', 'INSERT INTO public.schema_version']);
    expect(SQL_0A).toContain(`VALUES ('${STAMP}',`);
  });
});

describe('0r puts back exactly what was there', () => {
  it('the restored literal is the placeholder prod holds: its jsonb text hashes to the pinned md5', () => {
    expect(PLACEHOLDER).toMatchObject({ _basis: 'unresearched', _source: 'cultivar-create' });
    expect(md5(pgJsonbText(PLACEHOLDER))).toBe(MD5_BEFORE);
    expect(md5(pgJsonbText({ ...PLACEHOLDER, notes: `${PLACEHOLDER.notes} ` }))).not.toBe(MD5_BEFORE);
  });

  it('restores only rows 0a wrote, only while the stamp exists; names the same three rows', () => {
    for (const p of POTS) expect(SQL_0R).toContain(`('${p.row}'::uuid, '${p.cultivar}'::uuid)`);
    expect(SQL_0R).toMatch(/profile->>'_source' = 'v5-deckpots-001'\s+AND profile->>'_basis' = 'dave_decision'\s+AND EXISTS \(SELECT 1 FROM public\.schema_version WHERE version = '5\.0\.0-deckpots-001'\)/);
    expect(SQL_0R).toMatch(new RegExp(`UPDATE public\\.plant_varieties\\s+SET name = 'Purple Majesty Miller',\\s*updated_at = now\\(\\)\\s+WHERE id = '${MILLET}'\\s+AND name = 'Purple Majesty Millet'\\s+AND deleted_at IS NULL\\s+AND EXISTS \\(SELECT 1 FROM public\\.schema_version WHERE version = '5\\.0\\.0-deckpots-001'\\);`));
    expect(SQL_0R).toContain(`DELETE FROM public.schema_version WHERE version = '${STAMP}'`);
  });
});

describe('gates.yml carries the same rows and values as 0a', () => {
  it('the pre gate pins the same md5 and all three rows', () => {
    const g = gate('pre_profiles_are_the_untouched_create_placeholders');
    expect(g).toContain(`'${MD5_BEFORE}'`);
    for (const p of POTS) expect(g).toContain(p.row);
  });

  it('the standing invariant is prod-only, continuous, self-armed, and checks the 3-day value', () => {
    const g = gate('post_the_deck_pots_resolve_dave_s_three_day_cadence');
    expect(g).toMatch(/\n\s+env: prod\n/);
    expect(g).not.toMatch(/continuous: false/);
    expect(g).toContain(`WHERE version = '${STAMP}'`);
    expect(g).toContain(`'water_interval_days_container' = '3'::jsonb`);
    for (const p of POTS) expect(g).toContain(p.planting);
  });

  it('every gate that names a prod id is env: prod', () => {
    const names = [...GATES.matchAll(/- name: (\S+)\n/g)].map((m) => m[1]);
    for (const n of names) {
      const g = gate(n);
      if (/[0-9a-f]{8}-[0-9a-f]{4}-/.test(g)) expect(g, n).toMatch(/\n\s+env: prod\n/);
    }
  });
});

describe('HABIT — daisy and millet are recorded as not harvested, in all three lists', () => {
  it('not tracked, on the authoring JSON list and excused by the harvhabitgap gate', () => {
    expect(NOT_TRACKED_COPY.length, 'parsed the copied list').toBeGreaterThan(50);
    for (const s of ['daisy', 'millet']) {
      expect(NOT_TRACKED_COPY, s).toContain(s);
      expect(ATTR.not_harvest_tracked.slugs, s).toContain(s);
      expect(ATTR.by_crop_type[s], s).toBeUndefined();
    }
    const i = HABIT_GATES.indexOf('- name: post_every_null_habit_is_a_recorded_decision\n');
    const j = HABIT_GATES.indexOf('- name: ', i + 1);
    expect(i).toBeGreaterThan(-1);
    expect(HABIT_GATES.slice(i, j < 0 ? undefined : j)).toMatch(/\n\s+'daisy','millet',\n/);
  });

  it('chrysanthemum was already recorded, so 0a needs no habit write', () => {
    expect(NOT_TRACKED_COPY).toContain('chrysanthemum');
    expect(SQL_0A).not.toMatch(/crop_types/);
  });
});
