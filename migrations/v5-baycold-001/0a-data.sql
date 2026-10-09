-- 0a-data.sql
-- v5-baycold-001 — the potted Sweet Bay Laurel gets a bring-inside threshold, by giving its cultivar care
-- profile the one key that neither the profile nor any bundled data carries for it: `cold`. The method of
-- v5-coldshadow-002, one row, a value that was DECIDED rather than copied.
--
-- NOT APPLIED as of authoring (2026-10-09, lane baycold). No statement in this directory has run
-- against staging or prod. Apply order: README.md.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data.sql
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE DEFECT, read on prod 2026-10-09 (read-only role) and traced in source at dev 526eb195
--
-- Bay falls through two gaps, one per cold channel:
--   CARD   engine.coldFor cards a planting only when the profile it resolves carries cold.tender with a
--          protect_below_F, or its crop type has an entry in frostClass.COLD_BY_CROP_TYPE. The Sweet Bay
--          cultivar profile was written by cadence-backfill-20260823 as a watering-only row (8 keys, no
--          `cold`), the engine adopts it WHOLE (v_resolved_care.cadence_scopes = {cultivar}), `bay` has no
--          crop-type entry, and cadence-data-v2.json has no bay / Sweet Bay / Laurus entry to fall back
--          on. So the planting gets no card at any temperature.
--   EMAIL  `bay` is deliberately unbanded (frostClass.UNCERTAIN_SLUGS: a zone-8-ish woody herb that
--          survives a first frost but is overwintered indoors here). An unbanded slug is counted at the
--          tender trip points and grouped as "unclassified", which the email counts and never names.
--
-- This is NOT a v5-coldshadow row: that census counted plantings whose BUNDLED cold block a database
-- profile shadowed, and bay never had a bundled block. Nothing was hidden; the number did not exist.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE ROW — cultivar scope (care_scope = system | cultivar | leaf)
--
--   d4c8c7e3-320c-4019-8827-b39894cf02b8  cultivar "Sweet Bay" (e890276d…), bay
--       `cold` <- {"tender": true, "protect_below_F": 32}, Dave's decision 2026-10-09
--       -> Sweet Bay Laurel (0bf82c76…), Trough (not covered, not heated); no card today, no
--          brought_inside event logged
--
-- A cultivar row reaches every planting of its variety: this one reaches exactly that one planting.
-- md5(profile::text) at authoring = ae1f9608920cf706635dc726cdd44fe8; keys crop, _tier, notes, _source
-- (cadence-backfill-20260823), confidence, water_method, drought_tolerance,
-- water_interval_days_container (2).
--
-- The value is DECIDED, not copied: there is no bundled entry to copy. Dave, 2026-10-09: warn it, at
-- 32. The nearest precedent is Pineapple Sage, set to 32 in v5-frostband-001 ("bring in before
-- freeze"); bundled Rosemary, the sibling woody herb, is 20, which would card far too late for a plant
-- that is meant to come in before a hard frost. lambda/daily-plan/frostband.test.js parses the literal
-- out of this file and fails if it stops being 32.
--
-- NOT IN THIS FILE, deliberately:
--   frostClass.js — `bay` stays in UNCERTAIN_SLUGS. Banding it tender would list a perennial under
--     "finished" on the End of season page (src/lib/seasonEnd.js FINISHED_BANDS), a surface that ends
--     plantings in bulk; banding it light_frost_tolerant would move the email trips later and still
--     give no card.
--   Rosemary, penstemon and the other unbanded slugs — same class, not in this decision.
--   A CROP_LABELS entry — the email will say "bays (1)", the default plural. Cosmetic, separate.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE FIX
--
-- SINGLE-KEY jsonb_set, never a whole-object replace (v5-coldshadow-001, v5-heatrespcabbage-001): the 8
-- keys already on the row — watering interval, method, crop, notes, confidence, the _source marker —
-- stay byte-identical (gates.yml checks their md5). create_missing is TRUE because the key is ABSENT:
-- jsonb_set(profile, '{cold}', …, false) on a row without `cold` returns the row unchanged, so the
-- UPDATE would report "UPDATE 1" and write nothing. The post receipts tell "wrote the key" from
-- "matched the row".
--
-- Keyed by care_profile row id AND its (scope, scope_id) pair, guarded on the key being absent: a
-- re-run matches nothing, and a cold block written later by anyone is never clobbered. care_profile has
-- no app write route (v5-coldshadow-002), so this file is the path, not a bypass of one.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE EMAIL CHANGES ITS WORDING, NOT ITS NIGHTS. The other reader of `cold` is handler.js's
-- cadenceTenderFor, which PROMOTES an UNBANDED crop type into the frost alert by name. `bay` is unbanded,
-- so after this the planting is class tender (source cadence) and the email names "bays (1)" instead of
-- counting it in "N unclassified (treated as tender)". Both classes use the same trip points (advisory
-- 40F, protect 38F, hard freeze 33F), so the email fires on exactly the nights it fired before.
--
-- LANDING ORDER: none. No code change; no column added or removed. The engine already reads the key:
-- main 7ec97f6a (v4.177.0, fetched 2026-10-09) carries a lambda/daily-plan byte-identical to this
-- migration's base, dev 526eb195. The build actually running was not read. Both readers are older than
-- that: v5-frostband-001 (2026-09-18) was written against the email promotion and v5-coldshadow-002
-- (2026-09-19, prod then on v4.139.0) against the card path.
-- It does depend on CARE_CADENCE_SCOPES_ENABLED being true (prod's value in
-- scripts/lambda-config-expected.json): with that flag off the engine does not adopt the database
-- profile, and bay has no bundled entry beneath it.
--
-- SAFETY: idempotent and non-clobbering. On a database without this row the UPDATE matches zero rows
-- and only the stamp is written, the safe direction. STAGING WAS NOT READ: if the staging branch
-- predates 2026-08-23 or carries a different row id the result there is UPDATE 0; if it was re-cut from
-- prod since, the row is the same and the result is UPDATE 1. Both are correct. On PROD the UPDATE must
-- print UPDATE 1: an UPDATE 0 there means the wrong host or a changed row — stop and read the pre gates
-- (a guarded UPDATE 0 reads like "already applied").
-- ROLLBACK: 0r-rollback.sql.

BEGIN;

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 32}'::jsonb, true),
       updated_at = now()
 WHERE id = 'd4c8c7e3-320c-4019-8827-b39894cf02b8'
   AND scope = 'cultivar' AND scope_id = 'e890276d-43e6-41cd-9dfe-1fa8e05fcfc1'   -- Sweet Bay -> Sweet Bay Laurel
   AND NOT (profile ? 'cold');

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-baycold-001',
        'BAYCOLD-001 (data-only, no DDL). Adds the `cold` key, tender / protect below 32F, to the Sweet Bay '
        'cultivar care_profile row written by cadence-backfill-20260823 without one, so the potted Sweet Bay '
        'Laurel gets a bring-inside card at 32F and below and the frost email names it instead of counting it '
        'unclassified. The value is decided, not copied: no bundled entry exists for bay. Single-key jsonb_set '
        'keyed by row id and guarded on the key being absent; every other key untouched. Dave decision '
        '2026-10-09 (warn it, at 32). Reversible via 0r.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
