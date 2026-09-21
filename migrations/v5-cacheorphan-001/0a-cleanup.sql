-- 0a-cleanup.sql
-- v5-cacheorphan-001 — BUG-CACHEORPHANREGRESS-001: delete the 7 care-cache (entity_memory) rows that belong
-- to soft-deleted plantings. They are the +7 in the Monday integrity alert's entity_memory_orphans, which has
-- read 11 against a baseline of 4 since the 2026-08-31 run. Data-only: no DDL on an app table (the snap_ table
-- is this migration's BEFORE copy, the house pattern for a cache repair).
--
-- NOT APPLIED as of authoring (2026-09-21, lane cacheorphan). Rehearsed on an ephemeral fork of prod
-- (README.md).
--
-- APPLY ORDER (README.md): only after the daily-plan fix that ships with this directory is LIVE on the prod
-- garden-daily-plan Lambda (lambda/daily-plan/handler.js logRainEvents: both cache upserts join their parent
-- and skip a soft-deleted one). Applied before that, the next rain night's old upsert writes all 7 back under
-- new ids, post_no_cache_row_on_soft_deleted_planting goes red and the alert returns.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0a-cleanup.sql
--
-- ─── WHY THESE ROWS EXIST ───────────────────────────────────────────────────────────────────────────
-- migrations/v4-rainbackfill-001/0c-cachearms.sql (applied 2026-08-28) upserted a plant-keyed row for every
-- planting with a live watering or rain event, and never checked that the planting was live. A soft-deleted
-- planting keeps its events (the Deleted-Planting History Rule), so each of the 7 soft-deleted plantings that
-- had ever been watered got a row, all in one transaction (2026-08-28T13:17:38.504170+00:00). Curly Parsley's
-- row had been cleaned on 2026-08-14 (scripts/integrity-baselines.json) and came back. The nightly rain-night
-- upsert in lambda/daily-plan/handler.js had the same gap and rewrote all 7 on every rain night since. No
-- read path uses them: the rollups and the by-id read both drop a soft-deleted planting.
--
-- ─── WHY A HARD DELETE IS ALLOWED ──────────────────────────────────────────────────────────────────
-- entity_memory is a cache derived from event_log, which is the Soft-Delete-Only Rule's derived-data
-- carve-out; the Deleted-Planting History Rule says the same ("the care cache IS taken by the planting's
-- soft-delete"), and lambda/plants/index.js deletes the row in the same statement as the soft-delete. No
-- event is touched: a soft-deleted planting keeps its history.
--
-- ─── THE ROWS (read on prod 2026-09-21: every planting soft-deleted, none archived) ─────────────────
--   entity_memory id                      planting             plants.id                             deleted
--   45bbd419-d153-4c56-aa94-a16c11f6002b  Plum                 6e0e8cc0-0282-4fe0-9938-3fe21551bede  2026-05-28
--   40c4fec4-db50-43ae-bf5f-e0b4fdf5f2d1  Red Leaf (Regrown)   53c74573-be0a-432d-8c19-f0f10af525ba  2026-06-23
--   9d1f2750-1af9-43ba-8143-0c0aeb41a384  Jalapeño Orange      da969f5d-e18b-4f4e-b23a-e227269c7c74  2026-06-24
--   b1ba32dc-3997-4eb7-9a95-616b6f4d9031  Crown of Thorns      f7cc1e5c-6a71-4a57-8969-5148da48adb1  2026-06-30
--   05a13854-80fa-4d71-80c8-df67b568aad7  Vietnamese Coriander 6def5dc1-e0df-446c-8cb7-d45f8a14ec53  2026-06-30
--   ca39cf2a-bd0b-49d0-bfc9-61b40bcf19f1  Dracaena             b0a61907-5e6d-4135-ad4a-e204f8c780d1  2026-07-09
--   0478b377-b3ff-448a-a2d5-b2bf0243a24b  Curly Parsley        845b0dcf-e480-4da5-bb13-e0ac7550f029  2026-08-07
--
-- ─── GUARDS ─────────────────────────────────────────────────────────────────────────────────────────
--   * A second apply is refused (the stamp), and so is a leftover BEFORE copy (CREATE TABLE fails).
--   * Each row is deleted by its id AND the planting id read at authoring AND that planting still being
--     soft-deleted, so a row that was re-keyed, or whose planting was restored, is not touched.
--   * All or nothing. If a listed row survives the DELETE (its planting was restored, or it was re-keyed), or
--     the DELETE removed neither all 7 nor none, the transaction aborts and nothing is deleted. "None" is the
--     staging case: the rows were created on prod after the staging branch was cut, so there only the stamp
--     lands.
--   * The BEFORE copy is written by the DELETE's own RETURNING, in the same statement: it is exactly what was
--     removed, every column. 0r restores from it.
--
-- NOT TOUCHED: the 4 project-keyed rows (Chilis, Build Out, Basil, Smoke Child 2) that make up the alert's
-- accepted baseline of 4; removing them is a separate decision (README.md). No event, no planting.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-cacheorphan-001') THEN
    RAISE EXCEPTION 'v5-cacheorphan-001 is already applied (its schema_version row exists); nothing was changed';
  END IF;
END $$;

CREATE TEMP TABLE cacheorphan001_target (id uuid PRIMARY KEY, plant_id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO cacheorphan001_target (id, plant_id) VALUES
  ('45bbd419-d153-4c56-aa94-a16c11f6002b'::uuid, '6e0e8cc0-0282-4fe0-9938-3fe21551bede'::uuid), -- Plum
  ('40c4fec4-db50-43ae-bf5f-e0b4fdf5f2d1'::uuid, '53c74573-be0a-432d-8c19-f0f10af525ba'::uuid), -- Red Leaf (Regrown)
  ('9d1f2750-1af9-43ba-8143-0c0aeb41a384'::uuid, 'da969f5d-e18b-4f4e-b23a-e227269c7c74'::uuid), -- Jalapeño Orange
  ('b1ba32dc-3997-4eb7-9a95-616b6f4d9031'::uuid, 'f7cc1e5c-6a71-4a57-8969-5148da48adb1'::uuid), -- Crown of Thorns
  ('05a13854-80fa-4d71-80c8-df67b568aad7'::uuid, '6def5dc1-e0df-446c-8cb7-d45f8a14ec53'::uuid), -- Vietnamese Coriander
  ('ca39cf2a-bd0b-49d0-bfc9-61b40bcf19f1'::uuid, 'b0a61907-5e6d-4135-ad4a-e204f8c780d1'::uuid), -- Dracaena
  ('0478b377-b3ff-448a-a2d5-b2bf0243a24b'::uuid, '845b0dcf-e480-4da5-bb13-e0ac7550f029'::uuid); -- Curly Parsley

-- The BEFORE copy: entity_memory's columns, in order. Written only by the DELETE below.
CREATE TABLE public.snap_cacheorphan001_entity_memory (LIKE public.entity_memory);

WITH gone AS (
  DELETE FROM public.entity_memory em
   USING cacheorphan001_target t, public.plants p
   WHERE em.id = t.id
     AND em.plant_id = t.plant_id
     AND p.id = em.plant_id
     AND p.deleted_at IS NOT NULL
  RETURNING em.*
)
INSERT INTO public.snap_cacheorphan001_entity_memory
SELECT * FROM gone;

DO $$
DECLARE
  n_deleted int;
  n_left    int;
BEGIN
  SELECT count(*) INTO n_deleted FROM public.snap_cacheorphan001_entity_memory;
  SELECT count(*) INTO n_left
    FROM public.entity_memory em JOIN cacheorphan001_target t ON t.id = em.id;
  IF n_left <> 0 THEN
    RAISE EXCEPTION 'v5-cacheorphan-001: % listed row(s) survived the delete (the planting is no longer soft-deleted, or the row was re-keyed); nothing was deleted', n_left;
  END IF;
  IF n_deleted NOT IN (0, 7) THEN
    RAISE EXCEPTION 'v5-cacheorphan-001: the delete removed % of the 7 listed rows, expected all 7 (prod) or none (a branch that never had them); nothing was deleted', n_deleted;
  END IF;
  RAISE NOTICE 'v5-cacheorphan-001: deleted % row(s); BEFORE copy in public.snap_cacheorphan001_entity_memory', n_deleted;
END $$;

\echo '=== deleted (the BEFORE copy) ==='
SELECT s.id, s.plant_id, p.name AS planting, p.deleted_at AS planting_deleted_at,
       s.last_event_at, s.last_watered_at, s.updated_at
  FROM public.snap_cacheorphan001_entity_memory s
  JOIN public.plants p ON p.id = s.plant_id
 ORDER BY p.deleted_at;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-cacheorphan-001',
        'CACHEORPHAN-001: BUG-CACHEORPHANREGRESS-001 (data-only; BEFORE copy in snap_cacheorphan001_entity_memory). '
        'Deletes the 7 plant-keyed entity_memory rows on soft-deleted plantings that '
        'v4-rainbackfill-001/0c-cachearms.sql created on 2026-08-28 and the nightly rain-night cache upsert kept '
        'rewriting (the +7 in the weekly entity_memory_orphans alert, 4 -> 11). By row id, guarded on each '
        'planting still being soft-deleted, all or nothing. Cache rows fall under the Soft-Delete-Only Rule''s '
        'derived-data carve-out; no event touched. Applied only after the daily-plan live-parent cache upserts '
        'are on prod. Reversible via 0r.',
        now());

COMMIT;
