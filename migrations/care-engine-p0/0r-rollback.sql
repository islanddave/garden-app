-- CARE-ENGINE-P0 — Rollback (per-step, expand-contract safe). Because every step is ADDITIVE, the
-- rollback is "drop the new objects." The OLD evidence columns (tier/axis/polarity) were never touched,
-- so dropping the new cols fully restores the V1 schema. SAFE to run on prod ONLY before any consuming
-- code reads the new cols. After the dual-write Lambda is live, prefer leaving DDL in place (additive,
-- harmless) and rolling back the Lambda instead — additive DDL ahead of code is the whole point.
--
-- NOTE: this is the rollback of the EXPAND. The CONTRACT phase (dropping tier/axis/polarity) is a SEPARATE
-- future migration and has its OWN rollback; it is NOT part of P0.

BEGIN;

-- restore observed_at NOT NULL FIRST (before any column drops) — P0 widened it to nullable. Guard: any
-- V2 knowledge row with null observed_at is backfilled to captured_at before re-tightening (captured_at
-- still exists at this point in the rollback; the col-drop block runs later). Caught by COW rollback dry-run.
UPDATE public.evidence SET observed_at = captured_at WHERE observed_at IS NULL AND captured_at IS NOT NULL;
ALTER TABLE public.evidence ALTER COLUMN observed_at SET NOT NULL;


-- --- 0c rollback: re-loosen NOT NULL (constraints can stay VALIDATEd harmlessly; loosen for full revert)
ALTER TABLE public.evidence
  ALTER COLUMN evidence_class  DROP NOT NULL,
  ALTER COLUMN entity_type     DROP NOT NULL,
  ALTER COLUMN claim_scope     DROP NOT NULL,
  ALTER COLUMN evidence_kind   DROP NOT NULL,
  ALTER COLUMN claim           DROP NOT NULL,
  ALTER COLUMN source_tier     DROP NOT NULL,
  ALTER COLUMN trust_rank      DROP NOT NULL,
  ALTER COLUMN strength_weight DROP NOT NULL,
  ALTER COLUMN captured_at     DROP NOT NULL,
  ALTER COLUMN provenance      DROP NOT NULL;

-- --- 0a rollback: drop findings table, daily_plan col, evidence new cols + constraints + lookup.
DROP TABLE IF EXISTS public.findings;            -- drops its indexes + trigger.
ALTER TABLE public.daily_plan DROP COLUMN IF EXISTS engine_version;

-- evidence constraints (drop before columns).
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_class;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_entity_type;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_claim_scope;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_kind;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_provenance;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_relation;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_strength_weight;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_schema_version_dualwindow;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_planting_requires_node;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_distilled_requires_model;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_relation_target_paired;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS evidence_garden_node_id_fkey;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS evidence_source_tier_fkey;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS evidence_target_evidence_id_fkey;

-- evidence indexes.
DROP INDEX IF EXISTS public.idx_evidence_node_live;
DROP INDEX IF EXISTS public.idx_evidence_entity_live;
DROP INDEX IF EXISTS public.idx_evidence_class_live;
DROP INDEX IF EXISTS public.uq_evidence_source_record_live;
DROP INDEX IF EXISTS public.idx_evidence_target;

-- evidence new columns. (0b backfilled only these; old cols untouched -> V1 schema restored.)
ALTER TABLE public.evidence
  DROP COLUMN IF EXISTS evidence_class,
  DROP COLUMN IF EXISTS entity_type,
  DROP COLUMN IF EXISTS garden_node_id,
  DROP COLUMN IF EXISTS claim_scope,
  DROP COLUMN IF EXISTS evidence_kind,
  DROP COLUMN IF EXISTS claim,
  DROP COLUMN IF EXISTS source_tier,
  DROP COLUMN IF EXISTS trust_rank,
  DROP COLUMN IF EXISTS strength_weight,
  DROP COLUMN IF EXISTS observed_until,
  DROP COLUMN IF EXISTS captured_at,
  DROP COLUMN IF EXISTS provenance,
  DROP COLUMN IF EXISTS model_provenance,
  DROP COLUMN IF EXISTS source_record_id,
  DROP COLUMN IF EXISTS source_version,
  DROP COLUMN IF EXISTS target_evidence_id,
  DROP COLUMN IF EXISTS relation,
  DROP COLUMN IF EXISTS retracted,
  DROP COLUMN IF EXISTS retracted_at,
  DROP COLUMN IF EXISTS retracted_by,
  DROP COLUMN IF EXISTS retraction_reason;

-- schema_version 0b row bumped evidence.schema_version 1->2; restore to 1.
UPDATE public.evidence SET schema_version = 1 WHERE schema_version = 2;

DROP TABLE IF EXISTS public.evidence_source_tier;

DELETE FROM public.schema_version WHERE version IN ('care-engine-p0-0a','care-engine-p0-0b','care-engine-p0-0c');

COMMIT;
