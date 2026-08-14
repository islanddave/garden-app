-- 0a-additive-ddl.sql
-- OPS-ARCHRESTORE-001 — the substrate an un-archive needs. Purely additive: one helper function,
-- two nullable columns on the existing archive tables, one new cold-store table. No existing row is
-- read or written, no constraint is armed over existing data, no function body changes here.
--
-- ┌─ WHY 0a IS SEPARATE, AND WHY IT MUST APPLY FIRST ────────────────────────────────────────────┐
-- │ 0c CREATE OR REPLACEs the two archive routines so their photo detach RECORDS what it severs.  │
-- │ Those bodies reference photo_detach_archive and the fingerprint default. Applying 0c first     │
-- │ leaves both routines raising 42P01 on their next invocation — i.e. it breaks the escape hatch  │
-- │ that v4-softdelcascade-001's RESTRICT FKs depend on existing. Same sequencing argument that    │
-- │ file makes for its own 0a, for the same reason.                                                │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- ── THE FINDING THIS MIGRATION EXISTS FOR ──────────────────────────────────────────────────────
-- OPS-ARCHRESTORE-001 was filed as "row_data is preserved but nothing reconstitutes it". Building
-- only the inverse routine would have shipped a restore that silently returns LESS than archiving
-- took: both archive routines DETACH photos before deleting the events, and the severed
-- photos.event_id (plus, in the container routine, project_id / plant_id / location_id) is written
-- NOWHERE. Not into row_data — that is to_jsonb() over the EVENT row, not the photos. Not into the
-- archive tables. So the archive side is fixed FIRST, in this same migration.
--
-- MEASURED, live prod 2026-08-13 (owner DSN, exact — neither archive table has a deleted_at, so no
-- RLS soft-delete blindness applies): event_log_archive = 0 rows, harvest_log_archive = 0 rows.
-- NOTHING HAS EVER BEEN ARCHIVED IN PROD. That is what makes fixing the archive side free right
-- now: no backfill is owed, no historical detach is lost by doing it in this order, and no existing
-- archive row acquires a fingerprint it did not earn. It gets strictly more expensive after the
-- first operator invocation.
--
-- ── WHY A TABLE AND NOT A COLUMN ON event_log_archive ──────────────────────────────────────────
-- The recon (R1 §3) suggested `detached_photo_ids uuid[]` or `photo_links jsonb` as a COLUMN on
-- event_log_archive. That was re-derived here and REJECTED, because it cannot hold the whole
-- detach set:
--
--   1. archive_container_events() detaches on the PROJECT axis too — `ph.project_id =
--      p_container_id` — for photos that have NO event in the batch. Those photos have no
--      event_log_archive row to hang a column off. v4-softdelcascade-001's own informational
--      capture (sweep_capture_photos_with_a_single_dying_parent) counted 12 such photos in live
--      prod on 2026-08-12, so this is a populated case, not a theoretical one.
--   2. A container with ZERO events archives zero rows while still detaching its project-axis
--      photos. A per-archive-row column has literally nowhere to write.
--
-- A column would therefore have reproduced the exact defect this ticket exists to close, one level
-- down: a capture that is silently partial in the direction nobody measured. The table is keyed by
-- the SAME provenance columns the archive tables use (archived_plant_id / archived_project_id),
-- carries the same *_has_provenance CHECK, and carries NO foreign keys for the same stated reason
-- (v4-softdelcascade-001: "an FK would make the cold store refuse the very rows it exists to
-- hold"). It is a member of the archive family, not a new concept.
--
-- jsonb (not uuid[]) for the pre-image, per the recon's own reasoning: the plant routine COALESCEs
-- project_id/location_id FORWARD onto the photo while clearing event_id, and the container routine
-- additionally moves plant_id and clears project_id. A uuid[] records WHICH photos moved but not
-- WHAT moved, so it cannot invert a COALESCE. jsonb records every axis, and absorbs a future
-- photo-parent column without DDL.
--
-- ── WHY A FINGERPRINT, AND WHY IT IS NOT THE DRIFT TEST ────────────────────────────────────────
-- jsonb_populate_record() is drift-TOLERANT by design: it ignores keys with no matching column
-- (forward drift) and defaults columns absent from the snapshot (backward drift). That tolerance is
-- what makes it the right primitive AND what makes it dangerous — a snapshot taken before a column
-- existed restores that column as its default with no signal. schema_fingerprint is the cheap
-- trigger for 0c's drift check: when it still matches, the snapshot provably predates no schema
-- change and the expensive key-set comparison is skipped. It is provenance, not the assertion.
-- The assertion is archive_row_data_drift(), below.
--
-- NULLABLE, AND DELIBERATELY NOT BACKFILLED. The column is added WITHOUT a default and the default
-- is set in a second statement, so any archive row predating this migration keeps a NULL
-- fingerprint — an honest "unknown" — rather than being stamped with a version it was not taken
-- under. Prod has 0 such rows; staging may not.
--
-- ── DEPLOY BOUNDARY — the falsifiable test, answered ───────────────────────────────────────────
-- QUESTION: would the CURRENTLY DEPLOYED prod code perform an operation this now rejects?
-- ANSWER: NO, and vacuously so. 0a rejects nothing: it adds a function, two nullable columns and an
-- empty table. Nothing deployed calls archive_plant_events() or archive_container_events() at all
-- (established by v4-archpreservguard-001's bundle grep at prod 5c232164, unchanged at c509fff);
-- they are operator-invoked escape hatches. Safe to apply before or after a code deploy.
--
-- REVERSIBILITY: 0r drops all three objects. Because the archive tables are empty in prod, dropping
-- the fingerprint columns loses nothing; on a non-empty environment it loses only the fingerprint,
-- never row_data.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. The fingerprint source ──────────────────────────────────────────────────────────────────
-- schema_version is the house record of applied migrations (version, description, applied_at). Its
-- newest row is the closest thing this database has to "what shape am I". STABLE, not IMMUTABLE:
-- it reads a table.
-- RLS NOTE: schema_version has relrowsecurity = t but relforcerowsecurity = f, and the tables are
-- owned by the same role the application connects as, so the owner bypasses the policies. A caller
-- that could NOT read schema_version gets a NULL fingerprint, which 0c treats as "unknown" and
-- therefore runs the full drift comparison — fail-loud, not fail-open.
CREATE OR REPLACE FUNCTION public.current_schema_fingerprint()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT sv.version
    FROM public.schema_version sv
   ORDER BY sv.applied_at DESC, sv.version DESC
   LIMIT 1
$function$;

COMMENT ON FUNCTION public.current_schema_fingerprint() IS
  'OPS-ARCHRESTORE-001: newest schema_version.version, stamped onto archive rows so a later '
  'un-archive can detect that the snapshot predates the current shape instead of silently '
  'defaulting absent columns.';

-- ── 2. The drift test the fingerprint triggers ─────────────────────────────────────────────────
-- Returns NULL when a snapshot's key set matches the live column set exactly, and otherwise a
-- human-readable description naming BOTH directions. Deliberately a separate, testable function:
-- the un-archive routine's job is to refuse, not to compute.
CREATE OR REPLACE FUNCTION public.archive_row_data_drift(p_table text, p_row_data jsonb)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT NULLIF(
      COALESCE('missing=[' || (SELECT string_agg(c.column_name, ',' ORDER BY c.column_name)
                                 FROM information_schema.columns c
                                WHERE c.table_schema = 'public'
                                  AND c.table_name   = p_table
                                  AND NOT (p_row_data ? c.column_name)) || '] ', '')
   || COALESCE('unknown=[' || (SELECT string_agg(t.k, ',' ORDER BY t.k)
                                 FROM jsonb_object_keys(p_row_data) AS t(k)
                                WHERE NOT EXISTS (
                                        SELECT 1 FROM information_schema.columns c
                                         WHERE c.table_schema = 'public'
                                           AND c.table_name   = p_table
                                           AND c.column_name  = t.k)) || ']', ''),
      '')
$function$;

COMMENT ON FUNCTION public.archive_row_data_drift(text, jsonb) IS
  'OPS-ARCHRESTORE-001: NULL when a row_data snapshot matches the live column set of p_table; '
  'otherwise names the columns the snapshot is MISSING (would be silently defaulted by '
  'jsonb_populate_record) and the keys it carries that are no longer columns (would be silently '
  'dropped).';

-- ── 3. Fingerprint the existing archive tables ─────────────────────────────────────────────────
-- Two statements per table on purpose: ADD COLUMN with no default leaves pre-existing rows NULL
-- (honest unknown); SET DEFAULT then applies to every subsequent insert. Doing it in one
-- ADD COLUMN ... DEFAULT would stamp historical rows with a version they were not taken under.
ALTER TABLE public.event_log_archive   ADD COLUMN IF NOT EXISTS schema_fingerprint text;
ALTER TABLE public.harvest_log_archive ADD COLUMN IF NOT EXISTS schema_fingerprint text;

ALTER TABLE public.event_log_archive
  ALTER COLUMN schema_fingerprint SET DEFAULT public.current_schema_fingerprint();
ALTER TABLE public.harvest_log_archive
  ALTER COLUMN schema_fingerprint SET DEFAULT public.current_schema_fingerprint();

COMMENT ON COLUMN public.event_log_archive.schema_fingerprint IS
  'OPS-ARCHRESTORE-001: schema_version.version current when this row was archived. NULL = archived '
  'before the fingerprint existed; unarchive treats NULL as unknown and runs the full drift check.';
COMMENT ON COLUMN public.harvest_log_archive.schema_fingerprint IS
  'OPS-ARCHRESTORE-001: schema_version.version current when this row was archived. NULL = archived '
  'before the fingerprint existed; unarchive treats NULL as unknown and runs the full drift check.';

-- ── 4. The photo detach cold store ─────────────────────────────────────────────────────────────
-- One row per photo per detach. pre_image is the photo's parent set as it stood IMMEDIATELY BEFORE
-- the detach UPDATE — the fact that was previously destroyed.
--
-- NO FOREIGN KEYS, deliberately, exactly as event_log_archive / harvest_log_archive: photo_id
-- points at a live photo today, but archive rows are expected to outlive their referents and an FK
-- would make the cold store refuse the rows it exists to hold. The un-archive routine checks
-- resolution explicitly instead, and refuses by name.
--
-- NO RLS, matching both sibling archive tables (relrowsecurity = f on each). This table is written
-- only by the two archive routines and read only by the un-archive routines; it carries no data the
-- live photos row does not already carry.
CREATE TABLE IF NOT EXISTS public.photo_detach_archive (
  id                  uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  photo_id            uuid        NOT NULL,
  pre_image           jsonb       NOT NULL,
  archived_at         timestamptz NOT NULL DEFAULT now(),
  archived_by         text        NOT NULL DEFAULT CURRENT_USER,
  archived_reason     text,
  archived_plant_id   uuid,
  archived_project_id uuid,
  schema_fingerprint  text                 DEFAULT public.current_schema_fingerprint(),
  CONSTRAINT photo_detach_archive_has_provenance
    CHECK (archived_plant_id IS NOT NULL OR archived_project_id IS NOT NULL),
  CONSTRAINT photo_detach_archive_pre_image_is_object
    CHECK (jsonb_typeof(pre_image) = 'object')
);

COMMENT ON TABLE public.photo_detach_archive IS
  'OPS-ARCHRESTORE-001: cold store for photo->parent links severed by archive_plant_events() / '
  'archive_container_events(). Same provenance keys, same has_provenance CHECK and same no-FK '
  'policy as event_log_archive. Without it an un-archive gives back less than archiving took.';
COMMENT ON COLUMN public.photo_detach_archive.pre_image IS
  'The photo''s {event_id, project_id, location_id, plant_id} as it stood immediately BEFORE the '
  'detach UPDATE. JSON null means the axis was already NULL. Captured pre-image rather than '
  'RETURNING because RETURNING yields the NEW row and the detach''s COALESCE-forward is not '
  'invertible from the new state.';

CREATE INDEX IF NOT EXISTS idx_photo_detach_archive_plant
  ON public.photo_detach_archive (archived_plant_id) WHERE archived_plant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_photo_detach_archive_project
  ON public.photo_detach_archive (archived_project_id) WHERE archived_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_photo_detach_archive_photo
  ON public.photo_detach_archive (photo_id);

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.11-archrestore-001-capture',
  'ARCHRESTORE 0a: additive substrate for un-archiving. current_schema_fingerprint() and '
  'archive_row_data_drift() helpers; nullable schema_fingerprint on event_log_archive and '
  'harvest_log_archive (added WITHOUT default, then defaulted, so historical rows stay honestly '
  'NULL); new photo_detach_archive cold store for the photo->parent links the archive routines '
  'sever. A COLUMN on event_log_archive was rejected: archive_container_events() detaches on the '
  'project axis for photos with no event in the batch (12 such photos in live prod 2026-08-12) and '
  'a container with zero events archives zero rows, so a per-archive-row column cannot hold the '
  'whole detach set. No FKs and no RLS, matching both sibling archive tables. No row data touched; '
  'both archive tables held 0 rows at apply time, so no backfill is owed.')
ON CONFLICT DO NOTHING;

COMMIT;
