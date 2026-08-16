-- 0r-rollback.sql
-- V4-ANCHORBASE-001 rollback. Rehearse on STAGING before applying 0a to prod.
--
-- SAFE AT ANY TIME, and that is a design property rather than luck: this migration never wrote to
-- public.plants. No sown_at, transplanted_at or planted_out_at was set, so there is no user data to
-- restore and no observed date to distinguish from a derived one after the fact. Dropping this table
-- returns the database to exactly the state it was in before 0a.
--
-- The only thing lost is the derivation history — the retired (superseded) rows that pair a guess
-- with the observed date that later contradicted it. That pairing is the ONLY accuracy measurement
-- tier 3 will ever produce, so if the table has been live long enough to accumulate any, dump it
-- first:
--
--   \copy public.plant_anchor_derivation TO 'plant_anchor_derivation-<date>.csv' CSV HEADER
--
-- ── PART 1 (the EXECUTABLE body, and the usual case): retract the backfill, keep the schema. ────
-- Consult 2026-08-12 (regression seat, rollback gap 2): the executable body of this file used to
-- be the DROP, with the row-retraction living only in a comment — someone running the file
-- expecting to undo the backfill would drop the schema too. Inverted: running this file now
-- retracts rows ONLY. NOTE this also deletes SUPERSEDED rows from the same model — the only
-- accuracy measurement tier 3 will ever produce — so \copy the table first once any exist.

BEGIN;

DELETE FROM public.plant_anchor_derivation WHERE model_version = 'anchor-derive-v1';

COMMIT;

-- ── PART 2 (DESTRUCTIVE, deliberate, separate): drop the schema entirely. ──────────────────────
-- The table is standalone. Its single outbound FK is to public.plants (ON DELETE CASCADE since
-- 0a2) and nothing references it, so the drop cannot cascade into user data. UNCOMMENT to run —
-- this is intentionally not executable as-is.
--
-- ⚠️ THE DROP IS NOT SAFE AT RUNTIME, whatever it is to the data (OPS-DERIVEDCTEDEP-001). "Nothing
-- references it" above is a statement about FOREIGN KEYS ONLY, and it was written when it was also
-- true of the code. It is not true of the code now: eight statements in five deployed Lambdas name
-- this relation, SEVEN of them unguarded, so running part 2 against an environment whose Lambdas are
-- still deployed 500s live request paths rather than degrading them —
--   lambda/harvests/watch-route.js  the `derived` CTE. Runs on EVERY watch request regardless of
--                                  DERIVED_ANCHOR_ENABLED, and carries no try/catch on purpose:
--                                  the Today band must break visibly, not quietly revert to its
--                                  pre-derivation queue. No flag stands this one down.
--   lambda/plants/index.js          the PUT's supersede, inside the transaction — so EVERY planting
--                                  edit that reaches an anchor column fails, not just anchor work.
--   lambda/plants/merge.js          the cutover's snapshot read plus both retires.
--   lambda/events/index.js          V4-TRANSPLANTANCHOR-001, batch and single — every transplant log.
--   lambda/daily-plan/handler.js    the nightly sweep. The ONE fail-open site (try/catch, warns).
-- Sequencing if the drop is genuinely wanted: revert the code first, deploy it, THEN drop. The
-- census is pinned by lambda/anchor-derivation-hard-dependency.test.js, which reads THIS comment —
-- it goes red if the site list here stops naming what the code actually does.
--
-- BEGIN;
-- DROP INDEX IF EXISTS public.idx_plant_anchor_derivation_model_source;
-- DROP INDEX IF EXISTS public.idx_plant_anchor_derivation_user_live;
-- DROP INDEX IF EXISTS public.uq_plant_anchor_derivation_live;
-- DROP TABLE IF EXISTS public.plant_anchor_derivation;
-- COMMIT;
