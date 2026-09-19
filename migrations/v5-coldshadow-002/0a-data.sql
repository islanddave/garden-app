-- 0a-data.sql
-- v5-coldshadow-002 — V5-COLDSHADOWCENSUS-001: the POTTED plantings among the 19 whose bundled bring-inside
-- threshold is shadowed by a database care profile get that threshold back, by giving their cultivar care
-- profiles the one key that data carries and the profiles lack: `cold`. The sequel to v5-coldshadow-001
-- (Graptosedum, Pachyphytum), same method, disjoint rows.
--
-- NOT APPLIED as of authoring (2026-09-19, lane coldcards). No statement in this directory has run
-- against staging or prod. Apply order: README.md.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data.sql
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE DEFECT, measured read-only on prod 2026-09-19 (the v5-coldshadow-001 mechanism, wider census)
--
-- engine.coldFor resolves the planting's cadence first. When a database scope contributes a watering
-- interval (v_resolved_care.cadence_scopes non-empty), engine.resolveCadence returns that database
-- profile WHOLE and never reads cadence-data-v2.json. cadence-backfill-20260823 wrote watering-only
-- cultivar profiles with no `cold` key, and every bundled cold block beneath them went dark. Census over
-- the daily-plan handler's live-planting filter (209 plantings), base engine: 19 plantings shadowed. The
-- live plan shows both halves: on 2026-07-24 (low 49F) the coleus (left out below) got "tender tropical —
-- bring in tonight (low 49°F ≤ 50°F)" from the bundled data; from 2026-08-23 the plan's `crop` string for
-- every one of these plantings is the database wording, and none has had a profile-path card since except
-- Spider Plant, through the crop-type fallback at 45F.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE ROWS — every one CULTIVAR scope. There is no genus scope in the database (care_scope = system |
-- cultivar | leaf); the "genus:Coleus"-style labels in the census are the BUNDLED entry each row
-- shadows (cadence-data-v2.json by_genus_fallback), not the row's scope. A cultivar row reaches every
-- planting of its variety, so every planting of each variety was read, live or not: each row below
-- reaches exactly the live plantings listed (the other plantings of these varieties: none). No leaf-scope
-- row exists on any of them.
--
--   9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c  cultivar "Cobaea scandens (Violet)" (3db84405…), cobaea
--       `cold` <- by_genus_fallback["Cobaea"].cold = protect below 40F
--       -> Cobaea scandens (Violet) (1ef9592e…), plastic pot 6 in, Trough; no card today
--   04554719-e633-44d7-8791-f3e33c90ed2d  cultivar "Easy Wave Berry Velour" (ba53f113…), petunia
--       `cold` <- by_genus_fallback["Petunia"].cold = protect below 35F
--       -> Easy Wave Berry Velour Petunia (ac3c0e05…), plastic pot 6 in, Trough; no card today
--   2d2bc039-58e4-4ce7-8930-e58a66c4cd5a  cultivar "Jewel Mix Nasturtium" (d3101ac0…), nasturtium
--       `cold` <- by_genus_fallback["Tropaeolum"].cold = protect below 32F
--       -> Jewel Mix Nasturtium (731682ea…), plastic pot 6 in, Bag Area; no card today
--   315a0e95-0469-4b88-9647-5662c0edc884  cultivar "Petunia" (f46745bf…), petunia
--       `cold` <- by_genus_fallback["Petunia"].cold = protect below 35F
--       -> Petunia (e6f33a3d…), hanging basket 8 in, Trough; no card today
--   54187824-9ea7-4c5c-9fbf-da5f2326b84e  cultivar "Silver (Licorice Plant)" (4379ae45…), helichrysum
--       `cold` <- by_genus_fallback["Helichrysum"].cold = protect below 40F
--       -> Silver Helichrysum (a70bc754…), plastic pot 4 in, Trough; no card today
--   241d3455-8961-4c8c-a7ab-4a73e84fc002  cultivar "Spider Plant" (ece82bf2…), spider_plant
--       `cold` <- by_variety["Spider Plant"].cold = protect below 50F
--       -> Spider Plant (dc196337…), plastic pot 4 in, Stable; card today at 45F (crop-type fallback)
--   f9a3ca14-5a9e-4cd9-8294-babd6e90279f  cultivar "Sunny Susy White Halo" (eb7e7347…), thunbergia
--       `cold` <- by_genus_fallback["Thunbergia"].cold = protect below 45F
--       -> Sunny Susy White Halo Thunbergia (8ca4d744…), plastic pot 4 in, Trough; no card today
--   19c81d1a-c313-4ae2-bc82-5069eee72fe6  cultivar "Wishbone Flower" (a3d41b0a…), torenia
--       `cold` <- by_genus_fallback["Torenia"].cold = protect below 45F
--       -> Wishbone Flower (Torenia) (ae936173…), plastic pot 3 in, Trough; no card today
--
-- Values are the bundled ones, COPIED, not re-decided: the `cold` of the cadence-data-v2.json entry the
-- census resolved for each planting at 10452156cbef82b613bc0d4161d9237da555c969 (by_genus_fallback[genus]
-- for seven rows, by_variety["Spider Plant"] for one). Each bundled entry's crop agrees with the
-- variety's controlled crop_type_slug — no name collision of the by_variety["Peach"] kind.
-- lambda/daily-plan/coldcards.test.js parses every literal out of this file and fails if one stops
-- equalling its bundled entry.
--
-- NOT IN THIS FILE, deliberately (Dave, 2026-09-19: "card the potted ones"; decisions in README.md):
--   Fairway Orange Coleus, Fairway Orange Coleus Clone 1, Kiwi Fern Coleus — 15-gallon terracotta. Dave,
--     2026-09-19: "No, leave them off" — he will not move them. gates.yml checks that this file does not
--     write their two cultivar rows (573c512c Fairway Orange, 56d1cef3 Kiwi Fern).
--   Alaska Mix Nasturtium 1 — a 6x2 ft trough planter, cannot be carried in.
--   Clemson Spineless 80 (okra), Peach tree — in the ground; the Peach's bundled entry is a PEPPER.
--   Graptosedum, Pachyphytum — v5-coldshadow-001.
--   Echeveria, Ginger — the crop-type fallback already gives each exactly its bundled threshold (40F,
--     55F) at every temperature; a row here would change nothing.
--   Jade Plant — its bundled 40F would LOWER the 45F the crop-type fallback gives it.
-- Spider Plant is the one row that raises an existing card: 45F (crop-type fallback) -> 50F (its
-- by_variety entry, which the engine's own precedence makes authoritative over the fallback).
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE FIX
--
-- SINGLE-KEY jsonb_set, never a whole-object replace (v5-coldshadow-001, v5-heatrespcabbage-001): the 8
-- keys already on each row — watering interval, method, crop, notes, confidence, the _source marker —
-- stay byte-identical (gates.yml checks their md5). create_missing is TRUE because the key is ABSENT:
-- jsonb_set(profile, '{cold}', …, false) on a row without `cold` returns the row unchanged, so the
-- UPDATE would report "UPDATE 1" and write nothing. The post receipts tell "wrote the key" from
-- "matched the row".
--
-- Keyed by care_profile row id AND its (scope, scope_id) pair, guarded on the key being absent: a
-- re-run matches nothing, and a cold block written later by anyone is never clobbered. care_profile has
-- no app write route and no triggers (read on prod), so this file is the path, not a bypass of one.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE EMAIL DOES NOT MOVE. The only other reader of `cold` is handler.js's cadenceTenderFor, which can
-- only PROMOTE an UNBANDED crop type into the frost alert. Every crop type here is banded
-- (cobaea, thunbergia, torenia: chill_sensitive; nasturtium, helichrysum: tender; petunia:
-- light_frost_tolerant; spider_plant: tropical), so the alert classifies these plantings exactly as
-- before. This is a Today-card change only.
--
-- LANDING ORDER: none. No code change; no column added or removed. Prod runs v4.139.0 (main 6a630cdd,
-- 2026-09-19), whose lambda/daily-plan is byte-identical to this migration's base 10452156 (v4.138.0).
-- The build before it, v4.136.0, differed in two coldFor branches — the heated-location drop and the
-- in-ground drop — and neither can touch these 8 plantings (all potted, none in a heated location), so
-- the cards are the same under any of the three builds.
--
-- SAFETY: idempotent and non-clobbering. On a database without these rows every UPDATE matches zero
-- rows and only the stamp is written, the safe direction. That is the expected staging result: the rows
-- were written on prod on 2026-08-23 and the staging branch was cut from prod on 2026-08-11 (Neon API),
-- so staging cannot carry these row ids unless they were copied there since (not read: this lane was
-- cleared to read prod only). On PROD every UPDATE must print UPDATE 1: an UPDATE 0 there means the wrong
-- host or a changed row — stop and read the pre gates (a guarded UPDATE 0 reads like "already applied").
-- ROLLBACK: 0r-rollback.sql.

BEGIN;

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 40}'::jsonb, true),
       updated_at = now()
 WHERE id = '9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c'
   AND scope = 'cultivar' AND scope_id = '3db84405-1941-4e88-bb77-58595f47c3e7'   -- Cobaea scandens (Violet) -> Cobaea scandens (Violet)
   AND NOT (profile ? 'cold');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 35}'::jsonb, true),
       updated_at = now()
 WHERE id = '04554719-e633-44d7-8791-f3e33c90ed2d'
   AND scope = 'cultivar' AND scope_id = 'ba53f113-9903-449d-81b9-7dce30ef3934'   -- Easy Wave Berry Velour -> Easy Wave Berry Velour Petunia
   AND NOT (profile ? 'cold');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 32}'::jsonb, true),
       updated_at = now()
 WHERE id = '2d2bc039-58e4-4ce7-8930-e58a66c4cd5a'
   AND scope = 'cultivar' AND scope_id = 'd3101ac0-fd4e-456e-86b7-ebea732ac84c'   -- Jewel Mix Nasturtium -> Jewel Mix Nasturtium
   AND NOT (profile ? 'cold');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 35}'::jsonb, true),
       updated_at = now()
 WHERE id = '315a0e95-0469-4b88-9647-5662c0edc884'
   AND scope = 'cultivar' AND scope_id = 'f46745bf-c77e-4f42-b939-5363378a035e'   -- Petunia -> Petunia
   AND NOT (profile ? 'cold');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 40}'::jsonb, true),
       updated_at = now()
 WHERE id = '54187824-9ea7-4c5c-9fbf-da5f2326b84e'
   AND scope = 'cultivar' AND scope_id = '4379ae45-51ac-49f2-8205-aea13c3c64ad'   -- Silver (Licorice Plant) -> Silver Helichrysum
   AND NOT (profile ? 'cold');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 50}'::jsonb, true),
       updated_at = now()
 WHERE id = '241d3455-8961-4c8c-a7ab-4a73e84fc002'
   AND scope = 'cultivar' AND scope_id = 'ece82bf2-6a60-4186-b031-64af0519aa49'   -- Spider Plant -> Spider Plant
   AND NOT (profile ? 'cold');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 45}'::jsonb, true),
       updated_at = now()
 WHERE id = 'f9a3ca14-5a9e-4cd9-8294-babd6e90279f'
   AND scope = 'cultivar' AND scope_id = 'eb7e7347-26f2-42aa-b042-967511a31c0d'   -- Sunny Susy White Halo -> Sunny Susy White Halo Thunbergia
   AND NOT (profile ? 'cold');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 45}'::jsonb, true),
       updated_at = now()
 WHERE id = '19c81d1a-c313-4ae2-bc82-5069eee72fe6'
   AND scope = 'cultivar' AND scope_id = 'a3d41b0a-f79e-4301-b710-587b6d8544bf'   -- Wishbone Flower -> Wishbone Flower (Torenia)
   AND NOT (profile ? 'cold');

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-coldshadow-002',
        'COLDSHADOW-002: V5-COLDSHADOWCENSUS-001 (data-only, no DDL). Adds the `cold` key to eight cultivar '
        'care_profile rows written by cadence-backfill-20260823 without one — the potted plantings among the 19 '
        'whose bundled cadence-data-v2.json cold block their database profile shadowed whole: Cobaea, two '
        'petunias, Jewel Mix nasturtium, licorice plant, Spider Plant, thunbergia, torenia. Values copied from '
        'the bundled entry the census resolved. Single-key jsonb_set keyed by row id and guarded on the key '
        'being absent; every other key untouched. Dave decisions 2026-09-19 (card the potted ones; leave the '
        'coleus off). Reversible via 0r.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
