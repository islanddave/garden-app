-- 0r-rollback.sql
-- BUG-DIVERGENCEVOCAB-001 — rollback.
--
-- WHAT ROLLING BACK MEANS HERE: dropping the CHECK, i.e. returning plants.divergence_type to an
--   unconstrained text column. That is the only reversible part. It is the correct response to
--   exactly one situation: 0c armed the constraint and a writer nobody accounted for is now taking
--   23514s in prod. Dropping the CHECK unblocks writes immediately; the vocabulary is then
--   re-established by fixing the writer and re-running 0c.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO: it does not drop divergence_type, parent_plant_id or
--   lineage_note, and it does not delete any row. Those columns hold user-meaningful lineage data
--   (Soft-Delete-Only). Prod already carries 1 non-NULL parent_plant_id and 2 non-NULL
--   lineage_notes; DROP COLUMN would destroy them irreversibly to undo a constraint. It also does
--   not drop the FK or the index, which predate this migration on every real environment -- 0a
--   only recorded them, so "undoing" them would take prod further from its intended shape, not
--   closer. If a fresh replay genuinely needs the columns gone, that is a DROP DATABASE, not this.
--
-- SAFETY: idempotent (DROP CONSTRAINT IF EXISTS). No data change. Re-runnable.
--
-- AFTER RUNNING THIS: the schema_version rows are left in place on purpose -- they record what was
--   applied, and rewriting history to hide a rollback is how the next session mis-reads the state.
--   Note the rollback in the ledger instead.

ALTER TABLE public.plants DROP CONSTRAINT IF EXISTS plants_divergence_type_check;

INSERT INTO public.schema_version (version, description)
VALUES ('4.24.2-divergencevocab-001-rollback','BUG-DIVERGENCEVOCAB-001 ROLLBACK: dropped plants_divergence_type_check, leaving divergence_type unconstrained text. Columns, FK, index and all rows intentionally preserved (Soft-Delete-Only). Re-run 0a then 0c to restore, after fixing whichever writer was emitting an out-of-vocabulary value.')
ON CONFLICT (version) DO NOTHING;
