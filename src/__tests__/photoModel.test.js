// V4-PHOTOMODEL-001 — canonical photo object.
//
// Fixtures are shaped from the LIVE prod distribution measured 2026-08-07 (1094 live rows), not
// from what the surfaces assume. No real presigned URL appears here: presigns are transferable
// bearer credentials and must never enter a committed file.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  toPhoto, toPhotos, isPhoto, pickSource, sourceChain,
  presignAgeMs, isPresignStale,
  PARENT_KINDS, PARENT_FIELDS, PARENTAGE, TIER, PRESIGN_TTL_MS,
} from '../lib/photoModel.js'

const URL_FULL = 'https://s3.example.invalid/plants/P/a.jpg?sig=full'
const URL_THUMB = 'https://s3.example.invalid/thumbs/plants/P/a.jpg?sig=thumb'

// The modal 88.8% case: project + plant, both set.
const rowMulti = {
  id: 'p1', storage_path: 'plants/P/a.jpg', created_at: '2026-07-01T00:00:00Z',
  project_id: 'proj1', plant_id: 'plant1',
  view_url: URL_FULL, thumb_url: URL_THUMB,
}

describe('parent model — SIX FKs, matching the live photos_must_have_parent CHECK', () => {
  it('enumerates all six parent kinds the CHECK counts', () => {
    expect(PARENT_KINDS).toEqual(['event', 'project', 'location', 'plant', 'inventory', 'space'])
    expect(PARENT_FIELDS.inventory).toBe('inventory_item_id')
  })

  it('an inventory-only photo is ATTACHED — the BUG-PHOTOPARENT-001 six were never orphans', () => {
    // Measured: exactly 6 live rows have inventory_item_id and nothing else. The four-way model
    // reported them as "all refs NULL"; they are fully parented.
    const p = toPhoto({ id: 'i1', storage_path: 'inventory/I/a.jpg', inventory_item_id: 'inv1', view_url: URL_FULL })
    expect(p.isAttached).toBe(true)
    expect(p.isOrphan).toBe(false)
    expect(p.parentKinds).toEqual(['inventory'])
    expect(p.parentage).toBe(PARENTAGE.SINGLE)
  })

  it('multi-parent is a first-class state, not an error (88.8% of live rows)', () => {
    const p = toPhoto(rowMulti)
    expect(p.parentCount).toBe(2)
    expect(p.parentage).toBe(PARENTAGE.MULTI)
    expect(p.parentKinds).toEqual(['project', 'plant'])
    expect(p.isAttached).toBe(true)
  })

  it('distinguishes the INVALID orphan state from a legitimate pending_tag intake row', () => {
    const orphan = toPhoto({ id: 'o1', storage_path: 's/o.jpg', view_url: URL_FULL })
    expect(orphan.parentage).toBe(PARENTAGE.ORPHAN)
    expect(orphan.isOrphan).toBe(true)

    const pending = toPhoto({ id: 'o2', storage_path: 's/o.jpg', intake_status: 'pending_tag', view_url: URL_FULL })
    expect(pending.parentage).toBe(PARENTAGE.PENDING)
    expect(pending.isOrphan).toBe(false)   // the CHECK's 7th arm permits this
    expect(pending.isAttached).toBe(false)
  })

  it('counts a three-parent row (9 live rows) as multi', () => {
    const p = toPhoto({ id: 'm3', storage_path: 's/a.jpg', project_id: 'a', location_id: 'b', plant_id: 'c', view_url: URL_FULL })
    expect(p.parentCount).toBe(3)
    expect(p.parentage).toBe(PARENTAGE.MULTI)
  })
})

describe('sources — thumb truthiness carries ZERO information (BUG-PHOTONEWTHUMB-001)', () => {
  it('marks the thumb as NOT guaranteed and the original as guaranteed', () => {
    const p = toPhoto(rowMulti)
    expect(p.sources.thumb.guaranteed).toBe(false)
    expect(p.sources.full.guaranteed).toBe(true)
  })

  it('a thumb request degrades to the in-hand original — no second network source needed', () => {
    const p = toPhoto(rowMulti)
    expect(sourceChain(p, TIER.THUMB).map(s => s.url)).toEqual([URL_THUMB, URL_FULL])
    expect(pickSource(p, TIER.THUMB).url).toBe(URL_THUMB)
  })

  it('a FULL request never degrades to a thumb (a hero must not silently show a 200px image)', () => {
    const p = toPhoto(rowMulti)
    expect(sourceChain(p, TIER.FULL).map(s => s.url)).toEqual([URL_FULL])
  })

  it('adapts featured_photo_view_url as a FULL source, never a thumb', () => {
    const p = toPhoto({ id: 'f1', storage_path: 'plants/P/a.jpg', plant_id: 'x', featured_photo_view_url: URL_FULL })
    expect(p.sources.full.url).toBe(URL_FULL)
    expect(p.sources.thumb).toBeUndefined()
    expect(sourceChain(p, TIER.THUMB).map(s => s.url)).toEqual([URL_FULL])
  })

  it('a row with no renderable URL yields an empty chain rather than an undefined src', () => {
    const p = toPhoto({ id: 'n1', storage_path: 's/a.jpg', plant_id: 'x' })
    expect(sourceChain(p, TIER.THUMB)).toEqual([])
    expect(pickSource(p, TIER.FULL)).toBeNull()
  })
})

describe('presigned-URL expiry is an explicit property, not an assumption', () => {
  it('ages from receipt and goes stale exactly at the 900s TTL', () => {
    const t0 = 1_000_000
    const p = toPhoto(rowMulti, { receivedAt: t0 })
    expect(presignAgeMs(p, t0 + 1000)).toBe(1000)
    expect(isPresignStale(p, t0 + PRESIGN_TTL_MS - 1)).toBe(false)
    expect(isPresignStale(p, t0 + PRESIGN_TTL_MS)).toBe(true)
  })

  it('the model TTL matches PhotoImg’s — the two must never split', () => {
    // photoModel deliberately does not import the component (it would drag React into a pure-data
    // module), so the constant is duplicated. This assertion is what makes that safe.
    const src = readFileSync(join(process.cwd(), 'src/components/PhotoImg.jsx'), 'utf8')
    const m = /export const PRESIGN_TTL_MS\s*=\s*([^\n/]+)/.exec(src)
    expect(m, 'PhotoImg must still export PRESIGN_TTL_MS').toBeTruthy()
    // eslint-disable-next-line no-eval
    expect(eval(m[1].trim())).toBe(PRESIGN_TTL_MS)
  })

  it('a whole list page shares one receipt time so it expires together', () => {
    const ps = toPhotos([rowMulti, { ...rowMulti, id: 'p2' }], { receivedAt: 42 })
    expect(ps.map(p => p.urlMintedAt)).toEqual([42, 42])
  })
})

describe('adapter', () => {
  it('is idempotent — re-adapting a canonical photo returns it unchanged', () => {
    const once = toPhoto(rowMulti)
    expect(toPhoto(once)).toBe(once)
    expect(isPhoto(once)).toBe(true)
    expect(isPhoto(rowMulti)).toBe(false)
  })

  it('falls back to a non-empty alt (1092 of 1094 live rows have no caption)', () => {
    expect(toPhoto(rowMulti).alt).toBe('Garden photo')
    expect(toPhoto({ ...rowMulti, caption: 'First tomato' }).alt).toBe('First tomato')
  })

  it('surfaces taken_at but never substitutes it for created_at (taken_at is 100% NULL live)', () => {
    const p = toPhoto(rowMulti)
    expect(p.takenAt).toBeNull()
    expect(p.createdAt).toBe('2026-07-01T00:00:00Z')
  })

  it('tolerates null/garbage input instead of throwing into a render', () => {
    expect(toPhoto(null)).toBeNull()
    expect(toPhotos(null)).toEqual([])
    expect(toPhotos(undefined)).toEqual([])
  })
})
