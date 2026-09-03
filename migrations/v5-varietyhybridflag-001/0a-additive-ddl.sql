-- V5-VARIETYHYBRIDFLAG-001 — record breeding system on the VARIETY, so the app can answer
-- "will seed off this plant come true?"
--
-- WHY. The app cannot answer that question and the failure is silent for a full season: you save
-- seed in September, sow it in March, and find out in July. 19 true alarms exist in the current
-- roster (10 pepper + 9 tomato F1s) and 8 of the peppers DO NOT say F1 in their names — Carmen,
-- Cherry Stuffer, Dragon Roll, Gong Bao, Pick-N-Pop Yellow, Ristra Cayenne II, Thai Dragon,
-- Chilly Chill. Nothing in the UI distinguishes them from an heirloom.
--
-- WHY NOT REUSE THE EXISTING METADATA. inventory_items.metadata carries heirloom / open_pollinated
-- / hybrid_f1 keys on 196 rows. They are a VENDOR ARTIFACT, not a fact: the flags partition almost
-- perfectly by vendor, Mary's Heirloom Seeds is 36-for-36 `heirloom: true` (the vendor's own NAME
-- contains the word) and flags a variety called `Biquinho Yellow F1`. The usable count was revised
-- 196 -> 62 -> 8 across three passes. This migration loads NONE of it; the backfill payload
-- (0b-data.sql) is independently researched with a named source per row.
--
-- WHY VARIETY GRAIN, NOT LOT. The case for the lot was that Serrano and Thai Hot "contradict
-- themselves" across packets. Verified: both are Botanical-Interests-`false` vs Mary's-`true`, with
-- ZERO same-vendor contradictions anywhere in prod. That measures labelling conventions, not
-- lot-level truth. Per-lot override is deferred to V2 (design §8).
--
-- WHY heirloom IS NOT HERE. It is a different axis and it ships as V5-HEIRLOOMSTATUS-001, which has
-- its own 6-seat verdict (project-state/_seedvault-20260902/heirloom-panel/VERDICT-V100.md). Prod
-- proves the orthogonality: Black Krim, Green Zebra and Yellow Pear each carry `heirloom:false` on a
-- Botanical Interests lot AND `open_pollinated:true` on an Amazon lot of the SAME variety.
--
-- CHECKS ARE CREATED VALIDATED, NOT `NOT VALID`. The design seat wrote `NOT VALID`; the
-- V5-HEIRLOOMSTATUS-001 panel then measured that reasoning false on THIS table, twice
-- independently: all 16 pre-existing CHECKs on plant_varieties are `convalidated = t`, and a
-- NOT VALID CHECK still blocks new INSERTs, blocks an UPDATE of an unrelated column on a violating
-- row, and blocks a clean->bad UPDATE. It defers nothing about writer coupling — it is armed the
-- instant it exists. All it buys is skipping a 466-row scan costing microseconds, in exchange for a
-- permanent `convalidated=false` that a later reader cannot distinguish from "known violators
-- exist". Every column here is born NULL and every CHECK is NULL-tolerant, so there is nothing to
-- scan. Per memory `arming-a-check-is-a-deploy`: arming is safe here ONLY because these constrain
-- columns no deployed writer sets.
--
-- VIEW. public.cultivar is an EXPLICIT 42-column list, not SELECT *, and lambda/varieties both
-- READS and WRITES through it (UPDATE public.cultivar, INSERT INTO public.cultivar). lambda/plants
-- builds planting.variety_ref from it too, which is the object SaveSeedSheet holds at save time. A
-- view with an explicit column list does NOT auto-inherit new base-table columns, so WITHOUT the
-- widen below all four columns are unreadable and unwritable by every app surface — the
-- V4-DTMBASISVAR-001 near-outage class. The 42-column list below was captured from
-- pg_get_viewdef on PROD immediately before writing this file; the new columns are appended LAST as
-- plain pass-throughs so the view stays auto-updatable for the varieties INSERT.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

ALTER TABLE public.plant_varieties
  -- Breeding SYSTEM only. NULL = never asked; 'unknown' = asked and unanswerable, which is a
  -- DIFFERENT and more useful state because it lets the roster be triaged. Excludes 'f2_or_later'
  -- (a generation is a fact about a SAVE, never about a catalogue variety — it lives on the lot in
  -- V2), 'blend' and 'not_applicable' (both variety_rank facts), and 'heirloom' (a separate axis).
  ADD COLUMN IF NOT EXISTS breeding_system     text,

  -- Provenance OF breeding_system. Mirrors the weight_source house pattern on this same table.
  -- CHECK-paired below so a value can never stand without one: this is the anti-`grown_as` guard,
  -- named for the bulk default that set 'annual' on 362 of 413 cultivars and made the column
  -- worthless as evidence.
  ADD COLUMN IF NOT EXISTS breeding_source     text,

  -- Three tiers genuinely present in the payload: "three vendors agree" / "one catalogue page" /
  -- "lean hybrid, most likely - verify the packet".
  ADD COLUMN IF NOT EXISTS breeding_confidence text,

  -- The TAXON-RANK axis, and it decides whether breeding_system is even DEFINED for the row.
  -- 14 of 38 live pepper entries are pod types or market classes (Habanero, Serrano, Ancho,
  -- Scotch Bonnet, Piri Piri...). For those, breeding status is not unknown - it is undefined at
  -- this grain, because the name covers many cultivars with different answers.
  ADD COLUMN IF NOT EXISTS variety_rank        text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plant_varieties_breeding_system') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_breeding_system
      CHECK (breeding_system IS NULL OR breeding_system = ANY (ARRAY[
        'f1'::text,
        'open_pollinated'::text,
        -- MCPD SAMPSTAT 300. Without it a landrace is forced into 'open_pollinated', which asserts
        -- a uniformity the material does not have. Del Tonet, the roster's #1 "save these first",
        -- is a Catalan tomate de colgar landrace.
        'landrace'::text,
        'unknown'::text]));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plant_varieties_breeding_source') THEN
    -- No 'vendor_blanket' value: the vendor-identity class (all 36 Mary's rows) is NOT WRITTEN AT
    -- ALL rather than written and labelled. A labelled-but-present bad value still reads as data.
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_breeding_source
      CHECK (breeding_source IS NULL OR breeding_source = ANY (ARRAY[
        'packet_label'::text,
        'vendor_catalog'::text,
        'breeder'::text,
        'reference_work'::text,
        'grower_record'::text,
        'inference'::text]));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plant_varieties_breeding_confidence') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_breeding_confidence
      CHECK (breeding_confidence IS NULL OR breeding_confidence = ANY (ARRAY[
        'high'::text, 'medium'::text, 'low'::text]));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plant_varieties_variety_rank') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_variety_rank
      CHECK (variety_rank IS NULL OR variety_rank = ANY (ARRAY[
        'cultivar'::text,
        'market_class'::text,
        'blend'::text,
        'species'::text,
        'placeholder'::text]));
  END IF;

  -- ANTI-GROWN_AS. A breeding call may never stand unsourced.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plant_varieties_breeding_sourced') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_breeding_sourced
      CHECK (breeding_system IS NULL OR breeding_source IS NOT NULL);
  END IF;

  -- THE FORCING FUNCTION, and the most important constraint in this file.
  -- The DANGEROUS claim is "safe to save"; the HARMLESS error is "unknown". So a POSITIVE
  -- open-pollinated claim structurally requires the rank that makes it meaningful, while 'f1' and
  -- 'unknown' (both of which produce a warning or silence) may be asserted at any rank.
  -- This makes it impossible to record "Serrano is open-pollinated" — Serrano is a market class
  -- covering many cultivars, and asserting OP for it would tell you seed comes true when it may not.
  -- CONTRACT NOTE — this creates a REQUIRED FIELD PAIRING. Any write path that can set
  -- breeding_system='open_pollinated' must send variety_rank in the SAME statement or take a 23514.
  -- The varieties PUT and the backfill must both honour it, and that pairing is a test, not a
  -- comment (see gates.yml and the integration suite).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plant_varieties_op_requires_cultivar') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_op_requires_cultivar
      CHECK (breeding_system IS DISTINCT FROM 'open_pollinated' OR variety_rank = 'cultivar');
  END IF;
END $$;

COMMENT ON COLUMN public.plant_varieties.breeding_system IS
  'V5-VARIETYHYBRIDFLAG-001. Breeding SYSTEM only. NULL = never asked; unknown = asked and '
  'unanswerable. Not provenance (that is heirloom_status, V5-HEIRLOOMSTATUS-001) and not rank '
  '(variety_rank). f2_or_later is deliberately absent: a generation is a fact about a save, not '
  'about a catalogue variety, and belongs on inventory_items in V2.';
COMMENT ON COLUMN public.plant_varieties.breeding_source IS
  'Qualifies breeding_system ONLY. Mirrors the weight_source pattern. Required whenever '
  'breeding_system is set (chk_plant_varieties_breeding_sourced).';
COMMENT ON COLUMN public.plant_varieties.breeding_confidence IS
  'Confidence in breeding_system. high = multiple independent sources agree; medium = one '
  'catalogue or vendor page; low = inference or a lean, verify the packet.';
COMMENT ON COLUMN public.plant_varieties.variety_rank IS
  'Taxon rank of THIS ROW''S NAME, which decides whether breeding_system is defined for it. '
  'cultivar = a specific named variety; market_class = a pod type or class covering many cultivars '
  '(Habanero, Serrano, Ancho); blend = a seed mixture; species = a bare species name; placeholder = '
  'a stand-in row. Required for a positive open_pollinated claim '
  '(chk_plant_varieties_op_requires_cultivar).';

-- WIDEN public.cultivar. 42 columns captured verbatim from pg_get_viewdef on PROD 2026-09-03,
-- with the four new columns appended LAST. Omitting this is the whole-surface outage:
-- lambda/varieties writes THROUGH this view and lambda/plants reads variety_ref from it.
CREATE OR REPLACE VIEW public.cultivar AS
SELECT id,
    name AS display_name,
    species,
    genus,
    days_to_maturity_min,
    days_to_maturity_max,
    care_notes,
    soil_notes,
    sun_requirements,
    common_diseases,
    expected_yield_notes,
    photo_id,
    source_url,
    created_by,
    created_at,
    updated_at,
    deleted_at,
    source_proj_rescope_project_id,
    origin_country,
    origin_region,
    model_version,
    crop_type_slug,
    lifecycle,
    scoville_min,
    scoville_max,
    growth_habit,
    produces_scape,
    determinacy,
    day_length_response,
    grown_as,
    start_method,
    start_indoor_weeks_min,
    start_indoor_weeks_max,
    direct_sow_timing,
    sow_depth_in,
    seed_spacing_in,
    row_spacing_in,
    days_to_germ_min,
    days_to_germ_max,
    sow_season,
    sow_notes,
    dtm_basis,
    breeding_system,
    breeding_source,
    breeding_confidence,
    variety_rank
   FROM plant_varieties;

-- Re-grant explicitly. CREATE OR REPLACE preserves grants, so this is belt-and-braces for the
-- CREATE OR REPLACE path — but the ROLLBACK narrows the view and therefore needs DROP + CREATE,
-- which does not. Prod does carry a pg_default_acl row granting garden_ro SELECT on new public
-- relations (measured 2026-09-03 by a rolled-back probe), so the grant would auto-restore; that
-- default ACL does NOT cover garden_export_ro, and STAGING HAS NEITHER ROLE, so staging can never
-- test either behaviour. Explicit is the only form that is correct on both.
GRANT SELECT ON public.cultivar TO garden_ro;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.101.0-varietyhybridflag-001',
        'VARIETYHYBRIDFLAG: plant_varieties.breeding_system / breeding_source / breeding_confidence / variety_rank (all nullable text, no DEFAULT, six CHECKs created VALIDATED). Lets the app answer "will seed off this plant come true?" - 19 F1s in the current roster, 8 of which do not say F1 in their names. Existing inventory_items.metadata heirloom/open_pollinated/hybrid_f1 flags are NOT loaded: they partition by vendor, Marys Heirloom Seeds is 36-for-36 true including a variety named Biquinho Yellow F1, and the usable count fell 196 -> 62 -> 8 across three passes. Backfill ships separately in 0b-data.sql from an independently researched payload with a named source per row. Two structural guards: breeding_system may never stand without breeding_source (anti-grown_as), and a positive open_pollinated claim requires variety_rank=cultivar so that "Serrano is OP" - a market class covering many cultivars - is unenterable. CHECKs are VALIDATED not NOT VALID: all 16 pre-existing CHECKs on this table are convalidated and a NOT VALID check still blocks writes, so it defers nothing and only leaves a permanent unvalidated flag. public.cultivar widened 42 -> 46 columns because lambda/varieties both reads AND writes through that view and it carries an explicit column list.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;
-- ON CONFLICT because schema_version.version is the PRIMARY KEY, so a re-apply after a rollback
-- rehearsal or a partial-failure retry would otherwise die on duplicate key with the real work
-- already committed. That failure was found on the v4-dtmbasisvar-001 staging rehearsal.

COMMIT;
