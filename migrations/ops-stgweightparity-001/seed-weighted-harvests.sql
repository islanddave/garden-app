-- OPS-STGWEIGHTPARITY-001 — staging-only fixture: weighted harvest_log rows.
--
-- WHY THIS EXISTS
-- staging.harvest_log held 0 rows (verified 2026-08-03), so all three weight CHECKs
--   chk_harvest_log_weight_pairing        (weight_grams IS NULL) = (weight_estimated IS NULL)
--   chk_harvest_log_weight_basis_pairing  (weight_grams IS NULL) = (weight_basis IS NULL)
--   chk_harvest_log_weight_basis_estimated weight_estimated = (weight_basis <> 'measured')
-- passed VACUOUSLY. A staging green on any weight-touching migration proved nothing.
-- This seeds rows that exercise every branch so those gates actually bite.
--
-- STAGING ONLY. Never run against prod — it inserts synthetic harvests.
-- IDEMPOTENT: fixed UUIDs + ON CONFLICT DO NOTHING. Safe to re-run, and MUST be re-run
-- after any revert-rehearsal (that workflow resets the staging DB).
--
-- Re-run:  psql "$NEON_STAGING_URL" -f migrations/ops-stgweightparity-001/seed-weighted-harvests.sql
-- Verify:  psql "$NEON_STAGING_URL" -f migrations/ops-stgweightparity-001/verify.sql

\set ON_ERROR_STOP on

BEGIN;

-- Hard guard: refuse to run anywhere that looks like prod. Staging carries the
-- integration-test profiles; prod carries hundreds of live plantings.
DO $$
BEGIN
  IF (SELECT count(*) FROM plants WHERE deleted_at IS NULL) > 100 THEN
    RAISE EXCEPTION 'REFUSING: this database has % live plantings — looks like prod, not staging',
      (SELECT count(*) FROM plants WHERE deleted_at IS NULL);
  END IF;
END $$;

-- Anchor to whatever project/owner staging currently has. Resolved at run time so the
-- fixture survives a staging reset that regenerates ids.
CREATE TEMP TABLE _anchor ON COMMIT DROP AS
SELECT
  (SELECT id FROM plant_projects ORDER BY created_at LIMIT 1)         AS project_id,
  (SELECT id FROM profiles      ORDER BY id         LIMIT 1)          AS owner_id;

DO $$
BEGIN
  IF (SELECT project_id FROM _anchor) IS NULL OR (SELECT owner_id FROM _anchor) IS NULL THEN
    RAISE EXCEPTION 'REFUSING: staging has no plant_projects or no profiles to anchor the fixture to';
  END IF;
END $$;

-- ── Parent events ────────────────────────────────────────────────────────────────────
-- harvest_log.event_id is NOT NULL and FKs to event_log ON DELETE RESTRICT, so each
-- fixture row needs its own event. created_by is set at INSERT: the prevent_ownership_transfer
-- trigger is BEFORE UPDATE only, so inserting an owned row is not a transfer.
INSERT INTO event_log (id, project_id, event_type, event_date, title, notes, created_by, logged_by, is_public)
SELECT v.id, a.project_id, 'harvest', v.event_date, v.title,
       'OPS-STGWEIGHTPARITY-001 fixture — synthetic, staging only', a.owner_id, a.owner_id, false
FROM _anchor a,
(VALUES
  ('f0570000-0000-4000-8000-000000000001'::uuid, '2026-07-20 14:00:00+00'::timestamptz, 'fixture: measured weight'),
  ('f0570000-0000-4000-8000-000000000002'::uuid, '2026-07-21 14:00:00+00'::timestamptz, 'fixture: measured zero-gram boundary'),
  ('f0570000-0000-4000-8000-000000000003'::uuid, '2026-07-22 14:00:00+00'::timestamptz, 'fixture: cultivar-estimated weight'),
  ('f0570000-0000-4000-8000-000000000004'::uuid, '2026-07-23 14:00:00+00'::timestamptz, 'fixture: cultivar-estimated fractional'),
  ('f0570000-0000-4000-8000-000000000005'::uuid, '2026-07-24 14:00:00+00'::timestamptz, 'fixture: crop_type-estimated weight'),
  ('f0570000-0000-4000-8000-000000000006'::uuid, '2026-07-25 14:00:00+00'::timestamptz, 'fixture: count-only, no weight'),
  ('f0570000-0000-4000-8000-000000000007'::uuid, '2026-07-26 14:00:00+00'::timestamptz, 'fixture: measured, large weight'),
  ('f0570000-0000-4000-8000-000000000008'::uuid, '2026-07-27 14:00:00+00'::timestamptz, 'fixture: soft-deleted weighted row')
) AS v(id, event_date, title)
ON CONFLICT (id) DO NOTHING;

-- ── harvest_log fixture rows ─────────────────────────────────────────────────────────
-- Branch coverage against the three pairing CHECKs:
--   basis='measured'  => weight_estimated MUST be false
--   basis='cultivar'  => weight_estimated MUST be true
--   basis='crop_type' => weight_estimated MUST be true
--   weight_grams NULL => weight_estimated AND weight_basis both NULL
INSERT INTO harvest_log
  (id, event_id, project_id, quantity, unit, quality_rating, notes,
   created_by, weight_grams, weight_estimated, weight_basis, deleted_at)
SELECT v.id, v.event_id, a.project_id, v.quantity, v.unit, v.quality_rating,
       'OPS-STGWEIGHTPARITY-001 fixture — synthetic, staging only',
       a.owner_id, v.weight_grams, v.weight_estimated, v.weight_basis, v.deleted_at
FROM _anchor a,
(VALUES
  -- measured: estimated=false
  ('f0571000-0000-4000-8000-000000000001'::uuid, 'f0570000-0000-4000-8000-000000000001'::uuid,
   12::numeric, 'count', 4::smallint, 250.0::numeric, false, 'measured', NULL::timestamptz),
  -- measured at the >= 0 boundary of chk_harvest_log_weight_grams
  ('f0571000-0000-4000-8000-000000000002'::uuid, 'f0570000-0000-4000-8000-000000000002'::uuid,
   1::numeric, 'count', NULL::smallint, 0::numeric, false, 'measured', NULL::timestamptz),
  -- cultivar-derived estimate: estimated=true
  ('f0571000-0000-4000-8000-000000000003'::uuid, 'f0570000-0000-4000-8000-000000000003'::uuid,
   6::numeric, 'count', 5::smallint, 1360.5::numeric, true, 'cultivar', NULL::timestamptz),
  -- cultivar-derived, fractional grams (numeric precision path)
  ('f0571000-0000-4000-8000-000000000004'::uuid, 'f0570000-0000-4000-8000-000000000004'::uuid,
   3::numeric, 'count', 3::smallint, 12.34::numeric, true, 'cultivar', NULL::timestamptz),
  -- crop_type fallback estimate: estimated=true
  ('f0571000-0000-4000-8000-000000000005'::uuid, 'f0570000-0000-4000-8000-000000000005'::uuid,
   4::numeric, 'count', NULL::smallint, 500.0::numeric, true, 'crop_type', NULL::timestamptz),
  -- count-only control: the all-NULL side of both pairing CHECKs
  ('f0571000-0000-4000-8000-000000000006'::uuid, 'f0570000-0000-4000-8000-000000000006'::uuid,
   9::numeric, 'count', 2::smallint, NULL::numeric, NULL::boolean, NULL::text, NULL::timestamptz),
  -- measured, large weight + non-count unit
  ('f0571000-0000-4000-8000-000000000007'::uuid, 'f0570000-0000-4000-8000-000000000007'::uuid,
   33::numeric, 'lb', 4::smallint, 15000.0::numeric, false, 'measured', NULL::timestamptz),
  -- soft-deleted weighted row: catches a repair query that forgets `deleted_at IS NULL`
  ('f0571000-0000-4000-8000-000000000008'::uuid, 'f0570000-0000-4000-8000-000000000008'::uuid,
   2::numeric, 'count', NULL::smallint, 88.0::numeric, true, 'cultivar', '2026-07-28 00:00:00+00'::timestamptz)
) AS v(id, event_id, quantity, unit, quality_rating, weight_grams, weight_estimated, weight_basis, deleted_at)
ON CONFLICT (id) DO NOTHING;

COMMIT;
