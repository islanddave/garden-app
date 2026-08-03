-- 0d-coverage.sql — GENERATED. Run at apply time: which authoring keys resolve to a live cultivar?
-- matches=1 -> seeded; matches=0 -> skipped (no such cultivar); matches>=2 -> skipped (ambiguous name).
SELECT v.slug, v.name,
       (SELECT count(*) FROM public.cultivar c
         WHERE c.crop_type_slug = v.slug AND c.display_name = v.name AND c.deleted_at IS NULL) AS matches
FROM (VALUES
  ('tomato', 'San Marzano Roma'),
  ('tomato', 'San Marzano'),
  ('tomato', 'Moskvich Heirloom'),
  ('tomato', 'Super Sweet 100'),
  ('tomato', 'Black Cherry'),
  ('tomato', 'Cherry Falls'),
  ('tomato', 'Sunray'),
  ('tomato', 'Celebrity'),
  ('tomato', 'Granadero')
) AS v(slug, name)
ORDER BY matches, v.slug, v.name;
