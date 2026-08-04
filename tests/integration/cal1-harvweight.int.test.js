// cal1-harvweight.int.test.js — CAL-1 harvest weight derivation (POST /api/events).
//
// REWRITTEN 2026-08-03 for V4-HARVDUAL-001. The original pinned harvweight-001's contract, where a
// weight was estimated from crop_types.grams_per_unit gated on crop_types.default_unit = unit. That
// contract is retired: refweight-001 replaced the scalar with a per-unit jsonb map at BOTH the crop
// and variety level, pervariety-001 added real measured samples, and slicec-001 folded all of it
// into public.resolve_harvest_weight — the single derivation locus both write paths call.
//
// RESOLUTION ORDER under test (resolve_harvest_weight v3, V4-CAL1SAMPLECONF-001):
//   1. user-supplied grams          -> basis 'measured',  estimated false
//   2. unit is g/kg/lb/oz           -> basis 'measured',  estimated false
//   3. cultivar_weight_derived, CORROBORATED -> basis 'cultivar', estimated true  (real weighings)
//   4. plant_varieties.unit_weights -> basis 'cultivar',  estimated true   (reference)
//   5. cultivar_weight_derived, provisional  -> basis 'cultivar', estimated true  (n=1, only where
//                                      no variety reference exists)
//   6. crop_types.unit_weights      -> basis 'crop_type', estimated true   ONLY if the crop allows it
//   7. nothing                      -> NULL/NULL/NULL — no estimate, never guessed
//
// UPDATED 2026-08-04 for V4-CAL1SAMPLECONF-001. v2 ranked tier 3 above tier 4 unconditionally; a
// single unrepresentative weighing therefore overrode catalog on 16 of 18 derived groups (5
// Beefsteak resolved 140 g against a curated 1750 g). Tier 3 now requires corroboration —
// confidence IN ('high','medium'), i.e. sample_n >= 2, OR sample_n >= 5. The boundary cases live in
// cal1-sampleconf.int.test.js; this file keeps the end-to-end tier walk.
//
// Requires the CAL-1 columns; skips cleanly on a branch that lacks them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, setTestUserId, testRunId, insertProject } from './_harness.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'

const HAS_CAL1 = (await directSql`
  SELECT (to_regclass('public.harvest_log') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='harvest_log' AND column_name='weight_grams')
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='crop_types' AND column_name='unit_weights')
    AND to_regclass('public.cultivar_weight_sample') IS NOT NULL) AS ok`)[0].ok

describe.skipIf(!HAS_CAL1)('CAL-1 harvest weight derivation — POST /api/events (V4-HARVDUAL-001)', () => {
  const RUN = testRunId()
  const USER = `cal1_user_${RUN}`
  const CROP_FALLBACK = `cal1-crop-fb-${RUN}`   // unit_weights, variety_grams_required = FALSE
  const CROP_STRICT   = `cal1-crop-st-${RUN}`   // unit_weights, variety_grams_required = TRUE
  const CROP_UNSEEDED = `cal1-crop-uns-${RUN}`  // no unit_weights at all
  let projectId
  let plantCropFallback, plantCropFallbackClean, plantCropStrict, plantVarietyRef, plantSampled, plantUnseeded
  let cvSampledId

  // Hoisted to describe scope so individual tests can build their own fixtures (the uncorroborated
  // n=1 case below needs a variety no other test has weighed).
  const mkPlanting = async (slug, cvName, plantName, unitWeights = null) => {
    const cv = await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug, unit_weights)
      VALUES (${cvName + '-' + RUN}, ${USER}, ${slug}, ${unitWeights}::jsonb) RETURNING id`
    const pl = await directSql`
      INSERT INTO plants (project_id, name, created_by, variety_id)
      VALUES (${projectId}, ${plantName}, ${USER}, ${cv[0].id}) RETURNING id`
    return { cultivarId: cv[0].id, plantId: pl[0].id }
  }

  beforeAll(async () => {
    setTestUserId(USER)
    projectId = (await insertProject({ name: 'cal1-' + RUN, createdBy: USER })).id

    // A crop whose crop-level number IS a defensible fallback (low between-variety variance).
    await directSql`
      INSERT INTO crop_types (slug, display_name, default_unit, unit_weights, variety_grams_required)
      VALUES (${CROP_FALLBACK}, 'CAL1 Fallback Crop', 'count', ${'{"count":50}'}::jsonb, false)`
    // A high-variance crop: a crop-level average must NOT stand in for a missing variety number.
    await directSql`
      INSERT INTO crop_types (slug, display_name, default_unit, unit_weights, variety_grams_required)
      VALUES (${CROP_STRICT}, 'CAL1 Strict Crop', 'count', ${'{"count":50}'}::jsonb, true)`
    await directSql`
      INSERT INTO crop_types (slug, display_name, default_unit, unit_weights, variety_grams_required)
      VALUES (${CROP_UNSEEDED}, 'CAL1 Unseeded Crop', 'count', NULL, false)`

    plantCropFallback = (await mkPlanting(CROP_FALLBACK, 'cv-fb', 'plant-fb')).plantId
    // A SECOND fallback planting that no test ever weighs. The user-weight tests above post real
    // weights against plantCropFallback, and auto-capture then turns those into samples for its
    // variety — so by the time the crop-tier assertion runs, that variety has been promoted to the
    // SAMPLE tier and no longer exercises the crop fallback at all. (Auto-capture working exactly as
    // designed; the fixture was the bug.) This planting stays pristine.
    plantCropFallbackClean = (await mkPlanting(CROP_FALLBACK, 'cv-fb-clean', 'plant-fb-clean')).plantId
    plantCropStrict   = (await mkPlanting(CROP_STRICT,   'cv-st', 'plant-st')).plantId
    plantUnseeded     = (await mkPlanting(CROP_UNSEEDED, 'cv-uns', 'plant-uns')).plantId
    // variety reference overrides the crop number (7 vs 50)
    plantVarietyRef   = (await mkPlanting(CROP_STRICT, 'cv-ref', 'plant-ref', '{"count":7}')).plantId
    // a variety carrying BOTH a reference (7) and a real sample (200 g / 10 = 20) — the sample wins
    const sampled = await mkPlanting(CROP_STRICT, 'cv-sampled', 'plant-sampled', '{"count":7}')
    plantSampled = sampled.plantId
    cvSampledId = sampled.cultivarId
    await directSql`
      INSERT INTO cultivar_weight_sample
        (cultivar_id, unit, total_grams, unit_count, sampled_at, created_by)
      VALUES (${cvSampledId}, 'count', 200, 10, now(), ${USER})`
  })

  afterAll(async () => {
    await directSql`DELETE FROM xp_events WHERE user_id = ${USER}`
    await directSql`DELETE FROM user_achievements WHERE user_id = ${USER}`
    await directSql`DELETE FROM user_stats WHERE user_id = ${USER}`
    await directSql`DELETE FROM app_events WHERE user_clerk_sub = ${USER}`
    await directSql`DELETE FROM harvest_log WHERE created_by = ${USER}`
    await directSql`DELETE FROM entity_memory WHERE project_id = ${projectId}`
    // cultivar_weight_sample carries a BEFORE DELETE immutability trigger — by design, corrections
    // go to the void ledger and rows are never removed. That makes ordinary teardown impossible, so
    // the trigger is disabled for the duration of this DELETE and restored immediately. This is the
    // ONLY sanctioned place to do that: production corrections must still go through the void ledger.
    // (Worth knowing operationally — purging bad sample data anywhere needs this same dance.)
    await directSql`DELETE FROM cultivar_weight_void WHERE created_by = ${USER}`
    await directSql`ALTER TABLE cultivar_weight_sample DISABLE TRIGGER trg_cws_immutable`
    try {
      await directSql`DELETE FROM cultivar_weight_sample WHERE created_by = ${USER}`
    } finally {
      await directSql`ALTER TABLE cultivar_weight_sample ENABLE TRIGGER trg_cws_immutable`
    }
    await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
    await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
    await directSql`DELETE FROM plants WHERE created_by = ${USER}`
    await directSql`DELETE FROM entity WHERE cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ${USER})`
    await directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`
    await directSql`DELETE FROM crop_types WHERE slug IN (${CROP_FALLBACK}, ${CROP_STRICT}, ${CROP_UNSEEDED})`
    await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
  })

  const postHarvest = (extra) => {
    setTestUserId(USER)
    return callHandler(eventsHandler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'harvest', event_date: new Date().toISOString(), ...extra },
    })
  }

  // ── tier 2: the quantity IS the weight ───────────────────────────────────────
  it('MEASURED: unit=kg → qty*1000, estimated=false, basis=measured', async () => {
    const { status, body } = await postHarvest({ harvest: { quantity: 2, unit: 'kg' } })
    expect(status).toBe(201)
    expect(Number(body.harvest.weight_grams)).toBe(2000)
    expect(body.harvest.weight_estimated).toBe(false)
    expect(body.harvest.weight_basis).toBe('measured')
  })

  it('MEASURED: unit=oz → qty*28.3495, estimated=false', async () => {
    const { status, body } = await postHarvest({ harvest: { quantity: 4, unit: 'oz' } })
    expect(status).toBe(201)
    expect(Number(body.harvest.weight_grams)).toBeCloseTo(113.398, 2)
    expect(body.harvest.weight_estimated).toBe(false)
  })

  // ── tier 1: dual capture — the whole point of V4-HARVDUAL-001 ────────────────
  it('USER WEIGHT: count + weight together → the typed grams beat every estimate', async () => {
    const { status, body } = await postHarvest({
      plant_id: plantCropFallback, harvest: { quantity: 5, unit: 'count', weight: 337 },
    })
    expect(status).toBe(201)
    expect(Number(body.harvest.weight_grams)).toBe(337)   // NOT 5*50 = 250
    expect(body.harvest.weight_estimated).toBe(false)
    expect(body.harvest.weight_basis).toBe('measured')
  })

  it('USER WEIGHT: the scale unit is converted server-side', async () => {
    const { status, body } = await postHarvest({
      plant_id: plantCropFallback, harvest: { quantity: 5, unit: 'count', weight: 2, weight_unit: 'lb' },
    })
    expect(status).toBe(201)
    expect(Number(body.harvest.weight_grams)).toBeCloseTo(907.184, 2)
    expect(body.harvest.weight_estimated).toBe(false)
  })

  it('AUTO-CAPTURE: a dual count+weight harvest becomes a calibration sample for the variety', async () => {
    const before = await directSql`
      SELECT count(*)::int AS n FROM cultivar_weight_sample WHERE cultivar_id = ${cvSampledId}`
    const { status } = await postHarvest({
      plant_id: plantSampled, harvest: { quantity: 4, unit: 'count', weight: 100 },
    })
    expect(status).toBe(201)
    const after = await directSql`
      SELECT count(*)::int AS n FROM cultivar_weight_sample WHERE cultivar_id = ${cvSampledId}`
    expect(after[0].n).toBe(before[0].n + 1)
    // pooled count-weighted: (200 + 100) / (10 + 4)
    const derived = await directSql`
      SELECT grams_per_unit::float8 AS g FROM cultivar_weight_derived
       WHERE cultivar_id = ${cvSampledId} AND unit = 'count'`
    expect(derived[0].g).toBeCloseTo(300 / 14, 4)
  })

  it('AUTO-CAPTURE: a weight-unit harvest records NO sample (no count, so no ratio)', async () => {
    const before = await directSql`
      SELECT count(*)::int AS n FROM cultivar_weight_sample WHERE cultivar_id = ${cvSampledId}`
    await postHarvest({ plant_id: plantSampled, harvest: { quantity: 3, unit: 'lb' } })
    const after = await directSql`
      SELECT count(*)::int AS n FROM cultivar_weight_sample WHERE cultivar_id = ${cvSampledId}`
    expect(after[0].n).toBe(before[0].n)
  })

  // ── tiers 3/4/5: estimates ───────────────────────────────────────────────────
  it('SAMPLE TIER: a CORROBORATED weighing outranks the variety reference value', async () => {
    // By this point the fixture sample (200 g / 10) and the auto-captured one (100 g / 4) give
    // n=2 -> confidence 'medium', which is corroborated, so the pooled 300/14 beats the 7 g
    // reference. Asserted explicitly: under v3 the tier depends on sample_n, so a future fixture
    // change that silently dropped this to n=1 would flip the expected tier rather than fail here.
    const d = await directSql`
      SELECT sample_n::int AS n, confidence FROM cultivar_weight_derived
       WHERE cultivar_id = ${cvSampledId} AND unit = 'count'`
    expect(d[0].n, `this test needs a corroborated row; got sample_n=${d[0].n}`).toBeGreaterThanOrEqual(2)
    expect(['high', 'medium'], `confidence was '${d[0].confidence}'`).toContain(d[0].confidence)

    const { status, body } = await postHarvest({
      plant_id: plantSampled, harvest: { quantity: 2, unit: 'count' },
    })
    expect(status).toBe(201)
    expect(Number(body.harvest.weight_grams),
      `corroborated samples (n=${d[0].n}, ${d[0].confidence}) must win: expected `
      + `${(2 * (300 / 14)).toFixed(3)} g, got ${body.harvest.weight_grams} g`)
      .toBeCloseTo(2 * (300 / 14), 3)
    expect(body.harvest.weight_estimated).toBe(true)
    expect(body.harvest.weight_basis).toBe('cultivar')
  })

  it('SAMPLE TIER: an UNCORROBORATED (n=1) weighing does NOT outrank the reference', async () => {
    // The defect V4-CAL1SAMPLECONF-001 fixes, in miniature: reference 40 g/fruit, one weighing at
    // 4 g/fruit. 3 count must resolve to 120 g (reference), not 12 g (the single sample).
    const one = await mkPlanting(CROP_STRICT, 'cv-one-sample', 'plant-one-sample', '{"count":40}')
    await directSql`
      INSERT INTO cultivar_weight_sample
        (cultivar_id, unit, total_grams, unit_count, sampled_at, created_by)
      VALUES (${one.cultivarId}, 'count', 4, 1, now(), ${USER})`
    const { status, body } = await postHarvest({
      plant_id: one.plantId, harvest: { quantity: 3, unit: 'count' },
    })
    expect(status).toBe(201)
    expect(Number(body.harvest.weight_grams),
      `n=1 is uncorroborated, so the 40 g reference must hold: expected 120 g, got `
      + `${body.harvest.weight_grams} g (the v2 defect returned 3 x 4 = 12 g)`)
      .toBeCloseTo(120, 3)
    expect(body.harvest.weight_basis).toBe('cultivar')
  })

  it('VARIETY TIER: variety unit_weights outrank the crop number', async () => {
    const { status, body } = await postHarvest({
      plant_id: plantVarietyRef, harvest: { quantity: 3, unit: 'count' },
    })
    expect(status).toBe(201)
    expect(Number(body.harvest.weight_grams)).toBe(21)   // 3 * 7, NOT 3 * 50
    expect(body.harvest.weight_basis).toBe('cultivar')
  })

  it('CROP TIER: used when the crop permits a crop-level fallback', async () => {
    const { status, body } = await postHarvest({
      plant_id: plantCropFallbackClean, harvest: { quantity: 3, unit: 'count' },
    })
    expect(status).toBe(201)
    expect(Number(body.harvest.weight_grams)).toBe(150)  // 3 * 50
    expect(body.harvest.weight_estimated).toBe(true)
    expect(body.harvest.weight_basis).toBe('crop_type')
  })

  it('CROP TIER GATED: variety_grams_required blocks the crop average → no estimate', async () => {
    // the crop HAS a number (50) but the variety does not, and this crop's between-variety variance
    // makes that average indefensible — NULL beats a plausible-looking guess
    const { status, body } = await postHarvest({
      plant_id: plantCropStrict, harvest: { quantity: 3, unit: 'count' },
    })
    expect(status).toBe(201)
    expect(body.harvest.weight_grams).toBeNull()
    expect(body.harvest.weight_estimated).toBeNull()
    expect(body.harvest.weight_basis).toBeNull()
  })

  it('NO ESTIMATE: a crop with no unit_weights at all → all three NULL', async () => {
    const { status, body } = await postHarvest({
      plant_id: plantUnseeded, harvest: { quantity: 5, unit: 'count' },
    })
    expect(status).toBe(201)
    expect(body.harvest.weight_grams).toBeNull()
    expect(body.harvest.weight_estimated).toBeNull()
  })

  it('NO ESTIMATE: an unattributed (project-level) harvest resolves no crop → NULL', async () => {
    const { status, body } = await postHarvest({ harvest: { quantity: 7, unit: 'count' } })
    expect(status).toBe(201)
    expect(body.harvest.weight_grams).toBeNull()
    expect(body.harvest.weight_estimated).toBeNull()
  })

  it('NO ESTIMATE: a unit the maps do not cover falls through (count-only map, cup harvest)', async () => {
    const { status, body } = await postHarvest({
      plant_id: plantVarietyRef, harvest: { quantity: 2, unit: 'cup' },
    })
    expect(status).toBe(201)
    expect(body.harvest.weight_grams).toBeNull()
  })

  // ── invariants ───────────────────────────────────────────────────────────────
  it('pairing invariant: weight, estimated flag and basis are all-or-nothing together', async () => {
    const bad = await directSql`
      SELECT count(*)::int AS n FROM harvest_log
       WHERE created_by = ${USER}
         AND ((weight_grams IS NULL) <> (weight_estimated IS NULL)
           OR (weight_grams IS NULL) <> (weight_basis IS NULL))`
    expect(bad[0].n).toBe(0)
  })

  it('basis and estimated flag never disagree', async () => {
    const bad = await directSql`
      SELECT count(*)::int AS n FROM harvest_log
       WHERE created_by = ${USER} AND weight_basis IS NOT NULL
         AND weight_estimated <> (weight_basis <> 'measured')`
    expect(bad[0].n).toBe(0)
  })
})
