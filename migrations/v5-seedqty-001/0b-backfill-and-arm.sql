-- v5-seedqty-001 / 0b-backfill-and-arm.sql
-- V5-SEEDQTY-001 phase 0b — POST-DEPLOY ONLY.
--
-- ⛔ DO NOT RUN THIS UNTIL THE WRITING RELEASE IS LIVE IN PROD. Phase 0a is safe ahead of the code
-- because everything in it is vacuous under the deployed writer. This file is NOT: it moves live
-- values and it arms a CHECK over a column only the NEW writer sets. Running it early reproduces the
-- 2026-08-03 incident, where a VALIDATE against a column the deployed writer did not populate took
-- harvest logging down until the constraints were dropped.
--
-- The falsifiable test before arming anything here: would the CURRENTLY DEPLOYED code produce a row
-- that violates this? For the pairing CHECK the answer is YES until the seed-measure route ships,
-- because SaveSeedSheet would write a count with no estimated flag. Hence 0b, not 0a.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE BACKFILL SET IS A PREDICATE, NOT A LIST OF IDS.
--
-- The first draft named three UUIDs. Live prod has SIX rows carrying a seed count in
-- quantity_on_hand, and a test written against three ids passes on a backfill that missed three more.
-- Measured 2026-09-04:
--
--   69832d29… 1884 — saved 2026          packet 185.000
--   181627da… Sugar Baby — saved 2026    packet 175.000
--   099cfba0… Ukrainian Purple — 2026    packet 121.000
--   2d6df841… Green Flesh Honeydew       each   100.000   (source "Gardens at Mathews" — saved seed)
--   0bd5f450… Marshmallow                each    15.000
--   8fc07941… Alaska Mix Nasturtium      each    10.000
--
-- `quantity_on_hand > 5` selects exactly those six and nothing else: the next-largest seed row is 4
-- packets (Serrano, Bentley order #50330), so the predicate has real headroom on both sides today.
-- It is used ONCE, here, and is NOT promoted to a continuous invariant — a gate asserting
-- "no seed row exceeds 5" would red the day Dave legitimately buys ten packets of something. The
-- regression guard against a writer putting a count back into quantity_on_hand is a TEST
-- (SavedSeeds.storedCount), not a threshold on live data.
--
-- WHY `unit` IS LEFT ALONE. The three `each` rows become `1 each`, which reads oddly but is not a
-- false claim. Rewriting them to `packet` would assert a container nobody recorded. The bug being
-- fixed is a COUNT wearing a container unit, not the choice of container.
--
-- WHY THE `oz` ROW IS NOT IN THIS BACKFILL. `74ae4058… Pinto Beans (Quincy)` is `unit='oz',
-- quantity_on_hand=1.000` — one ounce of seed. That is a WEIGHT, correctly expressed in vocabulary
-- that already existed before this migration; it is not the defect. Moving it into seed_weight_g
-- while `oz` remains a legal unit would create exactly the two-encodings-of-one-jar problem this
-- migration exists to avoid (it is why inventory_items_unit_check was NOT widened — see 0a's
-- header). Recorded rather than silently skipped; a later decision may consolidate it.
--
-- NOTHING IS BACKFILLED FROM metadata.seeds_per_packet, and that is a judgement, not an oversight.
-- The key is present on 193 of 316 seed rows, 85 non-null. Of those 85, THIRTY-NINE are the literal
-- value `1`, plus 11 twos and 8 threes — that is the extractor reading "1 packet" as a seed count,
-- not a packet holding one seed. Values are also mixed types (71 string, 14 number). Seeding
-- seed_count from that would poison the new column at birth, and seed_count_estimated=true would not
-- rescue it: these are misreadings, not estimates. The key has ZERO readers anywhere in src/ or
-- lambda/ (verified by grep), so it is inert; it is left in place, unread, for Dave to rule on
-- (ledger OPS-SEEDSPERPACKET-001). Its only writer, the prompt schema at
-- lambda/inventory-items/extract.js:40, is removed in this same release so it stops growing.

BEGIN;

-- Guard: refuse to run before the writer is live. If seed_count is still NULL on every row AND the
-- deployed code cannot set it, this is a no-op — but running it against a stale deploy is the
-- ordering error above, so fail loudly rather than silently half-applying.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-seedqty-001') THEN
    RAISE EXCEPTION 'v5-seedqty-001 phase 0a has not been applied here. Apply 0a first.';
  END IF;
END $$;

-- ── The backfill. Idempotent by construction: the predicate stops matching once it has run, because
-- every matched row's quantity_on_hand becomes 1. Re-running is a no-op, not a double-move.
UPDATE public.inventory_items
   SET seed_count           = quantity_on_hand::integer,
       seed_count_estimated = false,   -- these are hand-counted saved lots, not vendor claims
       quantity_on_hand     = 1
 WHERE category = 'seeds'
   AND deleted_at IS NULL
   AND quantity_on_hand > 5
   AND seed_count IS NULL;             -- belt: never overwrite a count the new writer already set

-- ── Arm the pairing CHECK. NOT VALID first, then VALIDATE, so the table is not scanned under an
-- ACCESS EXCLUSIVE lock while writes are live. Soft-delete-aware per house precedent
-- (plant_projects_kind_not_null_unless_deleted, plants_surface_no_cultivar): a soft-deleted row
-- cannot be repaired through the app, so a constraint that could wedge on one must exempt it.
ALTER TABLE public.inventory_items
  ADD CONSTRAINT chk_inventory_seed_count_basis_pairing
    CHECK (deleted_at IS NOT NULL OR (seed_count IS NULL) = (seed_count_estimated IS NULL))
    NOT VALID;

-- Pre-VALIDATE sweep over the FULL table, unfiltered by deleted_at, per L-058. If this raises, STOP:
-- something wrote a count without its basis and VALIDATE would fail anyway, less legibly.
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad
    FROM public.inventory_items
   WHERE deleted_at IS NULL
     AND (seed_count IS NULL) <> (seed_count_estimated IS NULL);
  IF bad > 0 THEN
    RAISE EXCEPTION 'chk_inventory_seed_count_basis_pairing would fail on % live row(s) — triage before validating', bad;
  END IF;
END $$;

ALTER TABLE public.inventory_items
  VALIDATE CONSTRAINT chk_inventory_seed_count_basis_pairing;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-seedqty-001b',
        'SEEDQTY phase 0b (POST-DEPLOY): backfilled the six seed rows whose quantity_on_hand held a '
        'seed count (185/175/121 packet + 100/15/10 each) into seed_count with '
        'seed_count_estimated=false, setting quantity_on_hand=1 and leaving unit untouched. Selected '
        'by the predicate quantity_on_hand > 5, not by an id list — the first draft named three ids '
        'and there were six. Idempotent (the predicate stops matching after it runs). The oz row '
        '(Pinto Beans, 1 oz) is deliberately NOT migrated: it is a weight already correctly '
        'expressed, and moving it would create a second encoding. Nothing backfilled from '
        'metadata.seeds_per_packet -- 39 of its 85 non-null values are the literal 1. Then armed '
        'chk_inventory_seed_count_basis_pairing NOT VALID -> full-table sweep -> VALIDATE.',
        now())
ON CONFLICT (version) DO NOTHING;

COMMIT;
