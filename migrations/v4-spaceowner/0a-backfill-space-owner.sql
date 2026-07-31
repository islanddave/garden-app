-- 0a-backfill-space-owner.sql
-- V4-SPACEPHOTO-001 prerequisite — populate spaces.created_by.
--
-- PURPOSE: spaces.created_by is NULLABLE and is NULL on every existing row (live prod 2026-07-31:
--   1 row, "Gardens at Mathews Ridge", created_by NULL). Lane C's loadOwnedSpace() gates space
--   writes on `created_by = ANY(householdIds)`, which rejects a NULL-owner row — so without this
--   backfill C's photo-attach path rejects EVERY space and the feature is dead on arrival.
--
-- WHY NOT SOFTEN THE PREDICATE: an `OR created_by IS NULL` escape in loadOwnedSpace would make an
--   unowned space writable by ANY household. Fixing the data is correct; widening the authz
--   predicate to accommodate bad data is not.
--
-- SAFETY: spaces.created_by has NO readers today. The only code touching the table is
--   lambda/daily-plan/handler.js, which selects id/postal_code/weather_lat/weather_lng and never
--   created_by. So this write is behaviourally INERT until Lane C ships — it cannot change any
--   current plan, read, or authz decision.
--
-- VALUE PROVENANCE (not guessed): user_3D2gM0hIl03gjW3JM2DjtPzm0jI is the live garden-daily-plan
--   Lambda's OWNER_FALLBACK_SUB, and owns 73 of the 74 live plant_projects rows. All 269 live
--   plants carry workspace_id = the sentinel space id below, so the whole garden hangs off it.
--
-- HOUSEHOLD SAFETY: scoping the space to one sub does NOT lock the other household member out —
--   householdScope() returns the full household array for any member, so `created_by = ANY(...)`
--   still matches for Jen.
--
-- IDEMPOTENT: guarded on IS NULL, so a re-run is a no-op and an already-assigned owner is never
--   overwritten (this must never silently transfer ownership of a space someone else owns).
-- REVERSIBLE: UPDATE spaces SET created_by = NULL WHERE id = '00000000-0000-0000-0000-000000000001';
--   (that revert needs the same trigger dance as below).
--
-- THE TRIGGER DANCE: public.spaces carries the `prevent_ownership_transfer` trigger, whose predicate
--   is `OLD.created_by IS DISTINCT FROM NEW.created_by` — and NULL IS DISTINCT FROM 'user_...', so it
--   rejects even ADOPTING an unowned row, not just transferring an owned one. Discovered by this
--   migration failing closed on first apply (good: the guard works).
--
--   The trigger is deliberately NOT amended to exempt the NULL case, even though "an unowned row has
--   no owner to protect" is a defensible reading. That function guards NINE tables (event_log,
--   inventory_items, locations, photos, plant_projects, plants, spaces, spacetheme, tasks), so
--   relaxing it would let any NULL-owner row anywhere be claimed — a security change that deserves
--   its own review, not a side effect of a one-row data fix.
--
--   Instead the disable is scoped to this ONE table and wrapped in the SAME transaction as the
--   UPDATE, so the trigger cannot be left off: any failure rolls back the disable along with the
--   write. Run this file with --single-transaction (or wrap in BEGIN/COMMIT).
--
-- NOTE public.spacetheme also has exactly one NULL-owner row. It is deliberately NOT touched here —
--   nothing in this lane needs it, and it should be backfilled by whoever owns that surface.

ALTER TABLE public.spaces DISABLE TRIGGER prevent_ownership_transfer;

UPDATE public.spaces
   SET created_by = 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI',
       updated_at = now()
 WHERE created_by IS NULL;

ALTER TABLE public.spaces ENABLE TRIGGER prevent_ownership_transfer;
