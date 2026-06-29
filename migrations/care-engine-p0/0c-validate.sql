-- CARE-ENGINE-P0 — Step 0c: VALIDATE constraints + flip NOT NULL on backfilled required cols.
-- Spec: §3.1. Pre-condition: 0b backfill verification (the SELECT in 0b) returns all-zero.
-- Runs AFTER 0b. Each VALIDATE scans existing rows once (cheap at 103 rows). SET NOT NULL requires a
-- full-NULL-free column (guaranteed by 0b). Idempotent: VALIDATE on an already-valid constraint is a
-- NO-OP; SET NOT NULL on an already-NOT-NULL column is a NO-OP.

BEGIN;

-- 1. VALIDATE the NOT VALID CHECKs from 0a (now that 0b backfilled all rows).
ALTER TABLE public.evidence VALIDATE CONSTRAINT chk_evidence_class;
ALTER TABLE public.evidence VALIDATE CONSTRAINT chk_evidence_entity_type;
ALTER TABLE public.evidence VALIDATE CONSTRAINT chk_evidence_claim_scope;
ALTER TABLE public.evidence VALIDATE CONSTRAINT chk_evidence_kind;
ALTER TABLE public.evidence VALIDATE CONSTRAINT chk_evidence_provenance;
ALTER TABLE public.evidence VALIDATE CONSTRAINT chk_evidence_relation;
ALTER TABLE public.evidence VALIDATE CONSTRAINT chk_evidence_strength_weight;
ALTER TABLE public.evidence VALIDATE CONSTRAINT chk_evidence_schema_version_dualwindow;
ALTER TABLE public.evidence VALIDATE CONSTRAINT chk_evidence_planting_requires_node;
ALTER TABLE public.evidence VALIDATE CONSTRAINT chk_evidence_distilled_requires_model;
ALTER TABLE public.evidence VALIDATE CONSTRAINT chk_evidence_relation_target_paired;

-- 2. VALIDATE the FK that was added NOT VALID (source_tier).
ALTER TABLE public.evidence VALIDATE CONSTRAINT evidence_source_tier_fkey;

-- 3. Flip NOT NULL on the REQUIRED (R) generalization columns (all backfilled in 0b).
--    garden_node_id is CONDITIONAL (C) -> stays nullable, governed by chk_evidence_planting_requires_node.
--    Optional/conditional cols (observed_until, model_provenance, source_record_id, source_version,
--    target_evidence_id, relation, observed_at[V1 already NOT NULL], retracted_*) stay nullable.
ALTER TABLE public.evidence
  ALTER COLUMN evidence_class  SET NOT NULL,
  ALTER COLUMN entity_type     SET NOT NULL,
  ALTER COLUMN claim_scope     SET NOT NULL,
  ALTER COLUMN evidence_kind   SET NOT NULL,
  ALTER COLUMN claim           SET NOT NULL,
  ALTER COLUMN source_tier     SET NOT NULL,
  ALTER COLUMN trust_rank      SET NOT NULL,
  ALTER COLUMN strength_weight SET NOT NULL,
  ALTER COLUMN captured_at     SET NOT NULL,
  ALTER COLUMN provenance      SET NOT NULL;
-- retracted already NOT NULL DEFAULT FALSE from 0a.

INSERT INTO public.schema_version (version, description)
VALUES ('care-engine-p0-0c',
        'CARE-ENGINE-P0 0c: VALIDATE all evidence CHECKs + source_tier FK; SET NOT NULL on evidence_class/entity_type/claim_scope/evidence_kind/claim/source_tier/trust_rank/strength_weight/captured_at/provenance. garden_node_id stays nullable (conditional, governed by chk_evidence_planting_requires_node).')
ON CONFLICT (version) DO NOTHING;

COMMIT;
