-- 0a-additive-ddl.sql
-- V4-HANDEDNESSCONTROLS-001 (BD-054) — which hand works the phone, per USER, cross-device.
--
-- ⛔ STATUS: AUTHORED, NOT APPLIED. Neither staging nor prod. See gates.yml for the sequencing this
--    must follow, and note that the client shipped in this lane works WITHOUT it (per-device
--    localStorage) and starts syncing the moment it lands, with no client change.
--
-- PURPOSE. Dave works a weigh-in left-handed — right hand moves fruit onto the scale, left hand
--   logs the pick — and every two-control row in the app was laid out assuming a right thumb.
--   HarvestWatchBand's own source says so: "'Log harvest' takes the right-hand natural thumb zone
--   and 'Not yet' the harder-to-reach left, so a stray thumb tap lands on the NAVIGATION rather
--   than the control that writes a calibration sample." Worked left-handed that INVERTS — the
--   destructive control ("Not yet" = suppressed_until + 10 days, worst case 20 days invisible on a
--   system at 11.8% calibration) lands under the thumb and the harmless one does not. This is a
--   safety preference wearing a cosmetic costume.
--
-- WHY THIS COLUMN AND NOT A SECOND STORE. user_notification_prefs is ALREADY the per-user
--   cross-device preference store, and it already carries eight columns of pure UI state that have
--   nothing to do with notifications (garden_group_by ... whats_new_last_seen). Critically it is
--   keyed on created_by — the Clerk sub, per IDENTITY, not created_by = ANY(householdIds) — which
--   is the property this needs: the app has exactly two users on shared devices and they do not
--   have the same hands. saveGardenGroupBy() / log_many_all_selected are the working templates.
--   A new table would fork the read path for one text column.
--
-- WHY PER-IDENTITY MATTERS MORE HERE THAN FOR THE OTHERS. Inheriting someone else's garden_group_by
--   is an annoyance. Inheriting someone else's HANDEDNESS hands them the exact defect this feature
--   exists to remove, and nothing on screen tells them the layout was decided by another person.
--
-- SAFETY: fully additive + idempotent. ADD COLUMN IF NOT EXISTS, NULLABLE, NO DEFAULT. Re-running
--   the whole file is a clean no-op. No backfill and therefore NO 0b — the prior values live in
--   browser localStorage this migration cannot reach.
--
-- NULLABLE, NO DEFAULT, DELIBERATELY — the V4-ACQMATURE-001 / V4-USERPREFS-001 lesson. A
--   `DEFAULT 'right'` would write an assertion nobody made onto every existing row, and the client
--   could then no longer distinguish "chose right-handed" from "never opened the setting". Those
--   are different facts: the second one must stay adoptable by a value set on another device.
--   NULL is the only value that honestly means unset.

ALTER TABLE public.user_notification_prefs
  ADD COLUMN IF NOT EXISTS handedness text;

-- Domain guard, added NOT VALID (no full-table lock on apply) and VALIDATEd in 0c per L-058.
-- Mirrors the client's HANDS list (src/lib/handedness.js) and the Lambda's allowlist check; three
-- enforcement points on one contract is the same posture chk_unp_today_skipped_shape has, and for
-- the same reason — the DB guard is the one that cannot be bypassed, the Lambda's turns a bad write
-- into a 400 the client can act on, and the client's keeps a junk value from ever being sent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_unp_handedness'
  ) THEN
    ALTER TABLE public.user_notification_prefs
      ADD CONSTRAINT chk_unp_handedness
      CHECK (handedness IS NULL OR handedness IN ('right', 'left')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN public.user_notification_prefs.handedness IS
  'V4-HANDEDNESSCONTROLS-001 (BD-054). Which hand works the phone: ''right''|''left''. Decides which side of a two-control row the DESTRUCTIVE control sits on, so it is a safety preference, not a cosmetic one. NULL = unset, use the client default (''right'').';
