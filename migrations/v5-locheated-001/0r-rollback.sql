-- 0r-rollback.sql
-- V5-COLDCARDREACHABLE-001 — drop locations.heated and its schema_version stamp.
--
-- REHEARSED ON STAGING ONLY, between the staging apply and the staging re-apply. Never run on prod
-- once the reader has shipped: lambda/daily-plan/handler.js selects l.heated unconditionally, so
-- dropping the column under a deployed reader is not a rollback, it is an outage — every nightly plan
-- fails on a missing column and Today serves the previous day's stored plan until someone notices.
--
-- CORRECT PROD ROLLBACK ORDER, if it is ever needed (schema forward before code forward, code back
-- before schema back):
--   1. revert the reader (promote a main that predates the handler.js heated_resolved projection and
--      deploy the daily-plan Lambda), THEN
--   2. run this file.
-- In the other order the garden loses its plan.
--
-- WHAT IS UNRECOVERABLE: any heated value set after the apply. The House backfill is reconstructible
-- by re-applying 0a (its UPDATE is first-apply-only, and this file deletes the stamp that guards it).
-- Anything else is a fact that exists nowhere else — snapshot it first:
--
--   SELECT id, name FROM public.locations
--    WHERE (to_jsonb(locations) ->> 'heated')::boolean IS TRUE
--      AND id <> '7ee03125-2470-4400-a870-d931da1ffb92';
--
-- Nothing in the app can set heated today (no API field, no UI), so on a freshly applied branch that
-- query returns 0 rows by construction.
--
-- IF EXISTS so a rehearsal run twice, or run against a branch where 0a never landed, is a no-op.

BEGIN;

ALTER TABLE public.locations
  DROP COLUMN IF EXISTS heated;

DELETE FROM public.schema_version WHERE version = '5.0.0-locheated-001';

COMMIT;
