-- V4-FLAG-001 (2026-07-07): register the 'issue' tag facet so on-the-fly issue tags can be
-- created (Slice 2 promote-on-first-use). Additive IN-list widening of tag_facet_check using the
-- house NOT VALID -> VALIDATE idiom. The existing constraint is already NOT VALID; we drop+re-add
-- with 'issue' included, then VALIDATE (no historical row uses 'issue', so VALIDATE is a no-op scan).
-- Idempotent-ish: guarded by IF EXISTS on the drop. Ship to prod AND staging BEFORE any code that
-- writes facet='issue' (else those INSERTs 500 on the CHECK — green-CI/broken-prod class).
ALTER TABLE tag DROP CONSTRAINT IF EXISTS tag_facet_check;
ALTER TABLE tag ADD CONSTRAINT tag_facet_check
  CHECK (facet = ANY (ARRAY['type','group','lifecycle','location','freeform','heat','determinacy','day_length','allium_type','basil_use','issue']::text[]))
  NOT VALID;
ALTER TABLE tag VALIDATE CONSTRAINT tag_facet_check;
