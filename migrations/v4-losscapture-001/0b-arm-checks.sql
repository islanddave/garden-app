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

-- Byte-comparable with lambda/plants/index.js's ALLOWED_LOSS, which exists TWICE — one literal on
-- the PUT path, one on the POST path (each Lambda zips from its own directory, so the house
-- convention lambda/plants/validate.js's header documents is a textual mirror, not an import).
-- Three hand-maintained copies of one vocabulary, plus gates.yml's set-equality expectation, is the
-- BUG-DIVERGENCEVOCAB-001 shape; lambda/plants/loss-cause-vocab.test.js parses THIS ARRAY as the
-- single source of truth and asserts the other three against it.
-- CORRECTED 2026-08-18: an earlier draft of this header also cited
-- `lambda/events/validators.js`'s ALLOWED_LOSS_CAUSES. No such constant exists, or ever has — the
-- string `ALLOWED_LOSS_CAUSES` occurs in exactly one place in the repo, and it was this comment.
-- There is no events-side loss vocabulary to be byte-comparable with.
--
-- ═══ CORRECTED AGAIN 2026-08-18 (V4-LOSSEVENT-001) — TWO CHANGES, BOTH LOAD-BEARING ═══
--
-- (1) THE COLUMN ALREADY HAS A LIVE, VALIDATED CHECK, and this file did not know it. Measured
--     read-only on prod AND staging: `plants_loss_cause_check`, convalidated = true, over exactly
--     the same five values. 0a's header says "The DB CHECK loss_cause never had is armed in 0b" —
--     that is false. So the original form of this statement added a SECOND constraint over one
--     column under a different name, which is merely redundant while the two agree and is a
--     SILENT TRAP the moment they do not: the narrower VALIDATED one still rejects, so a widened
--     `chk_plants_loss_cause` would be entirely cosmetic and 'culled' would keep 23514-ing with
--     two constraints in the catalog both looking correct. The legacy constraint is therefore
--     DROPPED here and consolidated into the house-named one. 0r restores it.
--
-- (2) THE VOCABULARY IS WIDENED TO SEVEN (+ animal_damage, + culled; Dave 2026-08-18), and that
--     inverts the deploy ordering RELATIVE TO THE OTHER TWO CONSTRAINTS IN THIS FILE:
--         narrowing (qty_lost >= 0)   -> CODE FIRST. The guard must be live before the CHECK.
--         widening  (loss_cause + 2)  -> SCHEMA FIRST. This file must be applied before the
--                                       plants Lambda carrying the seven-value ALLOWED_LOSS.
--     Reversed, the deployed writer accepts 'culled' and the database 23514s it. The reverse
--     mistake is harmless by comparison: a narrow writer against a wide DB just 400s.
--     README.md §Ordering carries the full sequence.
--
-- Set-equality is asserted by gates.yml post_loss_cause_vocab_exact, and the absence of the legacy
-- constraint by post_legacy_loss_cause_check_removed — without that second gate, a shadowing
-- narrow constraint would satisfy every other gate in this file.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plants_loss_cause_check') THEN
    ALTER TABLE public.plants DROP CONSTRAINT plants_loss_cause_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plants_loss_cause') THEN
    ALTER TABLE public.plants ADD CONSTRAINT chk_plants_loss_cause
      CHECK (loss_cause IS NULL OR loss_cause = ANY (ARRAY[
        'pest'::text, 'disease'::text, 'weather'::text, 'transplant_shock'::text, 'unknown'::text,
        'animal_damage'::text, 'culled'::text
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
