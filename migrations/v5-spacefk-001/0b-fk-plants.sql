-- 0b-fk-plants.sql
-- V5-SPACETENANCYKEY-001 (multi-space Phase 1, step 1.8, first table): plants.workspace_id -> spaces(id)
--   ON DELETE RESTRICT, NOT VALID. Stamp 5.1.5-spacefk-001-fk-plants.
--
-- WHY. A planting's Space is plants.workspace_id (the daily plan inner-joins spaces on it). Nothing makes
--   that value name a Space today (Phase 0 read 5: no workspace_id column has a foreign key). From here
--   every INSERT, and every UPDATE that changes the key, is checked. 0d validates the existing rows.
--
-- RESTRICT, NOT CASCADE (P12). CASCADE reds v4-cascadesweep-001 post_no_cascade_onto_a_soft_deletable_table
--   (plants carries deleted_at); SET NULL / SET DEFAULT can red v4-evtanchordel-001
--   post_no_setnull_fk_inside_an_anchor_check. RESTRICT: deleting a Space that still has plantings is
--   refused with 23503. No deployed code deletes a Space.
--
-- THE GUARD (first statement after BEGIN) refuses, changing nothing, unless:
--   1. 0a's stamp 5.1.5-spacefk-001-fold exists (fold first: no row the key would reject exists when the
--      key appears, so no deployed write meets a 23503 on an unchanged invalid key; review DSA I1);
--   2. public.spaces carries trigger spaces_truncate_guard, BEFORE TRUNCATE, enabled 'O' (M1, step 1.3b).
--      With this key in place `TRUNCATE spaces CASCADE` reaches plants and everything that references
--      plants, whatever the ON DELETE action; the guard is then the only stop (review DSA I6);
--   3. no plants or plant_projects row carries the nil workspace;
--   4. no plants row names a workspace that is not a Space (the sweep 0d repeats before VALIDATE).
--
-- THE DEPLOYED CODE (the house test: would the currently deployed code write a row this rejects?). NO.
--   No code writes plants.workspace_id: git grep at 51a97146 finds no INSERT or UPDATE naming it; inserts
--   take the column DEFAULT ...0001, which is the one Space (lambda/plants/index.js INSERT INTO
--   public.garden_node names no workspace_id). lambda/container-workspace-census.test.js pins that set.
--
-- IDEMPOTENT. The key is added only when absent; an existing key of this name must already have exactly
--   this shape (single column, -> spaces(id), RESTRICT), or the file refuses. The stamp ON CONFLICT DO
--   NOTHING.
-- LOCKS. ADD FOREIGN KEY ... NOT VALID takes SHARE ROW EXCLUSIVE on plants and on spaces, held to COMMIT:
--   writes to either wait for milliseconds, reads do not wait. No row scan (NOT VALID). lock_timeout 5s.
--   Never apply at :55-:05 (the hourly daily-plan run).
--
-- ROLLBACK: 0r-rollback.sql (the whole directory, in reverse).
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0b-fk-plants.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The guard. ──────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.1.5-spacefk-001-fold') THEN
    RAISE EXCEPTION 'v5-spacefk-001 0b refused, nothing changed: 0a-fold.sql has not been applied (no stamp 5.1.5-spacefk-001-fold).';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'spaces'
          AND t.tgname = 'spaces_truncate_guard' AND NOT t.tgisinternal
          AND t.tgenabled = 'O'
          AND (t.tgtype & 2) <> 0     -- BEFORE
          AND (t.tgtype & 32) <> 0) THEN  -- TRUNCATE
    RAISE EXCEPTION 'v5-spacefk-001 0b refused, nothing changed: public.spaces has no enabled BEFORE TRUNCATE trigger spaces_truncate_guard.'
      USING HINT = 'Apply v5-spaceguard-001 (M1) first. With this key, TRUNCATE spaces CASCADE would reach plants and everything that references them.';
  END IF;

  SELECT string_agg(x.t || ' ' || x.id::text, ', ' ORDER BY x.t, x.id) INTO v_bad
    FROM (SELECT 'plant_projects' AS t, p.id FROM public.plant_projects p
           WHERE p.workspace_id = '00000000-0000-0000-0000-000000000000'
          UNION ALL
          SELECT 'plants', g.id FROM public.plants g
           WHERE g.workspace_id = '00000000-0000-0000-0000-000000000000') x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spacefk-001 0b refused, nothing changed: nil-workspace row(s) remain: %', v_bad;
  END IF;

  SELECT string_agg(g.id::text || ' (' || g.workspace_id::text || ')', ', ' ORDER BY g.id) INTO v_bad
    FROM public.plants g
   WHERE NOT EXISTS (SELECT 1 FROM public.spaces s WHERE s.id = g.workspace_id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spacefk-001 0b refused, nothing changed: plants row(s) name no Space: %', v_bad;
  END IF;
END $$;

-- ── 1. The key, once. ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_ok boolean;
BEGIN
  SELECT (c.contype = 'f' AND c.confdeltype = 'r'
          AND f.relname = 'spaces' AND fn.nspname = 'public'
          AND array_length(c.conkey, 1) = 1 AND array_length(c.confkey, 1) = 1
          AND a.attname = 'workspace_id' AND fa.attname = 'id')
    INTO v_ok
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace rn ON rn.oid = r.relnamespace
    LEFT JOIN pg_class f ON f.oid = c.confrelid
    LEFT JOIN pg_namespace fn ON fn.oid = f.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    LEFT JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[1]
   WHERE rn.nspname = 'public' AND r.relname = 'plants' AND c.conname = 'plants_workspace_id_fkey';

  IF v_ok IS NULL THEN
    ALTER TABLE public.plants
      ADD CONSTRAINT plants_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.spaces(id) ON DELETE RESTRICT NOT VALID;
  ELSIF NOT v_ok THEN
    RAISE EXCEPTION 'v5-spacefk-001 0b refused, nothing changed: a constraint plants_workspace_id_fkey exists with a different shape.'
      USING HINT = 'Read it with pg_get_constraintdef and find what created it; do not edit this guard.';
  END IF;
END $$;

COMMENT ON CONSTRAINT plants_workspace_id_fkey ON public.plants IS
  'V5-SPACETENANCYKEY-001 (v5-spacefk-001 0b). A planting''s Space must be a row in public.spaces. RESTRICT: a Space with plantings cannot be deleted. Validated by 0d.';

-- ── 2. The stamp. ──────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.1.5-spacefk-001-fk-plants',
        'SPACEFK fk-plants: V5-SPACETENANCYKEY-001 (multi-space Phase 1 step 1.8). FOREIGN KEY '
        'plants_workspace_id_fkey plants.workspace_id -> spaces(id) ON DELETE RESTRICT NOT VALID. Refuses '
        'unless the fold stamp exists, spaces_truncate_guard is enabled, and no plants row names no Space. '
        'Validated by -validate.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
