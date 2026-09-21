// seed-cards.int.test.js — V5-SEEDCARDS-001 against a real Postgres.
//
// The seed card reads two things the unit suite can only see as SQL TEXT (lambda/_test-stubs never
// executes it): the packet photo, derived by an explicit-pointer JOIN and a newest-live-photo LATERAL
// that runs only when the pointer is empty, and eleven cultivar facts read through the `cultivar`
// view. On prod 306 of 327 seed lots get their picture from that fallback arm, so it is the one this
// file drives. It also proves at the DATABASE level the claim the list's code comment makes and no
// unit test can: a list row PUT back whole — what the Inventory stepper and SavedSeeds do — never
// promotes the fallback photo into inventory_items.featured_photo_id. If it did, Dave's own next
// photo of that packet could never become its cover (the photos Lambda only fills an EMPTY pointer).
//
// S3: the handler presigns at module load's bucket; the presigner is stubbed to a deterministic URL
// (the photos-authz.int.test.js treatment), so a URL here proves which KEY was signed, nothing more.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { directSql, callHandler, setTestUserId, testRunId } from './_harness.js'

vi.hoisted(() => {
  process.env.S3_PHOTOS_BUCKET = 'garden-photos-int-test'
  process.env.AWS_REGION = 'us-east-1'
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client, cmd) => `https://stub-s3.invalid/${cmd?.input?.Key ?? 'unknown'}?signed=1`),
}))

const { handler } = await import('../../lambda/inventory-items/index.js')

const RUN = testRunId()
const USER = `user_int_seedcards_${RUN}`

// Built OUTSIDE the SQL template: sql-comment-hygiene.test.js forbids '//' inside one.
const VARIETY_URL = `https://example.test/${RUN}`

let varietyId
let lotId
let livePhotoId
let livePath

const listRow = async (path) => {
  const { status, body } = await callHandler(handler, { method: 'GET', path })
  expect(status, `${path} -> ${JSON.stringify(body).slice(0, 200)}`).toBe(200)
  const row = body.find((r) => r.id === lotId)
  expect(row, `lot missing from ${path}`).toBeTruthy()
  return row
}
const pointer = async () => (await directSql`
  SELECT featured_photo_id FROM inventory_items WHERE id = ${lotId}`)[0].featured_photo_id

beforeAll(async () => {
  setTestUserId(USER)

  // Every fact the card shows, with the CHECKs they carry: a breeding_system needs a
  // breeding_source; source_url must be https.
  const v = await directSql`
    INSERT INTO plant_varieties (
      name, created_by, species, origin_country, origin_region,
      scoville_min, scoville_max, scoville_source,
      breeding_system, breeding_source, days_to_maturity_min, days_to_maturity_max, dtm_basis, source_url)
    VALUES (
      ${'variety-seedcards-' + RUN}, ${USER}, 'Capsicum chinense', 'Mexico', 'Yucatán',
      100000, 350000, 'inference',
      'f1', 'vendor_catalog', 90, 100, 'from-transplant', ${VARIETY_URL})
    RETURNING id`
  varietyId = v[0].id

  const { status, body } = await callHandler(handler, {
    method: 'POST',
    path: '/api/inventory-items',
    body: {
      name: `seedcards-lot-${RUN}`, type: 'consumable', category: 'seeds', unit: 'packet',
      quantity_on_hand: 1, variety_id: varietyId,
    },
  })
  expect(status, `seed lot POST -> ${JSON.stringify(body)}`).toBe(201)
  lotId = body.id

  // The fallback arm's shape: a live photo on the lot, and NO explicit pointer. A soft-deleted photo
  // made AFTER it must not win the "newest" race — the alive filter is part of the contract.
  livePath = `inventory/${lotId}/${RUN}-live.jpg`
  const ph = await directSql`
    INSERT INTO photos (inventory_item_id, storage_path, created_by, is_public)
    VALUES (${lotId}, ${livePath}, ${USER}, false) RETURNING id`
  livePhotoId = ph[0].id
  await directSql`
    INSERT INTO photos (inventory_item_id, storage_path, created_by, is_public, deleted_at, created_at)
    VALUES (${lotId}, ${`inventory/${lotId}/${RUN}-dead.jpg`}, ${USER}, false, now(), now() + interval '1 minute')`
})

afterAll(async () => {
  // photos.inventory_item_id is ON DELETE SET NULL, and a photo with no parent fails
  // photos_must_have_parent, so the photos go first. plant_varieties is left to the namespaced
  // sweep in _cleanup.js (entity carries FKs into it), as seed-lifecycle.int.test.js does.
  await directSql`DELETE FROM photos WHERE created_by = ${USER}`
  await directSql`DELETE FROM inventory_items WHERE created_by = ${USER}`
})

describe('the seed list row, read from a real database', () => {
  // BUG-SEEDLISTSIGNING-001: the list carries the hero's ID and no URL — My seeds mints the thumbs it
  // draws. The id is the whole contract now, so it is what this proves against real rows.
  it('?category=seeds: the FALLBACK photo is the hero, the raw pointer stays null, nothing signed', async () => {
    setTestUserId(USER)
    expect(await pointer(), 'fixture: the lot must start with no explicit pointer').toBeNull()
    const r = await listRow('/api/inventory-items?category=seeds')
    expect(r.hero_photo_id).toBe(livePhotoId)
    expect(r.featured_photo_id).toBeNull()
    expect(r).not.toHaveProperty('featured_photo_view_url')
    expect(r).not.toHaveProperty('featured_photo_thumb_url')
    expect(r).not.toHaveProperty('featured_photo_storage_path')
    expect(r).not.toHaveProperty('effective_featured_photo_id')
    // BUG-SEEDTHUMBSOFFLINE-001: the FALLBACK hero's own thumb key — not the soft-deleted newer photo's.
    expect(r.hero_thumb_key).toBe(`thumbs/${livePath}`)
  })

  it('carries every cultivar fact the card shows, through the cultivar view', async () => {
    setTestUserId(USER)
    const r = await listRow('/api/inventory-items?category=seeds')
    expect({
      species: r.species, origin_country: r.origin_country, origin_region: r.origin_region,
      scoville_min: r.scoville_min, scoville_max: r.scoville_max, scoville_source: r.scoville_source,
      breeding_system: r.breeding_system, days_to_maturity_min: r.days_to_maturity_min,
      days_to_maturity_max: r.days_to_maturity_max, dtm_basis: r.dtm_basis, variety_source_url: r.variety_source_url,
    }).toEqual({
      species: 'Capsicum chinense', origin_country: 'Mexico', origin_region: 'Yucatán',
      scoville_min: 100000, scoville_max: 350000, scoville_source: 'inference',
      breeding_system: 'f1', days_to_maturity_min: 90, days_to_maturity_max: 100,
      dtm_basis: 'from-transplant', variety_source_url: VARIETY_URL,
    })
  })

  it('the unfiltered list derives the same hero and signs nothing', async () => {
    setTestUserId(USER)
    const r = await listRow('/api/inventory-items')
    expect(r.hero_photo_id).toBe(livePhotoId)
    expect(r.featured_photo_id).toBeNull()
    expect(r).not.toHaveProperty('featured_photo_view_url')
    expect(r).not.toHaveProperty('featured_photo_thumb_url')
  })

  it('by-id hands the packet page the same hero', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, { method: 'GET', path: `/api/inventory-items/${lotId}` })
    expect(status).toBe(200)
    expect(body.hero_photo_id).toBe(livePhotoId)
    expect(body.featured_photo_view_url).toBe(`https://stub-s3.invalid/${livePath}?signed=1`)
    expect(body.species).toBe('Capsicum chinense')
  })

  it('a list row PUT back whole never promotes the fallback photo into the explicit pointer', async () => {
    setTestUserId(USER)
    for (const path of ['/api/inventory-items?category=seeds', '/api/inventory-items']) {
      const row = await listRow(path)
      const { status, body } = await callHandler(handler, {
        method: 'PUT', path: `/api/inventory-items/${lotId}`, body: { ...row, quantity_on_hand: 2 },
      })
      expect(status, `PUT of a ${path} row -> ${JSON.stringify(body).slice(0, 200)}`).toBe(200)
      expect(await pointer(), `a ${path} row wrote its derived hero into featured_photo_id`).toBeNull()
    }
    // Non-vacuous: the PUT really landed.
    expect(Number((await directSql`SELECT quantity_on_hand FROM inventory_items WHERE id = ${lotId}`)[0].quantity_on_hand))
      .toBe(2)
  })
})
