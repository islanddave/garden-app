-- V4-CROPTYPEALIAS-002 — Dave answers three of the eight held alias decisions.
--
-- DATA ONLY. No DDL: crop_types.search_aliases already exists (v4-croptypealias-001, prod v4.64.1).
-- Three rows change. Nothing else is touched, and display_name is not touched at all.
--
-- ── WHAT THIS IS ────────────────────────────────────────────────────────────────────────────────
-- v4-croptypealias-001 populated 54 rows and deliberately left EIGHT crop types without an alias,
-- because in each case the obvious synonym is wrong, collides, or is a categorisation question
-- rather than a naming one. Its own header said those eight "stay his open decision", and three
-- gates were written to stop a later session tidying them up on its own initiative.
--
-- Dave was walked through all eight on 2026-08-29 and answered. THREE get an alias; FIVE stay NULL.
-- This migration is that answer, and it MUST also move the gates that were holding the door shut —
-- otherwise the gate corpus would be asserting the absence of a decision that has now been made.
--
-- ── THE THREE, AND WHY EACH IS SAFE ─────────────────────────────────────────────────────────────
--   thunbergia    -> 'black-eyed susan vine'
--       The BARE 'black-eyed susan' is Rudbeckia, a different plant, which is exactly why 001 held
--       it. The full common name 'black-eyed susan vine' IS this plant and collides with nothing:
--       measured on prod, zero other crop_types display_name or search_aliases contains 'vine'
--       adjacent to susan. Note the search predicate is substring ILIKE, so q='black-eyed susan'
--       still reaches this row through the longer string — the precise form is strictly better than
--       the bare one, not a weaker version of it.
--   cilantro      -> 'coriander'
--       Correct, and 001's stated objection was that substring matching also reaches culantro and
--       vietnamese_coriander. Dave's call: those extra hits are wanted. They are genuinely
--       coriander-flavoured herbs, so q=coriander returning all three is the search finding MORE of
--       what was meant rather than something wrong. This is a deliberate widening, not an oversight.
--   winter_squash -> 'butternut, acorn squash, pumpkin'  (APPEND — the row already had an alias)
--       The pumpkin half was a categorisation question, not a naming one. Dave's call: pumpkins are
--       winter squash and a search for pumpkin should surface the family. This row is ALREADY in the
--       54, so the alias-bearing row count goes 54 -> 56, NOT 57 — the two new rows are thunbergia
--       and cilantro. Measured on prod before writing.
--
-- ── THE FIVE THAT STAY NULL — still Dave's, still gated ─────────────────────────────────────────
--   marigold   'calendula' is Calendula officinalis, a different genus from Tagetes. Typing calendula
--              would return plants that are not calendula — the search would be actively wrong.
--   jade       'money plant' collides head-on with the EXISTING money_plant crop type (Lunaria).
--   delphinium 'larkspur' is Consolida, a neighbouring genus.
--   endive +   chicory/escarole/frisee overlap two Cichorium species ACROSS BOTH ROWS, so one word
--   radicchio  lands on two crops at once.
--   carnation  'dianthus' is the genus and is broader than the plant.
--
-- ── GATE CHANGES THAT RIDE WITH THIS ────────────────────────────────────────────────────────────
-- Three gates in v4-croptypealias-001/gates.yml encoded "Dave has not decided". They are amended in
-- the same commit, because leaving them would red the continuous invariant sweep on BOTH envs the
-- moment this applies:
--   post_alias_row_count               54 -> 56
--   post_excluded_eight_have_no_alias  drops cilantro + thunbergia -> post_excluded_six_have_no_alias
--   post_pumpkin_not_smuggled_into_any_alias  RETIRED and INVERTED -> post_pumpkin_is_winter_squash_only
-- The inversion matters: that gate existed to catch a session quietly appending 'pumpkin'. The
-- replacement still catches that — it pins pumpkin to EXACTLY ONE row — it just no longer asserts
-- zero. Deleting it outright would have removed the guard along with the obsolete expectation.
--
-- ── APPLY TO BOTH ENVIRONMENTS ──────────────────────────────────────────────────────────────────
-- Prod AND staging. Integration CI forks its ephemeral Neon branch from STAGING and applies no
-- migrations. Staging carries 98 crop_types to prod's 150, so the row-count gate stays env:prod.
--
-- MEASURED, not assumed — and one of the three is NOT on staging:
--   prod    150 crop_types, 54 alias-bearing. thunbergia NULL, cilantro NULL,
--           winter_squash 'butternut, acorn squash'.  -> after: 56 alias-bearing.
--   staging  98 crop_types, 31 alias-bearing. cilantro NULL, winter_squash 'butternut, acorn squash',
--           and THUNBERGIA DOES NOT EXIST AT ALL.     -> after: 32 alias-bearing.
-- That asymmetry is why the per-slug receipt gate for thunbergia carries env:prod. Its UPDATE simply
-- matches zero rows on staging, which is harmless — but a gate asserting the value there would fail
-- forever. An earlier draft of this header claimed all three slugs were present on staging; that was
-- written before the check and was wrong. Corrected after measuring both environments.

BEGIN;

-- thunbergia: NULL -> the precise common name. Guarded on IS NULL so a re-run cannot double-write
-- and cannot clobber a value someone set in between.
UPDATE public.crop_types
   SET search_aliases = 'black-eyed susan vine'
 WHERE slug = 'thunbergia'
   AND deleted_at IS NULL
   AND search_aliases IS NULL;

-- cilantro: NULL -> 'coriander'. Same IS NULL guard.
UPDATE public.crop_types
   SET search_aliases = 'coriander'
 WHERE slug = 'cilantro'
   AND deleted_at IS NULL
   AND search_aliases IS NULL;

-- winter_squash: APPEND pumpkin to the existing value. Matched on the exact prior string rather than
-- IS NULL, so this is idempotent (a second run matches nothing) and cannot silently overwrite a
-- different value if one is ever set.
UPDATE public.crop_types
   SET search_aliases = 'butternut, acorn squash, pumpkin'
 WHERE slug = 'winter_squash'
   AND deleted_at IS NULL
   AND search_aliases = 'butternut, acorn squash';

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.67.0-croptypealias-002',
        'V4-CROPTYPEALIAS-002 — Dave answered three of the eight alias decisions held open by '
        'v4-croptypealias-001 (walked through 2026-08-29). thunbergia -> ''black-eyed susan vine'' '
        '(the BARE ''black-eyed susan'' is Rudbeckia, which is why 001 held it; the full common name '
        'is this plant and collides with nothing, and substring ILIKE means the short form still '
        'reaches it). cilantro -> ''coriander'' (Dave accepted that substring matching also surfaces '
        'culantro and vietnamese_coriander — they are genuinely coriander-flavoured herbs, so those '
        'hits are wanted). winter_squash -> appended ''pumpkin'' to its existing ''butternut, acorn '
        'squash'' (a categorisation call, not a naming one: pumpkins ARE winter squash). FIVE stay '
        'NULL and stay Dave''s: marigold (calendula is a different genus), jade (''money plant'' '
        'collides with the existing money_plant/Lunaria row), delphinium (larkspur is Consolida), '
        'endive+radicchio (Cichorium overlap lands one word on two crops), carnation (dianthus is '
        'the genus, broader than the plant). Alias-bearing row count 54 -> 56, not 57: winter_squash '
        'already carried an alias and was already counted. Three gates in v4-croptypealias-001 moved '
        'in the same commit — the row count, the excluded-eight list (now six), and the pumpkin gate, '
        'which was INVERTED rather than deleted so it still catches a stray append. Apply to staging '
        'as well as prod; integration CI forks from staging and applies no migrations.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
