-- 0a-additive-ddl.sql
-- schema_version: 5.0.0-pantry-001
--
-- V5-PANTRY-001 — Put-Up release 2 (the Pantry), the database half, as B′ carries it. One file, one
--   transaction, the stamp written inside it. Plan: project-state/_crucible-pantry-20260928/
--   04-design-final.md (V4) §2.5 and §4.3, amended by 05-release-train.md §6/§6a and shrunk by
--   06-ferment-path.md §1.3: release F already created pantry_use, preservation_log.delta_at and
--   remaining_amount, so THIS FILE CREATES NONE OF THEM. The line above is machine-read by the train
--   step in .github/workflows/integration-test.yml; keep it the second line and equal to the INSERT at
--   the bottom.
--
-- THE STAMP IS FIXED: '5.0.0-pantry-001'. Never edit it after the first apply anywhere: every standing
--   gate in gates.yml self-arms on it.
--
-- APPLIES ON TOP OF F ONLY. v5-fermentpath-001 (stamp '5.0.0-fermentpath-001') must already be applied;
--   the guard below refuses otherwise.
--
-- WHAT IT ADDS
--   * pantry_item (new): the Pantry's bought things ("As is") and fresh-as-picked produce (V4 §2.5
--     "Bought items"). Typed-only discard date, no counts, soft delete, a global unique partial
--     idempotency key (V4 §5.2), set_updated_at, and the user_id ownership guard.
--   * kitchen_batch_input.pantry_item_id: a batch line that names a pantry item, FK NO ACTION, with
--     chk_kbi_pantry_item_kind (a line naming an item is a 'pantry' line).
--   * Nothing for pantry_use.fate: F's chk_pantry_use_fate already admits 'discarded' and 'given_away'
--     (v5-fermentpath-001 0a §5), which is all "Went bad" and "Gave it away" need.
--
-- EVERY NEW FOREIGN KEY STATES ITS ON DELETE (05 §6):
--   pantry_item.storage_location_id -> storage_location   NO ACTION (a place is soft-deleted; nothing
--                                                          hard-deletes one under a live item)
--   pantry_item.plant_id            -> plants             SET NULL  (V4 §4.3; the put-up precedent: a
--                                                          bought or picked thing outlives its planting
--                                                          record. merge.js repoints it; no CHECK names it)
--   pantry_item.crop_type_slug      -> crop_types         NO ACTION (the preservation_log / kbi precedent)
--   kitchen_batch_input.pantry_item_id -> pantry_item     NO ACTION (V4 §4.3; soft deletes only — no
--                                                          CASCADE onto a soft-deletable table)
--   No new FK CASCADEs (v4-cascadesweep-001 post_no_cascade_onto_a_soft_deletable_table) and no CHECK
--   names a SET NULL column (v4-evtanchordel-001 post_no_setnull_fk_inside_an_anchor_check).
--
-- OWNERSHIP (05 §6: name the function per new table). pantry_item's owner column is user_id, so its guard
--   is the user_id variant, public.prevent_kitchen_batch_ownership_transfer() — reused unchanged, the
--   same function 1b attached to preservation_log. NOT public.prevent_ownership_transfer(), which reads
--   OLD.created_by and would raise 42703 on every UPDATE here (BUG-KBOWNERTRIGGER-001). gates.yml
--   post_pantry_item_ownership_trigger_names_real_columns proves the attached function names only
--   pantry_item columns, continuously.
--
-- NOT AUDITED (V4 §5.5: "pantry_item stays unaudited — typed-only dates, no counts"). No audit trigger.
--   kitchen_batch_input's audit trigger (F) is untouched: its watch list does not gain pantry_item_id,
--   and F's identity trigger is untouched (post_identity_fn_kbi_names_its_columns pins its list); a
--   line's pantry_item_id is written only by the line INSERT.
--
-- WHY THE DEPLOYED WRITER IS UNAFFECTED (the house rule). A new table no deployed code names; one new
--   nullable column on kitchen_batch_input with no default, whose only CHECK passes on NULL; nothing
--   relaxed, nothing tightened, no view touched (v_kitchen_batch_current reads kitchen_batch only).
--   Every CHECK is created VALIDATED.
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS; ADD COLUMN IF NOT EXISTS; every CHECK and FK is DROP IF
--   EXISTS + ADD in one statement; triggers DROP IF EXISTS + CREATE; the stamp ON CONFLICT DO NOTHING.
--
-- ⚠ Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a shared
--   database: its own COMMIT ends your transaction. Rehearse on local PG 17 (README.md).
--
-- ROLLBACK: 0r-rollback.sql — guarded; refuses once a pantry item or a pantry line exists.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Guard: F is applied. ──────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-fermentpath-001') THEN
    RAISE EXCEPTION 'v5-pantry-001 0a refused: v5-fermentpath-001 (5.0.0-fermentpath-001) is not applied here. Release 2 applies on top of F only.';
  END IF;
END $$;

-- ── 1. pantry_item (new) ─────────────────────────────────────────────────────────────────────────
-- V4 §4.3. acquired_precision is the one §3.6 vocabulary; acquired_at is NULL when the date is not
-- known (precision NULL or 'unknown'), and a known date always carries its precision. use_by_target is
-- typed only (the route never derives one). used_up_at is "Used it up" (Undo clears it).
CREATE TABLE IF NOT EXISTS public.pantry_item (
  id                  uuid        DEFAULT gen_random_uuid() NOT NULL,
  user_id             text        NOT NULL,
  name                text        NOT NULL,
  storage_location_id uuid        NOT NULL,
  acquired_at         date,
  acquired_precision  text,
  use_by_target       date,
  plant_id            uuid,
  crop_type_slug      text,
  used_up_at          timestamptz,
  notes               text,
  idempotency_key     uuid,
  created_at          timestamptz DEFAULT now() NOT NULL,
  updated_at          timestamptz DEFAULT now() NOT NULL,
  deleted_at          timestamptz,
  CONSTRAINT pantry_item_pkey PRIMARY KEY (id)
);

ALTER TABLE public.pantry_item
  DROP CONSTRAINT IF EXISTS chk_pantry_item_name_nonblank,
  ADD CONSTRAINT chk_pantry_item_name_nonblank
    CHECK (btrim(name) <> '' AND char_length(name) <= 120),
  DROP CONSTRAINT IF EXISTS chk_pantry_item_acquired_precision,
  ADD CONSTRAINT chk_pantry_item_acquired_precision
    CHECK (acquired_precision IS NULL
           OR acquired_precision IN ('exact','hour','day','week','month','season','year','after','unknown')),
  DROP CONSTRAINT IF EXISTS chk_pantry_item_acquired_pairing,
  ADD CONSTRAINT chk_pantry_item_acquired_pairing
    CHECK ((acquired_at IS NULL) = (acquired_precision IS NULL OR acquired_precision = 'unknown')),
  DROP CONSTRAINT IF EXISTS pantry_item_storage_location_id_fkey,
  ADD CONSTRAINT pantry_item_storage_location_id_fkey
    FOREIGN KEY (storage_location_id) REFERENCES public.storage_location (id) ON DELETE NO ACTION,
  DROP CONSTRAINT IF EXISTS pantry_item_plant_id_fkey,
  ADD CONSTRAINT pantry_item_plant_id_fkey
    FOREIGN KEY (plant_id) REFERENCES public.plants (id) ON DELETE SET NULL,
  DROP CONSTRAINT IF EXISTS pantry_item_crop_type_slug_fkey,
  ADD CONSTRAINT pantry_item_crop_type_slug_fkey
    FOREIGN KEY (crop_type_slug) REFERENCES public.crop_types (slug) ON DELETE NO ACTION;

-- Global, partial: a 23505 on THIS name is a replay (V4 §5.2). Every read of a key is owner-scoped.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pantry_item_idempotency_key
  ON public.pantry_item (idempotency_key) WHERE idempotency_key IS NOT NULL;
-- The Pantry list reads the household's live items.
CREATE INDEX IF NOT EXISTS idx_pantry_item_user_live
  ON public.pantry_item (user_id) WHERE deleted_at IS NULL;
-- The planting merge's snapshot/repoint and the SET NULL RI action look items up by planting.
CREATE INDEX IF NOT EXISTS idx_pantry_item_plant
  ON public.pantry_item (plant_id) WHERE plant_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON public.pantry_item;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.pantry_item
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The user_id variant, reused unchanged (see the header). Sorts before set_updated_at ('p' < 's').
DROP TRIGGER IF EXISTS prevent_pantry_item_ownership_transfer ON public.pantry_item;
CREATE TRIGGER prevent_pantry_item_ownership_transfer BEFORE UPDATE ON public.pantry_item
  FOR EACH ROW EXECUTE FUNCTION public.prevent_kitchen_batch_ownership_transfer();

-- ── 2. kitchen_batch_input.pantry_item_id ────────────────────────────────────────────────────────
-- A line that names a pantry item (V4 §4.3). A legacy 'pantry' line with no item stays legal and reads
-- as "just a name" (V4 §4.2), so the CHECK is one-directional. No stock moves: a bought item has no
-- counts.
ALTER TABLE public.kitchen_batch_input
  ADD COLUMN IF NOT EXISTS pantry_item_id uuid;

ALTER TABLE public.kitchen_batch_input
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_pantry_item_id_fkey,
  ADD CONSTRAINT kitchen_batch_input_pantry_item_id_fkey
    FOREIGN KEY (pantry_item_id) REFERENCES public.pantry_item (id) ON DELETE NO ACTION,
  DROP CONSTRAINT IF EXISTS chk_kbi_pantry_item_kind,
  ADD CONSTRAINT chk_kbi_pantry_item_kind
    CHECK (pantry_item_id IS NULL OR input_kind = 'pantry');

CREATE INDEX IF NOT EXISTS idx_kbi_pantry_item
  ON public.kitchen_batch_input (pantry_item_id) WHERE pantry_item_id IS NOT NULL;

-- ── 3. The stamp, in the same transaction as everything above. ───────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-pantry-001',
        'V5-PANTRY-001 (Put-Up release 2, the Pantry, as carried by B′): new pantry_item (typed-only '
        'discard date, soft delete, global partial idempotency key, set_updated_at, user_id ownership '
        'guard via prevent_kitchen_batch_ownership_transfer; FKs storage_location NO ACTION, plants SET '
        'NULL, crop_types NO ACTION); kitchen_batch_input gains pantry_item_id (FK NO ACTION) with '
        'chk_kbi_pantry_item_kind. No pantry_use / delta_at / remaining_amount (F created them).')
ON CONFLICT (version) DO NOTHING;

COMMIT;
