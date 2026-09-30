-- 0a-additive-ddl.sql
-- schema_version: 5.0.0-batchbuilder-001
--
-- V5-BATCHBUILDER-001 — Put-Up B′ release 3 (the batch builder), the database half. One file, one
--   transaction, the stamp written inside it. Plan: project-state/_crucible-pantry-20260928/
--   04-design-final.md (V4) §4.4 and 05-release-train.md §6 "3:" / §6a "Archive vs soft deletes", as
--   narrowed by 06-ferment-path.md §1.3 (F already added remaining_amount and re-created the audit
--   trigger). The line above is machine-read by the train step in .github/workflows/integration-test.yml;
--   keep it the second line and keep it equal to the INSERT at the bottom.
--
-- THE STAMP IS FIXED: '5.0.0-batchbuilder-001'. Never edit it after the first apply anywhere: gates.yml
--   self-arms on it.
--
-- RELEASE 3 NEEDS NO NEW COLUMN, TABLE, CHECK, TRIGGER OR VIEW CHANGE. What V4 §4.4 lists moved into F:
--   * preservation_log.remaining_amount — v5-fermentpath-001 0a §4 (06 §1.3: "release 3's adds no
--     remaining_amount");
--   * 05 §6 "3: re-create the preservation_log audit trigger with remaining_amount watched" — F's 0a
--     re-creates trg_audit_preservation_log_upd watching thirteen, remaining_amount among them, and F's
--     post_audit_watches_exactly_the_thirteen pins it. Re-creating it here would be a no-op at best and a
--     drift from F's pinned list at worst, so this file leaves it alone (README.md).
--   How it was made →, the planting read, "Like <batch>", the ranked name search and pantry lines are all
--   Lambda and client work over columns that already exist (pantry_item_id arrives with v5-pantry-001).
--
-- WHAT THIS FILE DOES — BUG-ARCHIVESOFTDELBATCH-001, the data half (05 §6a "Archive vs soft deletes").
--   kitchen_batch_input.harvest_log_id is ON DELETE RESTRICT and a foreign key does not read deleted_at,
--   so a pick line that is soft-deleted, or that belongs to a soft-deleted batch, passes both archive
--   routines' kitchen guards and then pins its harvest_log row: archiving the planting (or the container)
--   dies on a bare 23503. Since release F no app path can make that shape — take-out hard-deletes a pick
--   line (06 §3.11) and "Remove this batch" hard-deletes its pick lines in the same statement (06 §3.12)
--   — but a batch removed BEFORE F (the shipped soft DELETE, live since V5-INFLIGHTBATCH-001) still holds
--   its pick lines. This file hard-deletes exactly those dead pick links, once, and gates.yml keeps a
--   standing gate that no dead pick link exists again.
--   WHY THIS OPTION (of the three the 1b README and 06 §3.12 weighed; the full reasoning is README.md):
--     (a) FK → SET NULL: chk_kbi_harvest_pairing turns the RI action into a 23514 — the archive still
--         dies, now inside the RI trigger;
--     (b) teach both archive routines to delete dead lines before the harvest delete: a whole-body
--         CREATE OR REPLACE of two shared, md5-fingerprinted routines that seven gate files match by text
--         — the riskiest edit in the family, for a shape no writer can create any more;
--     (c) the app never leaves a dead pick link (F already does this), plus THIS one-time sweep of the
--         links left from before F and a standing gate. Chosen: data-only, no routine or FK change,
--         idempotent, and it removes nothing that is evidence (the pick stays in harvest_log; a removed
--         batch has no restore; the line was a link).
--
-- THE DEPLOYED WRITER IS UNAFFECTED: no DDL at all. The sweep deletes only rows no route reads (a
--   soft-deleted line, or any line of a soft-deleted batch — readBatch, readLines and the view all filter
--   them out) and no FK points at kitchen_batch_input from a pick line (pantry_use references draw lines
--   only).
--
-- IDEMPOTENT: the DELETE matches nothing on a second run; the stamp is ON CONFLICT DO NOTHING.
--
-- ⚠ Exactly ONE COMMIT, at the end. Rehearse on local PG 17 only (README.md).
--
-- ROLLBACK: 0r-rollback.sql removes the stamp. The deleted links are not restored: they were links under
--   removed batches, which no surface shows and no restore reads (README.md).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Guard: F is applied (kitchen_batch_input.deleted_at and F's take-out / remove rules exist). ───
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-fermentpath-001') THEN
    RAISE EXCEPTION 'v5-batchbuilder-001 0a refused: v5-fermentpath-001 (5.0.0-fermentpath-001) is not applied here. Release 3 applies on top of F only.';
  END IF;
END $$;

-- ── 1. BUG-ARCHIVESOFTDELBATCH-001: the dead pick links, hard-deleted once. ─────────────────────────
-- BEGIN dead-pick-sweep (tests/integration/batchbuilder-archive.int.test.js runs exactly this block)
DO $$
DECLARE
  v_ids text;
  v_n   bigint;
BEGIN
  WITH gone AS (
    DELETE FROM public.kitchen_batch_input i
     WHERE i.harvest_log_id IS NOT NULL
       AND ( i.deleted_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM public.kitchen_batch b
                         WHERE b.id = i.batch_id AND b.deleted_at IS NOT NULL) )
    RETURNING i.id, i.batch_id
  )
  SELECT count(*), string_agg(g.id::text || ' (batch ' || g.batch_id::text || ')', ', ')
    INTO v_n, v_ids
    FROM gone g;
  RAISE NOTICE 'v5-batchbuilder-001: % dead pick link(s) removed%', v_n,
    CASE WHEN v_n > 0 THEN ': ' || v_ids ELSE '' END;
END $$;
-- END dead-pick-sweep

-- ── 2. The stamp, in the same transaction as everything above. ──────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-batchbuilder-001',
        'V5-BATCHBUILDER-001 (Put-Up B'' release 3, the batch builder): no DDL (remaining_amount and the '
        'thirteen-column preservation_log audit came with F). BUG-ARCHIVESOFTDELBATCH-001: pick lines under '
        'a soft-deleted batch, or soft-deleted themselves, hard-deleted once so no planting or container '
        'archive meets a bare 23503; a standing gate keeps it so.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
