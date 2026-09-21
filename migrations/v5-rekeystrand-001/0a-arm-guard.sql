-- 0a-arm-guard.sql
-- BUG-REKEYSTRANDSPROFILE-001 — arm the standing strand guard.
--
-- ┌─ THE DEFECT ─────────────────────────────────────────────────────────────────────────────────┐
-- │ An agent researches a cultivar and writes a care_profile keyed to its variety id. A human     │
-- │ then changes that planting's Variety through the picker. That is NOT a rename: VarietyPicker  │
-- │ MINTS A NEW plant_varieties ROW (submitCreate, src/components/VarietyPicker.jsx:306-332) and  │
-- │ re-points the form at it (:330). The planting PUT then writes the new id as a bare column     │
-- │ assignment (lambda/plants/index.js:1098-1101) with no dependent-row logic at all. The         │
-- │ research is left attached to a variety nothing is growing, and care_profile.scope_id carries  │
-- │ NO foreign key, so the database cannot see the reference to complain about it.                │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- THIS FILE WRITES NO DATA. It inserts one schema_version row and nothing else. That row is the
-- ARMING SWITCH: every standing gate in gates.yml carries
--     AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-rekeystrand-20260908')
-- so the guard is vacuously green until this runs and a real invariant forever after. Self-arming is
-- mandatory here, not stylistic: gate-invariants.yml fires on any migrations/** push and would red the
-- job the moment these gates landed if they asserted before being applied (gate-invariants.yml:166-171).
--
-- ┌─ READ BEFORE APPLYING ───────────────────────────────────────────────────────────────────────┐
-- │ APPLYING THIS MAKES EXISTING FINDINGS VISIBLE. Run preview_armed.py first and apply only      │
-- │ when it prints ARM-SAFE (README §Arming). 2026-09-08 measured two (Snapdragon, since          │
-- │ resolved, and Palmetto Punch). Live prod on 2026-09-21 read NOT ARM-SAFE with three, all      │
-- │ 2026-06-18 _seeded profiles:                                                                  │
-- │                                                                                               │
-- │   81951ffd-71fc-4a77-87a1-01ea07e96357  Palmetto Punch                                        │
-- │   c03b71ce-963d-482c-ad1d-19ddcdb69b9b  Bulgarian Carrot (Shipka)                             │
-- │   f0f2ed77-d3a5-418b-975c-fca44c11cd4c  Sunbright                                             │
-- │                                                                                               │
-- │ A stranded app placeholder is NOT a finding (Dave, 2026-09-21; README §Placeholders).         │
-- │                                                                                               │
-- │ That is the point of the guard, not a bug in it — but it means gate-invariants.yml goes RED   │
-- │ on the next run after apply unless each is resolved first, one of two ways:                   │
-- │                                                                                               │
-- │   RESOLVE  the profile belongs to the planting's new identity, or was simply wrong  -> move   │
-- │            or delete it. The strand is gone and the guard is green on its own.                │
-- │   RETAIN   the profile is worth keeping against the old cultivar (the Snapdragon research is  │
-- │            still good research about snapdragons, and Dave may plant an actual snapdragon)    │
-- │            -> label the decision IN THE DATA with a _retained sentence. See below.            │
-- │                                                                                               │
-- │ Neither is decided here. Both are Dave's call, and a migration that guessed would be making   │
-- │ a product decision under cover of a schema change.                                            │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- THE _retained MARKER — the recipe, kept next to the thing it clears.
-- The valve is a top-level string key on care_profile.profile. Any non-empty JSON string clears that
-- row; post_retained_marker_states_a_reason reds on a boolean, a number, a null or an empty string, so
-- `"_retained": true` will NOT silence a finding. Write a sentence that names who decided, when, and
-- why the row should outlive its planting:
--
--   UPDATE public.care_profile
--      SET profile = profile || jsonb_build_object(
--            '_retained',
--            'Kept <date> on Dave''s decision: <why this research should outlive its planting>. '
--            'Its last planting was re-keyed to <new cultivar> on <date>.')
--    WHERE scope = 'cultivar'
--      AND scope_id = '<variety uuid>'::uuid;
--
-- Left as a comment on purpose. Uncommenting it is asserting the decision was made; running this file
-- must never make it by default.
--
-- REVERSIBLE: 0r-rollback.sql deletes exactly this receipt, which disarms the gates back to vacuous.
-- No data is touched in either direction.
--
-- Usage (README §Arming has the full order — this predicate on main first, then the preview):
--   python3 migrations/v5-rekeystrand-001/preview_armed.py --env prod     # must print ARM-SAFE
--   psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-rekeystrand-001/0a-arm-guard.sql

BEGIN;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-rekeystrand-20260908',
        'REKEYSTRAND: BUG-REKEYSTRANDSPROFILE-001 standing guard. Arms three post gates that detect '
        'agent-written cultivar care_profile rows stranded when a human re-keys a planting to a newly '
        'minted variety (VarietyPicker creates rather than renames; the plants PUT re-points with no '
        'dependent-row logic). Scoped to varieties an audit_events row PROVES lost a planting, which '
        'is what keeps the candidate set at 4 instead of the ~1200 that "no live planting" alone '
        'matches. Release valve is a _retained sentence on the profile, itself gated so it cannot '
        'degrade to a boolean off-switch. A stranded app placeholder (_basis unresearched, no key '
        'beyond _source/_basis/notes) is not counted, per Dave 2026-09-21. Writes NO data. '
        'Forward-looking only: the plants audit trigger was armed 2026-08-27, so earlier re-keys are '
        'undetectable by construction.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
