-- V5-PUTUPCANDY-001 — widen chk_preservation_log_method from 18 values to 19 by adding `candy`.
--
-- WHY THIS EXISTS. The put-up method vocabulary has no value for candying. Its 18 values (mirrored
-- at lambda/preservation/index.js:36-52) name roasting, freezing, dehydrating, powdering, four
-- canning and pickling processes, fermenting, curing, cold storage, two dishes and an escape hatch —
-- and nothing for a confection. A repo-wide grep of src/, lambda/ and migrations/ returns zero
-- candy support of any kind. A candied batch therefore lands in 'other' or in a method it is not,
-- which is exactly the pathology the live rows already show: 2 of 5 are pesto filed as passata, and
-- the single 'other' row was a vinegar pickle (both measured on prod and recorded in
-- v4-putupmethod-001/0a-additive-ddl.sql:4-10).
--
-- AND IT IS NOT COSMETIC. v4-putupmethod-001/0a-additive-ddl.sql:21-25 established the hard rule for
-- this vocabulary: a method absent from SHELF_LIFE_MONTHS makes shelfLifeMonths() return null, which
-- makes defaultUseByTarget() return null, which leaves use_by_target NULL — and both the use-soon
-- route and the use_soon_count on every whats-put-up group then skip the row FOREVER. Dusted candy
-- at 2-3 weeks airtight at room temperature is by a wide margin the shortest-lived thing in this
-- vocabulary; the next shortest is quick_pickle's unprocessed fridge case at 2 months. It is
-- precisely the product that must not vanish from the surface that says "eat this".
--
-- ── THE PROCEDURE IS CANONICAL IN THIS HOUSE. IT IS NOT PUBLISHED GUIDANCE. ──────────────────────
-- Dave's own guide carries it: unsweet-watermelon-guide-V100-20260811.html, PART 6 · SOUR CANDIED
-- RIND (also at Projects/Gardening/library/public/guides/). It is a three-day staged-syrup method
-- plus 24-48 hours of drying, crucible-hardened, with the traditional-vs-invented provenance
-- separated in its own text. Its stated yield is "2 lb (900 g) prepped rind -> roughly 1 1/4 - 1 1/2
-- lb finished candy", i.e. a factor of 0.63-0.75. That factor is worth naming here because it is WHY
-- an input weight and an output weight legitimately differ by a third on the same batch — the shape
-- V5-INFLIGHTBATCH-001 already models with kitchen_batch_input.qty / is_byproduct on the way in and
-- preservation_log.quantity_value on the way out. Nothing in this file computes it; it is recorded
-- so a future reader does not mistake the difference for a data error.
--
-- ── PROVENANCE OF THE SHELF-LIFE NUMBER. READ THIS BEFORE TOUCHING SHELF_LIFE_MONTHS. ────────────
-- ⚠ `candy` WILL BE THE FIRST ENTRY IN SHELF_LIFE_MONTHS WITH NO PUBLISHED SOURCE, and that is a
-- change to that table's own stated contract rather than one more row in it. Its header says the
-- figures are cited "per boss-strategic safety note — these drive 'use soon' on stored FOOD and must
-- NOT be one-person hand-invented", and names NCHFP, the USDA Complete Guide to Home Canning, and
-- USDA "Freezing and Food Safety". No such source exists for this value.
--
-- THE NEGATIVE RESULT, from the food-safety research commissioned for this session
-- (project-state/_build-inflight-20260904/foodsafety-research.md §6.3, restated in §9.1): a search of
-- NCHFP, UGA, Penn State, OSU, UMN, USU, MSU and NC State found NO home-preservation guidance
-- covering candied-fruit endpoints, storage or shelf life. NCHFP's sugar-syrup material is about
-- canning syrups and states that syrup "does not prevent spoilage". §9.1 records the conclusion
-- flatly: "Candied products — no guidance to surface. There is nothing to cite."
--
-- SO THE ONLY SOURCE FOR THE NUMBER IS THE HOUSE GUIDE ABOVE, and it must be described that way
-- everywhere it appears — in the migration, at the table, and in any UI copy. It is a house
-- procedure's own storage note, not Extension guidance. Do NOT launder it into that table beside the
-- NCHFP-derived rows as though it shared their provenance; the whole point of that table's citation
-- discipline is that a reader can tell which figures are published and which are not.
--
-- WHY IT SHIPS ANYWAY, when `smoke` was DROPPED from v4-putupmethod-001 for the same missing
-- citation. The two cases differ in what exists to fall back on: `smoke` had no published figure AND
-- no house procedure AND a shelf life the migration called "genuinely storage- and cure-dependent",
-- so there was nothing to write down; the remedy chosen there was to fix the misleading form
-- placeholder instead. Candy has no published figure but DOES have a crucible-hardened house
-- procedure that states storage times for two distinct product forms, and it is a documented part of
-- the practice this column exists to record. That is a WEAKER citation, not an equivalent one. If
-- Dave would rather hold the value until a real source exists, deferring is a one-line change:
-- remove 'candy' from the list below. That choice is his, and it is recorded here so it stays
-- visible rather than being settled by the fact that this file was already written.
--
-- THE ADJACENT ANCHOR, AND WHAT IT DOES NOT SAY. The best-evidenced neighbouring standard is the
-- jam/jelly one, >=65% soluble solids (65 Brix). The research marks that figure well-established and
-- the water-activity mapping around it (~0.75-0.82) WEAKLY SOURCED — secondary and commercial only,
-- unverifiable at a primary source. The one primary-ish anchor (UC Master Food Preserver) says a
-- 55 wt.% sugar solution reaches a_w ~0.91, which is the MOST-BACTERIA threshold and nowhere near
-- the ~0.60-0.70 needed to stop moulds. The consequence for this value is specific and is the reason
-- the room-temperature figure must not be generous: a candied product can be well past any pathogen
-- risk and STILL be a mould substrate, so the sugar hurdle answers "is it dangerous" and says
-- nothing at all about "will it keep". Those are the two questions a use-by date is asked to answer
-- and this one can only honestly answer the second, badly.
--
-- ── THE LIMITATION THIS FILE CANNOT FIX, STATED RATHER THAN SMOOTHED OVER ────────────────────────
-- SHELF LIFE ATTACHES TO THE FINISH STEP AND TO THE STORAGE CONDITION, NOT TO THE PROCESS — and
-- those are TWO independent axes, converging from two independent directions. The house guide gives
-- the first: one candying batch produces outputs whose keeping times differ by an order of magnitude,
-- decided by what happened in the last ten minutes rather than by the method. The research gives the
-- second (foodsafety-research.md §6.2, §9.2): across the corpus, storage life for a dried or
-- sugar-preserved food is keyed to the storage CONDITION and to a completion determination made by
-- some other means — NCHFP's own dried-fruit bands are "1 year at 60F, 6 months at 80F", i.e. the
-- same food with a 2x spread on temperature alone, and its endpoint is texture-tested rather than
-- time-tested. A per-method constant is the one shape that can express neither axis.
-- The four house figures:
--   * undusted, frozen                 ~6 months   (guide Part 5: "Candied rind, uncoated ... ~6
--                                                   months"; Part 6: "undusted 6 months frozen")
--   * dusted, airtight, room temp      2-3 weeks   (guide Part 6 yield line)
--   * malic-forward dust               shortest    ("Eating it this week. Tastes best, weeps worst")
--   * tartaric-forward "storage dust"  longest of the dusted set ("Anything that has to sit in a jar
--                                                   for weeks"; least hygroscopic of the four acids)
-- The guide's freeze-and-finish-later plan makes this the NORMAL case, not an edge one: freeze an
-- undusted parent, then finish portions of it on different days with different dusts. Its own
-- labelling instruction — "note the parent date plus which dust you used" — is that fact written
-- down in the physical world.
--
-- A SINGLE PER-METHOD SHELF_LIFE_MONTHS CONSTANT CANNOT EXPRESS THAT. The table is keyed
-- method x storage_kind, so it can separate frozen from room-temperature (and this change uses that
-- to carry the 6-month and the short figure separately), but it CANNOT separate two room-temperature
-- outputs of one batch that differ only by which dust was used. Nor can it express 2-3 weeks at all:
-- its unit is whole months and addMonths() takes an integer, so the shortest expressible non-zero
-- horizon is 1 month, which OVERSTATES the house figure of 2-3 weeks by about a week.
--
-- `pantry: 1` IS THE MECHANISM'S FLOOR, NOT A DERIVED THIRTY-DAY ANSWER, and it is chosen as the
-- shortest value that is neither an alarm nor a disappearance. The alternatives are each worse in a
-- named way:
--   * 0 months  -> use_by_target = the put-up date, so the row reads "past use by" on day one. A
--                  card that reddens for a thing that is fine teaches the user that red means
--                  nothing (the ruling is explicit in _crucible-inflight-20260903's contract).
--   * null      -> no use_by_target, invisible to use-soon forever. That is the exact failure this
--                  migration exists to prevent, so it cannot be the answer to it.
--   * 2 or more -> a plausible-looking number with nothing behind it. There is no published source
--                  to round toward (§6.3), so any figure above the floor is invention.
-- Nobody may later read `pantry: 1` as a sourced 30-day claim. It errs LONG against a house figure,
-- on a product the research shows can sit past pathogen risk and still grow mould, so it is a
-- ceiling on how long the app will stay quiet — never a statement that the candy is good for a month.
--
-- THE RIGHT SHAPE IS A PROMPT, NOT AN ASSERTION, and that is the research's own structural finding
-- rather than a preference (§9.3): every affordance the published corpus supports is "either a
-- prompt to go do something or a clock that starts after someone else has made the determination.
-- Not one of them is an assessment of the batch." So the code spec asks for exactly that on a candy
-- row — prefill use_by_target from this default, label it visibly as a house estimate, and let the
-- cook set the real date — instead of silently computing a use-by the corpus cannot back. That turns
-- an unsourceable assertion into a question, which is the one move that is defensible here.
-- CODE-CHANGES-vocabmig-20260904.md §2 carries it.
--
-- PROPOSED, NOT BUILT — the per-output attribute that would fix it properly. Two nullable columns on
-- preservation_log, both write-once at close-out and neither in PRESERVATION_EDITABLE_COLUMNS:
--   finish_kind      text  -- 'undusted' | 'malic' | 'citric' | 'tartaric' | 'blend' | free label
--   shelf_life_days  int   -- when set, OVERRIDES the months table for this row only
-- Days is the minimum granularity that can say "18 days". The per-output STRUCTURE already exists —
-- V5-INFLIGHTBATCH-001's preservation_log.batch_id fans one kitchen_batch out to N preservation_log
-- rows, so "one batch, four outputs, four different use-by dates" is already representable today.
-- Only the shelf-life AXIS is missing. Deliberately out of scope here: a column with no writer is
-- inert, the writer is the batch close-out route another lane is building this week, and adding an
-- unused column to preservation_log is how a vocabulary change turns into a schema change nobody
-- reviewed. Note also that use_by_target is ALREADY per-row and user-overridable (L6), so a cook who
-- knows the real date can enter it by hand today; what is missing is the prompt.
--
-- ── WHY ONE VALUE AND NOT TWO ────────────────────────────────────────────────────────────────────
-- `candy_syrup` was CONSIDERED AND DEFERRED. Step 8 of the procedure keeps the drained syrup as a
-- real product ("watermelon-rind syrup for sodas and cocktails and it freezes fine"), and the house
-- guide gives a figure for it (Part 5: "Agua fresca / juice / syrup ... 6-12 months") — but that is
-- the same house-only provenance as the candy figure, and NCHFP's sugar-syrup material explicitly
-- says syrup "does not prevent spoilage" (foodsafety-research.md §6.3), so a second unsourced entry
-- would compound the precedent rather than reuse it. It is deferred on that ground and on the one
-- this vocabulary already set: v4-putupmethod-001 dropped `salsa` and `juice` because "neither
-- appears in Dave's request or his data". Nothing here asks for syrup and no live row is one. The
-- deferral is recorded so the next reader does not have to re-derive it, and post_no_syrup_value in
-- gates.yml is the standing assertion that it stayed deferred.
--
-- SPELLED `candy` TO MATCH chk_kitchen_batch_kind, AND THE TWO MUST STILL NEVER BE AUTO-MAPPED.
-- V5-INFLIGHTBATCH-001 put 'candy' in the batch-KIND vocabulary and its header states the axes are
-- "DIFFERENT ... deliberately and permanently: one mash batch legitimately outputs both hot_sauce
-- and ferment_mash jars. The app must never auto-map one vocabulary to the other." That still holds
-- and a candying batch is the sharpest example of it: one `candy` batch outputs candy AND syrup AND,
-- on the guide's own commonest non-ideal result, a chewy confection that closes as
-- `put_up_different`. The shared spelling is for the human reading both tables, not a join key. Do
-- not write code that derives one from the other.
--
-- ── A WIDENING IS WRITE-SAFE BUT NOT READ-SAFE ───────────────────────────────────────────────────
-- Same finding as v4-putupmethod-001, and it is why the parity test exists. DROP + ADD of a strict
-- superset cannot break an old writer: every value a stale bundle can send still passes. What it
-- breaks is a READER that enumerates the vocabulary, and there are five outside this file, none of
-- which errors on a value it has never seen — each degrades silently in a different direction
-- (enumerated in src/__tests__/putUpMethodParity.test.js's header; the worst is PutUp.jsx's
-- METHOD_GROUPS, where an unmapped stored method makes the row editor's <select> show the wrong
-- option and a save REWRITES the method). All five must move in the same change. See
-- ../v5-preservunit-001/CODE-CHANGES-vocabmig-20260904.md §2 for the file-by-file spec, INCLUDING
-- the change to the parity test itself, which currently reads its expected vocabulary out of
-- v4-putupmethod-001/0a-additive-ddl.sql and will go RED the moment the Lambda gains a 19th value
-- this file's existence does not tell it about.
--
-- ORDERING: MIGRATION FIRST, THEN THE CODE. A widening is safe EARLY and unsafe LATE, the exact
-- inverse of the narrowing in V5-PRESERVUNIT-001's 0b. Ship the code first and every attempt to save
-- a candied batch is a 23514 the UI cannot explain; apply the CHECK first and the only effect is a
-- constraint permitting a value nothing sends yet — inert. Within the code release, the LAMBDA half
-- must not trail the FRONTEND half: the picker offering an option the API rejects is a dead control
-- that 400s. Full sequence in gates.yml.
--
-- SAFETY: DROP + ADD is required because PostgreSQL cannot alter a CHECK in place. The new
-- constraint is a strict superset of the live 18-value one, so it is born valid — no NOT VALID, no
-- VALIDATE step, and no existing row can fail it. The sweep gate measures that rather than assuming
-- it. The DROP-to-ADD window is inside one transaction and takes an ACCESS EXCLUSIVE lock on
-- preservation_log; the table is 5 rows, so that is microseconds.

BEGIN;

ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_method;
ALTER TABLE public.preservation_log ADD CONSTRAINT chk_preservation_log_method
  CHECK (method IN (
    'roast_freeze','whole_freeze','blanch_freeze','dehydrate','powder','passata',
    'can_water_bath','can_pressure','jam_preserve','ferment','cure_store','cold_store',
    'purchased_preserved',
    'quick_pickle','pesto','hot_sauce','ferment_mash',
    -- V5-PUTUPCANDY-001. Sugar-preserved confection: the staged-syrup candying method, whose
    -- canonical procedure is unsweet-watermelon-guide-V100-20260811.html Part 6. Passes the strict
    -- axis test that pesto and hot_sauce failed — it names a PROCESS that genuinely changes how long
    -- the food keeps (2-3 weeks dusted at room temperature against 6 months undusted frozen), rather
    -- than naming a dish. Its SHELF_LIFE_MONTHS entry is a hard precondition, not a nicety, and is
    -- specified in ../v5-preservunit-001/CODE-CHANGES-vocabmig-20260904.md §2 — with every figure
    -- taken from that HOUSE guide and from no published source, because none exists (see the
    -- provenance block in this header before changing any of them).
    'candy',
    'other'
  ));

-- schema_version.description is NOT NULL with no default — omitting it fails the apply
-- mid-transaction.
--
-- DATE-ANCHORED VERSION STRING, and the reason is a live problem rather than a style preference:
-- v5-inflightbatch-001 writes '4.110.0-inflightbatch-001', and v4.110.0 has since SHIPPED without it
-- (public/releases.json, 2026-09-03 — the F1-hybrid seed-saving warning), so that string now
-- attributes a schema change to a release that does not contain it. An app-version prefix is a claim
-- about a release, and a migration authored before its release lands cannot honestly make one. A
-- date cannot collide with a version number, past or future. Shape follows the newest in-repo
-- precedent, '5.0.0-heatrespcabbage-20260902' and '5.0.0-cueinstrument-20260902'.
INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-putupcandy-20260904',
        'PUTUPCANDY-001: widen chk_preservation_log_method from 18 to 19 values, adding `candy` — '
        'sugar-preserved confection, the one process in Dave''s published practice with no value in '
        'this vocabulary. DROP+ADD because PG cannot alter a CHECK in place; a strict superset of '
        'the live constraint, so it is born valid and no existing row can fail it. Applied BEFORE '
        'the code that offers it: a widening is safe early and unsafe late. PROVENANCE WARNING: '
        '`candy` will be the FIRST SHELF_LIFE_MONTHS entry with NO PUBLISHED SOURCE. The session '
        'food-safety research (project-state/_build-inflight-20260904/foodsafety-research.md 6.3, '
        '9.1) searched NCHFP, UGA, Penn State, OSU, UMN, USU, MSU and NC State and found NO home '
        'guidance on candied-fruit endpoints, storage or shelf life — "there is nothing to cite". '
        'The figures therefore come from Dave''s own house guide '
        '(unsweet-watermelon-guide-V100-20260811.html Part 5/6: 6 mo undusted frozen; 2-3 weeks '
        'dusted at room temperature) and must never be described as Extension-backed. pantry:1 is '
        'the months-table FLOOR, not a derived 30-day figure, and errs LONG. It ships anyway because '
        'a method absent from that table yields no use_by_target and vanishes from use-soon forever, '
        'which for the shortest-lived product in the vocabulary is the worst available failure; the '
        'contrary precedent is `smoke`, dropped from v4-putupmethod-001 for a missing citation, and '
        'the difference is that candy has a house procedure and smoke had nothing. Deferring is a '
        'one-line change if Dave prefers. KNOWN LIMITATION, recorded not fixed: shelf life attaches '
        'to the FINISH step and the STORAGE CONDITION, not the process, so one batch spans ~3 weeks '
        'to ~6 months across its outputs and a per-method constant cannot express it; the per-output '
        'attribute that would is proposed in the 0a header and deliberately not built, and the code '
        'spec asks the UI to PROMPT for use_by_target on a candy row rather than assert one. '
        'candy_syrup considered and deferred (no request, no data, same unsourced provenance).',
        now())
ON CONFLICT (version) DO UPDATE
  SET description = EXCLUDED.description, applied_at = EXCLUDED.applied_at;

COMMIT;

-- Verify:
--   SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
--     JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
--    WHERE n.nspname='public' AND t.relname='preservation_log'
--      AND c.conname='chk_preservation_log_method';        -- expect 19 values incl. 'candy'
--   SELECT 1 FROM public.schema_version WHERE version='5.0.0-putupcandy-20260904';
