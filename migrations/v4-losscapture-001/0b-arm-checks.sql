-- 0b-arm-checks.sql — PHASE 2 of 3. ARMS the three CHECKs. DEPLOY-ORDERED — read this header.
-- Ledger items: V4-LOSSEVENT-001 / BUG-LOSSCAUSE-001 / V4-HARVDISPOSITION-001.
--
-- ═══ THIS FILE IS A DEPLOY STEP THAT HAPPENS TO BE WRITTEN IN SQL ═══
--
-- `NOT VALID` is routinely read as "safe, changes nothing". It exempts EXISTING rows. It constrains
-- EVERY SUBSEQUENT WRITE from the instant it commits. So this file does not extend the schema — it
-- narrows the contract the ALREADY-DEPLOYED writer must satisfy, and a writer deployed before the
-- narrowing has no idea it happened.
--
-- PRECONDITION, per constraint, stated as a property of the DEPLOYED ARTIFACT (not of the database):
--
--   chk_plants_qty_lost_nonneg     THE ONE THAT BLOCKS. Until v4.36.x the deployed plants Lambda
--                                  wrote body.qty_lost through a plain COALESCE (PUT) and `?? 0`
--                                  (POST) with NO floor. Arming this against that artifact makes a
--                                  client-supplied negative a 23514 -> 500 on a live route, and any
--                                  prod row already holding a negative qty_lost becomes un-editable
--                                  through the app (the PUT rewrites the row and the CHECK rejects
--                                  it). REQUIRES lambda/plants/validate.js validateQtyLost wired
--                                  into BOTH verbs and DEPLOYED. Gate:
--                                  pre_qty_lost_guard_is_deployed (manual).
--
--   chk_plants_loss_cause          Already effectively enforced in code: the deployed plants Lambda
--                                  has validated loss_cause against ALLOWED_LOSS (pest | disease |
--                                  weather | transplant_shock | unknown) on both verbs since
--                                  V1.2a-4 S1, and the CHECK below is byte-comparable with it. No
--                                  new deploy is required for this one — it is armed here rather
--                                  than in 0a only because a single arming boundary is easier to
--                                  reason about than three staggered ones.
--
--   chk_harvest_log_disposition    No deployed writer exists at all (disposition is new in 0a and
--                                  nothing writes it yet), so nothing can violate it. Same
--                                  reasoning: armed here for one boundary, not because it is
--                                  ordered.
--
-- Only the first is genuinely blocked, and the whole file waits on it. Splitting the safe two into
-- 0a to save a step would trade a real ordering guarantee for a cosmetic one.
--
-- SAFETY: idempotent (each ADD CONSTRAINT is guarded by a pg_constraint existence test) and
--   NOT VALID, so no full-table scan and no ACCESS EXCLUSIVE beyond the brief catalog update.
--   VALIDATE is 0c. No data change. schema_version INSERT is ON CONFLICT DO NOTHING.
--
-- NOT applied to any environment by the authoring session — apply is Dave-gated, staging first.

-- Byte-comparable with lambda/plants/index.js's ALLOWED_LOSS and lambda/events/validators.js's
-- ALLOWED_LOSS_CAUSES (textual mirror across the two Lambda zips, per the house convention
-- lambda/plants/validate.js's header documents — each Lambda zips from its own directory, so an
-- import cannot cross them).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plants_loss_cause') THEN
    ALTER TABLE public.plants ADD CONSTRAINT chk_plants_loss_cause
      CHECK (loss_cause IS NULL OR loss_cause = ANY (ARRAY[
        'pest'::text, 'disease'::text, 'weather'::text, 'transplant_shock'::text, 'unknown'::text
      ])) NOT VALID;
  END IF;
END $$;

-- qty_lost is a non-negative running counter, mirroring the implicit contract qty_harvested already
-- has (no CHECK either, but never observed negative) — this one gets an explicit floor because the
-- new loss write path ACCUMULATES into it (qty_lost + N) rather than only ever being hand-set, and
-- an accumulate-from-untrusted-input path is exactly where a floor earns its keep.
-- Its code twin is validateQtyLost in lambda/plants/validate.js, asserted by
-- lambda/plants/qty-lost-guard.test.js, which parses THIS statement.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plants_qty_lost_nonneg') THEN
    ALTER TABLE public.plants ADD CONSTRAINT chk_plants_qty_lost_nonneg
      CHECK (qty_lost IS NULL OR qty_lost >= 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_harvest_log_disposition') THEN
    ALTER TABLE public.harvest_log ADD CONSTRAINT chk_harvest_log_disposition
      CHECK (disposition IS NULL OR disposition = ANY (ARRAY[
        'dropped'::text, 'culled'::text, 'aborted'::text, 'damaged'::text
      ])) NOT VALID;
  END IF;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.25.1-losscapture-001-checks','V4-LOSSEVENT-001/BUG-LOSSCAUSE-001/V4-HARVDISPOSITION-001 phase 2/3 (DEPLOY-ORDERED). Arms chk_plants_loss_cause (pest|disease|weather|transplant_shock|unknown, mirrors the deployed Lambda ALLOWED_LOSS), chk_plants_qty_lost_nonneg (>=0), chk_harvest_log_disposition (dropped|culled|aborted|damaged). All three NOT VALID, so existing rows are exempt and every subsequent write is constrained. Precondition is a property of the deployed artifact: lambda/plants validateQtyLost must be LIVE on both verbs first (gate pre_qty_lost_guard_is_deployed). VALIDATE deferred to 0c-validate.sql.')
ON CONFLICT (version) DO NOTHING;
