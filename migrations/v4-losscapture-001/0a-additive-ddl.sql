-- 0a-additive-ddl.sql
-- V4-LOSSCAPTURE-001 (bundles V4-LOSSEVENT-001 / BUG-LOSSCAUSE-001 / V4-HARVDISPOSITION-001).
--
-- WHAT THIS CLOSES: Dave decided 2026-07-28 (D1, data-audit-streamline-plan-V100-20260728.html)
--   to add a loss event type; it was never filed to the ledger for three weeks and never built.
--   Live-Neon forensics (project-state/checkin-20260817/recon-usage.md §7) then found the
--   consequence in the data: the top cluster of Dave's 44 free-text event notes is harvest/loss
--   disposition prose ("Unripe abort", "Knocked off plant, very green", "Fell off plant with major
--   blotch") written because no column exists for it, and separately that plants.loss_cause is
--   NULL on all 20 failed 2026 plantings because nothing ever writes it.
--
-- TWO DISTINCT MECHANISMS, ONE MIGRATION (they are additive and independent, not a shared column):
--   (a) plants.loss_cause / plants.qty_lost — PLANT-level mortality summary. Both columns ALREADY
--       EXIST on prod/staging (hand-applied, like divergence_type before V4-DIVERGENCEVOCAB-001 —
--       no migration in this repo ever created them; confirmed via `git grep loss_cause
--       migrations/` finding only VIEW pass-throughs, never a CREATE/ADD). This file formalizes
--       their presence (ADD COLUMN IF NOT EXISTS -> no-op on both live environments, verified
--       read-only 2026-08-18) and adds the DB CHECK loss_cause never had — the Lambda-only
--       ALLOWED_LOSS vocabulary (lambda/plants/index.js) is the sole guard today, exactly the
--       "vocabulary drift" shape BUG-DIVERGENCEVOCAB-001 fixed for divergence_type. The new
--       events-Lambda write path this ships alongside (POST /api/events, event_type='loss') is
--       what finally gives these columns a writer, so formalizing them now — rather than leaving
--       them undocumented while a new caller starts depending on them — is in scope, not adjacent.
--   (b) harvest_log.disposition — PICK-level outcome (this specific harvest was dropped / culled /
--       aborted / damaged rather than a normal ripe pick). Genuinely NEW, harvest_log has never had
--       this column. Distinct from (a): a disposition describes one pick that still got logged as a
--       harvest; a loss event describes plants that produced no pick at all. Recon's evidence
--       cluster mixes both because Dave was writing both into harvest-event notes for lack of
--       anywhere else to put either one.
--
-- NULL SEMANTICS: NULL on both new/formalized vocab columns means "not categorized" — the vast
--   majority of harvests are normal picks and must never be nagged for a disposition value; NULL on
--   loss_cause already meant "not recorded" prior to this file and is unchanged. 'unknown' remains a
--   real, DISTINCT, user-chosen vocabulary member on loss_cause (not folded into NULL) — the
--   divergencevocab-001 migration's own comment draws this exact line ("loss_cause's 'unknown' ...
--   is not the same shape" as a nullable column with no sentinel), and that reasoning is why this
--   file's CHECK keeps 'unknown' rather than dropping it the way divergence_type's CHECK does.
--
-- SAFETY: fully additive + idempotent. ADD COLUMN IF NOT EXISTS, all nullable, no DEFAULT except
--   qty_lost's pre-existing DEFAULT 0 (recorded here for fresh-env parity, not newly chosen — it
--   already carries that default on prod). Every CHECK is guarded by a pg_constraint existence test
--   and added NOT VALID (no full-table scan / heavy lock on apply). VALIDATE is deferred to
--   0c-validate.sql, a separate post-deploy step (arming a CHECK is a deploy, not a migration — the
--   2026-08-03 outage rule). schema_version INSERT is ON CONFLICT DO NOTHING. No existing column,
--   constraint, view, or index is touched; no consumer selects either table positionally.
--
-- APPLY ORDER: 0a (this file) -> deploy the events + plants Lambdas carrying the write paths that
--   populate these columns -> 0c-validate.sql (VALIDATE the CHECKs against real captured rows, not
--   an all-NULL/all-existing-vocab column). Gates in gates.yml. NOT applied to any environment by
--   the authoring session — apply is Dave-gated, staging first.

ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS loss_cause text,
  ADD COLUMN IF NOT EXISTS qty_lost integer DEFAULT 0;

-- Byte-comparable with lambda/plants/index.js's ALLOWED_LOSS and lambda/events/validators.js's
-- ALLOWED_LOSS_CAUSES (textual mirror across the two Lambda zips, per the house convention
-- lambda/plants/validate.js's header documents — each Lambda zips from its own directory, so an
-- import cannot cross them). lambda/plants/loss-cause-enum.test.js parses this CHECK and asserts
-- both Lambda copies equal it as a set, closing the drift class BUG-DIVERGENCEVOCAB-001 found.
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
-- new events-Lambda write path ACCUMULATES into it (qty_lost + N) rather than only ever being
-- hand-set, and an accumulate-from-untrusted-input path is exactly where a floor earns its keep.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plants_qty_lost_nonneg') THEN
    ALTER TABLE public.plants ADD CONSTRAINT chk_plants_qty_lost_nonneg
      CHECK (qty_lost IS NULL OR qty_lost >= 0) NOT VALID;
  END IF;
END $$;

-- harvest_log.disposition — new. NULL = normal pick (the overwhelming majority; never required,
-- never nags — same progressive-disclosure contract quality_rating already uses on this table).
-- Vocabulary taken verbatim from the ledger items' own wording (unripe abort/damaged/dropped/culled)
-- and recon §7's top recommendation, mapped to four values: 'aborted' (unripe/immature pick),
-- 'dropped' (knocked/fell off the plant), 'damaged' (disease/blotch/pest-marked at pick time),
-- 'culled' (deliberately removed despite being off-spec). A pick taken early on purpose for use
-- ("Taken early for dish") is a NORMAL harvest, not a disposition value — it stays NULL + notes,
-- same as today; inventing a fifth value for it would blur the "something went wrong" signal the
-- other four exist to carry.
ALTER TABLE public.harvest_log
  ADD COLUMN IF NOT EXISTS disposition text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_harvest_log_disposition') THEN
    ALTER TABLE public.harvest_log ADD CONSTRAINT chk_harvest_log_disposition
      CHECK (disposition IS NULL OR disposition = ANY (ARRAY[
        'dropped'::text, 'culled'::text, 'aborted'::text, 'damaged'::text
      ])) NOT VALID;
  END IF;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.25.0-losscapture-001','V4-LOSSCAPTURE-001 (V4-LOSSEVENT-001/BUG-LOSSCAUSE-001/V4-HARVDISPOSITION-001): plants.loss_cause+qty_lost formalized in-repo (ADD COLUMN IF NOT EXISTS, no-op on prod/staging which already carry both) with new CHECKs chk_plants_loss_cause (pest|disease|weather|transplant_shock|unknown, mirrors the existing Lambda-only ALLOWED_LOSS vocabulary) and chk_plants_qty_lost_nonneg (>=0); harvest_log +disposition text nullable (genuinely new column) with chk_harvest_log_disposition (dropped|culled|aborted|damaged). All CHECKs added NOT VALID; VALIDATE deferred to 0c-validate.sql, post-deploy. Additive; no existing column/constraint/view touched.')
ON CONFLICT (version) DO NOTHING;
