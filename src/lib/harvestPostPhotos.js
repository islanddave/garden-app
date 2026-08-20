// harvestPostPhotos.js — V4-HARVPOSTPHOTOS-001. The photo half of the harvest post composer.
//
// WHY THIS EXISTS: ComposeHarvestBand shipped the caption and stopped there, so Dave still re-adds
// every photo by hand in the Facebook composer — the transcription this surface was built to remove,
// moved rather than deleted. `navigator.share({ files })` on Chrome Android hands the OS the bytes
// alongside the text, which is the whole gap.
//
// PURE + INJECTED, no React and no bare `fetch` in the hot path, so it unit-tests with zero runtime
// deps — same split as harvestPost.js next to it, and the same reason photoModel.js refuses to import
// a component: `mint` is passed in by the caller (which owns PhotoImg's minting cache) rather than
// imported here.
//
// ── The three facts the design rests on ────────────────────────────────────────────────────────────
// 1. TRANSIENT USER ACTIVATION DIES ACROSS AN AWAIT (Chrome Android). navigator.share must be called
//    with the files ALREADY IN HAND, so the fetching happens when the composer opens, not when Share
//    is tapped. Composition time is the prefetch window. Same landmine HarvestExportSheet documents.
// 2. PRESIGN EXPIRY IS A NON-ISSUE BY CONSTRUCTION. A view-url is a 900s bearer credential, but we
//    convert it to bytes immediately: the TTL only has to survive the mint -> fetch hop (milliseconds),
//    not the minutes Dave spends writing his lead. Holding a File is what immunizes this path.
// 3. THE SERVER CANNOT TELL US HOW BIG A PHOTO IS. photos.file_size_bytes and photos.mime_type are
//    NULL on 1269 of 1281 live rows (measured on prod 2026-08-20), so the byte budget can only be
//    enforced against blobs we have already received. It bounds what we HOLD and hand to the OS, not
//    what crosses the wire — the overshoot is capped at one file by the break below.
//
// A presigned S3 GET is fetched with credentials omitted: the signature is in the query string, and
// attaching the app's Authorization header (i.e. going through useApiFetch) makes S3 reject it.

import { stripImageFileStrict } from './imageMetadataStrip.js'

// Measured on prod (2026-08-20, 106 logging batches by the harvestPost.js 45-minute rule): 29 batches
// carry photos, distributed 1x13, 2x2, 3x4, 5x2, 8x2, 9, 11, 13, 14, 16, 30. A cap of 10 covers 24 of
// those 29 whole; the tail is bulk-import evenings, not posts. 10 is also where a Facebook post stops
// being a photo grid and becomes an album, and it keeps the file count well under any browser ceiling.
// NOTHING IS SILENTLY DROPPED — the composer states the count it left out.
export const MAX_POST_PHOTOS = 10

// Typical upload is ~240-830KB (imageDownscale caps the long edge at 2048px and re-encodes anything
// over 512KB), so ten photos is ~5MB and this never binds. It exists for the 913 photos backfilled
// BEFORE that downscale shipped, whose originals measured 1.9-6.2MB: ten of those would be 60MB of
// blobs held in a phone renderer, which is the OOM class imagePipeline.js is written around.
export const MAX_POST_PHOTO_BYTES = 25 * 1024 * 1024

// One retry of the whole (mint, fetch) pair. Rural LTE is this app's normal condition, and a mint that
// 403s because the presign lapsed is fixed by minting again — PhotoImg spends exactly the same budget
// on the same failure.
const ATTEMPTS = 2

const EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/jpeg': 'jpg' }

function extForType(type) {
  return EXT[String(type || '').toLowerCase()] || 'jpg'
}

// The batch's photos in logging order, deduped, capped. `items` arrive chronological from
// detectLastBatch, and each carries the `photos: [{id, caption, taken_at}]` array the harvests read
// model already returns (lambda/harvests/aggregate.js) — IDs only, no URL, which is why minting is a
// separate step. eventId rides along so the composer's per-line exclusions can reach the photo: one
// control ("leave the cucumbers out") governs both the line and its picture.
export function collectBatchPhotos(items, { limit = MAX_POST_PHOTOS } = {}) {
  const seen = new Set()
  const all = []
  for (const e of Array.isArray(items) ? items : []) {
    for (const p of Array.isArray(e?.photos) ? e.photos : []) {
      const photoId = p?.id
      if (!photoId || seen.has(photoId)) continue
      seen.add(photoId)
      all.push({ photoId, eventId: e.event_id ?? null })
    }
  }
  const cap = Math.max(0, Number(limit) || 0)
  return { photos: all.slice(0, cap), total: all.length, dropped: Math.max(0, all.length - cap) }
}

async function defaultFetchBlob(url, { signal } = {}) {
  const res = await fetch(url, { signal, credentials: 'omit' })
  if (!res.ok) {
    const err = new Error(`photo fetch ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.blob()
}

function aborted(signal, err) {
  return !!signal?.aborted || err?.name === 'AbortError'
}

async function loadOne(ref, { mint, fetchBlob, signal, index }) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const url = await mint(ref.photoId)
      if (!url) throw new Error('view-url returned no url')
      const blob = await fetchBlob(url, { signal })
      if (!blob || !blob.size) throw new Error('empty photo body')
      const type = blob.type || 'image/jpeg'
      // V4-PHOTOEXIFSTRIP-001 LAYER 2 — strip here as well as on upload, because this is the only
      // layer that protects the 913 photos ALREADY in S3. They were backfilled before any downscale
      // or strip existed, so they are camera originals with GPS at Dave's house, and nothing about
      // stripping on upload reaches them. Doing it here needs no bulk rewrite of stored objects:
      // the share sheet only ever sees the bytes we hand it. Upload-side strip fixes the future,
      // this fixes the present.
      //
      // A THROW IS THE CORRECT OUTCOME. It lands in the catch below, which retries the whole
      // (mint, fetch, strip) once and then counts the photo failed — so the composer says
      // "1 didn't load" and the post goes without it. A photo we cannot strip is not shared.
      //
      // BUG-HEICEXIFPASSTHRU-001 — the sentence above used to be FALSE, and it was false in the
      // exact place it was written. This called the LENIENT stripImageFile, which throws on an
      // unreadable blob but RETURNS THE INPUT for a container it has no walker for. Measured on a
      // real HEIC: fetchPostPhotos returned it as harvest-photo-1.heic, failed:0, GPS intact, and
      // handed it to the share sheet. Strict is what makes the comment true — the FB Lambda's
      // isJpeg reject (lambda/facebook-share/index.js) was the only enforcement, and the share
      // sheet does not go through the Lambda.
      const clean = await stripImageFileStrict(blob)
      // A neutral filename: it rides into the share sheet and on to whatever app receives it, so it
      // must not carry a caption, a variety name or a UUID.
      return new File([clean], `harvest-photo-${index + 1}.${extForType(type)}`, { type })
    } catch (err) {
      if (aborted(signal, err)) return null
    }
  }
  return null
}

// Fetch the batch's photos as Files, sequentially.
//
// SEQUENTIAL ON PURPOSE. Concurrency would make the byte budget fuzzy (in-flight responses can
// overshoot it by N files instead of 1) and buys little: the median photo-bearing batch is 3 photos,
// and this runs while Dave writes his lead rather than while he waits on a tap.
//
// PARTIAL IS THE CORRECT OUTCOME, and it is the opposite of HarvestExportSheet's drain-abort. That
// export aborts on a short page because a silently-truncated LIST OF HARVESTS looks complete and is
// not — it is the ledger. Photos are illustrative: one that fails to load leaves the post correct,
// and failing the whole share on a single 403 would make the feature useless on the flaky rural
// connection this app treats as normal. The count that did and did not load is stated either way.
//
// Returns { items: [{ photoId, eventId, file }], failed, skipped, bytes }.
export async function fetchPostPhotos(refs, options = {}) {
  const {
    mint,
    fetchBlob = defaultFetchBlob,
    byteLimit = MAX_POST_PHOTO_BYTES,
    onProgress,
    signal,
  } = options

  const list = Array.isArray(refs) ? refs : []
  const items = []
  let failed = 0
  let skipped = 0
  let bytes = 0

  for (let i = 0; i < list.length; i++) {
    if (signal?.aborted) { skipped += list.length - i; break }
    if (bytes >= byteLimit) { skipped += list.length - i; break }

    const file = await loadOne(list[i], { mint, fetchBlob, signal, index: i })
    if (!file) {
      if (signal?.aborted) { skipped += list.length - i; break }
      failed++
      onProgress?.({ done: items.length, failed, total: list.length })
      continue
    }
    // Budget checked against the blob we now hold — the server had no size to give us (header note 3).
    // Over budget stops the run rather than skipping one and continuing: the next photo came off the
    // same camera and will be the same size.
    if (bytes + file.size > byteLimit) { skipped += list.length - i; break }

    bytes += file.size
    items.push({ ...list[i], file })
    onProgress?.({ done: items.length, failed, total: list.length })
  }

  return { items, failed, skipped, bytes }
}
