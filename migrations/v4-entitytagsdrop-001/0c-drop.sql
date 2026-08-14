-- 0c-drop.sql
-- OPS-ENTITYTAGSDROP-001 — remove the legacy PLURAL `entity_tags` debris table and the three
-- AFTER DELETE triggers that were its only remaining writers. THE DESTRUCTIVE STEP.
--
-- ┌─ READ THIS BEFORE YOU READ ANYTHING ELSE ───────────────────────────────────────────────────┐
-- │ TWO TABLES DIFFER BY ONE CHARACTER.                                                          │
-- │                                                                                              │
-- │   entity_tags   PLURAL   — the subject. 7 columns, 2 rows of May-2026 smoke debris, no FKs,  │
-- │                            no views, no live SQL. Superseded by v4-tagsub. THIS IS DROPPED.  │
-- │   entity_tag    SINGULAR — the LIVE faceted tag system. 1,016 rows in prod, ALL of them      │
-- │                            entity_type='cultivar', 412 of 424 cultivars tagged. It carries   │
-- │                            the four BEFORE DELETE polymorphic-FK guards installed one day    │
-- │                            ago by v4-entitytagorphan-001. IT IS NOT TOUCHED BY THIS FILE.    │
-- │                                                                                              │
-- │ Every statement below is spelled with the trailing `s`. The preflight block asserts the      │
-- │ singular side is intact BEFORE anything drops, and the postflight block asserts it is STILL  │
-- │ intact — including its exact row count, captured into a variable and re-compared — so a      │
-- │ one-character error aborts the transaction instead of destroying the tag system.             │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- ── WHY THIS IS SAFE TO DROP ───────────────────────────────────────────────────────────────────
-- The plural table was superseded by v4-tagsub, which says so in its own header: "replace the flat
-- single-row entity_tags model with a normalized, faceted tag system" (0a-additive-ddl.sql:4) and
-- "Supersedes flat entity_tags" (:124). The frontend routes ALL /api/entity-tags traffic to the tags
-- Lambda, which uses the singular table exclusively. The last server-side consumer — the
-- /api/entity-tags block in the locations Lambda — was removed on 2026-07-28 (data-audit P1-code)
-- and replaced with an explicit 404 tombstone, pinned by lambda/locations/entity-tags-removed.test.js.
-- That test's own header states the ordering this migration completes:
--     "Removal ships BEFORE the entity_tags table drop (P1-data), per plan deploy-before-drop order."
-- The code half shipped two weeks ago and is live in prod. This is the data half.
--
-- ── THE THREE TRIGGERS, AND WHY THEY GO WITH IT ────────────────────────────────────────────────
--   plants          trg_delete_entity_tags_plant    AFTER DELETE -> delete_entity_tags_for_plant()
--   plant_projects  trg_delete_entity_tags_project  AFTER DELETE -> delete_entity_tags_for_project()
--   locations       trg_delete_entity_tags_location AFTER DELETE -> delete_entity_tags_for_location()
--
-- Each body is one statement: DELETE FROM entity_tags WHERE entity_type='<t>' AND entity_id=OLD.id.
-- They are DEAD AS GUARANTEES — they protect the singular table not at all, which is the entire
-- finding of BUG-ENTITYTAGORPHAN-001 — but they are LIVE OBJECTS that fire on every hard delete of
-- a planting, container or location. Leaving them behind a dropped table would turn every such
-- delete into a 42P01 undefined_table error. They are not optional cleanup; they are load-bearing
-- for this drop and must go in the same transaction.
--
-- ── ORDER IS FK/DEPENDENCY ORDER, AND IT IS NOT COSMETIC ───────────────────────────────────────
--   1. triggers   — a function cannot be dropped while a trigger depends on it (Postgres refuses).
--   2. functions  — dropped by their EXACT identity signature, re-verified from pg_proc in the
--                   preflight below. All three take zero arguments and none is overloaded, so
--                   `()` is correct TODAY; the preflight is what makes that a checked fact rather
--                   than an inherited assumption. A bare name would fail on an overload.
--   3. the table  — last, and with a PLAIN `DROP TABLE`. Deliberately NOT `CASCADE`.
--
-- ── WHY NO `CASCADE`, AND WHY NO `IF EXISTS` ───────────────────────────────────────────────────
-- `CASCADE` would silently absorb a dependency the sweep missed. The dependency inventory (0a
-- blocks 5a-5d, mirrored as gates.yml `sweep`) says nothing depends on this table: zero incoming
-- FKs, zero dependent views, zero triggers on it. The plain form is the ASSERTION that the sweep
-- was right. If it fails, that is INFORMATION — stop, read what Postgres names, and amend the
-- migration. It is not an obstacle to route around by adding CASCADE.
--
-- `IF EXISTS` is omitted for the same reason, and it is the more important of the two. `DROP
-- TRIGGER IF EXISTS trg_delete_entity_tag_plant` — one character short — succeeds silently and
-- ships green with the real trigger still armed against a dropped table. Bare DROPs make every
-- name in this file a checked claim. (This is a deliberate deviation from the recon's spelling,
-- which used IF EXISTS throughout; the preflight makes idempotence unnecessary — after 0r restores
-- the objects, this file re-applies cleanly, which is exactly when re-running is legitimate.)
--
-- ── DEPLOY BOUNDARY — the falsifiable test, answered ───────────────────────────────────────────
-- QUESTION: would the CURRENTLY DEPLOYED prod code touch `entity_tags` after this runs?
-- METHOD: the plural name was swept across the whole repo (`rg -uuu`, node_modules and .git
-- excluded) at c509fff4aec0225553228d8169dde77e68ae2903 = main = prod v4.16.0.
-- RESULT: every remaining hit is a COMMENT, a test asserting the name's ABSENCE, or a historical
-- migration. Zero live SQL in any of the 26 Lambda directories. The one file that names it in an
-- executable context — lambda/locations/entity-tags-removed.test.js — asserts the SQL is *gone*,
-- so it gets greener, not redder, from this drop.
-- ANSWER: NO. There is no pre-deploy/post-deploy split. Safe to apply before or after a code
-- deploy, and the code half already shipped two weeks ahead of it by design.
--
-- ── WHAT IS LOST, STATED PLAINLY ───────────────────────────────────────────────────────────────
-- Two rows, both created 2026-05-01 14:47 UTC by the v2 smoke suite, tag_key 'smoke-v2-a' and
-- 'smoke-v2-b', both pointing at one container. Their full contents are captured verbatim in
-- README.md §CAPTURE RECORD and are re-inserted by 0r-rollback.sql. No user-authored data exists in
-- this table and none ever will: the writer was removed two weeks ago.
--
-- REVERSIBILITY: 0r-rollback.sql rebuilds the table, its 3 constraints, its 5 indexes, its RLS
-- flag and 3 policies, the garden_ro grant (prod only — the role does not exist on staging), the
-- three functions and the three triggers, and re-inserts both rows with their original ids and
-- timestamps. Rehearse it on staging before applying here; a rollback path that has never been
-- executed is a rollback path that does not exist.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- PREFLIGHT. Every precondition this migration was authored against, re-asserted at apply time
-- against the live catalog. The recon that produced this file was read-only and correct at a SHA;
-- it is a hypothesis about the database in front of you now. Anything unexpected aborts before a
-- single object is dropped.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
DO $preflight$
DECLARE
  v_plural_rows      bigint;
  v_triggers         int;
  v_functions        int;
  v_overloaded       int;
  v_incoming_fks     int;
  v_dependent_views  int;
  v_triggers_on_it   int;
  v_singular_present int;
  v_singular_guards  int;
  v_singular_rows    bigint;
BEGIN
  -- 1. The subject exists, and is the plural one.
  IF to_regclass('public.entity_tags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.entity_tags (PLURAL) does not exist'
      USING ERRCODE = '42P01',
            DETAIL  = 'Nothing to drop. Either this migration already ran, or you are pointed at '
                      'the wrong database.',
            HINT    = 'Check schema_version for 4.23.11-entitytagsdrop-001 before re-running.';
  END IF;

  -- 2. It is still debris. 2 rows at authoring time; anything more means something started writing
  --    to a table this migration is about to destroy, and that changes the decision, not the plan.
  SELECT count(*) INTO v_plural_rows FROM public.entity_tags;
  IF v_plural_rows > 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.entity_tags holds % rows (expected <= 2)',
      v_plural_rows
      USING ERRCODE = 'raise_exception',
            DETAIL  = 'The 2 known rows are May-2026 smoke debris. Extra rows mean a live writer.',
            HINT    = 'Capture them (0a-evidence.sql) and re-decide before dropping anything.';
  END IF;

  -- 3. Exactly the three legacy triggers, on exactly the three expected tables.
  SELECT count(*) INTO v_triggers
    FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid
   WHERE NOT g.tgisinternal
     AND g.tgname IN ('trg_delete_entity_tags_plant',
                      'trg_delete_entity_tags_project',
                      'trg_delete_entity_tags_location')
     AND t.relname IN ('plants', 'plant_projects', 'locations');
  IF v_triggers <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected 3 legacy entity_tags triggers, found %',
      v_triggers
      USING ERRCODE = 'raise_exception',
            HINT    = 'Run 0a-evidence.sql block 3 and reconcile before proceeding.';
  END IF;

  -- 4. Exactly three zero-argument functions, none overloaded. This is what makes the `()` in the
  --    DROP FUNCTION statements below a checked fact rather than an inherited assumption.
  SELECT count(*) INTO v_functions
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname IN ('delete_entity_tags_for_plant',
                       'delete_entity_tags_for_project',
                       'delete_entity_tags_for_location');
  SELECT count(*) INTO v_overloaded
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname IN ('delete_entity_tags_for_plant',
                       'delete_entity_tags_for_project',
                       'delete_entity_tags_for_location')
     AND pg_get_function_identity_arguments(p.oid) <> '';
  IF v_functions <> 3 OR v_overloaded <> 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected 3 zero-arg functions, found % (% with arguments)',
      v_functions, v_overloaded
      USING ERRCODE = 'raise_exception',
            DETAIL  = 'DROP FUNCTION below names each signature as name(). An overload breaks that.',
            HINT    = 'Run 0a-evidence.sql block 4 for the exact regprocedure signatures.';
  END IF;

  -- 5. The dependency sweep the plain DROP TABLE asserts. Checked here so the failure names the
  --    dependency instead of surfacing as a bare 2BP01 at the end of the file.
  SELECT count(*) INTO v_incoming_fks
    FROM pg_constraint WHERE confrelid = 'public.entity_tags'::regclass;
  SELECT count(DISTINCT v.oid) INTO v_dependent_views
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class v ON v.oid = r.ev_class
   WHERE d.refobjid = 'public.entity_tags'::regclass AND v.relname <> 'entity_tags';
  SELECT count(*) INTO v_triggers_on_it
    FROM pg_trigger WHERE tgrelid = 'public.entity_tags'::regclass AND NOT tgisinternal;
  IF v_incoming_fks <> 0 OR v_dependent_views <> 0 OR v_triggers_on_it <> 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: entity_tags has dependents (fks=%, views=%, triggers=%)',
      v_incoming_fks, v_dependent_views, v_triggers_on_it
      USING ERRCODE = 'raise_exception',
            DETAIL  = 'The plain DROP TABLE below is the assertion that nothing depends on it.',
            HINT    = 'Do NOT add CASCADE. Read what depends on it and amend the migration.';
  END IF;

  -- 6. !! THE SINGULAR SIDE. The live tag system must be present and fully guarded BEFORE we
  --    start dropping things whose names differ from its by one character.
  SELECT count(*) INTO v_singular_present
    FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'entity_tag';
  SELECT count(*) INTO v_singular_guards
    FROM pg_trigger g
   WHERE NOT g.tgisinternal
     AND g.tgname IN ('trg_guard_entity_tag_plant',   'trg_guard_entity_tag_project',
                      'trg_guard_entity_tag_location','trg_guard_entity_tag_cultivar');
  SELECT count(*) INTO v_singular_rows FROM public.entity_tag;
  IF v_singular_present <> 1 OR v_singular_guards <> 4 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: SINGULAR entity_tag not intact (table=%, guards=% of 4)',
      v_singular_present, v_singular_guards
      USING ERRCODE = 'raise_exception',
            DETAIL  = 'The four BEFORE DELETE guards from v4-entitytagorphan-001 must be present '
                      'before and after this migration. They are the live tag system''s only '
                      'referential integrity.',
            HINT    = 'Do not proceed. Investigate the singular table first.';
  END IF;

  -- Stashed for the postflight comparison. A transaction-local temp table is used rather than a
  -- session variable so the two DO blocks can share it without a custom GUC. It is created with an
  -- explicit column list and populated by INSERT, NOT by `CREATE TEMP TABLE ... AS SELECT v_x`:
  -- PL/pgSQL does not substitute variables into utility statements, and CREATE TABLE AS is one, so
  -- the AS-SELECT spelling fails at runtime with "there is no parameter $1".
  CREATE TEMP TABLE _entitytagsdrop_before (
    singular_rows bigint NOT NULL,
    plural_rows   bigint NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO _entitytagsdrop_before (singular_rows, plural_rows)
  VALUES (v_singular_rows, v_plural_rows);

  RAISE NOTICE 'PREFLIGHT OK — plural entity_tags: % row(s), 3 triggers, 3 functions, 0 dependents',
    v_plural_rows;
  RAISE NOTICE 'PREFLIGHT OK — SINGULAR entity_tag: % row(s), 4/4 guards present (must be unchanged '
               'after this migration)', v_singular_rows;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. TRIGGERS. First, because a function cannot be dropped while a trigger depends on it.
--    Note the PLURAL `entity_tags` in every name. `trg_guard_entity_tag_*` (SINGULAR, four of
--    them, BEFORE DELETE) are a DIFFERENT SET and are not named anywhere in this file.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER trg_delete_entity_tags_plant    ON public.plants;
DROP TRIGGER trg_delete_entity_tags_project  ON public.plant_projects;
DROP TRIGGER trg_delete_entity_tags_location ON public.locations;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. FUNCTIONS. Exact identity signatures, verified zero-arg and non-overloaded by preflight #4.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
DROP FUNCTION public.delete_entity_tags_for_plant();
DROP FUNCTION public.delete_entity_tags_for_project();
DROP FUNCTION public.delete_entity_tags_for_location();

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. THE TABLE. Plain DROP — no CASCADE, no IF EXISTS. This one statement takes its 3 constraints,
--    5 indexes and 3 RLS policies with it, because those are its own dependents. Anything ELSE
--    that depends on it makes this fail with 2BP01, and that failure is the point.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
DROP TABLE public.entity_tags;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT. Inside the same transaction, so a wrong drop rolls back instead of committing.
-- The singular row-count re-comparison is the assertion that no amount of careful reading can
-- substitute for: if `entity_tag` were dropped by mistake, the SELECT below raises 42P01 and the
-- whole transaction unwinds.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
DO $postflight$
DECLARE
  v_before          bigint;
  v_after           bigint;
  v_plural_gone     boolean;
  v_triggers_left   int;
  v_functions_left  int;
  v_guards          int;
BEGIN
  SELECT singular_rows INTO v_before FROM _entitytagsdrop_before;

  v_plural_gone := to_regclass('public.entity_tags') IS NULL;
  SELECT count(*) INTO v_triggers_left
    FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg\_delete\_entity\_tags\_%';
  SELECT count(*) INTO v_functions_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname LIKE 'delete\_entity\_tags\_for\_%';
  IF NOT v_plural_gone OR v_triggers_left <> 0 OR v_functions_left <> 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT FAILED: plural residue (table_gone=%, triggers=%, functions=%)',
      v_plural_gone, v_triggers_left, v_functions_left
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The singular side, re-measured. Raises 42P01 here if the wrong table was dropped.
  SELECT count(*) INTO v_after FROM public.entity_tag;
  SELECT count(*) INTO v_guards
    FROM pg_trigger g
   WHERE NOT g.tgisinternal
     AND g.tgname IN ('trg_guard_entity_tag_plant',   'trg_guard_entity_tag_project',
                      'trg_guard_entity_tag_location','trg_guard_entity_tag_cultivar');
  IF v_after <> v_before OR v_guards <> 4 THEN
    RAISE EXCEPTION
      'POSTFLIGHT FAILED: SINGULAR entity_tag CHANGED (rows % -> %, guards % of 4). ROLLING BACK.',
      v_before, v_after, v_guards
      USING ERRCODE = 'raise_exception',
            DETAIL  = 'This migration must not touch the singular table. Something dropped or '
                      'modified the live tag system.',
            HINT    = 'The transaction is aborting. Investigate before any retry.';
  END IF;

  RAISE NOTICE 'POSTFLIGHT OK — plural entity_tags gone with its 3 triggers and 3 functions';
  RAISE NOTICE 'POSTFLIGHT OK — SINGULAR entity_tag intact: % row(s) unchanged, 4/4 guards',
    v_after;
END
$postflight$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.11-entitytagsdrop-001',
  'OPS-ENTITYTAGSDROP-001: drops the legacy PLURAL entity_tags debris table (2 smoke rows, '
  'superseded by v4-tagsub) with its 3 constraints, 5 indexes and 3 RLS policies, plus the three '
  'AFTER DELETE triggers trg_delete_entity_tags_{plant,project,location} and their functions. '
  'The SINGULAR entity_tag table and its four trg_guard_entity_tag_* guards are UNTOUCHED. '
  'Completes the deploy-before-drop order begun by the 2026-07-28 /api/entity-tags route removal.')
ON CONFLICT DO NOTHING;

COMMIT;
