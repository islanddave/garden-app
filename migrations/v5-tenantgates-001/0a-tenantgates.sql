-- 0a-tenantgates.sql
-- schema_version: 5.1.5-tenantgates-001
-- V5-SPACEISOLATION-001 (multi-space Phase 1 step 1.17), V5-SITECONSTANTS-001 (step 1.14, the database half) and
--   V5-PHOTOSPACEBACKFILL-001 (step 1.11). Build sheet:
--   project-state/_multispace-20261015/multispace-phase1-buildsheet-V203-20261016.0915.md §2 and §3R ("Gate tenancy").
--
-- SCOPE: one schema_version row. No DDL, no other data. This directory is gates; the stamp is what they arm on
--   (the house rule: a standing gate keys on its own migration's schema_version row, review DSA I3). Writing the
--   stamp IS arming them, so step 0 first refuses, changing nothing, where an armed gate would red at once:
--     1.17 post_no_second_owner_until_approved: a Space other than the original one, or one owned by someone
--          other than the original Space's owner, with no phase7-approved-* stamp; or the original Space absent
--          or ownerless.
--     1.14 post_sentinel_callers: a function body (any schema) that holds the original Space's id or calls
--          sentinel_workspace(), other than the listed gv.entity_cultivar_ins and the excluded definer
--          gv.sentinel_workspace; a listed entry that no longer matches; the definer's body changed.
--     1.11 post_photo_tenancy_no_conflict, only once v5-spacefk-001's fold stamp exists: a live photo whose
--          parents resolve to two workspaces.
--   The same predicates are the gates in gates.yml; keep them in step.
--
-- WHY THE DEPLOYED CODE IS UNAFFECTED: nothing reads schema_version at runtime except the gates.
-- LOCKS: one INSERT into schema_version. No apply window needed beyond the house one (never at
--   :55-:05), kept for uniformity with the Phase 1 sitting.
-- ROLLBACK: 0r-rollback.sql deletes the stamp; every gate here goes vacuous. Order across Phase 1 is
--   M3 -> M2 -> M1 (README.md).
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0a-tenantgates.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refuse to arm a gate that would red at once. Nothing has changed yet. ─────────────────────
DO $$
DECLARE
  v_list text;
BEGIN
  -- 1.17: one owner, until a Phase 7 approval.
  IF NOT EXISTS (SELECT 1 FROM public.spaces d
                  WHERE d.id = '00000000-0000-0000-0000-000000000001' AND d.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'v5-tenantgates-001 0a refused, nothing changed: the original Space is absent or has no owner; post_no_second_owner_until_approved would red at once.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version LIKE 'phase7-approved-%') THEN
    SELECT string_agg(s.id::text, ', ') INTO v_list
      FROM public.spaces s
     CROSS JOIN (SELECT d.created_by FROM public.spaces d WHERE d.id = '00000000-0000-0000-0000-000000000001') dave
     WHERE s.id IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'
        OR s.created_by IS DISTINCT FROM dave.created_by;
    IF v_list IS NOT NULL THEN
      RAISE EXCEPTION 'v5-tenantgates-001 0a refused, nothing changed: Space(s) % would red post_no_second_owner_until_approved.', v_list
        USING HINT = 'Phase 0 read 26 / E3a: read every spaces row on this env; a stray staging row is hard-deleted under smoke hygiene, or the gate becomes env: prod with the reason.';
    END IF;
  END IF;

  -- 1.14: the sentinel callers are exactly the list.
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname) INTO v_list
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE (p.prosrc ~ '00000000-0000-0000-0000-000000000001' OR p.prosrc ~* 'sentinel_workspace\s*\(')
     AND NOT (p.pronargs = 0 AND n.nspname = 'gv' AND p.proname IN ('entity_cultivar_ins', 'sentinel_workspace'));
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'v5-tenantgates-001 0a refused, nothing changed: unlisted sentinel caller(s) %; post_sentinel_callers would red at once.', v_list
      USING HINT = 'Re-read pg_proc on this env and decide each one (README.md "1.14"); do not widen the list to make this pass.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'gv' AND p.proname = 'entity_cultivar_ins' AND p.pronargs = 0
                    AND (p.prosrc ~ '00000000-0000-0000-0000-000000000001' OR p.prosrc ~* 'sentinel_workspace\s*\('))
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'gv' AND p.proname = 'sentinel_workspace' AND p.pronargs = 0
                       AND md5(p.prosrc) = 'd6b97956568e3c2a65bdb195d09eccbc') THEN
    RAISE EXCEPTION 'v5-tenantgates-001 0a refused, nothing changed: gv.entity_cultivar_ins no longer holds the id or calls sentinel_workspace(), or gv.sentinel_workspace() is not the body Phase 0 read (md5 d6b97956...).'
      USING HINT = 'The list in gates.yml post_sentinel_callers is stale; shrink it on purpose.';
  END IF;

  -- 1.11: armed only once v5-spacefk-001 has folded; then no live photo's parents may disagree.
  IF EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.1.5-spacefk-001-fold') THEN
    WITH live AS (
      SELECT ph.id, ph.plant_id, ph.project_id, ph.event_id, ph.space_id
        FROM public.photos ph WHERE ph.deleted_at IS NULL
    ), resolved AS (
      SELECT l.id AS photo_id, pl.workspace_id FROM live l JOIN public.plants pl ON pl.id = l.plant_id
      UNION ALL
      SELECT l.id, pp.workspace_id FROM live l JOIN public.plant_projects pp ON pp.id = l.project_id
      UNION ALL
      SELECT l.id, pl.workspace_id
        FROM live l JOIN public.event_log e ON e.id = l.event_id JOIN public.plants pl ON pl.id = e.plant_id
      UNION ALL
      SELECT l.id, pp.workspace_id
        FROM live l JOIN public.event_log e ON e.id = l.event_id JOIN public.plant_projects pp ON pp.id = e.project_id
      UNION ALL
      SELECT l.id, l.space_id FROM live l WHERE l.space_id IS NOT NULL
    )
    SELECT string_agg(photo_id::text, ', ' ORDER BY photo_id) INTO v_list
      FROM (SELECT r.photo_id FROM resolved r GROUP BY r.photo_id HAVING count(DISTINCT r.workspace_id) > 1) c;
    IF v_list IS NOT NULL THEN
      RAISE EXCEPTION 'v5-tenantgates-001 0a refused, nothing changed: live photo(s) % have parents in two workspaces; post_photo_tenancy_no_conflict would red at once.', v_list;
    END IF;
  END IF;
END $$;

-- ── 1. The stamp. Arming and applying are one event. ─────────────────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.1.5-tenantgates-001',
        'TENANTGATES: V5-SPACEISOLATION-001 (1.17), V5-SITECONSTANTS-001 (1.14 database half), '
        'V5-PHOTOSPACEBACKFILL-001 (1.11). Arms post_no_second_owner_until_approved, post_sentinel_callers '
        '(list: gv.entity_cultivar_ins; gv.sentinel_workspace excluded as the definer) and '
        'post_photo_tenancy_no_conflict (also armed on 5.1.5-spacefk-001-fold). No DDL; no other data.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
