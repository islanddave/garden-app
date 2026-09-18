-- 0a-data.sql
-- v5-frostband-001 — BUG-STABLEUNKNOWNSLUGS-001 + BUG-PINEAPPLESAGEBAND-001: two cultivars whose
-- crop type gives the frost alert the wrong answer, fixed by giving each a crop type of its own.
--
-- NOT APPLIED as of authoring (2026-09-18, lane frostband). No statement in this directory has run
-- against staging or prod. Apply order and the derive step: README.md.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data.sql     (then 0b-derive.mjs)
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE DEFECT
--
-- The frost alert bands crop TYPES (lambda/daily-plan/frostClass.js SLUGS_BY_BAND). Two live
-- cultivars sit in a crop type whose band is wrong for them, measured read-only on prod 2026-09-18:
--
--   44907632-80f4-4f8d-bbdd-e7143e0bea7a  "Sedum spectabile"  typed sedum  -> 1 planting, Autumn Fire
--       Stonecrop, in the Stable. Hylotelephium spectabile, a zone-3 showy stonecrop. `sedum` is
--       deliberately UNBANDED (frostClass.UNCERTAIN_SLUGS) because the genus spans hardy and tender
--       species, so the alert counts it tender and names it as "unclassified": a false alarm.
--   6b75492d-b08c-4f66-9de9-18157fc1bdaa  "Pineapple Sage"    typed sage   -> 1 planting, potted in
--       the open-sky Bag Area. Salvia elegans, zone 8-10, top-killed by the first frost. `sage` is
--       banded HARDY for garden sage (S. officinalis), so no frost alert can ever name it: a MISSED
--       alarm, the dangerous direction.
--
-- WHY A CROP TYPE, AND NOT THE BAND OF THE OLD ONE. Banding `sedum` hardy would silence the two tender
-- S. adolphii plantings that share it; banding `sage` tender would page for every garden sage. Genus
-- cannot separate either pair (Sedum/Hylotelephium are split only in the NAME "Sedum spectabile";
-- garden sage, pineapple sage and rosemary are all Salvia), and a name is not an identity
-- (BUG-WATERIDENTITYFREETEXT-001). This is v4-cropsplit-001's rule: where the divergence is
-- CATEGORICAL — a signal that fires versus one that can never fire — only a slug split works. The
-- band itself stays keyed on the controlled slug, exactly as every other band is.
--
-- Every move is BY EXPLICIT CULTIVAR ID, guarded on the old slug. Never by a predicate.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE COLD CHANNEL HAS THE SAME DEFECT, AND IS FIXED HERE TOO
--
-- The cold card (engine.coldFor) reads the cultivar's resolved care profile first. Pineapple Sage's
-- cultivar care_profile row was written by cadence-backfill-20260823 and says so in its own notes:
-- "Cloned from the sage crop baseline". It carries garden sage's cold block,
-- {"tender": false, "protect_below_F": 10}. CARE_CADENCE_SCOPES_ENABLED is true in prod
-- (scripts/lambda-config-expected.json), so the engine adopts that DB profile and the card is inert at
-- every temperature (a tender:false profile is never adopted by coldFor). The bundled
-- by_genus_fallback.Salvia entry authored for S. elegans (cadence-data-v2.json: tender, protect below
-- 32F, "bring in before freeze") is shadowed by it. Re-typing the cultivar alone would leave the email
-- saying "tender" and the card saying "hardy to 10F". So the `cold` key, and ONLY that key, is set to
-- the bundled S. elegans value.
--
-- SINGLE-KEY jsonb_set, never a whole-object replace (v5-heatrespcabbage-001): every other key on the
-- row — the watering intervals, crop, notes, confidence, the _source provenance marker the seededgate
-- resolver reads — survives byte-identically. Matched on the OLD value, so a re-run matches nothing
-- and a later hand-edit is never clobbered. care_profile has no app write route, so this file is the
-- correct path for it, not a bypass of one.
--
-- NOT fixed here, reported instead: the same row's watering and feeding keys are also garden-sage
-- clones (soak_then_dry, drought_tolerance high, crop "sage", which isMedHerb reads). Out of scope.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE TWO CROP TYPES
--
--   hylotelephium   'Hylotelephium (Showy Stonecrop)', category succulent (as sedum), lifecycle
--                   perennial (the cultivar's own), no harvest attributes: it inherits the recorded
--                   no-harvest decision sedum carries (src/data/harvest-attributes-v1.json
--                   not_harvest_tracked, src/lib/harvestTracked.js and v4-harvhabitgap-001's null-habit
--                   gate list it in the same change). Named by genus, the house convention for
--                   succulent types (sempervivum, haworthia, echeveria, lithops). The search aliases
--                   keep it findable by the name Dave uses ("stonecrop") and the name it was bought as.
--   pineapple_sage  'Pineapple Sage', category herb (as sage), lifecycle tender_perennial (the
--                   cultivar's own). Every harvest and weight column is COPIED FROM THE LIVE sage ROW,
--                   so harvest readiness and weight resolution for this cultivar are unchanged: the
--                   frost band is the only behaviour this migration means to move. The copied weights
--                   are garden-sage estimates, inherited, not re-measured.
--
-- created_by = 'v5-frostband-001' (the v4-cropsplit-001 convention), which scopes the guarded revive
-- below and the rollback's soft-delete to rows this migration minted. crop_types carries no audit or
-- ownership trigger.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- LANDING ORDER: NONE REQUIRED against the code, in either direction (README.md "Window").
--   * new code, old data: the two new bands are inert; today's behaviour, except Horseweed.
--   * old code, new data: the deployed classifier has never heard of either slug. Autumn Fire counts
--     as "unknown" (counted tender), so it stays a false alarm until the code lands. Pineapple Sage is
--     warned at once: its corrected cold block makes handler.js's cadenceTenderFor promote the unknown
--     slug to tender, so the email names "pineapple sages" (checked against the base frostClass.js).
--     No read path 500s: no column is added or removed.
-- ONE ordering constraint, and it is not about code: migrations/v4-harvhabitgap-001/gates.yml must
-- already list hylotelephium (this branch does) or post_every_null_habit_is_a_recorded_decision reds
-- on the next gate run after this apply.
--
-- SAFETY: idempotent and non-clobbering. Each INSERT is ON CONFLICT (slug) DO NOTHING plus a revive
-- scoped to created_by; each UPDATE is guarded on the value it replaces; the stamp is ON CONFLICT.
-- On a database without these cultivars (staging, if it predates them) every UPDATE matches zero rows
-- and only the two vocabulary rows are added — the safe direction.
-- ROLLBACK: 0r-rollback.sql.

BEGIN;

-- Audit actor for the plant_varieties update triggers (audit_events.actor_clerk_sub). A migration is
-- not Dave, so it does not assert his sub: this row names what actually wrote it.
SELECT set_config('app.actor_clerk_sub', 'migration:v5-frostband-001', true);

-- 1. The vocabulary, BEFORE any cultivar points at it (plant_varieties_crop_type_slug_fkey).
INSERT INTO public.crop_types
  (slug, display_name, category, default_lifecycle, sort_order, created_by, search_aliases)
VALUES
  ('hylotelephium', 'Hylotelephium (Showy Stonecrop)', 'succulent', 'perennial', 0, 'v5-frostband-001',
   'showy stonecrop, stonecrop, sedum spectabile')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.crop_types
  (slug, display_name, category, default_lifecycle, sort_order, created_by, search_aliases,
   harvest_habit, repeat_interval_days, loss_horizon_hours, set_to_first_pick_days,
   harvest_season_start_doy, harvest_season_end_doy, first_year_harvest, dtm_basis,
   default_unit, grams_per_unit, unit_weights, weight_source, weight_confidence,
   variety_grams_required)
SELECT 'pineapple_sage', 'Pineapple Sage', s.category, 'tender_perennial', 0, 'v5-frostband-001',
       'salvia, salvia elegans',
       s.harvest_habit, s.repeat_interval_days, s.loss_horizon_hours, s.set_to_first_pick_days,
       s.harvest_season_start_doy, s.harvest_season_end_doy, s.first_year_harvest, s.dtm_basis,
       s.default_unit, s.grams_per_unit, s.unit_weights, s.weight_source, s.weight_confidence,
       s.variety_grams_required
  FROM public.crop_types s
 WHERE s.slug = 'sage' AND s.deleted_at IS NULL
ON CONFLICT (slug) DO NOTHING;

-- crop_types_pkey is a plain PRIMARY KEY (slug): a soft-deleted row squats the slug invisibly, and
-- ON CONFLICT DO NOTHING would then leave it dead. Revive only a row this migration minted (a re-apply
-- after 0r); a squatter minted by anyone else stops the apply at pre_new_slugs_are_free instead.
UPDATE public.crop_types SET deleted_at = NULL, updated_at = now()
 WHERE slug IN ('hylotelephium', 'pineapple_sage') AND deleted_at IS NOT NULL
   AND created_by = 'v5-frostband-001';

-- 2. Re-point the two cultivars. Guarded on the OLD slug: idempotent, and a later hand re-type
--    survives. Deliberately NOT filtered on deleted_at: a soft-deleted cultivar that is later restored
--    must not come back on the wrong slug (v4-cropsplit-001). lifecycle is already correct on both.
UPDATE public.plant_varieties SET crop_type_slug = 'hylotelephium', updated_at = now()
 WHERE id = '44907632-80f4-4f8d-bbdd-e7143e0bea7a' AND crop_type_slug = 'sedum';   -- "Sedum spectabile" (Autumn Fire)

UPDATE public.plant_varieties SET crop_type_slug = 'pineapple_sage', updated_at = now()
 WHERE id = '6b75492d-b08c-4f66-9de9-18157fc1bdaa' AND crop_type_slug = 'sage';    -- "Pineapple Sage" (Salvia elegans)

-- 3. The cold channel: Pineapple Sage's cultivar care profile, `cold` key only, matched on the
--    garden-sage clone value. The new value is cadence-data-v2.json by_genus_fallback.Salvia's, the
--    entry authored for S. elegans.
UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 32}'::jsonb, false),
       updated_at = now()
 WHERE scope = 'cultivar'
   AND scope_id = '6b75492d-b08c-4f66-9de9-18157fc1bdaa'
   AND profile->'cold' = '{"tender": false, "protect_below_F": 10}'::jsonb;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-frostband-001',
        'FROSTBAND: BUG-STABLEUNKNOWNSLUGS-001 + BUG-PINEAPPLESAGEBAND-001 (data-only, no DDL). Mints '
        'crop types hylotelephium (hardy showy stonecrop) and pineapple_sage (tender; harvest and weight '
        'columns copied from sage) and re-points two cultivars by id, guarded on the old slug: '
        '"Sedum spectabile" (Autumn Fire) sedum -> hylotelephium, "Pineapple Sage" sage -> pineapple_sage. '
        'Sets the Pineapple Sage cultivar care_profile cold key (single-key jsonb_set, matched on the '
        'garden-sage clone value) to tender / protect below 32F so the cold card and the frost email agree. '
        'frostClass.js bands both slugs. Derived tags need 0b-derive.mjs. Reversible via 0r.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
