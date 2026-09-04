-- V5-PRESERVUNIT-001 — phase B: normalise the legacy plural spellings and NARROW the CHECK to the
-- canonical 12.
--
-- ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ ⛔ DO NOT APPLY THIS FILE IN THE SAME SITTING AS 0a. DO NOT APPLY IT UNTIL RELEASE R1 IS LIVE ║
-- ║    IN PROD.                                                                                  ║
-- ║                                                                                              ║
-- ║ R1 is defined in CODE-CHANGES-vocabmig-20260904.md in this directory. The three parts that   ║
-- ║ matter here:                                                                                 ║
-- ║   1. src/pages/PutUp.jsx UNIT_GROUPS emits the 12 CANONICAL singulars (not 'lbs'/'quarts').  ║
-- ║   2. src/pages/PutUp.jsx RowEditor renders a legacy stored value instead of a blank select.  ║
-- ║   3. lambda/preservation/index.js rejects an unlisted unit with a 400 before the DB sees it.  ║
-- ║                                                                                              ║
-- ║ Applying this against the CURRENT deployed bundle breaks put-ups in two ways at once:        ║
-- ║   * every NEW put-up 23514s — PutUp.jsx:855 defaults qtyUnit to 'lbs', which this file        ║
-- ║     forbids;                                                                                 ║
-- ║   * every EDIT and every one-tap "Mark used" on an unmigrated cached row 23514s — the         ║
-- ║     full-replace PUT (lambda/preservation/index.js:589-610) re-submits whatever spelling that ║
-- ║     bundle holds, and buildFullPayload (PutUp.jsx:1948) is the single choke point for the     ║
-- ║     decrement path.                                                                          ║
-- ║ Neither surfaces as an error a user can act on. The Lambda has no unit vocabulary today       ║
-- ║ (validateCommon:164 tests non-blank only), so a 23514 returns 500 and put()'s generic catch   ║
-- ║ renders "Couldn't update — try again." indefinitely.                                          ║
-- ║                                                                                              ║
-- ║ A NARROWING IS THE DANGEROUS DIRECTION AND MUST FOLLOW ITS WRITER. This is the inverse of a  ║
-- ║ widening (v4-putupmethod-001), which must PRECEDE its writer. Same invariant, opposite order: ║
-- ║     { values the constraint ACCEPTS } ⊇ { values the live writer EMITS }, at every instant.   ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- AUTHORISATION TO RUN THIS FILE is the `mid_*` block of gates.yml, not a calendar date. Run
-- `gate_runner.py --migration migrations/v5-preservunit-001 --phase sweep` after R1 has shipped and
-- read the mid gates; mid_r1_shipped_and_no_new_legacy_write is a MANUAL gate because no query can
-- see whether a service-worker-cached bundle is still alive somewhere.
--
-- ── WHY NORMALISE AND NARROW IN ONE TRANSACTION ──────────────────────────────────────────────────
-- ADD CONSTRAINT validates existing rows. A row still spelling 'quarts' aborts the ADD with 23514,
-- so the UPDATE has to precede it. Putting them in separate transactions would leave a window where
-- the rows are canonical but the constraint still admits the legacy spellings — harmless, but also
-- pointless, and a window is a thing someone has to remember to close. One transaction, one lock.
--
-- ── WHY THE UPDATE CAN RUN AT ALL ────────────────────────────────────────────────────────────────
-- Non-obvious and gated: 0a's CHECK is STILL ARMED while this UPDATE runs, and the UPDATE writes
-- 'qt', 'cup', 'lb' … . Those succeed only because 0a's union deliberately included the 12 canonical
-- values alongside the 10 legacy ones. Had 0a admitted only what writers emit today, this UPDATE
-- would 23514 against the constraint the same migration installed. mid_check_admits_canonical_before_narrowing
-- asserts that precondition rather than trusting it.
--
-- ── THE MAPPING ──────────────────────────────────────────────────────────────────────────────────
-- Nine plain depluralisations plus one substitution. 'quarts' → 'qt' and NOT 'quart': 'qt' is what
-- inventory_items_unit_check and chk_kbi_qty_unit both already spell it, so this is the spelling
-- that makes a cross-family roll-up work; 'quart' would be a fourth spelling of the unit that
-- already has three. lambda/daily-plan/ledger.js:89 accepts both prefixes today and is unaffected.
--
-- updated_at IS DELIBERATELY NOT TOUCHED. It means "the user changed this record", and no user
-- changed anything — the unit is the same unit, spelled the way the rest of the schema spells it.
-- Stamping it would misreport a data migration as an edit on the very rows whose provenance this
-- family exists to keep. preservation_log has no set_updated_at trigger (it is not in the 9-table
-- majority, per v5-inflightbatch-001/0a-additive-ddl.sql:181-184), so nothing does this implicitly.
-- The audit trail is the schema_version row written below.
--
-- SOFT-DELETED ROWS ARE INCLUDED, and that is not an oversight. A CHECK does not know about
-- deleted_at, so a soft-deleted row spelling 'quarts' would abort the ADD CONSTRAINT exactly as a
-- live one would. Every predicate here is therefore whole-table; the gates that are about LIVE rows
-- say `deleted_at IS NULL` explicitly, and the difference between the two is deliberate in both
-- directions.

BEGIN;

UPDATE public.preservation_log
   SET quantity_unit = CASE quantity_unit
         WHEN 'lbs'           THEN 'lb'
         WHEN 'cups'          THEN 'cup'
         WHEN 'pints'         THEN 'pint'
         WHEN 'quarts'        THEN 'qt'
         WHEN 'bushels'       THEN 'bushel'
         WHEN 'half-bushels'  THEN 'half-bushel'
         WHEN 'pecks'         THEN 'peck'
         WHEN 'flats'         THEN 'flat'
         WHEN 'jars'          THEN 'jar'
         WHEN 'bags'          THEN 'bag'
       END
 WHERE quantity_unit IN ('lbs','cups','pints','quarts','bushels','half-bushels','pecks','flats',
                         'jars','bags');

-- PostgreSQL cannot alter a CHECK in place, so this is a DROP + ADD under one ACCESS EXCLUSIVE lock.
-- The table is small (5 rows as recorded in v4-putupmethod-001's header), so the lock is
-- microseconds. The name is re-used so the constraint keeps its identity across both phases.
ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_quantity_unit;
ALTER TABLE public.preservation_log
  ADD CONSTRAINT chk_preservation_log_quantity_unit
  CHECK (quantity_unit IN (
    'lb','oz','count',
    'cup','pint','qt',
    'bushel','half-bushel','peck','flat',
    'jar','bag'
  ));

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-preservunit-20260904-narrow',
        'PRESERVUNIT-001 phase B (BUG-PRESERVUNITNOCHECK-001): normalise the 10 legacy plural '
        'quantity_unit spellings to their canonical singulars (quarts->qt to match '
        'inventory_items_unit_check and chk_kbi_qty_unit) and narrow '
        'chk_preservation_log_quantity_unit from 22 values to the canonical 12, in one transaction. '
        'A NARROWING: valid only after the release that stops the frontend emitting plurals. '
        'Suffix follows the two-phase precedent 4.63.0-rainbackfill-001-cachearms.',
        now())
ON CONFLICT (version) DO UPDATE
  SET description = EXCLUDED.description, applied_at = EXCLUDED.applied_at;

COMMIT;

-- Verify:
--   SELECT quantity_unit, count(*) FROM public.preservation_log GROUP BY 1 ORDER BY 1;
--     -- expect ONLY canonical values, across live AND soft-deleted rows
--   SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
--     JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
--    WHERE n.nspname='public' AND t.relname='preservation_log'
--      AND c.conname='chk_preservation_log_quantity_unit';   -- expect 12 values, no plurals
--   SELECT 1 FROM public.schema_version WHERE version='5.0.0-preservunit-20260904-narrow';
