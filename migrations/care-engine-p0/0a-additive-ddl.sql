-- CARE-ENGINE-P0 — Step 0a: Additive DDL only (NO behavior change; engine runs in shadow).
-- Spec: care-engine-backbone-spec-V200-20260624.md §3.1 (evidence), §3.2 (findings), §3.4 (versioning).
-- Gates: G-EVID (evidence_class default + backfill + ingest-writer same unit), G-VER (engine_version persisted).
-- Convention: CHECK constraints (NOT pg enums) — matches every prior migration; the ONLY pg enum in this
--             DB is the pre-existing public.entity_type (planting/cultivar/crop/critter_species), a DIFFERENT
--             axis from the evidence row's spec entity_type — so evidence.entity_type is a NEW text+CHECK col.
-- Expand-contract: this is the EXPAND step. Old cols (tier/axis/polarity) are KEPT for the dual-window.
--                  CONTRACT (drop old cols) is a LATER migration, never here. See rollback file.
-- Sequence: 0a (this, DDL) -> 0b (backfill 103 rows + ingest dual-write live) -> 0c (VALIDATE + NOT NULL flips).
-- Idempotent: ADD COLUMN IF NOT EXISTS; constraints guarded; DROP-recreate. NEW required cols added NULLABLE
--             here; 0b backfills; 0c flips NOT NULL / VALIDATEs the CHECKs.

BEGIN;

-- ============================================================
-- 1. trust_rank lookup (§3.1 "held in a lookup keyed by source_tier"). A TABLE not a CASE map: adding a
--    source (e.g. sensor) is a one-row INSERT, no DDL, and the ordinal never renumbers stored rows.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.evidence_source_tier (
  source_tier             TEXT PRIMARY KEY
                            CHECK (source_tier IN
                              ('first_party_obs','strong_external','wikipedia','claude_distilled','dave_confirmed')),
  trust_rank              SMALLINT NOT NULL,
  default_strength_weight NUMERIC(4,3) NOT NULL
                            CHECK (default_strength_weight >= 0 AND default_strength_weight <= 1),
  corroborating           BOOLEAN NOT NULL,
  note                    TEXT
);

INSERT INTO public.evidence_source_tier (source_tier, trust_rank, default_strength_weight, corroborating, note) VALUES
  ('dave_confirmed',   5, 1.000, TRUE,  'Dave explicitly confirmed (top of ladder).'),
  ('first_party_obs',  4, 0.700, TRUE,  'Logged first-party observation/event/photo on THIS planting.'),
  ('strong_external',  3, 0.500, TRUE,  'General knowledge backed by >=1 cited/library source.'),
  ('claude_distilled', 2, 0.250, FALSE, 'AI-distilled from chats, uncorroborated — CLAMPED, non-corroborating.'),
  ('wikipedia',        1, 0.100, FALSE, 'Low-trust general reference / cross-transfer floor — non-corroborating.')
ON CONFLICT (source_tier) DO NOTHING;

-- ============================================================
-- 2. evidence — V2 generalization (§3.1). ALL ADDITIVE. Old tier/axis/polarity KEPT.
-- ============================================================
ALTER TABLE public.evidence
  ADD COLUMN IF NOT EXISTS evidence_class     TEXT,
  ADD COLUMN IF NOT EXISTS entity_type        TEXT,
  ADD COLUMN IF NOT EXISTS garden_node_id     UUID,
  ADD COLUMN IF NOT EXISTS claim_scope        TEXT,
  ADD COLUMN IF NOT EXISTS evidence_kind      TEXT,
  ADD COLUMN IF NOT EXISTS claim              TEXT,
  ADD COLUMN IF NOT EXISTS source_tier        TEXT,
  ADD COLUMN IF NOT EXISTS trust_rank         SMALLINT,
  ADD COLUMN IF NOT EXISTS strength_weight    NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS observed_until     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS captured_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provenance         TEXT,
  ADD COLUMN IF NOT EXISTS model_provenance   JSONB,
  ADD COLUMN IF NOT EXISTS source_record_id   TEXT,
  ADD COLUMN IF NOT EXISTS source_version     TEXT,
  ADD COLUMN IF NOT EXISTS target_evidence_id UUID,
  ADD COLUMN IF NOT EXISTS relation           TEXT,
  ADD COLUMN IF NOT EXISTS retracted          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS retracted_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retracted_by       TEXT,
  ADD COLUMN IF NOT EXISTS retraction_reason  TEXT;

-- schema_version stays smallint; CHECK admits {1,2} for the dual-read/dual-write window (§3.4). 0b bumps
-- existing rows to 2 only after the ingest writer dual-writes. EXPECTED_SCHEMA_VERSION in validate.js is
-- NOT changed until the consuming-code deploy (G-EVID same unit). Tighten CHECK to {2} at CONTRACT.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='evidence_garden_node_id_fkey') THEN
    ALTER TABLE public.evidence ADD CONSTRAINT evidence_garden_node_id_fkey
      FOREIGN KEY (garden_node_id) REFERENCES public.plants(id) ON DELETE RESTRICT;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='evidence_source_tier_fkey') THEN
    ALTER TABLE public.evidence ADD CONSTRAINT evidence_source_tier_fkey
      FOREIGN KEY (source_tier) REFERENCES public.evidence_source_tier(source_tier) NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='evidence_target_evidence_id_fkey') THEN
    ALTER TABLE public.evidence ADD CONSTRAINT evidence_target_evidence_id_fkey
      FOREIGN KEY (target_evidence_id) REFERENCES public.evidence(id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_class;
ALTER TABLE public.evidence ADD CONSTRAINT chk_evidence_class
  CHECK (evidence_class IN ('observation','knowledge','environment','feedback','outcome')) NOT VALID;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_entity_type;
ALTER TABLE public.evidence ADD CONSTRAINT chk_evidence_entity_type
  CHECK (entity_type IN ('organism','condition','abiotic','action','cultivar','guide')) NOT VALID;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_claim_scope;
ALTER TABLE public.evidence ADD CONSTRAINT chk_evidence_claim_scope
  CHECK (claim_scope IN ('crop','cultivar','planting')) NOT VALID;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_kind;
ALTER TABLE public.evidence ADD CONSTRAINT chk_evidence_kind
  CHECK (evidence_kind IN ('plant_note','guide','critter_lore','event_log','photo','sensor','user_note')) NOT VALID;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_provenance;
ALTER TABLE public.evidence ADD CONSTRAINT chk_evidence_provenance
  CHECK (provenance IN ('claude_distilled','dave_confirmed','user','system','external')) NOT VALID;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_relation;
ALTER TABLE public.evidence ADD CONSTRAINT chk_evidence_relation
  CHECK (relation IS NULL OR relation IN ('supports','refutes','confirms','corrects')) NOT VALID;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_strength_weight;
ALTER TABLE public.evidence ADD CONSTRAINT chk_evidence_strength_weight
  CHECK (strength_weight IS NULL OR (strength_weight >= 0 AND strength_weight <= 1)) NOT VALID;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_schema_version_dualwindow;
ALTER TABLE public.evidence ADD CONSTRAINT chk_evidence_schema_version_dualwindow
  CHECK (schema_version IN (1,2)) NOT VALID;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_planting_requires_node;
ALTER TABLE public.evidence ADD CONSTRAINT chk_evidence_planting_requires_node
  CHECK (claim_scope IS DISTINCT FROM 'planting' OR garden_node_id IS NOT NULL) NOT VALID;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_distilled_requires_model;
ALTER TABLE public.evidence ADD CONSTRAINT chk_evidence_distilled_requires_model
  CHECK (provenance IS DISTINCT FROM 'claude_distilled' OR model_provenance IS NOT NULL) NOT VALID;
ALTER TABLE public.evidence DROP CONSTRAINT IF EXISTS chk_evidence_relation_target_paired;
ALTER TABLE public.evidence ADD CONSTRAINT chk_evidence_relation_target_paired
  CHECK ((relation IS NULL) = (target_evidence_id IS NULL)) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_evidence_node_live
  ON public.evidence (garden_node_id) WHERE retracted = FALSE AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_evidence_entity_live
  ON public.evidence (entity_id) WHERE retracted = FALSE AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_evidence_class_live
  ON public.evidence (evidence_class) WHERE retracted = FALSE AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_source_record_live
  ON public.evidence (source_record_id)
  WHERE source_record_id IS NOT NULL AND retracted = FALSE AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_evidence_target
  ON public.evidence (target_evidence_id) WHERE target_evidence_id IS NOT NULL;

-- ============================================================
-- 3. findings — NEW (§3.2). Persistence for HYBRID compute (§9). Names match contract.js where present.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.findings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version          SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  engine_version          TEXT NOT NULL,
  record_version          INTEGER NOT NULL DEFAULT 1,
  garden_node_id          UUID NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  entity_id               UUID NOT NULL REFERENCES public.entity(id) ON DELETE RESTRICT,
  finding_type            TEXT NOT NULL,
  finding_kind            TEXT NOT NULL CHECK (finding_kind IN ('diagnostic','action')),
  statement               TEXT NOT NULL,
  recommended_action      JSONB,
  severity                TEXT NOT NULL CHECK (severity IN ('low','moderate','high')),
  confidence_local        NUMERIC(5,3) NOT NULL CHECK (confidence_local >= 0 AND confidence_local <= 1),
  confidence_transferable NUMERIC(5,3) NOT NULL CHECK (confidence_transferable >= 0 AND confidence_transferable <= 1),
  confidence_band         TEXT NOT NULL CHECK (confidence_band IN ('low','moderate','high')),
  tier                    TEXT CHECK (tier IS NULL OR tier IN
                            ('first_party_obs','strong_external','wikipedia','claude_distilled','dave_confirmed',
                             'first_party_log','corroborated_general','transferable_prior')),
  corroborator_count      INTEGER NOT NULL DEFAULT 0 CHECK (corroborator_count >= 0),
  assertion_mode          TEXT NOT NULL CHECK (assertion_mode IN ('assert','ask')),
  decay_state             TEXT NOT NULL CHECK (decay_state IN ('fresh','decaying','stale_unverified','dormant','resolved')),
  trend                   TEXT NOT NULL CHECK (trend IN ('improving','steady','worsening')),
  channel                 TEXT NOT NULL CHECK (channel IN ('ambient','operational')),
  urgency_level           TEXT CHECK (urgency_level IS NULL OR urgency_level IN ('low','moderate','high')),
  source_room             TEXT CHECK (source_room IS NULL OR source_room IN ('Knowledge','Garden','Critters')),
  confidence_basis        UUID[] NOT NULL DEFAULT '{}',
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at              TIMESTAMPTZ,
  CONSTRAINT chk_findings_action_requires_recaction
    CHECK (finding_kind <> 'action' OR recommended_action IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_findings_live_natural
  ON public.findings (garden_node_id, entity_id, finding_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_findings_node_live  ON public.findings (garden_node_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_findings_entity_live ON public.findings (entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_findings_engine_version ON public.findings (engine_version) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_findings_order_live ON public.findings (garden_node_id, decay_state, trend) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS findings_updated_at ON public.findings;
CREATE TRIGGER findings_updated_at BEFORE UPDATE ON public.findings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 4. daily_plan.engine_version (§3.4 / G-VER).
-- ============================================================
-- ============================================================
-- 4b. Relax evidence.observed_at to NULLABLE (§3.1 C + §4.4 null-time rule).
--     V1 shipped observed_at NOT NULL (ingest always supplied it). V2 `knowledge` evidence may carry
--     null observed_at (decays on captured_at, long half-life). Dropping NOT NULL is ADDITIVE/safe — it
--     widens what is accepted; every existing row already has a value; the V1 ingest writer is unaffected.
--     (Caught by COW dry-run TEST B: a knowledge INSERT with null observed_at hit the legacy NOT NULL.)
-- ============================================================
ALTER TABLE public.evidence ALTER COLUMN observed_at DROP NOT NULL;

ALTER TABLE public.daily_plan ADD COLUMN IF NOT EXISTS engine_version TEXT;

-- ============================================================
-- 5. schema_version ledger.
-- ============================================================
INSERT INTO public.schema_version (version, description)
VALUES ('care-engine-p0-0a',
        'CARE-ENGINE-P0 0a: evidence V2 generalization (additive), evidence_source_tier lookup, findings table, daily_plan.engine_version. CHECKs NOT VALID (VALIDATE in 0c). Old tier/axis/polarity KEPT (expand-contract).')
ON CONFLICT (version) DO NOTHING;

COMMIT;
