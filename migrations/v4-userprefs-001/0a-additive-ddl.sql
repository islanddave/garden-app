-- 0a-additive-ddl.sql
-- V4-USERPREFS-001 — the last three per-DEVICE UI states become per-USER server state.
-- Closes V4-TODAYLOC-002, V4-LOGMANY-001, V4-WHATSNEW-002 in one additive DDL.
--
-- PURPOSE. Three ledger rows describe one defect in three costumes: a preference that belongs to
--   the PERSON is stored on the DEVICE, so it does not follow Dave from phone to laptop, and on a
--   shared device the second person to sign in inherits the first person's state. That second half
--   is not hypothetical here — this app has exactly two users, and src/lib/clientPrefs.js exists
--   ONLY to scrub four such keys at sign-out, which is a workaround for the absence of this store.
--
-- WHY NO NEW TABLE. user_notification_prefs is ALREADY the per-user cross-device preference store:
--   it is keyed on created_by (the Clerk sub, i.e. per-identity, NOT per-household — which matters,
--   because every other write path in this app is created_by = ANY(householdIds) and would make
--   Dave and Jen interchangeable), and it already carries five columns of pure UI state that have
--   nothing to do with notifications: garden_group_by, garden_sort_order, garden_expanded,
--   garden_bloom_seen, garden_helper_rung1_seen. saveGardenGroupBy() is the working template these
--   three follow. A new table would fork the read path for no gain.
--
-- THE CARE ROW IS WORSE THAN ITS LEDGER ENTRY SAYS. V4-TODAYLOC-002 is filed as a cross-device
--   correctness gap. It is also a SAME-device one: CareNeeded.jsx:44 keys the suppress set into
--   *sessionStorage*, which does not survive a tab close, let alone a PWA being evicted. Skipping a
--   watering row while standing in the garden and finding it back minutes later is the actual
--   reported experience. Moving to the server fixes both halves at once.
--
-- SAFETY: fully additive + idempotent. ADD COLUMN IF NOT EXISTS, all NULLABLE with NO DEFAULT.
--   Re-running the whole file is a clean no-op. No destructive DDL, no backfill, no rewrite — and
--   therefore NO 0b: there is no prior server-side value to migrate, because the prior values live
--   in browser storage this migration cannot reach. Existing clients keep reading their local copy
--   until the app code that prefers the server lands; a NULL column means "this user has not set
--   it", which is exactly the pre-existing behavior.
--
-- NULLABLE, NO DEFAULT, DELIBERATELY — same reasoning as V4-ACQMATURE-001. A `DEFAULT false` on
--   log_many_all_selected would write an assertion nobody made ("this user wants nothing
--   preselected") for every existing row, and the client cannot then distinguish that from a real
--   choice. NULL is the only value that honestly means "unset, fall back to the client default".

ALTER TABLE public.user_notification_prefs
  -- V4-TODAYLOC-002. Shape: {"date":"YYYY-MM-DD","keys":["<row key>", ...]}. The date is stored
  -- INSIDE the value rather than as a sibling column so the pair can never be written apart: a
  -- half-applied update that advanced the keys but not the date would silently suppress today's
  -- care rows using yesterday's set. Self-expiring by construction — the client ignores the whole
  -- object when its date is not today, so no cron, no TTL, and no cleanup job is required.
  ADD COLUMN IF NOT EXISTS today_skipped         jsonb,
  -- V4-LOGMANY-001. Was localStorage `defaultAllSelected` (per-device, the FIX-3 expedient).
  ADD COLUMN IF NOT EXISTS log_many_all_selected boolean,
  -- V4-WHATSNEW-002. The version string last acknowledged, e.g. '4.31.0'. text, not semver-typed:
  -- the client compares against its own build version and an unparseable value must degrade to
  -- "show the dot", never to an error.
  ADD COLUMN IF NOT EXISTS whats_new_last_seen   text;

-- Shape guard for the one non-scalar column, added NOT VALID (no full-table lock on apply) and
-- VALIDATEd in 0c per L-058. Enforces the object contract rather than merely "is jsonb": a bare
-- array or a string would satisfy the type and then break the client's date check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_unp_today_skipped_shape'
  ) THEN
    ALTER TABLE public.user_notification_prefs
      ADD CONSTRAINT chk_unp_today_skipped_shape
      CHECK (
        today_skipped IS NULL
        OR (
          jsonb_typeof(today_skipped) = 'object'
          AND jsonb_typeof(today_skipped -> 'date') = 'string'
          AND jsonb_typeof(today_skipped -> 'keys') = 'array'
        )
      ) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN public.user_notification_prefs.today_skipped IS
  'V4-TODAYLOC-002. Care-Needed suppress-for-today set: {"date":"YYYY-MM-DD","keys":[...]}. Date is embedded so it cannot drift from the keys; client ignores a non-today date, so this self-expires.';
COMMENT ON COLUMN public.user_notification_prefs.log_many_all_selected IS
  'V4-LOGMANY-001. Log-Many default selection. NULL = unset, use the client default.';
COMMENT ON COLUMN public.user_notification_prefs.whats_new_last_seen IS
  'V4-WHATSNEW-002. Last acknowledged release version string; drives the What''s New dot cross-device.';
