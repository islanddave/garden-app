-- 0a-additive-ddl.sql
-- V2-MVP-CRITTER — additive schema for MVP-Critter (Stages 1+2+3 plant-only).
-- Canonical spec: mvp-critter-pre-build-revision-V001-20260528.md
--   §1.1 (plant-only target binding) · §2 (Lambda contracts) · §3.2 (user_notification_prefs)
--   §3.27 (UNIQUE INDEX idempotency) · §3.28 (critter_species_prefs Investment loop) · §4 (8-species pool).
-- Binding parent: reward-ux-guideline-V100-20260518.1830.md (CONTENT-LOCKED).
--
-- Safety: ADDITIVE ONLY — CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. No backfill,
--   no NOT NULL added to an existing table, no VALIDATE → L-058 pre-VALIDATE sweep N/A.
--   Idempotent; re-run is a no-op. Migration Authoring Rule §2 (additive — safe any time).
-- Scope enforcement: ZERO RLS in current Neon (verified ripgrep, revision §3.1).
--   Lambda layer enforces scope via householdScope() → created_by = ANY(${householdIds}).
--   V3-ROLES will add RLS later via current_user_role() pattern.
-- UUID generator: house pattern is extensions.uuid_generate_v4() (per v2-quicklog + v1-2a-2 migrations).
--   pgcrypto + uuid-ossp both installed in Neon — using uuid-ossp for consistency.
-- Rollback: DROP TABLE IF EXISTS public.critter_species_prefs, public.user_notification_prefs, public.critter_state;
--   Safe ONLY pre-deploy. Post-deploy requires Lambda + client revert first (Migration Authoring Rule §3).

-- Defensive: schema_version exists in all current envs but guard against fresh provisioning.
CREATE TABLE IF NOT EXISTS public.schema_version (
  version     TEXT PRIMARY KEY,
  description TEXT,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── critter_state ──────────────────────────────────────────────────────────────
-- One row per earned critter. Plant-only binding for MVP per revision §1.1.
-- Cascading 3-target shape (plant/project/location) deferred to V3 expansion.
CREATE TABLE IF NOT EXISTS public.critter_state (
  id                  UUID         PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  created_by          TEXT         NOT NULL,                                  -- Clerk sub of action-completer; Lambda scope filter
  species_id          SMALLINT     NOT NULL CHECK (species_id BETWEEN 1 AND 255),  -- 1-8 MVP pool, 255 smoke sentinel, 100+ reserved V3
  target_kind         TEXT         NOT NULL CHECK (target_kind IN ('plant')), -- MVP plant-only; V3 adds 'project','location'
  target_id           UUID         NOT NULL,                                  -- denormalized for query speed; mirrors plant_id at insert
  plant_id            UUID         REFERENCES public.plants(id) ON DELETE SET NULL, -- nullable post-cascade (D-DEL-1 Option B re-anchor; render fallback to project)
  source_event_id     UUID         NOT NULL,                                  -- FK target (event_log.id) — no hard FK; events may be hard-deleted
  earned_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),                    -- award timestamp
  viewed_at           TIMESTAMPTZ,                                            -- set by PATCH /api/critters/viewed (Stage 3 dot clearing)
  faded_at            TIMESTAMPTZ,                                            -- set when 24-48h Stage 2 fade timer expires; future server reconciler
  dot_visible_after   TIMESTAMPTZ  NOT NULL DEFAULT now(),                    -- quiet-hours server-side computation per §3.6 (next 07:00 local if in quiet hours)
  -- meta: allowlist-constrained at write time (revision §6 deferred note — prevent behavioral-log creep).
  --   Allowed keys: deterministic_seed (UUID source_event_id), copy_variant_id (int 1-N), client_picked_at (ISO).
  --   No PII, no analytic event data, no user-typed strings.
  meta                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  deleted_at          TIMESTAMPTZ,                                            -- soft-delete sentinel (mirrors plants/projects pattern)
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Idempotency: prevents double-award when same event_id is POSTed twice (e.g., client retry,
--   household-mode race where Dave + Jen both log near-simultaneously on same plant).
-- Partial WHERE deleted_at IS NULL — allows replay after soft-delete (rare; supports test cleanup).
-- Lambda treats Postgres 23505 (unique violation) as idempotent success: SELECT existing, return that row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_critter_state_source_event_id
  ON public.critter_state (source_event_id)
  WHERE deleted_at IS NULL;

-- Active-set scan: GET /api/critters/active orders by earned_at DESC; this index supports it.
CREATE INDEX IF NOT EXISTS idx_critter_state_created_by_active
  ON public.critter_state (created_by, earned_at DESC)
  WHERE deleted_at IS NULL AND faded_at IS NULL;

-- Soft-delete cascade rendering: when plant is soft-deleted, fallback render chain checks plant_id IS NULL.
CREATE INDEX IF NOT EXISTS idx_critter_state_plant_id
  ON public.critter_state (plant_id)
  WHERE deleted_at IS NULL AND plant_id IS NOT NULL;


-- ─── user_notification_prefs ───────────────────────────────────────────────────
-- Stateless-default per revision §3.2: Lambda treats missing row as defaults.
-- Persists only on explicit user toggle action (closes first-read-side-effect finding).
CREATE TABLE IF NOT EXISTS public.user_notification_prefs (
  created_by            TEXT         PRIMARY KEY,                              -- Clerk sub
  critter_visit         TEXT         NOT NULL DEFAULT 'in_app_only'
                        CHECK (critter_visit IN ('off', 'in_app_only', 'system')),
  quiet_hours_start     TIME         NOT NULL DEFAULT '21:00',                 -- user-local; client passes TZ in request header (§3.6)
  quiet_hours_end       TIME         NOT NULL DEFAULT '07:00',
  coachmark_seen_at     TIMESTAMPTZ,                                           -- first-encounter coachmark dismissal (§3.7); single source of truth (no localStorage drift)
  opt_in_prompt_seen_at TIMESTAMPTZ,                                           -- ONLY set after prompt RENDERED (§3.8 suppression-flag fix)
  last_garden_view_at   TIMESTAMPTZ,                                           -- Stage 4 reopen instrumentation (§3.3); PATCH'd on every garden-view-opened event
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);


-- ─── critter_species_prefs (D-INV-1 Option A) ───────────────────────────────────
-- Investment loop schema per revision §3.28. Jen long-presses critter sprite in Stage 2
--   to mark love (weight 2.0) or meh (weight 0.5). Subsequent client-side pickSpecies modulates
--   species probability by weight. No dedicated index needed beyond the composite PK —
--   reads are always per (created_by, species_id) lookup during pickSpecies modulation.
CREATE TABLE IF NOT EXISTS public.critter_species_prefs (
  created_by   TEXT         NOT NULL,                                          -- Clerk sub
  species_id   SMALLINT     NOT NULL,                                          -- pinned pool 1-8 per revision §4 (no FK; pool is client+server constant)
  weight       REAL         NOT NULL DEFAULT 1.0 CHECK (weight > 0),           -- 2.0 = love, 1.0 = neutral, 0.5 = meh
  set_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),                            -- last user action timestamp (useful for meh-decay if ever added)
  PRIMARY KEY (created_by, species_id)
);


INSERT INTO public.schema_version (version, description)
VALUES ('2.2.13a',
        'V2-MVP-CRITTER additive: critter_state + user_notification_prefs + critter_species_prefs '
        '+ source_event_id idempotency unique index. Plant-only target binding (MVP scope cut). '
        'No RLS — Lambda householdScope enforcement. Revision V001 2026-05-28.')
ON CONFLICT (version) DO NOTHING;
