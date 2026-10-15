-- 0a-additive-ddl.sql
-- V5-TODAYREDESIGN-001 slice S7 — the redesigned Today's remembered open/closed state, per person, on
-- public.user_notification_prefs:
--   today_sections  jsonb NULL  {"v":1,"<section>":{"open":bool,"at":"YYYY-MM-DD","ack"?:{"t"?,"r"?}},…}
-- Design: _todayux_20260928/plan-v2.md §2.1 (Layer 1) and §8 S7, amended by §13 MF1 (date-scoped acks).
-- Reader and writer: lambda/critter/index.js (readTodaySections, and the today_sections arm of
-- PATCH /api/notifications/prefs). Validator: lambda/critter/validators.js todaySectionsError.
--
-- NOT APPLIED as of authoring (2026-10-14). The authoring lane opened no database connection — not to
-- staging, not to prod. Apply order and the cross-device merge rule: README-BUILD.md.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THIS TABLE
--
-- user_notification_prefs is the per-person cross-device UI-state store: keyed on created_by (the Clerk
-- sub, per identity, NOT per household), read at every app boot, and already carrying today_skipped,
-- more_pins and bar_layout, the jsonb template this column follows. A section's open/closed choice is
-- per person (Jen's Today never follows Dave's taps), so the household-scoped tables are the wrong scope.
--
-- NULLABLE, NO DEFAULT, deliberately. NULL means "this person never tapped a section header on the new
-- Today", which every reader treats as "no remembered state" (each section closed unless a trigger opens
-- it). A DEFAULT would stamp a choice nobody made onto every existing row (the V4-ACQMATURE-001 lesson).
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- SHAPE ONLY IN THE DATABASE
--
-- The CHECK admits NULL or a JSON object, nothing more. The vocabulary — which section keys, the entry
-- shape, the ack tiers and reasons, the size cap — is the Lambda validator's job: a vocabulary CHECK
-- here would turn a retired section key into a 23514 on every later save by that person, and every new
-- section into a migration. gates.yml pins that no other CHECK touches this column.
--
-- NOT VALID here, VALIDATE in 0c (L-058). Arming it is safe at once for the reason 0c states.
--
-- The schema_version stamp is written in the same transaction, so the self-arming gates in gates.yml
-- start asserting exactly when the column exists, and never before.

BEGIN;

ALTER TABLE public.user_notification_prefs
  ADD COLUMN IF NOT EXISTS today_sections jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.user_notification_prefs'::regclass
                    AND conname = 'chk_unp_today_sections_shape') THEN
    -- NULL, or an object. `jsonb_typeof` never raises, so no CASE is needed (contrast
    -- chk_unp_more_pins_shape, whose jsonb_array_length raises on a non-array).
    ALTER TABLE public.user_notification_prefs
      ADD CONSTRAINT chk_unp_today_sections_shape
      CHECK (today_sections IS NULL OR jsonb_typeof(today_sections) = 'object') NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN public.user_notification_prefs.today_sections IS
  'V5-TODAYREDESIGN-001 S7. This person''s remembered open/closed state for the redesigned Today''s '
  'sections: {"v":1,"<section>":{"open":bool,"at":"YYYY-MM-DD","ack"?:{"t"?,"r"?}}}. Written only by an '
  'explicit section-header tap; merged per top-level key by the critter Lambda (old || new). NULL = never '
  'set. Shape CHECK only (NULL or an object); keys, entries and acks are validated by the critter Lambda.';

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-todaysections-001',
        'TODAYSECTIONS: V5-TODAYREDESIGN-001 S7. user_notification_prefs.today_sections jsonb (the redesigned '
        'Today''s remembered open/closed state per section, per person), nullable with no DEFAULT, with a '
        'shape-only CHECK added NOT VALID (chk_unp_today_sections_shape: NULL or a JSON object) and VALIDATEd '
        'by 0c. The critter Lambda tolerates the column''s absence (it omits today_sections from the prefs GET '
        'and answers a today_sections PATCH with 409), so this may land before or after that Lambda.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;
-- ON CONFLICT because schema_version.version is the PRIMARY KEY: a re-apply after the 0r rehearsal or a
-- partial-failure retry would otherwise die on a duplicate key (found on the v4-dtmbasisvar-001 rehearsal).

COMMIT;
