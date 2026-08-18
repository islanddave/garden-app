-- V4-HARVHABITGAP-001 — ROLLBACK. Returns bee_balm's harvest_habit and repeat_interval_days to NULL.
--
-- SAFE, and destroys nothing recorded only here: the forward values are transcribed from
-- src/data/harvest-attributes-v1.json (by_crop_type.bee_balm) and its not_harvest_tracked.contested
-- entry, both of which survive a rollback. No DDL, no view, no Lambda coupling.
--
-- READ THIS BEFORE RUNNING IT. Rolling back does NOT restore a prior decision — it restores an
-- ABSENT one. NULL on this column means UNKNOWN, and the whole point of the forward migration is
-- that the answer stopped being unknown when Dave picked the plant. If the readiness band turns out
-- to be noisy on Monarda, the honest fix is either a different cadence (a forward migration with a
-- sourced number) or moving the slug back onto not_harvest_tracked with a stated reason — not a
-- silent NULL that reads as a coverage gap to the next person who audits this column.
--
-- Scoped by the exact forward values so a later hand-correction is never reverted to NULL by
-- someone re-running this file.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

UPDATE public.crop_types
   SET harvest_habit        = NULL,
       repeat_interval_days = NULL,
       updated_at           = now()
 WHERE slug = 'bee_balm'
   AND deleted_at IS NULL
   AND harvest_habit = 'cut_and_come_again'
   AND repeat_interval_days = 14;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.35.0-harvhabitgap-001-rollback',
        'ROLLBACK of 4.35.0-harvhabitgap-001: bee_balm harvest_habit/repeat_interval_days back to '
        'NULL. NOTE NULL here means UNKNOWN, not a decision — the pre-authored condition that set '
        'these values is still recorded in harvest-attributes-v1.json and still fired. Prefer a '
        'forward fix (a sourced cadence, or an explicit not_harvest_tracked entry).',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
