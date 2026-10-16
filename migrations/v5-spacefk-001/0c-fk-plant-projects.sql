-- 0c-fk-plant-projects.sql
-- V5-SPACETENANCYKEY-001 (multi-space Phase 1, step 1.8, second table): plant_projects.workspace_id ->
--   spaces(id) ON DELETE RESTRICT, NOT VALID. Stamp 5.1.5-spacefk-001-fk-projects.
--
-- WHY. A container's Space is plant_projects.workspace_id. The reparent path copies it into
--   reparent_event (lambda/projects/index.js reparentCore) and the rain cap reads it for a container-level
--   rain row (lambda/daily-plan/handler.js, the once-a-day cap). Until 0a, ten containers carried the nil
--   id, which names no Space. From here every INSERT, and every UPDATE that changes the key, is checked.
--
-- One table per transaction (0b did plants), so each holds its locks for one ALTER only. Everything else
--   is 0b's, word for word: the same four-part guard, RESTRICT for the same two gates, the same
--   deployed-code answer (no code writes plant_projects.workspace_id; lambda/projects/index.js INSERT INTO
--   public.container names no workspace_id and takes the DEFAULT), the same idempotency.
-- LOCKS. SHARE ROW EXCLUSIVE on plant_projects and on spaces, held to COMMIT; no row scan. lock_timeout 5s.
--   Never apply at :55-:05 (the hourly daily-plan run).
--
-- ROLLBACK: 0r-rollback.sql (the whole directory, in reverse).
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0c-fk-plant-projects.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The guard. ──────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.1.5-spacefk-001-fold') THEN
    RAISE EXCEPTION 'v5-spacefk-001 0c refused, nothing changed: 0a-fold.sql has not been applied (no stamp 5.1.5-spacefk-001-fold).';
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
    RAISE EXCEPTION 'v5-spacefk-001 0c refused, nothing changed: public.spaces has no enabled BEFORE TRUNCATE trigger spaces_truncate_guard.'
      USING HINT = 'Apply v5-spaceguard-001 (M1) first. With this key, TRUNCATE spaces CASCADE would reach plant_projects and everything that references them.';
  END IF;

  SELECT string_agg(x.t || ' ' || x.id::text, ', ' ORDER BY x.t, x.id) INTO v_bad
    FROM (SELECT 'plant_projects' AS t, p.id FROM public.plant_projects p
           WHERE p.workspace_id = '00000000-0000-0000-0000-000000000000'
          UNION ALL
          SELECT 'plants', g.id FROM public.plants g
           WHERE g.workspace_id = '00000000-0000-0000-0000-000000000000') x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spacefk-001 0c refused, nothing changed: nil-workspace row(s) remain: %', v_bad;
  END IF;

  SELECT string_agg(p.id::text || ' (' || p.workspace_id::text || ')', ', ' ORDER BY p.id) INTO v_bad
    FROM public.plant_projects p
   WHERE NOT EXISTS (SELECT 1 FROM public.spaces s WHERE s.id = p.workspace_id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spacefk-001 0c refused, nothing changed: plant_projects row(s) name no Space: %', v_bad;
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
   WHERE rn.nspname = 'public' AND r.relname = 'plant_projects' AND c.conname = 'plant_projects_workspace_id_fkey';

  IF v_ok IS NULL THEN
    ALTER TABLE public.plant_projects
      ADD CONSTRAINT plant_projects_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.spaces(id) ON DELETE RESTRICT NOT VALID;
  ELSIF NOT v_ok THEN
    RAISE EXCEPTION 'v5-spacefk-001 0c refused, nothing changed: a constraint plant_projects_workspace_id_fkey exists with a different shape.'
      USING HINT = 'Read it with pg_get_constraintdef and find what created it; do not edit this guard.';
  END IF;
END $$;

COMMENT ON CONSTRAINT plant_projects_workspace_id_fkey ON public.plant_projects IS
  'V5-SPACETENANCYKEY-001 (v5-spacefk-001 0c). A container''s Space must be a row in public.spaces. RESTRICT: a Space with containers cannot be deleted. Validated by 0d.';

-- ── 2. The stamp. ──────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.1.5-spacefk-001-fk-projects',
        'SPACEFK fk-projects: V5-SPACETENANCYKEY-001 (multi-space Phase 1 step 1.8). FOREIGN KEY '
        'plant_projects_workspace_id_fkey plant_projects.workspace_id -> spaces(id) ON DELETE RESTRICT NOT '
        'VALID. Refuses unless the fold stamp exists, spaces_truncate_guard is enabled, and no '
        'plant_projects row names no Space. Validated by -validate.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
