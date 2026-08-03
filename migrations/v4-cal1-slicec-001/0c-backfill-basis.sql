-- 0c-backfill-basis.sql
-- V4-HARVDUAL-001 Slice C — re-derive every stored weight through the v2 resolver and populate
-- harvest_log.weight_basis.
--
-- WHY THIS IS REQUIRED, not optional. v4-cal1-pervariety-001 added three CHECKs on harvest_log:
--   chk_harvest_log_weight_basis            weight_basis IN ('measured','cultivar','crop_type')
--   chk_harvest_log_weight_basis_pairing    (weight_grams IS NULL) = (weight_basis IS NULL)
--   chk_harvest_log_weight_basis_estimated  weight_estimated = (weight_basis <> 'measured')
-- They were authored against pervariety-001's ON-READ model, where harvest_log stores MEASURED grams
-- only and estimates are computed at read time — under which every estimated row has NULL grams and
-- the pairing CHECK is trivially satisfied.
--
-- v4-cal1-refweight-001 overturned that premise on Dave's 2026-08-03 directive: estimates ARE stored
-- now, and all 332 live rows carry weight_grams. So every one of them currently has a weight with a
-- NULL basis, which VIOLATES the pairing CHECK. The CHECKs were added NOT VALID, so the apply
-- succeeded and existing rows were never scanned — but 0d cannot VALIDATE them, and the very next
-- UPDATE to any harvest row would raise 23514. This backfill closes that window; it is the price of
-- storing estimates, and it is worth paying because it also gives every row per-row provenance.
--
-- The derivation is NOT reimplemented here — it calls resolve_harvest_weight, the same function both
-- Lambda write paths use, so the backfill cannot drift from live writes. (v1 of this backfill, in
-- v4-cal1-refweight-001/0d, DID inline its own COALESCE; that duplicate is retired by this file.)
--
-- MEASURED-SAFE: scoped to rows that are NOT already user-measured. A row whose weight the user
-- typed (weight_estimated=false on a non-weight unit) is left exactly as it is — re-deriving it
-- would discard the measurement in favour of an estimate.
--
-- RE-RUNNABLE: pure function of (plant, quantity, unit, reference/sample data). Run it again after
-- any new sample lands to propagate the improved factor.

BEGIN;

-- The resolution runs in a CTE, not in the UPDATE's own FROM clause: a LATERAL there cannot
-- reference the UPDATE target (`h`), which Postgres rejects with "invalid reference to FROM-clause
-- entry". Inside the CTE `h` is an ordinary FROM entry, so the function can be fed per-row.
WITH resolved AS (
  SELECT h.id, rw.weight_grams, rw.weight_estimated, rw.weight_basis
    FROM public.harvest_log h
    JOIN public.event_log e ON e.id = h.event_id AND e.deleted_at IS NULL
    CROSS JOIN LATERAL public.resolve_harvest_weight(e.plant_id, h.unit, h.quantity, NULL) rw
   WHERE h.deleted_at IS NULL
     -- leave a genuinely user-supplied weight alone: measured, but not merely because the unit is one
     AND NOT (h.weight_estimated IS FALSE AND h.unit NOT IN ('g','kg','lb','oz'))
)
UPDATE public.harvest_log h
   SET weight_grams     = r.weight_grams,
       weight_estimated = r.weight_estimated,
       weight_basis     = r.weight_basis,
       updated_at       = now()
  FROM resolved r
 WHERE r.id = h.id;

INSERT INTO public.schema_version (version, description)
VALUES ('4.20.2-cal1-slicec-basis-001','V4-HARVDUAL-001 Slice C: re-derive harvest_log weights through resolve_harvest_weight v2 and populate weight_basis, so pervariety-001 three CHECKs can be VALIDATEd. Required because refweight-001 stores estimates, which the on-read model those CHECKs assumed did not. Measured-safe and re-runnable.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
