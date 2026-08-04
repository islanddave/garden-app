-- 0a-name-sync-triggers.sql
-- V4-CULTIVARNAME-001 step A — close the entity-mirror UPDATE hole.
--
-- ADDITIVE ONLY. Creates two functions + two AFTER UPDATE OF name triggers. No column is added,
-- no constraint is created or validated, no row is written. Safe to apply ahead of any deploy:
-- the currently-deployed writers (lambda/varieties/index.js, lambda/plants/index.js) are unchanged
-- and unaware of these triggers; all they gain is a side effect that makes their existing writes
-- correct. This is the "widen before you narrow" side of the sequencing rule, not the narrow side —
-- nothing here can reject a write that previously succeeded (see the CHECK analysis below).
--
-- THE BUG. `entity` is a trigger-maintained mirror of the identity of every plant_varieties row
-- (entity_type='cultivar') and every plants row (entity_type='planting'). Three lifecycle events
-- exist; only two were covered:
--     INSERT        -> gv.entity_cultivar_ins / gv.entity_planting_ins        [covered]
--     soft-DELETE   -> gv.entity_cultivar_softdel / gv.entity_planting_softdel [covered]
--     name UPDATE   -> nothing                                                 [THE HOLE]
-- so display_name was written exactly once, at insert, and never again.
--
-- This is not a manual-SQL accident. The app's own rename path reproduces it every time: the API
-- writes through the auto-updatable views (`UPDATE public.cultivar SET display_name=…` at
-- lambda/varieties/index.js:232, `UPDATE public.garden_node SET display_name=…` in
-- lambda/plants/index.js), which resolve to plant_varieties.name / plants.name — and nothing has
-- ever propagated to the mirror. Verified against prod 2026-08-04: 7 cultivar rows and 21 planting
-- rows already carry a display_name that disagrees with their source. Every one of those
-- entity rows still has updated_at = created_at.
--
-- WHY A TRIGGER AND NOT A WRITER FIX. The mirror is already trigger-maintained on its other two
-- edges. Putting the third edge in the application would split one invariant across two
-- enforcement layers and leave direct-SQL writes (migrations, backfills, this very file) outside
-- it — which is exactly how the drift started. One mechanism, all three edges.
--
-- WHY THIS CANNOT REJECT A WRITE. `entity_dname_nonempty` CHECKs length(btrim(display_name)) > 0.
-- Both functions below reuse the INSERT triggers' COALESCE(NULLIF(btrim(NEW.name),''),'(…)')
-- fallback verbatim, so a blank/whitespace name lands the same literal the insert path would have
-- and the CHECK is satisfied by construction. plant_varieties.name and plants.name are both NOT
-- NULL, so NULL is not reachable either. No new failure mode is introduced.
--
-- NO RECURSION. entity's only trigger is gv.entity_bump (BEFORE UPDATE, version bump); it writes
-- nothing back to plants or plant_varieties. Depth is 1.
--
-- OWNERSHIP TRIGGER. prevent_ownership_transfer() sits on plants (BEFORE UPDATE) and raises when
-- created_by changes. Nothing here touches created_by on any table, and `entity` has no created_by
-- column at all, so the trigger is never provoked and must NOT be disabled for this migration.
--
-- SCOPE. Each trigger updates at most ONE entity row, matched on the uuid ref (cultivar_ref_id /
-- planting_ref_id), and only when the value actually differs — so a no-op rename does not churn
-- entity.version. If no live mirror row exists (possible: the INSERT triggers use
-- ON CONFLICT DO NOTHING), the UPDATE matches nothing and returns quietly. That matches existing
-- semantics; a missing mirror row is a separate concern and is deliberately not created here.

BEGIN;

CREATE OR REPLACE FUNCTION gv.entity_cultivar_rename()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE entity
     SET display_name = COALESCE(NULLIF(btrim(NEW.name),''),'(cultivar)')
   WHERE entity_type = 'cultivar'
     AND cultivar_ref_id = NEW.id
     AND deleted_at IS NULL
     AND display_name IS DISTINCT FROM COALESCE(NULLIF(btrim(NEW.name),''),'(cultivar)');
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION gv.entity_planting_rename()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE entity
     SET display_name = COALESCE(NULLIF(btrim(NEW.name),''),'(planting)')
   WHERE entity_type = 'planting'
     AND planting_ref_id = NEW.id
     AND deleted_at IS NULL
     AND display_name IS DISTINCT FROM COALESCE(NULLIF(btrim(NEW.name),''),'(planting)');
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS plant_varieties_entity_rename ON public.plant_varieties;
CREATE TRIGGER plant_varieties_entity_rename
  AFTER UPDATE OF name ON public.plant_varieties
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION gv.entity_cultivar_rename();

DROP TRIGGER IF EXISTS plants_entity_rename ON public.plants;
CREATE TRIGGER plants_entity_rename
  AFTER UPDATE OF name ON public.plants
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION gv.entity_planting_rename();

INSERT INTO public.schema_version (version, description)
VALUES ('4.21.3-cultivarname-001-namesync',
        'V4-CULTIVARNAME-001: AFTER UPDATE OF name triggers on plant_varieties and plants that propagate a rename to entity.display_name. Closes the one uncovered edge of the entity mirror (INSERT and soft-delete were already trigger-maintained); the app renames through the auto-updatable cultivar/garden_node views, so every UI rename silently drifted the mirror. Additive, no constraint, cannot reject a write.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
