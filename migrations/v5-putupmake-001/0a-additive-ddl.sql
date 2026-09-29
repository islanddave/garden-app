-- 0a-additive-ddl.sql
-- schema_version: 5.0.0-putupmake-001
--
-- V5-PUTUPMAKE-001 — Put-Up release 1b ("Put it up"), the database half. One file, one transaction,
--   the stamp written inside it. Plan: project-state/_crucible-pantry-20260928/04-design-final.md
--   (V4), the data-model section for release 1b, as amended by 05-release-train.md §6 ("1b" and
--   "All B releases"). The line above is machine-read by the train step in
--   .github/workflows/integration-test.yml; keep it the second line and keep it equal to the INSERT
--   at the bottom.
--
-- THE STAMP IS FIXED: '5.0.0-putupmake-001'. Never edit it after the first apply anywhere (05 §2.8):
--   every standing gate in gates.yml self-arms on it, so a re-minted stamp silently disarms them all.
--
-- ⚠ NO BACKFILL IN THIS FILE. use_by_basis is born NULL on every existing row and stays NULL until
--   0p-post-deploy-backfill.sql runs — which is only after verify-deploy shows B's Lambda live. While
--   the basis is NULL the basis/date CHECK below is vacuous, which is what lets release 1a's writer
--   (the deployed one when this lands on prod) keep editing dates on those rows.
--
-- WHY THE DEPLOYED 1a WRITER IS UNAFFECTED (the house rule: every CHECK armed here is tested against
--   the writer that is live when it lands — README.md carries the measured proofs). Each change here
--   is exactly one of:
--     (a) a RELAXATION of an existing CHECK, kept under its own name (attribution, method_other,
--         kitchen_batch start_precision and kind_other, kitchen_stage_log stage_kind, kitchen_batch_input
--         kind and qty_unit) — admits a strict superset of what it admitted before;
--     (b) a CHECK over a column 1a never writes (every new column) — vacuous for 1a;
--     (c) an arming 1a already satisfies: remaining_count <= package_count (1a's legacy PUT moves
--         remaining with a changed count and refuses below 0 — promote A must be live first), the unit
--         union (the deployed picker's 14 spellings are all inside it), kitchen_stage_log.amount_unit
--         (1a validates against 14 of these 25), the quantity pairing (1a always writes both), and the
--         storage_location UNIQUE (1a answers its 23505: POST finds the place, PUT says place_exists).
--   A NOT VALID constraint is never the remedy here: every CHECK below is created VALIDATED, so a
--   live row that would violate one aborts the whole transaction. gates.yml's sweep measures that
--   first (L-058), and README's two pre-checks run immediately before each apply.
--
-- NAMES KEPT, AND ONE PREMISE CORRECTED (05 §6, review3 data-schema-architect's MINOR on names):
--   * chk_preservation_log_quantity_value — UNTOUCHED. `quantity_value > 0` is already NULL-safe
--     (a CHECK passes on NULL), so the nullable pair needs no rewrite of it.
--   * chk_kitchen_batch_start_pairing — UNTOUCHED. Its biconditional holds unchanged for the two new
--     precision words (season, year are dated words, like month).
--   * chk_preservation_log_attribution / chk_preservation_log_method_other — relaxed IN PLACE (DROP +
--     ADD under the same name, one statement) with the label leg. The attribution CHECK names neither
--     source_kind nor batch_id (v4-putupprov-001's post_attribution_check_unchanged pins the first).
--   * chk_preservation_log_quantity_unit — CREATED, not widened. The plan (and review3) assumed
--     v5-preservunit-001 phase A had put it on the column. It had not: measured read-only 2026-09-29,
--     neither prod nor staging carries the '5.0.0-preservunit-20260904' stamp or any CHECK naming
--     quantity_unit. The statement is DROP IF EXISTS + ADD, so it widens in place if phase A ever lands
--     first and creates the constraint otherwise; the end state is the same 35-value union either way,
--     and 0r restores whichever state it found (by that stamp).
--   * The quantity pairing is the NEW chk_preservation_log_quantity_pairing — the exact name release
--     1a's restated gate (v5-preservunit-001 post_quantity_never_recorded_without_its_unit) requires,
--     validated, naming both columns.
--
-- FOREIGN KEYS — ON DELETE is stated on every FK this file creates:
--   * preservation_log.batch_id: SET NULL -> NO ACTION (name kept). put_up_stage_id implies batch_id
--     (chk_preservation_log_put_up_stage_batch), so a SET NULL fired by a batch hard delete would
--     23514 inside the RI trigger on a put-up jar — the anchor-delete class that
--     v4-evtanchordel-001's LIKE patterns cannot see in an implication CHECK. NO ACTION refuses the
--     delete instead. No app path hard-deletes a batch.
--   * kitchen_batch_input.batch_id: CASCADE -> NO ACTION, in the SAME statement that adds its
--     deleted_at — v4-cascadesweep-001 forbids CASCADE from any table carrying deleted_at.
--   * kitchen_stage_log.batch_id STAYS CASCADE (v5-inflightbatch-001 post_stage_log_fk_is_cascade; a
--     stage row is part of its batch). The table gains no deleted_at, so the sweep does not reach it.
--   * New: preservation_log.put_up_stage_id -> kitchen_stage_log(id) NO ACTION (the simple FK: a NULL
--     batch_id would switch the composite off under MATCH SIMPLE) plus the same-batch composite
--     (put_up_stage_id, batch_id) -> kitchen_stage_log(id, batch_id) NO ACTION;
--     kitchen_stage_log (batch_id, voids_id) -> (batch_id, id) NO ACTION (NO ACTION, not RESTRICT: a
--     batch hard delete removes the void and the voided row in one statement, and NO ACTION checks at
--     the end of it); kitchen_batch_input plant_id -> plants SET NULL (no CHECK names plant_id, so
--     the SET NULL can never 23514), preservation_log_id and output_id -> preservation_log NO ACTION,
--     crop_type_slug -> crop_types NO ACTION, (batch_id, put_up_stage_id) -> kitchen_stage_log
--     (batch_id, id) NO ACTION.
--
-- TRIGGERS on preservation_log (it carried none before this file):
--   * set_updated_at — the family's shared BEFORE UPDATE stamp.
--   * prevent_preservation_log_ownership_transfer -> public.prevent_kitchen_batch_ownership_transfer(),
--     the user_id variant, reused unchanged. NOT public.prevent_ownership_transfer(): its body reads
--     OLD.created_by, and this table's owner column is user_id — attaching it would raise 42703 on
--     every UPDATE (BUG-KBOWNERTRIGGER-001). gates.yml asserts every OLD./NEW. column the function
--     names exists on the table.
--   * trg_audit_preservation_log_upd -> public.audit_stmt_update(...), statement-level with both
--     transition tables, watching exactly storage_location_id, use_by_target, use_by_basis,
--     package_count, remaining_count, label, is_raw, in_oil, deleted_at. No INSERT or DELETE arm
--     (v4-harvestaudit-001 post_no_insert_arm_was_added).
--
-- v_kitchen_batch_current — CREATE OR REPLACE (the ACL survives; no GRANT here): the 30 live columns
--   in their order, then kitchen_batch's one new column appended. Every stage LATERAL skips void rows
--   and rows a void points at, and orders entered_at DESC NULLS LAST, created_at DESC, id DESC; the
--   legacy current_stage_* LATERAL reads only the five shipped kinds; current_storage_location_id has
--   its own LATERAL (newest row that has a location, so a later check-in no longer blanks it);
--   input_count skips soft-deleted lines; the pH LATERAL keeps ph_read_at DESC, id DESC.
--
-- THE ARCHIVE ROUTINES — whole-body CREATE OR REPLACE of both, built from the live prod body
--   (md5-pinned below), changed in exactly two places:
--   * archive_plant_events Guard 4 gains `AND kbi.deleted_at IS NULL`.
--   * archive_container_events gains Guard 5 — the container twin of Guard 4, with the same two
--     deleted_at filters. It had NO kitchen guard at all, so an archive of a container whose harvest
--     fed a batch aborted at the harvest_log delete with a bare 23503.
--   Every text fragment the corpus matches survives: v4-archpreservguard-001 (preservation_log named,
--   and named before the harvest_log delete, in both), v4-archrestore-001 (photo_detach_archive and
--   its ordering, the cultivar/preservation/photo guards, the cross-container harvest guard, the
--   return shape), v4-softdelcascade-001 (detach before the event delete), v5-inflightbatch-001 (the
--   Guard 3 and Guard 4 messages).
--   ⚠ WHAT THE FILTER CANNOT DO, recorded rather than smoothed over: kitchen_batch_input.harvest_log_id
--   is ON DELETE RESTRICT, and a foreign key does not read deleted_at. A harvest line that is
--   soft-deleted, or that belongs to a soft-deleted batch, passes the guard and then still holds the
--   harvest_log row, so the delete aborts with a bare 23503. V4 keeps harvest-line removal a HARD
--   delete (so the first shape is unreachable from the app); the second is reachable through the
--   shipped DELETE /api/kitchen-batches/:id and predates this file (Guard 4 has filtered
--   b.deleted_at since v5-inflightbatch-001). Nothing is lost either way — the archive refuses.
--
-- ⚠ THE FINGERPRINT GUARD (first statement after BEGIN). This file replaces two shared routine bodies
--   and a view wholesale, weeks after they were read. If anyone changes either routine or the view
--   before this lands, a plain CREATE OR REPLACE would silently revert their change. So the file
--   refuses unless each object is EITHER the pre-1b definition read on prod and staging 2026-09-29
--   (identical on both) OR this file's own definition (a re-apply). If you edit a routine body or the
--   view below, re-pin its 1b md5 here — the rehearsal's second apply fails loudly until you do.
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS; every CHECK and FK is DROP IF EXISTS + ADD in one statement
--   (re-apply rewrites it to this file's definition); the UNIQUE constraints the composite FKs depend
--   on are created only if absent (dropping one would need its dependants gone); indexes IF NOT EXISTS;
--   triggers DROP IF EXISTS + CREATE; the view and routines CREATE OR REPLACE; the stamp ON CONFLICT DO
--   NOTHING. Re-running the whole file on an applied database changes nothing.
--
-- ⚠ Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a
--   shared database: its own COMMIT ends your transaction. Rehearse on local PG 17 (README.md).
--
-- ROLLBACK: 0r-rollback.sql — guarded, and valid only while B's code is off dev (05 §4).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Fingerprint guard. ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_plant     text;
  v_container text;
  v_view      text;
BEGIN
  SELECT md5(p.prosrc) INTO v_plant
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'archive_plant_events';
  SELECT md5(p.prosrc) INTO v_container
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'archive_container_events';
  SELECT md5(pg_get_viewdef(c.oid, true)) INTO v_view
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_kitchen_batch_current' AND c.relkind = 'v';

  IF v_plant IS DISTINCT FROM 'b98b7fa25681bd8929bba311ee490869'
     AND v_plant IS DISTINCT FROM '7bf55d3f9193e0acf8806462727c6b46' THEN
    RAISE EXCEPTION 'v5-putupmake-001 0a refused: archive_plant_events is md5 %, neither the pre-1b body (b98b7fa25681bd8929bba311ee490869) nor this file''s (7bf55d3f9193e0acf8806462727c6b46). Someone changed it after 2026-09-29: fold their change into this file, re-pin, and re-rehearse.', v_plant;
  END IF;
  IF v_container IS DISTINCT FROM '76a4c2e1969ac0c675a2a853578a406d'
     AND v_container IS DISTINCT FROM 'd7404f466c958fdcf05787aecb82f10b' THEN
    RAISE EXCEPTION 'v5-putupmake-001 0a refused: archive_container_events is md5 %, neither the pre-1b body (76a4c2e1969ac0c675a2a853578a406d) nor this file''s (d7404f466c958fdcf05787aecb82f10b). Someone changed it after 2026-09-29: fold their change into this file, re-pin, and re-rehearse.', v_container;
  END IF;
  IF v_view IS DISTINCT FROM '6eaff4dacaa1963064cd25258e1a29a3'
     AND v_view IS DISTINCT FROM 'c180cfc6868704fdfdf5cc4de1013d6c' THEN
    RAISE EXCEPTION 'v5-putupmake-001 0a refused: v_kitchen_batch_current is md5 %, neither the pre-1b definition (6eaff4dacaa1963064cd25258e1a29a3) nor this file''s (c180cfc6868704fdfdf5cc4de1013d6c). Someone changed it after 2026-09-29: fold their change into this file, re-pin, and re-rehearse.', v_view;
  END IF;
END $$;

-- ── 1. kitchen_batch ─────────────────────────────────────────────────────────────────────────────
-- start_precision widens by the two dated estimate words (V4 "Estimated dates"); 'after' is not a
-- word this table uses. kind_other: "Other" needs no text from 1b — the relaxed CHECK still refuses a
-- BLANK name on an Other batch, and admits exactly what the old one did plus Other-without-a-name.
ALTER TABLE public.kitchen_batch
  ADD COLUMN IF NOT EXISTS idempotency_key uuid,
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_start_precision,
  ADD CONSTRAINT chk_kitchen_batch_start_precision
    CHECK (start_precision IS NULL
           OR start_precision IN ('exact','hour','day','week','month','season','year','unknown')),
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_kind_other,
  ADD CONSTRAINT chk_kitchen_batch_kind_other
    CHECK (kind IS DISTINCT FROM 'other' OR kind_other IS NULL OR btrim(kind_other) <> '');

-- The key lives on the row that IS the event (V4 "Idempotency"). Global, partial: a 23505 on THIS
-- index name is a replay; every read of a key is owner-scoped in the handler.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kitchen_batch_idempotency_key
  ON public.kitchen_batch (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── 2. kitchen_stage_log ─────────────────────────────────────────────────────────────────────────
-- entered_at loses its default and its NOT NULL: Put it up's "Not sure" stores no date with precision
-- 'unknown', and the pairing CHECK makes that the ONLY way a row may be undated. A NULL precision is a
-- pre-1b writer and stays legal forever ("never tightened"). Every shipped INSERT names entered_at, so
-- losing the default changes nothing for 1a.
ALTER TABLE public.kitchen_stage_log
  ADD COLUMN IF NOT EXISTS entered_precision text,
  ADD COLUMN IF NOT EXISTS voids_id          uuid,
  ADD COLUMN IF NOT EXISTS idempotency_key   uuid,
  ALTER COLUMN entered_at DROP DEFAULT,
  ALTER COLUMN entered_at DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS chk_ksl_stage_kind,
  ADD CONSTRAINT chk_ksl_stage_kind
    CHECK (stage_kind IN ('started','tended','moved','finished','failed',
                          'reopened','paused','resumed','noted','put_up','void')),
  DROP CONSTRAINT IF EXISTS chk_ksl_entered_precision,
  ADD CONSTRAINT chk_ksl_entered_precision
    CHECK (entered_precision IS NULL
           OR entered_precision IN ('exact','hour','day','week','month','season','year','unknown')),
  DROP CONSTRAINT IF EXISTS chk_ksl_entered_pairing,
  ADD CONSTRAINT chk_ksl_entered_pairing
    CHECK ((entered_at IS NULL) = (entered_precision IS NOT DISTINCT FROM 'unknown')),
  DROP CONSTRAINT IF EXISTS chk_ksl_void_pairing,
  ADD CONSTRAINT chk_ksl_void_pairing
    CHECK ((stage_kind = 'void') = (voids_id IS NOT NULL)),
  -- KITCHEN_UNITS (V4 "Units"), the one list; the table had no unit CHECK before.
  DROP CONSTRAINT IF EXISTS chk_ksl_amount_unit,
  ADD CONSTRAINT chk_ksl_amount_unit
    CHECK (amount_unit IS NULL OR amount_unit IN (
      'g','kg','oz','lb','ml','l','tsp','tbsp','fl oz','cup','pint','qt','gal',
      'count','clove','head','bunch','pinch','peck','bushel','half-bushel','flat','jar','bag','other'));

-- The two UNIQUE constraints are created only if absent: the composite FKs below (and in sections 3
-- and 4) depend on uq_ksl_batch_id_id, so a re-apply cannot drop and re-add it. voids_id is UNIQUE so
-- a second Undo of the same row is a 23505 on THIS name, which the undo route answers as a replay.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                   JOIN pg_class t ON t.oid = c.conrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'kitchen_stage_log'
                    AND c.conname = 'uq_ksl_batch_id_id') THEN
    ALTER TABLE public.kitchen_stage_log ADD CONSTRAINT uq_ksl_batch_id_id UNIQUE (batch_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                   JOIN pg_class t ON t.oid = c.conrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'kitchen_stage_log'
                    AND c.conname = 'uq_ksl_voids_id') THEN
    ALTER TABLE public.kitchen_stage_log ADD CONSTRAINT uq_ksl_voids_id UNIQUE (voids_id);
  END IF;
END $$;

-- A void may only point at a row of its OWN batch. (Which kinds a void may point at — tended, moved,
-- noted; put_up and finished only through the undo route — is the stages route's rule, not a CHECK.)
ALTER TABLE public.kitchen_stage_log
  DROP CONSTRAINT IF EXISTS kitchen_stage_log_batch_id_voids_id_fkey,
  ADD CONSTRAINT kitchen_stage_log_batch_id_voids_id_fkey
    FOREIGN KEY (batch_id, voids_id) REFERENCES public.kitchen_stage_log (batch_id, id)
    ON DELETE NO ACTION;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ksl_idempotency_key
  ON public.kitchen_stage_log (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── 3. kitchen_batch_input (0 rows on prod) ──────────────────────────────────────────────────────
-- ⚠ The batch FK moves CASCADE -> NO ACTION in the SAME statement that adds deleted_at.
-- 'harvest' stays in the kind list for stale bundles; new UI never writes it. qty_unit widens from 14
-- to KITCHEN_UNITS (25, a superset). No CHECK names plant_id (its FK is SET NULL, and a pairing over
-- it would turn a planting hard delete into a 23514 inside the RI trigger).
ALTER TABLE public.kitchen_batch_input
  ADD COLUMN IF NOT EXISTS plant_id            uuid,
  ADD COLUMN IF NOT EXISTS preservation_log_id uuid,
  ADD COLUMN IF NOT EXISTS crop_type_slug      text,
  ADD COLUMN IF NOT EXISTS source_label        text,
  ADD COLUMN IF NOT EXISTS role                text,
  ADD COLUMN IF NOT EXISTS salt_pct            numeric,
  ADD COLUMN IF NOT EXISTS salt_base           text,
  ADD COLUMN IF NOT EXISTS base_g              numeric,
  ADD COLUMN IF NOT EXISTS put_up_stage_id     uuid,
  ADD COLUMN IF NOT EXISTS output_id           uuid,
  ADD COLUMN IF NOT EXISTS ordinal             integer,
  ADD COLUMN IF NOT EXISTS deleted_at          timestamptz,
  ADD COLUMN IF NOT EXISTS idempotency_key     uuid,
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_batch_id_fkey,
  ADD CONSTRAINT kitchen_batch_input_batch_id_fkey
    FOREIGN KEY (batch_id) REFERENCES public.kitchen_batch (id) ON DELETE NO ACTION,
  DROP CONSTRAINT IF EXISTS chk_kbi_kind,
  ADD CONSTRAINT chk_kbi_kind
    CHECK (input_kind IN ('garden','put_up','pantry','purchased','other','harvest')),
  DROP CONSTRAINT IF EXISTS chk_kbi_qty_unit,
  ADD CONSTRAINT chk_kbi_qty_unit
    CHECK (qty_unit IS NULL OR qty_unit IN (
      'g','kg','oz','lb','ml','l','tsp','tbsp','fl oz','cup','pint','qt','gal',
      'count','clove','head','bunch','pinch','peck','bushel','half-bushel','flat','jar','bag','other')),
  DROP CONSTRAINT IF EXISTS chk_kbi_put_up_pairing,
  ADD CONSTRAINT chk_kbi_put_up_pairing
    CHECK ((preservation_log_id IS NOT NULL) = (input_kind = 'put_up')),
  DROP CONSTRAINT IF EXISTS chk_kbi_role,
  ADD CONSTRAINT chk_kbi_role
    CHECK (role IS NULL OR role IN ('salt','water')),
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_base,
  ADD CONSTRAINT chk_kbi_salt_base
    CHECK (salt_base IS NULL OR salt_base IN ('peppers','water','all')),
  DROP CONSTRAINT IF EXISTS chk_kbi_output_needs_put_up,
  ADD CONSTRAINT chk_kbi_output_needs_put_up
    CHECK (output_id IS NULL OR put_up_stage_id IS NOT NULL),
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_plant_id_fkey,
  ADD CONSTRAINT kitchen_batch_input_plant_id_fkey
    FOREIGN KEY (plant_id) REFERENCES public.plants (id) ON DELETE SET NULL,
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_preservation_log_id_fkey,
  ADD CONSTRAINT kitchen_batch_input_preservation_log_id_fkey
    FOREIGN KEY (preservation_log_id) REFERENCES public.preservation_log (id) ON DELETE NO ACTION,
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_crop_type_slug_fkey,
  ADD CONSTRAINT kitchen_batch_input_crop_type_slug_fkey
    FOREIGN KEY (crop_type_slug) REFERENCES public.crop_types (slug) ON DELETE NO ACTION,
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_output_id_fkey,
  ADD CONSTRAINT kitchen_batch_input_output_id_fkey
    FOREIGN KEY (output_id) REFERENCES public.preservation_log (id) ON DELETE NO ACTION,
  -- Lines added at a sitting belong to a put_up row of the SAME batch. batch_id is NOT NULL here,
  -- so MATCH SIMPLE enforces this whenever put_up_stage_id is set; no simple FK is needed.
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_batch_id_put_up_stage_id_fkey,
  ADD CONSTRAINT kitchen_batch_input_batch_id_put_up_stage_id_fkey
    FOREIGN KEY (batch_id, put_up_stage_id) REFERENCES public.kitchen_stage_log (batch_id, id)
    ON DELETE NO ACTION;

CREATE UNIQUE INDEX IF NOT EXISTS uq_kbi_idempotency_key
  ON public.kitchen_batch_input (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── 4. preservation_log ──────────────────────────────────────────────────────────────────────────
-- Every new column nullable, none with a default. preserved_at_precision takes the full vocabulary
-- ('after' included: on this table the date is NOT NULL, so Put it up's "Not sure" stores the
-- earliest date with 'after'), and no CHECK here mentions preserved_at_approx
-- (v4-putupsession-001 post_no_check_constraint_added).
ALTER TABLE public.preservation_log
  ADD COLUMN IF NOT EXISTS label                  text,
  ADD COLUMN IF NOT EXISTS container_label        text,
  ADD COLUMN IF NOT EXISTS use_by_basis           text,
  ADD COLUMN IF NOT EXISTS storage_moved_at       timestamptz,
  ADD COLUMN IF NOT EXISTS texture                text,
  ADD COLUMN IF NOT EXISTS is_raw                 boolean,
  ADD COLUMN IF NOT EXISTS in_oil                 boolean,
  ADD COLUMN IF NOT EXISTS ph_reading             numeric,
  ADD COLUMN IF NOT EXISTS ph_read_at             timestamptz,
  ADD COLUMN IF NOT EXISTS put_up_stage_id        uuid,
  ADD COLUMN IF NOT EXISTS preserved_at_precision text,
  ADD COLUMN IF NOT EXISTS idempotency_key        uuid,
  -- A jar may be logged with no size; the pair stays together (pairing CHECK below).
  ALTER COLUMN quantity_value DROP NOT NULL,
  ALTER COLUMN quantity_unit  DROP NOT NULL,
  -- Relaxed in place: a name alone attributes a jar (a label-only jar from a batch or the Walk).
  DROP CONSTRAINT IF EXISTS chk_preservation_log_attribution,
  ADD CONSTRAINT chk_preservation_log_attribution
    CHECK (crop_type_slug IS NOT NULL OR variety_id IS NOT NULL OR label IS NOT NULL),
  -- Relaxed in place: an "Other" put-up is named by its label; method_other_text stays optional.
  DROP CONSTRAINT IF EXISTS chk_preservation_log_method_other,
  ADD CONSTRAINT chk_preservation_log_method_other
    CHECK (method <> 'other'
           OR (method_other_text IS NOT NULL AND btrim(method_other_text) <> '')
           OR label IS NOT NULL),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_label_nonblank,
  ADD CONSTRAINT chk_preservation_log_label_nonblank
    CHECK (label IS NULL OR btrim(label) <> ''),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_label_len,
  ADD CONSTRAINT chk_preservation_log_label_len
    CHECK (label IS NULL OR char_length(label) <= 120),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_use_by_basis,
  ADD CONSTRAINT chk_preservation_log_use_by_basis
    CHECK (use_by_basis IS NULL OR use_by_basis IN ('typed','recipe','table','house','none')),
  -- none => no date; table / house / recipe => a date; typed => either (a typed "no date" is typed).
  -- Vacuous while use_by_basis IS NULL, which is every row until 0p and every row 1a writes.
  DROP CONSTRAINT IF EXISTS chk_preservation_log_use_by_basis_date,
  ADD CONSTRAINT chk_preservation_log_use_by_basis_date
    CHECK (use_by_basis IS NULL
           OR ((use_by_basis <> 'none' OR use_by_target IS NULL)
               AND (use_by_basis NOT IN ('table','house','recipe') OR use_by_target IS NOT NULL))),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_texture,
  ADD CONSTRAINT chk_preservation_log_texture
    CHECK (texture IS NULL OR texture IN ('snaps','bends','still_soft')),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_texture_method,
  ADD CONSTRAINT chk_preservation_log_texture_method
    CHECK (texture IS NULL OR method IN ('dehydrate','powder')),
  -- The pH pair: recorded together, on the scale's own domain, and NOTHING ELSE. Same two constraints,
  -- same meaning, as kitchen_stage_log's (v5-phrecord-001). A third CHECK naming ph_reading would be
  -- a threshold; gates.yml forbids one.
  DROP CONSTRAINT IF EXISTS chk_preservation_log_ph_pairing,
  ADD CONSTRAINT chk_preservation_log_ph_pairing
    CHECK ((ph_reading IS NULL) = (ph_read_at IS NULL)),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_ph_scale,
  ADD CONSTRAINT chk_preservation_log_ph_scale
    CHECK (ph_reading IS NULL OR (ph_reading >= 0 AND ph_reading <= 14)),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_put_up_stage_batch,
  ADD CONSTRAINT chk_preservation_log_put_up_stage_batch
    CHECK (put_up_stage_id IS NULL OR batch_id IS NOT NULL),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_preserved_at_precision,
  ADD CONSTRAINT chk_preservation_log_preserved_at_precision
    CHECK (preserved_at_precision IS NULL
           OR preserved_at_precision IN ('exact','hour','day','week','month','season','year',
                                         'after','unknown')),
  -- NEW name, both-or-neither, value > 0. release 1a's restated gate requires exactly this name,
  -- validated, naming both columns.
  DROP CONSTRAINT IF EXISTS chk_preservation_log_quantity_pairing,
  ADD CONSTRAINT chk_preservation_log_quantity_pairing
    CHECK ((quantity_value IS NULL) = (quantity_unit IS NULL)
           AND (quantity_value IS NULL OR quantity_value > 0)),
  -- THE PERMISSIVE UNION (V4 "Units"): KITCHEN_UNITS (25) + the ten legacy plurals the deployed
  -- picker writes = 35. The CHECK is never narrowed. A NULL unit passes (a CHECK passes on NULL; the
  -- pairing CHECK is what ties it to the value). Written `IN ( ... ));`, the shape the method-parity
  -- extractor reads — whose value regex needs a hyphen and a space for 'half-bushel' and 'fl oz'.
  DROP CONSTRAINT IF EXISTS chk_preservation_log_quantity_unit,
  ADD CONSTRAINT chk_preservation_log_quantity_unit
  CHECK (quantity_unit IN (
    'g','kg','oz','lb','ml','l','tsp','tbsp','fl oz','cup','pint','qt','gal',
    'count','clove','head','bunch','pinch','peck','bushel','half-bushel','flat','jar','bag','other',
    'lbs','cups','pints','quarts','bushels','half-bushels','pecks','flats','jars','bags'
  )),
  -- Armed against the deployed writer on purpose: release 1a's legacy PUT moves remaining_count with
  -- a changed package_count (refused below 0) and ignores the body's remaining_count, so it cannot
  -- produce a violator. Promote A must be live before this file reaches prod.
  DROP CONSTRAINT IF EXISTS chk_preservation_log_remaining_within_package,
  ADD CONSTRAINT chk_preservation_log_remaining_within_package
    CHECK (remaining_count IS NULL OR remaining_count <= package_count),
  DROP CONSTRAINT IF EXISTS preservation_log_batch_id_fkey,
  ADD CONSTRAINT preservation_log_batch_id_fkey
    FOREIGN KEY (batch_id) REFERENCES public.kitchen_batch (id) ON DELETE NO ACTION,
  DROP CONSTRAINT IF EXISTS preservation_log_put_up_stage_id_fkey,
  ADD CONSTRAINT preservation_log_put_up_stage_id_fkey
    FOREIGN KEY (put_up_stage_id) REFERENCES public.kitchen_stage_log (id) ON DELETE NO ACTION,
  DROP CONSTRAINT IF EXISTS preservation_log_put_up_stage_id_batch_id_fkey,
  ADD CONSTRAINT preservation_log_put_up_stage_id_batch_id_fkey
    FOREIGN KEY (put_up_stage_id, batch_id) REFERENCES public.kitchen_stage_log (id, batch_id)
    ON DELETE NO ACTION;

CREATE UNIQUE INDEX IF NOT EXISTS uq_preservation_log_idempotency_key
  ON public.preservation_log (idempotency_key) WHERE idempotency_key IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON public.preservation_log;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.preservation_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS prevent_preservation_log_ownership_transfer ON public.preservation_log;
CREATE TRIGGER prevent_preservation_log_ownership_transfer
  BEFORE UPDATE ON public.preservation_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_kitchen_batch_ownership_transfer();

DROP TRIGGER IF EXISTS trg_audit_preservation_log_upd ON public.preservation_log;
CREATE TRIGGER trg_audit_preservation_log_upd
  AFTER UPDATE ON public.preservation_log
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update(
    'storage_location_id', 'use_by_target', 'use_by_basis', 'package_count', 'remaining_count',
    'label', 'is_raw', 'in_oil', 'deleted_at');

-- ── 5. storage_location ──────────────────────────────────────────────────────────────────────────
-- One live place per owner, kind and name in any case: the key the place find-or-create uses. Partial,
-- so a removed place frees its name. README's second pre-check (0 duplicate groups) runs immediately
-- before every apply; a duplicate created in between aborts this transaction, which is fail-safe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_location_user_kind_label
  ON public.storage_location (user_id, kind, lower(label)) WHERE deleted_at IS NULL;

-- ── 6. v_kitchen_batch_current ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_kitchen_batch_current AS
 SELECT b.id,
    b.user_id,
    b.label,
    b.kind,
    b.kind_other,
    b.started_at,
    b.start_precision,
    b.start_anchor_kind,
    b.start_anchor_id,
    b.first_recorded_at,
    b.expected_days_min,
    b.expected_days_max,
    b.brine_note,
    b.suspended_at,
    b.closed_at,
    b.outcome,
    b.outcome_note,
    b.cover_photo_id,
    b.notes,
    b.created_at,
    b.updated_at,
    b.deleted_at,
    s.stage_kind AS current_stage_kind,
    s.label AS current_stage_label,
    s.entered_at AS current_stage_entered_at,
    loc.storage_location_id AS current_storage_location_id,
    ( SELECT count(*) AS count
           FROM public.kitchen_batch_input i
          WHERE i.batch_id = b.id AND i.deleted_at IS NULL) AS input_count,
    ( SELECT count(*) AS count
           FROM public.preservation_log p
          WHERE p.batch_id = b.id AND p.deleted_at IS NULL) AS output_count,
    ph.ph_reading AS last_ph_reading,
    ph.ph_read_at AS last_ph_read_at,
    b.idempotency_key
   FROM public.kitchen_batch b
     LEFT JOIN LATERAL ( SELECT sl.stage_kind,
            sl.label,
            sl.entered_at
           FROM public.kitchen_stage_log sl
          WHERE sl.batch_id = b.id
            AND sl.stage_kind IN ('started','tended','moved','finished','failed')
            AND NOT EXISTS (SELECT 1 FROM public.kitchen_stage_log v WHERE v.voids_id = sl.id)
          ORDER BY sl.entered_at DESC NULLS LAST, sl.created_at DESC, sl.id DESC
         LIMIT 1) s ON true
     LEFT JOIN LATERAL ( SELECT sl.storage_location_id
           FROM public.kitchen_stage_log sl
          WHERE sl.batch_id = b.id
            AND sl.storage_location_id IS NOT NULL
            AND sl.stage_kind <> 'void'
            AND NOT EXISTS (SELECT 1 FROM public.kitchen_stage_log v WHERE v.voids_id = sl.id)
          ORDER BY sl.entered_at DESC NULLS LAST, sl.created_at DESC, sl.id DESC
         LIMIT 1) loc ON true
     LEFT JOIN LATERAL ( SELECT pl.ph_reading,
            pl.ph_read_at
           FROM public.kitchen_stage_log pl
          WHERE pl.batch_id = b.id
            AND pl.ph_reading IS NOT NULL
            AND pl.stage_kind <> 'void'
            AND NOT EXISTS (SELECT 1 FROM public.kitchen_stage_log v WHERE v.voids_id = pl.id)
          ORDER BY pl.ph_read_at DESC, pl.id DESC
         LIMIT 1) ph ON true
  WHERE b.deleted_at IS NULL;

-- ── 7. The archive routines ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.archive_plant_events(p_plant_id uuid, p_reason text DEFAULT 'hard-delete of planting'::text) RETURNS TABLE(events_archived integer, harvests_archived integer, photos_detached integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_ids     uuid[];
  v_blocked text;
  v_events  integer := 0;
  v_harv    integer := 0;
  v_photos  integer := 0;
BEGIN
  IF p_plant_id IS NULL THEN
    RAISE EXCEPTION 'archive_plant_events: p_plant_id must not be NULL';
  END IF;

  SELECT array_agg(id) INTO v_ids FROM public.event_log WHERE plant_id = p_plant_id;

  IF v_ids IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  -- Guard 1 — calibration evidence is immutable and out of this function's authority.
  SELECT string_agg(id::text, ', ') INTO v_blocked
    FROM public.cultivar_weight_sample WHERE source_event_id = ANY(v_ids);
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('archive_plant_events: %s cultivar_weight_sample row(s) reference these events '
                       'and are immutable (trg_cws_immutable)', array_length(v_ids,1)),
      DETAIL  = format('cultivar_weight_sample ids: %s', v_blocked),
      HINT    = 'Resolve the calibration samples first (they are evidence, not derived data), then re-run.';
  END IF;

  -- Guard 2 — a photo that would be left with no parent at all. Checked BEFORE the detach so the
  -- transaction aborts with a message naming the photos rather than with a bare 23514.
  SELECT string_agg(ph.id::text, ', ') INTO v_blocked
    FROM public.photos ph
    JOIN public.event_log e ON e.id = ph.event_id
   WHERE ph.event_id = ANY(v_ids)
     AND COALESCE(ph.project_id, e.project_id) IS NULL
     AND COALESCE(ph.location_id, e.location_id) IS NULL
     AND ph.plant_id IS NULL
     AND ph.inventory_item_id IS NULL
     AND ph.space_id IS NULL
     AND COALESCE(ph.intake_status = 'pending_tag', false) = false;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_plant_events: detaching these events would leave photo(s) with no parent',
      DETAIL  = format('photos ids: %s', v_blocked),
      HINT    = 'Give each photo a parent (project, location, planting, space or inventory item) first. '
                'Photos are never deleted by this function.';
  END IF;

  -- Guard 3 (BUG-ARCHPRESERVGUARD-001) — preservation provenance. The harvest_log delete below is
  -- deliberate, but preservation_log.harvest_log_id used to be SET NULL, so it silently stripped
  -- every put-up record made from these harvests: the jar stayed, its source vanished. Same class
  -- as Guard 1 — a preservation record is user-authored evidence, not data derived from the
  -- harvest — so it gets the same treatment: refuse, name the rows, and let the operator decide.
  -- NOTE the FK itself stays SET NULL, deliberately (see section 3 of this file): this guard is
  -- the whole protection on the routine path, which is where the audit found the gap.
  SELECT string_agg(pl.id::text, ', ') INTO v_blocked
    FROM public.preservation_log pl
    JOIN public.harvest_log h ON h.id = pl.harvest_log_id
   WHERE h.event_id = ANY(v_ids);
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_plant_events: preservation_log row(s) record put-ups made from these '
                'harvests; archiving would strip their provenance',
      DETAIL  = format('preservation_log ids: %s', v_blocked),
      HINT    = 'Clear or re-point preservation_log.harvest_log_id for those rows first (they are '
                'evidence, not derived data), then re-run. Preservation records are never deleted '
                'by this function.';
  END IF;

  -- Guard 4 (V5-INFLIGHTBATCH-001) — kitchen-batch provenance. Mirrors Guard 3 term for term, and
  -- it is NOT optional: kitchen_batch_input.harvest_log_id is ON DELETE RESTRICT, so from the moment
  -- one input row exists the harvest_log DELETE below aborts with a bare 23503 naming nothing. That
  -- is precisely the failure Guard 2's comment says these guards exist to avoid. RESTRICT was chosen
  -- over the alternatives because that DELETE is a HARD delete into harvest_log_archive as jsonb:
  -- CASCADE would silently destroy a batch's provenance with no archive to recover it from, and SET
  -- NULL would leave an input row saying "something went in" that cannot say what — unlike
  -- preservation_log's single optional link, that column is half this row's identity.
  --
  -- deleted_at SCOPE STATED EXPLICITLY, per the count-discipline rule in
  -- v5-varietyhybridflag-001/gates.yml. A soft-deleted batch is not evidence anyone is protecting,
  -- so it does not block. (Guard 3 above has no such filter, so a soft-deleted put-up DOES block an
  -- archive — pre-existing, out of scope here, and deliberately not "fixed" in passing.)
  --
  -- V5-PUTUPMAKE-001 (Put-Up release 1b): a soft-deleted LINE does not block either, now that
  -- kitchen_batch_input carries deleted_at. Only non-harvest lines are ever soft-deleted (removing a
  -- harvest line stays a hard delete), so no harvest line reaches that filter from the app. What no
  -- filter can do: kitchen_batch_input.harvest_log_id is RESTRICT and a foreign key does not read
  -- deleted_at, so a harvest line under a soft-deleted batch still holds its harvest_log row and the
  -- harvest_log delete below aborts with a bare 23503. That predates 1b (the batch filter above),
  -- and it refuses rather than loses anything.
  SELECT string_agg(DISTINCT b.id::text, ', ') INTO v_blocked
    FROM public.kitchen_batch_input kbi
    JOIN public.harvest_log h    ON h.id = kbi.harvest_log_id
    JOIN public.kitchen_batch b  ON b.id = kbi.batch_id
   WHERE h.event_id = ANY(v_ids)
     AND b.deleted_at IS NULL
     AND kbi.deleted_at IS NULL;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_plant_events: kitchen_batch row(s) record a batch fed by these harvests; '
                'archiving would strip their provenance',
      DETAIL  = format('kitchen_batch ids: %s', v_blocked),
      HINT    = 'Remove or re-point those batch inputs first (they are evidence, not derived data), '
                'then re-run. Batches are never deleted by this function.';
  END IF;

  -- DETACH photos. COALESCE, not assignment: an existing parent always wins.
  --
  -- OPS-ARCHRESTORE-001: the UPDATE is UNCHANGED term for term. It is now one CTE of a single
  -- statement that ALSO records each photo's pre-detach parent set into photo_detach_archive,
  -- because photos.event_id is otherwise destroyed with no record anywhere and an un-archive
  -- cannot give back what it cannot see.
  --
  -- WHY A PRE-IMAGE CTE AND NOT `RETURNING`: RETURNING yields the NEW row, and this UPDATE's
  -- COALESCE-forward is not invertible from the new state — a project_id the photo GAINED from its
  -- event is indistinguishable from one it already carried. `pre` and `detached` are CTEs of one
  -- statement and therefore share one snapshot, so `pre` reads the values as they stood before the
  -- UPDATE. The INNER JOIN makes the captured set provably identical to the detached set (and
  -- forces `detached` to be referenced, though a data-modifying CTE executes regardless).
  WITH pre AS (
    SELECT ph.id AS photo_id, ph.event_id, ph.project_id, ph.location_id, ph.plant_id
      FROM public.photos ph
     WHERE ph.event_id = ANY(v_ids)
  ), detached AS (
    UPDATE public.photos ph
       SET event_id    = NULL,
           project_id  = COALESCE(ph.project_id,  e.project_id),
           location_id = COALESCE(ph.location_id, e.location_id),
           updated_at  = now()
      FROM public.event_log e
     WHERE e.id = ph.event_id
       AND ph.event_id = ANY(v_ids)
    RETURNING ph.id AS photo_id
  )
  INSERT INTO public.photo_detach_archive
        (photo_id, pre_image, archived_reason, archived_plant_id)
  SELECT d.photo_id,
         jsonb_build_object('event_id',    p.event_id,
                            'project_id',  p.project_id,
                            'location_id', p.location_id,
                            'plant_id',    p.plant_id),
         p_reason, p_plant_id
    FROM detached d
    JOIN pre p ON p.photo_id = d.photo_id;
  GET DIAGNOSTICS v_photos = ROW_COUNT;

  -- harvest_log FIRST: its FK into event_log is RESTRICT, so it has to be gone before the events are.
  WITH moved AS (
    DELETE FROM public.harvest_log h WHERE h.event_id = ANY(v_ids) RETURNING h.*
  )
  INSERT INTO public.harvest_log_archive
        (id, event_id, row_data, archived_reason, archived_plant_id)
  SELECT m.id, m.event_id, to_jsonb(m), p_reason, p_plant_id FROM moved m;
  GET DIAGNOSTICS v_harv = ROW_COUNT;

  WITH moved AS (
    DELETE FROM public.event_log e WHERE e.id = ANY(v_ids) RETURNING e.*
  )
  INSERT INTO public.event_log_archive
        (id, plant_id, project_id, location_id, event_type, event_date, created_by,
         row_data, archived_reason, archived_plant_id)
  SELECT m.id, m.plant_id, m.project_id, m.location_id, m.event_type, m.event_date, m.created_by,
         to_jsonb(m), p_reason, p_plant_id FROM moved m;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  RETURN QUERY SELECT v_events, v_harv, v_photos;
END
$$;

CREATE OR REPLACE FUNCTION public.archive_container_events(p_container_id uuid, p_reason text DEFAULT 'hard-delete of container'::text) RETURNS TABLE(events_archived integer, harvests_archived integer, photos_detached integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_ids     uuid[];
  v_blocked text;
  v_events  integer := 0;
  v_harv    integer := 0;
  v_photos  integer := 0;
BEGIN
  IF p_container_id IS NULL THEN
    RAISE EXCEPTION 'archive_container_events: p_container_id must not be NULL';
  END IF;

  -- Empty array, never NULL: every predicate below uses `= ANY(v_ids)`, which is FALSE against an
  -- empty array but NULL against a NULL one. The photo pass must still run for an event-less
  -- container (see header).
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_ids
    FROM public.event_log WHERE project_id = p_container_id;

  -- Guard 1 — calibration evidence is immutable and out of this function's authority.
  SELECT string_agg(id::text, ', ') INTO v_blocked
    FROM public.cultivar_weight_sample WHERE source_event_id = ANY(v_ids);
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_container_events: cultivar_weight_sample row(s) reference these events and '
                'are immutable (trg_cws_immutable)',
      DETAIL  = format('cultivar_weight_sample ids: %s', v_blocked),
      HINT    = 'Resolve the calibration samples first (they are evidence, not derived data), then re-run.';
  END IF;

  -- Guard 2 — a harvest_log row anchored to THIS container whose event belongs to a DIFFERENT one.
  -- Archiving it would strand harvest detail off an event that is staying. Zero such rows exist in
  -- prod (verified live: harvest_log.project_id is non-null and always equals its event's
  -- project_id), so this is a tripwire for future skew, not a live condition.
  SELECT string_agg(h.id::text, ', ') INTO v_blocked
    FROM public.harvest_log h
   WHERE h.project_id = p_container_id
     AND NOT (h.event_id = ANY(v_ids));
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_container_events: harvest_log row(s) anchored to this container belong to '
                'events in a different container; archiving them would strand detail off a surviving event',
      DETAIL  = format('harvest_log ids: %s', v_blocked),
      HINT    = 'Re-anchor or resolve those harvest rows first, then re-run.';
  END IF;

  -- Guard 3 — photos that the detach below would leave with no parent at all. Checked BEFORE any
  -- write so the transaction aborts with a message naming the photos rather than with a bare 23514
  -- from photos_must_have_parent (which is VALIDATED and would reject it anyway). The expression
  -- mirrors the UPDATE that follows, term for term, and the CHECK's disjunction, term for term.
  WITH affected AS (
    SELECT ph.id,
           CASE WHEN ph.event_id   = ANY(v_ids)       THEN NULL ELSE ph.event_id   END AS new_event_id,
           CASE WHEN ph.project_id = p_container_id   THEN NULL ELSE ph.project_id END AS new_project_id,
           COALESCE(ph.plant_id,
                    (SELECT e.plant_id    FROM public.event_log e
                      WHERE e.id = ph.event_id AND ph.event_id = ANY(v_ids)))          AS new_plant_id,
           COALESCE(ph.location_id,
                    (SELECT e.location_id FROM public.event_log e
                      WHERE e.id = ph.event_id AND ph.event_id = ANY(v_ids)))          AS new_location_id,
           ph.inventory_item_id, ph.space_id, ph.intake_status
      FROM public.photos ph
     WHERE ph.event_id = ANY(v_ids) OR ph.project_id = p_container_id
  )
  SELECT string_agg(a.id::text, ', ') INTO v_blocked
    FROM affected a
   WHERE a.new_event_id IS NULL AND a.new_project_id IS NULL AND a.new_plant_id IS NULL
     AND a.new_location_id IS NULL AND a.inventory_item_id IS NULL AND a.space_id IS NULL
     AND COALESCE(a.intake_status = 'pending_tag', false) = false;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_container_events: detaching this container would leave photo(s) with no parent',
      DETAIL  = format('photos ids: %s', v_blocked),
      HINT    = 'Give each photo a parent (planting, location, space or inventory item) first. '
                'Photos are never deleted by this function.';
  END IF;

  -- Guard 4 (BUG-ARCHPRESERVGUARD-001) — preservation provenance. Mirrors the harvest_log DELETE
  -- predicate below TERM FOR TERM (event_id = ANY(v_ids) OR project_id = p_container_id); a
  -- narrower guard here would let exactly the rows the delete reaches slip through. Same rationale
  -- as archive_plant_events Guard 3.
  SELECT string_agg(pl.id::text, ', ') INTO v_blocked
    FROM public.preservation_log pl
    JOIN public.harvest_log h ON h.id = pl.harvest_log_id
   WHERE h.event_id = ANY(v_ids) OR h.project_id = p_container_id;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_container_events: preservation_log row(s) record put-ups made from these '
                'harvests; archiving would strip their provenance',
      DETAIL  = format('preservation_log ids: %s', v_blocked),
      HINT    = 'Clear or re-point preservation_log.harvest_log_id for those rows first (they are '
                'evidence, not derived data), then re-run. Preservation records are never deleted '
                'by this function.';
  END IF;

  -- Guard 5 (V5-PUTUPMAKE-001, Put-Up release 1b) — kitchen-batch provenance, the container twin of
  -- archive_plant_events Guard 4, closing the gap it left: kitchen_batch_input.harvest_log_id is ON
  -- DELETE RESTRICT, so a batch line citing any harvest this routine deletes made the harvest_log
  -- delete below abort with a bare 23503 naming nothing. The predicate mirrors that delete TERM FOR
  -- TERM (an event of this container, OR a harvest anchored to it), as Guard 4 above does for
  -- preservation provenance. Same deleted_at scope as the plant routine: a soft-deleted batch and a
  -- soft-deleted line do not block (the foreign key still does; see the plant routine's Guard 4).
  SELECT string_agg(DISTINCT b.id::text, ', ') INTO v_blocked
    FROM public.kitchen_batch_input kbi
    JOIN public.harvest_log h    ON h.id = kbi.harvest_log_id
    JOIN public.kitchen_batch b  ON b.id = kbi.batch_id
   WHERE (h.event_id = ANY(v_ids) OR h.project_id = p_container_id)
     AND b.deleted_at IS NULL
     AND kbi.deleted_at IS NULL;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_container_events: kitchen_batch row(s) record a batch fed by these harvests; '
                'archiving would strip their provenance',
      DETAIL  = format('kitchen_batch ids: %s', v_blocked),
      HINT    = 'Remove or re-point those batch inputs first (they are evidence, not derived data), '
                'then re-run. Batches are never deleted by this function.';
  END IF;

  -- DETACH photos. COALESCE, not assignment: an existing parent always wins. The dying container is
  -- never used as a re-parent source. Both axes (event_id and project_id) are cleared in one pass so
  -- a photo carrying both is handled once.
  --
  -- OPS-ARCHRESTORE-001: UPDATE unchanged term for term; wrapped so the pre-detach parent set is
  -- recorded. This routine is precisely why the capture is a TABLE and not a column on
  -- event_log_archive: the `ph.project_id = p_container_id` arm reaches photos with NO event in
  -- v_ids (12 such photos in live prod 2026-08-12), and an event-less container archives zero rows
  -- while still detaching — in both cases there is no archive row for a column to live on.
  WITH pre AS (
    SELECT ph.id AS photo_id, ph.event_id, ph.project_id, ph.location_id, ph.plant_id
      FROM public.photos ph
     WHERE ph.event_id = ANY(v_ids) OR ph.project_id = p_container_id
  ), detached AS (
    UPDATE public.photos ph
       SET event_id    = CASE WHEN ph.event_id   = ANY(v_ids)     THEN NULL ELSE ph.event_id   END,
           project_id  = CASE WHEN ph.project_id = p_container_id THEN NULL ELSE ph.project_id END,
           plant_id    = COALESCE(ph.plant_id,
                                  (SELECT e.plant_id    FROM public.event_log e
                                    WHERE e.id = ph.event_id AND ph.event_id = ANY(v_ids))),
           location_id = COALESCE(ph.location_id,
                                  (SELECT e.location_id FROM public.event_log e
                                    WHERE e.id = ph.event_id AND ph.event_id = ANY(v_ids))),
           updated_at  = now()
     WHERE ph.event_id = ANY(v_ids) OR ph.project_id = p_container_id
    RETURNING ph.id AS photo_id
  )
  INSERT INTO public.photo_detach_archive
        (photo_id, pre_image, archived_reason, archived_project_id)
  SELECT d.photo_id,
         jsonb_build_object('event_id',    p.event_id,
                            'project_id',  p.project_id,
                            'location_id', p.location_id,
                            'plant_id',    p.plant_id),
         p_reason, p_container_id
    FROM detached d
    JOIN pre p ON p.photo_id = d.photo_id;
  GET DIAGNOSTICS v_photos = ROW_COUNT;

  -- harvest_log FIRST: both of its FKs (project_id, event_id) are RESTRICT, so it has to be gone
  -- before the events and before the container are.
  WITH moved AS (
    DELETE FROM public.harvest_log h
     WHERE h.event_id = ANY(v_ids) OR h.project_id = p_container_id
    RETURNING h.*
  )
  INSERT INTO public.harvest_log_archive
        (id, event_id, row_data, archived_reason, archived_project_id)
  SELECT m.id, m.event_id, to_jsonb(m), p_reason, p_container_id FROM moved m;
  GET DIAGNOSTICS v_harv = ROW_COUNT;

  WITH moved AS (
    DELETE FROM public.event_log e WHERE e.id = ANY(v_ids) RETURNING e.*
  )
  INSERT INTO public.event_log_archive
        (id, plant_id, project_id, location_id, event_type, event_date, created_by,
         row_data, archived_reason, archived_project_id)
  SELECT m.id, m.plant_id, m.project_id, m.location_id, m.event_type, m.event_date, m.created_by,
         to_jsonb(m), p_reason, p_container_id FROM moved m;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  RETURN QUERY SELECT v_events, v_harv, v_photos;
END
$$;

-- ── 8. The stamp, in the same transaction as everything above. ──────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-putupmake-001',
        'V5-PUTUPMAKE-001 (Put-Up release 1b, Put it up): preservation_log gains label, container_label, '
        'use_by_basis, storage_moved_at, texture, is_raw, in_oil, the pH pair, put_up_stage_id, '
        'preserved_at_precision, idempotency_key; the quantity pair goes nullable under the new '
        'chk_preservation_log_quantity_pairing; the unit CHECK is the 35-value union; remaining <= '
        'package; batch_id FK NO ACTION; set_updated_at, the user_id ownership trigger and the audit '
        'trigger attached. kitchen_batch / kitchen_stage_log / kitchen_batch_input widened (stage kinds, '
        'precision, voids, lines) with keyed events; storage_location unique per owner, kind and name; '
        'v_kitchen_batch_current re-derived with the 30 columns kept; both archive routines filter '
        'soft-deleted lines. No backfill: 0p-post-deploy-backfill.sql runs after B''s Lambda is live.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
