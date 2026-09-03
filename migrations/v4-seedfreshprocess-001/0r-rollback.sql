-- V4-SEEDFRESHPROCESS-001 rollback — narrow seed_process back to `wet | dry`.
--
-- READ THIS BEFORE RUNNING IT. Narrowing is NOT symmetric with the apply: any row written as 'fresh'
-- while this migration was live will make the ADD CONSTRAINT fail outright. That is the correct
-- behaviour — it refuses rather than destroying the distinction — but it means this file is only
-- runnable while zero 'fresh' rows exist. The SELECT below tells you which rows block it; decide
-- what they should become (almost certainly 'dry') and say so explicitly rather than letting a
-- rollback silently relabel a user's records.
--
--   SELECT id, name, seed_process FROM public.inventory_items WHERE seed_process = 'fresh';

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_seed_process_check;

ALTER TABLE public.inventory_items
  ADD CONSTRAINT inventory_items_seed_process_check
  CHECK (seed_process IS NULL OR seed_process = ANY (ARRAY['wet'::text, 'dry'::text]));
