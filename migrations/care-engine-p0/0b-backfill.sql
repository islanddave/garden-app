-- CARE-ENGINE-P0 — Step 0b: Backfill the 103 existing evidence rows + daily_plan engine_version.
-- Spec: §3.1 (field mapping), §13 G-EVID. Idempotent: every UPDATE guarded by "IS NULL". Run AFTER 0a,
-- BEFORE 0c.
--
-- ORDERING NOTE (caught by COW dry-run): a NOT VALID CHECK still enforces on rows TOUCHED by an UPDATE.
-- So garden_node_id MUST be resolved BEFORE (or in the same statement as) setting claim_scope='planting',
-- else chk_evidence_planting_requires_node fires mid-backfill. Order below: resolve node first, then set
-- claim_scope in a single CASE that only assigns 'planting' when a node is present.
--
-- Live ground truth (introspected prod, 2026-06-29): all 103 rows are tier=first_party_log, axis=local,
-- polarity=supporting, deleted_at IS NULL, schema_version=1. Mapping written generally (CASE over all V1
-- tiers) so it is correct even though current data is uniform.
--
-- V1 tier -> V2 source_tier:  dave_confirmed->dave_confirmed | first_party_log->first_party_obs |
--   corroborated_general->strong_external | claude_distilled->claude_distilled | transferable_prior->wikipedia
-- V1 polarity is KEPT (old column) through the dual-window; `relation` is the typed-EDGE field for
--   feedback items (target_evidence_id), left NULL for standalone V1 rows (chk_evidence_relation_target_paired).

BEGIN;

-- 1. evidence_class — all existing rows are first-party plant observations -> 'observation' (G-EVID).
UPDATE public.evidence SET evidence_class = 'observation' WHERE evidence_class IS NULL;

-- 2. entity_type (spec axis) — a first-party plant observation is about the organism -> 'organism'.
UPDATE public.evidence SET entity_type = 'organism' WHERE entity_type IS NULL;

-- 3. garden_node_id — resolve FIRST (before claim_scope) via the entity registry. For entity_type='planting'
--    the registry carries planting_ref_id -> plants.id.
UPDATE public.evidence ev
SET garden_node_id = e.planting_ref_id
FROM public.entity e
WHERE ev.garden_node_id IS NULL
  AND ev.entity_id = e.id
  AND e.entity_type = 'planting'
  AND e.planting_ref_id IS NOT NULL;

-- 4. claim_scope — set in ONE statement that assigns 'planting' ONLY when a node was resolved in step 3,
--    else 'cultivar' (honest granularity for cultivar/crop/critter-bound evidence). This guarantees
--    chk_evidence_planting_requires_node holds at write time for every touched row.
UPDATE public.evidence
SET claim_scope = CASE WHEN garden_node_id IS NOT NULL THEN 'planting' ELSE 'cultivar' END
WHERE claim_scope IS NULL;

-- 4b. entity_type honesty for non-planting-bound rows downgraded to cultivar scope (0 rows on current
--     prod data; defensive). Critter-bound -> 'organism'; cultivar/crop -> 'cultivar'.
UPDATE public.evidence ev
SET entity_type = CASE WHEN e.entity_type = 'critter_species' THEN 'organism' ELSE 'cultivar' END
FROM public.entity e
WHERE ev.entity_id = e.id
  AND ev.claim_scope = 'cultivar'
  AND ev.garden_node_id IS NULL
  AND ev.entity_type = 'organism';

-- 5. evidence_kind — source-type from V1 tier.
UPDATE public.evidence SET evidence_kind = CASE
    WHEN tier = 'first_party_log'      THEN 'plant_note'
    WHEN tier = 'corroborated_general' THEN 'guide'
    WHEN tier = 'transferable_prior'   THEN 'guide'
    WHEN tier = 'claude_distilled'     THEN 'plant_note'
    WHEN tier = 'dave_confirmed'       THEN 'plant_note'
    ELSE 'plant_note' END
  WHERE evidence_kind IS NULL;

-- 6. claim — carry V1 note; noteless -> placeholder so the 0c NOT NULL flip holds.
UPDATE public.evidence SET claim = COALESCE(NULLIF(TRIM(note), ''), 'observation logged') WHERE claim IS NULL;

-- 7. source_tier — V1 tier -> V2 source_tier map.
UPDATE public.evidence SET source_tier = CASE tier
    WHEN 'dave_confirmed'       THEN 'dave_confirmed'
    WHEN 'first_party_log'      THEN 'first_party_obs'
    WHEN 'corroborated_general' THEN 'strong_external'
    WHEN 'claude_distilled'     THEN 'claude_distilled'
    WHEN 'transferable_prior'   THEN 'wikipedia'
  END
  WHERE source_tier IS NULL;

-- 8. trust_rank + strength_weight — denormalize from the lookup.
UPDATE public.evidence ev
SET trust_rank = st.trust_rank, strength_weight = st.default_strength_weight
FROM public.evidence_source_tier st
WHERE ev.source_tier = st.source_tier
  AND (ev.trust_rank IS NULL OR ev.strength_weight IS NULL);

-- 9. captured_at — system write clock = created_at.
UPDATE public.evidence SET captured_at = created_at WHERE captured_at IS NULL;

-- 10. provenance — V1 tier -> §6.4 provenance value set.
UPDATE public.evidence SET provenance = CASE tier
    WHEN 'dave_confirmed'       THEN 'dave_confirmed'
    WHEN 'first_party_log'      THEN 'user'
    WHEN 'claude_distilled'     THEN 'claude_distilled'
    WHEN 'corroborated_general' THEN 'external'
    WHEN 'transferable_prior'   THEN 'external'
    ELSE 'user' END
  WHERE provenance IS NULL;

-- 11. retracted — soft-delete rule (§3.1): retracted = (deleted_at IS NOT NULL). Live rows stay FALSE.
UPDATE public.evidence
SET retracted = TRUE,
    retracted_at = COALESCE(retracted_at, deleted_at),
    retracted_by = COALESCE(retracted_by, 'system:p0-backfill'),
    retraction_reason = COALESCE(retraction_reason, 'migrated_v1_soft_delete')
WHERE deleted_at IS NOT NULL AND retracted = FALSE;

-- 12. schema_version — bump V1 rows 1 -> 2. APPLY-ORDER (prod): runs only AFTER the dual-writing ingest
--     Lambda is deployed (no in-flight old-writer schema_version=1 INSERT races it). On the COW dry-run
--     there is no live writer.
UPDATE public.evidence SET schema_version = 2 WHERE schema_version = 1;

-- 13. daily_plan.engine_version sentinel (§3.4 / G-VER) — pre-engine rows read as stale -> recompute.
UPDATE public.daily_plan SET engine_version = '0.0.0-preengine' WHERE engine_version IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('care-engine-p0-0b',
        'CARE-ENGINE-P0 0b: backfill 103 evidence rows (evidence_class=observation, source_tier from tier-map, trust_rank/strength_weight from lookup, captured_at=created_at, claim from note, garden_node_id resolved BEFORE claim_scope, provenance, schema_version 1->2, retracted from deleted_at) + daily_plan.engine_version sentinel. Idempotent.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
