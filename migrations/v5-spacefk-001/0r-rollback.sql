-- 0r-rollback.sql: v5-spacefk-001 rollback, the whole directory in reverse (0d -> 0c -> 0b -> 0a).
--   1. Drop plant_projects_workspace_id_fkey and plants_workspace_id_fkey (undoes 0d's validation with
--      them, then 0c, then 0b). This MUST come first: once either key exists, putting the nil id back on a
--      container changes the key, is checked, and raises 23503 (review DSA I2). There is no per-file 0r.
--   2. Restore workspace_id on the ten pinned containers from public.ctas_spacefold001_plant_projects,
--      by id, only where the row still carries what 0a gave it (...0001). All or nothing: a copied row
--      that is gone or carries anything else is listed and the whole file aborts, changing nothing. Then
--      drop the copy. On a database where 0a folded nothing (staging) there is no copy and no restore.
--   3. Delete the four stamps. Every gate in gates.yml disarms with them.
--
-- ONLY workspace_id goes back. version moves forward again (container_bump) and updated_at is set again
--   (set_updated_at): the row was written twice. A page loaded between 0a and this file gets one more
--   409 on its next move of one of the ten (README.md).
--
-- ORDER ACROSS PHASE 1 (README.md): M3 -> M2 (this) -> M1. M1's 0r refuses while either key exists,
--   because spaces_truncate_guard is the only stop on TRUNCATE spaces CASCADE while they do.
--
-- LOCKS. Dropping a foreign key takes ACCESS EXCLUSIVE on its table AND on public.spaces (its RI
--   triggers live there), held to COMMIT. So this file waits behind any open transaction on plants,
--   plant_projects or spaces, a reader's included, and reads of those tables wait the milliseconds to
--   COMMIT behind it. lock_timeout 5s: on a busy moment it fails (55P03) having changed nothing. Run it
--   again, outside the hourly :00 run.
--
-- A re-run after a successful rollback finds no key, no copy and no stamp, and is a no-op.
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
SELECT set_config('app.actor_clerk_sub', 'migration:v5-spacefk-001:rollback', true) AS actor;

CREATE TEMP TABLE spacefold001_pinned (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO spacefold001_pinned (id) VALUES
  ('5ddfb9ab-0261-40f8-9528-e8c0cf5861f6'),  -- Christmas Cactus
  ('a377adc6-6d83-4bf1-a19e-c533be0b938e'),  -- Dracaena
  ('49be2767-0e6d-4bab-ba71-12ee293c5d0f'),  -- Echeveria
  ('abc3a67a-7612-4224-96d6-2d0dfea20a7a'),  -- Echeveria 'Perle von Nurnberg'
  ('a03bd522-3c81-4ecf-bfb8-f4832f7794e0'),  -- Golden Sedum
  ('8c94878e-0689-4ea4-9c6e-ebb859e4ecc2'),  -- Gymnocalycium mihanovichii
  ('6cc82240-35ca-495d-a050-0481a0e7b5c4'),  -- Haworthia / Gasteria (assorted)
  ('5cd427cf-2e90-46f9-98bb-7dcebd4e64cc'),  -- Jade Plant
  ('a08de1c6-da94-445b-85e7-f20c4a967ce2'),  -- Japanese Maple
  ('10ff66bb-1343-4316-88fd-2b3dec325628');  -- Lithops (archived)

-- ── 1. The keys (0d, 0c, 0b). ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.plant_projects DROP CONSTRAINT IF EXISTS plant_projects_workspace_id_fkey;
ALTER TABLE public.plants DROP CONSTRAINT IF EXISTS plants_workspace_id_fkey;

-- ── 2. The fold (0a). ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_copy     int;
  v_restored int;
  v_bad      text;
BEGIN
  IF to_regclass('public.ctas_spacefold001_plant_projects') IS NULL THEN
    RAISE NOTICE 'v5-spacefk-001 0r: no BEFORE copy on this database (0a folded nothing here); no row restored';
    RETURN;
  END IF;

  PERFORM 1 FROM public.plant_projects p JOIN spacefold001_pinned k ON k.id = p.id FOR UPDATE OF p;

  -- EXECUTE, so a database without the copy never parses a statement that names it.
  EXECUTE 'SELECT count(*), string_agg(s.id::text || '' ('' || coalesce(p.workspace_id::text, ''row gone'') || '')'', '', '' ORDER BY s.id) '
          '        FILTER (WHERE p.id IS NULL OR p.workspace_id IS DISTINCT FROM ''00000000-0000-0000-0000-000000000001'') '
          '  FROM public.ctas_spacefold001_plant_projects s '
          '  JOIN spacefold001_pinned k ON k.id = s.id '
          '  LEFT JOIN public.plant_projects p ON p.id = s.id'
     INTO v_copy, v_bad;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spacefk-001 0r refused, nothing restored: copied container(s) not as 0a left them: %', v_bad;
  END IF;

  EXECUTE 'UPDATE public.plant_projects p SET workspace_id = s.workspace_id '
          '  FROM public.ctas_spacefold001_plant_projects s JOIN spacefold001_pinned k ON k.id = s.id '
          ' WHERE p.id = s.id AND p.workspace_id = ''00000000-0000-0000-0000-000000000001''';
  GET DIAGNOSTICS v_restored = ROW_COUNT;
  IF v_restored <> v_copy THEN
    RAISE EXCEPTION 'v5-spacefk-001 0r: % row(s) in the copy, % restored; nothing restored', v_copy, v_restored;
  END IF;

  DROP TABLE public.ctas_spacefold001_plant_projects;
  RAISE NOTICE 'v5-spacefk-001 0r: restored workspace_id on % container(s) from the BEFORE copy and dropped it', v_restored;
END $$;

-- ── 3. The stamps. ─────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version
 WHERE version IN ('5.1.5-spacefk-001-validate', '5.1.5-spacefk-001-fk-projects',
                   '5.1.5-spacefk-001-fk-plants', '5.1.5-spacefk-001-fold');

COMMIT;
