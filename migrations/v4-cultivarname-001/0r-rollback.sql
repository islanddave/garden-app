-- 0r-rollback.sql
-- V4-CULTIVARNAME-001 — reverse the data rename.
--
-- SAFE TO RUN WITHOUT A DEPLOY ROLLBACK **WHILE THE LEGACY CADENCE KEY IS STILL DEPLOYED**, and
-- that is by design. The companion repo change only ADDED the "Czech's Bush" key to
-- lambda/daily-plan/cadence-data-v2.json; the legacy "Czech Bush Slicer" key was deliberately left
-- in place precisely so this file works against the new Lambda. Reverting the DB alone therefore
-- lands back on a live, resolving key — no genus fallback, no silent cadence change.
--
-- THAT SAFETY IS CONDITIONAL, AND THE CONDITION EXPIRES. Once the NARROW step ships (the later,
-- separate deploy that drops the legacy key), this file becomes ACTIVELY DANGEROUS: it would set
-- the DB back to a name that no deployed key matches, which is precisely the silent genus-fallback
-- the whole widen/narrow sequence exists to prevent. Nothing outside this comment stops you, so
-- the pre-flight guard below checks the one thing it CAN check from inside the database, and the
-- NARROW checklist in README-BUILD.md requires deleting this file in the same commit that drops
-- the key. If you are reading this after the narrow has shipped: STOP, and roll back the deploy
-- too, or re-add the key first.
--
-- ORDER IS THE MIRROR IMAGE OF 0b. Statement 4 first (the explicit mirror repair has to be undone
-- while the trigger still cannot reach it), then plants, then plant_varieties. Statements 1-3 fire
-- 0a's rename triggers, which walk the three trigger-reachable entity rows back on their own.
--
-- THE TRIGGERS ARE NOT DROPPED HERE. They are a separate, strictly-additive fix for a bug that
-- predates this rename by months (7 cultivar + 21 planting mirror rows were already drifted on
-- 2026-08-04, before either ticket existed). Rolling back a rename is not a reason to reopen a
-- correctness hole. If the triggers themselves must go, run 0r-rollback-triggers.sql, and read its
-- header first — dropping them silently re-arms the drift.
--
-- Idempotent and first-write-wins, same as 0b: each statement asserts the post-state name, so a
-- second run reports UPDATE 0.

BEGIN;

-- 0'. Pre-flight. This cannot see the deployed Lambda bundle, so it checks the proxy it CAN see:
--     if the cultivar still has a seeded cultivar-scope care_profile, engine.js:32 short-circuits
--     before by_variety is ever consulted and the reverted name cannot cause a cadence change no
--     matter what the deployed JSON says. If that seeding is gone, the name-keyed path is live and
--     the operator must confirm the legacy key is still deployed before continuing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.care_profile
                  WHERE scope='cultivar'::care_scope
                    AND scope_id='b2be3698-b782-4a6b-8879-435effc9fcce'
                    AND (profile->>'_seeded')::boolean IS TRUE) THEN
    RAISE WARNING 'rollback pre-flight: the Czech cultivar has NO seeded care_profile, so its cadence now resolves through the NAME-keyed by_variety path. Confirm the DEPLOYED daily-plan Lambda still carries the legacy "Czech Bush Slicer" key before trusting this rollback (see gates.yml pre_deployed_lambda_carries_both_keys). If the NARROW step has shipped, this rollback will silently drop the planting to the genus fallback.';
  END IF;
END $$;

-- 4'. Undo the explicit mirror repair. Literal, not derived from pv.name: at this point in the
--     transaction plant_varieties still says 'Floradade', so deriving would be a no-op.
UPDATE public.entity
   SET display_name = 'Floridade'
 WHERE id = '52ea7182-1c45-4f76-97ae-10fd1c73c57f'
   AND entity_type = 'cultivar'
   AND display_name = 'Floradade'
   AND deleted_at IS NULL;

-- 3'. Fires plants_entity_rename -> entity 07881250 follows.
UPDATE public.plants
   SET name = 'Floridade'
 WHERE id = '9274e985-1cfe-4470-ab5a-424f3e6bdcd2'
   AND name = 'Floradade'
   AND deleted_at IS NULL;

-- 2'. Fires plants_entity_rename -> entity 88a08b2f follows.
UPDATE public.plants
   SET name = 'Czech Bush Slicer'
 WHERE id = 'ee3fd4c5-5fa3-4202-8044-2c2d19e4835e'
   AND name = 'Czech''s Bush'
   AND deleted_at IS NULL;

-- 1'. Fires plant_varieties_entity_rename -> entity f0f36069 follows.
UPDATE public.plant_varieties
   SET name = 'Czech Bush Slicer', updated_at = now()
 WHERE id = 'b2be3698-b782-4a6b-8879-435effc9fcce'
   AND name = 'Czech''s Bush'
   AND deleted_at IS NULL;

-- NOTE: plant_varieties 7b355b73 is deliberately NOT reverted to 'Floridade'. That rename happened
-- out-of-band on 2026-08-04 17:34 UTC and is CORRECT — BUG-FLORADADESYNC-001 was never "the rename
-- was wrong", it was "the rename did not propagate". Reverting it here would re-break the cultivar
-- to match the mirror instead of the other way round. If a full revert to the pre-2026-08-04 state
-- is genuinely wanted, that is a separate decision; the statement is left here, commented, so the
-- choice is explicit rather than forgotten:
--
--   UPDATE public.plant_varieties SET name='Floridade', updated_at=now()
--    WHERE id='7b355b73-391c-4cdd-b040-f1cd87a447d5' AND name='Floradade' AND deleted_at IS NULL;
--
-- Running it would ALSO need statement 4' skipped, since the trigger would then sync the mirror to
-- 'Floridade' by itself.

DELETE FROM public.schema_version WHERE version = '4.21.3-cultivarname-001-rename';

COMMIT;
