-- 0a-additive-ddl.sql — PHASE 1 of 3. COLUMNS ONLY. No CHECK is armed here.
-- Ledger items: V4-LOSSEVENT-001 / BUG-LOSSCAUSE-001 / V4-HARVDISPOSITION-001.
-- `losscapture-001` is this bundle's directory slug and schema_version prefix. It is NOT a ticket
-- id — there is no V4-LOSSCAPTURE-001 in project-state/ledger.yaml and never was. Cite the three
-- real ids above.
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
--       read-only 2026-08-18). The DB CHECK loss_cause never had is armed in 0b, not here.
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
--   is not the same shape" as a nullable column with no sentinel), and that reasoning is why 0b's
--   CHECK keeps 'unknown' rather than dropping it the way divergence_type's CHECK does.
--
-- WHY THE CHECKS ARE NOT IN THIS FILE — THE ORDERING FIX (2026-08-18 review).
--   The first draft added the columns AND all three CHECKs here. Those are two different kinds of
--   change and only one of them is backward-compatible.
--     * ADD COLUMN IF NOT EXISTS, nullable, no new default: the deployed artifact cannot notice.
--       Safe against ANY deployed Lambda version.
--     * ADD CONSTRAINT ... CHECK ... NOT VALID: NOT VALID exempts EXISTING rows and constrains
--       every SUBSEQUENT write. It is a change to the contract the DEPLOYED writer must already
--       satisfy — so it is deploy-ordered, and the deployed plants Lambda wrote qty_lost through a
--       plain COALESCE with no non-negativity guard. Arming it against that artifact turns a
--       client-supplied negative into a 23514 -> 500 on a live route.
--   Arming a CHECK is a deploy, not a migration. The CHECKs therefore live in 0b-arm-checks.sql,
--   behind a manual gate that refuses to run until the guard is live. See README.md §Apply order.
--
-- SAFETY: fully additive + idempotent. ADD COLUMN IF NOT EXISTS, all nullable, no DEFAULT except
--   qty_lost's pre-existing DEFAULT 0 (recorded here for fresh-env parity, not newly chosen — it
--   already carries that default on prod). No constraint is added. schema_version INSERT is
--   ON CONFLICT DO NOTHING. No existing column, constraint, view, or index is touched; no consumer
--   selects either table positionally.
--
-- NOT applied to any environment by the authoring session — apply is Dave-gated, staging first.

ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS loss_cause text,
  ADD COLUMN IF NOT EXISTS qty_lost integer DEFAULT 0;

-- harvest_log.disposition — new. NULL = normal pick (the overwhelming majority; never required,
-- never nags — same progressive-disclosure contract quality_rating already uses on this table).
-- Vocabulary taken verbatim from the ledger items' own wording (unripe abort/damaged/dropped/culled)
-- and recon §7's top recommendation, mapped to four values in 0b: 'aborted' (unripe/immature pick),
-- 'dropped' (knocked/fell off the plant), 'damaged' (disease/blotch/pest-marked at pick time),
-- 'culled' (deliberately removed despite being off-spec). A pick taken early on purpose for use
-- ("Taken early for dish") is a NORMAL harvest, not a disposition value — it stays NULL + notes,
-- same as today; inventing a fifth value for it would blur the "something went wrong" signal the
-- other four exist to carry.
ALTER TABLE public.harvest_log
  ADD COLUMN IF NOT EXISTS disposition text;

INSERT INTO public.schema_version (version, description)
VALUES ('4.25.0-losscapture-001','V4-LOSSEVENT-001/BUG-LOSSCAUSE-001/V4-HARVDISPOSITION-001 phase 1/3 (COLUMNS ONLY, safe against any deployed artifact). plants.loss_cause+qty_lost formalized in-repo (ADD COLUMN IF NOT EXISTS, no-op on prod/staging which already carry both); harvest_log +disposition text nullable (genuinely new column). NO CHECK is armed by this file — arming is deploy-ordered and deferred to 0b-arm-checks.sql, VALIDATE to 0c-validate.sql. Additive; no existing column/constraint/view touched.')
ON CONFLICT (version) DO NOTHING;
