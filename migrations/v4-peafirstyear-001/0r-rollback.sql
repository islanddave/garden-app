-- V4-PEAFIRSTYEAR-001 rollback — return crop_types slug='pea' first_year_harvest to NULL.
--
-- NULL is the pre-migration value and it is MEANINGFUL, not merely absent: the column's own COMMENT
-- reads "NULL = unknown (engine falls back to heuristics)". So this restores "unknown", which is
-- what prod carried from v4-sowfirstyear-001 until 2026-08-28 — it does not assert that peas are
-- second-year.
--
-- WHAT ROLLING BACK COSTS. sowGoal() returns to reaching 'harvest' for a NULL-lifecycle pea only
-- through HARVEST_TEXT_RE matching prose in the cultivar's sow_notes. That is the fragility the
-- migration removed, so a rollback reinstates it knowingly. Prod has one such cultivar today
-- (Oregon Sugar Pod, 7943ecf7-5777-46d7-bcf7-b9e12d54d374); the 4 cultivars with an explicit
-- lifecycle='annual' are unaffected either way.
--
-- Scoped to slug='pea' alone. It must not touch the 28 slugs v4-sowfirstyear-001 seeded TRUE, nor
-- the deliberate NULLs on garlic/shallot/lemon_verbena that two sibling gates pin.
--
-- Deletes this migration's schema_version row, which DISARMS its self-arming post gates (each is
-- wrapped in an EXISTS on that row) — so after a rollback the gate corpus goes quiet about pea
-- rather than failing forever.

BEGIN;

UPDATE public.crop_types
   SET first_year_harvest = NULL,
       updated_at         = now()
 WHERE slug = 'pea'
   AND deleted_at IS NULL
   AND first_year_harvest IS DISTINCT FROM NULL;

DELETE FROM public.schema_version
 WHERE version = '4.63.3-peafirstyear-001';

COMMIT;
