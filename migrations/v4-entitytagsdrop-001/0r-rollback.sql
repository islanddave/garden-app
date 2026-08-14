-- 0r-rollback.sql
-- OPS-ENTITYTAGSDROP-001 — rebuilds everything 0c-drop.sql destroyed.
--
-- ┌─ WHAT THIS FILE RE-CREATES, AND WHY IT IS UNUSUALLY COMPLETE ────────────────────────────────┐
-- │ Rolling back a trigger is dropping a trigger. Rolling back a DROP TABLE is REBUILDING it —   │
-- │ shape, constraints, indexes, row-level security, grants, and the rows themselves. Nothing in │
-- │ Postgres does that for you, so all of it is spelled out below, transcribed from the live     │
-- │ prod catalog on 2026-08-13 (see 0a-evidence.sql block 8, and README.md §CAPTURE RECORD).     │
-- │                                                                                              │
-- │   table            1  — 7 columns, exact types / nullability / defaults                      │
-- │   constraints      3  — pkey, unique, entity_type CHECK (5 types — a WIDER vocabulary than   │
-- │                         the singular table's 4; that difference is real, not a transcription │
-- │                         error, and it is why this file does not borrow the singular CHECK)   │
-- │   indexes          5  — 2 of them created implicitly by the pkey/unique constraints above,   │
-- │                         3 spelled explicitly                                                 │
-- │   RLS              1  — ENABLE (not FORCE), matching relrowsecurity=t relforcerowsecurity=f  │
-- │   policies         3  — select / insert / delete, over current_user_id()                     │
-- │   grants           1  — SELECT to garden_ro, PROD ONLY (see ENV PARITY below)                │
-- │   functions        3  — verbatim bodies from pg_get_functiondef                              │
-- │   triggers         3  — AFTER DELETE FOR EACH ROW, on plants / plant_projects / locations    │
-- │   rows             2  — original ids, created_by and created_at, not regenerated ones        │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- SINGULAR / PLURAL, once more: every object below is the PLURAL `entity_tags` family. The live
-- singular `entity_tag` and its four `trg_guard_entity_tag_*` guards are not named in this file and
-- are not affected by it. The verification block at the end asserts that.
--
-- ── ENV PARITY — the two databases legitimately differ ─────────────────────────────────────────
-- The `garden_ro` read-only role exists in PROD and NOT in staging, and the staging copy of this
-- table carried no ACL at all. A bare `GRANT ... TO garden_ro` would therefore fail on staging with
-- 42704 undefined_object and abort the rollback in the middle. The grant is wrapped in a role-
-- existence check so this one file is correct on both environments. Do not "simplify" it.
--
-- ── WHAT ROLLING BACK RE-ARMS ──────────────────────────────────────────────────────────────────
-- Nothing dangerous, and that asymmetry is worth stating: unlike v4-entitytagorphan-001's rollback,
-- which re-arms a real defect, this one restores a table nothing reads and three triggers that
-- protect nothing. The reason to run it is not safety — it is that a rollback path which has never
-- been executed is a rollback path that does not exist. Rehearse it on staging (apply 0c, run this,
-- confirm the counts below, re-apply 0c) before 0c is applied to prod.
--
-- ── ORDER IS THE INVERSE OF 0c, PLUS THE PARTS 0c GOT FOR FREE ─────────────────────────────────
-- table -> constraints -> indexes -> rows -> RLS -> policies -> grant -> functions -> triggers.
-- Rows go in BEFORE RLS is enabled. The table owner bypasses RLS here anyway (relforcerowsecurity
-- is false), but ordering it this way means the insert does not depend on that being true.
--
-- The 0c schema_version row is left in place on purpose: it is an applied-history log, not a state
-- flag. gates.yml keys on the catalog, not on that row, so a rolled-back database reports honestly.
--
-- RUN:  psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-entitytagsdrop-001/0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. TABLE + 3 CONSTRAINTS ──────────────────────────────────────────────────────────────────
-- Constraint names are spelled explicitly rather than left to Postgres' auto-naming, so the
-- restored catalog is byte-identical to what 0c removed rather than merely equivalent.
CREATE TABLE public.entity_tags (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  entity_type text        NOT NULL,
  entity_id   text        NOT NULL,
  tag_key     text        NOT NULL,
  tag_value   text,
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_tags_pkey PRIMARY KEY (id),
  CONSTRAINT entity_tags_entity_type_entity_id_tag_key_key
    UNIQUE (entity_type, entity_id, tag_key),
  -- FIVE types. The singular entity_tag admits four ('plant','cultivar','location','project');
  -- this legacy table admits 'project','plant','location','event','inventory_item'. Transcribed
  -- from pg_get_constraintdef, not adapted from its successor.
  CONSTRAINT entity_tags_entity_type_check CHECK (
    entity_type = ANY (ARRAY['project'::text, 'plant'::text, 'location'::text,
                             'event'::text, 'inventory_item'::text])
  )
);

-- ── 2. THE 3 NON-CONSTRAINT INDEXES ───────────────────────────────────────────────────────────
-- entity_tags_pkey and entity_tags_entity_type_entity_id_tag_key_key already exist, created
-- implicitly by the two constraints above. These three are the standalone ones.
CREATE INDEX idx_entity_tags_entity     ON public.entity_tags USING btree (entity_type, entity_id);
CREATE INDEX idx_entity_tags_key_value  ON public.entity_tags USING btree (tag_key, tag_value);
CREATE INDEX idx_entity_tags_created_by ON public.entity_tags USING btree (created_by);

-- ── 3. THE 2 ROWS, verbatim ───────────────────────────────────────────────────────────────────
-- Original ids, created_by and created_at — not regenerated. Both are v2 smoke-suite debris from
-- 2026-05-01, pointing at container 896fd584-1e6b-4c10-a60f-dbe885a3f860. Captured by
-- 0a-evidence.sql block 1b and reproduced in README.md §CAPTURE RECORD.
INSERT INTO public.entity_tags (id, entity_type, entity_id, tag_key, tag_value, created_by, created_at)
VALUES
  ('e8a90807-4743-4019-be80-5865c42ddb92', 'project',
   '896fd584-1e6b-4c10-a60f-dbe885a3f860', 'smoke-v2-a', 'hello',
   'user_3D2gM0hIl03gjW3JM2DjtPzm0jI', '2026-05-01 14:47:40.724242+00'::timestamptz),
  ('e4a5e4e7-db91-41e7-aaca-d1071a158e63', 'project',
   '896fd584-1e6b-4c10-a60f-dbe885a3f860', 'smoke-v2-b', 'world',
   'user_3D2gM0hIl03gjW3JM2DjtPzm0jI', '2026-05-01 14:47:40.920969+00'::timestamptz);

-- ── 4. RLS + THE 3 POLICIES ───────────────────────────────────────────────────────────────────
-- ENABLE, not FORCE: the live table had relrowsecurity=t, relforcerowsecurity=f. All three
-- policies are permissive and apply TO PUBLIC (pg_policy.polroles was empty), so no TO clause.
ALTER TABLE public.entity_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY entity_tags_select ON public.entity_tags
  FOR SELECT USING (current_user_id() IS NOT NULL);

CREATE POLICY entity_tags_insert ON public.entity_tags
  FOR INSERT WITH CHECK (created_by = current_user_id());

CREATE POLICY entity_tags_delete ON public.entity_tags
  FOR DELETE USING (created_by = current_user_id());

-- ── 5. GRANT — prod only, guarded (see ENV PARITY in the header) ──────────────────────────────
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garden_ro') THEN
    GRANT SELECT ON public.entity_tags TO garden_ro;
    RAISE NOTICE 'garden_ro exists — SELECT granted (prod shape restored)';
  ELSE
    RAISE NOTICE 'garden_ro does not exist here — grant skipped (staging shape, correct)';
  END IF;
END
$grant$;

-- ── 6. THE 3 FUNCTIONS, verbatim from pg_get_functiondef ──────────────────────────────────────
-- Unqualified `entity_tags` in each body is as-authored. It resolves through search_path, which is
-- why these bodies survived the /api/entity-tags route removal without anyone noticing them.
CREATE OR REPLACE FUNCTION public.delete_entity_tags_for_plant()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM entity_tags WHERE entity_type = 'plant' AND entity_id = OLD.id::TEXT;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_entity_tags_for_project()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM entity_tags WHERE entity_type = 'project' AND entity_id = OLD.id::TEXT;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_entity_tags_for_location()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM entity_tags WHERE entity_type = 'location' AND entity_id = OLD.id::TEXT;
  RETURN OLD;
END;
$function$;

-- ── 7. THE 3 TRIGGERS ─────────────────────────────────────────────────────────────────────────
-- AFTER DELETE FOR EACH ROW, matching pg_get_triggerdef exactly.
CREATE TRIGGER trg_delete_entity_tags_plant
  AFTER DELETE ON public.plants
  FOR EACH ROW EXECUTE FUNCTION delete_entity_tags_for_plant();

CREATE TRIGGER trg_delete_entity_tags_project
  AFTER DELETE ON public.plant_projects
  FOR EACH ROW EXECUTE FUNCTION delete_entity_tags_for_project();

CREATE TRIGGER trg_delete_entity_tags_location
  AFTER DELETE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION delete_entity_tags_for_location();

-- ── 8. VERIFY THE REBUILD IS COMPLETE, before committing ──────────────────────────────────────
DO $verify$
DECLARE
  v_rows      bigint;
  v_cols      int;
  v_cons      int;
  v_idx       int;
  v_pol       int;
  v_rls       boolean;
  v_fns       int;
  v_trg       int;
  v_guards    int;
  v_singular  bigint;
BEGIN
  SELECT count(*) INTO v_rows FROM public.entity_tags;
  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'entity_tags';
  SELECT count(*) INTO v_cons FROM pg_constraint
   WHERE conrelid = 'public.entity_tags'::regclass;
  SELECT count(*) INTO v_idx FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'entity_tags';
  SELECT count(*) INTO v_pol FROM pg_policy WHERE polrelid = 'public.entity_tags'::regclass;
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.entity_tags'::regclass;
  SELECT count(*) INTO v_fns FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname LIKE 'delete\_entity\_tags\_for\_%';
  SELECT count(*) INTO v_trg FROM pg_trigger
   WHERE NOT tgisinternal AND tgname LIKE 'trg\_delete\_entity\_tags\_%';

  IF v_rows <> 2 OR v_cols <> 7 OR v_cons <> 3 OR v_idx <> 5 OR v_pol <> 3
     OR v_rls IS NOT TRUE OR v_fns <> 3 OR v_trg <> 3 THEN
    RAISE EXCEPTION
      'ROLLBACK INCOMPLETE: rows=% (2) cols=% (7) constraints=% (3) indexes=% (5) policies=% (3) '
      'rls=% (t) functions=% (3) triggers=% (3)',
      v_rows, v_cols, v_cons, v_idx, v_pol, v_rls, v_fns, v_trg
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The singular side was never in scope here either. Assert it anyway — this file names three
  -- triggers whose spelling is one character from the live tag system's.
  SELECT count(*) INTO v_guards FROM pg_trigger g
   WHERE NOT g.tgisinternal
     AND g.tgname IN ('trg_guard_entity_tag_plant',   'trg_guard_entity_tag_project',
                      'trg_guard_entity_tag_location','trg_guard_entity_tag_cultivar');
  SELECT count(*) INTO v_singular FROM public.entity_tag;
  IF v_guards <> 4 THEN
    RAISE EXCEPTION 'SINGULAR entity_tag guards are % of 4 — investigate before committing', v_guards
      USING ERRCODE = 'raise_exception';
  END IF;

  RAISE NOTICE 'ROLLBACK OK — entity_tags rebuilt: 2 rows, 7 cols, 3 constraints, 5 indexes, '
               '3 policies, RLS on, 3 functions, 3 triggers';
  RAISE NOTICE 'SINGULAR entity_tag untouched: % row(s), 4/4 guards', v_singular;
END
$verify$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.11-entitytagsdrop-001-rollback',
  'ROLLBACK of 4.23.11-entitytagsdrop-001: rebuilds the legacy PLURAL entity_tags table (7 cols, '
  '3 constraints, 5 indexes, RLS + 3 policies, garden_ro grant where the role exists), re-inserts '
  'its 2 original smoke rows with their original ids and timestamps, and restores the three '
  'delete_entity_tags_for_* functions and their AFTER DELETE triggers. The SINGULAR entity_tag '
  'table is untouched.')
ON CONFLICT DO NOTHING;

COMMIT;
