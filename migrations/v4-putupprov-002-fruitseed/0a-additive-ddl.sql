-- 0a-additive-ddl.sql
-- V4-PUTUPPROV-002 — seed the BOUGHT/FORAGED fruit class into crop_types.
-- Canon: putup-provenance-plan-V101-20260726.md §D3.
--
-- WHY THIS EXISTS. V4-PUTUPPROV-001 (v3.64.0) made it possible to record that produce came from a
-- farm stand, a u-pick orchard or a store. It did NOT make it possible to SAY WHAT the produce is:
-- chk_preservation_log_attribution still requires crop_type_slug OR variety_id, and the live
-- catalog had 116 rows of which almost none were tree fruit. Before this, `peach` worked only by
-- accident (Dave planted one) while `apple` and `plum` — the two likeliest September purchases in
-- Franklin County — could not be logged at all. Provenance without vocabulary is a feature that
-- fails at the checkout counter.
--
-- WHY IT IS SAFE TO PUT NON-GARDEN SPECIES IN A GARDEN TAXONOMY. This was raised as a real risk:
-- crop_types reads like "things I grow", so seeding apple/cranberry/elderberry could start
-- proposing orchard trees to a zone-5b seed sower. VERIFIED AGAINST LIVE CODE, NOT ASSUMED:
--   * v_sow_candidates is built FROM inventory_items JOIN plant_varieties and does NOT reference
--     crop_types at all — a sow suggestion requires an actual seed packet you own, so a crop_types
--     row cannot generate one.
--   * src/lib/parseSowProfile.js uses crop_types as a VALIDATION WHITELIST for crop guesses
--     ("live crop_types enum whitelist"), not as a source of recommendations.
--   * The remaining consumers (VarietyPicker's crop chooser, whats-put-up?group=crop) only ever
--     display types that rows actually reference.
-- So the blast radius is: more options in a picker. That is the intended effect.
--
-- HARVEST-BEHAVIOUR COLUMNS ARE DELIBERATELY LEFT NULL. crop_types is not just labels — it carries
-- harvest_habit, repeat_interval_days, loss_horizon_hours, set_to_first_pick_days, and the
-- harvest-readiness engine reads them. NULL means UNKNOWN and NEVER FIRES (the V4-HARVATTR-001
-- convention). Guessing "an apple tree yields every 3 days" for a tree Dave does not own would be
-- writing inference into columns the UI displays as fact — the exact norm this project holds. If he
-- ever plants one, the values get filled in then, from his tree.
--
-- SAFETY: pure INSERT ... ON CONFLICT DO NOTHING against an existing table. No DDL, no constraint
-- change, no update to any existing row. Re-running is a clean no-op. Rollback deletes ONLY the
-- rows still unreferenced by any table (see 0r).

BEGIN;

INSERT INTO public.crop_types (slug, display_name, default_lifecycle, category, created_by) VALUES
  ('apple',       'Apple',            'perennial', 'fruit', 'system'),
  ('pear',        'Pear',             'perennial', 'fruit', 'system'),
  ('plum',        'Plum',             'perennial', 'fruit', 'system'),
  ('cherry',      'Cherry (sweet)',   'perennial', 'fruit', 'system'),
  ('sour_cherry', 'Cherry (tart)',    'perennial', 'fruit', 'system'),
  ('apricot',     'Apricot',          'perennial', 'fruit', 'system'),
  ('nectarine',   'Nectarine',        'perennial', 'fruit', 'system'),
  ('cranberry',   'Cranberry',        'perennial', 'fruit', 'system'),
  ('grape',       'Grape',            'perennial', 'fruit', 'system'),
  ('raspberry',   'Raspberry',        'perennial', 'fruit', 'system'),
  ('blackberry',  'Blackberry',       'perennial', 'fruit', 'system'),
  ('elderberry',  'Elderberry',       'perennial', 'fruit', 'system'),
  ('rhubarb',     'Rhubarb',          'perennial', 'fruit', 'system')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.schema_version (version, description)
VALUES ('4.15.1-putupprov-002','PUTUPPROV-002: seed 13 bought/foraged fruit crop_types (apple, pear, plum, cherry, sour_cherry, apricot, nectarine, cranberry, grape, raspberry, blackberry, elderberry, rhubarb) so Put-Up provenance can actually name non-garden produce — attribution requires crop_type_slug OR variety_id and the catalog had almost no tree fruit. Identity columns only; harvest_habit/repeat_interval_days/loss_horizon_hours/set_to_first_pick_days left NULL (=UNKNOWN, never fires) rather than inventing harvest behaviour for trees not grown here. Verified non-polluting: v_sow_candidates reads inventory_items, not crop_types.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
