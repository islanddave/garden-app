-- 0a-stamp.sql
-- schema_version: 5.3.12-tenancykeys-001
-- V5-SPACETENANCYKEY-001 (multi-space plan V204 step 2.0e, §2.4): arms the index gate
--   post_s_unique_indexes_carry_workspace. Plan: project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md.
--
-- SCOPE: one schema_version row. No DDL, no other data. This directory is a gate; the stamp is what it arms on
--   (the house rule: a standing gate keys on its own migration's schema_version row, review DSA I3; the
--   v5-tenantgates-001 and v5-tenancyclasses-001 pattern). Writing the stamp IS arming it, so step 0 first
--   refuses, changing nothing, where the armed gate would red at once: a unique index on an S, D or base-capable
--   C table that carries no tenancy key and is not in scripts/tenancy-index-exemptions.json. The same predicate,
--   and the same VALUES rows, are the gates in gates.yml; lambda/tenancy-keys.static.test.js keeps all three
--   equal to the class file and the exemption file.
--
-- WHY THE DEPLOYED CODE IS UNAFFECTED: nothing reads schema_version at runtime except the gates.
-- LOCKS: one INSERT into schema_version. The house window applies anyway (never at :55-:05, nor 07:00-08:00 UTC;
--   lock_timeout 5s).
-- ROLLBACK: 0r-rollback.sql deletes the stamp; the gate goes vacuous.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0a-stamp.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refuse where the armed gate would red. ───────────────────────────────────────────────────
DO $$
DECLARE
  v_list text;
BEGIN
  SELECT string_agg(f.finding, ', ' ORDER BY f.finding) INTO v_list FROM (
      WITH key_classes (nspname, relname, class, tenancy_column) AS (
        VALUES
        -- BEGIN tenancy-keys classes VALUES
        ('public', 'care_profile', 'C base + private', 'workspace_id'),
        ('public', 'container_closure', 'D', 'descendant_id'),
        ('public', 'critter_state', 'S needs key', NULL),
        ('public', 'cultivar_weight_sample', 'S needs key', NULL),
        ('public', 'cultivar_weight_void', 'S needs key', NULL),
        ('public', 'daily_plan', 'S needs key', NULL),
        ('public', 'entity', 'C base + private', 'workspace_id'),
        ('public', 'entity_memory', 'D', 'plant_id'),
        ('public', 'entity_tag', 'D', 'entity_id'),
        ('public', 'event_batches', 'S needs key', NULL),
        ('public', 'event_log', 'D', 'project_id'),
        ('public', 'event_log_archive', 'D', 'archived_project_id'),
        ('public', 'evidence', 'C base + private', NULL),
        ('public', 'favorites', 'S needs key', NULL),
        ('public', 'findings', 'S needs key', NULL),
        ('public', 'garden_shared_state', 'S has key', 'workspace_id'),
        ('public', 'harvest_log', 'D', 'project_id'),
        ('public', 'harvest_log_archive', 'D', 'archived_project_id'),
        ('public', 'harvest_watch_dismissal', 'D', 'plant_id'),
        ('public', 'inactive_project_dismissals', 'D', 'project_id'),
        ('public', 'inventory_items', 'S needs key', NULL),
        ('public', 'kitchen_batch', 'S needs key', NULL),
        ('public', 'kitchen_batch_input', 'D', 'batch_id'),
        ('public', 'kitchen_stage_log', 'D', 'batch_id'),
        ('public', 'locations', 'S needs key', NULL),
        ('public', 'merge_event', 'D event-time copy', 'workspace_id'),
        ('public', 'pantry_item', 'S needs key', NULL),
        ('public', 'pantry_use', 'D', 'preservation_log_id'),
        ('public', 'photo_detach_archive', 'D', 'photo_id'),
        ('public', 'photos', 'S needs key', NULL),
        ('public', 'plant_anchor_derivation', 'D', 'plant_id'),
        ('public', 'plant_projects', 'S has key', 'workspace_id'),
        ('public', 'plant_varieties', 'C base + private', NULL),
        ('public', 'plants', 'S has key', 'workspace_id'),
        ('public', 'plots', 'S new', 'workspace_id'),
        ('public', 'preservation_log', 'S needs key', NULL),
        ('public', 'preservation_source', 'D', 'preservation_log_id'),
        ('public', 'proj_rescope_events', 'S needs key', NULL),
        ('public', 'project_types', 'C base + private', NULL),
        ('public', 'ready_impression', 'D', 'plant_id'),
        ('public', 'recipe', 'S needs key', NULL),
        ('public', 'recipe_ingredient', 'D', 'recipe_id'),
        ('public', 'recipe_type', 'C base + private', NULL),
        ('public', 'reparent_event', 'D event-time copy', 'workspace_id'),
        ('public', 'seed_lot_addition', 'D', 'parent_link_id'),
        ('public', 'seed_lot_parent_planting', 'D', 'plant_id'),
        ('public', 'seed_lot_stage_log', 'D', 'inventory_item_id'),
        ('public', 'seen_event', 'S has key', 'workspace_id'),
        ('public', 'share_log', 'D', 'photo_id'),
        ('public', 'slug_alias', 'D', 'entity_id'),
        ('public', 'slug_redirects', 'S needs key', NULL),
        ('public', 'source', 'S needs key', NULL),
        ('public', 'space_suggestions', 'D', 'space_id'),
        ('public', 'spacetheme', 'S keyed by space_id', 'space_id'),
        ('public', 'storage_location', 'S needs key', NULL),
        ('public', 'tag', 'S needs key', NULL),
        ('public', 'tasks', 'S needs key', NULL),
        ('public', 'treatment_association', 'S has key', 'workspace_id'),
        ('public', 'variety_blend_component', 'C base + private', NULL),
        ('public', 'voice_alias', 'S needs key', NULL),
        ('public', 'watch_exclusion', 'D', 'plant_id'),
        ('public', 'watch_impression', 'D', 'plant_id'),
        ('public', 'weather_cold_range', 'D via plot', 'space_id'),
        ('public', 'weather_cue_impression', 'S needs key', NULL),
        ('public', 'weather_daily', 'D via plot', 'space_id')
        -- END tenancy-keys classes VALUES
      ),
      exemptions (nspname, relname, indexname, class) AS (
        VALUES
        -- BEGIN tenancy-index-exemptions VALUES
        ('public', 'care_profile', 'care_profile_scope_uniq', 3),
        ('public', 'care_profile', 'care_profile_system_uniq', 4),
        ('public', 'critter_state', 'idx_critter_state_source_event_id', 5),
        ('public', 'daily_plan', 'daily_plan_user_id_plan_date_key', 6),
        ('public', 'entity', 'entity_critter_uniq', 4),
        ('public', 'entity', 'entity_crop_uniq', 4),
        ('public', 'entity', 'entity_cultivar_uniq', 4),
        ('public', 'entity', 'entity_planting_uniq', 3),
        ('public', 'event_batches', 'event_batches_idempotency_key_key', 5),
        ('public', 'evidence', 'uq_evidence_source_record_live', 5),
        ('public', 'favorites', 'favorites_user_id_entity_type_entity_id_key', 6),
        ('public', 'findings', 'uq_findings_live_natural', 3),
        ('public', 'inventory_items', 'uq_inventory_items_idempotency_key', 5),
        ('public', 'kitchen_batch', 'uq_kitchen_batch_idempotency_key', 5),
        ('public', 'kitchen_batch_input', 'uq_kbi_id_preservation_log_id', 2),
        ('public', 'kitchen_batch_input', 'uq_kbi_idempotency_key', 5),
        ('public', 'kitchen_stage_log', 'uq_ksl_idempotency_key', 5),
        ('public', 'kitchen_stage_log', 'uq_ksl_voids_id', 3),
        ('public', 'locations', 'idx_locations_child_slug', 3),
        ('public', 'locations', 'idx_locations_root_slug', 6),
        ('public', 'locations', 'locations_qr_code_slug_key', 6),
        ('public', 'merge_event', 'merge_event_op_uniq', 5),
        ('public', 'pantry_item', 'uq_pantry_item_idempotency_key', 5),
        ('public', 'pantry_use', 'uq_pantry_use_idempotency_key', 5),
        ('public', 'pantry_use', 'uq_pantry_use_reverses_use_id', 3),
        ('public', 'photos', 'idx_photos_content_hash_uniq', 6),
        ('public', 'plant_projects', 'plant_projects_slug_key', 6),
        ('public', 'plant_varieties', 'plant_varieties_source_proj_rescope_uniq', 3),
        ('public', 'plant_varieties', 'uq_plant_varieties_creator_blend_key_live', 6),
        ('public', 'plant_varieties', 'uq_plant_varieties_name_species', 6),
        ('public', 'plants', 'plants_id_project_uq', 2),
        ('public', 'preservation_log', 'uq_preservation_log_idempotency_key', 5),
        ('public', 'recipe', 'uq_recipe_idempotency_key', 5),
        ('public', 'recipe_type', 'uq_recipe_type_builtin_label', 6),
        ('public', 'recipe_type', 'uq_recipe_type_user_label', 6),
        ('public', 'reparent_event', 'reparent_op_uniq', 6),
        ('public', 'seed_lot_addition', 'uq_sla_addition_key', 5),
        ('public', 'slug_redirects', 'uq_slug_namespace', 6),
        ('public', 'source', 'uq_source_match_key_live', 6),
        ('public', 'storage_location', 'uq_storage_location_user_kind_label', 6),
        ('public', 'tag', 'uq_tag_facet_slug_owner', 6),
        ('public', 'variety_blend_component', 'uq_vbc_blend_component_live', 3),
        ('public', 'voice_alias', 'uq_voice_alias_user_phrase', 6),
        ('public', 'weather_cue_impression', 'uq_weather_cue_impression_day', 6)
        -- END tenancy-index-exemptions VALUES
      ),
      uniq AS (
        SELECT k.nspname, k.relname, k.class, k.tenancy_column, ic.relname::text AS indexname,
               i.indexrelid, i.indrelid, i.indisprimary, i.indnkeyatts, i.indnullsnotdistinct,
               i.indkey::int2[] AS indkey, coalesce(pg_get_expr(i.indpred, i.indrelid), '') AS pred
          FROM key_classes k
          JOIN pg_namespace n ON n.nspname = k.nspname
          JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = k.relname
          JOIN pg_index i ON i.indrelid = c.oid AND i.indisunique
          JOIN pg_class ic ON ic.oid = i.indexrelid
      ),
      keycols AS (
        SELECT u.indexrelid, x.ord, x.attnum, a.attname::text AS attname
          FROM uniq u
         CROSS JOIN LATERAL unnest(u.indkey) WITH ORDINALITY AS x(attnum, ord)
          LEFT JOIN pg_attribute a ON a.attrelid = u.indrelid AND a.attnum = x.attnum AND x.attnum > 0
         WHERE x.ord <= u.indnkeyatts
      ),
      verdict AS (
        SELECT u.nspname, u.relname, u.indexname, u.class, u.indnullsnotdistinct,
               (SELECT string_agg(coalesce(kc.attname, '<expr>'), ', ' ORDER BY kc.ord)
                  FROM keycols kc WHERE kc.indexrelid = u.indexrelid) AS keys,
               (u.indisprimary AND u.indnkeyatts = 1
                AND EXISTS (SELECT 1 FROM keycols kc WHERE kc.indexrelid = u.indexrelid AND kc.attname = 'id')) AS pk_on_id,
               EXISTS (SELECT 1 FROM keycols kc
                        WHERE kc.indexrelid = u.indexrelid
                          AND (kc.attname = 'workspace_id' OR kc.attname = u.tenancy_column)) AS has_key,
               (u.class = 'D via plot'
                AND EXISTS (SELECT 1 FROM keycols kc
                             WHERE kc.indexrelid = u.indexrelid AND kc.attname IN ('space_id', 'plot_id'))) AS has_plot_key,
               EXISTS (SELECT 1 FROM keycols kc
                         JOIN pg_constraint f ON f.conrelid = u.indrelid AND f.contype = 'f' AND f.conkey = ARRAY[kc.attnum]
                         JOIN pg_class t ON t.oid = f.confrelid
                         JOIN pg_namespace tn ON tn.oid = t.relnamespace
                         JOIN key_classes p ON p.nspname = tn.nspname::text AND p.relname = t.relname::text
                        WHERE kc.indexrelid = u.indexrelid AND kc.ord = 1
                          AND (p.class LIKE 'S%' OR p.class LIKE 'D%')) AS leads_with_fk,
               (u.pred ~ '(^|\(|AND )is_base( AND |\)|$)' AND u.pred !~* '\mOR\M') AS base_pred
          FROM uniq u
      )
      SELECT v.nspname || '.' || v.relname || '.' || v.indexname || ' (' || v.class || '; ' || v.keys || ')' AS finding
        FROM verdict v
       WHERE NOT v.pk_on_id
         AND NOT (NOT v.indnullsnotdistinct
                  AND ((v.class LIKE 'S%' AND v.has_key)
                    OR (v.class LIKE 'D%' AND (v.has_key OR v.has_plot_key OR v.leads_with_fk))
                    OR (v.class = 'C base + private' AND (v.has_key OR v.base_pred))))
         AND NOT EXISTS (SELECT 1 FROM exemptions e
                          WHERE e.nspname = v.nspname AND e.relname = v.relname AND e.indexname = v.indexname)
       ORDER BY 1
  ) f;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'v5-tenancykeys-001 0a refused, nothing changed: %. post_s_unique_indexes_carry_workspace would red at once: key the index on workspace_id, or add it to scripts/tenancy-index-exemptions.json (and the VALUES blocks) with its class.', v_list;
  END IF;
END $$;

-- ── 1. The stamp. Arming and applying are one event. ─────────────────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.3.12-tenancykeys-001',
        'TENANCYKEYS: V5-SPACETENANCYKEY-001 (2.0e). Arms post_s_unique_indexes_carry_workspace: every unique '
        'index on an S, D or base-capable C table carries the tenancy key or is exempt by class. No DDL; no other data.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
