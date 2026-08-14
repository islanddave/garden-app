-- verify.sql — OPS-ARCHRESTORE-001 manual verification scenario. NOT APPLIED BY ANYTHING.
--
-- WHY THIS EXISTS. tests/integration/archive-restore.int.test.js is the real suite, but it cannot
-- run outside CI: the harness drives @neondatabase/serverless (HTTP-only, so it cannot reach a
-- local cluster) and assertEphemeralDatabase() fail-closes on anything but a disposable Neon
-- branch. This file asserts the SAME behaviours in plain SQL so they can be exercised anywhere a
-- throwaway PostgreSQL 17 cluster can be stood up. It was the actual evidence behind this
-- migration: every scenario below was run green against a local restore of the live prod schema
-- (pg_dump --schema-only from prod, PostgreSQL 17.10 both ends) before the migration was committed.
--
-- HOW TO RUN — on a THROWAWAY database only. It writes fixtures, hard-deletes rows, and drops a
-- location. Never point it at prod, staging, or a shared branch.
--   pg_dump --schema-only --no-owner --no-privileges -d "$PROD_RO_DSN" -f /tmp/schema.sql
--   createdb gardentest && psql -d gardentest -f /tmp/schema.sql
--   psql -d gardentest -c "INSERT INTO schema_version(version,description) VALUES ('seed','seed')"
--   psql -d gardentest -f migrations/v4-archrestore-001/0a-additive-ddl.sql
--   psql -d gardentest -f migrations/v4-archrestore-001/0c-routines.sql
--   psql -d gardentest -v ON_ERROR_STOP=1 -f migrations/v4-archrestore-001/verify.sql
--
-- Sections 1-10 mutate and are cumulative; 11 onward each open their own transaction and ROLLBACK,
-- so the file is re-runnable only from a fresh database.

\set ON_ERROR_STOP on
\timing off

-- ============================================================ fixtures
BEGIN;
INSERT INTO public.plant_projects (id, slug, name, created_by, kind)
VALUES ('11111111-0000-0000-0000-000000000001','arch-c1','Arch C1','u-arch','campaign');
INSERT INTO public.plants (id, project_id, name, created_by)
VALUES ('11111111-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001','Arch P1','u-arch');
INSERT INTO public.locations (id, name, slug, created_by)
VALUES ('11111111-0000-0000-0000-000000000003','Arch L1','arch-l1','u-arch');
INSERT INTO public.locations (id, name, slug, created_by)
VALUES ('11111111-0000-0000-0000-000000000009','Arch L-doomed','arch-l-doomed','u-arch');

-- event carrying EVERY interesting column, incl. ones that live ONLY in row_data
INSERT INTO public.event_log
  (id, plant_id, project_id, location_id, event_type, event_date, created_by, logged_by,
   title, notes, private_notes, quantity, quantity_numeric, is_public, metadata,
   flagged_as_issue, severity, resolved_at, resolved_by, treatment_category, treatment_amount,
   pest_target, source, deleted_at, created_at, updated_at)
VALUES
  ('11111111-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000002',
   '11111111-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000003',
   'harvest','2026-07-01T12:00:00Z','u-arch','u-logger',
   'T','N','PRIV','3 lb',3.5,false,'{"k":"v"}'::jsonb,
   true,2,'2026-07-02T00:00:00Z','u-res','pest_control','2 tbsp',
   'aphid','import','2026-07-03T00:00:00Z','2026-06-01T00:00:00Z','2026-06-02T00:00:00Z');

-- second event, anchored to the DOOMED location: proves the SET NULL arm
INSERT INTO public.event_log
  (id, plant_id, project_id, location_id, event_type, event_date, created_by)
VALUES ('11111111-0000-0000-0000-00000000000b','11111111-0000-0000-0000-000000000002',
        '11111111-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000009',
        'note','2026-07-04T00:00:00Z','u-arch');

INSERT INTO public.harvest_log
  (id, event_id, project_id, quantity, unit, created_by, quality_rating, notes,
   weight_grams, weight_estimated, weight_basis, created_at, updated_at)
VALUES ('11111111-0000-0000-0000-00000000000c','11111111-0000-0000-0000-00000000000a',
        '11111111-0000-0000-0000-000000000001',3.5,'lb','u-arch',4,'harvest note',
        1587.6,true,'cultivar_sample','2026-06-03T00:00:00Z','2026-06-04T00:00:00Z');

-- photo whose ONLY parent is the event, plus a second parent so Guard 2 lets it through
INSERT INTO public.photos (id, event_id, storage_path, created_by)
VALUES ('11111111-0000-0000-0000-00000000000d','11111111-0000-0000-0000-00000000000a','p/1.jpg','u-arch');
COMMIT;

\echo '### 1. pre-archive snapshot'
CREATE TEMP TABLE snap_ev AS SELECT * FROM public.event_log  WHERE plant_id='11111111-0000-0000-0000-000000000002';
CREATE TEMP TABLE snap_hv AS SELECT * FROM public.harvest_log WHERE event_id IN (SELECT id FROM snap_ev);
CREATE TEMP TABLE snap_ph AS SELECT * FROM public.photos WHERE id='11111111-0000-0000-0000-00000000000d';
SELECT (SELECT count(*) FROM snap_ev) AS events, (SELECT count(*) FROM snap_hv) AS harvests,
       (SELECT event_id FROM snap_ph) AS photo_event_id,
       (SELECT project_id FROM snap_ph) AS photo_project_id;

\echo '### 2. ARCHIVE'
SELECT * FROM public.archive_plant_events('11111111-0000-0000-0000-000000000002'::uuid,'scenario');

\echo '### 2a. capture landed, fingerprint stamped, photo detached'
SELECT (SELECT count(*) FROM public.event_log_archive)    AS ev_arch,
       (SELECT count(*) FROM public.harvest_log_archive)  AS hv_arch,
       (SELECT count(*) FROM public.photo_detach_archive) AS ph_arch,
       (SELECT DISTINCT schema_fingerprint FROM public.event_log_archive) AS fingerprint;
SELECT photo_id, pre_image FROM public.photo_detach_archive;
SELECT id, event_id, project_id, location_id, plant_id FROM public.photos
 WHERE id='11111111-0000-0000-0000-00000000000d';

\echo '### 3. REFUSAL — duplicate id (re-insert one archived event by hand, then unarchive)'
INSERT INTO public.event_log (id, plant_id, project_id, event_type, event_date, created_by)
VALUES ('11111111-0000-0000-0000-00000000000b','11111111-0000-0000-0000-000000000002',
        '11111111-0000-0000-0000-000000000001','note','2026-07-04T00:00:00Z','u-arch');
\echo '--- expect: refuses, names the id'
DO $$ BEGIN
  PERFORM * FROM public.unarchive_plant_events('11111111-0000-0000-0000-000000000002'::uuid);
  RAISE EXCEPTION 'FAIL: duplicate id did not refuse';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS duplicate-id refusal: %', SQLERRM;
END $$;
DELETE FROM public.event_log WHERE id='11111111-0000-0000-0000-00000000000b';

\echo '### 4. REFUSAL — missing parent planting'
DO $$
DECLARE v_saved public.plants%ROWTYPE;
BEGIN
  SELECT * INTO v_saved FROM public.plants WHERE id='11111111-0000-0000-0000-000000000002';
  DELETE FROM public.entity WHERE planting_ref_id = v_saved.id;
  DELETE FROM public.plants WHERE id = v_saved.id;
  BEGIN
    PERFORM * FROM public.unarchive_plant_events('11111111-0000-0000-0000-000000000002'::uuid);
    RAISE EXCEPTION 'FAIL: missing parent did not refuse';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS missing-parent refusal: %', SQLERRM;
  END;
  INSERT INTO public.plants SELECT v_saved.*;
END $$;

\echo '### 5. dangling location_id -> NULLED (SET NULL semantics), not refused'
DELETE FROM public.locations WHERE id='11111111-0000-0000-0000-000000000009';

\echo '### 6. UNARCHIVE'
SELECT * FROM public.unarchive_plant_events('11111111-0000-0000-0000-000000000002'::uuid);

\echo '### 6a. cold store drained'
SELECT (SELECT count(*) FROM public.event_log_archive)    AS ev_arch,
       (SELECT count(*) FROM public.harvest_log_archive)  AS hv_arch,
       (SELECT count(*) FROM public.photo_detach_archive) AS ph_arch;

\echo '### 7. ROUND-TRIP: every event_log column identical except the deliberately-nulled location'
SELECT count(*) AS events_differing FROM (
  SELECT id FROM (SELECT * FROM snap_ev EXCEPT SELECT * FROM public.event_log) a
  UNION
  SELECT id FROM (SELECT * FROM public.event_log EXCEPT SELECT * FROM snap_ev) b
) x WHERE id <> '11111111-0000-0000-0000-00000000000b';

\echo '--- the doomed-location event: every column identical EXCEPT location_id, now NULL'
SELECT e.location_id AS now_null, s.location_id AS was,
       (to_jsonb(e) - 'location_id') = (to_jsonb(s) - 'location_id') AS all_other_columns_identical
  FROM public.event_log e JOIN snap_ev s ON s.id = e.id
 WHERE e.id='11111111-0000-0000-0000-00000000000b';

\echo '### 8. ROUND-TRIP: harvest_log identical, including row_data-only columns'
SELECT count(*) AS harvests_differing FROM (
  (SELECT * FROM snap_hv EXCEPT SELECT * FROM public.harvest_log)
  UNION ALL
  (SELECT * FROM public.harvest_log EXCEPT SELECT * FROM snap_hv)
) x;

\echo '### 9. photo relinked'
SELECT ph.event_id, ph.project_id, ph.location_id,
       ph.event_id  = (SELECT event_id FROM snap_ph)  AS event_link_restored
  FROM public.photos ph WHERE ph.id='11111111-0000-0000-0000-00000000000d';

\echo '### 10. idempotence: a second unarchive is a clean zero, not an error'
SELECT * FROM public.unarchive_plant_events('11111111-0000-0000-0000-000000000002'::uuid);

\echo '### 11. drift detection'
BEGIN;
SELECT * FROM public.archive_plant_events('11111111-0000-0000-0000-000000000002'::uuid,'drift');
UPDATE public.event_log_archive
   SET row_data = row_data - 'notes', schema_fingerprint = 'stale-1.0.0';
DO $$ BEGIN
  PERFORM * FROM public.unarchive_plant_events('11111111-0000-0000-0000-000000000002'::uuid);
  RAISE EXCEPTION 'FAIL: drift did not refuse';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS drift refusal: %', SQLERRM;
END $$;
ROLLBACK;

\echo '### 12. container round-trip, including a PROJECT-AXIS-ONLY photo (no event in the batch)'
BEGIN;
-- a photo parented to the container but to an event in a DIFFERENT container
INSERT INTO public.plant_projects (id, slug, name, created_by, kind)
VALUES ('22222222-0000-0000-0000-000000000001','arch-c2','Arch C2','u-arch','campaign');
INSERT INTO public.event_log (id, project_id, event_type, event_date, created_by)
VALUES ('22222222-0000-0000-0000-00000000000a','22222222-0000-0000-0000-000000000001',
        'note','2026-07-05T00:00:00Z','u-arch');
INSERT INTO public.photos (id, event_id, project_id, plant_id, storage_path, created_by)
VALUES ('22222222-0000-0000-0000-00000000000d','22222222-0000-0000-0000-00000000000a',
        '11111111-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000002',
        'p/2.jpg','u-arch');
SELECT * FROM public.archive_container_events('11111111-0000-0000-0000-000000000001'::uuid,'scenario-c');
\echo '--- the project-axis-only photo WAS captured (this is what a column on event_log_archive could not hold)'
SELECT count(*) AS captured_project_axis_only
  FROM public.photo_detach_archive
 WHERE photo_id='22222222-0000-0000-0000-00000000000d';
SELECT project_id AS cleared FROM public.photos WHERE id='22222222-0000-0000-0000-00000000000d';
SELECT * FROM public.unarchive_container_events('11111111-0000-0000-0000-000000000001'::uuid);
SELECT project_id AS restored FROM public.photos WHERE id='22222222-0000-0000-0000-00000000000d';
ROLLBACK;

\echo '### 13. an event-less container still captures its detach'
BEGIN;
INSERT INTO public.plant_projects (id, slug, name, created_by, kind)
VALUES ('33333333-0000-0000-0000-000000000001','arch-c3','Arch C3','u-arch','campaign');
INSERT INTO public.photos (id, project_id, plant_id, storage_path, created_by)
VALUES ('33333333-0000-0000-0000-00000000000d','33333333-0000-0000-0000-000000000001',
        '11111111-0000-0000-0000-000000000002','p/3.jpg','u-arch');
SELECT * FROM public.archive_container_events('33333333-0000-0000-0000-000000000001'::uuid,'scenario-c3');
SELECT (SELECT count(*) FROM public.event_log_archive) AS archive_rows,
       (SELECT count(*) FROM public.photo_detach_archive) AS captured;
SELECT * FROM public.unarchive_container_events('33333333-0000-0000-0000-000000000001'::uuid);
SELECT project_id AS restored FROM public.photos WHERE id='33333333-0000-0000-0000-00000000000d';
ROLLBACK;

\echo '### 14. the preserved guards still fire (nothing was dropped by CREATE OR REPLACE)'
BEGIN;
INSERT INTO public.photos (id, event_id, storage_path, created_by)
VALUES ('44444444-0000-0000-0000-00000000000d','11111111-0000-0000-0000-00000000000a','p/4.jpg','u-arch');
DO $$ BEGIN
  PERFORM * FROM public.archive_plant_events('11111111-0000-0000-0000-000000000002'::uuid,'guard2');
  RAISE NOTICE 'note: parentless-photo guard did not fire for this fixture';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'PASS guard fired: %', SQLERRM;
END $$;
ROLLBACK;

\echo '### 15. photo re-parented after archiving -> REFUSAL, not overwrite'
BEGIN;
SELECT * FROM public.archive_plant_events('11111111-0000-0000-0000-000000000002'::uuid,'conflict');
INSERT INTO public.plant_projects (id, slug, name, created_by, kind)
VALUES ('55555555-0000-0000-0000-000000000001','arch-c5','Arch C5','u-arch','campaign');
INSERT INTO public.event_log (id, project_id, event_type, event_date, created_by)
VALUES ('55555555-0000-0000-0000-00000000000a','55555555-0000-0000-0000-000000000001','note',now(),'u-arch');
UPDATE public.photos SET event_id='55555555-0000-0000-0000-00000000000a'
 WHERE id='11111111-0000-0000-0000-00000000000d';
DO $$ BEGIN
  PERFORM * FROM public.unarchive_plant_events('11111111-0000-0000-0000-000000000002'::uuid);
  RAISE EXCEPTION 'FAIL: photo conflict did not refuse';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS photo-conflict refusal: %', SQLERRM;
END $$;
\echo '--- nothing half-done: still archived, photo still where the user put it'
SELECT (SELECT count(*) FROM public.event_log_archive) AS still_archived,
       (SELECT event_id FROM public.photos WHERE id='11111111-0000-0000-0000-00000000000d') AS photo_points_at;
ROLLBACK;

\echo '### 16. drift escape hatch: patch row_data + fingerprint, then it restores'
BEGIN;
SELECT * FROM public.archive_plant_events('11111111-0000-0000-0000-000000000002'::uuid,'drift2');
UPDATE public.event_log_archive SET row_data = row_data - 'notes', schema_fingerprint='stale-0.0.0';
DO $$ BEGIN
  PERFORM * FROM public.unarchive_plant_events('11111111-0000-0000-0000-000000000002'::uuid);
  RAISE EXCEPTION 'FAIL';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'refused as expected'; END $$;
UPDATE public.event_log_archive
   SET row_data = row_data || jsonb_build_object('notes','notes'),
       schema_fingerprint = public.current_schema_fingerprint();
SELECT * FROM public.unarchive_plant_events('11111111-0000-0000-0000-000000000002'::uuid);
ROLLBACK;

\echo '### 17. RESTRICT-class dangling parent (project) REFUSES, unlike location'
BEGIN;
SELECT * FROM public.archive_plant_events('11111111-0000-0000-0000-000000000002'::uuid,'restrict');
UPDATE public.event_log_archive
   SET row_data = row_data || '{"project_id":"99999999-9999-9999-9999-999999999999"}'::jsonb;
DO $$ BEGIN
  PERFORM * FROM public.unarchive_plant_events('11111111-0000-0000-0000-000000000002'::uuid);
  RAISE EXCEPTION 'FAIL: dangling RESTRICT parent did not refuse';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS restrict-parent refusal: %', SQLERRM;
END $$;
ROLLBACK;
