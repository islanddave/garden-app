// harvest-hero-membership.int.test.js — BUG-HARVHEROMEMBER-001, real-Postgres proof.
//
// WHY THIS FILE EXISTS AND WHY IT HAS TO BE INTEGRATION-TIER. The crop rail's hero query
// (lambda/harvests/index.js) resolved gn.featured_photo_id with an ALIVE filter and no membership
// re-check — half of INV-HERO. The other half is the half that matters here: a photo can stop
// belonging to a planting WITHOUT being deleted (PhotoLibrary's full-replace PUT re-parents it;
// V4-PHOTOUNTAG-001 returns it to the untagged inbox with every parent nulled). No deleted_at filter
// can see that, so the query kept preferring a photo that now belongs somewhere else and the fallback
// below it never got a chance — COALESCE already had a non-null id.
//
// Measured on prod 2026-08-31 the defect has ZERO live instances (0 of 251 garden_node pointers fail
// membership on a live planting), which is exactly why a static-text guard is not enough on its own:
// there is no production row that would demonstrate the behaviour, so the shape has to be BUILT. The
// sibling guard in lambda/harvests/crop-hero.test.js asserts the SQL text; this file is the only
// thing that observes Postgres actually resolving it.
//
// Fixture chain is the crop-attribution one from cal1-harvweight.int.test.js (crop_types ->
// plant_varieties.crop_type_slug -> plants.variety_id), because hero_plant_id only exists for a
// planting whose harvests are attributed to a crop. One crop_type per scenario keeps each hero
// selection independent — computeAggregates picks one winner per crop, so sharing a slug would make
// the tests fight over it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, setTestUserId, testRunId, insertProject } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'
import { handler as harvestsHandler } from '../../lambda/harvests/index.js'

const HAS_DEPS = (await directSql`
  SELECT (to_regclass('public.harvest_log') IS NOT NULL
      AND to_regclass('public.crop_types') IS NOT NULL
      AND to_regclass('public.photos') IS NOT NULL) AS ok`)[0].ok

describe.skipIf(!HAS_DEPS)('crop hero — the featured pointer must still be a MEMBER', () => {
  const RUN = testRunId()
  const USER = `hero_mem_${RUN}`
  const slugs = []
  let projectId

  // A crop + cultivar + planting + one attributed harvest, so this planting becomes its crop's hero.
  const mkCrop = async (tag) => {
    const slug = `heromem-${tag}-${RUN}`
    slugs.push(slug)
    await directSql`
      INSERT INTO crop_types (slug, display_name, default_unit)
      VALUES (${slug}, ${'HeroMem ' + tag}, 'count')`
    const cv = await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug)
      VALUES (${`cv-${tag}-${RUN}`}, ${USER}, ${slug}) RETURNING id`
    const pl = await directSql`
      INSERT INTO plants (project_id, name, created_by, variety_id)
      VALUES (${projectId}, ${`plant-${tag}-${RUN}`}, ${USER}, ${cv[0].id}) RETURNING id`
    const plantId = pl[0].id
    const ev = await directSql`
      INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public, logged_by, created_by)
      VALUES (${projectId}, ${plantId}, 'harvest', '2026-07-15T16:00:00Z'::timestamptz, true, ${USER}, ${USER})
      RETURNING id`
    await directSql`
      INSERT INTO harvest_log (event_id, project_id, quantity, unit, created_by)
      VALUES (${ev[0].id}, ${projectId}, 1::numeric, 'count', ${USER})`
    return { slug, plantId, eventId: ev[0].id }
  }

  // `at` drives the fallback's ORDER BY created_at DESC, so every test states its own winner rather
  // than depending on insertion order.
  const mkPhoto = async ({ plant = null, event = null, project = null, at, intake = null, deleted = false }) => {
    const rows = await directSql`
      INSERT INTO photos (plant_id, event_id, project_id, storage_path, created_by, intake_status,
                          created_at, deleted_at)
      VALUES (${plant}, ${event}, ${project},
              ${`int/heromem/${RUN}/${Math.random().toString(36).slice(2)}.jpg`},
              ${USER}, ${intake}, ${at}::timestamptz, ${deleted ? at : null}::timestamptz)
      RETURNING id`
    return rows[0].id
  }

  const setFeatured = (plantId, photoId) =>
    directSql`UPDATE plants SET featured_photo_id = ${photoId} WHERE id = ${plantId}`

  // The endpoint's own answer for one crop — never a direct SQL re-read, or the test would be
  // asserting against a query it wrote itself rather than the one that ships.
  const heroPhotoOf = async (slug) => {
    setTestUserId(USER)
    const { status, body } = await callHandler(harvestsHandler, {
      method: 'GET', path: '/api/harvests?timeframe=all&include=aggregates',
    })
    expect(status).toBe(200)
    const crop = body.aggregates.crops.find((c) => c.crop_type_slug === slug)
    expect(crop, `crop ${slug} missing from aggregates — fixture did not attribute`).toBeTruthy()
    return crop.hero_photo_id
  }

  beforeAll(async () => {
    setTestUserId(USER)
    projectId = (await insertProject({ name: 'heromem-' + RUN, createdBy: USER })).id
  })

  afterAll(async () => {
    assertFixtureId(USER)
    await settle('harvest-hero-membership', [
      // featured_photo_id -> photos is ON DELETE SET NULL, but photos.plant_id -> plants and
      // photos.event_id -> event_log are ON DELETE RESTRICT, so photos must go before both.
      () => directSql`UPDATE plants SET featured_photo_id = NULL WHERE created_by = ${USER}`,
      () => directSql`DELETE FROM harvest_log WHERE created_by = ${USER}`,
      () => directSql`DELETE FROM photos WHERE created_by = ${USER}`,
      () => directSql`DELETE FROM event_log WHERE created_by = ${USER}`,
      () => directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${USER})`,
      () => directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`,
      () => directSql`DELETE FROM plants WHERE created_by = ${USER}`,
      () => directSql`DELETE FROM entity WHERE cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ${USER})`,
      () => directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`,
      () => directSql`DELETE FROM crop_types WHERE slug = ANY(${slugs})`,
      () => directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`,
    ])
  })

  // POSITIVE CONTROL FIRST, and deliberately so: 30 of 31 live crops resolve through the explicit
  // arm, so the expensive way to get this wrong is not "the dangle survives" but "the re-check
  // demotes everybody". If this test ever goes red the fix is a mass regression, not a fix.
  it('still PREFERS a properly attached featured photo over a newer survivor', async () => {
    const { slug, plantId } = await mkCrop('ok')
    const chosen = await mkPhoto({ plant: plantId, at: '2026-07-01T00:00:00Z' })
    await mkPhoto({ plant: plantId, at: '2026-07-20T00:00:00Z' }) // newer — would win the fallback
    await setFeatured(plantId, chosen)
    expect(await heroPhotoOf(slug)).toBe(chosen)
  })

  // Event-attached heroes are the reason the membership arm is a disjunction. EventNew logs event
  // photos with {project_id, event_id} and NO plant_id; a plant_id-only re-check would demote every
  // one of them. On prod that shape is 94 of the 251 plant pointers.
  it('accepts a featured photo attached through the planting’s EVENT, not its plant_id', async () => {
    const { slug, plantId, eventId } = await mkCrop('evt')
    const chosen = await mkPhoto({ event: eventId, project: projectId, at: '2026-07-01T00:00:00Z' })
    await mkPhoto({ plant: plantId, at: '2026-07-20T00:00:00Z' })
    await setFeatured(plantId, chosen)
    expect(await heroPhotoOf(slug)).toBe(chosen)
  })

  // THE DEFECT. Nothing is deleted; the photo simply stops being this planting's.
  it('FALLS BACK when the featured photo has been re-parented to another planting', async () => {
    const { slug, plantId } = await mkCrop('moved')
    const survivor = await mkPhoto({ plant: plantId, at: '2026-07-01T00:00:00Z' })
    const moved = await mkPhoto({ plant: plantId, at: '2026-07-20T00:00:00Z' })
    await setFeatured(plantId, moved)
    const other = await mkCrop('moved-dest')
    await directSql`UPDATE photos SET plant_id = ${other.plantId} WHERE id = ${moved}`

    // The pointer is still stored and still references a live row — this is the whole point.
    // Every column here is alias-qualified: plants and photos BOTH carry deleted_at, so the bare
    // spelling is an ambiguous-reference error rather than a wrong answer.
    const [row] = await directSql`SELECT p.featured_photo_id, ph.deleted_at IS NULL AS alive
      FROM plants p JOIN photos ph ON ph.id = p.featured_photo_id WHERE p.id = ${plantId}`
    expect(row.featured_photo_id).toBe(moved)
    expect(row.alive).toBe(true)

    expect(await heroPhotoOf(slug)).toBe(survivor)
  })

  // The lane's actual finding: V4-PHOTOUNTAG-001 clears every parent and sets 'pending_tag'. The
  // pointer survives that too.
  it('FALLS BACK when the featured photo was returned to the untagged inbox', async () => {
    const { slug, plantId } = await mkCrop('inbox')
    const survivor = await mkPhoto({ plant: plantId, at: '2026-07-01T00:00:00Z' })
    const untagged = await mkPhoto({ plant: plantId, at: '2026-07-20T00:00:00Z' })
    await setFeatured(plantId, untagged)
    await directSql`UPDATE photos SET plant_id = NULL, project_id = NULL, location_id = NULL,
                                      intake_status = 'pending_tag' WHERE id = ${untagged}`
    expect(await heroPhotoOf(slug)).toBe(survivor)
  })

  // The half that already worked, pinned so the LATERAL rewrite cannot have dropped it.
  it('FALLS BACK when the featured photo is soft-deleted', async () => {
    const { slug, plantId } = await mkCrop('del')
    const survivor = await mkPhoto({ plant: plantId, at: '2026-07-01T00:00:00Z' })
    const gone = await mkPhoto({ plant: plantId, at: '2026-07-20T00:00:00Z', deleted: true })
    await setFeatured(plantId, gone)
    expect(await heroPhotoOf(slug)).toBe(survivor)
  })

  // A dangling pointer with nothing to fall back to must yield NULL, not the dangling id. Without
  // this, "fell back" and "returned the stale id" are indistinguishable whenever a survivor exists.
  it('yields NULL — never the stale id — when a dangling pointer has no survivor', async () => {
    const { slug, plantId } = await mkCrop('nosurv')
    const only = await mkPhoto({ plant: plantId, at: '2026-07-01T00:00:00Z' })
    await setFeatured(plantId, only)
    const other = await mkCrop('nosurv-dest')
    await directSql`UPDATE photos SET plant_id = ${other.plantId} WHERE id = ${only}`
    expect(await heroPhotoOf(slug)).toBeNull()
  })
})
