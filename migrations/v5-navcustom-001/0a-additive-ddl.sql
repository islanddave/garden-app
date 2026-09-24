-- 0a-additive-ddl.sql
-- V5-NAVCUSTOM-001 — two per-person nav settings on public.user_notification_prefs:
--   more_pins   jsonb NULL   the More-sheet row ids this person pinned, in pin order: ["seeds","photos"]
--   bar_layout  jsonb NULL   this person's tab bar: {"order":[5 tab keys],"hidden":[movable tab keys]}
-- Design: project-state/design-navcustom-V100-20260924.md §8 (binding over §1-§3). API/SPA contract:
-- project-state/_navcustom-build-20260924/CONTRACT.md §1. Reader and writer: lambda/critter/index.js
-- (readUserPrefs, and PATCH /api/notifications/prefs).
--
-- NOT APPLIED as of authoring (2026-09-24). The authoring lane executed no DDL anywhere — not on
-- staging, not on prod. Apply order: README-BUILD.md. This file AND 0c must be applied to staging and
-- to prod BEFORE any critter Lambda that names these columns is deployed.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THIS TABLE
--
-- Dave, 2026-09-24 (AUQ D1 + D4): pins are per person, and so is the bar — "only my bar changes", and
-- Jen's never shifts. That reverses the 2026-09-08 "one global nav order" ruling, so the global
-- app_config store is the wrong scope (and admin-only to write, so Jen could never pin). The favorites
-- table cannot hold these either (entity_id is uuid NOT NULL; favorites_entity_type_check admits four
-- types). user_notification_prefs is already the per-person cross-device UI-state store: keyed on
-- created_by (the Clerk sub, per identity, NOT per household), read at every app boot by readUserPrefs,
-- and already carrying today_skipped, the jsonb template both columns follow.
--
-- NULLABLE, NO DEFAULT, deliberately. NULL means "this person never set it", which is exactly today's
-- More menu and today's bar. A DEFAULT would stamp a choice nobody made onto both existing rows and the
-- client could no longer tell "unset" from "chosen" (the V4-ACQMATURE-001 lesson). A PATCH cannot write
-- NULL back (the route merges with COALESCE); [] and the shipped-default object are the "cleared"
-- values, and every reader treats them the same as NULL.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- SHAPE ONLY IN THE DATABASE
--
-- The vocabulary — which tab keys, which More row ids — is the Lambda validator's job
-- (lambda/critter/validators.js), and the client resolvers fall back per field. A vocabulary CHECK here
-- would turn a retired More row id into a 23514 on every later save by that person, and every new More
-- row into a migration. gates.yml pins that no other CHECK touches these columns.
--
-- CASE, NOT AND, in chk_unp_more_pins_shape: Postgres does not promise the evaluation order of AND, and
-- jsonb_array_length() raises on a non-array. CASE is the documented way to make the type test run
-- first. chk_unp_bar_layout_shape needs no CASE: `->` on a non-object returns NULL, it never raises.
--
-- NOT VALID here, VALIDATE in 0c (L-058). Arming them is safe at once for the reason 0c states.
--
-- The schema_version stamp is written in the same transaction, so the self-arming gates in gates.yml
-- start asserting exactly when the columns exist, and never before.

BEGIN;

ALTER TABLE public.user_notification_prefs
  ADD COLUMN IF NOT EXISTS more_pins  jsonb,
  ADD COLUMN IF NOT EXISTS bar_layout jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.user_notification_prefs'::regclass
                    AND conname = 'chk_unp_more_pins_shape') THEN
    -- NULL, or an array of at most 32 entries. 32 is the stored cap (CONTRACT §4 MORE_PINS_MAX_STORED);
    -- the UI shows at most 4. Entries are not typed here: the validator requires slug strings.
    ALTER TABLE public.user_notification_prefs
      ADD CONSTRAINT chk_unp_more_pins_shape
      CHECK (
        more_pins IS NULL
        OR CASE WHEN jsonb_typeof(more_pins) = 'array'
                THEN jsonb_array_length(more_pins) <= 32
                ELSE false
           END
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.user_notification_prefs'::regclass
                    AND conname = 'chk_unp_bar_layout_shape') THEN
    -- NULL, or an object whose `order` and `hidden` members, where present, are arrays. A missing
    -- member is tolerated here because the client resolves each field on its own (a bad or absent
    -- order falls back to the shipped order, a bad or absent hidden list to nothing hidden); the
    -- validator is stricter and requires exactly those two keys on every write.
    ALTER TABLE public.user_notification_prefs
      ADD CONSTRAINT chk_unp_bar_layout_shape
      CHECK (
        bar_layout IS NULL
        OR (
          jsonb_typeof(bar_layout) = 'object'
          AND COALESCE(jsonb_typeof(bar_layout -> 'order'),  'array') = 'array'
          AND COALESCE(jsonb_typeof(bar_layout -> 'hidden'), 'array') = 'array'
        )
      ) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN public.user_notification_prefs.more_pins IS
  'V5-NAVCUSTOM-001. This person''s pinned More-sheet row ids, in pin order, e.g. ["seeds","photos"]. '
  'NULL = never pinned (the shipped menu); [] = cleared. Shape CHECK only (array, at most 32); the id '
  'vocabulary is validated by the critter Lambda and filtered by the client, never by the database.';
COMMENT ON COLUMN public.user_notification_prefs.bar_layout IS
  'V5-NAVCUSTOM-001. This person''s tab bar: {"order":[all 5 tab keys],"hidden":[movable tab keys]}. '
  'NULL = the shipped bar. Per person (Dave, 2026-09-24, D4): Jen''s bar never follows Dave''s. '
  'Shape CHECK only; the tab vocabulary is validated by the critter Lambda.';

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-navcustom-001',
        'NAVCUSTOM: V5-NAVCUSTOM-001. user_notification_prefs.more_pins jsonb (pinned More-sheet row ids, '
        'in pin order) and bar_layout jsonb ({order, hidden}: this person''s tab bar, per person per Dave '
        '2026-09-24 D4), both nullable with no DEFAULT, each with a shape-only CHECK added NOT VALID '
        '(chk_unp_more_pins_shape: NULL or an array of <= 32; chk_unp_bar_layout_shape: NULL or an object '
        'whose order/hidden members, where present, are arrays) and VALIDATEd by 0c. Read at every boot '
        'by the critter Lambda readUserPrefs, so this must land before that Lambda.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;
-- ON CONFLICT because schema_version.version is the PRIMARY KEY: a re-apply after the 0r rehearsal or a
-- partial-failure retry would otherwise die on a duplicate key (found on the v4-dtmbasisvar-001 rehearsal).

COMMIT;
