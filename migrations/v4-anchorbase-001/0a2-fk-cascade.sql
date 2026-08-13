-- 0a2-fk-cascade.sql
-- V4-ANCHORBASE-001 amendment (pre-0b three-seat expert consult, 2026-08-12). Two conditions,
-- both additive-safe, both required before 0b populates the table:
--
-- (1) FK -> ON DELETE CASCADE. The regression seat REFUTED "populating is inert": the rows arm
--     plant_anchor_derivation_plant_id_fkey (implicit NO ACTION) as a NEW inbound delete-blocker
--     on every derived-for planting. Hard `DELETE FROM plants` is a supported, carefully
--     enumerated operation in this codebase (staging smoke purge, integration teardowns,
--     archive_plant_events() — see BUG-EVTANCHORDEL-001) and NONE of those callers clear this
--     table; post-0b they would fail 23503 naming a table outside their enumerated blocker list.
--     Under the Soft-Delete-Only rule, derivations are the carve-out class — derived, regenerable,
--     model-versioned data — so the correct shape is that a derivation dies with its planting
--     rather than blocking the deletion. One ALTER fixes every caller at once, no function edits.
--     (A superseded guess/truth pair whose planting is hard-deleted measures nothing — hard
--     deletes here are admin/test paths, not user history.)
--
-- (2) plausibility marker column. The horticulture seat identified a CATEGORY ERROR in the
--     baseline tier: for mid-season adds, created_at is an ACQUISITION date, not a planting date —
--     three 0b targets are literally named "Rescue" and one was already flowering at derivation.
--     Those rows do not estimate the planting date with error; they measure a different quantity.
--     Separately, a derived anchor whose date + catalogue DTM lands after first fall frost
--     (2026-09-28) is not a low-confidence estimate — it is impossible (one target derives to
--     Oct 9). Consumers must be able to drop both classes in one predicate. 0b stamps this at
--     write time; the column is nullable and additive.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.plant_anchor_derivation
  DROP CONSTRAINT plant_anchor_derivation_plant_id_fkey,
  ADD  CONSTRAINT plant_anchor_derivation_plant_id_fkey
       FOREIGN KEY (plant_id) REFERENCES public.plants(id) ON DELETE CASCADE;

ALTER TABLE public.plant_anchor_derivation
  ADD COLUMN IF NOT EXISTS plausibility text;

ALTER TABLE public.plant_anchor_derivation
  DROP CONSTRAINT IF EXISTS plant_anchor_derivation_plausibility_chk,
  ADD  CONSTRAINT plant_anchor_derivation_plausibility_chk
       CHECK (plausibility IS NULL OR plausibility IN ('rescue_suspect', 'post_frost_impossible'));

COMMENT ON COLUMN public.plant_anchor_derivation.plausibility IS
  'V4-ANCHORBASE-001 consult 2026-08-12. NULL = no known objection. rescue_suspect = the add-date '
  'is likely an acquisition date, not a planting date (name contains "rescue", or status already '
  'flowering/fruiting at derivation). post_frost_impossible = anchor_date + catalogue DTM lands '
  'after the first-fall-frost anchor. Consumers (route join, refits) exclude non-NULL rows unless '
  'they have better information.';

COMMIT;
