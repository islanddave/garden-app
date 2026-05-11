-- 20260511_var2_0c_validate.sql
-- VARIETY-REF Session 2 — Step 0c: VALIDATE chk_inventory_seed_requires_variety
-- Spec: varieties-schema-design-V001-20260508.md
-- Sequence: 0a (DDL) → 0b (backfill) → 0c (this — gated on backfill verification)
--
-- DO NOT APPLY THIS UNLESS the verification SELECT in 0b returns 0 for both checks:
--   plants_unbackfilled    = 0  (or accepted-loss documented)
--   seeds_without_variety  = 0  (HARD gate — DDL will fail if any rows violate)
--
-- VALIDATE CONSTRAINT acquires SHARE UPDATE EXCLUSIVE — readers and writers continue;
-- runs full table scan once. If any row violates, the statement errors and leaves
-- the constraint in NOT VALID state. No data is mutated; rerun after backfill fix.

ALTER TABLE public.inventory_items
  VALIDATE CONSTRAINT chk_inventory_seed_requires_variety;

INSERT INTO public.schema_version (version, description)
VALUES ('2.0.3c', 'VAR2-0c: VALIDATE chk_inventory_seed_requires_variety (post-backfill, gated on verification)')
ON CONFLICT (version) DO NOTHING;
