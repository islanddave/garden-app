-- 0a-additive-ddl.sql
-- schema_version: 5.0.0-pantryitemamount-001
--
-- V5-PUTUPLOGRETIRE-001 R2a, B1 (absorbs V5-PANTRYITEMWHEREFROM-001) — an "As is" / "Fresh, as picked"
--   Pantry item gains an amount and where it came from. One file, one transaction, the stamp written
--   inside it. The line above is machine-read by the train step in
--   .github/workflows/integration-test.yml; keep it the second line and equal to the INSERT at the bottom.
--
-- THE STAMP IS FIXED: '5.0.0-pantryitemamount-001'. Never edit it after the first apply anywhere: every
--   standing gate in gates.yml self-arms on it.
--
-- APPLIES ON TOP OF v5-pantry-001 ('5.0.0-pantry-001', the migration that created pantry_item); the guard
--   below refuses otherwise.
--
-- WHAT IT ADDS — four nullable columns on pantry_item, no default, and nine CHECKs:
--   quantity_value numeric(10,2), quantity_unit text    the amount AS LOGGED. Not stock: pantry_item has no
--                                                       count and no remaining, nothing decrements this pair,
--                                                       and no pantry_use row can name an item.
--   source_kind text, source_label text                 where it came from, the put-up's eight words.
--
-- THE AMOUNT IS NOT A COUNT. preservation_log stores a total (quantity_value) beside package_count and a
--   derived remaining_amount; pantry_item stores none of those and this file adds none. The only "use" an
--   item has is used_up_at (the whole thing). A reader must never present this pair as what is left.
--
-- UNITS: the 25 KITCHEN_UNITS (lambda/preservation/kitchenBatch.js), the list chk_kbi_qty_unit,
--   chk_ksl_amount_unit, chk_kitchen_batch_vessel_unit, chk_recipe_*_unit and chk_ri_qty_unit carry.
--   NOT preservation_log's 35-value union: its ten plurals exist only because rows written by the shipped
--   picker hold them, and this table has no such rows and no such writer.
--
-- THREE-VALUED LOGIC, stated per CHECK (a CHECK passes on NULL, so each is written to be two-valued
--   wherever a value is present; "all four NULL" is the deployed writer's row and passes every one):
--   quantity_pairing   (a IS NULL) = (b IS NULL)        both sides are never NULL. All-NULL row: TRUE.
--   quantity_value     v IS NULL OR (v > 0 AND v <> 'NaN')   NULL: TRUE by the first arm. numeric NaN sorts above
--                                                       every number, so `v > 0` alone ADMITS it (measured).
--   quantity_unit      u IS NULL OR u IN (...)          NULL: TRUE by the first arm; the list holds no NULL.
--   source_kind        k IS NULL OR k IN (...)          NULL: TRUE by the first arm.
--   source_label_len / _nonblank                        NULL: TRUE by the first arm.
--   source_label_kind  l IS NULL OR k IS NOT NULL       two-valued. All-NULL row: TRUE.
--   source_other       k IS DISTINCT FROM 'other' OR COALESCE(btrim(l), '') <> ''
--                                                       two-valued. NULL kind: TRUE (it is distinct from
--                                                       'other'). 'other' with a NULL label: FALSE, refused.
--   source_plant       k IS NULL OR k = 'own_garden' OR plant_id IS NULL
--                                                       NULL kind: TRUE by the first arm, so the second arm
--                                                       is only ever read with a value in it.
--
-- chk_pantry_item_source_plant NAMES plant_id, WHICH IS AN EXISTING COLUMN AND AN ON DELETE SET NULL FK.
--   Safe on both counts: (1) every row the deployed code writes or has written has source_kind NULL, so
--   the first arm passes whatever plant_id holds (createItem's INSERT and merge.js's repoint are the only
--   writers of plant_id); (2) the SET NULL action can only make the third arm TRUE. The definition has no
--   `IS NOT NULL) OR` arm, so v4-evtanchordel-001 post_no_setnull_fk_inside_an_anchor_check stays green.
--   Never rewrite it with a `(plant_id IS NOT NULL) OR ...` arm: that is the anchor-check shape the gate hunts.
--
-- WHY THE DEPLOYED WRITER IS UNAFFECTED (the house rule; asked of prod's artifact, v4.169.0). The three
--   statements that write pantry_item — pantryRoutes.js createItem INSERT, patchItem UPDATE, deleteItem
--   UPDATE — and lambda/plants/merge.js's repoint name their columns and none names these four, so every
--   row they produce carries NULL in all four and passes all nine CHECKs. Every CHECK is created
--   VALIDATED (no NOT VALID step): the four columns are born NULL on every existing row.
--
-- NOT AUDITED: pantry_item stays unaudited (v5-pantry-001 post_pantry_item_not_audited). No trigger here.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; every CHECK is DROP IF EXISTS + ADD in one statement; the stamp
--   ON CONFLICT DO NOTHING.
--
-- ⚠ Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a shared
--   database: its own COMMIT ends your transaction. Rehearse on local PG 17 (README.md).
--
-- ROLLBACK: 0r-rollback.sql — guarded; refuses once any item carries an amount or a source.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Guard: pantry_item exists (v5-pantry-001 is applied). ──────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-pantry-001') THEN
    RAISE EXCEPTION 'v5-pantryitemamount-001 0a refused: v5-pantry-001 (5.0.0-pantry-001) is not applied here. This file alters pantry_item.';
  END IF;
END $$;

-- ── 1. The four columns: nullable, no default. ────────────────────────────────────────────────────
ALTER TABLE public.pantry_item
  ADD COLUMN IF NOT EXISTS quantity_value numeric(10,2),
  ADD COLUMN IF NOT EXISTS quantity_unit  text,
  ADD COLUMN IF NOT EXISTS source_kind    text,
  ADD COLUMN IF NOT EXISTS source_label   text;

-- ── 2. The CHECKs, each created VALIDATED. ────────────────────────────────────────────────────────
ALTER TABLE public.pantry_item
  DROP CONSTRAINT IF EXISTS chk_pantry_item_quantity_pairing,
  ADD CONSTRAINT chk_pantry_item_quantity_pairing
    CHECK ((quantity_value IS NULL) = (quantity_unit IS NULL)),
  DROP CONSTRAINT IF EXISTS chk_pantry_item_quantity_value,
  ADD CONSTRAINT chk_pantry_item_quantity_value
    CHECK (quantity_value IS NULL OR (quantity_value > 0 AND quantity_value <> 'NaN')),
  DROP CONSTRAINT IF EXISTS chk_pantry_item_quantity_unit,
  ADD CONSTRAINT chk_pantry_item_quantity_unit
    CHECK (quantity_unit IS NULL
           OR quantity_unit IN ('g','kg','oz','lb','ml','l','tsp','tbsp','fl oz','cup','pint','qt','gal',
                                'count','clove','head','bunch','pinch','peck','bushel','half-bushel','flat',
                                'jar','bag','other')),
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_kind,
  ADD CONSTRAINT chk_pantry_item_source_kind
    CHECK (source_kind IS NULL OR source_kind IN (
        'own_garden','u_pick','farm_stand','csa','store','gift','foraged','other'
      )),
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_label_nonblank,
  ADD CONSTRAINT chk_pantry_item_source_label_nonblank
    CHECK (source_label IS NULL OR btrim(source_label) <> ''),
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_label_len,
  ADD CONSTRAINT chk_pantry_item_source_label_len
    CHECK (source_label IS NULL OR char_length(source_label) <= 120),
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_label_kind,
  ADD CONSTRAINT chk_pantry_item_source_label_kind
    CHECK (source_label IS NULL OR source_kind IS NOT NULL),
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_other,
  ADD CONSTRAINT chk_pantry_item_source_other
    CHECK (source_kind IS DISTINCT FROM 'other' OR COALESCE(btrim(source_label), '') <> ''),
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_plant,
  ADD CONSTRAINT chk_pantry_item_source_plant
    CHECK (source_kind IS NULL OR source_kind = 'own_garden' OR plant_id IS NULL);

-- ── 3. The stamp, in the same transaction as everything above. ───────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-pantryitemamount-001',
        'V5-PUTUPLOGRETIRE-001 R2a B1 (absorbs V5-PANTRYITEMWHEREFROM-001): pantry_item gains '
        'quantity_value numeric(10,2), quantity_unit, source_kind, source_label (nullable, no default) '
        'with nine validated CHECKs: the pairing, value > 0, the 25 kitchen units (no plurals), the eight '
        'source words, label nonblank / <= 120 / needs a kind, other needs a label, a non-garden source '
        'forbids a planting. The amount is as logged, never stock. No trigger, no FK, no index.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
