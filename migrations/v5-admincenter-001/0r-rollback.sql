-- 0r-rollback.sql
-- V5-ADMINCENTER-001 — rollback of user_notification_prefs.nav_tabs.
--
-- THIS ROLLBACK IS A BEHAVIOURAL NO-OP, and that is a property of the design rather than luck.
-- NULL means "use the shipped default order", so a client reading prefs from a database where the
-- column has been dropped sees exactly what it sees when the column is present and unset: no
-- nav_tabs key, resolveNavTabs(undefined), the shipped five tabs. No client change, no deploy, no
-- window in which the nav is wrong. That is the whole reason NULL was given that meaning.
--
-- ORDER. Constraint first, then the column — dropping a column silently drops its CHECK too, but
-- naming it makes the rehearsal assert both, and a re-apply after a partial failure needs the
-- constraint gone by name or the IF NOT EXISTS guard in 0a skips recreating it.
--
-- DATA LOSS, STATED PRECISELY: every user's chosen tab order. That is one small array per user, on a
-- table with a handful of rows, and re-entering it is a few taps on /admin/config. Nothing else in
-- the database references this column, so the loss is bounded to it. There is no export step here
-- because the value is trivially reconstructible and re-entering it is cheaper than restoring it.
--
-- SEQUENCING IF THE LAMBDA HAS ALREADY SHIPPED. If (and only if) the critter Lambda has been
-- deployed with nav_tabs in its prefs SELECT list, revert THAT first: an explicit SELECT list naming
-- a dropped column 500s every prefs read, and eight surfaces plus the nav config read that route.
-- Old Lambda + new schema is inert and safe; new Lambda + old schema is the hard direction, exactly
-- as v5-varietyhybridflag-001/gates.yml describes for its own pair.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

ALTER TABLE public.user_notification_prefs
  DROP CONSTRAINT IF EXISTS chk_unp_nav_tabs_shape;

ALTER TABLE public.user_notification_prefs
  DROP COLUMN IF EXISTS nav_tabs;

DELETE FROM public.schema_version WHERE version = '4.102.0-admincenter-001';

COMMIT;
