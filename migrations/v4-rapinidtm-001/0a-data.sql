-- V4-RAPINIDTM-001 — correct Rapini's days-to-maturity from 60 to 45.
--
-- DATA ONLY. No DDL, no view change, no code change, no deploy. The estimate is computed
-- client-side from variety_ref, which reads this table, so the correction takes effect on the next
-- page load with no promote.
--
-- PROVENANCE — the point of this migration. The stored 60 was unsourced and is a broccoli-shaped
-- number: it matches the heading-broccoli range this cultivar inherited when it sat under the
-- 'broccoli' crop type, not anything published for rapini. Two independent crucible seats flagged
-- it on 2026-08-05 (catalogue rapini runs ~35-50 days from direct seed: Sorrento 40, Spring Raab 42,
-- Sessantina ~45-50). I declined to change it then, because replacing one unsourced number with
-- another is not a fix. **Dave read the actual seed packet on 2026-08-06 and it says 45 days.**
-- That is the source, and it is why this migration exists separately from v4-dtmbasisvar-001
-- rather than riding along with it.
--
-- PAIRS WITH v4-dtmbasisvar-001 (shipped prod v3.101.0, df1480d8). That migration fixed the ANCHOR
-- — Rapini is direct-sown, so its estimate now counts from sown_at instead of a transplant date it
-- does not have. This fixes the DURATION counted from that anchor. Both were wrong; fixing only the
-- anchor left the estimate confidently ~2 weeks late.
--
-- EFFECT, measured on prod before writing this:
--   * The live planting (sown 2026-07-30): Est. harvest 2026-09-28 -> 2026-09-13.
--   * Sow Now: 1 active seed packet. A SHORTER dtm moves the fall latest-safe-sow date LATER
--     (maturity = sow + dtm must beat the frost anchor), so the window can only widen or stay put —
--     it cannot retroactively close a window that is currently open. Verified direction, not assumed.
--
-- min and max are both set to 45, preserving the existing shape (the row was 60-60, a point
-- estimate, not a range). If a range is wanted later that is a separate, sourced decision.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data.sql

BEGIN;

-- Scoped by the cultivar's stable UUID, not by name: "Rapini" is a plausible substring of a future
-- cultivar name, and the v4-cropsplit-001 precedent is explicit that moves/edits go by explicit id.
UPDATE public.plant_varieties
   SET days_to_maturity_min = 45,
       days_to_maturity_max = 45
 WHERE id = '0e33b90d-0dd0-4864-bd37-e9fedd1d3088'
   AND deleted_at IS NULL;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.19.0-rapinidtm-001',
        'RAPINIDTM: Rapini days_to_maturity 60 -> 45, both min and max, scoped by cultivar UUID. '
        'The 60 was unsourced and broccoli-shaped (inherited from the heading-broccoli range under '
        'the broccoli crop type); Dave read the seed packet 2026-08-06 and it says 45. Pairs with '
        'v4-dtmbasisvar-001, which fixed the ANCHOR (direct-sown, counts from sown_at) while this '
        'fixes the DURATION — anchor-only left the estimate confidently ~2 weeks late. Live '
        'planting est. harvest 2026-09-28 -> 2026-09-13. Data only: no DDL, no view, no deploy.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
