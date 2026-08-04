-- 0c-verify-triggers.sql
-- V4-CULTIVARNAME-001 — prove the name-sync MECHANISM works, on any environment.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-cultivarname-001/0c-verify-triggers.sql
--
-- Companion to 0c-verify.sql, which asserts that the two specific cultivars carry the right names.
-- That file is inherently prod-scoped: staging holds NEITHER cultivar (verified 2026-08-04 by a
-- full-column scan of all 68 staging tables — zero occurrences of any spelling), so applying
-- 0b-rename.sql there is a clean no-op that exercises nothing. A green no-op is not verification.
--
-- This file closes that gap. It creates a throwaway cultivar and planting, renames them, and
-- asserts the mirror followed — the exact behaviour BUG-FLORADADESYNC-001 was missing — then
-- ROLLS BACK. Nothing is left behind, so it is safe on prod too, and running it on prod is the
-- honest way to confirm the mechanism there rather than inferring it from staging.
--
-- WHY THE ROLLBACK IS SOUND. Every write is inside the transaction: the fixture rows, the entity
-- rows the INSERT triggers mirror, the audit_events rows trg_audit_plant_varieties writes, and the
-- version bumps. All of it disappears. The only externally-visible effect is sequence consumption,
-- and neither table uses a sequence (both ids are uuid defaults).

BEGIN;

DO $$
DECLARE
  cid uuid; pid uuid; ws uuid; actor text; got text;
BEGIN
  ws := gv.sentinel_workspace();
  actor := '__v4cultivarname001_probe__';

  ---------------------------------------------------------------------------
  -- Fixture. The INSERT triggers mirror both rows into entity for us; if they
  -- do not, this file fails here rather than mis-attributing it to the rename.
  ---------------------------------------------------------------------------
  INSERT INTO public.plant_varieties (name, created_by)
       VALUES ('__probe cultivar BEFORE__', actor) RETURNING id INTO cid;
  INSERT INTO public.plants (name, created_by, workspace_id, variety_id)
       VALUES ('__probe planting BEFORE__', actor, ws, cid) RETURNING id INTO pid;

  SELECT display_name INTO got FROM public.entity
   WHERE entity_type='cultivar' AND cultivar_ref_id=cid AND deleted_at IS NULL;
  IF got IS DISTINCT FROM '__probe cultivar BEFORE__' THEN
    RAISE EXCEPTION 'precondition: cultivar INSERT mirror is % (expected __probe cultivar BEFORE__)', COALESCE(got,'<no entity row>');
  END IF;

  SELECT display_name INTO got FROM public.entity
   WHERE entity_type='planting' AND planting_ref_id=pid AND deleted_at IS NULL;
  IF got IS DISTINCT FROM '__probe planting BEFORE__' THEN
    RAISE EXCEPTION 'precondition: planting INSERT mirror is % (expected __probe planting BEFORE__)', COALESCE(got,'<no entity row>');
  END IF;

  ---------------------------------------------------------------------------
  -- 1. THE REGRESSION. Rename via the base table. Before 0a this left the
  --    mirror untouched — that is the entire bug.
  ---------------------------------------------------------------------------
  UPDATE public.plant_varieties SET name='__probe cultivar AFTER__' WHERE id=cid;
  SELECT display_name INTO got FROM public.entity
   WHERE entity_type='cultivar' AND cultivar_ref_id=cid AND deleted_at IS NULL;
  IF got IS DISTINCT FROM '__probe cultivar AFTER__' THEN
    RAISE EXCEPTION 'check 1: cultivar rename did NOT propagate — mirror still says %', COALESCE(got,'<no entity row>');
  END IF;

  UPDATE public.plants SET name='__probe planting AFTER__' WHERE id=pid;
  SELECT display_name INTO got FROM public.entity
   WHERE entity_type='planting' AND planting_ref_id=pid AND deleted_at IS NULL;
  IF got IS DISTINCT FROM '__probe planting AFTER__' THEN
    RAISE EXCEPTION 'check 2: planting rename did NOT propagate — mirror still says %', COALESCE(got,'<no entity row>');
  END IF;

  ---------------------------------------------------------------------------
  -- 3. THE APP'S ACTUAL PATH. lambda/varieties/index.js and lambda/plants/
  --    index.js rename through the auto-updatable views, never the base
  --    tables. If the trigger only fired on direct base-table writes it would
  --    be useless in production. Same assertion, via the views.
  ---------------------------------------------------------------------------
  UPDATE public.cultivar SET display_name='__probe cultivar VIA VIEW__' WHERE id=cid;
  SELECT display_name INTO got FROM public.entity
   WHERE entity_type='cultivar' AND cultivar_ref_id=cid AND deleted_at IS NULL;
  IF got IS DISTINCT FROM '__probe cultivar VIA VIEW__' THEN
    RAISE EXCEPTION 'check 3: rename through the cultivar VIEW did not propagate — mirror says %', COALESCE(got,'<no entity row>');
  END IF;

  UPDATE public.garden_node SET display_name='__probe planting VIA VIEW__' WHERE id=pid;
  SELECT display_name INTO got FROM public.entity
   WHERE entity_type='planting' AND planting_ref_id=pid AND deleted_at IS NULL;
  IF got IS DISTINCT FROM '__probe planting VIA VIEW__' THEN
    RAISE EXCEPTION 'check 4: rename through the garden_node VIEW did not propagate — mirror says %', COALESCE(got,'<no entity row>');
  END IF;

  ---------------------------------------------------------------------------
  -- 5. THE ONE WAY THIS COULD HAVE BROKEN PRODUCTION. entity_dname_nonempty
  --    CHECKs length(btrim(display_name)) > 0. A naive sync trigger would
  --    propagate a blank name straight into that CHECK and abort the parent
  --    UPDATE — turning a previously-succeeding write into a hard failure,
  --    which is exactly the class of mistake the 2026-08-03 harvest-save
  --    incident was. The trigger reuses the INSERT path's
  --    COALESCE(NULLIF(btrim(...),''),'(cultivar)') fallback, so a blank name
  --    lands the same literal the insert would have and the write survives.
  ---------------------------------------------------------------------------
  --    The handler is NARROW on purpose. `WHEN OTHERS` here would catch a 23505 from
  --    uq_plant_varieties_name_species (two whitespace-named rows collide on lower(name)) or any
  --    future CHECK on plant_varieties.name and misreport it as the sync trigger rejecting the
  --    write — a check that blames the wrong component is worse than no check. Only the
  --    CHECK-violation class this test is actually about is caught; anything else re-raises with
  --    its own message intact.
  BEGIN
    UPDATE public.plant_varieties SET name='   ' WHERE id=cid;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'check 5: a blank cultivar name was REJECTED by a CHECK reached through the sync trigger (%). The trigger must never turn a write that previously succeeded into a failure — it is supposed to substitute the (cultivar) fallback, exactly as gv.entity_cultivar_ins does.', SQLERRM;
  END;
  SELECT display_name INTO got FROM public.entity
   WHERE entity_type='cultivar' AND cultivar_ref_id=cid AND deleted_at IS NULL;
  IF got IS DISTINCT FROM '(cultivar)' THEN
    RAISE EXCEPTION 'check 5: blank cultivar name should mirror as (cultivar), got %', COALESCE(got,'<no entity row>');
  END IF;

  BEGIN
    UPDATE public.plants SET name='' WHERE id=pid;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'check 6: an empty planting name was REJECTED by a CHECK reached through the sync trigger (%)', SQLERRM;
  END;
  SELECT display_name INTO got FROM public.entity
   WHERE entity_type='planting' AND planting_ref_id=pid AND deleted_at IS NULL;
  IF got IS DISTINCT FROM '(planting)' THEN
    RAISE EXCEPTION 'check 6: empty planting name should mirror as (planting), got %', COALESCE(got,'<no entity row>');
  END IF;

  ---------------------------------------------------------------------------
  -- 7. A no-op rename must not churn entity.version. The trigger has both a
  --    WHEN (OLD.name IS DISTINCT FROM NEW.name) clause and an
  --    IS DISTINCT FROM guard on the UPDATE; this proves at least one bites.
  ---------------------------------------------------------------------------
  DECLARE v0 int; v1 int;
  BEGIN
    SELECT version INTO v0 FROM public.entity WHERE entity_type='cultivar' AND cultivar_ref_id=cid;
    UPDATE public.plant_varieties SET name=name WHERE id=cid;
    SELECT version INTO v1 FROM public.entity WHERE entity_type='cultivar' AND cultivar_ref_id=cid;
    IF v1 IS DISTINCT FROM v0 THEN
      RAISE EXCEPTION 'check 7: a no-op rename bumped entity.version % -> %', v0, v1;
    END IF;
  END;

  ---------------------------------------------------------------------------
  -- 8. prevent_ownership_transfer() must still guard plants. The sync trigger
  --    shares BEFORE/AFTER space with it; assert we did not disturb it.
  ---------------------------------------------------------------------------
  BEGIN
    UPDATE public.plants SET created_by='__someone_else__' WHERE id=pid;
    RAISE EXCEPTION 'check 8: created_by was changed on plants — prevent_ownership_transfer did not fire';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE '%created_by cannot be changed%' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'V4-CULTIVARNAME-001 trigger mechanism: all 8 checks passed (fixture will be rolled back).';
END $$;

ROLLBACK;
