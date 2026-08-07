-- 0r-rollback.sql
-- BUG-SEEDEDGATE-001 — exact reversal of 0a-view.sql.
--
-- Re-issues the PRE-CHANGE definition of public.v_resolved_care verbatim, captured from live prod
-- with pg_get_viewdef('public.v_resolved_care'::regclass, true) at authoring time (2026-08-07,
-- before 0a was applied anywhere). It is reproduced byte-for-byte rather than retyped from the
-- foundation migration, because the live definition is the thing being rolled back to.
--
-- CREATE OR REPLACE VIEW cannot DROP columns — Postgres refuses with "cannot drop columns from
-- view". So this rollback must DROP the view and recreate it. That is safe here and only here,
-- because 0a verified the precondition that makes it safe: v_resolved_care has ZERO dependent
-- objects on prod (no matviews, no dependent views, no non-owner grants). DROP VIEW without CASCADE
-- is deliberate — if a dependent has appeared since 0a was applied, this rollback FAILS LOUDLY
-- rather than silently destroying it. Re-check dependents before forcing anything.
--
-- ORDER: run this only AFTER the code that reads the new columns has been rolled back or is running
-- with CARE_CADENCE_SCOPES_ENABLED unset. handler.js selects vrc.cadence_scopes / vrc.resolved_scopes
-- unconditionally once the code slice ships, so dropping the columns under a deployed reader makes
-- the nightly planting query throw and empties the daily plan for every user. Code first, then this.

BEGIN;

DROP VIEW public.v_resolved_care;

CREATE VIEW public.v_resolved_care AS
 SELECT n.id AS leaf_id,
    ((( SELECT care_profile.profile
           FROM care_profile
          WHERE care_profile.scope = 'system'::care_scope)) || COALESCE(cd.profile, '{}'::jsonb)) || COALESCE(lo.profile, '{}'::jsonb) AS resolved_profile
   FROM plants n
     LEFT JOIN care_profile cd ON cd.scope = 'cultivar'::care_scope AND cd.scope_id = n.variety_id
     LEFT JOIN care_profile lo ON lo.scope = 'leaf'::care_scope AND lo.scope_id = n.id;

DELETE FROM public.schema_version WHERE version = '4.23.3-seededgate-001';

COMMIT;
