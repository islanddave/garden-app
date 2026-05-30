/**
 * src/lib/captureQueue.js
 *
 * Bite 4 of Post-V2 UX overhaul Increment 2: Field capture durable queue.
 * Bite 5 extension: transcript columns + setTranscript / incrementTranscribeAttempt
 * for the Web Speech / manual-fallback transcription flow.
 *
 * Record schema:
 *   {
 *     id:                   uuid string,
 *     mode:                 'field' | 'desk',
 *     kind:                 'audio' | 'text',
 *     blob:                 Blob | null,         // present iff kind === 'audio'
 *     mime:                 string | null,        // 'audio/webm' | 'audio/mp4' | null for text
 *     durationMs:           number | null,        // 0 or null for text
 *     text:                 string | null,        // present iff kind === 'text'
 *     capturedAt:           ISO 8601 string,
 *     status:               'queued' | 'recorded' | 'transcribed' | 'handed_off',
 *     attemptCount:         number,
 *
 *     // Bite 5 (transcription) — additive; legacy records read with these fields
 *     // absent are tolerated (undefined treated as null / 0):
 *     transcript:           string | null,        // the user-confirmed (or Web Speech) transcript
 *     transcribedAt:        ISO 8601 string | null,
 *     transcribeAttempts:   number,                // total attempts (manual or web-speech)
 *     transcriptSource:     'manual' | 'web-speech' | null,
 *   }
 *
 * Retention policy (Dave-call from Bite 4): blobs persist indefinitely. No
 * delete / clear / prune. User-initiated cleanup arrives post-Bite 6 once an
 * audit surface exists.
 *
 * iOS quota landmine: navigator.storage.persist() is requested from
 * durableStorage.js on FieldCapture first-mount. captureQueue itself surfaces
 * quota errors via a string error code 'quota'.
 *
 * All exported functions are async; each opens a single connection per call
 * so tests can swap fake-indexeddb cleanly.
 */

const DB_NAME    = 'gardenAppFieldCapture'
const DB_VERSION = 1
const STORE      = 'captures'

const STATUS = Object.freeze({
  QUEUED:      'queued',
  RECORDED:    'recorded',
  TRANSCRIBED: 'transcribed',
  HANDED_OFF:  'handed_off',
})
export { STATUS }

const KIND = Object.freeze({
  AUDIO: 'audio',
  TEXT:  'text',
})
export { KIND }

const TRANSCRIPT_SOURCE = Object.freeze({
  MANUAL:     'manual',
  WEB_SPEECH: 'web-speech',
})
export { TRANSCRIPT_SOURCE }

function generateId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {}
  return `fc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function nowIso() {
  return new Date().toISOString()
}

export function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject('unavailable')
      return
    }
    let req
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      reject('failed')
      return
    }
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('byStatus',     'status',     { unique: false })
        store.createIndex('byCapturedAt', 'capturedAt', { unique: false })
      }
    }
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror   = ()  => reject('failed')
    req.onblocked = ()  => reject('blocked')
  })
}

function runTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let result
    let tx
    try {
      tx = db.transaction(STORE, mode)
    } catch (e) {
      reject(e && e.name === 'QuotaExceededError' ? 'quota' : 'failed')
      return
    }
    const store = tx.objectStore(STORE)
    Promise.resolve(fn(store)).then(
      (r) => { result = r },
      (e) => { reject(e) },
    )
    tx.oncomplete = () => resolve(result)
    tx.onerror    = () => reject(tx.error && tx.error.name === 'QuotaExceededError' ? 'quota' : 'failed')
    tx.onabort    = () => reject(tx.error && tx.error.name === 'QuotaExceededError' ? 'quota' : 'failed')
  })
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error && req.error.name === 'QuotaExceededError' ? 'quota' : 'failed')
  })
}

/**
 * Enqueue a recorded audio capture. Returns the stored record (with id).
 */
export async function enqueueRecording({ blob, mime, durationMs, mode = 'field' } = {}) {
  if (!blob) throw new Error('enqueueRecording: blob required')
  const db = await openDb()
  try {
    const record = {
      id:                 generateId(),
      mode,
      kind:               KIND.AUDIO,
      blob,
      mime:               mime || null,
      durationMs:         typeof durationMs === 'number' ? durationMs : null,
      text:               null,
      capturedAt:         nowIso(),
      status:             STATUS.RECORDED,
      attemptCount:       0,
      transcript:         null,
      transcribedAt:      null,
      transcribeAttempts: 0,
      transcriptSource:   null,
    }
    await runTx(db, 'readwrite', (store) => reqToPromise(store.add(record)))
    return record
  } finally {
    db.close()
  }
}

/**
 * Enqueue a text-only entry. Returns the stored record (with id).
 * Text entries are persisted with status='queued' and no transcript fields —
 * the text itself IS the content, and Bite 6 can decide whether to treat
 * the text as a transcript-equivalent at handoff time.
 */
export async function enqueueText({ text, mode = 'field' } = {}) {
  if (!text || typeof text !== 'string') throw new Error('enqueueText: text required')
  const db = await openDb()
  try {
    const record = {
      id:                 generateId(),
      mode,
      kind:               KIND.TEXT,
      blob:               null,
      mime:               null,
      durationMs:         null,
      text,
      capturedAt:         nowIso(),
      status:             STATUS.QUEUED,
      attemptCount:       0,
      transcript:         null,
      transcribedAt:      null,
      transcribeAttempts: 0,
      transcriptSource:   null,
    }
    await runTx(db, 'readwrite', (store) => reqToPromise(store.add(record)))
    return record
  } finally {
    db.close()
  }
}

/**
 * List all records, ordered by capturedAt ascending (oldest first).
 */
export async function list() {
  const db = await openDb()
  try {
    return await runTx(db, 'readonly', (store) => reqToPromise(store.getAll()))
      .then((all) => (all || []).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)))
  } finally {
    db.close()
  }
}

/**
 * Get a single record by id, or null if not found.
 */
export async function get(id) {
  const db = await openDb()
  try {
    const rec = await runTx(db, 'readonly', (store) => reqToPromise(store.get(id)))
    return rec || null
  } finally {
    db.close()
  }
}

/**
 * Update a record. Patch is merged onto the existing record; id is protected.
 * Returns the updated record, or null if id absent.
 */
export async function update(id, patch) {
  if (!id) throw new Error('update: id required')
  if (!patch || typeof patch !== 'object') throw new Error('update: patch required')
  const db = await openDb()
  try {
    return await runTx(db, 'readwrite', async (store) => {
      const cur = await reqToPromise(store.get(id))
      if (!cur) return null
      const next = { ...cur, ...patch, id: cur.id }
      await reqToPromise(store.put(next))
      return next
    })
  } finally {
    db.close()
  }
}

/**
 * Set the transcript for a record. Marks status='transcribed', records
 * transcribedAt + transcriptSource, and increments transcribeAttempts.
 *
 * Backward-compat: legacy records (Bite 4 era) without transcribeAttempts read
 * undefined; we initialize to 0 before incrementing.
 */
export async function setTranscript({ id, transcript, source = TRANSCRIPT_SOURCE.MANUAL } = {}) {
  if (!id) throw new Error('setTranscript: id required')
  if (typeof transcript !== 'string' || transcript.length === 0) {
    throw new Error('setTranscript: non-empty transcript required')
  }
  if (source !== TRANSCRIPT_SOURCE.MANUAL && source !== TRANSCRIPT_SOURCE.WEB_SPEECH) {
    throw new Error('setTranscript: source must be manual or web-speech')
  }
  const db = await openDb()
  try {
    return await runTx(db, 'readwrite', async (store) => {
      const cur = await reqToPromise(store.get(id))
      if (!cur) return null
      const next = {
        ...cur,
        id:                 cur.id,
        // Bite 5: transcript is the canonical field; also mirror into `text`
        // so Bite 4 callers reading `text` post-transcription still see content.
        transcript,
        text:               transcript,
        transcribedAt:      nowIso(),
        transcriptSource:   source,
        transcribeAttempts: (typeof cur.transcribeAttempts === 'number' ? cur.transcribeAttempts : 0) + 1,
        status:             STATUS.TRANSCRIBED,
      }
      await reqToPromise(store.put(next))
      return next
    })
  } finally {
    db.close()
  }
}

/**
 * Increment transcribeAttempts on a failed attempt (Web Speech silent failure,
 * no-speech timeout, denied permission). Does NOT change status or transcript.
 */
export async function incrementTranscribeAttempt(id) {
  if (!id) throw new Error('incrementTranscribeAttempt: id required')
  const db = await openDb()
  try {
    return await runTx(db, 'readwrite', async (store) => {
      const cur = await reqToPromise(store.get(id))
      if (!cur) return null
      const cur_attempts = typeof cur.transcribeAttempts === 'number' ? cur.transcribeAttempts : 0
      const next = { ...cur, id: cur.id, transcribeAttempts: cur_attempts + 1 }
      await reqToPromise(store.put(next))
      return next
    })
  } finally {
    db.close()
  }
}

/**
 * LEGACY shim — Bite 4 callers used markTranscribed(id, text). Now delegates
 * to setTranscript with source='manual'. Kept to avoid a flag-day rename.
 */
export async function markTranscribed(id, text) {
  return setTranscript({ id, transcript: text, source: TRANSCRIPT_SOURCE.MANUAL })
}

/**
 * Mark a record as handed off; convenience over update().
 */
export async function markHandedOff(id) {
  return update(id, { status: STATUS.HANDED_OFF })
}

/**
 * Count of records NOT in the handed_off state (the "unprocessed" depth).
 */
export async function getUnprocessedDepth() {
  const all = await list()
  return all.filter((r) => r.status !== STATUS.HANDED_OFF).length
}

/**
 * Total count of records (all statuses).
 */
export async function getTotalCount() {
  const all = await list()
  return all.length
}

/**
 * Age (ms) of the oldest unprocessed record (status !== handed_off). Returns
 * null if no unprocessed records.
 */
export async function getOldestUnprocessedAgeMs() {
  const all = await list()
  const unprocessed = all.filter((r) => r.status !== STATUS.HANDED_OFF)
  if (unprocessed.length === 0) return null
  const oldest = unprocessed[0]
  return Date.now() - new Date(oldest.capturedAt).getTime()
}
