-- 0a-rearm-check.sql
-- BUG-OPRANKCHECKNULL-001 — the Open-pollinated-needs-a-cultivar CHECK never fired on an unranked variety.
--
-- WHAT WAS WRONG. v5-varietyhybridflag-001 armed
--     CHECK (breeding_system IS DISTINCT FROM 'open_pollinated' OR variety_rank = 'cultivar')
-- and meant "an Open-pollinated claim needs a single named cultivar under it". On a row whose variety_rank
-- is NULL the second arm is NULL, the whole predicate is NULL, and a CHECK PASSES on NULL. So the rule
-- held only for rows that already had a rank — 438 of prod's 517 varieties have none (read 2026-09-23).
-- Measured on a staging fork on 2026-09-21: Open-pollinated on a NULL-rank row was accepted.
--
-- THE FIX is the NULL-safe comparison, same name, same meaning:
--     CHECK (breeding_system IS DISTINCT FROM 'open_pollinated' OR variety_rank IS NOT DISTINCT FROM 'cultivar')
-- The name is kept on purpose: the varieties handler's comments and tests, the integration suite
-- (variety-facts-edit.int.test.js) and v5-varietyhybridflag-001's post gate all refer to it by name.
--
-- WHY IT IS SAFE TO ARM (the arming-a-CHECK test, asked of what is deployed, not of a branch):
--   * Live data: 0 rows on prod and 0 on staging claim open_pollinated without variety_rank='cultivar'
--     (soft-deleted rows included — a CHECK does not know deleted_at). The guard below re-counts at apply
--     time and refuses rather than forcing.
--   * Writers of breeding_system, censused at dev dc253a127ef940970f9252dedaf38dfb65ce4f77:
--       - lambda/varieties PUT (V5-VARIETYFACTSEDIT-001, v4.142.0): Open-pollinated on a row with no
--         recorded rank fills variety_rank='cultivar' in the SAME UPDATE (fillsCultivarRank); a recorded
--         non-cultivar rank is refused by the preflight with a 400 before any write. v4.141.1 and earlier
--         could not write breeding_system through the PUT at all.
--       - POST /api/varieties writes no breeding column.
--       - lambda/plants and lambda/inventory-items only READ it.
--       - Projects/Gardening/_seedpacket_20260919/apply_fills.py writes it only
--         `WHERE ... AND (%s <> 'open_pollinated' OR variety_rank = 'cultivar')`, which never matches an
--         unranked row, so it cannot produce a violation.
--       - v5-varietyhybridflag-001/0b-data.sql, applied 2026-09-03, is history.
--     Nothing deployed writes a row this stricter CHECK refuses.
--
-- LOCKING: DROP and ADD run in ONE transaction, so there is no moment with no constraint. ADD CONSTRAINT
-- validates the whole table under ACCESS EXCLUSIVE; plant_varieties is ~520 rows, so the lock is brief.
--
-- IDEMPOTENT: DROP IF EXISTS + ADD, and the stamp upserts. Re-running re-validates and moves applied_at.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-rearm-check.sql
-- Apply order (README.md): staging -> rehearse 0r -> re-apply staging -> prod (Dave-approved) -> dev push.

BEGIN;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.plant_varieties
   WHERE breeding_system = 'open_pollinated' AND variety_rank IS DISTINCT FROM 'cultivar';
  IF n > 0 THEN
    RAISE EXCEPTION 'v5-oprankchecknull-001: % plant_varieties row(s) claim open_pollinated without variety_rank = cultivar; the NULL-safe CHECK would refuse them. Decide each row first (rank it, or change the claim); do not force this migration.', n;
  END IF;
END
$$;

ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_op_requires_cultivar;

ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_op_requires_cultivar
  CHECK (breeding_system IS DISTINCT FROM 'open_pollinated' OR variety_rank IS NOT DISTINCT FROM 'cultivar');

COMMENT ON CONSTRAINT chk_plant_varieties_op_requires_cultivar ON public.plant_varieties IS
  'V5-VARIETYHYBRIDFLAG-001 rule, made NULL-safe by BUG-OPRANKCHECKNULL-001 (v5-oprankchecknull-001): an '
  'Open-pollinated claim needs variety_rank = cultivar. IS NOT DISTINCT FROM, not =, so an unranked row '
  'is refused too; with = the predicate was NULL there and a CHECK passes on NULL. The variety editor '
  'fills an unrecorded rank with cultivar in the same UPDATE (Dave, 2026-09-21).';

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-oprankchecknull-001',
        'OPRANKCHECKNULL: BUG-OPRANKCHECKNULL-001. chk_plant_varieties_op_requires_cultivar re-armed as '
        '(breeding_system IS DISTINCT FROM ''open_pollinated'' OR variety_rank IS NOT DISTINCT FROM '
        '''cultivar''), same name. The v5-varietyhybridflag-001 form used variety_rank = ''cultivar'', '
        'which is NULL on an unranked row, and a CHECK passes on NULL, so the rule never fired on the '
        '438 of 517 prod varieties with no rank. Zero rows violated the stricter form at authoring; a '
        'guard re-counts and refuses. No deployed writer can produce a violation: the variety editor PUT '
        'fills the rank in the same UPDATE, POST writes no breeding column, apply_fills.py filters on the '
        'rank.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
