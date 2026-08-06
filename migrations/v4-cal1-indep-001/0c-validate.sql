-- 0c-validate.sql
-- V4-CAL1INDEP-001 — post-apply assertions. Read-only; RAISE EXCEPTION on any breach, so a failure
-- aborts and prints the offending fact rather than returning a table nobody reads.
--
-- Run AFTER 0a and 0b. Safe to re-run; asserts properties of the schema and of the live data, not
-- of the apply itself.

BEGIN TRANSACTION READ ONLY;

DO $$
DECLARE
  n bigint;
  r record;
BEGIN
  -- ── structural ────────────────────────────────────────────────────────────────────────────────
  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='cultivar_weight_derived'
     AND column_name IN ('independent_n','distinct_ratios');
  IF n <> 2 THEN
    RAISE EXCEPTION 'v3 view missing independent_n/distinct_ratios (found % of 2)', n;
  END IF;

  -- The eight v2 columns must keep their ordinal positions: CREATE OR REPLACE VIEW may only append,
  -- and any consumer doing positional access would break silently otherwise.
  SELECT count(*) INTO n
    FROM (VALUES ('cultivar_id',1),('unit',2),('grams_per_unit',3),('sample_n',4),
                 ('total_units',5),('cv',6),('usable_for_comparison',7),('confidence',8)) AS want(c,p)
    JOIN information_schema.columns col
      ON col.table_schema='public' AND col.table_name='cultivar_weight_derived'
     AND col.column_name=want.c AND col.ordinal_position=want.p;
  IF n <> 8 THEN
    RAISE EXCEPTION 'v2 column order not preserved in the v3 view (% of 8 in place)', n;
  END IF;

  IF to_regclass('public.cultivar_weight_crossunit_suspect') IS NULL THEN
    RAISE EXCEPTION 'cultivar_weight_crossunit_suspect view missing';
  END IF;

  -- ── the invariant this migration exists to establish ──────────────────────────────────────────
  -- No group may claim 'high' without having seen at least two DIFFERENT answers. This is the whole
  -- defect, stated as an assertion.
  FOR r IN
    SELECT cultivar_id, unit, sample_n, independent_n, distinct_ratios, confidence
      FROM public.cultivar_weight_derived
     WHERE confidence = 'high' AND distinct_ratios < 2
  LOOP
    RAISE EXCEPTION 'group (%, %) claims high on % distinct ratio(s)', r.cultivar_id, r.unit, r.distinct_ratios;
  END LOOP;

  -- A group whose rows all describe one observation must not be promotable at all.
  FOR r IN
    SELECT cultivar_id, unit, sample_n, independent_n, confidence
      FROM public.cultivar_weight_derived
     WHERE independent_n < 2 AND confidence <> 'provisional'
  LOOP
    RAISE EXCEPTION 'group (%, %) has independent_n=% but confidence=%',
      r.cultivar_id, r.unit, r.independent_n, r.confidence;
  END LOOP;

  -- independent_n can never exceed the row count it is distilled from.
  SELECT count(*) INTO n FROM public.cultivar_weight_derived WHERE independent_n > sample_n;
  IF n > 0 THEN
    RAISE EXCEPTION '% group(s) report independent_n > sample_n', n;
  END IF;

  -- usable_for_comparison must be exactly the independent_n>=2 predicate, not a leftover COUNT(*).
  SELECT count(*) INTO n
    FROM public.cultivar_weight_derived
   WHERE usable_for_comparison IS DISTINCT FROM (independent_n >= 2);
  IF n > 0 THEN
    RAISE EXCEPTION '% group(s) have usable_for_comparison out of step with independent_n', n;
  END IF;

  -- ── the resolver reads the new column ─────────────────────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname='public' AND p.proname='resolve_harvest_weight'
       AND pg_get_functiondef(p.oid) LIKE '%independent_n >= 5%'
  ) THEN
    RAISE EXCEPTION 'resolve_harvest_weight still promotes on sample_n; apply 0b';
  END IF;

  -- ── non-regression: the cv ladder itself is untouched above the guard ─────────────────────────
  -- Every group with >= 2 distinct ratios must land exactly where v2 would have put it.
  FOR r IN
    SELECT cultivar_id, unit, cv, confidence,
           CASE WHEN cv <= 0.15 THEN 'high' WHEN cv <= 0.35 THEN 'medium' ELSE 'low' END AS v2_tier
      FROM public.cultivar_weight_derived
     WHERE distinct_ratios >= 2 AND independent_n >= 2
  LOOP
    IF r.confidence <> r.v2_tier THEN
      RAISE EXCEPTION 'group (%, %) cv=% got % but the v2 ladder says %',
        r.cultivar_id, r.unit, r.cv, r.confidence, r.v2_tier;
    END IF;
  END LOOP;

  -- ── informational: what actually moved ────────────────────────────────────────────────────────
  SELECT count(*) INTO n FROM public.cultivar_weight_derived
   WHERE sample_n >= 2 AND distinct_ratios < 2;
  RAISE NOTICE 'degenerate groups (n>=2, one distinct ratio), now capped below high: %', n;

  SELECT count(*) INTO n FROM public.cultivar_weight_derived WHERE independent_n < sample_n;
  RAISE NOTICE 'groups carrying duplicate observations (independent_n < sample_n): %', n;

  SELECT count(*) INTO n FROM public.cultivar_weight_crossunit_suspect;
  RAISE NOTICE 'cross-unit suspect rows awaiting review (2 per pair): %', n;
END $$;

ROLLBACK;
