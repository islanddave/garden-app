-- 0a-evidence.sql
-- OPS-ENTITYTAGSDROP-001 — READ-ONLY evidence capture. This file DROPS NOTHING and WRITES NOTHING.
--
-- WHY A READ-ONLY 0a EXISTS AT ALL. Every other 0a in this corpus is additive DDL. This one is a
-- capture script, because 0c is the first migration in this repo that destroys a table, and a drop
-- is the one operation the Soft-Delete-Only rule cannot un-do. The 2 rows in the plural table are
-- smoke-test debris and nobody wants them back — but "nobody wants them back" is a judgement made
-- from a report, and a report is not the data. Run this, paste the output into the README's
-- CAPTURE RECORD section, and the drop stops being irreversible in the way that matters.
--
-- IT ALSO RE-ASSERTS THE PRECONDITIONS AT APPLY TIME rather than trusting the recon that authored
-- this migration. The recon was correct at c509fff4aec0225553228d8169dde77e68ae2903; it is a
-- hypothesis about the database at the moment you run 0c. Blocks 1-7 below are the falsifiable
-- version of it. gates.yml `pre` + `sweep` assert the same facts mechanically; this file exists so
-- a human can SEE them, and so the row contents are captured in a form that can be pasted.
--
-- SINGULAR / PLURAL. `entity_tags` (PLURAL, 7 columns, 2 rows, dead) is the subject. `entity_tag`
-- (SINGULAR, the faceted M2M from v4-tagsub, 1,016 rows in prod, ALL of them entity_type='cultivar')
-- is the LIVE tag system and is not touched by any file in this directory. Blocks 6 and 7 exist for
-- exactly one reason: to make a one-character error loud before it is destructive.
--
-- RUN:  psql "$NEON_DATABASE_URL" -X -f migrations/v4-entitytagsdrop-001/0a-evidence.sql
--       (and again against "$NEON_STAGING_URL" — see the ENV PARITY note in the README; the two
--        databases legitimately differ on singular row count and on the garden_ro grant.)

\pset pager off
\echo ''
\echo '=== 1. THE 2 ROWS — capture these into README.md before running 0c ==================='
\x on
SELECT * FROM public.entity_tags ORDER BY created_at;
\x off

\echo ''
\echo '=== 1b. The same rows as a re-insertable literal (0r-rollback.sql must match) ========'
SELECT format(
  '(%L, %L, %L, %L, %L, %L, %L::timestamptz)',
  id::text, entity_type, entity_id, tag_key, tag_value, created_by, created_at::text
) AS values_tuple
FROM public.entity_tags ORDER BY created_at;

\echo ''
\echo '=== 2. PRECONDITION — plural table exists, holds <= 2 rows ==========================='
SELECT count(*) AS plural_rows,
       (count(*) <= 2) AS precondition_ok
  FROM public.entity_tags;

\echo ''
\echo '=== 3. PRECONDITION — the three legacy triggers, and what they fire ================='
SELECT g.tgname, t.relname AS on_table, p.proname AS fn, pg_get_triggerdef(g.oid) AS def
  FROM pg_trigger g
  JOIN pg_class t ON t.oid = g.tgrelid
  JOIN pg_proc  p ON p.oid = g.tgfoid
 WHERE NOT g.tgisinternal
   AND g.tgname LIKE 'trg\_delete\_entity\_tags\_%'
 ORDER BY g.tgname;

\echo ''
\echo '=== 4. PRECONDITION — EXACT function signatures. A bare name fails if overloaded ===='
-- regprocedure renders the identity signature Postgres will accept in DROP FUNCTION. If any row
-- below shows arguments, or the same proname appears twice, 0c is WRONG and must be re-spelled.
SELECT p.oid::regprocedure::text AS drop_this_exact_signature,
       pg_get_function_identity_arguments(p.oid) AS ident_args,
       count(*) OVER (PARTITION BY p.proname) AS overload_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
 WHERE p.proname LIKE 'delete\_entity\_tags\_for\_%'
 ORDER BY 1;

\echo ''
\echo '=== 5. PRECONDITION — the dependency sweep 0c asserts by using a PLAIN DROP TABLE ==='
-- Every one of these must be empty. 0c does NOT use CASCADE: the plain form is the assertion that
-- this sweep was right, and a failure here is INFORMATION, not an obstacle to route around.
\echo '--- 5a. incoming foreign keys (expect 0 rows) ---'
SELECT conname, conrelid::regclass::text AS from_table
  FROM pg_constraint WHERE confrelid = 'public.entity_tags'::regclass;
\echo '--- 5b. dependent views / rules (expect 0 rows) ---'
SELECT DISTINCT n.nspname || '.' || v.relname AS dependent_view
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  JOIN pg_class v ON v.oid = r.ev_class
  JOIN pg_namespace n ON n.oid = v.relnamespace
 WHERE d.refobjid = 'public.entity_tags'::regclass
   AND v.relname <> 'entity_tags';
\echo '--- 5c. triggers ON the plural table (expect 0 rows) ---'
SELECT tgname FROM pg_trigger
 WHERE tgrelid = 'public.entity_tags'::regclass AND NOT tgisinternal;
\echo '--- 5d. everything else pg_depend knows about, minus its own indexes/constraints ---'
-- The catch-all. 5a-5c enumerate the classes we predicted; this one catches a class we did not.
SELECT d.classid::regclass::text AS dependent_kind,
       COALESCE(pg_describe_object(d.classid, d.objid, d.objsubid), '?') AS dependent_object,
       d.deptype
  FROM pg_depend d
 WHERE d.refobjid = 'public.entity_tags'::regclass
   AND d.deptype NOT IN ('i', 'a')
   AND d.classid <> 'pg_class'::regclass
   AND d.classid <> 'pg_constraint'::regclass;

\echo ''
\echo '=== 6. !! THE SINGULAR TABLE MUST BE UNTOUCHED — record the BEFORE numbers !! ======='
-- Prod 2026-08-13: 1016 rows, 4 guards. Staging: 0 rows, 4 guards (staging has never held a tag).
-- Compare these against the same query after 0c. Any change is a catastrophic mis-drop.
SELECT (SELECT count(*) FROM public.entity_tag) AS singular_entity_tag_rows,
       (SELECT count(*) FROM pg_trigger g
         WHERE NOT g.tgisinternal AND g.tgname LIKE 'trg\_guard\_entity\_tag\_%') AS singular_guards,
       (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'entity_tag') AS singular_table_present;

\echo ''
\echo '=== 7. The four guards by name — these survive 0c. If any is missing, STOP. ========='
SELECT g.tgname, t.relname AS on_table
  FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid
 WHERE NOT g.tgisinternal AND g.tgname LIKE 'trg\_guard\_entity\_tag\_%'
 ORDER BY g.tgname;

\echo ''
\echo '=== 8. Full object inventory 0r-rollback.sql must be able to rebuild ================'
\echo '--- 8a. columns ---'
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'entity_tags'
 ORDER BY ordinal_position;
\echo '--- 8b. constraints (3) ---'
SELECT conname, contype, pg_get_constraintdef(oid)
  FROM pg_constraint WHERE conrelid = 'public.entity_tags'::regclass ORDER BY conname;
\echo '--- 8c. indexes (5 — 2 of them constraint-backed) ---'
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'entity_tags' ORDER BY indexname;
\echo '--- 8d. RLS flag + policies (3) ---'
SELECT relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE oid = 'public.entity_tags'::regclass;
SELECT polname, polcmd,
       pg_get_expr(polqual, polrelid) AS using_expr,
       pg_get_expr(polwithcheck, polrelid) AS check_expr
  FROM pg_policy WHERE polrelid = 'public.entity_tags'::regclass ORDER BY polname;
\echo '--- 8e. grants (prod carries garden_ro=r; staging carries none — env parity note) ---'
SELECT relowner::regrole::text AS owner, COALESCE(relacl::text, '(default: owner only)') AS acl
  FROM pg_class WHERE oid = 'public.entity_tags'::regclass;
\echo '--- 8f. the three function bodies, verbatim ---'
SELECT pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
 WHERE p.proname LIKE 'delete\_entity\_tags\_for\_%'
 ORDER BY p.proname;
\echo ''
\echo '=== evidence capture complete. Nothing was modified. ================================'
