-- 0a-fold.sql
-- V5-SPACESENTINELDOC-001 (multi-space Phase 1, step 1.9): fold the ten containers that carry the nil
--   workspace '00000000-0000-0000-0000-000000000000' into the one Space that exists,
--   '00000000-0000-0000-0000-000000000001'. Stamp 5.1.5-spacefk-001-fold.
--
-- WHY. plant_projects.workspace_id is the container's Space. Ten of Dave's containers carry the nil id,
--   which names no row in public.spaces; every other row in every workspace_id column carries ...0001
--   (Phase 0 read 6). The plantings inside those ten already carry ...0001 (read 7: the 12 "mismatched"
--   plantings are all ...0001 plantings in a ...0000 container). The seam is the container column only.
--   1.8 (0b, 0c) puts a foreign key on workspace_id; this file runs FIRST so that no row the key would
--   reject exists when the key appears (review DSA I1: an UPDATE that touches a row twice in one
--   transaction re-checks an unchanged invalid key and raises 23503).
--
-- SCOPE: workspace_id on exactly the ten pinned ids below, and only where it is still the nil id.
--   Location, owner, status, name: untouched (P1, D27-note: no indoor precondition; the fold is a
--   tenancy re-stamp, not a move). No DDL on an app table. One new table, the BEFORE copy
--   public.ctas_spacefold001_plant_projects (the ctas_ prefix is the one scripts/check-staging-drift.py
--   ignores), created only on a database where at least one pinned row still needs folding.
--
-- THE TEN (prod, read 34, full ids re-read 2026-10-16 read-only): all live, kind 'category', created by
--   Dave; Lithops archived. Christmas Cactus, Dracaena, Echeveria, Echeveria 'Perle von Nurnberg',
--   Golden Sedum, Gymnocalycium mihanovichii, Haworthia / Gasteria (assorted), Jade Plant, Japanese
--   Maple, Lithops.
--
-- STAGING HAS NONE OF THEM (read 17; re-read 2026-10-16: 0 of 10 present, 0 nil rows). There this file
--   is a clean no-op: no BEFORE copy, no row changed, the stamp only.
--
-- TRIGGERS THE UPDATE FIRES on plant_projects (prod pg_trigger, 2026-10-16):
--   container_bump              BEFORE UPDATE row  gv.bump_version: version := OLD.version + 1.
--   set_updated_at              BEFORE UPDATE row  updated_at := now().
--   prevent_ownership_transfer  BEFORE UPDATE row  fires and passes: created_by is not written.
--   container_reparent_after    AFTER UPDATE row   fires; its body acts only when parent_project_id
--                                                  changes (IS DISTINCT FROM), so it does nothing here.
--   container_closure_after_ins AFTER INSERT row   not fired. trg_guard_entity_tag_project: BEFORE
--                                                  DELETE, not fired.
--   There is no audit trigger on plant_projects (read 26), so the record of this change is the BEFORE
--   copy and the stamp. The actor below is set for any trigger that reads it; none on this table does.
--   SIDE EFFECT, stated: version + 1 and updated_at = now() on each folded row. A page that loaded one of
--   these containers before the fold sends the old version on its next move and gets one 409 "Version
--   conflict — reload and retry" (README.md).
--
-- SAFETY / IDEMPOTENCY. All or nothing (one transaction). Re-running finds every pinned row already on
--   ...0001: no copy row, no UPDATE, the stamp ON CONFLICT DO NOTHING. Refuses, changing nothing, when:
--   the target Space is missing; a pinned row carries a third value; a nil row exists, in any
--   workspace_id table, that is not one of the ten (the fold would be partial: 0b would refuse, or an
--   event copy such as a reparent_event row would red the -validate census for ever); or, after the
--   UPDATE, any nil row remains or the folded count differs from the copied count.
--   LOCKS: row locks on the ten (FOR UPDATE, then the UPDATE), no table lock beyond ROW EXCLUSIVE.
--   lock_timeout 5s: behind a long-open transaction on one of the ten, the file fails fast (55P03)
--   having changed nothing. Run it again.
--
-- ORDER: 0a (this) -> 0b -> 0c -> 0d. 0b and 0c refuse until this file's stamp exists.
-- ROLLBACK: 0r-rollback.sql (the whole directory, in reverse).
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0a-fold.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
SELECT set_config('app.actor_clerk_sub', 'migration:v5-spacefk-001', true) AS actor;

-- The ten, once. Every statement below reads this list.
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

-- ── 0. Lock the ten, then refuse anything the fold cannot express. ──────────────────────────────────
DO $$
DECLARE
  v_bad text;
BEGIN
  PERFORM 1 FROM public.plant_projects p JOIN spacefold001_pinned k ON k.id = p.id FOR UPDATE OF p;

  IF NOT EXISTS (SELECT 1 FROM public.spaces WHERE id = '00000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'v5-spacefk-001 0a refused, nothing changed: the target Space 00000000-0000-0000-0000-000000000001 is not in public.spaces.';
  END IF;

  SELECT string_agg(p.id::text || ' (' || p.workspace_id::text || ')', ', ' ORDER BY p.id) INTO v_bad
    FROM public.plant_projects p JOIN spacefold001_pinned k ON k.id = p.id
   WHERE p.workspace_id NOT IN ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spacefk-001 0a refused, nothing changed: pinned container(s) carry a workspace that is neither the nil id nor the target: %', v_bad;
  END IF;

  SELECT string_agg(p.id::text, ', ' ORDER BY p.id) INTO v_bad
    FROM public.plant_projects p
   WHERE p.workspace_id = '00000000-0000-0000-0000-000000000000'
     AND NOT EXISTS (SELECT 1 FROM spacefold001_pinned k WHERE k.id = p.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spacefk-001 0a refused, nothing changed: nil-workspace container(s) outside the ten pinned: %', v_bad
      USING HINT = 'The fold covers exactly the ten containers read on prod. Re-read the census and re-pin; do not widen the UPDATE by predicate.';
  END IF;
END $$;

-- Every OTHER workspace_id table must hold no nil row either: a copy written before the fold (a
-- reparent_event row from moving one of the ten, say) would name no Space for ever and red the
-- all-row census armed on -validate. Prod and staging held none on 2026-10-16 (read 6, re-read).
DO $$
DECLARE
  r   record;
  v_n bigint;
  v_bad text;
BEGIN
  FOR r IN SELECT c.relname
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attname = 'workspace_id'
              AND NOT a.attisdropped AND c.relname !~ '^(ctas|snap)_' AND c.relname <> 'plant_projects'
            ORDER BY c.relname LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE workspace_id = ''00000000-0000-0000-0000-000000000000''', r.relname)
       INTO v_n;
    IF v_n > 0 THEN
      v_bad := coalesce(v_bad || ', ', '') || r.relname || ' ' || v_n;
    END IF;
  END LOOP;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spacefk-001 0a refused, nothing changed: nil-workspace row(s) in other tables: %', v_bad
      USING HINT = 'This file folds the ten containers only. Read those rows; folding a copy is its own reviewed change.';
  END IF;
END $$;

-- ── 1. Census BEFORE: every workspace_id value, per base table (stray ctas_/snap_ copies excluded). ──
DO $$
DECLARE
  r record;
  v text;
BEGIN
  FOR r IN SELECT c.relname
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attname = 'workspace_id'
              AND NOT a.attisdropped AND c.relname !~ '^(ctas|snap)_'
            ORDER BY c.relname LOOP
    EXECUTE format('SELECT string_agg(w || '' = '' || n, '', '' ORDER BY w) FROM '
                   '(SELECT workspace_id::text AS w, count(*) AS n FROM public.%I GROUP BY 1) x', r.relname) INTO v;
    RAISE NOTICE 'v5-spacefk-001 census before: % [%]', r.relname, coalesce(v, 'no rows');
  END LOOP;
END $$;

-- ── 2. The BEFORE copy, then the fold, then proof. ──────────────────────────────────────────────────
DO $$
DECLARE
  v_need   int;
  v_copied int := 0;
  v_folded int := 0;
  v_bad    text;
BEGIN
  SELECT count(*) INTO v_need
    FROM public.plant_projects p JOIN spacefold001_pinned k ON k.id = p.id
   WHERE p.workspace_id = '00000000-0000-0000-0000-000000000000';

  IF v_need > 0 THEN
    -- Whole rows, so the copy is a full pre-image; 0r reads workspace_id back from it by id.
    EXECUTE 'CREATE TABLE IF NOT EXISTS public.ctas_spacefold001_plant_projects AS '
            'SELECT p.*, now() AS ctas_taken_at FROM public.plant_projects p WITH NO DATA';
    EXECUTE 'INSERT INTO public.ctas_spacefold001_plant_projects '
            'SELECT p.*, now() FROM public.plant_projects p JOIN spacefold001_pinned k ON k.id = p.id '
            'WHERE p.workspace_id = ''00000000-0000-0000-0000-000000000000'' '
            '  AND NOT EXISTS (SELECT 1 FROM public.ctas_spacefold001_plant_projects s WHERE s.id = p.id)';
    -- Every row about to fold must have its nil value in the copy, whichever run wrote it.
    EXECUTE 'SELECT count(*) FROM public.ctas_spacefold001_plant_projects s '
            'JOIN public.plant_projects p ON p.id = s.id JOIN spacefold001_pinned k ON k.id = p.id '
            'WHERE p.workspace_id = ''00000000-0000-0000-0000-000000000000'' '
            '  AND s.workspace_id = ''00000000-0000-0000-0000-000000000000''' INTO v_copied;
  END IF;

  UPDATE public.plant_projects p
     SET workspace_id = '00000000-0000-0000-0000-000000000001'
    FROM spacefold001_pinned k
   WHERE p.id = k.id
     AND p.workspace_id = '00000000-0000-0000-0000-000000000000';
  GET DIAGNOSTICS v_folded = ROW_COUNT;

  IF v_folded <> v_need OR v_copied <> v_need THEN
    RAISE EXCEPTION 'v5-spacefk-001 0a: % row(s) needed folding, % copied, % folded; nothing was changed', v_need, v_copied, v_folded;
  END IF;

  SELECT string_agg(x.t || ' ' || x.id::text, ', ' ORDER BY x.t, x.id) INTO v_bad
    FROM (SELECT 'plant_projects' AS t, p.id FROM public.plant_projects p
           WHERE p.workspace_id = '00000000-0000-0000-0000-000000000000'
          UNION ALL
          SELECT 'plants', g.id FROM public.plants g
           WHERE g.workspace_id = '00000000-0000-0000-0000-000000000000') x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spacefk-001 0a: nil-workspace row(s) remain after the fold: %; nothing was changed', v_bad;
  END IF;

  RAISE NOTICE 'v5-spacefk-001 0a: folded % container(s) into 00000000-0000-0000-0000-000000000001 (% of 10 pinned present on this database); BEFORE copy %',
    v_folded, (SELECT count(*) FROM public.plant_projects p JOIN spacefold001_pinned k ON k.id = p.id),
    CASE WHEN v_need > 0 THEN 'in public.ctas_spacefold001_plant_projects' ELSE 'not needed' END;
END $$;

-- ── 3. Census AFTER. ────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
  v text;
BEGIN
  FOR r IN SELECT c.relname
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attname = 'workspace_id'
              AND NOT a.attisdropped AND c.relname !~ '^(ctas|snap)_'
            ORDER BY c.relname LOOP
    EXECUTE format('SELECT string_agg(w || '' = '' || n, '', '' ORDER BY w) FROM '
                   '(SELECT workspace_id::text AS w, count(*) AS n FROM public.%I GROUP BY 1) x', r.relname) INTO v;
    RAISE NOTICE 'v5-spacefk-001 census after: % [%]', r.relname, coalesce(v, 'no rows');
  END LOOP;
END $$;

-- ── 4. The stamp. Same transaction as the data change: applied and armed are one event. ─────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.1.5-spacefk-001-fold',
        'SPACEFK fold: V5-SPACESENTINELDOC-001 (multi-space Phase 1 step 1.9). The ten containers that '
        'carried the nil workspace 00000000-0000-0000-0000-000000000000 (prod only; read 34) now carry the '
        'one Space 00000000-0000-0000-0000-000000000001, by pinned id, under actor migration:v5-spacefk-001. '
        'workspace_id only; location and owner untouched. BEFORE copy in ctas_spacefold001_plant_projects '
        '(prod). Side effect: version + 1 and updated_at = now() on each folded row (container_bump, '
        'set_updated_at). No-op on staging (none of the ten). Arms 1.11''s photo tenancy gate. '
        'Followed by -fk-plants, -fk-projects, -validate.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
