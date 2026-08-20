// V4-HARVPOSTPHOTOS-001 — the photo half of the harvest post composer.
//
// Every test here is named for the thing that must not happen: a photo silently dropped, a caption
// lost to make room for one, a batch that downloads 60MB onto a phone, or a single failed fetch that
// takes the whole post down with it.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import exifr from 'exifr/dist/full.esm.mjs'
import {
  collectBatchPhotos, fetchPostPhotos, MAX_POST_PHOTOS, MAX_POST_PHOTO_BYTES,
} from '../lib/harvestPostPhotos.js'

const entry = (eventId, photoIds) => ({
  event_id: eventId,
  photos: photoIds.map((id) => ({ id, caption: null, taken_at: null })),
})

// A REAL JPEG of exactly `bytes` bytes. It has to be a real one now that fetchPostPhotos runs the
// V4-PHOTOEXIFSTRIP-001 strip over what it fetches — filler bytes are not a container the strip
// recognizes, which would leave every assertion here running against a path production never takes.
// The padding lives INSIDE the entropy-coded scan (and is never 0xFF, which would read as a marker),
// so the strip is a byte-for-byte no-op on it and the byte-budget arithmetic below stays exact.
const jpegOf = (size) => {
  if (size <= 0) return new Uint8Array(0)
  const head = [0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x03, 0x01]   // SOI + a minimal SOS header
  const scan = Math.max(0, size - head.length - 2)
  return new Uint8Array([...head, ...new Array(scan).fill(0x5A), 0xFF, 0xD9])
}
const blob = (bytes, type = 'image/jpeg') => new Blob([jpegOf(bytes)], { type })

// mint resolves a URL per id; fetchBlob resolves a blob per URL. Both injected, so nothing here
// touches the network or React.
const rig = ({ sizes = {}, mintFail = [], fetchFail = [], type = 'image/jpeg' } = {}) => {
  const mintCalls = []
  const fetchCalls = []
  const mint = vi.fn(async (id) => {
    mintCalls.push(id)
    if (mintFail.includes(id)) throw new Error('mint 500')
    return `https://s3.example/${id}?X-Amz-Signature=abc`
  })
  const fetchBlob = vi.fn(async (url) => {
    const id = url.split('/')[3].split('?')[0]
    fetchCalls.push(id)
    if (fetchFail.includes(id)) { const e = new Error('403'); e.status = 403; throw e }
    return blob(sizes[id] ?? 1024, type)
  })
  return { mint, fetchBlob, mintCalls, fetchCalls }
}

describe('collectBatchPhotos', () => {
  it('collects every photo on the batch in logging order, tagged with its event', () => {
    const r = collectBatchPhotos([entry('e1', ['p1', 'p2']), entry('e2', []), entry('e3', ['p3'])])
    expect(r.photos).toEqual([
      { photoId: 'p1', eventId: 'e1' },
      { photoId: 'p2', eventId: 'e1' },
      { photoId: 'p3', eventId: 'e3' },
    ])
    expect(r.total).toBe(3)
    expect(r.dropped).toBe(0)
  })

  it('returns nothing for a batch with no photos, so a photoless evening costs zero requests', () => {
    expect(collectBatchPhotos([entry('e1', []), { event_id: 'e2' }]).photos).toEqual([])
    expect(collectBatchPhotos(null).photos).toEqual([])
  })

  it('caps at MAX_POST_PHOTOS and REPORTS what it left out rather than dropping it silently', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `p${i}`)
    const r = collectBatchPhotos([entry('e1', ids)])
    expect(r.photos).toHaveLength(MAX_POST_PHOTOS)
    expect(r.total).toBe(30)
    expect(r.dropped).toBe(30 - MAX_POST_PHOTOS)
  })

  it('dedupes a photo that appears under two entries', () => {
    const r = collectBatchPhotos([entry('e1', ['p1']), entry('e2', ['p1', 'p2'])])
    expect(r.photos.map((p) => p.photoId)).toEqual(['p1', 'p2'])
  })
})

describe('fetchPostPhotos — assembling Files', () => {
  it('mints then fetches each photo and wraps the bytes as a File', async () => {
    const { mint, fetchBlob, mintCalls, fetchCalls } = rig({ sizes: { p1: 2048, p2: 4096 } })
    const r = await fetchPostPhotos(
      [{ photoId: 'p1', eventId: 'e1' }, { photoId: 'p2', eventId: 'e2' }],
      { mint, fetchBlob },
    )
    expect(mintCalls).toEqual(['p1', 'p2'])
    expect(fetchCalls).toEqual(['p1', 'p2'])
    expect(r.items).toHaveLength(2)
    expect(r.items[0].file).toBeInstanceOf(File)
    expect(r.items[0].file.size).toBe(2048)
    expect(r.items[0].file.type).toBe('image/jpeg')
    expect(r.items[0].eventId).toBe('e1')
    expect(r.bytes).toBe(2048 + 4096)
    expect(r.failed).toBe(0)
  })

  it('gives the File a neutral name — never a caption, a variety or a UUID', async () => {
    const { mint, fetchBlob } = rig()
    const r = await fetchPostPhotos([{ photoId: 'ba0c-uuid', eventId: 'e1' }], { mint, fetchBlob })
    expect(r.items[0].file.name).toBe('harvest-photo-1.jpg')
    expect(r.items[0].file.name).not.toContain('ba0c')
  })

  it('names a png a png, so the receiving app does not get a lying extension', async () => {
    const { mint, fetchBlob } = rig({ type: 'image/png' })
    const r = await fetchPostPhotos([{ photoId: 'p1', eventId: 'e1' }], { mint, fetchBlob })
    expect(r.items[0].file.name).toBe('harvest-photo-1.png')
    expect(r.items[0].file.type).toBe('image/png')
  })
})

describe('fetchPostPhotos — failure is partial, never total', () => {
  it('shares the four that loaded when one of five fails, and counts the one that did not', async () => {
    const refs = ['p1', 'p2', 'p3', 'p4', 'p5'].map((photoId) => ({ photoId, eventId: `e-${photoId}` }))
    const { mint, fetchBlob } = rig({ fetchFail: ['p3'] })
    const r = await fetchPostPhotos(refs, { mint, fetchBlob })
    expect(r.items.map((i) => i.photoId)).toEqual(['p1', 'p2', 'p4', 'p5'])
    expect(r.failed).toBe(1)
    expect(r.skipped).toBe(0)
  })

  it('retries the mint+fetch pair ONCE before giving up on a photo', async () => {
    let calls = 0
    const mint = vi.fn(async () => 'https://s3.example/p1?sig')
    const fetchBlob = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('transient')
      return blob(512)
    })
    const r = await fetchPostPhotos([{ photoId: 'p1', eventId: 'e1' }], { mint, fetchBlob })
    expect(calls).toBe(2)
    expect(r.items).toHaveLength(1)
    expect(r.failed).toBe(0)
  })

  it('counts a photo failed after the second attempt, and does not attempt a third', async () => {
    const { mint, fetchBlob } = rig({ fetchFail: ['p1'] })
    const r = await fetchPostPhotos([{ photoId: 'p1', eventId: 'e1' }], { mint, fetchBlob })
    expect(fetchBlob).toHaveBeenCalledTimes(2)
    expect(r.items).toEqual([])
    expect(r.failed).toBe(1)
  })

  it('survives a mint that throws (view-url 500 / expired presign) the same way', async () => {
    const { mint, fetchBlob } = rig({ mintFail: ['p1'] })
    const r = await fetchPostPhotos(
      [{ photoId: 'p1', eventId: 'e1' }, { photoId: 'p2', eventId: 'e2' }],
      { mint, fetchBlob },
    )
    expect(r.failed).toBe(1)
    expect(r.items.map((i) => i.photoId)).toEqual(['p2'])
  })

  it('treats an empty body as a failure rather than attaching a 0-byte image', async () => {
    const mint = vi.fn(async () => 'https://s3.example/p1?sig')
    const fetchBlob = vi.fn(async () => blob(0))
    const r = await fetchPostPhotos([{ photoId: 'p1', eventId: 'e1' }], { mint, fetchBlob })
    expect(r.items).toEqual([])
    expect(r.failed).toBe(1)
  })
})

describe('fetchPostPhotos — the byte budget', () => {
  it('stops once the budget is spent and reports the rest as skipped, not failed', async () => {
    const refs = ['p1', 'p2', 'p3', 'p4'].map((photoId) => ({ photoId, eventId: `e-${photoId}` }))
    const { mint, fetchBlob, fetchCalls } = rig({ sizes: { p1: 600, p2: 600, p3: 600, p4: 600 } })
    const r = await fetchPostPhotos(refs, { mint, fetchBlob, byteLimit: 1500 })
    expect(r.items.map((i) => i.photoId)).toEqual(['p1', 'p2'])
    expect(r.bytes).toBe(1200)
    expect(r.skipped).toBe(2)
    expect(r.failed).toBe(0)
    // Overshoot is bounded to ONE file: p3 is fetched and rejected, p4 is never requested.
    expect(fetchCalls).toEqual(['p1', 'p2', 'p3'])
  })

  it('defaults to a budget that a normal evening never reaches', async () => {
    const refs = Array.from({ length: 10 }, (_, i) => ({ photoId: `p${i}`, eventId: `e${i}` }))
    // 830KB is the largest live photo carrying a recorded size (prod, 2026-08-20).
    const sizes = Object.fromEntries(refs.map((r) => [r.photoId, 830 * 1024]))
    const { mint, fetchBlob } = rig({ sizes })
    const r = await fetchPostPhotos(refs, { mint, fetchBlob })
    expect(r.items).toHaveLength(10)
    expect(r.skipped).toBe(0)
    expect(r.bytes).toBeLessThan(MAX_POST_PHOTO_BYTES)
  })

  it('bounds a batch of pre-downscale originals instead of holding 60MB of blobs', async () => {
    const refs = Array.from({ length: 10 }, (_, i) => ({ photoId: `p${i}`, eventId: `e${i}` }))
    const sizes = Object.fromEntries(refs.map((r) => [r.photoId, 6 * 1024 * 1024]))
    const { mint, fetchBlob } = rig({ sizes })
    const r = await fetchPostPhotos(refs, { mint, fetchBlob })
    expect(r.bytes).toBeLessThanOrEqual(MAX_POST_PHOTO_BYTES)
    expect(r.items.length).toBeLessThan(10)
    expect(r.skipped).toBeGreaterThan(0)
  })
})

describe('fetchPostPhotos — abort and progress', () => {
  it('stops on an aborted signal and reports the remainder as skipped', async () => {
    const ac = new AbortController()
    const refs = ['p1', 'p2', 'p3'].map((photoId) => ({ photoId, eventId: `e-${photoId}` }))
    const mint = vi.fn(async (id) => `https://s3.example/${id}?sig`)
    const fetchBlob = vi.fn(async () => { ac.abort(); return blob(100) })
    const r = await fetchPostPhotos(refs, { mint, fetchBlob, signal: ac.signal })
    expect(r.items).toHaveLength(1)
    expect(r.skipped).toBe(2)
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('reports progress as it goes, so the composer can say what it is doing', async () => {
    const seen = []
    const refs = ['p1', 'p2'].map((photoId) => ({ photoId, eventId: `e-${photoId}` }))
    const { mint, fetchBlob } = rig()
    await fetchPostPhotos(refs, { mint, fetchBlob, onProgress: (p) => seen.push(p) })
    expect(seen).toEqual([
      { done: 1, failed: 0, total: 2 },
      { done: 2, failed: 0, total: 2 },
    ])
  })
})

// V4-PHOTOEXIFSTRIP-001 LAYER 2 — the layer that protects photos ALREADY in S3.
//
// 913 photos were backfilled before any downscale or strip existed, so they are camera originals
// with GPS at Dave's house sitting in the bucket right now. Nothing done on the upload path reaches
// them. This is what stops those exact bytes going to the Android share sheet, and therefore to
// Facebook, SMS, Drive or wherever else the sheet points — without rewriting a single stored object.
//
// Fixture is synthetic-gps.jpg (GPS at Greenwich; garden-app is a PUBLIC repo, so Dave's real
// coordinates are never committed). exifr reads the File that would have been handed to
// navigator.share — the assertion is on the outgoing bytes, not on a spy.
describe('fetchPostPhotos — a shared photo never carries the garden home address', () => {
  const GPS_BYTES = new Uint8Array(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'synthetic-gps.jpg')),
  )
  const parse = (b) => exifr.parse(b instanceof Uint8Array ? b : new Uint8Array(b), {
    tiff: true, exif: true, gps: true, ifd0: true, translateValues: false,
  })
  const readBytes = (b) => new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(new Uint8Array(fr.result))
    fr.onerror = () => reject(fr.error)
    fr.readAsArrayBuffer(b)
  })
  // A backfilled original: full camera EXIF, and a Samsung-style trailer past the EOI carrying the
  // SIM country code and the on-device capture path — neither of which is EXIF at all.
  const backfilled = () => new Blob([
    GPS_BYTES,
    new TextEncoder().encode('Image_UTC_Data1676097711091MCC_Data311PhotoEditor_Re_Edit_Data'
      + '{"originalPath":"/storage/emulated/0/DCIM/Camera/20230211_014150.jpg"}'),
  ], { type: 'image/jpeg' })

  const gpsRig = () => ({
    mint: vi.fn(async (id) => `https://s3.example/${id}?sig`),
    fetchBlob: vi.fn(async () => backfilled()),
  })

  it('the fixture really carries a fix before we touch it', async () => {
    expect((await parse(GPS_BYTES)).latitude).toBeCloseTo(51.4778, 3)
  })

  it('STRIPS THE GPS out of a backfilled original on its way to the share sheet', async () => {
    const { mint, fetchBlob } = gpsRig()
    const r = await fetchPostPhotos([{ photoId: 'p1', eventId: 'e1' }], { mint, fetchBlob })
    expect(r.items).toHaveLength(1)

    const sent = await readBytes(r.items[0].file)
    const after = await parse(sent)
    expect(after?.latitude).toBeUndefined()
    expect(after?.Make).toBeUndefined()
    expect(after?.DateTimeOriginal).toBeUndefined()
  })

  it('removes the trailer metadata that is not EXIF and that dropping APP1 would miss', async () => {
    const { mint, fetchBlob } = gpsRig()
    const r = await fetchPostPhotos([{ photoId: 'p1', eventId: 'e1' }], { mint, fetchBlob })
    const text = Buffer.from(await readBytes(r.items[0].file)).toString('latin1')
    expect(text).not.toContain('MCC_Data')
    expect(text).not.toContain('originalPath')
    expect(text).not.toContain('DCIM')
  })

  it('still hands back a decodable JPEG under the neutral filename', async () => {
    const { mint, fetchBlob } = gpsRig()
    const r = await fetchPostPhotos([{ photoId: 'p1', eventId: 'e1' }], { mint, fetchBlob })
    const sent = await readBytes(r.items[0].file)
    expect([sent[0], sent[1]]).toEqual([0xFF, 0xD8])
    expect([sent[sent.length - 2], sent[sent.length - 1]]).toEqual([0xFF, 0xD9])
    expect(r.items[0].file.name).toBe('harvest-photo-1.jpg')
    expect(r.items[0].file.type).toBe('image/jpeg')
  })

  it('counts a photo it cannot strip as FAILED rather than sharing it unstripped', async () => {
    const mint = vi.fn(async (id) => `https://s3.example/${id}?sig`)
    // A blob whose bytes cannot be read: the strip throws, loadOne retries once, then gives up.
    const unreadable = {
      size: 100,
      type: 'image/jpeg',
      arrayBuffer: () => Promise.reject(new Error('NotReadableError')),
    }
    const fetchBlob = vi.fn(async () => unreadable)
    const r = await fetchPostPhotos([{ photoId: 'p1', eventId: 'e1' }], { mint, fetchBlob })
    expect(r.items).toHaveLength(0)
    expect(r.failed).toBe(1)
    expect(fetchBlob).toHaveBeenCalledTimes(2)   // one retry, then counted failed
  })
})
