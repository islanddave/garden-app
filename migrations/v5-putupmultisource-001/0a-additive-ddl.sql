-- 0a-additive-ddl.sql
-- V5-PUTUPMULTISOURCE-001 — BD-058. A put-up may draw on N sources, and the provenance of EACH ONE
--   is kept. Dave's cases, verbatim from the ledger: something made with both his tomatoes AND his
--   basil; a pesto combining his basil with one of his peppers; and a made item mixing garden-grown
--   with locally bought ingredients. His words: "right now, I can't log that in a way that
--   represents that and keeps the history for those things."
--   Canon: project-state/design-putup-programme-V100-20260828.md §7 (source model) + §3.3 (why this
--   was deferred, and the rule that dissolves the deferral).
--
-- SCOPE: ONE new table, four indexes, ten CHECKs. It does NOT touch preservation_log — no column,
--   no constraint, no index, no view, no trigger. See D1 for why that is a deliberate narrowing of
--   what V100 §9.2 proposed rather than an omission.
--
-- WHERE THIS SITS AMONG THE THREE PUT-UP AXES. BD-034 (method — HOW it was put up) shipped as the
--   19-value chk_preservation_log_method. BD-056 (category — WHAT IT IS) shipped as
--   crop_types.category, with bought goods made first-class by promoting them to crop_types rows
--   (v4-putupprov-002-fruitseed; `non_plant_food` carries 7 of them on live prod today). BD-058 is
--   the third axis — WHERE EACH PART CAME FROM — and it is the only one of the three that is
--   inherently many-per-jar, which is why it is the only one that needs a table instead of a column.
--   The other two axes stay exactly where they are. Nothing below re-litigates either.
--
-- DESIGN DECISIONS THIS DDL ENCODES:
--
--   * D1 — ZERO CHANGES TO preservation_log, which is a deliberate divergence from V100 §9.2.
--     That section proposed DROPPING chk_preservation_log_source_plant
--       (source_kind IS NULL OR source_kind='own_garden' OR plant_id IS NULL)
--     on the grounds that "the garden-plus-bought jar is a constraint violation today". It is not,
--     once the parent's source columns are read as a CACHE OF THE ORDINAL-0 SOURCE rather than as
--     the jar's only source. A basil-plus-pine-nuts pesto is stored as parent
--     source_kind='own_garden' + plant_id=<basil> (the ordinal-0 row) with the pine nuts on a child
--     row — which SATISFIES the CHECK. The combination the CHECK forbids, a vendor source_kind
--     sitting beside a garden plant_id, is incoherent AS A CACHE: one source is never both. So the
--     constraint is not merely survivable, it is the correct invariant for the cache and it is kept.
--     What that buys, all of it real and all of it avoided by not touching the parent:
--       (i)   v4-putupprov-001/gates.yml post_column_count_is_25 is a FROZEN COUNT gate, continuous,
--             run against live prod AND staging on every migrations/** push. Its own comment records
--             that three separate sessions have already failed to maintain the number. Adding a
--             parent column reds CI on every other migration before this one is even applied.
--       (ii)  v4-putupprov-001/gates.yml post_attribution_check_unchanged exists, in its own words,
--             to make "relax attribution for non-garden sources" impossible to land by accident.
--             V100 §9.2 notes its own widening would slip past that gate on a substring technicality
--             and says "do not let it". The cheapest way not to let it is not to need it.
--       (iii) post_all_five_source_checks_validated pins all five putupprov CHECKs as present AND
--             convalidated. Dropping one is a hand-edit to another migration's gate file.
--     A later cut that genuinely needs the parent widened can still do it; this one does not, so it
--     does not. Blast radius falls from "two parent CHECKs swapped + two parent columns added, under
--     three continuous gates in a directory this change does not own" to "one new empty table".
--
--   * D2 — display_label text NOT NULL IS THE KEYSTONE, and it is what retires the deferral.
--     V100 §3.3 records why this row sat `planned`: the 2026-08-24 draft's child table carried
--       chk_ps_identified CHECK (plant_id IS NOT NULL OR harvest_log_id IS NOT NULL OR ...)
--     with plant_id/harvest_log_id as ON DELETE SET NULL. A referential SET NULL is an UPDATE on the
--     child; that UPDATE is checked against table CHECKs; if the nulled column was the row's only
--     identifier the CHECK raises 23514 AND THAT ABORTS THE PARENT DELETE. A guard against
--     provenance loss becomes a lock on the harvest table.
--     The rule, from V100 §7.4, and every CHECK below obeys it:
--       >>> NO CHECK ON THIS TABLE MAY REFERENCE A COLUMN THAT A FOREIGN KEY CAN SET TO NULL. <<<
--     A mandatory free-text label makes the row self-identifying without reference to any FK, so
--     there is no predicate left for a SET NULL to break. chk_ps_garden_only does name plant_id and
--     harvest_log_id, and is safe in the only direction it can move: nulling them makes the
--     predicate MORE satisfiable, never less.
--     THIS IS ALSO A LIVE CI CONSTRAINT, not only a design principle. v4-evtanchordel-001/gates.yml
--     carries post_no_setnull_fk_inside_an_anchor_check — a CONTINUOUS, WHOLE-CLASS gate over every
--     table in public, which reds if any SET NULL FK column appears in a CHECK whose definition
--     matches '%IS NOT NULL) OR %'. The 2026-08-24 shape would have tripped it from a directory this
--     change does not own. chk_ps_garden_only renders as "... OR ((plant_id IS NULL) AND
--     (harvest_log_id IS NULL))" and does not match. post_ps_not_a_setnull_anchor_offender in
--     gates.yml re-asserts that locally so the coupling is visible from here.
--     AND IT BUYS MORE THAN A BUG FIX. The label is written once, at entry, in Dave's own words —
--     "Blueberries", "Cherry Falls", "pine nuts", "the farm stand plums". When a planting is later
--     deleted, merged or archived, THE LABEL SURVIVES: the jar still says where it came from in
--     words after the pointer is gone. ⚠ The trade is real and is not smoothed over here: a
--     denormalised label goes stale if the planting is renamed. That is judged correct for a jar,
--     which is a historical artefact recording what he said at the time, but it does diverge from
--     how every other surface in this app renders a planting name (V100 Q5, open).
--
--   * D3 — provenance_grade is STORED, NOT DERIVED, and the reason is the whole point of BD-058.
--     It looks derivable: plant_id IS NOT NULL ⇒ 'planting'. It is not, in the one case that
--     matters. After an ON DELETE SET NULL, a row that WAS planting-grade is indistinguishable from
--     one that was never better than crop-grade. Storing the grade preserves the difference between
--     "he never knew" and "he knew, and the planting is gone" — which is precisely the per-source
--     history the row exists to keep. It costs one text column and it cannot be recovered later.
--     Four values, coarsest to finest: origin < crop < planting < harvest.
--
--   * D4 — preservation_log_id is ON DELETE RESTRICT. REVISED 2026-09-07 (BUG-PUTUPSRCCASCADE-001)
--     after the original CASCADE reddened tests/integration/cascade-sweep.int.test.js on dev. The
--     original three arguments are kept below because two of them still hold and the third is the
--     reason the reversal is safe:
--       (i)   STILL TRUE — the app never hard-deletes a put-up. lambda/preservation/index.js:790-799
--             answers DELETE with `UPDATE preservation_log SET deleted_at = NOW()`. So RESTRICT is
--             equally unreachable from the product: this change costs the user nothing.
--       (ii)  STILL TRUE, AND NOW HANDLED — the integration suites DO hard-delete, parents first
--             (tests/integration/_cleanup.js). RESTRICT alone would 23503 that teardown, exactly as
--             the original note predicted. Fixed at the source rather than worked around: _cleanup.js
--             now deletes preservation_source BEFORE preservation_log, the same child-first step
--             share_log already carries there for the same reason (its RESTRICT to photos).
--       (iii) FALSE, and this is what settles it — kitchen_batch_input_batch_id_fkey is indeed
--             CASCADE, but kitchen_batch_input has NO deleted_at column (verified on live prod,
--             2026-09-07). The guard fires on CASCADE *into a table carrying deleted_at*, which is
--             precisely the axis on which the two differ. The sibling is not a precedent for this
--             table; preservation_source is the first to hold both.
--     Why not the guard's ALLOWED list instead: its stated criterion is "derived caches and closure
--     rows, rebuilt from live data, correct to die with their parent". A source row is user-entered
--     provenance — what went into this jar — and is rebuildable from nothing. Adding it there would
--     break the allowlist's own rule rather than take the exception it offers.
--     Soft-delete remains the product behaviour; deleted_at on this table mirrors the parent's so a
--     single source can be retracted without disturbing its siblings' ordinals — and RESTRICT is what
--     makes that column's promise true rather than decorative.
--
--   * D5 — plant_id and harvest_log_id are ON DELETE SET NULL, matching preservation_log's own two
--     (v4-archpreservguard-001 names both). Safe here only because of D2. variety_id and
--     crop_type_slug are NO ACTION, matching the parent's, because neither is ever deleted in
--     practice and a silent null there would lose the crop identity the label alone does not carry.
--
--   * D6 — NO TRIGGERS, and this is checked against live prod rather than copied from a sibling.
--     preservation_log itself carries ZERO triggers (pg_trigger, live, 2026-09-07), so updated_at on
--     this family is written by the Lambda, not by set_updated_at. More sharply: the shared
--     public.prevent_ownership_transfer() function still hard-codes OLD.created_by (live prosrc,
--     unchanged), and this table's owner column is user_id — mirroring preservation_log, not the
--     inventory/event family's spelling. Attaching that trigger here would reproduce
--     BUG-KBOWNERTRIGGER-001 exactly: every UPDATE raising 42703, INSERTs unaffected, and a mock-sql
--     test suite unable to see it. Ownership immutability is enforced in the handler instead.
--
--   * D7 — source_kind's vocabulary is the parent's EIGHT VALUES VERBATIM, not a new list.
--     Re-homed to the child at the correct cardinality so two ingredients can carry two different
--     vendors. Same widening doctrine as v4-putupprov-001: to add a value, WIDEN this CHECK
--     (DROP + ADD with the longer list). Do NOT drop it and go free-text — v4-source-freetext did
--     exactly that to plants.source_type on 2026-07-07 and the vocabulary fragmented. `other` plus a
--     mandatory label is the escape hatch that keeps the closed list safe: an unforeseen source never
--     blocks a save, so there is never schedule pressure to drop the CHECK.
--     NOTE the parent's chk_preservation_log_source_other (other REQUIRES a label) has no twin here
--     and needs none: display_label is NOT NULL for every row, so the requirement it enforces
--     conditionally is unconditional on this table.
--
--   * D8 — qty_unit CARRIES A CLOSED VOCABULARY, unlike preservation_log.quantity_unit.
--     BUG-PRESERVUNITNOCHECK-001 records that the parent's unit column is the only one in this
--     family with no CHECK at all, and V4-PUTUPPROV-003 deliberately left it that way because a
--     CHECK would 400 existing prefills. Neither reason reaches a table with no rows and no prefill
--     path. The list is chk_kbi_qty_unit's fourteen values verbatim — the sibling join table's, which
--     is the right precedent for "how much of an ingredient", and matching it exactly means an input
--     moved from a kitchen batch to a jar never needs its unit respelled. Note the space in 'fl oz'.
--
--   * D9 — ordinal is smallint NOT NULL DEFAULT 0 with a UNIQUE partial index per live parent.
--     Ordinal 0 is THE PRIMARY: it is the row the parent's cached source_kind / source_label /
--     plant_id / harvest_log_id / crop_type_slug mirror, and D1 depends on that mirroring being
--     exactly one row. The index is partial on deleted_at IS NULL so retracting a source frees its
--     ordinal for reuse. It is NOT a CHECK, so no FK can interact with it.
--
-- SAFETY / IDEMPOTENCY: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and every
--   ADD CONSTRAINT guarded by a NOT EXISTS lookup against pg_constraint (Postgres has no
--   ADD CONSTRAINT IF NOT EXISTS). Re-running the whole file is a clean no-op — the family contract
--   stated in v4-putup-001/0a's header. schema_version INSERT is ON CONFLICT DO NOTHING.
--   Every CHECK is BORN VALID on an empty table, so there is no NOT VALID / backfill / VALIDATE
--   dance and no 0c-validate.sql. NO DATA MIGRATION AND NO BACKFILL: the 5 live put-up rows keep
--   their parent columns and gain no source rows. A jar with zero source rows means "sources not
--   recorded", which is what every existing row honestly is; it never means "no sources".
--   ⚠ There is exactly ONE COMMIT in this file, at the end. A bare COMMIT anywhere inside escapes
--   the transaction wrapper the runner applies and is never written here.
--
-- APPLY ORDER: 0a is the only apply step. STAGING FIRST, then rehearse 0r and re-apply, then prod.
--   DDL MUST LAND BEFORE THE CODE IS PROMOTED — new handler SQL naming a table that does not exist
--   raises 42P01 on every sources request. gates.yml carries the full sequencing. The existing
--   put-up routes are untouched by this migration and keep working either way, which is what makes
--   the ordering merely required rather than delicate.
--
-- ROLLBACK: 0r-rollback.sql drops the table outright, which is lossless ONLY while it is empty.
--   See that file's header — it is the v4-putup-001 case (new empty relations), not the
--   v4-putupprov-001 case (a populated table whose columns carry the payload).

BEGIN;

-- ── 1. The table. ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.preservation_source (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- D4 (REVISED 2026-09-07 — see the decision block above). RESTRICT, not CASCADE.
  preservation_log_id uuid NOT NULL REFERENCES public.preservation_log(id) ON DELETE RESTRICT,

  -- Mirrors the parent's owner column, and is the spelling every predicate in the handler binds.
  -- NOT created_by (D6) — that spelling is the inventory/event family's and the shared ownership
  -- trigger is hard-coded to it.
  user_id             text        NOT NULL,

  -- D9. 0 = primary, mirrored to the parent's cached source columns.
  ordinal             smallint    NOT NULL DEFAULT 0,

  -- D7. Parent vocabulary verbatim. NOT NULL here, unlike the parent: a source row exists because
  -- someone named a source, so "unrecorded" is the ABSENCE of a row, never a row with a null kind.
  source_kind         text        NOT NULL,
  -- Vendor/place. Non-garden only; the handler nulls it on a flip to own_garden.
  source_label        text,

  -- D2. THE KEYSTONE. Always set, in the words the cook used. Never nulled by any foreign key.
  display_label       text        NOT NULL,

  -- D3. Stored, not derived: after a SET NULL it is the only record that a finer grade was known.
  provenance_grade    text        NOT NULL,

  -- The internal pointers. Each may be null; none of them identifies the row (D2).
  crop_type_slug      text        REFERENCES public.crop_types(slug),
  variety_id          uuid        REFERENCES public.plant_varieties(id),
  plant_id            uuid        REFERENCES public.plants(id)      ON DELETE SET NULL,
  harvest_log_id      uuid        REFERENCES public.harvest_log(id) ON DELETE SET NULL,

  -- How much of THIS source went in. Optional always — "some basil" is a legitimate record and a
  -- forced number would be invented. NULL pair means unrecorded, never zero.
  quantity_value      numeric(10,2),
  quantity_unit       text,

  note                text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz,
  deleted_at          timestamptz
);

COMMENT ON TABLE public.preservation_source IS
  'BD-058. The N sources of one put-up, one row each, heterogeneous: an internal planting/harvest reference OR a bought ingredient with no planting behind it. Ordinal 0 is the primary and is what preservation_log''s own source_kind/source_label/plant_id/harvest_log_id cache. Zero rows for a jar means sources were not recorded, never that it had none.';
COMMENT ON COLUMN public.preservation_source.display_label IS
  'What this ingredient was called, in the cook''s words. NOT NULL and never nulled by a foreign key: it is what identifies the row after a planting is deleted, and it is what keeps every CHECK on this table independent of the FK columns (see 0a header D2).';
COMMENT ON COLUMN public.preservation_source.provenance_grade IS
  'How finely the origin was known WHEN RECORDED: origin < crop < planting < harvest. Stored rather than derived so an ON DELETE SET NULL cannot make "he knew, and the planting is gone" look like "he never knew".';
COMMENT ON COLUMN public.preservation_source.ordinal IS
  '0 = primary. Unique per live parent (uq_ps_parent_ordinal). The parent row caches the ordinal-0 source, which is what lets chk_preservation_log_source_plant stay in force on a mixed garden/bought jar.';

-- ── 2. Constraints. Guarded, born valid on an empty table. ───────────────────────────────────────
-- ⚠ EVERY predicate below is independent of plant_id / harvest_log_id / variety_id / crop_type_slug
--   EXCEPT chk_ps_garden_only, which names them only in the SET NULL-safe direction (D2).
DO $$
BEGIN
  -- D7. Closed 8-value vocabulary, the parent's verbatim. Widen it, never drop it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_source_kind') THEN
    ALTER TABLE public.preservation_source ADD CONSTRAINT chk_ps_source_kind
      CHECK (source_kind IN (
        'own_garden','u_pick','farm_stand','csa','store','gift','foraged','other'
      ));
  END IF;

  -- D3. Four grades, coarsest to finest.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_provenance_grade') THEN
    ALTER TABLE public.preservation_source ADD CONSTRAINT chk_ps_provenance_grade
      CHECK (provenance_grade IN ('origin','crop','planting','harvest'));
  END IF;

  -- D2. The label is two-state: meaningful, or the row does not exist. NOT NULL is declared on the
  -- column; this blocks '' and '   ' fragmenting the ingredient list the way a blank vendor would.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_label_nonblank') THEN
    ALTER TABLE public.preservation_source ADD CONSTRAINT chk_ps_label_nonblank
      CHECK (btrim(display_label) <> '');
  END IF;

  -- Bounded at the DATABASE, not only in the validator: the Lambda Function URL is directly callable
  -- with a valid Clerk JWT, so the app is not the only writer. Same 120 as the parent's label.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_label_len') THEN
    ALTER TABLE public.preservation_source ADD CONSTRAINT chk_ps_label_len
      CHECK (char_length(display_label) <= 120);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_source_label_nonblank') THEN
    ALTER TABLE public.preservation_source ADD CONSTRAINT chk_ps_source_label_nonblank
      CHECK (source_label IS NULL OR btrim(source_label) <> '');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_source_label_len') THEN
    ALTER TABLE public.preservation_source ADD CONSTRAINT chk_ps_source_label_len
      CHECK (source_label IS NULL OR char_length(source_label) <= 120);
  END IF;

  -- D2/D5. THE ONE CONSTRAINT THAT NAMES AN FK COLUMN, and it names them only in the direction a
  -- SET NULL can move: nulling plant_id or harvest_log_id makes this MORE satisfiable, never less.
  -- A bought ingredient cannot carry a garden pointer — the child-level twin of the parent's
  -- chk_preservation_log_source_plant, at the cardinality that makes the mixed jar expressible.
  -- ⚠ Do NOT rewrite this as a disjunction of IS NOT NULL terms. The rendered definition would then
  -- match '%IS NOT NULL) OR %' and trip v4-evtanchordel-001's continuous whole-class gate.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_garden_only') THEN
    ALTER TABLE public.preservation_source ADD CONSTRAINT chk_ps_garden_only
      CHECK (source_kind = 'own_garden' OR (plant_id IS NULL AND harvest_log_id IS NULL));
  END IF;

  -- Both halves of a quantity, or neither. A number with no unit is not a quantity.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_qty_pairing') THEN
    ALTER TABLE public.preservation_source ADD CONSTRAINT chk_ps_qty_pairing
      CHECK ((quantity_value IS NULL) = (quantity_unit IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_qty_positive') THEN
    ALTER TABLE public.preservation_source ADD CONSTRAINT chk_ps_qty_positive
      CHECK (quantity_value IS NULL OR quantity_value > 0);
  END IF;

  -- D8. chk_kbi_qty_unit's fourteen values verbatim. Note the space in 'fl oz'.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_qty_unit') THEN
    ALTER TABLE public.preservation_source ADD CONSTRAINT chk_ps_qty_unit
      CHECK (quantity_unit IS NULL OR quantity_unit IN (
        'g','kg','oz','lb','count','cup','tbsp','tsp','fl oz','qt','gal','ml','l','other'
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_ordinal_nonneg') THEN
    ALTER TABLE public.preservation_source ADD CONSTRAINT chk_ps_ordinal_nonneg
      CHECK (ordinal >= 0);
  END IF;
END $$;

-- ── 3. Indexes. ─────────────────────────────────────────────────────────────────────────────────
-- The read path: every live source of one jar, in entry order.
CREATE INDEX IF NOT EXISTS idx_ps_parent
  ON public.preservation_source (preservation_log_id, ordinal, id)
  WHERE deleted_at IS NULL;

-- D9. One primary per jar, and one row per ordinal. Partial so a retracted source frees its slot.
-- A UNIQUE INDEX rather than a UNIQUE CONSTRAINT precisely because a constraint cannot be partial —
-- and because an index is invisible to the SET NULL/CHECK interaction D2 guards against.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_parent_ordinal
  ON public.preservation_source (preservation_log_id, ordinal)
  WHERE deleted_at IS NULL;

-- The provenance read that BD-058 exists for: "what has this planting gone into?" and the same for
-- a single pick. Partial on both live-ness and the FK so a deleted planting's rows leave the index.
CREATE INDEX IF NOT EXISTS idx_ps_plant
  ON public.preservation_source (plant_id)
  WHERE deleted_at IS NULL AND plant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ps_harvest
  ON public.preservation_source (harvest_log_id)
  WHERE deleted_at IS NULL AND harvest_log_id IS NOT NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-putupmultisource-001','PUTUPMULTISOURCE (BD-058): new table preservation_source — the N sources of one put-up, heterogeneous (internal planting/harvest OR a bought ingredient with no planting). ZERO changes to preservation_log: the parent''s source columns are re-read as a cache of the ordinal-0 source, which keeps chk_preservation_log_source_plant correct and in force on a mixed garden/bought jar and avoids three continuous gates in v4-putupprov-001''s directory (incl. the frozen post_column_count_is_25). display_label NOT NULL is the identity rule that retires the 23514 ON DELETE SET NULL deferral (V100 §3.3/§7.4) and keeps this table out of v4-evtanchordel-001''s whole-class setnull-in-anchor-check gate. provenance_grade stored not derived so a nulled FK cannot make "he knew, and the planting is gone" look like "he never knew". 10 born-valid CHECKs, 4 indexes incl. a partial unique on (preservation_log_id, ordinal). No triggers (preservation_log has none; prevent_ownership_transfer hard-codes created_by — BUG-KBOWNERTRIGGER-001). No backfill: the 5 existing put-ups gain no rows.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
