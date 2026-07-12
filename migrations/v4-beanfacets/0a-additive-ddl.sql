-- 0a-additive-ddl.sql
-- V4 BEAN FACETS (V4-BEANFACET-001) — three DERIVED cultivar classification facets for beans.
--
-- PURPOSE: widen tag_facet_check so the derive engine (crop-derive.js) can emit the bean facets:
--     bean_type  (species group: common/runner/lima/fava/yardlong/cowpea/soybean, from genus/species)
--     bean_habit (bush/half_runner/pole, from name + growth_habit prose)
--     bean_use   (snap/shell/dry/dual_purpose, from name + prose)
--   All three are DERIVED, system-owned facets (same class as type/lifecycle/heat/...); NOT
--   hand-assignable, so lambda/tags/validate.js VALID_USER_FACETS is intentionally NOT widened.
--   No new plant_varieties columns: everything derives from existing name/genus/species/growth_habit.
--   Crop 'althaea' (marshmallow) intentionally gets NO crop-specific facet (monospecies).
--
-- SAFETY: fully additive + idempotent. The tag_facet_check widen is a SUPERSET of the LIVE constraint
--   (which already carries 'issue' from the flag-issue feature) — every currently-valid facet stays
--   valid. Added NOT VALID (no full-table scan/lock on apply) then VALIDATEd in 0c-validate.sql (L-058).
--   Re-running the whole file is a clean no-op.
--
-- ROLLBACK:
--   ALTER TABLE public.tag DROP CONSTRAINT IF EXISTS tag_facet_check;
--   ALTER TABLE public.tag ADD CONSTRAINT tag_facet_check
--     CHECK (facet = ANY (ARRAY['type','group','lifecycle','location','freeform',
--                               'heat','determinacy','day_length','allium_type','basil_use','issue']));
--   -- (then re-derive to drop any bean_* tags: node migrations/v4-beanfacets/0b-backfill.mjs)

-- Widen the tag facet vocabulary (superset — additive; keeps every live facet incl. 'issue').
DO $$ BEGIN
  ALTER TABLE public.tag DROP CONSTRAINT IF EXISTS tag_facet_check;
  ALTER TABLE public.tag ADD CONSTRAINT tag_facet_check
    CHECK (facet = ANY (ARRAY['type','group','lifecycle','location','freeform',
                              'heat','determinacy','day_length','allium_type','basil_use','issue',
                              'bean_type','bean_habit','bean_use'])) NOT VALID;
END $$;
