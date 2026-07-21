-- V4-RADICCHIO-001 sibling fix — same defect class, found by the crop-vs-slug audit.
-- Chervil (Anthriscus cerefolium) carried crop_type_slug='parsley' (Petroselinum crispum): a
-- different genus, kept only because the dataset guess settled for the nearest valid slug.
-- Non-destructive, idempotent. Run redrive.mjs with CULTIVAR_ID=3aa3e850-... after, to swap the
-- derived type: facet tag.
--
-- Attrs mirror the herb-catalog convention (parsley/cilantro/dill are all cut_and_come_again).
-- Chervil is annual (parsley is biennial), bolts fast in heat, and holds poorly once cut — hence
-- the shorter repeat and the 48h loss horizon shared with cilantro rather than parsley's 96h.

INSERT INTO crop_types (slug, display_name, category, default_lifecycle, harvest_habit,
                        repeat_interval_days, loss_horizon_hours, sort_order, created_by)
VALUES ('chervil', 'Chervil', 'herb', 'annual', 'cut_and_come_again', 10, 48, 0, 'v4-radicchio-001')
ON CONFLICT (slug) DO NOTHING;

UPDATE plant_varieties
   SET crop_type_slug = 'chervil', updated_at = now()
 WHERE id = '3aa3e850-c8cd-4632-9320-2d448c81164b'
   AND crop_type_slug = 'parsley';
