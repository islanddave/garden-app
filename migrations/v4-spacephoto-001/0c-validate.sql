-- 0c-validate.sql
-- V4-SPACEPHOTO-001 — validate the widened parent constraint, then retire the old one.
--
-- VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock (not ACCESS EXCLUSIVE), so concurrent
-- reads and writes continue during the 977-row scan.
--
-- The rename is what makes this idempotent-safe to re-run against an already-migrated DB:
-- after the rename there is exactly one constraint named photos_must_have_parent, carrying
-- the widened predicate. Re-running 0a would then fail on the duplicate _v2 name rather than
-- silently producing two overlapping constraints.

ALTER TABLE public.photos VALIDATE CONSTRAINT photos_must_have_parent_v2;

ALTER TABLE public.photos DROP CONSTRAINT photos_must_have_parent;

ALTER TABLE public.photos
  RENAME CONSTRAINT photos_must_have_parent_v2 TO photos_must_have_parent;
