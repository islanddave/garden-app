-- V5-HEATRESPONSEDISPLAY-001 — correct the cabbage heat_response before it is surfaced to a reader.
--
-- NOT APPLIED. Written, gated and committed unapplied; the orchestrator owns the apply decision.
--
-- THE DEFECT IS HORTICULTURAL, not a typo. Three cabbage cultivar care_profile rows carry
-- "heat causes bolting". Cabbage bolting is VERNALIZATION — flowering induced by sustained COLD on a
-- plant past its juvenile stem diameter, expressed later when it warms. Heat does not cause it. What
-- heat actually does to a cabbage is loosen the head, raise the split risk and make prompt cutting
-- the right move. The old string therefore pointed a reader at shade cloth for a plant that wanted
-- harvesting, and V5-HEATRESPONSEDISPLAY-001 is the change that puts these strings in front of a
-- human for the first time — which is why the correction lands before the surface, not after.
--
-- SCOPE, measured read-only on prod 2026-09-02: exactly three care_profile rows carry the string,
-- all scope='cultivar', all crop_type_slug='cabbage', resolving to 3 live plantings.
--   48c55703-8ddf-46bf-a7e9-7187319d1046  Cabbage (unknown)   _seeded:true          (care-cadence-001-seed.sql)
--   622ad02d-7f06-4bc6-a0bb-e0ca0943257c  Copenhagen Market   cadence-backfill-20260823
--   691c2afb-f950-497f-88ff-c6398c732265  Red Acre            cadence-backfill-20260823
-- Only the first has a source file in this repo. Correcting cadence-data-v2.json alone would leave
-- two of Dave's three cabbages still asserting the wrong cause, which is why this migration exists.
--
-- SINGLE-KEY UPDATE, NEVER A FULL-OBJECT REPLACE. jsonb_set touches the 'heat_response' key and
-- nothing else, so every other key on the row survives byte-identically — the watering intervals,
-- the cold block, confidence, notes, the _seeded / _source provenance markers the seededgate view
-- reads, and any overwintering / suppression key a later writer may have added. A
-- `SET profile = '{...}'::jsonb` here would silently drop whatever this file's author did not think
-- to re-type, which is exactly how care_profile edits have gone wrong before. The post gates below
-- assert the key SET is unchanged and that only heat_response moved.
--
-- MATCHED ON THE OLD VALUE, not on a scope_id list. That makes it self-limiting (a second run
-- matches zero rows), keeps it from clobbering a hand-edit someone made in the meantime, and means
-- it corrects any future cultivar that inherits the same wrong sentence.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data-fix.sql
-- Apply to BOTH staging and prod. Reverse: 0r-rollback.sql.

BEGIN;

UPDATE public.care_profile
   SET profile = jsonb_set(
         profile,
         '{heat_response}',
         to_jsonb('>85F daily; heat loosens heads and worsens splitting; harvest promptly; afternoon shade; bolting here is cold-triggered (vernalization), not heat'::text),
         false),
       updated_at = now()
 WHERE scope = 'cultivar'
   AND profile->>'heat_response' = '>85F daily; heat causes bolting; afternoon shade';

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-heatrespcabbage-20260902',
        'HEATRESPCABBAGE: correct the cabbage heat_response on three cultivar care_profile rows '
        'ahead of V5-HEATRESPONSEDISPLAY-001 surfacing heat_response as display prose. The old '
        'string asserted heat-caused bolting; cabbage bolting is vernalization (cold), so it sent a '
        'reader to shade a plant that needed cutting. Targeted jsonb_set on the heat_response key '
        'only - no other key on any row is read or rewritten. Matched on the old value, so it is '
        'idempotent and cannot clobber a later hand-edit.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
