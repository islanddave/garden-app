-- 0b-rename.sql
-- V4-CULTIVARNAME-001 step B — the data rename. Apply AFTER 0a and AFTER the daily-plan Lambda
-- carrying the widened cadence-data-v2.json is live in the target environment.
--
--   BUG-FLORADADESYNC-001   Floridade -> Floradade    (cultivar row already renamed; mirror stale)
--   BUG-CZECHBUSHID-001     Czech Bush Slicer -> Czech's Bush
--
-- ONE cultivar each. Renamed, not replaced — every id below is unchanged, and every foreign key
-- into plant_varieties / plants / entity is a uuid (21 FKs audited on prod 2026-08-04; the only
-- non-id FK in the area is plant_varieties.crop_type_slug -> crop_types.slug, untouched). No name
-- is a foreign key anywhere, so there is no referential hazard.
--
-- THERE IS, HOWEVER, ONE UNIQUENESS RULE ON A NAME — and it is easy to miss:
--     CREATE UNIQUE INDEX uq_plant_varieties_name_species ON public.plant_varieties
--       USING btree (lower(name), COALESCE(species,'')) WHERE (deleted_at IS NULL);
-- It is a bare UNIQUE INDEX with NO pg_constraint row, so `SELECT ... FROM pg_constraint` returns
-- clean for it no matter which contype you filter on. (Same trap as querying pg_constraint against
-- a VIEW: a clean result that means nothing.) Uniqueness must be checked in pg_indexes.
-- This is the ONE mechanism by which statement 1 can raise — a 23505 that aborts the whole
-- transaction. Verified clear on prod 2026-08-04: zero live rows collide with
-- (lower('Czech''s Bush'), 'lycopersicum'). Re-verified in the guard below at apply time rather
-- than trusted from this comment, because the check is cheap and the failure is loud but late.
--
-- WHY "Czech's Bush". The row's own provenance already told us: origin_region reads "Czechoslovakia;
-- sent to Ben Quisenberry (USA) by Milan Sodomka in 1976", which is verbatim the documented history
-- of the heirloom catalogued as Czech's Bush (tatianastomatobase.com/wiki/Czech's_Bush,
-- plantswithstories.com/tomatoes/czechs-bush). Determinate, ~70 days, 4-6 oz red — matching this
-- row's days_to_maturity 70-75 and expected_yield_notes "4 oz round red fruits". "Czech Bush Slicer"
-- is attested by no seed house, catalogue or reference. The apparent 10x fruit-size disagreement
-- that stopped this rename on 2026-08-03 cuts ACROSS both spellings, so it is not evidence of two
-- cultivars; it is a size dispute inside one.
--
-- WHY "Floradade". UF 1976 release, named for Flora + Dade County. The row's own care_notes and its
-- victoryseeds "flora-dade" source_url both already said so, and the nursery sign OCR reads
-- "Tomato - Floradade". Peer-reviewed literature uses Floradade exclusively.
--
-- FIRST-WRITE-WINS / IDEMPOTENT. Every statement is scoped by id AND asserts the expected pre-state
-- name. Re-running reports UPDATE 0 across the board. Running against a database that never held
-- these rows (staging, as of 2026-08-04) reports UPDATE 0 across the board and is a clean no-op —
-- see gates.yml gate `staging_is_a_no_op` for why that is expected and what it does and does not
-- prove.
--
-- ORDERING INSIDE THE TRANSACTION. plant_varieties first, then plants, then the mirror
-- reconciliation. The first two fire 0a's rename triggers, which sync three of the four entity
-- rows for free; statement 4 exists only because plant_varieties.name was ALREADY changed to
-- 'Floradade' out-of-band on 2026-08-04 17:34 UTC, so no UPDATE will ever fire the trigger for that
-- cultivar and its mirror row can only be repaired explicitly.
--
-- NOT TOUCHED, DELIBERATELY:
--   * audit_events.before_jsonb/after_jsonb (15 rows) — immutable history. The whole point of an
--     audit log is that it records what the value WAS.
--   * daily_plan.items (21 rows carrying 'Floridade', 29 carrying 'Czech Bush Slicer', measured on
--     prod 2026-08-04 — the spread matches when each planting was created, 06-29 and 06-12
--     respectively, against a plan history starting 06-20) — per-day
--     generated snapshots, not source data. Past days are history; the CURRENT day is refreshed by
--     re-invoking the daily-plan Lambda after this migration (scripts/rerun-daily-plan.sh), which
--     regenerates from live names instead of hand-editing jsonb. Editing a generated artifact in
--     place would make it disagree with what the generator would now produce.
--   * ctas_20260803_plant_varieties_{cs001,refw,slicec}, ctas_20260730_plants_cal8 — pre-change
--     CTAS snapshots. They exist to hold the old values. Rewriting a backup defeats it.
--   * created_by on any table. prevent_ownership_transfer() guards 9 tables (event_log,
--     inventory_items, locations, photos, plant_projects, plants, spaces, spacetheme, tasks) and
--     treats NULL->value as a transfer. plants is among them; this migration writes only `name`,
--     so the trigger is never provoked and must NOT be disabled.

BEGIN;

-- 0. Pre-flight: prove the target name does not collide under uq_plant_varieties_name_species
--    BEFORE attempting the write, so the operator gets a sentence instead of a bare 23505.
DO $$
DECLARE conflict_id uuid;
BEGIN
  SELECT id INTO conflict_id
    FROM public.plant_varieties
   WHERE deleted_at IS NULL
     AND id <> 'b2be3698-b782-4a6b-8879-435effc9fcce'
     AND lower(name) = lower('Czech''s Bush')
     AND COALESCE(species,'') = COALESCE(
           (SELECT species FROM public.plant_varieties WHERE id='b2be3698-b782-4a6b-8879-435effc9fcce'), '');
  IF conflict_id IS NOT NULL THEN
    RAISE EXCEPTION 'pre-flight: renaming to "Czech''s Bush" would violate uq_plant_varieties_name_species — live row % already holds that (lower(name), species). Resolve the duplicate before applying.', conflict_id;
  END IF;
END $$;

-- 1. cultivar (base table; `cultivar` is a VIEW over this). Fires plant_varieties_entity_rename,
--    which syncs entity f0f36069-0115-451c-9869-d01ec0323c53. Expect: UPDATE 1.
UPDATE public.plant_varieties
   SET name = 'Czech''s Bush', updated_at = now()
 WHERE id = 'b2be3698-b782-4a6b-8879-435effc9fcce'
   AND name = 'Czech Bush Slicer'
   AND deleted_at IS NULL;

-- 2. planting (base table; `garden_node` is a VIEW over this). Fires plants_entity_rename, which
--    syncs entity 88a08b2f-8659-41e8-a622-0c6fcb807b94. Expect: UPDATE 1.
UPDATE public.plants
   SET name = 'Czech''s Bush'
 WHERE id = 'ee3fd4c5-5fa3-4202-8044-2c2d19e4835e'
   AND name = 'Czech Bush Slicer'
   AND deleted_at IS NULL;

-- 3. planting. Fires plants_entity_rename, which syncs entity
--    07881250-f942-4ffe-8be7-278c168d7c7e. Expect: UPDATE 1.
UPDATE public.plants
   SET name = 'Floradade'
 WHERE id = '9274e985-1cfe-4470-ab5a-424f3e6bdcd2'
   AND name = 'Floridade'
   AND deleted_at IS NULL;

-- 4. The one row no trigger can reach. plant_varieties.name for this cultivar was set to
--    'Floradade' on 2026-08-04 17:34:27 UTC, before any sync trigger existed, so there is no future
--    UPDATE to fire on. Repaired explicitly, scoped to this entity row, and derived from the source
--    of truth rather than from a literal so it cannot reintroduce a third spelling. Expect: UPDATE 1.
UPDATE public.entity e
   SET display_name = COALESCE(NULLIF(btrim(pv.name),''),'(cultivar)')
  FROM public.plant_varieties pv
 WHERE e.id = '52ea7182-1c45-4f76-97ae-10fd1c73c57f'
   AND e.entity_type = 'cultivar'
   AND e.cultivar_ref_id = pv.id
   AND pv.id = '7b355b73-391c-4cdd-b040-f1cd87a447d5'
   AND e.deleted_at IS NULL
   AND e.display_name IS DISTINCT FROM COALESCE(NULLIF(btrim(pv.name),''),'(cultivar)');

INSERT INTO public.schema_version (version, description)
VALUES ('4.21.3-cultivarname-001-rename',
        'V4-CULTIVARNAME-001: rename tomato cultivar b2be3698 "Czech Bush Slicer" -> "Czech''s Bush" (BUG-CZECHBUSHID-001) and propagate the earlier 7b355b73 "Floridade" -> "Floradade" cultivar rename to plants.name and entity.display_name (BUG-FLORADADESYNC-001). 4 statements, 4 rows, ids unchanged. Companion repo change widens lambda/daily-plan/cadence-data-v2.json by_variety with the new key BEFORE this runs.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
