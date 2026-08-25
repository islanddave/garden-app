-- 0a-additive-ddl.sql
-- V4-PUTUPTAXONOMY-001 (BD-034) — widen chk_preservation_log_method by four values.
--
-- WHY THIS EXISTS. Dave's complaint is that the "how did you put it up" list forces his practice
-- into ill-fitting buckets, and he named three gaps himself: PESTO ("arguably fits sauce but really
-- does not"), HOT SAUCES, and FERMENTATION MASHES. The data agrees with him. Of five live put-up
-- rows (VERIFIED, prod, this session): two are pesto filed as `passata`, and the single `other` row
-- is method_other_text = 'Vinegar dill pickles' — a vinegar pickle is not a `ferment` (no lactic
-- culture) and not necessarily `can_water_bath` (a fridge pickle is never processed), so a
-- food-safety-distinct process is currently living in the escape hatch.
--
-- A WIDENING IS WRITE-SAFE BUT NOT READ-SAFE — the whole reason this migration ships with a parity
-- test attached. DROP + ADD of a strict superset cannot break an old writer: every value the
-- deployed bundle can send still passes. What it CAN break is a READER that enumerates the
-- vocabulary, and there are five of those outside this file, none of which errors on an unknown
-- value — each degrades silently in a different direction (see src/__tests__/putUpMethodParity.test.js,
-- which is the guard, and the reader enumeration in its header, which is the argument). The design
-- brief's core safety claim, "every Phase-1 constraint change is a widening, so it cannot break an
-- old writer", verifies as TRUE and INCOMPLETE; this comment is the missing half.
--
-- THE HARD PRECONDITION EACH NEW VALUE HAD TO CLEAR: a cited SHELF_LIFE_MONTHS entry. Adding a
-- method without one is not a neutral omission — shelfLifeMonths() returns null for an unlisted
-- method (lambda/preservation/index.js:76-81), which yields no use_by_target, and use-soon then
-- never surfaces the row. This is already happening: the 'Vinegar dill pickles' row is the only one
-- of five with use_by_target IS NULL (VERIFIED, prod). Four uncited methods would have taken that
-- from one-in-five to five-in-nine. Every figure added alongside this migration is DERIVED from a
-- source already cited in that file (NCHFP / USDA Complete Guide to Home Canning / USDA "Freezing
-- and Food Safety"), never freshly invented — the derivation is stated per value at the table.
--
-- WHY FOUR AND NOT SIX. `smoke` was considered and DEFERRED: the form's own placeholder says
-- "e.g. smoked" (PutUp.jsx), so it suggests a method it does not offer — but smoked-food shelf life
-- is genuinely storage- and cure-dependent and this session could not source a defensible figure.
-- Shipping it uncited would have violated the precondition above, so the placeholder is being fixed
-- instead, which closes the same trap without inventing a food-safety number. `salsa` and `juice`
-- were considered and dropped for want of evidence — neither appears in Dave's request or his data.
--
-- ORTHOGONALITY, RECORDED RATHER THAN SILENTLY RESOLVED. On the strict axis test — "does this value
-- change how long it keeps or whether it is safe?" — quick_pickle passes cleanly and pesto/hot_sauce
-- do not: they name a DISH, and frozen pesto keeps exactly as long as anything else frozen. They
-- ship anyway because Dave named them and because the method field is what HE reads back six months
-- later; BD-034 says the mis-fit IS the complaint. The tension is real and is on the record here
-- rather than being decided silently in either direction.
--
-- SAFETY: DROP + ADD is required because PostgreSQL cannot alter a CHECK in place. The new
-- constraint is a strict superset of the live one (VERIFIED against prod: the live definition is
-- exactly the 14 values below minus the four being added), so it is born valid — no NOT VALID, no
-- VALIDATE step, and no possible existing row that fails it. The window between DROP and ADD is
-- inside one transaction and takes an ACCESS EXCLUSIVE lock on preservation_log; the table has 5
-- rows, so that is microseconds.

BEGIN;

ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_method;
ALTER TABLE public.preservation_log ADD CONSTRAINT chk_preservation_log_method
  CHECK (method IN (
    'roast_freeze','whole_freeze','blanch_freeze','dehydrate','powder','passata',
    'can_water_bath','can_pressure','jam_preserve','ferment','cure_store','cold_store',
    'purchased_preserved',
    -- BD-034. Vinegar pickling: not a ferment (no culture), not necessarily processed. Already the
    -- only method='other' row in prod.
    'quick_pickle',
    -- BD-034, named by Dave. 2 of 5 live rows are pesto currently filed as passata.
    'pesto',
    -- BD-034, named by Dave. Pepper is the #2 harvested crop and no method named its obvious product.
    'hot_sauce',
    -- BD-034, named by Dave: an UNFINISHED intermediate, still working, not a finished preserve.
    'ferment_mash',
    'other'
  ));

INSERT INTO public.schema_version (version, description)
VALUES ('4.40.0-putupmethod-001','PUTUPMETHOD-001 (BD-034): widen chk_preservation_log_method from 14 to 18 values, adding quick_pickle, pesto, hot_sauce and ferment_mash. DROP+ADD because PG cannot alter a CHECK in place; strict superset of the live constraint so it is born valid — no NOT VALID, no VALIDATE, no existing row can fail it (5 live rows, all on pre-existing values). Evidence: the single method=other row in prod is method_other_text=''Vinegar dill pickles'' and 2 of 5 rows are pesto filed as passata. Each new value ships with a SHELF_LIFE_MONTHS entry DERIVED from a source already cited in lambda/preservation/index.js — an uncited method silently yields no use_by_target and vanishes from use-soon, which already affects 1 of 5 live rows. A widening is WRITE-safe but NOT READ-safe: five readers enumerate this vocabulary and none errors on an unknown value, so all five are updated in the same change and bound by src/__tests__/putUpMethodParity.test.js. smoke/salsa/juice considered and deferred — no citable shelf life / no evidence.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
