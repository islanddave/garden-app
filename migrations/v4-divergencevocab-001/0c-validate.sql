-- 0c-validate.sql
-- BUG-DIVERGENCEVOCAB-001 phase 2/2 — POST-DEPLOY. Arms plants_divergence_type_check.
--
-- ══ RUN THIS ONLY AFTER THE WRITER DEPLOY. THIS FILE IS A DEPLOY STEP, NOT A SCHEMA STEP. ══
--   Adding a nullable column is backward-compatible; VALIDATEing a CHECK over it is forward-
--   INcompatible, because it constrains a value only the NEW writer sets. Arming a CHECK ahead of
--   the deployed writer is what took prod harvest logging down on 2026-08-03 (23514 on every save).
--   The precondition is a property of the DEPLOYED ARTIFACT, not of this branch and not of a date:
--
--     PRECONDITION — every deployed writer of plants.divergence_type must emit only
--     division | cutting | saved_seed_from | NULL. Today that is one writer, the garden-plants
--     Lambda (lambda/plants/index.js, ALLOWED_DIVERGENCE on both the POST and PUT paths). Read the
--     value out of the LIVE function code, not out of this working tree. gates.yml carries this as
--     pre_deployed_writer_emits_canonical_vocabulary (manual: true) precisely because no SQL query
--     can answer it.
--
--   For this particular change the risk window happens to be empty, and it is worth stating why so
--   nobody generalises the exemption: the OLD deployed Lambda's allowlist is
--   mutation/cross/selection/unknown, ALL FOUR of which this CHECK rejects. It has therefore never
--   succeeded in writing this column and cannot produce a violating row -- prod and staging both
--   read 0 non-NULL divergence_type across ALL rows (prod 303 total / 270 live, staging 22).
--   Arming is a no-op against the old writer rather than a break. That is a fact about THIS
--   vocabulary swap; the sequencing above stands regardless.
--
-- EFFECT ON prod AND staging: NONE. Both already carry this constraint with convalidated = t
--   (verified read-only 2026-08-06), and VALIDATE CONSTRAINT on an already-validated constraint is
--   a no-op. This file does real work only on a fresh environment replayed from 0a.
--
-- SAFETY: idempotent, and it REFUSES rather than forces. The sweep below runs the CHECK predicate
--   over the FULL table -- every row, INCLUDING soft-deleted ones (deleted_at IS NOT NULL). Scoping
--   a pre-VALIDATE sweep to live rows is the classic way to get a green sweep followed by a red
--   VALIDATE: the constraint scans the heap, and Postgres does not care that a row is soft-deleted.
--   It also asserts the constraint's predicate is the canonical one before arming it, so an
--   environment that somehow acquired the wrong vocabulary fails loudly instead of validating the
--   wrong rule. Nothing here deletes or rewrites data (Soft-Delete-Only holds trivially: no DML).
--
-- NOT applied to any environment by the authoring session -- apply is Dave-gated, staging first.

BEGIN;

DO $$
DECLARE
  bad     bigint;
  sample  text;
  def     text;
  canon   text := 'CHECK (((divergence_type = ANY (ARRAY[''division''::text, ''cutting''::text, ''saved_seed_from''::text])) OR (divergence_type IS NULL)))';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plants_divergence_type_check') THEN
    RAISE EXCEPTION 'plants_divergence_type_check is absent -- run 0a-additive-ddl.sql first';
  END IF;

  -- The constraint must encode the canonical vocabulary, not merely exist. Guards against an
  -- environment where someone armed the dead mutation/cross/selection set instead.
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'plants_divergence_type_check';
  IF def <> canon THEN
    RAISE EXCEPTION 'plants_divergence_type_check predicate is not canonical. found: % expected: %', def, canon;
  END IF;

  -- FULL-TABLE sweep. NO deleted_at filter, deliberately -- see the SAFETY note above.
  SELECT count(*) INTO bad
    FROM public.plants
   WHERE divergence_type IS NOT NULL
     AND divergence_type NOT IN ('division','cutting','saved_seed_from');

  IF bad > 0 THEN
    SELECT string_agg(DISTINCT divergence_type, ', ') INTO sample
      FROM public.plants
     WHERE divergence_type IS NOT NULL
       AND divergence_type NOT IN ('division','cutting','saved_seed_from');
    RAISE EXCEPTION
      '% row(s) across the FULL plants table would violate plants_divergence_type_check (values: %). '
      'A writer is still emitting the dead vocabulary -- fix the writer and re-deploy before arming.',
      bad, sample;
  END IF;
END $$;

ALTER TABLE public.plants VALIDATE CONSTRAINT plants_divergence_type_check;

-- The FK recorded in 0a is validated here too; on prod/staging it is already convalidated.
ALTER TABLE public.plants VALIDATE CONSTRAINT plants_parent_plant_id_fkey;

DO $$
DECLARE
  ok boolean;
BEGIN
  SELECT convalidated INTO ok FROM pg_constraint WHERE conname = 'plants_divergence_type_check';
  IF NOT ok THEN
    RAISE EXCEPTION 'plants_divergence_type_check is still NOT VALID after VALIDATE';
  END IF;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.24.1-divergencevocab-001-validate','BUG-DIVERGENCEVOCAB-001 phase 2/2 (POST-DEPLOY). Asserts the canonical predicate, sweeps the FULL plants table (soft-deleted rows included) for violators, then VALIDATEs plants_divergence_type_check and plants_parent_plant_id_fkey. No-op on prod and staging, where both are already convalidated. Precondition is a property of the deployed artifact: every live writer of divergence_type must emit only division|cutting|saved_seed_from|NULL -- see gates.yml pre_deployed_writer_emits_canonical_vocabulary.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
