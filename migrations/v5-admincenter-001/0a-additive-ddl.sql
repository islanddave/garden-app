-- 0a-additive-ddl.sql
-- V5-ADMINCENTER-001 — user_notification_prefs.nav_tabs. The bottom nav's tab ORDER, per user,
-- cross-device. Design: project-state/design-admincentre-V100-20260908.md §5.
--
-- ⛔ STATUS: AUTHORED, NOT APPLIED. Neither staging nor prod. See gates.yml for the sequencing this
--    must follow. The lane that wrote this was instructed to author and stop; do not apply from a
--    lane branch. The SPA half ships WITHOUT it and is correct without it (see NULL, below).
--
-- PURPOSE. The row asks for "an admin centre — configure the app through the UI, first capability
--   being which nav tabs appear and in what order". This column is the whole storage for that first
--   capability: an ordered list of tab keys, rendered by src/lib/navConfig.js.
--
-- NULL MEANS "USE THE SHIPPED DEFAULT", AND THAT IS THE LOAD-BEARING PROPERTY OF THIS FILE.
--   It makes the migration purely additive, makes 0r a behavioural no-op, and — most importantly —
--   makes every failure degrade to today's bar rather than to an empty one. A never-configured user,
--   a failed prefs GET, an offline boot, a rolled-back column and a malformed value all arrive at
--   the same place: the five tabs the app shipped with. resolveNavTabs() in the SPA is total over
--   this column's entire domain, jsonb included, and returns the default for anything it does not
--   accept. Do NOT add a DEFAULT here: a concrete default would make "never configured" and "chose
--   the shipped order" indistinguishable, the same trap the nullable-no-default columns beside this
--   one exist to avoid (handedness, log_many_all_selected, whats_new_last_seen).
--
-- WHY THIS TABLE AND NOT A NEW ONE. Every CREATE TABLE across migrations/**/*.sql was enumerated
--   during design: there is no general config/settings/feature-flag table. user_notification_prefs
--   is ALREADY the per-user cross-device preference store and has been extended ~10 times for
--   exactly this shape of fact (garden_group_by, garden_sort_order, garden_expanded,
--   garden_bloom_seen, today_skipped, log_many_all_selected, whats_new_last_seen, handedness). It is
--   keyed on created_by — the Clerk sub, per IDENTITY — which is what nav layout wants: this app has
--   two users on shared devices and their bars need not match. A new table would fork the read path
--   for one column, and the read path is on the boot critical path.
--
-- WHY jsonb AND NOT text[]. The neon-serverless driver round-trips jsonb as a JS value with no
--   parsing at the call site, which is how every other structured column on this table is already
--   stored (garden_expanded, garden_bloom_seen, today_skipped are all jsonb). text[] would be the
--   tighter type and the odd one out.
--
-- THE CHECK IS CREATED VALIDATED, and arming it is safe here for the specific reason the standing
--   rule requires: no deployed writer sets this column. It does not exist yet, and the critter
--   Lambda's HAS_UPDATABLE allowlist (lambda/critter/validators.js) does not carry the key, so there
--   is no path by which a live writer can violate it mid-apply. Every existing row is born NULL and
--   the CHECK is NULL-tolerant, so there is nothing to scan either.
--
-- WHAT THE CHECK DOES AND DOES NOT ASSERT. It pins the SHAPE (an array of at most 16 elements) and
--   nothing about the KEYS. The key vocabulary lives in JS (navConfig.TAB_REGISTRY) and would go
--   stale in the database the first time a tab is renamed; validity is the renderer's job and it is
--   total. The cardinality bound is a PAYLOAD bound, not a validity rule: this column is returned by
--   GET /api/notifications/prefs, which is on the boot path, and an unbounded array there would be
--   paid for on every cold start. 16 is comfortably above any conceivable bar (the renderer accepts
--   exactly 5) and low enough to keep the response small.
--
-- NO VIEW WIDEN REQUIRED. user_notification_prefs is a plain table (relkind='r', re-pinned in
--   gates.yml), not a base table behind an explicit-column-list view, so the garden_node /
--   public.cultivar failure mode — a new column invisible to every app surface — cannot occur here.
--
-- NO 0b. There is no prior value to migrate anywhere: this capability has never existed, on the
--   server or on a device.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

ALTER TABLE public.user_notification_prefs
  ADD COLUMN IF NOT EXISTS nav_tabs jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_unp_nav_tabs_shape') THEN
    ALTER TABLE public.user_notification_prefs ADD CONSTRAINT chk_unp_nav_tabs_shape
      CHECK (nav_tabs IS NULL
             OR (jsonb_typeof(nav_tabs) = 'array' AND jsonb_array_length(nav_tabs) <= 16));
  END IF;
END $$;

COMMENT ON COLUMN public.user_notification_prefs.nav_tabs IS
  'V5-ADMINCENTER-001. Ordered array of bottom-nav tab keys, per user. NULL = use the shipped '
  'default order, which is also what the client renders for any value it will not accept - see '
  'src/lib/navConfig.js resolveNavTabs(), which is total over this column. v1 is REORDER-ONLY: the '
  'renderer accepts a permutation of the shipped five keys and nothing else, so a value that drops '
  'or adds a tab is ignored rather than partly applied. Hiding a tab is deliberately not '
  'implemented - it would remove the only door to a page - and is reserved for a later decision. '
  'The CHECK pins shape only; the key vocabulary lives in the client and is not mirrored here.';

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.102.0-admincenter-001',
        'ADMINCENTER: user_notification_prefs.nav_tabs (nullable jsonb, no DEFAULT, one VALIDATED NULL-tolerant shape CHECK). Storage for the admin centres first capability - the order of the bottom nav tabs, per user, cross-device. NULL means use the shipped default order, which makes this purely additive, makes the rollback a behavioural no-op, and makes every failure path (no row, failed GET, offline boot, malformed value) degrade to todays bar rather than to an empty nav. Added to user_notification_prefs rather than a new table because that table is already the per-user cross-device preference store and has been extended ~10 times for this shape of fact; it is keyed per Clerk sub, which is what nav layout wants on shared devices. The CHECK pins shape (array, <=16 elements) not the key vocabulary: keys live in src/lib/navConfig.js and would go stale here. No view widen - user_notification_prefs is a plain table. No 0b - nothing to migrate. INERT until the critter Lambda adds nav_tabs to its HAS_UPDATABLE allowlist and its prefs SELECT list; until then the clients PATCH carries nav_tabs alone and is refused 400, exactly as V4-HANDEDNESSCONTROLS-001 is.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;
-- ON CONFLICT because schema_version.version is the PRIMARY KEY, so a re-apply after a rollback
-- rehearsal or a partial-failure retry would otherwise die on duplicate key with the real work
-- already committed. Found on the v4-dtmbasisvar-001 staging rehearsal.

COMMIT;
