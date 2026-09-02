-- V4-SOWSTAGE-001 — make the sow path aware that seed can be mid-process.
--
-- THE DEFECT, MEASURED NOT ARGUED. v_sow_candidates selects on category='seeds', not deleted,
-- status='active', and a live variety_id. It says nothing about seed_stage. On 2026-09-02 a lot with
-- seed_stage='fermenting' was inserted into an ephemeral Neon branch forked from staging and came
-- back from this view as a sow candidate. So a jar of wet tomato seed sitting in pulp is offered to
-- the user identically to a finished packet — and `grep -c seed_stage` returns 0 for BOTH
-- src/lib/sowEngine.js and src/pages/SowNow.jsx, so nothing downstream corrects it either.
--
-- IT RUNS BOTH WAYS, WHICH IS THE PART THAT MATTERS. Advancing a lot to `stored` grants it nothing:
-- its sowability was already fixed before it was ever staged, by four columns the stage route does
-- not touch. So the whole ferment -> dry -> store loop is decorative with respect to sowing. The
-- user's chain — "save seed -> lifecycle -> a proper SOWABLE seed inventory item" — has no
-- implementation at this link, in either direction.
--
-- WHY A COLUMN APPEND AND NOT A WHERE CLAUSE. Five CONTINUOUS gates across three migrations
-- (v4-sowfirstyear-001:28,73; v4-sowarchive-001:37,114; v4-maturitybasis-001:116) pin this view's
-- ROWCOUNT to its unfiltered base join, and none carries `continuous: false`. Narrowing the view
-- server-side would red all five on prod AND staging on the next migrations/** push. Appending
-- columns changes no rowcount, so all five stay green — VERIFIED by running them on prod after this
-- applied, not assumed.
--
-- IT DID TRIP TWO OTHER GATES, AND THIS IS THE CORRECTION WORTH READING. The recon that scoped this
-- work said appending a column "does not trip them" because the gates pin rowcount, not the column
-- list. That is true of the five rowcount gates and FALSE of the repo as a whole: three separate
-- gates pin an ABSOLUTE COLUMN COUNT on this view. Two already carried `continuous: false`
-- (v4-sowfirstyear-001 post_view_column_count_30, v4-maturitybasis-001 post_view_column_count) with
-- comments explaining that every later widening invalidates a frozen count. The third —
-- v4-sowarchive-001 post_view_column_count_33 — did not, and maturitybasis's own comment records
-- that it did not. This migration is what finally tripped it. It has been flagged apply-window-only
-- to match its two siblings rather than bumped to 35 for the next widening to break again, and
-- v4-dtmbasisvar-001 pre_view_column_count_33 (green only by coincidence, since that migration left
-- the count unchanged) got the same treatment. No durable guard was weakened.
--
-- The diversion is then made client-side in
-- sowEngine, beside the shipped isDepleted() and isArchivedForSeason() — which is also the
-- house-consistent place for it, and the only one that can keep the lot VISIBLE while marking it
-- not-ready. That is the product decision: divert, do not hide. Seed you own should not vanish for
-- two weeks with no cue that it is on its way.
--
-- THE DEFINITION BELOW IS THE INSTALLED ONE, READ FROM pg_get_viewdef, NOT COPIED FROM A MIGRATION
-- FILE. Two migrations both claim to define this view and they DISAGREE on the projection
-- (v4-dtmbasisvar-001 has 33 columns with COALESCE(v.dtm_basis, ct.dtm_basis) plus the two
-- sow_archive columns; v4-maturitybasis-001 has 32 with a bare ct.dtm_basis and neither), and their
-- receipt version strings order them the OPPOSITE way from their content. v4-maturitybasis-001
-- says so itself: "Live pg_get_viewdef is the authority, not the newest migration file." Verified
-- live 2026-09-02 — the installed projection is the 33-column dtmbasisvar shape, reproduced
-- verbatim below with seed_stage and seed_process APPENDED at positions 34 and 35.
--
-- APPEND-ONLY IS A HARD RULE FOR CREATE OR REPLACE VIEW. Postgres refuses to replace a view that
-- renames, reorders, retypes or drops an existing output column. New columns may only go at the end.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

CREATE OR REPLACE VIEW public.v_sow_candidates AS
 SELECT i.id AS inventory_item_id,
    i.name AS item_name,
    i.quantity_on_hand,
    i.unit,
    i.created_by,
    i.purchase_date,
    i.source,
    i.metadata,
    v.id AS variety_id,
    v.name AS variety_name,
    v.crop_type_slug,
    v.lifecycle,
    v.grown_as,
    v.sun_requirements,
    v.days_to_maturity_min,
    v.days_to_maturity_max,
    v.start_method,
    v.start_indoor_weeks_min,
    v.start_indoor_weeks_max,
    v.direct_sow_timing,
    v.sow_depth_in,
    v.seed_spacing_in,
    v.row_spacing_in,
    v.days_to_germ_min,
    v.days_to_germ_max,
    v.sow_season,
    v.sow_notes,
    v.growth_habit,
    v.day_length_response,
    ct.first_year_harvest,
    COALESCE(v.dtm_basis, ct.dtm_basis) AS dtm_basis,
    i.sow_archived_season,
    i.sow_archived_at,
    i.seed_stage,
    i.seed_process
   FROM inventory_items i
     JOIN plant_varieties v ON v.id = i.variety_id
     LEFT JOIN crop_types ct ON ct.slug = v.crop_type_slug
  WHERE i.category = 'seeds'::text AND i.deleted_at IS NULL AND i.status = 'active'::text AND v.deleted_at IS NULL;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.94.0-sowstage-001',
        'SOWSTAGE: V4-SOWSTAGE-001. v_sow_candidates +seed_stage +seed_process, APPENDED at '
        'positions 34-35. WHERE clause byte-identical to the installed definition read from '
        'pg_get_viewdef — no narrowing, so the five continuous rowcount gates on this view are '
        'untouched. Projection only; the in-process diversion is client-side in sowEngine so an '
        'in-process lot stays VISIBLE and marked rather than disappearing.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;

-- Verify:
-- SELECT column_name, ordinal_position FROM information_schema.columns
--  WHERE table_name='v_sow_candidates' AND column_name IN ('seed_stage','seed_process');
-- SELECT count(*) FROM v_sow_candidates;   -- must equal the pre-apply count
