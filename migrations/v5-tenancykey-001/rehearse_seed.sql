-- rehearse_seed.sql: LOCAL REHEARSAL ONLY. Prod-shaped rows for migrations/v5-tenancykey-001/rehearse_local.py.
-- One or more rows in each of the 25 tables, with the owner values prod carries (Dave, Jen, system, a managed
-- principal, the four pipeline labels, a soft-deleted Dave-dev location) and the parents the parent-join tables
-- read (a planting, a variety, a project). Synthetic: no prod row is copied.
-- Load into the --base-prod database with PGOPTIONS='-c session_replication_role=replica' (no FK or trigger checks;
-- CHECKs still apply). The guard below refuses anything but a loopback or socket connection.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
  IF inet_server_addr() IS NOT NULL AND NOT (inet_server_addr() << inet '127.0.0.0/8' OR inet_server_addr() = inet '::1') THEN
    RAISE EXCEPTION 'rehearse_seed.sql is for a local rehearsal cluster only; this server is not on loopback.';
  END IF;
END $guard$;
-- parents for the parent-join tables
INSERT INTO plants (id, name, created_by) VALUES ('10000000-0000-0000-0000-000000000001', 'seed planting', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI');
INSERT INTO plant_varieties (id, name, created_by) VALUES ('20000000-0000-0000-0000-000000000001', 'seed variety', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI');
INSERT INTO plant_projects (id, slug, name, created_by, kind) VALUES ('30000000-0000-0000-0000-000000000001', 'seed-proj', 'seed project', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI', 'category');

INSERT INTO locations (name, slug, created_by) VALUES ('loc dave', 'loc-dave', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI'),
  ('loc dev', 'loc-dev', 'user_3CxBEbOgG0fmeGmB6D0ohTju0wv');
UPDATE locations SET deleted_at = now() WHERE slug = 'loc-dev';
INSERT INTO photos (storage_path, created_by, plant_id) VALUES ('p/1.jpg', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI', '10000000-0000-0000-0000-000000000001');
INSERT INTO inventory_items (user_id, created_by, type, name, category, quantity) VALUES
  ('user_3D2gM0hIl03gjW3JM2DjtPzm0jI', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI', 'durable', 'trowel', 'tools', 1);
INSERT INTO storage_location (id, user_id, label, kind) VALUES ('40000000-0000-0000-0000-000000000001', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI', 'freezer', 'deep_freezer');
INSERT INTO preservation_log (user_id, preserved_at, method, label, quantity_value, quantity_unit, package_count)
  VALUES ('user_3D2gM0hIl03gjW3JM2DjtPzm0jI', current_date, 'whole_freeze', 'beans', 1, 'jar', 1);
INSERT INTO kitchen_batch (user_id, label) VALUES ('user_3D2gM0hIl03gjW3JM2DjtPzm0jI', 'kraut');
INSERT INTO pantry_item (user_id, name, storage_location_id) VALUES ('user_3D2gM0hIl03gjW3JM2DjtPzm0jI', 'jam', '40000000-0000-0000-0000-000000000001');
INSERT INTO recipe (user_id, name) VALUES ('user_3D2gM0hIl03gjW3JM2DjtPzm0jI', 'mash');
INSERT INTO tag (facet, label, slug, source, owner_id, visibility, created_by) VALUES
  ('freeform', 'a', 'a', 'user', 'system', 'shared', 'system'),
  ('freeform', 'b', 'b', 'user', 'system', 'shared', 'rescue-intake-longriver-20260712');
INSERT INTO critter_state (created_by, species_id, target_kind, target_id, source_event_id) VALUES
  ('user_3E2xA85kQhr1vSZhiv4W1GLudJV', 1, 'plant', '10000000-0000-0000-0000-000000000001', gen_random_uuid());
INSERT INTO findings (engine_version, garden_node_id, entity_id, finding_type, finding_kind, statement, severity,
                      confidence_local, confidence_transferable, confidence_band, assertion_mode, decay_state, trend, channel)
  VALUES ('1', '10000000-0000-0000-0000-000000000001', gen_random_uuid(), 'x', 'diagnostic', 's', 'low', 0.5, 0.5,
          'low', 'assert', 'fresh', 'steady', 'ambient');
INSERT INTO tasks (title, created_by) VALUES ('water', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI');
INSERT INTO event_batches (idempotency_key, created_by, event_type, scope_json, event_date) VALUES
  ('k1', 'user_3E2xA85kQhr1vSZhiv4W1GLudJV', 'water', '{}', current_date);
INSERT INTO daily_plan (user_id, plan_date) VALUES ('user_3E2xA85kQhr1vSZhiv4W1GLudJV', current_date);
INSERT INTO favorites (user_id, entity_type, entity_id) VALUES ('user_3E2xA85kQhr1vSZhiv4W1GLudJV', 'plant', '10000000-0000-0000-0000-000000000001');
INSERT INTO voice_alias (user_id, heard_key, heard_text, variety_id) VALUES ('user_3D2gM0hIl03gjW3JM2DjtPzm0jI', 'sungold', 'sun gold', '20000000-0000-0000-0000-000000000001');
INSERT INTO proj_rescope_events (action, actor, project_id) VALUES ('classified', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI', '30000000-0000-0000-0000-000000000001');
INSERT INTO weather_cue_impression (user_id, shown_on, cue, form, model_version) VALUES ('user_3D2gM0hIl03gjW3JM2DjtPzm0jI', current_date, 'cold', 'check', 'v1');
INSERT INTO cultivar_weight_sample (id, cultivar_id, unit, total_grams, unit_count, sampled_at, created_by) VALUES
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'count', 100, 2, now(), 'cal1-seed'),
  ('50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'count', 90, 2, now(), 'migration:v4-harvweightest-001');
INSERT INTO cultivar_weight_void (sample_id, created_by) VALUES
  ('50000000-0000-0000-0000-000000000001', 'res008-backfill'),
  ('50000000-0000-0000-0000-000000000002', 'agent:mainsync13-20260928');
INSERT INTO source (name, created_by) VALUES ('Johnny''s', 'system'), ('Farm', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI');
INSERT INTO slug_redirects (source_slug, source_entity_type, target_entity_type, target_entity_id, reason) VALUES
  ('old-proj', 'project', 'variety', '20000000-0000-0000-0000-000000000001', 'rescope'),
  ('old-plant', 'plant', 'planting', '10000000-0000-0000-0000-000000000001', 'rescope'),
  ('old-proj2', 'project', 'project', '30000000-0000-0000-0000-000000000001', 'rename');
INSERT INTO treatment_association (target, target_id, treatment_type, started_at)
  SELECT e.enumlabel::node_class, '10000000-0000-0000-0000-000000000001', 'spray', now()
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'node_class' ORDER BY e.enumsortorder LIMIT 1;
INSERT INTO seen_event (leaf_id) VALUES ('10000000-0000-0000-0000-000000000001');
INSERT INTO garden_shared_state (kind, natural_key, counter) VALUES ('incentive_counter', 'tally:sightings', 3);
COMMIT;
