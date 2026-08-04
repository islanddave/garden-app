-- 0c-verify.sql
-- V4-CULTIVARNAME-001 — post-apply proof. Read-only: no BEGIN, no write, safe on prod at any time.
--
-- Run:  psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-cultivarname-001/0c-verify.sql
--
-- Every check below RAISES on failure rather than printing a row a human has to notice. A check
-- that can only be read by eye is a check that gets skipped at 11pm. The final SELECT prints the
-- surface inventory for the record.
--
-- WHAT THIS DOES NOT ASSERT. It cannot see the deployed Lambda's copy of cadence-data-v2.json.
-- Gate `deployed_lambda_resolves` in gates.yml covers that half; check 4 here only proves the DB
-- side of that contract (the name the Lambda will look up), and scripts/verify-cultivar-rename.mjs
-- checks the repo side. Both halves are required.

\echo '=== V4-CULTIVARNAME-001 verification ==='

DO $$
DECLARE n int; v text; bad text;
BEGIN
  ---------------------------------------------------------------------------
  -- 0. Environment guard. This file asserts facts about two specific rows, so
  --    it is only meaningful where those rows live. As of 2026-08-04 STAGING
  --    holds neither cultivar (full-column scan of all 68 staging tables: zero
  --    occurrences of any spelling), so 0b-rename.sql is a clean no-op there
  --    and this file has nothing to check. Fail loudly rather than pass
  --    vacuously — a verification that returns green on a database it never
  --    examined is worse than no verification.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO n FROM public.plant_varieties
   WHERE id IN ('b2be3698-b782-4a6b-8879-435effc9fcce','7b355b73-391c-4cdd-b040-f1cd87a447d5');
  IF n = 0 THEN
    RAISE EXCEPTION 'check 0: this database holds NEITHER target cultivar, so nothing here can be verified. Expected on staging — run 0c-verify-triggers.sql instead, which proves the sync mechanism on any environment. On PROD this is a genuine failure: the rows have been hard-deleted.';
  ELSIF n = 1 THEN
    RAISE EXCEPTION 'check 0: exactly one of the two target cultivars exists. Partial state — investigate before trusting any check below.';
  END IF;

  ---------------------------------------------------------------------------
  -- 1. The two cultivars carry exactly the new names, one live row each.
  ---------------------------------------------------------------------------
  SELECT name INTO v FROM public.plant_varieties
   WHERE id='b2be3698-b782-4a6b-8879-435effc9fcce' AND deleted_at IS NULL;
  IF v IS DISTINCT FROM 'Czech''s Bush' THEN
    RAISE EXCEPTION 'check 1a: plant_varieties b2be3698 name is % (expected Czech''s Bush)', COALESCE(v,'<missing>');
  END IF;

  SELECT name INTO v FROM public.plant_varieties
   WHERE id='7b355b73-391c-4cdd-b040-f1cd87a447d5' AND deleted_at IS NULL;
  IF v IS DISTINCT FROM 'Floradade' THEN
    RAISE EXCEPTION 'check 1b: plant_varieties 7b355b73 name is % (expected Floradade)', COALESCE(v,'<missing>');
  END IF;

  ---------------------------------------------------------------------------
  -- 2. ZERO live surfaces carry a stale spelling. Scoped to the tables that
  --    hold source-of-truth identity; the immutable/generated surfaces that
  --    legitimately keep the old string are enumerated in check 6.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO n FROM public.plant_varieties
   WHERE deleted_at IS NULL AND (name = 'Floridade' OR name = 'Czech Bush Slicer');
  IF n <> 0 THEN RAISE EXCEPTION 'check 2a: % live plant_varieties row(s) still stale', n; END IF;

  SELECT count(*) INTO n FROM public.plants
   WHERE deleted_at IS NULL AND (name = 'Floridade' OR name = 'Czech Bush Slicer');
  IF n <> 0 THEN RAISE EXCEPTION 'check 2b: % live plants row(s) still stale', n; END IF;

  SELECT count(*) INTO n FROM public.entity
   WHERE deleted_at IS NULL AND (display_name = 'Floridade' OR display_name = 'Czech Bush Slicer');
  IF n <> 0 THEN RAISE EXCEPTION 'check 2c: % live entity row(s) still stale', n; END IF;

  ---------------------------------------------------------------------------
  -- 3. The mirror agrees with its source for OUR FOUR ROWS. Deliberately
  --    scoped: prod carried 28 drifted mirror rows on 2026-08-04 (7 cultivar +
  --    21 planting) from the same root cause, of which exactly ONE is in scope
  --    here (entity 52ea7182, the Floradade cultivar — the other three in-scope
  --    rows currently AGREE with their still-stale sources). So 27 remain drifted
  --    afterwards, out of scope and tracked separately. 0a's triggers stop new
  --    drift; they cannot retro-heal a row nobody edits.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO n
    FROM public.entity e JOIN public.plant_varieties pv ON pv.id = e.cultivar_ref_id
   WHERE e.entity_type='cultivar' AND e.deleted_at IS NULL
     AND pv.id IN ('b2be3698-b782-4a6b-8879-435effc9fcce','7b355b73-391c-4cdd-b040-f1cd87a447d5')
     AND e.display_name IS DISTINCT FROM COALESCE(NULLIF(btrim(pv.name),''),'(cultivar)');
  IF n <> 0 THEN RAISE EXCEPTION 'check 3a: % cultivar mirror row(s) still desynced', n; END IF;

  SELECT count(*) INTO n
    FROM public.entity e JOIN public.plants p ON p.id = e.planting_ref_id
   WHERE e.entity_type='planting' AND e.deleted_at IS NULL
     AND p.id IN ('ee3fd4c5-5fa3-4202-8044-2c2d19e4835e','9274e985-1cfe-4470-ab5a-424f3e6bdcd2')
     AND e.display_name IS DISTINCT FROM COALESCE(NULLIF(btrim(p.name),''),'(planting)');
  IF n <> 0 THEN RAISE EXCEPTION 'check 3b: % planting mirror row(s) still desynced', n; END IF;

  ---------------------------------------------------------------------------
  -- 4. THE CARE-LAMBDA CONTRACT, DB half. resolveCadence() in
  --    lambda/daily-plan/engine.js looks up by_variety on [p.variety, p.name]
  --    where p.variety = plant_varieties.name and p.name = plants.name, with
  --    no normalization. Assert both strings the Lambda will present are the
  --    new key. (The Lambda's own copy of the JSON is gate
  --    `deployed_lambda_resolves`; the repo copy is verify-cultivar-rename.mjs.)
  ---------------------------------------------------------------------------
  SELECT pv.name || ' | ' || p.name INTO v
    FROM public.plants p JOIN public.plant_varieties pv ON pv.id = p.variety_id
   WHERE p.id = 'ee3fd4c5-5fa3-4202-8044-2c2d19e4835e' AND p.deleted_at IS NULL;
  IF v IS DISTINCT FROM 'Czech''s Bush | Czech''s Bush' THEN
    RAISE EXCEPTION 'check 4a: cadence lookup keys for the Czech planting are [%] (expected Czech''s Bush | Czech''s Bush)', COALESCE(v,'<missing>');
  END IF;

  SELECT pv.name || ' | ' || p.name INTO v
    FROM public.plants p JOIN public.plant_varieties pv ON pv.id = p.variety_id
   WHERE p.id = '9274e985-1cfe-4470-ab5a-424f3e6bdcd2' AND p.deleted_at IS NULL;
  IF v IS DISTINCT FROM 'Floradade | Floradade' THEN
    RAISE EXCEPTION 'check 4b: cadence lookup keys for the Floradade planting are [%] (expected Floradade | Floradade)', COALESCE(v,'<missing>');
  END IF;

  -- 4c. The Czech planting resolves its cadence from the DB tier, which wins over by_variety
  --     entirely (engine.js:32 returns early on db_cadence._seeded). That is a SECOND layer of
  --     protection for this specific planting, not the primary one — assert it so a future
  --     un-seeding is noticed rather than silently dropping back onto the name-keyed path.
  IF NOT EXISTS (SELECT 1 FROM public.v_resolved_care
                  WHERE leaf_id='ee3fd4c5-5fa3-4202-8044-2c2d19e4835e'
                    AND (resolved_profile->>'_seeded')::boolean IS TRUE) THEN
    RAISE WARNING 'check 4c: the Czech planting no longer has a seeded care_profile — its cadence now depends ENTIRELY on the by_variety name key. Confirm the deployed cadence-data-v2.json carries "Czech''s Bush".';
  END IF;

  ---------------------------------------------------------------------------
  -- 5. The triggers that stop this recurring actually exist and are enabled.
  ---------------------------------------------------------------------------
  SELECT string_agg(t.want, ', ') INTO bad
    FROM (VALUES ('plant_varieties_entity_rename','plant_varieties'),
                 ('plants_entity_rename','plants')) AS t(want, tbl)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger g
      WHERE g.tgname = t.want AND g.tgrelid = ('public.'||t.tbl)::regclass
        AND NOT g.tgisinternal AND g.tgenabled <> 'D');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'check 5: missing or disabled trigger(s): %', bad; END IF;

  ---------------------------------------------------------------------------
  -- 6. The old spelling SHOULD still exist in immutable history. If it does
  --    not, something rewrote an audit log or a snapshot and that is worse
  --    than the bug we came to fix.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO n FROM public.audit_events
   WHERE table_name = 'plant_varieties'
     AND (before_jsonb::text ILIKE '%Floridade%' OR before_jsonb::text ILIKE '%Czech Bush Slicer%'
       OR after_jsonb::text  ILIKE '%Floridade%' OR after_jsonb::text  ILIKE '%Czech Bush Slicer%');
  IF n = 0 THEN
    RAISE WARNING 'check 6: audit_events carries NO record of the old spellings. On prod that is a red flag (expected >0); on staging or a fresh branch it is expected.';
  END IF;

  RAISE NOTICE 'V4-CULTIVARNAME-001: all checks passed.';
END $$;

\echo ''
\echo '--- surface inventory (for the record) ---'
SELECT 'plant_varieties' AS surface, id::text, name AS value
  FROM public.plant_varieties
 WHERE id IN ('b2be3698-b782-4a6b-8879-435effc9fcce','7b355b73-391c-4cdd-b040-f1cd87a447d5')
UNION ALL
SELECT 'cultivar (VIEW)', id::text, display_name
  FROM public.cultivar
 WHERE id IN ('b2be3698-b782-4a6b-8879-435effc9fcce','7b355b73-391c-4cdd-b040-f1cd87a447d5')
UNION ALL
SELECT 'plants', id::text, name
  FROM public.plants
 WHERE id IN ('ee3fd4c5-5fa3-4202-8044-2c2d19e4835e','9274e985-1cfe-4470-ab5a-424f3e6bdcd2')
UNION ALL
SELECT 'garden_node (VIEW)', id::text, display_name
  FROM public.garden_node
 WHERE id IN ('ee3fd4c5-5fa3-4202-8044-2c2d19e4835e','9274e985-1cfe-4470-ab5a-424f3e6bdcd2')
UNION ALL
SELECT 'entity ('||entity_type||')', id::text, display_name
  FROM public.entity
 WHERE id IN ('f0f36069-0115-451c-9869-d01ec0323c53','88a08b2f-8659-41e8-a622-0c6fcb807b94',
              '52ea7182-1c45-4f76-97ae-10fd1c73c57f','07881250-f942-4ffe-8be7-278c168d7c7e')
ORDER BY 1, 3;

\echo ''
\echo '--- OUT OF SCOPE, reported not fixed: other drifted entity mirror rows ---'
SELECT 'cultivar' AS kind, e.id::text AS entity_id, e.display_name AS mirror_says, pv.name AS source_says
  FROM public.entity e JOIN public.plant_varieties pv ON pv.id = e.cultivar_ref_id
 WHERE e.entity_type='cultivar' AND e.deleted_at IS NULL
   AND e.display_name IS DISTINCT FROM COALESCE(NULLIF(btrim(pv.name),''),'(cultivar)')
UNION ALL
SELECT 'planting', e.id::text, e.display_name, p.name
  FROM public.entity e JOIN public.plants p ON p.id = e.planting_ref_id
 WHERE e.entity_type='planting' AND e.deleted_at IS NULL
   AND e.display_name IS DISTINCT FROM COALESCE(NULLIF(btrim(p.name),''),'(planting)')
ORDER BY 1, 3;
