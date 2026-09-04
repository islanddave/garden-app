-- 0r-rollback.sql
-- V5-SOURCEKIND-001 — back to the frozen 12-value CHECK.
--
-- ORDER MATTERS. The FK must go before the table it points at, and the CHECK must be restored while
-- source.kind still holds only seeded values — so this file is only safe to run while every live
-- source row's kind is one of the original 12. It refuses rather than guessing if that is not true:
-- restoring the CHECK over a MINTED kind would either fail loudly (best case) or, if someone dropped
-- the guard first, leave a row violating a constraint that claims to be validated.
--
-- Usage: psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

-- Refuse to roll back over data this rollback would invalidate. A minted kind has no home in the
-- CHECK below, and silently dropping those rows' classification is exactly the provenance loss the
-- whole source design exists to prevent.
DO $$
DECLARE
  v_minted text[];
BEGIN
  IF to_regclass('public.source') IS NOT NULL THEN
    SELECT array_agg(DISTINCT s.kind) INTO v_minted
      FROM public.source s
     WHERE s.kind IS NOT NULL
       AND s.kind <> ALL (ARRAY['seed_company','nursery','garden_center','farm_stand','market',
                                'retail','plant_swap','person','organization','brand','own_garden',
                                'other']);
    IF v_minted IS NOT NULL THEN
      RAISE EXCEPTION
        'REFUSING to roll back V5-SOURCEKIND-001: % source row kind(s) use a MINTED vocabulary value '
        '(%) that the restored 12-value CHECK does not permit. Re-classify or soft-delete those '
        'sources first, or leave this migration in place.',
        array_length(v_minted, 1), array_to_string(v_minted, ', ');
    END IF;
  END IF;
END
$$;

ALTER TABLE public.source DROP CONSTRAINT IF EXISTS fk_source_kind;

DO $$
BEGIN
  IF to_regclass('public.source') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_source_kind') THEN
    ALTER TABLE public.source
      ADD CONSTRAINT chk_source_kind
      CHECK (kind IS NULL OR kind = ANY (ARRAY[
        'seed_company','nursery','garden_center','farm_stand','market','retail',
        'plant_swap','person','organization','brand','own_garden','other'
      ]));
  END IF;
END
$$;

DROP TRIGGER IF EXISTS set_updated_at ON public.source_kind;

-- 0a does NOT create these — see its "NO AUDIT TRIGGERS ON THIS TABLE" block for why (slug-keyed
-- table vs a uuid audit_events.row_id; they install and silently log nothing). They are dropped here
-- anyway because an early draft of 0a DID create them and they reached staging on 2026-09-04 before
-- the defect was found. Anyone re-running this rollback against a database that saw that draft needs
-- them gone; on every other database these are no-ops.
DROP TRIGGER IF EXISTS trg_audit_source_kind_upd ON public.source_kind;
DROP TRIGGER IF EXISTS trg_audit_source_kind_del ON public.source_kind;

-- Indexes and constraints on public.source_kind go with the table. As in v5-sourceentity-001's
-- rollback, the public.audit_events rows written for table_name = 'source_kind' are DELIBERATELY
-- kept: they are history about edits that really happened.
DROP TABLE IF EXISTS public.source_kind;

DELETE FROM public.schema_version WHERE version = '5.0.0-sourcekind-001';

COMMIT;
