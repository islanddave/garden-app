-- Migration: Attribution defaults + locations RLS cleanup
-- Applied: 2026-04-22
-- Scope: locations had pre-existing broad RLS (any-auth on all ops) — replaced INSERT
--        with creator-owns pattern; cleaned duplicate/redundant policies;
--        added DEFAULT auth.uid() to attribution columns that lacked it.
--
-- Final locations policy state:
--   SELECT:  locations_public_read  → true (shared garden zones, public)
--   INSERT:  locations_insert_own   → auth.uid() = created_by
--   UPDATE:  locations_auth_update  → auth.role() = 'authenticated'
--   DELETE:  locations_auth_delete  → auth.role() = 'authenticated'

-- 1. locations.created_by: add DEFAULT so INSERT auto-populates without app code change
ALTER TABLE public.locations
  ALTER COLUMN created_by SET DEFAULT auth.uid();

-- 2. Enable RLS on locations (was absent per sweet-vigilant-mayer 2026-04-22)
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

-- 3. Replace broad INSERT policy with creator-owns (pre-existing auth_insert was any-authenticated)
DROP POLICY IF EXISTS locations_auth_insert ON public.locations;
DROP POLICY IF EXISTS locations_insert_own   ON public.locations;
CREATE POLICY locations_insert_own ON public.locations
  FOR INSERT WITH CHECK (auth.uid() = created_by);

-- 4. Remove duplicate DELETE/UPDATE/SELECT policies added in initial migration attempt
--    (pre-existing locations_auth_delete and locations_auth_update are kept)
DROP POLICY IF EXISTS locations_delete_auth ON public.locations;
DROP POLICY IF EXISTS locations_update_auth ON public.locations;
DROP POLICY IF EXISTS locations_select_auth ON public.locations;

-- 5. event_log.logged_by: add DEFAULT auth.uid()
--    Existing NULL rows unaffected. New events auto-tag the logging user.
ALTER TABLE public.event_log
  ALTER COLUMN logged_by SET DEFAULT auth.uid();

-- 6. photos.uploaded_by: add DEFAULT auth.uid()
--    Existing NULL rows unaffected. New uploads auto-tag the uploader.
ALTER TABLE public.photos
  ALTER COLUMN uploaded_by SET DEFAULT auth.uid();
