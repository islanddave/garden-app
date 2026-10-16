-- 0d-validate.sql
-- V5-SPACETENANCYKEY-001 (multi-space Phase 1, step 1.10): VALIDATE both workspace keys after the
--   all-row sweep. Stamp 5.1.5-spacefk-001-validate.
--
-- THE SWEEP (Migration Authoring Rule, L-058): every row, no deleted_at filter. A foreign key does not
--   know what a soft delete is, and VALIDATE trips on a soft-deleted row exactly as on a live one:
--     SELECT count(*) FROM plants p WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = p.workspace_id)
--     SELECT count(*) FROM plant_projects p WHERE NOT EXISTS (... s.id = p.workspace_id)
--   both 0, or the file refuses and names the rows. After 0a both are 0 on prod (the ten folded; read 6:
--   every other row is ...0001) and on staging (no nil row ever).
--
-- WHY VALIDATE IS POST-DEPLOY-SAFE. The falsifiable test: would the deployed code write a row that
--   violates the key? No code writes either column (0b, 0c headers; the census test pins it), and the
--   DEFAULT is the one Space. VALIDATE changes nothing for writes that 0b/0c did not already check; it
--   proves the old rows, so gates.yml can assert convalidated.
--
-- The event-copy census (merge_event, reparent_event and the five other workspace_id tables) is a gate,
--   not a key, in Phase 1: gates.yml post_workspace_census_every_row_names_a_space, armed on this stamp.
--
-- IDEMPOTENT. VALIDATE of a validated key is a no-op; the stamp ON CONFLICT DO NOTHING.
-- LOCKS. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on the table it validates (reads and writes of
--   plants / plant_projects go on) and ROW SHARE on spaces, while it scans: 327 + 86 rows on prod. Its
--   own lock_timeout 5s; never at :55-:05 (the hourly daily-plan run).
--
-- ROLLBACK: 0r-rollback.sql (the whole directory, in reverse).
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0d-validate.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Order, then the all-row sweep. ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n   bigint;
  v_bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.1.5-spacefk-001-fk-plants')
     OR NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.1.5-spacefk-001-fk-projects') THEN
    RAISE EXCEPTION 'v5-spacefk-001 0d refused, nothing changed: 0b and 0c must both be applied first (stamps -fk-plants and -fk-projects).';
  END IF;

  SELECT count(*), string_agg(p.id::text || ' (' || p.workspace_id::text || ')', ', ' ORDER BY p.id)
    INTO v_n, v_bad
    FROM public.plants p
   WHERE NOT EXISTS (SELECT 1 FROM public.spaces s WHERE s.id = p.workspace_id);
  RAISE NOTICE 'v5-spacefk-001 0d sweep: plants rows naming no Space (all rows, deleted included) = %', v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'v5-spacefk-001 0d refused, nothing validated: % plants row(s) name no Space: %', v_n, v_bad;
  END IF;

  SELECT count(*), string_agg(p.id::text || ' (' || p.workspace_id::text || ')', ', ' ORDER BY p.id)
    INTO v_n, v_bad
    FROM public.plant_projects p
   WHERE NOT EXISTS (SELECT 1 FROM public.spaces s WHERE s.id = p.workspace_id);
  RAISE NOTICE 'v5-spacefk-001 0d sweep: plant_projects rows naming no Space (all rows, deleted included) = %', v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'v5-spacefk-001 0d refused, nothing validated: % plant_projects row(s) name no Space: %', v_n, v_bad;
  END IF;
END $$;

-- ── 1. Validate. ───────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.plants VALIDATE CONSTRAINT plants_workspace_id_fkey;
ALTER TABLE public.plant_projects VALIDATE CONSTRAINT plant_projects_workspace_id_fkey;

-- ── 2. The stamp. ──────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.1.5-spacefk-001-validate',
        'SPACEFK validate: V5-SPACETENANCYKEY-001 (multi-space Phase 1 step 1.10). All-row sweep (no '
        'deleted_at filter) = 0 on plants and plant_projects, then VALIDATE CONSTRAINT '
        'plants_workspace_id_fkey and plant_projects_workspace_id_fkey. Arms the convalidated gate and the '
        'all-row workspace census over every other workspace_id base table.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
