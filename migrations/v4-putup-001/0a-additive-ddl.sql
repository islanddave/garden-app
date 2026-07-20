-- 0a-additive-ddl.sql
-- V4-PUTUP-001 — "Put-Up" post-harvest preservation LOGGING surface (design
--   harvest-center-app-design-V101-20260720.md, Option A). Creates the two NEW tables the feature
--   needs; touches NO existing table, view, or constraint.
--
-- PURPOSE: land the schema for the Put-Up log (preservation_log) + its storage-location vocab
--   (storage_location), so the CRUD Lambda, the "what's put up" / "use soon" reads, and the
--   put-up overlay have a home. Design decisions this DDL encodes:
--     * L1  — a SEPARATE preservation_log table (NOT an event_log event type). event_log is
--             untouched: no new reader propagation, no critter-award trip, no event_type CHECK risk.
--     * L2  — a SEPARATE storage_location vocab (NOT the garden `locations` tree). The freezer is a
--             kitchen concept, not a By-Space garden node.
--     * L5  — method is text + CHECK against the generalized vocab (NOT a native Postgres ENUM:
--             ALTER TYPE can't run in a txn with other DDL and values can't be cleanly removed).
--             method='other' REQUIRES method_other_text (CHECK) or it's silent data loss. The
--             water-bath / pressure canning split ships in the vocab NOW (safety: low-acid crops
--             must pressure-can — botulism risk — so a generic `can` is never offered).
--     * L7  — crop attribution keys on crop_type_slug FK -> crop_types(slug) (GROUND-TRUTH: crop_types
--             PK is `slug` text, matches inventory_items/plant_varieties). variety_id FK ->
--             plant_varieties(id). At least one of {crop_type_slug, variety_id} is required (CHECK):
--             no unattributable put-up.
--     * L8  — harvest_log_id is an OPTIONAL provenance link to the EXISTING harvest_log(id) (102 rows).
--             A put-up writes NO harvest aggregate; deleting the harvest nulls the link, keeps the put-up.
--     * L4  — minimal decrement: remaining_count + consumed_at keep the inventory truthful so "use soon"
--             never fires on already-eaten stock. NOT the full Culinary depletion engine.
--     * Soft-Delete-Only: deleted_at on BOTH tables; every read filters IS NULL. Cross-Device: user_id
--             (Clerk sub, TEXT — matches inventory_items.created_by) is the server-side scope key.
--   quantity_value numeric(10,2) + quantity_unit text MIRROR the harvest_log {quantity numeric, unit text}
--   convention (design GROUND-TRUTH). package_count = # of containers, distinct from quantity_value = total.
--
-- SAFETY: fully additive + idempotent. CREATE TABLE IF NOT EXISTS; all CHECKs are INLINE on freshly
--   created EMPTY tables, so they are born-valid — there is NO populated table to scan and therefore
--   NO NOT VALID / VALIDATE dance (why this migration has no 0c-validate.sql, unlike v4-seedinv-001;
--   the contract assertion lives in gates.yml `post`). CREATE INDEX IF NOT EXISTS. schema_version
--   INSERT is ON CONFLICT DO NOTHING. Re-running the whole file is a clean no-op. NO destructive DDL.
--   Zero read-impact on any existing surface until app code references the new tables.
--
-- ORDER: storage_location is created FIRST because preservation_log.storage_location_id FKs it.
--
-- APPLY ORDER: 0a (this file) is the only apply step (pure DDL, no data loader). Gates in gates.yml
--   (pre/post; no data sweep — the tables are empty on create). NOT applied to any environment this
--   session (held at dev). Staging-first per gates.yml sequencing; prod is Dave-gated.
--
-- ROLLBACK: 0r-rollback.sql drops both tables (preservation_log first — it depends on storage_location)
--   and the schema_version row. Safe while no consuming code reads the tables; once the Put-Up surfaces
--   are live, prefer rolling back the CODE and leaving these additive tables in place (harmless).

-- 1. storage_location — per-user, soft-deleted vocab of where put-ups live (L2). Created BEFORE
--    preservation_log so the storage_location_id FK target exists.
CREATE TABLE IF NOT EXISTS public.storage_location (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id    text        NOT NULL,
  label      text        NOT NULL,
  kind       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT storage_location_pkey PRIMARY KEY (id),
  CONSTRAINT chk_storage_location_kind
    CHECK (kind IN ('deep_freezer','fridge_freezer','fridge','pantry','cold_storage','other'))
);

CREATE INDEX IF NOT EXISTS idx_storage_location_user
  ON public.storage_location (user_id, deleted_at);

-- 2. preservation_log — the Put-Up log itself (Option A, design §3). Forward-compatible with a future
--    pantry_item merge: `id` is the stable FK target the Culinary epic would key on.
CREATE TABLE IF NOT EXISTS public.preservation_log (
  id                  uuid          NOT NULL DEFAULT gen_random_uuid(),
  user_id             text          NOT NULL,                          -- Clerk sub; server-side scope key (L: Cross-Device)

  -- Attribution (L7): at least one of {crop_type_slug, variety_id} required (CHECK below).
  crop_type_slug      text          REFERENCES public.crop_types(slug),
  variety_id          uuid          REFERENCES public.plant_varieties(id),
  plant_id            uuid          REFERENCES public.plants(id) ON DELETE SET NULL,       -- planting deleted -> keep put-up history
  harvest_log_id      uuid          REFERENCES public.harvest_log(id) ON DELETE SET NULL,  -- OPTIONAL provenance (L8); writes no aggregate

  -- The put-up.
  preserved_at        date          NOT NULL,                          -- user-meaningful put-up date; use-by anchor (L6)
  method              text          NOT NULL,                          -- L5 vocab; text+CHECK, NOT a native enum
  method_other_text   text,                                            -- required when method='other' (CHECK below)
  quantity_value      numeric(10,2) NOT NULL,                          -- total contents (CHECK > 0); mirrors harvest_log.quantity
  quantity_unit       text          NOT NULL,                          -- curated pick-list class; mirrors harvest_log.unit
  package_count       integer       NOT NULL DEFAULT 1,                -- # containers (CHECK >= 1); distinct from quantity_value

  -- Storage + shelf-life.
  storage_location_id uuid          REFERENCES public.storage_location(id),   -- NULL -> "Unassigned" bucket
  use_by_target       date,                                            -- NULL = no expiry (excluded from "use soon"); default computed on render (L6)

  -- Minimal decrement (L4) — keep the inventory truthful; NOT the full depletion engine.
  remaining_count     integer,                                         -- packages left; NULL = untouched (treat as package_count)
  consumed_at         timestamptz,                                     -- set when fully used up

  notes               text,
  photo_id            uuid          REFERENCES public.photos(id),      -- save succeeds independent of photo upload

  created_at          timestamptz   NOT NULL DEFAULT now(),            -- distinct from preserved_at
  updated_at          timestamptz,
  deleted_at          timestamptz,                                     -- Soft-Delete-Only; ALL reads filter IS NULL

  CONSTRAINT preservation_log_pkey PRIMARY KEY (id),

  -- At least one crop attribution (L7): no unattributable put-up.
  CONSTRAINT chk_preservation_log_attribution
    CHECK (crop_type_slug IS NOT NULL OR variety_id IS NOT NULL),

  -- Method vocab (L5) — generalized NOW, tomato-first only in UI defaults. Canning split is safety-
  -- critical: can_water_bath (high-acid only) vs can_pressure (low-acid) — never a generic `can`.
  CONSTRAINT chk_preservation_log_method
    CHECK (method IN (
      'roast_freeze','whole_freeze','blanch_freeze','dehydrate','powder','passata',
      'can_water_bath','can_pressure','jam_preserve','ferment','cure_store','cold_store','other'
    )),

  -- method='other' must carry free text or it is silent data loss (L5).
  CONSTRAINT chk_preservation_log_method_other
    CHECK (method <> 'other' OR (method_other_text IS NOT NULL AND btrim(method_other_text) <> '')),

  CONSTRAINT chk_preservation_log_quantity_value  CHECK (quantity_value > 0),
  CONSTRAINT chk_preservation_log_package_count    CHECK (package_count >= 1),
  -- remaining_count, when tracked, is a non-negative decrement of the packages (0 = all used).
  CONSTRAINT chk_preservation_log_remaining_count  CHECK (remaining_count IS NULL OR remaining_count >= 0)
);

-- Household/user scope + soft-delete filter for the "what's put up" reads.
CREATE INDEX IF NOT EXISTS idx_preservation_log_user
  ON public.preservation_log (user_id, deleted_at);

-- "Use soon" band: partial index over live rows that HAVE an expiry (NULL use-by is excluded from the band).
CREATE INDEX IF NOT EXISTS idx_preservation_log_use_by
  ON public.preservation_log (use_by_target)
  WHERE deleted_at IS NULL AND use_by_target IS NOT NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.14.0-putup-001','PUTUP: NEW storage_location vocab (per-user, kind CHECK, soft-deleted) + NEW preservation_log (Option A post-harvest put-up log; FKs crop_types(slug)/plant_varieties(id)/plants(id) SET NULL/harvest_log(id) SET NULL/storage_location(id)/photos(id); method text+CHECK 13-value vocab incl. can_water_bath/can_pressure safety split; method_other required CHECK; quantity_value numeric(10,2)>0 + quantity_unit mirroring harvest_log; package_count>=1; at-least-one-of crop/variety CHECK; remaining_count/consumed_at minimal decrement; Soft-Delete-Only). Indexes (user_id,deleted_at) + partial (use_by_target). Two NEW empty tables, additive, no existing surface touched.')
ON CONFLICT (version) DO NOTHING;
