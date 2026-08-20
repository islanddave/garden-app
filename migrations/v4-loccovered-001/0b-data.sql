-- 0b-data.sql
-- V4-COVEREDNOTMODELLED-001 — backfill locations.covered from the CURRENT name-match.
--
-- NOT APPLIED as of authoring (2026-08-20). Runs immediately after 0a, same session, both
-- environments. 0a without 0b is a live behaviour change on the day the reader ships (every
-- location would resolve NULL and fall to the type_label heuristic, silently reclassifying Stable
-- and House to exposed and rain-crediting 22 live plantings under a roof), so the two are ONE
-- logical step and the runbook must not separate them.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE POINT OF THIS FILE: THE MIGRATION IS BEHAVIOUR-PRESERVING
--
-- The CASE below is a verbatim transcription of the TRUE/FALSE arms of daily-plan/handler.js's
-- `cov` lateral as it stands at 3a07d2273d6181e4d7da76f7a0f3744e26d57212 (v4.39.2, live in prod):
--
--     when l.id is null                            then null   <- not transcribable; see below
--     when l.name in ('Stable','House')            then true
--     when l.type_label in ('shelf','rack','tray') then true
--     when l.type_label is null                    then null
--     else false
--
-- so after this runs, `covered` holds exactly what the name-match computes for every existing row,
-- and the reader in 0-flag form returns exactly what it returns today. Day one changes nothing.
-- Every subsequent change is Dave ticking a box. lambda/daily-plan/covered-backfill-parity.test.js
-- pins that transcription: it extracts BOTH CASE expressions from disk — this file and handler.js —
-- and reds if they ever disagree, so the equivalence claim is executable rather than asserted here.
--
-- The `l.id is null` arm is deliberately NOT transcribed. It fires when a planting has no location
-- at all, so there is no row to write it onto; it stays in the reader, where it is the only arm that
-- can still produce the UNKNOWN state. That is the BUG-NOLOCOUTDOOR-001 fail-safe and this bundle
-- does not touch it.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THIS DOES NOT FILTER deleted_at
--
-- The handler joins `left join locations l on l.id=coalesce(p.location_id, pj.location_id)` with NO
-- deleted_at predicate, so a SOFT-DELETED location still classifies any planting that points at it.
-- Measured on live prod 2026-08-20: 10 of 31 location rows are soft-deleted and 0 live plantings
-- resolve to one — so filtering would be behaviour-neutral TODAY, and would silently stop being so
-- the first time a location is restored or a planting is repointed. Backfilling every row keeps the
-- column a faithful mirror of the predicate it replaces under every future join, which is the whole
-- equivalence argument. Writing to a soft-deleted row is otherwise inert.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- IDEMPOTENT, AND SAFE TO RE-RUN AFTER DAVE HAS EDITED FLAGS
--
-- `WHERE covered IS NULL` means a second run touches only rows that have never been stated. It can
-- therefore never revert a Dave edit back to the name-match — which matters because the runbook
-- rehearses 0r (which DROPs the column) and re-applies on staging, and because a partial apply is
-- resumable by simply running it again.
--
-- The BEFORE UPDATE trigger `prevent_ownership_transfer` fires on this table. Verified against live
-- prod: its body raises only when OLD.created_by IS DISTINCT FROM NEW.created_by, and this UPDATE
-- does not name created_by, so it passes. `set_updated_at` also fires and will bump updated_at on
-- every touched row — expected, and not read by the care engine.

UPDATE public.locations
   SET covered = CASE
         WHEN name IN ('Stable','House')            THEN true
         WHEN type_label IN ('shelf','rack','tray') THEN true
         WHEN type_label IS NULL                    THEN NULL
         ELSE false
       END
 WHERE covered IS NULL;
