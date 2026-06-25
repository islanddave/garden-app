-- 0b-data.sql
-- V4 PLANTTYPE — DATA backfill: seed crop_types vocabulary + map live plant_varieties
--   to crop_type_slug (by genus/species, then by name) and set lifecycle from the crop default.
--
-- PURPOSE: populate the controlled crop_types vocabulary (introduced additively in 0a) and
--   backfill the nullable type metadata on EXISTING live plant_varieties rows. Owner-decided
--   horticultural mapping (Dave). Two-pass backfill: (1) precise genus/species rules, then
--   (2) name-substring fallback for rows with null/empty genus. Rows that remain NULL after
--   both passes are AMBIGUOUS by design and are left NULL for manual owner review — never guessed.
--
-- SAFETY: fully idempotent.
--   * crop_types seeds: INSERT ... ON CONFLICT (slug) DO NOTHING (re-run = no-op, never clobbers
--     a hand-edited display_name/lifecycle/category/sort_order).
--   * every crop_type_slug UPDATE is guarded `AND crop_type_slug IS NULL` so a re-run NEVER
--     overwrites an existing or hand-corrected mapping. First-write-wins; genus pass runs before
--     name pass, and within each pass earlier (more specific) rules win because later rules are
--     also IS-NULL-guarded.
--   * lifecycle UPDATE is guarded `AND lifecycle IS NULL` (sets only un-set rows).
--   * all UPDATEs are scoped `AND deleted_at IS NULL` (live rows only).
--   * schema_version INSERT is ON CONFLICT (version) DO NOTHING.
--   Re-running the whole file is a clean no-op.
--
-- DRY-RUN: dry-run-validated on a throwaway COW branch off production br-delicate-sea-amum92c2
--   (see report). NOT applied to prod. NOT applied to staging. NOT committed.
--
-- ROLLBACK (no schema change to undo — data-only; to fully revert the backfill):
--   UPDATE public.plant_varieties SET crop_type_slug=NULL, lifecycle=NULL WHERE deleted_at IS NULL;
--   DELETE FROM public.crop_types;   -- only if reverting the vocabulary too (FK is ON DELETE SET NULL)
--   DELETE FROM public.schema_version WHERE version='4.1.1-planttype-seed-001';
--   (Caution: a blanket null-out also discards any manual hand-fixes; prefer targeted reverts.)

BEGIN;

-- ============================================================================
-- 1. crop_types vocabulary seed  (slug, display_name, default_lifecycle, category, sort_order)
--    Owner-decided. ON CONFLICT (slug) DO NOTHING — idempotent, never clobbers hand edits.
-- ============================================================================
INSERT INTO public.crop_types (slug, display_name, default_lifecycle, category, sort_order) VALUES
  ('pepper','Pepper','tender_perennial','vegetable',0),
  ('tomato','Tomato','tender_perennial','vegetable',0),
  ('tomatillo','Tomatillo','annual','vegetable',0),
  ('potato','Potato','annual','vegetable',0),
  ('sweet_potato','Sweet Potato','tender_perennial','vegetable',0),
  ('eggplant','Eggplant','tender_perennial','vegetable',0),
  ('cucumber','Cucumber','annual','vegetable',0),
  ('cucamelon','Cucamelon','annual','vegetable',0),
  ('squash','Squash','annual','vegetable',0),
  ('luffa','Luffa','annual','vegetable',0),
  ('bitter_melon','Bitter Melon','annual','vegetable',0),
  ('melon','Melon','annual','fruit',0),
  ('watermelon','Watermelon','annual','fruit',0),
  ('onion','Onion','biennial','vegetable',0),
  ('shallot','Shallot','perennial','vegetable',0),
  ('garlic','Garlic','perennial','vegetable',0),
  ('leek','Leek','biennial','vegetable',0),
  ('chives','Chives','perennial','herb',0),
  ('asparagus','Asparagus','perennial','vegetable',0),
  ('beet','Beet','biennial','vegetable',0),
  ('chard','Chard','biennial','vegetable',0),
  ('cabbage','Cabbage','biennial','vegetable',0),
  ('broccoli','Broccoli','biennial','vegetable',0),
  ('lettuce','Lettuce','annual','vegetable',0),
  ('endive','Endive','annual','vegetable',0),
  ('arugula','Arugula','annual','vegetable',0),
  ('spinach','Spinach','annual','vegetable',0),
  ('basil','Basil','annual','herb',0),
  ('oregano','Oregano','perennial','herb',0),
  ('mint','Mint','perennial','herb',0),
  ('parsley','Parsley','biennial','herb',0),
  ('dill','Dill','annual','herb',0),
  ('cilantro','Cilantro','annual','herb',0),
  ('culantro','Culantro','tender_perennial','herb',0),
  ('tarragon','Tarragon','perennial','herb',0),
  ('rosemary','Rosemary','tender_perennial','herb',0),
  ('sage','Sage','perennial','herb',0),
  ('lemongrass','Lemongrass','tender_perennial','herb',0),
  ('bee_balm','Bee Balm','perennial','herb',0),
  ('vietnamese_coriander','Vietnamese Coriander','tender_perennial','herb',0),
  ('strawberry','Strawberry','perennial','fruit',0),
  ('blueberry','Blueberry','perennial','fruit',0),
  ('black_raspberry','Black Raspberry','perennial','fruit',0),
  ('avocado','Avocado','perennial','fruit',0),
  ('peach','Peach','perennial','fruit',0),
  ('pineapple','Pineapple','perennial','fruit',0),
  ('marigold','Marigold','annual','flower',0),
  ('chrysanthemum','Chrysanthemum','perennial','flower',0),
  ('begonia','Begonia','tender_perennial','flower',0),
  ('geranium','Geranium','tender_perennial','flower',0),
  ('rose','Rose','perennial','flower',0),
  ('crown_of_thorns','Crown of Thorns','tender_perennial','flower',0),
  ('fittonia','Fittonia','tender_perennial','houseplant',0),
  ('pothos','Pothos','tender_perennial','houseplant',0),
  ('dracaena','Dracaena','tender_perennial','houseplant',0),
  ('echeveria','Echeveria','perennial','succulent',0),
  ('lithops','Lithops','perennial','succulent',0),
  ('jade','Jade','perennial','succulent',0),
  ('christmas_cactus','Christmas Cactus','perennial','houseplant',0),
  ('tradescantia','Tradescantia','tender_perennial','houseplant',0),
  ('hosta','Hosta','perennial','ornamental',0),
  ('japanese_maple','Japanese Maple','perennial','tree',0)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- 2. PASS 1 — backfill crop_type_slug by lower(genus)/lower(species).
--    A genus match wins. Every UPDATE is IS-NULL-guarded so order = priority and
--    a re-run never overwrites a prior/hand-corrected mapping.
--    More specific rules are placed before broader ones (e.g. allium aggregatum
--    before plain cepa; brassica italica before plain oleracea).
-- ============================================================================

-- Capsicum (any species) -> pepper
UPDATE public.plant_varieties SET crop_type_slug='pepper'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='capsicum';

-- Solanum split
UPDATE public.plant_varieties SET crop_type_slug='tomato'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='solanum' AND lower(species)='lycopersicum';
UPDATE public.plant_varieties SET crop_type_slug='potato'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='solanum' AND lower(species)='tuberosum';
UPDATE public.plant_varieties SET crop_type_slug='eggplant'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='solanum' AND lower(species)='melongena';

-- Physalis (any) -> tomatillo
UPDATE public.plant_varieties SET crop_type_slug='tomatillo'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='physalis';

-- Ipomoea batatas -> sweet_potato
UPDATE public.plant_varieties SET crop_type_slug='sweet_potato'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='ipomoea' AND lower(species)='batatas';

-- Cucurbits / melons
UPDATE public.plant_varieties SET crop_type_slug='cucumber'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='cucumis' AND lower(species)='sativus';
UPDATE public.plant_varieties SET crop_type_slug='melon'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='cucumis' AND lower(species) LIKE 'melo%';
UPDATE public.plant_varieties SET crop_type_slug='watermelon'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='citrullus' AND lower(species)='lanatus';
UPDATE public.plant_varieties SET crop_type_slug='cucamelon'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='melothria' AND lower(species)='scabra';
UPDATE public.plant_varieties SET crop_type_slug='squash'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='cucurbita' AND lower(species)='pepo';
UPDATE public.plant_varieties SET crop_type_slug='luffa'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='luffa';
UPDATE public.plant_varieties SET crop_type_slug='bitter_melon'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='momordica' AND lower(species)='charantia';

-- Allium (specific species first; bare allium with null/empty species LEFT NULL = ambiguous)
UPDATE public.plant_varieties SET crop_type_slug='garlic'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='allium' AND lower(species)='sativum';
UPDATE public.plant_varieties SET crop_type_slug='shallot'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='allium' AND lower(species) LIKE 'cepa var. aggregatum%';
UPDATE public.plant_varieties SET crop_type_slug='onion'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='allium' AND lower(species) LIKE 'cepa%';
UPDATE public.plant_varieties SET crop_type_slug='leek'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='allium' AND lower(species) LIKE 'ampeloprasum%';
UPDATE public.plant_varieties SET crop_type_slug='chives'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='allium' AND lower(species)='tuberosum';

-- Asparagus officinalis -> asparagus
UPDATE public.plant_varieties SET crop_type_slug='asparagus'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='asparagus' AND lower(species)='officinalis';

-- Beta vulgaris -> chard if name mentions chard else beet
UPDATE public.plant_varieties SET crop_type_slug='chard'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='beta' AND lower(species)='vulgaris' AND name ~* 'chard';
UPDATE public.plant_varieties SET crop_type_slug='beet'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='beta' AND lower(species)='vulgaris';

-- Brassica oleracea (italica -> broccoli, else cabbage)
UPDATE public.plant_varieties SET crop_type_slug='broccoli'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='brassica' AND lower(species) LIKE 'oleracea var. italica%';
UPDATE public.plant_varieties SET crop_type_slug='cabbage'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='brassica' AND lower(species) LIKE 'oleracea%';

-- Leafy
UPDATE public.plant_varieties SET crop_type_slug='lettuce'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='lactuca' AND lower(species)='sativa';
UPDATE public.plant_varieties SET crop_type_slug='endive'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='cichorium' AND lower(species)='endivia';
UPDATE public.plant_varieties SET crop_type_slug='arugula'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='eruca' AND lower(species)='sativa';

-- Herbs (genus-keyed)
UPDATE public.plant_varieties SET crop_type_slug='basil'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='ocimum';
UPDATE public.plant_varieties SET crop_type_slug='oregano'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='origanum';
UPDATE public.plant_varieties SET crop_type_slug='mint'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='mentha';
UPDATE public.plant_varieties SET crop_type_slug='parsley'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='petroselinum';
UPDATE public.plant_varieties SET crop_type_slug='dill'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='anethum';
UPDATE public.plant_varieties SET crop_type_slug='cilantro'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='coriandrum';
UPDATE public.plant_varieties SET crop_type_slug='culantro'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='eryngium' AND lower(species)='foetidum';
UPDATE public.plant_varieties SET crop_type_slug='tarragon'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='artemisia' AND lower(species) IN ('dracunculus','dracunculoides');
UPDATE public.plant_varieties SET crop_type_slug='lemongrass'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='cymbopogon';
UPDATE public.plant_varieties SET crop_type_slug='bee_balm'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='monarda';
UPDATE public.plant_varieties SET crop_type_slug='vietnamese_coriander'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='persicaria' AND lower(species)='odorata';

-- Berries / fruit
UPDATE public.plant_varieties SET crop_type_slug='strawberry'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='fragaria';
UPDATE public.plant_varieties SET crop_type_slug='blueberry'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='vaccinium';
UPDATE public.plant_varieties SET crop_type_slug='black_raspberry'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='rubus';
UPDATE public.plant_varieties SET crop_type_slug='avocado'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='persea' AND lower(species)='americana';

-- Flowers / ornamentals (genus-keyed)
UPDATE public.plant_varieties SET crop_type_slug='begonia'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='begonia';
UPDATE public.plant_varieties SET crop_type_slug='geranium'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='pelargonium';
UPDATE public.plant_varieties SET crop_type_slug='rose'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='rosa';
UPDATE public.plant_varieties SET crop_type_slug='chrysanthemum'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='chrysanthemum';
UPDATE public.plant_varieties SET crop_type_slug='crown_of_thorns'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='euphorbia' AND lower(species)='milii';

-- Houseplants / succulents (genus-keyed)
UPDATE public.plant_varieties SET crop_type_slug='fittonia'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='fittonia';
UPDATE public.plant_varieties SET crop_type_slug='dracaena'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='dracaena';
UPDATE public.plant_varieties SET crop_type_slug='echeveria'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='echeveria';
UPDATE public.plant_varieties SET crop_type_slug='lithops'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='lithops';
UPDATE public.plant_varieties SET crop_type_slug='pothos'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='epipremnum';
UPDATE public.plant_varieties SET crop_type_slug='christmas_cactus'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='schlumbergera';
UPDATE public.plant_varieties SET crop_type_slug='tradescantia'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND lower(genus)='tradescantia';

-- ============================================================================
-- 3. PASS 2 — name-substring fallback for rows with null/empty genus still NULL.
--    Priority order matters; each UPDATE remains IS-NULL-guarded.
-- ============================================================================

-- tomato first (catches 'Pineapple Tomato' before any pineapple/fruit rule)
UPDATE public.plant_varieties SET crop_type_slug='tomato'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name ~* 'tomato';

-- spinach
UPDATE public.plant_varieties SET crop_type_slug='spinach'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name ~* 'spinach';

-- lettuce family
UPDATE public.plant_varieties SET crop_type_slug='lettuce'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL
    AND (name ~* 'romaine|leaf lettuce|mixed lettuce|red leaf' OR name ~* 'lettuce');

-- cabbage
UPDATE public.plant_varieties SET crop_type_slug='cabbage'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name ~* 'cabbage';

-- herbs / flowers / misc by name
UPDATE public.plant_varieties SET crop_type_slug='sage'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name ~* 'sage';
UPDATE public.plant_varieties SET crop_type_slug='rosemary'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name ~* 'rosemary';
UPDATE public.plant_varieties SET crop_type_slug='marigold'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name ~* 'marigold';
UPDATE public.plant_varieties SET crop_type_slug='geranium'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name ~* 'geranium';
UPDATE public.plant_varieties SET crop_type_slug='jade'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name='Crassula ovata';
UPDATE public.plant_varieties SET crop_type_slug='hosta'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name ~* 'hosta';
UPDATE public.plant_varieties SET crop_type_slug='japanese_maple'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name ~* 'japanese maple';
UPDATE public.plant_varieties SET crop_type_slug='peach'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name='Peach';
UPDATE public.plant_varieties SET crop_type_slug='pineapple'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL AND name='Pineapple';

-- pepper by common heat-name (catches 'Chili Red','Rista Cayanne II')
UPDATE public.plant_varieties SET crop_type_slug='pepper'
  WHERE deleted_at IS NULL AND crop_type_slug IS NULL
    AND name ~* 'cayenne|chili|chile|jalapeno|habanero|serrano|cayanne';

-- Rows STILL NULL after both passes are AMBIGUOUS by design — left NULL for owner review.

-- ============================================================================
-- 4. lifecycle backfill from crop default (only where unset)
-- ============================================================================
UPDATE public.plant_varieties pv
   SET lifecycle = ct.default_lifecycle
  FROM public.crop_types ct
 WHERE pv.crop_type_slug = ct.slug
   AND pv.deleted_at IS NULL
   AND pv.lifecycle IS NULL;

-- ============================================================================
-- 5. schema_version
-- ============================================================================
INSERT INTO public.schema_version (version, description)
VALUES ('4.1.1-planttype-seed-001','PLANTTYPE data backfill: seed crop_types vocab + map live plant_varieties crop_type_slug (genus/species then name) + lifecycle from crop default; ambiguous rows left NULL')
ON CONFLICT (version) DO NOTHING;

COMMIT;
