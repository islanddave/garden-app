// BUG-CAREFEEDINHERIT-001 — 21 cultivar care profiles that never state a feeding interval inherit the SYSTEM row's 14
// days through v_resolved_care (system || cultivar || leaf: shallow, right wins), so engine.fertilizeRec cards every
// one of those plantings every 14 days. Dave, 2026-09-21: "Use the care-data intervals" — set each of the 21 to its
// own interval from the app's care data. migrations/v5-feedinherit-001 adds the one key, `fertilize_interval_days`, to
// those 21 cultivar rows (all written by cadence-backfill-20260823), copying the bundled value the engine resolves for
// each planting. No engine change.
//
// Pinned here, through the real call site (engine.generatePlan -> tasks.fertilize) and the resolver:
//   * every value 0a writes, PARSED OUT OF 0a-data.sql, is a JSON number equal to the bundled entry the engine
//     resolves for every planting of that cultivar (live and soft-deleted) and to the value Dave approved (the
//     lane-profileshadow §3 table); the entry 0a's own comment names for each row is that same entry; 0r and the
//     gates.yml receipts carry the same literals;
//   * the fixture profiles ARE the prod rows: each renders, as Postgres renders jsonb, to the md5 the gates pin;
//   * 0a writes exactly the 21 rows and none of the five left out (three legacy Rubus, Lemon Thyme, the Peach); the
//     reach guard names exactly the 21 cultivars and their 26 plantings (21 live, 5 soft-deleted);
//   * each of the 21 is carded on the house 14 days before the apply and on its own interval after, and not one day
//     sooner;
//   * the expected change Dave was shown: forward 2026-09-21..11-30, 77 feed cards become 53 across the 21;
//   * the five left out get no feed card either way, which is why writing them would change nothing.
// The unit suite mocks SQL: nothing here proves the migration applied or the rows exist. Its gates do.
//
// MUTATION LOG — 2026-09-21, lane-feedintervals-20260921. Each applied to ONE file, this file run, RED observed, file
// restored byte-for-byte (sha256 checked), GREEN re-observed. Recorded in the lane findings
// (_mainsync5ship3_20260921/lane-feedintervals-20260921.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';

const { generatePlan, resolveCadence, isMedHerb } = engine;

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', '..', 'migrations', 'v5-feedinherit-001');
const STAMP = '5.0.0-feedinherit-001';
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, '');
const RAW_0A = readFileSync(join(DIR, '0a-data.sql'), 'utf8');
const SQL_0A = stripSqlComments(RAW_0A);
const RAW_0R = readFileSync(join(DIR, '0r-rollback.sql'), 'utf8');
const SQL_0R = stripSqlComments(RAW_0R);
const GATES = readFileSync(join(DIR, 'gates.yml'), 'utf8');

// The system row as read on prod 2026-09-21 (b3f35f46…): the house defaults under every cultivar row. Its
// fertilize_interval_days is the 14 the 21 plantings inherit.
const SYSTEM = { light: 'part_sun', water_amount_ml: 250, water_interval_days: 3, fertilize_interval_days: 14 };

// Read on prod 2026-09-21: care_profile row -> its cultivar (plant_varieties id, name, genus, crop type) -> the bundled
// entry the engine resolves for its plantings and that entry's interval (= the lane-profileshadow §3 value Dave approved)
// -> md5 of the row's profile as Postgres renders it -> the row's profile exactly as read -> its one live planting (the
// fields the feed path reads) -> the soft-deleted plantings the row also reaches. No leaf-scope row on any of them.
const ROWS = [
  { row: '58586ba5-7080-469d-bf77-3f5746cd2132', cultivar: 'a11dd600-84b4-4bd6-8611-f85336bc3c2e',
    variety: 'Alaska Mix', genus: 'Tropaeolum', slug: 'nasturtium', bundled: ['by_variety', 'Alaska Mix'], interval: 45,
    md5: '56232db6edd44008c0036b319237ec12', profile: { crop: 'nasturtium', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 20 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2 },
    live: { id: '8f84f21c-f2f8-4ead-9221-9c5add78036d', name: 'Alaska Mix Nasturtium 1', status: 'vegetative', container_type: 'trough', substrate_start: '2026-07-03', last_fert: '2026-09-10' },
    deleted: [{ id: '7ea304c4-5ae5-4408-94e5-546d706e3392', name: 'Alaska Mix Nasturtium 2' }, { id: 'd6b56799-875c-4999-bb94-e2cbab1641b1', name: 'Alaska Mix Nasturtium' }] },
  { row: 'cf4e17cf-d3da-46c9-bf71-a014f35bf2ad', cultivar: 'b11814aa-83ed-48e4-882d-a6709e42572f',
    variety: 'Chrysanthemum', genus: 'Chrysanthemum', slug: 'chrysanthemum', bundled: ['by_genus_fallback', 'Chrysanthemum'], interval: 28,
    md5: '95a27bbffd9bbeb5c89a2407d6d02551', profile: { crop: 'chrysanthemum', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 5.0d over 10 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'medium', water_interval_days_container: 5 },
    live: { id: 'a458d170-6669-4e7a-b12b-810877fc535e', name: 'Chrysanthemum', status: 'vegetative', container_type: 'plastic_pot', substrate_start: '2026-06-23', last_fert: null },
    deleted: [] },
  { row: '834a3a15-bd59-4801-ac2d-1d58bc0c79a3', cultivar: '1b2b7bf8-0d9e-4c39-b7d7-0acd744f16f7',
    variety: 'Clemson Spineless 80', genus: 'Abelmoschus', slug: 'okra', bundled: ['by_genus_fallback', 'Abelmoschus'], interval: 21,
    md5: '0d9731f506b43f422c9055cc0b2d2870', profile: { crop: 'okra', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 13 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_inground: 2, water_interval_days_container: 2 },
    live: { id: 'c7a08b26-f5d0-44ba-843c-416cba97e02b', name: 'Clemson Spineless 80', status: 'harvested', container_type: 'in_ground', substrate_start: '2026-07-15', last_fert: '2026-09-10' },
    deleted: [{ id: '11b13057-608e-4de2-b9b3-c9fd586265b4', name: 'Clemson Spineless 80' }, { id: 'cd6c4356-a29c-489c-a3a3-b9c68829f829', name: 'Clemson Spineless 80 Okra Seeds' }] },
  { row: '9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c', cultivar: '3db84405-1941-4e88-bb77-58595f47c3e7',
    variety: 'Cobaea scandens (Violet)', genus: 'Cobaea', slug: 'cobaea', bundled: ['by_genus_fallback', 'Cobaea'], interval: 21,
    md5: '3fb6b9b305e417724b087ebd42d606cc', profile: { cold: { tender: true, protect_below_F: 40 }, crop: 'cobaea', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 1.5d over 18 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2 },
    live: { id: '1ef9592e-4d69-4171-a21e-24cf5c3f2e61', name: 'Cobaea scandens (Violet)', status: 'vegetative', container_type: 'plastic_pot', substrate_start: '2026-07-21', last_fert: '2026-09-10' },
    deleted: [] },
  { row: 'e43739f4-75a6-4ae4-a673-1a8aef0e0f0b', cultivar: 'd9eba456-0836-4690-b3db-02aa0fb4fb1b',
    variety: 'Contender', genus: 'Phaseolus', slug: 'bean', bundled: ['by_genus_fallback', 'Phaseolus'], interval: 30,
    md5: '7d54f17db6de625fc7ccf3018d4f162a', profile: { crop: 'bean', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 11 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_inground: 2, water_interval_days_container: 2 },
    live: { id: '909c85ce-60a5-4e55-8564-9437ef7df383', name: 'Contender Bush Bean', status: 'harvested', container_type: 'in_ground', substrate_start: '2026-07-21', last_fert: '2026-09-10' },
    deleted: [] },
  { row: 'f807599b-f4d4-4fff-9703-ff21cbf9981f', cultivar: '219329ac-66f3-4c25-8a46-6246bb91c858',
    variety: 'Dwarf Blue Curled (Vates)', genus: 'Brassica', slug: 'kale', bundled: ['by_genus_fallback', 'Brassica'], interval: 21,
    md5: 'c851db18b63f8b19612ce9300af574de', profile: { crop: 'kale', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 9 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2 },
    live: { id: '198627b4-91b2-4806-917f-d812623409cd', name: 'Dwarf Blue Curled Kale', status: 'vegetative', container_type: 'tray_cell', substrate_start: '2026-07-31', last_fert: '2026-09-08' },
    deleted: [] },
  { row: '04554719-e633-44d7-8791-f3e33c90ed2d', cultivar: 'ba53f113-9903-449d-81b9-7dce30ef3934',
    variety: 'Easy Wave Berry Velour', genus: 'Petunia', slug: 'petunia', bundled: ['by_genus_fallback', 'Petunia'], interval: 7,
    md5: '5f2027fd1ff9e33e8bbbb1ebe0a6fa78', profile: { cold: { tender: true, protect_below_F: 35 }, crop: 'petunia', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 1.0d over 19 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 1 },
    live: { id: 'ac3c0e05-aada-47c6-a4c1-447ee3906b79', name: 'Easy Wave Berry Velour Petunia', status: 'flowering', container_type: 'plastic_pot', substrate_start: '2026-07-12', last_fert: '2026-09-10' },
    deleted: [] },
  { row: 'f86d0c66-7b6d-4a8e-b9de-0132d9e3332a', cultivar: 'c94e3179-b14a-4707-8ca2-1305dd0946dc',
    variety: 'Foxglove', genus: 'Digitalis', slug: 'foxglove', bundled: ['by_genus_fallback', 'Digitalis'], interval: 30,
    md5: '43e034ff6ab7011b3d6fd6e8aecdb2ee', profile: { crop: 'foxglove', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 1.5d over 18 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2 },
    live: { id: 'b2784442-9945-4004-bd5f-c36fe3b7530e', name: 'Foxglove', status: 'vegetative', container_type: 'plastic_pot', substrate_start: '2026-07-12', last_fert: '2026-09-10' },
    deleted: [] },
  { row: '13bcffdc-ac3d-4294-a6a9-b887aa76584e', cultivar: '450c3391-b809-43e5-b7ae-de16b9cce431',
    variety: 'Gold Rush', genus: 'Phaseolus', slug: 'bean', bundled: ['by_genus_fallback', 'Phaseolus'], interval: 30,
    md5: '7d54f17db6de625fc7ccf3018d4f162a', profile: { crop: 'bean', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 11 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_inground: 2, water_interval_days_container: 2 },
    live: { id: '71cfa027-adb9-4d29-86bc-977e14c19dee', name: 'Gold Rush Bush Bean', status: 'harvested', container_type: 'in_ground', substrate_start: '2026-07-21', last_fert: '2026-09-10' },
    deleted: [] },
  { row: '5378c39e-8174-4ce9-85ad-351adc4f1486', cultivar: '3b986e62-14ca-4262-86bb-eb35c418bd19',
    variety: 'Hosta', genus: 'Hosta', slug: 'hosta', bundled: ['by_genus_fallback', 'Hosta'], interval: 45,
    md5: '378cd2587ff37d625fbfd7b8c8c9948f', profile: { crop: 'hosta', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 13.5d over 4 intervals — THIN SAMPLE, revisit.', _source: 'cadence-backfill-20260823', confidence: 'low', water_method: 'drench_to_drainage', drought_tolerance: 'high', water_interval_days_inground: 14, water_interval_days_container: 14 },
    live: { id: '21408041-566c-432a-a109-38e158158120', name: 'Hosta', status: 'vegetative', container_type: 'in_ground', substrate_start: '2026-06-23', last_fert: null },
    deleted: [] },
  { row: '8cc55d60-10a6-468e-a9af-cfafc7731b65', cultivar: '055e3ff1-21c0-44ce-bace-d8a900f6145a',
    variety: 'Japanese Maple', genus: 'Acer', slug: 'japanese_maple', bundled: ['by_variety', 'Japanese Maple'], interval: 60,
    md5: '12c1d516c75c3cbdfba2e90bca267794', profile: { crop: 'japanese maple', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 28 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2 },
    live: { id: '8814273d-3444-4183-83b8-dad09a49c452', name: 'Japanese Maple', status: 'vegetative', container_type: 'plastic_pot', substrate_start: '2026-05-31', last_fert: '2026-09-10' },
    deleted: [] },
  { row: '2d2bc039-58e4-4ce7-8930-e58a66c4cd5a', cultivar: 'd3101ac0-fd4e-456e-86b7-ebea732ac84c',
    variety: 'Jewel Mix Nasturtium', genus: 'Tropaeolum', slug: 'nasturtium', bundled: ['by_genus_fallback', 'Tropaeolum'], interval: 45,
    md5: 'a83395305590751cc6f2ddd03a6cf20f', profile: { cold: { tender: true, protect_below_F: 32 }, crop: 'nasturtium', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 21 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2 },
    live: { id: '731682ea-a840-469d-8cf8-2fb143c993b9', name: 'Jewel Mix Nasturtium', status: 'flowering', container_type: 'plastic_pot', substrate_start: '2026-06-29', last_fert: '2026-09-10' },
    deleted: [] },
  { row: 'ebf1aab5-4879-4080-a8aa-4e11b454de31', cultivar: 'b1fad1e2-b2e1-40ee-ab02-1f6cf9a20a6d',
    variety: 'Lacinato (Dinosaur)', genus: 'Brassica', slug: 'kale', bundled: ['by_genus_fallback', 'Brassica'], interval: 21,
    md5: 'c851db18b63f8b19612ce9300af574de', profile: { crop: 'kale', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 9 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2 },
    live: { id: '54689036-4d77-4370-9f6d-591260fe0e0a', name: 'Lacinato Dinosaur Kale', status: 'vegetative', container_type: 'tray_cell', substrate_start: '2026-07-31', last_fert: '2026-09-08' },
    deleted: [] },
  { row: 'e74d95b7-df0a-4948-9bf2-d5bfd1bbeeea', cultivar: '72ebf73c-bf46-429a-bb2d-3243e3d0826d',
    variety: 'Lemon Verbena', genus: 'Aloysia', slug: 'lemon_verbena', bundled: ['by_genus_fallback', 'Aloysia'], interval: 21,
    md5: 'a626e28a0675a5892506e1fbf5160ce0', profile: { crop: 'lemon verbena', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 1.0d over 11 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 1 },
    live: { id: 'edfc68f5-a28a-484a-8be6-dd00b4067dde', name: 'Lemon Verbena', status: 'harvested', container_type: 'fabric_bag', substrate_start: '2026-07-21', last_fert: '2026-09-08' },
    deleted: [] },
  { row: 'c848cd0b-48bf-4622-be46-b65903725bc3', cultivar: '0609afc2-51ea-4045-858b-fe28060e2f20',
    variety: 'Palla Rossa Mavrik', genus: 'Cichorium', slug: 'radicchio', bundled: ['by_genus_fallback', 'Cichorium'], interval: 21,
    md5: '5831719141b1265afb0e269a71c3c358', profile: { crop: 'radicchio', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 11 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2 },
    live: { id: '54245a51-629f-463f-8515-0b51f2896c73', name: 'Palla Rossa Mavrik Radicchio', status: 'vegetative', container_type: 'tray_cell', substrate_start: '2026-07-22', last_fert: '2026-09-08' },
    deleted: [] },
  { row: '315a0e95-0469-4b88-9647-5662c0edc884', cultivar: 'f46745bf-c77e-4f42-b939-5363378a035e',
    variety: 'Petunia', genus: 'Petunia', slug: 'petunia', bundled: ['by_genus_fallback', 'Petunia'], interval: 7,
    md5: '5f2027fd1ff9e33e8bbbb1ebe0a6fa78', profile: { cold: { tender: true, protect_below_F: 35 }, crop: 'petunia', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 1.0d over 19 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 1 },
    live: { id: 'e6f33a3d-f861-4354-8728-34c08b84e1be', name: 'Petunia', status: 'flowering', container_type: 'hanging_basket', substrate_start: '2026-07-12', last_fert: '2026-09-10' },
    deleted: [] },
  { row: '1d49baf7-103b-4a65-a6f5-81d1034d36a1', cultivar: '81924103-2858-408f-991e-aad591827a49',
    variety: 'Purple Vienna', genus: 'Brassica', slug: 'kohlrabi', bundled: ['by_genus_fallback', 'Brassica'], interval: 21,
    md5: '76525dcf00834fc2e91268173b5d66d3', profile: { crop: 'kohlrabi', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 11 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2 },
    live: { id: 'd2e8c2df-5a9e-4f24-abf7-665ba849cdfc', name: 'Purple Vienna Kohlrabi', status: 'vegetative', container_type: 'raised_bed', substrate_start: '2026-08-06', last_fert: '2026-09-10' },
    deleted: [{ id: 'f441211e-c528-49d7-a6f3-5ed8433beb55', name: 'Purple Vienna Kohlrabi Seeds' }] },
  { row: 'ae276aeb-95c1-4dd2-8eab-159aa4dfa262', cultivar: '51da1e31-c16d-4cbc-ac3b-b3c718e7472c',
    variety: 'Redbor', genus: 'Brassica', slug: 'kale', bundled: ['by_genus_fallback', 'Brassica'], interval: 21,
    md5: 'c851db18b63f8b19612ce9300af574de', profile: { crop: 'kale', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 9 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2 },
    live: { id: 'b9b5d4b2-7763-4904-b897-2562647b6a8f', name: 'Redbor Kale', status: 'vegetative', container_type: 'tray_cell', substrate_start: '2026-07-31', last_fert: '2026-09-08' },
    deleted: [] },
  { row: '241d3455-8961-4c8c-a7ab-4a73e84fc002', cultivar: 'ece82bf2-6a60-4186-b031-64af0519aa49',
    variety: 'Spider Plant', genus: 'Chlorophytum', slug: 'spider_plant', bundled: ['by_variety', 'Spider Plant'], interval: 30,
    md5: '81e03e75f3e41f00829efc350ef319db', profile: { cold: { tender: true, protect_below_F: 50 }, crop: 'spider plant', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 7.0d over 7 intervals — THIN SAMPLE, revisit.', _source: 'cadence-backfill-20260823', confidence: 'low', water_method: 'drench_to_drainage', drought_tolerance: 'high', water_interval_days_container: 7 },
    live: { id: 'dc196337-453b-4c44-94c0-f1e20d6deef3', name: 'Spider Plant', status: 'vegetative', container_type: 'plastic_pot', substrate_start: '2026-07-09', last_fert: null },
    deleted: [] },
  { row: 'd44d911e-b57c-40d2-88e9-d35ae16b1c87', cultivar: '21a8596d-f689-4028-a1dc-a34ae94c128b',
    variety: 'Tavera', genus: 'Phaseolus', slug: 'bean', bundled: ['by_genus_fallback', 'Phaseolus'], interval: 30,
    md5: '7d54f17db6de625fc7ccf3018d4f162a', profile: { crop: 'bean', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 11 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_inground: 2, water_interval_days_container: 2 },
    live: { id: '3f273506-c291-4863-932d-9388bb8b5c81', name: 'Tavera Filet Bush Bean Seeds', status: 'harvested', container_type: 'in_ground', substrate_start: '2026-07-21', last_fert: '2026-09-10' },
    deleted: [] },
  { row: '43162747-b27c-4ac3-bbd8-eadddd48cffc', cultivar: 'bc79d915-69a3-4945-8293-27314d83a29b',
    variety: 'Tendersweet', genus: 'Daucus', slug: 'carrot', bundled: ['by_genus_fallback', 'Daucus'], interval: 30,
    md5: 'b7c570259a428cb046b14e49c1032dad', profile: { crop: 'carrot', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 1.0d over 9 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_inground: 1, water_interval_days_container: 1 },
    live: { id: 'a690cd4a-fa1e-4c8b-93ac-08b8f8c6041a', name: 'Tendersweet Carrot', status: 'vegetative', container_type: 'raised_bed', substrate_start: '2026-07-24', last_fert: '2026-09-10' },
    deleted: [] },
];

// The five rows Dave's decision leaves alone (prod ids and profiles as read 2026-09-21), and why.
const EXCLUDED = [
  { row: '49ebc111-edb7-46f3-b665-8e0ea04a579a', cultivar: '4ae060fa-ac18-4b71-8428-ffe3568a96a8', variety: 'Allegheny Blackberry', why: 'legacy in-ground Rubus (_tier P, deliberately unmanaged); the planting is dormant, never carded', genus: 'Rubus', slug: 'blackberry',
    profile: { crop: 'blackberry', _tier: 'P', notes: 'Established legacy in-ground Allegheny blackberry — deliberately unmanaged, rainfall only. no_calendar_water suppresses routine watering tasks; the interval is a fallback and is never expected to fire.', _source: 'cadence-backfill-20260823', confidence: 'high', water_method: 'rainfall_only', drought_tolerance: 'high', no_calendar_water: true, water_interval_days_inground: 14, water_interval_days_container: 14 },
    live: { id: '670c5160-17b6-413f-8cd6-f8ac59e73d9a', name: 'Blackberry', status: 'dormant', container_type: 'in_ground', substrate_start: '2026-07-25', last_fert: null } },
  { row: 'b973ecee-5c9e-4eac-b801-56b30e38dce3', cultivar: 'f8d90e8b-c43f-424a-96d4-45e5ad2db017', variety: 'Red Raspberry', why: 'legacy in-ground Rubus (_tier P, deliberately unmanaged); the planting is dormant, never carded', genus: 'Rubus', slug: 'red_raspberry',
    profile: { crop: 'red raspberry', _tier: 'P', notes: 'Established legacy in-ground red raspberry — deliberately unmanaged, rainfall only. no_calendar_water suppresses routine watering tasks; the interval is a fallback and is never expected to fire.', _source: 'cadence-backfill-20260823', confidence: 'high', water_method: 'rainfall_only', drought_tolerance: 'high', no_calendar_water: true, water_interval_days_inground: 14, water_interval_days_container: 14 },
    live: { id: 'c2d59748-240c-42f8-b1c3-50fe64dfa0fd', name: 'Red Raspberries', status: 'dormant', container_type: 'in_ground', substrate_start: '2026-06-03', last_fert: null } },
  { row: '401f91aa-ebb5-4fdf-9b5c-f6872b203bbc', cultivar: '3e9997e1-350a-4c81-b9b9-e607e808fec0', variety: 'Wild Wineberry', why: 'legacy in-ground Rubus (_tier P, deliberately unmanaged); the planting is dormant, never carded', genus: 'Rubus', slug: 'wineberry',
    profile: { crop: 'wineberry', _tier: 'P', notes: 'Established legacy in-ground wild wineberry — deliberately unmanaged, rainfall only. no_calendar_water suppresses routine watering tasks; the interval is a fallback and is never expected to fire.', _source: 'cadence-backfill-20260823', confidence: 'high', water_method: 'rainfall_only', drought_tolerance: 'high', no_calendar_water: true, water_interval_days_inground: 14, water_interval_days_container: 14 },
    live: { id: 'ee5b75e2-13b7-4735-a9fd-5c4381adc73f', name: 'Wild Wineberry', status: 'dormant', container_type: 'in_ground', substrate_start: '2026-06-30', last_fert: null } },
  { row: '6b8e2195-5534-4bb6-aceb-c91a9daebc88', cultivar: 'db83be63-5344-4615-9399-4eb0644dce14', variety: 'Lemon Thyme', why: 'crop "thyme": engine.isMedHerb never feeds it, so no card either way', genus: null, slug: 'thyme',
    profile: { crop: 'thyme', _tier: 'T2', notes: 'No crop baseline existed. Cadence derived from Dave\'s own watering log: median gap 2.0d over 11 intervals.', _source: 'cadence-backfill-20260823', confidence: 'medium', water_method: 'drench_to_drainage', drought_tolerance: 'low', water_interval_days_container: 2 },
    live: { id: '39141bf6-fc5d-46a6-99d8-2a190906956a', name: 'Lemon Thyme', status: 'vegetative', container_type: 'ceramic', substrate_start: '2026-07-11', last_fert: '2026-09-10' } },
  { row: 'd9690105-fb81-40cf-abb0-218972f86daa', cultivar: '62b87b4c-96fe-439e-99c8-d39c0179ed12', variety: 'Peach', why: 'no_calendar_feed: true (Dave, 2026-09-17); not among the 25 at all', genus: 'Prunus', slug: 'peach',
    profile: { crop: 'peach tree', _tier: 'P', notes: 'Established legacy in-ground peach tree — deliberately unmanaged, rainfall only. no_calendar_water suppresses routine watering tasks; the interval is a fallback and is never expected to fire. no_calendar_feed added 2026-09-17 on Dave\'s ruling (never feed it at all), after the inherited system 14-day interval carded Espoma Tomato-Tone on 09-08 and 09-09 and a fertilizing event was logged 09-10.', _source: 'cadence-backfill-20260823', confidence: 'high', water_method: 'rainfall_only', no_calendar_feed: true, drought_tolerance: 'high', no_calendar_water: true, water_interval_days_inground: 14, water_interval_days_container: 14 },
    live: { id: '4b1f2362-2def-4410-8e46-a599468c43e9', name: 'Peach tree', status: 'harvested', container_type: 'in_ground', substrate_start: '2026-06-09', last_fert: '2026-09-10' } },
];

// Every care_profile UPDATE in 0a, in file order. The guard and the create_missing flag are part of the shape: an
// UPDATE that loses either no longer matches, and the binding test below goes red. The jsonb literal is captured
// loosely on purpose, so a value written as a JSON string is caught by the number check, not by a silent non-match.
const UPDATES = [...SQL_0A.matchAll(
  /UPDATE public\.care_profile\s+SET profile = jsonb_set\(profile, '\{fertilize_interval_days\}', '([^']*)'::jsonb, (true|false)\),\s*updated_at = now\(\)\s+WHERE id = '([0-9a-f-]{36})'\s+AND scope = 'cultivar' AND scope_id = '([0-9a-f-]{36})'\s+AND NOT \(profile \? 'fertilize_interval_days'\);/g)]
  .map((m) => ({ row: m[3], cultivar: m[4], value: JSON.parse(m[1]), createMissing: m[2] }));
const valueFor = (row) => (UPDATES.find((u) => u.row === row) || {}).value;
// The bundled entry each 0a statement NAMES, from the comment on its scope_id line ("; by_genus_fallback[\"Hosta\"]").
const CLAIMS = [...RAW_0A.matchAll(
  /AND scope = 'cultivar' AND scope_id = '([0-9a-f-]{36})'[ \t]+--[^\n]*?; (by_variety|by_genus_fallback)\["([^"\n]+)"\][ \t]*\n/g)]
  .map((m) => ({ cultivar: m[1], bundled: [m[2], m[3]] }));
const bundledFor = (r) => cad[r.bundled[0]][r.bundled[1]];

// One gate's text, from its `- name:` line to the next gate's.
const gate = (name) => {
  const i = GATES.indexOf(`- name: ${name}\n`);
  if (i < 0) throw new Error(`gate ${name} not found`);
  const j = GATES.indexOf('- name: ', i + 1);
  return GATES.slice(i, j < 0 ? undefined : j);
};
const GATE_NAMES = [...GATES.matchAll(/- name: (\S+)\n/g)].map((m) => m[1]);
const uuids = (s) => [...s.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]);
// The ids inside one `<column> IN (...)` / `NOT IN (...)` list of a gate.
const inList = (name, column, not = false) => {
  const m = gate(name).match(new RegExp(`${column.replace('.', '\\.')} ${not ? 'NOT IN' : 'IN'} \\(([^)]*)\\)`));
  if (!m) throw new Error(`${name}: no ${column} ${not ? 'NOT IN' : 'IN'} list`);
  return uuids(m[1]);
};
const valueOf = (name) => Number(gate(name).match(/\n {4}value: (\d+)\n/)[1]);
// The gate's own `continuous: false` key line — not the section comment that can trail the slice.
const windowOnly = (name) => /\n {4}continuous: false\n/.test(gate(name));

// Postgres's jsonb text rendering (keys ordered by length, then bytes; ", " and ": " separators), so a fixture can be
// checked against the md5(profile::text) read on prod.
const byLenThenBytes = (a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b));
const pgText = (v) => (v === null ? 'null' : Array.isArray(v) ? `[${v.map(pgText).join(', ')}]`
  : typeof v === 'object' ? `{${Object.keys(v).sort(byLenThenBytes).map((k) => `${JSON.stringify(k)}: ${pgText(v[k])}`).join(', ')}}`
    : JSON.stringify(v));
const pgMd5 = (profile) => createHash('md5').update(pgText(profile)).digest('hex');

// v_resolved_care = system || cultivar (no leaf row on any of these plantings).
const resolved = (profile) => ({ ...SYSTEM, ...profile });
const afterProfile = (r) => ({ ...r.profile, fertilize_interval_days: valueFor(r.row) });
// The planting shape handler.js selects, as read on prod: adopting its cultivar profile (cadence_scopes {cultivar}).
const planting = (r, profile, over = {}) => ({
  id: r.live.id, name: r.live.name, variety: r.variety, genus: r.genus, crop_type_slug: r.slug,
  status: r.live.status, container_type: r.live.container_type, project: 'Garden', project_id: 'pj',
  project_status: 'growing', substrate_start: r.live.substrate_start, last_fert: r.live.last_fert,
  db_cadence: resolved(profile), cadence_scopes: ['cultivar'], ...over,
});
const planOn = (p, today) => generatePlan({ plantings: [{ ...p }], cadence: cad, fertModel: fm, today,
  weather: { unit: 'F', tonightLow: 60, highToday: 75 }, ownerFallback: 'dave' });
const feedCard = (p, today) => Object.values(planOn(p, today).users).flatMap((u) => u.tasks.fertilize)
  .find((x) => x.id === p.id) || null;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
// Forward 2026-09-21..11-30 (71 days), the model the expected-change table used: Dave feeds the day it is carded.
const forward = (p0) => {
  let p = p0;
  const cards = [];
  for (let i = 0; i <= 70; i++) {
    const day = addDays('2026-09-21', i);
    const c = feedCard(p, day);
    if (c) { cards.push({ day: day.slice(5), interval: c.interval }); p = { ...p, last_fert: day }; }
  }
  return cards;
};

describe('v5-feedinherit-001 writes the bundled interval, and only that key, on exactly the 21 rows', () => {
  it('0a sets fertilize_interval_days on the 21 rows, by id and (scope, scope_id), guarded on the key being absent, create_missing true', () => {
    expect(UPDATES.map(({ row, cultivar, createMissing }) => ({ row, cultivar, createMissing })))
      .toEqual(ROWS.map(({ row, cultivar }) => ({ row, cultivar, createMissing: 'true' })));
    expect((SQL_0A.match(/UPDATE public\.care_profile/g) || []).length).toBe(ROWS.length);
    expect(new Set(ROWS.map((r) => r.row)).size).toBe(21);
  });

  it.each(ROWS)('$variety: 0a writes $interval as a JSON number — its bundled entry, the value approved, the entry 0a names', (r) => {
    expect(typeof valueFor(r.row)).toBe('number');
    expect(valueFor(r.row)).toBe(r.interval);
    expect(bundledFor(r).fertilize_interval_days).toBe(r.interval);
    expect(CLAIMS.filter((c) => c.cultivar === r.cultivar)).toEqual([{ cultivar: r.cultivar, bundled: r.bundled }]);
  });

  it.each(ROWS)('$variety: the engine resolves that entry for every planting the row reaches, live and soft-deleted', (r) => {
    const via = r.bundled[0] === 'by_variety' ? `variety:${r.bundled[1]}` : `genus:${r.bundled[1]}`;
    for (const p of [r.live, ...r.deleted]) {
      const bundledOnly = resolveCadence({ id: p.id, name: p.name, variety: r.variety, genus: r.genus,
        crop_type_slug: r.slug, db_cadence: null, cadence_scopes: [] }, cad);
      expect(bundledOnly._via, p.name).toBe(via);
      expect(bundledOnly.fertilize_interval_days, p.name).toBe(valueFor(r.row));
    }
  });

  it.each(ROWS)('$variety: the bundled entry is about the same plant (genus $genus)', (r) => {
    if (r.bundled[0] === 'by_genus_fallback') expect(r.bundled[1]).toBe(r.genus);
    else {
      expect(r.bundled[1]).toBe(r.variety);
      expect(bundledFor(r).crop.toLowerCase()).toContain(r.genus.toLowerCase());
    }
  });

  it('negative control for that identity check: by_variety["Peach"] (a pepper) fails it for the Peach tree (Prunus)', () => {
    expect(cad.by_variety.Peach.crop.toLowerCase()).not.toContain('prunus');
  });

  it('the fixtures are the rows as read: each profile renders to the md5 pinned for it, and states no feed interval', () => {
    for (const r of ROWS) {
      expect(pgMd5(r.profile), r.variety).toBe(r.md5);
      expect(r.profile, r.variety).not.toHaveProperty('fertilize_interval_days');
      expect(r.profile._source, r.variety).toBe('cadence-backfill-20260823');
    }
  });

  it('0a names none of the five excluded rows, their cultivars or plantings, and stamps its own version', () => {
    for (const e of EXCLUDED) {
      for (const id of [e.row, e.cultivar, e.live.id]) {
        expect(RAW_0A.includes(id), `0a names ${e.variety} id ${id} (${e.why})`).toBe(false);
        expect(RAW_0R.includes(id), `0r names ${e.variety} id ${id}`).toBe(false);
      }
    }
    expect(SQL_0A).toContain(`VALUES ('${STAMP}',`);
    expect([...RAW_0A.matchAll(/'5\.0\.0-[a-z0-9-]+'/g)].map((m) => m[0])).toEqual([`'${STAMP}'`]);
  });

  it('0r removes only what 0a wrote, row by row, only while the stamp exists, and reports against the pinned md5', () => {
    const rolledBack = [...SQL_0R.matchAll(
      /UPDATE public\.care_profile\s+SET profile = profile - 'fertilize_interval_days', updated_at = now\(\)\s+WHERE id = '([0-9a-f-]{36})'\s+AND scope = 'cultivar' AND scope_id = '([0-9a-f-]{36})'\s+AND profile->'fertilize_interval_days' = '([^']*)'::jsonb\s+AND EXISTS \(SELECT 1 FROM public\.schema_version WHERE version = '([^']+)'\);/g)]
      .map((m) => ({ row: m[1], cultivar: m[2], value: JSON.parse(m[3]), stamp: m[4] }));
    expect(rolledBack).toEqual(ROWS.map((r) => ({ row: r.row, cultivar: r.cultivar, value: valueFor(r.row), stamp: STAMP })));
    expect((SQL_0R.match(/UPDATE public\.care_profile/g) || []).length).toBe(ROWS.length);
    expect(SQL_0R.indexOf(`DELETE FROM public.schema_version WHERE version = '${STAMP}';`))
      .toBeGreaterThan(SQL_0R.lastIndexOf('UPDATE public.care_profile'));
    const report = [...SQL_0R.matchAll(/\('([0-9a-f-]{36})', '(?:[^']|'')*', '([0-9a-f]{32})'\)/g)].map((m) => ({ row: m[1], md5: m[2] }));
    expect(report).toEqual(ROWS.map((r) => ({ row: r.row, md5: r.md5 })));
  });
});

describe('gates.yml carries the same rows, values, reach and exclusions', () => {
  it('the value receipt, the single-key receipt and the pre md5 gate carry the same literals', () => {
    const vals = [...gate('post_each_row_carries_its_bundled_interval').matchAll(
      /\('([0-9a-f-]{36})'::uuid, '([0-9a-f-]{36})'::uuid, '([^']*)'::jsonb\)/g)]
      .map((m) => ({ row: m[1], cultivar: m[2], value: JSON.parse(m[3]) }));
    expect(vals).toEqual(ROWS.map((r) => ({ row: r.row, cultivar: r.cultivar, value: bundledFor(r).fertilize_interval_days })));
    const single = [...gate('post_feed_fix_was_single_key_not_a_full_replace').matchAll(
      /\('([0-9a-f-]{36})'::uuid, '([0-9a-f-]{36})'::uuid, '([0-9a-f]{32})', (\d+)\)/g)]
      .map((m) => ({ row: m[1], cultivar: m[2], md5: m[3], nkeys: Number(m[4]) }));
    expect(single).toEqual(ROWS.map((r) => ({ row: r.row, cultivar: r.cultivar, md5: r.md5, nkeys: Object.keys(r.profile).length + 1 })));
    const pre = [...gate('pre_profiles_are_the_backfill_rows_without_a_feed_interval').matchAll(
      /\('([0-9a-f-]{36})'::uuid, '([0-9a-f-]{36})'::uuid, '([0-9a-f]{32})'\)/g)]
      .map((m) => ({ row: m[1], cultivar: m[2], md5: m[3] }));
    expect(pre).toEqual(ROWS.map((r) => ({ row: r.row, cultivar: r.cultivar, md5: r.md5 })));
  });

  it('the engine-view receipt names the 21 live plantings with their interval and unchanged watering interval', () => {
    const view = [...gate('post_engine_view_of_the_twenty_one_carries_the_interval').matchAll(
      /\('([0-9a-f-]{36})'::uuid, '([^']*)'::jsonb, '(\d+)'\)/g)]
      .map((m) => ({ id: m[1], value: JSON.parse(m[2]), wic: Number(m[3]) }));
    expect(view).toEqual(ROWS.map((r) => ({ id: r.live.id, value: r.interval, wic: r.profile.water_interval_days_container })));
  });

  it('the identity receipt names each cultivar with its name, crop type and genus', () => {
    const ident = [...gate('pre_cultivars_are_the_rows_read_at_authoring').matchAll(
      /\('([0-9a-f-]{36})'::uuid, '((?:[^']|'')*)', '([a-z_]+)', '([A-Za-z]+)'\)/g)]
      .map((m) => ({ cultivar: m[1], variety: m[2].replace(/''/g, "'"), slug: m[3], genus: m[4] }));
    expect(ident).toEqual(ROWS.map((r) => ({ cultivar: r.cultivar, variety: r.variety, slug: r.slug, genus: r.genus })));
  });

  it('the reach guards name exactly the 21 cultivars and their 26 plantings, and every count matches them', () => {
    const cultivars = ROWS.map((r) => r.cultivar);
    const live = ROWS.map((r) => r.live.id);
    const reach = ROWS.flatMap((r) => [r.live.id, ...r.deleted.map((d) => d.id)]);
    expect(reach).toHaveLength(26);
    expect(ROWS.flatMap((r) => r.deleted)).toHaveLength(5);
    expect(inList('pre_each_row_reaches_exactly_the_listed_plantings', 'p.variety_id')).toEqual(cultivars);
    expect(inList('pre_each_row_reaches_exactly_the_listed_plantings', 'p.id', true)).toEqual(reach);
    expect(uuids(gate('pre_the_twenty_one_are_live'))).toEqual(ROWS.flatMap((r) => [r.live.id, r.cultivar]));
    expect(uuids(gate('pre_the_five_soft_deleted_stay_deleted')))
      .toEqual(ROWS.flatMap((r) => r.deleted.flatMap((d) => [d.id, r.cultivar])));
    expect(inList('pre_the_engine_inherits_the_house_fourteen', 'vrc.leaf_id')).toEqual(live);
    expect(inList('pre_no_leaf_row_states_feeding_on_these_cultivars', 'p.variety_id')).toEqual(cultivars);
    expect(inList('post_no_live_planting_of_these_cultivars_inherits_the_house_feed_interval', 'p.variety_id')).toEqual(cultivars);
    expect(inList('post_zero_a_wrote_no_other_care_profile_row', 'cp.id', true)).toEqual(ROWS.map((r) => r.row));
    for (const name of ['pre_cultivars_are_the_rows_read_at_authoring', 'pre_profiles_are_the_backfill_rows_without_a_feed_interval',
      'pre_the_twenty_one_are_live', 'pre_the_engine_inherits_the_house_fourteen', 'post_each_row_carries_its_bundled_interval',
      'post_feed_fix_was_single_key_not_a_full_replace', 'post_engine_view_of_the_twenty_one_carries_the_interval']) {
      expect(valueOf(name), name).toBe(21);
    }
    expect(valueOf('pre_the_five_soft_deleted_stay_deleted')).toBe(5);
    for (const name of ['pre_each_row_reaches_exactly_the_listed_plantings', 'pre_no_leaf_row_states_feeding_on_these_cultivars',
      'post_no_live_planting_of_these_cultivars_inherits_the_house_feed_interval', 'post_the_excluded_rows_were_left_alone',
      'post_zero_a_wrote_no_other_care_profile_row', 'pre_not_already_applied']) {
      expect(valueOf(name), name).toBe(0);
    }
  });

  it('the five left out: only the pre/post pair names their rows, and nothing names their cultivars or plantings', () => {
    const rows = EXCLUDED.map((e) => e.row);
    expect(uuids(gate('pre_the_excluded_rows_state_no_feed_interval'))).toEqual(EXCLUDED.flatMap((e) => [e.row, e.cultivar]));
    expect(valueOf('pre_the_excluded_rows_state_no_feed_interval')).toBe(EXCLUDED.length);
    expect(inList('post_the_excluded_rows_were_left_alone', 'cp.id')).toEqual(rows);
    expect(windowOnly('post_the_excluded_rows_were_left_alone')).toBe(true);
    const pair = new Set(['pre_the_excluded_rows_state_no_feed_interval', 'post_the_excluded_rows_were_left_alone']);
    for (const name of GATE_NAMES.filter((n) => !pair.has(n))) {
      for (const e of EXCLUDED) {
        for (const id of [e.row, e.cultivar, e.live.id]) expect(gate(name).includes(id), `${name} names ${e.variety} id ${id}`).toBe(false);
      }
    }
    for (const e of EXCLUDED) expect(gate('pre_the_excluded_rows_state_no_feed_interval').includes(e.live.id)).toBe(false);
  });

  it('the standing invariant self-arms on this stamp, runs continuously, and judges where the interval comes from', () => {
    const g = gate('post_no_live_planting_of_these_cultivars_inherits_the_house_feed_interval');
    expect(g).toContain(`WHERE EXISTS (SELECT 1 FROM public.schema_version WHERE version = '${STAMP}')`);
    expect(windowOnly('post_no_live_planting_of_these_cultivars_inherits_the_house_feed_interval')).toBe(false);
    expect(g).toContain("coalesce(cd.profile ? 'fertilize_interval_days', false)");
    expect(g).toContain("coalesce(lo.profile ? 'fertilize_interval_days', false)");
    expect(g).toContain("vrc.resolved_profile->'no_calendar_feed' IS DISTINCT FROM 'true'::jsonb");
    expect(g).not.toContain('::regclass');
    for (const name of GATE_NAMES.filter((n) => n.startsWith('post_') && n !== 'post_no_live_planting_of_these_cultivars_inherits_the_house_feed_interval')) {
      expect(windowOnly(name), name).toBe(true);
    }
    expect([...GATES.matchAll(/'5\.0\.0-[a-z0-9-]+'/g)].every((m) => m[0] === `'${STAMP}'`)).toBe(true);
  });
});

describe('ENGINE — each of the 21 is fed on the house 14 days before the apply, on its own interval after', () => {
  // 2026-06-01 -> 2026-10-15 is 19 weeks: past the MG-active window (fertilizeRec returns null before 13 weeks for its
  // own reason), short of needs_feed_24wk_plus. Every card below appears or not because of the interval alone.
  const TODAY = '2026-10-15';
  const at = (p, daysSinceFeed) => feedCard({ ...p, substrate_start: '2026-06-01', last_fert: addDays(TODAY, -daysSinceFeed) }, TODAY);

  it('instrument check: every fixture takes the ADOPTED DATABASE PROFILE, which inherits 14 before and states its own after', () => {
    for (const r of ROWS) {
      const before = resolveCadence(planting(r, r.profile), cad);
      const after = resolveCadence(planting(r, afterProfile(r)), cad);
      expect(before._via, r.variety).toBe('db');
      expect(after._via, r.variety).toBe('db');
      expect(before.fertilize_interval_days, r.variety).toBe(14);
      expect(after.fertilize_interval_days, r.variety).toBe(r.interval);
      expect(after.water_interval_days_container, r.variety).toBe(before.water_interval_days_container);
    }
  });

  it.each(ROWS)('$live.name BEFORE: carded 14 days after a feed, with interval 14, and not at 13', (r) => {
    const p = planting(r, r.profile);
    expect(at(p, 13)).toBeNull();
    expect(at(p, 14)).toMatchObject({ id: r.live.id, interval: 14 });
  });

  it.each(ROWS)('$live.name AFTER: carded $interval days after a feed, with interval $interval, and not a day sooner', (r) => {
    const p = planting(r, afterProfile(r));
    expect(at(p, r.interval - 1)).toBeNull();
    expect(at(p, r.interval)).toMatchObject({ id: r.live.id, interval: r.interval });
    // The house 14 is exactly where the two differ: a card there before, none after (longer intervals), or a card a
    // week sooner (the petunias' 7).
    if (r.interval > 14) expect(at(p, 14)).toBeNull();
    else expect(at(p, 7)).toMatchObject({ interval: 7 });
  });
});

describe('EXPECTED CHANGE — the table Dave decided on, re-run through generatePlan on the rows as read', () => {
  // lane-profileshadow §3 (re-verified by this lane on 2026-09-21): feed cards 2026-09-21..11-30 before -> after, and
  // the first day the two runs differ (a card on one side only, or a card with a different interval).
  const EXPECTED = {
  'Alaska Mix Nasturtium 1': [5, 1, '10-02'],
  'Chrysanthemum': [5, 3, '09-22'],
  'Clemson Spineless 80': [4, 3, '10-14'],
  'Cobaea scandens (Violet)': [3, 2, '10-20'],
  'Contender Bush Bean': [3, 2, '10-20'],
  'Dwarf Blue Curled Kale': [3, 2, '10-30'],
  'Easy Wave Berry Velour Petunia': [4, 8, '10-11'],
  'Foxglove': [4, 2, '10-11'],
  'Gold Rush Bush Bean': [3, 2, '10-20'],
  'Hosta': [5, 2, '09-22'],
  'Japanese Maple': [5, 1, '09-24'],
  'Jewel Mix Nasturtium': [5, 1, '09-28'],
  'Lacinato Dinosaur Kale': [3, 2, '10-30'],
  'Lemon Verbena': [3, 2, '10-20'],
  'Palla Rossa Mavrik Radicchio': [3, 2, '10-21'],
  'Petunia': [4, 8, '10-11'],
  'Purple Vienna Kohlrabi': [2, 2, '11-05'],
  'Redbor Kale': [3, 2, '10-30'],
  'Spider Plant': [4, 2, '10-08'],
  'Tavera Filet Bush Bean Seeds': [3, 2, '10-20'],
  'Tendersweet Carrot': [3, 2, '10-23'],
  };
  const runs = ROWS.map((r) => ({ r, before: forward(planting(r, r.profile)), after: forward(planting(r, afterProfile(r))) }));

  it.each(runs.map((x) => [x.r.live.name, x]))('%s: card count and first differing day as in the table', (name, { before, after }) => {
    const [b, a, first] = EXPECTED[name];
    expect(before.length).toBe(b);
    expect(after.length).toBe(a);
    expect(before.every((c) => c.interval === 14)).toBe(true);
    const days = new Set([...before, ...after].map((c) => c.day));
    const diff = [...days].sort().find((d) => JSON.stringify(before.find((c) => c.day === d)) !== JSON.stringify(after.find((c) => c.day === d)));
    expect(diff).toBe(first);
  });

  it('77 feed cards become 53: 18 plantings fewer, the two petunias more, the kohlrabi the same count a week later', () => {
    expect(runs.reduce((n, x) => n + x.before.length, 0)).toBe(77);
    expect(runs.reduce((n, x) => n + x.after.length, 0)).toBe(53);
    expect(runs.filter((x) => x.after.length < x.before.length)).toHaveLength(18);
    expect(runs.filter((x) => x.after.length > x.before.length).map((x) => x.r.live.name).sort())
      .toEqual(['Easy Wave Berry Velour Petunia', 'Petunia']);
    const kohlrabi = runs.find((x) => x.r.live.name === 'Purple Vienna Kohlrabi');
    expect(kohlrabi.before.map((c) => c.day)).toEqual(['11-05', '11-19']);
    expect(kohlrabi.after.map((c) => c.day)).toEqual(['11-05', '11-26']);
    const petunia = runs.find((x) => x.r.live.name === 'Petunia');
    expect(petunia.after.map((c) => c.day)).toEqual(['10-11', '10-18', '10-25', '11-01', '11-08', '11-15', '11-22', '11-29']);
  });
});

describe('DECISION — the five left out get no feed card either way', () => {
  const excludedPlanting = (e, profile) => ({
    id: e.live.id, name: e.live.name, variety: e.variety, genus: e.genus, crop_type_slug: e.slug, status: e.live.status,
    container_type: e.live.container_type, project: 'Garden', project_id: 'pj', project_status: 'growing',
    substrate_start: e.live.substrate_start, last_fert: e.live.last_fert, db_cadence: resolved(profile), cadence_scopes: ['cultivar'],
  });
  const bundledInterval = (e) => resolveCadence({ ...excludedPlanting(e, e.profile), db_cadence: null, cadence_scopes: [] }, cad)
    .fertilize_interval_days;

  it.each(EXCLUDED)('$variety ($why): no card over the 71 days, as read or with its bundled interval written', (e) => {
    expect(e.profile).not.toHaveProperty('fertilize_interval_days');
    expect(forward(excludedPlanting(e, e.profile))).toEqual([]);
    expect(forward(excludedPlanting(e, { ...e.profile, fertilize_interval_days: bundledInterval(e) }))).toEqual([]);
  });

  it('and each for its recorded reason: the Rubus dormant and _tier P, Lemon Thyme a Mediterranean herb, the Peach never-feed', () => {
    const by = Object.fromEntries(EXCLUDED.map((e) => [e.variety, e]));
    for (const v of ['Allegheny Blackberry', 'Red Raspberry', 'Wild Wineberry']) {
      expect(by[v].live.status, v).toBe('dormant');
      expect(by[v].profile._tier, v).toBe('P');
    }
    expect(isMedHerb(by['Lemon Thyme'].profile.crop)).toBe(true);
    expect(by.Peach.profile.no_calendar_feed).toBe(true);
    // Positive control: without its never-feed key the Peach WOULD be carded (the 09-08 leak), so the empty run above is
    // the key working, not a fixture that can never card.
    const { no_calendar_feed: _drop, ...peachWithoutKey } = by.Peach.profile;
    expect(forward(excludedPlanting(by.Peach, peachWithoutKey)).length).toBeGreaterThan(0);
  });
});
