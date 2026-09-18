-- 0a-additive-ddl.sql
-- V5-COLDCARDREACHABLE-001 — public.locations.heated, and the one location that is heated today.
-- Ledger row: V5-COLDCARDREACHABLE-001 (Dave-approved 2026-09-17). Reader: lambda/daily-plan/handler.js
-- (`l.heated is true as heated_resolved`) -> engine.coldFor, which drops the cold card for a heated
-- location.
--
-- NOT APPLIED as of authoring (2026-09-18). The authoring lane executed no DDL anywhere — not on
-- staging, not on prod. Apply order: README.md "Landing order". This file must be applied to staging
-- AND prod BEFORE the reader reaches a deployed Lambda.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY A NEW COLUMN, AND WHY `covered` IS NOT IT
--
-- `covered` (v4-loccovered-001) means rain does not reach the location. It says nothing about
-- temperature, and the difference is not academic here. Dave, 2026-09-17: "House is heated, Stable is
-- unheated, shelves are all in the stable." Of the eight covered locations on prod exactly ONE is
-- warm, and the unheated Stable holds more live plantings (23) than the House (11). A cold card
-- suppressed on `covered` would have silenced the larger and more marginal population — the plants the
-- card exists for. Nothing in the schema said "warm", so nothing could tell the two apart.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY NOT NULL DEFAULT false, when covered is a deliberate three-state
--
-- The dangerous direction for THIS column is a false TRUE. A location wrongly read as heated drops the
-- cold card for every planting in it, and a heated location is also covered, so those plantings are
-- already excluded from the frost alert (frostClass.isCoveredDefault) — nothing would speak for them.
-- "Not stated" must therefore mean NOT heated, and NOT NULL DEFAULT false says exactly that, with no
-- NULL for a reader to mishandle (rainClass once read covered's NULL with `?` and got it wrong).
--
-- The price is inheritance. covered's flag-gated ancestor walk fills a NULL from the nearest stated
-- parent; heated has no NULL, so a child location cannot inherit from a heated parent. The House has
-- no child locations (verified on prod 2026-09-18), and a child created later reads unheated -> its
-- plantings keep their card -> noise, the safe direction. If "a shelf inside the House is heated
-- because the House is" is ever wanted, the column has to become a three-state first — a separate
-- decision, not a tweak to the reader.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- ADDITIVE, AND INERT UNDER THE CODE THAT IS DEPLOYED TODAY
--
-- ADD COLUMN with a constant DEFAULT is a catalog-only change on Postgres 11+: no table rewrite, no
-- long lock. The deployed locations Lambda names its INSERT columns explicitly and never mentions
-- heated, so its inserts take the default; its `RETURNING *` responses gain one key the UI ignores.
-- The deployed daily-plan Lambda never names the column. Old code + new schema is therefore INERT, and
-- the window between this apply and the reader's deploy can be as long as it needs to be. The reverse
-- (new reader + old schema) is the one that breaks: the plantings query throws and the nightly plan is
-- empty for both users.
--
-- NO CHECK CONSTRAINT, deliberately — arming a constraint over a column is a deploy, not a migration
-- (v4-loccovered-001/0a, and the 2026-08-03 harvest outage). gates.yml asserts there is none.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE BACKFILL: ONE ROW, SELECTED BY ID, IN THE SAME TRANSACTION
--
--   7ee03125-2470-4400-a870-d931da1ffb92   House   zone, level 0, root, covered = t, live
--
-- Read on prod 2026-09-18 through garden_ro: the only row named House among all 31 location rows,
-- soft-deleted included, and no location has it as a parent. Selected by ID, never by name: a name
-- match is the free-text-identity defect v4-loccovered-001 exists to retire. The name is checked once,
-- as a receipt, by gates.yml pre_house_row_is_the_house — not used as the selector.
--
-- On a database where this id does not exist (staging, unless its House shares prod's id — unverified,
-- the authoring lane was cleared to read prod only) the UPDATE matches zero rows and every location
-- stays unheated, the safe direction. The House gates are `env: prod` for that reason.
--
-- FIRST APPLY ONLY. The UPDATE is guarded on this migration's own schema_version row being absent, and
-- the stamp is written after it in the same transaction, so a re-run of this file (the rehearsal
-- re-apply, or a retry after a partial failure) can never revert a later edit of the House back to
-- true. 0r deletes the stamp together with the column, so a rehearsal re-apply backfills afresh.
--
-- Triggers on locations: per v4-loccovered-001/0b, prevent_ownership_transfer raises only when
-- created_by changes (this UPDATE does not name it), and set_updated_at bumps updated_at on the one
-- touched row, which nothing in the care engine reads.

BEGIN;

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS heated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.locations.heated IS
  'V5-COLDCARDREACHABLE-001. TRUE = the location is kept warm (the House), so a planting there needs no '
  'bring-it-inside cold card; lambda/daily-plan reads it as heated_resolved. NOT the same as covered: '
  'covered means no rain reaches it, and the covered Stable is unheated. NOT NULL DEFAULT false because '
  'a false TRUE silences cold cards for plants that are also excluded from the frost alert, so an '
  'unstated location must read unheated. No ancestor inheritance (there is no unstated value to fill). '
  'Deliberately unconstrained - see migrations/v5-locheated-001/0a-additive-ddl.sql.';

UPDATE public.locations
   SET heated = true
 WHERE id = '7ee03125-2470-4400-a870-d931da1ffb92'
   AND NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-locheated-001');

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-locheated-001',
        'LOCHEATED: V5-COLDCARDREACHABLE-001. public.locations.heated boolean NOT NULL DEFAULT false, '
        'no CHECK armed, plus a first-apply-only backfill of heated = true on the House '
        '(7ee03125-2470-4400-a870-d931da1ffb92) selected by id. Read by lambda/daily-plan/handler.js as '
        'heated_resolved; engine.coldFor drops the cold card for a heated location. Distinct from '
        'covered on purpose: the covered Stable is unheated and holds more plantings than the House '
        '(Dave 2026-09-17). NOT NULL so an unstated location reads unheated, the safe direction; hence '
        'no ancestor inheritance.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;
-- ON CONFLICT because schema_version.version is the PRIMARY KEY: a re-apply after the rollback
-- rehearsal or a partial-failure retry would otherwise die on a duplicate key (v4-dtmbasisvar-001).

COMMIT;
