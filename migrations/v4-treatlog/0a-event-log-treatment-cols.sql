-- V4-TREATLOG-001 — structured treatment capture on event_log (additive, nullable → safe)
-- Product applied (inventory FK or free-typed), what kind, how much, and the pest/disease targeted.
ALTER TABLE event_log
  ADD COLUMN IF NOT EXISTS treatment_product_id   uuid REFERENCES inventory_items(id),
  ADD COLUMN IF NOT EXISTS treatment_product_text text,
  ADD COLUMN IF NOT EXISTS treatment_category     text,
  ADD COLUMN IF NOT EXISTS treatment_amount       text,
  ADD COLUMN IF NOT EXISTS pest_target            text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='event_log_treatment_category_check') THEN
    ALTER TABLE event_log ADD CONSTRAINT event_log_treatment_category_check
      CHECK (treatment_category IS NULL OR treatment_category IN ('fertilizer','amendment','pest_control','other'));
  END IF;
END $$;
