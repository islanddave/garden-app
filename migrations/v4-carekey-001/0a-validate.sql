-- v4-carekey-001/0a-validate.sql
-- Care re-key (project_id -> plant_id) Phase E: VALIDATE the constraint Phase A left NOT VALID.
-- Design V100 §3-E. Continues migrations/care-rekey-001/ (0a additive DDL + 0b backfill, both
-- applied to staging + prod 2026-07-24).
--
-- THIS IS A DEPLOY BOUNDARY, NOT A NEUTRAL PRE-STEP. Arming a constraint is forward-INCOMPATIBLE
-- when it constrains a value only the NEW writer sets. The falsifiable test is answered in
-- gates.yml and README.md against the DEPLOYED prod artifact, not against the branch in hand.
--
-- SCOPE IS ONE CONSTRAINT. Live prod introspection (pg_constraint.convalidated) at authoring time:
--   entity_memory_plant_id_fkey       convalidated = t   -- 0a added it WITHOUT `NOT VALID`, so
--                                                           Postgres validated it at ADD time.
--   entity_memory_exactly_one_parent  convalidated = t   -- CHECKs added without NOT VALID likewise.
--   event_log_has_anchor              convalidated = f   -- the only one left. THIS FILE.
-- Design §3-E says "the NOT VALID constraints" (plural); live schema says there is exactly one.
-- Live schema wins (migrations lag manual ALTERs in this project).
--
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on event_log — it does NOT block reads, INSERTs
-- or UPDATEs; it blocks only DDL and other VALIDATEs. event_log is 12,447 rows. The scan is
-- sub-second and the lock is not user-visible. This is why VALIDATE is safe to run online and the
-- original ALTER ... ADD CHECK was not.
--
-- Idempotent: the DO-block skips when the constraint is already validated, so a re-run is a no-op
-- rather than a redundant table scan.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'event_log_has_anchor' AND NOT convalidated) THEN
    ALTER TABLE public.event_log VALIDATE CONSTRAINT event_log_has_anchor;
  END IF;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.2-carekey-001-validate',
        'Care re-key Phase E: VALIDATE event_log_has_anchor (plant_id IS NOT NULL OR project_id IS NOT NULL). No row data touched.')
ON CONFLICT (version) DO NOTHING;
