-- 0a-data.sql
-- v5-feedinherit-001 — BUG-CAREFEEDINHERIT-001: 21 plantings are prompted to feed every 14 days because
-- their cultivar care profile never states a feeding interval, so the house default fills it in. This
-- gives each of those 21 cultivar profiles the one key it lacks, `fertilize_interval_days`, with the
-- value the bundled cadence data already carries for that plant.
--
-- APPLIED on prod 2026-09-21 17:10:19Z and on staging 17:10:12Z (stamp only). Do not re-run (README.md, Status).
-- NOT APPLIED as of authoring (2026-09-21, lane feedintervals). No statement in this directory has run
-- against staging or prod; it was rehearsed on an ephemeral fork of prod (README.md). Apply order:
-- README.md.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data.sql
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE DEFECT, measured read-only on prod 2026-09-21 (lane-profileshadow census, re-run by this lane)
--
-- v_resolved_care merges system || cultivar || leaf with the jsonb || operator (shallow, top-level,
-- right wins). The SYSTEM row carries fertilize_interval_days: 14. A cultivar row that omits the key
-- therefore hands the engine 14, and engine.fertilizeRec cannot tell "the cultivar says 14" from
-- "nobody said anything". cadence-backfill-20260823 wrote watering-only cultivar profiles, so every
-- plant under one of them is fed on the house 14 days. Census over the daily-plan handler's live-planting
-- filter (211 plantings, 208 adopt a database profile): 25 inherit 14 while their bundled
-- cadence-data-v2.json entry says otherwise. Forward 2026-09-21..11-30 (model: Dave feeds the day it is
-- carded), 21 of the 25 get a different run of feed cards; the other four never get one either way.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE ROWS — every one CULTIVAR scope (care_scope = system | cultivar | leaf; the "genus:Brassica"
-- style labels below name the BUNDLED entry each row lacks, not the row's scope). A cultivar row reaches
-- every planting of its variety, live or deleted, so every plants row of each variety was read. 18 rows
-- reach exactly their one live planting. Three also reach soft-deleted plantings of the same cultivar
-- (listed): nothing reads a deleted planting's feed interval (the daily-plan SELECT drops deleted rows),
-- and each of them resolves the same bundled entry as its live sibling. No leaf-scope row exists on any
-- planting of these 21 cultivars.
--
--   58586ba5-7080-469d-bf77-3f5746cd2132  cultivar "Alaska Mix" (a11dd600…), nasturtium
--       fertilize_interval_days <- by_variety["Alaska Mix"].fertilize_interval_days = 45
--       -> Alaska Mix Nasturtium 1 (8f84f21c…), vegetative, trough
--          and soft-deleted "Alaska Mix Nasturtium 2" (7ea304c4…, deleted 2026-08-14)
--          and soft-deleted "Alaska Mix Nasturtium" (d6b56799…, deleted 2026-07-21)
--   cf4e17cf-d3da-46c9-bf71-a014f35bf2ad  cultivar "Chrysanthemum" (b11814aa…), chrysanthemum
--       fertilize_interval_days <- by_genus_fallback["Chrysanthemum"].fertilize_interval_days = 28
--       -> Chrysanthemum (a458d170…), vegetative, plastic_pot
--   834a3a15-bd59-4801-ac2d-1d58bc0c79a3  cultivar "Clemson Spineless 80" (1b2b7bf8…), okra
--       fertilize_interval_days <- by_genus_fallback["Abelmoschus"].fertilize_interval_days = 21
--       -> Clemson Spineless 80 (c7a08b26…), harvested, in_ground
--          and soft-deleted "Clemson Spineless 80" (11b13057…, deleted 2026-07-15)
--          and soft-deleted "Clemson Spineless 80 Okra Seeds" (cd6c4356…, deleted 2026-07-22)
--   9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c  cultivar "Cobaea scandens (Violet)" (3db84405…), cobaea
--       fertilize_interval_days <- by_genus_fallback["Cobaea"].fertilize_interval_days = 21
--       -> Cobaea scandens (Violet) (1ef9592e…), vegetative, plastic_pot
--   e43739f4-75a6-4ae4-a673-1a8aef0e0f0b  cultivar "Contender" (d9eba456…), bean
--       fertilize_interval_days <- by_genus_fallback["Phaseolus"].fertilize_interval_days = 30
--       -> Contender Bush Bean (909c85ce…), harvested, in_ground
--   f807599b-f4d4-4fff-9703-ff21cbf9981f  cultivar "Dwarf Blue Curled (Vates)" (219329ac…), kale
--       fertilize_interval_days <- by_genus_fallback["Brassica"].fertilize_interval_days = 21
--       -> Dwarf Blue Curled Kale (198627b4…), vegetative, tray_cell
--   04554719-e633-44d7-8791-f3e33c90ed2d  cultivar "Easy Wave Berry Velour" (ba53f113…), petunia
--       fertilize_interval_days <- by_genus_fallback["Petunia"].fertilize_interval_days = 7
--       -> Easy Wave Berry Velour Petunia (ac3c0e05…), flowering, plastic_pot
--   f86d0c66-7b6d-4a8e-b9de-0132d9e3332a  cultivar "Foxglove" (c94e3179…), foxglove
--       fertilize_interval_days <- by_genus_fallback["Digitalis"].fertilize_interval_days = 30
--       -> Foxglove (b2784442…), vegetative, plastic_pot
--   13bcffdc-ac3d-4294-a6a9-b887aa76584e  cultivar "Gold Rush" (450c3391…), bean
--       fertilize_interval_days <- by_genus_fallback["Phaseolus"].fertilize_interval_days = 30
--       -> Gold Rush Bush Bean (71cfa027…), harvested, in_ground
--   5378c39e-8174-4ce9-85ad-351adc4f1486  cultivar "Hosta" (3b986e62…), hosta
--       fertilize_interval_days <- by_genus_fallback["Hosta"].fertilize_interval_days = 45
--       -> Hosta (21408041…), vegetative, in_ground
--   8cc55d60-10a6-468e-a9af-cfafc7731b65  cultivar "Japanese Maple" (055e3ff1…), japanese_maple
--       fertilize_interval_days <- by_variety["Japanese Maple"].fertilize_interval_days = 60
--       -> Japanese Maple (8814273d…), vegetative, plastic_pot
--   2d2bc039-58e4-4ce7-8930-e58a66c4cd5a  cultivar "Jewel Mix Nasturtium" (d3101ac0…), nasturtium
--       fertilize_interval_days <- by_genus_fallback["Tropaeolum"].fertilize_interval_days = 45
--       -> Jewel Mix Nasturtium (731682ea…), flowering, plastic_pot
--   ebf1aab5-4879-4080-a8aa-4e11b454de31  cultivar "Lacinato (Dinosaur)" (b1fad1e2…), kale
--       fertilize_interval_days <- by_genus_fallback["Brassica"].fertilize_interval_days = 21
--       -> Lacinato Dinosaur Kale (54689036…), vegetative, tray_cell
--   e74d95b7-df0a-4948-9bf2-d5bfd1bbeeea  cultivar "Lemon Verbena" (72ebf73c…), lemon_verbena
--       fertilize_interval_days <- by_genus_fallback["Aloysia"].fertilize_interval_days = 21
--       -> Lemon Verbena (edfc68f5…), harvested, fabric_bag
--   c848cd0b-48bf-4622-be46-b65903725bc3  cultivar "Palla Rossa Mavrik" (0609afc2…), radicchio
--       fertilize_interval_days <- by_genus_fallback["Cichorium"].fertilize_interval_days = 21
--       -> Palla Rossa Mavrik Radicchio (54245a51…), vegetative, tray_cell
--   315a0e95-0469-4b88-9647-5662c0edc884  cultivar "Petunia" (f46745bf…), petunia
--       fertilize_interval_days <- by_genus_fallback["Petunia"].fertilize_interval_days = 7
--       -> Petunia (e6f33a3d…), flowering, hanging_basket
--   1d49baf7-103b-4a65-a6f5-81d1034d36a1  cultivar "Purple Vienna" (81924103…), kohlrabi
--       fertilize_interval_days <- by_genus_fallback["Brassica"].fertilize_interval_days = 21
--       -> Purple Vienna Kohlrabi (d2e8c2df…), vegetative, raised_bed
--          and soft-deleted "Purple Vienna Kohlrabi Seeds" (f441211e…, deleted 2026-08-14)
--   ae276aeb-95c1-4dd2-8eab-159aa4dfa262  cultivar "Redbor" (51da1e31…), kale
--       fertilize_interval_days <- by_genus_fallback["Brassica"].fertilize_interval_days = 21
--       -> Redbor Kale (b9b5d4b2…), vegetative, tray_cell
--   241d3455-8961-4c8c-a7ab-4a73e84fc002  cultivar "Spider Plant" (ece82bf2…), spider_plant
--       fertilize_interval_days <- by_variety["Spider Plant"].fertilize_interval_days = 30
--       -> Spider Plant (dc196337…), vegetative, plastic_pot
--   d44d911e-b57c-40d2-88e9-d35ae16b1c87  cultivar "Tavera" (21a8596d…), bean
--       fertilize_interval_days <- by_genus_fallback["Phaseolus"].fertilize_interval_days = 30
--       -> Tavera Filet Bush Bean Seeds (3f273506…), harvested, in_ground
--   43162747-b27c-4ac3-bbd8-eadddd48cffc  cultivar "Tendersweet" (bc79d915…), carrot
--       fertilize_interval_days <- by_genus_fallback["Daucus"].fertilize_interval_days = 30
--       -> Tendersweet Carrot (a690cd4a…), vegetative, raised_bed
--
-- Values are the bundled ones, COPIED, not re-decided: the fertilize_interval_days of the
-- cadence-data-v2.json entry engine.resolveCadence picks for each planting when no database scope
-- applies, at d9affbebdd9f13aff765effa96b34ea3520ab317 (by_variety for three rows, by_genus_fallback for
-- eighteen). Each bundled entry is about the same plant as the cultivar: a genus entry is keyed by the
-- cultivar's own plant_varieties.genus, and each of the three variety entries names that genus in its
-- crop text. lambda/daily-plan/feedinherit.test.js parses every value, and the entry each line below
-- names, out of this file and fails if one stops matching.
--
-- NOT IN THIS FILE, deliberately (Dave, 2026-09-21: set "the 21" to their care-data intervals):
--   Allegheny Blackberry, Red Raspberry, Wild Wineberry — the three legacy in-ground Rubus rows
--     (_tier P, "deliberately unmanaged, rainfall only"). All three plantings are dormant, so the engine
--     never cards them either way.
--   Lemon Thyme — its crop is "thyme", which engine.isMedHerb never feeds; no card either way.
--   Peach — not among the 25 at all; its row carries no_calendar_feed: true (Dave, 2026-09-17).
--   gates.yml checks that this file writes none of those five rows.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE FIX
--
-- SINGLE-KEY jsonb_set, never a whole-object replace (the v5-coldshadow-001/-002 method): the 8 or 9
-- keys already on each row stay byte-identical (gates.yml checks their md5). create_missing is TRUE
-- because the key is ABSENT: jsonb_set(profile, '{fertilize_interval_days}', …, false) on a row without
-- it returns the row unchanged, so the UPDATE would print "UPDATE 1" and write nothing. The post
-- receipts tell "wrote the key" from "matched the row". The value is a JSON NUMBER: the engine reads the
-- key only when typeof is 'number', so a string would be ignored.
--
-- Keyed by care_profile row id AND its (scope, scope_id) pair, guarded on the key being absent: a
-- re-run matches nothing, and an interval written later by anyone is never clobbered. care_profile has
-- no triggers (read on prod). Its two app writers cannot reach these rows: lambda/varieties inserts a
-- row for a NEW cultivar only (ON CONFLICT DO NOTHING), lambda/plants/overwinterAttr.js writes leaf rows.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- LANDING ORDER: none. No code change and no column added or removed. engine.fertilizeRec already reads
-- the key from the adopted profile. Prod main 628620625dda6f2979eafc54ac7faa2e9d674faa (v4.141.0) and
-- this migration's base d9affbeb have byte-identical lambda/daily-plan/, scripts/gate_runner.py and
-- migrations/ (git diff empty), so prod already runs the engine the rehearsal used.
--
-- SAFETY: idempotent and non-clobbering. On a database without these rows every UPDATE matches zero
-- rows and only the stamp is written, the safe direction. That is the expected staging result: the rows
-- were written on prod on 2026-08-23 and the staging branch was cut from prod on 2026-08-11 (the
-- v5-coldshadow-001/-002 finding; staging was not read by this lane). On PROD every UPDATE must print
-- UPDATE 1: an UPDATE 0 there means the wrong host or a changed row — stop and read the pre gates (a
-- guarded UPDATE 0 reads like "already applied").
-- ROLLBACK: 0r-rollback.sql.

BEGIN;

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '45'::jsonb, true),
       updated_at = now()
 WHERE id = '58586ba5-7080-469d-bf77-3f5746cd2132'
   AND scope = 'cultivar' AND scope_id = 'a11dd600-84b4-4bd6-8611-f85336bc3c2e'   -- Alaska Mix -> Alaska Mix Nasturtium 1 (+2 soft-deleted); by_variety["Alaska Mix"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '28'::jsonb, true),
       updated_at = now()
 WHERE id = 'cf4e17cf-d3da-46c9-bf71-a014f35bf2ad'
   AND scope = 'cultivar' AND scope_id = 'b11814aa-83ed-48e4-882d-a6709e42572f'   -- Chrysanthemum -> Chrysanthemum; by_genus_fallback["Chrysanthemum"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '21'::jsonb, true),
       updated_at = now()
 WHERE id = '834a3a15-bd59-4801-ac2d-1d58bc0c79a3'
   AND scope = 'cultivar' AND scope_id = '1b2b7bf8-0d9e-4c39-b7d7-0acd744f16f7'   -- Clemson Spineless 80 -> Clemson Spineless 80 (+2 soft-deleted); by_genus_fallback["Abelmoschus"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '21'::jsonb, true),
       updated_at = now()
 WHERE id = '9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c'
   AND scope = 'cultivar' AND scope_id = '3db84405-1941-4e88-bb77-58595f47c3e7'   -- Cobaea scandens (Violet) -> Cobaea scandens (Violet); by_genus_fallback["Cobaea"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '30'::jsonb, true),
       updated_at = now()
 WHERE id = 'e43739f4-75a6-4ae4-a673-1a8aef0e0f0b'
   AND scope = 'cultivar' AND scope_id = 'd9eba456-0836-4690-b3db-02aa0fb4fb1b'   -- Contender -> Contender Bush Bean; by_genus_fallback["Phaseolus"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '21'::jsonb, true),
       updated_at = now()
 WHERE id = 'f807599b-f4d4-4fff-9703-ff21cbf9981f'
   AND scope = 'cultivar' AND scope_id = '219329ac-66f3-4c25-8a46-6246bb91c858'   -- Dwarf Blue Curled (Vates) -> Dwarf Blue Curled Kale; by_genus_fallback["Brassica"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '7'::jsonb, true),
       updated_at = now()
 WHERE id = '04554719-e633-44d7-8791-f3e33c90ed2d'
   AND scope = 'cultivar' AND scope_id = 'ba53f113-9903-449d-81b9-7dce30ef3934'   -- Easy Wave Berry Velour -> Easy Wave Berry Velour Petunia; by_genus_fallback["Petunia"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '30'::jsonb, true),
       updated_at = now()
 WHERE id = 'f86d0c66-7b6d-4a8e-b9de-0132d9e3332a'
   AND scope = 'cultivar' AND scope_id = 'c94e3179-b14a-4707-8ca2-1305dd0946dc'   -- Foxglove -> Foxglove; by_genus_fallback["Digitalis"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '30'::jsonb, true),
       updated_at = now()
 WHERE id = '13bcffdc-ac3d-4294-a6a9-b887aa76584e'
   AND scope = 'cultivar' AND scope_id = '450c3391-b809-43e5-b7ae-de16b9cce431'   -- Gold Rush -> Gold Rush Bush Bean; by_genus_fallback["Phaseolus"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '45'::jsonb, true),
       updated_at = now()
 WHERE id = '5378c39e-8174-4ce9-85ad-351adc4f1486'
   AND scope = 'cultivar' AND scope_id = '3b986e62-14ca-4262-86bb-eb35c418bd19'   -- Hosta -> Hosta; by_genus_fallback["Hosta"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '60'::jsonb, true),
       updated_at = now()
 WHERE id = '8cc55d60-10a6-468e-a9af-cfafc7731b65'
   AND scope = 'cultivar' AND scope_id = '055e3ff1-21c0-44ce-bace-d8a900f6145a'   -- Japanese Maple -> Japanese Maple; by_variety["Japanese Maple"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '45'::jsonb, true),
       updated_at = now()
 WHERE id = '2d2bc039-58e4-4ce7-8930-e58a66c4cd5a'
   AND scope = 'cultivar' AND scope_id = 'd3101ac0-fd4e-456e-86b7-ebea732ac84c'   -- Jewel Mix Nasturtium -> Jewel Mix Nasturtium; by_genus_fallback["Tropaeolum"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '21'::jsonb, true),
       updated_at = now()
 WHERE id = 'ebf1aab5-4879-4080-a8aa-4e11b454de31'
   AND scope = 'cultivar' AND scope_id = 'b1fad1e2-b2e1-40ee-ab02-1f6cf9a20a6d'   -- Lacinato (Dinosaur) -> Lacinato Dinosaur Kale; by_genus_fallback["Brassica"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '21'::jsonb, true),
       updated_at = now()
 WHERE id = 'e74d95b7-df0a-4948-9bf2-d5bfd1bbeeea'
   AND scope = 'cultivar' AND scope_id = '72ebf73c-bf46-429a-bb2d-3243e3d0826d'   -- Lemon Verbena -> Lemon Verbena; by_genus_fallback["Aloysia"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '21'::jsonb, true),
       updated_at = now()
 WHERE id = 'c848cd0b-48bf-4622-be46-b65903725bc3'
   AND scope = 'cultivar' AND scope_id = '0609afc2-51ea-4045-858b-fe28060e2f20'   -- Palla Rossa Mavrik -> Palla Rossa Mavrik Radicchio; by_genus_fallback["Cichorium"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '7'::jsonb, true),
       updated_at = now()
 WHERE id = '315a0e95-0469-4b88-9647-5662c0edc884'
   AND scope = 'cultivar' AND scope_id = 'f46745bf-c77e-4f42-b939-5363378a035e'   -- Petunia -> Petunia; by_genus_fallback["Petunia"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '21'::jsonb, true),
       updated_at = now()
 WHERE id = '1d49baf7-103b-4a65-a6f5-81d1034d36a1'
   AND scope = 'cultivar' AND scope_id = '81924103-2858-408f-991e-aad591827a49'   -- Purple Vienna -> Purple Vienna Kohlrabi (+1 soft-deleted); by_genus_fallback["Brassica"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '21'::jsonb, true),
       updated_at = now()
 WHERE id = 'ae276aeb-95c1-4dd2-8eab-159aa4dfa262'
   AND scope = 'cultivar' AND scope_id = '51da1e31-c16d-4cbc-ac3b-b3c718e7472c'   -- Redbor -> Redbor Kale; by_genus_fallback["Brassica"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '30'::jsonb, true),
       updated_at = now()
 WHERE id = '241d3455-8961-4c8c-a7ab-4a73e84fc002'
   AND scope = 'cultivar' AND scope_id = 'ece82bf2-6a60-4186-b031-64af0519aa49'   -- Spider Plant -> Spider Plant; by_variety["Spider Plant"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '30'::jsonb, true),
       updated_at = now()
 WHERE id = 'd44d911e-b57c-40d2-88e9-d35ae16b1c87'
   AND scope = 'cultivar' AND scope_id = '21a8596d-f689-4028-a1dc-a34ae94c128b'   -- Tavera -> Tavera Filet Bush Bean Seeds; by_genus_fallback["Phaseolus"]
   AND NOT (profile ? 'fertilize_interval_days');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{fertilize_interval_days}', '30'::jsonb, true),
       updated_at = now()
 WHERE id = '43162747-b27c-4ac3-bbd8-eadddd48cffc'
   AND scope = 'cultivar' AND scope_id = 'bc79d915-69a3-4945-8293-27314d83a29b'   -- Tendersweet -> Tendersweet Carrot; by_genus_fallback["Daucus"]
   AND NOT (profile ? 'fertilize_interval_days');

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-feedinherit-001',
        'FEEDINHERIT-001: BUG-CAREFEEDINHERIT-001 (data-only, no DDL). Adds fertilize_interval_days to 21 '
        'cultivar care_profile rows written by cadence-backfill-20260823 without one, which therefore '
        'inherited the system row''s 14 days. Values copied from the bundled cadence-data-v2.json entry the '
        'engine resolves for each planting. Single-key jsonb_set keyed by row id and guarded on the key being '
        'absent; every other key untouched. Dave decision 2026-09-21 (set the 21 to their care-data '
        'intervals; the three legacy Rubus rows, Lemon Thyme and the Peach left alone). Reversible via 0r.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
