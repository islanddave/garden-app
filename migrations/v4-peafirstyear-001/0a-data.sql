-- V4-PEAFIRSTYEAR-001 — crop_types slug='pea': first_year_harvest NULL -> true.
--
-- DATA ONLY. No DDL, no view, no constraint change, no deploy. One column on one row.
--
-- ── WHAT IS WRONG ────────────────────────────────────────────────────────────────────────────────
-- Verified against prod Neon 2026-08-28:  slug=pea | first_year_harvest=NULL | default_lifecycle=annual
--
-- sowEngine.js `sowGoal()` answers "is this sowing FOR a harvest this season, or to establish a
-- crown for next year?" — and the answer sets the season-length clamp. Its ladder is:
--     1. (grown_as ?? lifecycle) === 'annual'      -> 'harvest'
--     2. first_year_harvest === true / false       -> 'harvest' / 'establishment'
--     3. dtm > 200, FIRST_YEAR_HARVEST_CROPS, HARVEST_TEXT_RE over prose
--     4. default                                    -> 'establishment'
--
-- Rungs 1 and 2 both read from v_sow_candidates, and rung 1 reads `v.lifecycle` — the CULTIVAR's
-- column, NOT the crop type's default. That is the whole defect: crop-derive.js:198 resolves the
-- lifecycle chip as `cultivar.lifecycle ?? ct.default_lifecycle`, but sowGoal has no equivalent
-- fallback. So `crop_types.pea.default_lifecycle = 'annual'` does NOT reach rung 1, and a pea
-- cultivar whose own lifecycle is NULL falls straight past rung 2 as well.
--
-- What catches it today is rung 3 — HARVEST_TEXT_RE matching the words "for a fall harvest" inside
-- the cultivar's own sow_notes prose. MEASURED 2026-08-28 on the Sandia intake: 'Oregon Sugar Pod'
-- (7943ecf7-5777-46d7-bcf7-b9e12d54d374) reached 'harvest' by that route and no other. Reword that
-- sentence and peas silently become 'establishment', which swaps the clamp to FF-35 and treats a
-- snow pea as an overwintering crown. A sowing rule that depends on the phrasing of a paragraph is
-- not a rule.
--
-- ── WHY PEA WAS LEFT NULL, AND WHY THAT IS NOT A REASON TO LEAVE IT ─────────────────────────────
-- Not an oversight to be embarrassed about, and worth stating so nobody "re-fixes" it backwards.
-- v4-sowfirstyear-001/0a seeded TRUE for 28 slugs under the heading "Vegetables whose
-- default_lifecycle is biennial/perennial are the whole point of the flag — without it the engine
-- treats them as year-2 ornamentals." Pea is already default_lifecycle='annual', so by that framing
-- it needed nothing. The framing was right about crop types and wrong about cultivars: the flag is
-- the ONLY rung that survives a cultivar with a NULL lifecycle, which is exactly what an intake
-- creates (see V4-INTAKE-001 — intake deliberately does not write cultivar.lifecycle so it can
-- track the crop default).
--
-- This is NOT the inference the seed migration warned against ("Guessing here would put inference
-- in a column the engine reads as fact"). A pea is eaten the same season it is sown; there is no
-- ambiguity to guess at, which is the same standard under which 'carrot' and 'beet' are TRUE.
--
-- CONTRADICTION CHECK (the bee_balm trap, L-372 family): grepped the whole gate corpus, word-
-- boundary, excluding peach/pepper/repeat. ZERO gates anywhere reference 'pea'. The two gates that
-- pin deliberate NULLs name only garlic + shallot (v4-sowfirstyear-001::post_garlic_and_shallot_
-- left_null) and garlic + shallot + lemon_verbena (v4-croptype-002::pre_deliberate_nulls_are_null).
-- Nothing is being overturned.
--
-- ── ENVIRONMENT ASYMMETRY — READ BEFORE INTERPRETING A GREEN STAGING RUN ────────────────────────
-- THE 'pea' CROP TYPE DOES NOT EXIST ON STAGING. Measured 2026-08-28: staging holds 98 crop_types
-- and its only pea-like slugs are peach, pear and pepper. So on staging this UPDATE matches zero
-- rows and every violation-count gate below is vacuously 0. That is why the positive receipt gate
-- carries `env: prod` and `continuous: false`, exactly as v4-rapinidtm-001 does for the Rapini row
-- staging also lacks. A green staging run proves nothing here and must not be read as coverage.
--
-- BLAST RADIUS. One row, one column, in a table the engine reads. It cannot move the lifecycle chip
-- (crop-derive prefers cultivar.lifecycle) and it cannot change any cultivar whose own lifecycle or
-- grown_as is already 'annual' — those short-circuit at rung 1 and never consult this flag.
--
-- SO THIS CHANGES NOTHING TODAY, AND THE HONEST VERSION OF THAT IS WORTH WRITING DOWN. Prod has
-- FIVE pea cultivars and ALL FIVE now carry lifecycle='annual': Cascadia, Iona, Progress #9 and
-- Wando always did, and Oregon Sugar Pod — the Sandia intake row, the one that exposed this whole
-- problem by reaching 'harvest' purely through its prose — had lifecycle set to 'annual' by hand
-- earlier on 2026-08-28, before this migration was written. Measured immediately before apply:
-- zero pea cultivars with a NULL lifecycle. Every one of them short-circuits at rung 1.
--
-- The value is therefore ENTIRELY FORWARD-LOOKING, and it is real: V4-INTAKE-001 deliberately does
-- not write cultivar.lifecycle at intake (so the chip can track the crop default), which means the
-- NEXT pea packet entered through the app lands with a NULL lifecycle and walks straight back into
-- the prose dependency. The hand-fix on one row does not survive the next intake; this does.
-- Do not read a green post-apply gate as evidence that behaviour moved — see the vacuity note on
-- post_null_lifecycle_peas_have_a_crop_level_answer in gates.yml.
--
-- Does NOT fix the underlying asymmetry — sowGoal still has no crop-level lifecycle fallback, so
-- any OTHER annual crop type whose cultivars carry a NULL lifecycle has the same latent hole. That
-- is the general fix and it is a code change, tracked separately; this migration closes the one
-- crop measured to be exposed.

BEGIN;

UPDATE public.crop_types
   SET first_year_harvest = true,
       updated_at         = now()
 WHERE slug = 'pea'
   AND deleted_at IS NULL
   AND first_year_harvest IS DISTINCT FROM true;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.63.3-peafirstyear-001',
        'PEAFIRSTYEAR: crop_types slug=pea — first_year_harvest NULL -> true. sowGoal() reads the '
        'CULTIVAR lifecycle from v_sow_candidates and has no crop-default fallback (unlike '
        'crop-derive.js:198), so a pea cultivar with a NULL lifecycle skipped rungs 1 and 2 of the '
        'ladder and reached ''harvest'' only via HARVEST_TEXT_RE matching the words "for a fall '
        'harvest" in its own sow_notes prose — measured on Oregon Sugar Pod 2026-08-28. Rewording '
        'that sentence would have silently reclassified peas as ''establishment'' and clamped the '
        'sow window to FF-35. Not a guess: a pea is eaten the season it is sown, the same standard '
        'under which carrot and beet are TRUE. Data only, no DDL, no deploy. PROD-ONLY EFFECT — the '
        'pea crop type does not exist on staging (98 crop_types, only peach/pear/pepper), so every '
        'violation-count gate is vacuous there and the receipt gate is env:prod/continuous:false. '
        'Does not move the lifecycle chip and cannot affect the 4 pea cultivars already carrying '
        'lifecycle=annual, which short-circuit before this flag is read.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
