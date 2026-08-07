-- 0a-additive-ddl.sql
-- BUG-DIVERGENCEVOCAB-001 — plants.divergence_type: record the CANONICAL vocabulary in-repo.
--
-- WHAT THE DEFECT ACTUALLY WAS (this is a code bug, not a schema bug):
--   plants.divergence_type carried two disjoint vocabularies.
--     * live DB CHECK plants_divergence_type_check : division | cutting | saved_seed_from
--     * lambda/plants/index.js ALLOWED_DIVERGENCE  : mutation | cross | selection | unknown
--   Zero overlap, so every value the API accepted the database rejected (23514 -> 400) and every
--   value the database would accept the API rejected first. The feature was dead in both
--   directions. 0 prod rows / 0 staging rows carry a non-NULL divergence_type, so nothing was
--   corrupted -- it was simply never writable.
--
--   The DB side is the DESIGNED vocabulary. proj-rescope-plan V100/V101/V102 §4.1 authored the
--   column as, verbatim:
--       -- Plant: parent_plant_id (narrow semantics: divergence only)
--       ADD COLUMN divergence_type TEXT
--         CHECK (divergence_type IN ('division','cutting','saved_seed_from') OR ... IS NULL);
--   and V102 §schema-map line 54 states the edge as
--       parent_plant_id -> Planting (narrow: division/cutting/saved-seed).
--   divergence_type therefore TYPES THE PARENT EDGE: given parent_plant_id, how was this planting
--   propagated OFF that parent. The lambda's mutation/cross/selection set was invented at
--   implementation time (commit a265aa6, "V1.2a-4 S1") under a comment claiming it "Mirrors DB
--   CHECK constraints" -- provably false against the very plan that commit cites. That set is
--   breeding-genetics vocabulary, which V102 §40 explicitly DEFERS to V4 BREEDING-LINES
--   ("VarietyLine deferred to V4"), with plants.lineage_note as the interim free-text escape hatch.
--   So the fix is: lambda adopts the DB vocabulary. The schema does not move.
--
-- WHY A MIGRATION AT ALL, THEN:
--   Because no migration file in this repo ever created this column or this constraint. The DDL
--   was applied by hand from the plan document during V1.2a-4 S1 and never backfilled into
--   migrations/ -- one instance of the gap garden-app-fullstack-audit-20260723.md §M5 records
--   ("~14 columns written with no creating migration -> fresh-env replay 42703s"). Two consequences
--   this file closes:
--     1. a fresh environment replayed from migrations/ has no divergence_type at all;
--     2. the vocabulary had no machine-readable home, which is precisely why a hand-copied literal
--        in a Lambda could drift from it unnoticed for 15 months. lambda/plants/divergence-enum.test.js
--        now PARSES the CHECK below and asserts the Lambda allowlist equals it as a set, so this
--        file is the single source of truth and the drift is CI-detectable.
--
-- EFFECT ON prod AND staging: NONE. Verified read-only 2026-08-06 -- both already carry
--   plants_divergence_type_check with exactly this predicate, convalidated = t. Every statement
--   below is existence-guarded, so on those two databases this file is a pure no-op that records
--   a schema_version row. It only does real work on an environment that lacks the column, i.e. a
--   fresh replay.
--
-- SAFETY: additive + idempotent. ADD COLUMN IF NOT EXISTS (nullable, no DEFAULT -> metadata-only,
--   no table rewrite). The CHECK is added NOT VALID and guarded by a pg_constraint existence test,
--   so it is never dropped/recreated on an environment that already has it (dropping a validated
--   constraint to re-add it NOT VALID would be a strict regression). VALIDATE happens separately
--   in 0c-validate.sql, AFTER the writer deploy -- see the apply order below.
--
-- APPLY ORDER (the 2026-08-03 outage rule: arming a CHECK is a deploy, not a migration):
--   0a (this file)  -- pre-deploy, additive only, no constraint armed
--   deploy          -- ship the plants Lambda carrying the reconciled ALLOWED_DIVERGENCE
--   0c-validate.sql -- post-deploy, arms/validates the constraint
--   The window between 0a and the deploy is safe by construction here: the OLD deployed Lambda can
--   only emit mutation/cross/selection/unknown, all four of which its OWN allowlist gates and the
--   CHECK rejects, so it has never written this column and cannot produce a violating row. That is
--   an argument about the currently-deployed artifact, not about this branch -- 0c restates it as a
--   gate rather than trusting it.
--
-- NOT applied to any environment by the authoring session -- apply is Dave-gated, staging first.

ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS divergence_type text;

-- Canonical vocabulary. Kept byte-comparable with the live predicate on prod/staging so the
-- drift-guard test can parse one list and compare it against both Lambda literals.
-- NULL is permitted and MEANS "not recorded" -- that is why there is no 'unknown' member: an
-- explicit unknown sentinel alongside a nullable column gives two spellings of one state, and
-- loss_cause's 'unknown' (a value the user actively chooses over naming a cause) is not the same
-- shape. Free-text nuance that outgrows these three belongs in plants.lineage_note.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plants_divergence_type_check') THEN
    ALTER TABLE public.plants ADD CONSTRAINT plants_divergence_type_check
      CHECK ((divergence_type = ANY (ARRAY['division'::text, 'cutting'::text, 'saved_seed_from'::text]))
             OR (divergence_type IS NULL)) NOT VALID;
  END IF;
END $$;

-- Also recorded here for fresh-env parity: the lineage edge itself and its partial index, from the
-- same V102 §4.1 block. Guarded identically; no-ops wherever they already exist.
ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS parent_plant_id uuid,
  ADD COLUMN IF NOT EXISTS lineage_note text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plants_parent_plant_id_fkey') THEN
    ALTER TABLE public.plants ADD CONSTRAINT plants_parent_plant_id_fkey
      FOREIGN KEY (parent_plant_id) REFERENCES public.plants(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_plants_parent_plant_id
  ON public.plants (parent_plant_id)
  WHERE parent_plant_id IS NOT NULL AND deleted_at IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.24.0-divergencevocab-001','BUG-DIVERGENCEVOCAB-001 phase 1/2 (PRE-DEPLOY, additive only). Records plants.divergence_type + plants_divergence_type_check (division|cutting|saved_seed_from, NOT VALID when newly created) + parent_plant_id FK + lineage_note + idx_plants_parent_plant_id in-repo for the first time; the V1.2a-4 S1 hand-apply never produced a migration file. No-op on prod and staging, which already carry the identical validated predicate (verified read-only 2026-08-06). The DB vocabulary is canonical per proj-rescope-plan V102 §4.1; the Lambda allowlist mutation/cross/selection/unknown was the defect and is reconciled in code, not here. Arming/validating is deferred to 0c-validate.sql, post-deploy.')
ON CONFLICT (version) DO NOTHING;
