-- V4-GARLICANNUAL-001 — correct three crop_types defects on slug='garlic' that together taught a
-- false life cycle: that garlic left in the ground resumes and bulbs up a second year.
--
-- DATA ONLY on the DB side. No DDL, no view, no constraint change. Ships alongside two lockstep
-- edits to authoring/provenance files that carry the same numbers (see LOCKSTEP below); neither is
-- on a runtime read path, so this migration still needs no promote to take effect.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
-- Verified by direct query against prod Neon 2026-08-26, and identical on the staging branch:
--   slug=garlic | default_lifecycle='perennial' | dtm_basis=NULL | start_doy=186 | end_doy=211
--
-- (1) default_lifecycle 'perennial' -> 'annual'.
--     Garlic is cultivated as an annual: one fall clove planting, one winter, one summer lift, then
--     replant fresh cloves. There is no second dormancy after summer senescence. Allium sativum is
--     a perennial geophyte in the botanical sense, which is exactly why this row read as defensible
--     and went unexamined — but this column is what an agent or a reader consults when asking "does
--     this planting come back", and on that question 'perennial' is the wrong answer.
--     PROVENANCE of the old value: seeded in bulk by migrations/v4-planttype/0b-data.sql:54
--     ('garlic','Garlic','perennial','vegetable',0) under a header describing the whole list as
--     "Owner-decided horticultural mapping (Dave)". It was a row in a 100-odd-row vocabulary seed,
--     not a per-crop decision, and Dave is correcting it here.
--
-- (2) dtm_basis NULL -> 'from-sow'.
--     The cultivar "Garlic (hardneck)" (96773f51-d9bb-418e-b1d4-974f25dae60d) carries
--     days_to_maturity 240-270, a figure that is only meaningful anchored to fall plant-out. With
--     the basis NULL the duration had no stated anchor at all.
--     WHY 'from-sow' AND NOT 'from-transplant': crop_types_dtm_basis_chk admits exactly those two
--     values; there is no 'from-plant-out'. A garlic clove is the propagule, planted straight into
--     its final position — there is no transplant step, and no nursery stage to count from. Picking
--     'from-transplant' would be actively worse than NULL: plantingMaturity.js:162 would look for
--     transplanted_at, fail to find one on a direct-planted crop, and render the "set a transplant
--     date" prompt (awaitingTransplant) on every garlic card forever.
--     Resolution is cultivar-first (COALESCE(pv.dtm_basis, ct.dtm_basis), lambda/plants/index.js:417)
--     and the garlic cultivar's own dtm_basis is NULL, so this crop-level value is what it will use.
--
-- (3) harvest_season_start_doy 186 -> 196, harvest_season_end_doy 211 -> 217.
--     186 = Jul 5. For a Franklin County hilltown ridge that is early enough that a bulb lifted then
--     is likely still immature; Dave's expectation is ~Jul 15 - Aug 5. New window 196 = Jul 15 to
--     217 = Aug 5. Note this SHIFTS the window later and slightly narrows it (26 days -> 22), rather
--     than widening it — the old end (211 = Jul 30) was never the defective bound.
--     The window stays SET rather than going NULL: harvestAttributesSync.test.js pins the windowed
--     set to exactly ['asparagus','garlic'], and the justification in harvest-attributes-v1.json
--     still holds — too early gives undersized bulbs, too late splits the wrapper and the bulb will
--     not store, so lifting outside the window is a real loss, not merely atypical.
--
-- ── WHAT THIS DOES **NOT** FIX (recorded so it is not re-derived, or mistaken for a failed apply) ──
--   * THE VISIBLE "Perennial" CHIP DOES NOT MOVE. crop-derive.js:198 reads
--       cultivar.lifecycle ?? ct.default_lifecycle
--     and plant_varieties.lifecycle is 'perennial' on the garlic cultivar, so the derived
--     lifecycle facet tag still resolves to perennial and the card still shows that chip. This
--     migration cannot reach it; closing it is a separate decision, surfaced to Dave.
--     AND THE OBVIOUS FIX IS A TRAP, so it is written down here rather than left to be rediscovered.
--     plant_varieties carries a SECOND axis, grown_as, which computeDerivedTags never consults, and
--     it is 'annual' on the garlic cultivar — which looks like the answer and is not. Measured on
--     live prod 2026-08-26: grown_as is 'annual' on 362 of 413 live cultivars, NULL on 37, and
--     something else on 14 — and those 14 are exactly the rows where it duplicates `lifecycle`.
--     It is 'annual' on the Peach tree, the High Bush blueberry, the Hosta, the Japanese Maple,
--     the jade plant and the Asparagus crown. It is a bulk default, not curated data, and it
--     happens to be right for garlic by luck rather than by anyone deciding. Making crop-derive
--     prefer it would therefore not "show the as-grown truth" — it would label 68 crop types'
--     worth of trees, shrubs and houseplants "Annual", and it would throw away the genuinely
--     useful tender_perennial signal on 188 pepper and tomato cultivars. Strictly worse than
--     today. Whatever closes this gap, it is not that.
--   * THE DOY WINDOW IS INERT FOR GARLIC TODAY. isReadyToPick (src/lib/harvestReadiness.js:116)
--     returns false for any crop whose harvest_habit is not in {repeat, cut_and_come_again} before
--     it ever reaches inHarvestWindow at :128. Garlic is 'single'. Nothing else consumes these two
--     columns — lambda/harvests/ does not read them, and src/lib/storageDeadlines.js:22 explicitly
--     refuses to. So (3) is a correctness fix to the recorded window, not a behaviour change, and
--     the value it buys is that the next reader of this row gets Dave's real window rather than one
--     ten days early. Stated plainly because a gate proving the value landed cannot prove it matters.
--   * THE LIVE PLANTING IS NOT TOUCHED. 7bfaea51-8ad6-4063-948c-9b6e78616418 ("Garlic", ~12 plants,
--     Legacy Pasture in-ground) was set status='dormant' on 2026-08-13 with zero harvest events ever
--     logged, on the reasoning — recorded verbatim in its own observation event — that "Hardneck
--     garlic overwinters ... and the planting rests until spring, when it resumes and bulbs up."
--     That is the false model this migration corrects at the source. Dormant excludes the planting
--     from daily-plan care, harvest watch, dashboard counts and findings, and daily-plan/engine.js:697
--     records that a human set it and only a human clears it. Its repair is Dave's call about his
--     own garden and belongs on the app write path, not in a migration.
--
-- ── LOCKSTEP (same commit, or harvestAttributesSync.test.js fails) ───────────────────────────────
--   * src/data/harvest-attributes-v1.json — garlic block DOY pair + notes.
--   * migrations/v4-harvattr-001/0b-data.sql — the garlic seed tuple, as a marked ADDENDUM. That
--     test reads that ONE hardcoded SQL path and is blind to this directory, so a new migration
--     alone leaves the JSON and the pinned seed disagreeing. Its historical schema_version INSERT is
--     left untouched.
--   * src/data/storageDeadlines.json — the garlic no_calendar_deadline finding quotes 186/211 as
--     current fact; amended with a dated note so the numbers do not read as live.
--
-- SHALLOT IS DELIBERATELY UNTOUCHED. It is also default_lifecycle='perennial', and Dave flagged it
-- as more defensible. It is: shallots multiply into a clump and can be carried over, its two
-- cultivars disagree with each other on the botanical axis ('perennial' and 'biennial') while both
-- carry grown_as='annual', and unlike garlic it has no DOY window and no false-dormancy incident
-- behind it. Changing it would be a guess. Left as-is, reported to Dave.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data.sql

BEGIN;

-- Scoped by the primary key. Idempotent on the data fields: every value is a constant, so a re-run
-- writes the same row (updated_at moves, which is the honest record that the row was rewritten).
UPDATE public.crop_types
   SET default_lifecycle        = 'annual',
       dtm_basis                = 'from-sow',
       harvest_season_start_doy = 196,
       harvest_season_end_doy   = 217,
       updated_at               = now()
 WHERE slug = 'garlic'
   AND deleted_at IS NULL;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.41.0-garlicannual-001',
        'GARLICANNUAL: crop_types slug=garlic — default_lifecycle perennial -> annual (cultivated as '
        'an annual: fall cloves, one winter, summer lift, replant; no second dormancy), dtm_basis '
        'NULL -> from-sow (the 240-270d figure had no anchor; a clove is direct-planted, and '
        'from-transplant would strand every garlic card on the set-a-transplant-date prompt), and '
        'harvest_season_doy 186-211 -> 196-217 (Jul 5 is early for a Franklin County ridge; Dave''s '
        'window is ~Jul 15 - Aug 5). Corrects the model behind planting 7bfaea51 being set dormant '
        '2026-08-13 with zero harvest on the reasoning that it would bulb up next spring. Data only, '
        'no DDL, no deploy. Does NOT move the visible Perennial chip (crop-derive prefers '
        'plant_varieties.lifecycle) and the DOY pair is inert while harvest_habit=single — both '
        'deliberate, both recorded in 0a-data.sql. shallot deliberately left unchanged.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
