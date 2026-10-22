-- 0r-rollback.sql: v5-tenancyvalidate-001 rollback, the whole directory in reverse (25 -> 01), in ONE transaction.
-- V5-SPACETENANCYKEY-001, multi-space step 2.3.
--
-- A VALIDATED KEY CANNOT BE UN-VALIDATED IN PLACE. PostgreSQL has no ALTER ... NOT VALID for an existing
--   constraint, so this drops each key the directory validated and adds it again exactly as v5-tenancykey-001 made
--   it: <table>_workspace_id_fkey, FOREIGN KEY (workspace_id) REFERENCES public.spaces (id) ON DELETE RESTRICT
--   NOT VALID, with 2.1's comment. Adding a key NOT VALID scans no row, so nothing here can fail on data.
--   Between the DROP and the ADD (inside this one transaction, under ACCESS EXCLUSIVE) no other session sees the
--   table without its key.
--
-- WHAT, per key whose stamp is present (a partly applied run is rolled back as far as it went):
--   validated key  -> DROP CONSTRAINT, ADD CONSTRAINT ... NOT VALID, COMMENT (2.1's text), DELETE the stamp;
--   NOT VALID key  -> nothing to undo; DELETE the stamp;
--   no key and no 2.1 stamp (2.1's own rollback ran first) -> nothing to undo; DELETE the stamp.
-- It REFUSES, changing nothing, when a stamped key is gone while 2.1's stamp is still present, or is not in 2.1's
--   shape (workspace_id alone -> public.spaces(id), ON DELETE RESTRICT): something other than these two
--   directories changed it, and re-adding it here would hide that.
-- A key validated WITHOUT this directory's stamp is not touched (this file undoes only what the stamps say).
-- WHEN. Never needed for writes: a NOT VALID key checks every new row exactly as a validated one does. It is the
--   undo for the state, e.g. before v5-tenancykey-001's own 0r (run this first so these stamps do not outlive
--   their keys).
-- ENV. None needed: it changes only what the stamps say this directory did.
-- LOCKS. ACCESS EXCLUSIVE on each table touched and on spaces (the key's RI triggers on spaces are dropped and
--   made again), to COMMIT. lock_timeout 5s. Same windows as the apply: never at :58-:02 or 07:00-08:00 UTC.
-- RE-RUN. A second run finds no stamp and changes nothing.
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-tenancyvalidate-001/0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $rollback$
DECLARE
  r record;
  v_bad text := '';
  v_redo int := 0;
  v_noop int := 0;
BEGIN
  CREATE TEMP TABLE tenancyvalidate_keys (n int, relname text, conname text, key_stamp text, stamp text) ON COMMIT DROP;
  INSERT INTO tenancyvalidate_keys VALUES
    -- BEGIN tenancyvalidate keys
    (1, 'locations', 'locations_workspace_id_fkey', '5.3.13-tenancykey-001-locations', '5.3.14-tenancyvalidate-001-locations'),
    (2, 'photos', 'photos_workspace_id_fkey', '5.3.13-tenancykey-001-photos', '5.3.14-tenancyvalidate-001-photos'),
    (3, 'inventory_items', 'inventory_items_workspace_id_fkey', '5.3.13-tenancykey-001-inventory-items', '5.3.14-tenancyvalidate-001-inventory-items'),
    (4, 'storage_location', 'storage_location_workspace_id_fkey', '5.3.13-tenancykey-001-storage-location', '5.3.14-tenancyvalidate-001-storage-location'),
    (5, 'preservation_log', 'preservation_log_workspace_id_fkey', '5.3.13-tenancykey-001-preservation-log', '5.3.14-tenancyvalidate-001-preservation-log'),
    (6, 'kitchen_batch', 'kitchen_batch_workspace_id_fkey', '5.3.13-tenancykey-001-kitchen-batch', '5.3.14-tenancyvalidate-001-kitchen-batch'),
    (7, 'pantry_item', 'pantry_item_workspace_id_fkey', '5.3.13-tenancykey-001-pantry-item', '5.3.14-tenancyvalidate-001-pantry-item'),
    (8, 'recipe', 'recipe_workspace_id_fkey', '5.3.13-tenancykey-001-recipe', '5.3.14-tenancyvalidate-001-recipe'),
    (9, 'tag', 'tag_workspace_id_fkey', '5.3.13-tenancykey-001-tag', '5.3.14-tenancyvalidate-001-tag'),
    (10, 'critter_state', 'critter_state_workspace_id_fkey', '5.3.13-tenancykey-001-critter-state', '5.3.14-tenancyvalidate-001-critter-state'),
    (11, 'findings', 'findings_workspace_id_fkey', '5.3.13-tenancykey-001-findings', '5.3.14-tenancyvalidate-001-findings'),
    (12, 'tasks', 'tasks_workspace_id_fkey', '5.3.13-tenancykey-001-tasks', '5.3.14-tenancyvalidate-001-tasks'),
    (13, 'event_batches', 'event_batches_workspace_id_fkey', '5.3.13-tenancykey-001-event-batches', '5.3.14-tenancyvalidate-001-event-batches'),
    (14, 'daily_plan', 'daily_plan_workspace_id_fkey', '5.3.13-tenancykey-001-daily-plan', '5.3.14-tenancyvalidate-001-daily-plan'),
    (15, 'favorites', 'favorites_workspace_id_fkey', '5.3.13-tenancykey-001-favorites', '5.3.14-tenancyvalidate-001-favorites'),
    (16, 'voice_alias', 'voice_alias_workspace_id_fkey', '5.3.13-tenancykey-001-voice-alias', '5.3.14-tenancyvalidate-001-voice-alias'),
    (17, 'proj_rescope_events', 'proj_rescope_events_workspace_id_fkey', '5.3.13-tenancykey-001-proj-rescope-events', '5.3.14-tenancyvalidate-001-proj-rescope-events'),
    (18, 'weather_cue_impression', 'weather_cue_impression_workspace_id_fkey', '5.3.13-tenancykey-001-weather-cue-impression', '5.3.14-tenancyvalidate-001-weather-cue-impression'),
    (19, 'cultivar_weight_sample', 'cultivar_weight_sample_workspace_id_fkey', '5.3.13-tenancykey-001-cultivar-weight-sample', '5.3.14-tenancyvalidate-001-cultivar-weight-sample'),
    (20, 'cultivar_weight_void', 'cultivar_weight_void_workspace_id_fkey', '5.3.13-tenancykey-001-cultivar-weight-void', '5.3.14-tenancyvalidate-001-cultivar-weight-void'),
    (21, 'source', 'source_workspace_id_fkey', '5.3.13-tenancykey-001-source', '5.3.14-tenancyvalidate-001-source'),
    (22, 'slug_redirects', 'slug_redirects_workspace_id_fkey', '5.3.13-tenancykey-001-slug-redirects', '5.3.14-tenancyvalidate-001-slug-redirects'),
    (23, 'treatment_association', 'treatment_association_workspace_id_fkey', '5.3.13-tenancykey-001-fk-treatment-association', '5.3.14-tenancyvalidate-001-treatment-association'),
    (24, 'garden_shared_state', 'garden_shared_state_workspace_id_fkey', '5.3.13-tenancykey-001-fk-garden-shared-state', '5.3.14-tenancyvalidate-001-garden-shared-state'),
    (25, 'seen_event', 'seen_event_workspace_id_fkey', '5.3.13-tenancykey-001-fk-seen-event', '5.3.14-tenancyvalidate-001-seen-event')
    -- END tenancyvalidate keys
    ;

  -- Each stamped key's state: present at all, present in 2.1's shape, validated.
  CREATE TEMP TABLE tenancyvalidate_state ON COMMIT DROP AS
  SELECT k.*,
         EXISTS (SELECT 1 FROM public.schema_version sv WHERE sv.version = k.key_stamp) AS key_stamped,
         EXISTS (SELECT 1 FROM pg_constraint x
                   JOIN pg_class c ON c.oid = x.conrelid
                   JOIN pg_namespace ns ON ns.oid = c.relnamespace
                  WHERE ns.nspname = 'public' AND c.relname = k.relname AND x.conname = k.conname) AS has_key,
         (SELECT x.convalidated
            FROM pg_constraint x
            JOIN pg_class c ON c.oid = x.conrelid
            JOIN pg_namespace ns ON ns.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = x.conrelid AND a.attnum = x.conkey[1]
            JOIN pg_class f ON f.oid = x.confrelid
            JOIN pg_namespace fn ON fn.oid = f.relnamespace
            JOIN pg_attribute fa ON fa.attrelid = x.confrelid AND fa.attnum = x.confkey[1]
           WHERE ns.nspname = 'public' AND c.relname = k.relname AND x.conname = k.conname AND x.contype = 'f'
             AND cardinality(x.conkey) = 1 AND a.attname = 'workspace_id'
             AND cardinality(x.confkey) = 1 AND fn.nspname = 'public' AND f.relname = 'spaces' AND fa.attname = 'id'
             AND x.confdeltype = 'r') AS validated   -- NULL: no key in 2.1's shape
    FROM tenancyvalidate_keys k
   WHERE EXISTS (SELECT 1 FROM public.schema_version sv WHERE sv.version = k.stamp);

  -- ── Pass 1: every refusal, before anything is dropped. ───────────────────────────────────────────────
  FOR r IN SELECT * FROM tenancyvalidate_state ORDER BY n DESC LOOP
    IF NOT r.has_key AND r.key_stamped THEN
      v_bad := v_bad || format(' %s is gone but v5-tenancykey-001 stamp %s is present;', r.conname, r.key_stamp);
    ELSIF r.has_key AND r.validated IS NULL THEN
      v_bad := v_bad || format(' %s is not in the shape v5-tenancykey-001 made;', r.conname);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'v5-tenancyvalidate-001 0r refused, nothing changed:%', v_bad;
  END IF;

  -- ── Pass 2: reverse order. A validated key goes back to NOT VALID; every stamp goes. ───────────────────
  FOR r IN SELECT * FROM tenancyvalidate_state ORDER BY n DESC LOOP
    IF r.validated THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.relname, r.conname);
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES public.spaces (id) '
                     'ON DELETE RESTRICT NOT VALID', r.relname, r.conname);
      EXECUTE format('COMMENT ON CONSTRAINT %I ON public.%I IS %L', r.conname, r.relname,
                     format('V5-SPACETENANCYKEY-001 (v5-tenancykey-001 %s, step 2.1). A row''s Space is a row of public.spaces. RESTRICT: a Space with rows here cannot be deleted. NOT VALID until step 2.3.',
                            lpad(r.n::text, 2, '0')));
      v_redo := v_redo + 1;
    ELSE
      v_noop := v_noop + 1;
    END IF;
    DELETE FROM public.schema_version WHERE version = r.stamp;
  END LOOP;
  RAISE NOTICE 'v5-tenancyvalidate-001 0r: % key(s) put back to NOT VALID; % stamp(s) had nothing to undo; % stamp(s) deleted.',
    v_redo, v_noop, v_redo + v_noop;
END $rollback$;

COMMIT;
