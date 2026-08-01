// cal1-harvweight.int.test.js — V4-CAL1-HARVWEIGHT-001 harvest weight derivation (POST /api/events).
//
// The harvest POST path (lambda/events/index.js new_harvest CTE) derives harvest_log.weight_grams +
// weight_estimated at write time:
//   MEASURED  — the harvest unit is itself a weight (g/kg/lb/oz): grams = qty * GRAMS_PER_WEIGHT_UNIT,
//               weight_estimated = false. No crop chain needed.
//   ESTIMATED — the unit matches the crop's default_unit AND the crop has a grams_per_unit:
//               grams = qty * crop.grams_per_unit, weight_estimated = true.
//   NEITHER   — else (unseeded crop, unit≠default_unit, or no planting resolved): both NULL. NULL
//               grams_per_unit = UNKNOWN = no estimate; the value is never guessed (0a NULL contract).
//
// Seeds the live derivation join: event_log.plant_id -> garden_node(view over plants).cultivar_id
// (= plants.variety_id) -> cultivar(view over plant_varieties).crop_type_slug -> crop_types.slug,
// gated by crop_types.default_unit = harvest unit. Requires the CAL-1 columns (staging-applied
// 2026-07-30 to br-damp-frog-amdfxwrr, which integration-test.yml branches its ephemeral DB from);
// skips cleanly if a branch lacks them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, setTestUserId, testRunId, insertProject } from './_harness.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'

const HAS_CAL1 = (await directSql`
  SELECT (to_regclass('public.harvest_log') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='harvest_log' AND column_name='weight_grams')) AS ok`)[0].ok

describe.skipIf(!HAS_CAL1)('CAL-1 harvest weight derivation — POST /api/events (V4-CAL1-HARVWEIGHT-001)', () => {
  const RUN = testRunId()
  const USER = `cal1_user_${RUN}`
  const CROP = `cal1-crop-${RUN}`              // seeded: default_unit=count, grams_per_unit=50
  const CROP_UNSEEDED = `cal1-crop-uns-${RUN}` // default_unit=count, grams_per_unit=NULL
  let projectId, plantSeeded, plantUnseeded

  beforeAll(async () => {
    setTestUserId(USER)
    projectId = (await insertProject({ name: 'cal1-' + RUN, createdBy: USER })).id

    await directSql`
      INSERT INTO crop_types (slug, display_name, default_unit, grams_per_unit)
      VALUES (${CROP}, ${'CAL1 Test Crop'}, 'count', ${50})`
    await directSql`
      INSERT INTO crop_types (slug, display_name, default_unit, grams_per_unit)
      VALUES (${CROP_UNSEEDED}, ${'CAL1 Unseeded Crop'}, 'count', ${null})`

    // cultivar (plant_varieties base) -> planting (plants base, variety_id = cultivar) per crop.
    const cvSeeded = await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug)
      VALUES (${'cal1-cv-seeded-' + RUN}, ${USER}, ${CROP}) RETURNING id`
    plantSeeded = (await directSql`
      INSERT INTO plants (project_id, name, created_by, variety_id)
      VALUES (${projectId}, ${'cal1-plant-seeded'}, ${USER}, ${cvSeeded[0].id}) RETURNING id`)[0].id

    const cvUnseeded = await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug)
      VALUES (${'cal1-cv-uns-' + RUN}, ${USER}, ${CROP_UNSEEDED}) RETURNING id`
    plantUnseeded = (await directSql`
      INSERT INTO plants (project_id, name, created_by, variety_id)
      VALUES (${projectId}, ${'cal1-plant-uns'}, ${USER}, ${cvUnseeded[0].id}) RETURNING id`)[0].id
  })

  afterAll(async () => {
    // FK-safe teardown mirroring events.int.test.js (entity registry + entity_memory before plants).
    await directSql`DELETE FROM xp_events WHERE user_id = ${USER}`
    await directSql`DELETE FROM user_achievements WHERE user_id = ${USER}`
    await directSql`DELETE FROM user_stats WHERE user_id = ${USER}`
    await directSql`DELETE FROM app_events WHERE user_clerk_sub = ${USER}`
    await directSql`DELETE FROM harvest_log WHERE created_by = ${USER}`
    await directSql`DELETE FROM entity_memory WHERE project_id = ${projectId}`
    await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
    await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
    await directSql`DELETE FROM plants WHERE created_by = ${USER}`
    // entity also carries a cultivar_ref_id -> plant_varieties FK (RESTRICT); clear before varieties.
    await directSql`DELETE FROM entity WHERE cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ${USER})`
    await directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`
    await directSql`DELETE FROM crop_types WHERE slug IN (${CROP}, ${CROP_UNSEEDED})`
    await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
  })

  const postHarvest = (extra) => {
    setTestUserId(USER)
    return callHandler(eventsHandler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'harvest', event_date: new Date().toISOString(), ...extra },
    })
  }

  it('MEASURED: unit=kg → weight_grams = qty*1000, weight_estimated=false (no crop chain)', async () => {
    const { status, body } = await postHarvest({ harvest: { quantity: 2, unit: 'kg' } })
    expect(status).toBe(201)
    expect(Number(body.harvest.weight_grams)).toBe(2000)
    expect(body.harvest.weight_estimated).toBe(false)
  })

  it('MEASURED: unit=oz → weight_grams = qty*28.3495, weight_estimated=false', async () => {
    const { status, body } = await postHarvest({ harvest: { quantity: 4, unit: 'oz' } })
    expect(status).toBe(201)
    expect(Number(body.harvest.weight_grams)).toBeCloseTo(113.398, 2)
    expect(body.harvest.weight_estimated).toBe(false)
  })

  it('ESTIMATED: unit=count on a seeded crop (grams_per_unit=50) → weight_grams=qty*50, estimated=true', async () => {
    const { status, body } = await postHarvest({ plant_id: plantSeeded, harvest: { quantity: 3, unit: 'count' } })
    expect(status).toBe(201)
    expect(Number(body.harvest.weight_grams)).toBe(150)
    expect(body.harvest.weight_estimated).toBe(true)
  })

  it('NO ESTIMATE: unit=count on an unseeded crop (grams_per_unit NULL) → both NULL (never guessed)', async () => {
    const { status, body } = await postHarvest({ plant_id: plantUnseeded, harvest: { quantity: 5, unit: 'count' } })
    expect(status).toBe(201)
    expect(body.harvest.weight_grams).toBeNull()
    expect(body.harvest.weight_estimated).toBeNull()
  })

  it('NO ESTIMATE: project-level count harvest (no plant_id resolves no crop) → both NULL', async () => {
    const { status, body } = await postHarvest({ harvest: { quantity: 7, unit: 'count' } })
    expect(status).toBe(201)
    expect(body.harvest.weight_grams).toBeNull()
    expect(body.harvest.weight_estimated).toBeNull()
  })

  it('pairing invariant: no row carries a weight without its provenance flag (or vice-versa)', async () => {
    const bad = await directSql`
      SELECT count(*)::int AS n FROM harvest_log
       WHERE created_by = ${USER} AND (weight_grams IS NULL) <> (weight_estimated IS NULL)`
    expect(bad[0].n).toBe(0)
  })
})
