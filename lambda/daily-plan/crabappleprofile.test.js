// DATA-CRABAPPLEPROFILE-001 — the site crabapple: a decided care profile, a decided harvest habit and a
// frost band, pinned where each is read.
//
//   CARE     engine.generatePlan, the real call site of waterSuppression and fertilizeRec. The profile the
//            fixtures carry is PARSED OUT of migrations/v5-crabappleprofile-001/0a-data.sql, never retyped,
//            so what the engine is shown here is what the migration writes.
//   HABIT    the value 0a writes, held equal to src/data/harvest-attributes-v1.json and to the seed row in
//            migrations/v4-harvattr-001/0b-data.sql.
//   FROST    frostClass: `crabapple` hardy, beside `apple`.
//
// Dave's decisions, 2026-10-09: no watering reminders and never feed (same as the Peach tree), track the
// harvest as one gathering per season, mark it hardy.
//
// Fixtures are the planting shape handler.js selects. Read on prod 2026-10-09: in_ground, status
// harvested, Drive (not covered, not heated), genus Malus, cadence_scopes {} before the apply. db_cadence
// is v_resolved_care.resolved_profile, i.e. the system row merged under the cultivar row. The system
// row's two keys here (water_interval_days 3, fertilize_interval_days 14) are the ones engine.js and
// v4-seededgate-001 describe; that row was not read on prod. substrate_start and the last-watered date are
// NOT prod values: they are chosen so a feed card and a watering card are REACHABLE, because a "no card"
// test on a planting that would get none anyway proves nothing (the neverfeed.test.js rule).
//
// The unit suite mocks SQL: nothing here proves the migration applied or the rows exist. The migration's
// own gates do that (migrations/v5-crabappleprofile-001/gates.yml). The last three describe blocks bind
// this file to 0a, 0r and that gates file.
//
// MUTATION LOG — 2026-10-09, lane-crabprofile-20261009. Each applied to ONE file, this file run, RED
// observed, the file restored byte-for-byte (sha256 checked). Baseline 37 green.
//   C1  0a writes no_calendar_water false                                 -> 9 RED
//   C2  0a writes no_calendar_feed false                                  -> 8 RED
//   C3  0a drops both fallback interval keys                              -> 5 RED
//   C4  0a writes an in-ground fallback of 7                              -> 5 RED
//   C5  0a leaves _basis unresearched                                     -> 3 RED
//   C6  0a adds a tender cold block at 32F                                -> 6 RED
//   C7  0a loses the md5 guard                                            -> 16 RED
//   C8  0a keyed by row id only, (scope, scope_id) dropped                -> 16 RED
//   C9  0a merges (profile || ...) instead of replacing                   -> 17 RED
//   C10 0a writes habit 'repeat'                                          -> 4 RED
//   C11 0a habit UPDATE loses its IS NULL guard                           -> 4 RED
//   C12 0a also writes loss_horizon_hours                                 -> 5 RED
//   C13 0a stamps a different version                                     -> 1 RED
//   C14 0a's note stops saying the cultivar is not identified             -> 3 RED
//   C15 0r restores a placeholder one character off                       -> 1 RED
//   C16 0r guards on a profile 0a did not write                           -> 1 RED
//   C17 0r profile restore loses its stamp guard                          -> 4 RED
//   C18 0r habit reset loses its value guard                              -> 1 RED
//   C19 gates: the decision invariant demoted to continuous: false        -> 1 RED
//   C20 gates: the decision invariant loses its self-arming stamp check   -> 1 RED
//   C21 gates: the decision invariant loses env: prod                     -> 1 RED
//   C22 gates: the decision invariant stops checking feed                 -> 1 RED
//   C23 gates: the reach invariant stops excluding the tree itself        -> 1 RED
//   C24 gates: the pre gate's md5 differs                                 -> 1 RED
//   C25 gates: the value receipt holds a different profile                -> 1 RED
//   C26 gates: the premise gate stops requiring an empty cadence_scopes   -> 1 RED
//   C27 gates: the habit receipt says 'repeat'                            -> 1 RED
//   C28 gates: the habit receipt loses env: prod                          -> 1 RED
//   C29 frostClass: crabapple dropped from the hardy band                 -> 2 RED
//   C30 frostClass: crabapple also filed as uncertain                     -> 1 RED
//   C31 engine.waterSuppression ignores no_calendar_water                 -> 4 RED
//   C32 engine.feedSuppression ignores no_calendar_feed                   -> 3 RED
//   C33 engine.resolveCadence never adopts the database profile           -> 4 RED
//   C34 engine.waterSuppression stops reading the raw profile             -> 1 RED
//   C35 harvest-attributes-v1.json: crabapple authored as 'repeat'        -> 1 RED
//   C36 0b seed row: crabapple gains a loss horizon                       -> 1 RED
//   C37 harvestTracked.js: crabapple copied onto the not-tracked list     -> 1 RED
//   C38 v4-harvhabitgap-001 gate: crabapple excused on the NOT IN list    -> 1 RED
// C29 is 2 here; src/__tests__/slugUniverseConsistency.test.js and frostBands.parity.test.js go red on it
// too (3 RED across the two, run separately).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
import fc from './frostClass.js';

const { generatePlan, resolveCadence } = engine;
const { summarize, frostClassForSlug, coldProfileForSlug, BAND_BY_SLUG, SLUGS_BY_BAND, UNCERTAIN_SLUGS } = fc;

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');
const MIGRATION = join(REPO, 'migrations', 'v5-crabappleprofile-001');
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, '');
const SQL_0A = stripSqlComments(readFileSync(join(MIGRATION, '0a-data.sql'), 'utf8'));
const SQL_0R = stripSqlComments(readFileSync(join(MIGRATION, '0r-rollback.sql'), 'utf8'));
const GATES = readFileSync(join(MIGRATION, 'gates.yml'), 'utf8');

const STAMP = '5.0.0-crabappleprofile-001';
const ROW = 'c59f1b2f-fec6-4e17-aea5-5260700f1235';        // care_profile row
const CULTIVAR = '2680ddd1-9f6a-400b-9c3b-2645fb4a39a8';   // plant_varieties "Crabapple"
const PLANTING = 'fbf317f9-20f8-4400-8523-f410d214a959';   // plants "Crabapple"
const MD5_BEFORE = 'd5335984e4af2339fe6ee7b4f4946436';     // md5(profile::text), prod 2026-10-09

// The Peach tree's cultivar profile (care_profile d9690105…), read on prod 2026-10-09: the model. Notes
// omitted. Nothing below is copied from it at run time; it is here so "the same as the Peach tree" is a
// comparison this file makes rather than a sentence in a README.
const PEACH = { crop: 'peach tree', _tier: 'P', _source: 'cadence-backfill-20260823', confidence: 'high',
  water_method: 'rainfall_only', no_calendar_feed: true, drought_tolerance: 'high', no_calendar_water: true,
  water_interval_days_inground: 14, water_interval_days_container: 14 };

// Postgres renders jsonb as text with keys ordered by byte length and then bytewise, ': ' after a key and
// ', ' between pairs. That rule reproduces the md5 prod reported for the placeholder row, which is the
// only evidence it is right and all this file needs it for. Flat objects of scalars only.
const pgJsonbText = (o) => `{${Object.keys(o)
  .sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)))
  .map((k) => `${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(', ')}}`;
const md5 = (s) => createHash('md5').update(Buffer.from(s, 'utf8')).digest('hex');

// Every care_profile UPDATE in 0a. The id + (scope, scope_id) key and the md5 guard are part of the
// pattern: an UPDATE that loses any of them no longer matches, PROFILE is undefined, and the binding and
// engine tests go red together.
const PROFILE_UPDATES = [...SQL_0A.matchAll(
  /UPDATE public\.care_profile\s+SET profile = '(\{[^']*\})'::jsonb,\s*updated_at = now\(\)\s+WHERE id = '([0-9a-f-]{36})'\s+AND scope = 'cultivar' AND scope_id = '([0-9a-f-]{36})'\s+AND md5\(profile::text\) = '([0-9a-f]{32})';/g)]
  .map((m) => ({ row: m[2], cultivar: m[3], md5: m[4], profile: JSON.parse(m[1]) }));
// The profile the fixtures carry is the one 0a writes, parsed, never retyped.
const PROFILE = PROFILE_UPDATES.length === 1 ? PROFILE_UPDATES[0].profile : undefined;

const HABIT_UPDATES = [...SQL_0A.matchAll(
  /UPDATE public\.crop_types\s+SET harvest_habit = '([a-z_]+)',\s*updated_at\s+= now\(\)\s+WHERE slug = '([a-z0-9_]+)'\s+AND deleted_at IS NULL\s+AND harvest_habit IS NULL;/g)]
  .map((m) => ({ habit: m[1], slug: m[2] }));
const HABIT = HABIT_UPDATES.length === 1 ? HABIT_UPDATES[0].habit : undefined;

const ROLLED_BACK = [...SQL_0R.matchAll(
  /UPDATE public\.care_profile\s+SET profile = \$placeholder\$(\{[\s\S]*?\})\$placeholder\$::jsonb,\s*updated_at = now\(\)\s+WHERE id = '([0-9a-f-]{36})'\s+AND scope = 'cultivar' AND scope_id = '([0-9a-f-]{36})'\s+AND profile = '(\{[^']*\})'::jsonb\s+AND EXISTS \(SELECT 1 FROM public\.schema_version WHERE version = '([^']+)'\);/g)]
  .map((m) => ({ restored: JSON.parse(m[1]), row: m[2], cultivar: m[3], guard: JSON.parse(m[4]), stamp: m[5] }));
const PLACEHOLDER = ROLLED_BACK.length === 1 ? ROLLED_BACK[0].restored : undefined;

const GATE_NAMES = [...GATES.matchAll(/- name: (\S+)\n/g)].map((m) => m[1]);
// One gate's text, from its `- name:` line to the next gate's.
const gate = (name) => {
  const i = GATES.indexOf(`- name: ${name}\n`);
  if (i < 0) throw new Error(`gate ${name} not found`);
  const j = GATES.indexOf('- name: ', i + 1);
  return GATES.slice(i, j < 0 ? undefined : j);
};

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────
const TODAY = '2026-10-09';
const SYSTEM = { water_interval_days: 3, fertilize_interval_days: 14 };
const DRIVE = { frost_covered_resolved: false, heated_resolved: false };   // open sky, unheated
// 2026-05-01 -> 23 weeks: past the fresh-mix window, so a feed card is reachable for a reason that is not
// the phase. Last watered 20 days ago: overdue on a 3-day interval AND on a 14-day one.
const tree = (cultivarProfile, scopes, extra = {}) => ({
  id: PLANTING, name: 'Crabapple', variety: 'Crabapple', crop_type_slug: 'crabapple', genus: 'Malus',
  container_type: 'in_ground', status: 'harvested', ...DRIVE,
  db_cadence: { ...SYSTEM, ...cultivarProfile }, cadence_scopes: scopes,
  last_brought_inside: null, last_brought_outside: null,
  project: 'Drive', project_id: 'pd', substrate_start: '2026-05-01', last_water: '2026-09-19', last_fert: null,
  ...extra,
});
const without = (o, ...keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const BEFORE = () => tree(PLACEHOLDER, []);          // the placeholder: nothing in the database decides
const AFTER = () => tree(PROFILE, ['cultivar']);     // 0a applied: the interval keys make the engine adopt it

const tasksFor = (p, low = 50) => {
  const plan = generatePlan({ plantings: [p], cadence: cad, fertModel: fm, today: TODAY,
    weather: { unit: 'F', tonightLow: low, highToday: low + 20 }, ownerFallback: 'dave', frostAlertEnabled: true });
  const users = Object.values(plan.users);
  expect(users).toHaveLength(1);
  return users[0].tasks;
};
const WATER_LISTS = ['water_due', 'no_history', 'rain_skipped'];
const listed = (tasks, key) => (tasks[key] || []).filter((r) => r.id === PLANTING);
const watered = (tasks) => WATER_LISTS.flatMap((k) => listed(tasks, k));
const LOWS = [60, 50, 45, 41, 40, 38, 36, 33, 32, 31, 28, 20, 10, 0];

describe('fixture guard — both cards are reachable before the apply (this file is worthless if they are not)', () => {
  it('on the placeholder the engine resolves the bundled default, not a database profile', () => {
    expect(resolveCadence(BEFORE(), cad)._via).toBe('default');
    // nothing bundled stands behind it either: no variety entry, no genus entry, no default cold block
    expect(cad.by_variety.Crabapple).toBeUndefined();
    expect(cad.by_genus_fallback.Malus).toBeUndefined();
    expect(cad.default.cold).toBeUndefined();
  });

  it('BEFORE: a watering card on the 3-day default, for a mature tree in the ground', () => {
    const t = tasksFor(BEFORE());
    expect(listed(t, 'water_due')).toMatchObject([{ name: 'Crabapple', in_ground: true, interval: 3, days_since: 20 }]);
    expect(listed(t, 'dormancy_suppressed')).toEqual([]);
  });

  it('BEFORE: never watered at all, it sits on the no-history list instead', () => {
    expect(listed(tasksFor({ ...BEFORE(), last_water: null }), 'no_history'))
      .toMatchObject([{ name: 'Crabapple', interval: 3, never: true }]);
  });

  it('BEFORE: a feed card on the inherited 14-day interval', () => {
    const t = tasksFor(BEFORE());
    expect(listed(t, 'fertilize')).toMatchObject([{ name: 'Crabapple', interval: 14, never: true }]);
    expect(t.feed_suppressed).toBeUndefined();
  });
});

describe('CARE — with the profile 0a writes, no watering card and no feed card', () => {
  it('the engine adopts the database profile (the 14-day interval keys are what make it)', () => {
    const c = resolveCadence(AFTER(), cad);
    expect(c._via).toBe('db');
    expect(c.crop).toBe('crabapple tree');
  });

  it('watering: on no watering list, and listed under dormancy_suppressed with the no_calendar_water rule', () => {
    const t = tasksFor(AFTER());
    expect(watered(t)).toEqual([]);
    expect(listed(t, 'dormancy_suppressed')).toMatchObject([{ name: 'Crabapple', crop: 'crabapple tree', rule: 'no_calendar_water' }]);
  });

  it('never watered, or watered yesterday: still no watering card', () => {
    for (const last_water of [null, '2026-10-08', '2026-06-01']) {
      const t = tasksFor({ ...AFTER(), last_water });
      expect(watered(t), String(last_water)).toEqual([]);
      expect(listed(t, 'dormancy_suppressed'), String(last_water)).toHaveLength(1);
    }
  });

  it('feeding: no feed card, and listed under feed_suppressed with the no_calendar_feed rule', () => {
    const t = tasksFor(AFTER());
    expect(listed(t, 'fertilize')).toEqual([]);
    expect(listed(t, 'feed_suppressed')).toMatchObject([{ name: 'Crabapple', crop: 'crabapple tree', rule: 'no_calendar_feed' }]);
  });

  it('each key does its own work: take one away and exactly that card comes back', () => {
    const noWater = tasksFor(tree(without(PROFILE, 'no_calendar_water'), ['cultivar']));
    // the fallback, firing: the IN-GROUND key, 14 days, not the 3-day house default
    expect(listed(noWater, 'water_due')).toMatchObject([{ interval: PROFILE.water_interval_days_inground, days_since: 20, in_ground: true }]);
    expect(PROFILE.water_interval_days_inground).toBe(14);
    expect(listed(noWater, 'fertilize')).toEqual([]);
    const noFeed = tasksFor(tree(without(PROFILE, 'no_calendar_feed'), ['cultivar']));
    expect(listed(noFeed, 'fertilize')).toHaveLength(1);
    expect(watered(noFeed)).toEqual([]);
  });

  it('neither suppression needs the engine to adopt the profile: flag off, or no interval keys, both still hold', () => {
    // CARE_CADENCE_SCOPES_ENABLED off: handler.js nulls cadence_scopes on every row. The engine falls to the
    // bundled default for `c`, and both suppression reads still find the keys on the raw db_cadence.
    const flagOff = tree(PROFILE, null);
    expect(resolveCadence(flagOff, cad)._via).toBe('default');
    // And the same row without its two interval keys never enters cadence_scopes at all.
    const bare = tree(without(PROFILE, 'water_interval_days_inground', 'water_interval_days_container'), []);
    expect(resolveCadence(bare, cad)._via).toBe('default');
    for (const p of [flagOff, bare]) {
      const t = tasksFor(p);
      expect(watered(t)).toEqual([]);
      expect(listed(t, 'fertilize')).toEqual([]);
      expect(listed(t, 'dormancy_suppressed')).toMatchObject([{ rule: 'no_calendar_water' }]);
      expect(listed(t, 'feed_suppressed')).toMatchObject([{ rule: 'no_calendar_feed' }]);
      // what adoption buys: unadopted, the row is labelled by genus, not by the profile
      expect(listed(t, 'dormancy_suppressed')[0].crop).toBe('Malus');
    }
  });

  it('a string "true" is not a refusal: the engine and the standing gate both demand the boolean', () => {
    const t = tasksFor(tree({ ...PROFILE, no_calendar_water: 'true', no_calendar_feed: 'true' }, ['cultivar']));
    expect(listed(t, 'water_due')).toHaveLength(1);
    expect(listed(t, 'fertilize')).toHaveLength(1);
    expect(PROFILE.no_calendar_water).toBe(true);
    expect(PROFILE.no_calendar_feed).toBe(true);
  });
});

describe('FROST — crabapple is hardy, beside apple: never in the alert, never carded', () => {
  it('banded hardy by its own slug, the same band as apple, and not left uncertain', () => {
    expect(BAND_BY_SLUG.crabapple).toBe('hardy');
    expect(BAND_BY_SLUG.crabapple).toBe(BAND_BY_SLUG.apple);
    expect(SLUGS_BY_BAND.hardy).toContain('crabapple');
    expect(UNCERTAIN_SLUGS).not.toContain('crabapple');
    expect(frostClassForSlug('crabapple')).toMatchObject({ class: 'hardy', countedAs: 'hardy', source: 'slug', band: 'hardy' });
    expect(coldProfileForSlug('crabapple')).toBeNull();
  });

  it('the frost alert does not count it, before or after the apply; an unbanded tree in its place would be', () => {
    const cadenceTenderFor = (p) => { const c = resolveCadence(p, cad); return !!(c && c.cold && c.cold.tender); };
    for (const p of [BEFORE(), AFTER()]) {
      const s = summarize([p], { cadenceTenderFor });
      expect({ atRisk: s.atRisk, tender: s.tender, unknown: s.unknown }).toEqual({ atRisk: 0, tender: 0, unknown: 0 });
    }
    // instrument check: the same planting under a slug no band names is counted, as "unclassified"
    const s = summarize([{ ...AFTER(), crop_type_slug: 'zz_no_such_crop' }], { cadenceTenderFor });
    expect({ atRisk: s.atRisk, unknown: s.unknown, slugs: s.unknownSlugs }).toEqual({ atRisk: 1, unknown: 1, slugs: ['zz_no_such_crop'] });
  });

  it('no cold card at any temperature: the profile carries no `cold`, and nothing bundled supplies one', () => {
    expect(PROFILE).not.toHaveProperty('cold');
    for (const low of LOWS) {
      expect(listed(tasksFor(AFTER(), low), 'cold'), `${low}F after`).toEqual([]);
      expect(listed(tasksFor(BEFORE(), low), 'cold'), `${low}F before`).toEqual([]);
    }
  });
});

describe('HABIT — one gathering per season, in the migration, the authoring JSON and the seed alike', () => {
  const doc = JSON.parse(readFileSync(join(REPO, 'src', 'data', 'harvest-attributes-v1.json'), 'utf8'));
  const seed = readFileSync(join(REPO, 'migrations', 'v4-harvattr-001', '0b-data.sql'), 'utf8');

  it("0a sets crabapple's habit once: by slug, live rows only, guarded on the habit being NULL", () => {
    expect(HABIT_UPDATES).toEqual([{ habit: 'single', slug: 'crabapple' }]);
  });

  it('the authoring JSON carries the same habit, and leaves every attribute nobody decided NULL', () => {
    const row = doc.by_crop_type.crabapple;
    expect(row, 'crabapple must be seeded in by_crop_type').toBeTruthy();
    expect(row.harvest_habit).toBe(HABIT);
    expect(row.harvest_habit).toBe('single');
    for (const col of ['repeat_interval_days', 'loss_horizon_hours', 'set_to_first_pick_days',
      'harvest_season_start_doy', 'harvest_season_end_doy']) expect(row[col] ?? null, col).toBeNull();
  });

  it('the seed row says the same, column for column', () => {
    expect(seed).toMatch(/^\s*\('crabapple','single',NULL,NULL,NULL,NULL,NULL\),\s+--/m);
  });

  it('0a writes no other harvest column', () => {
    expect(SQL_0A).not.toMatch(/repeat_interval_days|loss_horizon_hours|set_to_first_pick_days|harvest_season_|first_year_harvest/);
  });

  it('it is harvest-tracked: on no recorded-NULL list, and not on the copied not-tracked list', () => {
    expect(doc.not_harvest_tracked.slugs).not.toContain('crabapple');
    expect(doc.unseeded_vocabulary.slugs).not.toContain('crabapple');
    expect(Object.keys(doc.establishing_not_yet_harvestable.entries)).not.toContain('crabapple');
    expect(readFileSync(join(REPO, 'src', 'lib', 'harvestTracked.js'), 'utf8')).not.toMatch(/['"]crabapple['"]/);
    // nor excused by the gate it clears: it leaves that gate's population by having a habit
    const habitGap = readFileSync(join(REPO, 'migrations', 'v4-harvhabitgap-001', 'gates.yml'), 'utf8');
    expect(habitGap).not.toMatch(/'crabapple'/);
  });
});

describe('the migration writes the decided profile, whole, on the one row (migrations/v5-crabappleprofile-001)', () => {
  it('0a replaces the profile once: by row id AND (scope, scope_id), guarded on the md5 of the placeholder', () => {
    expect(PROFILE_UPDATES).toEqual([{ row: ROW, cultivar: CULTIVAR, md5: MD5_BEFORE, profile: PROFILE }]);
    expect(PROFILE).toBeTruthy();
  });

  it('the decided values, pinned directly', () => {
    expect(PROFILE).toMatchObject({
      no_calendar_water: true, no_calendar_feed: true, water_method: 'rainfall_only',
      water_interval_days_inground: 14, water_interval_days_container: 14,
      crop: 'crabapple tree', _tier: 'P',
    });
    expect(Object.keys(PROFILE).sort()).toEqual(['_basis', '_source', '_tier', 'confidence', 'crop', 'no_calendar_feed',
      'no_calendar_water', 'notes', 'water_interval_days_container', 'water_interval_days_inground', 'water_method']);
    for (const key of ['cold', 'drought_tolerance', 'fertilize_interval_days', 'water_interval_days', 'water_rule', '_seeded']) {
      expect(PROFILE, key).not.toHaveProperty(key);
    }
  });

  it('it is the Peach tree\'s shape: every key the two share for water and feed holds the Peach\'s value', () => {
    for (const key of ['_tier', 'water_method', 'no_calendar_water', 'no_calendar_feed',
      'water_interval_days_inground', 'water_interval_days_container']) expect(PROFILE[key], key).toBe(PEACH[key]);
    // The differences, each deliberate: a judgement label the Peach row predates, and no drought claim.
    expect(Object.keys(PEACH).filter((k) => !(k in PROFILE))).toEqual(['drought_tolerance']);
    expect(Object.keys(PROFILE).filter((k) => !(k in PEACH)).sort()).toEqual(['_basis', 'notes']);
  });

  it('labelled as a judgement, not a measurement, and no longer the placeholder the gate counts', () => {
    // v4-cadencerefill-001: a ratified judgement is _basis dave_decision with confidence low.
    expect(PROFILE._basis).toBe('dave_decision');
    expect(PROFILE.confidence).toBe('low');
    expect(PROFILE._source).toBe('v5-crabappleprofile-001');
    // post_no_live_planting_rests_on_an_unresearched_placeholder reds on this label with no cadence scope
    const cadenceRefill = readFileSync(join(REPO, 'migrations', 'v4-cadencerefill-001', 'gates.yml'), 'utf8');
    const label = cadenceRefill.match(/cp\.profile->>'_basis' = '([^']+)'\n\s+AND cardinality\(r\.cadence_scopes\) = 0/);
    expect(label, 'the placeholder gate was not found in the shape this test reads').toBeTruthy();
    expect(PROFILE._basis).not.toBe(label[1]);
    expect(PLACEHOLDER._basis).toBe(label[1]);
  });

  it('the note says whose profile it is: one unidentified tree, and that it moves with the tree', () => {
    expect(PROFILE.notes).toContain('The mature in-ground crabapple at the site, cultivar not identified');
    expect(PROFILE.notes).toContain('not to crabapples in general');
    expect(PROFILE.notes).toContain('2026-10-09');
    expect(PROFILE.notes).toMatch(/re-pointed to a named cultivar, this profile has to move with it/);
  });

  it('the literals survive the SQL they sit in: no quote, backslash or comment marker to mangle them', () => {
    expect(PROFILE.notes).not.toMatch(/['"\\]|--/);
    // 0r's placeholder literal is dollar-quoted because it does carry \" escapes; it must not carry the tag
    expect(JSON.stringify(PLACEHOLDER)).not.toContain('$placeholder$');
    expect(JSON.stringify(PLACEHOLDER)).not.toContain('--');
  });

  it('0a writes nothing else: the profile, the habit, the stamp, in one transaction', () => {
    expect(SQL_0A.match(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.\w+/g))
      .toEqual(['UPDATE public.care_profile', 'UPDATE public.crop_types', 'INSERT INTO public.schema_version']);
    expect(SQL_0A).not.toMatch(/jsonb_set\(/);
    expect(SQL_0A.replace(/'(?:[^']|'')*'/g, "''")).not.toContain('||');
    expect(SQL_0A).not.toMatch(/\b(?:ALTER|DROP|CREATE|TRUNCATE)\s/);
    expect(SQL_0A.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
  });

  it('the stamp is 5.0.0-crabappleprofile-001 in the house shape, and 0r deletes the same one', () => {
    expect(SQL_0A).toMatch(new RegExp(
      "INSERT INTO public\\.schema_version \\(version, description, applied_at\\)\\s+VALUES \\('5\\.0\\.0-crabappleprofile-001',"
      + '[\\s\\S]*?now\\(\\)\\)\\s+ON CONFLICT \\(version\\) DO UPDATE\\s+SET applied_at = now\\(\\), description = EXCLUDED\\.description;'));
    expect([...SQL_0A.matchAll(/'(\d+\.\d+\.\d+-[a-z0-9-]+)'/g)].map((m) => m[1])).toEqual([STAMP]);
    expect(SQL_0R).toContain(`DELETE FROM public.schema_version WHERE version = '${STAMP}';`);
  });
});

describe('0r puts back exactly what was there (migrations/v5-crabappleprofile-001/0r-rollback.sql)', () => {
  it('the profile: the same row, only while it still holds what 0a wrote and the stamp exists', () => {
    expect(ROLLED_BACK).toEqual([{ restored: PLACEHOLDER, row: ROW, cultivar: CULTIVAR, guard: PROFILE, stamp: STAMP }]);
    expect((SQL_0R.match(/UPDATE public\.care_profile/g) || []).length).toBe(1);
  });

  it('the restored literal IS the placeholder prod held: its jsonb text hashes to the md5 the pre gate pins', () => {
    expect(Object.keys(PLACEHOLDER).sort()).toEqual(['_basis', '_source', 'notes']);
    expect(PLACEHOLDER).toMatchObject({ _basis: 'unresearched', _source: 'cultivar-create' });
    expect(md5(pgJsonbText(PLACEHOLDER))).toBe(MD5_BEFORE);
    // instrument check: the hash moves with a single character, so the equality above is not vacuous
    expect(md5(pgJsonbText({ ...PLACEHOLDER, notes: `${PLACEHOLDER.notes} ` }))).not.toBe(MD5_BEFORE);
    expect(SQL_0R).toContain(`'${MD5_BEFORE}'`);
  });

  it('the habit: back to NULL, only while it is still the value 0a wrote and the stamp exists', () => {
    const habit = [...SQL_0R.matchAll(
      /UPDATE public\.crop_types\s+SET harvest_habit = NULL,\s*updated_at\s+= now\(\)\s+WHERE slug = '([a-z0-9_]+)'\s+AND deleted_at IS NULL\s+AND harvest_habit = '([a-z_]+)'\s+AND EXISTS \(SELECT 1 FROM public\.schema_version WHERE version = '([^']+)'\);/g)]
      .map((m) => ({ slug: m[1], habit: m[2], stamp: m[3] }));
    expect(habit).toEqual([{ slug: 'crabapple', habit: HABIT, stamp: STAMP }]);
    expect(SQL_0R.match(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.\w+/g))
      .toEqual(['UPDATE public.care_profile', 'UPDATE public.crop_types', 'DELETE FROM public.schema_version']);
  });
});

describe('gates.yml carries the same rows and values as 0a (migrations/v5-crabappleprofile-001)', () => {
  const STANDING = ['post_the_crabapple_gets_no_calendar_watering_or_feeding',
    'post_no_other_planting_inherits_the_unmanaged_tree_profile'];
  const armed = `WHERE EXISTS (SELECT 1 FROM public.schema_version WHERE version = '${STAMP}')`;

  it('the pre gates, two standing invariants and the receipts, in that order', () => {
    expect(GATE_NAMES).toEqual([
      'pre_not_already_applied', 'pre_cultivar_is_the_row_read_at_authoring',
      'pre_profile_is_the_untouched_create_placeholder', 'pre_no_leaf_override_decides_water_or_feed',
      'pre_no_other_live_planting_reaches_this_row', 'pre_the_planting_is_live_in_the_ground_and_under_open_sky',
      'pre_the_engine_resolves_no_database_cadence_for_the_planting',
      'pre_crop_type_is_the_row_read_at_authoring_with_no_habit',
      'post_schema_version_recorded', ...STANDING,
      'post_the_row_carries_exactly_the_decided_profile', 'post_engine_view_of_the_planting_is_adopted_and_suppressed',
      'post_crabapple_habit_is_single_and_nothing_else_was_written',
    ]);
    // Exactly two post gates are continuous (carry no `continuous: false` key): the standing invariants.
    const post = GATE_NAMES.filter((n) => n.startsWith('post_'));
    expect(post.filter((n) => !/\n {4}continuous: false\n/.test(gate(n)))).toEqual(STANDING);
  });

  it('every gate that names a prod id or the prod-only crop type is env: prod; the two that name neither run on both', () => {
    for (const name of GATE_NAMES) {
      const sql = gate(name).slice(gate(name).indexOf('\n    sql: |\n'));
      const prodKeyed = /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/.test(sql) || /slug = 'crabapple'/.test(sql);
      expect(/\n {4}env: prod\n/.test(gate(name)), name).toBe(prodKeyed);
    }
    expect(GATE_NAMES.filter((n) => !/\n {4}env: /.test(gate(n))))
      .toEqual(['pre_not_already_applied', 'post_schema_version_recorded']);
  });

  it('the decision gate: self-armed, reads the handler\'s view for THE PLANTING, both keys exactly true', () => {
    const g = gate(STANDING[0]);
    expect(g).toContain(armed);
    expect(g).toContain('JOIN public.v_resolved_care vrc ON vrc.leaf_id = p.id');
    expect(g).toContain(`AND p.id IN ('${PLANTING}')`);
    expect(g).toContain("vrc.resolved_profile->'no_calendar_water' = 'true'::jsonb\n");
    expect(g).toContain("AND vrc.resolved_profile->'no_calendar_feed'  = 'true'::jsonb\n");
    expect(g).toContain(') IS NOT TRUE');
    // not narrowed to adopted profiles: the engine reads both keys off the raw profile
    expect(g.slice(g.indexOf('\n    sql: |\n'))).not.toContain('cadence_scopes');
    expect(g).toMatch(/expect: rowcount_eq\n {4}value: 0\n/);
  });

  it('the reach gate: self-armed, every OTHER live planting of the cultivar that resolves either key true', () => {
    const g = gate(STANDING[1]);
    expect(g).toContain(armed);
    expect(g).toContain('JOIN public.v_resolved_care vrc ON vrc.leaf_id = p.id');
    expect(g).toContain(`AND p.variety_id IN ('${CULTIVAR}')`);
    expect(g).toContain(`AND p.id NOT IN ('${PLANTING}')`);
    expect(g).toMatch(/AND \(\s+vrc\.resolved_profile->'no_calendar_water' = 'true'::jsonb\n\s+OR vrc\.resolved_profile->'no_calendar_feed' {2}= 'true'::jsonb\)/);
    expect(g).toMatch(/expect: rowcount_eq\n {4}value: 0\n/);
    // the same line the pre reach guard holds before the apply
    const pre = gate('pre_no_other_live_planting_reaches_this_row');
    expect(pre).toContain(`p.variety_id IN ('${CULTIVAR}')`);
    expect(pre).toContain(`AND p.id NOT IN ('${PLANTING}')`);
  });

  it('the pre gates pin the placeholder by the same md5 0a matches on, and the planting premise', () => {
    expect(gate('pre_profile_is_the_untouched_create_placeholder'))
      .toContain(`('${ROW}'::uuid, '${CULTIVAR}'::uuid, '${MD5_BEFORE}')`);
    expect(gate('pre_profile_is_the_untouched_create_placeholder')).toContain('AND md5(cp.profile::text) = v.md5_before');
    const premise = gate('pre_the_engine_resolves_no_database_cadence_for_the_planting');
    expect(premise).toContain(`vrc.leaf_id IN ('${PLANTING}')`);
    expect(premise).toContain('AND cardinality(vrc.cadence_scopes) = 0');
    expect(premise).toContain("NOT (vrc.resolved_profile ? 'no_calendar_water')");
    expect(premise).toContain("NOT (vrc.resolved_profile ? 'no_calendar_feed')");
    const planting = gate('pre_the_planting_is_live_in_the_ground_and_under_open_sky');
    expect(planting).toContain(`('${PLANTING}'::uuid, '${CULTIVAR}'::uuid)`);
    expect(planting).toContain("AND p.container_type = 'in_ground'");
    expect(gate('pre_crop_type_is_the_row_read_at_authoring_with_no_habit'))
      .toContain('AND c.harvest_habit IS NULL AND c.repeat_interval_days IS NULL');
  });

  it('the receipts carry the profile, the planting and the habit 0a writes', () => {
    const value = gate('post_the_row_carries_exactly_the_decided_profile');
    expect(value).toContain(`WHERE cp.id = '${ROW}'`);
    expect(value).toContain(`AND cp.scope = 'cultivar' AND cp.scope_id = '${CULTIVAR}'`);
    expect(JSON.parse(value.match(/AND cp\.profile = '(\{[^']*\})'::jsonb/)[1])).toEqual(PROFILE);
    const view = gate('post_engine_view_of_the_planting_is_adopted_and_suppressed')
      .match(/\('([0-9a-f-]{36})'::uuid, '(\d+)', '([a-z_]+)'\)/);
    expect({ id: view[1], wi: Number(view[2]), basis: view[3] })
      .toEqual({ id: PLANTING, wi: PROFILE.water_interval_days_inground, basis: PROFILE._basis });
    expect(gate('post_engine_view_of_the_planting_is_adopted_and_suppressed')).toContain("vrc.cadence_scopes = ARRAY['cultivar']");
    const habit = gate('post_crabapple_habit_is_single_and_nothing_else_was_written');
    expect(habit).toContain(`AND c.harvest_habit = '${HABIT}'`);
    for (const col of ['repeat_interval_days', 'loss_horizon_hours', 'set_to_first_pick_days',
      'harvest_season_start_doy', 'harvest_season_end_doy']) expect(habit, col).toContain(`AND c.${col} IS NULL`);
  });

  it('no gate, and neither SQL file, names any id but these three', () => {
    for (const text of [GATES, SQL_0A, SQL_0R]) {
      const ids = new Set([...text.matchAll(/'([0-9a-f]{8}-[0-9a-f-]{27})'/g)].map((m) => m[1]));
      expect([...ids].every((id) => [ROW, CULTIVAR, PLANTING].includes(id)), [...ids].join(' ')).toBe(true);
    }
    const inGates = new Set([...GATES.matchAll(/'([0-9a-f]{8}-[0-9a-f-]{27})'/g)].map((m) => m[1]));
    expect([...inGates].sort()).toEqual([ROW, CULTIVAR, PLANTING].sort());
  });
});
