-- V4-DTMBASISVAR-001 — 0b DATA. Set the per-cultivar basis for the two cultivars the crucible
-- proved are mis-anchored. Separate from 0a so the structural change stays a pure no-op and this
-- file (the only part with user-visible effect) can be reverted on its own.
--
-- SCOPE IS DELIBERATELY NARROW. Two cultivars, by NAME + current slug, both on 'broccoli'. Rapini
-- (Brassica rapa Ruvo) and Kailaan (B. oleracea Alboglabra) both have catalogue DTM quoted FROM
-- DIRECT SEED, while crop_types.broccoli carries 'from-transplant' — correct for heading broccoli
-- (Belstar, Green Magic), wrong for these two. Evidence for Rapini is not merely catalogue: its one
-- live planting is sown_at 2026-07-30 with transplanted_at NULL, i.e. direct-sown, so the
-- from-transplant anchor has nothing to resolve against and the card shows no date at all.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH, and why:
--   * plant_varieties.days_to_maturity_min/max — two crucible seats flagged Rapini's stored 60 as a
--     broccoli-shaped number (catalogue rapini is ~35-50 from seed). Correcting it needs Dave's
--     actual packet; guessing would replace one unsourced number with another.
--   * sow_notes / start_method — a seat found Kailaan's "TRANSPLANTS BOLT - DIRECT SOW ONLY" note
--     horticulturally wrong (gai lan is routinely plug-grown) and believes it belongs on Rapini
--     instead. That is a rewrite of Dave's own recorded content on contested expert opinion with no
--     packet to check it against, and it would move sow windows. Flagged, not applied.
--
-- IDEMPOTENT: re-running sets the same values. Guarded on the current slug so it cannot silently
-- follow a cultivar that has since been moved elsewhere.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0b-data.sql

BEGIN;

UPDATE public.plant_varieties
   SET dtm_basis = 'from-sow'
 WHERE deleted_at IS NULL
   AND crop_type_slug = 'broccoli'
   AND name IN ('Rapini', 'Kailaan');

COMMIT;
