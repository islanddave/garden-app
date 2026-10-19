-- 0a-stamp.sql
-- schema_version: 5.3.8-tenancyclasses-001
-- V5-SPACETENANCYKEY-001 (multi-space plan V204 step 2.0b, §2.1): arms the relkind gate
--   post_tenancy_classes_closed_world. Plan: project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md.
--
-- SCOPE: one schema_version row. No DDL, no other data. This directory is a gate; the stamp is what it arms on
--   (the house rule: a standing gate keys on its own migration's schema_version row, review DSA I3; the
--   v5-tenantgates-001 pattern). Writing the stamp IS arming it, so step 0 first refuses, changing nothing, where
--   the armed gate would red at once: a live relation lambda/tenancy-classes.json does not class, or a classed
--   relation that is gone or changed relkind (pending rows excepted until their stamp). The same predicate, and
--   the same VALUES rows, are the gates in gates.yml; lambda/tenancy-classes.test.js keeps all three equal to
--   the class file.
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
      WITH tenancy_classes (nspname, relname, relkind, class, tenancy_column, pending_stamp) AS (
        VALUES
        -- BEGIN tenancy-classes VALUES
        ('public', 'achievements', 'r', 'C base only', NULL, NULL),
        ('public', 'app_config', 'r', 'P', NULL, NULL),
        ('public', 'app_events', 'r', 'P', NULL, NULL),
        ('public', 'audit_events', 'r', 'P', NULL, NULL),
        ('public', 'care_profile', 'r', 'C base + private', 'workspace_id', NULL),
        ('public', 'container', 'v', 'S has key', 'workspace_id', NULL),
        ('public', 'container_closure', 'r', 'D', 'descendant_id', NULL),
        ('public', 'critter_species', 'r', 'C base only', NULL, NULL),
        ('public', 'critter_species_prefs', 'r', 'Person', 'created_by', NULL),
        ('public', 'critter_state', 'r', 'S needs key', NULL, NULL),
        ('public', 'crop_types', 'r', 'C base only', NULL, NULL),
        ('public', 'cultivar', 'v', 'C base + private', NULL, NULL),
        ('public', 'cultivar_weight_crossunit_suspect', 'v', 'View', NULL, NULL),
        ('public', 'cultivar_weight_derived', 'v', 'View', NULL, NULL),
        ('public', 'cultivar_weight_sample', 'r', 'S needs key', NULL, NULL),
        ('public', 'cultivar_weight_void', 'r', 'S needs key', NULL, NULL),
        ('public', 'daily_plan', 'r', 'S needs key', NULL, NULL),
        ('public', 'entity', 'r', 'C base + private', 'workspace_id', NULL),
        ('public', 'entity_memory', 'r', 'D', 'plant_id', NULL),
        ('public', 'entity_tag', 'r', 'D', 'entity_id', NULL),
        ('public', 'event_batches', 'r', 'S needs key', NULL, NULL),
        ('public', 'event_log', 'r', 'D', 'project_id', NULL),
        ('public', 'event_log_archive', 'r', 'D', 'archived_project_id', NULL),
        ('public', 'event_log_public', 'v', 'View', NULL, NULL),
        ('public', 'evidence', 'r', 'C base + private', NULL, NULL),
        ('public', 'evidence_source_tier', 'r', 'C base only', NULL, NULL),
        ('public', 'favorites', 'r', 'S needs key', NULL, NULL),
        ('public', 'findings', 'r', 'S needs key', NULL, NULL),
        ('public', 'garden_node', 'v', 'S has key', 'workspace_id', NULL),
        ('public', 'garden_shared_state', 'r', 'S has key', 'workspace_id', NULL),
        ('public', 'harvest_log', 'r', 'D', 'project_id', NULL),
        ('public', 'harvest_log_archive', 'r', 'D', 'archived_project_id', NULL),
        ('public', 'harvest_watch_dismissal', 'r', 'D', 'plant_id', NULL),
        ('public', 'inactive_project_dismissals', 'r', 'D', 'project_id', NULL),
        ('public', 'inventory_items', 'r', 'S needs key', NULL, NULL),
        ('public', 'kitchen_batch', 'r', 'S needs key', NULL, NULL),
        ('public', 'kitchen_batch_input', 'r', 'D', 'batch_id', NULL),
        ('public', 'kitchen_stage_log', 'r', 'D', 'batch_id', NULL),
        ('public', 'locations', 'r', 'S needs key', NULL, NULL),
        ('public', 'locations_with_path', 'v', 'View', NULL, NULL),
        ('public', 'maintenance_flags', 'r', 'P', NULL, NULL),
        ('public', 'merge_event', 'r', 'D event-time copy', 'workspace_id', NULL),
        ('public', 'notification_subscriptions', 'r', 'Person', 'user_id', NULL),
        ('public', 'pantry_item', 'r', 'S needs key', NULL, NULL),
        ('public', 'pantry_use', 'r', 'D', 'preservation_log_id', NULL),
        ('public', 'photo_detach_archive', 'r', 'D', 'photo_id', NULL),
        ('public', 'photos', 'r', 'S needs key', NULL, NULL),
        ('public', 'plant_anchor_derivation', 'r', 'D', 'plant_id', NULL),
        ('public', 'plant_projects', 'r', 'S has key', 'workspace_id', NULL),
        ('public', 'plant_varieties', 'r', 'C base + private', NULL, NULL),
        ('public', 'plants', 'r', 'S has key', 'workspace_id', NULL),
        ('public', 'platform_operators', 'r', 'P', NULL, NULL),
        ('public', 'plots', 'r', 'S new', 'workspace_id', '5.3.6-plottier-001'),
        ('public', 'preservation_log', 'r', 'S needs key', NULL, NULL),
        ('public', 'preservation_source', 'r', 'D', 'preservation_log_id', NULL),
        ('public', 'profiles', 'r', 'Person', 'id', NULL),
        ('public', 'proj_rescope_events', 'r', 'S needs key', NULL, NULL),
        ('public', 'project_types', 'r', 'C base + private', NULL, NULL),
        ('public', 'rate_limit_buckets', 'r', 'P', NULL, NULL),
        ('public', 'ready_impression', 'r', 'D', 'plant_id', NULL),
        ('public', 'recipe', 'r', 'S needs key', NULL, NULL),
        ('public', 'recipe_ingredient', 'r', 'D', 'recipe_id', NULL),
        ('public', 'recipe_type', 'r', 'C base + private', NULL, NULL),
        ('public', 'reparent_event', 'r', 'D event-time copy', 'workspace_id', NULL),
        ('public', 'schema_version', 'r', 'P', NULL, NULL),
        ('public', 'seed_lot_addition', 'r', 'D', 'parent_link_id', NULL),
        ('public', 'seed_lot_parent_planting', 'r', 'D', 'plant_id', NULL),
        ('public', 'seed_lot_stage_log', 'r', 'D', 'inventory_item_id', NULL),
        ('public', 'seen_event', 'r', 'S has key', 'workspace_id', NULL),
        ('public', 'share_log', 'r', 'D', 'photo_id', NULL),
        ('public', 'slug_alias', 'r', 'D', 'entity_id', NULL),
        ('public', 'slug_redirects', 'r', 'S needs key', NULL, NULL),
        ('public', 'source', 'r', 'S needs key', NULL, NULL),
        ('public', 'source_kind', 'r', 'C base only', NULL, NULL),
        ('public', 'space_suggestions', 'r', 'D', 'space_id', NULL),
        ('public', 'spaces', 'r', 'P', NULL, NULL),
        ('public', 'spacetheme', 'r', 'S keyed by space_id', 'space_id', NULL),
        ('public', 'stat_care_day', 'v', 'View', NULL, NULL),
        ('public', 'stat_heat_clock_crop', 'v', 'View', NULL, NULL),
        ('public', 'stat_heat_clock_cultivar', 'v', 'View', NULL, NULL),
        ('public', 'stat_heat_ladder', 'v', 'View', NULL, NULL),
        ('public', 'stat_longest_giving', 'v', 'View', NULL, NULL),
        ('public', 'stat_pepper_best', 'v', 'View', NULL, NULL),
        ('public', 'stat_pick', 'v', 'View', NULL, NULL),
        ('public', 'stat_planting', 'v', 'View', NULL, NULL),
        ('public', 'stat_planting_harvest', 'v', 'View', NULL, NULL),
        ('public', 'stat_saved_lot', 'v', 'View', NULL, NULL),
        ('public', 'stat_season_pins', 'v', 'View', NULL, NULL),
        ('public', 'stat_source_card', 'v', 'View', NULL, NULL),
        ('public', 'stat_source_mix', 'v', 'View', NULL, NULL),
        ('public', 'stat_tomato_keep', 'v', 'View', NULL, NULL),
        ('public', 'stat_tomato_month_size', 'v', 'View', NULL, NULL),
        ('public', 'stat_weather_day', 'v', 'View', 'space_id', NULL),
        ('public', 'stat_weekly_heat_fruit', 'v', 'View', NULL, NULL),
        ('public', 'storage_location', 'r', 'S needs key', NULL, NULL),
        ('public', 'tag', 'r', 'S needs key', NULL, NULL),
        ('public', 'tasks', 'r', 'S needs key', NULL, NULL),
        ('public', 'treatment_association', 'r', 'S has key', 'workspace_id', NULL),
        ('public', 'user_achievements', 'r', 'Person', 'user_id', NULL),
        ('public', 'user_notification_prefs', 'r', 'Person', 'created_by', NULL),
        ('public', 'user_public_profile', 'v', 'View', NULL, NULL),
        ('public', 'user_stats', 'r', 'Person', 'user_id', NULL),
        ('public', 'ux_events', 'r', 'P', NULL, NULL),
        ('public', 'v_container_recency', 'v', 'View', NULL, NULL),
        ('public', 'v_kitchen_batch_current', 'v', 'View', NULL, NULL),
        ('public', 'v_resolved_care', 'v', 'View', NULL, NULL),
        ('public', 'v_sow_candidates', 'v', 'View', NULL, NULL),
        ('public', 'variety_blend_component', 'r', 'C base + private', NULL, NULL),
        ('public', 'voice_alias', 'r', 'S needs key', NULL, NULL),
        ('public', 'watch_exclusion', 'r', 'D', 'plant_id', NULL),
        ('public', 'watch_impression', 'r', 'D', 'plant_id', NULL),
        ('public', 'weather_cold_range', 'r', 'D via plot', 'space_id', NULL),
        ('public', 'weather_cue_impression', 'r', 'S needs key', NULL, NULL),
        ('public', 'weather_daily', 'r', 'D via plot', 'space_id', NULL),
        ('public', 'xp_events', 'r', 'Person', 'user_id', NULL)
        -- END tenancy-classes VALUES
      ),
      live AS (
        SELECT n.nspname::text AS nspname, c.relname::text AS relname, c.relkind::text AS relkind
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname !~ '^pg_(toast|temp_)'
           AND c.relname !~ '^ctas_'
           AND c.relname !~ '^snap_'
           AND c.relname !~ '^harvest_log_weight_snapshot_'
           AND c.relname !~ '^plants_legacy_cols_backup_'
      )
      SELECT 'unclassed ' || l.nspname || '.' || l.relname || ' (relkind ' || l.relkind || ')' AS finding
        FROM live l
         WHERE NOT EXISTS (SELECT 1 FROM tenancy_classes k WHERE k.nspname = l.nspname AND k.relname = l.relname)
      UNION ALL
      SELECT 'stale ' || k.nspname || '.' || k.relname || ' (relkind ' || k.relkind || ')'
        FROM tenancy_classes k
         WHERE (k.pending_stamp IS NULL OR EXISTS (SELECT 1 FROM public.schema_version v WHERE v.version = k.pending_stamp))
           AND NOT EXISTS (SELECT 1 FROM live l WHERE l.nspname = k.nspname AND l.relname = k.relname AND l.relkind = k.relkind)
  ) f;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'v5-tenancyclasses-001 0a refused, nothing changed: %. post_tenancy_classes_closed_world would red at once: class the relation in lambda/tenancy-classes.json (and the VALUES blocks), or drop the stale row.', v_list;
  END IF;
END $$;

-- ── 1. The stamp. Arming and applying are one event. ─────────────────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.3.8-tenancyclasses-001',
        'TENANCYCLASSES: V5-SPACETENANCYKEY-001 (2.0b). Arms post_tenancy_classes_closed_world: the live catalog '
        'and lambda/tenancy-classes.json name the same relations. No DDL; no other data.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
