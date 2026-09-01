-- V4-SEEDSAVEFLOW-001 (BD-071) slice 1 — the seed-saving process-stage substrate.
--
-- WHY THIS EXISTS. There is no seed-saving flow in the app. `seed_saved` is a valid event type with
-- a label and an icon, but it is NOT in PRIMARY_EVENT_TYPES, so the only way to reach it is the
-- collapsed "More" disclosure in the event-type picker, filed under the category "Harvest". Dave
-- could not find it, which is the expected outcome of that placement. Measured on prod 2026-09-01:
-- ZERO seed_saved events have ever been logged, for any crop, ever — alongside zero cloves_saved
-- and zero cured. A capability nobody has used once in the life of the app is not a feature.
--
-- Design: _voiceclose_20260831/design-seedsave.md §5 "SMALLEST FIRST SLICE", re-verified against
-- live prod 2026-09-01 before writing this (columns absent, table absent, the 1884 planting and
-- variety both still live and unchanged).
--
-- ADDITIVE AND EXPAND-ONLY. Two nullable columns and one new child table. Nothing existing is
-- altered, no view is widened, and `status` is deliberately untouched — the saved-seeds surface
-- reads inventory_items directly, so v_sow_candidates needs no change and sowability cannot regress.
--
-- THREE STAGES, NOT FOUR (design Q1). Dave listed "fermenting, drying, dehydrating, stored" and also
-- asked for fewer stages. Dehydrating is modelled as a WAY OF DRYING rather than a stage of its own,
-- noted on the log entry, because a dehydrator run and a screen-drying run answer the same question
-- ("is it dry yet?") and splitting them doubles the vocabulary for no decision either one changes.
-- This is a recommendation taken, not a ruling Dave gave — if he wants dehydrating visible as its
-- own row, it becomes a fourth value and the CHECK below is the one place to change.
--
-- CHECK IS ADDED VALID, NOT `NOT VALID`, AND THAT IS SAFE HERE — the exception to the house
-- NOT-VALID-then-VALIDATE pattern (L-058), stated rather than skipped. That pattern exists because
-- VALIDATE scans existing rows and can break a still-deployed old writer that emits values the new
-- constraint forbids. Neither hazard applies to a column CREATED IN THIS STATEMENT: every existing
-- row gets NULL (which the CHECK admits), and no deployed code can write to a column that did not
-- exist a moment ago. Adding it valid avoids leaving an unvalidated constraint behind for someone to
-- arm later, which is its own trap.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-ddl.sql

BEGIN;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS seed_process text,
  ADD COLUMN IF NOT EXISTS seed_stage   text;

-- Guarded so a re-run does not error on an existing constraint (ADD CONSTRAINT has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_seed_process_check') THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT inventory_items_seed_process_check
      CHECK (seed_process IS NULL OR seed_process IN ('wet', 'dry'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_seed_stage_check') THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT inventory_items_seed_stage_check
      CHECK (seed_stage IS NULL OR seed_stage IN ('fermenting', 'drying', 'stored'));
  END IF;
END
$$;

-- The stage history. A lot's CURRENT stage lives denormalised on inventory_items.seed_stage (one
-- read for the list view); this table is the audit trail of how it got there, which is the half Dave
-- actually asked for — "when did I set it out to dry" is the question a seed saver asks in March.
--
-- RLS DELIBERATELY OFF, matching preservation_log — the closest sibling in this schema, also a child
-- log table, also RLS-off with a NOT NULL owner column. inventory_items itself has RLS with 4 real
-- policies, so the asymmetry is stated rather than accidental: this is a single-household app today
-- (V5-PERMSHARD-001 keeps household scope), and a child table's rows are only reachable through a
-- parent the caller could already read.
--
-- IF ANYONE EVER ENABLES RLS ON THIS TABLE, THEY MUST ADD A POLICY IN THE SAME MIGRATION. Enabling
-- RLS with zero policies is deny-all for every non-owner role, and it fails SILENTLY — it returns
-- zero rows rather than a permission error, so it reads as "no data" instead of "no access". That
-- exact footgun was found live on public.schema_version on 2026-09-01 and had been blinding the
-- read-only role for an unknown period (see v4-roschemaversion-001).
CREATE TABLE IF NOT EXISTS public.seed_lot_stage_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id),
  stage             text NOT NULL,
  entered_at        timestamptz NOT NULL DEFAULT now(),
  note              text,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seed_lot_stage_log_stage_check
    CHECK (stage IN ('fermenting', 'drying', 'stored'))
);

CREATE INDEX IF NOT EXISTS idx_seed_lot_stage_log_item
  ON public.seed_lot_stage_log (inventory_item_id, entered_at DESC);

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.89.0-seedsaveflow-001',
        'SEEDSAVEFLOW: V4-SEEDSAVEFLOW-001 (BD-071) slice 1. inventory_items +seed_process '
        '(wet|dry) +seed_stage (fermenting|drying|stored), both nullable with CHECKs; new '
        'seed_lot_stage_log child table + index for the stage history. Additive and expand-only: '
        'no view widened, status untouched, no provenance column added (V4-SEEDLINK-001 owns that '
        'FK and this slice must not duplicate it). Substrate only - no Lambda or UI in this file.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;

-- Verify:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='inventory_items' AND column_name IN ('seed_process','seed_stage');
-- SELECT to_regclass('public.seed_lot_stage_log');
