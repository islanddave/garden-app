-- v5-seedqty-001 / 0a-additive-ddl.sql
-- V5-SEEDQTY-001 (closes BUG-SEEDQTYUNIT-001) — a seed lot records HOW MANY SEEDS and HOW MUCH THEY
-- WEIGH, separately from how many packets are on the shelf.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE BUG. Three saved-seed lots on prod read `185.000 packet`, `175.000 packet`, `121.000 packet`.
-- Those are SEED COUNTS wearing the packet unit; nobody has 185 packets of home-saved tomato seed.
-- Both live CHECKs pass (consumable_requires_unit, consumable_requires_quantity_on_hand) because
-- neither asserts the unit is TRUE — a schema-enforcement-boundary gap. Two writers produce it:
-- SaveSeedSheet.jsx:376,383 creates with a literal unit:'packet' and the count in quantity_on_hand,
-- and SavedSeeds.jsx countPayloadFrom PUTs the count into quantity_on_hand while LIST_ROW_PUT_STRIP
-- does not strip `unit`, so the row keeps the unit it was born with.
--
-- Dave's ruling (2026-09-04): a packet can carry a seed COUNT and a WEIGHT at the same time, because
-- some packets state a count and some state grams or mg. So this is columns, not a wider vocabulary.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS DELIBERATELY DOES **NOT** DO — no change to inventory_items_unit_check.
--
-- The first draft widened the unit vocabulary with 'seeds'/'g'/'mg' as well. Both review seats
-- rejected it independently and they are right: with seed_count and seed_weight_g in place, the
-- widening makes TWO rows legal for one jar —
--     quantity_on_hand=1,   unit='packet', seed_count=185
--     quantity_on_hand=185, unit='seeds',  seed_count=NULL
-- with nothing constraining them to agree and nothing marking either authoritative. Every reader
-- (sowEngine.isDepleted, the quantity bands, v_sow_candidates) would branch on both forever. It also
-- buys nothing: counts are covered by seed_count, weights by seed_weight_g, and weight-sold rows can
-- already be expressed — prod has Pinto Beans (Quincy) at unit='oz'. Only METRIC mass was missing,
-- and that need dies with this column.
--
-- Keeping the CHECK untouched also means none of the FOUR places the unit vocabulary is spelled has
-- to move: this constraint, lambda/inventory-items/index.js:70 VALID_UNITS, and BOTH
-- src/lib/inventoryEnums.js:53 INVENTORY_UNITS and :65 INVENTORY_CHECK_SETS.unit. Worth knowing that
-- the only test guarding them (src/__tests__/inventoryEnums.test.js:26) compares :53 against :65 —
-- two constants in ONE file — so it proves a file agrees with itself and can see neither the Lambda
-- list nor the database. Not fixed here; recorded so nobody trusts it.
--
-- Dave's word "seeds" is not lost. It is the UI LABEL, where he actually reads it. It is `count` in
-- the column name, matching harvest_log_unit_check and chk_kbi_qty_unit which both already use
-- 'count' for this concept, and matching the singular-token convention v5-preservunit-001 exists to
-- protect.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- GRAMS, NOT MILLIGRAMS. The first draft said mg "is comfortably inside integer range with no float
-- error". That is self-refuting against the proposed type: numeric is exact arbitrary-precision
-- decimal, so 0.5 g has no float error at any scale — the argument would only apply to double
-- precision, which nobody proposed. Meanwhile `grep -rn "_mg\b|milligram" src/ lambda/ migrations/`
-- returns ZERO hits and grams is canonical throughout: harvest_log.weight_grams,
-- crop_types.grams_per_unit, cultivar_weight_sample.total_grams, harvest-constants.js toGrams,
-- cal1Weights.js. mg would make every future join to a gram column need a ×1000 that no constraint
-- enforces — the silent 1000× class, in a codebase whose own doctrine (cal1Weights.js:8-12) is
-- "NEVER emit a guessed conversion factor". numeric(10,3) resolves to 1 mg; packets run 0.1–30 g.
--
-- WHY seed_count_estimated SHIPS NOW rather than later. A vendor's "approx. 200 seeds" and Dave's
-- hand-counted 185 are not the same fact, and with one undifferentiated column every downstream
-- total launders a guess. harvest_log carries exactly this pair (weight_estimated + weight_basis
-- beside weight_grams, bound by chk_harvest_log_weight_pairing) and the reason is written down at
-- src/lib/harvestWeight.js:43-48: "labelling a real measurement as an estimate is a harmless
-- understatement; the reverse launders a guess." That column was added a version AFTER weight_grams
-- (migrations/v4-harvbasis-sample-001/) — this repo has already paid the retrofit bill once.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- PHASE DISCIPLINE. Everything in this file is VACUOUS under the currently-deployed writer, which is
-- what makes it safe to apply before the code ships. Verified rather than assumed: the Lambda uses
-- explicit column lists in both INSERT INTO inventory_items (...) (index.js:1175-1190) and
-- UPDATE inventory_items SET ... (index.js:881-896) — no dynamic column construction — so the
-- deployed writer cannot emit these columns, they stay NULL, and every CHECK below passes on NULL.
-- The falsifiable test from the deploy rules (would the CURRENTLY DEPLOYED code produce a row that
-- violates this?) answers NO for all four.
--
-- The pairing CHECK ((seed_count IS NULL) = (seed_count_estimated IS NULL)) is NOT vacuous once the
-- new code starts writing seed_count, so it is NOT here — it is in 0b, armed after the writing
-- release is live. That is the 2026-08-03 lesson (arming a CHECK over a column only the NEW writer
-- sets breaks every write from the still-deployed OLD code) applied in the safe direction.
--
-- v_sow_candidates IS RECREATED HERE AND THAT IS A DELIVERABLE, NOT A TIDY-UP. The view enumerates
-- its 37 columns explicitly (no SELECT *), so Postgres froze that list at CREATE VIEW and ADD COLUMN
-- does NOT propagate. lambda/inventory-items/index.js:330 does `SELECT * FROM v_sow_candidates`, so
-- without this the sow surface would read quantity_on_hand=1 after the backfill with no path to the
-- real count. CREATE OR REPLACE cannot insert columns mid-list, so the three are APPENDED.

BEGIN;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS seed_count           integer       NULL,
  ADD COLUMN IF NOT EXISTS seed_weight_g        numeric(10,3) NULL,
  ADD COLUMN IF NOT EXISTS seed_count_estimated boolean       NULL;

COMMENT ON COLUMN public.inventory_items.seed_count IS
  'Number of seeds in this lot. NULL = nobody has counted. 0 is a MEASURED fact (an empty packet '
  'kept for its label), which is why the domain is >= 0 and not > 0. Pairs with '
  'seed_count_estimated: true = a vendor packet figure, false = someone counted them.';
COMMENT ON COLUMN public.inventory_items.seed_weight_g IS
  'Weight of seed in this lot, GRAMS (numeric(10,3) resolves to 1 mg). Canonical scale, matching '
  'harvest_log.weight_grams and every gram helper in src/lib. The typed unit the user entered is '
  'deliberately NOT retained -- same tradeoff harvest_log makes via toGrams(). 0 is legal: '
  '"weighed it, it is empty" must be expressible and distinct from NULL "never weighed".';
COMMENT ON COLUMN public.inventory_items.seed_count_estimated IS
  'TRUE = seed_count came from a vendor packet claim ("approx. 200 seeds"). FALSE = counted. NULL '
  'only while seed_count is NULL -- the pairing is armed as a CHECK in 0b, after the writer ships.';

-- Seeds-only, ONE CHECK PER COLUMN so a violation names which column caused it. This is the house
-- pattern on this table: chk_inventory_source_kind_seeds_only and
-- chk_inventory_source_plant_seeds_only are both spelled NULL-first, per column.
--
-- `AND type = 'consumable'` is load-bearing, not belt-and-braces. There is NO constraint on this
-- table binding category to type (verified: zero constraints whose definition mentions both), so a
-- category='seeds', type='durable' row is legal today. consumable_fields_null_for_durables would
-- force ITS unit and quantity_on_hand NULL while these three columns stayed writable -- a seed lot
-- with a count and no container unit. All 316 live seed rows are consumable, so this is satisfied.
ALTER TABLE public.inventory_items
  ADD CONSTRAINT chk_inventory_seed_count_seeds_only
    CHECK (seed_count IS NULL OR (category = 'seeds' AND type = 'consumable')),
  ADD CONSTRAINT chk_inventory_seed_weight_seeds_only
    CHECK (seed_weight_g IS NULL OR (category = 'seeds' AND type = 'consumable')),
  ADD CONSTRAINT chk_inventory_seed_count_nonneg
    CHECK (seed_count IS NULL OR seed_count >= 0),
  ADD CONSTRAINT chk_inventory_seed_weight_nonneg
    CHECK (seed_weight_g IS NULL OR seed_weight_g >= 0);

-- The DELIBERATE ASYMMETRY, stated because an implementer reading quickly will make both the same:
-- both are >= 0, NOT one > 0. These are stock levels that reach zero on depletion (prod already has
-- seed rows at quantity_on_hand 0.000). Under > 0, "I weighed it and it is empty" would be
-- inexpressible except as NULL, colliding with "never weighed" and destroying the whole point of
-- seed_count_estimated. chk_kbi_qty_positive uses > 0 because a kitchen-batch INPUT of zero is
-- meaningless; this is stock, and harvest_log's weight CHECK is >= 0.

CREATE OR REPLACE VIEW public.v_sow_candidates AS
 SELECT i.id AS inventory_item_id,
    i.name AS item_name,
    i.quantity_on_hand,
    i.unit,
    i.created_by,
    i.purchase_date,
    i.source,
    i.metadata,
    v.id AS variety_id,
    v.name AS variety_name,
    v.crop_type_slug,
    v.lifecycle,
    v.grown_as,
    v.sun_requirements,
    v.days_to_maturity_min,
    v.days_to_maturity_max,
    v.start_method,
    v.start_indoor_weeks_min,
    v.start_indoor_weeks_max,
    v.direct_sow_timing,
    v.sow_depth_in,
    v.seed_spacing_in,
    v.row_spacing_in,
    v.days_to_germ_min,
    v.days_to_germ_max,
    v.sow_season,
    v.sow_notes,
    v.growth_habit,
    v.day_length_response,
    ct.first_year_harvest,
    COALESCE(v.dtm_basis, ct.dtm_basis) AS dtm_basis,
    i.sow_archived_season,
    i.sow_archived_at,
    i.seed_stage,
    i.seed_process,
    i.source_plant_id,
    i.source_kind,
    -- APPENDED, in this order, and never inserted mid-list: CREATE OR REPLACE VIEW cannot renumber
    -- existing columns, and lambda/inventory-items/index.js:330 SELECT *s this view.
    i.seed_count,
    i.seed_weight_g,
    i.seed_count_estimated
   FROM inventory_items i
     JOIN plant_varieties v ON v.id = i.variety_id
     LEFT JOIN crop_types ct ON ct.slug = v.crop_type_slug
  WHERE i.category = 'seeds'::text AND i.deleted_at IS NULL AND i.status = 'active'::text
    AND v.deleted_at IS NULL;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-seedqty-001',
        'SEEDQTY phase 0a: V5-SEEDQTY-001 additive. inventory_items gains seed_count (integer), '
        'seed_weight_g (numeric(10,3), grams), seed_count_estimated (boolean), each seeds-only and '
        'consumable-only by its own CHECK, both quantities >= 0. v_sow_candidates recreated with '
        'the three columns APPENDED (it enumerates columns, so ADD COLUMN does not reach it, and '
        'the Lambda SELECT *s it). NO change to inventory_items_unit_check -- deliberately, see the '
        'file header: widening it would make two encodings of one jar legal. All of this is vacuous '
        'under the deployed writer (explicit column lists in both INSERT and UPDATE), so it is safe '
        'ahead of the code. The seed_count/seed_count_estimated pairing CHECK is NOT here -- it is '
        'not vacuous once the new writer runs, so it is armed in 0b after that release is live.',
        now())
ON CONFLICT (version) DO NOTHING;

COMMIT;
