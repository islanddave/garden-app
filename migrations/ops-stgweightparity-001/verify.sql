-- OPS-STGWEIGHTPARITY-001 — post-seed gates. Every row must read PASS.
-- Run: psql "$NEON_STAGING_URL" -f migrations/ops-stgweightparity-001/verify.sql

\pset format aligned

WITH g AS (
  SELECT 'G1 weighted rows exist (gates no longer vacuous)' AS gate,
         (SELECT count(*) FROM harvest_log WHERE weight_grams IS NOT NULL) >= 6 AS ok,
         (SELECT count(*)::text FROM harvest_log WHERE weight_grams IS NOT NULL) AS detail
  UNION ALL
  -- Was `count(DISTINCT weight_basis) = 3`. A cardinality equality is the wrong assertion twice
  -- over: it FAILS on prod today (prod has no crop_type row, so distinct = 2) and it would fail
  -- again the moment V4-HARVBASIS-SAMPLE-001 introduces a 4th value. What the gate actually wants
  -- is "the three fixture bases are all present", which is a containment test and is stable under
  -- any future vocabulary widening.
  SELECT 'G2 all three seeded weight_basis values present',
         (SELECT count(DISTINCT weight_basis) FROM harvest_log
           WHERE weight_basis IN ('measured','cultivar','crop_type')) = 3,
         (SELECT string_agg(DISTINCT weight_basis, ',') FROM harvest_log WHERE weight_basis IS NOT NULL)
  UNION ALL
  SELECT 'G3 NULL-weight control row present',
         EXISTS (SELECT 1 FROM harvest_log
                 WHERE weight_grams IS NULL AND weight_estimated IS NULL AND weight_basis IS NULL),
         (SELECT count(*)::text FROM harvest_log WHERE weight_grams IS NULL)
  UNION ALL
  SELECT 'G4 zero pairing violations (grams vs estimated)',
         NOT EXISTS (SELECT 1 FROM harvest_log
                     WHERE (weight_grams IS NULL) <> (weight_estimated IS NULL)),
         '0 expected'
  UNION ALL
  SELECT 'G5 zero pairing violations (grams vs basis)',
         NOT EXISTS (SELECT 1 FROM harvest_log
                     WHERE (weight_grams IS NULL) <> (weight_basis IS NULL)),
         '0 expected'
  UNION ALL
  SELECT 'G6 measured<=>estimated=false invariant holds',
         NOT EXISTS (SELECT 1 FROM harvest_log
                     WHERE weight_basis IS NOT NULL
                       AND weight_estimated <> (weight_basis <> 'measured')),
         '0 expected'
  UNION ALL
  SELECT 'G7 all three CHECKs still VALIDATED',
         (SELECT count(*) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
          WHERE c.relname = 'harvest_log' AND con.contype = 'c' AND con.convalidated
            AND con.conname IN ('chk_harvest_log_weight_pairing',
                                'chk_harvest_log_weight_basis_pairing',
                                'chk_harvest_log_weight_basis_estimated')) = 3,
         'expect 3'
  UNION ALL
  SELECT 'G8 soft-deleted weighted row present (deleted_at trap)',
         EXISTS (SELECT 1 FROM harvest_log WHERE deleted_at IS NOT NULL AND weight_grams IS NOT NULL),
         '1 expected'
)
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, gate, detail FROM g ORDER BY gate;
