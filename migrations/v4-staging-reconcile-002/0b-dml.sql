-- 0b-dml.sql
-- Finish the reconcile: give the 4 grandfathered staging rows a kind so the constraint can be
-- VALIDATED, closing the last real difference between staging and prod.
--
-- v4-staging-reconcile-001 added plant_projects_kind_not_null_unless_deleted as NOT VALID because
-- staging held 4 alive rows with kind NULL. NOT VALID enforces on new writes (which is what made
-- the integration fixtures fail honestly, and they were then fixed), but it leaves
-- convalidated = false where prod is convalidated = true. That is a genuine remaining drift: any
-- audit comparing validation state still reads staging as different, and the rows themselves stay
-- in a state prod would never have produced.
--
-- THE 4 ROWS (measured 2026-07-31, staging): "Build Out", "Basil", "Chilis", "Peppers". These are
-- real staging seed projects, not test residue — each is a single growing project of the sort that
-- carries plantings, events and harvests.
--
-- WHY 'campaign', from three converging sources:
--   1. plant_projects_kind_check permits 'campaign' | 'category' | 'cultivar'.
--   2. lambda/projects/index.js POST coalesces a missing kind to 'campaign' — an explicit
--      server-side backstop, so a project created through the real path lands here.
--   3. Prod distribution: campaign 52 / category 24 / cultivar 5, and every alive row is campaign
--      or category. 'category' means a grouping folder; none of these four is one.
--
-- SAFETY: kind is not an ownership column, so prevent_ownership_transfer (which fires on
-- created_by) does not apply — no trigger dance needed here.
-- IDEMPOTENT: guarded on IS NULL, so a re-run is a no-op and never overwrites a real kind.
-- REVERSIBLE in principle, but pointless: reverting would restore rows prod's schema forbids.

UPDATE public.plant_projects
   SET kind = 'campaign',
       updated_at = now()
 WHERE kind IS NULL
   AND deleted_at IS NULL;
