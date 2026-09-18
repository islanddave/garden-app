-- 0a-data.sql
-- v5-coldshadow-001 — BUG-COLDPROFILESHADOWSBUNDLED-001: Graptosedum and Pachyphytum get the bring-inside
-- card at 40F that the bundled cadence data already gives them, by giving their cultivar care profiles
-- the one key that data carries and the profiles lack: `cold`.
--
-- NOT APPLIED as of authoring (2026-09-18, lane coldshadow). No statement in this directory has run
-- against staging or prod. Apply order: README.md.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data.sql
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE DEFECT, measured read-only on prod 2026-09-18
--
-- engine.coldFor resolves the planting's cadence first. When a database scope contributes a watering
-- interval (v_resolved_care.cadence_scopes non-empty; CARE_CADENCE_SCOPES_ENABLED is on in prod),
-- engine.resolveCadence returns that database profile WHOLE and never reads cadence-data-v2.json. On
-- 2026-08-23 cadence-backfill-20260823 wrote a cultivar profile for each of these two cultivars,
-- "Cloned from the succulent crop baseline": watering keys, no `cold` key. From that night:
--
--   bdbf05dd-0239-4ac0-b0d1-b0cbc816a62c  cultivar profile of "Graptosedum" (f4919a6f-…), 1 planting
--   5a179436-7feb-4e3d-9f29-bbf5272b9414  cultivar profile of "Pachyphytum" (b3666254-…), 1 planting
--
-- both plantings potted, in the unheated Stable, resolve {system,cultivar} with cadence_scopes
-- {cultivar} and NO `cold` key, so the bundled by_variety entries, both
-- {"tender": true, "protect_below_F": 40}, are shadowed. The crop-type fallback
-- beneath them is empty on purpose (frostClass.COLD_BY_CROP_TYPE has no `succulent`: the slug also
-- holds hardy species), so the card is silent at every temperature. The live plan shows the switch:
-- its `crop` for these two read "succulent (Graptosedum)" / "succulent (Pachyphytum, moonstones)" (the
-- bundled entries) through 2026-08-22 and "succulent" (the database profile) from 2026-08-23 on. Neither
-- planting has ever had a cold card. There is no leaf-scope row on either planting.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE FIX
--
-- Dave, 2026-09-18: both get a bring-inside card at 40F. The value written is the bundled one,
-- COPIED, not re-decided: cadence-data-v2.json by_variety["Graptosedum"].cold and
-- by_variety["Pachyphytum"].cold at 1408ca046f43eb08e365b0ac3265643a12af29b6.
-- lambda/daily-plan/coldshadow.test.js parses both literals out of this file and fails if either stops
-- equalling the bundled entry.
--
-- SINGLE-KEY jsonb_set, never a whole-object replace (v5-heatrespcabbage-001, v5-frostband-001): the
-- 13 keys already on each row — the watering intervals, crop, notes, confidence, the _source marker —
-- stay byte-identical (gates.yml checks their md5). create_missing is TRUE because the key is ABSENT:
-- jsonb_set(profile, '{cold}', …, false) on a row without `cold` returns the row unchanged, so the
-- UPDATE would report "UPDATE 1" and write nothing (checked read-only on prod). The post receipts are
-- what tell "wrote the key" from "matched the row".
--
-- Keyed by care_profile row id AND its (scope, scope_id) pair, guarded on the key being absent: a
-- re-run matches nothing, and a cold block written later by anyone is never clobbered. care_profile
-- has no app write route and no triggers (so no audit actor to set), which makes this file the path
-- for it, not a bypass of one.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE EMAIL MOVES TOO, and that is the design, not a side effect to suppress. handler.js hands
-- frostClass.summarize a cadenceTenderFor built on the same resolveCadence, and a tender cold block
-- promotes an UNBANDED slug to tender (promotion-only: it never overrides a banded slug). `succulent`
-- is unbanded, so after the apply both plantings leave the "unclassified (treated as tender)" count and
-- are named as "succulents (2)". The trip temperatures do not move: an unbanded slug is counted in the
-- tender band either way (frostClass.UNKNOWN_BAND = 'tender'). The card and the email then agree.
--
-- LANDING ORDER: none. No code change; no column added or removed; nothing reads a key this adds
-- except coldFor and cadenceTenderFor, which already read it.
--
-- SAFETY: idempotent and non-clobbering. On a database without these rows (staging, if it does not
-- carry Dave's prod cultivars) both UPDATEs match zero rows and only the stamp is written, the safe
-- direction. On PROD both must print UPDATE 1: an UPDATE 0 there means the wrong host or a changed row —
-- stop and read the pre gates (neon-psql-env-local: a guarded UPDATE 0 reads like "already applied").
-- ROLLBACK: 0r-rollback.sql.

BEGIN;

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 40}'::jsonb, true),
       updated_at = now()
 WHERE id = 'bdbf05dd-0239-4ac0-b0d1-b0cbc816a62c'
   AND scope = 'cultivar' AND scope_id = 'f4919a6f-eb7e-4c03-bc0f-b158f8ef51fd'   -- Graptosedum
   AND NOT (profile ? 'cold');

UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": true, "protect_below_F": 40}'::jsonb, true),
       updated_at = now()
 WHERE id = '5a179436-7feb-4e3d-9f29-bbf5272b9414'
   AND scope = 'cultivar' AND scope_id = 'b3666254-9b71-478b-bf9e-2f2bb97dd8a9'   -- Pachyphytum
   AND NOT (profile ? 'cold');

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-coldshadow-001',
        'COLDSHADOW: BUG-COLDPROFILESHADOWSBUNDLED-001 (data-only, no DDL). Adds the `cold` key to two '
        'cultivar care_profile rows written by cadence-backfill-20260823 without one — Graptosedum '
        '(bdbf05dd) and Pachyphytum (5a179436) — with the value cadence-data-v2.json by_variety already '
        'carries for both (tender, protect below 40F). Their database profiles shadowed the bundled entry '
        'whole, so the bring-inside card was silent at every temperature. Single-key jsonb_set keyed by row '
        'id and guarded on the key being absent; every other key untouched. Dave decision 2026-09-18. '
        'Reversible via 0r.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
