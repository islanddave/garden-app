-- 0c-guard.sql
-- BUG-ENTITYTAGORPHAN-001 — the POLYMORPHIC edge. entity_tag.entity_id carries no foreign key and
-- no working cleanup, so a hard parent delete orphans user-authored tag associations permanently.
-- THE FIX.
--
-- ┌─ THE DEFECT ────────────────────────────────────────────────────────────────────────────────┐
-- │ entity_tag is polymorphic: (entity_type, entity_id) where entity_type is CHECK-constrained   │
-- │ to 'plant' | 'cultivar' | 'location' | 'project'. entity_id is a bare uuid — no FK is        │
-- │ POSSIBLE, because the column points into four different tables depending on a sibling        │
-- │ column. Postgres cannot express that, so nothing at the database level has ever stopped a    │
-- │ parent from being deleted out from under its tags.                                          │
-- │                                                                                             │
-- │ Three AFTER DELETE triggers LOOK like they cover it:                                        │
-- │   plants          trg_delete_entity_tags_plant    -> delete_entity_tags_for_plant()          │
-- │   plant_projects  trg_delete_entity_tags_project  -> delete_entity_tags_for_project()        │
-- │   locations       trg_delete_entity_tags_location -> delete_entity_tags_for_location()       │
-- │ Every one of them deletes from `entity_tags` — the LEGACY PLURAL debris table, 2 rows, which │
-- │ the frontend stopped writing long ago. They do not touch `entity_tag` (singular), which is   │
-- │ the live table holding every real association. They are no-ops wearing the costume of a      │
-- │ guarantee.                                                                                  │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- MEASURED, live prod 2026-08-13, owner DSN (RLS-exempt), unfiltered by deleted_at:
--   * entity_tag: 1,016 rows total, 989 live. The audit's headline "989 user-authored associations"
--     was the LIVE count; the orphan question is about all 1,016.
--   * ALL 1,016 are entity_type='cultivar'. Zero plant, zero location, zero project rows.
--     So the three cleanup triggers that exist cover entity types with NO tags, and the one type
--     holding EVERY tag has no trigger at all. That inversion is the finding.
--   * 412 distinct cultivars are tagged, out of 424 total.
--   * ORPHANS TODAY: 0, across all four types.
--
-- WHY ZERO ORPHANS, AND WHY THAT IS NOT REASSURING. Hard-deleting a cultivar is currently refused
-- because `entity.cultivar_ref_id` is ON DELETE RESTRICT (from DRG-ENGINE-002, an unrelated ticket)
-- and a trigger auto-registers an `entity` row for every cultivar — all 424 have one. That is
-- INCIDENTAL PROTECTION: a side effect of someone else's FK, not a policy about tags. It is also
-- routinely defeated in two statements, and the staging smoke purge does exactly that today:
--     DELETE FROM entity WHERE entity_type='cultivar' AND cultivar_ref_id IN (...);  -- :606
--     DELETE FROM plant_varieties WHERE name ILIKE '%smoke%';                        -- :607
-- Delete the registry row first and the cultivar becomes freely deletable, taking its tags'
-- referents with it. The V4-SOFTDELCASCADE-001 audit named this exact pattern when it found 29 of
-- 74 containers "incidentally protected" and refused to count it: protection that nobody chose can
-- be removed by someone who never knew they had it.
--
-- ── THE MECHANISM: a polymorphic foreign key, spelled as a trigger ─────────────────────────────
-- This migration adds ONE function and FOUR BEFORE DELETE triggers, one per parent table. The
-- function raises SQLSTATE 23503 — foreign_key_violation, deliberately the SAME code a real FK
-- raises — when the row being deleted still has entity_tag rows pointing at it. It reads; it never
-- writes. It is a foreign key in every respect except that Postgres cannot be told about it.
--
-- IT GUARDS ALL ROWS, NOT JUST LIVE ONES, and that is the load-bearing choice here. The previous
-- migration in this family put it best in its sweep gates: *a foreign key does not know what a soft
-- delete is*. A soft-deleted association still names a parent, and V4-SOFTDEL-001's second promise
-- is that all data stays RECOVERABLE — an association whose referent no longer exists cannot be
-- restored, only resurrected as a dangling pointer. Guarding only `deleted_at IS NULL` would leave
-- the orphan count creeping upward invisibly and would make the zero-orphans gate below untrue over
-- time. The invariant worth having is the absolute one: NO entity_tag row may ever name a parent
-- that does not exist.
--
-- ── WHY NOT THE ALTERNATIVES ───────────────────────────────────────────────────────────────────
--   * Fix the three existing triggers to target `entity_tag` instead of `entity_tags` — rejected,
--     and it is the tempting wrong answer. It would make them CASCADE user-authored content on a
--     parent delete, which is precisely what Soft-Delete-Only forbids; today they are harmless only
--     because they hit an empty table. Correcting their aim without changing their verb would turn
--     three dead no-ops into three live destroyers of 1,016 rows.
--   * AFTER DELETE trigger that soft-deletes the associations — rejected for the reason
--     V4-SOFTDELCASCADE-001 gave when it rejected auto-archiving: it leaves the destructive action
--     in place and merely arranges that the damage is tidier. It also still produces orphans; they
--     just carry a deleted_at.
--   * Split entity_id into four typed, nullable FK columns with a one-of CHECK — the genuinely
--     correct schema, and rejected on proportionality rather than merit. It needs a data migration
--     of 1,016 rows and a rewrite of every read path in lambda/tags/index.js, where the polymorphic
--     shape is load-bearing (the GARDENIA bulk mode joins on entity_type/entity_id directly). Worth
--     revisiting if a fifth entity type is ever added; recorded here so the option is not lost.
--   * Rely on entity.cultivar_ref_id RESTRICT — rejected: see "incidental protection" above. It
--     covers one of four types, by accident, and the purge already routes around it.
--   * Drop the legacy `entity_tags` table and its three dead triggers — CORRECT, but it belongs to
--     OPS-ENTITYTAGSDROP-001, which carries its own deploy-before-drop ordering. Not folded in: a
--     table drop is not reversible the way a trigger is, and this migration should stay revertible
--     by deleting four triggers and a function. The dead triggers are left in place and are now
--     visibly redundant beside the real guards.
--
-- ── DEPLOY BOUNDARY — the falsifiable test, answered ───────────────────────────────────────────
-- QUESTION: would the CURRENTLY DEPLOYED prod code perform a delete this guard now refuses?
-- METHOD: all 27 deployed prod Lambda bundles were downloaded (aws lambda get-function
-- Code.Location, staging excluded) and grepped for `DELETE FROM` earlier today against prod at
-- 5c232164616228dfce4f3e669ef8011a2cf7a456 (v4.14.0).
-- RESULT: the only real DELETE statements in deployed prod code are `DELETE FROM favorites` and
-- `DELETE FROM public.entity_memory`. NEITHER is a parent of entity_tag. Every app DELETE route on
-- plants, plant_projects, locations and varieties soft-deletes.
-- ANSWER: NO. No deployed writer hard-deletes any of the four parents, so no deployed behaviour
-- changes. Safe to apply before or after a code deploy.
--
-- COMPANION EDITS, shipped in the same commit — these are the callers that DO hard-delete:
--   1. .github/workflows/deploy-staging.yml smoke purge — sweeps entity_tag for smoke entities
--      before deleting plants/varieties/locations/projects. A 0-row no-op today (smoke runs create
--      no tags), so it is insurance against a future smoke path that does.
--   2. tests/integration/_cleanup.js — the namespace sweep never included entity_tag at all.
--   The two integration suites that DO create entity_tag rows (tags-authz, crop-types) already
--   delete them first, forced there by entity_tag.tag_id -> tag(id) being RESTRICT. Verified by
--   reading, then by running the full suite with this migration live.
--
-- REVERSIBILITY: four triggers and one function. 0r drops them; no row is read, written or moved.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- The guard. TG_ARGV[0] carries the entity_type this parent table corresponds to, so one function
-- serves all four triggers and there is exactly one place for the predicate to be wrong.
--
-- ERRCODE 23503 is deliberate: callers that already handle a foreign-key refusal from the real
-- RESTRICTs on this schema (and the integration suites that assert '23503') treat this identically.
-- A bespoke code would make a polymorphic FK look like a different kind of failure than a declared
-- one, which is exactly the distinction this migration exists to erase.
--
-- READ-ONLY BY CONSTRUCTION. This function must never INSERT, UPDATE or DELETE. A BEFORE DELETE
-- trigger that modifies rows can defuse a downstream RESTRICT before it fires — leaving the
-- constraint looking armed while it silently guards nothing. gates.yml asserts this property
-- against prosrc rather than trusting this comment.
CREATE OR REPLACE FUNCTION public.guard_entity_tag_parent_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_type  text := TG_ARGV[0];
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.entity_tag et
   WHERE et.entity_type = v_type
     AND et.entity_id   = OLD.id;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'cannot delete % % — % entity_tag association(s) still reference it',
      v_type, OLD.id, v_count
      -- The HINT deliberately does NOT spell the escape-hatch statement out. prosrc is what the
      -- read-only gate greps, and a literal write statement inside a string would make that gate
      -- unable to tell a comment from a body. The exact statement lives in COMMENT ON FUNCTION
      -- below and in README §Escape hatch, where no gate has to parse around it.
      USING ERRCODE = '23503',
            TABLE   = 'entity_tag',
            HINT    = 'Withdraw the associations first, on purpose: remove the public.entity_tag '
                   || 'rows matching entity_type = ''' || v_type || ''' and entity_id = '''
                   || OLD.id || ''', then retry. See COMMENT ON FUNCTION '
                   || 'guard_entity_tag_parent_delete() for the statement.';
  END IF;

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.guard_entity_tag_parent_delete() IS
  'BUG-ENTITYTAGORPHAN-001. Polymorphic foreign key for entity_tag.entity_id, which cannot carry a '
  'declared FK because its referent table is chosen by entity_type. Raises 23503 on a parent delete '
  'that would orphan associations. Counts ALL rows, not just live ones: a foreign key does not know '
  'what a soft delete is. MUST stay read-only — see gates.yml post_guard_function_is_read_only. '
  'ESCAPE HATCH, the statement the HINT refers to: '
  'DELETE FROM public.entity_tag WHERE entity_type = $type AND entity_id = $id;';

-- Four parents, one per entity_type admitted by entity_tag_entity_type_check. If that CHECK ever
-- gains a fifth type, the new parent needs a trigger here — gates.yml asserts the two lists agree.
CREATE TRIGGER trg_guard_entity_tag_plant
  BEFORE DELETE ON public.plants
  FOR EACH ROW EXECUTE FUNCTION public.guard_entity_tag_parent_delete('plant');

CREATE TRIGGER trg_guard_entity_tag_project
  BEFORE DELETE ON public.plant_projects
  FOR EACH ROW EXECUTE FUNCTION public.guard_entity_tag_parent_delete('project');

CREATE TRIGGER trg_guard_entity_tag_location
  BEFORE DELETE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.guard_entity_tag_parent_delete('location');

-- The one that actually matters today: all 1,016 associations are cultivar-typed, and this is the
-- parent that had no cleanup trigger of any kind. Note that `cultivar` is a VIEW over
-- plant_varieties; a DELETE through the view is rewritten onto the base table, so this row trigger
-- fires for both spellings. The integration suite exercises the view spelling specifically.
CREATE TRIGGER trg_guard_entity_tag_cultivar
  BEFORE DELETE ON public.plant_varieties
  FOR EACH ROW EXECUTE FUNCTION public.guard_entity_tag_parent_delete('cultivar');

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.8-entitytagorphan-001',
  'ENTITYTAGORPHAN fix: polymorphic guard for entity_tag.entity_id, which can carry no declared FK. '
  'BEFORE DELETE triggers on plants/plant_projects/locations/plant_varieties raise 23503 rather than '
  'orphaning associations. All 1016 live rows are cultivar-typed and plant_varieties had NO cleanup '
  'trigger, while the three that existed targeted the legacy 2-row entity_tags table for entity '
  'types with zero tags. Previously protected only incidentally by entity.cultivar_ref_id RESTRICT, '
  'which the staging purge already routes around. Counts all rows regardless of deleted_at. '
  'No row data touched.')
ON CONFLICT DO NOTHING;

COMMIT;
