-- 0a-data.sql
-- V4-BEEBALMFLIP-001 — execute the pre-authored bee_balm flip. DATA ONLY: both columns already
--   exist (added by v4-harvattr-001). There is NO DDL in this migration.
--
-- PURPOSE: `src/data/harvest-attributes-v1.json` -> not_harvest_tracked.contested.bee_balm has
--   carried, since 2026-07-21, a pre-written conditional decision: "Monarda is a real
--   culinary/tea herb (category='herb' in the vocab) but is grown here as a pollinator
--   ornamental. Left NULL per brief; flip to cut_and_come_again/14d if Dave actually picks it."
--   V4-HARVHABITGAP-001 confirmed live 2026-08-18 that the condition has fired: bee_balm
--   (Wild Bergamot) has 1 logged harvest event. This migration is that flip, not a new
--   authoring decision — the values were written down three weeks before this file existed.
--
-- SCOPE: exactly one slug, two columns. bee_balm was, until this migration, simultaneously
--   listed in harvest-attributes-v1.json's not_harvest_tracked.slugs AND documented as
--   contested/conditional in .contested.bee_balm. The JSON has been updated in the same commit
--   to move bee_balm into by_crop_type and remove it from not_harvest_tracked.slugs — this SQL
--   file is the corresponding DB-side write. src/__tests__/harvestAttributesSync.test.js also
--   required the matching row to be added to migrations/v4-harvattr-001/0b-data.sql's seed VALUES
--   block (that file is the sync gate's only SQL source), which was done in the same commit.
--
-- PROVENANCE: harvest_habit='cut_and_come_again' and repeat_interval_days=14 are copied verbatim
--   from the pre-authored contested note, not re-derived. confidence for that pair is high for
--   exactly this reason. loss_horizon_hours is intentionally NOT written by this migration (see
--   the JSON's by_crop_type.bee_balm notes) — no reviewed estimate exists yet, and inventing one
--   here would violate the "NULL is a decision, not a default" contract this file's own header
--   states. A future migration may add it once authored.
--
-- SAFETY: fully idempotent, first-write-wins, matching the v4-croptype-002 convention.
--   * Each UPDATE is guarded on its own target column IS NULL, so a re-run can never overwrite an
--     existing or hand-corrected value.
--   * Both UPDATEs scoped `AND deleted_at IS NULL` (live vocabulary rows only).
--   * schema_version INSERT is ON CONFLICT (version) DO NOTHING.
--   * Re-running the whole file is a clean no-op.
--
-- CONSTRAINT AGREEMENT (checked before authoring): 'cut_and_come_again' is one of the three
--   literals in chk_crop_types_harvest_habit; repeat_interval_days=14 is within the
--   chk_crop_types_repeat_interval-legal 1..365 range for a non-'single' row.
--
-- APPLY ORDER: 0a (this file) -> post gates. NOT applied to any environment by the authoring
--   session — apply is Dave-gated, staging first, per the project's Migration Authoring Rule.
--
-- ROLLBACK: 0r-rollback.sql (re-NULLs exactly the two cells this file sets, and only where they
--   still hold the value this file wrote).

BEGIN;

UPDATE public.crop_types SET harvest_habit='cut_and_come_again', updated_at=now()
 WHERE slug='bee_balm' AND deleted_at IS NULL AND harvest_habit IS NULL;
-- high | Verbatim from not_harvest_tracked.contested.bee_balm's pre-authored condition, which has
-- now fired: 1 harvest event logged on Wild Bergamot (V4-HARVHABITGAP-001, confirmed live
-- 2026-08-18). This is the single highest-confidence value in the whole backfill item — it
-- executes a decision already written down, not a new one.

UPDATE public.crop_types SET repeat_interval_days=14, updated_at=now()
 WHERE slug='bee_balm' AND deleted_at IS NULL AND repeat_interval_days IS NULL AND harvest_habit <> 'single';
-- high | Same pre-authored source as above. 14d sits inside the cadence range this file's other
-- cut_and_come_again herbs already use (chives 14, mint 14, culantro 14) — a leafy perennial herb
-- regrowth interval, not an outlier.

-- Deliberately NOT written here (documented above, repeated so a future pass does not "fix" it):
--   loss_horizon_hours — no horticultural-review estimate exists yet for bee_balm; left NULL
--   rather than guessed, per src/data/harvest-attributes-v1.json's own "NULL is a decision, not a
--   gap" contract. See by_crop_type.bee_balm.notes for the candidate-range discussion.

INSERT INTO public.schema_version (version, description)
VALUES ('4.34.0-beebalmflip-001',
        'BEEBALMFLIP-001: execute the pre-authored bee_balm flip (harvest_habit NULL -> cut_and_come_again, repeat_interval_days NULL -> 14). Data-only, no DDL, single slug. loss_horizon_hours deliberately left NULL (no reviewed estimate yet). V4-HARVHABITGAP-001.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
