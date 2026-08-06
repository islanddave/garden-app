-- 0a-derived-v3.sql
-- V4-CAL1INDEP-001 — cultivar_weight_derived learns the difference between MORE SAMPLES and MORE
-- EVIDENCE. Confidence stops being awarded for repetition.
--
-- ── THE DEFECT ───────────────────────────────────────────────────────────────────────────────────
-- The v2 view (v4-cal1-slicec-001/0f) computes confidence purely from COUNT(*) and STDDEV_SAMP over
-- the per-sample ratios:
--
--     WHEN COUNT(*) < 2 THEN 'provisional'
--     WHEN STDDEV_SAMP(per_unit)/AVG(per_unit) <= 0.15 THEN 'high'   ...
--
-- Both inputs are blind to whether the rows describe DIFFERENT OBSERVATIONS. Two rows carrying the
-- same ratio drive stddev to exactly 0, so cv = 0, so the group is promoted to 'high' — the top of
-- the ladder — on a set that contains no information about dispersion at all. Zero additional
-- evidence buys maximum confidence, and the ladder is monotone in the wrong direction: the more
-- redundant the data, the more certain the view claims to be.
--
-- That matters because resolve_harvest_weight promotes on exactly this column
-- (corroborated := confidence IN ('high','medium') OR sample_n >= 5), so a fake 'high' does not
-- merely mislabel a row — it overrides the curated variety reference for every future harvest of
-- that cultivar.
--
-- ── LIVE, AT THE TIME OF WRITING ─────────────────────────────────────────────────────────────────
-- Pineapple Tomatillo (457d4628-1531-4349-8af7-2a114c206599), unit 'count': sample_n = 2, cv = 0,
-- confidence 'high'. The two live samples are 3 g / 2 fruit (2026-08-05) and 9 g / 6 fruit
-- (2026-08-06) — genuinely separate weighings a day apart that both land on exactly 1.5 g/fruit.
-- Nothing about that pair establishes tightness. A gram-resolution scale weighing ~1.5 g fruit
-- quantises to roughly +/-33% per fruit, so agreeing "exactly" is what the lattice does, not what
-- the cultivar does. It is the ONLY group in the live set with distinct_ratios = 1 and n >= 2.
--
-- ── A CORRECTION TO THE ORIGINALLY REPORTED MECHANISM ────────────────────────────────────────────
-- This defect was reported as cross-unit duplication: a third row exists for that cultivar,
-- (unit='bunch', 3 g, 2), written 16 seconds before the 'count' row, and it is the same physical
-- weighing recorded twice. That row is real, but it is NOT what produced the 'high' — and the
-- proposed remedy (collapse samples sharing (cultivar_id, sampled_at, ratio) ACROSS units) would
-- not have moved a single confidence value. Two independent reasons, both verified against live:
--
--   1. That sample is already excluded. Its source harvest (fa115a1d…) was soft-deleted 16 s after
--      creation — Dave re-logged it under 'count' — and the v2 view already anti-joins samples whose
--      source event is deleted. It contributes to nothing today.
--   2. Even had it survived, it could not have inflated the 'count' group's cv. The view groups by
--      (cultivar_id, UNIT), so a cross-unit twin always lands in a DIFFERENT group. Cross-unit
--      duplication cannot raise any group's confidence, because the duplicate is never in the group.
--
-- So the requested cross-unit collapse is a no-op against cv, and it is also the wrong remedy on the
-- merits: "2 bunches weigh 3 g" and "2 fruits weigh 3 g" are not duplicate measurements of one
-- quantity, they are CONTRADICTORY claims about two different quantities (a bunch contains several
-- fruits, so both cannot hold). Averaging them would manufacture a number neither row asserts. The
-- twin is therefore FLAGGED for review, not merged — see cultivar_weight_crossunit_suspect below,
-- and the sample-level exclusion in the independent_n definition.
--
-- The real inflation path is SAME-unit and is reachable today: two DISTINCT harvest events carrying
-- an identical (unit, grams, count) payload — a double-submit that creates two events rather than
-- editing one — produce two samples in the SAME group. The 0f no-op guard cannot catch it: that
-- guard keys on source_event_id, and these are different events. Result: cv = 0, confidence 'high',
-- one weighing. This migration closes that path.
--
-- ── WHAT THIS CHANGES ────────────────────────────────────────────────────────────────────────────
-- Two new columns make the missing distinction explicit, and the ladder is rebuilt on them.
--
--   independent_n    COUNT(DISTINCT (sampled_at, ratio)) over samples with no cross-unit twin.
--                    "How many separate observations do I actually have?" Rows that agree on BOTH
--                    the instant and the ratio are one observation however many times they were
--                    written, so a duplicate cannot buy corroboration.
--   distinct_ratios  COUNT(DISTINCT ratio). "How many different answers have I seen?" At 1, the
--                    sample stddev is 0 by construction and carries no dispersion information.
--
--   confidence :=
--     independent_n < 2    -> 'provisional'   genuinely one observation, whatever COUNT(*) says
--     distinct_ratios < 2  -> 'medium'        real corroboration, but cv = 0 is an artifact
--     else                 -> the v2 cv ladder, byte-for-byte unchanged
--
-- WHY THE MIDDLE RUNG IS 'medium' AND NOT 'provisional'. The task proposed demoting every
-- distinct_ratios = 1 group to 'provisional' regardless of sample_n. That is the stricter reading
-- and it is one predicate away (see README-BUILD.md §Stricter variant), but it is not the right
-- default here, for a reason that is in the repo rather than in theory: Pineapple Tomatillo is the
-- only group it would hit, and its factor has ALREADY been reviewed and accepted — see
-- scripts/harvest-weight-ratchet-ack.json, decision "ACCEPT: the measurement is right and the
-- reference is wrong for this variety", against Dave's standing direction that "his own weighings
-- ARE the target: the catalogue reference is the fallback, not the authority". 'provisional' would
-- drop the group below tier 4 and hand every future tomatillo harvest back to the generic 8 g/count
-- catalogue figure, reversing that decision as a side effect of a confidence fix.
--
-- The two rungs separate the two questions the v2 column conflated. HOW GOOD IS THE POINT ESTIMATE
-- is answered by independent_n — two real weighings of the correct cultivar beat a generic
-- catalogue number, and 'medium' keeps that promotion. HOW MUCH DO I KNOW ABOUT SPREAD is answered
-- by distinct_ratios — at 1, nothing, so 'high' is unavailable. The claim that gets retracted is
-- precisely the unsupported one.
--
-- usable_for_comparison moves from COUNT(*) >= 2 to independent_n >= 2. Same question, honest input.
-- sample_n keeps its exact v2 meaning (raw live row count) so nothing reading it changes under it;
-- independent_n is the new column, not a redefinition of the old one.
--
-- cv is still computed and still reported when it is 0. Reporting cv = 0 next to confidence
-- 'medium' is the diagnostic — suppressing it would hide the very signal that identifies these
-- groups.
--
-- SAFETY: CREATE OR REPLACE on a view with NO dependents (verified against live pg_depend). The
-- eight existing columns keep their names, types and ORDER — required, since CREATE OR REPLACE VIEW
-- may only APPEND — so the two new columns are last. No table, column, constraint or row is
-- touched, and not one gram value in harvest_log moves as a result of this file. Re-runnable.

-- ── the derived view, v3 ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.cultivar_weight_derived AS
WITH live AS (
  SELECT s.id, s.cultivar_id, s.unit, s.total_grams, s.unit_count, s.sampled_at,
         (s.total_grams / s.unit_count)            AS per_unit,
         -- The distinctness key. Rounded so that numeric scale artifacts (3/2 vs 9/6) cannot split
         -- one ratio into two, which would silently re-open the hole this file exists to close.
         -- 6 dp is far below any weighing resolution that reaches this table.
         round(s.total_grams / s.unit_count, 6)    AS ratio_key
    FROM public.cultivar_weight_sample s
   WHERE NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void v WHERE v.sample_id = s.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.event_log e
        WHERE e.id = s.source_event_id AND e.deleted_at IS NOT NULL)
),
flagged AS (
  -- One physical weighing logged under two units leaves one row in each of two groups. We cannot
  -- tell WHICH unit was the mistake, so neither row may serve as corroboration for its own group —
  -- fail closed. The row still contributes to grams_per_unit (it is the only evidence that group
  -- has); it just stops counting as an independent observation.
  SELECT l.*,
         EXISTS (
           SELECT 1 FROM live t
            WHERE t.cultivar_id = l.cultivar_id
              AND t.sampled_at  = l.sampled_at
              AND t.ratio_key   = l.ratio_key
              AND t.unit       <> l.unit
         ) AS crossunit_twin
    FROM live l
),
agg AS (
  SELECT
    cultivar_id,
    unit,
    SUM(total_grams) / SUM(unit_count)                              AS grams_per_unit,
    COUNT(*)                                                        AS sample_n,
    SUM(unit_count)                                                 AS total_units,
    COUNT(DISTINCT ratio_key)                                       AS distinct_ratios,
    COUNT(DISTINCT (sampled_at, ratio_key))
      FILTER (WHERE NOT crossunit_twin)                             AS independent_n,
    CASE WHEN COUNT(*) >= 2 AND AVG(per_unit) > 0
         THEN STDDEV_SAMP(per_unit) / AVG(per_unit) END             AS cv
    FROM flagged
   GROUP BY cultivar_id, unit
)
SELECT
  cultivar_id,
  unit,
  grams_per_unit,
  sample_n,
  total_units,
  cv,
  (independent_n >= 2)                                              AS usable_for_comparison,
  CASE
    -- one observation, however many rows recorded it
    WHEN independent_n < 2   THEN 'provisional'
    -- corroborated, but every observation returned the same answer: stddev 0 is arithmetic, not
    -- evidence, so the top rung is withheld
    WHEN distinct_ratios < 2 THEN 'medium'
    -- from here down, identical to v2
    WHEN cv <= 0.15          THEN 'high'
    WHEN cv <= 0.35          THEN 'medium'
    ELSE 'low'
  END                                                               AS confidence,
  independent_n,
  distinct_ratios
FROM agg;

COMMENT ON VIEW public.cultivar_weight_derived IS
  'CAL-1 per-(cultivar,unit) pooled weight factor (v3). grams_per_unit is the count-weighted pooled '
  'ratio SUM(grams)/SUM(count) over live (non-voided, non-soft-deleted-source) samples. sample_n is '
  'the RAW live row count (v2 meaning, unchanged). independent_n is the number of DISTINCT '
  '(sampled_at, ratio) observations excluding cross-unit twins — duplicate rows describing one '
  'weighing collapse to 1. distinct_ratios is the number of different ratios seen; at 1 the sample '
  'stddev is 0 by construction and cv carries no dispersion information. confidence: provisional '
  'when independent_n < 2; capped at medium when distinct_ratios < 2; otherwise the cv ladder '
  '(<=0.15 high, <=0.35 medium, else low). Repetition can no longer raise confidence.';

-- ── cross-unit twin review queue ─────────────────────────────────────────────────────────────────
-- Diagnostic only. Nothing reads this to make a decision; it exists so a mis-unit entry surfaces
-- for a human instead of quietly sitting in the sample table. Deliberately NOT auto-voided: these
-- are Dave's own measurements, cultivar_weight_sample is append-only by trigger, and correcting one
-- means choosing which of the two units was wrong — a judgement, not a rule. The correction path is
-- the existing void-don't-edit ledger (INSERT INTO cultivar_weight_void), never a DELETE.
CREATE OR REPLACE VIEW public.cultivar_weight_crossunit_suspect AS
WITH live AS (
  SELECT s.id, s.cultivar_id, s.unit, s.total_grams, s.unit_count, s.sampled_at, s.source_event_id,
         round(s.total_grams / s.unit_count, 6) AS ratio_key
    FROM public.cultivar_weight_sample s
   WHERE NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void v WHERE v.sample_id = s.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.event_log e
        WHERE e.id = s.source_event_id AND e.deleted_at IS NOT NULL)
)
SELECT a.cultivar_id,
       a.sampled_at,
       a.ratio_key                        AS grams_per_unit,
       a.id                               AS sample_id,
       a.unit                             AS unit,
       a.source_event_id                  AS source_event_id,
       b.id                               AS twin_sample_id,
       b.unit                             AS twin_unit,
       b.source_event_id                  AS twin_source_event_id,
       a.total_grams,
       a.unit_count
  FROM live a
  JOIN live b
    ON b.cultivar_id = a.cultivar_id
   AND b.sampled_at  = a.sampled_at
   AND b.ratio_key   = a.ratio_key
   AND b.unit       <> a.unit;

COMMENT ON VIEW public.cultivar_weight_crossunit_suspect IS
  'CAL-1 review queue: live weight samples that share (cultivar_id, sampled_at, grams-per-unit) with '
  'another live sample under a DIFFERENT unit — i.e. one physical weighing most likely logged twice '
  'under two units. Two rows per pair (symmetric), one from each side. Diagnostic only: these rows '
  'are already excluded from independent_n in cultivar_weight_derived, so they cannot corroborate. '
  'Resolve by voiding the wrong-unit sample via cultivar_weight_void (void-do-not-edit); never '
  'DELETE, and do not merge the two — different units are different quantities, not duplicates.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.0-cal1-indep-001',
  'V4-CAL1INDEP-001: cultivar_weight_derived v3 — an independence guard before cv is trusted. v2 '
  'computed confidence from COUNT(*) and STDDEV_SAMP alone, so N rows carrying the SAME ratio gave '
  'cv=0 and promoted the group to ''high'' on zero dispersion evidence; resolve_harvest_weight then '
  'used that fake ''high'' to override the curated variety reference. Adds independent_n '
  '(COUNT(DISTINCT (sampled_at, ratio)) excluding cross-unit twins) and distinct_ratios, and rebuilds '
  'the ladder on them: independent_n<2 -> provisional (duplicate rows are one observation); '
  'distinct_ratios<2 -> capped at medium (cv=0 is arithmetic, not evidence); otherwise the v2 cv '
  'ladder unchanged. usable_for_comparison now reads independent_n; sample_n keeps its v2 meaning. '
  'Also adds cultivar_weight_crossunit_suspect, a read-only review queue for one weighing logged '
  'under two units. Live effect: exactly one group moves (Pineapple Tomatillo/count, high -> medium, '
  'n=2 with 1 distinct ratio); no other confidence value and no harvest_log gram changes.')
ON CONFLICT (version) DO NOTHING;
