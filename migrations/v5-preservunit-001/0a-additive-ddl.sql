-- V5-PRESERVUNIT-001 (BUG-PRESERVUNITNOCHECK-001) — phase A: give preservation_log.quantity_unit a
-- vocabulary. THE PERMISSIVE ONE. Read the sequencing block before applying anything in this
-- directory.
--
-- ⚠ THIS DIRECTORY IS TWO APPLIES SEPARATED BY A DEPLOY. Applying 0a and 0b in one sitting BREAKS
--   PROD. 0b must not be applied until a specific frontend + Lambda release has shipped. The whole
--   argument is in 0b's header; the short form is in the sequence below.
--
-- WHY THIS EXISTS. quantity_unit is `text NOT NULL` with NO CHECK of any kind — the only unit column
-- in its family without a vocabulary. Its siblings both have one: harvest_log.unit carries
-- harvest_log_unit_check ('lb','oz','kg','g','count','bunch','cup','head' — 8 values, singular,
-- migrations/v1-2a-2/0a-additive-ddl.sql:47) and inventory_items.unit carries
-- inventory_items_unit_check ('each','packet','oz','fl oz','lb','gal','qt','bag','roll','sheet',
-- 'other' — 11 values, singular, mirrored at src/lib/inventoryEnums.js:53 and
-- lambda/inventory-items/index.js:70). This column's own DDL comment claims it "mirrors
-- harvest_log.unit" (v4-putup-001/0a-additive-ddl.sql:84). It does not. It mirrors the SHAPE and not
-- the VOCABULARY, and PutUp.jsx:112 has said so in the source since the units audit.
--
-- THE DRIFT IS ALREADY LIVE, and it is a three-way disagreement, not a two-way one. Recorded in this
-- repo rather than measured by this file: preservation rows store PLURAL 'quarts'/'cups'
-- (v5-inflightbatch-001/0a-additive-ddl.sql:246-248, and the fixtures at
-- src/__tests__/PutUpFromPlanting.test.jsx:117-167); the put-up picker writes PLURAL
-- ('lbs','cups','quarts','jars' — PutUp.jsx UNIT_GROUPS:122-128); harvest_log writes SINGULAR
-- ('cup','head','bunch','count'); inventory_items writes 'qt' where preservation says 'quarts'.
-- So the same physical unit has up to three spellings across three tables, and any join or roll-up
-- across the families compares incomparable strings. lambda/daily-plan/ledger.js:89 already carries
-- a `u.startsWith('quart') || u.startsWith('qt')` normaliser — a downstream consumer paying the cost
-- of this drift today.
--
-- ── ARMING A CHECK IS A DEPLOY, NOT A SCHEMA CHANGE ──────────────────────────────────────────────
-- The invariant, stated the way v4-harvbasis-sample-001/gates.yml states it, holding at every
-- instant and in both directions:
--
--     { values the constraint ACCEPTS }  ⊇  { values the live writer EMITS }
--
-- The still-deployed bundle emits PLURAL. This is a PWA: after any promote, a loaded tab keeps its
-- old bundle until reload, and a service-worker-cached bundle can emit 'quarts' for as long as it
-- lives. Two writers make that unavoidable rather than rare:
--   * the create form — PutUp.jsx:855 `useState(prefill.quantity_unit || 'lbs')`, so EVERY new
--     put-up sends 'lbs' by default;
--   * the full-replace PUT — lambda/preservation/index.js:589-610 assigns
--     `quantity_unit = ${body.quantity_unit}` UNCONDITIONALLY, fed by buildFullPayload
--     (PutUp.jsx:1948), which is the single choke point for the one-tap "Mark used" decrement. An
--     unrelated tap re-submits the row's stored spelling.
-- Arm a CHECK that forbids 'quarts' and both of those 23514 inside the transaction. The Lambda has
-- no unit vocabulary to catch it first (validateCommon:164 only tests non-blank), so the constraint
-- violation surfaces as a 500, which put()'s generic catch renders as "Couldn't update — try again."
-- forever — the exact undiagnosable-save-failure shape already documented as a fixed bug at
-- PutUp.jsx RowEditor:2096-2103.
--
-- ── WHY THE OBVIOUS ORDER (NORMALISE, THEN ARM) IS THE WRONG ONE ─────────────────────────────────
-- Rewriting the stored rows to 'qt' BEFORE the UI knows that spelling is not neutral either. The row
-- editor is a controlled `<select>` built from UNIT_GROUPS (PutUp.jsx:2130) seeded with
-- `useState(rec.quantity_unit || 'lbs')` (:2092). A stored value matching no <option> leaves the
-- select with selectedIndex -1 — it renders BLANK. The stored value survives an untouched save
-- (state still holds it, and Mark-used bypasses the editor entirely via buildFullPayload), so this
-- is a visible defect rather than the silent rewrite the METHOD_GROUPS case produces — but any user
-- who touches that blank control must pick a PLURAL value, which the narrowed CHECK would then
-- refuse. Normalising early buys nothing and costs a broken control on every row.
--
-- ── THE SEQUENCE. FIVE STEPS, AND STEPS 1 AND 4 ARE DIFFERENT SITTINGS ───────────────────────────
--   1. APPLY 0a (this file) — staging then prod. Arms the 22-value UNION below. NO CODE DEPENDENCY:
--      it is a strict superset of everything any live writer can emit, so nothing breaks and nothing
--      needs to ship first. This is the step that closes BUG-PRESERVUNITNOCHECK-001's literal
--      complaint — the column stops being free text.
--   2. SHIP RELEASE R1 (frontend + Lambda, other lanes). Spec: CODE-CHANGES-vocabmig-20260904.md
--      in this directory. Lambda gains VALID_UNITS = the same 22-value union (so a bad unit is a 400
--      naming the field, not a 500); PutUp.jsx UNIT_GROUPS switches to the 12 CANONICAL singulars
--      with a display-layer pluraliser; RowEditor tolerates a legacy stored value instead of
--      rendering blank.
--   3. SOAK until no NEW write carries a legacy spelling. There is no clean signal for a drained
--      service-worker population; the honest check is the mid gate in gates.yml plus elapsed time.
--   4. APPLY 0b — staging then prod. Normalises the legacy rows and narrows the CHECK to the 12
--      canonical values, in ONE transaction. THIS STEP IS DESTRUCTIVE TO OLD BUNDLES. Do not reach
--      it in the same sitting as step 1.
--   5. SHIP RELEASE R2 (optional hygiene) — narrow the Lambda's VALID_UNITS to 12 and drop the
--      RowEditor legacy tolerance. Nothing breaks if this never happens; the DB is already the
--      binding gate by then.
--
-- ── THE TARGET VOCABULARY, AND WHY IT IS SINGULAR ────────────────────────────────────────────────
-- Canonical is SINGULAR. Three of the four unit columns in this schema already are — harvest_log
-- (8), inventory_items (11), and kitchen_batch_input's chk_kbi_qty_unit (14, authored 2026-09-03 in
-- v5-inflightbatch-001 explicitly so as NOT to inherit this column's drift). preservation_log's
-- plural is the outlier, one table against three, and the integration suite already writes singular
-- into it (31 × 'lb', 2 × 'pint', 1 × 'oz', 1 × 'jar' across tests/integration/preservation*.js).
-- 'quarts' resolves to 'qt' rather than to 'quart' because 'qt' is what inventory_items and
-- kitchen_batch_input both already spell it; 'quart' would invent a fourth spelling of the one unit
-- that already has three.
--
-- THIS ANSWERS THE OBJECTION THAT KILLED THE CHECK THE FIRST TIME, rather than ignoring it.
-- PutUp.jsx:109-117 records the earlier decision — "STILL NO DB CHECK ON quantity_unit, and that is
-- now a considered decision rather than an omission" — on two grounds: a CHECK pinned to the plural
-- pick-list "would 400 any future harvest-to-put-up prefill that copies harvest_log.unit, and would
-- also break 31 integration writes of 'lb'". Both dissolve against a SINGULAR target: 'lb', 'oz',
-- 'count', 'pint' and 'jar' are all canonical here, so all 34 integration writes survive phase B
-- untouched, and every value mapHarvestUnit (src/lib/putUpPrefill.js:30-45) can produce maps onto a
-- canonical value. That comment's closing instruction — "reconciling the two vocabularies is its own
-- piece of work and must not be smuggled into a units addition" — is what this directory IS. It is
-- not smuggled into anything.
--
-- ── WHAT THE UNION ADMITS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────
-- The 22 values below are exactly (12 canonical) ∪ (10 legacy plurals). Nothing else. In particular:
--   * NO 'other'. chk_preservation_log_method's escape hatch already demonstrated the cost — the one
--     live method='other' row meant two unrelated things until V4-PUTUPTAXONOMY-001 split it. A unit
--     column with no free-text path from the app (every write comes from a dropdown) does not need
--     one, and an escape hatch here would re-open the free-text hole this migration closes.
--   * NO 'kg'/'g'. mapHarvestUnit refuses to convert them precisely so an inferred poundage is never
--     written as fact (putUpPrefill.js:23-26); admitting them here would give that guess a
--     destination.
--   * NO 'fl oz'/'gal'/'tbsp'/'tsp'/'ml'/'l', which chk_kbi_qty_unit carries. Nothing writes them to
--     this column and no picker offers them. A vocabulary padded with values nothing emits is a
--     vocabulary that asserts nothing.
--
-- CREATED VALIDATED, NOT `NOT VALID`. The union is a strict superset of every spelling any writer
-- can produce, so no existing row can fail it and there is nothing to defer. Per
-- v5-varietyhybridflag-001's finding, NOT VALID buys nothing here and leaves a permanent
-- convalidated=false a later reader cannot distinguish from "known violators exist". The sweep gate
-- measures the superset claim against live data before this file runs, rather than assuming it.

BEGIN;

-- The name follows the family's chk_<table>_<column> idiom (chk_preservation_log_method,
-- chk_preservation_log_attribution), NOT the auto-generated <table>_<column>_check spelling that
-- harvest_log and inventory_items carry. 0b re-uses this name, so the constraint's identity survives
-- the narrowing and pg_get_constraintdef stays the single place to read the live vocabulary.
--
-- Written as `IN (...)` terminated by `));` deliberately: that is the exact shape
-- src/__tests__/putUpMethodParity.test.js::checkConstraintValues extracts from, so a units parity
-- test can reuse the extractor unchanged. NOTE for whoever writes it — that extractor's value regex
-- is /'([a-z_]+)'/g and will silently MISS 'half-bushel' and 'half-bushels'; it needs a hyphen in
-- the character class. A regex that skips two values would certify parity it never checked.
ALTER TABLE public.preservation_log
  ADD CONSTRAINT chk_preservation_log_quantity_unit
  CHECK (quantity_unit IN (
    -- ── CANONICAL (12). The phase-B target. Every one of these is already emitted by some live
    --    writer or is the singular of one that is, so none is speculative.
    'lb','oz','count',
    'cup','pint','qt',
    'bushel','half-bushel','peck','flat',
    'jar','bag',
    -- ── LEGACY (10), admitted BY THIS PHASE ONLY. Each is a plural spelling the deployed bundle
    --    still emits; each is dropped by 0b once nothing emits it. They are listed separately and
    --    labelled so that a reader diffing 0a against 0b sees a deliberate contraction rather than
    --    ten values that look accidentally lost.
    'lbs','cups','pints','quarts',
    'bushels','half-bushels','pecks','flats',
    'jars','bags'
  ));

-- schema_version.description is NOT NULL with no default — omitting it fails the apply
-- mid-transaction.
--
-- THE VERSION STRING IS DATE-ANCHORED AND CARRIES NO CLAIM ABOUT A RELEASE. Two reasons, and the
-- second is a live problem in this repo: (a) this migration deliberately spans two applies separated
-- by a deploy, so no single app version owns it and an app-version prefix would be a false claim by
-- construction; (b) v5-inflightbatch-001 writes '4.110.0-inflightbatch-001', and v4.110.0 has since
-- SHIPPED without it (public/releases.json, 2026-09-03, the F1-hybrid warning) — so that string now
-- attributes a schema change to a release that does not contain it. A date suffix cannot collide
-- with any version number, past or future. Shape follows the newest in-repo precedent,
-- '5.0.0-heatrespcabbage-20260902' and '5.0.0-cueinstrument-20260902'.
INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-preservunit-20260904',
        'PRESERVUNIT-001 phase A (BUG-PRESERVUNITNOCHECK-001): arm chk_preservation_log_quantity_unit '
        'over the 22-value UNION of the 12 canonical singular units and the 10 legacy plural '
        'spellings the deployed bundle still emits. Closes the free-text hole on the one unit column '
        'in its family with no vocabulary. A strict superset of every live writer, so it is born '
        'valid and needs no code to ship first. Phase B (0b) normalises the legacy rows and narrows '
        'to the canonical 12, and MUST NOT be applied until the release specified in '
        'CODE-CHANGES-vocabmig-20260904.md is live in prod.',
        now())
ON CONFLICT (version) DO UPDATE
  SET description = EXCLUDED.description, applied_at = EXCLUDED.applied_at;

COMMIT;

-- Verify:
--   SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
--     JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
--    WHERE n.nspname='public' AND t.relname='preservation_log'
--      AND c.conname='chk_preservation_log_quantity_unit';
--   SELECT quantity_unit, count(*) FROM public.preservation_log
--    WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC;   -- expect only union members
--   SELECT 1 FROM public.schema_version WHERE version='5.0.0-preservunit-20260904';
