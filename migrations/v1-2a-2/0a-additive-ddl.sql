-- V1.2a-2 Session 1 — 0a additive DDL
-- Date: 2026-05-13
-- Scope: event_log column adds; new tables (harvest_log, notification_subscriptions,
--        inactive_project_dismissals); entity_memory column add; indexes; achievement seeds.
-- Safe to apply BEFORE Session 2 Lambda updates (additive only; defaults preserve back-compat).
--
-- Locked decisions (Dave AskUserQuestion 2026-05-13):
--   Q-A Tile 3 zero-state: HIDE (Lambda/UI concern in S3; no DDL impact).
--   Q-B harvest_log.unit enum: ACCEPT — lb, oz, kg, g, count, bunch, cup, head (8 values).
--   Q-C 6 new achievement seeds: APPROVE ALL (580 XP total; harvest_quantity + harvest_quality
--       + issue_resolve_count trigger types; reuse event_type_count for harvest_century).
--
-- L-058: chk_event_log_severity_requires_flag added NOT VALID here, validated in 0c
--        after pre-VALIDATE sweep (no deleted_at filter; mirrors VALIDATE all-row scope).

BEGIN;

-- §3.1 event_log additions
ALTER TABLE event_log
  ADD COLUMN IF NOT EXISTS flagged_as_issue BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS severity SMALLINT NULL
    CHECK (severity IS NULL OR severity BETWEEN 1 AND 3),
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ NULL;

-- Cross-column invariant (NOT VALID; validated in 0c after sweep)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_event_log_severity_requires_flag'
  ) THEN
    ALTER TABLE event_log
      ADD CONSTRAINT chk_event_log_severity_requires_flag
      CHECK (flagged_as_issue = true OR severity IS NULL) NOT VALID;
  END IF;
END$$;

-- §3.2 harvest_log
-- Convention (Lambda-enforced): every harvest_log row has a paired event_log row
-- (event_id FK, event_type='harvest', quantity_numeric=harvest_log.quantity).
-- ON DELETE RESTRICT because event_log uses soft-delete; cascade would never fire.
CREATE TABLE IF NOT EXISTS harvest_log (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  event_id UUID NOT NULL UNIQUE REFERENCES event_log(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES plant_projects(id) ON DELETE RESTRICT,
  quantity NUMERIC NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('lb','oz','kg','g','count','bunch','cup','head')),
  quality_rating SMALLINT NULL
    CHECK (quality_rating IS NULL OR quality_rating BETWEEN 1 AND 5),
  notes TEXT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ NULL
);

-- §3.3 notification_subscriptions
-- V1.2a-2 stub: records browser Notification.permission state per user.
-- V1.2b will extend to per-device (origin-scoped) if multi-device push is needed.
CREATE TABLE IF NOT EXISTS notification_subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  permission_state TEXT NOT NULL DEFAULT 'default'
    CHECK (permission_state IN ('default','granted','denied')),
  granted_at TIMESTAMPTZ NULL,
  last_prompted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- §3.4 inactive_project_dismissals — per-user composite PK
CREATE TABLE IF NOT EXISTS inactive_project_dismissals (
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES plant_projects(id) ON DELETE CASCADE,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

-- §3.5 entity_memory (last_harvested_at, last_observed_at, last_event_at already exist per probe)
ALTER TABLE entity_memory
  ADD COLUMN IF NOT EXISTS last_issue_at TIMESTAMPTZ NULL;

-- §3.6 Indexes
CREATE INDEX IF NOT EXISTS idx_event_log_flagged
  ON event_log (project_id, created_at DESC)
  WHERE flagged_as_issue = true AND resolved_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_event_log_harvest
  ON event_log (project_id, event_date DESC)
  WHERE event_type = 'harvest' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_harvest_log_project
  ON harvest_log (project_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_memory_stale
  ON entity_memory (project_id, last_observed_at);

CREATE INDEX IF NOT EXISTS idx_entity_memory_issue
  ON entity_memory (project_id, last_issue_at)
  WHERE last_issue_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inactive_dismissals_user
  ON inactive_project_dismissals (user_id);

-- §3.7 Achievement seeds (6 new; first_harvest + harvester already exist per probe).
-- Sort order range 110-115. Total XP supply: 75+50+200+30+75+150 = 580.
-- New trigger_types: harvest_quantity, harvest_quality, issue_resolve_count.
-- Session 2 Lambda evaluator must implement these. Gaming mitigation on issue_resolve_count:
-- only count resolves where resolved_at >= created_at + INTERVAL '24 hours'.
INSERT INTO achievements
  (slug, name, description, emoji, xp_reward, trigger_type, trigger_value, is_secret, is_active, sort_order)
VALUES
  ('big_harvest',     'Big Harvest',     'Log a single harvest of 25+ count',
     '🧺', 75,  'harvest_quantity',     '{"quantity_gte": 25}'::jsonb,             false, true, 110),
  ('quality_grower',  'Quality Grower',  'Log a 5-star harvest',
     '⭐', 50,  'harvest_quality',      '{"quality_rating": 5}'::jsonb,            false, true, 111),
  ('harvest_century', 'Harvest Century', 'Reach 25 total harvest events',
     '💯', 200, 'event_type_count',     '{"type": "harvest", "count": 25}'::jsonb, false, true, 112),
  ('attentive',       'Attentive',       'Resolve your first flagged issue',
     '👀', 30,  'issue_resolve_count',  '{"count": 1}'::jsonb,                     false, true, 113),
  ('three_strikes',   'Three Strikes',   'Resolve 3 flagged issues',
     '✅', 75,  'issue_resolve_count',  '{"count": 3}'::jsonb,                     false, true, 114),
  ('caretaker',       'Caretaker',       'Resolve 10 flagged issues',
     '🛡️', 150, 'issue_resolve_count',  '{"count": 10}'::jsonb,                    false, true, 115)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
