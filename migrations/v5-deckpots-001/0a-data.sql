-- DATA-FALLDECKPOTS-001 — the three fall pots on the Deck: decided watering, and the Millet rename.
--
-- DATA ONLY. No DDL, no view, no code, no deploy. Shape of v5-crabappleprofile-001: whole-object
-- replace of each cultivar-create placeholder, keyed by row id AND (scope, scope_id), guarded on the
-- md5 of the placeholder read on prod 2026-10-14 (d5335984e4af2339fe6ee7b4f4946436, the same bytes the
-- crabapple row held).
--
-- Dave's decisions, first-hand 2026-10-14 (AskUserQuestion, T1 session t1-stabilityreds-20261014,
-- recorded on the ledger row): the three cultivars water every 3 days, rain counts, _basis
-- dave_decision; rename Purple Majesty Miller to Purple Majesty Millet. Daisy and millet are not
-- harvested: that half is code (not_harvest_tracked lists), not this migration.
--
-- "Rain counts" needs no profile key. Rain credit is decided per planting from its location's cover
-- (handler.js `cov.state is false as rain_exposed_resolved`, engine.js rainClass) or the planting's
-- own rain_exposed override; no care_profile key on prod mentions rain (274 cultivar rows read
-- 2026-10-14). All three plantings sit on the Deck, covered = false, rain_exposed NULL, and the
-- autologger already wrote a rain event on each on 2026-10-13.
--
-- 3 days is the container interval all three resolve today (Chrysanthemum's bundled genus entry, the
-- default for the other two), so the watering cadence does not move. Feeding does not either: once the
-- engine adopts a database row it merges system || cultivar, and the system row's 14-day feed would
-- replace the Chrysanthemum genus entry's 28 (the v5-feedinherit-001 defect), so the chrysanthemum row
-- carries fertilize_interval_days 28 explicitly. Daisy and millet resolve 14 before and after. Card text
-- does change for the mums (crop label, water method, moisture hint come from this row, not the genus
-- entry); no alert changes. What changes is that the database holds Dave's decision instead of nobody's.
--
-- Each cultivar reaches exactly one live planting and none has a leaf-scope row (read 2026-10-14);
-- gates.yml holds both premises.
--
-- Reversible: 0r-rollback.sql.

BEGIN;

UPDATE public.care_profile
   SET profile = '{
         "crop": "chrysanthemum", "_tier": "T3", "confidence": "low",
         "_basis": "dave_decision", "_source": "v5-deckpots-001",
         "water_method": "drench_to_drainage", "drought_tolerance": "medium",
         "water_interval_days_container": 3, "fertilize_interval_days": 28,
         "notes": "Dave decision 2026-10-14: water every 3 days, rain counts. Nursery transplant in a plastic pot on the Deck. The older Chrysanthemum cultivar reads 5 days from his own log; he chose 3 for this one. Feed interval 28 is carried over from the bundled Chrysanthemum genus entry the planting uses today, so adopting this row does not move it to the house 14 (v5-feedinherit-001)."
       }'::jsonb,
       updated_at = now()
 WHERE id = '63463242-7d45-43cb-821a-55450f8320bd'
   AND scope = 'cultivar' AND scope_id = 'f1588cbd-0861-45ef-8c5a-42687839e218'   -- Garden Chrysanthemum
   AND md5(profile::text) = 'd5335984e4af2339fe6ee7b4f4946436';

UPDATE public.care_profile
   SET profile = '{
         "crop": "daisy", "_tier": "T3", "confidence": "low",
         "_basis": "dave_decision", "_source": "v5-deckpots-001",
         "water_method": "drench_to_drainage", "drought_tolerance": "medium",
         "water_interval_days_container": 3,
         "notes": "Dave decision 2026-10-14: water every 3 days, rain counts. No watering history and no sibling cultivar. Rudbeckia hirta in a plastic pot on the Deck."
       }'::jsonb,
       updated_at = now()
 WHERE id = '737964e9-f583-49af-bf1c-34058376e934'
   AND scope = 'cultivar' AND scope_id = '0f89c33f-8c9a-479f-8e80-aca9091b3622'   -- Prairie Sun
   AND md5(profile::text) = 'd5335984e4af2339fe6ee7b4f4946436';

UPDATE public.care_profile
   SET profile = '{
         "crop": "millet", "_tier": "T3", "confidence": "low",
         "_basis": "dave_decision", "_source": "v5-deckpots-001",
         "water_method": "drench_to_drainage", "drought_tolerance": "medium",
         "water_interval_days_container": 3,
         "notes": "Dave decision 2026-10-14: water every 3 days, rain counts. No watering history and no sibling cultivar. Annual Pennisetum glaucum in a plastic pot on the Deck."
       }'::jsonb,
       updated_at = now()
 WHERE id = 'f61237a4-1868-4cfe-9710-7916b42dcf77'
   AND scope = 'cultivar' AND scope_id = '7a61c3e5-b90a-4f32-a21f-ba08d7daa3d3'   -- Purple Majesty Miller
   AND md5(profile::text) = 'd5335984e4af2339fe6ee7b4f4946436';

-- The rename. By id, only while it still carries the typo. uq_plant_varieties_name_species is
-- (lower(name), coalesce(species,'')) over live rows; no live 'Purple Majesty Millet' exists (2026-10-14).
UPDATE public.plant_varieties
   SET name = 'Purple Majesty Millet',
       updated_at = now()
 WHERE id = '7a61c3e5-b90a-4f32-a21f-ba08d7daa3d3'
   AND name = 'Purple Majesty Miller'
   AND deleted_at IS NULL;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-deckpots-001',
        'DECKPOTS-001 (data-only, no DDL). Replaces the cultivar-create placeholder care profiles on '
        'Garden Chrysanthemum, Prairie Sun and Purple Majesty Millet with Dave''s decision (2026-10-14): '
        'water every 3 days in a container, rain counts, _basis dave_decision. Whole-object replace by '
        'row id, guarded on the placeholder md5. Renames Purple Majesty Miller to Purple Majesty Millet, '
        'guarded on the old name. Reversible via 0r.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
