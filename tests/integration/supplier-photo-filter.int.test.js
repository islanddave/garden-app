// supplier-photo-filter.int.test.js — V5-SEEDVENDORPHOTOFILTER-001 against a real Postgres.
//
// Supplier packet images (our ingest names them vendor-image--*) stay out of the unscoped gallery
// (Photo Library default page, Space attach picker) and out of header photo search. The predicate's
// hazard is SQL-shaped and invisible to the unit suite, which never executes SQL: original_filename
// is NULL on most rows, and `NULL NOT LIKE 'x'` is NULL, so a bare NOT LIKE would silently drop every
// photo that has no stored file name. This proves the filter drops the supplier image and keeps both
// kinds of own photo — and that the read My seeds depends on, minting a supplier image by id, still
// answers.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'

vi.hoisted(() => {
  process.env.S3_PHOTOS_BUCKET = 'garden-photos-int-test'
  process.env.AWS_REGION = 'us-east-1'
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client, cmd) =>
    `https://stub-s3.invalid/${cmd?.input?.Key ?? 'unknown'}?signed=1`),
}))

const { handler } = await import('../../lambda/photos/index.js')
const { searchPhotos } = await import('../../lambda/dashboard/handlers.js')

const RUN = testRunId()
const USER = `user_int_supplierphoto_${RUN}`
const CAPTION = `Seed packet ${RUN}`

let itemId
const ids = {}

async function insertPhoto(label, originalFilename) {
  const rows = await directSql`
    INSERT INTO photos (inventory_item_id, storage_path, uploaded_by, created_by, original_filename, caption)
    VALUES (${itemId}, ${`inventory/${itemId}/${RUN}-${label}.jpg`}, ${USER}, ${USER}, ${originalFilename},
            ${`${CAPTION} · ${label}`})
    RETURNING id
  `
  return rows[0].id
}

beforeAll(async () => {
  setTestUserId(USER)
  // A durable tool: needs only `quantity` (durable_requires_quantity), where a seed lot would need a
  // variety row too. The parent's kind is irrelevant to the predicate under test.
  const item = await directSql`
    INSERT INTO inventory_items (name, type, category, quantity, created_by, user_id)
    VALUES (${'int-supplierphoto-' + RUN}, 'durable', 'tools', 1, ${USER}, ${USER})
    RETURNING id
  `
  itemId = item[0].id
  ids.supplier = await insertPhoto('supplier', `vendor-image--botanical-interests--${RUN}.jpg`)
  // The two shapes an own photo takes on prod: no stored file name (most rows), and a camera name.
  ids.nameless = await insertPhoto('nameless', null)
  ids.named = await insertPhoto('named', `IMG_${RUN}.jpg`)
})

afterAll(async () => {
  // Fixtures are hard-deleted (the test-teardown carve-out). photos first: its parent is the item.
  await directSql`DELETE FROM photos WHERE created_by = ${USER}`
  await directSql`DELETE FROM inventory_items WHERE created_by = ${USER}`
})

const listIds = async (path) => {
  const { status, body } = await callHandler(handler, { method: 'GET', path })
  expect(status, `${path} -> ${JSON.stringify(body).slice(0, 200)}`).toBe(200)
  return new Set(body.map((p) => p.id))
}

describe('supplier packet images are left out of the unscoped gallery and photo search', () => {
  it('fixture: all three photos are live and belong to the caller', async () => {
    const rows = await directSql`
      SELECT count(*)::int AS n FROM photos WHERE created_by = ${USER} AND deleted_at IS NULL`
    expect(rows[0].n).toBe(3)
  })

  it('GET /api/photos keeps both own photos — including the one with NO file name — and drops the supplier image', async () => {
    setTestUserId(USER)
    for (const path of ['/api/photos', '/api/photos?limit=200']) {
      const got = await listIds(path)
      expect(got.has(ids.nameless), `${path}: an own photo with a NULL original_filename vanished (NULL NOT LIKE)`).toBe(true)
      expect(got.has(ids.named), `${path}: an own photo with a camera file name vanished`).toBe(true)
      expect(got.has(ids.supplier), `${path}: the supplier image is in the unscoped gallery`).toBe(false)
    }
  })

  it('header photo search finds both own photos by caption and not the supplier image', async () => {
    const rows = await searchPhotos(directSql, USER, `%${CAPTION}%`)
    const got = new Set(rows.map((r) => r.id))
    expect(got).toEqual(new Set([ids.nameless, ids.named]))
  })

  it('the supplier image still mints by id — the read My seeds draws its thumbnail through', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/photos/view-url/${ids.supplier}?tier=thumb`,
    })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body.view_url).toContain(`thumbs/inventory/${itemId}/${RUN}-supplier.jpg`)
  })
})
