-- 0r-rollback.sql
-- BUG-NOPLANTINGAUDIT-001 — detach the plants audit arms.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-plantingaudit-001/0r-rollback.sql
--
-- Detaches ONLY the two arms 0a added. `plants` keeps its seven pre-existing triggers
-- (prevent_ownership_transfer, set_updated_at, plants_entity_ins, plants_entity_softdel,
-- plants_entity_rename, trg_guard_entity_tag_plant, garden_node_bump) — this must never become a
-- blanket "drop the triggers on plants". Safe to run
-- whether or not 0a applied: both DROPs are IF EXISTS.
--
-- WHAT THIS DOES NOT DO, deliberately: it does not delete the audit_events rows already written for
-- plants, and it does not drop audit_stmt_delete / audit_stmt_update / audit_watched_slice.
-- Those three functions are SHARED — plant_varieties, event_log and harvest_log all depend on them
-- (OPS-HARVESTAUDIT-001), so dropping them here would silently disarm three other tables' audit
-- coverage while appearing to roll back only this one. That is the whole hazard of rolling back a
-- migration that attached to shared machinery rather than creating its own.
--
-- Rolling back does NOT re-open the defect quietly: gate post_plants_audit_arms_present is
-- self-armed on the 4.56.0-plantingaudit-001 schema_version row, so removing that row below returns
-- every post gate to vacuously-true rather than leaving them red. If you roll back and want the gap
-- to stay visible, leave the schema_version row in place and the gates will go RED, which is the
-- correct signal for "this was armed and someone took it away".
BEGIN;

DROP TRIGGER IF EXISTS trg_audit_plants_del ON public.plants;
DROP TRIGGER IF EXISTS trg_audit_plants_upd ON public.plants;

DELETE FROM public.schema_version WHERE version = '4.56.0-plantingaudit-001';

COMMIT;
