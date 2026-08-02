// space-photos.int.test.js — V4-SPACEPHOTO-001 against REAL Postgres (staging Neon branch, which
// carries the Lane C DDL: photos.space_id, spaces.featured_photo_id, the 7-clause
// photos_must_have_parent).
//
// Why integration and not more static guards: coverage is blind to lambda/photos/** and the sibling
// lambda/photos/*.test.js files assert SOURCE TEXT, so a CI-green run is not evidence that any of
// this executes. The named ACs below are the ones whose failure modes are DB-shaped — an exact-match
// partition, an ON CONFLICT add-parent, a soft-deleted FK that ON DELETE SET NULL never fires on,
// and a cross-household predicate. None of those can be proven by reading the file.
//
// AC-5 (flag-off inertness) is covered on BOTH levels: the emitted-SQL half lives in
// lambda/photos/space-photos.test.js (executes buildPhotoInsert and inspects the statement text);
// the behavioural half is here.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
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

const RUN = testRunId()
const USER = `user_int_space_${RUN}`
const FOREIGN_USER = `user_int_space_foreign_${RUN}`
// A well-formed uuid that matches no row — the control for the no-existence-oracle assertion.
const ABSENT_SPACE = '00000000-0000-0000-0000-0000000000ff'

let spaceId
let foreignSpaceId
let locationId

async function newSpace(owner, label) {
  const rows = await directSql`
    INSERT INTO spaces (name, created_by) VALUES (${label}, ${owner}) RETURNING id
  `
  return rows[0].id
}

async function insertPhoto({ storagePath, owner = USER, space = null, location = null, contentHash = null, intake = null }) {
  const rows = await directSql`
    INSERT INTO photos (storage_path, uploaded_by, created_by, space_id, location_id, content_hash, intake_status)
    VALUES (${storagePath}, ${owner}, ${owner}, ${space}, ${location}, ${contentHash}, ${intake})
    RETURNING id
  `
  return rows[0].id
}

beforeAll(async () => {
  setTestUserId(USER)
  spaceId = await newSpace(USER, `int-space-${RUN}`)
  foreignSpaceId = await newSpace(FOREIGN_USER, `int-space-foreign-${RUN}`)
  const loc = await directSql`
    INSERT INTO locations (name, slug, created_by) VALUES (${'int-loc-' + RUN}, ${'int-loc-' + RUN}, ${USER})
    RETURNING id
  `
  locationId = loc[0].id
})

afterAll(async () => {
  // Hard delete is correct for fixtures (explicit carve-out to Soft-Delete-Only). Order matters:
  // photos.space_id is ON DELETE RESTRICT, so the photos must go before the spaces.
  await directSql`UPDATE spaces SET featured_photo_id = NULL WHERE id IN (${spaceId}, ${foreignSpaceId})`
  await directSql`DELETE FROM photos WHERE created_by IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM locations WHERE id = ${locationId}`
  await directSql`DELETE FROM spaces WHERE id IN (${spaceId}, ${foreignSpaceId})`
  delete process.env.SPACE_PHOTOS_ENABLED
})

beforeEach(async () => {
  process.env.SPACE_PHOTOS_ENABLED = 'true'
  await directSql`UPDATE spaces SET featured_photo_id = NULL WHERE id IN (${spaceId}, ${foreignSpaceId})`
  await directSql`DELETE FROM photos WHERE created_by IN (${USER}, ${FOREIGN_USER})`
})

describe('AC-1 — GET /api/photos?space_id is an EXACT match, not a subtree walk', () => {
  it('returns the space photo and EXCLUDES a photo attached to a location', async () => {
    const onSpace = await insertPhoto({ storagePath: `spaces/${RUN}/hero.jpg`, space: spaceId })
    const onLocation = await insertPhoto({ storagePath: `locations/${RUN}/bed.jpg`, location: locationId })

    const res = await callHandler(handler, { method: 'GET', path: `/api/photos?space_id=${spaceId}` })
    expect(res.status).toBe(200)
    const ids = res.body.map((p) => p.id)
    expect(ids).toContain(onSpace)
    // The whole point: reusing the ?location_id WITH RECURSIVE loc_subtree walk here would drag in
    // every descendant location's photos and this assertion is what catches that.
    expect(ids).not.toContain(onLocation)
    expect(ids).toHaveLength(1)
  })

  it('does not disturb the ?location_id gallery', async () => {
    const onSpace = await insertPhoto({ storagePath: `spaces/${RUN}/x.jpg`, space: spaceId })
    const onLocation = await insertPhoto({ storagePath: `locations/${RUN}/y.jpg`, location: locationId })

    const res = await callHandler(handler, { method: 'GET', path: `/api/photos?location_id=${locationId}` })
    const ids = res.body.map((p) => p.id)
    expect(ids).toContain(onLocation)
    expect(ids).not.toContain(onSpace)
  })

  it('another household\'s photo on the SAME space is never returned', async () => {
    // created_by is the conjunct that stops an attach (by anyone who can see the space) from
    // becoming a cross-household read.
    const mine = await insertPhoto({ storagePath: `spaces/${RUN}/mine.jpg`, space: spaceId })
    const theirs = await insertPhoto({ storagePath: `spaces/${RUN}/theirs.jpg`, space: spaceId, owner: FOREIGN_USER })

    const res = await callHandler(handler, { method: 'GET', path: `/api/photos?space_id=${spaceId}` })
    const ids = res.body.map((p) => p.id)
    expect(ids).toEqual([mine])
    expect(ids).not.toContain(theirs)
  })
})

describe('AC-2 — set-featured re-designates the hero', () => {
  it('the first uploaded photo auto-features, and a later explicit choice REPLACES it', async () => {
    const first = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `spaces/${RUN}/a.jpg`, space_id: spaceId },
    })
    expect(first.status).toBe(201)
    let [row] = await directSql`SELECT featured_photo_id FROM spaces WHERE id = ${spaceId}`
    expect(row.featured_photo_id).toBe(first.body.id)

    const second = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `spaces/${RUN}/b.jpg`, space_id: spaceId },
    })
    expect(second.status).toBe(201)
    // Auto-promote only fills a NULL, so the second upload must NOT steal the hero.
    ;[row] = await directSql`SELECT featured_photo_id FROM spaces WHERE id = ${spaceId}`
    expect(row.featured_photo_id).toBe(first.body.id)

    // ...but an explicit designation must, or the first photo ever uploaded is locked in forever.
    const put = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/space-featured/${spaceId}`, body: { photo_id: second.body.id },
    })
    expect(put.status).toBe(200)
    ;[row] = await directSql`SELECT featured_photo_id FROM spaces WHERE id = ${spaceId}`
    expect(row.featured_photo_id).toBe(second.body.id)
  })

  it('{ photo_id: null } clears the hero', async () => {
    const id = await insertPhoto({ storagePath: `spaces/${RUN}/c.jpg`, space: spaceId })
    await directSql`UPDATE spaces SET featured_photo_id = ${id} WHERE id = ${spaceId}`

    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/space-featured/${spaceId}`, body: { photo_id: null },
    })
    expect(res.status).toBe(200)
    const [row] = await directSql`SELECT featured_photo_id FROM spaces WHERE id = ${spaceId}`
    expect(row.featured_photo_id).toBeNull()
  })

  it('rejects a photo that is not attached to this space', async () => {
    const unattached = await insertPhoto({ storagePath: `locations/${RUN}/z.jpg`, location: locationId })
    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/space-featured/${spaceId}`, body: { photo_id: unattached },
    })
    expect(res.status).toBe(400)
    const [row] = await directSql`SELECT featured_photo_id FROM spaces WHERE id = ${spaceId}`
    expect(row.featured_photo_id).toBeNull()
  })
})

describe('AC-3 — cross-household attach and set-featured are refused, with no existence oracle', () => {
  it('POST with another household\'s space_id 400s and writes nothing', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `spaces/${RUN}/steal.jpg`, space_id: foreignSpaceId },
    })
    expect(res.status).toBe(400)
    const rows = await directSql`SELECT id FROM photos WHERE space_id = ${foreignSpaceId}`
    expect(rows).toHaveLength(0)
  })

  it('PUT space-featured against another household\'s space 400s and leaves it untouched', async () => {
    const theirPhoto = await insertPhoto({
      storagePath: `spaces/${RUN}/theirhero.jpg`, space: foreignSpaceId, owner: FOREIGN_USER,
    })
    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/space-featured/${foreignSpaceId}`, body: { photo_id: theirPhoto },
    })
    expect(res.status).toBe(400)
    const [row] = await directSql`SELECT featured_photo_id FROM spaces WHERE id = ${foreignSpaceId}`
    expect(row.featured_photo_id).toBeNull()
  })

  it('a foreign space and an absent space are INDISTINGUISHABLE in the response', async () => {
    const foreign = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/space-featured/${foreignSpaceId}`, body: { photo_id: null },
    })
    const absent = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/space-featured/${ABSENT_SPACE}`, body: { photo_id: null },
    })
    expect(foreign.status).toBe(absent.status)
    expect(foreign.body).toEqual(absent.body)
  })

  it('the space-hero read 404s on another household\'s space', async () => {
    const res = await callHandler(handler, { method: 'GET', path: `/api/photos/space-hero/${foreignSpaceId}` })
    expect(res.status).toBe(404)
  })

  it('a malformed space id is a 400, not an opaque 22P02 500', async () => {
    const res = await callHandler(handler, {
      method: 'PUT', path: '/api/photos/space-featured/not-a-uuid', body: { photo_id: null },
    })
    expect(res.status).toBe(400)
  })
})

describe('AC-4 — POST add-parent: a duplicate content_hash ATTACHES rather than silently dropping', () => {
  it('re-POSTing an existing hash with a space_id sets space_id on the existing row', async () => {
    const hash = `hash-space-${RUN}`
    const first = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `locations/${RUN}/grand.jpg`, location_id: locationId, content_hash: hash },
    })
    expect(first.status).toBe(201)
    let [row] = await directSql`SELECT space_id FROM photos WHERE id = ${first.body.id}`
    expect(row.space_id).toBeNull()

    // The "grand photo" flow: the image is ALREADY attached elsewhere, so the dedupe fires. Without
    // add-parent semantics the handler returns the existing row and the requested space is dropped.
    const second = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `locations/${RUN}/grand.jpg`, location_id: locationId, content_hash: hash, space_id: spaceId },
    })
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)
    expect(second.body.id).toBe(first.body.id)

    ;[row] = await directSql`SELECT space_id FROM photos WHERE id = ${first.body.id}`
    expect(row.space_id).toBe(spaceId)
  })

  it('COALESCE keeps an existing space_id — a re-upload does not re-point an attached photo', async () => {
    const hash = `hash-keep-${RUN}`
    const other = await newSpace(USER, `int-space-other-${RUN}`)
    try {
      const first = await callHandler(handler, {
        method: 'POST', path: '/api/photos',
        body: { storage_path: `spaces/${RUN}/keep.jpg`, space_id: spaceId, content_hash: hash },
      })
      expect(first.status).toBe(201)

      await callHandler(handler, {
        method: 'POST', path: '/api/photos',
        body: { storage_path: `spaces/${RUN}/keep.jpg`, space_id: other, content_hash: hash },
      })
      const [row] = await directSql`SELECT space_id FROM photos WHERE id = ${first.body.id}`
      expect(row.space_id).toBe(spaceId)
    } finally {
      await directSql`UPDATE spaces SET featured_photo_id = NULL WHERE id = ${other}`
      await directSql`DELETE FROM photos WHERE space_id = ${other}`
      await directSql`DELETE FROM spaces WHERE id = ${other}`
    }
  })

  it('a space_id alone satisfies photos_must_have_parent for an upload_failed row', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `spaces/${RUN}/failed.jpg`, space_id: spaceId, intake_status: 'upload_failed' },
    })
    expect(res.status).toBe(201)
  })
})

describe('AC-5 — flag OFF is behaviourally identical to the pre-V4 handler', () => {
  beforeEach(() => { delete process.env.SPACE_PHOTOS_ENABLED })

  it('?space_id is IGNORED — the unfiltered list is returned, exactly as an unknown param is today', async () => {
    const onSpace = await insertPhoto({ storagePath: `spaces/${RUN}/off1.jpg`, space: spaceId })
    const onLocation = await insertPhoto({ storagePath: `locations/${RUN}/off2.jpg`, location: locationId })

    const res = await callHandler(handler, { method: 'GET', path: `/api/photos?space_id=${spaceId}` })
    expect(res.status).toBe(200)
    const ids = res.body.map((p) => p.id)
    // If the filter had been applied, the location photo would be absent.
    expect(ids).toContain(onSpace)
    expect(ids).toContain(onLocation)
    // And the response carries no space_id key at all — the column is not in the SELECT list.
    expect(res.body[0]).not.toHaveProperty('space_id')
  })

  it('POST ignores space_id entirely (the column is not in the INSERT)', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `spaces/${RUN}/off3.jpg`, location_id: locationId, space_id: spaceId },
    })
    expect(res.status).toBe(201)
    const [row] = await directSql`SELECT space_id FROM photos WHERE id = ${res.body.id}`
    expect(row.space_id).toBeNull()
  })

  it('POST with ONLY space_id still 400s on the pre-V4 parentless rule', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `spaces/${RUN}/off4.jpg`, space_id: spaceId, intake_status: 'upload_failed' },
    })
    expect(res.status).toBe(400)
  })

  it('neither space route exists — both fall through to the 405 the pre-V4 handler gave', async () => {
    const hero = await callHandler(handler, { method: 'GET', path: `/api/photos/space-hero/${spaceId}` })
    expect(hero.status).toBe(405)
    const featured = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/space-featured/${spaceId}`, body: { photo_id: null },
    })
    expect(featured.status).toBe(405)
  })
})

describe('AC-6 — a soft-deleted hero falls back instead of returning a dead URL', () => {
  it('space-hero skips the soft-deleted featured photo and serves the newest survivor', async () => {
    const dead = await insertPhoto({ storagePath: `spaces/${RUN}/dead.jpg`, space: spaceId })
    // Sequenced so the survivor is unambiguously newer than the soft-deleted hero.
    await new Promise((r) => setTimeout(r, 5))
    const alive = await insertPhoto({ storagePath: `spaces/${RUN}/alive.jpg`, space: spaceId })
    await directSql`UPDATE spaces SET featured_photo_id = ${dead} WHERE id = ${spaceId}`
    await directSql`UPDATE photos SET deleted_at = now() WHERE id = ${dead}`

    // ON DELETE SET NULL only fires on a HARD delete, so the FK still points at the dead row.
    const [space] = await directSql`SELECT featured_photo_id FROM spaces WHERE id = ${spaceId}`
    expect(space.featured_photo_id).toBe(dead)

    const res = await callHandler(handler, { method: 'GET', path: `/api/photos/space-hero/${spaceId}` })
    expect(res.status).toBe(200)
    expect(res.body.space_id).toBe(spaceId)
    expect(res.body.name).toBe(`int-space-${RUN}`)
    expect(res.body.featured_photo_id).toBe(alive)
    expect(res.body.featured_photo_view_url).toContain(`spaces/${RUN}/alive.jpg`)
  })

  it('serves the designated hero when it is alive, and null when the space has no photos', async () => {
    const res0 = await callHandler(handler, { method: 'GET', path: `/api/photos/space-hero/${spaceId}` })
    expect(res0.status).toBe(200)
    expect(res0.body.featured_photo_id).toBeNull()
    expect(res0.body.featured_photo_view_url).toBeNull()

    const id = await insertPhoto({ storagePath: `spaces/${RUN}/live.jpg`, space: spaceId })
    await directSql`UPDATE spaces SET featured_photo_id = ${id} WHERE id = ${spaceId}`
    const res1 = await callHandler(handler, { method: 'GET', path: `/api/photos/space-hero/${spaceId}` })
    expect(res1.body.featured_photo_id).toBe(id)
    expect(res1.body.featured_photo_view_url).toContain(`spaces/${RUN}/live.jpg`)
  })
})

describe('AC-8 — GET /api/photos/space-hero with NO id resolves the caller\'s own space', () => {
  // THE DEFECT THIS CLOSES: every other space route needs a :spaceId and nothing shipped could
  // supply one — no /api/spaces, and no read shape leaks workspace_id. The frontend's stopgap was a
  // VITE_SPACE_ID build variable unset in every environment, so the feature was unreachable.
  it('returns the household\'s space, with the id the other space routes need', async () => {
    const id = await insertPhoto({ storagePath: `spaces/${RUN}/noid.jpg`, space: spaceId })

    const res = await callHandler(handler, { method: 'GET', path: '/api/photos/space-hero' })
    expect(res.status).toBe(200)
    expect(res.body.space_id).toBe(spaceId)
    expect(res.body.name).toBe(`int-space-${RUN}`)
    expect(res.body.featured_photo_id).toBe(id)
    expect(res.body.featured_photo_view_url).toContain(`spaces/${RUN}/noid.jpg`)
    expect(res.body.household_space_count).toBe(1)

    // The returned id must actually work on the sibling routes — that is the whole point of the
    // discovery path, and an id resolved by a DIFFERENT rule than loadOwnedSpace's would 400 here.
    const put = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/space-featured/${res.body.space_id}`, body: { photo_id: id },
    })
    expect(put.status).toBe(200)
    const gallery = await callHandler(handler, { method: 'GET', path: `/api/photos?space_id=${res.body.space_id}` })
    expect(gallery.status).toBe(200)
    expect(gallery.body.map((p) => p.id)).toEqual([id])
  })

  it('agrees with the explicit /:spaceId form (one query, two routes)', async () => {
    await insertPhoto({ storagePath: `spaces/${RUN}/agree.jpg`, space: spaceId })
    const noId = await callHandler(handler, { method: 'GET', path: '/api/photos/space-hero' })
    const byId = await callHandler(handler, { method: 'GET', path: `/api/photos/space-hero/${spaceId}` })
    const { household_space_count: _c, ...noIdBody } = noId.body
    expect(noIdBody).toEqual(byId.body)
  })

  it('a household with NO space gets a 200 empty state, not a 404', async () => {
    // A 404 here is indistinguishable from a broken scope, so the client would have to treat a
    // perfectly normal condition as a failure. There is also no id to probe for, so a 200 leaks
    // nothing. Contrast the /:spaceId form, which still 404s (asserted in AC-3).
    setTestUserId(`user_int_space_orphan_${RUN}`)
    try {
      const res = await callHandler(handler, { method: 'GET', path: '/api/photos/space-hero' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        space_id: null,
        name: null,
        featured_photo_id: null,
        featured_is_explicit: false,
        featured_photo_view_url: null,
        household_space_count: 0,
      })
    } finally {
      setTestUserId(USER)
    }
  })

  it('never resolves another household\'s space', async () => {
    await insertPhoto({ storagePath: `spaces/${RUN}/foreignonly.jpg`, space: foreignSpaceId, owner: FOREIGN_USER })
    setTestUserId(`user_int_space_orphan2_${RUN}`)
    try {
      const res = await callHandler(handler, { method: 'GET', path: '/api/photos/space-hero' })
      expect(res.body.space_id).toBeNull()
    } finally {
      setTestUserId(USER)
    }
  })

  it('MORE than one space: deterministic oldest pick, reported count, never an error', async () => {
    // Today the live table holds exactly one space. Erroring on >1 would take a household's hero
    // down the moment it gained a second one — a regression triggered by unrelated data — so the
    // pick is the oldest (created_at never changes, so it is stable) and the true count is
    // surfaced instead of the assumption being silently baked in.
    const extra = await directSql`
      INSERT INTO spaces (name, created_by, created_at)
      VALUES (${'int-space-newer-' + RUN}, ${USER}, now() + interval '1 hour')
      RETURNING id
    `
    const newerId = extra[0].id
    try {
      const res = await callHandler(handler, { method: 'GET', path: '/api/photos/space-hero' })
      expect(res.status).toBe(200)
      expect(res.body.household_space_count).toBe(2)
      expect(res.body.space_id).toBe(spaceId)
      expect(res.body.space_id).not.toBe(newerId)

      // Stable across calls — not whatever Postgres happens to return first.
      const again = await callHandler(handler, { method: 'GET', path: '/api/photos/space-hero' })
      expect(again.body.space_id).toBe(spaceId)
    } finally {
      await directSql`UPDATE spaces SET featured_photo_id = NULL WHERE id = ${newerId}`
      await directSql`DELETE FROM photos WHERE space_id = ${newerId}`
      await directSql`DELETE FROM spaces WHERE id = ${newerId}`
    }
  })

  it('the id-free route does not exist with the flag OFF', async () => {
    delete process.env.SPACE_PHOTOS_ENABLED
    try {
      const res = await callHandler(handler, { method: 'GET', path: '/api/photos/space-hero' })
      expect(res.status).toBe(405)
      expect(res.body).toEqual({ error: 'Method not allowed' })
    } finally {
      process.env.SPACE_PHOTOS_ENABLED = 'true'
    }
  })
})

describe('AC-9 — the hero says whether it is an explicit designation or a fallback', () => {
  // THE DEFECT THIS CLOSES: featured_photo_id is the EFFECTIVE hero (COALESCE of the stored
  // designation and the newest space photo), which keeps the id and the url consistent but makes
  // the response ambiguous. The client's set-featured control no-ops when the tapped id already
  // equals featured_photo_id — so tapping the photo that merely HAPPENS to be the fallback
  // persisted nothing, and the hero silently reverted on the next upload.
  it('a fallback hero reports featured_is_explicit=false even though the id is populated', async () => {
    const id = await insertPhoto({ storagePath: `spaces/${RUN}/fb.jpg`, space: spaceId })
    const [row] = await directSql`SELECT featured_photo_id FROM spaces WHERE id = ${spaceId}`
    expect(row.featured_photo_id).toBeNull()

    const res = await callHandler(handler, { method: 'GET', path: `/api/photos/space-hero/${spaceId}` })
    expect(res.body.featured_photo_id).toBe(id)   // effective hero — id and url still agree
    expect(res.body.featured_is_explicit).toBe(false)
  })

  it('designating that SAME photo flips it to true — the silent-revert scenario end to end', async () => {
    const first = await insertPhoto({ storagePath: `spaces/${RUN}/e1.jpg`, space: spaceId })
    const before = await callHandler(handler, { method: 'GET', path: '/api/photos/space-hero' })
    expect(before.body.featured_photo_id).toBe(first)
    expect(before.body.featured_is_explicit).toBe(false)   // <- the client MUST still PUT

    await callHandler(handler, {
      method: 'PUT', path: `/api/photos/space-featured/${spaceId}`, body: { photo_id: first },
    })
    const after = await callHandler(handler, { method: 'GET', path: '/api/photos/space-hero' })
    expect(after.body.featured_photo_id).toBe(first)
    expect(after.body.featured_is_explicit).toBe(true)

    // And it now SURVIVES a newer upload, which is what the no-op guard was silently costing.
    await new Promise((r) => setTimeout(r, 5))
    await insertPhoto({ storagePath: `spaces/${RUN}/e2.jpg`, space: spaceId })
    const later = await callHandler(handler, { method: 'GET', path: '/api/photos/space-hero' })
    expect(later.body.featured_photo_id).toBe(first)
    expect(later.body.featured_is_explicit).toBe(true)
  })

  it('a soft-deleted designation reads as a FALLBACK, so the client re-persists', async () => {
    const dead = await insertPhoto({ storagePath: `spaces/${RUN}/x1.jpg`, space: spaceId })
    await new Promise((r) => setTimeout(r, 5))
    const alive = await insertPhoto({ storagePath: `spaces/${RUN}/x2.jpg`, space: spaceId })
    await directSql`UPDATE spaces SET featured_photo_id = ${dead} WHERE id = ${spaceId}`
    await directSql`UPDATE photos SET deleted_at = now() WHERE id = ${dead}`

    const res = await callHandler(handler, { method: 'GET', path: `/api/photos/space-hero/${spaceId}` })
    expect(res.body.featured_photo_id).toBe(alive)
    // The column is non-NULL, but it points at a row the gallery no longer shows — from the
    // client's side that is a fallback, and it should be replaced rather than trusted.
    expect(res.body.featured_is_explicit).toBe(false)
  })

  it('no photos at all: null hero, false, and no crash on the presign', async () => {
    const res = await callHandler(handler, { method: 'GET', path: '/api/photos/space-hero' })
    expect(res.status).toBe(200)
    expect(res.body.space_id).toBe(spaceId)
    expect(res.body.featured_photo_id).toBeNull()
    expect(res.body.featured_is_explicit).toBe(false)
    expect(res.body.featured_photo_view_url).toBeNull()
  })
})

describe('AC-7 — the daily-plan spaces read still works after the ALTER', () => {
  it('runs the literal query from lambda/daily-plan/handler.js against the altered table', async () => {
    // Extracted from source rather than retyped: a future edit to that query is picked up here
    // instead of silently drifting away from what this test claims to cover.
    const src = readFileSync(new URL('../../lambda/daily-plan/handler.js', import.meta.url), 'utf8')
    const m = src.match(/`(select id, postal_code, weather_lat, weather_lng from spaces)`/)
    expect(m, 'daily-plan spaces query not found — update this test if it moved').toBeTruthy()

    const rows = await directSql(m[1])
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    for (const k of ['id', 'postal_code', 'weather_lat', 'weather_lng']) {
      expect(Object.prototype.hasOwnProperty.call(rows[0], k)).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PUT /api/photos/:id/space — the ATTACH route (added 2026-08-02, crucible boss ruling).
//
// This is the whole reason the route exists: before it, photos.space_id was write-once-at-INSERT, so
// the Space hero could only ever be a photo uploaded directly to /space — none of the 981 photos
// already in prod could become the property's cover image.
//
// These cases are DB-shaped on purpose. The sibling lambda/photos/space-photos.test.js proves which
// SQL text gets constructed; it runs against a recording fake and cannot see the 7-clause CHECK, the
// FKs, or a null-parameter typing failure. Everything below has to touch real Postgres to mean
// anything. Where a case exists to pin a guard, the mutation that must red it is named inline.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('V4-SPACEPHOTO-001 — PUT /api/photos/:id/space (attach)', () => {
  beforeEach(() => { process.env.SPACE_PHOTOS_ENABLED = 'true' })
  afterAll(() => { delete process.env.SPACE_PHOTOS_ENABLED })

  const put = (id, body) => callHandler(handler, {
    method: 'PUT', path: `/api/photos/${id}/space`, body, userId: USER,
  })

  it('attaches an existing photo to the space', async () => {
    const photoId = await insertPhoto({ storagePath: `attach/${RUN}-a.jpg`, location: locationId })
    const res = await put(photoId, { space_id: spaceId })
    expect(res.status).toBe(200)
    expect(res.body.space_id).toBe(spaceId)
    const [row] = await directSql`SELECT space_id FROM photos WHERE id = ${photoId}`
    expect(row.space_id).toBe(spaceId)
  })

  it('detaches on an explicit null when another parent survives', async () => {
    // Mutation: bind the null under a `::uuid` cast inside a CASE — neon cannot type it and this
    // reds with a 500 while every source-text assertion stays green.
    const photoId = await insertPhoto({ storagePath: `attach/${RUN}-b.jpg`, space: spaceId, location: locationId })
    const res = await put(photoId, { space_id: null })
    expect(res.status).toBe(200)
    expect(res.body.space_id).toBeNull()
  })

  it('refuses to detach the ONLY parent — 400, not an opaque 500', async () => {
    // photos_must_have_parent counts space_id, so clearing it here leaves the row parentless: a
    // 23514 that isUpstream() does not classify. Mutation: delete the hasOtherParent pre-check and
    // this returns 500 instead of 400.
    const photoId = await insertPhoto({ storagePath: `attach/${RUN}-c.jpg`, space: spaceId })
    const res = await put(photoId, { space_id: null })
    expect(res.status).toBe(400)
    const [row] = await directSql`SELECT space_id FROM photos WHERE id = ${photoId}`
    expect(row.space_id).toBe(spaceId)
  })

  it('requires the key — an omitted space_id is a 400, never a silent detach', async () => {
    // This is the property that justifies a dedicated route over widening the general re-tag PUT:
    // there, an omitted key means "cleared". Mutation: accept an absent key as null.
    const photoId = await insertPhoto({ storagePath: `attach/${RUN}-d.jpg`, space: spaceId, location: locationId })
    const res = await put(photoId, {})
    expect(res.status).toBe(400)
    const [row] = await directSql`SELECT space_id FROM photos WHERE id = ${photoId}`
    expect(row.space_id).toBe(spaceId)
  })

  it("rejects another household's space with the generic 400", async () => {
    // Mutation: drop the loadOwnedSpace call — this then writes a cross-household FK, which the
    // ?space_id gallery turns into a live cross-household READ.
    const photoId = await insertPhoto({ storagePath: `attach/${RUN}-e.jpg`, location: locationId })
    const res = await put(photoId, { space_id: foreignSpaceId })
    expect(res.status).toBe(400)
    const [row] = await directSql`SELECT space_id FROM photos WHERE id = ${photoId}`
    expect(row.space_id).toBeNull()
  })

  it('rejects an absent-but-well-formed space id identically — no existence oracle', async () => {
    const photoId = await insertPhoto({ storagePath: `attach/${RUN}-f.jpg`, location: locationId })
    const absent = await put(photoId, { space_id: ABSENT_SPACE })
    const foreign = await put(photoId, { space_id: foreignSpaceId })
    expect(absent.status).toBe(foreign.status)
    expect(absent.body).toEqual(foreign.body)
  })

  it("rejects another household's photo", async () => {
    // Mutation: drop `created_by = ANY(householdIds)` from the ownership SELECT.
    const photoId = await insertPhoto({ storagePath: `attach/${RUN}-g.jpg`, owner: FOREIGN_USER, location: locationId })
    const res = await put(photoId, { space_id: spaceId })
    expect(res.status).toBe(400)
    const [row] = await directSql`SELECT space_id FROM photos WHERE id = ${photoId}`
    expect(row.space_id).toBeNull()
  })

  it('rejects a soft-deleted photo', async () => {
    // Load-bearing: without deleted_at IS NULL a dead row could be attached and then designated
    // hero. Mutation: drop that conjunct from the ownership SELECT.
    const photoId = await insertPhoto({ storagePath: `attach/${RUN}-h.jpg`, location: locationId })
    await directSql`UPDATE photos SET deleted_at = now() WHERE id = ${photoId}`
    const res = await put(photoId, { space_id: spaceId })
    expect(res.status).toBe(400)
  })

  it('rejects a malformed photo id with 400, not a 22P02 500', async () => {
    const res = await put('not-a-uuid', { space_id: spaceId })
    expect(res.status).toBe(400)
  })

  it('does NOT auto-feature — attach and designate stay separate acts', async () => {
    // Attaching a batch to the property must not silently make the first one the hero. Mutation:
    // add an autoPromoteFeatured call to the attach route and this reds.
    await directSql`UPDATE spaces SET featured_photo_id = NULL WHERE id = ${spaceId}`
    const photoId = await insertPhoto({ storagePath: `attach/${RUN}-i.jpg`, location: locationId })
    await put(photoId, { space_id: spaceId })
    const [space] = await directSql`SELECT featured_photo_id FROM spaces WHERE id = ${spaceId}`
    expect(space.featured_photo_id).toBeNull()
  })

  // REVERSED 2026-08-02 by V4-SPACECLIENTGAP-001. This test used to assert
  // `intake_status` stayed 'pending_tag' after an attach. That was DESCRIPTIVE of the code as
  // built, not a designed invariant: unlike every sibling in this block it carried no rationale
  // and no mutation note, and the route's own header justifies only the OTHER half of its
  // "does not touch intake_status and does not auto-feature" sentence (the auto-feature half —
  // "attach and designate are separate acts" — which still holds and is still pinned above).
  //
  // Keeping it would have preserved a real defect: a photo whose only tag is the Space would sit
  // in intake_status='pending_tag' forever, so idx_photos_intake_pending keeps matching and the
  // quick-tag carousel re-serves a photo the user already filed. It was cold only because prod
  // carried zero pending_tag rows; the client flip is what makes the path reachable.
  //
  // The drain behaviour and its three guards are covered in the V4-SPACECLIENTGAP-001 block
  // below. What remains HERE is the narrower survivor: attach must not disturb a row that was
  // never in the inbox to begin with.
  it('leaves an already-filed row alone — attach only drains, it never writes a status', async () => {
    // Mutation: make the CASE arm write anything other than NULL, or drop the ELSE, and this reds.
    const photoId = await insertPhoto({ storagePath: `attach/${RUN}-j.jpg`, location: locationId })
    const [before] = await directSql`SELECT intake_status FROM photos WHERE id = ${photoId}`
    expect(before.intake_status).toBeNull()
    await put(photoId, { space_id: spaceId })
    const [row] = await directSql`SELECT intake_status FROM photos WHERE id = ${photoId}`
    expect(row.intake_status).toBeNull()
  })

  it('is inert with the gate closed', async () => {
    delete process.env.SPACE_PHOTOS_ENABLED
    const photoId = await insertPhoto({ storagePath: `attach/${RUN}-k.jpg`, location: locationId })
    const res = await put(photoId, { space_id: spaceId })
    expect(res.status).toBe(405)
    const [row] = await directSql`SELECT space_id FROM photos WHERE id = ${photoId}`
    expect(row.space_id).toBeNull()
  })
})

describe('V4-SPACEPHOTO-001 — a de-membered hero falls back instead of rendering stale', () => {
  beforeEach(() => { process.env.SPACE_PHOTOS_ENABLED = 'true' })
  afterAll(() => { delete process.env.SPACE_PHOTOS_ENABLED })

  it('drops an explicit hero that no longer carries this space_id', async () => {
    // The cell the attach route ARMS. Before it existed nothing could clear space_id, so a
    // designated hero was a gallery member by construction and fetchSpaceHero did not re-check.
    // Now it can be cleared out from under the designation — leaving featured_photo_id pointing at
    // a photo the ?space_id gallery will never return, i.e. a hero the user can see but cannot
    // re-pick or clear from the page it appears on.
    // Mutation: remove `AND fp.space_id = s.id` from fetchSpaceHero's explicit-hero join — the
    // de-membered photo is then returned with featured_is_explicit true and this reds.
    const heroId = await insertPhoto({ storagePath: `demember/${RUN}-hero.jpg`, space: spaceId, location: locationId })
    const memberId = await insertPhoto({ storagePath: `demember/${RUN}-member.jpg`, space: spaceId })
    await directSql`UPDATE spaces SET featured_photo_id = ${heroId} WHERE id = ${spaceId}`

    const before = await callHandler(handler, { method: 'GET', path: `/api/photos/space-hero/${spaceId}`, userId: USER })
    expect(before.status).toBe(200)
    expect(before.body.featured_photo_id).toBe(heroId)
    expect(before.body.featured_is_explicit).toBe(true)

    await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${heroId}/space`, body: { space_id: null }, userId: USER,
    })

    const after = await callHandler(handler, { method: 'GET', path: `/api/photos/space-hero/${spaceId}`, userId: USER })
    expect(after.status).toBe(200)
    expect(after.body.featured_photo_id).toBe(memberId)
    expect(after.body.featured_is_explicit).toBe(false)
  })
})

// V4-SPACECLIENTGAP-001 — the quick-tag inbox must drain for space-parented photos.
//
// Why these are integration and not source-text assertions: both paths turn on the row's PRIOR
// intake_status, which only exists in the database. A static check can prove the CASE expression is
// constructed; only a real round trip proves the row actually left 'pending_tag' — and, in the
// negative cases, that it correctly did NOT.
describe('V4-SPACECLIENTGAP-001 — attaching a space drains the quick-tag inbox', () => {
  beforeEach(() => { process.env.SPACE_PHOTOS_ENABLED = 'true' })
  afterAll(() => { delete process.env.SPACE_PHOTOS_ENABLED })

  const attach = (id, body) => callHandler(handler, {
    method: 'PUT', path: `/api/photos/${id}/space`, body, userId: USER,
  })
  const status = async (id) => (await directSql`SELECT intake_status FROM photos WHERE id = ${id}`)[0].intake_status

  it("clears pending_tag when the space becomes the photo's parent", async () => {
    // The whole point: idx_photos_intake_pending keeps matching a pending row, so the quick-tag
    // carousel re-serves a photo the user already filed onto the property. The inbox never drains.
    // Mutation: drop `drainsInbox` from the UPDATE and this row stays 'pending_tag'.
    const photoId = await insertPhoto({ storagePath: `drain/${RUN}-a.jpg`, location: locationId, intake: 'pending_tag' })
    const res = await attach(photoId, { space_id: spaceId })
    expect(res.status).toBe(200)
    expect(res.body.intake_status).toBeNull()
    expect(await status(photoId)).toBeNull()
  })

  it('leaves a DETACH pending — un-tagging is not filing', async () => {
    // Mirrors the general PUT's rule: a pending row that is un-tagged must STAY pending. Clearing
    // here would mark a photo filed that nobody filed. Mutation: drop the `nextSpaceId !== null`
    // conjunct and this reds.
    const photoId = await insertPhoto({ storagePath: `drain/${RUN}-b.jpg`, space: spaceId, location: locationId, intake: 'pending_tag' })
    const res = await attach(photoId, { space_id: null })
    expect(res.status).toBe(200)
    expect(await status(photoId)).toBe('pending_tag')
  })

  it("does NOT touch 'upload_failed' — attaching a space is not a successful upload", async () => {
    // A different state with its own recovery path. Mutation: widen the guard to any non-null
    // intake_status and this reds.
    const photoId = await insertPhoto({ storagePath: `drain/${RUN}-c.jpg`, location: locationId, intake: 'upload_failed' })
    const res = await attach(photoId, { space_id: spaceId })
    expect(res.status).toBe(200)
    expect(await status(photoId)).toBe('upload_failed')
  })

  it('drains via the general re-tag PUT when the SPACE is the surviving parent', async () => {
    // The general PUT has full-replace semantics, so this all-null save is an "un-tag" of the
    // project/location/plant fields — but space_id is not among the fields it SETs, so the row is
    // still properly parented and must drain. Without the gated pre-read, `setsParent` reads false
    // here and a space-attached photo re-tagged through the modal falls back into the carousel
    // forever. Mutation: remove the `spaceParented` term from setsParent and this reds.
    const photoId = await insertPhoto({ storagePath: `drain/${RUN}-d.jpg`, space: spaceId, intake: 'pending_tag' })
    const res = await callHandler(handler, {
      method: 'PUT',
      path: `/api/photos/${photoId}`,
      body: { project_id: null, location_id: null, plant_id: null, caption: 'the whole place' },
      userId: USER,
    })
    expect(res.status).toBe(200)
    expect(await status(photoId)).toBeNull()
    // And the attachment itself is untouched — the general PUT never SETs space_id, which is the
    // property that let the attach path be a separate sub-resource in the first place.
    const [row] = await directSql`SELECT space_id FROM photos WHERE id = ${photoId}`
    expect(row.space_id).toBe(spaceId)
  })

  it('still leaves a genuinely parentless un-tag pending, with the gate open', async () => {
    // The guard the general PUT's own comment block calls CRITICAL: blindly nulling intake_status
    // on a row with no surviving parent makes it parentless AND non-pending, which
    // photos_must_have_parent rejects — a 500 on a legitimate un-tag. The space pre-read must not
    // weaken that. Mutation: make spaceParented unconditionally true and this reds.
    const photoId = await insertPhoto({ storagePath: `drain/${RUN}-e.jpg`, location: locationId, intake: 'pending_tag' })
    const res = await callHandler(handler, {
      method: 'PUT',
      path: `/api/photos/${photoId}`,
      body: { project_id: null, location_id: null, plant_id: null, caption: null },
      userId: USER,
    })
    expect(res.status).toBe(200)
    expect(await status(photoId)).toBe('pending_tag')
  })
})

describe('V4-SPACEPHOTO-001 — the default photo list carries space_id when the gate is open', () => {
  afterAll(() => { delete process.env.SPACE_PHOTOS_ENABLED })

  it('returns space_id on the unfiltered list so the client can tell space-attached from untagged', async () => {
    // PhotoLibrary's "untagged" filter reads p.space_id. Only the ?space_id branch ever selected the
    // column, so the field was undefined on every row that page saw and its space conjunct could
    // never fire — every space photo would have rendered as unfinished work.
    // Mutation: remove the list-decoration block and this reds.
    process.env.SPACE_PHOTOS_ENABLED = 'true'
    const photoId = await insertPhoto({ storagePath: `listdec/${RUN}-a.jpg`, space: spaceId })
    const res = await callHandler(handler, { method: 'GET', path: '/api/photos', userId: USER })
    expect(res.status).toBe(200)
    const row = res.body.find((p) => p.id === photoId)
    expect(row, 'the space photo should appear in the unfiltered list').toBeTruthy()
    expect(row.space_id).toBe(spaceId)
  })

  it('omits space_id entirely with the gate closed — flag-off byte-identity', async () => {
    // Pairs with the assertion elsewhere in this file that the flag-off list has no space_id
    // property. This is what lets the four list SELECTs stay untouched.
    delete process.env.SPACE_PHOTOS_ENABLED
    await insertPhoto({ storagePath: `listdec/${RUN}-b.jpg`, location: locationId })
    const res = await callHandler(handler, { method: 'GET', path: '/api/photos', userId: USER })
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(0)
    for (const p of res.body) expect(p).not.toHaveProperty('space_id')
  })
})
