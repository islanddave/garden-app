// fileSnapshot.test.js — BUG-PHOTOSTAGEDREAD-001.
//
// THIS FILE EXISTS BECAUSE THE COMPONENT TESTS CANNOT COVER THE FIX. The bug is an Android picker
// handle being reclaimed between pick and read; jsdom has no notion of that, and its Blob has no
// `arrayBuffer` at all, so in every component test the module takes its documented no-copy branch.
// A green PhotoLibrary/EventNew/PhotoUpload suite is therefore evidence that staging still works —
// NOT evidence that anything was copied. That claim is pinned here, against stub blobs that DO have
// arrayBuffer, which is what every engine the bug can occur on has.
//
// What is still not proven anywhere, and cannot be from a test runner: that a copied blob actually
// survives Android reclaiming the original handle. That rests on Chrome owning blob storage, and on
// Dave's device smoke.

import { describe, it, expect, vi } from 'vitest'
import { snapshotFile, snapshotFiles } from '../lib/fileSnapshot.js'

// A stand-in for a real browser's File: has arrayBuffer, so the copy branch runs. Deliberately NOT
// a jsdom File — using one would silently take the no-copy branch and assert nothing.
function fakeFile(name, bytes = [1, 2, 3], opts = {}) {
  const buf = new Uint8Array(bytes).buffer
  return {
    name,
    type: opts.type ?? 'image/jpeg',
    lastModified: opts.lastModified ?? 1_700_000_000_000,
    size: bytes.length,
    arrayBuffer: opts.arrayBuffer ?? (() => Promise.resolve(buf)),
  }
}

function readBack(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(new Uint8Array(fr.result))
    fr.onerror = () => reject(fr.error)
    fr.readAsArrayBuffer(blob)
  })
}

// The exact DOMException Chrome raises for a reclaimed handle — the string from Dave's screenshot.
const RECLAIMED = () => Promise.reject(new Error(
  'The requested file could not be read, typically due to permission problems that have occurred ' +
  'after a reference to a file was acquired.'
))

describe('snapshotFile — the copy', () => {
  it('returns a DIFFERENT object carrying the same bytes', async () => {
    const src = fakeFile('a.jpg', [7, 8, 9])
    const out = await snapshotFile(src)
    expect(out).not.toBe(src)                       // a passthrough would defeat the whole fix
    // Read back through FileReader, not arrayBuffer: the output is a real (jsdom) File and jsdom's
    // Blob has no arrayBuffer — the same absence the module's no-copy branch exists for.
    expect(Array.from(await readBack(out))).toEqual([7, 8, 9])
  })

  it('reads the source EXACTLY ONCE — the copy is what detaches it', async () => {
    // Re-reading later is the thing that fails on a reclaimed handle. If the module read lazily
    // instead of eagerly it would look identical here and still be broken in the field.
    const arrayBuffer = vi.fn(() => Promise.resolve(new Uint8Array([1]).buffer))
    await snapshotFile(fakeFile('a.jpg', [1], { arrayBuffer }))
    expect(arrayBuffer).toHaveBeenCalledTimes(1)
  })

  it('preserves name, type and lastModified', async () => {
    // Not cosmetic: extFromFile/mimeFromFile derive the S3 key extension and Content-Type from
    // these, and the photos row stores original_filename. A snapshot that dropped them would
    // silently change what gets stored.
    const src = fakeFile('Bhut Jolokia.HEIC', [1], { type: 'image/heic', lastModified: 1234 })
    const out = await snapshotFile(src)
    expect(out.name).toBe('Bhut Jolokia.HEIC')
    expect(out.type).toBe('image/heic')
    expect(out.lastModified).toBe(1234)
  })

  it('THROWS on an unreadable source rather than handing back the original', async () => {
    // The whole point of doing this at pick time. A fail-safe that returned the original would hand
    // back the very handle it could not read, so the item would stage looking fine and fail later —
    // which IS the reported bug, just relocated.
    const src = fakeFile('gone.jpg', [1], { arrayBuffer: RECLAIMED })
    await expect(snapshotFile(src)).rejects.toThrow(/could not be read/)
  })

  it('hands back the ORIGINAL when the engine has no arrayBuffer', async () => {
    // The documented jsdom / ancient-WebView branch. Asserted so the fallback stays a deliberate,
    // visible choice rather than something a future edit can quietly widen.
    const noCopy = { name: 'a.jpg', type: 'image/jpeg', lastModified: 1 }
    await expect(snapshotFile(noCopy)).resolves.toBe(noCopy)
  })
})

describe('snapshotFiles — the batch', () => {
  it('one unreadable photo costs that photo, not the batch', async () => {
    // The inversion of the reported failure, where one bad moment cost nine photos.
    const files = [
      fakeFile('a.jpg'),
      fakeFile('bad.jpg', [1], { arrayBuffer: RECLAIMED }),
      fakeFile('c.jpg'),
    ]
    const { ok, failed } = await snapshotFiles(files)
    expect(ok.map(o => o.file.name)).toEqual(['a.jpg', 'c.jpg'])
    expect(failed).toHaveLength(1)
    expect(failed[0].file.name).toBe('bad.jpg')
    expect(failed[0].error).toMatch(/could not be read/)
  })

  it('never rejects, so a whole failed pick still returns a shape the caller can report', async () => {
    const files = [fakeFile('a.jpg', [1], { arrayBuffer: RECLAIMED })]
    const { ok, failed } = await snapshotFiles(files)
    expect(ok).toEqual([])
    expect(failed).toHaveLength(1)
  })

  it('reads SERIALLY — a parallel map would hold every original at once', async () => {
    // The memory contract, and not a style preference: memory pressure is the root cause of the
    // reclaim, so reading ten multi-megabyte originals concurrently would make the bug likelier on
    // exactly the devices that have it. Measured by peak concurrency, which is what actually matters.
    let live = 0, peak = 0
    const slow = () => { live++; peak = Math.max(peak, live)
      return new Promise(r => setTimeout(() => { live--; r(new Uint8Array([1]).buffer) }, 0)) }
    await snapshotFiles(Array.from({ length: 5 }, (_, i) => fakeFile(`f${i}.jpg`, [1], { arrayBuffer: slow })))
    expect(peak).toBe(1)
  })

  it('reports progress after each file so a long pick is not a dead tap', async () => {
    const seen = []
    await snapshotFiles([fakeFile('a.jpg'), fakeFile('b.jpg'), fakeFile('c.jpg')], (d, t) => seen.push([d, t]))
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]])
  })

  it('a throwing progress callback never costs a photo', async () => {
    const { ok } = await snapshotFiles([fakeFile('a.jpg')], () => { throw new Error('render blew up') })
    expect(ok.map(o => o.file.name)).toEqual(['a.jpg'])
  })
})
