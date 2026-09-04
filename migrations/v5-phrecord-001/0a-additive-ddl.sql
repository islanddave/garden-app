-- V5-PHRECORD-001 — a place to WRITE DOWN a pH someone measured.
--
-- FOLLOW-ON, NOT A FIRST APPLY. V5-INFLIGHTBATCH-001 is already live on staging and production as of
-- 2026-09-04, so kitchen_stage_log below is an existing table with a deployed writer, and every
-- statement here is additive against it. Nothing existing is dropped, relaxed or re-typed.
--
-- WHAT THIS IS FOR. The stage log already carries `cue_observed` free text — "translucent", "bubbling
-- stopped" — which is the right home for an observation you make with your eyes. A pH is not that. It
-- is a number produced by an instrument, it is the one datum the preservation literature asks a cook
-- to WRITE DOWN, and buried in free text it cannot be read back reliably by anything. BC CDC's
-- fermented-vegetables guidance states it as a recommendation to record: "Our main recommendation is
-- monitoring and recording pH and time as the CCP for a successful vegetable fermentation." This
-- migration is that column and nothing more.
--
-- ⚠ THE LINE THIS SCHEMA IS BUILT TO HOLD, and it is the whole design:
--   FORBIDDEN — derive, score, colour, gate, compare to a threshold, or infer from elapsed time.
--   PERMITTED — record a measured value verbatim, prompt someone to measure, link to how.
-- A recorded reading is shown back exactly as it was typed. Nothing in this schema, and nothing in
-- the code that reads it, says whether a reading is good. There is no threshold column, no status
-- column, no derived flag, and no DEFAULT on either column added below — a default would invent a
-- reading or invent the instant it was taken, and an invented reading is worse than an absent one.
-- Adjudication: project-state/_build-inflight-20260904/FOODSAFETY-RULING-V101.md §2 (gardening-docs).
-- Evidence, with the scope condition on every figure: foodsafety-research.md §1, §3, §9 alongside it.
--
-- ⚠ AND IT IS AN ORIGINAL DESIGN CHOICE, NOT A COMPLIANCE POSTURE. No published convention exists for
-- what home-preservation software should say — that is a documented negative result in the research,
-- not an omission from it. Nothing here follows a standard, and no future comment, copy or commit
-- message may imply that it does.
--
-- WHY TWO COLUMNS AND NOT ONE. The instant a reading was taken is not the instant the row was
-- written: a cook measures at the counter and logs from the sofa, and a reading is only a record of
-- anything if it says when. entered_at answers "when did you log this", ph_read_at answers "when did
-- you read it", and collapsing them would put a wrong time on the only datum that has one. They are
-- bound by a biconditional CHECK rather than a default, for the reason in the paragraph above.
--
-- WHY plain `numeric` AND NOT numeric(4,2). Postgres preserves the scale of the literal it is given,
-- so a reading typed with two decimals reads back with two and one typed with one keeps one. A typed
-- precision would rewrite each into the other, which is exactly the "shown back as typed" requirement
-- failing at the storage layer. The app sends the trimmed STRING the cook typed, not a JS number, for
-- the same reason — a Number round-trip drops the trailing zero the meter displayed.
--
-- WHY THE SCALE CHECK IS NOT A THRESHOLD. chk_ksl_ph_scale admits 0 through 14, which is the pH
-- scale's definitional range and nothing else. It is symmetric, it treats no reading as better or
-- worse than another, and it excludes no value any meter or strip in the linked guidance can produce.
-- Its entire job is to catch a fat-finger — a strip cannot read 46 — in the same spirit as the
-- chk_ksl_amount_positive that ships beside it. It is deliberately NOT a food-safety band, and if a
-- later reader is tempted to narrow it toward one, that is the change this header exists to refuse.
--
-- WHY THE VIEW GAINS A "LAST READING" AND WHY THAT IS NOT AN AGGREGATE. The one prompt this data
-- supports is a recurring one, and a recurring prompt has to know when you last did the thing or it
-- nags forever. `last_ph_reading` / `last_ph_read_at` name ONE ROW — the newest reading and the
-- moment it was taken, travelling together and never apart, in exactly the way current_stage_kind
-- names one row today. They are NOT a count, a streak, a run, a mean or a trend, and the ruling
-- forbids all five: a batch that never acidified produces an unbroken run of "checked" entries, so
-- any aggregate over these turns absent failure signs into apparent success. Each reading is a dated
-- line in the record. That is the entire contract.
--
-- CREATE OR REPLACE, NEVER DROP + CREATE. Replacing preserves the view's grants; dropping would
-- silently strip garden_ro's SELECT and turn every read-only investigation into an empty result,
-- which reads as "there are no batches" — the most misleading possible answer. The cost of REPLACE is
-- that the existing columns must keep their names AND positions, and this file's `b.*` re-expands at
-- apply time; gates.yml pre_view_star_expands_unchanged measures that precondition rather than
-- assuming it, so a kitchen_batch column added by some other migration first goes red in a gate
-- instead of aborting the apply with an opaque "cannot change name of view column".

BEGIN;

-- ── 1. the two columns ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.kitchen_stage_log
  ADD COLUMN ph_reading numeric,
  ADD COLUMN ph_read_at timestamptz;

-- Created VALIDATED, not NOT VALID. Both columns are brand new, so every pre-existing row holds NULL
-- in both and each CHECK is vacuously true against the whole table — there is nothing to scan and
-- nothing to violate. gates.yml sweep_ph_predicates_vacuous measures that rather than asserting it
-- (L-058), and a permanent convalidated=false would be indistinguishable to a later reader from
-- "known violators exist".
--
-- The biconditional, matching chk_ksl_amount_pairing one field over: a reading always carries the
-- instant it was read, and an instant with no reading records nothing.
ALTER TABLE public.kitchen_stage_log
  ADD CONSTRAINT chk_ksl_ph_pairing CHECK ((ph_reading IS NULL) = (ph_read_at IS NULL));

-- The pH scale's definitional range. See the header: symmetric, admits every reading either
-- instrument can produce, and is not a safety band.
ALTER TABLE public.kitchen_stage_log
  ADD CONSTRAINT chk_ksl_ph_scale CHECK (ph_reading IS NULL OR (ph_reading >= 0 AND ph_reading <= 14));

-- ── 2. the index the view's second LATERAL needs ─────────────────────────────────────────────────
-- PARTIAL on `ph_reading IS NOT NULL`, so it holds only rows that carry a reading — a small fraction
-- of the stage log, since most rows are a move or a skim. idx_ksl_batch cannot serve this lookup: its
-- key is (batch_id, entered_at DESC, id DESC) and the newest row is usually not the newest READING.
-- The column order below matches the LATERAL's ORDER BY exactly, so the derivation stays one index
-- probe per open batch — the same bound the INFLIGHTBATCH header measured for current stage.
CREATE INDEX idx_ksl_ph ON public.kitchen_stage_log (batch_id, ph_read_at DESC, id DESC)
  WHERE ph_reading IS NOT NULL;

-- ── 3. the view ──────────────────────────────────────────────────────────────────────────────────
-- Byte-identical to V5-INFLIGHTBATCH-001's definition through output_count — appending at the end is
-- the only shape CREATE OR REPLACE VIEW accepts, and re-ordering or renaming anything above would
-- abort the apply. The second LATERAL is the only addition.
CREATE OR REPLACE VIEW public.v_kitchen_batch_current AS
SELECT b.*,
       s.stage_kind          AS current_stage_kind,
       s.label               AS current_stage_label,
       s.entered_at          AS current_stage_entered_at,
       s.storage_location_id AS current_storage_location_id,
       (SELECT count(*) FROM public.kitchen_batch_input i WHERE i.batch_id = b.id)  AS input_count,
       (SELECT count(*) FROM public.preservation_log p
         WHERE p.batch_id = b.id AND p.deleted_at IS NULL)                          AS output_count,
       -- ONE ROW, both halves of it, never one without the other. A reading with no instant beside it
       -- is not a dated line, and a dated line is all this is allowed to be.
       ph.ph_reading         AS last_ph_reading,
       ph.ph_read_at         AS last_ph_read_at
  FROM public.kitchen_batch b
  LEFT JOIN LATERAL (
       SELECT sl.stage_kind, sl.label, sl.entered_at, sl.storage_location_id
         FROM public.kitchen_stage_log sl
        WHERE sl.batch_id = b.id
        ORDER BY sl.entered_at DESC, sl.id DESC
        LIMIT 1
  ) s ON TRUE
  -- Ordered by ph_read_at, NOT entered_at: the question this answers is "when did you last measure",
  -- and a reading back-dated to the counter is the newest reading even when it was logged after a
  -- later skim. `id DESC` is the same deterministic tiebreak idx_ksl_batch carries — two rows written
  -- in one statement tie on their timestamps, which leaves "last" nondeterministic without it.
  LEFT JOIN LATERAL (
       SELECT pl.ph_reading, pl.ph_read_at
         FROM public.kitchen_stage_log pl
        WHERE pl.batch_id = b.id
          AND pl.ph_reading IS NOT NULL
        ORDER BY pl.ph_read_at DESC, pl.id DESC
        LIMIT 1
  ) ph ON TRUE
 WHERE b.deleted_at IS NULL;

-- schema_version.description is NOT NULL with no default — omitting it fails the apply
-- mid-transaction. Caught by the prod dry-run, which is what the dry-run is for.
INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-phrecord-20260904',
        'PHRECORD: kitchen_stage_log.ph_reading + ph_read_at, their pairing and scale CHECKs, '
        'idx_ksl_ph, and last_ph_reading / last_ph_read_at on v_kitchen_batch_current. A recorded '
        'measurement, shown back as typed. Nothing derives, scores or gates on it.',
        now())
ON CONFLICT (version) DO UPDATE
  SET description = EXCLUDED.description, applied_at = EXCLUDED.applied_at;

COMMIT;

-- Verify:
--   SELECT column_name, is_nullable, column_default FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='kitchen_stage_log'
--      AND column_name IN ('ph_reading','ph_read_at') ORDER BY 1;
--   SELECT conname, convalidated FROM pg_constraint c
--     JOIN pg_class t ON t.oid = c.conrelid
--    WHERE t.relname='kitchen_stage_log' AND conname LIKE 'chk_ksl_ph%' ORDER BY 1;
--   SELECT indexname FROM pg_indexes WHERE tablename='kitchen_stage_log' AND indexname='idx_ksl_ph';
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='v_kitchen_batch_current'
--      AND column_name LIKE 'last_ph%' ORDER BY 1;
