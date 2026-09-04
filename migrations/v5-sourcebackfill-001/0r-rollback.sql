-- 0r-rollback.sql
-- V5-SOURCEBACKFILL-001 — back to substrate-only.
--
-- THIS ROLLBACK IS CHEAP, AND THAT IS THE WHOLE REASON THE BACKFILL COULD SHIP WITH FIVE
-- MEDIUM-CONFIDENCE CATEGORY LABELS. 0b never writes plants.source_ref or inventory_items.source —
-- it only READS them as a join key — so undoing it is nulling four columns and deleting rows nobody
-- has touched. No provenance is destroyed in either direction.
--
-- IT REFUSES ONCE HUMANS ARE USING IT. Two conditions, checked before anything is written: a source
-- row created by someone other than 'system', or a parent row pointing at a source that this
-- backfill did not create. Either means the picker is live and people have made choices, at which
-- point a blanket revert would delete their work — and a rollback that silently eats a user's edits
-- is worse than no rollback.
--
-- Usage: psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

DO $$
DECLARE
  v_human_sources int;
  v_human_pointers int;
BEGIN
  SELECT count(*) INTO v_human_sources
    FROM public.source WHERE created_by <> 'system';

  SELECT count(*) INTO v_human_pointers
    FROM (
      SELECT p.source_id AS sid FROM public.plants p WHERE p.source_id IS NOT NULL
      UNION ALL
      SELECT p.acquired_from_source_id FROM public.plants p WHERE p.acquired_from_source_id IS NOT NULL
      UNION ALL
      SELECT i.source_id FROM public.inventory_items i WHERE i.source_id IS NOT NULL
      UNION ALL
      SELECT i.acquired_from_source_id FROM public.inventory_items i
       WHERE i.acquired_from_source_id IS NOT NULL
    ) x
    JOIN public.source s ON s.id = x.sid
   WHERE s.created_by <> 'system';

  IF v_human_sources > 0 OR v_human_pointers > 0 THEN
    RAISE EXCEPTION
      'REFUSING to roll back V5-SOURCEBACKFILL-001: % source row(s) were created by a person and % '
      'parent row(s) point at one. Reverting would delete work done through the app. Undo the '
      'specific rows you mean, or leave this migration in place.',
      v_human_sources, v_human_pointers;
  END IF;
END
$$;

-- Order matters: drop the pointers before the rows they reference, or the FK's NO ACTION raises.
UPDATE public.plants
   SET source_id = NULL, acquired_from_source_id = NULL
 WHERE source_id IS NOT NULL OR acquired_from_source_id IS NOT NULL;

UPDATE public.inventory_items
   SET source_id = NULL, acquired_from_source_id = NULL
 WHERE source_id IS NOT NULL OR acquired_from_source_id IS NOT NULL;

-- Hard delete, NOT a soft delete, and this is the one place in the source design where that is
-- right. Soft-deleting would leave 53 tombstones whose match_keys still occupy the live unique
-- index's shadow and whose names would reappear in any admin view of deleted rows — for a
-- catalogue that, after this file runs, never legitimately existed. The Soft-Delete-Only Rule's
-- carve-out for regenerable data applies exactly: every row here is reproducible byte-for-byte by
-- re-running 0b from the same reviewed CSVs.
DELETE FROM public.source WHERE created_by = 'system';

DELETE FROM public.schema_version WHERE version = '5.0.0-sourcebackfill-001';

COMMIT;
