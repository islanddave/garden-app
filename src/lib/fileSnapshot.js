// src/lib/fileSnapshot.js
// BUG-PHOTOSTAGEDREAD-001 — detach a picked File from the picker's handle before we stage it.
//
// THE FAILURE, reported from Dave's Android on prod v4.80.0: he picked 10 photos in the Photo
// Library, 1 uploaded and 9 failed, every one of them with
//     "The requested file could not be read, typically due to permission problems that have
//      occurred after a reference to a file was acquired"
// which is Chrome's DOMException for a File whose backing store is no longer readable.
//
// WHY IT LOOKS IMPOSSIBLE FROM THE SCREENSHOT, AND ISN'T. The staged thumbnails all rendered fine.
// That is not evidence the bytes were readable — `URL.createObjectURL(file)` does not copy anything,
// it mints a URL pointing at the SAME backing store, and the already-decoded image stays painted
// after that store dies. So a picker handle can be dead while its preview still looks perfect. The
// preview is not a liveness check on the file, and nothing else in the staging path read the bytes.
//
// WHY ONLY THE FIRST ONE SURVIVED. Every staging surface held the raw `File` objects and read them
// LATER — the Photo Library on the Upload tap, EventNew on Save, PhotoUpload's strip inside a serial
// queue. Android hands out picker files as temporary content:// handles (and for a cloud-backed
// provider like Google Photos, a temp file it downloaded); those are reclaimable, and decoding the
// first multi-megabyte photo is exactly the memory pressure that reclaims the rest. Item 1 read
// before the pressure existed; items 2..N read after.
//
// THE FIX IS A COPY, NOT A RETRY. Re-reading a dead handle fails again — there is nothing to retry.
// `new Blob([await file.arrayBuffer()])` moves the bytes into the renderer's own blob storage, which
// Chrome owns, pages to disk under pressure, and does NOT reclaim out from under us. From that point
// the file is ours for as long as we hold it.
//
// WHY AT PICK TIME. This is the ONLY moment the handle is guaranteed live — it is the same trusted
// gesture that opened the picker. A snapshot taken any later is a snapshot that can already fail.
// It also relocates the error to where it is actionable: "that photo couldn't be read" while the
// user is still looking at the picker beats the same message against nine thumbnails three minutes
// later, after they have chosen a planting and pressed Upload.
//
// NOT FAIL-SAFE, deliberately — this throws rather than handing back the original File. A fail-safe
// fallback here would return the exact handle we could not read, so the staged item would look fine
// and fail later anyway: it would convert a clear failure into the silent-then-late one this bug IS.
// Callers mark the item errored and keep it out of the batch.

// Read serially, never Promise.all. Peak memory is one decoded ArrayBuffer plus the snapshots taken
// so far; a parallel map would hold N originals at once, on the phones where memory pressure is the
// root cause in the first place. Ten 5MB photos is a ~5MB spike and ~50MB retained, which Chrome
// pages out; ten 5MB photos read in parallel is a 50MB spike, which it does not.

// WHERE THE COPY DOES NOT HAPPEN, AND WHY THAT IS SAFE RATHER THAN A HOLE.
// `Blob.arrayBuffer()` is the whole mechanism. Every engine that can hit this bug has it — it is the
// Android Chrome the report came from, and has been in Chrome since 76 and Safari since 14. What
// does NOT have it is jsdom, where every unit test runs.
//
// So when it is absent we hand back the ORIGINAL file rather than copying. That is not a fail-safe
// papering over the defect: on the platform where the defect exists the real branch always runs, and
// the fallback is reachable only from an engine that cannot exhibit it. The alternative — a
// FileReader fallback — was written first and rejected: FileReader completes on a TASK, so a
// ten-photo pick needs ten task ticks before anything stages, and every staging test in the app
// would have to flush-until-quiescent to see a single file. That is a fragile contract to leave
// behind for a branch that never runs in production.
//
// The copy is therefore proven by a direct unit test against a stub blob that HAS arrayBuffer
// (fileSnapshot.test.js), not by the component tests — which is the honest place for it anyway,
// since jsdom has no notion of a reclaimed picker handle and could never test the real thing.
function canCopy(blob) {
  return blob && typeof blob.arrayBuffer === 'function'
}

/**
 * Copy a picked File's bytes into blob storage, detaching it from the picker handle.
 * Preserves name/type/lastModified — the upload path derives the extension, the Content-Type and
 * `original_filename` from them, so a snapshot that dropped them would change what gets stored.
 * Throws if the bytes cannot be read — which on Android IS the "could not be read ... after a
 * reference to a file was acquired" DOMException this module exists to catch at pick time.
 */
export async function snapshotFile(file) {
  if (!canCopy(file)) return file
  const buf = await file.arrayBuffer()
  // `new File` rather than `new Blob`: extFromFile/mimeFromFile/original_filename all read .name,
  // and readCaptureMeta slices by offset the same way on either. Some older WebViews lack the File
  // constructor, so fall back to a Blob with the fields grafted on rather than failing the upload.
  if (typeof File === 'function') {
    try {
      return new File([buf], file.name, { type: file.type, lastModified: file.lastModified })
    } catch (e) { /* fall through to the Blob form */ }
  }
  const blob = new Blob([buf], { type: file.type })
  try {
    Object.defineProperty(blob, 'name', { value: file.name, enumerable: true })
    Object.defineProperty(blob, 'lastModified', { value: file.lastModified, enumerable: true })
  } catch (e) { /* a nameless blob still uploads; extFromFile falls back on the MIME type */ }
  return blob
}

/**
 * Snapshot a list of picked files one at a time.
 * Returns { ok, failed } rather than throwing, so one unreadable photo out of ten costs that one
 * photo and not the batch — the opposite of the reported failure, where one bad moment cost nine.
 * `onProgress(done, total)` fires after each file so the caller can say "Preparing 3 of 10" instead
 * of freezing on a tap that now does real work.
 */
export async function snapshotFiles(files, onProgress = null) {
  const ok = []
  const failed = []
  const total = files.length
  for (let i = 0; i < total; i++) {
    const file = files[i]
    try {
      ok.push({ file: await snapshotFile(file), original: file })
    } catch (err) {
      failed.push({ file, error: err?.message || 'Could not read that photo.' })
    }
    if (typeof onProgress === 'function') {
      try { onProgress(i + 1, total) } catch (e) { /* a progress callback must never cost a photo */ }
    }
  }
  return { ok, failed }
}
